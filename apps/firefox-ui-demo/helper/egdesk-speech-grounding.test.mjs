import test from 'node:test'
import assert from 'node:assert/strict'
import { SPEECH_RULES, speechInterpretations, speechQuestions, speechSegments } from './egdesk-speech-grounding.mjs'

const texts = message => speechSegments(message).map(({ start, end }) => message.slice(start, end))
const enums = {
  source: ['self_reported_observation', 'attributed_report', 'inference', 'record_based', 'unspecified', 'unknown'],
  form: ['assertion', 'plan', 'conditional', 'question', 'unknown'],
  time: ['past_anchored', 'past_unspecified', 'at_utterance', 'ongoing_no_end', 'future_anchored', 'future_unspecified', 'unknown'],
}
const labels = { source: 'attributed_report', form: 'plan', time: 'future_anchored' }
const one = [{ start: 6, end: 31 }]
const choice = (value, other = 'unknown', top = 0.93, second = 0.05) => ({
  type: 'choice', choice: value, confidence: 0.85,
  probabilities: [{ value, probability: top }, { value: other, probability: second }],
})
const answersAt = (index, values = labels) => Object.fromEntries(Object.entries(values).map(([axis, value]) => [`speech_${axis}_${index}`, choice(value)]))
const onlyForm = answer => speechInterpretations({ ...answersAt(0), speech_form_0: answer }, one).filter(x => x.form !== 'unknown')

test('offsets refer to the original untrimmed UTF-16 string; repeated content stays distinct', () => {
  const sentence = '🧭 I saw the e\u0301 tag.'
  const input = `\t ${sentence}\r\n \u00a0${sentence}  `
  const end = 2 + sentence.length, next = end + 4
  assert.deepEqual(speechSegments(input), [{ start: 2, end }, { start: next, end: next + sentence.length }])
  assert.deepEqual(texts(input), [sentence, sentence])
})

test('abbreviations, initials, decimals, domains and ellipses do not invent breaks', () => {
  const first = 'Dr. J. Park at Example Inc. mentioned the U.S. site, e.g. lab.invalid, at 3.14.'
  const second = 'I waited... Then I paused … briefly . . . and left.'
  assert.deepEqual(texts(`${first} ${second} Next?`), [first, second, 'Next?'])
  for (const input of ['Only a trail...', 'Only a trail…', 'Only a trail . . .', 'Ask Dr.', 'The U.S.', '?!…', '  \r\n  ']) {
    assert.deepEqual(speechSegments(input), [], input)
  }
  assert.deepEqual(texts('One ended. This did not'), ['One ended.', 'This did not'])
  assert.deepEqual(texts('  내일 확인할 거야  '), ['내일 확인할 거야'])
  assert.deepEqual(texts('1. We left on May 5. Did you?'), ['1. We left on May 5.', 'Did you?'])
})

test('quotation, attribution and nesting stay intact; punctuation can be multilingual', () => {
  const a = 'Jo said, “I waited. Then I left!”'
  const b = '“Did it stop?” she asked.'
  const c = 'I checked (the sign read "it\'s open!").'
  assert.deepEqual(texts(`${a} ${b} ${c} Done?`), [a, b, c, 'Done?'])
  assert.deepEqual(texts('끝났다。다음이다！또 할까？'), ['끝났다。', '다음이다！', '또 할까？'])
  assert.deepEqual(texts('「済んだ。」と報告した。次だ。'), ['「済んだ。」と報告した。', '次だ。'])
  assert.deepEqual(texts('“Did it stop?” Rae asked. Then it stopped.'), ['“Did it stop?” Rae asked.', 'Then it stopped.'])
  assert.deepEqual(texts('One ended. She said “I left. Then I waited!'), ['One ended.'])
})

test('skip over-budget units whole, never return a prefix or suffix, cap at six', () => {
  const exact = 'z'.repeat(2047) + '.', long = 'q'.repeat(2048) + '.'
  const quote = '“I paused. ' + 'p'.repeat(2048) + '!”'
  const small = ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']
  assert.deepEqual(texts(`${long} ${exact} ${quote} ${small.join(' ')}`), [exact, ...small.slice(0, 5)])
  assert.deepEqual(texts(`${'p'.repeat(2046)}🧭.`), []) // 2049 UTF-16 code units
  for (const input of [null, undefined, 19, {}, Symbol('text')]) assert.deepEqual(speechSegments(input), [])
})

test('emit typed questions with all and only the enum choices; interpolate offsets, never speech', () => {
  const message = '  GreyToken901 left. BlueToken312 stayed?'
  const spans = speechSegments(message)
  const poisoned = spans.map(span => ({ ...span, priorQuote: 'PriorToken114', get text() { throw Error('text accessed') } }))
  const questions = speechQuestions(poisoned)
  assert.deepEqual(questions, speechQuestions(spans))
  assert.deepEqual(questions.map(q => q.name), ['speech_source_0', 'speech_form_0', 'speech_time_0', 'speech_source_1', 'speech_form_1', 'speech_time_1'])
  assert.doesNotMatch(JSON.stringify(questions), /PriorToken114|GreyToken901|BlueToken312/)
  for (const [i, span] of spans.entries()) for (const axis of Object.keys(enums)) {
    const q = questions.find(item => item.name === `speech_${axis}_${i}`)
    assert.equal(q.type, 'choice')
    assert.deepEqual(q.choices.map(x => x.value), enums[axis])
    assert.ok(q.choices.every(x => typeof x.description === 'string'))
    assert.ok(q.instructions.includes(`[${span.start}, ${span.end})`))
    assert.match(q.instructions, /current original untrimmed message/)
    assert.match(q.instructions, /UTF-16/)
    assert.match(q.instructions, /compound.*unknown/)
  }
})

