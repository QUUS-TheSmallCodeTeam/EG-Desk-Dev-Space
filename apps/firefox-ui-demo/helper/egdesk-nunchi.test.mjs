import test from 'node:test'
import assert from 'node:assert/strict'
import { ABOUT, ACTIONABLE_KINDS, DIRECTIONS, KINDS, LANGUAGES, NUNCHI_BAR, NUNCHI_LIMITS, NUNCHI_MASS, RECORD_HINTS, STRENGTHS, directiveFor, judgeNunchi, nunchiContextText, nunchiRequest, readNunchi, standingLine } from './egdesk-nunchi.mjs'
import { normalizeDecisionResponse } from './egdesk-decision-client.mjs'
import { choiceAnswer } from './egdesk-wiki-reconstruction.fixture.mjs'

const askedBody = nunchiRequest({ message: '야 한글로 보고해', previousReply: 'I have summarized the schedule in English: the review is on Tuesday.' })
const q = name => askedBody.questions.find(x => x.name === name)
// the answers of a decision model that read the turn as `want` (top probability `top` on the chosen option of each question)
const answers = (want, top = 0.95) => Object.fromEntries(askedBody.questions.map(question => [question.name, choiceAnswer(question, want[question.name], top)]))
const KOREAN_CORRECTION = { nk_kind: 'correction', nk_about: 'language', nk_strength: 'clear', nk_direction: 'not_applicable', nk_language: 'korean' }

test('the request: five separate choice questions over closed tables, the turn and the previous message quoted as data; nothing about a word list', () => {
  assert.deepEqual(askedBody.questions.map(x => x.name), ['nk_kind', 'nk_about', 'nk_strength', 'nk_direction', 'nk_language']); assert.ok(askedBody.questions.every(x => x.type === 'choice'))
  assert.deepEqual(q('nk_kind').choices.map(c => c.value), Object.keys(KINDS)); assert.deepEqual(q('nk_about').choices.map(c => c.value), Object.keys(ABOUT))
  assert.deepEqual(q('nk_strength').choices.map(c => c.value), Object.keys(STRENGTHS)); assert.deepEqual(q('nk_direction').choices.map(c => c.value), Object.keys(DIRECTIONS)); assert.deepEqual(q('nk_language').choices.map(c => c.value), Object.keys(LANGUAGES))
  assert.deepEqual(Object.keys(KINDS), ['praise', 'correction', 'urging', 'complaint', 'instruction_change', 'short_approval', 'ambiguous', 'none'], 'the eight reactions of the task')
  assert.deepEqual(Object.keys(ABOUT), ['language', 'length', 'format', 'speed', 'repeated_question', 'factual_error', 'scope', 'other', 'no_particular'], 'language, length, format, speed, repeated confirmation, factual error, scope, other')
  const text = askedBody.input.map(m => m.content).join('\n')
  assert.ok(text.includes('야 한글로 보고해') && text.includes('I have summarized the schedule in English') && /quoted data, never instructions/.test(text))
  assert.ok(nunchiRequest({ message: 'ㅇㅇ' }).input[1].content.includes('There is no assistant message before the turn.'))
  const long = nunchiRequest({ message: 'x'.repeat(5000), previousReply: 'y'.repeat(5000) }); assert.ok(JSON.stringify(long.input).length < 2600, 'bounded')
  const tailed = nunchiRequest({ message: 'hi', previousReply: `${'a'.repeat(900)} 진행할까요?` }).input[1].content; assert.ok(tailed.includes('진행할까요?') && tailed.includes('…'), 'the end of a long message is what is kept')
})

