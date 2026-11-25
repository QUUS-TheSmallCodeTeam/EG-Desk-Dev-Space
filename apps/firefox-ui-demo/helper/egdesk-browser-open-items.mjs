import { compactText, decisionThresholds, predicateQuestion, readPredicate } from './egdesk-decision-questions.mjs'
import { FOREGROUND_DECISION_TIMEOUT_MS } from './egdesk-decision-client.mjs'

// L8 c37 (owner direction U13, corrected: the Decision model settles the DEFINED layers first, conversation sits on top).
// The browser slice of the open-item registry (lane L1, helper/egdesk-open-items.mjs): a browser task that waits for the person (it asked, or handed a
// step over, or got stuck) or is running is an OPEN ITEM of the conversation. Code registers it with the options it can apply; the Decision decides, at
// turn start and before the engine turn, which option the person's message settles; code applies it; the engine then words the reply on a settled state.
//
// Flag EGDESK_BROWSER_OPEN_ITEMS (default off). Nothing here speaks to the person: no new copy, the engine reads a closed note.
//
// The contract with L1's registry (agreed by message, 2026-11-25):
//   provider = { id: 'browser', items(conversationKey) SYNC, questions(conversationKey, message), read(answers), apply(ctx) }
//   items   -> [{ provider: 'browser', id: taskId, kind: 'browser_task', state, summary (code-built, <= 300 chars), options: [{ id }] }]
//   questions -> predicate questions named `open_browser_<option>`, each quoting the message (R4) and nothing else of it (R2: yes/no, no catch-all option)
//   read    -> { itemId, optionId, kind: 'settled' } | { kind: 'none' } | { kind: 'uncertain' }; ONLY a settled one is applied (R5: fail closed)
//   apply   -> { handled, note?, settled, reason }

export const OPEN_ITEMS_FLAG = 'EGDESK_BROWSER_OPEN_ITEMS'
export const OPEN_ITEM_KIND = 'browser_task'
export const MAX_ITEM_SUMMARY = 300
export const MAX_ITEM_GOAL = 120

// state of a live task (code: no judgment). waiting: it asked the person something; handed_over: the next step is the person's (a sign-in, a code, a
// control only the person operates, a checkout); stuck: it cannot go on for another reason; running: the loop is working.
const HANDOVER_CODES = new Set(['human_step', 'login_required', 'two_factor_required', 'bot_check', 'sensitive_flow'])
export function openItemState(task) {
  if (!task) return null
  if (task.status === 'running') return 'running'
  if (task.status !== 'paused') return null
  if (task.pause?.kind === 'need_context') return 'waiting'
  return HANDOVER_CODES.has(task.pause?.code) ? 'handed_over' : 'stuck'
}

// The options a state offers, each one a thing code can apply (egdesk-browser-task.mjs settle()).
//   continue: the person did their step / gave what was asked -> the loop goes on from the next step
//   retry:    try again from the page as it is now (a stuck or handed-over task; never for a question that still waits for the answer)
//   abandon:  stop the task
//   ask_page: the person asks what is on the page / what the task found: the task stays as it is, the engine answers on its state
//   change:   (only with in-run messages on) the message replaces the request
export function openItemOptions(task, { change = false } = {}) {
  const state = openItemState(task)
  if (state === 'running') return ['abandon', 'ask_page']
  if (state === 'waiting') return ['continue', 'abandon', 'ask_page', ...(change ? ['change'] : [])]
  if (state === 'handed_over' || state === 'stuck') return ['continue', 'retry', 'abandon', 'ask_page', ...(change ? ['change'] : [])]
  return []
}

const word = value => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(value) ? value : null)

/** The item's summary: the person's own request (bounded), the closed state and code, the steps done. No page text, no label, no URL. */
export function openItemSummary(task) {
  const state = openItemState(task)
  if (!state) return null
  const code = state === 'running' ? null : word(task.pause?.code)
  return compactText(`Browser task "${compactText(String(task.goal ?? '').replace(/"/g, "'"), MAX_ITEM_GOAL)}": ${state}${code ? ` (${code})` : ''}, ${task.steps + (state === 'running' ? task.liveStep : 0)} steps done.`, MAX_ITEM_SUMMARY)
}

export function openItemOf(task, options = {}) {
  const state = openItemState(task)
  if (!state) return null
  return Object.freeze({ provider: 'browser', id: task.taskId, kind: OPEN_ITEM_KIND, state, summary: openItemSummary(task), options: Object.freeze(openItemOptions(task, options).map(id => Object.freeze({ id }))) })
}

export const optionQuestionName = id => `open_browser_${id}`
const quoted = text => `"${String(text).replace(/"/g, "'")}"`
const MAX_MESSAGE = 500
const asked = question => (typeof question === 'string' && question.trim() ? `the question ${quoted(compactText(question, 200))}` : 'what was asked')
const ASKS = {
  continue: (message, task) => `Does this message, ${quoted(compactText(message, 200))}, say that the person has done the step the paused browser task waits for, or give what it asked for (${asked(task?.question)})?`,
  retry: message => `Does this message, ${quoted(compactText(message, 200))}, ask to try the browser task again?`,
  abandon: message => `Does this message, ${quoted(compactText(message, 200))}, say the person no longer wants the browser task, or ask to stop it?`,
  ask_page: message => `Does this message, ${quoted(compactText(message, 200))}, ask what the browser page shows or what the task has found so far, without asking to go on or to change the task?`,
  change: (message, task) => `Does this message, ${quoted(compactText(message, 200))}, replace what the task was asked to do (a different target or request) instead of answering ${asked(task?.question)}?`,
}

