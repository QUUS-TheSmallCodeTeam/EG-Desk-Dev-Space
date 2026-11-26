// a1 (교대, L5): what the conversation model's turn and the screen get about an objective browser task, when the Decision model and the conversation model
// take turns on one browser request in ONE conversation. Developer flag EGDESK_BROWSER_ENTRY=alternate (the entry as 'on', plus this); default off, and with
// 'on' or anything else nothing here is used, so every input and event stays exactly as before.
//
//   1. The rule rides WITH the closed note (the same additionalContext entry, egdesk_browser_task): one field, `rule`, next to the note, in the same words for
//      Claude and Codex. The thread's instructions are not touched (a bounded thread of either engine takes no EG-Desk instructions), and the note itself
//      (egdesk-browser-task.mjs subjectiveNote) is not changed: the rule is added beside it.
//   2. A step of the Decision loop becomes one `browserTaskStep` event for the screen (chat.event v2, transient: shown, never stored), from the pre-turn entry,
//      the in-run resume and the browser task tool alike. Closed words, counts, ids and the control's own label only: never a typed value, a URL or page text.
// Pure: no I/O.

export const BROWSER_TASK_STEP_EVENT = 'browserTaskStep'
/** The browser task tool the conversation model continues the task with (L8 a1; the name is provisional). The rule names it only when the turn offers it. */
export const BROWSER_TASK_TOOL_NAME = 'egdesk_browser_task'
export const ALTERNATE_VALUE = 'alternate'

const RULE_HEAD = 'EG-Desk\'s Decision model already worked on this browser request in the person\'s Card before your turn. This note says what it did (stepsDone, actions) and where it stopped (status, code). Do not redo those steps, and read the page only for what the note does not say.'
const RULE_DONE = 'status done: tell the person the result in one message.'
const RULE_VALUE_TOOL = `A status that needs a value or a choice (need_context, needs_value, needs_guidance): when the conversation already settles it (the person said it, or it follows plainly from what they said), continue with the browser task tool (${BROWSER_TASK_TOOL_NAME}), giving the value or the choice under the name the note uses, and the Decision model carries on from where it stopped; otherwise ask the person one short question.`
const RULE_VALUE_ASK = 'A status that needs a value or a choice (need_context, needs_value, needs_guidance): when the conversation already settles it (the person said it, or it follows plainly from what they said), continue from where it stopped yourself; otherwise ask the person one short question.'
const RULE_CANNOT = 'cannot_proceed: tell the person what is left for them to do on the page. Never ask the person for something they already said.'

/** The rule, in the same words for both engines. toolOffered: the browser task tool is in this turn's tools (only then is it named). */
export function browserTaskRule({ toolOffered = false } = {}) {
  return [RULE_HEAD, RULE_DONE, toolOffered === true ? RULE_VALUE_TOOL : RULE_VALUE_ASK, RULE_CANNOT].join(' ')
}

/**
 * withBrowserTaskRule(note, { toolOffered }) -> the note's context value with the rule beside the note: {"egdesk_browser_task": {...}, "rule": "..."}.
 * A value that is not the note's JSON object is returned unchanged (nothing is guessed).
 */
export function withBrowserTaskRule(note, { toolOffered = false } = {}) {
  if (typeof note !== 'string') return note
  let parsed
  try { parsed = JSON.parse(note) } catch { return note }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.egdesk_browser_task || typeof parsed.egdesk_browser_task !== 'object') return note
  return JSON.stringify({ ...parsed, rule: browserTaskRule({ toolOffered }) })
}

const WORD = /^[a-z][a-z0-9_]{0,39}$/i
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
const short = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null)
const word = value => (typeof value === 'string' && WORD.test(value) ? value : null)
const id = value => (typeof value === 'string' && ID.test(value) ? value : null)
// what the Decision loop's own step reports call an operation (the browser tool it used), as the screen's closed words
const OP_OF_TOOL = Object.freeze({ egdesk_browser_click: 'press', egdesk_browser_fill: 'type', egdesk_browser_navigate: 'open', egdesk_browser_scroll: 'scroll',
  egdesk_browser_wait: 'wait', egdesk_browser_wait_text: 'wait', egdesk_browser_observe: 'read', egdesk_browser_select: 'select', egdesk_browser_press_key: 'key' })
export const BROWSER_TASK_STEP_FIELDS = Object.freeze(['taskId', 'cardId', 'seq', 'op', 'target', 'valueName', 'ok', 'ms', 'by', 'status', 'phase'])

/**
 * browserTaskStepDetails(info, { taskId, cardId, phase }) -> the event's details, or null when there is nothing to show.
 *   info: what the loop reports for one step (L8 a1: { taskId, cardId, seq, op, target, valueName, ok, ms, by, status? }; the earlier loop: { step, action }).
 *   The earlier loop's report (no op and no seq) is shown only for an action that changed something (press, type, open, scroll, select, key): its
 *   step-start report (no action) and its reads and waits are not lines on the screen.
 *   The task and card ids given by the caller win over the step's own (the caller holds the task). Only the listed fields leave, each checked:
 *   ids and closed words by pattern, counts as non-negative integers, the control's label (target) and the value's NAME (valueName) cut to 80 characters.
 *   A typed value, a URL, page text or anything unlisted never leaves.
 */
export function browserTaskStepDetails(info, { taskId = null, cardId = null, phase = null } = {}) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null
  const legacy = info.op === undefined && info.seq === undefined
  const op = legacy ? (typeof info.action === 'string' ? OP_OF_TOOL[info.action] ?? null : null) : word(info.op)
  if (legacy && (!op || op === 'read' || op === 'wait')) return null
  const seq = count(info.seq) ?? count(info.step)
  const details = {
    taskId: id(taskId) ?? id(info.taskId), cardId: id(cardId) ?? id(info.cardId), seq, op,
    target: short(info.target, 80) || null, valueName: short(info.valueName, 80) || null,
    ok: typeof info.ok === 'boolean' ? info.ok : null, ms: count(Number.isFinite(info.ms) ? Math.round(info.ms) : info.ms),
    by: word(info.by), status: word(info.status), phase: word(phase),
  }
  if (!details.taskId || (details.seq === null && !details.op && !details.status)) return null
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null))
}

/**
 * stepSink(publish) -> (info, ids) => boolean: one place that turns a loop step into a published step, once. The same step can be reported twice (the loop's
 * store hook and an onStep option of the same loop): the second report of one (task, phase, seq) is dropped. Only a report with its own seq is checked
 * (the earlier loop numbers steps per segment, so its numbers repeat). publish(details) returns whether it was shown.
 */
export function stepSink(publish) {
  const seen = new Set()
  return (info, ids = {}) => {
    const details = browserTaskStepDetails(info, ids)
    if (!details) return false
    if (Number.isSafeInteger(info?.seq)) {
      const key = `${details.taskId}:${details.phase ?? ''}:${details.seq}`
      if (seen.has(key)) return false
      seen.add(key)
      if (seen.size > 500) seen.delete(seen.values().next().value)
    }
    try { return publish(details) === true } catch { return false }
  }
}

/**
 * withStepHook(store, hook) -> the same task store, whose progress(task, info) (the loop's observer hook, egdesk-browser-task.mjs) also calls hook(task, info).
 * Every other method and the size are the store's own (the prototype is the store); the store's own progress still runs first and the hook never changes it.
 */
export function withStepHook(store, hook) {
  if (!store || typeof hook !== 'function') return store
  return Object.create(store, { progress: { value(task, info) {
    const out = store.progress?.(task, info)
    try { hook(task, info) } catch { /* the screen never changes the loop */ }
    return out
  } } })
}