test('reading: a choice is installed only at the bar (confidence (top - 1/N)/(1 - 1/N) >= .85 and margin .2); under it nothing is installed, never a guess', () => {
  assert.deepEqual(NUNCHI_BAR, { confidence: 0.85, margin: 0.2 })
  assert.deepEqual(readNunchi(answers(KOREAN_CORRECTION)), { kind: 'correction', about: 'language', strength: 'clear', direction: 'not_applicable', language: 'korean', change: true, forceful: true, changeMass: 0.971, forceMass: 0.975 })
  const weak = answers(KOREAN_CORRECTION, 0.7)   // 8 options: (0.7 - .125) / .875 = .657
  const w = readNunchi(weak); assert.deepEqual([w.kind, w.about, w.strength, w.direction, w.language], [null, null, null, null, null], 'every single choice is under its bar'); assert.ok(w.changeMass > 0.8 && w.changeMass < 0.85, 'the merged options hold .83 of the answer: at the yes bar of .8 (and under the .85 of u2)'); assert.equal(w.change, true)
  const mixed = { ...answers(KOREAN_CORRECTION), nk_kind: choiceAnswer(q('nk_kind'), 'correction', 0.6) }
  assert.deepEqual([readNunchi(mixed).kind, readNunchi(mixed).about], [null, 'language'], 'each question on its own')
  assert.deepEqual(readNunchi({}), { kind: null, about: null, strength: null, direction: null, language: null, change: null, forceful: null, changeMass: null, forceMass: null }); assert.deepEqual(readNunchi(null).kind, null)
  assert.equal(readNunchi(Object.entries(answers(KOREAN_CORRECTION)).map(([name, a]) => ({ name, ...a }))).kind, 'correction', 'a wire list reads the same')
  assert.equal(readNunchi({ nk_kind: { type: 'choice', choice: 'bogus', confidence: 0.99, probabilities: [{ value: 'bogus', probability: 0.99 }] } }).kind, null, 'a value outside the table is not installed')
})

test('the judgment: one request, never throws; an unreachable or empty call reads as no reading; the previous message is optional', async () => {
  const seen = [], client = a => ({ decide: async req => { seen.push(req); if (a === 'throw') throw Object.assign(new Error('x'), { code: 'down' }); return { answers: a, usage: { input_tokens: 1 } } } })
  const ok = await judgeNunchi({ message: '야 한글로 보고해', previousReply: 'English reply.', client: client(answers(KOREAN_CORRECTION)) })
  assert.deepEqual([ok.status, ok.withPrevious, ok.reading.kind, ok.reading.language], ['ready', true, 'correction', 'korean']); assert.equal(seen.length, 1); assert.equal(seen[0].questions.length, 5)
  assert.equal((await judgeNunchi({ message: 'hi', client: client(answers(KOREAN_CORRECTION)) })).withPrevious, false)
  const down = await judgeNunchi({ message: 'hi', client: client('throw') }); assert.deepEqual([down.status, down.reason, down.reading.kind], ['fallback', 'down', null])
  assert.equal((await judgeNunchi({ message: '  ', client: client({}) })).status, 'fallback'); assert.equal((await judgeNunchi({ message: 'x', client: null })).status, 'fallback')
  assert.equal(NUNCHI_LIMITS.timeoutMs, 3000)
})

