import { createHash, randomUUID } from 'node:crypto'

// Lane A/native adapter: chrome /chat/send includes selectedSources from the
// submitted Chat draft before it is cleared. Never infer action authority from
// immutable read-only attachments. prepare({selectedSources}) -> specs(prepared)
// -> bind(run, prepared) -> dispatch(run, {tool, arguments, callId}).
// sendToUi(request) must correlate requestId to a single response from the
// chrome UI's browserAgentTools.attachTransport({source, respond}) listener for
// a Lane A-validated SSE stream's `browser-tool-request` event.
// Requests carry runId, cardId, targetCardEpoch, deadlineMs, permission-bound selection/binding,
// actor guard and postcondition; never fan out to all open Browser Cards.
// Lane A owns native registration, response mapping, run cancellation and
// transport authentication. This module owns run admission/preconditions;
// Firefox chrome owns the final live Card/actor comparison and actual input.
const target = { type: 'object', additionalProperties: false, required: ['ref', 'role', 'label', 'href', 'value', 'tag'],
  properties: { ...Object.fromEntries(['ref', 'role', 'label', 'href', 'value', 'tag'].map(key => [key, { type: 'string' }])),
    disabled: { type: 'boolean' }, bounds: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, { type: 'number' }])) } } }
const postcondition = { type: 'object', additionalProperties: false, required: ['kind', 'value'],
  properties: { kind: { type: 'string', enum: ['visible-text', 'url', 'target-value'] }, value: { type: 'string' } } }
const base = { cardId: { type: 'string' }, observationId: { type: 'string' }, expectedRevision: { type: 'integer' } }
function spec(name, description, properties, required) {
  return { type: 'function', name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required } }
}
export const BROWSER_TOOL_SPECS = [
  spec('egdesk_browser_observe', 'Observe one explicitly selected Browser Card. Coordinates are Browser surface-local; camera movement does not change the target. A selected account label does not prove site login.',
    { cardId: base.cardId }, ['cardId']),
  spec('egdesk_browser_navigate', 'Request navigation in the bound Browser Card, then observe. A dispatched request does not prove load or an external effect.',
    { ...base, url: { type: 'string' }, postcondition }, ['cardId', 'observationId', 'expectedRevision', 'url', 'postcondition']),
  spec('egdesk_browser_click', 'Request one guarded DOM click on an observed element without pointerdown or a focus step. A site may ignore synthetic clicks or focus another element itself. Requires a fresh observation, exact target precondition and testable DOM postcondition; an interaction grant is not proof of external authorization or submission success.',
    { ...base, ref: { type: 'string' }, expectedTarget: target, postcondition },
    ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'postcondition']),
  spec('egdesk_browser_fill', 'Fill an observed non-password field in the bound Browser Card. Requires a fresh observation, exact target precondition and a testable DOM postcondition.',
    { ...base, ref: { type: 'string' }, expectedTarget: target, text: { type: 'string' }, postcondition },
    ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'text', 'postcondition']),
]
const SPEC_BY_NAME = new Map(BROWSER_TOOL_SPECS.map(item => [item.name, item]))

