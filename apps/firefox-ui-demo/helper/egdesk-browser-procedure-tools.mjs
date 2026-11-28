import { PROCEDURE_FLAG } from './egdesk-browser-procedure.mjs'
import { runProcedure } from './egdesk-browser-procedure-run.mjs'
import { pickTaskCard } from './egdesk-browser-task-tool.mjs'
import { buildReflexCandidates, decideReflexStep, localDay } from './egdesk-browser-reflex.mjs'
import { decisionThresholds } from './egdesk-decision-questions.mjs'
import { FOREGROUND_DECISION_TIMEOUT_MS } from './egdesk-decision-client.mjs'

// Round g (L60): the chat tools of the browser procedures, served by the page tools provider beside egdesk_browser_task (Claude through the EG-Desk MCP catalog and Codex through
// dynamicTools read the same specs()). Offered ONLY when the flag EGDESK_BROWSER_PROCEDURES is 'on' AND the procedure service host (list/get/save/update/remove/captureDraft,
// lane L59) was injected; otherwise createProcedureTools returns null and nothing changes. All user-visible/model-visible copy below is PROPOSED copy, kept in this one place.

export const PROCEDURE_TOOL_NAMES = Object.freeze({ list: 'egdesk_browser_procedure_list', run: 'egdesk_browser_procedure_run', save: 'egdesk_browser_procedure_save', update: 'egdesk_browser_procedure_update' })
export const PROCEDURE_TOOL_NAME_LIST = Object.freeze(Object.values(PROCEDURE_TOOL_NAMES))
export const procedureToolsEnabled = env => env?.[PROCEDURE_FLAG] === 'on'
export const PROCEDURE_LIMITS = Object.freeze({ id: 80, cardId: 160, name: 80, values: 40, valueName: 80, valueChars: 2000, steps: 100, stepId: 20 })

// PROPOSED copy: the rule, the same words for both engines (it rides in every tool description and every reply's forYouOnly).
export const PROCEDURE_RULE = 'Procedure run rules. needs_confirm: ask the person to confirm that step, then call egdesk_browser_procedure_run again with fromStep = that stepId and confirmed = [that stepId]. ' +
  'needs_value: ask the person for the missing value (params), or infer it from the conversation, then call run again with values. ' +
  'human_step: tell the person what is left for them on the page; do not retry. ' +
  'cannot_proceed: say which step stopped (stepId, index) and why (code) in everyday words. ' +
  'Never claim a step ran when it did not: only the steps in done ran.'
export const PROCEDURE_NOTE = 'Not for the person: status, code and the other fields are EG-Desk\'s own markings. Say what happened in everyday words.'

