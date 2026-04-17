import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('bookmark store CRUD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshweb-bm-'))
  try {
    const { BookmarkStore } = await import('../server/bookmarks.js')
    const store = new BookmarkStore(join(dir, 'bookmarks.db'))

    const id = store.create({ label: 'Pi-hole', url: 'http://192.168.1.5/admin', ignoreTls: false })
    assert.ok(id)

    const bm = store.get(id)
    assert.equal(bm.label, 'Pi-hole')
    assert.equal(bm.url, 'http://192.168.1.5/admin')
    assert.equal(bm.ignoreTls, false)

    const all = store.list()
    assert.equal(all.length, 1)

    store.update(id, { label: 'Pi-hole (renamed)', ignoreTls: true })
    const updated = store.get(id)
    assert.equal(updated.label, 'Pi-hole (renamed)')
    assert.equal(updated.ignoreTls, true)

    store.delete(id)
    assert.equal(store.list().length, 0)

    store.close()
  } finally {
    rmSync(dir, { recursive: true })
  }
})
