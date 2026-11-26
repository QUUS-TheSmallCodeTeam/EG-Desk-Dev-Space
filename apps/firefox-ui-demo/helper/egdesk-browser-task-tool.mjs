import { compactText, decisionThresholds } from './egdesk-decision-questions.mjs'
import { NO_FIELD_TEXT, candidateSpans, pickFieldText, undecidedField } from './egdesk-browser-field-text.mjs'
import { FOREGROUND_DECISION_TIMEOUT_MS } from './egdesk-decision-client.mjs'
import { PAGE_TEXT_FLAG, askedFieldTarget, buildReflexCandidates, localDay, navigationLanded, optionOp, optionTarget, reflexActionArgs } from './egdesk-browser-reflex.mjs'
import { MAX_TASK_STEPS, createBrowserTaskStore, taskStepEvent } from './egdesk-browser-task.mjs'

// L8 a1 ('교대' round, owner 2026-11-26: "decision model 이랑 대화형 모델이 같은 세션에서 같은 맥락으로 번갈아가면서 사용자 요청을 빠르게 수행"): the browser task as ONE tool
// the conversation model (Claude through the EG-Desk MCP catalog, Codex through the own-tools path: both read the page tools provider's specs(), which carries this
// tool when its flag is on) calls as often as it needs inside its own turn. The objective loop (egdesk-browser-reflex.mjs, the provider's runDirectTask) decides each
// step (operation and element in one Decision request) until the goal is met or it needs the model; the model then gives what only it can give and calls again:
//   needs_value     a field needs text the decision model cannot write: values { name: text } (the model's own words, or the person's)
//   needs_guidance  several listed elements fit, or the step was undecided: guidance { choose: <an id from options> }, or the model asks the person
//   human_step      sign-in, a code, a check, payment, permission, a submit that writes: the person's own step on the page
//   cannot          see code (the model may use egdesk_card_read / egdesk_card_press / egdesk_card_type itself)
//   done            the page shows what the goal asked for
// The decision model never writes a value: it CHOOSES where a named value goes (mapValuesToFields), and when no value was given it chooses among the spans code cut
// out of the person's message and the goal (pickFieldText; none = needs_value). Every page action is still the Browser provider's own dispatch for the same run
// (the run binding, the Card grant, the action gate, same-site navigation, receipts). A read-only GET search (the c20/c25 proof readOnlyPress, the same the page
// tools trust) is submitted by the loop at once (owner 2026-11-26 16:00: "검색 제출 자동: 허용"); pay, grant, delete and a submit that writes are never candidates.
// Step events (taskStepEvent): one per page action, to onStep(run, event) (lane L5 carries them through the runtime, lane L1 draws them).
// Developer flag EGDESK_BROWSER_TASK_TOOL=on (default off; it needs EGDESK_PAGE_TOOLS=on and the decision model on). The tool name is provisional (one constant).

export const BROWSER_TASK_TOOL_NAME = 'egdesk_browser_task' // provisional: the owner names model-facing tools; change it here only
export const BROWSER_TASK_TOOL_FLAG = 'EGDESK_BROWSER_TASK_TOOL'
export const browserTaskToolEnabled = env => env?.[BROWSER_TASK_TOOL_FLAG] === 'on'
export const BROWSER_TASK_PAGE_TEXT_FLAG = PAGE_TEXT_FLAG // one flag (egdesk-browser-reflex.mjs) for the tool, the loop and the direct entry: on = the page's own text may be sent
export const BROWSER_TASK_STATUSES = Object.freeze(['done', 'needs_value', 'needs_guidance', 'human_step', 'cannot'])
export const BROWSER_TASK_LIMITS = Object.freeze({ goal: 500, values: 20, valueName: 80, valueChars: 500, choose: 40, cardId: 160, options: 6, optionLabel: 60, spans: 60, spanWords: 6, message: 600, segment: 6 })
export { NO_FIELD_TEXT, candidateSpans, pickFieldText } // a1: the span choice lives in egdesk-browser-field-text.mjs (the direct entry uses it too)
export const BROWSER_TASK_NOTE = 'Not for the person: status, code, op and the other fields are EG-Desk\'s own markings. Say what happened in everyday words.'

