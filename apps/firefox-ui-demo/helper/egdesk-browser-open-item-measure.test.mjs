// L8 c38: the Decisions-only measurement of the open browser task's option predicates. Fake client: nothing is sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { OPEN_ITEM_HARD_LIMITS, loadOpenItemPlan, planTask, runOpenItemPlan, scoreOpenItemRun, selectReplies, standIn, verdict } from './egdesk-browser-open-item-measure.mjs'
import { decideOpenItem, optionQuestionName } from './egdesk-browser-open-items.mjs'

const plan = loadOpenItemPlan()
const KEY = 'egd-synthetic-not-a-key-0008-long-enough'

test('the plan is pre-registered and valid: 12 short realistic replies, each with the outcome it should have, the acceptable set, a prediction that sums to one; the drop order names every reply once', () => {
  assert.equal(plan.set, 'browser-open-item-v1'); assert.equal(plan.replies.length, 12)
  assert.deepEqual(plan.replies.map(r => r.id), ['ack', 'typo', 'okok', 'again', 'again2', 'stop', 'stop2', 'page', 'notyet', 'offtopic', 'change', 'compound'])
  assert.deepEqual([...plan.dropOrder].sort(), plan.replies.map(r => r.id).sort())
  assert.ok(plan.replies.every(r => r.message.length <= 40), 'short replies')
  assert.deepEqual(plan.replies.filter(r => r.want === 'none').map(r => [r.id, r.acceptable]), [['okok', ['continue']], ['notyet', []], ['offtopic', []]])
  assert.ok(plan.prediction.correct && plan.prediction.wrong && plan.prediction.mostLikelyMisses.length)
  assert.deepEqual([plan.maxRequests, plan.tokenCeiling], [12, 4000]); assert.ok(OPEN_ITEM_HARD_LIMITS.tokenCeiling <= 13000)
})

test('the task is built by the product\'s store as a handed-over task, and the five options (change included) are the ones asked', () => {
  const task = planTask(plan)
  assert.deepEqual([task.status, task.pause, task.steps, task.goal], ['paused', { kind: 'cannot_proceed', code: 'login_required' }, 1, '내 다음 공연 예매 내역 알려줘'])
  assert.ok(task.question.includes('로그인'))
})

test('verdict by code: correct, acceptable, safe miss and wrong', () => {
  const r = (want, acceptable, uncertainOk) => ({ want, acceptable, ...(uncertainOk ? { uncertainOk } : {}) })
  const settled = optionId => ({ kind: 'settled', optionId }), uncertain = { kind: 'uncertain' }, noneRead = { kind: 'none' }
  assert.equal(verdict(r('continue', ['continue']), settled('continue')), 'correct')
  assert.equal(verdict(r('retry', ['retry', 'continue']), settled('continue')), 'acceptable')
  assert.equal(verdict(r('retry', ['retry', 'continue']), settled('abandon')), 'wrong')
  assert.equal(verdict(r('none', []), settled('continue')), 'wrong', 'continue settled on "아직" is the unsafe error')
  assert.equal(verdict(r('none', ['continue']), settled('continue')), 'acceptable')
  assert.equal(verdict(r('none', []), noneRead), 'correct')
  assert.equal(verdict(r('none', []), uncertain), 'acceptable')
  assert.equal(verdict(r('retry', ['retry', 'continue']), uncertain), 'safe_miss', 'the retry/continue overlap is a miss that costs a turn')
  assert.equal(verdict(r('continue', ['continue', 'ask_page'], true), uncertain), 'acceptable', 'a compound message is rightly not settled')
  assert.equal(verdict(r('abandon', ['abandon']), noneRead), 'safe_miss')
  assert.deepEqual(scoreOpenItemRun({ replies: [1, 2] }, [{ id: 'a', verdict: 'correct' }, { id: 'b', verdict: 'wrong' }]), { ran: 2, notRun: 0, correct: 1, acceptable: 0, safeMiss: 0, wrong: 1, wrongReplies: ['b'], pass: false })
})

