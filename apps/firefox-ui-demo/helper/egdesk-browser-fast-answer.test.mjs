// L8 c36 (U13 R-C): the fast answer decision. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FAST_MORE, decideFastAnswer, fastAnswerText, fastLines, fastLineName, fastQuestions } from './egdesk-browser-fast-answer.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

const NOTE = { status: 'done', page: ['멤버십 관리', '이용 중인 요금제: 프리미엄', '다음 결제일: 2026-12-14', '결제 금액: 14,900원'] }
const client = (lineYes, more, seen = []) => ({ decide: async req => { seen.push(req); return { usage: { input_tokens: 50 }, answers: Object.fromEntries(req.questions.map(q => [q.name, { type: 'predicate', probability: q.name === FAST_MORE ? more : (lineYes.includes(Number(q.name.split('_')[2])) ? 0.96 : 0.02) }])) } } })

test('only a finished task has lines: found first, else the page\'s own lines (bounded); a hand-over or a question has none', () => {
  assert.deepEqual(fastLines(NOTE), NOTE.page)
  assert.deepEqual(fastLines({ status: 'done', found: ['a'], page: ['b'] }), ['a'])
  assert.equal(fastLines({ status: 'done', page: Array.from({ length: 20 }, (_, i) => `줄 ${i}`) }).length, 8)
  for (const status of ['cannot_proceed', 'need_context']) assert.deepEqual(fastLines({ status, page: ['x'] }), [])
  assert.deepEqual(fastLines(null), [])
})

test('the request: one predicate per line quoting that line alone, one about the request; the grouped lint passes', async () => {
  const qs = fastQuestions(NOTE.page)
  assert.deepEqual(qs.map(q => q.name), [0, 1, 2, 3].map(fastLineName).concat([FAST_MORE]))
  assert.equal(qs[2].instructions, 'Does this line from the page, "다음 결제일: 2026-12-14", answer the request by itself?')
  const seen = []
  await decideFastAnswer({ message: '다음 결제일이 언제야?', note: NOTE, client: client([2], 0.03, seen) })
  assert.equal(seen.length, 1, 'one request')
  assert.equal(seen[0].input[1].content, 'Request: 다음 결제일이 언제야?')
  assert.equal(lintGroupedRequest({ input: seen[0].input, questions: seen[0].questions }).ok, true)
})

test('code decides: exactly one line yes and the question decided to need no more -> show that line verbatim; every other case is the engine', async () => {
  const run = (yes, more) => decideFastAnswer({ message: 'q', note: NOTE, client: client(yes, more) })
  const shown = await run([2], 0.03)
  assert.deepEqual([shown.kind, shown.line, shown.text, shown.reason], ['show', '다음 결제일: 2026-12-14', '다음 결제일: 2026-12-14', 'one_line_decided'])
  assert.equal(fastAnswerText('  다음 결제일: 2026-12-14 '), '다음 결제일: 2026-12-14', 'nothing is added')
  assert.deepEqual([(await run([], 0.03)).kind, (await run([], 0.03)).reason], ['engine', 'no_line_decided'])
  assert.deepEqual([(await run([2, 3], 0.03)).kind, (await run([2, 3], 0.03)).reason], ['engine', 'several_lines'])
  for (const more of [0.5, 0.9, 0.16]) assert.deepEqual([(await run([2], more)).kind, (await run([2], more)).reason], ['engine', 'needs_more_than_a_line'], `more ${more}`)
  assert.equal((await run([2], 0.15)).kind, 'show', 'the bar itself (1 - the done bar) is decided no')
  assert.deepEqual([(await decideFastAnswer({ message: 'q', note: { status: 'cannot_proceed' }, client: client([0], 0) })).kind], ['none'])
  assert.deepEqual([(await decideFastAnswer({ message: 'q', note: NOTE, client: { decide: async () => { throw new Error('down') } } })).kind], ['engine'], 'any failure is the engine')
  assert.equal((await decideFastAnswer({ message: 'q', note: NOTE, client: { decide: async () => ({ answers: {} }) } })).kind, 'engine', 'no answers: the engine')
})
