import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry, ENTRY_ANSWER_ASK, ENTRY_WEB_ASK, entryEvidence, entryQuestions, entryWallEvidence, entryWallQuestions, readBrowserEntry, wallCandidates } from './egdesk-browser-task.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

// L8 c21: the settings entry (real, browser-live-settings-v2, 2026-11-25): the request predicate 0.90, the card predicate 0.19, so the
// entry did not enter. The body (rebuilt byte for byte by product code, sha256 6b1eb94e...) quoted the card by title and host only.
const MSG = '마케팅 알림 꺼줘'
const SHOWS = ['알림 설정', '마케팅 정보 알림: 켜짐', '보안 알림: 켜짐', '약관 안내']
function world({ allow = true, observe = 'ok', cards = [{ cardId: 'card', permission: 'interact' }], titles = { card: '알림 설정 | 계정' }, hosts = { card: 'account.example.test' }, answer = null } = {}) {
  const bodies = [], observed = []
  const client = createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-0008', fetchImpl: async (_u, init) => {
    bodies.push(init.body); const wire = JSON.parse(init.body)
    return { ok: true, text: async () => JSON.stringify({ answers: (answer ?? (() => wire.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'browser_entry_answer' ? 0.95 : 0.02 })) /* c33: nothing says web: answerable without a page */))(wire) }) } } })
  const provider = { directEntryEnabled: () => true,
    reflexScope: (_run, _call, cardId) => ({ client, isDecisionCurrent: () => true,
      callTool: async (name, args) => { observed.push([name, args.cardId, cardId]); if (observe === 'throw') throw new Error('gone'); return { observationId: 'o', snapshot: { text: SHOWS } } } }),
    runDirectTask: async () => ({ outcome: 'escalated', reason: 'human_step', steps: [], state: null }) }
  const entry = createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), cardTextInEntry: () => allow })
  const say = message => entry.handle({ run: { runId: 'r', browserBinding: { cards } }, conversationKey: 'dm', message, hosts, titles })
  return { say, bodies, observed }
}
const sha = text => createHash('sha256').update(text).digest('hex')

test('off (the default, or the run may not receive page text): the entry body is the real one, byte for byte, and no card is observed', async () => {
  const w = world({ allow: false })
  await w.say(MSG)
  // c27/c29: the request predicate's evidence lists the open pages, its question says what counts, and a second single-condition predicate asks whether the request
  // is answerable without any open page. The REAL c21 body is still reproduced byte for byte once exactly those changes are taken out: nothing else moved.
  const body = JSON.parse(w.bodies[0])
  assert.equal(body.input[1].content, 'User message: 마케팅 알림 꺼줘\nThe pages the user has open:\n- "알림 설정 | 계정" at "account.example.test"')
  assert.deepEqual(body.questions.slice(0, 2).map(q => [q.name, q.instructions]), [['browser_entry', ENTRY_WEB_ASK], ['browser_entry_answer', ENTRY_ANSWER_ASK]])
  const c21 = { ...body, input: [body.input[0], { ...body.input[1], content: 'User message: 마케팅 알림 꺼줘' }], questions: [{ ...body.questions[0], instructions: 'Is this request something to do in a web page rather than an answer?' }, body.questions[2]] }
  assert.equal(sha(JSON.stringify(c21)).slice(0, 12), '6b1eb94ef39b', 'the real c21 body, byte for byte, without the two c27 changes')
  assert.deepEqual(w.observed, [])
})

