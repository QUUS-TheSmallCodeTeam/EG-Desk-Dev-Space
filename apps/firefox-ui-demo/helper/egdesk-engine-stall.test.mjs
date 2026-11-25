// c33: the first-event watchdog. A fake engine that accepts turn/start and then goes silent; real (short) timers; no process starts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { ENGINE_STALL_FLAG, ENGINE_STALL_LIMITS, eventTurnId, stallConfigFromEnv, stallFact } from './egdesk-engine-stall.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

test('the flag: an integer number of milliseconds within the limits, anything else is off; the turn id of an event; the closed fact', () => {
  assert.deepEqual(stallConfigFromEnv({ [ENGINE_STALL_FLAG]: '45000' }), { firstEventMs: 45000 }); assert.deepEqual(stallConfigFromEnv({ [ENGINE_STALL_FLAG]: '5000' }), { firstEventMs: 5000 }); assert.deepEqual(stallConfigFromEnv({ [ENGINE_STALL_FLAG]: '120000' }), { firstEventMs: 120000 })
  for (const bad of [undefined, '', 'on', '4999', '120001', '45s', '-1', '45000.5', '0450000']) assert.equal(stallConfigFromEnv(bad === undefined ? {} : { [ENGINE_STALL_FLAG]: bad }), null, String(bad))
  assert.deepEqual([ENGINE_STALL_LIMITS.minMs, ENGINE_STALL_LIMITS.maxMs], [5000, 120000])
  assert.deepEqual([eventTurnId({ params: { turnId: 't1' } }), eventTurnId({ params: { turn: { id: 't2' } } }), eventTurnId({ params: { item: { turnId: 't3' } } }), eventTurnId({ params: { threadId: 'x' } }), eventTurnId(null)], ['t1', 't2', 't3', null, null])
  assert.deepEqual(stallFact({ afterMs: 45000, stalls: 1, recovered: true }), { stalled: true, afterMs: 45000, count: 1, retried: true, recovered: true, outcome: 'recovered' }); assert.equal(stallFact({ afterMs: 1, stalls: 2, recovered: false }).outcome, 'failed')
})

