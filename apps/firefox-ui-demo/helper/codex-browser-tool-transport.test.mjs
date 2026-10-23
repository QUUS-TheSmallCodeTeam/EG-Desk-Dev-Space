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
  const wire = (index = sent.length - 1) => JSON.parse(sent[index].frame.split('data: ')[1])
  return { transport, timers, sent, client, request, wire, setOwner: value => { owner = value }, setTime: value => { time = value } }
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
  const requestId = h.wire().requestId
  assert.throws(() => h.transport.receive('wrong-stream', { requestId, status: 'observed' }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
  assert.deepEqual(h.transport.receive(chosen, { requestId, status: 'observed' }), { accepted: true, requestId })
  assert.deepEqual(await pending, { requestId: 'request-1', status: 'observed' })
  assert.throws(() => h.transport.receive(chosen, { requestId, status: 'observed' }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
})

test('Browser stream loss and account changes cannot complete a pending action', async () => {
  const h = harness()
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const pending = h.transport.sendToUi(h.request())
  h.setOwner('codex:account-2')
  assert.throws(() => h.transport.receive(chosen, { requestId: h.wire().requestId, status: 'acted' }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
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
  assert.throws(() => h.transport.receive(chosen, { requestId: h.wire().requestId }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
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
  assert.throws(() => h.transport.receive(chosen, { requestId: h.wire().requestId, status: 'acted' }), error => error.code === 'BROWSER_UI_RESPONSE_STALE')
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
  h.transport.receive(chosen, { requestId: wire.requestId, status: 'cancelled' })
  assert.equal((await pending).status, 'cancelled')
})

test('unbinding run A terminates only its pending requests and timers; late A is stale while B completes without resend', async t => {
  const h = harness()
  t.after(() => h.transport.reset())
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  h.transport.bindRun('run-2', 'ui-thread-1', chosen)
  const a = h.transport.sendToUi({ ...h.request('request-a'), kind: 'act' }).catch(error => error)
  const b = h.transport.sendToUi({ ...h.request('request-b'), runId: 'run-2' })
  b.catch(() => {})
  assert.equal(h.sent.length, 2)
  h.transport.unbindRun('run-1')
  assert.equal(h.transport.pending.has(h.wire(0).requestId), false)
  assert.equal(h.transport.pending.has(h.wire(1).requestId), true)
  assert.equal(h.timers.size, 1)
  const ended = await a
  assert.equal(ended.code, 'BROWSER_RUN_ENDED')
  assert.match(ended.message, /outcome is unknown/)
  assert.throws(() => h.transport.receive(chosen, { requestId: h.wire(0).requestId, status: 'acted' }),
    { code: 'BROWSER_UI_RESPONSE_STALE' })
  h.transport.receive(chosen, { requestId: h.wire(1).requestId, status: 'observed' })
  assert.equal((await b).status, 'observed')
  assert.equal(h.transport.pending.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.sent.length, 2, 'ending or receiving a request must not resend it')
})

test('reusing a run ID cannot revive its old request or let old cleanup affect the new binding', async t => {
  const h = harness()
  t.after(() => h.transport.reset())
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const oldBinding = h.transport.runs.get('run-1')
  const old = h.transport.sendToUi({ ...h.request('old-request'), kind: 'act' }).catch(error => error)
  const oldTimeout = [...h.timers.values()][0].callback
  h.transport.unbindRun('run-1')
  assert.equal(h.transport.pending.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal((await old).code, 'BROWSER_RUN_ENDED')
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  assert.notEqual(h.transport.runs.get('run-1'), oldBinding)
  const fresh = h.transport.sendToUi(h.request('fresh-request'))
  fresh.catch(() => {})
  oldTimeout()
  assert.throws(() => h.transport.receive(chosen, { requestId: h.wire(0).requestId, status: 'acted' }),
    { code: 'BROWSER_UI_RESPONSE_STALE' })
  assert.equal(h.transport.pending.has(h.wire(1).requestId), true)
  assert.equal(h.timers.size, 1)
  h.transport.receive(chosen, { requestId: h.wire(1).requestId, status: 'observed' })
  assert.equal((await fresh).status, 'observed')
  assert.equal(h.timers.size, 0)
  assert.equal(h.sent.length, 2)
})

test('a late response cannot settle a new request that reuses both caller request ID and run ID', async t => {
  const h = harness()
  t.after(() => h.transport.reset())
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const old = h.transport.sendToUi({ ...h.request(), kind: 'act' }).catch(error => error)
  const oldWire = JSON.parse(h.sent[0].frame.split('data: ')[1])
  h.transport.unbindRun('run-1')
  assert.equal((await old).code, 'BROWSER_RUN_ENDED')
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const fresh = h.transport.sendToUi(h.request())
  fresh.catch(() => {})
  const freshWire = JSON.parse(h.sent[1].frame.split('data: ')[1])
  assert.throws(() => h.transport.receive(chosen, { requestId: oldWire.requestId, status: 'acted' }),
    { code: 'BROWSER_UI_RESPONSE_STALE' })
  h.transport.receive(chosen, { requestId: freshWire.requestId, status: 'observed' })
  assert.deepEqual(await fresh, { requestId: 'request-1', status: 'observed' })
  assert.equal(h.transport.pending.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.sent.length, 2)
})

test('account reset keeps the stream but old response IDs cannot complete a new owner request', async t => {
  const h = harness()
  t.after(() => h.transport.reset())
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const old = h.transport.sendToUi({ ...h.request(), kind: 'act' }).catch(error => error)
  const oldWire = h.wire()
  h.transport.reset()
  assert.equal((await old).code, 'BROWSER_UI_DISCONNECTED')
  h.setOwner('codex:account-2')
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const fresh = h.transport.sendToUi(h.request())
  fresh.catch(() => {})
  assert.throws(() => h.transport.receive(chosen, { requestId: oldWire.requestId, status: 'acted' }),
    { code: 'BROWSER_UI_RESPONSE_STALE' })
  assert.equal(h.transport.pending.size, 1)
  h.transport.receive(chosen, { requestId: h.wire().requestId, status: 'observed' })
  assert.deepEqual(await fresh, { requestId: 'request-1', status: 'observed' })
  assert.equal(h.timers.size, 0)
  assert.equal(h.sent.length, 2)
})

test('unique handoff IDs preserve duplicate-call rejection and the 64-request bound with complete unbind cleanup', async t => {
  const h = harness()
  t.after(() => h.transport.reset())
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const pending = []
  for (let index = 0; index < 64; index++) {
    pending.push(h.transport.sendToUi(h.request(`bounded-${index}`)).catch(error => error))
    if (index === 0) await assert.rejects(h.transport.sendToUi(h.request('bounded-0')), { code: 'BROWSER_UI_BUSY' })
  }
  await assert.rejects(h.transport.sendToUi(h.request('overflow')), { code: 'BROWSER_UI_BUSY' })
  assert.equal(h.transport.pending.size, 64)
  assert.equal(h.timers.size, 64)
  h.transport.unbindRun('run-1')
  assert((await Promise.all(pending)).every(error => error.code === 'BROWSER_RUN_ENDED'))
  assert.equal(h.transport.pending.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.sent.length, 64)
})
