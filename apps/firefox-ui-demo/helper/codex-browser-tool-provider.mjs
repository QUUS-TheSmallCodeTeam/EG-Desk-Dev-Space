import { BROWSER_INTERACTION_TOOL_NAMES, BROWSER_READ_TOOL_NAMES, BROWSER_TOOL_SPECS, createBrowserToolService } from './egdesk-browser-tool-runtime.mjs'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { chatError } from './codex-chat-values.mjs'
import { classifyPublicToolError } from './codex-tool-errors.mjs'
import { fixtureSnapshotMatches } from './codex-browser-fixture-qa.mjs'
import { NAVIGATION_REASON_TEXT } from './egdesk-browser-url-policy.mjs'
import { BROWSER_REFLEX_TOOL_NAME, BROWSER_REFLEX_TOOL_SPEC, reflexResultForModel, runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { randomUUID } from 'node:crypto'

const BROWSER_BOUNDED = 'browserBounded'
const READ_ONLY_QA = 'readOnlyQa'
const FIXTURE_BROWSER_QA = 'fixtureBrowserQa'
// Guarded tools an explicit interaction selection may use. Navigation scope,
// focus and wait budgets are enforced again by the B service and the actor.
// The lists live in the runtime so the chat runtime shares one copy.
const BOUNDED_INTERACTION_TOOLS = new Set(BROWSER_INTERACTION_TOOL_NAMES)
// Read tools any granted Card may use (no action lease, never acts).
const BOUNDED_READ_TOOLS = new Set(BROWSER_READ_TOOL_NAMES)
const DISPATCH_PHASES = new Set(['not-dispatched', 'dispatched', 'unknown'])
const DIALOG_TYPES = new Set(['alert', 'confirm', 'prompt', 'beforeunload'])
// BRW-07: Cards one run may hold (its explicit grants plus Cards it opened).
const MAX_RUN_CARDS = 4
// D-B1 refusal facts: a fixed reason and the host the model itself named.
const NAVIGATION_REASONS = new Set(Object.keys(NAVIGATION_REASON_TEXT))
const HOST_PATTERN = /^[a-z0-9.:\[\]-]{1,253}$/i
// Fixed, content-free facts the model may see beside a public error code:
// whether the action was sent, what structurally covered a refused click,
// and the type of a page dialog. Raw diagnostics stay withheld.
function publicBrowserErrorDetail(error) {
  if (!error || typeof error !== 'object') return {}
  const detail = {}
  if (DISPATCH_PHASES.has(error.dispatchPhase)) detail.dispatchPhase = error.dispatchPhase
  if ([true, false, 'unknown'].includes(error.dispatched)) detail.dispatched = error.dispatched
  if (typeof error.obscuredBy === 'string' && /^[A-Za-z0-9 #._=:/-]{1,160}$/.test(error.obscuredBy)) detail.obscuredBy = error.obscuredBy
  if (DIALOG_TYPES.has(error.dialog?.type)) detail.dialog = { type: error.dialog.type }
  if (error.navigation && typeof error.navigation === 'object' && NAVIGATION_REASONS.has(error.navigation.reason)) {
    detail.navigation = { reason: error.navigation.reason,
      ...(typeof error.navigation.host === 'string' && HOST_PATTERN.test(error.navigation.host) ? { host: error.navigation.host } : {}) }
  }
  if (error.reconcile && typeof error.reconcile === 'object') {
    const { answered, entered, performing, fenced, reason } = error.reconcile
    detail.reconcile = { answered: answered === true,
      ...([true, false].includes(entered) ? { entered } : {}),
      ...(performing === true ? { performing: true } : {}), ...(fenced === true ? { fenced: true } : {}),
      ...(['run-ended', 'no-answer', 'unrecognized-answer', 'other-document', 'record-evicted', 'unproven'].includes(reason) ? { reason } : {}) }
  }
  return detail
}
const SUCCESS_STATUSES = new Set(['observed', 'postcondition-observed', 'wait-condition-met',
  'cards-listed', 'site-allowed', 'card-opened', 'card-closed', 'history-dispatched', 'screenshot-observed'])
// DECISION_MODEL_CONTEXT_SETUP.md §3.3: the reflex tool is appended after the
// unchanged BROWSER_TOOL_SPECS (their schemas are in thread manifest hashes),
// and only while a decision key is configured and the mode is 'on'.
function reflexEnabled(decision) {
  try { return Boolean(decision) && decision.mode?.() === 'on' && decision.configured?.() === true }
  catch { return false }
}
function reflexStepError(text) {
  let code = 'TOOL_FAILED'
  try { const parsed = JSON.parse(text); if (typeof parsed?.error?.code === 'string') code = parsed.error.code } catch {}
  const error = new Error('Browser reflex step failed')
  error.code = code
  return error
}
const PUBLIC_INPUT_ROUTES = new Set(['dom-click-no-pointerdown', 'dom-scroll-api', 'dom-keyboard-event',
  'dom-value-setter', 'dom-editor-replace', 'chrome-load-uri', 'chrome-history', 'trusted-pointer', 'trusted-text-input'])

// Process-local evidence, not part of the native tool response or public Activity.
const reflexHandoffs = new WeakMap()
const cancelledBrowserRuns = new WeakSet()
export function isCurrentBrowserReflexHandoff(response, run, event) {
  const handoff = reflexHandoffs.get(response)
  return handoff?.run === run && handoff.event === event && !cancelledBrowserRuns.has(run)
}

export function createCodexBrowserToolProvider({ transport, getOwnerKey, schemaReady = () => true, fixtureQa = null, decision = null, runReflex = runBrowserReflex, service = createBrowserToolService({ sendToUi: request => transport.sendToUi(request), getOwnerKey }) }) {
  if (!transport || typeof transport.hasClient !== 'function' || typeof getOwnerKey !== 'function') throw new TypeError('Browser provider requires a bounded UI transport and account identity')
  let resetting = 0
  const fixtureAttestations = new Map()
  const provider = {
    providerId: 'egdesk-browser',
    prepare(body) {
      const selectedSources = body.selectedSources ?? []
      if (!Array.isArray(selectedSources)) throw chatError('INVALID_BROWSER_SELECTION', 'Browser selection must be an array', 400)
      if (body.effectiveExecutionPolicy === FIXTURE_BROWSER_QA && !selectedSources.length) throw chatError('BROWSER_FIXTURE_REQUIRED', 'Fixture Browser QA requires one selected local Card', 400)
      if (!selectedSources.length) return null
      if (!schemaReady()) throw chatError('BROWSER_TOOLS_UNAVAILABLE', 'Native Browser tool contract is not verified', 503)
      if (resetting) throw chatError('BROWSER_RESET_PENDING', 'Browser authority is still being revoked', 409)
      const policy = body.effectiveExecutionPolicy
      if (![READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA].includes(policy)) throw chatError('BROWSER_POLICY_REQUIRED', 'Browser tools require an explicit bounded native execution policy', 409)
      const transportId = body.browserTransportId
      if (!transport.hasClient(transportId)) throw chatError('BROWSER_UI_UNAVAILABLE', 'The selected Browser UI stream is unavailable', 409)
      if (selectedSources.some(source => typeof source?.id !== 'string' || !source.id ||
          typeof source.browserToolSelection?.token !== 'string' || !source.browserToolSelection.token ||
          source.browserToolSelection.threadId !== body.clientThreadId)) {
        throw chatError('INVALID_BROWSER_SELECTION', 'Browser selection must retain its one-time source token and exact Chat binding', 400)
      }
      if (policy === READ_ONLY_QA && selectedSources.some(source => source.browserToolPermission !== 'observe')) {
        throw chatError('BROWSER_INTERACTION_NOT_GRANTED', 'This mode accepts only a Browser observe selection', 403)
      }
      // BrowserBounded is the existing native safety envelope. Interaction
      // comes only from this request's explicit UI selection, never from a
      // thread policy, prior run, retained snapshot or catalog registration.
      const interactionRequested = policy === BROWSER_BOUNDED
        && selectedSources.some(source => source.browserToolPermission === 'interact')
      if (interactionRequested) {
        // BRW-07 / BRW-11: every interact Card is an explicit selection of the
        // person's own (a standing grant the UI re-issued for this turn, or a
        // Card the Agent opened inside it); never a thread-wide default.
        const interacting = selectedSources.filter(source => source.browserToolPermission === 'interact')
        if (selectedSources.length > MAX_RUN_CARDS || interacting.some(source => source.selectedByUser !== true)) {
          throw chatError('INVALID_BROWSER_SELECTION', 'Select one to four explicitly granted Browser Cards for this run', 400)
        }
        for (const source of interacting) {
          let selectedUrl
          try { selectedUrl = new URL(source.sourceRef?.uri) } catch {}
          if (!selectedUrl || !['http:', 'https:'].includes(selectedUrl.protocol)
            || selectedUrl.username || selectedUrl.password) {
            throw chatError('INVALID_BROWSER_SELECTION', 'This run requires selected HTTP(S) Browser Cards', 400)
          }
        }
      }
      if (policy === FIXTURE_BROWSER_QA && (!fixtureQa || selectedSources.length !== 1 ||
          selectedSources[0].browserToolPermission !== 'interact' ||
          selectedSources[0].sourceRef?.uri !== fixtureQa.url ||
          selectedSources[0].sourceRef?.accountId !== '')) {
        throw chatError('BROWSER_FIXTURE_UNAVAILABLE', 'Fixture Browser QA requires the exact opted-in local fixture and an interaction selection', 403)
      }
      let selection
      try { selection = service.prepare({ selectedSources, ownerKey: getOwnerKey() }) }
      catch (error) { const failure = classifyPublicToolError(error, { browser: true }); throw chatError(failure.code, failure.message, 400) }
      return { selection, transportId, policy, interactionRequested }
    },
    // Advertise available specs; runtime narrows the original native catalog
    // using its safety envelope and first explicit selection. A later send
    // cannot expand that catalog. Per-run UI binding remains actual authority.
    specs() {
      if (!schemaReady()) return []
      return reflexEnabled(decision) ? [...BROWSER_TOOL_SPECS, BROWSER_REFLEX_TOOL_SPEC] : BROWSER_TOOL_SPECS
    },
    requireThread(threadId, prepared) {
      if (prepared && !this.runtime.browserRegisteredThreads.has(threadId)) {
        throw chatError('BROWSER_TOOLS_UNAVAILABLE', 'This native thread predates Browser tools; keep its history and choose an explicit new conversation', 409)
      }
    },
    registerThread(threadId) { this.runtime.browserRegisteredThreads.add(threadId) },
    // A pre-turn run object (quiet: true) never publishes Activity; its events belong to no run yet.
    emit(run, ...args) { if (run?.quiet === true) return undefined; return this.runtime.emit(run, ...args) },
    async bindRun(run, prepared) {
      if (!prepared) return
      if (resetting) throw chatError('BROWSER_RESET_PENDING', 'Browser authority is still being revoked', 409)
      transport.bindRun(run.runId, run.clientThreadId, prepared.transportId)
      try {
        const receipt = await service.bind(run, prepared.selection)
        run.browserBinding = { cards: receipt.cards.map(card => {
          const selected = prepared.selection?.cards?.get?.(card.cardId)
          return { cardId: card.cardId, permission: card.permission,
            ...(typeof selected?.sourceId === 'string' ? { sourceId: selected.sourceId } : {}),
            ...(typeof selected?.cardEpoch === 'string' ? { cardEpoch: selected.cardEpoch } : {}) }
        }) }
        this.emit(run, 'browser.bound', run.browserBinding)
      } catch (error) {
        transport.unbindRun(run.runId)
        const failure = classifyPublicToolError(error, { browser: true })
        throw chatError(failure.code, failure.message, 409)
      }
    },
    // C9: the direct entry's pre-turn binding (bindRun with a quiet pre-run) becomes the turn's run. Same binding, same grants.
    async adoptRun(run, prepared, preRun) {
      if (!prepared || !preRun) return
      if (resetting) throw chatError('BROWSER_RESET_PENDING', 'Browser authority is still being revoked', 409)
      transport.bindRun(run.runId, run.clientThreadId, prepared.transportId)
      try {
        service.adopt(preRun, run)
        run.browserBinding = { cards: (preRun.browserBinding?.cards || []).map(card => ({ ...card })) }
        run.adoptedFrom = preRun.runId
        this.emit(run, 'browser.bound', run.browserBinding)
      } catch (error) {
        transport.unbindRun(run.runId)
        const failure = classifyPublicToolError(error, { browser: true })
        throw chatError(failure.code, failure.message, 409)
      }
    },
    async dispatch(run, event) {
      if (event?.tool === BROWSER_REFLEX_TOOL_NAME) return this.dispatchReflex(run, event)
      try {
        if (run.executionPolicy?.mode === BROWSER_BOUNDED) {
          const card = run.browserBinding?.cards?.find(item => item.cardId === event.arguments?.cardId)
          if (!card) throw chatError('BROWSER_CARD_NOT_SELECTED', 'This run has no grant for that Browser Card', 403)
          if (!BOUNDED_READ_TOOLS.has(event.tool)
            && !(BOUNDED_INTERACTION_TOOLS.has(event.tool) && card.permission === 'interact')) {
            throw chatError('BROWSER_INTERACTION_NOT_GRANTED', 'This run permits only its selected Browser observation or granted guarded interaction', 403)
          }
        }
        const fixtureMode = run.executionPolicy?.mode === FIXTURE_BROWSER_QA
        if (fixtureMode) {
          if (!fixtureQa || !['egdesk_browser_observe', 'egdesk_browser_click', 'egdesk_browser_fill'].includes(event.tool)) {
            throw chatError('BROWSER_FIXTURE_SCOPE', 'Fixture QA does not authorize this Browser tool', 403)
          }
          if (event.tool !== 'egdesk_browser_observe' && !fixtureAttestations.get(run.answerId)?.has(event.arguments?.cardId)) {
            throw chatError('BROWSER_FIXTURE_ATTESTATION_FAILED', 'Observe and attest the selected fixture Card before interaction', 403)
          }
          if (event.tool === 'egdesk_browser_click' && (event.arguments?.expectedTarget?.tag?.toLowerCase() !== 'button' ||
              event.arguments?.expectedTarget?.href || event.arguments?.postcondition?.kind !== 'visible-text')) {
            throw chatError('BROWSER_FIXTURE_SCOPE', 'Fixture QA click is limited to a local button with visible-text postcondition', 403)
          }
          if (event.tool === 'egdesk_browser_fill' && (!['input', 'textarea'].includes(event.arguments?.expectedTarget?.tag?.toLowerCase()) ||
              event.arguments?.postcondition?.kind !== 'target-value')) {
            throw chatError('BROWSER_FIXTURE_SCOPE', 'Fixture QA fill is limited to a local text field with value postcondition', 403)
          }
        }
        const result = await service.dispatch(run, event)
        if (fixtureMode && event.tool === 'egdesk_browser_observe') {
          if (!fixtureSnapshotMatches(result.snapshot, fixtureQa)) {
            fixtureAttestations.delete(run.answerId)
            void service.cancelRun(run).catch(() => {})
            throw chatError('BROWSER_FIXTURE_ATTESTATION_FAILED', 'Live Browser observation did not match the owned QA fixture', 403)
          }
          const cards = fixtureAttestations.get(run.answerId) || new Set()
          cards.add(result.cardId)
          fixtureAttestations.set(run.answerId, cards)
        }
        if (fixtureMode && event.tool !== 'egdesk_browser_observe' &&
            (!fixtureSnapshotMatches(result.after, fixtureQa) || result.status !== 'postcondition-observed')) {
          fixtureAttestations.delete(run.answerId)
          void service.cancelRun(run).catch(() => {})
          throw chatError('BROWSER_FIXTURE_ATTESTATION_FAILED', 'Fixture action did not retain the exact local page and postcondition', 403)
        }
        const success = SUCCESS_STATUSES.has(result.status)
        // BRW-07: the run's Card set follows what the UI bound or closed, so
        // later calls for the new Card pass this provider and the chat runtime.
        if (result.status === 'card-opened' && Array.isArray(run.browserBinding?.cards) &&
            !run.browserBinding.cards.some(item => item.cardId === result.cardId)) {
          run.browserBinding.cards.push({ cardId: result.cardId, permission: result.permission, cardEpoch: result.cardEpoch,
            openedByAgent: true, openedFrom: result.openedFrom })
          this.emit(run, 'browser.card.opened', { callId: event.callId, cardId: result.cardId, openedFrom: result.openedFrom,
            permission: result.permission, targetCardEpoch: result.cardEpoch, originalProviderId: this.providerId,
            namespace: event.namespace || null, bridgeEpoch: this.runtime.currentEpoch?.() ?? null }, event.callId)
        }
        if (result.status === 'card-closed' && Array.isArray(run.browserBinding?.cards)) {
          run.browserBinding.cards = run.browserBinding.cards.filter(item => item.cardId !== result.cardId)
          this.emit(run, 'browser.card.closed', { callId: event.callId, cardId: result.cardId, originalProviderId: this.providerId,
            namespace: event.namespace || null, bridgeEpoch: this.runtime.currentEpoch?.() ?? null }, event.callId)
        }
        const selected = run.browserBinding?.cards?.find(card => card.cardId === result.cardId)
        // The route the actor reported, from a fixed set; never a success claim.
        const inputRoute = [result.dispatchReceipt?.inputRoute, result.dispatchReceipt?.clickInputRoute]
          .find(route => PUBLIC_INPUT_ROUTES.has(route))
        this.emit(run, success ? 'browser.tool.completed' : 'browser.tool.unverified', {
          callId: event.callId, cardId: result.cardId, status: result.status,
          originalProviderId: this.providerId, namespace: event.namespace || null,
          bridgeEpoch: this.runtime.currentEpoch?.() ?? null,
          ...(selected?.sourceId ? { sourceId: selected.sourceId } : {}),
          ...(selected?.cardEpoch ? { targetCardEpoch: selected.cardEpoch } : {}),
          ...(result.action ? { action: result.action } : {}),
          ...(result.observationId ? { observationId: result.observationId } : {}),
          ...(result.postcondition ? { postconditionMatched: result.postcondition.matched === true } : {}),
          ...(inputRoute ? { inputRoute } : {}),
          externalEffectVerified: false,
        }, event.callId)
        // BRW-09: a masked screenshot travels as its own inputImage item.
        const imageUrl = typeof result.screenshot?.imageUrl === 'string' ? result.screenshot.imageUrl : null
        const text = JSON.stringify(imageUrl ? { ...result, screenshot: { ...result.screenshot, imageUrl: '[attached image]' } } : result)
        return { success, contentItems: [{ type: 'inputText', text }, ...(imageUrl ? [{ type: 'inputImage', imageUrl }] : [])] }
      } catch (error) {
        if (run.executionPolicy?.mode === FIXTURE_BROWSER_QA) fixtureAttestations.delete(run.answerId)
        const failure = classifyPublicToolError(error, { browser: true })
        const selected = run.browserBinding?.cards?.find(card => card.cardId === event.arguments?.cardId)
        this.emit(run, 'browser.tool.failed', { callId: event.callId, code: failure.code, cardId: selected?.cardId || null,
          originalProviderId: this.providerId, namespace: event.namespace || null,
          bridgeEpoch: this.runtime.currentEpoch?.() ?? null,
          ...(selected?.sourceId ? { sourceId: selected.sourceId } : {}),
          ...(selected?.cardEpoch ? { targetCardEpoch: selected.cardEpoch } : {}) }, event.callId)
        return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: { ...failure, ...publicBrowserErrorDetail(error) } }) }] }
      }
    },
    // Each reflex step goes through this provider's own dispatch for the same
    // run with a fresh callId, so grants, the action gate and receipts apply.
    // The authority one reflex execution runs under, shared by the model-called tool and the direct chat entry:
    // the recipient/key, run binding and Card grant are captured once and rechecked at every send.
    reflexScope(run, event, cardId) {
      // Snapshot the existing recipient/run scope; do not adopt a replacement
      // credential or Browser binding while an observation is pending.
      const currentRecipient = () => {
        try { return reflexEnabled(decision) ? decision.recipient?.() ?? null : null }
        catch { return null }
      }
      const recipient = currentRecipient()
      const generation = decision.generation?.()
      const binding = transport.runs.get(run.runId)
      const card = run.browserBinding?.cards?.find(item => item.cardId === cardId)
      const isDecisionCurrent = () => Boolean(recipient && binding && !resetting &&
        !cancelledBrowserRuns.has(run) && run.status === 'inProgress' && run.executionPolicy?.mode === BROWSER_BOUNDED &&
        binding.ownerKey === getOwnerKey() && binding.clientThreadId === run.clientThreadId &&
        transport.runs.get(run.runId) === binding && transport.hasClient(binding.transportId) &&
        card?.permission === 'interact' && run.browserBinding?.cards?.includes(card) && currentRecipient() === recipient &&
        Number.isSafeInteger(generation) && decision.generation?.() === generation)
      const authorizeDispatch = selectedRecipient => selectedRecipient === recipient && isDecisionCurrent()
      let step = 0
      const callTool = async (name, toolArgs) => {
        if (typeof name !== 'string' || !name.startsWith('egdesk_browser_') || name === BROWSER_REFLEX_TOOL_NAME) {
          const error = new Error('Browser reflex may call only Browser tools'); error.code = 'BROWSER_REFLEX_SCOPE'; throw error
        }
        step++
        const output = await this.dispatch(run, { tool: name, arguments: toolArgs,
          callId: `${event.callId || 'reflex'}.reflex-${step}-${randomUUID()}`, namespace: event.namespace || null })
        const text = output?.contentItems?.[0]?.text ?? ''
        if (!output?.success) throw reflexStepError(text)
        return JSON.parse(text)
      }
      // Page text reaches the decision model only where it may reach this run's models: the Agent tool ceiling and the selected Card grant.
      const gate = createEgressGate(modelDataPermissions({ toolCeiling: run.toolCeiling ?? null, browserGranted: Boolean(card) && card.permission !== 'none' }))
      return { callTool, authorizeDispatch, isDecisionCurrent, client: decision.client ? gate.guardClient(decision.client, ['page_text']) : null }
    },
    // Each reflex step goes through this provider's own dispatch for the same
    // run with a fresh callId, so grants, the action gate and receipts apply.
    async dispatchReflex(run, event) {
      if (!reflexEnabled(decision)) {
        return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: { code: 'BROWSER_REFLEX_UNAVAILABLE', message: 'The Browser reflex is not enabled' } }) }] }
      }
      const args = event.arguments && typeof event.arguments === 'object' ? event.arguments : {}
      const { callTool, authorizeDispatch, isDecisionCurrent, client } = this.reflexScope(run, event, args.cardId)
      let result
      try {
        result = await runReflex({ cardId: args.cardId, goal: args.goal,
          ...(args.values !== undefined ? { values: args.values } : {}),
          ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
          callTool, client, authorizeDispatch, isDecisionCurrent })
      } catch (error) {
        const failure = classifyPublicToolError(error, { browser: true })
        return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: failure }) }] }
      }
      const response = { success: result?.outcome !== 'invalid', contentItems: [{ type: 'inputText', text: reflexResultForModel(result || {}) }] }
      if (result?.outcome === 'handoff') reflexHandoffs.set(response, { run, event })
      return response
    },
    // The same gate as the model-called tool: a key and mode 'on'. Off means the direct entry calls nothing.
    directEntryEnabled() { return reflexEnabled(decision) },
    // The direct chat entry (egdesk-browser-task.mjs): same authority as the tool, but called by EG-Desk itself with
    // the user's own message as the goal. Returns the raw reflex result (outcome, steps, state), never the model text.
    // Reflex and Decisions gating is identical to the tool: mode on and a key, or nothing is called.
    // The account the run belongs to (history records are scoped to it).
    currentOwnerKey() { const key = getOwnerKey(); return typeof key === 'string' && key ? key : null },
    async runDirectTask(run, { cardId, goal, userContext = [], resumeState = null, priorRun = null, memoryPacket = null, maxSteps, callId, onStep = null }) {
      if (!reflexEnabled(decision)) return { outcome: 'fallback', reason: 'not_configured', steps: [] }
      const scope = this.reflexScope(run, { callId: callId || 'direct-task', namespace: null }, cardId)
      const result = await runReflex({ cardId, goal, ...(maxSteps !== undefined ? { maxSteps } : {}), userContext, resumeState, priorRun, memoryPacket, onStep,
        callTool: scope.callTool, client: scope.client, authorizeDispatch: scope.authorizeDispatch, isDecisionCurrent: scope.isDecisionCurrent })
      if (result?.outcome === 'handoff') reflexHandoffs.set(result, { run, event: { callId: callId || 'direct-task' } })
      return result
    },
    async cancelRun(run) {
      // Fence notices immediately, even while the stop RPC or UI cleanup is pending.
      cancelledBrowserRuns.add(run)
      fixtureAttestations.delete(run.answerId)
      if (run.browserBinding?.cards?.length) this.emit(run, 'browser.cancel.requested', {
        originalProviderId: this.providerId, namespace: null, bridgeEpoch: this.runtime.currentEpoch?.() ?? null,
        cards: run.browserBinding.cards.map(({ cardId, sourceId, cardEpoch }) => ({ cardId,
          ...(sourceId ? { sourceId } : {}), ...(cardEpoch ? { targetCardEpoch: cardEpoch } : {}) })),
      })
      try { return await service.cancelRun(run) }
      catch { return [] }
      finally { transport.unbindRun(run.runId); if (run.adoptedFrom) transport.unbindRun(run.adoptedFrom) }
    },
    disconnect() {
      fixtureAttestations.clear()
      resetting++
      const operation = service.reset()
      void Promise.resolve(operation).catch(() => {}).finally(() => { for (const runId of transport.runs.keys()) transport.unbindRun(runId); resetting-- })
    },
    reset() {
      fixtureAttestations.clear()
      resetting++
      const operation = service.reset()
      void Promise.resolve(operation).catch(() => {}).finally(() => { transport.reset(); resetting-- })
    },
  }
  return provider
}
