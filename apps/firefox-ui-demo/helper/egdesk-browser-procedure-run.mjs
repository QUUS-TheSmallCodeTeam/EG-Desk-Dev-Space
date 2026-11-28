import { bindProcedureParams } from './egdesk-browser-procedure.mjs'
import { isBrowserUserHold } from './egdesk-browser-tool-runtime.mjs'
import { classifyAction } from './egdesk-browser-action-classifier.mjs'
import { expectedTargetOf, navigationLanded, reflexActionArgs } from './egdesk-browser-reflex.mjs'
import { summarizeChange } from './egdesk-browser-change.mjs'
import { taskStepEvent, withBrowserTaskActivity } from './egdesk-browser-task.mjs'

// Round g (L60): the runner of a saved browser procedure (JSON v1, helper/egdesk-browser-procedure.mjs). It replays the steps on ONE Browser Card through the same guarded tools
// the decision loop uses (tools.callTool = a run's reflexScope.callTool: run binding, Card grant, action gate, same-site navigation, receipts all still apply), and stops
// honestly instead of guessing:
//   needs_confirm  a step the person confirms once at run time (submit, payment, delete) is reached and its id is not in `confirmed`: nothing was done for it
//   needs_value    a non-sensitive parameter has neither a value nor a default
//   human_step     a `person` step (a sensitive field), a person-only control (login, password, card details, permission), or the person took the Card (user-hold)
//   cannot_proceed target_not_found, a refused or unverified action, a page that kept changing, a refused start page (the tool's own code)
// Each step finds its target in code first (normalized label + role among the observed elements: exactly one = that element); otherwise the decision model is asked once
// (`decide`), and no answer is target_not_found. A refused act on a page that moved (STALE) looks again, up to CHANGE_LOOKS times (L55), then stops.
// Every step is one browser.task.step frame through onStep(run, event) (taskStepEvent), and the run holds the Card lease (withBrowserTaskActivity). Closed words only: never an address or page text.

export const CHANGE_LOOKS = 3 // re-observations after a refused act on a changing page (L55's bound), then cannot_proceed page_changing
export const PROCEDURE_RUN_STATUSES = Object.freeze(['done', 'needs_confirm', 'needs_value', 'human_step', 'cannot_proceed'])
const STALE_CODES = new Set(['BROWSER_OBSERVATION_STALE', 'BROWSER_TARGET_STALE'])
const CODE = /^[A-Za-z][A-Za-z0-9_]{2,63}$/
// the controls only the person operates, by their own name (the sensitive-label vocabulary of the reflex loop, plus sign-in words)
const PERSON_LABEL = /password|passcode|비밀번호|패스워드|\bpin\b|otp|인증\s*번호|보안\s*코드|card\s*number|카드\s*번호|cvc|cvv|주민\s*등록|로그인|sign[\s-]?in|log[\s-]?in/i
const STEP_OP = Object.freeze({ navigate: 'open', history: 'open', fill: 'fill', select: 'select', click: 'press', press: 'press', scroll: 'scroll' })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const labelKey = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const hostOf = url => { try { return new URL(url).host.toLowerCase() } catch { return null } }
const codeOf = error => (CODE.test(error?.code ?? '') ? error.code : 'TOOL_FAILED')
const textOf = step => (typeof step?.value?.text === 'string' ? step.value.text : typeof step?.text === 'string' ? step.text : null)

/** The goal sentence the decision model gets for one step (the step's own words: op, target label, a value's name). Never a value. */
export function stepGoal(step) {
  const label = step.target?.label ? JSON.stringify(step.target.label) : 'the page'
  const what = { fill: `Type into the field ${label}`, select: `Choose an option in ${label}`, click: `Press ${label}`, press: `Press the key ${step.key ?? ''} in ${label}`, scroll: 'Scroll the page', navigate: 'Open the page', history: 'Move in the history' }[step.op] ?? 'Do the step'
  return `${what}. Pick the element on the page that is this saved step's target.`
}

const needsTarget = step => ['fill', 'select', 'click', 'press'].includes(step.op)
const fillable = element => !['button', 'link'].includes(String(element.role))

/** matchTarget(elements, target) -> { element } (exactly one by label + role) | { candidates } (none or several). Disabled elements never match. */
export function matchTarget(elements, target) {
  const want = labelKey(target?.label), role = target?.role ? labelKey(target.role) : null
  const live = (Array.isArray(elements) ? elements : []).filter(element => record(element) && typeof element.ref === 'string' && element.disabled !== true)
  const hits = live.filter(element => labelKey(element.label) === want && (!role || labelKey(element.role) === role))
  return hits.length === 1 ? { element: hits[0] } : { candidates: hits }
}