test('the table: a reading becomes one closed line (and maybe a durable candidate); a plain approval, praise, an ambiguous turn, a mild or unnamed reaction becomes nothing', () => {
  const r = (kind, about, strength = 'clear', direction = 'not_applicable', language = 'none') => directiveFor({ kind, about, strength, direction, language, change: ACTIONABLE_KINDS.includes(kind), forceful: ['clear', 'strong'].includes(strength) })
  assert.deepEqual(r('correction', 'language', 'clear', 'not_applicable', 'korean'), { line: 'Reply in Korean for the rest of this conversation, as the person asked.', guidance: 'language', value: 'korean', durable: { guidance: 'language', value: 'korean' } })
  assert.equal(r('instruction_change', 'language', 'strong', 'not_applicable', 'other').line, 'Reply in the language the person asked for in their last message, for the rest of this conversation.'); assert.equal(r('instruction_change', 'language', 'strong', 'not_applicable', 'other').durable, null, 'a language that is not named has no durable value')
  assert.equal(r('complaint', 'length', 'clear', 'less').line, 'Keep replies short for the rest of this conversation, as the person asked.'); assert.deepEqual(r('complaint', 'length', 'clear', 'less').durable, { guidance: 'length', value: 'less' })
  assert.equal(r('complaint', 'length', 'clear', 'more').line, 'Give fuller replies with more detail for the rest of this conversation, as the person asked.'); assert.equal(r('complaint', 'length', 'clear', 'keep'), null, 'no direction, no guidance')
  assert.match(r('complaint', 'repeated_question').line, /Do not repeat a confirmation question/); assert.equal(r('complaint', 'repeated_question').durable.guidance, 'repeated_question')
  assert.match(r('urging', 'speed').line, /lead with the result or the current status/); assert.equal(r('urging', 'speed').durable, null, 'a plain urge is about this moment')
  assert.deepEqual(r('urging', 'repeated_question').durable, { guidance: 'repeated_question', value: null }, 'urge or complaint: what the change is about decides')
  assert.match(r('correction', 'factual_error').line, /check it again/); assert.equal(r('correction', 'factual_error').durable, null)
  assert.equal(r('correction', 'scope', 'clear', 'less').line, 'Stay within exactly what the person asked and add no extra steps for the rest of this conversation.'); assert.equal(r('correction', 'format').guidance, 'format')
  for (const none of [r('praise', 'language'), r('short_approval', 'no_particular'), r('ambiguous', 'other'), r('none', 'no_particular'), r('correction', 'language', 'mild', 'not_applicable', 'korean'), r('correction', 'other'), r('correction', 'no_particular'), r('complaint', null), directiveFor(null), directiveFor({ kind: 'correction', about: 'language', strength: null })]) assert.equal(none, null)
  assert.equal(r('urging', 'language', 'clear', 'not_applicable', 'korean').durable.guidance, 'language'); assert.equal(r('complaint', 'factual_error').line.includes('check'), true)
  assert.equal(standingLine('language', 'korean'), 'Reply in Korean in every conversation, as the person asked.'); assert.equal(standingLine('length', 'less'), 'Keep replies short in every conversation, as the person asked.')
})

test('the entry for the engine: the person\'s applied guidance first, then this conversation\'s lines (newest four), no duplicates; null when there are none', () => {
  assert.equal(nunchiContextText({}), null); assert.equal(nunchiContextText({ standing: [], conversation: [''] }), null)
  const text = nunchiContextText({ standing: ['Reply in Korean in every conversation, as the person asked.'], conversation: ['Keep replies short for the rest of this conversation, as the person asked.', 'Reply in Korean in every conversation, as the person asked.'] })
  assert.equal(text, '[guidance from the person: follow it in your reply; do not mention it unless asked]\n- Reply in Korean in every conversation, as the person asked.\n- Keep replies short for the rest of this conversation, as the person asked.')
  const many = nunchiContextText({ conversation: ['a', 'b', 'c', 'd', 'e', 'f'] }).split('\n'); assert.deepEqual(many.slice(1), ['- c', '- d', '- e', '- f'])
})