test('on: one observation per card (a read, no Decision request); the card predicate quotes its first three lines, each on its own', async () => {
  const w = world()
  await w.say(MSG)
  assert.deepEqual(w.observed, [['egdesk_browser_observe', 'card', 'card']])
  assert.equal(w.bodies.length, 1, 'still one Decision request for the entry')
  const card = JSON.parse(w.bodies[0]).questions.find(q => q.name === 'browser_entry_card_0')
  assert.equal(card.instructions, 'Does this request need to be done on this open page: "알림 설정 | 계정" at "account.example.test", which now shows "알림 설정" / "마케팅 정보 알림: 켜짐" / "보안 알림: 켜짐"?')
  assert.doesNotMatch(card.instructions, /약관 안내/, 'at most three lines')
  const off = world({ allow: false }); await off.say(MSG)
  assert.ok(Buffer.byteLength(w.bodies[0]) - Buffer.byteLength(off.bodies[0]) < 200, 'the card lines are a small addition (the c27 evidence adds the same lines once more)')
  assert.match(JSON.parse(w.bodies[0]).input[1].content, /\n- "알림 설정 \| 계정" at "account.example.test" shows "알림 설정" \/ "마케팅 정보 알림: 켜짐" \/ "보안 알림: 켜짐"$/, 'c27: the open page and its first lines are evidence for the request predicate')
  assert.deepEqual(JSON.parse(w.bodies[0]).questions.map(q => q.name), ['browser_entry', 'browser_entry_answer', 'browser_entry_card_0'], 'c23: the first entry request is unchanged; the interruption predicate is a follow-up only where it can matter')
})

test('the combination as designed: the real 0.90 / 0.19 is "the card is not the place" (not entered); a card decided yes on the page it shows enters', () => {
  const cards = [{ cardId: 'card', host: 'account.example.test', title: '알림 설정 | 계정' }]
  const P = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { type: 'predicate', probability: v }]))
  assert.equal(readBrowserEntry(P({ browser_entry: 0.90, browser_entry_card_0: 0.19 }), cards).kind, 'not_browser', 'one card decided no: the one-card rule does not apply')
  assert.equal(readBrowserEntry(P({ browser_entry: 0.90, browser_entry_card_0: 0.40 }), cards).cardId, 'card', 'an undecided card with a decided web task: the one granted card')
  assert.equal(readBrowserEntry(P({ browser_entry: 0.90, browser_entry_card_0: 0.90 }), cards).cardId, 'card')
})

test('skipped when code named the card (no card question is asked); a card that cannot be observed is quoted by title and host alone; lines are bounded', async () => {
  const named = world({ titles: { card: '마케팅 알림 | 계정' } })
  await named.say('마케팅 알림 꺼줘')
  assert.deepEqual([named.observed, JSON.parse(named.bodies[0]).questions.map(q => q.name)], [[], ['browser_entry', 'browser_entry_answer']])
  const gone = world({ observe: 'throw' })
  await gone.say(MSG)
  assert.equal(JSON.parse(gone.bodies[0]).questions[2].instructions, 'Does this request need to be done on this open page: "알림 설정 | 계정" at "account.example.test"?')
  const long = entryQuestions([{ cardId: 'c', host: 'a.example.test', title: 'T', shows: ['가'.repeat(200), 'x"y'] }])[2].instructions
  assert.ok(long.includes(`"${'가'.repeat(59)}…"`) || long.length < 200)
  assert.match(long, /"x'y"/, 'a quote inside a line cannot close the quoted line')
})

test('two cards, each quoting its own lines: the grouped request passes the grouping lint (each question carries its own page)', async () => {
  const w = world({ cards: [{ cardId: 'card', permission: 'interact' }, { cardId: 'card2', permission: 'interact' }], titles: { card: '알림 설정 | 계정', card2: '받은 편지함 | 메일' }, hosts: { card: 'account.example.test', card2: 'mail.example.test' } })
  await w.say(MSG)
  assert.equal(w.observed.length, 2)
  const body = JSON.parse(w.bodies[0])
  assert.equal(lintGroupedRequest(body).ok, true)
})