test('compound statements stay whole: no clause splitting or keyword-based labels', () => {
  const message = 'I saw the lamp, but Jo plans to check it if she returns.'
  assert.deepEqual(texts(message), [message])
  const spans = speechSegments(message)
  assert.deepEqual(speechInterpretations({}, spans), [])
  const mixed = { ...answersAt(0), speech_source_0: choice('unknown', 'inference') }
  assert.deepEqual(speechInterpretations(mixed, spans), [{...spans[0], ...labels, source:'unknown'}])
})

test('bad ranges never enter prompts or redirect the answer index', () => {
  for (const spans of [null, {}, [null], [{ start: 'secret', end: 1 }], [{ start: -1, end: 1 }],
    [{ start: 0, end: 2049 }], [{ start: 1, end: 1 }], [{ start: 0, end: 1.5 }],
    [...one, ...one], Array(7).fill(one[0]), [{ get start() { throw Error('trap') }, end: 1 }]]) {
    assert.deepEqual(speechQuestions(spans), [])
    assert.deepEqual(speechInterpretations(answersAt(0), spans), [])
  }
})

test('emit only the five permitted fields, for independently complete spans, in original order', () => {
  const spans = [...one, { start: 35, end: 51 }, { start: 61, end: 73 }]
  const last = { source: 'unspecified', form: 'question', time: 'ongoing_no_end' }
  const all = { ...answersAt(2, last), ...answersAt(0), ...answersAt(1) }
  all.speech_form_1 = { type: 'refusal' }
  Object.assign(all.speech_source_0, { verified: true, quote: 'not the quote', start: 0, end: 1 })
  assert.deepEqual(speechInterpretations(all, spans), [{ ...one[0], ...labels }, { ...spans[1], ...labels, form:'unknown' }, { ...spans[2], ...last }])
  for (const axis of Object.keys(enums)) for (const value of enums[axis].filter(x => x !== 'unknown')) {
    const values = { ...labels, [axis]: value }
    assert.deepEqual(speechInterpretations(answersAt(0, values), one), [{ ...one[0], ...values }])
  }
})

test('confidence and actual winner margin are independent, inclusive checks', () => {
  const edge = choice('plan', 'unknown', 0.60, 0.40)
  assert.equal(onlyForm(edge).length, 1)
  assert.deepEqual(onlyForm({ ...edge, confidence: 0.849999 }), [])
  assert.deepEqual(onlyForm(choice('plan', 'unknown', 0.599999, 0.400001)), [])
  assert.deepEqual(onlyForm(choice('plan', 'unknown', 0.5999999999999999, 0.4000000000000001)), [])
  assert.deepEqual(onlyForm(choice('plan', 'unknown', 0.49, 0.51)), [])
  assert.equal(onlyForm({ ...edge, probabilities: [...edge.probabilities].reverse() }).length, 1)
  assert.deepEqual(onlyForm(choice('plan', 'unknown', 0.29, 0.05)), []) // unreported mass can win
  for (const axis of Object.keys(enums)) {
    const a = answersAt(0)
    a[`speech_${axis}_0`] = choice('unknown', enums[axis][0])
    assert.deepEqual(speechInterpretations(a, one), [{...one[0],...labels,[axis]:'unknown'}])
    delete a[`speech_${axis}_0`]
    assert.deepEqual(speechInterpretations(a, one), [{...one[0],...labels,[axis]:'unknown'}])
  }
})

test('malformed, unlisted, contradictory or unranked responses fail closed without coercion', () => {
  const ok = choice('plan'), row = ok.probabilities[0]
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const bad of [null, undefined, Symbol('x'), 3n, [], revoked.proxy, { type: 'refusal' }, { ...ok, type: 'predicate' },
    { ...ok, choice: false }, { ...ok, choice: '__proto__' }, { ...ok, choice: 'verified' }, { ...ok, choice: 'assertion' },
    ...['0.99', NaN, Infinity, -1, 1.01].map(confidence => ({ ...ok, confidence })),
    ...[null, undefined, {}, [], [row], Array(2), [row, null], [row, row], [row, {}],
      [row, { value: 'invented', probability: 0.01 }], [row, { value: 'unknown', probability: 0.90 }],
      [row, { value: 'unknown', probability: NaN }], [row, { value: 'unknown', probability: '0.01' }],
      [row, { value: 'unknown', probability: -0.01 }], [row, revoked.proxy], Object.assign(Array(1000), { 0: row }),
    ].map(probabilities => ({ ...ok, probabilities })),
    Object.create(ok), { ...ok, get probabilities() { throw Error('trap') } }]) {
    assert.deepEqual(onlyForm(bad), [])
  }
  assert.deepEqual(speechInterpretations({ ...answersAt(0), get speech_form_0() { throw Error('trap') } }, one), [{...one[0], ...labels, form:'unknown'}])
  for (const bad of [null, undefined, 99, 4n, Symbol('x'), [], revoked.proxy, Object.create(answersAt(0)),
    new Proxy({}, { getOwnPropertyDescriptor() { throw Error('trap') } })]) {
    assert.deepEqual(speechInterpretations(bad, one), [])
  }
})

test('native answer rules keep speech, clocks and evidence separate', () => {
  for (const term of [/fallible/i, /never physical verification/i, /another agent.*not independent/i,
    /plans.*hypotheses.*not establish completion/i, /spokenAt/, /historical UTC offset/i,
    /current question.*own clock/i, /never derive event time from storage/i,
    /unknown timing.*not an ongoing state/i, /no reported end.*not mean/i, /everyday language/i]) {
    assert.match(SPEECH_RULES, term)
  }
})
