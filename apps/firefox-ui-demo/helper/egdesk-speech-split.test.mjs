// The 'split-isolated' sentence-label design for the write judgment (L7 c20): source and time as yes/no predicates, combined by code at the
// speech bar (.85 / .15). The axes design stays the default and is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SPEECH_DESIGNS, SPEECH_SPLIT, SPEECH_SPLIT_BARS, SPEECH_SPLIT_KEYS, SPEECH_THRESHOLDS, WRITE_SPEECH_DESIGNS, speechDesignInterpretations,
  speechDesignQuestions, speechIsolatedQuestions, speechSegments, speechSplitQuestions, splitLabels } from './egdesk-speech-grounding.mjs'
import { judgeTurnWrite } from './egdesk-turn-memory.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

const yes = 0.9, no = 0.05
const v = map => Object.fromEntries(Object.entries(map).map(([k, x]) => [k, x === 'y' ? 'yes' : x === 'n' ? 'no' : 'unknown']))
const srcN = { other: 'n', own: 'n', record: 'n', guess: 'n' }, timeN = { before: 'n', now: 'n', ongoing: 'n', after: 'n', when: 'n' }

test('the bar is the speech bar, not lowered: yes at >= .85, no at <= .15', () => {
  assert.equal(SPEECH_SPLIT_BARS.yes, SPEECH_THRESHOLDS.confidence)
  assert.deepEqual(SPEECH_SPLIT_BARS, { yes: 0.85, no: 0.15 })
  assert.deepEqual(WRITE_SPEECH_DESIGNS, ['axes-isolated', 'split-isolated', 'hybrid-isolated', 'hybrid-two-step'])
  assert.ok(!SPEECH_DESIGNS.includes(SPEECH_SPLIT), 'not a turn-level design')
})

test('source: exactly one basis yes and the rest no gives it; all no gives unspecified; several or undecided gives unknown', () => {
  assert.equal(splitLabels(v({ ...srcN, other: 'y' })).source, 'attributed_report')
  assert.equal(splitLabels(v({ ...srcN, own: 'y' })).source, 'self_reported_observation')
  assert.equal(splitLabels(v({ ...srcN, record: 'y' })).source, 'record_based')
  assert.equal(splitLabels(v({ ...srcN, guess: 'y' })).source, 'inference')
  assert.equal(splitLabels(v(srcN)).source, 'unspecified')
  assert.equal(splitLabels(v({ ...srcN, other: 'y', own: 'y' })).source, 'unknown')
  assert.equal(splitLabels(v({ ...srcN, record: '?' })).source, 'unknown')
  assert.equal(splitLabels({}).source, 'unknown', 'a missing answer is never a no')
})

test('time: one direction (now+ongoing counts as ongoing), the anchor decides past/future, anything else unknown', () => {
  const t = map => splitLabels(v({ ...timeN, ...map })).time
  assert.equal(t({ before: 'y', when: 'y' }), 'past_anchored')
  assert.equal(t({ before: 'y' }), 'past_unspecified')
  assert.equal(t({ after: 'y', when: 'y' }), 'future_anchored')
  assert.equal(t({ after: 'y' }), 'future_unspecified')
  assert.equal(t({ now: 'y' }), 'at_utterance')
  assert.equal(t({ now: 'y', when: 'y' }), 'unknown', 'about now but naming a day or time: conflicting times (c23 a16)')
  assert.equal(t({ now: 'y', when: '?' }), 'at_utterance', 'an undecided anchor does not block now (c23 c08: when .26)')
  assert.equal(t({ ongoing: 'y' }), 'ongoing_no_end')
  assert.equal(t({ ongoing: 'y', now: 'y' }), 'ongoing_no_end')
  assert.equal(t({ before: 'y', when: '?' }), 'unknown', 'an undecided anchor installs no past label')
  assert.equal(t({ before: 'y', now: 'y' }), 'unknown', 'two times in one sentence')
  assert.equal(t({ before: 'y', after: 'y', when: 'y' }), 'unknown')
  assert.equal(t({}), 'unknown', 'no direction stated')
  assert.equal(t({ after: '?' }), 'unknown')
})

test('one-sentence message: nine predicates about the message plus the form axis; several sentences: each quoted', () => {
  const one = '메일 보니까 견적 회신이 이미 와 있어.'
  const qs = speechSplitQuestions(speechSegments(one), one)
  assert.deepEqual(qs.map(q => q.name), ['speech_form_0', ...SPEECH_SPLIT_KEYS.source.map(k => `speechs_${k}_0`), ...SPEECH_SPLIT_KEYS.time.map(k => `speechs_${k}_0`)])
  assert.deepEqual(qs[0], speechIsolatedQuestions(speechSegments(one), one).find(q => q.name === 'speech_form_0'), 'form is the axes question, unchanged')
  for (const q of qs.slice(1)) { assert.equal(q.type, 'predicate'); assert.match(q.instructions, /^The message is a single sentence; judge it\. /); assert.ok(!q.instructions.includes(one)) }
  const two = '어제 배포했어. 내일 점검하자.'
  const spans = speechSegments(two), q2 = speechSplitQuestions(spans, two)
  assert.equal(spans.length, 2)
  assert.equal(q2.length, 20)
  for (const q of q2.filter(q => q.name.endsWith('_1') && q.type === 'predicate')) assert.ok(q.instructions.includes(JSON.stringify('내일 점검하자.')))
  assert.equal(lintGroupedRequest({ input: [{ role: 'user', content: two }], questions: q2 }).ok, true)
  assert.deepEqual(speechDesignQuestions(SPEECH_SPLIT, spans, two), q2)
})

