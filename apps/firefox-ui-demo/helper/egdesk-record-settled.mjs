import { compactText, predicateQuestion } from './egdesk-decision-questions.mjs'
import { clockLine, ternary } from './egdesk-wiki-reconstruction.mjs'

// L7 c38 (owner direction U13, layer audit L1 c31b M-c/M-d): the memory layer is settled BEFORE the engine answers (flag turnMemory.writeFirst, default off).
//
// Today the record write judgment runs after the answer, so the engine writes its words first and the record follows (check-27mw: the engine said the meeting was settled before the
// report was judged and stored as an unconfirmed reading). With the flag the same judgment (the same code, the same questions) runs at the start of the turn, right behind the memory
// loop, inside the turn-context budget (the loop's cap: warm turn 2.5 s, cold turn 4 s). What it settled is handed to the engine as a short statement of state, so its words follow the record:
//   - a message that was kept as an UNCONFIRMED REPORT on a stored record (status change of that record, applied now as a pending reading, never a status)
//   - a correction (the record is reported outdated, also only a pending reading)
//   - a new unconfirmed record of the message (stored right after the reply by the existing path; stated only where the store may take it)
//   - a person's confirmation or refusal of an earlier note, judged at the start of this turn as before (egdesk-record-confirmation.mjs)
//   - a CONFLICT: the message says something other than the record says (a different state or date): both are kept, the record as it is, the message as a report that is not confirmed.
// The conflict is one more yes/no question per (record, message) pair, asked only when the judgment targets an existing record; nothing is asked of the person.
// c39 (the two gaps of c38), same flag:
//   - a statement that is a NEW record is stored at the start of the turn too (the write judgment already chose new / an existing record / nothing from code-built candidates: the 'about' design),
//     together with the person's utterance record the new page points at, only inside the budget; a correction's follow-up page likewise. Outside it the old path (after the answer) stores it.
//   - CONTRADICTIONS between two records of this turn's picked set that nothing links (no supersedes, follows_from ... either way) and neither of which is outdated: one request with one yes/no
//     question per pair (at most 4 records, 6 pairs, each question quotes its own pair), asked beside the write judgment (no extra wait), bounded by the cap. A "yes" is stated to the engine as
//     "these two records differ; do not decide which is right". Nothing is stored or marked in the wiki for it, and nothing is asked of the person.
// If the settlement is not ready within the budget, the turn goes on exactly as it does today (the recording rule, the write after the answer): never a wait beyond the cap.
export const SETTLED_HEAD = '[recording settled before your reply]'
export const SETTLED_LIMITS = Object.freeze({ conflictTimeoutMs: 1500, excerptChars: 400 })
export const CONTRADICTION_LIMITS = Object.freeze({ maxPages: 4, maxPairs: 6, timeoutMs: 1500, excerptChars: 300 })
const SHORT = Object.freeze({ done: 'done (carried out or settled)', plan: 'planned (not done yet)', superseded: 'outdated (the person gave a detail that replaces it)', unknown: 'not decided', reported_by_other: 'reported by someone else' })
const RECORD_STATUS = status => SHORT[status] ?? SHORT.unknown

const RULES = [
  'System judge. A stored record and a person\'s new message are shown. Judge only what the record says and what the message says, not whether either is true.',
  'They differ when the message gives a state or a date other than the record gives: the record leaves a thing undecided and the message settles it, the record plans it and the message says it is done, or the two name different days.',
  'They do not differ when the message only repeats the record, asks about it, or is about something else.',
].join('\n')

/** Pure: the question for one pair. page: { title, status, time: { slice }, body }. */
export function conflictQuestion(page) {
  return predicateQuestion('cf_differs', `Does the person's message say something other than the record "${compactText(page.title, 120)}" says: a different state (undecided, planned, done) or a different date or time?`)
}

/**
 * judgeRecordConflict({ message, page, client, askedAt, signal, timeoutMs }) -> { status: 'ready' | 'fallback', conflict: { state: 'yes' | 'no' | 'unknown', p }, usage }
 * One stateless call over ONE pair. page: a stored record already permission-checked by the caller. Never throws; a failed call is 'unknown' (no conflict is marked).
 */
