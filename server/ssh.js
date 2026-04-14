import { Client } from 'ssh2'
import { randomUUID } from 'node:crypto'

/**
 * Manages active SSH sessions keyed by session ID.
 * Each session holds: { client, stream, ws, connId, startedAt, label }
 */
export class SshManager {
  #sessions = new Map()
  #logger

  #safeSend(ws, payload) {
    try {
      ws.send(payload)
    } catch {
      // WebSocket closed between readyState check and send — ignore
    }
  }

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
              this.#safeSend(ws, JSON.stringify({ type: 'data', data: data.toString('base64') }))
            }
          })

          stream.stderr.on('data', (data) => {
            if (ws.readyState === ws.constructor.OPEN) {
              this.#safeSend(ws, JSON.stringify({ type: 'data', data: data.toString('base64') }))
            }
          })

          stream.on('close', () => {
            if (!this.#sessions.has(sessionId)) return  // already cleaned up by kill()
            log.info('SSH stream closed')
            this.#sessions.delete(sessionId)
            if (ws.readyState === ws.constructor.OPEN) {
              this.#safeSend(ws, JSON.stringify({ type: 'close' }))
              ws.close()
            }
          })

          resolve(sessionId)
        })
      })

      client.on('error', (err) => {
        log.warn({ err }, 'SSH connection error')
        this.#sessions.delete(sessionId)
        client.end()  // defensive cleanup
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
        this.#safeSend(session.ws, JSON.stringify({ type: 'data', data: Buffer.from('\r\n' + message + '\r\n').toString('base64') }))
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
