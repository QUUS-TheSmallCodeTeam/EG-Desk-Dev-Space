import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BROWSER_REAL_TOKEN_CEILING, SYNTHETIC_BROWSER_PAGES, buildBrowserRealPlan, priorRecordThroughMemory } from './egdesk-browser-real-plan.mjs'
import { buildReflexCandidates } from './egdesk-browser-reflex.mjs'
import { PS_NAMES } from './egdesk-browser-page-state.fixture.mjs'

// The real-measurement plan for the browser task: built by product code, deterministic, inside its token ceiling, with
// expectations that can actually be scored against its own requests. Building it sends nothing.
const built = await buildBrowserRealPlan()
const wire = id => JSON.parse(built.bodies[id])
const question = (id, name) => wire(id).questions.find(q => q.name === name)
const text = id => wire(id).input.map(m => m.content).join('\n')

test('the plan has exactly the declared format: 12 requests, each with a file, the sha256 of its exact bytes, a token estimate and expectations', () => {
  const { plan, bodies } = built
  assert.deepEqual(Object.keys(plan), ['set', 'tokenCeiling', 'passRule', 'requests'])
  assert.deepEqual(plan.requests.map(r => r.id), ['entry-task', 'entry-not-browser', 'entry-two-cards', 'entry-with-prior',
    'step-obvious-link', 'step-two-businesses', 'step-two-businesses-prior', 'step-two-factor', 'step-only-human-controls',
    'resume-answer', 'resume-stop', 'resume-unrelated'])
  for (const r of plan.requests) {
    assert.deepEqual(Object.keys(r), ['id', 'file', 'sha256', 'estInputTokens', 'expect'])
    assert.equal(r.file, `requests/${r.id}.json`)
    assert.equal(r.sha256, createHash('sha256').update(bodies[r.id], 'utf8').digest('hex'))
    assert.ok(Number.isSafeInteger(r.estInputTokens) && r.estInputTokens > 0)
    assert.ok(r.expect.length >= 1)
    for (const e of r.expect) {
      assert.ok(['hard', 'soft'].includes(e.severity) && typeof e.note === 'string' && e.note.length > 10, `${r.id} ${e.name}`)
      assert.deepEqual(Object.keys(e).filter(k => !['name', 'kind', 'min', 'max', 'equals', 'oneOf', 'minConfidence', 'severity', 'note'].includes(k)), [], 'only the declared fields')
      const q = question(r.id, e.name)
      assert.ok(q, `${r.id}: ${e.name} is a question of the request`)
      assert.equal(q.type, e.kind)
      const values = q.choices?.map(c => c.value) ?? []
      if (e.equals !== undefined) assert.ok(values.includes(e.equals), `${r.id}: ${e.equals} is offered`)
      if (e.oneOf) assert.ok(e.oneOf.every(v => values.includes(v)), `${r.id}: every allowed value is offered`)
      if (e.kind === 'predicate') assert.ok(Number.isFinite(e.min ?? e.max))
    }
  }
  const total = plan.requests.reduce((n, r) => n + r.estInputTokens, 0)
  assert.ok(total <= plan.tokenCeiling && plan.tokenCeiling === BROWSER_REAL_TOKEN_CEILING && plan.tokenCeiling <= 12000, `estimated ${total} tokens`)
  assert.ok(built.details.reduce((n, d) => n + d.estByBytes, 0) <= plan.tokenCeiling, 'the cruder bytes/3 estimate fits as well')
})

test('building twice gives the same bytes; a body is one Decision request (model, input, questions) and carries no key, no private host and no image', async () => {
  const again = await buildBrowserRealPlan()
  assert.deepEqual(again.bodies, built.bodies); assert.deepEqual(again.plan, built.plan)
  for (const [id, body] of Object.entries(built.bodies)) {
    assert.deepEqual(Object.keys(JSON.parse(body)), ['model', 'input', 'questions'], id)
    assert.doesNotMatch(body, /egd-synthetic|Bearer|authorization|input_image|image_url/i, id)
    for (const host of body.match(/https?:\/\/[a-z0-9.-]+/g) ?? []) assert.match(host, /^https:\/\/(portal|mail)\.example\.test$/, id)
    for (const host of body.match(/[a-z0-9-]+\.example\.[a-z]+/g) ?? []) assert.match(host, /^(portal|mail)\.example\.test$/, id)
  }
})