// ---- c22: the ride-along questions (appended to the turn-start request) are built exactly like the standalone entry's ----
import { decideBrowserEntry, observeCardLines, rideAlongEntry } from './egdesk-browser-task.mjs'
const RIDE_CARDS = [{ cardId: 'card', host: 'account.example.test', title: '알림 설정 | 계정' }]
const rideProvider = (calls = []) => ({ reflexScope: (_run, _call, cardId) => ({ callTool: async (name, args) => { calls.push([name, args.cardId, cardId]); return { observationId: 'o', snapshot: { text: SHOWS } } } }) })
test('ride-along, off (the run may not receive page text): the questions are the c21 ones byte for byte and no card is observed', async () => {
  const calls = []
  const ride = await rideAlongEntry({ provider: rideProvider(calls), run: {}, message: MSG, cards: RIDE_CARDS, cardText: false })
  assert.equal(JSON.stringify(ride.questions), JSON.stringify(entryQuestions(RIDE_CARDS)))
  assert.deepEqual([ride.codeCard, calls], [null, []])
})
test('ride-along, on: one observation per card, the same quoting as the standalone entry, the same fallback, nothing when code named the card', async () => {
  const calls = []
  const ride = await rideAlongEntry({ provider: rideProvider(calls), run: {}, message: MSG, cards: RIDE_CARDS, cardText: true })
  assert.deepEqual(calls, [['egdesk_browser_observe', 'card', 'card']])
  // the standalone entry, for the same cards and lines, asks the very same questions
  let standalone = null
  const client = { decide: async request => { standalone = request.questions; return { answers: {} } } }
  await decideBrowserEntry({ message: MSG, cards: await observeCardLines({ provider: rideProvider(), run: {}, message: MSG, cards: RIDE_CARDS, enabled: true }), client })
  assert.equal(JSON.stringify(ride.questions), JSON.stringify(standalone))
  assert.match(ride.questions[2].instructions, /which now shows "알림 설정" \/ "마케팅 정보 알림: 켜짐" \/ "보안 알림: 켜짐"\?$/)
  const failing = { reflexScope: () => ({ callTool: async () => { throw new Error('gone') } }) }
  assert.equal(JSON.stringify((await rideAlongEntry({ provider: failing, run: {}, message: MSG, cards: RIDE_CARDS, cardText: true })).questions), JSON.stringify(entryQuestions(RIDE_CARDS)), 'a card that cannot be observed: title and host')
  const named = []
  const byCode = await rideAlongEntry({ provider: rideProvider(named), run: {}, message: '알림 설정에서 마케팅 꺼줘', cards: RIDE_CARDS, cardText: true })
  assert.deepEqual([byCode.codeCard, byCode.questions.map(q => q.name), named], ['card', ['browser_entry', 'browser_entry_answer'], []])
})

