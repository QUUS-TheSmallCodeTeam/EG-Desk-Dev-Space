import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { FLOW_KINDS } from './egdesk-conversation-flow.mjs'
import { HEARTBEAT_PATTERNS, buildHeartbeatPlan, planFile } from './egdesk-heartbeat-real-plan.mjs'

// The real-measurement plan for the heartbeat judgments is built by the product code and sends nothing. These tests keep the
// registered plan (egdesk-heartbeat-real-plan.snapshot.json) equal to what the product builds today: a change of wording, options or
// facts changes the bytes, and then the plan has to be registered again (node scripts/egdesk-heartbeat-real-plan.mjs --snapshot)
// and any real result measured on the old bytes no longer describes the product.
const snapshot = JSON.parse(readFileSync(new URL('./egdesk-heartbeat-real-plan.snapshot.json', import.meta.url), 'utf8'))
const realFetch = globalThis.fetch
let network = 0
globalThis.fetch = async () => { network++; throw new Error('no network in a plan build') }
const plan = await buildHeartbeatPlan()
globalThis.fetch = realFetch
const body = id => JSON.parse(plan.requests.find(r => r.id === id).body)
const lines = id => body(id).input.slice(1).map(row => row.content).join('\n')

test('the plan is exactly the registered one, in the runner\'s format, under the token bound, and building it sends nothing', () => {
  assert.equal(network, 0)
  assert.deepEqual(planFile(plan), snapshot, 'the product no longer builds the registered bytes: register again with --snapshot and re-measure')
  assert.deepEqual(Object.keys(snapshot), ['set', 'tokenCeiling', 'passRule', 'requests'])
  for (const r of snapshot.requests) {
    assert.deepEqual(Object.keys(r), ['id', 'file', 'sha256', 'estInputTokens', 'expect']); assert.equal(r.file, `requests/${r.id}.json`); assert.match(r.sha256, /^[a-f0-9]{64}$/)
    for (const e of r.expect) {
      assert.ok(['hard', 'soft'].includes(e.severity) && e.kind === 'choice' && e.name === 'message__need' && typeof e.note === 'string' && e.note.length > 0)
      assert.ok((typeof e.equals === 'string') !== Array.isArray(e.oneOf), 'equals or oneOf')
    }
  }
  const total = plan.requests.reduce((n, r) => n + r.estInputTokens, 0)
  assert.equal(plan.requests.length, 15); assert.ok(total <= plan.tokenCeiling && plan.tokenCeiling < 12_000, `estimated ${total}, ceiling ${plan.tokenCeiling}`)
  assert.deepEqual([plan.requests.filter(r => r.id.startsWith('need-')).length, plan.requests.filter(r => r.id.startsWith('pointer-')).length], [9, 6])
})

test('every body is the product\'s wire body: model, fixed rule, session facts, one question with closed options, and every expected value is an offered option', () => {
  for (const r of plan.requests) {
    assert.equal(createHash('sha256').update(r.body).digest('hex'), r.sha256)
    const b = JSON.parse(r.body)
    assert.deepEqual(Object.keys(b), ['model', 'input', 'questions', 'prompt_cache_key']); assert.deepEqual([b.model, b.prompt_cache_key], [DECISION_MODEL, 'heartbeat-beat'])
    assert.deepEqual(b.input.map(row => row.role), ['developer', 'user', 'user']); assert.match(b.input[1].content, /^Session:\nseconds_since_the_person_wrote: \d+\n/); assert.match(b.input[2].content, /^Question message__need:\n/)
    assert.equal(b.questions.length, 1)
    const q = b.questions[0], offered = q.choices.map(c => c.value)
    assert.deepEqual([q.type, q.name, offered[0]], ['choice', 'message__need', 'none'])
    for (const c of q.choices) assert.equal(c.description, FLOW_KINDS.find(kind => kind.value === c.value).description)
    for (const e of r.expect) for (const v of e.oneOf ?? [e.equals]) assert.ok(offered.includes(v), `${r.id}: expected "${v}" is not offered (${offered})`)
    // Numbers and closed labels only: no text of a person, a page, a terminal or a model, and no member id.
    for (const row of b.input.slice(1)) for (const line of row.content.split('\n').slice(1)) assert.match(line, /^[a-z_]+: [a-z0-9_]+$/, `${r.id}: ${line}`)
    assert.doesNotMatch(r.body, /[\u3131-\uD79D]|npm|m-jin|egd-synthetic|\/work/)
  }
})

