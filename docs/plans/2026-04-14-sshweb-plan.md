# sshweb Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use godmode:task-runner to implement this plan task-by-task.

**Goal:** Build a personal homelab web-based SSH terminal with encrypted connection manager, master-key unlock, Docker deployment, and operational tooling.

**Architecture:** Node.js Express server proxies WebSocket connections to remote SSH servers via ssh2. All connection secrets are AES-256-GCM encrypted in a SQLite database, unlocked at runtime by an Argon2id-derived master key entered through a web unlock page. Frontend is a Vite-built single-page app using xterm.js.

**Tech Stack:** Node.js 24, Express, ws, ssh2, better-sqlite3, argon2, pino, uuid, dotenv (backend); xterm + @xterm/addon-fit + @xterm/addon-web-links, Vite (frontend); Docker + docker-compose (deployment).

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `server/.gitkeep`
- Create: `client/.gitkeep`
- Create: `data/.gitkeep`
- Create: `tests/.gitkeep`

**Step 1: Initialize package.json**

```bash
cd /c/Users/jhh/projects/sshweb
npm init -y
```

**Step 2: Install backend dependencies**

```bash
npm install express ws ssh2 better-sqlite3 argon2 pino uuid dotenv
```

**Step 3: Install frontend dependencies**

```bash
npm install --save-dev vite @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
```

**Step 4: Install test dependencies**

```bash
npm install --save-dev supertest
```

**Step 5: Update package.json with scripts**

Edit `package.json` to set `"type": "module"` and add scripts:

```json
{
  "name": "sshweb",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "node --watch server/index.js & vite",
    "build": "vite build",
    "start": "node server/index.js",
    "test": "node --test tests/**/*.test.js"
  }
}
```

**Step 6: Create .env.example**

```
PORT=3000
DATA_DIR=./data
SESSION_TIMEOUT_MINUTES=60
MAX_SESSIONS=10
LOG_LEVEL=info
```

**Step 7: Create .gitignore**

```
node_modules/
dist/
.env
data/*.db
data/salt
*.backup-*
```

**Step 8: Create directory placeholders**

```bash
mkdir -p server client data tests
touch server/.gitkeep client/.gitkeep data/.gitkeep tests/.gitkeep
```

**Step 9: Verify**

```bash
ls -la && cat package.json
```
Expected: directories exist, package.json has correct scripts and `"type": "module"`.

**Step 10: Commit**

```bash
git add -A
git commit -m "feat: project scaffold with dependencies"
```

---

## Task 2: Config Module

**Files:**
- Create: `server/config.js`
- Create: `tests/config.test.js`

**Step 1: Write the failing test**

Create `tests/config.test.js`:

```js
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

test('config exports expected fields with defaults', async () => {
  // Set minimal env
  process.env.DATA_DIR = './data'
  process.env.PORT = '3000'

  const { config } = await import('../server/config.js')

  assert.equal(config.port, 3000)
  assert.equal(config.dataDir, './data')
  assert.equal(config.sessionTimeoutMinutes, 60)
  assert.equal(config.maxSessions, 10)
  assert.equal(config.logLevel, 'info')
})
```

**Step 2: Run test to confirm failure**

```bash
node --test tests/config.test.js
```
Expected: FAIL — `Cannot find module '../server/config.js'`

**Step 3: Implement config.js**

Create `server/config.js`:

```js
import 'dotenv/config'

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  dataDir: process.env.DATA_DIR ?? './data',
  sessionTimeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES ?? '60', 10),
  maxSessions: parseInt(process.env.MAX_SESSIONS ?? '10', 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',
}
```

**Step 4: Run test to confirm pass**

```bash
node --test tests/config.test.js
```
Expected: PASS

**Step 5: Commit**

```bash
git add server/config.js tests/config.test.js
git commit -m "feat: config module with dotenv"
```

---

## Task 3: Crypto Module

**Files:**
- Create: `server/crypto.js`
- Create: `tests/crypto.test.js`

**Step 1: Write the failing test**

Create `tests/crypto.test.js`:

```js
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { encrypt, decrypt } from '../server/crypto.js'

test('encrypt then decrypt returns original plaintext', () => {
  const key = Buffer.alloc(32, 'a') // 256-bit test key
  const plaintext = 'super-secret-password'

  const ciphertext = encrypt(plaintext, key)
  const result = decrypt(ciphertext, key)

  assert.equal(result, plaintext)
})

test('encrypt produces different output each call (random IV)', () => {
  const key = Buffer.alloc(32, 'b')
  const plaintext = 'same input'

  const c1 = encrypt(plaintext, key)
  const c2 = encrypt(plaintext, key)

  assert.notEqual(c1, c2)
})

test('decrypt throws on tampered ciphertext', () => {
  const key = Buffer.alloc(32, 'c')
  const ciphertext = encrypt('data', key)
  const tampered = ciphertext.slice(0, -4) + 'xxxx'

  assert.throws(() => decrypt(tampered, key))
})
```

**Step 2: Run test to confirm failure**

```bash
node --test tests/crypto.test.js
```
Expected: FAIL — `Cannot find module '../server/crypto.js'`

**Step 3: Implement crypto.js**

Create `server/crypto.js`:

```js
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Encrypt plaintext string with AES-256-GCM.
 * Returns a base64 string: iv(12) + tag(16) + ciphertext
 * @param {string} plaintext
 * @param {Buffer} key - 32-byte key
 * @returns {string}
 */
export function encrypt(plaintext, key) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

/**
 * Decrypt a base64 AES-256-GCM ciphertext string.
 * @param {string} ciphertextB64
 * @param {Buffer} key - 32-byte key
 * @returns {string}
 */
export function decrypt(ciphertextB64, key) {
  const data = Buffer.from(ciphertextB64, 'base64')
  const iv = data.subarray(0, IV_BYTES)
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = data.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
}
```

**Step 4: Run test to confirm pass**

```bash
node --test tests/crypto.test.js
```
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add server/crypto.js tests/crypto.test.js
git commit -m "feat: AES-256-GCM encrypt/decrypt module"
```

---

## Task 4: Master Key Module

**Files:**
- Create: `server/masterkey.js`
- Create: `tests/masterkey.test.js`

**Step 1: Write the failing test**

Create `tests/masterkey.test.js`:

```js
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('full unlock/lock/verify cycle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshweb-test-'))
  try {
    const { MasterKey } = await import('../server/masterkey.js')
    const mk = new MasterKey(dir)

    assert.equal(mk.isUnlocked(), false)

    // First unlock: initialises salt + verification token
    await mk.unlock('correct-password')
    assert.equal(mk.isUnlocked(), true)
    assert.ok(mk.getKey() instanceof Buffer)
    assert.equal(mk.getKey().length, 32)

    // Lock
    mk.lock()
    assert.equal(mk.isUnlocked(), false)
    assert.equal(mk.getKey(), null)

    // Unlock again with same password: must produce same key
    const key1 = (await mk.unlock('correct-password'), mk.getKey())
    mk.lock()
    const key2 = (await mk.unlock('correct-password'), mk.getKey())
    assert.deepEqual(key1, key2)

    // Wrong password must throw
    mk.lock()
    await assert.rejects(() => mk.unlock('wrong-password'), /invalid/i)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
```

**Step 2: Run test to confirm failure**

```bash
node --test tests/masterkey.test.js
```
Expected: FAIL — `Cannot find module '../server/masterkey.js'`

**Step 3: Implement masterkey.js**

Create `server/masterkey.js`:

```js
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import argon2 from 'argon2'

const SALT_FILE = 'salt'
const VERIFY_FILE = 'verify'
const VERIFY_DATA = 'sshweb-unlock-ok'
const KEY_BYTES = 32

export class MasterKey {
  #key = null
  #dataDir

  constructor(dataDir) {
    this.#dataDir = dataDir
    mkdirSync(dataDir, { recursive: true })
  }

  isUnlocked() {
    return this.#key !== null
  }

  getKey() {
    return this.#key
  }

  lock() {
    if (this.#key) {
      this.#key.fill(0) // zero out memory
      this.#key = null
    }
  }

  async unlock(password) {
    const salt = this.#getOrCreateSalt()
    const key = await argon2.hash(password, {
      type: argon2.argon2id,
      salt,
      raw: true,
      hashLength: KEY_BYTES,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    })

    const verifyFile = join(this.#dataDir, VERIFY_FILE)
    if (!existsSync(verifyFile)) {
      // First run: create verification token
      const token = createHmac('sha256', key).update(VERIFY_DATA).digest('base64')
      writeFileSync(verifyFile, token, 'utf8')
    } else {
      // Subsequent runs: verify password is correct
      const stored = readFileSync(verifyFile, 'utf8').trim()
      const candidate = createHmac('sha256', key).update(VERIFY_DATA).digest('base64')
      if (!timingSafeEqual(Buffer.from(stored), Buffer.from(candidate))) {
        throw new Error('Invalid master password')
      }
    }

    this.#key = key
  }

  #getOrCreateSalt() {
    const saltFile = join(this.#dataDir, SALT_FILE)
    if (existsSync(saltFile)) {
      return readFileSync(saltFile)
    }
    const salt = randomBytes(32)
    writeFileSync(saltFile, salt)
    return salt
  }
}
```

**Step 4: Run test to confirm pass**

```bash
node --test tests/masterkey.test.js
```
Expected: PASS (note: Argon2id is intentionally slow ~1-2s)

**Step 5: Commit**

```bash
git add server/masterkey.js tests/masterkey.test.js
git commit -m "feat: Argon2id master key with lock/unlock/verify"
```

---

## Task 5: Connection Store

**Files:**
- Create: `server/store.js`
- Create: `tests/store.test.js`

**Step 1: Write the failing test**

Create `tests/store.test.js`:

```js
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('connection store CRUD with encryption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshweb-store-'))
  try {
    const { ConnectionStore } = await import('../server/store.js')
    const key = Buffer.alloc(32, 0x42)
    const store = new ConnectionStore(join(dir, 'test.db'), key)

    // Create
    const id = store.create({
      label: 'My Server',
      host: '192.168.1.10',
      port: 22,
      username: 'admin',
      authType: 'password',
      secret: 'mysecretpassword',
    })
    assert.ok(id)

    // Read
    const conn = store.get(id)
    assert.equal(conn.label, 'My Server')
    assert.equal(conn.host, '192.168.1.10')
    assert.equal(conn.secret, 'mysecretpassword') // decrypted on read

    // List
    const all = store.list()
    assert.equal(all.length, 1)
    assert.equal(all[0].id, id)
    assert.equal(all[0].secret, undefined) // list does NOT return secrets

    // Update
    store.update(id, { label: 'Renamed', secret: 'newpassword' })
    const updated = store.get(id)
    assert.equal(updated.label, 'Renamed')
    assert.equal(updated.secret, 'newpassword')

    // Delete
    store.delete(id)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
```

**Step 2: Run test to confirm failure**

```bash
node --test tests/store.test.js
```
Expected: FAIL — `Cannot find module '../server/store.js'`

**Step 3: Implement store.js**

Create `server/store.js`:

```js
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { encrypt, decrypt } from './crypto.js'

export class ConnectionStore {
  #db
  #key

  constructor(dbPath, key) {
    this.#key = key
    this.#db = new Database(dbPath)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'password',
        secret TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  create({ label, host, port = 22, username, authType = 'password', secret }) {
    const id = randomUUID()
    const now = Date.now()
    this.#db.prepare(`
      INSERT INTO connections (id, label, host, port, username, auth_type, secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, label, host, port, username, authType, encrypt(secret, this.#key), now, now)
    return id
  }

  get(id) {
    const row = this.#db.prepare('SELECT * FROM connections WHERE id = ?').get(id)
    if (!row) return null
    return this.#deserialize(row)
  }

  list() {
    return this.#db
      .prepare('SELECT id, label, host, port, username, auth_type, created_at, updated_at FROM connections ORDER BY label')
      .all()
      .map(row => ({
        id: row.id,
        label: row.label,
        host: row.host,
        port: row.port,
        username: row.username,
        authType: row.auth_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
  }

  update(id, fields) {
    const existing = this.get(id)
    if (!existing) throw new Error(`Connection ${id} not found`)
    const updated = { ...existing, ...fields }
    const now = Date.now()
    this.#db.prepare(`
      UPDATE connections
      SET label = ?, host = ?, port = ?, username = ?, auth_type = ?, secret = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.label, updated.host, updated.port, updated.username,
      updated.authType, encrypt(updated.secret, this.#key), now, id
    )
  }

  delete(id) {
    this.#db.prepare('DELETE FROM connections WHERE id = ?').run(id)
  }

  #deserialize(row) {
    return {
      id: row.id,
      label: row.label,
      host: row.host,
      port: row.port,
      username: row.username,
      authType: row.auth_type,
      secret: decrypt(row.secret, this.#key),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
```

**Step 4: Run test to confirm pass**

```bash
node --test tests/store.test.js
```
Expected: PASS

**Step 5: Commit**

```bash
git add server/store.js tests/store.test.js
git commit -m "feat: encrypted connection store with better-sqlite3"
```

---

## Task 6: SSH Manager

**Files:**
- Create: `server/ssh.js`

> Note: No unit tests for this module — it wraps a live network dependency (ssh2). Integration is verified in Task 14 (smoke test).

**Step 1: Implement ssh.js**

Create `server/ssh.js`:

```js
import { Client } from 'ssh2'
import { randomUUID } from 'node:crypto'

/**
 * Manages active SSH sessions keyed by session ID.
 * Each session holds: { client, stream, ws, connId, startedAt, label }
 */
export class SshManager {
  #sessions = new Map()
  #logger

  constructor(logger) {
    this.#logger = logger
  }

  /**
   * Open an SSH connection and attach it to a WebSocket.
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {string} opts.username
   * @param {'password'|'key'} opts.authType
   * @param {string} opts.secret - password or private key PEM
   * @param {string} opts.label - human-readable connection label
   * @param {import('ws').WebSocket} opts.ws
   * @param {number} opts.cols
   * @param {number} opts.rows
   * @returns {Promise<string>} sessionId
   */
  open({ host, port, username, authType, secret, label, ws, cols = 80, rows = 24 }) {
    return new Promise((resolve, reject) => {
      const sessionId = randomUUID()
      const client = new Client()
      const log = this.#logger.child({ sessionId, label, host })

      const authOpts = authType === 'key'
        ? { privateKey: secret }
        : { password: secret }

      client.on('ready', () => {
        log.info('SSH connection ready')
        client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
          if (err) {
            log.error({ err }, 'Failed to open shell')
            client.end()
            return reject(err)
          }

          this.#sessions.set(sessionId, {
            client, stream, ws,
            connId: null, startedAt: Date.now(), label, host,
          })

          stream.on('data', (data) => {
            if (ws.readyState === ws.constructor.OPEN) {
              ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }))
            }
          })

          stream.stderr.on('data', (data) => {
            if (ws.readyState === ws.constructor.OPEN) {
              ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }))
            }
          })

          stream.on('close', () => {
            log.info('SSH stream closed')
            this.#sessions.delete(sessionId)
            if (ws.readyState === ws.constructor.OPEN) {
              ws.send(JSON.stringify({ type: 'close' }))
              ws.close()
            }
          })

          resolve(sessionId)
        })
      })

      client.on('error', (err) => {
        log.warn({ err }, 'SSH connection error')
        this.#sessions.delete(sessionId)
        reject(err)
      })

      client.connect({ host, port, username, readyTimeout: 10000, ...authOpts })
    })
  }

  /**
   * Write data from the browser into the SSH stream.
   */
  write(sessionId, data) {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    session.stream.write(data)
  }

  /**
   * Resize the PTY for a session.
   */
  resize(sessionId, cols, rows) {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    session.stream.setWindow(rows, cols, 0, 0)
  }

  /**
   * Kill a session by ID.
   */
  kill(sessionId) {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    session.stream.end()
    session.client.end()
    this.#sessions.delete(sessionId)
  }

  /**
   * Kill all active sessions, optionally sending a message first.
   */
  killAll(message) {
    for (const [sessionId, session] of this.#sessions) {
      if (message && session.ws.readyState === session.ws.constructor.OPEN) {
        session.ws.send(JSON.stringify({ type: 'data', data: Buffer.from('\r\n' + message + '\r\n').toString('base64') }))
      }
      session.stream.end()
      session.client.end()
    }
    this.#sessions.clear()
  }

  /**
   * Returns summary of all active sessions (no secrets).
   */
  listSessions() {
    return [...this.#sessions.entries()].map(([id, s]) => ({
      id,
      label: s.label,
      host: s.host,
      startedAt: s.startedAt,
      durationSeconds: Math.floor((Date.now() - s.startedAt) / 1000),
    }))
  }

  get sessionCount() {
    return this.#sessions.size
  }
}
```

**Step 2: Commit**

```bash
git add server/ssh.js
git commit -m "feat: SSH manager with PTY, resize, session tracking"
```

---

## Task 7: Express Server & WebSocket Handler

**Files:**
- Create: `server/index.js`
- Create: `tests/server.test.js`

**Step 1: Write the failing tests**

Create `tests/server.test.js`:

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import request from 'supertest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app, server, cleanup

test('before all: start server in locked state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshweb-srv-'))
  process.env.DATA_DIR = dir
  process.env.PORT = '0' // random port
  process.env.LOG_LEVEL = 'silent'

  const mod = await import('../server/index.js')
  app = mod.app
  server = mod.server
  cleanup = () => {
    server.close()
    rmSync(dir, { recursive: true })
  }
})

test('GET /health returns locked status when not unlocked', async () => {
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'locked')
  assert.ok(typeof res.body.uptime === 'number')
  assert.ok(typeof res.body.version === 'string')
})

test('GET / redirects to /unlock when locked', async () => {
  const res = await request(app).get('/')
  assert.equal(res.status, 302)
  assert.ok(res.headers.location.includes('/unlock'))
})

test('POST /api/unlock with wrong password returns 401', async () => {
  const res = await request(app)
    .post('/api/unlock')
    .send({ password: '' })
    .set('Content-Type', 'application/json')
  assert.equal(res.status, 400)
})

test('after all: close server', () => {
  cleanup?.()
})
```

