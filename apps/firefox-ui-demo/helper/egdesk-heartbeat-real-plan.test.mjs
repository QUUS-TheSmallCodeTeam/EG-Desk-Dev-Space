import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { FLOW_PREDICATES } from './egdesk-conversation-flow.mjs'
import { BEAT_PREDICATE_YES } from './egdesk-heartbeat-judge.mjs'
import { ANSWER, HEARTBEAT_PATTERNS, REQUEST, buildHeartbeatPlan, planFile } from './egdesk-heartbeat-real-plan.mjs'

// The real-measurement plan for the heartbeat's message judgment (second registration, after the first one measured "none" 15/15)
// is built by the product code and sends nothing. These tests keep the registered plan (egdesk-heartbeat-real-plan.snapshot.json)
// equal to what the product builds today: a change of wording, questions or material changes the bytes, and then the plan has to be
// registered again (node scripts/egdesk-heartbeat-real-plan.mjs --snapshot) and a result measured on the old bytes no longer
// describes the product.
const snapshot = JSON.parse(readFileSync(new URL('./egdesk-heartbeat-real-plan.snapshot.json', import.meta.url), 'utf8'))
const realFetch = globalThis.fetch
let network = 0
globalThis.fetch = async () => { network++; throw new Error('no network in a plan build') }
const plan = await buildHeartbeatPlan()
globalThis.fetch = realFetch
const body = id => JSON.parse(plan.requests.find(r => r.id === id).body)
const text = id => body(id).input.slice(1).map(row => row.content).join('\n')
const asked = id => body(id).questions.map(q => q.name)

test('the plan is exactly the registered one, in the runner\'s format, under the token bound, and building it sends nothing', () => {
  assert.equal(network, 0)
  assert.deepEqual(planFile(plan), snapshot, 'the product no longer builds the registered bytes: register again with --snapshot and re-measure')
  assert.deepEqual(Object.keys(snapshot), ['set', 'tokenCeiling', 'passRule', 'requests']); assert.equal(snapshot.set, 'heartbeat-c15')
  for (const r of snapshot.requests) {
    assert.deepEqual(Object.keys(r), ['id', 'file', 'sha256', 'estInputTokens', 'expect']); assert.equal(r.file, `requests/${r.id}.json`); assert.match(r.sha256, /^[a-f0-9]{64}$/)
    for (const e of r.expect) {
      assert.ok(['hard', 'soft'].includes(e.severity) && e.kind === 'predicate' && /^message__(note|ask|stalled|pointer)$/.test(e.name) && typeof e.note === 'string' && e.note.length > 0)
      assert.ok((e.min === undefined) !== (e.max === undefined), 'a yes (min) or a no (max)')
    }
  }
  const total = plan.requests.reduce((n, r) => n + r.estInputTokens, 0)
  assert.equal(plan.requests.length, 15); assert.ok(total <= plan.tokenCeiling && plan.tokenCeiling < 12_000, `estimated ${total}, ceiling ${plan.tokenCeiling}`)
  assert.deepEqual([plan.requests.filter(r => r.id.startsWith('need-')).length, plan.requests.filter(r => r.id.startsWith('pointer-')).length], [9, 6])
})