test('each pattern carries the facts it is named for', () => {
  const has = (id, ...needles) => { for (const needle of needles) assert.ok(lines(id).includes(needle), `${id} lacks "${needle}"\n${lines(id)}`) }
  const offered = id => body(id).questions[0].choices.map(c => c.value)
  has('need-quick-3s', 'seconds_since_the_person_wrote: 3\n', 'reasoning_in_progress: yes')
  has('need-thinking-12s', 'seconds_since_the_person_wrote: 12\n', 'seconds_since_anything_came_from_the_work: 1\n', 'tool_steps_done: 0')
  has('need-thinking-20s', 'seconds_since_the_person_wrote: 20\n', 'last_activity_from_the_work: reasoning', 'reasoning_in_progress: yes')
  has('need-command-40s', 'seconds_since_the_person_wrote: 40\n', 'current_phase: tool_running', 'waiting_on: command_running', 'waiting_on_seconds: 18')
  has('need-objective-40s', 'current_phase: objective_step', 'tool_steps_done: 3', 'steps_known_to_remain: 21', 'waiting_on: browser_task_running')
  has('need-missing-10s', 'seconds_since_the_person_wrote: 10\n', 'agent_asked_a_question_in_its_notes: yes'); assert.deepEqual(offered('need-missing-10s'), ['none', 'explain_wait', 'ask_missing'])
  has('need-silence-25s', 'seconds_since_anything_came_from_the_work: 24\n', 'reasoning_in_progress: no'); assert.deepEqual(offered('need-silence-25s'), ['none', 'explain_wait', 'stalled'])
  has('need-reasoning-70s', 'seconds_since_the_person_wrote: 70\n', 'seconds_since_anything_came_from_the_work: 60\n', 'reasoning_in_progress: yes'); assert.deepEqual(offered('need-reasoning-70s'), ['none', 'explain_wait', 'stalled'])
  has('need-just-posted-8s', 'seconds_since_last_message_from_you: 8\n', 'wait_already_explained: yes', 'steps_done_since_last_message: 2')
  has('pointer-owner-elsewhere', 'work_in_progress: no', 'attention_kind: result', 'attention_for: owner', 'attention_where: left', 'attention_person_in_this_conversation: no', 'waiting_person_present: yes')
  has('pointer-requester-present', 'attention_for: requester', 'attention_where: right', 'attention_distance: near', 'attention_person_in_this_conversation: yes', 'waiting_person: requester')
  has('pointer-in-view', 'attention_where: in_view')
  has('pointer-nobody-waiting', 'waiting_person: nobody', 'waiting_person_present: no')
  has('pointer-new-run', 'work_in_progress: yes', 'seconds_since_the_person_wrote: 5\n', 'attention_where: below')
  has('pointer-held-3min', 'work_in_progress: yes', 'attention_where: none', 'attention_waiting_seconds: 185')
  for (const r of plan.requests.filter(r => r.id.startsWith('pointer-'))) assert.deepEqual(offered(r.id), ['none', 'pointer'])
})

test('what is registered: hard where the design depends on the answer; the moments a code rule decides are marked and never hard, except the one control', () => {
  const hard = HEARTBEAT_PATTERNS.filter(p => p.expect.some(e => e.severity === 'hard')).map(p => p.id)
  assert.deepEqual(hard, ['need-quick-3s', 'need-command-40s', 'need-objective-40s', 'need-missing-10s', 'need-silence-25s', 'need-reasoning-70s', 'pointer-owner-elsewhere', 'pointer-requester-present'])
  const counterfactual = HEARTBEAT_PATTERNS.filter(p => p.path === 'counterfactual')
  assert.deepEqual(counterfactual.map(p => p.id), ['need-quick-3s', 'need-thinking-12s', 'need-just-posted-8s', 'pointer-nobody-waiting'])
  for (const p of counterfactual) { assert.ok(p.codeRule); assert.deepEqual(p.expect.map(e => e.equals), ['none']) }
  for (const p of HEARTBEAT_PATTERNS) { assert.ok(p.ifMissed.length > 20 && p.pattern.length > 20); for (const e of p.expect) if (e.equals && e.equals !== 'none') assert.equal(e.minConfidence, 0.75) }
  // Both directions are measured: a judge that always acts and a judge that never acts each fail a hard expectation.
  assert.ok(HEARTBEAT_PATTERNS.some(p => p.expect.some(e => e.severity === 'hard' && e.equals === 'none')) && HEARTBEAT_PATTERNS.some(p => p.expect.some(e => e.severity === 'hard' && e.equals === 'pointer')))
})
