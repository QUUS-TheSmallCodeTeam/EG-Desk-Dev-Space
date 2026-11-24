import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DECISION_MODEL, validateDecisionRequest } from './egdesk-decision-client.mjs'
import { CONFIRMATION_CASES, CONFIRMATION_SET, STATED_REPLY, UNSTATED_REPLY, buildConfirmationPlan } from './egdesk-confirmation-plan.mjs'
import { confirmationAction } from './egdesk-record-confirmation.mjs'

const built = await buildConfirmationPlan()

test('confirmation plan: the declarative format, nine product-built bodies, every expectation names a real question, about 6k tokens', () => {
  const { plan, files } = built
  assert.deepEqual(Object.keys(plan), ['set', 'tokenCeiling', 'passRule', 'requests']); assert.equal(plan.set, CONFIRMATION_SET)
  assert.equal(plan.requests.length, 9)
  for (const r of plan.requests) {
    assert.deepEqual(Object.keys(r), ['id', 'file', 'sha256', 'estInputTokens', 'expect'])
    const file = files.find(f => f.file === r.file), body = JSON.parse(file.bytes.toString('utf8'))
    assert.equal(createHash('sha256').update(file.bytes).digest('hex'), r.sha256)
    assert.equal(body.model, DECISION_MODEL); validateDecisionRequest({ input: body.input, questions: body.questions })
    assert.deepEqual(body.questions.map(q => [q.name, q.type]), [['rc_stated_0', 'predicate'], ['rc_confirms_0', 'predicate'], ['rc_rejects_0', 'predicate']], 'yes/no questions only')
    const def = CONFIRMATION_CASES.find(c => c.id === r.id)
    assert.ok(body.input.some(m => m.content === `Assistant's previous reply:\n${def.reply === 'stated' ? STATED_REPLY : UNSTATED_REPLY}`) && body.input.at(-1).content.endsWith(def.message))
    for (const e of r.expect) assert.ok(body.questions.some(q => q.name === e.name) && ['hard', 'soft'].includes(e.severity) && e.note)
    assert.ok(r.expect.some(e => e.severity === 'hard'))
  }
  assert.ok(built.estInputTokens <= 6000, String(built.estInputTokens)); assert.ok(plan.tokenCeiling >= built.estInputTokens)
})

test('the registered hard checks are exactly what keeps a non-answer from promoting: "고마워" and "그럼 롤백 조건은 뭐였지?" can never reach promote', () => {
  const hard = id => built.plan.requests.find(r => r.id === id).expect.filter(e => e.severity === 'hard')
  for (const id of ['c5-next-question', 'c6-thanks', 'c7-hesitation']) assert.deepEqual(hard(id).map(e => [e.name, e.max]), [['rc_confirms_0', 0.79]], id)
  assert.deepEqual(hard('c8-yes-to-other-question').map(e => [e.name, e.max]), [['rc_stated_0', 0.79]])
  // with those hard checks met, no combination of the other two readings promotes (the bars are the product's: yes >= 0.8)
  const t = p => ({ state: p >= 0.8 ? 'yes' : p <= 0.2 ? 'no' : 'unknown', p })
  for (const confirms of [0, 0.5, 0.79]) for (const stated of [0, 0.5, 1]) for (const rejects of [0, 0.5, 1]) assert.notEqual(confirmationAction(t(stated), t(confirms), t(rejects)).action, 'promote')
  for (const stated of [0, 0.5, 0.79]) for (const confirms of [0, 0.5, 1]) for (const rejects of [0, 0.5, 1]) assert.notEqual(confirmationAction(t(stated), t(confirms), t(rejects)).action, 'promote')
  // and the registered outcomes of the confirming and rejecting cases follow from their hard checks
  assert.equal(confirmationAction(t(0.8), t(0.8), t(0.2)).action, 'promote')
  assert.equal(confirmationAction(t(1), t(0.2), t(0.8)).action, 'revert')
})

test('deterministic: the same code builds the same bytes', async () => {
  const again = await buildConfirmationPlan()
  assert.deepEqual(again.plan, built.plan)
})