export async function judgeRecordConflict({ message, page, client, askedAt = null, signal, timeoutMs = SETTLED_LIMITS.conflictTimeoutMs } = {}) {
  const unknown = { state: 'unknown', p: null }
  if (!client || !page || typeof page.title !== 'string' || typeof message !== 'string' || !message.trim()) return { status: 'fallback', reason: 'not_configured', conflict: unknown, usage: null }
  const block = `Record "${compactText(page.title, 120)}": state ${page.status ?? 'unknown'}, time ${page.time?.slice ?? 'unknown'}.\n${compactText(page.body ?? '', SETTLED_LIMITS.excerptChars)}`
  const input = [{ role: 'developer', content: RULES }, { role: 'user', content: block }, { role: 'user', content: `${clockLine(askedAt)}\nThe person's message:\n${message}` }]
  let result
  try { result = await client.decide({ input, questions: [conflictQuestion(page)], timeoutMs, signal }) } catch (error) { return { status: 'fallback', reason: error?.code ?? 'unreachable', conflict: unknown, usage: null } }
  return { status: 'ready', conflict: ternary(result.answers?.cf_differs), usage: result.usage ?? null }
}

const CT_RULES = [
  'System judge. Stored records are shown, then questions that each name two of them. Judge only what the two records say, not whether either is true.',
  'Two records contradict each other when they give a different state, date, time, amount or place for the very same matter, so that both cannot hold.',
  'They do not contradict each other when they are about different matters, when one adds detail to the other, or when both say the same.',
].join('\n')
const aliasOf = i => `R${i + 1}`

/**
 * contradictionPairs(pages, { linked }) -> [{ a, b }]  (pure; code only)
 * pages: the records of the turn's picked set, in pick order: { id, title, status, time: { slice }, body }. linked(a, b) -> true when a link joins them in either direction.
 * Records that are outdated (status superseded) are left out, at most maxPages are taken, a linked pair is not asked (its link already says how the two relate), at most maxPairs pairs.
 */
export function contradictionPairs(pages, { linked = () => false, limits = CONTRADICTION_LIMITS } = {}) {
  const list = (Array.isArray(pages) ? pages : []).filter(p => p && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.body === 'string' && p.body.trim() && p.status !== 'superseded').slice(0, limits.maxPages)
  const pairs = []
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (pairs.length < limits.maxPairs && !linked(list[i], list[j]) && !linked(list[j], list[i])) pairs.push({ a: list[i], b: list[j] })
  return pairs
}

/** Pure: the request of one contradiction check: the distinct records of the pairs once each (R1...), one yes/no question per pair that quotes its own two. */
export function contradictionRequest(pairs, askedAt = null) {
  const records = []
  for (const { a, b } of pairs) for (const page of [a, b]) if (!records.includes(page)) records.push(page)
  const block = (page, i) => `${aliasOf(i)} | "${compactText(page.title, 120)}" | state ${page.status ?? 'unknown'} | time ${page.time?.slice ?? 'unknown'}\n${compactText(page.body, CONTRADICTION_LIMITS.excerptChars)}`
  const questions = pairs.map(({ a, b }, k) => predicateQuestion(`ct_${k}`, `Do ${aliasOf(records.indexOf(a))} "${compactText(a.title, 80)}" and ${aliasOf(records.indexOf(b))} "${compactText(b.title, 80)}" contradict each other: a different state, date, time, amount or place for the very same matter?`))
  return { input: [{ role: 'developer', content: CT_RULES }, { role: 'user', content: `${clockLine(askedAt)}\nRecords:\n${records.map(block).join('\n\n')}` }], questions }
}

/**
 * judgeContradictions({ pairs, client, askedAt, signal, timeoutMs }) -> { status: 'ready' | 'fallback' | 'none', contradictions: [{ a, b, p }], judged, usage }
 * One stateless request for all pairs (bounded by the caller's pairs). Never throws; a failed or cut request marks nothing.
 */
