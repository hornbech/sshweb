import 'dotenv/config'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { WebSocketServer } from 'ws'
import pino from 'pino'
import { config } from './config.js'
import { MasterKey } from './masterkey.js'
import { ConnectionStore } from './store.js'
import { CredentialStore } from './credentials.js'
import { SshManager } from './ssh.js'
import { getLocalSubnets, parseCIDR, scanSubnet } from './scan.js'
import { SessionManager, getSessionToken } from './session.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DIST = join(__dirname, '../dist')
const startedAt = Date.now()


export const logger = pino({
  level: config.logLevel,
})

export const masterKey = new MasterKey(config.dataDir)
export const sshManager = new SshManager(logger)
export const sessions = new SessionManager(config.sessionTimeoutMinutes)

/** @type {ConnectionStore|null} */
let store = null

/** @type {CredentialStore|null} */
let credStore = null

function getStore() {
  if (!store && masterKey.isUnlocked()) {
    store = new ConnectionStore(
      join(config.dataDir, 'connections.db'),
      masterKey.getKey()
    )
  }
  return store
}

function getCredStore() {
  if (!credStore && masterKey.isUnlocked()) {
    credStore = new CredentialStore(
      join(config.dataDir, 'credentials.db'),
      masterKey.getKey()
    )
  }
  return credStore
}

function closeCredStore() {
  if (credStore) { credStore.close(); credStore = null }
}

function requireCredStore(res) {
  const s = getCredStore()
  if (!s) { res.status(423).json({ error: 'Server locked' }); return null }
  return s
}

function closeStore() {
  if (store) { store.close(); store = null }
  closeCredStore()
}

function requireStore(res) {
  const s = getStore()
  if (!s) { res.status(423).json({ error: 'Server locked' }); return null }
  return s
}

export const app = express()
app.set('trust proxy', 1) // real client IP from X-Forwarded-For (NPM)

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // xterm.js writes inline styles
      connectSrc: ["'self'", 'wss:', 'ws:'],   // WebSocket
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],           // xterm.js worker
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // would break xterm canvas
  permissionsPolicy: {
    features: {
      clipboard_read: ["'self'"],   // Ctrl+V paste into terminal
      camera: [],
      microphone: [],
      geolocation: [],
    },
  },
}))

// Rate limit unlock attempts (per real IP)
const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' }),
})

// Rate limit subnet scans (per real IP)
const scanLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many scans. Wait 5 minutes.' }),
})

app.use(express.json())
app.use(express.urlencoded({ extended: false }))

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    secure: req.secure || config.nodeEnv === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: config.sessionTimeoutMinutes * 60 * 1000, // milliseconds
  }
}

// Auth guard — paths that never require a session
const PUBLIC_PATHS = ['/unlock', '/api/unlock', '/health']
app.use((req, res, next) => {
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next()
  if (req.path.startsWith('/assets') || req.path.startsWith('/favicon') || req.path === '/logo.svg') return next()
  if (masterKey.isUnlocked() && sessions.validate(getSessionToken(req))) return next()
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' })
  res.clearCookie('session', { path: '/' })
  return res.redirect('/unlock')
})

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: masterKey.isUnlocked() ? 'ok' : 'locked',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    activeSessions: sshManager.sessionCount,
  })
})

// Unlock status (first run detection)
app.get('/api/unlock', (req, res) => {
  res.json({ firstRun: !masterKey.hasPassword() })
})