test('every body is the product\'s wire body: the neutral rule, the session lines, the material in sentences with the person\'s own words quoted, and yes/no questions only', () => {
  for (const r of plan.requests) {
    assert.equal(createHash('sha256').update(r.body).digest('hex'), r.sha256)
    const b = JSON.parse(r.body)
    assert.deepEqual(Object.keys(b), ['model', 'input', 'questions', 'prompt_cache_key']); assert.deepEqual([b.model, b.prompt_cache_key], [DECISION_MODEL, 'heartbeat-beat'])
    assert.equal(b.input[0].role, 'developer'); assert.doesNotMatch(b.input[0].content, /do-nothing|prefer/i)
    assert.match(b.input[1].content, /^Session:\nseconds_since_the_person_wrote: \d+\n/)
    assert.match(b.input[2].content, /^What the message questions are about:\nThe person's request:\n"""\n[^\n]+\n"""\n/, r.id)
    assert.ok(Object.values(REQUEST).some(request => b.input[2].content.includes(request)), `${r.id}: the scripted request is quoted`)
    // yes/no questions with the product's fixed instructions; no choice, no "none" option anywhere.
    for (const q of b.questions) { assert.deepEqual(Object.keys(q), ['type', 'name', 'instructions']); assert.equal(q.type, 'predicate'); assert.equal(q.instructions, FLOW_PREDICATES[q.name.replace('message__', '')].instructions) }
    for (const e of r.expect) assert.ok(b.questions.some(q => q.name === e.name), `${r.id}: ${e.name} is expected but not asked`)
    // public synthetic content only: no member id, no key, no path, no page address
    assert.doesNotMatch(r.body, /m-jin|egd-synthetic|\/work|https?:/)
  }
})

test('each pattern carries what it is named for, in the words the judge reads', () => {
  const has = (id, ...needles) => { for (const needle of needles) assert.ok(text(id).includes(needle), `${id} lacks "${needle}"\n${text(id)}`) }
  has('need-quick-3s', '- 3 seconds have passed since the person wrote.', 'The assistant is thinking (a reasoning step is open)'); assert.deepEqual(asked('need-quick-3s'), ['message__note'])
  has('need-thinking-12s', '- 12 seconds have passed', 'The last sign of activity from the work was 1 second ago.')
  has('need-thinking-20s', '- 20 seconds have passed', 'The assistant is thinking (a reasoning step is open)', 'Nothing has been said to the person since they wrote.')
  has('need-command-40s', '- 40 seconds have passed', 'The assistant is running a command: `npm test -- --suite=payments` (running for about 18 seconds; its output shows it is still running).'); assert.deepEqual(asked('need-command-40s'), ['message__note'])
  has('need-objective-40s', 'a task in the browser is still going', 'Tool steps finished so far: 3.', 'The task may take up to 21 more steps (an upper limit, not a plan).', 'The task\'s last step finished 3 seconds ago.')
  assert.ok(!text('need-objective-40s').includes('The last sign of activity'), 'the engine\'s own silence is not reported while a step-by-step task runs')
  has('need-missing-10s', 'Question message__ask:\nThe assistant\'s latest note to itself:\n"""\n배포 대상이 운영인지 스테이징인지 요청에 없다. 어느 환경에 배포해야 하나?\n"""', '(the last one: a command: `git status --short`)')
  assert.deepEqual(asked('need-missing-10s'), ['message__ask', 'message__note'])
  has('need-silence-25s', 'The last sign of activity from the work was 24 seconds ago.', '- No tool step is running.'); assert.deepEqual(asked('need-silence-25s'), ['message__stalled', 'message__note'])
  has('need-reasoning-70s', '- 70 seconds have passed', 'The last sign of activity from the work was 60 seconds ago.', 'a reasoning step is open'); assert.deepEqual(asked('need-reasoning-70s'), ['message__stalled', 'message__note'])
  has('need-just-posted-8s', 'Already said to the person while working:\n- 8 seconds ago (a note that this takes a while): "테스트를 돌리는 중이라 조금 걸립니다. 끝나면 바로 정리해 드릴게요."', 'Tool steps finished so far: 3')
  has('pointer-owner-elsewhere', `The assistant's answer, already posted:\n"""\n${ANSWER.report}\n"""`, 'A finished result is waiting to the left of what they are looking at on the desk, some way off. It is for the owner of this task. They are not in this conversation: the note would go into their own conversation.',
    'they are at the desk (last input 2 seconds ago)')
  assert.ok(!text('pointer-owner-elsewhere').includes(REQUEST.budget) && !text('pointer-owner-elsewhere').includes(ANSWER.budget), 'nothing of the owner\'s own conversation')
  has('pointer-requester-present', `"""\n${ANSWER.survey}\n"""`, 'waiting to the right of what they are looking at on the desk, close by. It is for the person who asked. They take part in this conversation.')
  has('pointer-already-told', `"""\n${ANSWER.surveyTold}\n"""`)
  has('pointer-nobody-waiting', 'Nobody is at the desk waiting for this.', 'far away')
  has('pointer-new-run', REQUEST.summary, '- 5 seconds have passed', 'Separately, from earlier work in this conversation: a finished result is waiting below what they are looking at on the desk, close by.')
  has('pointer-held-3min', REQUEST.budget, 'Separately: a finished result from another task has been waiting for this person for about 185 seconds, elsewhere on the desk.')
  assert.ok(!text('pointer-held-3min').includes(REQUEST.report) && !/left/.test(text('pointer-held-3min')), 'a held fact carries neither the other task\'s text nor its old direction')
  for (const r of plan.requests.filter(r => r.id.startsWith('pointer-'))) assert.deepEqual(asked(r.id), ['message__pointer'])
})

test('what is registered: speak (hard) in the seven situations whose hard expectation failed on the first measurement, stay silent (hard) at 3 s, just after speaking and with nobody there', () => {
  const hard = kind => HEARTBEAT_PATTERNS.filter(p => p.expect.some(e => e.severity === 'hard' && e[kind] !== undefined)).map(p => p.id)
  assert.deepEqual(hard('min'), ['need-command-40s', 'need-objective-40s', 'need-missing-10s', 'need-silence-25s', 'need-reasoning-70s', 'pointer-owner-elsewhere', 'pointer-requester-present'])
  assert.deepEqual(hard('max'), ['need-quick-3s', 'need-just-posted-8s', 'pointer-nobody-waiting'])
  for (const p of HEARTBEAT_PATTERNS) for (const e of p.expect) {
    if (e.severity === 'hard' && e.min !== undefined) assert.equal(e.min, BEAT_PREDICATE_YES, 'an expected yes is registered at the product\'s own bar')
    if (e.max !== undefined) assert.equal(e.max, 0.5)
  }
  const counterfactual = HEARTBEAT_PATTERNS.filter(p => p.path === 'counterfactual')
  assert.deepEqual(counterfactual.map(p => p.id), ['need-quick-3s', 'need-thinking-12s', 'need-just-posted-8s', 'pointer-nobody-waiting'])
  for (const p of counterfactual) { assert.ok(p.codeRule); assert.ok(p.expect.every(e => e.max !== undefined), 'where a code rule decides, the registered answer is no') }
  for (const p of HEARTBEAT_PATTERNS) assert.ok(p.ifMissed.length > 20 && p.pattern.length > 20 && p.before.length > 3)
})
