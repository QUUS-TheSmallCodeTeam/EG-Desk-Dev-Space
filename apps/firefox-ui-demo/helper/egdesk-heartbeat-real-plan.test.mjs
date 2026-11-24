import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { FLOW_PREDICATES } from './egdesk-conversation-flow.mjs'
import { BEAT_PREDICATE_YES } from './egdesk-heartbeat-judge.mjs'
import { ANSWER, HEARTBEAT_NOT_SENT, HEARTBEAT_PATTERNS, HEARTBEAT_PLAN_TOKEN_CAP, HEARTBEAT_REMEASURE, NOTE, REQUEST, buildHeartbeatPlan, codeOnlyCases, planFile } from './egdesk-heartbeat-real-plan.mjs'

// The heartbeat's message judgment, third registration (heartbeat-c16, a re-measurement). Built by the product code; sends nothing.
//  - egdesk-heartbeat-real-plan.snapshot.json is the registered c16 plan: the product must still build exactly those bytes.
//  - egdesk-heartbeat-real-plan.c15.json is the c15 registration that was MEASURED (2026-11-24, 14/15). Every case not re-measured
//    must still have exactly the bytes measured then, so its result still describes the product.
const snapshot = JSON.parse(readFileSync(new URL('./egdesk-heartbeat-real-plan.snapshot.json', import.meta.url), 'utf8'))
const measured = Object.fromEntries(JSON.parse(readFileSync(new URL('./egdesk-heartbeat-real-plan.c15.json', import.meta.url), 'utf8')).requests.map(r => [r.id, r.sha256]))
const realFetch = globalThis.fetch
let network = 0
globalThis.fetch = async () => { network++; throw new Error('no network in a plan build') }
const plan = await buildHeartbeatPlan(), all = await buildHeartbeatPlan({ only: null }), code = await codeOnlyCases()
globalThis.fetch = realFetch
const body = id => JSON.parse(all.requests.find(r => r.id === id).body)
const text = id => body(id).input.slice(1).map(row => row.content).join('\n')
const asked = id => body(id).questions.map(q => q.name)

test('the plan is exactly the registered one, in the runner\'s format, at most 5,000 tokens, and building it sends nothing', () => {
  assert.equal(network, 0)
  assert.deepEqual(planFile(plan), snapshot, 'the product no longer builds the registered bytes: register again with --snapshot')
  assert.equal(snapshot.set, 'heartbeat-c16'); assert.deepEqual(snapshot.requests.map(r => r.id), [...HEARTBEAT_REMEASURE])
  for (const r of snapshot.requests) {
    assert.deepEqual(Object.keys(r), ['id', 'file', 'sha256', 'estInputTokens', 'expect'])
    for (const e of r.expect) { assert.ok(e.kind === 'predicate' && /^message__(note|ask|pointer|told_1)$/.test(e.name) && e.note.length > 0); assert.ok((e.min === undefined) !== (e.max === undefined)) }
  }
  const total = plan.requests.reduce((n, r) => n + r.estInputTokens, 0)
  assert.ok(total <= plan.tokenCeiling && plan.tokenCeiling <= HEARTBEAT_PLAN_TOKEN_CAP, `estimated ${total}, ceiling ${plan.tokenCeiling}`)
})

test('what is re-measured is exactly what changed: every other case still has the bytes measured in heartbeat-c15', () => {
  const same = [], changed = [], fresh = []
  for (const r of all.requests) (measured[r.id] === undefined ? fresh : measured[r.id] === r.sha256 ? same : changed).push(r.id)
  assert.deepEqual(same, ['need-quick-3s', 'need-thinking-12s', 'need-objective-40s', 'need-missing-10s', 'need-just-posted-8s'])
  assert.deepEqual(changed, ['need-silence-25s', 'need-reasoning-70s', 'pointer-owner-elsewhere', 'pointer-requester-present', 'pointer-already-told', 'pointer-new-run', 'pointer-held-3min'])
  assert.deepEqual(fresh, ['need-thinking-30s', 'need-command-45s', 'ask-plain-note-10s', 'ask-no-question-mark-10s', 'pointer-nothing-to-look-at'])
  // measured in c15 but no longer asked by the product: the 20 s ask (no-step floor), the 40 s command ask (moved to 45 s), and the
  // two pointer cases code now decides (below)
  assert.deepEqual(Object.keys(measured).filter(id => !all.requests.some(r => r.id === id)), ['need-thinking-20s', 'need-command-40s', 'pointer-nobody-waiting'])
  for (const id of [...changed, ...fresh]) assert.ok(HEARTBEAT_REMEASURE.includes(id) || Object.hasOwn(HEARTBEAT_NOT_SENT, id), `${id} changed: sent, or a reason why not`)
})