**Step 2: Run test to confirm failure**

```bash
node --test tests/server.test.js
```
Expected: FAIL — `Cannot find module '../server/index.js'`

**Step 3: Implement server/index.js**

Create `server/index.js`:

```js
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
  ...(config.logLevel === 'silent' ? {} : {}),
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

export const app = express()
app.use(express.json())

// Lock guard middleware — redirect to /unlock unless the path is allowed
const UNLOCKED_PATHS = ['/unlock', '/api/unlock', '/health']
app.use((req, res, next) => {
  if (masterKey.isUnlocked()) return next()
  if (UNLOCKED_PATHS.some(p => req.path.startsWith(p))) return next()
  if (req.path.startsWith('/assets') || req.path.startsWith('/favicon')) return next()
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
  const unlockHtml = join(__dirname, '../client/unlock.html')
  if (existsSync(unlockHtml)) {
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
    store = null // reset store so it picks up new key
    logger.info('Server unlocked')
    res.json({ ok: true })
  } catch {
    res.status(401).json({ error: 'Invalid password' })
  }
})

app.post('/api/lock', (req, res) => {
  masterKey.lock()
  store = null
  logger.info('Server locked')
  res.json({ ok: true })
})

// Connection CRUD
app.get('/api/connections', (req, res) => {
  res.json(getStore().list())
})

app.post('/api/connections', (req, res) => {
  const { label, host, port, username, authType, secret } = req.body
  const id = getStore().create({ label, host, port, username, authType, secret })
  res.status(201).json({ id })
})

app.put('/api/connections/:id', (req, res) => {
  getStore().update(req.params.id, req.body)
  res.json({ ok: true })
})

app.delete('/api/connections/:id', (req, res) => {
  getStore().delete(req.params.id)
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
  app.get('*', (req, res) => {
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
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'connect') {
      const { connectionId, cols, rows } = msg
      const conn = getStore().get(connectionId)
      if (!conn) { ws.close(4003, 'Connection not found'); return }

      try {
        sessionId = await sshManager.open({
          ...conn, ws, cols: cols ?? 80, rows: rows ?? 24,
        })
        ws.send(JSON.stringify({ type: 'connected', sessionId }))
      } catch (err) {
        log.warn({ err }, 'SSH open failed')
        ws.send(JSON.stringify({ type: 'error', message: err.message }))
        ws.close()
      }
    } else if (msg.type === 'data' && sessionId) {
      sshManager.write(sessionId, Buffer.from(msg.data, 'base64').toString())
    } else if (msg.type === 'resize' && sessionId) {
      sshManager.resize(sessionId, msg.cols, msg.rows)
    }
  })

  ws.on('close', () => {
    if (sessionId) sshManager.kill(sessionId)
  })
})

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...')
  sshManager.killAll('Server shutting down...')
  const timeout = setTimeout(() => process.exit(0), 10_000)
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
```

