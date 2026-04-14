import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('connection store CRUD with encryption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshweb-store-'))
  try {
    const { ConnectionStore } = await import('../server/store.js')
    const key = Buffer.alloc(32, 0x42)
    const store = new ConnectionStore(join(dir, 'test.db'), key)

    // Create
    const id = store.create({
      label: 'My Server',
      host: '192.168.1.10',
      port: 22,
      username: 'admin',
      authType: 'password',
      secret: 'mysecretpassword',
    })
    assert.ok(id)

    // Read
    const conn = store.get(id)
    assert.equal(conn.label, 'My Server')
    assert.equal(conn.host, '192.168.1.10')
    assert.equal(conn.secret, 'mysecretpassword') // decrypted on read

    // List
    const all = store.list()
    assert.equal(all.length, 1)
    assert.equal(all[0].id, id)
    assert.equal(all[0].secret, undefined) // list does NOT return secrets

    // Update
    store.update(id, { label: 'Renamed', secret: 'newpassword' })
    const updated = store.get(id)
    assert.equal(updated.label, 'Renamed')
    assert.equal(updated.secret, 'newpassword')

    // Delete
    store.delete(id)
    assert.equal(store.list().length, 0)

    store.close()
  } finally {
    rmSync(dir, { recursive: true })
  }
})
