import https from 'node:https'
import Unblocker from 'unblocker'
import { classifyHost } from './netguard.js'

const FRAME_HEADERS_TO_STRIP = ['x-frame-options']
const CSP_DIRECTIVES_TO_STRIP = ['frame-ancestors']

function stripFrameBlocking(data) {
  for (const h of FRAME_HEADERS_TO_STRIP) delete data.headers[h]
  for (const h of ['content-security-policy', 'content-security-policy-report-only']) {
    if (data.headers[h]) {
      data.headers[h] = data.headers[h]
        .split(';')
        .map(d => d.trim())
        .filter(d => !CSP_DIRECTIVES_TO_STRIP.some(s => d.toLowerCase().startsWith(s)))
        .join('; ')
      if (!data.headers[h]) delete data.headers[h]
    }
  }
}

const ERROR_STYLE = `body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#eee;background:#1a1a1a}
h1{color:#f66}code{background:#333;padding:.1rem .3rem;border-radius:.2rem}
button{background:#e94560;color:#fff;border:none;border-radius:4px;padding:.5rem 1.2rem;cursor:pointer;font-size:1rem;margin-top:1rem}button:hover{opacity:.9}
.muted{color:#999;font-size:.85rem;margin-top:1rem}`

function errorPage(res, status, title, message) {
  res.status(status).set('content-type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>${ERROR_STYLE}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`)
}

export function createWebProxy({ cookieJars, bookmarks, tlsOverrides = new Set() }) {
  // Always accept self-signed / expired certs for proxy requests.
  // The private-IP guard is our trust boundary — homelab gear almost
  // universally uses self-signed certs and strict TLS just adds friction.
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false })

  const unblocker = new Unblocker({
    prefix: '/proxy/',
    httpsAgent: agent,
    requestMiddleware: [
      // Inject per-session cookies for the target origin
      (data) => {
        const sessionId = data.clientRequest.sshwebSessionId
        if (!sessionId) return
        const origin = `${data.uri.protocol}//${data.uri.host}`
        const jar = cookieJars.getJar(sessionId, origin)
        const cookie = jar.getCookieStringSync(data.url)
        if (cookie) data.headers.cookie = cookie
      },
    ],
    responseMiddleware: [
      // Strip frame-blocking headers so the page loads in our iframe
      (data) => stripFrameBlocking(data),
      // Capture Set-Cookie into per-session jar, then remove from response.
      // Read from remoteResponse (raw upstream headers) because unblocker's
      // built-in cookie middleware rewrites paths before we run.
      (data) => {
        const raw = data.remoteResponse?.headers?.['set-cookie']
        if (!raw) return
        const cookies = Array.isArray(raw) ? raw : [raw]
        const sessionId = data.clientRequest.sshwebSessionId
        if (!sessionId) return
        const origin = `${data.uri.protocol}//${data.uri.host}`
        const jar = cookieJars.getJar(sessionId, origin)
        for (const c of cookies) {
          try { jar.setCookieSync(c, origin) } catch { /* ignore malformed */ }
        }
        // Remove rewritten cookies from response — we manage cookies server-side
        delete data.headers['set-cookie']
      },
    ],
  })

  // Wrap unblocker with our guards as a single middleware function
  return function webProxyMiddleware(req, res, next) {
    // Only handle /proxy/ requests
    if (!req.url.startsWith('/proxy/')) return next()

    // Reject WebSocket upgrades
    if ((req.headers.upgrade || '').toLowerCase() === 'websocket') {
      return res.status(501).set('content-type', 'text/plain').send('WebSocket proxying is not supported')
    }

    // Extract host from proxy URL for private-IP check
    const match = req.url.match(/^\/proxy\/(https?):\/\/([^/:?#]+)/)
    if (!match) return unblocker(req, res, next)

    const host = match[2]
    classifyHost(host).then((result) => {
      if (!result.allowed) {
        return errorPage(res, 403, 'Blocked', `Only private-network hosts are allowed. ${result.reason}.`)
      }
      req.proxiedHost = host
      req.resolvedIp = result.resolvedIp
      unblocker(req, res, (err) => {
        if (!err) return next()
        // Show friendly error pages for common connection failures
        if (res.headersSent) return next(err) // too late, let Express handle it
        const code = err.code || ''
        if (code === 'ECONNREFUSED') {
          return errorPage(res, 502, 'Connection Refused', `Could not connect to <code>${host}</code>. The server may be down or not listening on this port.`)
        }
        if (code === 'ECONNRESET' || code === 'EPIPE') {
          return errorPage(res, 502, 'Connection Reset', `The connection to <code>${host}</code> was reset. The server may have closed the connection unexpectedly.`)
        }
        if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
          return errorPage(res, 504, 'Timeout', `The connection to <code>${host}</code> timed out. The server may be unreachable or very slow.`)
        }
        if (code === 'ENOTFOUND') {
          return errorPage(res, 502, 'DNS Error', `Could not resolve hostname <code>${host}</code>.`)
        }
        // Catch-all for any other upstream error
        return errorPage(res, 502, 'Proxy Error', `Error connecting to <code>${host}</code>: ${err.message || code}`)
      })
    }).catch(next)
  }
}
