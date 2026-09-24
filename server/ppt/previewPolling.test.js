import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { previewPollingScript } from './previewProxy.js'

test('native live polling shares pending reads, clones bodies and retries after errors', async () => {
  let calls = 0, settle, fail
  const window = { fetch: () => {
    calls++
    return new Promise((resolve, reject) => { settle = resolve; fail = reject })
  } }
  vm.runInNewContext(previewPollingScript, { window })
  const first = window.fetch('/preview/api/slides')
  const second = window.fetch('/preview/api/slides')
  assert.equal(calls, 1)
  settle(new Response('{"slides":[]}'))
  assert.deepEqual(await (await first).json(), { slides: [] })
  assert.deepEqual(await (await second).json(), { slides: [] })
  const failed = window.fetch('/preview/api/slides')
  fail(new Error('network'))
  await assert.rejects(failed, /network/)
  const retry = window.fetch('/preview/api/slides')
  assert.equal(calls, 3)
  settle(new Response('{}'))
  await retry
  const write = window.fetch('/preview/api/slides', { method: 'POST' })
  const settleWrite = settle
  const read = window.fetch('/preview/api/slides')
  assert.equal(calls, 5, 'writes must never be coalesced with reads')
  settle(new Response('{}'))
  settleWrite(new Response('{}'))
  await read
  await write
})
