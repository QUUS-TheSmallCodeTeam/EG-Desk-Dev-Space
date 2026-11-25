// u4: the decision-call log. A mock engine and a mock decision client: nothing is sent. Small temporary folders only, removed when each test ends.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createChatHttpHandler } from './codex-bridge-http.mjs'
import { DECISION_CALL_KINDS, DECISION_CALL_OUTCOMES, callKindOf, callOutcomeOf, createDecisionCallLog, decisionCallLogFromEnv, recordDecisionCalls } from './egdesk-decision-call-log.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const q = (...names) => names.map(name => ({ type: 'predicate', name, instructions: 'x' }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('call kinds come from the prompt cache key and the NAMES of the questions: every feature that asks the decision model gets a closed word, unknown ones are "other"', () => {
  const table = [
    [{ questions: q('answer_type', 'time_intent', 'rel_0', 'rel_1') }, 'context'], [{ promptCacheKey: 'decision-first-commands', questions: q('df_pick') }, 'pick'], [{ questions: q('df_pick') }, 'pick'],
    [{ questions: q('reply_runs_command', 'reply_declines_command') }, 'approval_reply'], [{ questions: q('oi_ref_1') }, 'open_items'], [{ questions: q('nk_kind', 'nk_about') }, 'nunchi'],
    [{ promptCacheKey: 'draft-check', questions: q('sup_0', 'tense_0') }, 'check'], [{ questions: q('claim_0') }, 'check'], [{ questions: q('risk_outside', 'risk_unrestorable') }, 'command_gate'],
    [{ questions: q('output_reports_problem') }, 'run_conditions'], [{ questions: q('terminal_state') }, 'terminal_state'], [{ questions: q('tn_action', 'tw_about_1') }, 'memory'], [{ questions: q('wm_need_1') }, 'working_memory'],
    [{ questions: q('rc_confirms_1') }, 'record'], [{ questions: q('same_matter_1') }, 'placement'], [{ questions: q('same_1') }, 'browser'], [{ questions: q('goal_met') }, 'browser'], [{ questions: q('goes_to_1') }, 'hud_routing'],
    [{ promptCacheKey: 'heartbeat-beat', questions: q('whatever') }, 'heartbeat'], [{ promptCacheKey: 'work-placement', questions: q('x') }, 'placement'], [{ questions: q('warmup') }, 'warmup'], [{ questions: q('brand_new_question') }, 'other'], [{}, 'other'], [null, 'other'],
  ]
  for (const [request, kind] of table) { assert.equal(callKindOf(request), kind, JSON.stringify(request)); assert.ok(DECISION_CALL_KINDS.includes(kind)) }
  const outcomes = [[{ code: 'decision_mode_off' }, 'refused'], [{ code: 'request_timeout' }, 'timeout'], [{ code: 'budget_exceeded' }, 'budget'], [{ code: 'bad_response' }, 'bad_response'], [{ code: 'unreachable' }, 'unreachable'], [{ name: 'AbortError' }, 'aborted'], [new Error('x'), 'error'], [null, 'error']]
  for (const [error, outcome] of outcomes) { assert.equal(callOutcomeOf(error), outcome); assert.ok(DECISION_CALL_OUTCOMES.includes(outcome)) }
})

test('the log keeps closed rows relative to the turn start, bounded; a call outside a turn scope is not noted; the wrapped client is the client with decide() noted; off is the client itself', async () => {
  let clock = 1000; const log = createDecisionCallLog({ now: () => clock, limits: { turns: 3, callsPerTurn: 2 } })
  const stub = { model: 'm', verifyKey: () => 'verified', async decide(request) { clock += 40; if (request.fail) throw Object.assign(new Error('x'), { code: 'request_timeout' }); return { answers: [], usage: { inputTokens: 1234.4, cachedTokens: 128, outputTokens: 5 } } } }
  const client = recordDecisionCalls(stub, log); assert.equal(client.model, 'm'); assert.equal(client.verifyKey(), 'verified'); assert.equal(client.callLog, log); assert.equal(recordDecisionCalls(stub, null), stub, 'off: the client itself')
  await client.decide({ questions: q('answer_type') }); assert.deepEqual(log.recent(), [], 'outside a scope nothing is noted')
  log.beginTurn('req-1'); await log.scope('req-1', async () => { await client.decide({ questions: q('answer_type') }); await client.decide({ questions: q('df_pick') }); await client.decide({ questions: q('oi_ref_1') }).catch(() => {}) })
  const calls = log.callsFor('req-1'); assert.equal(calls.length, 2, 'bounded per turn'); assert.deepEqual(calls.map(c => [c.kind, c.startMs, c.endMs, c.inputTokens, c.cachedTokens, c.outcome]), [['context', 0, 40, 1234, 128, 'ok'], ['pick', 40, 80, 1234, 128, 'ok']])
  await log.scope('req-2', () => client.decide({ questions: q('nk_kind'), fail: true }).catch(() => {})); assert.deepEqual(log.callsFor('req-2').map(c => [c.kind, c.outcome, c.inputTokens, c.cachedTokens]), [['nunchi', 'timeout', null, null]])
  for (const key of ['a', 'b', 'c']) log.beginTurn(key); assert.deepEqual(log.recent(10).map(t => t.requestId), ['req-2', 'a', 'b', 'c'].slice(-3), 'bounded turns')
  for (const call of calls) assert.deepEqual(Object.keys(call).sort(), ['cachedTokens', 'endMs', 'inputTokens', 'kind', 'outcome', 'startMs'], 'closed fields only')
  assert.equal(decisionCallLogFromEnv({}), null); assert.equal(decisionCallLogFromEnv({ EGDESK_DECISION_CALL_LOG: 'yes' }), null); assert.ok(decisionCallLogFromEnv({ EGDESK_DECISION_CALL_LOG: 'on' }))
})