/**
 * runProcedure({ procedure, cardId, values?, fromStep?, confirmed?, tools, decide?, signal?, onStep?, run?, clock? })
 *   -> { status, stepId?, index?, code?, done: [stepIds], ... }
 *   tools.callTool(name, args): the guarded Browser tools of this run (reflexScope(run, event, cardId).callTool)
 *   decide({ step, goal, snapshot, elements, candidates, change }) -> a ref (or { ref }) of one of `elements`, or null: the decision model's one look at the page
 *   onStep(run, event): browser.task.step frames (taskStepEvent shape, plus the op 'activity' start/stop frames)
 */
export async function runProcedure({ procedure, cardId, values = {}, fromStep = null, confirmed = [], tools, decide = null, signal = undefined, onStep = null, run = null, clock = Date.now } = {}) {
  if (!record(procedure) || !Array.isArray(procedure.steps) || typeof cardId !== 'string' || !cardId || typeof tools?.callTool !== 'function') throw new TypeError('runProcedure needs a procedure, a cardId and tools.callTool')
  const task = { taskId: `${procedure.id}.r${++runCounter}`, cardId, eventSeq: 0 }
  const done = []
  const confirmedIds = new Set(Array.isArray(confirmed) ? confirmed : [])
  const started = clock()
  const emit = (info, by = 'decision', status = null) => {
    const event = taskStepEvent(task, info, { seq: task.eventSeq + 1, by, status })
    if (!event) return
    task.eventSeq = event.seq
    try { onStep?.(run, event) } catch { /* an observer never affects the run */ }
  }
  const finish = (status, extra = {}) => {
    const wire = { needs_confirm: 'confirm_needed', needs_value: 'needs_value', human_step: 'person_only_controls' }
    emit({ op: 'end', code: extra.code ?? wire[status], ok: status === 'done', stepMs: clock() - started }, 'decision', status)
    return { status, ...extra, done }
  }
  const call = (name, args) => tools.callTool(name, args)
  const observe = async () => {
    const observed = await call('egdesk_browser_observe', { cardId })
    const snapshot = observed?.snapshot
    if (!record(snapshot) || typeof observed?.observationId !== 'string' || !Number.isSafeInteger(snapshot.revision)) throw Object.assign(new Error('no observation'), { code: 'observe_failed' })
    return { observationId: observed.observationId, snapshot }
  }
  const settle = async forLoad => { try { await call('egdesk_browser_wait', { cardId, for: forLoad ? 'load' : 'idle', timeoutMs: forLoad ? 10000 : 5000 }) } catch (error) { if (isBrowserUserHold(error)) throw error } }

  async function work() {
    const bound = bindProcedureParams(procedure, values && typeof values === 'object' ? values : {})
    const steps = bound.steps
    let from = 0
    if (fromStep !== null && fromStep !== undefined) {
      from = steps.findIndex(step => step.id === fromStep)
      if (from < 0) return finish('cannot_proceed', { code: 'step_unknown' })
    }
    // a value nobody gave: asked for before anything is done, for every remaining step at once
    const missing = new Set(bound.missing)
    const lacking = steps.map((step, index) => ({ step, index })).filter(({ step, index }) => index >= from && !step.person && missing.has(step.value?.param) && textOf(step) === null)
    if (lacking.length) return finish('needs_value', { stepId: lacking[0].step.id, index: lacking[0].index, params: [...new Set(lacking.map(({ step }) => step.value.param))] })
    try {
      if (fromStep === null || fromStep === undefined) {
        const stop = await startPage()
        if (stop) return stop
      }
      for (let index = from; index < steps.length; index++) {
        const step = steps[index]
        if (signal?.aborted) return finish('cannot_proceed', { stepId: step.id, index, code: 'aborted' })
        if (step.person === true) return finish('human_step', { stepId: step.id, index, code: 'person_only_controls', ...(step.target?.label ? { controls: [step.target.label] } : {}) })
        if (step.confirm && !confirmedIds.has(step.id)) return finish('needs_confirm', { stepId: step.id, index, confirm: step.confirm })
        const stop = await runStep(step, index)
        if (stop) return stop
        done.push(step.id)
      }
      return finish('done')
    } catch (error) {
      if (isBrowserUserHold(error)) return finish('human_step', { code: 'user_hold', staleBy: 'user-hold' })
      return finish('cannot_proceed', { code: codeOf(error) })
    }
  }

  // The start page: only when the Card is on another host than the procedure began on, through the normal guarded navigate (site policy applies; its refusal code is the answer).
  async function startPage() {
    const start = procedure.start
    if (!record(start) || typeof start.url !== 'string') return null
    const first = await observe()
    if (hostOf(first.snapshot.url) === String(start.host ?? '').toLowerCase()) return null
    const t0 = clock()
    const meta = { op: 'open', target: start.host }
    try {
      await call('egdesk_browser_navigate', { cardId, observationId: first.observationId, expectedRevision: first.snapshot.revision, url: start.url, postcondition: { kind: 'url', value: start.url } })
    } catch (error) {
      if (isBrowserUserHold(error)) throw error
      if (!(await landed(start.url, first.snapshot.url))) {
        emit({ failed: 'egdesk_browser_navigate', ok: false, stepMs: clock() - t0, code: codeOf(error), ...meta })
        return finish('cannot_proceed', { code: codeOf(error), stepId: null, index: -1 })
      }
    }
    emit({ action: 'egdesk_browser_navigate', ok: true, stepMs: clock() - t0, ...meta })
    await settle(true)
    return null
  }
  async function landed(expected, from) {
    await settle(true)
    try { return navigationLanded({ actual: (await observe()).snapshot.url, expected, from }) } catch (error) { if (isBrowserUserHold(error)) throw error; return false }
  }

  // One step: observe fresh, find the target, act. A refused act on a page that moved looks again (CHANGE_LOOKS), each look deciding from the page as it is now.
  async function runStep(step, index) {
    const where = { stepId: step.id, index }
    let previous = null, change = null
    for (let look = 0; look <= CHANGE_LOOKS; look++) {
      if (signal?.aborted) return finish('cannot_proceed', { ...where, code: 'aborted' })
      const { observationId, snapshot } = await observe()
      if (previous) change = summarizeChange(previous.snapshot, snapshot, previous.ref)
      let element = null
      if (needsTarget(step)) {
        element = await findTarget(step, snapshot, change)
        if (!element) return finish('cannot_proceed', { ...where, code: 'target_not_found' })
        const stop = guardTarget(step, element, snapshot, where)
        if (stop) return stop
      }
      const planned = plan(step, element, { observationId, snapshot })
      if (planned.stop) return finish('cannot_proceed', { ...where, code: planned.stop })
      const t0 = clock()
      const meta = stepMeta(step, element, planned.tool)
      try {
        await call(planned.tool, planned.args)
      } catch (error) {
        if (isBrowserUserHold(error)) throw error
        if (planned.tool === 'egdesk_browser_navigate' && await landed(planned.args.url, snapshot.url)) { emit({ action: planned.tool, ok: true, stepMs: clock() - t0, ...meta }); return null }
        if (STALE_CODES.has(error?.code)) { previous = { snapshot, ref: element?.ref ?? null }; continue }
        emit({ failed: planned.tool, ok: false, stepMs: clock() - t0, code: codeOf(error), ...meta })
        return finish('cannot_proceed', { ...where, code: codeOf(error) })
      }
      emit({ action: planned.tool, ok: true, stepMs: clock() - t0, ...meta })
      await settle(planned.loads === true)
      return null
    }
    emit({ failed: 'egdesk_browser_observe', ok: false, stepMs: 0, code: 'page_changing', op: STEP_OP[step.op], target: step.target?.label })
    return finish('cannot_proceed', { ...where, code: 'page_changing' })
  }

  async function findTarget(step, snapshot, change) {
    const elements = Array.isArray(snapshot.interactiveElements) ? snapshot.interactiveElements : []
    const match = matchTarget(elements, step.target)
    if (match.element) return match.element
    if (typeof decide !== 'function') return null
    const offered = ['fill', 'select'].includes(step.op) ? elements.filter(fillable) : elements
    let chosen = null
    try { chosen = await decide({ step, goal: stepGoal(step), snapshot, elements: offered, candidates: match.candidates, change }) } catch (error) { if (isBrowserUserHold(error)) throw error; chosen = null }
    const ref = typeof chosen === 'string' ? chosen : record(chosen) ? chosen.ref : null
    return offered.find(element => element.ref === ref && element.disabled !== true) ?? null
  }

  // What stays with the person even when the procedure saved it: sign-in and credential controls, a permission grant; and a payment or delete press the saved step did not mark for confirmation.
  function guardTarget(step, element, snapshot, where) {
    const label = String(element.label ?? '')
    if (PERSON_LABEL.test(label) || label === 'Sensitive field' || element.sensitive === true) return finish('human_step', { ...where, code: 'person_only_controls', controls: [label.slice(0, 60)] })
    if (!['click', 'press'].includes(step.op) && !(step.op === 'fill' || step.op === 'select')) return null
    let category = 'none'
    try { category = classifyAction({ mode: 'activate', label, role: element.role, tag: element.tag, url: snapshot.url })?.category ?? 'none' } catch { category = 'none' }
    if (category === 'grant') return finish('human_step', { ...where, code: 'person_only_controls', controls: [label.slice(0, 60)] })
    if (['click', 'press'].includes(step.op) && ['pay', 'delete'].includes(category) && !step.confirm) return finish('needs_confirm', { ...where, confirm: category === 'pay' ? 'payment' : 'delete', code: 'confirm_needed' })
    return null
  }

  // The guarded tool call for the step, its arguments copied from the fresh observation (never generated).
  function plan(step, element, { observationId, snapshot }) {
    const base = { cardId, observationId, expectedRevision: snapshot.revision }
    switch (step.op) {
      case 'navigate': return typeof step.url === 'string' ? { tool: 'egdesk_browser_navigate', args: { ...base, url: step.url, postcondition: { kind: 'url', value: step.url } }, loads: true } : { stop: 'step_invalid' }
      case 'history': return { tool: 'egdesk_browser_history', args: { ...base, action: step.action }, loads: true }
      case 'scroll': return { tool: 'egdesk_browser_scroll', args: { ...base, direction: step.direction ?? 'down', amount: Number.isFinite(step.amount) && step.amount <= 0.5 ? 'half' : 'page' } }
      case 'fill': case 'select': {
        const text = textOf(step)
        if (text === null) return { stop: 'needs_value' }
        let option = { item: { kind: 'fill', element } }
        if (String(element.tag).toLowerCase() === 'select' && Array.isArray(element.options)) {
          const hit = element.options.find(o => o?.value === text) ?? element.options.find(o => labelKey(o?.label) === labelKey(text))
          if (!hit) return { stop: 'option_not_found' }
          option = { item: { kind: 'choice', element, desired: hit.value } }
        }
        const planned = reflexActionArgs(option, { cardId, observationId, snapshot, text })
        return planned.tool ? { tool: planned.tool, args: planned.args } : { stop: 'value_unusable' }
      }
      case 'press': {
        const expect = step.expect
        const postcondition = ['url', 'visible-text'].includes(expect?.kind) && expect.value ? { kind: expect.kind, value: expect.value } : { kind: 'target-value', value: String(element.value ?? '') }
        return { tool: 'egdesk_browser_press', args: { ...base, ref: element.ref, expectedTarget: expectedTargetOf(element), key: step.key, ...(['Enter', 'Space'].includes(step.key) || expect ? { postcondition } : {}) }, loads: step.key === 'Enter' }
      }
      default: { // click
        const expect = step.expect
        if (String(element.tag).toLowerCase() === 'a' && typeof element.href === 'string' && element.href && expect?.kind !== 'visible-text') {
          const planned = reflexActionArgs({ item: { kind: 'navigate', element } }, { cardId, observationId, snapshot })
          return { tool: planned.tool, args: planned.args, loads: true }
        }
        if (['url', 'visible-text', 'target-value'].includes(expect?.kind) && typeof expect.value === 'string') {
          return { tool: 'egdesk_browser_click', args: { ...base, ref: element.ref, expectedTarget: expectedTargetOf(element), postcondition: { kind: expect.kind, value: expect.value } }, loads: expect.kind === 'url' }
        }
        // a saved press was named by the person: the c20 named-change press (its confirm and person-only exceptions were handled above)
        const planned = reflexActionArgs({ item: { kind: 'press', element, named: true } }, { cardId, observationId, snapshot })
        return planned.tool ? { tool: planned.tool, args: planned.args } : { stop: planned.escalate ?? 'press_needs_expected_effect' }
      }
    }
  }
  const stepMeta = (step, element, tool) => {
    const op = step.confirm && step.op === 'click' ? 'submit' : STEP_OP[step.op]
    const target = step.op === 'navigate' || step.op === 'history' ? hostOf(step.url ?? '') ?? step.action : step.target?.label
    const shown = ['fill', 'select'].includes(step.op) && step.person !== true && !PERSON_LABEL.test(String(element?.label ?? '')) ? textOf(step) : null
    return { op, ...(target ? { target } : {}), ...(step.value?.param ? { valueName: step.value.param } : {}), ...(shown !== null ? { displayValue: shown.slice(0, 60) } : {}) }
  }

  return withBrowserTaskActivity(run, task, onStep, work)
}
let runCounter = 0