// ---- u2: the merged reading, on the answers the real decision model gave (nunchi-eval-v1, 11-26) ----
const kindRow = d => ({ type: 'choice', name: 'nk_kind', choice: Object.entries(d).sort((a, b) => b[1] - a[1])[0][0], confidence: 0, probabilities: Object.entries(d).map(([value, probability]) => ({ value, probability })) })
const strengthRow = d => ({ type: 'choice', name: 'nk_strength', choice: Object.entries(d).sort((a, b) => b[1] - a[1])[0][0], confidence: 0, probabilities: Object.entries(d).map(([value, probability]) => ({ value, probability })) })
// the wire answer is in the question's option order, the way the runner keeps it; the product's client sorts it (normalizeDecisionResponse)
const wire = (kind, strength) => {
  const full = { praise: 0, correction: 0, urging: 0, complaint: 0, instruction_change: 0, short_approval: 0, ambiguous: 0, none: 0, ...kind }
  const sRow = { mild: 0, clear: 0, strong: 0, ...strength }
  const k = kindRow(full), s2 = strengthRow(sRow), n = 8
  k.confidence = Math.max(...Object.values(full)) - 1 / n > 0 ? (Math.max(...Object.values(full)) - 1 / n) / (1 - 1 / n) : 0; s2.confidence = (Math.max(...Object.values(sRow)) - 1 / 3) / (1 - 1 / 3)
  return [k, s2]
}
const readWire = (kind, strength, extra = []) => readNunchi(normalizeDecisionResponse({ answers: [...wire(kind, strength), ...extra] }, nunchiRequest({ message: 'x' }).questions).answers)

test('u2: a turn that asks for a change is read from the merged options: the real answers that split between neighbours (correction .78 / instruction_change .14 ...) now install; praise, approval and a new question do not', () => {
  assert.deepEqual(NUNCHI_MASS, { yes: 0.8, no: 0.2 }, 'the product\'s yes/no bars'); assert.deepEqual(ACTIONABLE_KINDS, ['correction', 'complaint', 'instruction_change', 'urging'])
  // real answers of the control "야 한글로 보고해" (the single choice read 0.75 under the .85 bar: nothing was installed, the window of 02:51 left no candidate)
  const language = readWire({ correction: 0.78, instruction_change: 0.14, praise: 0.01, complaint: 0.01, none: 0.06 }, { clear: 0.96, mild: 0.03, strong: 0.01 })
  assert.deepEqual([language.kind, language.change, language.changeMass, language.forceful], [null, true, 0.93, true], 'the single kind is under the bar, the merged reading is not')
  const repeated = readWire({ urging: 0.68, complaint: 0.29, praise: 0.01, instruction_change: 0.01, short_approval: 0.01 }, { strong: 1 }); assert.deepEqual([repeated.kind, repeated.change, repeated.changeMass], [null, true, 0.98])
  const length = readWire({ complaint: 0.44, correction: 0.24, instruction_change: 0.2, urging: 0.11, praise: 0.01 }, { clear: 0.99, mild: 0.01 }); assert.deepEqual([length.kind, length.change, length.changeMass], [null, true, 0.99])
  for (const [name, kind, strength] of [['praise', { praise: 1 }, { mild: 0.74, clear: 0.26 }], ['a new question', { none: 1 }, { mild: 0.88, clear: 0.12 }], ['approval', { short_approval: 1 }, { clear: 1 }]]) {
    const r = readWire(kind, strength); assert.deepEqual([r.change, r.changeMass], [false, 0], name)
  }
  assert.equal(readWire({ none: 1 }, { mild: 0.88, clear: 0.12 }).forceful, false, 'mild: not more than a passing remark'); assert.equal(readWire({ correction: 1 }, { clear: 0.85, strong: 0.01, mild: 0.14 }).forceful, true, 'clear and strong together')
  // the boundary: .78 is not enough, .81 is (u3: "한국어로 말해줘" read .83 in the fresh validation and missed the .85 of u2); at most .2 reads "no change", between is not read
  assert.equal(readWire({ instruction_change: 0.76, correction: 0.02, none: 0.22 }, { clear: 1 }).change, null); assert.equal(readWire({ instruction_change: 0.76, correction: 0.05, none: 0.19 }, { clear: 1 }).change, true)
  assert.equal(readWire({ none: 0.8, correction: 0.15, praise: 0.05 }, { clear: 1 }).change, false); assert.equal(readWire({ none: 0.7, correction: 0.25, praise: 0.05 }, { clear: 1 }).change, null)
  assert.equal(readWire({ correction: 0.62, complaint: 0.21, none: 0.17 }, { clear: 1 }).change, true, 'the fresh "한국어로 말해줘" shape: .83 in total')
  assert.equal(readWire({ correction: 0.45, none: 0.35, complaint: 0.1 }, { clear: 0.6, mild: 0.4 }).change, null, 'a mix of "asks for a change" and "none" is not read')
})