const MS = 80
function world(t, options = {}) {
  const stall = 'stall' in options ? options.stall : { firstEventMs: MS }, plan = options.plan ?? []
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-stall-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const project = path.join(base, 'p'); fs.mkdirSync(project)
  const calls = [], turns = []; let chat = null, n = 0
  const request = async (method, params) => {
    calls.push([method, structuredClone(params)])
    if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }
    if (method === 'turn/interrupt') return options.hangInterrupt ? new Promise(() => {}) : {}
    if (method === 'turn/start') {
      const id = `turn-${++n}`, behaviour = plan[n - 1] ?? 'events'; turns.push(id)
      const emit = () => chat.handleNotification({ method: 'turn/started', params: { threadId: 'conv-1', turn: { id, status: 'inProgress', items: [] } } })
      if (behaviour === 'events') setTimeout(emit, 5)
      else if (behaviour === 'before') { void emit() }                                    // an event BEFORE the answer
      else if (behaviour === 'threadLevel') setTimeout(() => chat.handleNotification({ method: 'thread/status/changed', params: { threadId: 'conv-1', status: 'active' } }), 5) // belongs to no turn
      else if (behaviour === 'tool') setTimeout(() => chat.handleServerRequest({ id: 'rq-1', method: 'item/tool/call', params: { threadId: 'conv-1', turnId: id, callId: 'c1', tool: 'unknown_tool', arguments: {} } }).catch(() => {}), 5)
      else if (behaviour === 'oldTurnLate') setTimeout(() => chat.handleNotification({ method: 'turn/completed', params: { threadId: 'conv-1', turn: { id: 'turn-1', status: 'interrupted', items: [] } } }), MS + 20) // after the stall was detected and turn-1 interrupted: the second turn is waiting
      return { turn: { id, status: 'inProgress', items: [] } }
    }
    return {}
  }
  chat = new CodexChatRuntime({ request, respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:stall', ...(stall ? { engineStall: stall } : {}) })
  chat.setConnection(true)
  return { chat, project, calls, turns, of: m => calls.filter(([x]) => x === m).map(([, p]) => p) }
}
const send = (w, id = 'r1') => w.chat.send({ message: '테스트', clientThreadId: 'ui', requestId: id, cwd: w.project })

test('healthy: an event for the turn within the limit: one turn/start, no interrupt, no fact; the watchdog does not touch a turn that spoke, however long it runs afterwards', async t => {
  const w = world(t), sent = await send(w), run = w.chat.runFor(sent)
  assert.equal(w.of('turn/start').length, 1); assert.equal(w.of('turn/interrupt').length, 0); assert.equal(run.engineStall, undefined); assert.equal(w.chat.engineStalls.size, 0)
  await new Promise(r => setTimeout(r, MS * 3)); assert.equal(w.of('turn/interrupt').length, 0, 'silence after the first event is not this watchdog\'s'); assert.equal(w.of('turn/start').length, 1)
  for (const plan of [['before'], ['tool']]) { const x = world(t, { plan }); await send(x); assert.equal(x.of('turn/start').length, 1, plan[0]); assert.equal(x.of('turn/interrupt').length, 0, plan[0]) }
})

test('silent once: the turn is interrupted, started ONCE more with the same parameters (a retry message id), the run is the second turn, the fact is on the run and the conversation', async t => {
  const w = world(t, { plan: ['silent', 'events'] }), started = Date.now(), sent = await send(w), run = w.chat.runFor(sent)
  assert.ok(Date.now() - started >= MS, 'it waited the limit'); assert.equal(w.of('turn/start').length, 2); assert.deepEqual(w.of('turn/interrupt').map(p => p.turnId), ['turn-1'])
  const [first, second] = w.of('turn/start'); assert.equal(second.clientUserMessageId, `${first.clientUserMessageId}:retry1`); assert.deepEqual({ ...second, clientUserMessageId: first.clientUserMessageId }, first, 'only the message id differs')
  assert.equal(sent.runId, 'turn-2'); assert.deepEqual(run.engineStall, { stalled: true, afterMs: MS, count: 1, retried: true, recovered: true, outcome: 'recovered' }); assert.deepEqual(w.chat.engineStalls.get('ui'), run.engineStall)
})

test('silent twice: no third attempt; the request ends with the closed code ENGINE_STALLED (504) and the conversation keeps the failed fact', async t => {
  const w = world(t, { plan: ['silent', 'silent', 'events'] })
  await assert.rejects(send(w), error => error.code === 'ENGINE_STALLED' && error.httpStatus === 504)
  assert.equal(w.of('turn/start').length, 2); assert.deepEqual(w.of('turn/interrupt').map(p => p.turnId), ['turn-1', 'turn-2']); assert.deepEqual(w.chat.engineStalls.get('ui'), { stalled: true, afterMs: MS, count: 2, retried: true, recovered: false, outcome: 'failed' })
})

test('what counts as the turn\'s first event: its own events only; a thread-level message and a late event of the interrupted turn do not', async t => {
  const a = world(t, { plan: ['threadLevel', 'events'] }); const sentA = await send(a)
  assert.equal(a.of('turn/start').length, 2, 'a thread-level message belongs to no turn: still silent'); assert.equal(sentA.runId, 'turn-2')
  const lateOld = world(t, { plan: ['oldTurnLate', 'silent'] })
  await assert.rejects(send(lateOld), { code: 'ENGINE_STALLED' }); assert.equal(lateOld.of('turn/start').length, 2, 'a late event of turn-1 does not rescue turn-2'); assert.equal(lateOld.chat.engineWaiters.size, 0, 'no waiter is left behind')
})

test('flag off or malformed: exactly engine.startTurn (no wait, no interrupt, no retry); an engine that never speaks is as before', async t => {
  for (const stall of [null, undefined, { firstEventMs: 0 }, { firstEventMs: 'x' }]) {
    const w = world(t, { stall, plan: ['silent'] }), started = Date.now(), sent = await send(w)
    assert.ok(Date.now() - started < MS * 3); assert.equal(w.of('turn/start').length, 1); assert.equal(w.of('turn/interrupt').length, 0); assert.equal(sent.runId, 'turn-1'); assert.equal(w.chat.engineStall, null)
  }
})

test('an interrupt that never answers does not hold the retry for longer than its own bound', async t => {
  const w = world(t, { plan: ['silent', 'events'], hangInterrupt: true })
  const started = Date.now(); const sent = await send(w), took = Date.now() - started
  assert.ok(took >= MS + ENGINE_STALL_LIMITS.interruptMs - 200 && took < MS + ENGINE_STALL_LIMITS.interruptMs + 1500, 'waited the interrupt\'s bound, no longer: ' + took); assert.equal(sent.runId, 'turn-2'); assert.equal(w.of('turn/interrupt').length, 1)
})
