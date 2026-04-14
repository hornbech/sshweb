import 'dotenv/config'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'
import pino from 'pino'
import { config } from './config.js'
import { MasterKey } from './masterkey.js'
import { ConnectionStore } from './store.js'
import { SshManager } from './ssh.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DIST = join(__dirname, '../dist')
const startedAt = Date.now()

// Determine version from package.json
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'))
const VERSION = pkg.version

export const logger = pino({
  level: config.logLevel,
})

export const masterKey = new MasterKey(config.dataDir)
export const sshManager = new SshManager(logger)

/** @type {ConnectionStore|null} */
let store = null

function getStore() {
  if (!store && masterKey.isUnlocked()) {
    store = new ConnectionStore(
      join(config.dataDir, 'connections.db'),
      masterKey.getKey()
    )
  }
  return store
}

function closeStore() {
  if (store) { store.close(); store = null }
}

function requireStore(res) {
  const s = getStore()
  if (!s) { res.status(423).json({ error: 'Server locked' }); return null }
  return s
}

export const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

// Lock guard middleware — redirect to /unlock unless the path is allowed
const UNLOCKED_PATHS = ['/unlock', '/api/unlock', '/health']
app.use((req, res, next) => {
  if (masterKey.isUnlocked()) return next()
  if (UNLOCKED_PATHS.some(p => req.path.startsWith(p))) return next()
  if (req.path.startsWith('/assets') || req.path.startsWith('/favicon')) return next()
  if (req.path.startsWith('/api/')) return res.status(423).json({ error: 'Server locked' })
  return res.redirect('/unlock')
})

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: masterKey.isUnlocked() ? 'ok' : 'locked',
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    activeSessions: sshManager.sessionCount,
  })
})

// Unlock page
app.get('/unlock', (req, res) => {
  if (masterKey.isUnlocked()) return res.redirect('/')
  const distUnlock = join(DIST, 'unlock.html')
  const srcUnlock = join(__dirname, '../client/unlock.html')
  const unlockHtml = existsSync(distUnlock) ? distUnlock : existsSync(srcUnlock) ? srcUnlock : null
  if (unlockHtml) {
    res.sendFile(unlockHtml)
  } else {
    // Fallback minimal unlock page if client not built yet
    res.send(`<!DOCTYPE html><html><body>
      <form method="POST" action="/api/unlock">
        <input name="password" type="password" placeholder="Master password" autofocus>
        <button type="submit">Unlock</button>
      </form></body></html>`)
  }
})

app.post('/api/unlock', async (req, res) => {
  const { password } = req.body
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required' })
  }
  try {
    await masterKey.unlock(password)
    closeStore() // reset store so it picks up new key
    logger.info('Server unlocked')
    res.json({ ok: true })
  } catch {
    res.status(401).json({ error: 'Invalid password' })
  }
})

app.post('/api/lock', (req, res) => {
  masterKey.lock()
  closeStore()
  logger.info('Server locked')
  res.json({ ok: true })
})

// Connection CRUD
app.get('/api/connections', (req, res) => {
  const s = requireStore(res)
  if (!s) return
  res.json(s.list())
})

app.post('/api/connections', (req, res) => {
  const s = requireStore(res)
  if (!s) return
  const { label, host, port, username, authType, secret } = req.body
  if (!label || !host || !username || !secret) {
    return res.status(400).json({ error: 'label, host, username, and secret are required' })
  }
  if (!['password', 'key'].includes(authType)) {
    return res.status(400).json({ error: 'authType must be "password" or "key"' })
  }
  const id = s.create({ label, host, port: Number(port) || 22, username, authType, secret })
  res.status(201).json({ id })
})

app.put('/api/connections/:id', (req, res) => {
  const s = requireStore(res)
  if (!s) return
  s.update(req.params.id, req.body)
  res.json({ ok: true })
})

app.delete('/api/connections/:id', (req, res) => {
  const s = requireStore(res)
  if (!s) return
  s.delete(req.params.id)
  res.json({ ok: true })
})

// Active sessions (admin)
app.get('/api/sessions', (req, res) => {
  res.json(sshManager.listSessions())
})

app.delete('/api/sessions/:id', (req, res) => {
  sshManager.kill(req.params.id)
  res.json({ ok: true })
})

// Serve built frontend (production)
if (existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get('/{*splat}', (req, res) => {
    res.sendFile(join(DIST, 'index.html'))
  })
}

// HTTP + WebSocket server
export const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  if (!masterKey.isUnlocked()) {
    ws.close(4001, 'Server locked')
    return
  }
  if (sshManager.sessionCount >= config.maxSessions) {
    ws.close(4002, 'Max sessions reached')
    return
  }

  let sessionId = null
  const log = logger.child({ wsConn: true })

  ws.on('message', async (raw) => {
    try {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      if (msg.type === 'connect') {
        const { connectionId, cols, rows } = msg
        const s = getStore()
        if (!s) { ws.close(4001, 'Server locked'); return }
        const conn = s.get(connectionId)
        if (!conn) { ws.close(4003, 'Connection not found'); return }

        try {
          sessionId = await sshManager.open({
            ...conn, ws, cols: cols ?? 80, rows: rows ?? 24,
          })
          ws.send(JSON.stringify({ type: 'connected', sessionId }))
        } catch (err) {
          log.warn({ err }, 'SSH open failed')
          try { ws.send(JSON.stringify({ type: 'error', message: err.message })) } catch {}
          ws.close()
        }
      } else if (msg.type === 'data' && sessionId) {
        sshManager.write(sessionId, Buffer.from(msg.data, 'base64').toString())
      } else if (msg.type === 'resize' && sessionId) {
        sshManager.resize(sessionId, msg.cols, msg.rows)
      }
    } catch (err) {
      log.error({ err }, 'Unhandled error in WebSocket message handler')
      try { ws.close(4000, 'Internal error') } catch {}
    }
  })

  ws.on('close', () => {
    if (sessionId) sshManager.kill(sessionId)
  })
})

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...')
  closeStore()
  sshManager.killAll('Server shutting down...')
  const timeout = setTimeout(() => process.exit(0), 10_000)
  timeout.unref()
  server.close(() => {
    clearTimeout(timeout)
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Start listening only when run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'sshweb started')
  })
}
