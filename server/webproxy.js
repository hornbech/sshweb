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

const INTERSTITIAL_STYLE = `body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#eee;background:#1a1a1a}
h1{color:#f66}code{background:#333;padding:.1rem .3rem;border-radius:.2rem}
button{background:#e94560;color:#fff;border:none;border-radius:4px;padding:.5rem 1.2rem;cursor:pointer;font-size:1rem;margin-top:1rem}button:hover{opacity:.9}`

function interstitial(res, status, title, message) {
  res.status(status).set('content-type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>${INTERSTITIAL_STYLE}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`)
}

function tlsInterstitial(res, origin) {
  const escaped = origin.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const originJson = JSON.stringify(origin)
  const html = '<!doctype html>' +
    '<html><head><meta charset="utf-8"><title>TLS Error</title>' +
    '<style>' + INTERSTITIAL_STYLE + '</style></head>' +
    '<body><h1>TLS Certificate Error</h1>' +
    '<p>The upstream server at <code>' + escaped + '</code> presented an invalid or self-signed certificate.</p>' +
    '<button id="proceed">Proceed for this session</button>' +
    '<script>' +
    'document.getElementById("proceed").addEventListener("click",async()=>{' +
    'await fetch("/api/tls-override",{method:"POST",headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({origin:' + originJson + '})});location.reload()})' +
    '</script></body></html>'
  res.status(526).set('content-type', 'text/html; charset=utf-8').send(html)
}

export function createWebProxy({ cookieJars, bookmarks, tlsOverrides = new Set() }) {
  // Agents for TLS override: one strict (default), one permissive
  const strictAgent = new https.Agent({ keepAlive: true })
  const permissiveAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false })

  // The config object is passed by reference to unblocker — we can swap
  // httpsAgent in requestMiddleware and it takes effect for the current
  // request because Node is single-threaded and the HTTP request is created
  // synchronously right after middleware returns.
  const unblockerConfig = {
    prefix: '/proxy/',
    httpsAgent: strictAgent,
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
      // TLS override: swap agent if bookmark or session override allows insecure
      (data) => {
        if (data.uri?.protocol !== 'https:') return
        const origin = `${data.uri.protocol}//${data.uri.host}`
        const bm = bookmarks.getByOrigin?.(origin)
        const sessionId = data.clientRequest.sshwebSessionId
        const allowInsecure = (bm && bm.ignoreTls) || tlsOverrides.has(`${sessionId}|${origin}`)
        unblockerConfig.httpsAgent = allowInsecure ? permissiveAgent : strictAgent
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
  }

  // Unblocker is a connect/express middleware that expects to see /proxy/ in req.url.
  const unblocker = new Unblocker(unblockerConfig)

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
      unblocker(req, res, (err) => {
        if (!err) return next()
        // TLS certificate errors — show interstitial
        if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
            err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
            err.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
            err.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
            err.code === 'CERT_HAS_EXPIRED') {
          const proto = match[1]
          const port = req.url.match(/^\/proxy\/https?:\/\/[^/:?#]+(:\d+)/)?.[1] || ''
          const origin = `${proto}://${host}${port}`
          return tlsInterstitial(res, origin)
        }
        next(err)
      })
    }).catch(next)
  }
}
