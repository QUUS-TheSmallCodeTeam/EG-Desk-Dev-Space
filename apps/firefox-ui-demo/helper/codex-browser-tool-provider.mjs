import { BROWSER_TOOL_SPECS, createBrowserToolService } from './egdesk-browser-tool-runtime.mjs'
import { chatError } from './codex-chat-values.mjs'
import { classifyPublicToolError } from './codex-tool-errors.mjs'

const BROWSER_BOUNDED = 'browserBounded'
const READ_ONLY_QA = 'readOnlyQa'

export function createCodexBrowserToolProvider({ transport, getOwnerKey, schemaReady = () => true, service = createBrowserToolService({ sendToUi: request => transport.sendToUi(request), getOwnerKey }) }) {
  if (!transport || typeof transport.hasClient !== 'function' || typeof getOwnerKey !== 'function') throw new TypeError('Browser provider requires a bounded UI transport and account identity')
  let resetting = 0
  const provider = {
    providerId: 'egdesk-browser',
    prepare(body) {
      const selectedSources = body.selectedSources ?? []
      if (!Array.isArray(selectedSources)) throw chatError('INVALID_BROWSER_SELECTION', 'Browser selection must be an array', 400)
      if (!selectedSources.length) return null
      if (!schemaReady()) throw chatError('BROWSER_TOOLS_UNAVAILABLE', 'Native Browser tool contract is not verified', 503)
      if (resetting) throw chatError('BROWSER_RESET_PENDING', 'Browser authority is still being revoked', 409)
      const policy = body.effectiveExecutionPolicy
      if (![READ_ONLY_QA, BROWSER_BOUNDED].includes(policy)) throw chatError('BROWSER_POLICY_REQUIRED', 'Browser tools require an explicit bounded native execution policy', 409)
      const transportId = body.browserTransportId
      if (!transport.hasClient(transportId)) throw chatError('BROWSER_UI_UNAVAILABLE', 'The selected Browser UI stream is unavailable', 409)
      if (selectedSources.some(source => typeof source?.id !== 'string' || !source.id ||
          typeof source.browserToolSelection?.token !== 'string' || !source.browserToolSelection.token ||
          source.browserToolSelection.threadId !== body.clientThreadId)) {
        throw chatError('INVALID_BROWSER_SELECTION', 'Browser selection must retain its one-time source token and exact Chat binding', 400)
      }
      if (policy === READ_ONLY_QA && selectedSources.some(source => source.browserToolPermission !== 'observe')) {
        throw chatError('BROWSER_INTERACTION_NOT_GRANTED', 'Read-only QA accepts only a Browser observe selection', 403)
      }
      let selection
      try { selection = service.prepare({ selectedSources, ownerKey: getOwnerKey() }) }
      catch (error) { const failure = classifyPublicToolError(error, { browser: true }); throw chatError(failure.code, failure.message, 400) }
      return { selection, transportId, policy }
    },
    // Register the complete stable catalog when a native thread is created.
    // Per-run selection, native policy and the service binding are the actual
    // authority; this lets a user attach a Card later without changing threads.
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
        const result = await service.dispatch(run, event)
        const success = ['observed', 'postcondition-observed'].includes(result.status)
        const selected = run.browserBinding?.cards?.find(card => card.cardId === result.cardId)
        this.runtime.emit(run, success ? 'browser.tool.completed' : 'browser.tool.unverified', {
          callId: event.callId, cardId: result.cardId, status: result.status,
          originalProviderId: this.providerId, namespace: event.namespace || null,
          bridgeEpoch: this.runtime.currentEpoch?.() ?? null,
          ...(selected?.sourceId ? { sourceId: selected.sourceId } : {}),
          ...(selected?.cardEpoch ? { targetCardEpoch: selected.cardEpoch } : {}),
          ...(result.action ? { action: result.action } : {}),
          ...(result.observationId ? { observationId: result.observationId } : {}),
          ...(result.postcondition ? { postconditionMatched: result.postcondition.matched === true } : {}),
          externalEffectVerified: false,
        }, event.callId)
        return { success, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
      } catch (error) {
        const failure = classifyPublicToolError(error, { browser: true })
        const selected = run.browserBinding?.cards?.find(card => card.cardId === event.arguments?.cardId)
        this.runtime.emit(run, 'browser.tool.failed', { callId: event.callId, code: failure.code, cardId: selected?.cardId || null,
          originalProviderId: this.providerId, namespace: event.namespace || null,
          bridgeEpoch: this.runtime.currentEpoch?.() ?? null,
          ...(selected?.sourceId ? { sourceId: selected.sourceId } : {}),
          ...(selected?.cardEpoch ? { targetCardEpoch: selected.cardEpoch } : {}) }, event.callId)
        return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: failure }) }] }
      }
    },
    async cancelRun(run) {
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
      resetting++
      const operation = service.reset()
      void Promise.resolve(operation).catch(() => {}).finally(() => { for (const runId of transport.runs.keys()) transport.unbindRun(runId); resetting-- })
    },
    reset() {
      resetting++
      const operation = service.reset()
      void Promise.resolve(operation).catch(() => {}).finally(() => { transport.reset(); resetting-- })
    },
  }
  return provider
}
