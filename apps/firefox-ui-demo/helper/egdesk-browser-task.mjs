import { randomBytes } from 'node:crypto'
import { DecisionError, FOREGROUND_DECISION_TIMEOUT_MS } from './egdesk-decision-client.mjs'
import { decideHistory, hostOf, labelKey, safePath } from './egdesk-browser-task-history.mjs'
import { choiceQuestion, compactText, decisionThresholds, readChoice, tableOptions } from './egdesk-decision-questions.mjs'

// Direct chat -> objective browser entry (L8 cycle 6; JEV_INTEGRATION_SUGGESTIONS.md §2 Pillar 1, §4.3, §9.3).
//
// Paradigm: the Decision model is a system-level judge. It never speaks to the user and its probability is never
// execution permission. The user's own chat message becomes the goal of an objective browser task directly (no
// subjective sub-goal step). Every objective step offers fixed options (done, need more context from the user,
// cannot proceed); when the judge picks one, control exits to the subjective model, which talks to the user in the
// same DM. The user's next message resumes the same task with that context.
//
// Pieces here (all pure or in-memory; the chat runtime wiring is a separate step, see the cycle report):
// - entryQuestion/readBrowserEntry/decideBrowserEntry: "is this message a browser task, and on which open card" over
//   options the runtime enumerates (granted interact cards) plus two fixed options. It is one choice question, so a
//   caller that already sends a turn-start Decisions request adds it to that request instead of making a second one.
// - createBrowserTaskStore: task id, card, step count, entered values (reflex state), user context, pause reason.
// - createDirectBrowserEntry().handle(): gate, resume-or-enter, run the objective loop, and return either
//   { handled: false, reason } (an ordinary subjective turn) or { handled: true, status, note } where note is the
//   structured, data-minimal text the subjective model receives.
// Auto-execution scope is unchanged (canon §5.2): same-site links, scrolling, entering supplied values. Submit,
// payment, permission and delete are never candidates; the note says "human_step" when only such elements remain.

export const ENTRY_CONTROLS = Object.freeze({
  not_browser_task: 'The message is not asking for something to be done in a browser page.',
  ask_user: 'The message is probably a browser task but it is unclear which listed card it concerns.',
})
export const RESUME_CONTROLS = Object.freeze({
  resume_task: 'The message gives what the paused browser task asked for, or says the blocking step is done.',
  cancel_task: 'The user no longer wants the paused browser task.',
  unrelated: 'The message is about something else; keep the browser task paused.',
})
export const MAX_TASK_STEPS = 24
const SEGMENT_STEPS = 6
const ASKED_CODES = new Set(['choice_needed', 'detail_needed'])
const MAX_MESSAGE = 500
const TTL_MS = 30 * 60 * 1000
const MAX_TASKS = 32

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const label = (index, host) => `[C${index}] ${compactText(host, 60) || 'browser card'}`

/** cards: [{ cardId, host? }] from the run's granted interact cards (code-enumerated, never model-written). */
export function entryOptions(cards) {
  const options = cards.map((card, index) => ({ value: label(index + 1, card.host), description: 'An open Browser Card the user granted to this chat.', cardId: card.cardId }))
  return options
}

export function entryQuestion(cards, { name = 'browser_entry' } = {}) {
  const options = entryOptions(cards)
  return choiceQuestion(name, 'Is the user message a task to carry out in one of the listed browser cards? Pick the card, or a fixed option.',
    [...options.map(({ value, description }) => ({ value, description })), ...tableOptions(ENTRY_CONTROLS)])
}

/**
 * readBrowserEntry(answers, cards, { name?, thresholds? }) → { kind, cardId?, confidence, margin, ranked }
 * kind: 'browser' (a card, confident) | 'not_browser' | 'ask_user' | 'uncertain'. Uncertain never starts a task.
 */
export function readBrowserEntry(answers, cards, { name = 'browser_entry', thresholds: overrides } = {}) {
  const thresholds = decisionThresholds(overrides)
  const picked = readChoice(answers, name, { minConfidence: thresholds.choice, minMargin: thresholds.margin })
  const base = { confidence: picked.confidence, margin: picked.margin, ranked: picked.ranked.map(row => row.probability) }
  if (picked.state !== 'accepted') return { kind: 'uncertain', ...base }
  if (picked.value === 'not_browser_task') return { kind: 'not_browser', ...base }
  if (picked.value === 'ask_user') return { kind: 'ask_user', ...base }
  const option = entryOptions(cards).find(item => item.value === picked.value)
  return option ? { kind: 'browser', cardId: option.cardId, ...base } : { kind: 'uncertain', ...base }
}

const ENTRY_RULES = 'You route one user chat message for EG-Desk. Options are open browser cards the user granted plus fixed options. Pick a card only when the message asks for something to be done on a page in that card.'

