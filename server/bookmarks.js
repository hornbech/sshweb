import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export class BookmarkStore {
  #db

  constructor(dbPath) {
    this.#db = new Database(dbPath)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id         TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        url        TEXT NOT NULL,
        ignore_tls INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  create({ label, url, ignoreTls = false, sortOrder = 0 }) {
    const id = randomUUID()
    const now = Date.now()
    this.#db.prepare(`
      INSERT INTO bookmarks (id, label, url, ignore_tls, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, label, url, ignoreTls ? 1 : 0, sortOrder, now, now)
    return id
  }

  get(id) {
    const row = this.#db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id)
    return row ? this.#deserialize(row) : null
  }

  list() {
    return this.#db
      .prepare('SELECT * FROM bookmarks ORDER BY sort_order, label')
      .all()
      .map(r => this.#deserialize(r))
  }

  update(id, fields) {
    const existing = this.get(id)
    if (!existing) throw new Error(`Bookmark ${id} not found`)
    const updated = { ...existing, ...fields }
    const now = Date.now()
    this.#db.prepare(`
      UPDATE bookmarks
      SET label = ?, url = ?, ignore_tls = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `).run(updated.label, updated.url, updated.ignoreTls ? 1 : 0, updated.sortOrder ?? 0, now, id)
  }

  delete(id) {
    this.#db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
  }

  close() { this.#db.close() }

  #deserialize(row) {
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      ignoreTls: row.ignore_tls === 1,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
