import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserToolTransport } from './codex-browser-tool-transport.mjs'

function harness() {
  let owner = 'codex:account-1'
  let time = 1000
  const timers = new Map(), sent = []
  const transport = new BrowserToolTransport({
    getOwnerKey: () => owner, now: () => time,
    setTimer: (callback, delay) => { const timer = { unref() {} }; timers.set(timer, { callback, delay }); return timer },
    clearTimer: timer => timers.delete(timer),
  })
  const client = name => ({ chatProtocol: 2, closed: false, send(frame) { sent.push({ name, frame }); return true } })
  const request = (id = 'request-1') => ({ version: 1, requestId: id, runId: 'run-1', clientThreadId: 'ui-thread-1', cardId: 'card-1', targetCardEpoch: 'epoch-1', deadlineMs: 1500, kind: 'observe' })
  return { transport, timers, sent, client, request, setOwner: value => { owner = value }, setTime: value => { time = value } }
}

test('Browser request targets only its selected v2 UI stream and accepts one matching response', async () => {
  const h = harness()
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.registerClient(h.client('other'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const pending = h.transport.sendToUi(h.request())
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].name, 'chosen')
  assert.match(h.sent[0].frame, /^event: browser-tool-request\n/)
  assert.equal(JSON.parse(h.sent[0].frame.split('data: ')[1]).targetCardEpoch, 'epoch-1')
  await assert.rejects(h.transport.sendToUi({ ...h.request('wrong-chat'), clientThreadId: 'another-thread' }), error => error.code === 'BROWSER_UI_UNAVAILABLE')
  assert.throws(() => h.transport.receive('wrong-stream', { requestId: 'request-1', status: 'observed' }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
  assert.deepEqual(h.transport.receive(chosen, { requestId: 'request-1', status: 'observed' }), { accepted: true, requestId: 'request-1' })
  assert.deepEqual(await pending, { requestId: 'request-1', status: 'observed' })
  assert.throws(() => h.transport.receive(chosen, { requestId: 'request-1', status: 'observed' }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
})

test('Browser stream loss and account changes cannot complete a pending action', async () => {
  const h = harness()
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const pending = h.transport.sendToUi(h.request())
  h.setOwner('codex:account-2')
  assert.throws(() => h.transport.receive(chosen, { requestId: 'request-1', status: 'acted' }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
  h.transport.closeClient(chosen)
  await assert.rejects(pending, error => error.code === 'BROWSER_UI_DISCONNECTED')
  await assert.rejects(h.transport.sendToUi(h.request('request-2')), error => error.code === 'BROWSER_UI_UNAVAILABLE')
})

test('Browser deadlines and malformed target envelopes fail closed', async () => {
  const h = harness()
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  await assert.rejects(h.transport.sendToUi({ ...h.request(), targetCardEpoch: '' }), error => error.code === 'BROWSER_UI_PROTOCOL')
  const pending = h.transport.sendToUi(h.request())
  assert.equal([...h.timers.values()][0].delay, 500)
  ;[...h.timers.values()][0].callback()
  await assert.rejects(pending, error => error.code === 'BROWSER_UI_TIMEOUT')
  assert.throws(() => h.transport.receive(chosen, { requestId: 'request-1' }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
})

test('account reset revokes run authority without stranding the visible SSE stream', async () => {
  const h = harness()
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const pending = h.transport.sendToUi(h.request())
  h.transport.reset()
  await assert.rejects(pending, error => error.code === 'BROWSER_UI_DISCONNECTED')
  assert.equal(h.transport.hasClient(chosen), true)
  h.transport.bindRun('run-2', 'ui-thread-1', chosen)
  assert.equal(h.transport.runs.get('run-2').transportId, chosen)
})

test('a UI response after its absolute deadline is rejected even before the timer callback runs', async () => {
  const h = harness()
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const pending = h.transport.sendToUi(h.request())
  h.setTime(1500)
  assert.throws(() => h.transport.receive(chosen, { requestId: 'request-1', status: 'acted' }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
  await assert.rejects(pending, error => error.code === 'BROWSER_UI_TIMEOUT')
})

test('cancel request retains exact Chat and one-time selection metadata in its targeted UI envelope', async () => {
  const h = harness()
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const pending = h.transport.sendToUi({ ...h.request('cancel-1'), kind: 'cancel', selectionToken: 'one-time-token', sourceId: 'source-1' })
  const wire = JSON.parse(h.sent[0].frame.split('data: ')[1])
  assert.equal(wire.clientThreadId, 'ui-thread-1')
  assert.equal(wire.selectionToken, 'one-time-token')
  assert.equal(wire.sourceId, 'source-1')
  h.transport.receive(chosen, { requestId: 'cancel-1', status: 'cancelled' })
  assert.equal((await pending).status, 'cancelled')
})