/** decideBrowserEntry({ message, cards, client, ... }) → readBrowserEntry result + usage. Throws DecisionError. */
export async function decideBrowserEntry({ message, cards, hints = [], client, thresholds, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, signal, authorizeDispatch }) {
  const result = await client.decide({
    input: [{ role: 'developer', content: ENTRY_RULES }, { role: 'user', content: [`User message: ${compactText(message, MAX_MESSAGE)}`,
      ...(hints.length ? ['Earlier browser tasks on these cards (from this app):', ...hints] : [])].join('\n') }],
    questions: [entryQuestion(cards)], timeoutMs, signal, authorizeDispatch,
  })
  return { ...readBrowserEntry(result.answers, cards, { thresholds }), usage: result.usage, latencyMs: result.latencyMs }
}

const RESUME_RULES = 'A browser task is paused until the user answers. Decide what the user message means for that task.'
export async function decideResume({ message, pause, client, thresholds: overrides, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, signal, authorizeDispatch }) {
  const thresholds = decisionThresholds(overrides)
  const result = await client.decide({
    input: [{ role: 'developer', content: RESUME_RULES },
      { role: 'user', content: `Paused because: ${pause.kind} (${pause.code})\nUser message: ${compactText(message, MAX_MESSAGE)}` }],
    questions: [choiceQuestion('task_resume', 'What does the user message mean for the paused browser task?', tableOptions(RESUME_CONTROLS))],
    timeoutMs, signal, authorizeDispatch,
  })
  const picked = readChoice(result.answers, 'task_resume', { minConfidence: thresholds.choice, minMargin: thresholds.margin })
  return { kind: picked.state === 'accepted' ? picked.value : 'uncertain', confidence: picked.confidence, margin: picked.margin, usage: result.usage }
}

/** One task per conversation, kept in memory only (never persisted, never logged). */
export function createBrowserTaskStore({ now = Date.now, ttlMs = TTL_MS, maxTasks = MAX_TASKS } = {}) {
  const tasks = new Map() // taskId -> task
  const live = task => task && (task.status === 'running' || task.status === 'paused') && now() - task.updatedAt <= ttlMs
  return {
    create({ conversationKey, cardId, goal }) {
      for (const task of tasks.values()) if (task.conversationKey === conversationKey && live(task)) task.status = 'cancelled'
      while (tasks.size >= maxTasks) tasks.delete(tasks.keys().next().value)
      const task = { taskId: `bt_${randomBytes(6).toString('hex')}`, conversationKey, cardId, goal: compactText(goal, MAX_MESSAGE), status: 'running',
        pause: null, userContext: [], state: null, prior: null, trail: [], resolved: [], pendingAsk: null, host: '', steps: 0, actions: { fill: 0, navigate: 0, scroll: 0 }, segments: 0, createdAt: now(), updatedAt: now() }
      tasks.set(task.taskId, task)
      return task
    },
    paused(conversationKey) {
      for (const task of tasks.values()) if (task.conversationKey === conversationKey && task.status === 'paused' && live(task)) return task
      return null
    },
    touch(task) { task.updatedAt = now() },
    get(taskId) { return tasks.get(taskId) ?? null },
    get size() { return tasks.size },
  }
}

const CANNOT = new Set(['blocked', 'access_denied', 'error_page', 'modal_blocking', 'uncertain', 'press_needs_expected_effect', 'tool_failed', 'observe_failed', 'step_rejected'])
const PUBLIC_CODE = /^[A-Za-z][A-Za-z0-9_]{2,63}$/
const tally = (task, result) => {
  for (const step of result.steps || []) {
    for (const action of step.actions || []) {
      if (!action.ok) continue
      if (action.tool === 'egdesk_browser_fill') task.actions.fill++
      else if (action.tool === 'egdesk_browser_navigate') task.actions.navigate++
      else if (action.tool === 'egdesk_browser_scroll') task.actions.scroll++
    }
  }
  task.steps += (result.steps || []).length
  // Content-minimal trail for the next run: the label of each opened element and where, never values or queries.
  for (const step of result.steps || []) {
    if (!step.opened || !(step.actions || []).some(action => action.ok && action.tool === 'egdesk_browser_navigate')) continue
    if (!task.host) task.host = hostOf(step.url)
    const label = labelKey(step.opened.option)
    task.trail.push({ op: 'open', label, from: safePath(step.url), to: safePath(step.opened.to) })
    if (task.pendingAsk) { task.resolved.push({ asked: task.pendingAsk, chose: label, at: safePath(step.url) }); task.pendingAsk = null }
  }
  if (!task.host) task.host = hostOf(result.steps?.[0]?.url)
}