export const BROWSER_TASK_TOOL_SPEC = Object.freeze({
  type: 'function', name: BROWSER_TASK_TOOL_NAME,
  description: 'Hand a browser task on a Card the person granted for operation (their Browser card menu: Chat 조작 허용) to EG-Desk\'s fast decision loop instead of one tool call per click. ' +
    'It opens same-site links, types the values you give into the fields they belong in, runs read-only searches and scrolls, deciding each step in well under a second, until the goal is met or it needs you. ' +
    'Give values for anything to type that the person did not say word for word (it only picks text from their message, it never writes). A link to another site is offered in options; choosing it asks the person about that site. ' +
    'Call it again in the same turn as often as needed: with values when it answers needs_value, with guidance {choose: id} (an id from options) when it answers needs_guidance, and without goal to continue the same task. ' +
    'status: done | needs_value (ask.field needs text: give it in values, or ask the person) | needs_guidance (choose one of options, or ask the person) | human_step (sign-in, a code, payment, permission or a submit only the person may do) | cannot (see code; you may use egdesk_card_read, egdesk_card_press and egdesk_card_type yourself). ' +
    'It never pays, grants permission, deletes or submits a form that writes. The result fields are for you only: tell the person what happened in everyday words.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      goal: { type: 'string', maxLength: BROWSER_TASK_LIMITS.goal, description: 'What to do on the page, in the person\'s words. Omit to continue the current task.' },
      values: { type: 'object', additionalProperties: { type: 'string', maxLength: BROWSER_TASK_LIMITS.valueChars }, description: 'Text to type, each under a short name for what it is, e.g. {"검색어": "장화 신은 고양이"}.' },
      guidance: { type: 'object', additionalProperties: false, required: ['choose'], properties: { choose: { type: 'string', maxLength: BROWSER_TASK_LIMITS.choose, description: 'An id from the last result\'s options.' } } },
      cardId: { type: 'string', description: 'Omit when exactly one Card is granted for operation.' },
    },
  },
})

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const CODE = /^[A-Za-z][A-Za-z0-9_]{2,63}$/
const OPTION_VALUE = /^\[([A-Z])\d+\]\s*/
const strip = value => compactText(String(value ?? '').replace(OPTION_VALUE, ''), BROWSER_TASK_LIMITS.optionLabel)
const hostOf = url => { try { return new URL(url).host.toLowerCase() } catch { return null } }
// every result carries the "not for the person" note (the harness rule the page tools follow, u8 D23): its fields are EG-Desk's markings, never words for the person
const reply = body => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ ...body, forYouOnly: BROWSER_TASK_NOTE }) }] })

export function validateTaskArgs(args) {
  if (!record(args)) return 'arguments must be an object'
  const allowed = new Set(['goal', 'values', 'guidance', 'cardId'])
  if (Object.keys(args).some(key => !allowed.has(key))) return 'unknown argument'
  if (args.goal !== undefined && (typeof args.goal !== 'string' || args.goal.length > BROWSER_TASK_LIMITS.goal)) return `goal must be at most ${BROWSER_TASK_LIMITS.goal} characters`
  if (args.cardId !== undefined && (typeof args.cardId !== 'string' || !args.cardId || args.cardId.length > BROWSER_TASK_LIMITS.cardId)) return 'cardId must be a Card id'
  if (args.values !== undefined) {
    if (!record(args.values)) return 'values must be an object of strings'
    const entries = Object.entries(args.values)
    if (entries.length > BROWSER_TASK_LIMITS.values) return `at most ${BROWSER_TASK_LIMITS.values} values`
    if (entries.some(([key, value]) => !key.trim() || key.length > BROWSER_TASK_LIMITS.valueName || typeof value !== 'string' || !value.length || value.length > BROWSER_TASK_LIMITS.valueChars)) {
      return `values must map short names to texts of 1 to ${BROWSER_TASK_LIMITS.valueChars} characters`
    }
  }
  if (args.guidance !== undefined && (!record(args.guidance) || Object.keys(args.guidance).some(key => key !== 'choose') || typeof args.guidance.choose !== 'string' || !args.guidance.choose || args.guidance.choose.length > BROWSER_TASK_LIMITS.choose)) return 'guidance must be {choose: an option id}'
  return null
}

