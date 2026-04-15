import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { encrypt, decrypt } from './crypto.js'

export class ConnectionStore {
  #db
  #key

  constructor(dbPath, key) {
    this.#key = key
    this.#db = new Database(dbPath)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'password',
        secret TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  create({ label, host, port = 22, username, authType = 'password', secret }) {
    const id = randomUUID()
    const now = Date.now()
    this.#db.prepare(`
      INSERT INTO connections (id, label, host, port, username, auth_type, secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, label, host, port, username, authType, encrypt(secret, this.#key), now, now)
    return id
  }

  get(id) {
    const row = this.#db.prepare('SELECT * FROM connections WHERE id = ?').get(id)
    if (!row) return null
    return this.#deserialize(row)
  }

  list() {
    return this.#db
      .prepare('SELECT id, label, host, port, username, auth_type, created_at, updated_at FROM connections ORDER BY label')
      .all()
      .map(row => ({
        id: row.id,
        label: row.label,
        host: row.host,
        port: row.port,
        username: row.username,
        authType: row.auth_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
  }

  update(id, fields) {
    const existing = this.get(id)
    if (!existing) throw new Error(`Connection ${id} not found`)
    const updated = { ...existing, ...fields }
    const now = Date.now()
    this.#db.prepare(`
      UPDATE connections
      SET label = ?, host = ?, port = ?, username = ?, auth_type = ?, secret = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.label, updated.host, updated.port, updated.username,
      updated.authType, encrypt(updated.secret, this.#key), now, id
    )
  }

  delete(id) {
    this.#db.prepare('DELETE FROM connections WHERE id = ?').run(id)
  }

  reencryptAll(newKey) {
    const rows = this.#db.prepare('SELECT id, secret FROM connections').all()
    const update = this.#db.prepare('UPDATE connections SET secret = ? WHERE id = ?')
    this.#db.transaction(() => {
      for (const row of rows) {
        update.run(encrypt(decrypt(row.secret, this.#key), newKey), row.id)
      }
    })()
    this.#key = Buffer.from(newKey)
  }

  close() {
    this.#db.close()
  }

  #deserialize(row) {
    return {
      id: row.id,
      label: row.label,
      host: row.host,
      port: row.port,
      username: row.username,
      authType: row.auth_type,
      secret: decrypt(row.secret, this.#key),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