/** The one structured line the subjective model receives. Closed vocabulary, counts, and (for a choice) up to three element labels. */
export function subjectiveNote(task, { status, code, candidates = [], detail }) {
  const body = { id: task.taskId, status, ...(code ? { code } : {}),
    ...(candidates.length ? { candidates: candidates.slice(0, 3).map(item => compactText(item.replace(/^\[[A-Z]\d+\]\s*/, ''), 60)) } : {}),
    ...(typeof detail === 'string' && PUBLIC_CODE.test(detail) ? { detail } : {}),
    stepsDone: task.steps, actions: { ...task.actions } }
  const next = status === 'done' ? 'report_to_user' : status === 'need_context' ? 'ask_user_in_chat' : 'tell_user_and_ask_in_chat'
  return JSON.stringify({ egdesk_browser_task: { ...body, next } })
}

/**
 * createDirectBrowserEntry({ provider, store, calibration?, thresholds?, timeoutMs? })
 * handle({ run, conversationKey, message, hosts? }) → { handled: false, reason } | { handled: true, status, note, taskId, resumed }
 * Gate: the provider's reflex gate (mode on + key). Off or no key: nothing is called.
 */
export function createDirectBrowserEntry({ provider, store, history = null, calibration = null, thresholds, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS } = {}) {
  if (!provider || typeof provider.runDirectTask !== 'function' || typeof provider.reflexScope !== 'function') throw new TypeError('provider must offer runDirectTask')
  const note = (key, raw) => { try { calibration?.record?.(raw) } catch { /* recording never changes behaviour */ } return key }
  const record1 = (answers, count, would, fallback) => {
    const row = answers?.rows
    const raw = { feature: 'browser_reflex', mode: 'on', candidates: count, ...(fallback ? { fallback } : {}),
      judgments: row ? [{ q: 'choice', top: row.top, second: row.second, p: row.p, confidence: row.p, options: count + Object.keys(ENTRY_CONTROLS).length,
        margin: row.top - row.second, threshold: decisionThresholds(thresholds).choice, minMargin: decisionThresholds(thresholds).margin, would }] : [] }
    return note(null, raw)
  }

  async function loop(run, task, hosts) {
    // Segments of a few steps; the task's total budget survives pauses.
    for (;;) {
      const remaining = MAX_TASK_STEPS - task.steps
      if (remaining <= 0) return finishPause(task, { kind: 'cannot_proceed', code: 'step_limit' }, null)
      const result = await provider.runDirectTask(run, { cardId: task.cardId, goal: task.goal, userContext: task.userContext, resumeState: task.state, priorRun: task.prior,
        maxSteps: Math.min(SEGMENT_STEPS, remaining), callId: `${task.taskId}.s${++task.segments}` })
      tally(task, result)
      task.state = record(result.state) ? result.state : task.state
      store.touch(task)
      if (result.outcome === 'max_steps' && result.reason !== 'step_rejected') continue
      return fromResult(task, result)
    }
  }

  // One content-minimal record per task (upsert by id): done, or where it got stuck. Never fatal.
  function remember(task, run, outcome) {
    try {
      const ownerKey = provider.currentOwnerKey?.()
      if (!history || !ownerKey || !task.host) return
      history.record({ ownerKey, id: task.taskId, host: task.host, goal: task.goal, outcome, trail: task.trail, resolved: task.resolved, steps: task.steps })
    } catch { /* history never changes the task */ }
  }

  function finishPause(task, pause, result, extra = {}) {
    task.status = 'paused'; task.pause = pause; store.touch(task)
    if (pause.kind === 'need_context' && ASKED_CODES.has(pause.code)) task.pendingAsk = pause.code
    else remember(task, null, { status: 'stuck', code: pause.code })
    const status = pause.kind === 'need_context' ? 'need_context' : 'cannot_proceed'
    return { handled: true, status: 'paused', taskId: task.taskId,
      note: subjectiveNote(task, { status, code: pause.code, candidates: extra.candidates, detail: extra.detail }) }
  }

  function fromResult(task, result) {
    switch (result.outcome) {
      case 'done':
        task.status = 'done'; task.pause = null; store.touch(task)
        remember(task, null, { status: 'done' })
        return { handled: true, status: 'done', taskId: task.taskId, note: subjectiveNote(task, { status: 'done' }) }
      case 'needs_user_context': return finishPause(task, { kind: 'need_context', code: 'choice_needed' }, result, { candidates: result.candidates || [] })
      case 'needs_free_text': return finishPause(task, { kind: 'need_context', code: 'detail_needed' }, result)
      case 'handoff': return finishPause(task, { kind: 'cannot_proceed', code: typeof result.pageState === 'string' ? result.pageState : 'sensitive_flow' }, result)
      case 'escalated': {
        const last = (result.steps || []).at(-1)
        const humanStep = result.reason === 'blocked' && (last?.excluded?.gated ?? 0) > 0
        const code = humanStep ? 'human_step' : CANNOT.has(result.reason) ? result.reason : 'blocked'
        return finishPause(task, { kind: 'cannot_proceed', code }, result, { detail: result.code })
      }
      case 'max_steps': return finishPause(task, { kind: 'cannot_proceed', code: 'step_rejected' }, result, { detail: result.code })
      case 'fallback': // the judge is unavailable: today's behaviour, the subjective model drives the tools itself
        task.status = 'cancelled'; store.touch(task)
        return { handled: false, reason: `fallback:${result.reason || 'unavailable'}` }
      default: task.status = 'cancelled'; return { handled: false, reason: `outcome:${result.outcome}` }
    }
  }

  // History step: code enumerates permitted earlier records for this site; the Decision model picks the same task or none
  // (no candidates means no request); the host fetches it again with the permission check. Any failure means no history.
  async function lookupPrior({ message, ownerKey, host, gateScope }) {
    try {
      if (!history || !ownerKey || !host) return null
      const found = history.candidates({ ownerKey, hosts: [host] })
      if (!found.length) return null
      const records = found.map(item => history.fetch({ ownerKey, hosts: [host], id: item.id })).filter(Boolean)
      if (!records.length) return null
      const pick = await decideHistory({ message, records, client: gateScope.client, thresholds, timeoutMs, authorizeDispatch: gateScope.authorizeDispatch })
      if (!gateScope.isDecisionCurrent()) return null
      return pick.kind === 'record' ? history.fetch({ ownerKey, hosts: [host], id: pick.id }) : null
    } catch { return null }
  }

  return {
    async handle({ run, conversationKey, message, hosts = {} }) {
      if (typeof message !== 'string' || !message.trim()) return { handled: false, reason: 'empty' }
      const cards = (run?.browserBinding?.cards || []).filter(card => card.permission === 'interact').map(card => ({ cardId: card.cardId, host: hosts[card.cardId] || '' }))
      if (!cards.length) return { handled: false, reason: 'no_card' }
      if (typeof provider.directEntryEnabled !== 'function' || !provider.directEntryEnabled()) return { handled: false, reason: 'mode_off' }
      const gateScope = provider.reflexScope(run, { callId: 'direct-entry', namespace: null }, cards[0].cardId)
      if (!gateScope.client) return { handled: false, reason: 'mode_off' }
      const paused = store.paused(conversationKey)
      try {
        if (paused) {
          const resume = await decideResume({ message, pause: paused.pause, client: gateScope.client, thresholds, timeoutMs, authorizeDispatch: gateScope.authorizeDispatch })
          if (!gateScope.isDecisionCurrent()) return { handled: false, reason: 'evidence_unavailable' }
          if (resume.kind === 'cancel_task') { paused.status = 'cancelled'; return { handled: false, reason: 'task_cancelled' } }
          if (resume.kind !== 'resume_task') return { handled: false, reason: resume.kind === 'unrelated' ? 'unrelated' : 'uncertain' }
          paused.userContext.push(compactText(message, MAX_MESSAGE)); paused.status = 'running'; paused.pause = null
          const out = await loop(run, paused, hosts)
          return { ...out, resumed: true }
        }
        const ownerKey = provider.currentOwnerKey?.() ?? null
        const hints = history && ownerKey ? cards.map((card, i) => { const goal = card.host ? history.latestGoal({ ownerKey, host: card.host }) : null; return goal ? `[C${i + 1}] ${compactText(goal, 80)}` : null }).filter(Boolean).slice(0, 4) : []
        const entry = await decideBrowserEntry({ message, cards, hints, client: gateScope.client, thresholds, timeoutMs, authorizeDispatch: gateScope.authorizeDispatch })
        if (!gateScope.isDecisionCurrent()) return { handled: false, reason: 'evidence_unavailable' }
        record1({ rows: { top: entry.ranked[0] ?? 0, second: entry.ranked[1] ?? 0, p: entry.confidence ?? 0 } }, cards.length, entry.kind === 'browser' ? 'act' : 'hold')
        if (entry.kind !== 'browser') return { handled: false, reason: entry.kind }
        const task = store.create({ conversationKey, cardId: entry.cardId, goal: message })
        task.prior = await lookupPrior({ run, task, message, ownerKey, host: cards.find(card => card.cardId === entry.cardId)?.host, gateScope })
        return await loop(run, task, hosts)
      } catch (error) {
        record1({}, cards.length, 'hold', error instanceof DecisionError && ['timeout', 'unreachable', 'bad_response', 'budget_exceeded', 'evidence_unavailable', 'not_configured'].includes(error.code) ? error.code : null)
        return { handled: false, reason: error instanceof DecisionError ? `fallback:${error.code}` : 'error' }
      }
    },
  }
}
