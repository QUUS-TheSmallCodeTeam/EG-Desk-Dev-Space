import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { FLOW_PREDICATES } from './egdesk-conversation-flow.mjs'
import { ANSWER, HEARTBEAT_NOT_SENT, HEARTBEAT_PATTERNS, HEARTBEAT_PLAN_TOKEN_CAP, HEARTBEAT_REMEASURE, NOTE, WAIT, buildHeartbeatPlan, codeOnlyCases, planFile } from './egdesk-heartbeat-real-plan.mjs'

// The heartbeat's judgments, fifth registration (heartbeat-c18). Built by the product code; sends nothing.
//  - egdesk-heartbeat-real-plan.snapshot.json: the registered c18 heartbeat part; the product must still build exactly those bytes.
//  - egdesk-heartbeat-real-plan.c15.json, .c16.json and .c17.json: the registrations that were MEASURED (2026-11-24). Every case not re-measured
//    must still have the bytes of its latest measurement, so that result still describes the product.
const snapshot = JSON.parse(readFileSync(new URL('./egdesk-heartbeat-real-plan.snapshot.json', import.meta.url), 'utf8'))
const measured = {}
for (const file of ['c15', 'c16', 'c17']) for (const r of JSON.parse(readFileSync(new URL(`./egdesk-heartbeat-real-plan.${file}.json`, import.meta.url), 'utf8')).requests) measured[r.id] = r.sha256
const realFetch = globalThis.fetch
let network = 0
globalThis.fetch = async () => { network++; throw new Error('no network in a plan build') }
const plan = await buildHeartbeatPlan(), all = await buildHeartbeatPlan({ only: null }), code = await codeOnlyCases()
globalThis.fetch = realFetch
const body = id => JSON.parse(all.requests.find(r => r.id === id).body)
const text = id => body(id).input.slice(1).map(row => row.content).join('\n')
const asked = id => body(id).questions.map(q => q.name)

test('the plan is exactly the registered one, in the runner\'s format, under the token cap, and building it sends nothing', () => {
  assert.equal(network, 0)
  assert.deepEqual(planFile(plan), snapshot, 'the product no longer builds the registered bytes: register again with --snapshot')
  assert.equal(snapshot.set, 'heartbeat-c18'); assert.deepEqual(snapshot.requests.map(r => r.id), [...HEARTBEAT_REMEASURE])
  for (const r of snapshot.requests) for (const e of r.expect) assert.ok(['hard', 'soft'].includes(e.severity) && e.note.length > 0)
  const total = plan.requests.reduce((n, r) => n + r.estInputTokens, 0)
  assert.ok(total <= plan.tokenCeiling && plan.tokenCeiling <= HEARTBEAT_PLAN_TOKEN_CAP, `estimated ${total}, ceiling ${plan.tokenCeiling}`)
})

test('what is re-measured is what changed: every other case still has the bytes of its latest measurement', () => {
  const same = [], changed = [], fresh = []
  for (const r of all.requests) (measured[r.id] === undefined ? fresh : measured[r.id] === r.sha256 ? same : changed).push(r.id)
  assert.deepEqual(same, ['need-quick-3s', 'need-thinking-12s', 'need-thinking-30s', 'need-command-45s', 'need-objective-40s', 'need-missing-10s', 'need-just-posted-8s', 'ask-plain-note-10s', 'ask-no-question-mark-10s',
    'pointer-owner-elsewhere', 'pointer-requester-present', 'pointer-owner-decision'])
  assert.deepEqual(changed, ['need-silence-25s', 'need-reasoning-70s', 'pointer-already-told', 'pointer-nothing-to-look-at', 'pointer-new-run', 'pointer-held-3min', 'wait-check-choice', 'wait-check-predicates', 'wait-check-invented-result'])
  assert.deepEqual(fresh, ['ride-along-needs-10s'])
  for (const id of [...changed, ...fresh]) assert.ok(HEARTBEAT_REMEASURE.includes(id) || Object.hasOwn(HEARTBEAT_NOT_SENT, id), `${id} changed: sent, or a reason why not`)
})

test('what code decides costs no request: nobody at the desk, something already in view', () => {
  assert.deepEqual(code, [{ id: 'pointer-nobody-waiting', requests: 0, held: 1, posted: 1 }, { id: 'pointer-in-view', requests: 0, held: 0, posted: 1 }])
})

