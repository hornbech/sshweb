import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CookieJarStore } from '../server/cookiejars.js'

test('cookie jars are isolated per session and per origin', async () => {
  const store = new CookieJarStore()
  const jarA = store.getJar('session-1', 'http://192.168.1.5')
  const jarB = store.getJar('session-1', 'http://192.168.1.6')
  const jarC = store.getJar('session-2', 'http://192.168.1.5')

  await jarA.setCookie('hello=world; Path=/', 'http://192.168.1.5')
  const fromA = await jarA.getCookieString('http://192.168.1.5')
  const fromB = await jarB.getCookieString('http://192.168.1.5')
  const fromC = await jarC.getCookieString('http://192.168.1.5')

  assert.equal(fromA, 'hello=world')
  assert.equal(fromB, '')
  assert.equal(fromC, '')

  store.clearSession('session-1')
  const postClear = await store.getJar('session-1', 'http://192.168.1.5').getCookieString('http://192.168.1.5')
  assert.equal(postClear, '')
})