const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required })
const str = (max, description) => ({ type: 'string', maxLength: max, ...(description ? { description } : {}) })
export const PROCEDURE_TOOL_SPECS = Object.freeze([
  { type: 'function', name: PROCEDURE_TOOL_NAMES.list, description: 'List the saved browser procedures (id, name, site, step count, parameter names). Read-only. ' + PROCEDURE_RULE, inputSchema: obj({}) },
  { type: 'function', name: PROCEDURE_TOOL_NAMES.run,
    description: 'Run a saved browser procedure on a Browser Card the person granted for operation, step by step through the guarded browser tools. It stops before any step the person must confirm, and at a step only the person may do. ' + PROCEDURE_RULE,
    inputSchema: obj({ procedureId: str(PROCEDURE_LIMITS.id), cardId: str(PROCEDURE_LIMITS.cardId, 'Omit when exactly one Card is granted for operation.'),
      values: { type: 'object', additionalProperties: str(PROCEDURE_LIMITS.valueChars), description: 'Parameter values by parameter name; a parameter left out uses its saved default.' },
      fromStep: str(PROCEDURE_LIMITS.stepId, 'Continue from this step id (after needs_confirm).'),
      confirmed: { type: 'array', items: str(PROCEDURE_LIMITS.stepId), maxItems: PROCEDURE_LIMITS.steps, description: 'Step ids the person has confirmed.' } }, ['procedureId']) },
  { type: 'function', name: PROCEDURE_TOOL_NAMES.save,
    description: 'Save what the last browser task on this Card in this conversation did as a reusable procedure. Passwords, codes and card numbers are never stored. ' + PROCEDURE_RULE,
    inputSchema: obj({ name: str(PROCEDURE_LIMITS.name), cardId: str(PROCEDURE_LIMITS.cardId) }) },
  { type: 'function', name: PROCEDURE_TOOL_NAMES.update,
    description: 'Edit a saved procedure: rename it, remove steps, change parameter defaults, or mark a step to be confirmed at run time (or unmark it with null). ' + PROCEDURE_RULE,
    inputSchema: obj({ procedureId: str(PROCEDURE_LIMITS.id), name: str(PROCEDURE_LIMITS.name),
      removeSteps: { type: 'array', items: str(PROCEDURE_LIMITS.stepId), maxItems: PROCEDURE_LIMITS.steps },
      setDefaults: { type: 'object', additionalProperties: str(PROCEDURE_LIMITS.valueChars) },
      setConfirm: { type: 'object', additionalProperties: { type: ['string', 'null'], enum: ['submit', 'payment', 'delete', null] } } }, ['procedureId']) },
])

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const reply = body => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ ...body, forYouOnly: PROCEDURE_NOTE + ' ' + PROCEDURE_RULE }) }] })
const fail = (code, detail) => reply({ status: 'cannot_proceed', code, ...(detail ? { detail } : {}) })
const strings = (value, max) => Array.isArray(value) && value.length <= PROCEDURE_LIMITS.steps && value.every(item => typeof item === 'string' && item && item.length <= max)

export function validateProcedureArgs(tool, args) {
  if (!record(args)) return 'arguments must be an object'
  const allowed = { [PROCEDURE_TOOL_NAMES.list]: [], [PROCEDURE_TOOL_NAMES.run]: ['procedureId', 'cardId', 'values', 'fromStep', 'confirmed'], [PROCEDURE_TOOL_NAMES.save]: ['name', 'cardId'], [PROCEDURE_TOOL_NAMES.update]: ['procedureId', 'name', 'removeSteps', 'setDefaults', 'setConfirm'] }[tool]
  if (!allowed) return 'unknown tool'
  if (Object.keys(args).some(key => !allowed.includes(key))) return 'unknown argument'
  if ([PROCEDURE_TOOL_NAMES.run, PROCEDURE_TOOL_NAMES.update].includes(tool) && (typeof args.procedureId !== 'string' || !args.procedureId || args.procedureId.length > PROCEDURE_LIMITS.id)) return 'procedureId is required'
  if (args.cardId !== undefined && (typeof args.cardId !== 'string' || !args.cardId || args.cardId.length > PROCEDURE_LIMITS.cardId)) return 'cardId must be a Card id'
  if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim() || args.name.length > PROCEDURE_LIMITS.name)) return 'name must be 1 to 80 characters'
  for (const key of ['values', 'setDefaults']) {
    if (args[key] === undefined) continue
    if (!record(args[key]) || Object.keys(args[key]).length > PROCEDURE_LIMITS.values) return `${key} must be an object of at most ${PROCEDURE_LIMITS.values} strings`
    if (Object.entries(args[key]).some(([name, text]) => !name || name.length > PROCEDURE_LIMITS.valueName || typeof text !== 'string' || text.length > PROCEDURE_LIMITS.valueChars)) return `${key} must map parameter names to texts`
  }
  if (args.fromStep !== undefined && (typeof args.fromStep !== 'string' || !args.fromStep || args.fromStep.length > PROCEDURE_LIMITS.stepId)) return 'fromStep must be a step id'
  if (args.confirmed !== undefined && !strings(args.confirmed, PROCEDURE_LIMITS.stepId)) return 'confirmed must be a list of step ids'
  if (args.removeSteps !== undefined && !strings(args.removeSteps, PROCEDURE_LIMITS.stepId)) return 'removeSteps must be a list of step ids'
  if (args.setConfirm !== undefined && (!record(args.setConfirm) || Object.values(args.setConfirm).some(kind => kind !== null && !['submit', 'payment', 'delete'].includes(kind)))) return 'setConfirm must map step ids to submit, payment, delete or null'
  return null
}

