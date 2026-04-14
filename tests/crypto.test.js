import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { encrypt, decrypt } from '../server/crypto.js'

test('encrypt then decrypt returns original plaintext', () => {
  const key = Buffer.alloc(32, 'a') // 256-bit test key
  const plaintext = 'super-secret-password'

  const ciphertext = encrypt(plaintext, key)
  const result = decrypt(ciphertext, key)

  assert.equal(result, plaintext)
})

test('encrypt produces different output each call (random IV)', () => {
  const key = Buffer.alloc(32, 'b')
  const plaintext = 'same input'

  const c1 = encrypt(plaintext, key)
  const c2 = encrypt(plaintext, key)

  assert.notEqual(c1, c2)
})

test('decrypt throws on tampered ciphertext', () => {
  const key = Buffer.alloc(32, 'c')
  const ciphertext = encrypt('data', key)
  const tampered = ciphertext.slice(0, -4) + 'xxxx'

  assert.throws(() => decrypt(tampered, key))
})
