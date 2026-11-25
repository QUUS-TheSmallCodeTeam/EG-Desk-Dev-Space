import test from 'node:test'
import assert from 'node:assert/strict'
import { ABOUT, DIRECTIONS, KINDS, LANGUAGES, NUNCHI_BAR, NUNCHI_LIMITS, STRENGTHS, directiveFor, judgeNunchi, nunchiContextText, nunchiRequest, readNunchi, standingLine } from './egdesk-nunchi.mjs'
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
  assert.deepEqual(readNunchi(answers(KOREAN_CORRECTION)), { kind: 'correction', about: 'language', strength: 'clear', direction: 'not_applicable', language: 'korean' })
  const weak = answers(KOREAN_CORRECTION, 0.7)   // 8 options: (0.7 - .125) / .875 = .657
  assert.deepEqual(readNunchi(weak), { kind: null, about: null, strength: null, direction: null, language: null })
  const mixed = { ...answers(KOREAN_CORRECTION), nk_kind: choiceAnswer(q('nk_kind'), 'correction', 0.6) }
  assert.deepEqual([readNunchi(mixed).kind, readNunchi(mixed).about], [null, 'language'], 'each question on its own')
  assert.deepEqual(readNunchi({}), { kind: null, about: null, strength: null, direction: null, language: null }); assert.deepEqual(readNunchi(null).kind, null)
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
  const r = (kind, about, strength = 'clear', direction = 'not_applicable', language = 'none') => directiveFor({ kind, about, strength, direction, language })
  assert.deepEqual(r('correction', 'language', 'clear', 'not_applicable', 'korean'), { line: 'Reply in Korean for the rest of this conversation, as the person asked.', guidance: 'language', value: 'korean', durable: { guidance: 'language', value: 'korean' } })
  assert.equal(r('instruction_change', 'language', 'strong', 'not_applicable', 'other').line, 'Reply in the language the person asked for in their last message, for the rest of this conversation.'); assert.equal(r('instruction_change', 'language', 'strong', 'not_applicable', 'other').durable, null, 'a language that is not named has no durable value')
  assert.equal(r('complaint', 'length', 'clear', 'less').line, 'Keep replies short for the rest of this conversation, as the person asked.'); assert.deepEqual(r('complaint', 'length', 'clear', 'less').durable, { guidance: 'length', value: 'less' })
  assert.equal(r('complaint', 'length', 'clear', 'more').line, 'Give fuller replies with more detail for the rest of this conversation, as the person asked.'); assert.equal(r('complaint', 'length', 'clear', 'keep'), null, 'no direction, no guidance')
  assert.match(r('complaint', 'repeated_question').line, /Do not repeat a confirmation question/); assert.equal(r('complaint', 'repeated_question').durable.guidance, 'repeated_question')
  assert.match(r('urging', 'speed').line, /lead with the result or the current status/); assert.equal(r('urging', 'speed').durable, null, 'a plain urge is about this moment')
  assert.match(r('correction', 'factual_error').line, /check it again/); assert.equal(r('correction', 'factual_error').durable, null)
  assert.equal(r('correction', 'scope', 'clear', 'less').line, 'Stay within exactly what the person asked and add no extra steps for the rest of this conversation.'); assert.equal(r('correction', 'format').guidance, 'format')
  for (const none of [r('praise', 'language'), r('short_approval', 'no_particular'), r('ambiguous', 'other'), r('none', 'no_particular'), r('correction', 'language', 'mild', 'not_applicable', 'korean'), r('correction', 'other'), r('correction', 'no_particular'), r('complaint', null), directiveFor(null), directiveFor({ kind: 'correction', about: 'language', strength: null })]) assert.equal(none, null)
  assert.equal(r('urging', 'language', 'clear', 'not_applicable', 'korean').durable, null, 'an urge is not a preference'); assert.equal(r('complaint', 'factual_error').line.includes('check'), true)
  assert.equal(standingLine('language', 'korean'), 'Reply in Korean in every conversation, as the person asked.'); assert.equal(standingLine('length', 'less'), 'Keep replies short in every conversation, as the person asked.')
})

test('the entry for the engine: the person\'s applied guidance first, then this conversation\'s lines (newest four), no duplicates; null when there are none', () => {
  assert.equal(nunchiContextText({}), null); assert.equal(nunchiContextText({ standing: [], conversation: [''] }), null)
  const text = nunchiContextText({ standing: ['Reply in Korean in every conversation, as the person asked.'], conversation: ['Keep replies short for the rest of this conversation, as the person asked.', 'Reply in Korean in every conversation, as the person asked.'] })
  assert.equal(text, '[guidance from the person: follow it in your reply; do not mention it unless asked]\n- Reply in Korean in every conversation, as the person asked.\n- Keep replies short for the rest of this conversation, as the person asked.')
  const many = nunchiContextText({ conversation: ['a', 'b', 'c', 'd', 'e', 'f'] }).split('\n'); assert.deepEqual(many.slice(1), ['- c', '- d', '- e', '- f'])
})