// ---- through the runtime: a mock Codex engine, a mock decision client, a real chat store ----
const PLAN = { id: 'doc:pg', kind: 'document', title: 'PostgreSQL 이전 계획', summary: '현재 운영 중', timeSlice: 'present', loadText: () => 'body' }
const ANSWER = 'PostgreSQL 마이그레이션은 현재 운영 중입니다.', PERSON = 'PostgreSQL 마이그레이션 상태는?'
function world(t, { on = true } = {}) {
  const dir = createPrivateQaTempDirectory('egdesk-call-log-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = openChatStore({ dataDir: dir, ownerScope: 'call-log' }); t.after(() => store.close())
  const log = on ? createDecisionCallLog() : null, events = []
  const stub = { model: 'mock', async decide(request) {
    await sleep(8)
    const answers = {}
    for (const x of request.questions) {
      if (x.name === 'answer_type' || x.name === 'time_intent') answers[x.name] = { type: 'choice', choice: x.choices[0].value, confidence: 0.9, probabilities: [{ value: x.choices[0].value, probability: 0.9 }] }
      else if (/^claim_/.test(x.name)) answers[x.name] = { type: 'choice', choice: 'supported', confidence: 0.95, probabilities: [{ value: 'supported', probability: 0.96 }, { value: 'insufficient', probability: 0.02 }] }
      else if (/^(present_|sup_)/.test(x.name)) answers[x.name] = { type: 'predicate', probability: 0.93 }
      else answers[x.name] = { type: 'predicate', probability: x.name === 'rel_0' ? 0.95 : 0.04 }
    }
    return { answers, model: 'mock', usage: { inputTokens: 20000, cachedTokens: 3000 }, latencyMs: 8 } } }
  let chat = null, turns = 0, threads = 0
  chat = new CodexChatRuntime({ store, requireStore: true, getOwnerKey: () => 'codex:call-log', verifyFile: async () => null, emit: e => events.push(e), emitLegacy() {}, respond() {},
    request: async (method, params) => {
      if (method === 'thread/start') return { thread: { id: `thread-${++threads}` }, cwd: '/work', model: 'm' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'turn/start') {
        const id = `turn-${++turns}`, timing = { threadId: params.threadId, turnId: id }
        setTimeout(async () => { const n = (m, p) => chat.handleNotification({ method: m, params: p })
          await n('item/started', { ...timing, item: { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: '' } }); await n('item/agentMessage/delta', { ...timing, itemId: 'a1', delta: ANSWER })
          await n('item/completed', { ...timing, item: { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: ANSWER } }); await n('turn/completed', { threadId: params.threadId, turn: { id, status: 'completed', items: [] } }) }, 20)
        return { turn: { id, status: 'inProgress', items: [] } }
      }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected ${method}`)
    },
    decisionContext: { mode: () => 'on', configured: () => true, client: on ? recordDecisionCalls(stub, log) : stub, budgetMs: 800, collect: async () => [PLAN], calibrationLog: openCalibrationLog({ dataDir: dir, log() {} }), draftCheck: { mode: () => 'advisory', eligible: () => true } } })
  chat.setConnection(true)
  return { chat, store, log, events, dir }
}

test('through the runtime: the turn\'s calls are noted with the turn\'s own times (the context call before the engine, the check after the answer), carried in the decision-context row\'s detail, persisted with the run, and read by the internal route; none of the person\'s words is in them', async t => {
  const w = world(t), sent = await w.chat.send({ message: PERSON, clientThreadId: 'dm-1', requestId: 'req-1' })
  for (let i = 0; i < 400 && !(w.log.callsFor('req-1').some(c => c.kind === 'check') && w.events.some(e => e.event === 'run.completed')); i++) await sleep(10)
  await sleep(60); await w.chat.queue
  const calls = w.log.callsFor('req-1'); assert.deepEqual(calls.map(c => c.kind), ['context', 'check']); assert.deepEqual(calls.map(c => [c.inputTokens, c.cachedTokens, c.outcome]), [[20000, 3000, 'ok'], [20000, 3000, 'ok']])
  assert.ok(calls[0].startMs >= 0 && calls[0].endMs - calls[0].startMs >= 6, 'the call took its own time'); assert.ok(calls[1].startMs >= calls[0].endMs, 'the check came after the context call (it follows the answer)')
  const run = [...w.chat.runs.values()].find(r => r.requestId === 'req-1'), row = run.activities.find(a => a.kind === 'decisionContext'); assert.ok(row, 'the decision-context row'); assert.deepEqual(row.detail.calls.map(c => c.kind), ['context', 'check'])
  const stored = w.store.listEvents('dm-1', { limit: 200 }).events ?? w.store.listEvents('dm-1', { limit: 200 }); const withCalls = (Array.isArray(stored) ? stored : []).filter(e => JSON.stringify(e).includes('"calls"'))
  assert.ok(withCalls.length >= 1, 'the calls are in the stored events of the run'); const found = []; const walk = o => { if (o && typeof o === 'object') { if (Array.isArray(o.calls)) found.push(o.calls); Object.values(o).forEach(walk) } }; for (const e of withCalls) { walk(e); for (const v of Object.values(e)) if (typeof v === 'string' && v.startsWith('{')) { try { walk(JSON.parse(v)) } catch { /* not json */ } } }
  assert.ok(found.length >= 1 && found.every(list => list.every(c => Object.keys(c).sort().join() === 'cachedTokens,endMs,inputTokens,kind,outcome,startMs')), 'stored calls are closed rows'); const text = JSON.stringify(found); assert.ok(!text.includes(PERSON) && !text.includes('answer_type') && !text.includes('PostgreSQL'), 'no person text, no question name, no candidate text in the calls')
  const turn = w.chat.decisionCallTurns(5).turns.at(-1); assert.deepEqual([turn.requestId, turn.runId, turn.calls.map(c => c.kind)], ['req-1', run.runId, ['context', 'check']]); assert.equal(typeof turn.startedAt, 'number')
  assert.equal(sent.accepted, true)
})

test('flag off: nothing is noted, send() is the unchanged send, the run rows carry no calls and the route is not there', async t => {
  const w = world(t, { on: false }); assert.equal(w.chat.callLog(), null)
  await w.chat.send({ message: PERSON, clientThreadId: 'dm-1', requestId: 'req-1' }); for (let i = 0; i < 200 && !w.events.some(e => e.event === 'run.completed'); i++) await sleep(10)
  const run = [...w.chat.runs.values()].find(r => r.requestId === 'req-1'); assert.equal(run.activities.find(a => a.kind === 'decisionContext')?.detail?.calls, undefined); assert.deepEqual(w.chat.decisionCallTurns(), { turns: [] })
  const req = Readable.from([]); Object.assign(req, { method: 'GET', headers: { host: '127.0.0.1:39218' }, socket: { remoteAddress: '127.0.0.1' } }); const res = { writeHead() {}, end() { this.done = true } }
  assert.equal(await createChatHttpHandler(w.chat, async () => {})(req, res, new URL('http://localhost/chat/decision-calls')), false, 'the route falls through: not handled')
})

test('the internal route: the most recent turns, limit 1-64, a bad limit is refused', async t => {
  const w = world(t); await w.chat.send({ message: PERSON, clientThreadId: 'dm-1', requestId: 'req-1' }); for (let i = 0; i < 300 && !w.log.callsFor('req-1').length; i++) await sleep(10)
  const call = async search => { const req = Readable.from([]); Object.assign(req, { method: 'GET', headers: { host: '127.0.0.1:39218' }, socket: { remoteAddress: '127.0.0.1' } }); const res = { status: 0, writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
    const handled = await createChatHttpHandler(w.chat, async () => {})(req, res, new URL(`http://localhost/chat/decision-calls${search}`)); return { handled, res } }
  const ok = await call(''); assert.deepEqual([ok.handled, ok.res.status], [true, 200]); assert.equal(ok.res.body.turns.at(-1).requestId, 'req-1'); assert.ok(ok.res.body.turns.at(-1).calls.length >= 1)
  for (const bad of ['?limit=0', '?limit=65', '?limit=x', '?limit=-1']) { const r = await call(bad); assert.deepEqual([r.handled, r.res.status, r.res.body.code], [true, 400, 'INVALID_DECISION_CALLS_QUERY'], bad) }
  assert.equal((await call('?limit=64')).res.status, 200)
})

// ---- the stage table ----
import { formatCallTable, summarizeCalls, turnsFromChatDb, turnsFromRouteJson, wallMs } from './egdesk-decision-call-table.mjs'
import { main as tableMain } from '../scripts/egdesk-decision-call-table.mjs'
import { DatabaseSync } from 'node:sqlite'

test('the table: wall time counts overlaps once, per-kind sums, the closed rows only', () => {
  assert.equal(wallMs([]), 0); assert.equal(wallMs([{ startMs: 0, endMs: 100 }, { startMs: 50, endMs: 120 }, { startMs: 300, endMs: 350 }]), 170)
  const calls = [{ kind: 'context', startMs: 0, endMs: 600, inputTokens: 20000, cachedTokens: 3000, outcome: 'ok' }, { kind: 'pick', startMs: 650, endMs: 1000, inputTokens: 900, cachedTokens: 0, outcome: 'ok' }, { kind: 'pick', startMs: 700, endMs: 900, inputTokens: null, cachedTokens: null, outcome: 'timeout' }]
  const sm = summarizeCalls(calls); assert.deepEqual([sm.count, sm.wallMs, sm.inputTokens, sm.cachedTokens, sm.kinds.pick.count, sm.kinds.context.ms], [3, 950, 20900, 3000, 2, 600])
  assert.deepEqual(turnsFromRouteJson({ turns: [{ requestId: 'r', startedAt: 5, calls }, { nonsense: true }]}).map(t => [t.requestId, t.calls.length, t.stages]), [['r', 3, null], ['', 0, null]])
})

test('the table from a real store: the stage times come from the run\'s events, the calls from the decision-context row; the script prints the table and the JSON, the store is opened read-only', async t => {
  const w = world(t), sent = await w.chat.send({ message: PERSON, clientThreadId: 'dm-1', requestId: 'req-1' })
  for (let i = 0; i < 400 && !(w.log.callsFor('req-1').some(c => c.kind === 'check') && w.events.some(e => e.event === 'run.completed')); i++) await sleep(10)
  await sleep(80); await w.chat.queue; assert.equal(sent.accepted, true)
  const dir = createPrivateQaTempDirectory('egdesk-call-table-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = fs.readdirSync(w.dir).filter(f => f.endsWith('.sqlite') || f.endsWith('.sqlite-wal') || f.endsWith('.sqlite-shm')); for (const f of source) fs.copyFileSync(path.join(w.dir, f), path.join(dir, f))
  const file = path.join(dir, source.find(f => f.endsWith('.sqlite'))), db = new DatabaseSync(file, { readOnly: true })
  const turns = turnsFromChatDb(db); db.close(); assert.equal(turns.length, 1); const [turn] = turns
  assert.deepEqual(turn.calls.map(c => c.kind), ['context', 'check']); assert.ok(turn.stages.postedMs > 0 && turn.stages.contextMs >= 6 && turn.stages.dispatchMs >= 0 && turn.stages.engineMs >= 0, JSON.stringify(turn.stages))
  assert.ok(Math.abs(turn.stages.contextMs - turn.calls[0].endMs) < 60, 'the dispatch waited for the context call: the call ends where the context stage ends (within the event clock\'s jitter)')
  const lines = formatCallTable(turns); assert.match(lines.join('\n'), /decision calls 2/); assert.match(lines.at(-1), /input tokens 40000, cached 6000 \(15%\)/); assert.ok(!lines.join('\n').includes(PERSON))
  const printed = []; assert.equal(tableMain(['db', file], { print: line => printed.push(line) }), 0); assert.match(printed.join('\n'), /context \d+-\d+ 20000\/3000 ok/)
  const asJson = []; assert.equal(tableMain(['db', file, '--json'], { print: line => asJson.push(line) }), 0); const parsed = JSON.parse(asJson.join('\n')); assert.equal(parsed.turns[0].summary.count, 2)
  assert.equal(tableMain(['db', file, '--since', '2999-01-01T00:00:00Z'], { print() {} }), 1, 'no rows is exit 1'); assert.equal(tableMain(['db'], { printError() {} }), 2); assert.equal(tableMain(['db', file, '--since', 'x'], { printError() {} }), 2)
  const routeFile = path.join(dir, 'route.json'); fs.writeFileSync(routeFile, JSON.stringify({ turns: w.chat.decisionCallTurns(5).turns })); assert.equal(tableMain(['route', routeFile], { print() {} }), 0)
})