test('selectReplies: the budget keeps what fits, dropping in the pre-registered order; 4000 keeps three (again, notyet, ack), 13000 keeps all twelve; the estimate is of the product\'s own requests', async () => {
  const small = await selectReplies(plan, 4000)
  assert.deepEqual([small.kept, small.dropped], [['ack', 'again', 'notyet'], plan.dropOrder.slice(0, 9)])
  assert.ok(small.estInputTokens <= 4000 && small.estInputTokens > 2900, `estimated ${small.estInputTokens}`)
  const all = await selectReplies(plan, 13000)
  assert.deepEqual([all.kept.length, all.dropped], [12, []]); assert.ok(Object.values(all.perReply).reduce((a, b) => a + b, 0) > 12000, 'twelve replies are about 12k tokens by the typed estimate, not 4k')
})

test('a full run with the stand-in: twelve requests, each byte for byte the product\'s decideOpenItem request; the plan\'s own expectations pass; nothing wrong', async () => {
  const bodies = []
  const out = await runOpenItemPlan({ plan, budget: 13000, scripted: body => { bodies.push(body); return standIn(plan)(body) } })
  assert.deepEqual([out.sent, out.rows.length, out.stoppedBecause, out.score.pass, out.score.wrong], [12, 12, null, true, 0])
  // the same request, built directly by the product's function
  const direct = []
  for (const reply of plan.replies) await decideOpenItem({ message: reply.message, task: planTask(plan), change: true, client: { decide: async request => { direct.push(request); return { answers: standIn(plan)({ questions: request.questions, input: request.input }) .reduce((m, a) => ({ ...m, [a.name]: a }), {}) } } } })
  assert.deepEqual(bodies.map(b => b.questions.map(q => q.name)), direct.map(r => r.questions.map(q => q.name)))
  assert.deepEqual(bodies.map(b => b.input[1].content), direct.map(r => r.input[1].content))
  assert.ok(bodies.every(b => b.questions.map(q => q.name).join() === ['continue', 'retry', 'abandon', 'ask_page', 'change'].map(optionQuestionName).join()))
  assert.deepEqual(out.requests.map(r => r.id), plan.replies.map(r => r.id))
})

test('a model that settles continue on everything is caught: "아직", "그만해", the page question and the weather are WRONG, so the plan fails', async () => {
  const always = body => body.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'open_browser_continue' ? 0.97 : 0.02 }))
  const out = await runOpenItemPlan({ plan, budget: 13000, scripted: always })
  assert.equal(out.score.pass, false)
  assert.deepEqual(out.score.wrongReplies, ['stop', 'stop2', 'page', 'notyet', 'offtopic', 'change'])
})

test('guards: a dry run sends nothing; a missing key sends nothing; the first failed request stops the run with no retry; the ceiling and the limit stop it; the key is never in the result; only the official endpoint', async () => {
  assert.equal((await runOpenItemPlan({ plan })).stoppedBecause, 'dry_run')
  assert.equal((await runOpenItemPlan({ plan, send: true, key: null })).stoppedBecause, 'no_key')
  let calls = 0
  const failing = await runOpenItemPlan({ plan, send: true, key: KEY, fetchImpl: async () => { calls++; return { status: 500, text: async () => '{}' } } })
  assert.deepEqual([calls, failing.sent, failing.stoppedBecause], [1, 1, 'http_500'])
  const urls = []
  const ok = await runOpenItemPlan({ plan, send: true, key: KEY, budget: 4000, fetchImpl: async (url, init) => { urls.push(url); const body = JSON.parse(init.body); return { status: 200, text: async () => JSON.stringify({ answers: standIn(plan)(body), usage: { input_tokens: 1500 } }) } } })
  assert.ok(urls.every(u => u === 'https://api.openai.com/v1/decisions'))
  assert.equal(ok.stoppedBecause, 'token_ceiling', 'real usage above the estimate stops the run at the ceiling, never past it')
  assert.deepEqual([ok.sent, ok.usage.inputTokens], [2, 3000])
  assert.equal(JSON.stringify(ok).includes(KEY), false)
  const limited = await runOpenItemPlan({ plan: { ...plan, maxRequests: 12 }, send: true, key: KEY, budget: 13000, fetchImpl: async (url, init) => ({ status: 200, text: async () => JSON.stringify({ answers: standIn(plan)(JSON.parse(init.body)), usage: { input_tokens: 500 } }) }) })
  assert.deepEqual([limited.sent, limited.score.pass], [12, true])
  assert.equal(OPEN_ITEM_HARD_LIMITS.maxRequests, 12)
})
