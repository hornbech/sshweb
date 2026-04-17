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
  assert.ok(!('version' in res.body)) // version removed to reduce info disclosure
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

// --- Bookmark routes (require unlocked state) ---

let sessionCookie

test('POST /api/unlock sets up master password and session', async () => {
  const res = await request(app)
    .post('/api/unlock')
    .send({ password: 'test-master-pw' })
    .set('Content-Type', 'application/json')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  // Extract session cookie for subsequent requests
  const cookies = res.headers['set-cookie']
  sessionCookie = cookies?.find(c => c.startsWith('session='))?.split(';')[0]
  assert.ok(sessionCookie, 'session cookie should be set')
})

test('bookmark routes: CRUD through HTTP', async () => {
  const created = await request(app)
    .post('/api/bookmarks')
    .set('Cookie', sessionCookie)
    .send({ label: 'Pi-hole', url: 'http://192.168.1.5/admin' })
  assert.equal(created.status, 201)
  const { id } = created.body
  assert.ok(id)

  const list = await request(app)
    .get('/api/bookmarks')
    .set('Cookie', sessionCookie)
  assert.equal(list.status, 200)
  assert.equal(list.body.length, 1)
  assert.equal(list.body[0].id, id)

  const upd = await request(app)
    .put(`/api/bookmarks/${id}`)
    .set('Cookie', sessionCookie)
    .send({ label: 'Pi-hole v2' })
  assert.equal(upd.status, 200)

  const del = await request(app)
    .delete(`/api/bookmarks/${id}`)
    .set('Cookie', sessionCookie)
  assert.equal(del.status, 200)

  const empty = await request(app)
    .get('/api/bookmarks')
    .set('Cookie', sessionCookie)
  assert.equal(empty.body.length, 0)
})

test('bookmark routes: rejects invalid URL', async () => {
  const res = await request(app)
    .post('/api/bookmarks')
    .set('Cookie', sessionCookie)
    .send({ label: 'Bad', url: 'not-a-url' })
  assert.equal(res.status, 400)
})

test('bookmark routes: rejects missing fields', async () => {
  const res = await request(app)
    .post('/api/bookmarks')
    .set('Cookie', sessionCookie)
    .send({ label: 'No URL' })
  assert.equal(res.status, 400)
})

test('after all: close server', () => {
  cleanup?.()
})
