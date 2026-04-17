# Browser Tab Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use godmode:task-runner to implement this plan task-by-task.

**Goal:** Add a browser tab to sshweb that lets the user reach internal HTTP/HTTPS admin UIs on private IPs through an in-container proxy, with saved bookmarks, per-session cookie isolation, and tab restore on reload.

**Architecture:** Express mounts a `/proxy/<url>` route powered by the [`unblocker`](https://www.npmjs.com/package/unblocker) npm library. A sshweb-specific middleware chain (session guard → private-IP guard with DNS pinning → TLS policy → per-session cookie jar) runs before `unblocker` fetches and streams upstream responses. Client gains a sidebar "Web" section (bookmarks) and a new tab kind that renders an iframe pointed at `/proxy/<url>` with URL/back/forward/refresh chrome.

**Tech Stack:** Node 24, Express 5, better-sqlite3, `unblocker` (new), `tough-cookie` (new), vanilla DOM client, Vite dev bundler, `node --test` for unit tests, `supertest` for HTTP tests.

**Reference design:** `docs/plans/2026-04-17-browser-tab-design.md`

**Working convention:** sshweb ships from `master`. Create a feature branch `feat/browser-tab` for these tasks; merge to `master` at the end. No remote push until the user asks.

---

## Task 0: Prep branch and install dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`

**Step 1: Create feature branch**

Run:
```bash
git checkout -b feat/browser-tab
```
Expected: `Switched to a new branch 'feat/browser-tab'`

**Step 2: Install runtime deps**

Run:
```bash
npm install unblocker tough-cookie
```
Expected: both appear under `dependencies` in `package.json`; `npm audit` surfaces no critical issues (pre-existing warnings are OK).

**Step 3: Verify baseline tests still pass**

Run:
```bash
npm test
```
Expected: all existing tests pass. Fix any environmental break before proceeding.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add unblocker and tough-cookie deps for browser tab"
```

---

## Task 1: Bookmark store (SQLite CRUD)

**Files:**
- Create: `server/bookmarks.js`
- Create: `tests/bookmarks.test.js`

**Step 1: Write the failing test**

Create `tests/bookmarks.test.js`:

```js
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('bookmark store CRUD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshweb-bm-'))
  try {
    const { BookmarkStore } = await import('../server/bookmarks.js')
    const store = new BookmarkStore(join(dir, 'bookmarks.db'))

    const id = store.create({ label: 'Pi-hole', url: 'http://192.168.1.5/admin', ignoreTls: false })
    assert.ok(id)

    const bm = store.get(id)
    assert.equal(bm.label, 'Pi-hole')
    assert.equal(bm.url, 'http://192.168.1.5/admin')
    assert.equal(bm.ignoreTls, false)

    const all = store.list()
    assert.equal(all.length, 1)

    store.update(id, { label: 'Pi-hole (renamed)', ignoreTls: true })
    const updated = store.get(id)
    assert.equal(updated.label, 'Pi-hole (renamed)')
    assert.equal(updated.ignoreTls, true)

    store.delete(id)
    assert.equal(store.list().length, 0)

    store.close()
  } finally {
    rmSync(dir, { recursive: true })
  }
})
```

**Step 2: Run test, confirm failure**

Run: `node --test tests/bookmarks.test.js`
Expected: FAIL — `Cannot find module '.../server/bookmarks.js'`.

**Step 3: Implement `server/bookmarks.js`**

Create the file:

```js
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export class BookmarkStore {
  #db

  constructor(dbPath) {
    this.#db = new Database(dbPath)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id         TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        url        TEXT NOT NULL,
        ignore_tls INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  create({ label, url, ignoreTls = false, sortOrder = 0 }) {
    const id = randomUUID()
    const now = Date.now()
    this.#db.prepare(`
      INSERT INTO bookmarks (id, label, url, ignore_tls, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, label, url, ignoreTls ? 1 : 0, sortOrder, now, now)
    return id
  }

  get(id) {
    const row = this.#db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id)
    return row ? this.#deserialize(row) : null
  }

  list() {
    return this.#db
      .prepare('SELECT * FROM bookmarks ORDER BY sort_order, label')
      .all()
      .map(r => this.#deserialize(r))
  }

  update(id, fields) {
    const existing = this.get(id)
    if (!existing) throw new Error(`Bookmark ${id} not found`)
    const updated = { ...existing, ...fields }
    const now = Date.now()
    this.#db.prepare(`
      UPDATE bookmarks
      SET label = ?, url = ?, ignore_tls = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `).run(updated.label, updated.url, updated.ignoreTls ? 1 : 0, updated.sortOrder ?? 0, now, id)
  }

  delete(id) {
    this.#db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
  }

  close() { this.#db.close() }

  #deserialize(row) {
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      ignoreTls: row.ignore_tls === 1,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
```

**Step 4: Re-run test, confirm pass**

Run: `node --test tests/bookmarks.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/bookmarks.js tests/bookmarks.test.js
git commit -m "feat(bookmarks): add SQLite store for web bookmarks"
```

---

## Task 2: Private-IP guard utility

**Files:**
- Create: `server/netguard.js`
- Create: `tests/netguard.test.js`

**Step 1: Write the failing test**

Create `tests/netguard.test.js`:

```js
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isPrivateAddress, classifyHost } from '../server/netguard.js'

test('isPrivateAddress — RFC1918 + loopback', () => {
  assert.equal(isPrivateAddress('10.0.0.1'), true)
  assert.equal(isPrivateAddress('172.16.5.5'), true)
  assert.equal(isPrivateAddress('172.31.255.255'), true)
  assert.equal(isPrivateAddress('192.168.1.1'), true)
  assert.equal(isPrivateAddress('127.0.0.1'), true)
  assert.equal(isPrivateAddress('::1'), true)
  assert.equal(isPrivateAddress('fc00::1'), true)
  assert.equal(isPrivateAddress('fe80::1'), true)

  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('1.1.1.1'), false)
  assert.equal(isPrivateAddress('172.32.0.1'), false)
  assert.equal(isPrivateAddress('2606:4700::1'), false)
})

test('classifyHost resolves DNS names and rejects public resolutions', async () => {
  // Literal private IP passes without DNS
  const ok = await classifyHost('192.168.0.1')
  assert.equal(ok.allowed, true)
  assert.equal(ok.resolvedIp, '192.168.0.1')

  // Literal public IP rejected
  const bad = await classifyHost('8.8.8.8')
  assert.equal(bad.allowed, false)
  assert.match(bad.reason, /public/i)
})
```

**Step 2: Confirm failure**

Run: `node --test tests/netguard.test.js`
Expected: FAIL — module not found.

**Step 3: Implement `server/netguard.js`**

```js
import { promises as dns } from 'node:dns'
import net from 'node:net'

const PRIVATE_V4_RANGES = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
]

function ipToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc * 256) + Number(oct), 0)
}

function inV4Range(ip, base, prefix) {
  const ipN = ipToLong(ip)
  const baseN = ipToLong(base)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ipN & mask) === (baseN & mask)
}

export function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    return PRIVATE_V4_RANGES.some(([b, p]) => inV4Range(addr, b, p))
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase()
    if (lower === '::1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true // link-local
    return false
  }
  return false
}

export async function classifyHost(hostname) {
  if (net.isIP(hostname)) {
    return isPrivateAddress(hostname)
      ? { allowed: true, resolvedIp: hostname }
      : { allowed: false, reason: 'Target is a public IP address' }
  }
  let addrs
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch (err) {
    return { allowed: false, reason: `DNS lookup failed: ${err.code || err.message}` }
  }
  for (const { address } of addrs) {
    if (!isPrivateAddress(address)) {
      return { allowed: false, reason: `Hostname resolves to public IP ${address}` }
    }
  }
  return { allowed: true, resolvedIp: addrs[0].address }
}
```

**Step 4: Re-run test, confirm pass**

Run: `node --test tests/netguard.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/netguard.js tests/netguard.test.js
git commit -m "feat(netguard): add private-IP guard with DNS classification"
```

---

## Task 3: Per-session cookie jar store

**Files:**
- Create: `server/cookiejars.js`
- Create: `tests/cookiejars.test.js`

**Step 1: Write the failing test**

```js
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CookieJarStore } from '../server/cookiejars.js'

test('cookie jars are isolated per session and per origin', async () => {
  const store = new CookieJarStore()
  const jarA = store.getJar('session-1', 'http://192.168.1.5')
  const jarB = store.getJar('session-1', 'http://192.168.1.6')
  const jarC = store.getJar('session-2', 'http://192.168.1.5')

  await jarA.setCookie('hello=world; Path=/', 'http://192.168.1.5')
  const fromA = await jarA.getCookieString('http://192.168.1.5')
  const fromB = await jarB.getCookieString('http://192.168.1.5')
  const fromC = await jarC.getCookieString('http://192.168.1.5')

  assert.equal(fromA, 'hello=world')
  assert.equal(fromB, '')
  assert.equal(fromC, '')

  store.clearSession('session-1')
  const postClear = await store.getJar('session-1', 'http://192.168.1.5').getCookieString('http://192.168.1.5')
  assert.equal(postClear, '')
})
```

**Step 2: Confirm failure**

Run: `node --test tests/cookiejars.test.js`
Expected: FAIL — module not found.

**Step 3: Implement `server/cookiejars.js`**

```js
import { CookieJar } from 'tough-cookie'

export class CookieJarStore {
  #bySession = new Map() // sessionId -> Map<origin, CookieJar>

  getJar(sessionId, origin) {
    let byOrigin = this.#bySession.get(sessionId)
    if (!byOrigin) {
      byOrigin = new Map()
      this.#bySession.set(sessionId, byOrigin)
    }
    let jar = byOrigin.get(origin)
    if (!jar) {
      jar = new CookieJar()
      byOrigin.set(origin, jar)
    }
    return jar
  }

  clearSession(sessionId) {
    this.#bySession.delete(sessionId)
  }

  clearAll() {
    this.#bySession.clear()
  }

  sessionCount() {
    return this.#bySession.size
  }
}
```

**Step 4: Re-run test, confirm pass**

Run: `node --test tests/cookiejars.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/cookiejars.js tests/cookiejars.test.js
git commit -m "feat(cookies): add per-session cookie jar store"
```

---

## Task 4: Web proxy pipeline (unblocker + sshweb middleware)

**Files:**
- Create: `server/webproxy.js`
- Create: `tests/webproxy.test.js`

**Step 1: Write the failing integration test**

This test starts a fixture HTTP upstream on 127.0.0.1 and drives the proxy end-to-end via supertest.

```js
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createServer } from 'node:http'
import express from 'express'
import request from 'supertest'
import { createWebProxy } from '../server/webproxy.js'
import { CookieJarStore } from '../server/cookiejars.js'

function startFixture() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/set') {
        res.setHeader('Set-Cookie', 'auth=yes; Path=/')
        res.setHeader('X-Frame-Options', 'DENY')
        res.setHeader('Content-Type', 'text/html')
        res.end('<a href="/next">n</a>')
      } else if (req.url === '/next') {
        res.setHeader('Content-Type', 'text/html')
        res.end(`cookie=${req.headers.cookie ?? ''}`)
      } else {
        res.statusCode = 404
        res.end()
      }
    }).listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('web proxy: passes through, strips frame headers, stores per-session cookies', async () => {
  const upstream = await startFixture()
  const { port } = upstream.address()

  const app = express()
  const jars = new CookieJarStore()
  app.use((req, _res, next) => { req.sshwebSessionId = 'test-session'; next() })
  app.use('/proxy', createWebProxy({
    cookieJars: jars,
    bookmarks: { getByOrigin: () => null },
  }))

  const set = await request(app).get(`/proxy/http://127.0.0.1:${port}/set`)
  assert.equal(set.status, 200)
  assert.equal(set.headers['x-frame-options'], undefined)
  assert.match(set.text, /\/proxy\/http:\/\/127\.0\.0\.1/) // URL rewritten

  const next = await request(app).get(`/proxy/http://127.0.0.1:${port}/next`)
  assert.match(next.text, /cookie=auth=yes/)

  upstream.close()
})

test('web proxy: rejects public IP targets with 403', async () => {
  const app = express()
  const jars = new CookieJarStore()
  app.use((req, _res, next) => { req.sshwebSessionId = 'test-session'; next() })
  app.use('/proxy', createWebProxy({
    cookieJars: jars,
    bookmarks: { getByOrigin: () => null },
  }))
  const res = await request(app).get('/proxy/http://8.8.8.8/')
  assert.equal(res.status, 403)
  assert.match(res.text, /private/i)
})

test('web proxy: rejects WebSocket upgrade with 501', async () => {
  const app = express()
  app.use((req, _res, next) => { req.sshwebSessionId = 'test-session'; next() })
  app.use('/proxy', createWebProxy({
    cookieJars: new CookieJarStore(),
    bookmarks: { getByOrigin: () => null },
  }))
  const res = await request(app)
    .get('/proxy/http://192.168.1.1/')
    .set('Upgrade', 'websocket')
    .set('Connection', 'Upgrade')
  assert.equal(res.status, 501)
})
```

**Step 2: Confirm failure**

Run: `node --test tests/webproxy.test.js`
Expected: FAIL — module not found.

**Step 3: Implement `server/webproxy.js`**

```js
import Unblocker from 'unblocker'
import express from 'express'
import { classifyHost, isPrivateAddress } from './netguard.js'

const FRAME_HEADERS_TO_STRIP = ['x-frame-options']
const CSP_HEADERS_TO_STRIP = ['content-security-policy', 'content-security-policy-report-only']

function stripFrameBlocking(data) {
  for (const h of FRAME_HEADERS_TO_STRIP) delete data.headers[h]
  for (const h of CSP_HEADERS_TO_STRIP) {
    if (data.headers[h]) {
      // Remove frame-ancestors directive from the CSP while preserving the rest
      data.headers[h] = data.headers[h]
        .split(';')
        .map(d => d.trim())
        .filter(d => !d.toLowerCase().startsWith('frame-ancestors'))
        .join('; ')
      if (!data.headers[h]) delete data.headers[h]
    }
  }
}

function interstitial(res, status, title, message) {
  res.status(status).set('content-type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#eee;background:#1a1a1a}
h1{color:#f66}code{background:#333;padding:.1rem .3rem;border-radius:.2rem}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`)
}

export function createWebProxy({ cookieJars, bookmarks, tlsOverrides = new Set() }) {
  const router = express.Router()

  // Reject WebSocket upgrades with 501
  router.use((req, res, next) => {
    if ((req.headers.upgrade || '').toLowerCase() === 'websocket') {
      return res.status(501).set('content-type', 'text/plain').send('WebSocket proxying is not supported')
    }
    next()
  })

  // Private-IP guard with DNS classification
  router.use(async (req, res, next) => {
    // unblocker expects paths like /proxy/http://host/...
    const match = req.originalUrl.match(/^\/proxy\/(https?):\/\/([^\/:?#]+)(:\d+)?/)
    if (!match) return next()
    const host = match[2]
    const result = await classifyHost(host)
    if (!result.allowed) {
      return interstitial(res, 403, 'Blocked', `Only private-network hosts are allowed. ${result.reason}.`)
    }
    req.proxiedHost = host
    req.resolvedIp = result.resolvedIp
    next()
  })

  const unblocker = Unblocker({
    prefix: '/proxy/',
    requestMiddleware: [
      // Cookie jar: attach this session's cookies for the target origin
      (data) => {
        const sessionId = data.clientRequest.sshwebSessionId
        if (!sessionId) return
        const origin = `${data.url.protocol}//${data.url.host}`
        const jar = cookieJars.getJar(sessionId, origin)
        const cookie = jar.getCookieStringSync(origin)
        if (cookie) data.headers.cookie = cookie
      },
      // TLS policy: set agent based on bookmark ignore_tls or session override
      (data) => {
        if (data.url.protocol !== 'https:') return
        const origin = `${data.url.protocol}//${data.url.host}`
        const bm = bookmarks.getByOrigin(origin)
        const allowInsecure = (bm && bm.ignoreTls) || tlsOverrides.has(`${data.clientRequest.sshwebSessionId}|${origin}`)
        if (allowInsecure) {
          data.requestOptions = { ...data.requestOptions, rejectUnauthorized: false }
        }
      },
    ],
    responseMiddleware: [
      (data) => stripFrameBlocking(data),
      (data) => {
        // Capture Set-Cookie into the per-session jar
        const raw = data.headers['set-cookie']
        if (!raw) return
        const cookies = Array.isArray(raw) ? raw : [raw]
        const sessionId = data.clientRequest.sshwebSessionId
        if (!sessionId) return
        const origin = `${data.url.protocol}//${data.url.host}`
        const jar = cookieJars.getJar(sessionId, origin)
        for (const c of cookies) {
          try { jar.setCookieSync(c, origin) } catch { /* ignore malformed */ }
        }
        // Prevent the browser from seeing origin-scoped cookies for sshweb's domain
        delete data.headers['set-cookie']
      },
    ],
  })

  router.use((req, res, next) => {
    // unblocker expects to be mounted at the root with paths like /proxy/http://...
    // Our router is mounted at /proxy, so reconstruct the expected shape.
    req.url = req.originalUrl
    unblocker(req, res, next)
  })

  return router
}
```

**Step 4: Re-run test, confirm pass**

Run: `node --test tests/webproxy.test.js`
Expected: PASS. If `unblocker`'s API shape differs from what the test assumes (URL regex, middleware data shape), adapt both `webproxy.js` and the test — the test is the contract for sshweb, `unblocker` is the transport.

**Step 5: Commit**

```bash
git add server/webproxy.js tests/webproxy.test.js
git commit -m "feat(webproxy): add unblocker-backed proxy with cookie/TLS/IP guards"
```

---

## Task 5: REST endpoints — bookmarks CRUD

**Files:**
- Modify: `server/index.js` (mount bookmark store + routes)
- Modify: `tests/server.test.js` (add bookmark route coverage)

**Step 1: Write the failing test**

Append to `tests/server.test.js` (reuse existing test scaffolding for unlocked server):

```js
test('bookmark routes: CRUD through HTTP', async () => {
  const { app, unlock } = await bootTestServer() // existing helper in server.test.js
  await unlock()

  const created = await request(app).post('/api/bookmarks').send({ label: 'Pi-hole', url: 'http://192.168.1.5/admin' })
  assert.equal(created.status, 201)
  const { id } = created.body

  const list = await request(app).get('/api/bookmarks')
  assert.equal(list.status, 200)
  assert.equal(list.body.length, 1)
  assert.equal(list.body[0].id, id)

  const upd = await request(app).put(`/api/bookmarks/${id}`).send({ label: 'Pi-hole v2' })
  assert.equal(upd.status, 200)

  const del = await request(app).delete(`/api/bookmarks/${id}`)
  assert.equal(del.status, 200)
})
```

> If `bootTestServer` does not exist, refactor the existing test file to extract a helper first (small prep commit). Mirror the pattern used by `/api/connections` tests.

**Step 2: Confirm failure**

Run: `node --test tests/server.test.js`
Expected: FAIL on the new test (404 on `/api/bookmarks`).

**Step 3: Wire the store and routes in `server/index.js`**

- Import: `import { BookmarkStore } from './bookmarks.js'`
- Add to the module-level state block (near `let credStore = null`):
  ```js
  /** @type {BookmarkStore|null} */
  let bookmarkStore = null

  function getBookmarkStore() {
    if (!bookmarkStore && masterKey.isUnlocked()) {
      bookmarkStore = new BookmarkStore(join(config.dataDir, 'bookmarks.db'))
    }
    return bookmarkStore
  }

  function closeBookmarkStore() {
    if (bookmarkStore) { bookmarkStore.close(); bookmarkStore = null }
  }

  function requireBookmarkStore(res) {
    const s = getBookmarkStore()
    if (!s) { res.status(423).json({ error: 'Server locked' }); return null }
    return s
  }
  ```
- Add `closeBookmarkStore()` inside `closeStore()`.
- Add routes (alongside credential routes, mirror the same style):
  ```js
  app.get('/api/bookmarks', (req, res) => {
    const s = requireBookmarkStore(res); if (!s) return
    res.json(s.list())
  })

  app.post('/api/bookmarks', (req, res) => {
    const s = requireBookmarkStore(res); if (!s) return
    const { label, url, ignoreTls } = req.body
    if (!label || !url) return res.status(400).json({ error: 'label and url are required' })
    try { new URL(url) } catch { return res.status(400).json({ error: 'invalid url' }) }
    const id = s.create({ label, url, ignoreTls: !!ignoreTls })
    res.status(201).json({ id })
  })

  app.get('/api/bookmarks/:id', (req, res) => {
    const s = requireBookmarkStore(res); if (!s) return
    const bm = s.get(req.params.id)
    if (!bm) return res.status(404).json({ error: 'Not found' })
    res.json(bm)
  })

  app.put('/api/bookmarks/:id', (req, res) => {
    const s = requireBookmarkStore(res); if (!s) return
    try { s.update(req.params.id, req.body); res.json({ ok: true }) }
    catch (err) { res.status(404).json({ error: err.message }) }
  })

  app.delete('/api/bookmarks/:id', (req, res) => {
    const s = requireBookmarkStore(res); if (!s) return
    s.delete(req.params.id)
    res.json({ ok: true })
  })
  ```

**Step 4: Re-run test, confirm pass**

Run: `node --test tests/server.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/index.js tests/server.test.js
git commit -m "feat(api): expose bookmark CRUD endpoints"
```

---

## Task 6: Mount web proxy + session-state plumbing

**Files:**
- Modify: `server/index.js`
- Modify: `server/session.js` (emit a clear-hook)
- Modify: `tests/server.test.js`

**Step 1: Teach `SessionManager` about subscribers**

In `server/session.js`, add an `onClear` hook:

```js
#clearHandlers = new Set()

onClear(handler) { this.#clearHandlers.add(handler) }

destroy(token) {
  this.#sessions.delete(token)
  for (const h of this.#clearHandlers) h(token)
}

clear() {
  const tokens = [...this.#sessions.keys()]
  this.#sessions.clear()
  for (const t of tokens) for (const h of this.#clearHandlers) h(t)
}
```

**Step 2: Write the failing test**

Add to `tests/server.test.js`:

```js
test('proxy requires unlocked session and wipes cookies on lock', async () => {
  const { app, unlock, lock } = await bootTestServer()
  // Locked: 401
  let res = await request(app).get('/proxy/http://192.168.1.1/')
  assert.equal(res.status, 401)
  await unlock()
  // Now auth guard passes, private-IP guard will try and likely 502 (no upstream),
  // but NOT 401. Assert it isn't 401.
  res = await request(app).get('/proxy/http://192.168.1.1/')
  assert.notEqual(res.status, 401)
  await lock()
  res = await request(app).get('/proxy/http://192.168.1.1/')
  assert.equal(res.status, 401)
})
```

**Step 3: Confirm failure**

Run: `node --test tests/server.test.js`
Expected: FAIL on `/proxy/...` — route not mounted yet.

**Step 4: Wire the proxy in `server/index.js`**

- Import: `import { createWebProxy } from './webproxy.js'` and `import { CookieJarStore } from './cookiejars.js'`
- At module level:
  ```js
  const cookieJars = new CookieJarStore()
  const tlsOverrides = new Set()
  sessions.onClear((token) => {
    cookieJars.clearSession(token)
    for (const key of tlsOverrides) if (key.startsWith(`${token}|`)) tlsOverrides.delete(key)
    openTabs.delete(token)
  })
  const openTabs = new Map() // token -> [{ tabId, url }]
  ```
- Tag each authenticated request with its session id. In the existing auth guard, after validating:
  ```js
  if (masterKey.isUnlocked() && sessions.validate(getSessionToken(req))) {
    req.sshwebSessionId = getSessionToken(req)
    return next()
  }
  ```
- Mount the proxy router **after** the auth guard but before the SPA fallback:
  ```js
  app.use('/proxy', createWebProxy({
    cookieJars,
    bookmarks: {
      getByOrigin(origin) {
        const s = getBookmarkStore()
        if (!s) return null
        return s.list().find(b => {
          try { return new URL(b.url).origin === origin }
          catch { return false }
        }) ?? null
      },
    },
    tlsOverrides,
  }))
  ```
- Export `cookieJars`, `tlsOverrides`, `openTabs` so later tasks (admin panel, tab-restore) can touch them.

**Step 5: Re-run test, confirm pass**

Run: `node --test tests/server.test.js`
Expected: PASS.

**Step 6: Commit**

```bash
git add server/index.js server/session.js tests/server.test.js
git commit -m "feat(proxy): mount /proxy behind auth and wire session lifecycle"
```

---

## Task 7: TLS override endpoint (session-scoped "proceed anyway")

**Files:**
- Modify: `server/index.js`
- Modify: `tests/server.test.js`

**Step 1: Write the failing test**

```js
test('tls override is session-scoped', async () => {
  const { app, unlock } = await bootTestServer()
  await unlock()
  const res = await request(app).post('/api/tls-override').send({ origin: 'https://192.168.1.20' })
  assert.equal(res.status, 200)
  // Second call with missing origin rejects
  const bad = await request(app).post('/api/tls-override').send({})
  assert.equal(bad.status, 400)
})
```

**Step 2: Confirm failure** — 404.

**Step 3: Add the route**

```js
app.post('/api/tls-override', (req, res) => {
  const { origin } = req.body
  if (!origin || typeof origin !== 'string') return res.status(400).json({ error: 'origin required' })
  try { new URL(origin) } catch { return res.status(400).json({ error: 'invalid origin' }) }
  tlsOverrides.add(`${req.sshwebSessionId}|${origin}`)
  res.json({ ok: true })
})
```

**Step 4: Re-run test, confirm pass.**

**Step 5: Commit**

```bash
git add server/index.js tests/server.test.js
git commit -m "feat(api): add session-scoped TLS override endpoint"
```

---

## Task 8: Tab-restore endpoints

**Files:**
- Modify: `server/index.js`
- Modify: `tests/server.test.js`

**Step 1: Write the failing test**

```js
test('tabs endpoint round-trips open-tab state', async () => {
  const { app, unlock } = await bootTestServer()
  await unlock()
  const empty = await request(app).get('/api/tabs')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, [])

  const put = await request(app).put('/api/tabs').send([{ tabId: 'a', url: 'http://192.168.1.5/' }])
  assert.equal(put.status, 200)

  const again = await request(app).get('/api/tabs')
  assert.equal(again.body.length, 1)
  assert.equal(again.body[0].tabId, 'a')
})
```

**Step 2: Confirm failure.**

**Step 3: Add routes**

```js
app.get('/api/tabs', (req, res) => {
  res.json(openTabs.get(req.sshwebSessionId) ?? [])
})
app.put('/api/tabs', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'array required' })
  const cleaned = req.body
    .filter(t => t && typeof t.tabId === 'string' && typeof t.url === 'string')
    .slice(0, 20) // bound memory
  openTabs.set(req.sshwebSessionId, cleaned)
  res.json({ ok: true })
})
```

**Step 4: Re-run test, confirm pass.**

**Step 5: Commit**

```bash
git add server/index.js tests/server.test.js
git commit -m "feat(api): add tab-restore state endpoints"
```

---

## Task 9: Admin panel — web state

**Files:**
- Modify: `server/index.js`
- Modify: `tests/server.test.js`

**Step 1: Write the failing test**

```js
test('admin web-state endpoint', async () => {
  const { app, unlock } = await bootTestServer()
  await unlock()
  const before = await request(app).get('/api/admin/web')
  assert.equal(before.status, 200)
  assert.equal(before.body.activeCookieSessions, 0)

  await request(app).post('/api/admin/web/clear-cookies')
  const after = await request(app).get('/api/admin/web')
  assert.equal(after.body.activeCookieSessions, 0)
})
```

**Step 2: Add routes**

```js
app.get('/api/admin/web', (_req, res) => {
  res.json({
    activeCookieSessions: cookieJars.sessionCount(),
    openTabs: [...openTabs.values()].reduce((n, arr) => n + arr.length, 0),
    tlsOverrides: tlsOverrides.size,
  })
})

app.post('/api/admin/web/clear-cookies', (_req, res) => {
  cookieJars.clearAll()
  res.json({ ok: true })
})
```

**Step 3: Re-run test, confirm pass.**

**Step 4: Commit**

```bash
git add server/index.js tests/server.test.js
git commit -m "feat(admin): expose web-proxy state + clear-cookies action"
```

---

## Task 10: Client — web API + tab kind scaffold

**Files:**
- Modify: `client/main.js`
- Modify: `client/index.html`
- Modify: `client/style.css`

**Step 1: Add bookmark/tab state and API helpers at the top of `client/main.js`**

Below the existing `connections = []` line:

```js
let bookmarks = []
// existing tabs Map now carries { kind: 'ssh' | 'web', ... }
```

Extend the `api` helpers to accept a generic wrapper for JSON — they already do. No change.

Add loaders:

```js
async function loadBookmarks() {
  bookmarks = await api.get('/api/bookmarks')
  renderBookmarkList()
}
```

**Step 2: Add a "Web" section in `client/index.html`**

Inside the sidebar, below the existing connections list:

```html
<section id="web-section">
  <header>
    <h2>Web</h2>
    <button id="add-bookmark" title="Add bookmark">＋</button>
  </header>
  <ul id="bookmark-list"></ul>
</section>
```

Wire DOM refs at the top of `main.js`:

```js
const bookmarkList = document.getElementById('bookmark-list')
const addBookmarkBtn = document.getElementById('add-bookmark')
```

**Step 3: Render function**

```js
function renderBookmarkList() {
  bookmarkList.innerHTML = ''
  for (const bm of bookmarks) {
    const li = document.createElement('li')
    li.dataset.id = bm.id
    const label = document.createElement('span')
    label.textContent = bm.label
    const host = document.createElement('span')
    host.className = 'conn-host'
    try { host.textContent = new URL(bm.url).host } catch { host.textContent = bm.url }
    const info = document.createElement('div')
    info.className = 'conn-info'
    info.append(label, host)
    li.append(info)
    li.addEventListener('click', () => openWebTab({ url: bm.url, bookmarkId: bm.id }))
    // edit/delete buttons (mirror connections)
    bookmarkList.appendChild(li)
  }
}
```

**Step 4: Add-bookmark modal**

Reuse existing modal pattern. Create a small `openBookmarkModal(existing)` that prompts for `label`, `url`, and `ignoreTls`.

**Step 5: Ensure `loadBookmarks()` is called at startup** alongside `loadConnections()`.

**Step 6: Commit**

```bash
git add client/main.js client/index.html client/style.css
git commit -m "feat(client): add Web sidebar section and bookmark list"
```

> **Step 7 (manual check):** Run `make dev` and confirm the sidebar shows the new section, `+` opens the modal, adding a bookmark persists across reload.

---

## Task 11: Client — web tab UI (iframe, URL bar, nav chrome)

**Files:**
- Modify: `client/main.js`
- Modify: `client/index.html` (tab template)
- Modify: `client/style.css`

**Step 1: Add `openWebTab` + `closeWebTab`**

```js
function openWebTab({ url, bookmarkId = null }) {
  const tabId = crypto.randomUUID()
  const container = document.createElement('div')
  container.className = 'web-tab'
  container.innerHTML = `
    <div class="web-chrome">
      <button data-act="back">←</button>
      <button data-act="forward">→</button>
      <button data-act="reload">⟳</button>
      <form class="web-url-form"><input class="web-url" type="text" value="${url}"></form>
    </div>
    <iframe class="web-frame" src="/proxy/${url}"></iframe>
  `
  termContainer.appendChild(container)
  container.style.display = 'none'

  const iframe = container.querySelector('iframe')
  const urlInput = container.querySelector('.web-url')
  const form = container.querySelector('.web-url-form')

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    iframe.src = '/proxy/' + urlInput.value.trim()
  })
  container.querySelector('[data-act="back"]').onclick = () => { try { iframe.contentWindow.history.back() } catch {} }
  container.querySelector('[data-act="forward"]').onclick = () => { try { iframe.contentWindow.history.forward() } catch {} }
  container.querySelector('[data-act="reload"]').onclick = () => iframe.contentWindow.location.reload()

  iframe.addEventListener('load', () => {
    try {
      const path = iframe.contentWindow.location.pathname + iframe.contentWindow.location.search
      const m = path.match(/^\/proxy\/(.+)$/)
      if (m) urlInput.value = decodeURIComponent(m[1])
      persistOpenTabs()
    } catch { /* cross-origin safety guard */ }
  })

  tabs.set(tabId, { kind: 'web', container, iframe, urlInput, bookmarkId })
  addTabButton(tabId, urlInput.value)
  activateTab(tabId)
  persistOpenTabs()
}
```

**Step 2: Update `activateTab` / `addTabButton` / `closeTab` to handle `kind: 'web'`**

Hide/show `container` instead of the xterm element; skip xterm fit logic for web tabs; persist on close.

**Step 3: Persist open tabs**

```js
async function persistOpenTabs() {
  const state = [...tabs.entries()]
    .filter(([, t]) => t.kind === 'web')
    .map(([tabId, t]) => ({ tabId, url: t.urlInput.value }))
  try { await api.put('/api/tabs', state) } catch {}
}
```

**Step 4: Restore on startup**

In the init sequence, after `loadBookmarks()`:

```js
const saved = await api.get('/api/tabs')
for (const t of saved) openWebTab({ url: t.url })
```

**Step 5: Style** — minimal CSS for `.web-tab`, `.web-chrome`, `.web-frame` (100% width, border-less iframe, flex layout).

**Step 6: Commit**

```bash
git add client/main.js client/index.html client/style.css
git commit -m "feat(client): add web tab UI with URL bar, nav, and iframe"
```

> **Step 7 (manual check):** `make dev`, open a bookmark to a real LAN UI, confirm it loads inside the tab, links inside follow through the proxy, URL bar reflects navigation, reload restores open tabs.

---

## Task 12: Client — TLS interstitial handling

**Files:**
- Modify: `client/main.js`
- The interstitial page is already served by `server/webproxy.js` on TLS failure (Task 4). We only need the "Proceed" button to POST to `/api/tls-override` and reload the iframe.

**Step 1: Update the TLS-fail interstitial to include a `<script>`**

In `server/webproxy.js`, add a dedicated interstitial for TLS failures (separate from the 403 private-IP one) that renders:

```html
<form id="proceed" method="dialog">
  <button>Proceed for this session</button>
</form>
<script>
document.getElementById('proceed').addEventListener('submit', async (e) => {
  e.preventDefault()
  await fetch('/api/tls-override', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: ORIGIN_PLACEHOLDER })
  })
  location.reload()
})
</script>
```

Substitute `ORIGIN_PLACEHOLDER` server-side with the upstream origin.

**Step 2: Trigger path** — the outbound TLS agent will error; catch in unblocker's error middleware and render the interstitial.

**Step 3: Test (manual)** — add a bookmark with a self-signed HTTPS target, verify the interstitial, click Proceed, confirm the page loads.

**Step 4: Commit**

```bash
git add server/webproxy.js client/main.js
git commit -m "feat(proxy): interstitial + client flow for TLS self-sign acceptance"
```

---

## Task 13: Admin panel — UI for web metrics

**Files:**
- Modify: `client/main.js`
- Modify: `client/index.html`

**Step 1:** In the existing admin section, add a small block:

```html
<div id="admin-web">
  <div>Active cookie sessions: <span id="admin-web-cookies">0</span></div>
  <div>Open web tabs: <span id="admin-web-tabs">0</span></div>
  <button id="admin-web-clear">Clear web cookies</button>
</div>
```

**Step 2:** Fetch `/api/admin/web` when the admin panel refreshes; wire the button to `POST /api/admin/web/clear-cookies` + re-fetch.

**Step 3: Commit**

```bash
git add client/main.js client/index.html
git commit -m "feat(admin): surface web-proxy metrics and clear-cookies action"
```

---

## Task 14: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `.env.example` (no changes expected; verify)

**Step 1:** Add a "Web browser tab" section to `README.md` after "Network Scanner":

- What it does
- Scope: private-IP only (RFC1918 + loopback), HTML/CSS admin UIs
- Limitations: no WebSockets, no public internet, JS-computed URLs may break
- How to add bookmarks
- TLS override semantics
- Troubleshooting: frame-blocking headers, cookies cleared on lock, no file downloads through iframe

**Step 2:** Add a CHANGELOG entry (match the existing format):

```
## Unreleased

### Added
- Web browser tab: browse internal admin UIs via a built-in proxy. Bookmarks
  live in the sidebar alongside SSH connections; tabs restore on reload;
  per-session cookie isolation; private-IP scope enforced.

### Security notes
- Proxy rejects any target that isn't RFC1918 or loopback (DNS pinned per
  page-load against rebinding). TLS strict by default; per-bookmark and
  session-scoped overrides required to accept self-signed certs.
```

**Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe browser tab feature"
```

---

## Task 15: Manual smoke test + final verification

**Steps (no code):**

1. `make build && make test` → all green.
2. `make dev` → open http://localhost:3000, unlock, add a bookmark to a real LAN admin UI (e.g. router, Pi-hole).
3. Click the bookmark → web tab opens, page renders, links clickable.
4. Log in to the admin UI → confirm it succeeds, subsequent pages remember the login.
5. Reload the sshweb page → the same tabs reopen, still logged in.
6. Lock sshweb from the admin panel → unlock again → tabs reopen but admin UI asks for a new login (cookies wiped).
7. Attempt to paste a public URL (e.g. `https://example.com`) into a web tab URL bar → 403 interstitial.
8. Attempt an HTTPS admin UI with self-signed cert → TLS interstitial → "Proceed this session" → page loads.
9. Check admin panel → active cookie sessions > 0, clear-cookies works.
10. Build container: `make update` → container healthy, browse same flow through NPM.

Record any bug findings as follow-up tasks before merging.

**Commit:** none — verification only.

---

## Task 16: Merge to master

**Steps:**

1. `git checkout master`
2. `git merge --no-ff feat/browser-tab -m "feat: browser tab for internal admin UIs"`
3. Do NOT push. Stop here and report to the user; they will push when satisfied.

---

## Cross-cutting reminders

- TDD: every task that adds behavior writes the test first (Tasks 1–9). UI tasks (10–13) use `make dev` manual verification — it's acceptable here since the project has no client test infrastructure yet.
- DRY: reuse the existing modal/form patterns in `client/main.js` for the bookmark modal. Do not fork a new modal system.
- YAGNI: do not add import/export, drag-reorder, or persistent cookies in v1.
- Commits: small and focused; one per task.
- The auth guard in `server/index.js` already protects everything except `PUBLIC_PATHS` — `/proxy/*` is protected for free. Do not add it to `PUBLIC_PATHS`.
- `.env.example` gets no new variables in v1 — add them in a later task if a need emerges.
