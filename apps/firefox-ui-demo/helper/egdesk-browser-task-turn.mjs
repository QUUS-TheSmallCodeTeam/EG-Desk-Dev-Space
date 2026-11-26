// a1 (교대, L5): what the conversation model's turn and the screen get about an objective browser task, when the Decision model and the conversation model
// take turns on one browser request in ONE conversation. Developer flag EGDESK_BROWSER_ENTRY=alternate (the entry as 'on', plus this); default off.
//
//   1. The rule rides WITH the closed note (the same additionalContext entry, egdesk_browser_task): one field, `rule`, next to the note, in the same words for
//      Claude and Codex. The thread's instructions are not touched (a bounded thread of either engine takes no EG-Desk thread rule for it), and the note itself is not changed.
//   2. Every step of a Decision loop (the entry's, the in-run resume's, the tool's) is one step for the screen through lane L1's channel
//      (decisionContext.browserSteps.publish, egdesk-browser-steps-channel.mjs; it sends nothing while EGDESK_BROWSER_STEPS_UI is off), whatever the entry value
//      ('on' or 'alternate'): browserStepFor below. Closed words, counts, ids and the control's own label only: never a typed value, an address or page text.
// Pure: no I/O.
import { BROWSER_TASK_TOOL_NAME } from './egdesk-browser-task-tool.mjs'

export { BROWSER_TASK_TOOL_NAME } // L8's name, the one constant
export const ALTERNATE_VALUE = 'alternate'

const RULE_HEAD = 'EG-Desk\'s Decision model already worked on this browser request in the person\'s Card before your turn. This note says what it did and where it stopped (status, code). Do not redo those steps, and read the page only for what the note does not say.'
const RULE_DONE = 'status done: tell the person the result in one message.'
const RULE_VALUE_TOOL = `next continue_with_egdesk_browser_task: call ${BROWSER_TASK_TOOL_NAME} this turn without a goal. For needs_value, infer the value from the conversation and pass it in values under ask.field; ask the person one short question only if you cannot infer it. For needs_guidance, read the Card if needed and continue the task; use only option ids the tool offers. For need_context, follow the note's next.`
const RULE_VALUE_ASK = 'A status that needs a value or a choice (needs_value, needs_guidance, need_context): when the conversation already settles it (the person said it, or it follows plainly from what they said), continue from where it stopped yourself; otherwise ask the person one short question.'
const RULE_CANNOT = 'human_step, cannot or cannot_proceed: tell the person what is left for them to do on the page. Never ask the person for something they already said.'

/** The rule, in the same words for both engines. toolOffered: the browser task tool is in this turn's tools (only then is it named). */
export function browserTaskRule({ toolOffered = false } = {}) {
  return [RULE_HEAD, RULE_DONE, toolOffered === true ? RULE_VALUE_TOOL : RULE_VALUE_ASK, RULE_CANNOT].join(' ')
}

/**
 * withBrowserTaskRule(note, { toolOffered }) -> the note's context value with the rule beside the note: {"egdesk_browser_task": {...}, "rule": "..."}.
 * A value that is not the note's JSON object is returned unchanged (nothing is guessed).
 */
export function withBrowserTaskRule(note, { toolOffered = false } = {}) {
  const parsed = noteObject(note)
  return parsed ? JSON.stringify({ ...parsed, rule: browserTaskRule({ toolOffered }) }) : note
}

const noteObject = note => {
  if (typeof note !== 'string') return null
  let parsed
  try { parsed = JSON.parse(note) } catch { return null }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.egdesk_browser_task && typeof parsed.egdesk_browser_task === 'object' ? parsed : null
}
/** The note's own closed words: { id, status, code } (or null). */
export function noteWords(note) {
  const body = noteObject(note)?.egdesk_browser_task
  return body ? { id: typeof body.id === 'string' ? body.id : typeof body.taskId === 'string' ? body.taskId : null, status: typeof body.status === 'string' ? body.status : null, code: typeof body.code === 'string' ? body.code : null } : null
}

// the step contract's operations (L8 taskStepEvent: open | submit | press | fill | scroll | end) as the screen's words (L1 EGDeskBrowserStepsView OP_ALIASES)
const SCREEN_OP = Object.freeze({ open: 'navigate', submit: 'submit', press: 'click', fill: 'fill', scroll: 'scroll' })
// why the conversation model takes the task over, in the screen's words (L1 HANDOFF_REASONS): the note's or the tool's closed status/code
const HANDOFF_OF = Object.freeze({ needs_value: 'needs_value', detail_needed: 'needs_value', needs_guidance: 'low_confidence', uncertain: 'low_confidence', page_unclear: 'low_confidence',
  choice_needed: 'needs_user', confirm_needed: 'needs_user', need_context: 'needs_user', human_step: 'human_step', person_only_controls: 'human_step', sensitive_flow: 'human_step' })
const WORD = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/
const short = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/**
 * browserStepFor(event, { clientThreadId }) -> one step in lane L1's shape for decisionContext.browserSteps.publish, or null.
 *   event: L8's step contract ({ taskId, cardId, seq, op, target, valueName, ok, ms, by, code?, status? }), or the entry's own last step
 *   ({ taskId, cardId, seq, op: 'end', status, code }). An op 'end' becomes 'done' (status done), 'blocked' (cannot) or 'handoff' with its reason.
 *   Only the listed fields leave, each checked; a typed value, an address or page text never leaves.
 */
export function browserStepFor(event, { clientThreadId } = {}) {
  if (!event || typeof event !== 'object' || typeof clientThreadId !== 'string' || !clientThreadId) return null
  const taskId = typeof event.taskId === 'string' && ID.test(event.taskId) ? event.taskId : null, seq = count(event.seq)
  if (!taskId || seq === null) return null
  const status = typeof event.status === 'string' && WORD.test(event.status) ? event.status : null, code = typeof event.code === 'string' && WORD.test(event.code) ? event.code : null
  let op = SCREEN_OP[event.op] ?? null, reason = null
  if (event.op === 'end') {
    const handoff = HANDOFF_OF[code] ?? HANDOFF_OF[status] ?? null
    op = status === 'done' ? 'done' : handoff ? 'handoff' : 'blocked'
    reason = op === 'handoff' ? handoff : null
  }
  if (!op) return null
  const step = { clientThreadId, taskId, seq, op,
    ...(typeof event.cardId === 'string' && ID.test(event.cardId) ? { cardId: event.cardId } : {}),
    ...(short(event.target, 60) ? { target: short(event.target, 60) } : {}), ...(short(event.valueName, 40) ? { valueName: short(event.valueName, 40) } : {}),
    ...(typeof event.ok === 'boolean' ? { ok: event.ok } : {}), ...(count(event.ms) !== null ? { ms: event.ms } : {}),
    by: event.by === 'model' ? 'model' : 'decision',
    ...(op === 'handoff' ? { status: reason } : status ? { status } : {}), ...(reason ? { reason } : {}) }
  return step
}