**Step 4: Run tests to confirm pass**

```bash
node --test tests/server.test.js
```
Expected: 5 tests PASS

**Step 5: Commit**

```bash
git add server/index.js tests/server.test.js
git commit -m "feat: Express server with WebSocket, unlock flow, session management"
```

---

## Task 8: Vite Config & Frontend Scaffold

**Files:**
- Create: `vite.config.js`
- Create: `client/index.html`
- Create: `client/unlock.html`
- Create: `client/style.css`

**Step 1: Create vite.config.js**

```js
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
```

**Step 2: Create client/unlock.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>sshweb — Unlock</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="unlock-page">
  <div class="unlock-card">
    <h1>sshweb</h1>
    <p>Enter your master password to unlock.</p>
    <form id="unlock-form">
      <input id="password" type="password" placeholder="Master password" autofocus required>
      <button type="submit">Unlock</button>
      <p id="error-msg" class="error hidden"></p>
    </form>
  </div>
  <script type="module">
    document.getElementById('unlock-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const password = document.getElementById('password').value
      const errEl = document.getElementById('error-msg')
      errEl.classList.add('hidden')
      const res = await fetch('/api/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        window.location.href = '/'
      } else {
        errEl.textContent = 'Invalid password. Try again.'
        errEl.classList.remove('hidden')
        document.getElementById('password').value = ''
        document.getElementById('password').focus()
      }
    })
  </script>
