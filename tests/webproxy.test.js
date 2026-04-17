import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createServer } from 'node:http'
import express from 'express'
import request from 'supertest'
import { createWebProxy } from '../server/webproxy.js'

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

test('web proxy: passes through, strips frame headers, forwards cookies via browser', async () => {
  const upstream = await startFixture()
  const { port } = upstream.address()

  const app = express()
  app.use((req, _res, next) => { req.sshwebSessionId = 'test-session'; next() })
  app.use(createWebProxy())

  const set = await request(app).get(`/proxy/http://127.0.0.1:${port}/set`)
  assert.equal(set.status, 200)
  assert.equal(set.headers['x-frame-options'], undefined)
  assert.match(set.text, /\/proxy\/http:\/\/127\.0\.0\.1/) // URL rewritten

  // Unblocker rewrites Set-Cookie path to /proxy/http://host:port/ and forwards to browser
  const setCookies = set.headers['set-cookie']
  assert.ok(setCookies, 'Set-Cookie should be forwarded to browser')

  // Simulate browser sending cookie back on next request
  const cookieHeader = Array.isArray(setCookies)
    ? setCookies.map(c => c.split(';')[0]).join('; ')
    : setCookies.split(';')[0]
  const next = await request(app)
    .get(`/proxy/http://127.0.0.1:${port}/next`)
    .set('Cookie', cookieHeader)
  assert.match(next.text, /cookie=auth=yes/)

  upstream.close()
})

test('web proxy: rejects public IP targets with 403', async () => {
  const app = express()
  app.use((req, _res, next) => { req.sshwebSessionId = 'test-session'; next() })
  app.use(createWebProxy())
  const res = await request(app).get('/proxy/http://8.8.8.8/')
  assert.equal(res.status, 403)
  assert.match(res.text, /private/i)
})

test('web proxy: shows friendly error on ECONNREFUSED', async () => {
  const app = express()
  app.use((req, _res, next) => { req.sshwebSessionId = 'test-session'; next() })
  app.use(createWebProxy())
  // Port 1 on loopback — nothing listening, guaranteed ECONNREFUSED
  const res = await request(app).get('/proxy/http://127.0.0.1:1/')
  assert.equal(res.status, 502)
  assert.match(res.text, /Connection Refused/i)
})

test('web proxy: HTTPS with self-signed cert works (permissive agent)', async () => {
  const app = express()
  app.use((req, _res, next) => { req.sshwebSessionId = 'test-session'; next() })
  app.use(createWebProxy())
  const res = await request(app).get('/proxy/https://127.0.0.1:1/')
  // Should be 502 (connection refused), NOT a TLS error interstitial
  assert.equal(res.status, 502)
  assert.match(res.text, /Connection Refused|Proxy Error/i)
})

test('web proxy: rejects WebSocket upgrade with 501', async () => {
  const app = express()
  app.use((req, _res, next) => { req.sshwebSessionId = 'test-session'; next() })
  app.use(createWebProxy())
  const res = await request(app)
    .get('/proxy/http://192.168.1.1/')
    .set('Upgrade', 'websocket')
    .set('Connection', 'Upgrade')
  assert.equal(res.status, 501)
})
