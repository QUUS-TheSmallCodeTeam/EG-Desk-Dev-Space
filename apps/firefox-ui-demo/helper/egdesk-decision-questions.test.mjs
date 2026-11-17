import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DECISION_THRESHOLDS, choiceQuestion, compactText, decisionThresholds, readChoice, readPredicate, tableOptions, uniqueOptions } from './egdesk-decision-questions.mjs'

test('options get readable unique values and keep their items', () => {
  const options = uniqueOptions([
    { label: '  자세히   보기 ', description: 'first', item: 1 },
    { label: '자세히 보기', item: 2 },
    { label: '', item: 3 },
    { label: 'x'.repeat(300), item: 4 },
  ])
  assert.deepEqual(options.map(option => option.value).slice(0, 3), ['자세히 보기', '자세히 보기 (2)', 'item'])
  assert.ok(options[3].value.length <= 114 && options[3].value.endsWith('…'))
  assert.deepEqual(options.map(option => option.item), [1, 2, 3, 4])
  assert.equal(options[0].description, 'first')
  assert.equal(new Set(options.map(option => option.value)).size, options.length)
})

test('choice questions stay inside the published option range', () => {
  assert.throws(() => choiceQuestion('c', 'x', [{ value: 'only' }]), RangeError)
  assert.throws(() => choiceQuestion('c', 'x', Array.from({ length: 256 }, (_, index) => ({ value: `v${index}` }))), RangeError)
  const question = choiceQuestion('c', 'pick', tableOptions({ a: 'first', b: 'second' }))
  assert.deepEqual(question, { type: 'choice', name: 'c', instructions: 'pick', choices: [{ value: 'a', description: 'first' }, { value: 'b', description: 'second' }] })
})

test('readers turn refusals into unknown and apply confidence and margin', () => {
  const answers = {
    yes: { type: 'predicate', probability: 0.9 },
    no: { type: 'predicate', probability: 0.2 },
    refused: { type: 'refusal' },
    clear: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: [{ value: 'a', probability: 0.9 }, { value: 'b', probability: 0.05 }] },
    close: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: [{ value: 'a', probability: 0.5 }, { value: 'b', probability: 0.45 }] },
  }
  assert.deepEqual(readPredicate(answers, 'yes', 0.5), { state: 'yes', probability: 0.9 })
  assert.deepEqual(readPredicate(answers, 'no', 0.5), { state: 'no', probability: 0.2 })
  assert.deepEqual(readPredicate(answers, 'refused', 0.5), { state: 'unknown', probability: null })
  assert.deepEqual(readPredicate(answers, 'absent', 0.5), { state: 'unknown', probability: null })
  assert.equal(readChoice(answers, 'clear', { minConfidence: 0.75, minMargin: 0.2 }).state, 'accepted')
  const close = readChoice(answers, 'close', { minConfidence: 0.75, minMargin: 0.2 })
  assert.equal(close.state, 'uncertain')
  assert.equal(Math.round(close.margin * 100), 5)
  assert.equal(readChoice(answers, 'refused', { minConfidence: 0.5 }).state, 'unknown')
})

test('threshold overrides accept only probabilities for known keys', () => {
  const thresholds = decisionThresholds({ relevant: 0.6, choice: 7, unknownKey: 0.1 })
  assert.equal(thresholds.relevant, 0.6)
  assert.equal(thresholds.choice, DEFAULT_DECISION_THRESHOLDS.choice)
  assert.equal(Object.hasOwn(thresholds, 'unknownKey'), false)
  assert.equal(compactText(' a \n b ', 10), 'a b')
})
