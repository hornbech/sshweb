import { randomBytes } from 'node:crypto'

export class SessionManager {
  #sessions = new Map() // token → expiresAt (ms)
  #timeoutMs

  constructor(timeoutMinutes) {
    this.#timeoutMs = timeoutMinutes * 60 * 1000
    // Prune expired tokens periodically
    setInterval(() => this.#prune(), 5 * 60 * 1000).unref()
  }

  create() {
    const token = randomBytes(32).toString('hex')
    this.#sessions.set(token, Date.now() + this.#timeoutMs)
    return token
  }

  validate(token) {
    if (!token) return false
    const expiresAt = this.#sessions.get(token)
    if (!expiresAt) return false
    if (Date.now() > expiresAt) {
      this.#sessions.delete(token)
      return false
    }
    // Slide expiry on activity
    this.#sessions.set(token, Date.now() + this.#timeoutMs)
    return true
  }

  destroy(token) {
    this.#sessions.delete(token)
  }

  clear() {
    this.#sessions.clear()
  }

  get count() {
    return this.#sessions.size
  }

  #prune() {
    const now = Date.now()
    for (const [token, expiresAt] of this.#sessions) {
      if (now > expiresAt) this.#sessions.delete(token)
    }
  }
}

// Parse the session token from a raw Cookie header (works for both
// Express req and raw Node IncomingMessage used by the WS upgrade).
export function getSessionToken(req) {
  const cookie = req.headers?.cookie ?? ''
  const m = cookie.match(/(?:^|;\s*)session=([^;]+)/)
  return m?.[1] ? decodeURIComponent(m[1]) : null
}
