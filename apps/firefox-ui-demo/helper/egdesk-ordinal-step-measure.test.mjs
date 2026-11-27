// L8 c44: the ordinal-step measurement. Fake client: nothing is sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ORDINAL_HARD, captureStepRequest, contextLineFor, loadOrdinalPlan, ordinalStandIn, ordinalVerdict, runOrdinalPlan, scoreOrdinal, selectOrdinal } from './egdesk-ordinal-step-measure.mjs'

const plan = loadOrdinalPlan()
const KEY = 'egd-synthetic-not-a-key-0008-long-enough'

test('the plan is pre-registered and valid: four ways an ordinal reaches the step, the bar of the product, a ceiling of 5000 and a fixed drop order', () => {
  assert.equal(plan.set, 'ordinal-step-v1'); assert.deepEqual(plan.replies.map(r => [r.id, r.message, r.line]), [['bare', '두번째', 'bare'], ['code', '두번째', 'code'], ['list', '두번째', 'list'], ['below', '아래 거', 'below']])
  assert.deepEqual([plan.maxRequests, plan.tokenCeiling, ORDINAL_HARD.tokenCeiling], [4, 5000, 5000]); assert.deepEqual(plan.dropOrder, ['below', 'bare'])
  assert.deepEqual(plan.asked, ['사업자 123-45-67890', '사업자 987-65-43210'])
})

test('the line each variant sends is the product\'s own: the bare reply (the old line), choiceContextLine (the entry\'s line for an unambiguous ordinal), choiceListLine (when code cannot resolve)', () => {
  const line = id => contextLineFor(plan, plan.replies.find(r => r.id === id))
  assert.equal(line('bare'), '두번째')
  assert.ok(line('code').startsWith('Chose "사업자 987-65-43210" (option 2 of the options the person was asked to choose between, in this order: 1. 사업자 123-45-67890 / 2. 사업자 987-65-43210)'))
  assert.equal(line('list'), '두번째\n(The person had been asked to choose between, in this order: 1. 사업자 123-45-67890 / 2. 사업자 987-65-43210)')
  assert.equal(line('below'), '아래 거\n(The person had been asked to choose between, in this order: 1. 사업자 123-45-67890 / 2. 사업자 987-65-43210)')
})

test('the step request is the product\'s own (the objective step over the portal fixture\'s /invoices page): the options of the page, the goal and the context line; only the line differs between variants', async () => {
  const a = await captureStepRequest(plan, plan.replies.find(r => r.id === 'code')), b = await captureStepRequest(plan, plan.replies.find(r => r.id === 'bare'))
  assert.deepEqual(a.questions.map(q => q.name), b.questions.map(q => q.name)); assert.equal(a.questions[0].name, 'next_step')
  assert.ok(a.questions[0].choices.map(c => c.value).some(v => v.includes('사업자 987-65-43210')) && a.input[1].content.includes('Goal: 포털 세금계산서 이번 달 거 받아줘'))
  assert.ok(a.input[1].content.includes('Context the user gave in the chat (not page text):\nChose "사업자 987-65-43210"'))
  assert.ok(b.input[1].content.includes('Context the user gave in the chat (not page text):\n두번째\n\n'), 'the old bare line')
  assert.equal(a.input[1].content.replace(/Context the user gave[\s\S]*?\n\nVisible/, 'Visible'), b.input[1].content.replace(/Context the user gave[\s\S]*?\n\nVisible/, 'Visible'), 'nothing else differs')
})

test('verdict by code with the product\'s bar: the wanted business accepted = correct, the other business accepted = WRONG, under the bar = safe miss', () => {
  const choice = (value, confidence, other = 'x') => ({ next_step: { type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }, { value: other, probability: 1 - confidence }] } })
  assert.equal(ordinalVerdict(plan, choice('[L2] 사업자 987-65-43210', 0.98)).verdict, 'correct')
  assert.equal(ordinalVerdict(plan, choice('[L2] 사업자 987-65-43210', 0.60)).verdict, 'safe_miss', 'the V4 value: under the 0.75 bar')
  assert.equal(ordinalVerdict(plan, choice('[L1] 사업자 123-45-67890', 0.95)).verdict, 'wrong', 'the other business')
  assert.deepEqual(scoreOrdinal({ replies: [1, 2] }, [{ id: 'a', verdict: 'correct' }, { id: 'b', verdict: 'wrong' }]), { ran: 2, notRun: 0, correct: 1, safeMiss: 0, wrong: 1, wrongReplies: ['b'], pass: false })
})

test('selectOrdinal: under 5000 the pre-registered order drops below and bare; all four are about 6.7k; the run with the stand-in passes; guards hold', async () => {
  const all = await selectOrdinal(plan, 99999)
  assert.ok(Object.values(all.perReply).reduce((a, b) => a + b, 0) > 6500)
  const fit = await selectOrdinal(plan, 5000)
  assert.deepEqual([fit.kept, fit.dropped], [['code', 'list'], ['below', 'bare']]); assert.ok(fit.estInputTokens * 1.03 <= 5000, `estimated ${fit.estInputTokens}`)
  const out = await runOrdinalPlan({ plan, scripted: ordinalStandIn(plan) })
  assert.deepEqual([out.sent, out.score.pass, out.score.correct, out.dropped], [2, true, 2, ['below', 'bare']])
  const bare = await runOrdinalPlan({ plan, budget: 5000, scripted: ordinalStandIn(plan), unbounded: true })
  assert.deepEqual(bare.rows.map(r => [r.id, r.verdict]), [['bare', 'safe_miss'], ['code', 'correct'], ['list', 'correct'], ['below', 'correct']], 'the bare shape is the one the stand-in leaves unsure (the V4 value)')
  const wrongModel = await runOrdinalPlan({ plan, scripted: body => body.questions.map(q => (q.name === 'next_step' ? { name: q.name, type: 'choice', choice: q.choices[0].value, confidence: 0.95, probabilities: [{ value: q.choices[0].value, probability: 0.95 }] } : { name: q.name, type: 'predicate', probability: q.name.startsWith('ps_') ? 0.01 : 0.02 })) })
  assert.equal(wrongModel.score.pass, false); assert.ok(wrongModel.score.wrongReplies.length >= 1, 'a model that picks the first business is caught')
  assert.equal((await runOrdinalPlan({ plan })).stoppedBecause, 'dry_run'); assert.equal((await runOrdinalPlan({ plan, send: true, key: null })).stoppedBecause, 'no_key')
  const ok = await runOrdinalPlan({ plan, send: true, key: KEY, fetchImpl: async (url, init) => ({ status: 200, text: async () => JSON.stringify({ answers: ordinalStandIn(plan)(JSON.parse(init.body)), usage: { input_tokens: 3500 } }) }) })
  assert.equal(ok.stoppedBecause, 'token_ceiling'); assert.ok(ok.usage.inputTokens <= 5000); assert.equal(JSON.stringify(ok).includes(KEY), false)
})
