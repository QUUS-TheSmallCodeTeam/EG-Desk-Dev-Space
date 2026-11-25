import test from 'node:test'
import assert from 'node:assert/strict'
import { FAST_ANSWER_BARS, FAST_ANSWER_LIMITS, decideFastAnswer, fastCandidates, fastCarryText, fastQuestions, fastTurn, splitSentences } from './egdesk-memory-fast-answer.mjs'
import { SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { buildWiki, reconstructMemory } from './egdesk-wiki-reconstruction.mjs'

// Pure parts of the fast answer: the sentence splitter, the code floors, the Decision answers read by code. The Decision model is a scripted stand-in
// (it answers by question name, the way the real one is read); the picked records come from the repo's own loop on the synthetic wiki.
const SCOPE = { allowedScopes: ['dm:this-room'] }
const RETENTION = '롤백은 몇 분 안에 하기로 했지?'
const wiki = buildWiki(SYNTHETIC_PAGES)
// prepareTurnMemory's result shape: the loop's own output is result.memory
const picked = async (message, w = wiki) => ({ memory: await reconstructMemory({ message, wiki: w, client: mockJudge(), scope: SCOPE, mode: 'first', delivered: null, budget: { linksFirst: true } }) })
// the scripted Decision: `by` maps a question name to a probability; unlisted fa_ans_/fa_alone_ default to 0.02, fa_more to 0.02
const scripted = (by = {}, calls = []) => ({ async decide(request) {
  calls.push(request)
  return { answers: Object.fromEntries(request.questions.map(q => [q.name, { type: 'predicate', probability: by[q.name] ?? 0.02 }])), usage: { inputTokens: 1 } }
} })
const run = async (message, by, extra = {}) => { const calls = []; const result = await picked(message, extra.wiki); const outcome = await decideFastAnswer({ message, result, wiki: extra.wiki ?? wiki, scope: SCOPE, client: scripted(by, calls), ...extra.options }); return { outcome, calls, result } }

test('splitSentences: by line item and by sentence end; bullets and numbers go; a decimal stays whole', () => {
  assert.deepEqual(splitSentences('문제가 생기면 SQLite 백업으로 30분 안에 되돌린다. 롤백 판단은 헬스체크 실패 시점에 한다.'), ['문제가 생기면 SQLite 백업으로 30분 안에 되돌린다.', '롤백 판단은 헬스체크 실패 시점에 한다.'])
  assert.deepEqual(splitSentences('- 알림 채널 확인\n- 캐시 비우기\r\n2) 백업 7일 보관'), ['알림 채널 확인', '캐시 비우기', '백업 7일 보관'])
  assert.deepEqual(splitSentences('보관 기간은 47.5일이다. 끝났다!'), ['보관 기간은 47.5일이다.', '끝났다!'])
  assert.deepEqual(splitSentences(' \n  \n'), [])
  assert.deepEqual(splitSentences(null), [])
})

test('the loop picked one settled record: its two sentences are the candidates, in order', async () => {
  const result = await picked(RETENTION)
  assert.deepEqual(result.memory.picks.map(p => p.id), ['db/pg-rollback'])
  const found = fastCandidates({ result, wiki, scope: SCOPE })
  assert.equal(found.ok, true)
  assert.deepEqual(found.pages.map(p => [p.id, p.status, p.sentences.length]), [['db/pg-rollback', 'done', 2]])
  assert.equal(found.pages[0].sentences[0], '문제가 생기면 SQLite 백업으로 30분 안에 되돌린다.')
})

test('floors: every record that is not settled, readable and its own sends the turn to the engine without a Decision request', async () => {
  const page = (over = {}) => ({ id: 'x/one', title: '기록', body: '백업은 47일 보관한다.', revision: '1', time: { slice: 'past' }, provenance: { kind: 'own_record' }, status: 'done', links: [], ...over })
  const check = (over, options = {}) => {
    const w = buildWiki([page(over), ...(options.others ?? [])])
    return fastCandidates({ result: { memory: { status: 'ready', picks: [{ id: 'x/one', ...(options.pick ?? {}) }, ...(options.others ?? []).map(p => ({ id: p.id }))] } }, wiki: w, scope: options.scope ?? SCOPE })
  }
  assert.equal(check({}).ok, true)
  assert.equal(check({ status: 'plan', time: { slice: 'planned' } }).ok, true, 'a plan that is recorded as a plan is settled as a plan')
  assert.equal(check({ status: 'reported_by_other' }).reason, 'status_not_settled')
  assert.equal(check({ status: 'unknown' }).reason, 'status_not_settled')
  assert.equal(check({ status: 'superseded' }).reason, 'status_not_settled')
  assert.equal(check({}, { pick: { statusRead: 'plan' } }).reason, 'status_read_differs')
  assert.equal(check({}, { pick: { statusRead: 'done' } }).ok, true)
  assert.equal(check({ statusReadings: [{ status: 'done', state: 'pending' }] }).reason, 'reading_pending')
  assert.equal(check({ statusReadings: [{ status: 'done', state: 'accepted' }] }).ok, true)
  assert.equal(check({ time: { slice: 'hypothetical' } }).reason, 'time_unsettled')
  assert.equal(check({ time: { slice: 'unknown' } }).reason, 'time_unsettled')
  assert.equal(check({ provenance: { kind: 'utterance' } }).reason, 'provenance_not_own')
  assert.equal(check({ provenance: { kind: 'reported_by_other' } }).reason, 'provenance_not_own')
  assert.equal(check({ mayRead: () => true }).reason, 'guarded_record')
  assert.equal(check({ ref: 'chat-message:abc' }).reason, 'guarded_record')
  assert.equal(check({ scope: 'dm:other-room' }).reason, 'not_permitted')
  assert.equal(check({ body: `${'가'.repeat(FAST_ANSWER_LIMITS.sentenceChars + 1)}.` }).reason, 'sentence_too_long')
  assert.equal(check({ body: Array.from({ length: FAST_ANSWER_LIMITS.sentences + 1 }, (_, i) => `항목 ${i + 1}번 끝.`).join('\n') }).reason, 'too_many_sentences')
  assert.equal(check({}, { others: [page({ id: 'x/two' }), page({ id: 'x/three' }), page({ id: 'x/four' })] }).reason, 'too_many_records')
  assert.equal(fastCandidates({ result: { memory: { status: 'ready', picks: [] } }, wiki, scope: SCOPE }).reason, 'no_picked_record')
  assert.equal(fastCandidates({ result: { memory: { status: 'empty', picks: [{ id: 'x' }] } }, wiki, scope: SCOPE }).reason, 'no_picked_record')
  assert.equal(fastCandidates({ result: { memory: { status: 'ready', picks: [{ id: 'nope/missing' }] } }, wiki, scope: SCOPE }).reason, 'record_missing')
  const replaced = buildWiki([page(), page({ id: 'x/new', title: '새 기록', body: '백업은 30일 보관한다.', links: [{ type: 'supersedes', to: 'x/one' }] })])
  assert.equal(fastCandidates({ result: { memory: { status: 'ready', picks: [{ id: 'x/one' }] } }, wiki: replaced, scope: SCOPE }).reason, 'superseded')
})

test('five picked records (one of them only relays what a lead said) never reach the Decision model', async () => {
  const { outcome, calls } = await run('A사 견적 v2 팀장 승인 기한이 언제야?', { fa_ans_0: 0.99 })
  assert.deepEqual([outcome.use, outcome.reason, outcome.calls], [false, 'too_many_records', 0])
  assert.equal(calls.length, 0)
})

test('questions: one for the message, then two per sentence, each quoting only that sentence', async () => {
  const questions = fastQuestions({ message: RETENTION, pages: [{ id: 'p', title: 't', status: 'done', sentences: ['첫째 문장이다.', '둘째 문장이다.'] }] })
  assert.deepEqual(questions.map(q => q.name), ['fa_more', 'fa_ans_0', 'fa_alone_0', 'fa_ans_1', 'fa_alone_1'])
  assert.ok(questions.every(q => q.type === 'predicate'))
  assert.ok(questions[0].instructions.includes(RETENTION) && !/첫째|둘째/.test(questions[0].instructions), 'the message question quotes no sentence')
  for (const [i, other] of [[1, '둘째'], [2, '둘째'], [3, '첫째'], [4, '첫째']]) assert.ok(!questions[i].instructions.includes(other), `${questions[i].name} quotes its own sentence only`)
  assert.ok(questions.slice(1).every(q => !/titl|\bt\b|status/.test(q.instructions.replace(RETENTION, ''))), 'no title, id or status is sent')
})

test('one sentence clearly the answer, the message needs nothing more, the sentence stands alone: use it, with one request', async () => {
  const { outcome, calls } = await run(RETENTION, { fa_ans_0: 0.97 })
  assert.deepEqual([outcome.use, outcome.text, outcome.pageId, outcome.p, outcome.calls], [true, '문제가 생기면 SQLite 백업으로 30분 안에 되돌린다.', 'db/pg-rollback', 0.97, 1])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].questions.length, 5)
})

