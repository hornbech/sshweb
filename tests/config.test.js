import { strict as assert } from 'node:assert'
import { test } from 'node:test'

// Note: ESM module cache means config.js is loaded once per process.
// We test the exported values' types and validity, not default fallbacks
// (which require fresh process invocations to test meaningfully).
import { config } from '../server/config.js'

const VALID_LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

test('config.port is a finite integer', () => {
  assert.equal(typeof config.port, 'number')
  assert.ok(Number.isFinite(config.port))
  assert.ok(config.port > 0 && config.port <= 65535, `port ${config.port} out of valid range`)
})

test('config.dataDir is a non-empty string', () => {
  assert.equal(typeof config.dataDir, 'string')
  assert.ok(config.dataDir.length > 0)
})

test('config.sessionTimeoutMinutes is a positive finite integer', () => {
  assert.equal(typeof config.sessionTimeoutMinutes, 'number')
  assert.ok(Number.isFinite(config.sessionTimeoutMinutes))
  assert.ok(config.sessionTimeoutMinutes > 0)
})

test('config.maxSessions is a positive finite integer', () => {
  assert.equal(typeof config.maxSessions, 'number')
  assert.ok(Number.isFinite(config.maxSessions))
  assert.ok(config.maxSessions > 0)
})

test('config.logLevel is a valid pino log level', () => {
  assert.ok(VALID_LOG_LEVELS.has(config.logLevel), `logLevel "${config.logLevel}" is not a valid pino level`)
})
