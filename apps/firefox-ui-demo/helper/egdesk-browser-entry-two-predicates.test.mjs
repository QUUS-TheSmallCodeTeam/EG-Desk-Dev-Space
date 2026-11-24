// L8 c29: the request question is two single-condition predicates (owner decision, c28), combined by code. Real: with the page's billing line listed (card 0.98) the
// one-question form read "다음 결제일이 언제야?" as an answer at 0.01, in c31, c34 and c35 (three wordings).
import test from 'node:test'
import assert from 'node:assert/strict'
import { ENTRY_ANSWER, ENTRY_ANSWER_ASK, ENTRY_WEB, ENTRY_WEB_ASK, decideBrowserEntry, entryQuestions, readBrowserEntry } from './egdesk-browser-task.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { triageTurn } from './egdesk-turn-memory.mjs'

const cards = [{ cardId: 'card', host: 'streamly.example.test', title: '멤버십 관리 | 스트리밍플러스', shows: ['멤버십 관리', '이용 중인 요금제: 프리미엄', '다음 결제일: 2026-12-14'] }]
const P = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { type: 'predicate', probability: v }]))
const read = (o, list = cards, opts = {}) => readBrowserEntry(P(o), list, opts)

test('the questions: the page predicate, then the answer predicate, then one per card; each asks one thing', () => {
  const qs = entryQuestions(cards)
  assert.deepEqual(qs.map(q => [q.name, q.type]), [[ENTRY_WEB, 'predicate'], [ENTRY_ANSWER, 'predicate'], ['browser_entry_card_0', 'predicate']])
  assert.equal(qs[0].instructions, ENTRY_WEB_ASK)
  assert.equal(qs[1].instructions, ENTRY_ANSWER_ASK)
  assert.doesNotMatch(ENTRY_WEB_ASK, /rather than an answer/, 'no "A rather than B" in one question')
  assert.deepEqual(entryQuestions(cards, { codeCard: 'card' }).map(q => q.name), [ENTRY_WEB, ENTRY_ANSWER], 'a card named by code: the two request predicates only')
})

test('code combines them: a decided yes on "answerable without any page" is an answer whatever else was said; otherwise the page predicate decides as before', () => {
  // the real membership numbers of c34/c35 (page predicate .01, card .98) are an answer in either form: that is the page predicate's own answer, no bar moved
  assert.equal(read({ browser_entry: 0.01, browser_entry_answer: 0.9, browser_entry_card_0: 0.98 }).kind, 'not_browser')
  // the page predicate yes and the answer predicate NOT decided yes enters (the case the one-question form could not reach)
  for (const answer of [0.02, 0.4, 0.74]) assert.equal(read({ browser_entry: 0.9, browser_entry_answer: answer, browser_entry_card_0: 0.98 }).cardId, 'card', `answer ${answer}`)
  // both decided yes: the request is answerable without a page, so nothing is entered (an answer wins, even with a card decided yes)
  assert.equal(read({ browser_entry: 0.9, browser_entry_answer: 0.8, browser_entry_card_0: 0.98 }).kind, 'not_browser')
  assert.equal(read({ browser_entry: 0.9, browser_entry_answer: 0.8 }, cards, { codeCard: 'card' }).kind, 'not_browser', 'also when code named the card')
  // the answer predicate never enters anything by itself, and an undecided page predicate stays undecided
  assert.equal(read({ browser_entry: 0.5, browser_entry_answer: 0.02, browser_entry_card_0: 0.98 }).cardId, 'card', 'the one card decided yes with a not-decided-no request: the card rules as before')
  assert.equal(read({ browser_entry: 0.1, browser_entry_answer: 0.02, browser_entry_card_0: 0.98 }).kind, 'not_browser', 'the page predicate decided no stays an answer')
  // no answer predicate (older riders, fixtures): exactly as before
  assert.equal(read({ browser_entry: 0.9, browser_entry_card_0: 0.98 }).cardId, 'card')
  assert.equal(read({ browser_entry: 0.02, browser_entry_card_0: 0.98 }).kind, 'not_browser')
  // the numbers are kept for the calibration log
  assert.deepEqual([read({ browser_entry: 0.9, browser_entry_answer: 0.4, browser_entry_card_0: 0.98 }).web, read({ browser_entry: 0.9, browser_entry_answer: 0.4, browser_entry_card_0: 0.98 }).answerP], [0.9, 0.4])
})

test('through decideBrowserEntry: one request with both predicates and the open pages as evidence; the membership request enters when the page predicate says so', async () => {
  const bodies = []
  const client = createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-0008', fetchImpl: async (_u, init) => { const wire = JSON.parse(init.body); bodies.push(wire)
    const p = { browser_entry: 0.93, browser_entry_answer: 0.04, browser_entry_card_0: 0.98 }
    return { ok: true, text: async () => JSON.stringify({ answers: wire.questions.map(q => ({ name: q.name, type: 'predicate', probability: p[q.name] ?? 0.02 })) }) } } })
  const out = await decideBrowserEntry({ message: '다음 결제일이 언제야?', cards, client })
  assert.equal(out.kind, 'browser')
  assert.equal(bodies.length, 1)
  assert.deepEqual(bodies[0].questions.map(q => q.name), ['browser_entry', 'browser_entry_answer', 'browser_entry_card_0'])
  assert.match(bodies[0].input[1].content, /"다음 결제일: 2026-12-14"$/, 'the billing line is evidence (as in the real runs)')
  assert.equal(lintGroupedRequest({ input: bodies[0].input, questions: bodies[0].questions }).ok, true)
})

test('the ride-along carries all the entry predicates (the two request predicates and the cards), not only the first two', async () => {
  const sent = []
  const client = { decide: async request => { sent.push(request.questions.map(q => q.name)); return { answers: {} } } }
  const riders = entryQuestions([{ cardId: 'a', host: 'a.example.test', title: 'A site' }, { cardId: 'b', host: 'b.example.test', title: 'B site' }])
  const out = await triageTurn({ message: 'x', client, askedAt: 1, extraQuestions: riders })
  assert.deepEqual(sent[0].slice(-4), ['browser_entry', 'browser_entry_answer', 'browser_entry_card_0', 'browser_entry_card_1'])
  assert.deepEqual(Object.keys(out.extra), ['browser_entry', 'browser_entry_answer', 'browser_entry_card_0', 'browser_entry_card_1'])
})