// ---- c23: an interruption of the site never vetoes the card (real, browser-live-settings-v4: the error page's card predicate 0) ----
const ERROR_SHOWS = ['일시적인 오류가 발생했습니다.', '잠시 후 다시 시도해 주세요. (오류 500)']
const P2 = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { type: 'predicate', probability: v }]))
test('the interruption follow-up: only where it can matter (web task decided, no card yes, a card with known lines decided no), one predicate per such card quoting that page alone', () => {
  const cards = [{ cardId: 'a', host: 'account.example.test', title: '오류 | 계정', shows: ERROR_SHOWS }, { cardId: 'b', host: 'mail.example.test', title: '받은 편지함' }]
  const first = answers => readBrowserEntry(P2(answers), cards)
  assert.deepEqual(wallCandidates(first({ browser_entry: 0.9, browser_entry_card_0: 0.0, browser_entry_card_1: 0.05 }), cards), [0], 'card b has no known lines: not asked')
  assert.deepEqual(wallCandidates(first({ browser_entry: 0.9, browser_entry_card_0: 0.0, browser_entry_card_1: 0.9 }), cards), [], 'a card decided yes already enters')
  assert.deepEqual(wallCandidates(first({ browser_entry: 0.2, browser_entry_card_0: 0.0, browser_entry_card_1: 0.05 }), cards), [], 'an answer, not a web task')
  assert.deepEqual(wallCandidates(first({ browser_entry: 0.9, browser_entry_card_0: 0.5, browser_entry_card_1: 0.05 }), cards), [], 'an undecided card is not a no')
  const qs = entryWallQuestions(cards, [0])
  assert.deepEqual(qs.map(q => q.name), ['browser_entry_wall_0'])
  // c24 (real: the follow-up was REFUSED when the page was only inside the question): the question names the page; the lines are the evidence
  assert.equal(qs[0].instructions, 'Is this open page "오류 | 계정" at "account.example.test" an error page, a sign-in page or a check that stops it from showing its content?')
  assert.equal(entryWallEvidence('마케팅 알림 꺼줘', cards, [0]), 'User message: 마케팅 알림 꺼줘\n\nWhat the open page shows now (the first lines):\n- "오류 | 계정" at "account.example.test" shows "일시적인 오류가 발생했습니다." / "잠시 후 다시 시도해 주세요. (오류 500)"')
  assert.deepEqual(entryQuestions(cards).map(q => q.name), ['browser_entry', 'browser_entry_answer', 'browser_entry_card_0', 'browser_entry_card_1'], 'the first request has no wall question')
  assert.deepEqual(entryQuestions(cards, { codeCard: 'a' }).map(q => q.name), ['browser_entry', 'browser_entry_answer'], 'a card named by code asks nothing about the card, its lines never veto it')
})
test('real replay: web task .90, card .00 on an error page; the interruption predicate decides the page is a wall: the card is still the place (one card, or the one wall among cards decided no)', () => {
  const one = [{ cardId: 'card', host: 'account.example.test', title: '오류 | 계정', shows: ERROR_SHOWS }]
  assert.equal(readBrowserEntry(P2({ browser_entry: 0.90, browser_entry_card_0: 0.0 }), one).kind, 'not_browser', 'before: the real answers alone (no wall asked) did not enter')
  assert.equal(readBrowserEntry(P2({ browser_entry: 0.90, browser_entry_card_0: 0.0, browser_entry_wall_0: 0.95 }), one).cardId, 'card')
  assert.equal(readBrowserEntry(P2({ browser_entry: 0.90, browser_entry_card_0: 0.0, browser_entry_wall_0: 0.5 }), one).kind, 'not_browser', 'an undecided wall does not enter')
  assert.equal(readBrowserEntry(P2({ browser_entry: 0.10, browser_entry_card_0: 0.0, browser_entry_wall_0: 0.95 }), one).kind, 'not_browser', 'an answer, not a web task: a wall changes nothing')
  const two = [{ cardId: 'a', host: 'account.example.test', title: '오류', shows: ERROR_SHOWS }, { cardId: 'b', host: 'mail.example.test', title: '받은 편지함', shows: ['받은 편지함'] }]
  assert.equal(readBrowserEntry(P2({ browser_entry: 0.9, browser_entry_card_0: 0.0, browser_entry_card_1: 0.05, browser_entry_wall_0: 0.95, browser_entry_wall_1: 0.02 }), two).cardId, 'a', 'the one wall, the other card decided no')
  assert.equal(readBrowserEntry(P2({ browser_entry: 0.9, browser_entry_card_0: 0.0, browser_entry_card_1: 0.5, browser_entry_wall_0: 0.95 }), two).kind, 'ask_user', 'another card is undecided: the person is asked')
  assert.equal(readBrowserEntry(P2({ browser_entry: 0.9, browser_entry_card_0: 0.0, browser_entry_card_1: 0.9, browser_entry_wall_0: 0.95 }), two).cardId, 'b', 'a card decided yes wins over a wall')
  assert.equal(readBrowserEntry(P2({ browser_entry: 0.9, browser_entry_card_0: 0.0, browser_entry_card_1: 0.0, browser_entry_wall_0: 0.95, browser_entry_wall_1: 0.95 }), two).kind, 'not_browser', 'two walls: no card is chosen by a wall')
})
test('through the entry: the follow-up enters an error page and the step hands it over (the person sees the error); a normal page that is not the place is still not entered; the first request is as before', async () => {
  const run = async ({ shows, card, wall, rode = false }) => {
    const sent = []
    const answers = wire => wire.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'browser_entry' ? 0.9 : q.name === 'browser_entry_answer' ? 0.03 : q.name === 'browser_entry_card_0' ? card : wall }))
    const client = createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-0008', fetchImpl: async (_u, init) => { const wire = JSON.parse(init.body); sent.push(wire.questions.map(q => q.name)); return { ok: true, text: async () => JSON.stringify({ answers: answers(wire) }) } } })
    const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client, isDecisionCurrent: () => true, callTool: async () => ({ observationId: 'o', snapshot: { text: shows } }) }),
      runDirectTask: async () => ({ outcome: 'handoff', pageState: 'error_page', steps: [{ url: 'https://account.example.test/x', actions: [] }], state: null }) }
    const entry = createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), cardTextInEntry: () => true })
    const entryAnswers = rode ? { browser_entry: { type: 'predicate', probability: 0.9 }, browser_entry_card_0: { type: 'predicate', probability: card }, codeCard: null } : null
    const out = await entry.handle({ run: { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message: MSG, hosts: { card: 'account.example.test' }, titles: { card: '오류 | 계정' }, entryAnswers })
    return { out, sent }
  }
  for (const rode of [false, true]) {
    const wall = await run({ shows: ERROR_SHOWS, card: 0.0, wall: 0.95, rode })
    assert.deepEqual([wall.out.handled, JSON.parse(wall.out.note).egdesk_browser_task.code], [true, 'error_page'], `rode=${rode}`)
    assert.deepEqual(wall.sent, rode ? [['browser_entry_wall_0']] : [['browser_entry', 'browser_entry_answer', 'browser_entry_card_0'], ['browser_entry_wall_0']], 'the first request unchanged; one follow-up')
    const other = await run({ shows: ['환율 계산기'], card: 0.0, wall: 0.02, rode })
    assert.deepEqual([other.out.handled, other.out.reason], [false, 'not_browser'], `rode=${rode}`)
  }
  // c24: the follow-up as sent: the page lines are in the evidence, the question is about that page; a refusal (no probability) enters nothing
  const bodies = []
  const refusing = createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-0008', fetchImpl: async (_u, init) => { const wire = JSON.parse(init.body); bodies.push(wire)
    return { ok: true, text: async () => JSON.stringify({ answers: wire.questions.map(q => (q.name === 'browser_entry_wall_0' ? { name: q.name, type: 'refusal' } : { name: q.name, type: 'predicate', probability: q.name === 'browser_entry' ? 0.9 : 0.0 })) }) } } })
  const cards1 = [{ cardId: 'card', host: 'account.example.test', title: '오류 | 계정', shows: ERROR_SHOWS }]
  const decided = await decideBrowserEntry({ message: MSG, cards: cards1, client: refusing })
  assert.equal(decided.kind, 'not_browser', 'an unanswered follow-up is not a yes: the page is not entered')
  const followUp = bodies.find(b => b.questions.some(q => q.name === 'browser_entry_wall_0'))
  assert.match(followUp.input[1].content, /shows "일시적인 오류가 발생했습니다\." \/ "잠시 후 다시 시도해 주세요\. \(오류 500\)"/)
  assert.doesNotMatch(followUp.questions[0].instructions, /오류 500/)
  assert.equal(lintGroupedRequest({ input: followUp.input, questions: followUp.questions }).ok, true)
  const failing = await run({ shows: ERROR_SHOWS, card: 0.0, wall: 0.95 }) // control: the same answers, follow-up working
  assert.equal(failing.out.handled, true)
})

