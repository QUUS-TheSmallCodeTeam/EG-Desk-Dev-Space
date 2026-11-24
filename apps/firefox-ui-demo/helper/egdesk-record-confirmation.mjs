import { choiceQuestion, compactText, predicateQuestion, readChoice } from './egdesk-decision-questions.mjs'
import { clockLine, stableAlias, ternary } from './egdesk-wiki-reconstruction.mjs'

// How a PENDING reading becomes the record's status without a form or a button: through the conversation itself.
//
//   1. A turn's write judgment stores a reading as pending ("the person reported this plan as done"). Nothing else happens then.
//   2. On a later turn of the same session the answering model is told what was noted (confirmationNote) and says so in its own
//      words, as a statement. It does not ask.
//   3. The person's NEXT message is read by the Decision model over a closed set: confirm / object / neither / unsure, and whether the
//      previous reply really stated the note. Code decides (confirmationAction):
//        the reply stated it AND the person confirms  -> promote (the host calls writer.promote with by: 'user', at: that message)
//        the person objects (stated or not)           -> revert  (writer.reject: the pending reading is withdrawn, the status untouched)
//        anything else                                -> keep    (still pending; it may be mentioned once more, then it just stays pending)
//
// What this is not: the Decision model does not judge whether the record is TRUE, and its score is not permission to write. It only
// reads the person's own message as a speech act about a note they were shown. The authority is the person's message; promote() still
// refuses anything that is not a later confirmation by the user. A message that says nothing about the note never confirms it:
// not objecting is not agreeing (the counter `silent` only reports how often that rule would have fired, for the owner's decision).
export const CONFIRM_LIMITS = Object.freeze({ records: 3, answerChars: 1500, offers: 2, timeoutMs: 2000 })
export const CONFIRM_BARS = Object.freeze({ stated: 0.8, reply: Object.freeze({ minConfidence: 0.75, minMargin: 0.2 }) })
const STATUS_WORDS = Object.freeze({ done: 'done (carried out or settled)', plan: 'planned (not done yet)', superseded: 'outdated (the person gave a detail that replaces it)' })
const REPLIES = Object.freeze([
  { value: 'confirm', description: 'The person agrees that the note is right, or tells the assistant to keep it.' },
  { value: 'object', description: 'The person says it is not so (or not yet so), or that it should not be recorded or should be undone.' },
  { value: 'neither', description: 'The message is about something else, or does not respond to the note at all (thanks, a new topic, a question).' },
  { value: 'unsure', description: 'It cannot be told which of these it is.' }])
const RULES = [
  'You are a system judge. Earlier in this conversation the system noted some of the person\'s reports as unconfirmed records. Judge only from the assistant\'s previous reply and the person\'s new message, both shown.',
  'The person confirms a note only by agreeing with it, or telling the assistant to keep it, in answer to a reply that stated it. Silence, thanks, a new topic or a question is neither confirmation nor objection.',
  'The person objects when they say it is not so, not yet so, or that it should not be recorded or should be undone.',
  'Each question is about ONE note. Do not judge whether the note is true. If it cannot be told, choose unsure.',
].join('\n')

const usable = records => (Array.isArray(records) ? records : []).filter(r => r && typeof r.title === 'string' && r.title.trim() && Object.hasOwn(STATUS_WORDS, r.status)).slice(0, CONFIRM_LIMITS.records)

/**
 * The lines given to the answering model about what was noted and is not confirmed. A statement to make, never a question to ask.
 * records: [{ title, status: 'done' | 'plan' | 'superseded' }] -> string | null
 */
export function confirmationNote(records) {
  const list = usable(records)
  if (!list.length) return null
  return ['[noted in this conversation, not confirmed]',
    ...list.map(r => `- "${compactText(r.title, 120)}": the person reported it as ${STATUS_WORDS[r.status]}. It is kept as a report; the recorded status has not changed.`),
    'When it fits your reply, tell the person in one short clause what was noted, in their language, as a plain statement (for example: "… 완료로 적어 둘게요"). Do not ask them to confirm it, do not make a form of it, and do not repeat it if you have already said it. Until the person agrees, treat it as reported, not as settled.'].join('\n')
}

