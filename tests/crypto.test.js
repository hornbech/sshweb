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

test('encrypt throws on wrong key length', () => {
  assert.throws(() => encrypt('data', Buffer.alloc(16)), /32-byte/)
})

test('decrypt throws on truncated ciphertext', () => {
  assert.throws(() => decrypt(Buffer.alloc(10).toString('base64'), Buffer.alloc(32, 'a')), /too short/)
})

test('decrypt throws on wrong key', () => {
  const key1 = Buffer.alloc(32, 0x01)
  const key2 = Buffer.alloc(32, 0x02)
  const ciphertext = encrypt('secret', key1)
  assert.throws(() => decrypt(ciphertext, key2))
})