test('c27: the request predicate sees the open pages (title, site, first lines; a card named by code too); no card, no lines; the question says what counts', async () => {
  assert.deepEqual(entryEvidence([]), [])
  assert.deepEqual(entryEvidence([{ cardId: 'a', host: '', title: '' }]), [], 'a card with no identity adds nothing')
  assert.deepEqual(entryEvidence([{ cardId: 'a', host: 'streamly.example.test', title: '멤버십 관리 | 스트리밍플러스', shows: ['멤버십 관리', '다음 결제일: 2026-12-14'] }, { cardId: 'b', host: 'news.example.test', title: '오늘의 뉴스 | 경제일보' }]),
    ['The pages the user has open:', '- "멤버십 관리 | 스트리밍플러스" at "streamly.example.test" shows "멤버십 관리" / "다음 결제일: 2026-12-14"', '- "오늘의 뉴스 | 경제일보" at "news.example.test"'])
  // through the standalone entry: a card named by code (one question) still has its page in the evidence
  const w = world({ titles: { card: '마이페이지 | 한결병원' }, hosts: { card: 'carehosp.example.test' } })
  await w.say('한결병원 다음 진료 예약 날짜 알려줘')
  const body = JSON.parse(w.bodies[0])
  assert.deepEqual(body.questions.map(q => q.name), ['browser_entry', 'browser_entry_answer'])
  assert.equal(body.input[1].content, 'User message: 한결병원 다음 진료 예약 날짜 알려줘\nThe pages the user has open:\n- "마이페이지 | 한결병원" at "carehosp.example.test" shows "알림 설정" / "마케팅 정보 알림: 켜짐" / "보안 알림: 켜짐"'.replace(/ shows .*$/, ''), 'named by code: the lines are not read (nothing is observed for it)')
  assert.deepEqual(w.observed, [])
  assert.equal(lintGroupedRequest({ input: body.input, questions: body.questions }).ok, true)
  assert.ok(ENTRY_WEB_ASK.startsWith('Is this request about something that one of the open pages holds or shows, so that doing it means reading from or working in that page?') && ENTRY_WEB_ASK.includes("An account's own data, such as a date, an amount or a status, is held by its page."))
  assert.ok(ENTRY_ANSWER_ASK.startsWith('Can this be answered from general knowledge or the conversation alone, with no open page?') && ENTRY_ANSWER_ASK.includes('the answering model does not see them'))
  // the ride-along host receives the same evidence
  const { rideAlongEntry } = await import('./egdesk-browser-task.mjs')
  const ride = await rideAlongEntry({ provider: { reflexScope: () => ({ callTool: async () => ({ snapshot: { text: ['멤버십 관리', '다음 결제일: 2026-12-14'] } }) }) }, run: {}, message: '다음 결제일이 언제야?', cards: [{ cardId: 'card', host: 'streamly.example.test', title: '멤버십 관리 | 스트리밍플러스' }], cardText: true })
  assert.equal(ride.evidence, 'The pages the user has open:\n- "멤버십 관리 | 스트리밍플러스" at "streamly.example.test" shows "멤버십 관리" / "다음 결제일: 2026-12-14"')
  assert.equal(ride.questions[0].instructions, ENTRY_WEB_ASK)
})