/** The first interact Card the call names, else the only one; else a closed refusal code. */
export function pickTaskCard(cards, cardId) {
  const interact = (Array.isArray(cards) ? cards : []).filter(card => card?.permission === 'interact')
  if (!interact.length) return { error: 'TASK_NO_INTERACT_CARD' }
  if (typeof cardId === 'string' && cardId) return interact.some(card => card.cardId === cardId) ? { cardId } : { error: 'TASK_CARD_NOT_GRANTED' }
  return interact.length === 1 ? { cardId: interact[0].cardId } : { error: 'TASK_CARD_REQUIRED', cardIds: interact.map(card => card.cardId).slice(0, 4) }
}

const opOfValue = value => { const kind = OPTION_VALUE.exec(String(value ?? ''))?.[1]; return kind === 'L' ? 'open' : kind === 'F' ? 'fill' : 'press' }
/** The elements the model may choose between (option values '[L1] label'), as ids and short labels; the task remembers the values for the guidance call. */
function offer(task, values, code, outside = []) {
  const seen = new Set()
  const list = (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && OPTION_VALUE.test(value) && !seen.has(value) && seen.add(value))
  // the same site's elements first (what the loop itself ranked), then links to another site (each asks the person about its site when chosen)
  const links = Array.isArray(outside) ? outside : []
  const near = list.slice(0, links.length ? BROWSER_TASK_LIMITS.options - 2 : BROWSER_TASK_LIMITS.options)
  const far = links.slice(0, BROWSER_TASK_LIMITS.options - near.length)
  task.offered = [...near.map(value => ({ value, label: strip(value), op: opOfValue(value) })), ...far.map(link => ({ label: compactText(link.label, BROWSER_TASK_LIMITS.optionLabel), op: 'open', href: link.href, site: hostOf(link.href) }))]
    .map((item, index) => ({ id: `o${index + 1}`, ...item }))
  return { status: 'needs_guidance', code: far.length && !near.length ? 'outside_site' : code, options: task.offered.map(({ id, label, site }) => ({ id, label, ...(site ? { site } : {}) })), ...(task.offered.length ? {} : { next: 'read_the_card' }) }
}

/** outcomeBody(task, result) -> { status, code?, ask?, options?, controls?, target?, next? }: the reflex result in the tool's closed words. */
// outside: the links to another site on the page the loop ended on (onPage offSite); they are offered where the loop found no way on (the person is asked about the site).
export function outcomeBody(task, result, { outside = [] } = {}) {
  const r = record(result) ? result : {}
  const far = Array.isArray(outside) ? outside.filter(link => typeof link?.label === 'string' && link.label && typeof link.href === 'string') : []
  switch (r.outcome) {
    case 'done': return { status: 'done' }
    case 'needs_free_text': {
      const fields = Array.isArray(r.fields) ? r.fields : []
      const label = typeof r.label === 'string' && r.label ? compactText(r.label, BROWSER_TASK_LIMITS.optionLabel) : r.field ? strip(r.field) : fields.length ? strip(fields[0]) : null
      return { status: 'needs_value', ask: { field: label, kind: 'text' }, ...(fields.length > 1 ? { fields: fields.slice(0, BROWSER_TASK_LIMITS.options).map(strip) } : {}) }
    }
    case 'needs_user_context': return offer(task, r.candidates, 'choice_needed')
    case 'page_unclear': task.offered = []; return { status: 'needs_guidance', code: 'page_unclear', options: [], next: 'read_the_card' }
    case 'handoff': task.offered = []; return { status: 'human_step', code: CODE.test(r.pageState ?? '') ? r.pageState : 'sensitive_flow' }
    case 'escalated': {
      if (r.reason === 'human_step') { task.offered = []; return { status: 'human_step', code: 'person_only_controls', ...(r.staleBy === 'user-hold' ? { staleBy: r.staleBy } : {}), ...(Array.isArray(r.controls) && r.controls.length ? { controls: r.controls.filter(label => typeof label === 'string').slice(0, 3).map(label => compactText(label, BROWSER_TASK_LIMITS.optionLabel)) } : {}) } }
      if (r.reason === 'uncertain') return offer(task, (r.ranked || []).map(row => row?.value), 'uncertain', far)
      if (r.reason === 'blocked' && far.length) return offer(task, [], 'outside_site', far)
      task.offered = []
      if (r.reason === 'press_needs_expected_effect') return { status: 'human_step', code: 'press_needs_expected_effect', ...(r.suggestion?.option ? { target: strip(r.suggestion.option) } : {}) }
      return { status: 'cannot', code: CODE.test(r.reason ?? '') ? r.reason : 'blocked', ...(CODE.test(r.code ?? '') ? { detail: r.code } : {}) }
    }
    case 'max_steps': if (r.reason === 'step_limit' && far.length) return offer(task, [], 'outside_site', far); task.offered = []; return { status: 'cannot', code: r.reason === 'step_limit' ? 'step_limit' : 'step_rejected', ...(CODE.test(r.code ?? '') ? { detail: r.code } : {}) }
    case 'fallback': task.offered = []; return { status: 'cannot', code: 'decision_unavailable', next: 'use_card_tools' }
    case 'aborted': task.offered = []; return { status: 'cannot', code: 'aborted' }
    case 'guidance_unknown': return { status: 'needs_guidance', code: 'option_unknown', options: (task.offered || []).map(({ id, label }) => ({ id, label })) }
    case 'guidance_gone': task.offered = []; return { status: 'cannot', code: 'option_gone', next: 'read_the_card' }
    default: task.offered = []; return { status: 'cannot', code: 'blocked' }
  }
}