function reject(code, message) { throw Object.assign(new Error(message), { code }) }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function short(value, max = 512) { return typeof value === 'string' && value.length > 0 && value.length <= max }
function sameTarget(left, right) {
  return ['ref', 'role', 'label', 'href', 'value', 'tag'].every(key => left?.[key] === right?.[key])
}
function safeUrl(value) {
  if (!short(value, 2048) || /[\u0000-\u0020\u007f]/.test(value)) return false
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }
  catch { return false }
}
function sameUrl(left, right) {
  try { return new URL(left).href === new URL(right).href }
  catch { return false }
}
function validateArgs(tool, args) {
  const schema = SPEC_BY_NAME.get(tool)?.inputSchema
  if (!schema || !record(args)) reject('INVALID_BROWSER_TOOL', 'Unsupported Browser tool or argument object')
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) ||
      schema.required.some(key => !Object.hasOwn(args, key))) reject('INVALID_BROWSER_TOOL', 'Invalid Browser tool arguments')
  if (!short(args.cardId, 160)) reject('INVALID_BROWSER_TOOL', 'cardId is required')
  if (tool === 'egdesk_browser_observe') return
  if (!short(args.observationId, 160) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 ||
      !record(args.postcondition) || !['visible-text', 'url', 'target-value'].includes(args.postcondition.kind) ||
      typeof args.postcondition.value !== 'string' || args.postcondition.value.length > 512 ||
      (args.postcondition.kind !== 'target-value' && !args.postcondition.value) ||
      (args.postcondition.kind === 'url' && !safeUrl(args.postcondition.value)) ||
      Object.keys(args.postcondition).some(key => !['kind', 'value'].includes(key))) reject('INVALID_BROWSER_TOOL', 'Fresh observation and postcondition are required')
  if (tool === 'egdesk_browser_navigate') {
    if (!safeUrl(args.url) || args.postcondition.kind !== 'url') reject('INVALID_BROWSER_TOOL', 'Navigation requires an explicit safe URL and URL postcondition')
    return
  }
  if (!short(args.ref, 160) || !record(args.expectedTarget) || args.expectedTarget.ref !== args.ref ||
      Object.keys(args.expectedTarget).some(key => !['ref', 'role', 'label', 'href', 'value', 'tag', 'disabled', 'bounds'].includes(key)) ||
      ['ref', 'role', 'label', 'href', 'value', 'tag'].some(key => typeof args.expectedTarget[key] !== 'string')) {
    reject('INVALID_BROWSER_TOOL', 'An exact observed element precondition is required')
  }
  if (tool === 'egdesk_browser_fill' && (typeof args.text !== 'string' || args.text.length > 8192 ||
      args.postcondition.kind !== 'target-value')) reject('INVALID_BROWSER_TOOL', 'Fill requires bounded text and a target-value postcondition')
}
function validSnapshot(snapshot, cardId) {
  return record(snapshot) && snapshot.cardId === cardId &&
    short(snapshot.documentId, 160) && Number.isSafeInteger(snapshot.revision) &&
    record(snapshot.viewport) && Number.isFinite(snapshot.viewport.width) && Number.isFinite(snapshot.viewport.height) &&
    Number.isFinite(snapshot.viewport.devicePixelRatio) && snapshot.viewport.devicePixelRatio > 0 &&
    typeof snapshot.url === 'string' && Array.isArray(snapshot.interactiveElements) && Array.isArray(snapshot.text)
}
function observationFrom(response, cardId) {
  const snapshot = response?.snapshot
  if (response?.status !== 'observed' || !validSnapshot(snapshot, cardId)) {
    reject('BROWSER_OBSERVATION_UNAVAILABLE', 'The selected Browser did not return a verifiable observation')
  }
  return snapshot
}
function checkPostcondition(condition, snapshot, ref) {
  if (!snapshot || !condition) return false
  if (condition.kind === 'url') return sameUrl(snapshot.url, condition.value)
  if (condition.kind === 'visible-text') return snapshot.text.some(text => String(text).includes(condition.value))
  if (condition.kind === 'target-value') return snapshot.interactiveElements.some(item => item.ref === ref && item.value === condition.value)
  return false
}