test('c28: the ride-along host appends the entry evidence after the message (triage request); without it the triage request is byte for byte what it was', async () => {
  const { triageTurn } = await import('./egdesk-turn-memory.mjs')
  const bodies = []
  const client = { decide: async request => { bodies.push(JSON.stringify(request.input)); return { answers: {} } } }
  await triageTurn({ message: '다음 결제일이 언제야?', client, askedAt: 1 })
  await triageTurn({ message: '다음 결제일이 언제야?', client, askedAt: 1, extraEvidence: '' })
  await triageTurn({ message: '다음 결제일이 언제야?', client, askedAt: 1, extraEvidence: '   ' })
  assert.equal(new Set(bodies.slice(0, 3)).size, 1, 'no evidence: identical requests')
  const evidence = entryEvidence([{ cardId: 'a', host: 'streamly.example.test', title: '멤버십 관리 | 스트리밍플러스', shows: ['다음 결제일: 2026-12-14'] }]).join('\n')
  await triageTurn({ message: '다음 결제일이 언제야?', client, askedAt: 1, extraEvidence: evidence })
  const base = JSON.parse(bodies[0]), withEvidence = JSON.parse(bodies[3])
  assert.deepEqual(withEvidence.slice(0, base.length), base, 'everything before is unchanged')
  assert.deepEqual(withEvidence.slice(base.length), [{ role: 'user', content: evidence }], 'one extra user item, after the message')
})
