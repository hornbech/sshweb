import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isPrivateAddress, classifyHost } from '../server/netguard.js'

test('isPrivateAddress — RFC1918 + loopback', () => {
  assert.equal(isPrivateAddress('10.0.0.1'), true)
  assert.equal(isPrivateAddress('172.16.5.5'), true)
  assert.equal(isPrivateAddress('172.31.255.255'), true)
  assert.equal(isPrivateAddress('192.168.1.1'), true)
  assert.equal(isPrivateAddress('127.0.0.1'), true)
  assert.equal(isPrivateAddress('::1'), true)
  assert.equal(isPrivateAddress('fc00::1'), true)
  assert.equal(isPrivateAddress('fe80::1'), true)

  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('1.1.1.1'), false)
  assert.equal(isPrivateAddress('172.32.0.1'), false)
  assert.equal(isPrivateAddress('2606:4700::1'), false)
})

test('classifyHost resolves DNS names and rejects public resolutions', async () => {
  // Literal private IP passes without DNS
  const ok = await classifyHost('192.168.0.1')
  assert.equal(ok.allowed, true)
  assert.equal(ok.resolvedIp, '192.168.0.1')

  // Literal public IP rejected
  const bad = await classifyHost('8.8.8.8')
  assert.equal(bad.allowed, false)
  assert.match(bad.reason, /public/i)
})
