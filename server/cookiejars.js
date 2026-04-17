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
