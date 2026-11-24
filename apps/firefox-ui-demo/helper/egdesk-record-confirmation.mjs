import { compactText, predicateQuestion } from './egdesk-decision-questions.mjs'
import { ternary } from './egdesk-wiki-reconstruction.mjs'

// How a PENDING reading becomes the record's status without a form or a button: through the conversation itself.
//
//   1. A turn's write judgment stores a reading as pending ("the person reported this plan as done"). Nothing else happens then.
//   2. On a later turn of the same session the answering model is told what was noted (confirmationNote) and says so in its own
//      words, as a statement. It does not ask.
//   3. The person's NEXT message is read by the Decision model with yes/no questions only, each quoting the one note it is about (no
//      forced choice among confirm / object / neither / unsure: real runs put a "none"-like option in a choice and got undecided answers):
//        rc_stated_i   did the previous reply tell the person this note was recorded?
//        rc_confirms_i is the person confirming the note the assistant just stated?
//        rc_rejects_i  is the person rejecting or correcting it?
//      Code decides (confirmationAction):
//        stated yes, confirms yes, rejects no  -> promote (the host calls writer.promote with by: 'user', at: that message)
//        rejects yes, confirms no              -> revert  (writer.reject: the pending reading is withdrawn, the status untouched)
//        anything else (both no, both yes, any undecided, a confirmation of a note the reply never stated)
//                                              -> keep    (still pending; it may be mentioned once more, then it just stays pending)
//
// What this is not: the Decision model does not judge whether the record is TRUE, and its score is not permission to write. It only
// reads the person's own message as a speech act about a note they were shown. The authority is the person's message; promote() still
// refuses anything that is not a later confirmation by the user. A message that says nothing about the note never confirms it:
// not objecting is not agreeing (the counter `silent` only reports how often that rule would have fired, for the owner's decision).
export const CONFIRM_LIMITS = Object.freeze({ records: 3, answerChars: 1500, offers: 2, timeoutMs: 2000 })
// The product's yes/no bars (yes >= 0.8, no <= 0.2; in between is undecided). Not changed here.
export const CONFIRM_BARS = Object.freeze({ yes: 0.8, no: 0.2 })
const SHORT_STATUS = Object.freeze({ done: 'done', plan: 'planned', superseded: 'outdated' })
const STATUS_WORDS = Object.freeze({ done: 'done (carried out or settled)', plan: 'planned (not done yet)', superseded: 'outdated (the person gave a detail that replaces it)' })
const RULES = [
  'System judge. A report of the person was noted as an unconfirmed record. Judge only from the reply and the new message shown.',
  'Confirming: agreeing it is right or saying to keep it. Rejecting: saying it is not so, not yet so, or should not be recorded. Thanks, silence, a new topic or a question is neither.',
  'Answer each question for its quoted note alone, not whether it is true.',
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

/** Pure: what the host does with one note. stated, confirms, rejects: ternaries ({ state: 'yes' | 'no' | 'unknown' }). */
export function confirmationAction(stated, confirms, rejects) {
  const c = confirms?.state, r = rejects?.state
  if (c !== 'yes' && c !== 'no') return { action: 'keep', reason: 'undecided' }
  if (r !== 'yes' && r !== 'no') return { action: 'keep', reason: 'undecided' }
  if (c === 'yes' && r === 'yes') return { action: 'keep', reason: 'contradictory' }
  if (r === 'yes') return { action: 'revert', reason: 'objected' }
  if (c === 'yes') return stated?.state === 'yes' ? { action: 'promote', reason: 'confirmed' } : { action: 'keep', reason: 'confirmed_but_not_stated' }
  return { action: 'keep', reason: 'no_response' } // both a decided no: not objecting is not agreeing
}

/**
 * judgeConfirmation({ message, previousAnswer, records, client, askedAt, signal, timeoutMs }) -> { status, verdicts, silent, usage, questions }
 * One stateless call. records: [{ title, status }] (already permission-checked by the caller; at most 3 are judged).
 * verdicts[i]: { stated, confirms, rejects (each { state, p }), action, reason }, in the order of `records`.
 * silent: how many notes were stated and met with a decided "no" to both (reported only; never acted on).
 */
export async function judgeConfirmation({ message, previousAnswer, records, client, askedAt = null, signal, timeoutMs = CONFIRM_LIMITS.timeoutMs } = {}) {
  const list = usable(records)
  const unknown = { state: 'unknown', p: null }
  const keep = reason => ({ status: 'fallback', reason, verdicts: list.map(() => ({ stated: unknown, confirms: unknown, rejects: unknown, action: 'keep', reason })), silent: 0, usage: null, questions: 0 })
  if (!client || !list.length || typeof message !== 'string' || !message.trim()) return keep('not_configured')
  if (typeof previousAnswer !== 'string' || !previousAnswer.trim()) return keep('no_previous_answer')
  // Each question quotes its own note (judged alone, as one item), so a second note in the same request cannot be read into it.
  const quoted = r => JSON.stringify(`${compactText(r.title, 120)} (noted as ${SHORT_STATUS[r.status]})`)
  const questions = list.flatMap((r, i) => [
    predicateQuestion(`rc_stated_${i}`, `Note ${quoted(r)}: did the assistant's previous reply tell the person it was recorded?`),
    predicateQuestion(`rc_confirms_${i}`, `Note ${quoted(r)}: is the person's new message confirming it?`),
    predicateQuestion(`rc_rejects_${i}`, `Note ${quoted(r)}: is the person's new message rejecting or correcting it?`)])
  const input = [{ role: 'developer', content: RULES },
    { role: 'user', content: `Assistant's previous reply:\n${previousAnswer.length > CONFIRM_LIMITS.answerChars ? `${previousAnswer.slice(0, CONFIRM_LIMITS.answerChars)} […]` : previousAnswer}` },
    // No clock line: nothing here is about time, and the note is quoted in its questions.
    { role: 'user', content: `The person's new message:\n${message}` }]
  let result
  try { result = await client.decide({ input, questions, timeoutMs, signal }) } catch (error) { return keep(error?.code ?? 'unreachable') }
  const verdicts = list.map((_, i) => {
    const stated = ternary(result.answers?.[`rc_stated_${i}`]), confirms = ternary(result.answers?.[`rc_confirms_${i}`]), rejects = ternary(result.answers?.[`rc_rejects_${i}`])
    return { stated, confirms, rejects, ...confirmationAction(stated, confirms, rejects) }
  })
  return { status: 'ready', verdicts, silent: verdicts.filter(v => v.stated.state === 'yes' && v.reason === 'no_response').length, usage: result.usage ?? null, questions: questions.length }
}
