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

function interstitial(res, status, title, message) {
  res.status(status).set('content-type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#eee;background:#1a1a1a}
h1{color:#f66}code{background:#333;padding:.1rem .3rem;border-radius:.2rem}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`)
}

export function createWebProxy({ cookieJars, bookmarks, tlsOverrides = new Set() }) {
  // Unblocker is a connect/express middleware that expects to see /proxy/ in req.url.
  // It handles its own routing internally based on the prefix.
  const unblocker = new Unblocker({
    prefix: '/proxy/',
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
        return interstitial(res, 403, 'Blocked', `Only private-network hosts are allowed. ${result.reason}.`)
      }
      req.proxiedHost = host
      req.resolvedIp = result.resolvedIp
      unblocker(req, res, next)
    }).catch(next)
  }
}
