import https from 'node:https'
import Unblocker from 'unblocker'
import { classifyHost } from './netguard.js'
import { PATCHED_CLIENT_JS } from './unblocker-client-patched.js'

const CLIENT_SCRIPT_PATH = '/proxy/client/unblocker-client.js'

// Headers stripped from upstream responses so proxied pages render in our iframe.
// We remove the entire CSP rather than selectively stripping directives because
// upstream policies are designed for direct access — directives like script-src
// 'self' or base-uri 'self' break under URL-rewriting proxy context.
const HEADERS_TO_STRIP = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
]

function stripFrameBlocking(data) {
  for (const h of HEADERS_TO_STRIP) delete data.headers[h]
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

export function createWebProxy() {
  // Always accept self-signed / expired certs for proxy requests.
  // The private-IP guard is our trust boundary — homelab gear almost
  // universally uses self-signed certs and strict TLS just adds friction.
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false })

  const unblocker = new Unblocker({
    prefix: '/proxy/',
    httpsAgent: agent,
    responseMiddleware: [
      // Strip frame-blocking headers so the page loads in our iframe
      (data) => stripFrameBlocking(data),
      // Cookies are handled by unblocker's built-in cookie middleware, which
      // rewrites Set-Cookie paths to /proxy/http://host:port/ so they're
      // naturally scoped per target site in the browser.  This allows
      // upstream JavaScript (e.g. Synology DSM) to read document.cookie for
      // session tokens and CSRF tokens.
    ],
  })

  // Wrap unblocker with our guards as a single middleware function
  return function webProxyMiddleware(req, res, next) {
    // Only handle /proxy/ requests
    if (!req.url.startsWith('/proxy/')) return next()

    // Serve our patched injected client script.  Upstream unblocker's initFetch
    // breaks multi-step logins by assigning to Request.url (read-only).
    if (req.url === CLIENT_SCRIPT_PATH) {
      res.set('content-type', 'application/javascript; charset=utf-8')
      res.set('cache-control', 'public, max-age=600')
      return res.send(PATCHED_CLIENT_JS)
    }

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