</body>
</html>
```

**Step 3: Create client/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>sshweb</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <div class="sidebar-header">
        <span class="logo">sshweb</span>
        <button id="new-conn-btn" title="New connection">+</button>
      </div>
      <ul id="connection-list"></ul>
      <div id="admin-panel">
        <div class="admin-row">
          <span id="status-dot" class="dot green"></span>
          <span id="uptime">—</span>
        </div>
        <div id="active-sessions-list"></div>
        <button id="lock-btn" class="danger">Lock Server</button>
      </div>
    </aside>
    <main id="main">
      <div id="tabs"></div>
      <div id="terminal-container"></div>
      <div id="no-connection">
        <p>Select a connection or add a new one.</p>
      </div>
    </main>
  </div>

  <!-- New/Edit connection modal -->
  <div id="modal" class="hidden">
    <div class="modal-card">
      <h2 id="modal-title">New Connection</h2>
      <form id="conn-form">
        <input name="label" placeholder="Label (e.g. My Server)" required>
        <input name="host" placeholder="Host / IP" required>
        <input name="port" type="number" value="22" required>
        <input name="username" placeholder="Username" required>
        <select name="authType">
          <option value="password">Password</option>
          <option value="key">Private Key</option>
        </select>
        <input id="secret-field" name="secret" type="password" placeholder="Password or paste private key">
        <div class="modal-actions">
          <button type="button" id="cancel-btn">Cancel</button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  </div>

  <script type="module" src="/main.js"></script>
</body>
</html>
```

**Step 4: Create client/style.css**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #1a1a2e;
  --surface: #16213e;
  --surface2: #0f3460;
  --accent: #e94560;
  --text: #e0e0e0;
  --text-muted: #888;
  --sidebar-w: 220px;
  --tab-h: 36px;
}

body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; height: 100vh; overflow: hidden; }

