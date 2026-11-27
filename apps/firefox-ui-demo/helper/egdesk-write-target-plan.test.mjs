import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DECISION_MODEL, validateDecisionRequest } from './egdesk-decision-client.mjs'
import { WRITE_TARGET_CASES, WRITE_TARGET_SET, buildWriteTargetPlan } from './egdesk-write-target-plan.mjs'

const built = await buildWriteTargetPlan()
const body = id => JSON.parse(built.files.find(f => f.file === `requests/${id}.json`).bytes.toString('utf8'))

test('the plan is exactly the declarative format: set, tokenCeiling, passRule, requests with id / file / sha256 of the file bytes / estInputTokens / expect', () => {
  const { plan, files } = built
  assert.deepEqual(Object.keys(plan), ['set', 'tokenCeiling', 'passRule', 'requests'])
  assert.equal(plan.set, WRITE_TARGET_SET); assert.ok(Number.isSafeInteger(plan.tokenCeiling) && typeof plan.passRule === 'string' && plan.passRule.length > 40)
  assert.deepEqual(plan.requests.map(r => r.id), ['u1-relayed-past', 'u2-own-plan', 'u3-own-observation', 'pg-done-report', 'due-date-correction', 'small-talk'])
  for (const r of plan.requests) {
    assert.deepEqual(Object.keys(r), ['id', 'file', 'sha256', 'estInputTokens', 'expect'])
    const file = files.find(f => f.file === r.file)
    assert.equal(r.file, `requests/${r.id}.json`); assert.equal(createHash('sha256').update(file.bytes).digest('hex'), r.sha256)
    assert.ok(Number.isSafeInteger(r.estInputTokens) && r.estInputTokens > 0)
    const parsed = JSON.parse(file.bytes.toString('utf8'))
    assert.deepEqual(Object.keys(parsed), ['model', 'input', 'questions']); assert.equal(parsed.model, DECISION_MODEL)
    validateDecisionRequest({ input: parsed.input, questions: parsed.questions })
    // every expectation names a question of that request, with a value the question really offers
    for (const e of r.expect) {
      const q = parsed.questions.find(x => x.name === e.name)
      assert.ok(q && q.type === e.kind && ['hard', 'soft'].includes(e.severity) && typeof e.note === 'string' && e.note, `${r.id} ${e.name}`)
      if (e.kind === 'predicate') assert.ok((e.min === undefined) !== (e.max === undefined) && [e.min, e.max].filter(v => v !== undefined).every(v => v >= 0 && v <= 1))
      else { assert.ok((e.equals === undefined) !== (e.oneOf === undefined)); for (const v of e.equals !== undefined ? [e.equals] : e.oneOf) assert.ok(q.choices.some(c => c.value === v), `${r.id} ${e.name} ${v}`) }
    }
    assert.ok(r.expect.some(e => e.severity === 'hard'))
  }
  const total = plan.requests.reduce((n, r) => n + r.estInputTokens, 0)
  assert.equal(total, built.estInputTokens); assert.ok(total <= 8200, `about 8k input tokens, got ${total}`); assert.ok(plan.tokenCeiling >= total && plan.tokenCeiling <= total * 1.2)
})

test('the bodies are the product\'s own requests: no question asks "new or none", a case without records has no target question, small talk is the recording triage', async () => {
  for (const def of WRITE_TARGET_CASES) {
    const b = body(def.id), names = b.questions.map(q => q.name)
    assert.ok(!names.includes('tw_target') && !b.questions.some(q => q.type === 'choice' && q.choices.some(c => ['new', 'none'].includes(c.value))), def.id)
    assert.ok(b.input.at(-1).content.endsWith(def.message), 'the registered utterance, exactly')
    if (def.kind === 'triage') { assert.deepEqual(names, ['tn_courtesy', 'tn_need', 'tn_record']); continue }
    assert.deepEqual(names, ['tw_status', ...def.candidates.map((_, i) => `tw_about_${i}`), 'speech_source_0', 'speech_form_0', 'speech_time_0'], def.id)
    assert.deepEqual(b.questions[0].choices.map(c => c.value), ['done', 'plan', 'corrected', 'unknown'])
    assert.equal(b.input[1].content.startsWith('Stored records:\n'), true)
    if (!def.candidates.length) assert.equal(b.input[1].content, 'Stored records:\n(none)')
  }
  // the registered target of each candidate case is the record whose question must be yes, and every other record's must be no
  for (const [id, yesIndex, n] of [['pg-done-report', 0, 3], ['due-date-correction', 0, 2]]) {
    const expect = built.plan.requests.find(r => r.id === id).expect
    for (let i = 0; i < n; i++) { const e = expect.find(x => x.name === `tw_about_${i}`); assert.deepEqual([e.severity, i === yesIndex ? e.min : e.max], ['hard', i === yesIndex ? 0.8 : 0.2]) }
  }
  assert.match(body('due-date-correction').input[1].content, /P1 \|[^\n]*B사 납품 일정\n[^\n]*12월 3일[\s\S]*P2 \|[^\n]*A사 납품 일정/)
  // deterministic and free of anything private
  const again = await buildWriteTargetPlan()
  assert.deepEqual(again.plan, built.plan); assert.ok(built.files.every(f => !f.bytes.toString('utf8').includes('A사 내부 원가')))
})
