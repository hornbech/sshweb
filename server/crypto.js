import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Encrypt plaintext string with AES-256-GCM.
 * Returns a base64 string: iv(12) + tag(16) + ciphertext
 * @param {string} plaintext
 * @param {Buffer} key - 32-byte key
 * @returns {string}
 */
export function encrypt(plaintext, key) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

/**
 * Decrypt a base64 AES-256-GCM ciphertext string.
 * @param {string} ciphertextB64
 * @param {Buffer} key - 32-byte key
 * @returns {string}
 */
export function decrypt(ciphertextB64, key) {
  const data = Buffer.from(ciphertextB64, 'base64')
  const iv = data.subarray(0, IV_BYTES)
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = data.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
}
