import { strict as assert } from 'node:assert'
import { test } from 'node:test'

test('config exports expected fields with defaults', async () => {
  // Set minimal env
  process.env.DATA_DIR = './data'
  process.env.PORT = '3000'

  const { config } = await import('../server/config.js')

  assert.equal(config.port, 3000)
  assert.equal(config.dataDir, './data')
  assert.equal(config.sessionTimeoutMinutes, 60)
  assert.equal(config.maxSessions, 10)
  assert.equal(config.logLevel, 'info')
})
