import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { encrypt, decrypt } from './crypto.js'

export class CredentialStore {
  #db
  #key

  constructor(dbPath, key) {
    this.#key = key
    this.#db = new Database(dbPath)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'password',
        secret TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  create({ name, username, authType = 'password', secret }) {
    const id = randomUUID()
    const now = Date.now()
    this.#db.prepare(`
      INSERT INTO credentials (id, name, username, auth_type, secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, username, authType, encrypt(secret, this.#key), now, now)
    return id
  }

  get(id) {
    const row = this.#db.prepare('SELECT * FROM credentials WHERE id = ?').get(id)
    if (!row) return null
    return this.#deserialize(row)
  }

  list() {
    return this.#db
      .prepare('SELECT id, name, username, auth_type, created_at, updated_at FROM credentials ORDER BY name')
      .all()
      .map(row => ({
        id: row.id,
        name: row.name,
        username: row.username,
        authType: row.auth_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
  }

  update(id, fields) {
    const existing = this.get(id)
    if (!existing) throw new Error(`Credential ${id} not found`)
    const updated = { ...existing, ...fields }
    const now = Date.now()
    this.#db.prepare(`
      UPDATE credentials
      SET name = ?, username = ?, auth_type = ?, secret = ?, updated_at = ?
      WHERE id = ?
    `).run(updated.name, updated.username, updated.authType, encrypt(updated.secret, this.#key), now, id)
  }

  delete(id) {
    this.#db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
  }

  reencryptAll(newKey) {
    const rows = this.#db.prepare('SELECT id, secret FROM credentials').all()
    const update = this.#db.prepare('UPDATE credentials SET secret = ? WHERE id = ?')
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
      name: row.name,
      username: row.username,
      authType: row.auth_type,
      secret: decrypt(row.secret, this.#key),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