/** Pure: what the host does with one record's verdict. stated: ternary of the predicate; reply: readChoice result. */
export function confirmationAction(stated, reply) {
  const value = reply?.state === 'accepted' ? reply.value : null
  if (value === 'object') return { action: 'revert', reason: 'objected' }
  if (value === 'confirm') return stated?.state === 'yes' ? { action: 'promote', reason: 'confirmed' } : { action: 'keep', reason: 'confirmed_but_not_stated' }
  if (value === 'neither') return { action: 'keep', reason: 'no_response' }
  return { action: 'keep', reason: 'undecided' }
}

/**
 * judgeConfirmation({ message, previousAnswer, records, client, askedAt, signal, timeoutMs }) -> { status, verdicts, silent, usage, questions }
 * One stateless call. records: [{ title, status }] (already permission-checked by the caller; at most 3 are judged).
 * verdicts[i]: { stated: { state, p }, reply: { state, value, confidence, margin }, action, reason }, in the order of `records`.
 * silent: how many notes were stated and met with a decided "neither" (reported only; never acted on).
 */
export async function judgeConfirmation({ message, previousAnswer, records, client, askedAt = null, signal, timeoutMs = CONFIRM_LIMITS.timeoutMs } = {}) {
  const list = usable(records)
  const keep = reason => ({ status: 'fallback', reason, verdicts: list.map(() => ({ stated: { state: 'unknown', p: null }, reply: { state: 'missing' }, action: 'keep', reason })), silent: 0, usage: null, questions: 0 })
  if (!client || !list.length || typeof message !== 'string' || !message.trim()) return keep('not_configured')
  if (typeof previousAnswer !== 'string' || !previousAnswer.trim()) return keep('no_previous_answer')
  const questions = list.flatMap((r, i) => [
    predicateQuestion(`rc_stated_${i}`, `Did the assistant's previous reply tell the person that note ${stableAlias(i)} was recorded as ${STATUS_WORDS[r.status]}?`),
    choiceQuestion(`rc_reply_${i}`, `How does the person's new message respond to note ${stableAlias(i)} (recorded as ${STATUS_WORDS[r.status]})?`, REPLIES)])
  const input = [{ role: 'developer', content: RULES },
    { role: 'user', content: `Notes (unconfirmed):\n${list.map((r, i) => `${stableAlias(i)} | "${compactText(r.title, 120)}" | noted as ${STATUS_WORDS[r.status]}`).join('\n')}` },
    { role: 'user', content: `Assistant's previous reply:\n${previousAnswer.length > CONFIRM_LIMITS.answerChars ? `${previousAnswer.slice(0, CONFIRM_LIMITS.answerChars)} […]` : previousAnswer}` },
    { role: 'user', content: `${clockLine(askedAt)}\nThe person's new message:\n${message}` }]
  let result
  try { result = await client.decide({ input, questions, timeoutMs, signal }) } catch (error) { return keep(error?.code ?? 'unreachable') }
  const verdicts = list.map((_, i) => {
    const stated = ternary(result.answers?.[`rc_stated_${i}`]), reply = readChoice(result.answers, `rc_reply_${i}`, CONFIRM_BARS.reply)
    return { stated, reply: { state: reply.state, value: reply.state === 'accepted' ? reply.value : null, confidence: reply.confidence ?? null, margin: reply.margin ?? null }, ...confirmationAction(stated, reply) }
  })
  return { status: 'ready', verdicts, silent: verdicts.filter(v => v.stated.state === 'yes' && v.reason === 'no_response').length, usage: result.usage ?? null, questions: questions.length }
}