test('what code decides costs no request: nobody at the desk (c15 measured 1.0 there) and something already in view', () => {
  assert.deepEqual(code, [{ id: 'pointer-nobody-waiting', requests: 0, held: 1, posted: 1 }, { id: 'pointer-in-view', requests: 0, held: 0, posted: 1 }])
})

test('every body is the product\'s wire body: yes/no questions only, each pointer item quoted on its own, nothing of audience or geometry in a pointer request', () => {
  for (const r of all.requests) {
    assert.equal(createHash('sha256').update(r.body).digest('hex'), r.sha256)
    const b = JSON.parse(r.body)
    assert.deepEqual([b.model, b.prompt_cache_key], [DECISION_MODEL, 'heartbeat-beat'])
    for (const q of b.questions) { assert.equal(q.type, 'predicate'); const name = q.name.replace('message__', '').replace(/_\d$/, ''); assert.equal(q.instructions, FLOW_PREDICATES[name].instructions) }
    assert.ok(!b.questions.some(q => q.name === 'message__stalled'), 'the stall is code')
    for (const e of r.expect) assert.ok(b.questions.some(q => q.name === e.name), `${r.id}: ${e.name}`)
    assert.doesNotMatch(r.body, /m-jin|egd-synthetic|\/work|https?:/)
  }
  for (const id of all.requests.map(r => r.id).filter(id => id.startsWith('pointer-'))) {
    assert.doesNotMatch(text(id), /What the message questions are about|on the desk|at the desk|owner|left|right of|nobody/i, `${id}: pointer questions read only their quoted item`)
  }
  const quote = (label, value) => `${label}:\n"""\n${value}\n"""`
  assert.deepEqual(asked('pointer-owner-elsewhere'), ['message__pointer']); assert.ok(text('pointer-owner-elsewhere').includes(quote('The message about the finished work', ANSWER.report)))
  assert.deepEqual(asked('pointer-requester-present'), ['message__pointer', 'message__told_1']); assert.ok(text('pointer-requester-present').includes(quote('A message already posted to this person', ANSWER.survey)))
  assert.ok(text('pointer-already-told').includes(quote('A message already posted to this person', ANSWER.surveyTold)))
  assert.ok(text('pointer-nothing-to-look-at').includes(quote('The message about the finished work', ANSWER.tests)))
  assert.ok(text('ask-no-question-mark-10s').includes(quote('The assistant\'s latest note to itself', NOTE.needs))); assert.ok(!NOTE.needs.includes('?') && !NOTE.plain.includes('?'))
  assert.ok(text('ask-plain-note-10s').includes(quote('The assistant\'s latest note to itself', NOTE.plain)))
  assert.ok(text('need-thinking-30s').includes('- 30 seconds have passed since the person wrote.')); assert.ok(text('need-thinking-30s').includes(REQUEST.plan))
  assert.ok(text('need-command-45s').includes('running for about 23 seconds; its output shows it is still running'))
  assert.deepEqual(asked('need-silence-25s'), ['message__note']); assert.deepEqual(asked('need-reasoning-70s'), ['message__note'])
})

test('what is registered: hard where the shipped design depends on the answer; the "?" pre-filter study is soft', () => {
  const hard = HEARTBEAT_PATTERNS.filter(p => HEARTBEAT_REMEASURE.includes(p.id)).flatMap(p => p.expect.filter(e => e.severity === 'hard').map(e => `${p.id}:${e.name}:${e.min !== undefined ? 'yes' : 'no'}`))
  assert.deepEqual(hard, ['need-thinking-30s:message__note:yes', 'need-command-45s:message__note:yes', 'need-silence-25s:message__note:yes', 'pointer-owner-elsewhere:message__pointer:yes',
    'pointer-requester-present:message__pointer:yes', 'pointer-requester-present:message__told_1:no', 'pointer-already-told:message__told_1:yes'])
  for (const id of ['ask-plain-note-10s', 'ask-no-question-mark-10s', 'pointer-nothing-to-look-at']) assert.ok(HEARTBEAT_PATTERNS.find(p => p.id === id).expect.every(e => e.severity === 'soft'))
  for (const p of HEARTBEAT_PATTERNS) for (const e of p.expect) { if (e.min !== undefined) assert.equal(e.min, BEAT_PREDICATE_YES); if (e.max !== undefined) assert.equal(e.max, 0.5) }
  for (const p of HEARTBEAT_PATTERNS) assert.ok(p.ifMissed.length > 20 && p.pattern.length > 20 && p.before.length > 2)
})