test('pointer bodies: a requested result is never asked about (only told_N); a background result is asked the act-or-decide question on its quoted announcement', () => {
  for (const id of ['pointer-requester-present', 'pointer-already-told', 'pointer-nothing-to-look-at', 'pointer-new-run']) assert.deepEqual(asked(id), ['message__told_1'], id)
  for (const id of ['pointer-owner-elsewhere', 'pointer-owner-decision', 'pointer-held-3min']) assert.deepEqual(asked(id), ['message__pointer'], id)
  assert.equal(body('pointer-owner-decision').questions[0].instructions, FLOW_PREDICATES.pointer.instructions)
  assert.match(FLOW_PREDICATES.pointer.instructions, /did not ask for\. Does it contain something they must act on or decide\?$/)
  assert.ok(text('pointer-owner-decision').includes(`"""\n${ANSWER.quote}\n"""`))
  for (const id of all.requests.map(r => r.id).filter(id => id.startsWith('pointer-'))) assert.doesNotMatch(text(id), /What the message questions are about|on the desk|at the desk|left|right of|nobody/i, id)
})

test('wait-message checks: the facts the message was composed from are the evidence (present), only the concrete sentence is sent, both designs', () => {
  for (const id of ['wait-check-choice', 'wait-check-predicates', 'wait-check-invented-result']) {
    const b = body(id), all = b.input.map(row => row.content).join('\n')
    assert.equal(b.prompt_cache_key, 'draft-check'); assert.equal(b.model, DECISION_MODEL)
    assert.match(all, /The person asked: 결제 모듈 테스트를 돌리고 실패한 항목이 있으면 정리해 주세요\./)
    assert.match(all, /10 seconds have passed since the person wrote\. The assistant is running a command: `npm test -- --suite=payments` \(running for about 10 seconds; its output shows it is still running\)/)
    assert.doesNotMatch(all, /끝나는 대로 결과를 알려 드릴게요|나머지를 확인하고 있어요/, 'the sentence without a concrete detail is not sent')
    assert.doesNotMatch(all, /ok\\n|content not available|PostgreSQL/, 'no command output, no turn material')
  }
  assert.deepEqual(asked('wait-check-choice'), ['claim_0', 'present_0']); assert.deepEqual(asked('wait-check-predicates'), ['sup_0', 'tense_0'])
  assert.ok(text('wait-check-predicates').includes(`Sentence S1:\n"""\n${WAIT.concrete.split('. ')[0]}.\n"""`))
  assert.ok(text('wait-check-invented-result').includes('결제 모듈 테스트 128개 중 3개가 실패했어요.'))
})

test('ride-along bodies: the note question plus one early-question judgment per note without "?", quoted on its own', () => {
  assert.deepEqual(asked('need-silence-25s'), ['message__note', 'message__ask_1']); assert.deepEqual(asked('ride-along-needs-10s'), ['message__note', 'message__ask_1'])
  assert.ok(text('need-silence-25s').includes('Question message__ask_1:\nA note the assistant wrote to itself:\n"""\n풀 리퀘스트의 변경 파일을 확인하는 중이다.\n"""'))
  assert.ok(text('ride-along-needs-10s').includes(`Question message__ask_1:\nA note the assistant wrote to itself:\n"""\n${NOTE.needs}\n"""`))
  assert.equal(body('ride-along-needs-10s').questions[1].instructions, FLOW_PREDICATES.ask.instructions)
})

test('what is registered: hard where the shipped design depends on the answer', () => {
  const hard = HEARTBEAT_PATTERNS.filter(p => HEARTBEAT_REMEASURE.includes(p.id)).flatMap(p => p.expect.filter(e => e.severity === 'hard').map(e => `${p.id}:${e.name}:${e.min !== undefined ? 'yes' : 'no'}`))
  assert.deepEqual(hard, ['need-silence-25s:message__note:yes', 'need-silence-25s:message__ask_1:no', 'ride-along-needs-10s:message__ask_1:yes'])
  for (const p of HEARTBEAT_PATTERNS) for (const e of p.expect) { if (e.min !== undefined) assert.equal(e.min, 0.8); if (e.max !== undefined) assert.equal(e.max, 0.5) }
  for (const p of HEARTBEAT_PATTERNS) assert.ok(p.ifMissed.length > 20 && p.pattern.length > 20 && p.before.length > 2, p.id)
})