export async function judgeContradictions({ pairs, client, askedAt = null, signal, timeoutMs = CONTRADICTION_LIMITS.timeoutMs } = {}) {
  if (!client || !Array.isArray(pairs) || !pairs.length) return { status: 'none', contradictions: [], judged: 0, usage: null }
  const { input, questions } = contradictionRequest(pairs, askedAt)
  let result
  try { result = await client.decide({ input, questions, timeoutMs, signal }) } catch (error) { return { status: 'fallback', reason: error?.code ?? 'unreachable', contradictions: [], judged: 0, usage: null } }
  const contradictions = pairs.map((pair, k) => ({ ...pair, ...ternary(result.answers?.[`ct_${k}`]) })).filter(v => v.state === 'yes').map(({ a, b, p }) => ({ a, b, p }))
  return { status: 'ready', contradictions, judged: pairs.length, usage: result.usage ?? null }
}

/**
 * settledRecordText(settled) -> string | null
 * settled: { write: { kind: 'pending_reading' | 'correction' | 'new_record' | 'not_recorded', title?, status?, recordStatus?, recordSlice?, conflict? } | null,
 *            confirmations: [{ title, action: 'promoted' | 'withdrawn', status }],
 *            contradictions: [{ a: { title, status, slice }, b: { title, status, slice } }] }
 * Engine-facing statements of state (not copy for the person: the engine words it in the person's language). null when there is nothing to state.
 */
export function settledRecordText({ write = null, confirmations = [], contradictions = [] } = {}) {
  const lines = []
  for (const c of (Array.isArray(confirmations) ? confirmations : []).slice(0, 3)) {
    if (!c || typeof c.title !== 'string' || !c.title.trim()) continue
    lines.push(c.action === 'promoted' ? `- The person has just confirmed "${compactText(c.title, 120)}": the record now reads ${RECORD_STATUS(c.status)}.`
      : `- The person has just refused the note on "${compactText(c.title, 120)}": the record's status is unchanged and nothing is kept.`)
  }
  if (write?.kind === 'pending_reading' || write?.kind === 'correction') {
    const title = compactText(write.title ?? '', 120), reported = write.kind === 'correction' ? SHORT.superseded : RECORD_STATUS(write.status)
    lines.push(write.conflict === true
      ? `- The record "${title}" and the person's message differ: the record reads ${RECORD_STATUS(write.recordStatus)}${write.recordSlice && write.recordSlice !== 'unknown' ? ` (${write.recordSlice})` : ''}, the person reports it as ${reported}. Both are kept: the record as it is, the message as a report that is not confirmed.`
      : `- The person's message was kept as an unconfirmed report on the record "${title}": reported as ${reported}. The record itself still reads ${RECORD_STATUS(write.recordStatus)}; its status has not changed.`)
  } else if (write?.kind === 'new_record') lines.push('- The person\'s message is kept as a new record that is not confirmed.')
  else if (write?.kind === 'not_recorded') lines.push('- Nothing from this message is recorded.')
  const kept = lines.length
  const word = side => `${compactText(side.title ?? '', 100)} (${RECORD_STATUS(side.status)}${side.slice && side.slice !== 'unknown' ? `, ${side.slice}` : ''})`
  for (const c of (Array.isArray(contradictions) ? contradictions : []).slice(0, CONTRADICTION_LIMITS.maxPairs)) {
    if (c?.a && c?.b) lines.push(`- Two stored records contradict each other and nothing links them: "${word(c.a)}" and "${word(c.b)}".`)
  }
  if (!lines.length) return null
  return [SETTLED_HEAD, ...lines,
    ...(kept ? ['Let your words follow this state. If it fits your reply, say in one short clause, in the person\'s language, what was kept and that it is not confirmed, as a plain statement. Do not ask the person to confirm it, never call a report confirmed or settled, and do not say that anything was recorded beyond what is listed here.'] : []),
    ...(lines.length > kept ? ['Where two records contradict each other, say that they differ and what each one says; do not decide which of them is right and do not merge them into one statement.'] : [])].join('\n')
}