/** applyProcedureEdit(procedure, args) -> { procedure } | { error }: the update tool's edits on a copy (sensitive parameters take no default; a step with a removed id is dropped). */
export function applyProcedureEdit(procedure, args) {
  const next = JSON.parse(JSON.stringify(procedure))
  const ids = new Set(next.steps.map(step => step.id))
  for (const id of [...(args.removeSteps ?? []), ...Object.keys(args.setConfirm ?? {})]) if (!ids.has(id)) return { error: 'step_unknown', detail: id }
  for (const name of Object.keys(args.setDefaults ?? {})) {
    const param = next.params.find(item => item.name === name)
    if (!param) return { error: 'param_unknown', detail: name }
    if (param.sensitive) return { error: 'param_sensitive', detail: name }
  }
  if (args.name !== undefined) next.name = args.name.trim()
  if (args.removeSteps?.length) next.steps = next.steps.filter(step => !args.removeSteps.includes(step.id))
  if (!next.steps.length) return { error: 'no_steps_left' }
  for (const [name, text] of Object.entries(args.setDefaults ?? {})) next.params.find(item => item.name === name).default = text
  for (const [id, kind] of Object.entries(args.setConfirm ?? {})) { const step = next.steps.find(item => item.id === id); if (kind === null) delete step.confirm; else step.confirm = kind }
  const used = new Set(next.steps.map(step => step.value?.param).filter(Boolean))
  next.params = next.params.filter(param => used.has(param.name))
  return { procedure: next }
}

const summarize = p => !Array.isArray(p?.steps) ? { id: p?.id, name: p?.name, host: p?.host ?? null, stepCount: p?.stepCount ?? 0, paramNames: p?.paramNames ?? [] } : ({ id: p.id, name: p.name, host: p.start?.host ?? null, stepCount: p.steps?.length ?? 0, paramNames: (p.params ?? []).map(item => item.name) })

/**
 * createProcedureTools({ procedures, browser, env?, onStep? }) -> null | { names, specs, handle(run, event) }
 *   procedures: the service host { list, get, save, update, remove?, captureDraft } (lane L59); null/missing = no tools
 *   browser: { reflexScope(run, event, cardId) } (the Browser provider's own scope: callTool, client, authorizeDispatch)
 *   onStep(run, event): the browser.task.step frames of a run (the same hook as the browser task tool)
 */
