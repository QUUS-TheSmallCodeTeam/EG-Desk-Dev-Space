// L8 c43: the placeless-entry measurement (L2's side question from V2). Fake client: nothing is sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ENTRY_PLACELESS_HARD, captureEntryRequest, entryStandIn, entryVerdict, loadEntryPlacelessPlan, runEntryPlacelessPlan, scoreEntry, selectEntry } from './egdesk-entry-placeless-measure.mjs'
import { ENTRY_WEB_ASK, entryEvidence } from './egdesk-browser-task.mjs'

const plan = loadEntryPlacelessPlan()
const KEY = 'egd-synthetic-not-a-key-0008-long-enough'

test('the plan is pre-registered and valid: three evidence levels of the open card, three placeless messages and two unrelated controls, a ceiling under 8000 and a fixed drop order', () => {
  assert.equal(plan.set, 'entry-placeless-v1'); assert.equal(plan.replies.length, 13)
  assert.deepEqual(Object.keys(plan.evidence), ['E1', 'E2', 'E3'])
  assert.equal(plan.evidence.E1.card.title, '합성 포털', 'E1 is the V2 fixture\'s evidence: the neutral title and host only')
  assert.ok(plan.evidence.E3.card.shows.length === 3 && plan.evidence.E2.card.title.includes('세금계산서'))
  assert.deepEqual([...new Set(plan.replies.map(r => r.message))], ['이번 달 세금계산서 받아줘', '세금계산서 받아줘', '이번 달 거 받아줘', '오늘 날씨 어때?', '파이썬 리스트 정렬 어떻게 해?'])
  assert.deepEqual(plan.replies.filter(r => r.want === 'not').map(r => r.id), ['c1-e1', 'c1-e2', 'c1-e3', 'c2-e2', 'c2-e3'])
  assert.deepEqual([plan.tokenCeiling, ENTRY_PLACELESS_HARD.tokenCeiling], [7500, 8000]); assert.deepEqual(plan.dropOrder, ['c2-e3', 'c1-e1', 'm2-e1'])
  assert.ok(plan.prediction.decision.includes('no product change'))
})

test('the request is the product\'s own: decideBrowserEntry\'s first request (the entry predicate, the answer predicate, one card predicate), with the card evidence of the level; nothing hand-written', async () => {
  const e1 = await captureEntryRequest(plan, plan.replies.find(r => r.id === 'm1-e1'))
  assert.deepEqual(e1.request.questions.map(q => q.name), ['browser_entry', 'browser_entry_answer', 'browser_entry_card_0'])
  assert.equal(e1.request.questions[0].instructions, ENTRY_WEB_ASK)
  assert.ok(e1.request.input[1].content.includes('User message: 이번 달 세금계산서 받아줘'))
  assert.ok(e1.request.input[1].content.includes(entryEvidence(e1.cards).join('\n')))
  assert.ok(!e1.request.input[1].content.includes('shows'), 'E1: no lines of the page')
  const e3 = await captureEntryRequest(plan, plan.replies.find(r => r.id === 'm1-e3'))
  assert.ok(e3.request.input[1].content.includes('shows "세금계산서 조회" / "이번 달 매출 3건, 매입 5건"') || e3.request.input[1].content.includes('세금계산서 조회'), 'E3 shows the page\'s lines')
  const e2 = await captureEntryRequest(plan, plan.replies.find(r => r.id === 'm1-e2'))
  assert.ok(e2.request.input[1].content.includes('세금계산서 조회 | 홈택스'))
})

test('verdict by code: entering a page task on an unrelated message is WRONG; a placeless message that does not enter is a safe miss (or acceptable where the plan allows it)', () => {
  const r = id => plan.replies.find(x => x.id === id)
  assert.equal(entryVerdict(r('m1-e2'), 'enter'), 'correct'); assert.equal(entryVerdict(r('m1-e2'), 'not'), 'safe_miss')
  assert.equal(entryVerdict(r('m3-e2'), 'not'), 'acceptable'); assert.equal(entryVerdict(r('c1-e2'), 'not'), 'correct'); assert.equal(entryVerdict(r('c1-e2'), 'enter'), 'wrong')
  assert.deepEqual(scoreEntry({ replies: [1, 2] }, [{ id: 'a', verdict: 'correct' }, { id: 'b', verdict: 'wrong' }]), { ran: 2, notRun: 0, correct: 1, acceptable: 0, safeMiss: 0, wrong: 1, wrongReplies: ['b'], pass: false })
})

test('selectEntry: under the 7500 default the pre-registered order drops c2-e3 and c1-e1; all 13 are about 8.4k; a full run with the stand-in passes; guards hold', async () => {
  const all = await selectEntry(plan, 99999)
  assert.ok(Object.values(all.perReply).reduce((a, b) => a + b, 0) > 8000)
  const fit = await selectEntry(plan, 7500)
  assert.deepEqual(fit.dropped, ['c2-e3', 'c1-e1']); assert.equal(fit.kept.length, 11); assert.ok(fit.estInputTokens * 1.03 <= 8000, `estimated ${fit.estInputTokens}`)
  const out = await runEntryPlacelessPlan({ plan, scripted: entryStandIn(plan) })
  assert.deepEqual([out.sent, out.score.pass, out.score.wrong, out.dropped], [11, true, 0, ['c2-e3', 'c1-e1']])
  assert.equal((await runEntryPlacelessPlan({ plan })).stoppedBecause, 'dry_run'); assert.equal((await runEntryPlacelessPlan({ plan, send: true, key: null })).stoppedBecause, 'no_key')
  const enterAll = await runEntryPlacelessPlan({ plan, scripted: body => body.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'browser_entry_answer' ? 0.03 : 0.95 })) })
  assert.equal(enterAll.score.pass, false); assert.ok(enterAll.score.wrongReplies.every(id => id.startsWith('c')), 'a model that enters everything is caught on the controls')
  let calls = 0
  const failing = await runEntryPlacelessPlan({ plan, send: true, key: KEY, fetchImpl: async () => { calls++; return { status: 500, text: async () => '{}' } } })
  assert.deepEqual([calls, failing.sent], [1, 1])
  const ok = await runEntryPlacelessPlan({ plan, send: true, key: KEY, fetchImpl: async (url, init) => ({ status: 200, text: async () => JSON.stringify({ answers: entryStandIn(plan)(JSON.parse(init.body)), usage: { input_tokens: 800 } }) }) })
  assert.equal(ok.stoppedBecause, 'token_ceiling'); assert.ok(ok.usage.inputTokens <= 7500); assert.equal(JSON.stringify(ok).includes(KEY), false)
})