test('entry (c20): the request predicate and one predicate per granted card; the prior record rides only where declared', () => {
  // c20: the entry predicates: the request, then one per card quoting that page alone
  assert.deepEqual(wire('entry-task').questions.map(q => q.name), ['browser_entry', 'browser_entry_card_0'])
  assert.deepEqual(wire('entry-two-cards').questions.map(q => q.name), ['browser_entry', 'browser_entry_card_0', 'browser_entry_card_1'])
  assert.match(question('entry-two-cards', 'browser_entry_card_1').instructions, /mail\.example\.test/)
  assert.match(text('entry-with-prior'), /Stored memory fetched for this turn/); assert.match(text('entry-with-prior'), /사업자 987-65-43210/)
  for (const id of ['entry-task', 'entry-not-browser', 'entry-two-cards']) assert.doesNotMatch(text(id), /Stored memory|987-65/)
})

test('steps: the same questions (next_step, the page-state predicates, goal_met); the two-business page is byte-identical in its options with and without the prior record, which only adds evidence', () => {
  for (const id of built.plan.requests.map(r => r.id).filter(id => id.startsWith('step-'))) assert.deepEqual(wire(id).questions.map(q => [q.name, q.type]), [['next_step', 'choice'], ...PS_NAMES.map(name => [name, 'predicate']), ['goal_met', 'predicate']])
  assert.deepEqual(wire('step-two-businesses').questions, wire('step-two-businesses-prior').questions)
  assert.doesNotMatch(text('step-two-businesses'), /History \(earlier run|Stored memory/)
  assert.match(text('step-two-businesses-prior'), /it is listed now as \[L2\] 사업자 987-65-43210/)
  assert.ok(question('step-two-businesses', 'next_step').choices.some(c => c.value === 'needs_user_context'), 'the fixed "need more context from the user" option is offered')
})

test('safety by construction: the human-only page and the second-factor page offer NO element, and the dangerous labels are not in the request at all', () => {
  const controls = ['scroll_more', 'goal_met', 'needs_free_text', 'needs_user_context', 'blocked']
  assert.deepEqual(built.controls, controls)
  for (const id of ['step-only-human-controls', 'step-two-factor']) assert.deepEqual(question(id, 'next_step').choices.map(c => c.value), controls, id)
  const body = built.bodies['step-only-human-controls']
  assert.doesNotMatch(body, /구독 해지|제출|subscription\/cancel/, 'neither the cancellation link nor the submit button, as label or as address')
  assert.doesNotMatch(built.bodies['step-two-factor'], /인증번호|인증 확인/)
  // what the product withheld, counted by the same candidate builder the loop uses
  assert.deepEqual(buildReflexCandidates(SYNTHETIC_BROWSER_PAGES.subscription).excluded.gated, 2)
  const otp = buildReflexCandidates(SYNTHETIC_BROWSER_PAGES.otp)
  assert.deepEqual([otp.options.length, otp.excluded.sensitive, otp.excluded.gated], [0, 1, 1])
})

test('resume: only the closed pause code and the reply are sent; the three fixed options', () => {
  for (const id of ['resume-answer', 'resume-stop', 'resume-unrelated']) {
    assert.deepEqual(question(id, 'task_resume').choices.map(c => c.value), ['resume_task', 'cancel_task', 'unrelated'])
    assert.match(text(id), /Paused because: need_context \(choice_needed\)\nUser message: /)
    assert.doesNotMatch(text(id), /사업자 \d|portal|example/, 'no page content and no site in the resume request')
  }
})

test('the prior record is product-made: written through the general write path as an agent_note page with its body, and fetched back by the general memory fetch', async () => {
  const memory = await priorRecordThroughMemory()
  assert.equal(memory.pageId, 'browser-task/bt_0123456789ab')
  assert.deepEqual(memory.pages.map(p => [p.id, p.provenance.kind, typeof p.body]), [['browser-task/bt_0123456789ab', 'agent_note', 'string']])
  assert.deepEqual(memory.prior.resolved, [{ asked: 'choice_needed', chose: '사업자 987-65-43210', at: '/invoices' }])
})

test('every safety expectation is hard; hard expectations cover each stage', () => {
  const notes = built.plan.requests.flatMap(r => r.expect.map(e => ({ id: r.id, ...e })))
  assert.ok(notes.filter(e => /^Safety:/.test(e.note)).every(e => e.severity === 'hard'))
  for (const r of built.plan.requests) assert.ok(r.expect.some(e => e.severity === 'hard'), `${r.id} has a hard expectation`)
  // c16: each ordinary-page check is six hard predicate bounds (was one page_state choice): 20 - 3 + 18 = 35
  // c20: the entry predicates add one hard bound each on entry-task, entry-two-cards and entry-with-prior: 35 + 3 = 38
  assert.equal(notes.filter(e => e.severity === 'hard').length, 38); assert.equal(notes.filter(e => e.severity === 'soft').length, 8)
})
