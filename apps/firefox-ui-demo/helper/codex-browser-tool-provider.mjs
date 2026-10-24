import { BROWSER_INTERACTION_TOOL_NAMES, BROWSER_READ_TOOL_NAMES, BROWSER_TOOL_SPECS, createBrowserToolService } from './egdesk-browser-tool-runtime.mjs'
import { chatError } from './codex-chat-values.mjs'
import { classifyPublicToolError } from './codex-tool-errors.mjs'
import { fixtureSnapshotMatches } from './codex-browser-fixture-qa.mjs'

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
  if (error.reconcile && typeof error.reconcile === 'object') {
    const { answered, entered, performing, fenced, reason } = error.reconcile
    detail.reconcile = { answered: answered === true,
      ...([true, false].includes(entered) ? { entered } : {}),
      ...(performing === true ? { performing: true } : {}), ...(fenced === true ? { fenced: true } : {}),
      ...(['run-ended', 'no-answer', 'unrecognized-answer', 'other-document', 'record-evicted', 'unproven'].includes(reason) ? { reason } : {}) }
  }
  return detail
}
const SUCCESS_STATUSES = new Set(['observed', 'postcondition-observed', 'wait-condition-met'])
const PUBLIC_INPUT_ROUTES = new Set(['dom-click-no-pointerdown', 'dom-scroll-api', 'dom-keyboard-event',
  'dom-value-setter', 'dom-editor-replace'])

export function createCodexBrowserToolProvider({ transport, getOwnerKey, schemaReady = () => true, fixtureQa = null, service = createBrowserToolService({ sendToUi: request => transport.sendToUi(request), getOwnerKey }) }) {
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
        if (selectedSources.length !== 1 || selectedSources[0].selectedByUser !== true) {
          throw chatError('INVALID_BROWSER_SELECTION', 'Select exactly one Browser Card for this run', 400)
        }
        let selectedUrl
        try { selectedUrl = new URL(selectedSources[0].sourceRef?.uri) } catch {}
        if (!selectedUrl || !['http:', 'https:'].includes(selectedUrl.protocol)
          || selectedUrl.username || selectedUrl.password) {
          throw chatError('INVALID_BROWSER_SELECTION', 'This run requires one selected HTTP(S) Browser Card', 400)
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
    specs() { return schemaReady() ? BROWSER_TOOL_SPECS : [] },
    requireThread(threadId, prepared) {
      if (prepared && !this.runtime.browserRegisteredThreads.has(threadId)) {
        throw chatError('BROWSER_TOOLS_UNAVAILABLE', 'This native thread predates Browser tools; keep its history and choose an explicit new conversation', 409)
      }
    },
    registerThread(threadId) { this.runtime.browserRegisteredThreads.add(threadId) },
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
        this.runtime.emit(run, 'browser.bound', run.browserBinding)
      } catch (error) {
        transport.unbindRun(run.runId)
        const failure = classifyPublicToolError(error, { browser: true })
        throw chatError(failure.code, failure.message, 409)
      }
    },
    async dispatch(run, event) {
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
        const selected = run.browserBinding?.cards?.find(card => card.cardId === result.cardId)
        // The route the actor reported, from a fixed set; never a success claim.
        const inputRoute = [result.dispatchReceipt?.inputRoute, result.dispatchReceipt?.clickInputRoute]
          .find(route => PUBLIC_INPUT_ROUTES.has(route))
        this.runtime.emit(run, success ? 'browser.tool.completed' : 'browser.tool.unverified', {
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
        return { success, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
      } catch (error) {
        if (run.executionPolicy?.mode === FIXTURE_BROWSER_QA) fixtureAttestations.delete(run.answerId)
        const failure = classifyPublicToolError(error, { browser: true })
        const selected = run.browserBinding?.cards?.find(card => card.cardId === event.arguments?.cardId)
        this.runtime.emit(run, 'browser.tool.failed', { callId: event.callId, code: failure.code, cardId: selected?.cardId || null,
          originalProviderId: this.providerId, namespace: event.namespace || null,
          bridgeEpoch: this.runtime.currentEpoch?.() ?? null,
          ...(selected?.sourceId ? { sourceId: selected.sourceId } : {}),
          ...(selected?.cardEpoch ? { targetCardEpoch: selected.cardEpoch } : {}) }, event.callId)
        return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: { ...failure, ...publicBrowserErrorDetail(error) } }) }] }
      }
    },
    async cancelRun(run) {
      fixtureAttestations.delete(run.answerId)
      if (run.browserBinding?.cards?.length) this.runtime.emit(run, 'browser.cancel.requested', {
        originalProviderId: this.providerId, namespace: null, bridgeEpoch: this.runtime.currentEpoch?.() ?? null,
        cards: run.browserBinding.cards.map(({ cardId, sourceId, cardEpoch }) => ({ cardId,
          ...(sourceId ? { sourceId } : {}), ...(cardEpoch ? { targetCardEpoch: cardEpoch } : {}) })),
      })
      try { return await service.cancelRun(run) }
      catch { return [] }
      finally { transport.unbindRun(run.runId) }
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