export function createProcedureTools({ procedures, browser, env = process.env, onStep = null, thresholds, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, now = Date.now } = {}) {
  if (!procedureToolsEnabled(env) || !procedures || ['list', 'get', 'save', 'update', 'captureDraft'].some(name => typeof procedures[name] !== 'function')) return null
  if (!browser || typeof browser.reflexScope !== 'function') throw new TypeError('the procedure tools need the Browser provider (reflexScope)')
  const t = decisionThresholds(thresholds)
  const busy = new Set()
  const cardsOf = run => (Array.isArray(run?.browserBinding?.cards) ? run.browserBinding.cards : [])

  async function runIt(run, event, args) {
    const picked = pickTaskCard(cardsOf(run), args.cardId)
    if (picked.error) return fail(picked.error, picked.cardIds?.join(','))
    const procedure = await procedures.get(args.procedureId)
    if (!record(procedure)) return fail('procedure_unknown')
    const key = `${run?.clientThreadId ?? run?.conversationId}/${picked.cardId}`
    if (busy.has(key)) return fail('PROCEDURE_BUSY')
    busy.add(key)
    try {
      const scope = browser.reflexScope(run, { callId: `${event?.callId ?? 'procedure'}.run`, namespace: null }, picked.cardId)
      const decide = scope?.client ? async ({ goal, snapshot, change }) => {
        const { options } = buildReflexCandidates(snapshot, { textComboboxes: true })
        if (!options.length) return null
        const out = await decideReflexStep({ goal, snapshot, options, today: localDay(now()), ...(change ? { change } : {}), client: scope.client, thresholds: t, timeoutMs, authorizeDispatch: scope.authorizeDispatch })
        return out?.kind === 'act' ? out.option.item.element.ref : null
      } : null
      const result = await runProcedure({ procedure, cardId: picked.cardId, values: args.values ?? {}, fromStep: args.fromStep ?? null, confirmed: args.confirmed ?? [], tools: { callTool: scope.callTool }, decide, onStep, run })
      return reply({ ...result, procedureId: procedure.id, name: procedure.name, cardId: picked.cardId })
    } finally { busy.delete(key) }
  }

  async function saveIt(run, args) {
    const clientThreadId = run?.clientThreadId ?? run?.conversationId ?? null
    if (!clientThreadId) return fail('TASK_NO_CONVERSATION')
    const cards = cardsOf(run)
    const cardId = args.cardId ?? (cards.length === 1 ? cards[0].cardId : cards.find(card => card.permission === 'interact')?.cardId)
    if (!cardId || !cards.some(card => card.cardId === cardId)) return fail('TASK_CARD_REQUIRED')
    let draft
    try { draft = await procedures.captureDraft({ clientThreadId, cardId, ...(args.name ? { name: args.name } : {}) }) } catch { return fail('nothing_to_save') }
    draft = record(draft?.draft) ? draft.draft : draft
    if (!record(draft) || !Array.isArray(draft.steps) || !draft.steps.length) return fail('nothing_to_save')
    const saved = await procedures.save(draft)
    const procedure = record(saved?.procedure) ? saved.procedure : saved
    if (saved?.ok === false || !record(procedure) || typeof procedure.id !== 'string') return fail('save_refused', Array.isArray(saved?.errors) ? String(saved.errors[0]).slice(0, 120) : undefined)
    return reply({ status: 'saved', ...summarize(procedure), personSteps: procedure.steps.filter(step => step.person).map(step => step.id), confirmSteps: procedure.steps.filter(step => step.confirm).map(step => step.id) })
  }

  async function updateIt(args) {
    const procedure = await procedures.get(args.procedureId)
    if (!record(procedure)) return fail('procedure_unknown')
    const edited = applyProcedureEdit(procedure, args)
    if (edited.error) return fail(edited.error, edited.detail)
    const saved = await procedures.update(args.procedureId, edited.procedure)
    const next = record(saved?.procedure) ? saved.procedure : saved
    if (saved?.ok === false || !record(next) || typeof next.id !== 'string') return fail('update_refused', Array.isArray(saved?.errors) ? String(saved.errors[0]).slice(0, 120) : undefined)
    return reply({ status: 'updated', ...summarize(next) })
  }

  return {
    names: PROCEDURE_TOOL_NAME_LIST, specs: PROCEDURE_TOOL_SPECS,
    async handle(run, event) {
      const tool = event?.tool
      const args = record(event?.arguments) ? event.arguments : {}
      const invalid = validateProcedureArgs(tool, args)
      if (invalid) return fail('PROCEDURE_ARGS_INVALID', invalid)
      try {
        if (tool === PROCEDURE_TOOL_NAMES.list) return reply({ status: 'ok', procedures: (await procedures.list()).map(summarize) })
        if (tool === PROCEDURE_TOOL_NAMES.run) return await runIt(run, event, args)
        if (tool === PROCEDURE_TOOL_NAMES.save) return await saveIt(run, args)
        return await updateIt(args)
      } catch { return fail('tool_failed') }
    },
  }
}
