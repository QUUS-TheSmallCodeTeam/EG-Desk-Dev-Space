// L1 c31: the fast answer (helper/egdesk-memory-fast-answer.mjs) in the real-engine check, through the check's extension API (registered in helper/egdesk-real-engine-registrations.mjs).
// A conversation turns the bridge flag on with  "flags": { "EGDESK_TURN_MEMORY_FAST_ANSWER": "on" }  and seeds pages with the memory field (needs --decisions: the Decision model
// picks the record and judges the sentences). A turn may carry
//   "expect": { "fastAnswer": { "used": true|false, "reason": "<word>" | ["<word>", …], "answerIs": "<the posted answer, exactly>", "maxSeconds": n, "noDecisionCall": true } }
//   used            true: code posted a sentence and NO turn/start reached the engine; false: the engine answered (at least one turn/start);
//   reason          why the fast path did not answer (the closed words of the module: needs_more_than_a_sentence, several_sentences, time_unsettled, ...), one or any of a list;
//   answerIs        the posted answer is exactly this text (the record's own sentence);
//   maxSeconds      the turn took at most this many seconds, from the person's message to the finished answer (the number to compare with the engine's own turn);
//   noDecisionCall  the fast-answer question was never sent (a code floor ruled it out first).
// The turn record carries fastAnswer = { flag, used, reason, calls, decisionMs, pageId, p, engineTurns, seconds, answer } for every turn of such a conversation, flag off included, so the
// two paths can be compared on the same question (scripts/egdesk-fast-answer-compare.mjs). Nothing here asks a model whether a turn went well.
import { FAST_REASONS } from './egdesk-memory-fast-answer.mjs'

export const FAST_FLAG = 'EGDESK_TURN_MEMORY_FAST_ANSWER'
const WORD = /^[a-z][a-z_]{2,39}$/
const reasonList = { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: WORD.source } }
export const FAST_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  used: { type: 'boolean' }, reason: { anyOf: [{ type: 'string', pattern: WORD.source }, reasonList] }, answerIs: { type: 'string', minLength: 1, maxLength: 400 },
  maxSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 600 }, noDecisionCall: { const: true } } })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** validateFastExpect(value, conv, turn, where) → ['<where>: <reason>'] */
export function validateFastExpect(value, conv, turn, where = '$.expect.fastAnswer') {
  const errors = [], bad = (at, why) => errors.push(`${at}: ${why}`)
  if (!isObject(value)) return [`${where}: an object`]
  for (const k of Object.keys(value)) if (!Object.keys(FAST_EXPECT_SCHEMA.properties).includes(k)) bad(`${where}.${k}`, 'unknown key')
  if (value.used !== undefined && typeof value.used !== 'boolean') bad(`${where}.used`, 'true or false')
  if (value.maxSeconds !== undefined && !(typeof value.maxSeconds === 'number' && value.maxSeconds > 0 && value.maxSeconds <= 600)) bad(`${where}.maxSeconds`, 'a number of seconds, 0 to 600')
  if (value.answerIs !== undefined && !(typeof value.answerIs === 'string' && value.answerIs.trim() && value.answerIs.length <= 400)) bad(`${where}.answerIs`, 'a non-empty text of at most 400 characters')
  if (value.noDecisionCall !== undefined && value.noDecisionCall !== true) bad(`${where}.noDecisionCall`, 'true')
  if (conv.memory?.mode !== 'on') bad(where, 'needs the conversation\'s memory.mode = "on" (the loop picks the record the sentence comes from)')
  if (turn.whileRunning !== undefined || turn.action !== undefined) bad(where, 'not checked on a whileRunning or action turn')
  const on = conv.flags?.[FAST_FLAG] === 'on'
  if (!on && (value.used === true || value.answerIs !== undefined || value.reason !== undefined || value.noDecisionCall !== undefined)) bad(where, `needs flags.${FAST_FLAG} = "on" in this conversation (without it nothing is judged and the engine always answers)`)
  if (value.used === true && (value.reason !== undefined || value.noDecisionCall !== undefined)) bad(`${where}.reason`, 'a reason is why the engine answered: it belongs to used: false')
  if (value.used !== true && value.answerIs !== undefined) bad(`${where}.answerIs`, 'only an answer posted by code (used: true) has the record\'s sentence')
  for (const r of [].concat(value.reason ?? [])) if (typeof r !== 'string' || !WORD.test(r)) bad(`${where}.reason`, 'closed words like needs_more_than_a_sentence')
  return errors
}

const clip = (text, max) => (typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : text)

/** The conversation's hook: counts the engine's turn/start requests per scripted turn and reads the runtime's own fast-answer record of the turn's run. */
export function createFastAnswerHook(conversation) {
  let chat = null, starts = 0, fast = null, answer = null
  const on = conversation?.flags?.[FAST_FLAG] === 'on'
  return {
    attach: deps => { chat = deps.chat },
    observe: method => { if (method === 'turn/start') starts += 1 },
    beginTurn: () => { starts = 0; fast = null; answer = null },
    afterTurn: ctx => {
      try {
        const run = [...chat.runs.values()].find(r => r.runId === ctx.run?.runId && r.conversationId === ctx.run?.conversationId)
        fast = run ? chat.fastAnswerRecord(run) : null
      } catch { fast = null }
      answer = typeof ctx.answer === 'string' ? ctx.answer : null
      return null
    },
    finishTurn: ctx => {
      const want = ctx.expect?.fastAnswer
      if (!on && !want) return null
      const seconds = Number.isFinite(ctx.latencyMs) ? Math.round(ctx.latencyMs / 100) / 10 : null
      const record = { flag: on, used: fast?.used === true, reason: fast ? fast.reason : null, calls: fast?.calls ?? 0, decisionMs: fast?.ms ?? null, pageId: fast?.pageId ?? null, p: fast?.p ?? null,
        engineTurns: starts, seconds, answer: clip(answer, 400) ?? null }
      const expectations = []
      const put = (check, ok, detail) => expectations.push({ check: `fastAnswer.${check}`, ok, detail })
      if (want?.used !== undefined) put('used', record.used === want.used && (want.used ? starts === 0 : starts >= 1), { used: record.used, engineTurns: starts, reason: record.reason })
      if (want?.reason !== undefined) put('reason', !record.used && [].concat(want.reason).includes(record.reason), { reason: record.reason, wanted: [].concat(want.reason) })
      if (want?.answerIs !== undefined) put('answerIs', record.used && typeof answer === 'string' && answer.trim() === want.answerIs.trim(), { answer: clip(answer, 200) ?? null })
      if (want?.maxSeconds !== undefined) put('maxSeconds', seconds !== null && seconds <= want.maxSeconds, { seconds, max: want.maxSeconds })
      if (want?.noDecisionCall === true) put('noDecisionCall', record.calls === 0 && !record.used, { calls: record.calls, reason: record.reason })
      return { record, expectations }
    },
  }
}

export { FAST_REASONS }