test('every doubt is the engine: under the bar, unanswered, a second candidate, needs more, unclear alone, a failed request', async () => {
  const doubt = async (by, expected, options) => { const { outcome } = await run(RETENTION, by, options); assert.deepEqual([outcome.use, outcome.reason], [false, expected], JSON.stringify(by)) }
  await doubt({ fa_ans_0: FAST_ANSWER_BARS.answer - 0.01 }, 'no_sentence_is_the_answer')
  await doubt({}, 'no_sentence_is_the_answer')
  await doubt({ fa_ans_0: 0.97, fa_ans_1: 0.95 }, 'several_sentences')
  await doubt({ fa_ans_0: 0.97, fa_ans_1: 0.5 }, 'another_sentence_unsure')
  assert.equal((await run(RETENTION, { fa_ans_0: 0.97, fa_ans_1: 0.49 })).outcome.use, true, 'a second sentence just under the unsure bar is not a candidate')
  await doubt({ fa_ans_0: 0.97, fa_more: 0.21 }, 'needs_more_than_a_sentence')
  await doubt({ fa_ans_0: 0.97, fa_more: 0.9 }, 'needs_more_than_a_sentence')
  await doubt({ fa_ans_0: 0.97, fa_alone_0: 0.21 }, 'sentence_needs_context')
  await doubt({ fa_ans_0: 0.97, fa_alone_0: 0.9 }, 'sentence_needs_context')
  const result = await picked(RETENTION)
  const failing = await decideFastAnswer({ message: RETENTION, result, wiki, scope: SCOPE, client: { async decide() { throw Object.assign(new Error('x'), { code: 'timeout' }) } } })
  assert.deepEqual([failing.use, failing.reason, failing.calls], [false, 'timeout', 1])
  const silent = await decideFastAnswer({ message: RETENTION, result, wiki, scope: SCOPE, client: { async decide() { return { answers: {} } } } })
  assert.deepEqual([silent.use, silent.reason], [false, 'unanswered'])
  const noMore = await decideFastAnswer({ message: RETENTION, result, wiki, scope: SCOPE, client: { async decide(r) { return { answers: Object.fromEntries(r.questions.filter(q => q.name !== 'fa_ans_1').map(q => [q.name, { type: 'predicate', probability: q.name === 'fa_ans_0' ? 0.97 : 0.02 }])) } } } })
  assert.deepEqual([noMore.use, noMore.reason], [false, 'unanswered'], 'a sentence without an answer is never taken as a "no"')
  const noMessage = await decideFastAnswer({ message: RETENTION, result, wiki, scope: SCOPE, client: { async decide(r) { return { answers: Object.fromEntries(r.questions.filter(q => q.name !== 'fa_more').map(q => [q.name, { type: 'predicate', probability: q.name === 'fa_ans_0' ? 0.97 : 0.02 }])) } } } })
  assert.deepEqual([noMessage.use, noMessage.reason], [false, 'unanswered'], 'a message question without an answer is never taken as a "no"')
})