/**
 * createBrowserTaskTool({ browser, store?, now?, clock?, messageOf?, onStep?, thresholds?, timeoutMs?, maxSteps? }) -> { name, spec, store, handle(run, event) }
 *   browser: the Browser tool provider (runDirectTask, reflexScope, directEntryEnabled), called for the SAME run
 *   messageOf(run): the person's message of this turn (optional; lane L5 wires it): its spans are candidates for a field nobody gave a value for
 *   onStep(run, event): each page action as the step event contract (an observer: it never changes the task)
 * One task per conversation (the store's create cancels an older one); a call without goal continues the conversation's open task.
 */
// pageText (default false): whether the loop's judgments may read the page's own text. Off (Main's brief of the owner's 16:00 answer: control names and values on every site, no body
// text): they read the title and the controls instead (withoutPageText). On: the page text as the direct entry sends it (the run's page_text gate decides as always).
// storeOf() (optional): the runtime's task store (the direct entry's, lane L5's browserTasks()): the tool and the entry then continue the same task; without it (or while it
// answers null) the tool keeps its own store.
export function createBrowserTaskTool({ browser, store = createBrowserTaskStore(), storeOf = null, now = Date.now, clock = Date.now, messageOf = null, onStep = null, thresholds, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, maxSteps = MAX_TASK_STEPS, pageText = false } = {}) {
  if (!browser || typeof browser.runDirectTask !== 'function' || typeof browser.reflexScope !== 'function') throw new TypeError('the task tool needs the Browser provider (runDirectTask, reflexScope)')
  const t = decisionThresholds(thresholds)
  const busy = new Set()
  const tasksNow = () => { try { const shared = typeof storeOf === 'function' ? storeOf() : null; return shared && typeof shared.create === 'function' && typeof shared.active === 'function' ? shared : store } catch { return store } }
  const decisionOff = () => typeof browser.directEntryEnabled === 'function' && browser.directEntryEnabled() !== true
  const OFF = Object.freeze({ status: 'cannot', code: 'decision_unavailable', next: 'use_card_tools' })
  let pagePress = null // the page tools' own press (bound by the page tools provider): a link to another site goes through its site question
  const message = run => { try { const text = typeof messageOf === 'function' ? messageOf(run) : null; return typeof text === 'string' && text.trim() ? compactText(text, BROWSER_TASK_LIMITS.message) : null } catch { return null } }

  function eventsFor(run, task, sink) {
    return (info, by = 'decision', status = null) => {
      const event = taskStepEvent(task, info, { seq: (task.eventSeq ?? 0) + 1, by, status })
      if (!event) return
      task.eventSeq = event.seq
      if (event.op !== 'end') sink.push(event)
      if (typeof onStep === 'function') { try { onStep(run, event) } catch { /* an observer never affects the task */ } }
    }
  }

  // A field nobody gave a value for: the decision model chooses among the spans of the person's message and the goal (one request). null = ask the model.
  async function textFromSpans(run, event, task, result, page) {
    const fields = Array.isArray(result.fields) ? result.fields : []
    const field = typeof result.field === 'string' && result.field ? result.field : fields.length === 1 ? fields[0] : null
    if (!field) return null
    const label = typeof result.label === 'string' && result.label ? result.label : strip(field)
    const key = `${page?.host ?? ''}|${label}`
    if (task.spanTried.includes(key)) return null
    task.spanTried.push(key)
    const said = message(run)
    const spans = candidateSpans([said, task.goal])
    if (!spans.length) return null
    const scope = browser.reflexScope(run, { callId: `${event?.callId ?? task.taskId}.text`, namespace: null }, task.cardId)
    if (!scope?.client) return null
    let picked
    try { picked = await pickFieldText({ client: scope.client, goal: task.goal, message: said, field: label, host: page?.host ?? null, spans, thresholds: t, timeoutMs, authorizeDispatch: scope.authorizeDispatch }) } catch { return null }
    if (typeof scope.isDecisionCurrent === 'function' && !scope.isDecisionCurrent()) return null
    if (!picked.text) return null
    task.spanPicks = (task.spanPicks ?? 0) + 1
    return { [field]: picked.text } // the option value as the name: the loop binds it to that field without another request
  }

  // guidance { choose }: the element the model chose among the last options, found again on the page as it is now and acted on (only what the loop itself may do).
  async function guide(run, event, task, choose, onPage, emit) {
    const offered = (task.offered || []).find(item => item.id === choose)
    if (!offered) return { outcome: 'guidance_unknown' }
    const scope = browser.reflexScope(run, { callId: `${event?.callId ?? task.taskId}.guide`, namespace: null }, task.cardId, { actor: 'model' })
    const t0 = clock()
    if (offered.href) return outside(run, event, task, offered, scope, onPage, emit, t0)
    let observed
    try { observed = await scope.callTool('egdesk_browser_observe', { cardId: task.cardId }) } catch (error) { return { outcome: 'escalated', reason: 'observe_failed', ...(CODE.test(error?.code ?? '') ? { code: error.code } : {}) } }
    const snapshot = observed?.snapshot
    if (!record(snapshot) || typeof observed?.observationId !== 'string' || !Number.isSafeInteger(snapshot.revision)) return { outcome: 'escalated', reason: 'observe_failed' }
    onPage({ title: compactText(typeof snapshot.title === 'string' ? snapshot.title : '', 120) || null, host: hostOf(snapshot.url) })
    const { options } = buildReflexCandidates(snapshot, { textComboboxes: true })
    const match = options.find(option => option.value === offered.value) ?? options.find(option => optionTarget(option) === offered.label && optionOp(option) === offered.op) ?? null
    if (!match) return { outcome: 'guidance_gone' }
    const planned = reflexActionArgs(match, { cardId: task.cardId, observationId: observed.observationId, snapshot })
    if (planned.needsText) return { outcome: 'needs_free_text', field: match.value, label: compactText(match.item.element.label, 100), fieldTarget: askedFieldTarget(snapshot, match) }
    if (planned.escalate) return { outcome: 'escalated', reason: planned.escalate, suggestion: { option: match.value } }
    const meta = { op: optionOp(match), target: optionTarget(match) }
    try {
      await scope.callTool(planned.tool, planned.args)
      emit({ action: planned.tool, ok: true, stepMs: clock() - t0, ...meta }, 'model')
    } catch (error) {
      // a navigation the site redirected or extended: the page that loaded decides (the same rule as the loop's steps and the page tools)
      let landed = false
      if (planned.tool === 'egdesk_browser_navigate') {
        try { await scope.callTool('egdesk_browser_wait', { cardId: task.cardId, for: 'load', timeoutMs: 5000 }) } catch { /* observe as it is */ }
        try { landed = navigationLanded({ actual: (await scope.callTool('egdesk_browser_observe', { cardId: task.cardId }))?.snapshot?.url, expected: planned.args.url, from: snapshot.url, submitted: match.item.readOnly?.kind === 'get_form' }) } catch { landed = false }
      }
      if (!landed) {
        const code = CODE.test(error?.code ?? '') ? error.code : 'TOOL_FAILED'
        emit({ failed: planned.tool, ok: false, stepMs: clock() - t0, code, ...meta }, 'model')
        return { outcome: 'escalated', reason: 'tool_failed', code }
      }
      emit({ action: planned.tool, ok: true, stepMs: clock() - t0, ...meta }, 'model')
    }
    try { await scope.callTool('egdesk_browser_wait', match.item.kind === 'navigate' || match.item.readOnly?.kind === 'get_form' ? { cardId: task.cardId, for: 'load', timeoutMs: 10000 } : { cardId: task.cardId, for: 'idle', timeoutMs: 5000 }) } catch { /* the next observation shows the page as it is */ }
    task.userContext.push(`Chosen in the chat for this task: ${offered.label}`)
    task.steps += 1
    task.offered = []
    return null
  }

  // A link to another site the model chose: pressed through the page tools, which find it again by its address on a fresh observation, ask the person about the site (the
  // Card's question) and follow it once. Refused or unanswered: nothing moved.
  async function outside(run, event, task, offered, scope, onPage, emit, t0) {
    if (typeof pagePress !== 'function') return { outcome: 'escalated', reason: 'outside_site_unavailable' }
    let out = null
    try { out = JSON.parse((await pagePress(run, { tool: 'egdesk_card_press', callId: `${event?.callId ?? task.taskId}.site`, arguments: { cardId: task.cardId } }, { cardId: task.cardId, href: offered.href }))?.contentItems?.[0]?.text ?? 'null') } catch { out = null }
    if (out?.status === 'refused' && out?.code === 'PAGE_REF_UNKNOWN') return { outcome: 'guidance_gone' }
    const meta = { op: 'open', target: compactText(offered.label, 40) }
    if (out?.status !== 'pressed') {
      emit({ failed: 'egdesk_browser_navigate', ok: false, stepMs: clock() - t0, ...meta, ...(CODE.test(out?.code ?? '') ? { code: out.code } : {}) }, 'model')
      if (out?.status === 'person_step') return { outcome: 'escalated', reason: 'human_step', controls: [offered.label] }
      return { outcome: 'escalated', reason: out?.site === 'site-refused' || out?.code === 'BROWSER_NAVIGATE_OUT_OF_SCOPE' ? 'site_not_allowed' : 'tool_failed', ...(CODE.test(out?.code ?? '') ? { code: out.code } : {}) }
    }
    emit({ action: 'egdesk_browser_navigate', ok: true, stepMs: clock() - t0, ...meta }, 'model')
    try { await scope.callTool('egdesk_browser_wait', { cardId: task.cardId, for: 'load', timeoutMs: 10000 }) } catch { /* the next observation shows the page as it is */ }
    onPage({ title: null, host: offered.site ?? null, offSite: [] })
    task.userContext.push(`Chosen in the chat for this task: ${offered.label} (on ${offered.site ?? 'another site'})`)
    task.steps += 1
    task.offered = []
    return null
  }

  async function work(run, event, task, args, started, store) {
    const steps = []
    const emit = eventsFor(run, task, steps)
    let page = task.lastPage ?? null
    const observer = info => { store.progress?.(task, info); emit(info) }
    const onPage = info => { page = { title: info?.title ?? null, host: info?.host ?? null, offSite: Array.isArray(info?.offSite) ? info.offSite : [] }; task.lastPage = page }
    task.status = 'running'; task.pause = null
    let values = record(args.values) ? { ...args.values } : {}
    let resumeState = task.state
    if (task.askedField && !args.guidance) resumeState = { ...resumeState, askedField: task.askedField }
    task.askedField = null
    let result = null
    if (args.guidance) result = await guide(run, event, task, args.guidance.choose, onPage, emit)
    while (!result) {
      const remaining = maxSteps - task.steps
      if (remaining <= 0) { result = { outcome: 'max_steps', reason: 'step_limit' }; break }
      const out = await browser.runDirectTask(run, { cardId: task.cardId, goal: task.goal, ...(Object.keys(values).length ? { values } : {}), userContext: task.userContext, resumeState,
        maxSteps: Math.min(BROWSER_TASK_LIMITS.segment, remaining), callId: `${task.taskId}.s${++task.segments}`, onStep: observer, onPage, today: localDay(now()), textComboboxes: true, valuesFirst: true, actor: 'decision', pageText: pageText === true })
      values = {}
      task.state = record(out?.state) ? out.state : task.state
      resumeState = task.state
      task.steps += Array.isArray(out?.steps) ? out.steps.length : 0
      store.touch(task)
      if (out?.outcome === 'max_steps' && out.reason !== 'step_rejected') continue
      if (out?.outcome === 'needs_free_text') {
        const found = await textFromSpans(run, event, task, out, page)
        if (found) { values = found; continue }
      }
      // an undecided step whose top choices hold a text field, with nothing left to type: the step is about the text for that field (the same span choice)
      const pendingText = Array.isArray(task.state?.pending) && task.state.pending.length > 0
      const rankedField = out?.outcome === 'escalated' && out.reason === 'uncertain' && !pendingText ? undecidedField(out) : null
      if (rankedField) {
        const found = await textFromSpans(run, event, task, { field: rankedField }, page)
        if (found) { values = found; continue }
      }
      result = out ?? { outcome: 'fallback' }
    }
    const body = outcomeBody(task, result, { outside: typeof pagePress === 'function' ? page?.offSite ?? [] : [] })
    if (body.status === 'needs_value' && result.fieldTarget) task.askedField = { ...result.fieldTarget, name: body.ask.field }
    task.status = body.status === 'done' ? 'done' : body.code === 'decision_unavailable' ? 'cancelled' : 'paused'
    task.pause = task.status === 'paused' ? { kind: body.status === 'needs_value' || body.status === 'needs_guidance' ? 'need_context' : 'cannot_proceed', code: body.code ?? body.status } : null
    store.touch(task)
    const elapsedMs = Math.max(0, clock() - started)
    emit({ op: 'end', code: body.code, ok: body.status === 'done', stepMs: elapsedMs }, 'decision', body.status)
    return { ...body, taskId: task.taskId,
      steps: steps.map(step => ({ op: step.op, ...(step.target ? { target: step.target } : {}), ...(step.valueName ? { valueName: step.valueName } : {}), ok: step.ok, ms: step.ms, ...(step.by === 'model' ? { by: 'model' } : {}) })),
      page: { title: page?.title ?? null, host: page?.host ?? null }, elapsedMs }
  }

  async function handle(run, event) {
    const started = clock()
    const args = record(event?.arguments) ? event.arguments : {}
    const invalid = validateTaskArgs(args)
    if (invalid) return reply({ status: 'cannot', code: 'TASK_ARGS_INVALID', detail: invalid })
    // the person's chat id first: the direct entry keeps its tasks under it (runBrowserEntryOn: context.clientThreadId), so a call without goal finds the task the entry left (L5 a1)
    const conversationKey = run?.clientThreadId ?? run?.conversationId ?? null
    if (!conversationKey) return reply({ status: 'cannot', code: 'TASK_NO_CONVERSATION' })
    const cards = Array.isArray(run?.browserBinding?.cards) ? run.browserBinding.cards : []
    const store = tasksNow()
    let task = null
    if (typeof args.goal === 'string' && args.goal.trim()) {
      const picked = pickTaskCard(cards, args.cardId)
      if (picked.error) return reply({ status: 'cannot', code: picked.error, ...(picked.cardIds ? { cardIds: picked.cardIds } : {}) })
      if (decisionOff()) return reply(OFF)
      task = store.create({ conversationKey, cardId: picked.cardId, goal: args.goal })
      Object.assign(task, { toolTask: true, offered: [], spanTried: [], eventSeq: 0, lastPage: null })
    } else {
      task = store.active(conversationKey)
      if (!task) return reply({ status: 'cannot', code: 'TASK_GOAL_REQUIRED' })
      // a task the direct entry started (the shared store) is continued as it is: its page, its steps and what the person said stay
      if (task.toolTask !== true) Object.assign(task, { toolTask: true, offered: task.offered ?? [], spanTried: task.spanTried ?? [], eventSeq: task.eventSeq ?? 0, lastPage: task.lastPage ?? null })
      if (args.cardId && args.cardId !== task.cardId) return reply({ status: 'cannot', code: 'TASK_CARD_MISMATCH' })
      if (!cards.some(card => card?.cardId === task.cardId && card.permission === 'interact')) return reply({ status: 'cannot', code: 'TASK_CARD_NOT_GRANTED' })
      if (decisionOff()) return reply(OFF)
    }
    if (busy.has(task.taskId)) return reply({ status: 'cannot', code: 'TASK_BUSY' })
    busy.add(task.taskId)
    try { return reply(await work(run, event, task, args, started, store)) }
    catch { task.status = 'paused'; task.pause = { kind: 'cannot_proceed', code: 'tool_failed' }; return reply({ status: 'cannot', code: 'tool_failed', taskId: task.taskId }) }
    finally { busy.delete(task.taskId) }
  }

  return { name: BROWSER_TASK_TOOL_NAME, spec: BROWSER_TASK_TOOL_SPEC, store, handle, usePagePress(press) { pagePress = typeof press === 'function' ? press : null } }
}
