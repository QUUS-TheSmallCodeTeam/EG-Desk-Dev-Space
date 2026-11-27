// L8 c29: the request question is two single-condition predicates (owner decision, c28), combined by code. Real: with the page's billing line listed (card 0.98) the
// one-question form read "다음 결제일이 언제야?" as an answer at 0.01, in c31, c34 and c35 (three wordings).
import test from 'node:test'
import assert from 'node:assert/strict'
import { ENTRY_ANSWER, ENTRY_ANSWER_ASK, ENTRY_WEB, ENTRY_WEB_ASK, createBrowserTaskStore, createDirectBrowserEntry, decideBrowserEntry, entryQuestions, readBrowserEntry, wallCandidates } from './egdesk-browser-task.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { triageTurn } from './egdesk-turn-memory.mjs'
import { pageTextFor } from './egdesk-page-text.fixture.mjs'
pageTextFor(["c33: through the entry the real numbers end as an error_page"]) // a1: these pin what was sent WITH the page text (the flag on for them only; the default is off)

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

// ---- c33: the settings error page (real, browser-live-settings-current, 5 runs, 0 passes on the current bytes) ----
const errorCards = [{ cardId: 'card', host: 'account.example.test', title: '오류 | 계정', shows: ['일시적인 오류가 발생했습니다.', '잠시 후 다시 시도해 주세요. (오류 500)'] }]
const REAL = { browser_entry: 0.14, browser_entry_answer: 0, browser_entry_card_0: 0.52 } // the real numbers

test('c33: a request that cannot be answered without a page, on an open page the page predicate says does not hold it, asks the interruption follow-up; a decided interruption enters, an ordinary page does not', () => {
  const first = read(REAL, errorCards)
  assert.equal(first.kind, 'not_browser', 'without the follow-up this is the failed real run')
  assert.deepEqual(wallCandidates(first, errorCards), [0], 'the follow-up is asked (it was not: it ran only for a decided web task)')
  assert.equal(read({ ...REAL, browser_entry_wall_0: 1 }, errorCards).cardId, 'card', 'the page is an interruption: it enters, the step hands the page over')
  assert.equal(read({ ...REAL, browser_entry_wall_0: 0.02 }, errorCards).kind, 'not_browser', 'an ordinary page that does not hold the request is still not entered')
  assert.equal(read({ ...REAL, browser_entry_wall_0: 0.5 }, errorCards).kind, 'not_browser', 'an undecided interruption does not enter')
  // the controls stay out: answerable without a page never reaches the follow-up, whatever the page shows
  const control = read({ browser_entry: 0.02, browser_entry_answer: 0.95, browser_entry_card_0: 0.1 }, errorCards)
  assert.deepEqual([control.kind, wallCandidates(control, errorCards)], ['not_browser', []])
  assert.equal(read({ browser_entry: 0.02, browser_entry_answer: 0.95, browser_entry_card_0: 0.1, browser_entry_wall_0: 1 }, errorCards).kind, 'not_browser', 'even a decided interruption does not enter an answer')
  // a page without known lines is not asked; a card decided yes already enters
  assert.deepEqual(wallCandidates(first, [{ cardId: 'card', host: 'account.example.test', title: '오류 | 계정' }]), [])
  assert.deepEqual(wallCandidates(read({ ...REAL, browser_entry_card_0: 0.9 }, errorCards), errorCards), [])
  // two cards: exactly one interruption and every other card decided no
  const two = [...errorCards, { cardId: 'mail', host: 'mail.example.test', title: '받은 편지함', shows: ['받은 편지함'] }]
  assert.equal(read({ ...REAL, browser_entry_card_1: 0.05, browser_entry_wall_0: 1, browser_entry_wall_1: 0.02 }, two).cardId, 'card')
  assert.equal(read({ ...REAL, browser_entry_card_1: 0.05, browser_entry_wall_0: 1, browser_entry_wall_1: 1 }, two).kind, 'not_browser', 'two interruptions: no card')
  assert.notEqual(read({ ...REAL, browser_entry_card_1: 0.5, browser_entry_wall_0: 1 }, two).kind, 'browser', 'another card undecided: not entered on a wall')
})

test('c33: through the entry the real numbers end as an error_page hand-over after one follow-up request that quotes the page', async () => {
  const sent = []
  const answers = wire => wire.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'browser_entry_wall_0' ? 1 : REAL[q.name] ?? 0 }))
  const client = createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-0008', fetchImpl: async (_u, init) => { const wire = JSON.parse(init.body); sent.push(wire); return { ok: true, text: async () => JSON.stringify({ answers: answers(wire) }) } } })
  const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client, isDecisionCurrent: () => true, callTool: async () => ({ observationId: 'o', snapshot: { text: errorCards[0].shows } }) }),
    runDirectTask: async () => ({ outcome: 'handoff', pageState: 'error_page', steps: [{ url: 'https://account.example.test/x', actions: [] }], state: null }) }
  const entry = createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), cardTextInEntry: () => true })
  const out = await entry.handle({ run: { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message: '마케팅 알림 꺼줘', hosts: { card: 'account.example.test' }, titles: { card: '오류 | 계정' } })
  assert.deepEqual([out.handled, JSON.parse(out.note).egdesk_browser_task.code], [true, 'error_page'])
  assert.deepEqual(sent.map(b => b.questions.map(q => q.name)), [['browser_entry', 'browser_entry_answer', 'browser_entry_card_0'], ['browser_entry_wall_0']])
  assert.match(sent[1].input[1].content, /"일시적인 오류가 발생했습니다\."/)
  assert.equal(lintGroupedRequest({ input: sent[1].input, questions: sent[1].questions }).ok, true)
})