// Unlock page
app.get('/unlock', (req, res) => {
  if (masterKey.isUnlocked() && sessions.validate(getSessionToken(req))) return res.redirect('/')
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

app.post('/api/unlock', unlockLimiter, async (req, res) => {
  const { password } = req.body
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required' })
  }
  try {
    const wasLocked = !masterKey.isUnlocked()
    await masterKey.unlock(password)
    if (wasLocked) closeStore() // reset store on first unlock
    const token = sessions.create()
    res.cookie('session', token, sessionCookieOptions(req))
    logger.info('Server unlocked')
    res.json({ ok: true })
  } catch (err) {
    if (err.message === 'Invalid master password') {
      return res.status(401).json({ error: 'Invalid password' })
    }
    logger.error({ err }, 'Unlock failed')
    res.status(500).json({ error: err.message || 'Server error during unlock' })
  }
})

app.post('/api/lock', (req, res) => {
  // CSRF guard: reject cross-origin browser requests
  const origin = req.get('origin')
  if (origin) {
    const host = req.get('host') ?? ''
    try {
      if (new URL(origin).host !== host) {
        return res.status(403).json({ error: 'Forbidden' })
      }
    } catch {
      return res.status(403).json({ error: 'Forbidden' })
    }
  }
  masterKey.lock()
  closeStore()
  sessions.clear()
  res.clearCookie('session', { path: '/' })
  logger.info('Server locked')
  res.json({ ok: true })
})

app.post('/api/change-password', async (req, res) => {
  if (!masterKey.isUnlocked()) return res.status(423).json({ error: 'Server locked' })
  const { currentPassword, newPassword } = req.body
  if (!currentPassword || !newPassword || typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'currentPassword and newPassword required' })
  }
  try {
    const { newKey, newSalt } = await masterKey.deriveNewKey(currentPassword, newPassword)
    const s = getStore()
    if (s) s.reencryptAll(newKey)
    const cs = getCredStore()
    if (cs) cs.reencryptAll(newKey)
    masterKey.commitNewPassword(newKey, newSalt)
    closeStore()
    sessions.clear()
    const token = sessions.create()
    res.cookie('session', token, sessionCookieOptions(req))
    logger.info('Master password changed')
    res.json({ ok: true })
  } catch (err) {
    if (err.message === 'Invalid master password') {
      return res.status(401).json({ error: 'Invalid current password' })
    }
    logger.error({ err }, 'Change password failed')
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// Network scan
app.get('/api/scan/subnets', (req, res) => {
  res.json({ subnets: getLocalSubnets() })
})

app.get('/api/scan', scanLimiter, (req, res) => {
  const { subnet } = req.query
  if (!subnet || typeof subnet !== 'string') {
    return res.status(400).json({ error: 'subnet query parameter required' })
  }
  try {
    parseCIDR(subnet) // validate before opening the stream
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // disable Nginx/OpenResty response buffering
  res.flushHeaders()

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  let aborted = false
  req.on('close', () => { aborted = true })

  scanSubnet(subnet, {
    onHost: (host) => send(host),
    onProgress: (p) => send({ progress: p }),
    isAborted: () => aborted,
  })
    .then(() => { send({ done: true }); res.end() })
    .catch((err) => { send({ error: err.message }); res.end() })
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
  const { label, host, port, username, authType, secret, credentialId } = req.body
  if (!label || !host) {
    return res.status(400).json({ error: 'label and host are required' })
  }
  if (authType && !['password', 'key'].includes(authType)) {
    return res.status(400).json({ error: 'authType must be "password" or "key"' })
  }
  const id = s.create({ label, host, port: Number(port) || 22, username: username || '', authType: authType || 'password', secret: secret || '', credentialId: credentialId || null })
  res.status(201).json({ id })
})

app.get('/api/connections/:id', (req, res) => {
  const s = requireStore(res)
  if (!s) return
  const conn = s.get(req.params.id)
  if (!conn) return res.status(404).json({ error: 'Not found' })
  res.json(conn)
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

// Credential CRUD
app.get('/api/credentials', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  res.json(s.list())
})

app.post('/api/credentials', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  const { name, username, authType, secret } = req.body
  if (!name || !username || !secret) {
    return res.status(400).json({ error: 'name, username, and secret are required' })
  }
  if (authType && !['password', 'key'].includes(authType)) {
    return res.status(400).json({ error: 'authType must be "password" or "key"' })
  }
  const id = s.create({ name, username, authType: authType || 'password', secret })
  res.status(201).json({ id })
})

app.get('/api/credentials/:id', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  const cred = s.get(req.params.id)
  if (!cred) return res.status(404).json({ error: 'Not found' })
  res.json(cred)
})

app.put('/api/credentials/:id', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  try {
    s.update(req.params.id, req.body)
    res.json({ ok: true })
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

app.delete('/api/credentials/:id', (req, res) => {
  const s = requireCredStore(res)
  if (!s) return
  const connStore = getStore()
  if (connStore) {
    const refs = connStore.list().filter(c => c.credentialId === req.params.id)
    if (refs.length > 0) {
      return res.status(409).json({
        error: `Credential is used by ${refs.length} connection${refs.length !== 1 ? 's' : ''}. Unlink them first.`
      })
    }
  }
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

wss.on('connection', (ws, req) => {
  if (!masterKey.isUnlocked() || !sessions.validate(getSessionToken(req))) {
    ws.close(4001, 'Unauthorized')
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

        let resolvedConn = conn
        if (conn.credentialId) {
          const cs = getCredStore()
          const cred = cs?.get(conn.credentialId)
          if (cred) {
            resolvedConn = { ...conn, username: cred.username, authType: cred.authType, secret: cred.secret }
          }
        }

        try {
          sessionId = await sshManager.open({
            ...resolvedConn, ws, cols: cols ?? 80, rows: rows ?? 24,
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
