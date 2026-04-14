import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('full unlock/lock/verify cycle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sshweb-test-'))
  try {
    const { MasterKey } = await import('../server/masterkey.js')
    const mk = new MasterKey(dir)

    assert.equal(mk.isUnlocked(), false)

    // First unlock: initialises salt + verification token
    await mk.unlock('correct-password')
    assert.equal(mk.isUnlocked(), true)
    assert.ok(mk.getKey() instanceof Buffer)
    assert.equal(mk.getKey().length, 32)

    // Lock
    mk.lock()
    assert.equal(mk.isUnlocked(), false)
    assert.equal(mk.getKey(), null)

    // Unlock again with same password: must produce same key
    const key1 = (await mk.unlock('correct-password'), mk.getKey())
    mk.lock()
    const key2 = (await mk.unlock('correct-password'), mk.getKey())
    assert.deepEqual(key1, key2)

    // Wrong password must throw
    mk.lock()
    await assert.rejects(() => mk.unlock('wrong-password'), /invalid/i)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
