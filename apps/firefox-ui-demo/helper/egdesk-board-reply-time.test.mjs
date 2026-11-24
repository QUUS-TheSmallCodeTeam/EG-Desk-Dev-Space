// Board reply screening and time (L1 cycle 12). Real measurement 2026-11-24: an excerpt about last year's, since-closed visitor parking was judged
// relevant at .99 and last term's refund rule at .83, so they would have gone into the reply as if current.
// What an approved excerpt carries, from the product code: the owner types plain strings (egdesk-board-agent-ask.mjs validateExcerpts, at most 8 of
// at most 1,500 bytes); the Desk stores them as a JSON array of strings (writeBoardAgentAskPolicy). No date, version or "superseded by" link of its own,
// so there is nothing for a code rule to compute (R3). The excerpt's own words can tell. L1 c13, after the v2 measurement (.96 for parking "closed in
// January 2026": the statement is still true, the arrangement is not): a SECOND request, only for the excerpts decided relevant, asks per excerpt
// "does the arrangement this excerpt describes still apply on <the date the question is about>?" (that date found by code, else today), and code
// combines: relevant AND applies is offered; relevant but not is dated and never offered.
// Synthetic: temp SQLite Desk, the real service, the real selector, the real Decisions client over a mock fetch, the real draft transport over a mock fetch.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { rmSync } from 'node:fs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { BOARD_AGENT_IN_EFFECT_BAR, BOARD_AGENT_RELEVANCE_BAR, localDay, questionDate, readScreeningInput, selectBoardAgentContext } from './egdesk-board-agent-context.mjs'
import { createBoardAgentDraftTransport } from './egdesk-board-agent-draft.mjs'
import { createDecisionClient, DECISION_MODEL } from './egdesk-decision-client.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'
import { normalizeEntry } from './egdesk-decision-calibration-log.mjs'

const NOW = Date.parse('2026-11-24T10:00:00+09:00')
const QUESTION = '이번 주 금요일 공개 설명회 방문자는 어디에 주차하나요?'
const CURRENT = '공개 설명회 방문자는 체육관 뒤 제2주차장을 이용합니다.'
const DATED = '작년 가을 설명회까지는 정문 앞 임시 주차장을 썼으며, 그 주차장은 올해 1월에 폐쇄되었습니다.'
const OTHER = '구내식당 점심 메뉴는 매주 월요일 게시판에 올라옵니다.'
const E = [OTHER, CURRENT, DATED]
const profile = { lifecycle: 'active', activeRevision: 1, active: { revision: 1, hash: 'a'.repeat(64), body: { name: 'Sim Agent', model: null } } }

// The provider reads what it is sent: relevance and "in effect" per excerpt, from the excerpt's own quoted text.
function provider(posts, { relevant = text => /주차/.test(text), current = text => !/작년|폐쇄/.test(text), drop = null } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body); posts.push(body)
    const sent = readScreeningInput(body.input), textOf = alias => sent.candidates.find(c => c.alias === alias).text
    const answers = body.questions.filter(q => q.name !== drop).map(q => {
      const alias = q.name.replace(/_now$/, ''), yes = q.name.endsWith('_now') ? current(textOf(alias)) : relevant(textOf(alias))
      return { name: q.name, type: 'predicate', probability: yes ? 0.96 : 0.04 }
    })
    return Response.json({ model: DECISION_MODEL, answers })
  }
}
function machine(t, { mode = 'on', respond } = {}) {
  const root = createPrivateQaTempDirectory('egdesk-board-time-')
  const desk = openDeskStore({ dataDir: path.join(root, 'desk'), ownerScope: 'board-time' })
  desk.saveBoard('board-time', { body: { version: 1, agenda: { id: 'board-time', title: 'Sim Board' }, cards: [], shapes: [] }, expectedRevision: null })
  const posts = [], drafted = [], log = []
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0001', fetchImpl: respond(posts) })
  const draft = createBoardAgentDraftTransport({ readConfig: () => ({ apiKey: 'egd-synthetic-draft-not-a-key-0002', model: 'synthetic-draft' }), fetchImpl: async (url, init) => {
    drafted.push(JSON.parse(JSON.parse(init.body).input[0].content[0].text).excerpts)
    return Response.json({ object: 'response', status: 'completed', model: 'synthetic-draft', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '초안입니다.' }] }] })
  } })
  const service = createBoardAgentAskService({ desk, profiles: { get: id => (id === 'p' ? profile : null) }, selectContext: selectBoardAgentContext, now: () => NOW,
    decisionStatus: () => ({ mode, model: DECISION_MODEL, bindingId: 'b', client }), draft, calibrationLog: { record: e => { log.push(normalizeEntry(e, NOW)); return 'c1' }, outcome() {} } })
  t.after(() => { service.close(); desk.close(); rmSync(root, { recursive: true, force: true }) })
  let version = service.policy({ boardId: 'board-time', action: 'save', expectedVersion: null, profileId: 'p', excerpts: E, publicInstructions: '' }).policy.version
  const ask = async runMode => {
    const issued = service.policy({ boardId: 'board-time', action: 'issue', expectedVersion: version }); version = issued.policy.version
    const request = { kind: 'request', requestId: '8878a7f3-df6b-4383-af12-6ae38ad4fe2e', requestDigest: 'b'.repeat(64), question: QUESTION, recipient: '소유자', excerpt: '', expectedReply: 'short', askCode: issued.askCode }
    const prepared = service.prepare({ boardId: 'board-time', request, mode: runMode })
    return service.run({ ticket: prepared.ticket, confirm: true })
  }
  return { ask, posts, drafted, log }
}

