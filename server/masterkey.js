import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import argon2 from 'argon2'

const SALT_FILE = 'salt'
const VERIFY_FILE = 'verify'
const VERIFY_DATA = 'sshweb-unlock-ok'
const KEY_BYTES = 32

export class MasterKey {
  #key = null
  #dataDir

  constructor(dataDir) {
    this.#dataDir = dataDir
    mkdirSync(dataDir, { recursive: true })
  }

  isUnlocked() {
    return this.#key !== null
  }

  getKey() {
    return this.#key ? Buffer.from(this.#key) : null
  }

  lock() {
    if (this.#key) {
      this.#key.fill(0) // zero out memory
      this.#key = null
    }
  }

  async unlock(password) {
    const salt = this.#getOrCreateSalt()
    const key = await argon2.hash(password, {
      type: argon2.argon2id,
      salt,
      raw: true,
      hashLength: KEY_BYTES,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    })

    const verifyFile = join(this.#dataDir, VERIFY_FILE)
    if (!existsSync(verifyFile)) {
      // First run: create verification token
      const token = createHmac('sha256', key).update(VERIFY_DATA).digest('base64')
      writeFileSync(verifyFile, token, 'utf8')
    } else {
      // Subsequent runs: verify password is correct
      const stored = readFileSync(verifyFile, 'utf8').trim()
      const candidate = createHmac('sha256', key).update(VERIFY_DATA).digest('base64')
      if (!timingSafeEqual(Buffer.from(stored), Buffer.from(candidate))) {
        throw new Error('Invalid master password')
      }
    }

    this.#key = key
  }

  #getOrCreateSalt() {
    const saltFile = join(this.#dataDir, SALT_FILE)
    if (existsSync(saltFile)) {
      return readFileSync(saltFile)
    }
    const salt = randomBytes(32)
    writeFileSync(saltFile, salt)
    return salt
  }
}
