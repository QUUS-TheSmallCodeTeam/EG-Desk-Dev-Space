import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserToolTransport } from './codex-browser-tool-transport.mjs'

function harness() {
  let owner = 'codex:account-1'
  let time = 1000, clockTime = 50000.5
  const timers = new Map(), sent = []
  const transport = new BrowserToolTransport({
    getOwnerKey: () => owner, now: () => time, clock: () => clockTime,
    setTimer: (callback, delay) => { const timer = { unref() {} }; timers.set(timer, { callback, delay }); return timer },
    clearTimer: timer => timers.delete(timer),
  })
  const client = name => ({ chatProtocol: 2, closed: false, send(frame) { sent.push({ name, frame }); return true } })
  const request = (id = 'request-1') => ({ version: 1, requestId: id, runId: 'run-1', clientThreadId: 'ui-thread-1', cardId: 'card-1', targetCardEpoch: 'epoch-1', deadlineMs: 1500, kind: 'observe' })
  const wire = (index = sent.length - 1) => JSON.parse(sent[index].frame.split('data: ')[1])
  return { transport, timers, sent, client, request, wire, setOwner: value => { owner = value }, setTime: value => { time = value },
    setClock: value => { clockTime = value } }
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

test('a 200000-character fill request crosses the stream whole, on one SSE data line', async () => {
  const h = harness()
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const text = '가😀 line\n"quote"\\\u2028'.repeat(20000).slice(0, 200000)
  assert.equal(text.length, 200000)
  const pending = h.transport.sendToUi({ ...h.request(), kind: 'act', action: { type: 'fill', ref: 'el_1', text } })
  assert.equal(h.sent.length, 1)
  const frame = h.sent[0].frame
  assert.equal(frame.split('\n').length, 4, 'event, data, blank, trailing: no raw newline inside the payload')
  assert.equal(h.wire().action.text, text, 'text arrives identical, in order')
  h.transport.receive(chosen, { requestId: h.wire().requestId, status: 'acted' })
  assert.equal((await pending).status, 'acted')
})

test('a closed stream is still an honest failure for a very long request', async () => {
  const h = harness()
  const chosen = h.transport.registerClient({ chatProtocol: 2, closed: false, send: () => false })
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  await assert.rejects(h.transport.sendToUi({ ...h.request(), action: { text: 'x'.repeat(300000) } }), error => error.code === 'BROWSER_UI_DISCONNECTED')
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

// REA 웹10: seq and sentAtMs ride the wire unchanged; UI timing returns unchanged; timeouts are dated.
test('seq and sentAtMs reach the UI unchanged beside the unique wire ID; malformed values are refused before sending', async t => {
  const h = harness()
  t.after(() => h.transport.reset())
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const first = h.transport.sendToUi({ ...h.request('seq-1'), seq: 7, sentAtMs: 49999.125 })
  first.catch(() => {})
  const second = h.transport.sendToUi({ ...h.request('seq-2'), seq: 8, sentAtMs: 49999.5 })
  second.catch(() => {})
  assert.deepEqual([h.wire(0).seq, h.wire(1).seq], [7, 8])
  assert.deepEqual([h.wire(0).sentAtMs, h.wire(1).sentAtMs], [49999.125, 49999.5])
  assert.notEqual(h.wire(0).requestId, 'seq-1', 'the wire ID stays a fresh handoff ID')
  for (const [field, value] of [['seq', 0], ['seq', 1.5], ['seq', '9'], ['seq', null],
    ['sentAtMs', Number.NaN], ['sentAtMs', -1], ['sentAtMs', '49999'], ['sentAtMs', Infinity]]) {
    const refused = h.transport.sendToUi({ ...h.request(`bad-${field}-${String(value)}`), [field]: value })
    refused.catch(() => {})
    assert.equal(h.sent.length, 2, `${field}=${String(value)}: a malformed request never reaches the UI`)
    await assert.rejects(refused, { code: 'BROWSER_UI_PROTOCOL' }, `${field}=${String(value)}`)
  }
  const legacy = h.transport.sendToUi(h.request('legacy'))
  legacy.catch(() => {})
  assert.equal(Object.hasOwn(h.wire(), 'seq'), false, 'a request without seq is still accepted as before')
})

test('UI timing in a response reaches the helper unchanged', async t => {
  const h = harness()
  t.after(() => h.transport.reset())
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const pending = h.transport.sendToUi({ ...h.request(), kind: 'act', seq: 3, sentAtMs: 50000.25 })
  const timing = { receivedAtMs: 50000.75, authorizedAtMs: 50001, performEnterMs: 50001.25, performExitMs: 50002,
    performCallsBefore: 4, performCallsAfter: 5, firstEventAtMs: 50001.5 }
  h.transport.receive(chosen, { requestId: h.wire().requestId, status: 'rejected', dispatchPhase: 'dispatched', timing })
  assert.deepEqual(await pending, { requestId: 'request-1', status: 'rejected', dispatchPhase: 'dispatched', timing })
})

test('a transport timeout records seq, sentAtMs and timedOutAtMs and still leaves a late response stale', async t => {
  const h = harness()
  t.after(() => h.transport.reset())
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  const timed = h.transport.sendToUi({ ...h.request('timed'), kind: 'act', seq: 4, sentAtMs: 50000.25 }).catch(error => error)
  h.setClock(50500.5)
  ;[...h.timers.values()][0].callback()
  const timeout = await timed
  assert.equal(timeout.code, 'BROWSER_UI_TIMEOUT')
  assert.match(timeout.message, /outcome is unknown/)
  assert.deepEqual([timeout.seq, timeout.sentAtMs, timeout.timedOutAtMs], [4, 50000.25, 50500.5])
  assert.throws(() => h.transport.receive(chosen, { requestId: h.wire().requestId, status: 'acted' }),
    { code: 'BROWSER_UI_RESPONSE_STALE' })

  const late = h.transport.sendToUi({ ...h.request('late'), kind: 'act', seq: 5, sentAtMs: 50600 }).catch(error => error)
  h.setTime(1500)
  h.setClock(50700.75)
  assert.throws(() => h.transport.receive(chosen, { requestId: h.wire().requestId, status: 'acted' }),
    { code: 'BROWSER_UI_RESPONSE_STALE' })
  const lateTimeout = await late
  assert.equal(lateTimeout.code, 'BROWSER_UI_TIMEOUT')
  assert.deepEqual([lateTimeout.seq, lateTimeout.sentAtMs, lateTimeout.timedOutAtMs], [5, 50600, 50700.75])
  assert.equal(h.transport.pending.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.sent.length, 2, 'a timeout never resends')
})

test('budgetMs and callId reach the UI unchanged; malformed values are refused before sending; a timeout names its handoff ID', async t => {
  const h = harness()
  t.after(() => h.transport.reset())
  const chosen = h.transport.registerClient(h.client('chosen'))
  h.transport.bindRun('run-1', 'ui-thread-1', chosen)
  for (const bad of [{ budgetMs: 0 }, { budgetMs: 60001 }, { budgetMs: 1.5 }, { budgetMs: '500' },
    { callId: '' }, { callId: 'x'.repeat(161) }, { callId: 7 }]) {
    await assert.rejects(h.transport.sendToUi({ ...h.request('bad'), kind: 'act', ...bad }), { code: 'BROWSER_UI_PROTOCOL' }, JSON.stringify(bad))
  }
  assert.equal(h.sent.length, 0)
  const pending = h.transport.sendToUi({ ...h.request('act-1'), kind: 'act', budgetMs: 500, callId: 'native-call-1' }).catch(error => error)
  const wire = h.wire()
  assert.equal(wire.budgetMs, 500)
  assert.equal(wire.callId, 'native-call-1')
  ;[...h.timers.values()][0].callback()
  const timeout = await pending
  assert.equal(timeout.code, 'BROWSER_UI_TIMEOUT')
  assert.equal(timeout.wireRequestId, wire.requestId, 'the lease request ID Firefox handed the actor')
  assert.notEqual(timeout.wireRequestId, 'act-1')
  // A reconcile question travels like any other request, with no action.
  const question = h.transport.sendToUi({ ...h.request('question-1'), kind: 'reconcile', callId: 'native-call-1',
    actRequestId: wire.requestId, budgetMs: 300 })
  const asked = h.wire()
  assert.equal(asked.kind, 'reconcile')
  assert.equal(asked.actRequestId, wire.requestId)
  h.transport.receive(chosen, { requestId: asked.requestId, status: 'reconciled',
    reconcile: { callId: 'native-call-1', entered: false, fenced: true } })
  assert.equal((await question).reconcile.entered, false)
})