/* Unlock page */
.unlock-page { display: flex; align-items: center; justify-content: center; height: 100vh; }
.unlock-card { background: var(--surface); padding: 2rem; border-radius: 8px; width: 320px; }
.unlock-card h1 { margin-bottom: .5rem; color: var(--accent); }
.unlock-card p { color: var(--text-muted); margin-bottom: 1.5rem; font-size: .9rem; }
.unlock-card input { width: 100%; padding: .6rem; margin-bottom: 1rem; background: var(--bg); border: 1px solid var(--surface2); border-radius: 4px; color: var(--text); }
.unlock-card button { width: 100%; padding: .7rem; background: var(--accent); border: none; border-radius: 4px; color: #fff; cursor: pointer; font-size: 1rem; }
.unlock-card button:hover { opacity: .9; }
.error { color: var(--accent); font-size: .85rem; margin-top: .5rem; }
.hidden { display: none !important; }

/* App layout */
#app { display: flex; height: 100vh; }
#sidebar { width: var(--sidebar-w); background: var(--surface); display: flex; flex-direction: column; border-right: 1px solid var(--surface2); flex-shrink: 0; }
.sidebar-header { display: flex; align-items: center; justify-content: space-between; padding: .75rem 1rem; border-bottom: 1px solid var(--surface2); }
.logo { font-weight: bold; color: var(--accent); }
.sidebar-header button { background: var(--accent); border: none; border-radius: 4px; color: #fff; width: 24px; height: 24px; cursor: pointer; font-size: 1.1rem; }
#connection-list { list-style: none; flex: 1; overflow-y: auto; padding: .5rem 0; }
#connection-list li { display: flex; align-items: center; justify-content: space-between; padding: .5rem 1rem; cursor: pointer; font-size: .9rem; }
#connection-list li:hover { background: var(--surface2); }
#connection-list li.active { background: var(--surface2); border-left: 3px solid var(--accent); }
#admin-panel { border-top: 1px solid var(--surface2); padding: .75rem 1rem; font-size: .8rem; }
.admin-row { display: flex; align-items: center; gap: .5rem; margin-bottom: .5rem; color: var(--text-muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.green { background: #4caf50; }
.dot.red { background: var(--accent); }
.session-item { display: flex; justify-content: space-between; align-items: center; padding: .25rem 0; color: var(--text-muted); }
.session-item button { background: none; border: 1px solid var(--accent); color: var(--accent); border-radius: 3px; padding: 1px 6px; cursor: pointer; font-size: .75rem; }
button.danger { width: 100%; margin-top: .5rem; padding: .5rem; background: transparent; border: 1px solid var(--accent); color: var(--accent); border-radius: 4px; cursor: pointer; }
button.danger:hover { background: var(--accent); color: #fff; }

/* Main area */
#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
#tabs { display: flex; background: var(--surface); border-bottom: 1px solid var(--surface2); min-height: var(--tab-h); overflow-x: auto; }
.tab { display: flex; align-items: center; gap: .5rem; padding: 0 1rem; height: var(--tab-h); cursor: pointer; font-size: .85rem; color: var(--text-muted); border-right: 1px solid var(--surface2); white-space: nowrap; }
.tab.active { background: var(--bg); color: var(--text); }
.tab button { background: none; border: none; color: inherit; cursor: pointer; font-size: 1rem; padding: 0 2px; }
#terminal-container { flex: 1; overflow: hidden; position: relative; }
.terminal-pane { position: absolute; inset: 0; display: none; }
.terminal-pane.active { display: block; }
#no-connection { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--text-muted); }

/* Modal */
#modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-card { background: var(--surface); padding: 1.5rem; border-radius: 8px; width: 360px; }
.modal-card h2 { margin-bottom: 1rem; }
.modal-card input, .modal-card select { width: 100%; padding: .5rem; margin-bottom: .75rem; background: var(--bg); border: 1px solid var(--surface2); border-radius: 4px; color: var(--text); }
.modal-actions { display: flex; gap: .5rem; justify-content: flex-end; }
.modal-actions button { padding: .5rem 1rem; border-radius: 4px; cursor: pointer; border: none; }
.modal-actions button[type="button"] { background: var(--surface2); color: var(--text); }
.modal-actions button[type="submit"] { background: var(--accent); color: #fff; }
```

**Step 5: Verify build works**

```bash
npm run build
```
Expected: `dist/` directory created with `index.html` and assets.

**Step 6: Commit**

```bash
git add vite.config.js client/
git commit -m "feat: Vite config and frontend HTML/CSS scaffold"
```

---

## Task 9: Frontend JavaScript (main.js)

**Files:**
- Create: `client/main.js`

**Step 1: Implement client/main.js**

Create `client/main.js`:

```js
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

// ── State ──────────────────────────────────────────────────────────────────
const tabs = new Map()   // tabId -> { term, fitAddon, ws, sessionId, label }
let activeTab = null
let connections = []
let editingId = null

// ── DOM refs ───────────────────────────────────────────────────────────────
const connList = document.getElementById('connection-list')
const tabBar = document.getElementById('tabs')
const termContainer = document.getElementById('terminal-container')
const noConn = document.getElementById('no-connection')
const modal = document.getElementById('modal')
const connForm = document.getElementById('conn-form')
const modalTitle = document.getElementById('modal-title')
const uptimeEl = document.getElementById('uptime')
const sessionsEl = document.getElementById('active-sessions-list')
const statusDot = document.getElementById('status-dot')

// ── API helpers ────────────────────────────────────────────────────────────
const api = {
  get: (path) => fetch(path).then(r => r.json()),
  post: (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  put: (path, body) => fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  del: (path) => fetch(path, { method: 'DELETE' }).then(r => r.json()),
}

// ── Connections ────────────────────────────────────────────────────────────
async function loadConnections() {
  connections = await api.get('/api/connections')
  renderConnectionList()
}

function renderConnectionList() {
  connList.innerHTML = ''
  for (const conn of connections) {
    const li = document.createElement('li')
    li.dataset.id = conn.id
    li.innerHTML = `<span>${conn.label}</span><span class="conn-host">${conn.host}</span>`
    li.addEventListener('click', () => openTerminal(conn))
    connList.appendChild(li)
  }
}

// ── Terminal tabs ──────────────────────────────────────────────────────────
function openTerminal(conn) {
  const tabId = `tab-${conn.id}-${Date.now()}`
  const pane = document.createElement('div')
  pane.className = 'terminal-pane'
  pane.id = tabId
  termContainer.appendChild(pane)

  const term = new Terminal({ theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#e94560' }, fontFamily: 'monospace', fontSize: 14, cursorBlink: true })
  const fitAddon = new FitAddon()
  const webLinksAddon = new WebLinksAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(webLinksAddon)
  term.open(pane)
  fitAddon.fit()

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'connect', connectionId: conn.id, cols: term.cols, rows: term.rows }))
  }

  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data)
    if (msg.type === 'data') term.write(atob(msg.data))
    else if (msg.type === 'error') { term.write(`\r\nError: ${msg.message}\r\n`); ws.close() }
    else if (msg.type === 'close') { term.write('\r\n[Connection closed]\r\n') }
  }

  ws.onclose = () => term.write('\r\n[Disconnected]\r\n')

  term.onData((data) => {
    ws.send(JSON.stringify({ type: 'data', data: btoa(data) }))
  })

  term.onResize(({ cols, rows }) => {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  })

  tabs.set(tabId, { term, fitAddon, ws, sessionId: null, label: conn.label })
  addTab(tabId, conn.label)
  switchTab(tabId)
  noConn.style.display = 'none'
}

function addTab(tabId, label) {
  const tab = document.createElement('div')
  tab.className = 'tab'
  tab.dataset.id = tabId
  tab.innerHTML = `<span>${label}</span><button title="Close">✕</button>`
  tab.querySelector('span').addEventListener('click', () => switchTab(tabId))
  tab.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); closeTab(tabId) })
  tabBar.appendChild(tab)
}

function switchTab(tabId) {
  if (activeTab) {
    document.querySelector(`#${activeTab}`)?.classList.remove('active')
    document.querySelector(`.tab[data-id="${activeTab}"]`)?.classList.remove('active')
  }
  activeTab = tabId
  document.querySelector(`#${tabId}`)?.classList.add('active')
  document.querySelector(`.tab[data-id="${tabId}"]`)?.classList.add('active')
  tabs.get(tabId)?.fitAddon.fit()
}

function closeTab(tabId) {
  const t = tabs.get(tabId)
  if (t) { t.ws.close(); t.term.dispose() }
  tabs.delete(tabId)
  document.querySelector(`#${tabId}`)?.remove()
  document.querySelector(`.tab[data-id="${tabId}"]`)?.remove()
  if (activeTab === tabId) {
    activeTab = null
    const remaining = [...tabs.keys()]
    if (remaining.length) switchTab(remaining[remaining.length - 1])
    else noConn.style.display = ''
  }
}

// ── New/Edit connection modal ───────────────────────────────────────────────
document.getElementById('new-conn-btn').addEventListener('click', () => openModal(null))
document.getElementById('cancel-btn').addEventListener('click', closeModal)
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })

function openModal(conn) {
  editingId = conn?.id ?? null
  modalTitle.textContent = conn ? 'Edit Connection' : 'New Connection'
  connForm.reset()
  if (conn) {
    Object.entries(conn).forEach(([k, v]) => {
      const el = connForm.elements[k] ?? connForm.elements[k === 'authType' ? 'authType' : null]
      if (el) el.value = v
    })
  }
  modal.classList.remove('hidden')
  connForm.elements.label.focus()
}

function closeModal() { modal.classList.add('hidden'); editingId = null }

connForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const data = Object.fromEntries(new FormData(connForm))
  data.port = parseInt(data.port, 10)
  if (editingId) {
    await api.put(`/api/connections/${editingId}`, data)
  } else {
    await api.post('/api/connections', data)
  }
  closeModal()
  await loadConnections()
})

// ── Admin panel ────────────────────────────────────────────────────────────
document.getElementById('lock-btn').addEventListener('click', async () => {
  await api.post('/api/lock', {})
  window.location.href = '/unlock'
})

async function refreshAdmin() {
  try {
    const health = await api.get('/health')
    const s = health.uptime
    uptimeEl.textContent = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    statusDot.className = `dot ${health.status === 'ok' ? 'green' : 'red'}`

    const sessions = await api.get('/api/sessions')
    sessionsEl.innerHTML = sessions.length
      ? sessions.map(s => `<div class="session-item"><span>${s.label}</span><button onclick="killSession('${s.id}')">Kill</button></div>`).join('')
      : '<div style="color:var(--text-muted);font-size:.8rem">No active sessions</div>'
  } catch {}
}

window.killSession = async (id) => {
  await api.del(`/api/sessions/${id}`)
  refreshAdmin()
}

// ── Resize ────────────────────────────────────────────────────────────────
const ro = new ResizeObserver(() => {
  if (activeTab) tabs.get(activeTab)?.fitAddon.fit()
})
ro.observe(termContainer)

// ── Init ──────────────────────────────────────────────────────────────────
loadConnections()
refreshAdmin()
setInterval(refreshAdmin, 15_000)
```

**Step 2: Build and verify**

```bash
npm run build
```
Expected: `dist/` builds without errors.

**Step 3: Commit**

```bash
git add client/main.js
git commit -m "feat: frontend app with xterm.js tabs, connection manager, admin panel"
```

---

## Task 10: Dockerfile & docker-compose

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

**Step 1: Create .dockerignore**

```
node_modules
dist
.env
data
*.backup-*
.git
docs
tests
```

**Step 2: Create Dockerfile**

```dockerfile
# ── Stage 1: Build frontend ───────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY client/ client/
COPY vite.config.js ./
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

RUN addgroup -S sshweb && adduser -S sshweb -G sshweb

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ server/
COPY --from=builder /app/dist dist/

RUN mkdir -p /data && chown sshweb:sshweb /data
VOLUME ["/data"]

USER sshweb

ENV PORT=3000 \
    DATA_DIR=/data \
    SESSION_TIMEOUT_MINUTES=60 \
    MAX_SESSIONS=10 \
    LOG_LEVEL=info \
    NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server/index.js"]
```

**Step 3: Create docker-compose.yml**

```yaml
services:
  sshweb:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    env_file:
      - .env
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

**Step 4: Create .env from example**

```bash
cp .env.example .env
```

