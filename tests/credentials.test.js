import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('credential store CRUD with encryption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshweb-cred-'))
  try {
    const { CredentialStore } = await import('../server/credentials.js')
    const key = Buffer.alloc(32, 0x42)
    const store = new CredentialStore(join(dir, 'test.db'), key)

    // Create
    const id = store.create({ name: 'Home Lab Admin', username: 'admin', authType: 'password', secret: 's3cret' })
    assert.ok(id)

    // Read
    const cred = store.get(id)
    assert.equal(cred.name, 'Home Lab Admin')
    assert.equal(cred.username, 'admin')
    assert.equal(cred.secret, 's3cret')

    // List omits secret
    const all = store.list()
    assert.equal(all.length, 1)
    assert.equal(all[0].id, id)
    assert.equal(all[0].secret, undefined)

    // Update
    store.update(id, { name: 'Renamed', secret: 'newpass' })
    const updated = store.get(id)
    assert.equal(updated.name, 'Renamed')
    assert.equal(updated.secret, 'newpass')

    // Delete
    store.delete(id)
    assert.equal(store.list().length, 0)

    store.close()
  } finally {
    rmSync(dir, { recursive: true })
  }
})