test('a message that is empty or long is never judged', async () => {
  const result = await picked(RETENTION)
  for (const message of ['', '   ', 'ㅇ'.repeat(FAST_ANSWER_LIMITS.messageChars + 1)]) {
    const outcome = await decideFastAnswer({ message, result, wiki, scope: SCOPE, client: scripted({ fa_ans_0: 0.99 }) })
    assert.deepEqual([outcome.use, outcome.reason, outcome.calls], [false, 'message_unsuited', 0])
  }
})

test('the bars are the owner-facing numbers: the answer bar is above the loop\'s yes, "no" is the loop\'s no', () => {
  assert.equal(FAST_ANSWER_BARS.answer, 0.9); assert.equal(FAST_ANSWER_BARS.no, 0.2); assert.equal(FAST_ANSWER_BARS.unsure, 0.5)
  assert.ok(Object.isFrozen(FAST_ANSWER_BARS) && Object.isFrozen(FAST_ANSWER_LIMITS))
})

test('fastTurn is an engine turn that already finished with one final answer; the carry text names the question and the sentence only', () => {
  const { turn } = fastTurn('30분 안에 되돌린다.')
  assert.equal(turn.status, 'completed'); assert.match(turn.id, /^egdesk-fast-/)
  assert.deepEqual(turn.items.map(i => [i.type, i.phase, i.text]), [['agentMessage', 'final_answer', '30분 안에 되돌린다.']])
  assert.notEqual(fastTurn('x').turn.id, fastTurn('x').turn.id)
  const carry = fastCarryText('롤백은?', '30분 안에 되돌린다.')
  assert.ok(carry.includes('롤백은?') && carry.includes('30분 안에 되돌린다.'))
})