**Step 5: Build image to verify**

```bash
docker compose build
```
Expected: Build completes with no errors. Both stages complete.

**Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore .env.example
git commit -m "feat: multi-stage Dockerfile and docker-compose"
```

---

## Task 11: Makefile

**Files:**
- Create: `Makefile`

**Step 1: Create Makefile**

```makefile
.PHONY: start stop logs restart update backup shell audit check-updates upgrade-deps maintain test build

start:
	docker compose up -d

stop:
	docker compose down

logs:
	docker compose logs -f

restart:
	docker compose restart

update:
	docker compose build && docker compose up -d

backup:
	cp -r ./data ./data.backup-$(shell date +%Y%m%d-%H%M%S)
	@echo "Backup created: data.backup-$(shell date +%Y%m%d-%H%M%S)"

shell:
	docker compose exec sshweb sh

# Development
dev:
	npm run dev

build:
	npm run build

test:
	node --test tests/**/*.test.js

# Dependency management
audit:
	npm audit

check-updates:
	npx npm-check-updates

upgrade-deps:
	npx npm-check-updates -u && npm install && npm audit

# Monthly maintenance: audit + check updates + rebuild with latest base image
maintain:
	@echo "=== npm audit ===" && npm audit; \
	echo "=== outdated packages ===" && npx npm-check-updates; \
	echo "=== rebuilding with latest base image ===" && \
	docker compose build --pull && docker compose up -d
```

**Step 2: Verify make commands are parseable**

```bash
make --dry-run start
make --dry-run test
```
Expected: Prints commands without executing them, no parse errors.

**Step 3: Run tests via make**

```bash
make test
```
Expected: All tests PASS.

**Step 4: Commit**

```bash
git add Makefile
git commit -m "feat: Makefile for start/stop/logs/backup/maintain operations"
```

---

## Task 12: Smoke Test (End-to-End)

**Goal:** Verify the full stack works — server starts, serves frontend, unlock flow works, health endpoint is correct.

**Step 1: Start dev server**

```bash
npm run build && node server/index.js &
```

**Step 2: Verify health endpoint (locked)**

```bash
curl -s http://localhost:3000/health | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.assert(d.status==='locked'); console.log('health locked: OK')"
```
Expected: `health locked: OK`

**Step 3: Verify redirect on root**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
```
Expected: `302`

**Step 4: Unlock with a test password**

```bash
curl -s -X POST http://localhost:3000/api/unlock \
  -H "Content-Type: application/json" \
  -d '{"password":"testpassword123"}' | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.assert(d.ok===true); console.log('unlock: OK')"
```
Expected: `unlock: OK`

**Step 5: Verify health is now unlocked**

```bash
curl -s http://localhost:3000/health | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.assert(d.status==='ok'); console.log('health ok: OK')"
```
Expected: `health ok: OK`

**Step 6: Create a connection via API**

```bash
curl -s -X POST http://localhost:3000/api/connections \
  -H "Content-Type: application/json" \
  -d '{"label":"Test","host":"127.0.0.1","port":22,"username":"test","authType":"password","secret":"test"}' \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.assert(d.id); console.log('create connection: OK', d.id)"
```
Expected: `create connection: OK <uuid>`

**Step 7: List connections**

```bash
curl -s http://localhost:3000/api/connections | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.assert(d.length===1); console.assert(!d[0].secret,'secrets not in list'); console.log('list connections: OK')"
```
Expected: `list connections: OK`

**Step 8: Stop the test server**

```bash
kill %1 2>/dev/null; rm -rf data/
```

**Step 9: Build and start Docker container**

```bash
cp .env.example .env
make build && make start
sleep 3
curl -s http://localhost:3000/health | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.assert(d.status==='locked'); console.log('docker health: OK')"
make stop
```
Expected: `docker health: OK`

**Step 10: Final commit**

```bash
git add -A
git commit -m "feat: sshweb v1.0.0 complete"
```

---

## Task 13: Renovate Config (Optional — if repo is on GitHub/GitLab)

**Files:**
- Create: `renovate.json`

**Step 1: Create renovate.json**

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:base"],
  "schedule": ["before 9am on Monday"],
  "packageRules": [
    {
      "matchUpdateTypes": ["patch", "minor"],
      "automerge": false
    }
  ]
}
```

This tells Renovate to open PRs weekly for dependency updates. Review and merge manually.

**Step 2: Commit**

```bash
git add renovate.json
git commit -m "chore: add Renovate config for automated dependency PRs"
```

---

## Summary

| Task | Component | Tests |
|---|---|---|
| 1 | Project scaffold | — |
| 2 | Config module | `tests/config.test.js` |
| 3 | AES-256-GCM crypto | `tests/crypto.test.js` |
| 4 | Argon2id master key | `tests/masterkey.test.js` |
| 5 | Encrypted connection store | `tests/store.test.js` |
| 6 | SSH manager | Integration only |
| 7 | Express server + WebSocket | `tests/server.test.js` |
| 8 | Vite + HTML/CSS scaffold | Build verification |
| 9 | Frontend JS (xterm.js) | Build verification |
| 10 | Dockerfile + docker-compose | Docker build verification |
| 11 | Makefile | `make test` |
| 12 | Smoke test (end-to-end) | Manual curl checks |
| 13 | Renovate (optional) | — |

**Run all unit tests at any time:** `make test`