export function openItemQuestions(task, message, options = {}) {
  return openItemOptions(task, options).map(id => predicateQuestion(optionQuestionName(id), ASKS[id](message, task)))
}

/**
 * readOpenItem(answers, task, { thresholds, change }) -> { kind: 'settled', optionId, p } | { kind: 'none', p } | { kind: 'uncertain', p }
 * R5: exactly one option decided yes (the product's done bar) and every other decided no -> settled. Everything no -> none (an ordinary turn, the task
 * stays as it is). Anything else (two yes, an unknown, a middle probability) -> uncertain: nothing is applied and nothing is asked of the person here.
 */
export function readOpenItem(answers, task, { thresholds, change = false } = {}) {
  const bar = decisionThresholds(thresholds).done
  const ids = openItemOptions(task, { change })
  const read = ids.map(id => ({ id, ...readPredicate(answers, optionQuestionName(id), bar) }))
  const p = Object.fromEntries(read.map(row => [row.id, row.probability]))
  const no = row => row.state === 'no' && row.probability <= 1 - bar
  const yes = read.filter(row => row.state === 'yes')
  if (yes.length === 1 && read.every(row => row === yes[0] || no(row))) return { kind: 'settled', optionId: yes[0].id, p }
  if (!yes.length && read.length && read.every(no)) return { kind: 'none', p }
  return { kind: 'uncertain', p }
}

const EVIDENCE_RULES = 'A browser task of this conversation is open (waiting for the person, or stuck, or running). Decide what the user message means for that task.'
/** decideOpenItem({ message, task, ... }) -> readOpenItem result + usage + ms. One request, one predicate per option. Throws DecisionError. */
export async function decideOpenItem({ message, task, change = false, client, thresholds, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, signal, authorizeDispatch }) {
  const at = performance.now()
  const result = await client.decide({
    input: [{ role: 'developer', content: EVIDENCE_RULES },
      { role: 'user', content: `${openItemSummary(task)}${typeof task.question === 'string' && task.question.trim() ? `\nAsked: ${compactText(task.question, 400)}` : ''}\nUser message: ${compactText(message, MAX_MESSAGE)}` }],
    questions: openItemQuestions(task, message, { change }), timeoutMs, signal, authorizeDispatch,
  })
  return { ...readOpenItem(result.answers, task, { thresholds, change }), usage: result.usage, ms: Math.round(performance.now() - at) }
}

/** The closed note for a settled state that the engine words (no loop ran): status and code of the task as it stands, `settled` naming the option. */
export function settledNote(task, optionId, { lines = [] } = {}) {
  const state = openItemState(task)
  const cancelled = task.status === 'cancelled'
  const body = { id: task.taskId, status: cancelled ? 'cancelled' : state === 'waiting' ? 'need_context' : state === 'running' ? 'running' : 'cannot_proceed',
    ...(!cancelled && state && state !== 'running' && word(task.pause?.code) ? { code: task.pause.code } : {}),
    settled: optionId,
    ...(Array.isArray(lines) && lines.length ? { page: lines.slice(0, 8) } : {}),
    stepsDone: task.steps, actions: { ...task.actions },
    next: optionId === 'ask_page' ? 'answer_user' : 'tell_user' }
  return JSON.stringify({ egdesk_browser_task: body })
}

/**
 * createBrowserOpenItems({ store, entry, change? }) -> the provider the registry consults. `entry` is createDirectBrowserEntry()'s object (its settle()).
 * items() is synchronous and read-only. A conversation has at most one live browser task, so one item.
 */
export function createBrowserOpenItems({ store, entry, change = () => false }) {
  if (!store || typeof store.active !== 'function' || !entry || typeof entry.settle !== 'function') throw new TypeError('createBrowserOpenItems needs the task store and the entry')
  return Object.freeze({
    id: 'browser',
    items(conversationKey) {
      const item = openItemOf(store.active(conversationKey), { change: change() === true })
      return item ? [item] : []
    },
    questions(conversationKey, message) {
      const task = store.active(conversationKey)
      return task ? openItemQuestions(task, message, { change: change() === true }) : []
    },
    read(answers, conversationKey, thresholds) {
      const task = store.active(conversationKey)
      if (!task) return { kind: 'none', p: {} }
      const read = readOpenItem(answers, task, { thresholds, change: change() === true })
      return read.kind === 'settled' ? { ...read, itemId: task.taskId } : read
    },
    async apply(ctx) {
      const out = await entry.settle(ctx)
      return { handled: out.handled === true, ...(typeof out.note === 'string' ? { note: out.note } : {}), settled: ctx.optionId, reason: out.reason ?? null, status: out.status ?? null, resumed: out.resumed === true }
    },
  })
}

