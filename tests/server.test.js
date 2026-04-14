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