test('interpretations: same shape and vocabulary as the axes design; form from its axis question', () => {
  const one = '민지 씨가 그러는데 어제 배포는 문제없이 끝났대.', spans = speechSegments(one)
  const answers = { speech_form_0: { type: 'choice', choice: 'assertion', confidence: 0.97, probabilities: [{ value: 'assertion', probability: 0.97 }, { value: 'plan', probability: 0.02 }] } }
  const p = (key, x) => { answers[`speechs_${key}_0`] = { type: 'predicate', probability: x } }
  p('other', yes); p('own', no); p('record', no); p('guess', no); p('before', yes); p('now', no); p('ongoing', no); p('after', no); p('when', yes)
  assert.deepEqual(speechDesignInterpretations(SPEECH_SPLIT, answers, spans), [{ start: 0, end: one.length, source: 'attributed_report', form: 'assertion', time: 'past_anchored' }])
  p('other', 0.84) // just under the bar: undecided, no source label
  assert.equal(speechDesignInterpretations(SPEECH_SPLIT, answers, spans)[0].source, 'unknown')
  p('other', yes); p('own', 0.16)
  assert.equal(speechDesignInterpretations(SPEECH_SPLIT, answers, spans)[0].source, 'unknown')
})

test('judgeTurnWrite: the default request is unchanged; split only when asked; any other value is the default', async () => {
  const bodyOf = async speechDesign => { const seen = []
    await judgeTurnWrite({ message: '그 버그는 내가 고쳤어.', candidates: [], client: { async decide(r) { seen.push(r); return { answers: {} } } }, askedAt: Date.parse('2026-11-27T10:00:00+09:00'), targetDesign: 'about', ...(speechDesign ? { speechDesign } : {}) })
    return JSON.stringify(seen[0]) }
  const base = await bodyOf(null)
  assert.equal(await bodyOf('axes-isolated'), base)
  assert.equal(await bodyOf('predicates'), base)
  const split = JSON.parse(await bodyOf(SPEECH_SPLIT))
  assert.ok(split.questions.some(q => q.name === 'speechs_own_0'))
  assert.ok(!split.questions.some(q => q.name === 'speech_source_0' || q.name === 'speech_time_0'))
  assert.ok(split.questions.some(q => q.name === 'speech_form_0'))
  assert.deepEqual(split.input, JSON.parse(base).input, 'same input; only the label questions differ')
})

test('the context selection\'s rules are unchanged unless the action set is asked for', async () => {
  const { prepareTurnContext } = await import('./egdesk-context-setup.mjs')
  const seen = []
  const client = { async decide(r) { seen.push(r); return { answers: {}, model: 'gpt-6-luna', usage: { input_tokens: 1 }, latencyMs: 1 } } }
  const candidates = [{ id: 'ontology:a', kind: 'timeline', title: '롤백 절차', summary: '', timeSlice: 'present' }]
  await prepareTurnContext({ message: '전체 테스트 돌리고 결과 알려줘', candidates, client })
  await prepareTurnContext({ message: '전체 테스트 돌리고 결과 알려줘', candidates, client, ruleSet: 'other' })
  await prepareTurnContext({ message: '전체 테스트 돌리고 결과 알려줘', candidates, client, ruleSet: 'action' })
  assert.equal(seen[0].input[0].content.split('\n').length, 3)
  assert.equal(seen[1].input[0].content, seen[0].input[0].content)
  assert.equal(seen[2].input[0].content, `${seen[0].input[0].content}\n${seen[2].input[0].content.split('\n')[3]}`)
  assert.deepEqual(seen[2].questions, seen[0].questions, 'the questions are unchanged')
})

test('the write-judgment flag reaches the turn-memory config only with its exact value', async () => {
  const { createTurnMemoryConfig } = await import('./egdesk-turn-memory-wiring.mjs')
  const base = { settings: { turnMemory: { mode: 'on' } }, getAdapter: () => ({}) }
  assert.equal(Object.hasOwn(createTurnMemoryConfig(base), 'speechDesign'), false)
  assert.equal(createTurnMemoryConfig({ ...base, speechDesign: 'split-isolated' }).speechDesign, 'split-isolated')
  assert.equal(Object.hasOwn(createTurnMemoryConfig({ ...base, speechDesign: 'predicates' }), 'speechDesign'), false)
})