test('what is asked: relevance for every excerpt, then the arrangement question ONLY for the relevant ones, on the date the question is about', async t => {
  const m = machine(t, { respond: posts => provider(posts) })
  await m.ask('draft')
  assert.equal(m.posts.length, 2)
  const first = readScreeningInput(m.posts[0].input), second = readScreeningInput(m.posts[1].input)
  assert.deepEqual(first, { question: QUESTION, today: '2026-11-24', candidates: E.map((text, i) => ({ alias: `c${i + 1}`, text })) }); assert.equal(localDay(NOW), '2026-11-24')
  assert.deepEqual(m.posts[0].questions.map(q => q.name), ['c1', 'c2', 'c3'], 'yes/no relevance per excerpt, nothing else')
  // the canteen excerpt is not relevant: it is not asked about time at all (R3), and its words do not travel again
  assert.deepEqual(second, { question: QUESTION, today: '2026-11-24', about: '2026-11-27', candidates: [{ alias: 'c2', text: CURRENT }, { alias: 'c3', text: DATED }] })
  assert.deepEqual(m.posts[1].questions, ['c2', 'c3'].map(a => ({ type: 'predicate', name: `${a}_now`, instructions: `Does the arrangement this excerpt describes (excerpt ${a}) still apply on 2026-11-27?` })))
  for (const [i, row] of m.posts[1].input.slice(2).entries()) for (const other of E.filter(text => text !== second.candidates[i].text)) assert.ok(!row.content.includes(other), 'each excerpt quoted on its own')
  assert.equal(BOARD_AGENT_RELEVANCE_BAR, 0.6); assert.equal(BOARD_AGENT_IN_EFFECT_BAR, 0.5)
})
test('the date the question is about is a code rule: stated dates, this/next week\'s weekday, tomorrow, a month; else today', () => {
  const at = Date.parse('2026-11-24T12:00:00Z') // a Tuesday
  const cases = [['이번 주 금요일(11월 27일) 설명회 주차는?', '2026-11-27'], ['이번 주 금요일 주차는?', '2026-11-27'], ['다음 주 월요일 회의실은?', '2026-11-30'], ['내일 셔틀 시간은?', '2026-11-25'],
    ['2026-12-03 일정은?', '2026-12-03'], ['2026년 12월 5일 행사', '2026-12-05'], ['겨울 학기 워크숍(12월 시작) 환불은?', '2026-12'], ['2027년 1월 일정', '2027-01'], ['3월 2일 개강 준비물은?', '2027-03-02']]
  for (const [q, when] of cases) assert.deepEqual(questionDate(q, at), { when, stated: true }, q)
  for (const q of ['현재 스탠다드 요금제(2026년 개정판)의 월 요금은?', '2월 30일 행사', '설명회 주차는 어디?']) assert.deepEqual(questionDate(q, at), { when: '2026-11-24', stated: false }, q)
})
test('on: a relevant excerpt whose arrangement no longer applies is DATED and never offered as the current answer; nothing relevant -> no time question', async t => {
  const m = machine(t, { respond: posts => provider(posts) })
  const result = await m.ask('draft')
  assert.deepEqual(m.drafted, [[CURRENT]], 'the drafting model gets the current excerpt only: last year\'s parking is not offered')
  assert.equal(result.screening, 'decision')
  // the calibration family of the Board reply: relevance per excerpt, the time judgment only where it was asked; numbers and closed words only
  const [entry] = m.log
  assert.deepEqual(entry.judgments.filter(j => j.q === 'relevance').map(j => [j.p, j.would]), [[0.96, 'attach'], [0.96, 'attach'], [0.04, 'skip']])
  assert.deepEqual(entry.judgments.filter(j => j.q === 'in_effect').map(j => [j.p, j.threshold, j.would]), [[0.96, 0.5, 'accept'], [0.04, 0.5, 'reject']])
  assert.ok(!JSON.stringify(entry).includes('주차'))
  // if every relevant excerpt is dated, none is offered: the owner writes the reply (no draft request is made)
  const allDated = machine(t, { respond: posts => provider(posts, { current: () => false }) })
  const none = await allDated.ask('draft')
  assert.deepEqual([allDated.drafted, none.answer], [[], ''], 'nothing current to offer')
  // nothing relevant: one request only, and no time question for anything
  const unrelated = machine(t, { respond: posts => provider(posts, { relevant: () => false }) })
  await unrelated.ask('draft')
  assert.deepEqual([unrelated.posts.length, unrelated.posts[0].questions.length], [1, 3])
})
test('a missing or malformed "in effect" answer is never read as "in effect": the response is unusable and the word match stands, as for any bad answer; advisory and extract are unchanged', async t => {
  const missing = machine(t, { respond: posts => provider(posts, { drop: 'c3_now' }) })
  const r1 = await missing.ask('draft')
  assert.equal(r1.screening, 'fallback'); assert.deepEqual(missing.drafted.length, 1); assert.equal(missing.posts.length, 2)
  assert.deepEqual(missing.log[0].fallback, 'bad_response')
  // advisory: both questions are asked and recorded; the selection is today's word match
  const advisory = machine(t, { mode: 'advisory', respond: posts => provider(posts) })
  const r2 = await advisory.ask('draft')
  assert.equal(r2.screening, 'advisory'); assert.equal(advisory.posts.length, 2); assert.equal(advisory.log[0].judgments.filter(j => j.q === 'in_effect').length, 2, 'asked for the two relevant excerpts only')
  // extract: nothing is sent to any model, so not to Decisions either (cycle 7), and the word match has no notion of time (a limit, see report)
  const extract = machine(t, { respond: posts => provider(posts) })
  const r3 = await extract.ask('extract')
  assert.deepEqual([extract.posts.length, r3.source], [0, 'local'])
})