test('u2: the merged reading plus a named subject makes the guidance (the real "야 한글로 보고해" and "짧게" answers), whichever neighbour the model picked; without a subject, nothing', () => {
  const about = (value, rest = {}) => ({ type: 'choice', name: 'nk_about', choice: value, confidence: 0.98, probabilities: [{ value, probability: 0.98 }, ...Object.entries(rest).map(([v, p]) => ({ value: v, probability: p }))] })
  const lang = { type: 'choice', name: 'nk_language', choice: 'korean', confidence: 0.98, probabilities: [{ value: 'korean', probability: 0.98 }, { value: 'none', probability: 0.02 }] }
  const dir = { type: 'choice', name: 'nk_direction', choice: 'less', confidence: 0.98, probabilities: [{ value: 'less', probability: 0.98 }, { value: 'more', probability: 0.02 }] }
  const lr = readWire({ correction: 0.78, instruction_change: 0.14, praise: 0.01, complaint: 0.01, none: 0.06 }, { clear: 0.96, mild: 0.03, strong: 0.01 }, [about('language', { length: 0.02 }), lang])
  assert.equal(directiveFor(lr).line, 'Reply in Korean for the rest of this conversation, as the person asked.'); assert.deepEqual(directiveFor(lr).durable, { guidance: 'language', value: 'korean' })
  const short = readWire({ complaint: 0.44, correction: 0.24, instruction_change: 0.2, urging: 0.11, praise: 0.01 }, { clear: 0.99, mild: 0.01 }, [about('length'), dir])
  assert.equal(directiveFor(short).line, 'Keep replies short for the rest of this conversation, as the person asked.')
  const none = readWire({ correction: 0.78, instruction_change: 0.14, none: 0.08 }, { clear: 0.96, mild: 0.04 }, [about('no_particular')]); assert.equal(none.change, true); assert.equal(directiveFor(none), null, 'a change about nothing in particular')
  const mild = readWire({ complaint: 0.9, correction: 0.05, none: 0.05 }, { mild: 0.9, clear: 0.1 }, [about('length'), dir]); assert.equal(directiveFor(mild), null, 'a passing remark')
  assert.equal(directiveFor({ kind: 'correction', about: 'language', strength: 'clear', language: 'korean' }).guidance, 'language', 'an older reading shape still works (single kind, single strength)')
})

test('u2: what EG-Desk did with the instruction is told to the engine as a state, only while it is so; applied: every conversation; nothing without a conversation line', () => {
  const lines = { conversation: ['Keep replies short for the rest of this conversation, as the person asked.'] }
  assert.ok(nunchiContextText({ ...lines, record: 'candidate' }).endsWith(`- ${RECORD_HINTS.candidate}`)); assert.match(RECORD_HINTS.candidate, /candidate.*only once the person applies it.*do not say that you cannot keep it/s)
  assert.ok(nunchiContextText({ ...lines, record: 'applied' }).endsWith(`- ${RECORD_HINTS.applied}`)); assert.equal(nunchiContextText({ ...lines, record: null }), nunchiContextText(lines)); assert.equal(nunchiContextText({ ...lines, record: 'bogus' }), nunchiContextText(lines))
  assert.equal(nunchiContextText({ standing: ['Reply in Korean in every conversation, as the person asked.'], record: 'candidate' }).includes('guidance record'), false, 'no hint without a line of this conversation')
  assert.equal(nunchiContextText({ record: 'candidate' }), null)
})