export function createBrowserToolService({ sendToUi, getOwnerKey, timeoutMs = 15000, now = Date.now } = {}) {
  if (typeof sendToUi !== 'function' || typeof getOwnerKey !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new TypeError('Browser tool service requires UI transport, current account provider and bounded timeout')
  }
  const bindings = new Map()
  const pendingBindings = new Map()
  const closedRuns = new Set()
  const preparedRuns = new WeakSet()

  function cancelCards(binding) {
    return Promise.allSettled(binding.selectedCards.map(card => requestUi({ kind: 'cancel',
      runId: binding.runId, clientThreadId: binding.clientThreadId, cardId: card.cardId,
      cardEpoch: card.cardEpoch, selectionToken: card.selectionToken,
    })))
  }

  async function requestUi(payload) {
    const requestId = randomUUID()
    const targetCardEpoch = payload.selection?.cardEpoch || payload.binding?.cardEpoch || payload.cardEpoch
    if (!short(targetCardEpoch, 160)) reject('BROWSER_UI_PROTOCOL', 'Browser request has no exact Card generation')
    let timer
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => sendToUi({ version: 1, requestId, targetCardEpoch,
          deadlineMs: now() + timeoutMs, ...payload })),
        new Promise((_, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(Object.assign(new Error('Browser UI response timed out; outcome is unknown'), { code: 'BROWSER_UI_TIMEOUT' })), timeoutMs) }),
      ])
      if (!record(response) || response.requestId !== requestId) reject('BROWSER_UI_PROTOCOL', 'Browser UI response does not match this request')
      if (JSON.stringify(response).length > 180000) reject('BROWSER_UI_PROTOCOL', 'Browser UI response exceeded the bounded limit')
      return response
    } finally { clearTimeout(timer) }
  }

  function prepare({ selectedSources = [], ownerKey = getOwnerKey() } = {}) {
    if (Array.isArray(selectedSources) && selectedSources.length === 0) return null
    if (!short(ownerKey, 256) || ownerKey !== getOwnerKey()) reject('BROWSER_OWNER_REQUIRED', 'Current Engine account must be known and unchanged')
    if (!Array.isArray(selectedSources) || selectedSources.length > 4) reject('INVALID_BROWSER_SELECTION', 'Select at most four Browser Cards')
    const cards = new Map()
    for (const source of selectedSources) {
      const ref = source?.sourceRef
      const identity = source?.browserToolIdentity
      const selection = source?.browserToolSelection
      if (source?.kind !== 'browser' || !short(source.id, 160) || source.selectedByUser !== true ||
          !['observe', 'interact'].includes(source.browserToolPermission) || !record(ref) ||
          !short(ref.viewId, 160) || !short(ref.profileId, 160) || typeof ref.accountId !== 'string' ||
          ref.accountId.length > 160 || !short(ref.uri, 2048) || cards.has(ref.viewId) ||
          !record(identity) || !short(identity.cardEpoch, 160) || !short(identity.engineAccountKey, 256) ||
          !Number.isSafeInteger(identity.authorityEpoch) || !Number.isSafeInteger(identity.userContextId) ||
          !record(selection) || !short(selection.token, 160) || !short(selection.threadId, 160)) {
        reject('INVALID_BROWSER_SELECTION', 'Browser tool source must be explicitly selected with a bound Card, profile and permission')
      }
      cards.set(ref.viewId, { cardId: ref.viewId, profileId: ref.profileId, accountId: ref.accountId,
        selectedUrl: ref.uri, permission: source.browserToolPermission,
        selectionToken: selection.token, clientThreadId: selection.threadId, sourceId: source.id, ...identity })
    }
    const value = { ownerKey, cards, preparedAt: now() }
    preparedRuns.add(value)
    return value
  }

  function specs(prepared = null) {
    if (!prepared || !preparedRuns.has(prepared)) return []
    const permissions = [...prepared.cards.values()].map(card => card.permission)
    if (!permissions.length) return []
    return permissions.includes('interact') ? BROWSER_TOOL_SPECS : BROWSER_TOOL_SPECS.slice(0, 1)
  }

  async function bind(run, prepared) {
    if (!short(run?.answerId, 160) || !short(run?.clientThreadId, 160) ||
        !preparedRuns.has(prepared) || prepared.ownerKey !== getOwnerKey()) reject('BROWSER_BINDING_FORBIDDEN', 'Browser run binding is unavailable for this account')
    if (closedRuns.has(run.answerId)) reject('BROWSER_RUN_ENDED', 'Cancelled Browser run cannot be rebound')
    if (bindings.has(run.answerId) || pendingBindings.has(run.answerId)) reject('BROWSER_BINDING_EXISTS', 'Browser run is already bound or binding')
    const binding = { ownerKey: prepared.ownerKey, runId: run.runId || run.answerId,
      clientThreadId: run.clientThreadId, selectedCards: [...prepared.cards.values()],
      cards: new Map(), pending: new Set(), calls: new Map(), closed: false }
    pendingBindings.set(run.answerId, binding)
    try {
      for (const card of prepared.cards.values()) {
        if (binding.closed || closedRuns.has(run.answerId) || prepared.ownerKey !== getOwnerKey() || run.status !== 'inProgress') {
          reject('BROWSER_RUN_ENDED', 'Browser run or account ended during binding')
        }
        if (card.clientThreadId !== binding.clientThreadId) reject('BROWSER_BINDING_FORBIDDEN', 'Browser selection belongs to another Chat thread')
        const response = await requestUi({ kind: 'bind', runId: binding.runId,
          clientThreadId: binding.clientThreadId, cardId: card.cardId, selection: card })
        if (response.status !== 'bound' || !record(response.binding) || response.binding.cardId !== card.cardId ||
            response.binding.profileId !== card.profileId || response.binding.accountId !== card.accountId ||
            !short(response.binding.cardEpoch, 160) || !Number.isSafeInteger(response.binding.userContextId) ||
            !sameUrl(response.binding.url, card.selectedUrl) || response.binding.cardEpoch !== card.cardEpoch ||
            response.binding.userContextId !== card.userContextId ||
            response.binding.engineAccountKey !== card.engineAccountKey ||
            response.binding.authorityEpoch !== card.authorityEpoch) reject('BROWSER_BINDING_STALE', 'Selected Browser identity changed before binding')
        if (binding.closed || closedRuns.has(run.answerId) || run.status !== 'inProgress') reject('BROWSER_RUN_ENDED', 'Browser run ended during binding')
        if (prepared.ownerKey !== getOwnerKey()) reject('BROWSER_OWNER_CHANGED', 'Engine account changed during Browser binding')
        binding.cards.set(card.cardId, { ...card, ui: response.binding, observation: null,
          busy: false, uncertain: false, pendingTransition: null })
      }
      if (binding.closed || closedRuns.has(run.answerId) || prepared.ownerKey !== getOwnerKey() || run.status !== 'inProgress') {
        reject('BROWSER_RUN_ENDED', 'Browser run or account ended before binding completed')
      }
      bindings.set(run.answerId, binding)
      return { cards: [...binding.cards.values()].map(({ cardId, profileId, accountId, permission, ui }) =>
        ({ cardId, profileId, accountId, permission, userContextId: ui.userContextId, accountStatus: ui.accountStatus || 'unverified' })) }
    } catch (error) {
      // Cancel even the card whose bind response was lost; UI tombstones the
      // run/Card key so a delayed bind cannot resurrect authority.
      binding.closed = true
      closedRuns.add(run.answerId)
      await cancelCards(binding)
      throw error
    } finally {
      if (pendingBindings.get(run.answerId) === binding) pendingBindings.delete(run.answerId)
    }
  }

  async function executeDispatch(run, event) {
    const args = event?.arguments
    const tool = event?.tool
    validateArgs(tool, args)
    const binding = bindings.get(run?.answerId)
    if (!binding || binding.closed || closedRuns.has(run?.answerId) || binding.ownerKey !== getOwnerKey() || run?.status !== 'inProgress') reject('BROWSER_RUN_ENDED', 'Browser tool run or account is no longer active')
    const card = binding.cards.get(args.cardId)
    if (!card) reject('BROWSER_CARD_NOT_SELECTED', 'Browser Card was not selected for this run')
    if (card.busy) reject('BROWSER_CARD_BUSY', 'Wait for the current Browser request to finish')
    if (tool !== 'egdesk_browser_observe' && card.permission !== 'interact') reject('BROWSER_INTERACTION_NOT_GRANTED', 'Read-only Browser context does not authorize interaction')
    if (tool === 'egdesk_browser_observe') {
      card.busy = true
      const pending = requestUi({ kind: 'observe', runId: binding.runId,
        clientThreadId: binding.clientThreadId, cardId: card.cardId, binding: card.ui,
        options: { textLimit: 60, elementLimit: 80 } })
      binding.pending.add(pending)
      let response
      try { response = await pending } finally { binding.pending.delete(pending); card.busy = false }
      if (binding.closed || binding.ownerKey !== getOwnerKey()) reject('BROWSER_RUN_ENDED', 'Browser run ended during observation')
      const snapshot = observationFrom(response, card.cardId)
      const transition = card.pendingTransition
      const transitionRecovered = !!(transition &&
        snapshot.documentId !== transition.priorDocumentId &&
        ['interactive', 'complete'].includes(snapshot.readyState) &&
        !transition.wasAlreadyTrue && checkPostcondition(transition.condition, snapshot, transition.ref))
      if (transitionRecovered) { card.uncertain = false; card.pendingTransition = null }
      card.observation = { id: randomUUID(), snapshot }
      return { status: 'observed', cardId: card.cardId, observationId: card.observation.id,
        snapshot, navigationPostconditionReobserved: transitionRecovered && transition.actionType === 'navigate',
        documentTransitionPostconditionReobserved: transitionRecovered, externalEffectVerified: false }
    }
    if (card.uncertain) reject('BROWSER_OUTCOME_UNKNOWN', 'A prior Browser action has an unknown outcome; select the context again')
    const observed = card.observation
    if (!observed || observed.id !== args.observationId || observed.snapshot.revision !== args.expectedRevision) reject('BROWSER_OBSERVATION_STALE', 'Observe this Browser Card again before acting')
    if (tool !== 'egdesk_browser_navigate') {
      const original = observed.snapshot.interactiveElements.find(item => item.ref === args.ref)
      if (!original || !sameTarget(original, args.expectedTarget) || original.disabled) reject('BROWSER_TARGET_STALE', 'Target precondition does not match the observed element')
    }
    // A single observation authorizes at most one dispatch. Unknown outcomes are
    // not retried automatically; the next action requires a new observation.
    card.observation = null
    card.busy = true
    const action = tool === 'egdesk_browser_navigate' ? { type: 'navigate', url: args.url } :
      tool === 'egdesk_browser_click' ? { type: 'click', ref: args.ref } :
      { type: 'fill', ref: args.ref, text: args.text }
    const wasAlreadyTrue = checkPostcondition(args.postcondition, observed.snapshot, args.ref)
    const markUnknown = () => {
      card.uncertain = true
      if (action.type === 'navigate' ||
          (action.type === 'click' && ['url', 'visible-text'].includes(args.postcondition.kind))) {
        card.pendingTransition = { condition: args.postcondition, ref: args.ref || null,
          priorDocumentId: observed.snapshot.documentId, actionType: action.type, wasAlreadyTrue }
      }
    }
    const guard = { documentId: observed.snapshot.documentId, revision: observed.snapshot.revision,
      viewport: observed.snapshot.viewport, url: observed.snapshot.url,
      focusedRef: observed.snapshot.focusedElement?.ref || null,
      ...(args.expectedTarget ? { target: args.expectedTarget } : {}) }
    const pending = requestUi({ kind: 'act', runId: binding.runId,
      clientThreadId: binding.clientThreadId, cardId: card.cardId, binding: card.ui,
      action, guard, postcondition: args.postcondition })
    binding.pending.add(pending)
    let response
    try { response = await pending }
    catch (error) { markUnknown(); throw error }
    finally { binding.pending.delete(pending); card.busy = false }
    if (binding.closed || binding.ownerKey !== getOwnerKey()) reject('BROWSER_RUN_ENDED', 'Browser run ended during action; effect is unknown')
    if (response.status !== 'acted' || !record(response.receipt)) {
      markUnknown()
      reject('BROWSER_ACTION_UNVERIFIED', response.error || 'Browser action was not confirmed; do not retry blindly')
    }
    const after = response.receipt.after
    const dispatchReceipt = response.receipt.dispatchReceipt
    const readbackIsCurrent = validSnapshot(after, card.cardId) && record(dispatchReceipt) &&
      dispatchReceipt.actor === 'JSWindowActor' && dispatchReceipt.eventDispatched === true &&
      dispatchReceipt.documentStillCurrent === true &&
      (action.type === 'navigate' || after.documentId === observed.snapshot.documentId) &&
      (action.type !== 'click' || (
        dispatchReceipt.clickInputRoute === 'dom-click-no-pointerdown' &&
        dispatchReceipt.targetClickObserved === true))
    const matched = !wasAlreadyTrue && readbackIsCurrent && checkPostcondition(args.postcondition, after, args.ref)
    if (!matched) markUnknown()
    return { status: matched ? 'postcondition-observed' : 'postcondition-unverified',
      cardId: card.cardId, action: action.type, dispatchReceipt: response.receipt.dispatchReceipt || null,
      postcondition: { ...args.postcondition, matched, wasAlreadyTrue }, after: after || null,
      observation: response.receipt.observation || null,
      ...(action.type === 'navigate' ? { pageLoadVerified: false } : {}), externalEffectVerified: false }
  }

  async function dispatch(run, event) {
    const tool = event?.tool
    validateArgs(tool, event?.arguments)
    const binding = bindings.get(run?.answerId)
    if (!binding || binding.closed || closedRuns.has(run?.answerId) || binding.ownerKey !== getOwnerKey() || run?.status !== 'inProgress') {
      reject('BROWSER_RUN_ENDED', 'Browser tool run or account is no longer active')
    }
    const callId = event?.callId
    if (tool !== 'egdesk_browser_observe' && !short(callId, 160)) {
      reject('BROWSER_CALL_ID_REQUIRED', 'Native Browser actions require a stable call ID')
    }
    if (!short(callId, 160)) return executeDispatch(run, event)
    const fingerprint = createHash('sha256').update(JSON.stringify([tool, event.arguments])).digest('hex')
    const previous = binding.calls.get(callId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) reject('BROWSER_CALL_ID_REUSED', 'Browser call ID was reused with different arguments')
      return previous.operation
    }
    if (binding.calls.size >= 1024) reject('BROWSER_CALL_LIMIT', 'Browser run reached its bounded call limit')
    const operation = executeDispatch(run, event)
    binding.calls.set(callId, { fingerprint, operation })
    return operation
  }

  async function cancelRun(run) {
    if (short(run?.answerId, 160)) closedRuns.add(run.answerId)
    const binding = bindings.get(run?.answerId) || pendingBindings.get(run?.answerId)
    if (!binding) return []
    binding.closed = true
    for (const card of binding.cards.values()) card.observation = null
    return cancelCards(binding)
  }
  function reset() {
    const pending = [...new Set([...bindings.values(), ...pendingBindings.values()])].flatMap(binding => {
      binding.closed = true
      return [cancelCards(binding)]
    })
    for (const answerId of [...bindings.keys(), ...pendingBindings.keys()]) closedRuns.add(answerId)
    bindings.clear()
    pendingBindings.clear()
    return Promise.allSettled(pending)
  }
  return { prepare, specs, bind, dispatch, cancelRun, reset }
}
