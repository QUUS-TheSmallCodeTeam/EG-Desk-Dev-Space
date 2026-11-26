import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BROWSER_INTERACTION_TOOL_NAMES, BROWSER_READ_TOOL_NAMES, BROWSER_TOOL_SPECS, boundedFieldValue,
  createBrowserToolService } from './egdesk-browser-tool-runtime.mjs'
import { classifyPublicToolError } from './codex-tool-errors.mjs'

test('click tool advertises the focus-safe DOM route and still requires a postcondition', () => {
  const click = BROWSER_TOOL_SPECS.find(item => item.name === 'egdesk_browser_click')
  assert.match(click.description, /without pointerdown or a focus step/)
  assert.match(click.description, /site may ignore synthetic clicks or focus another element/)
  assert(click.inputSchema.required.includes('postcondition'))
})

const run = { answerId: 'answer-1', runId: 'run-1', clientThreadId: 'thread-a', status: 'inProgress' }
function source(permission = 'interact', cardId = 'browser-1') {
  return { id: `selected-${cardId}`, kind: 'browser', selectedByUser: true,
    browserToolPermission: permission, browserToolSelection: { token: `grant-${cardId}`, threadId: 'thread-a' },
    browserToolIdentity: { cardEpoch: 'card-epoch-1', userContextId: 0,
      engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0 },
    sourceRef: { viewId: cardId, profileId: 'firefox-default', accountId: 'fixture-account', uri: 'https://example.test/local' } }
}
function snapshot(revision = 3, overrides = {}) {
  return { cardId: 'browser-1', documentId: 'document-1', revision,
    coordinateSpace: 'browser-viewport-local', viewport: { width: 720, height: 480, devicePixelRatio: 1 },
    url: 'https://example.test/local', title: 'Fixture', text: ['Count: 0'],
    interactiveElements: [{ ref: 'el_1', role: 'button', label: 'Increment', href: '', value: '',
      tag: 'button', disabled: false, bounds: { x: 12, y: 30, width: 80, height: 30 } }], ...overrides }
}
function omitDispatchFields(receipt, ...fields) {
  const dispatchReceipt = { ...receipt.dispatchReceipt }
  for (const field of fields) delete dispatchReceipt[field]
  return { ...receipt, dispatchReceipt }
}
function fixture(permission = 'interact', { bindUrl = 'https://example.test/local' } = {}) {
  let owner = 'engine-account-1'
  let current = snapshot()
  let actionCalls = 0
  let navigationAfterNull = false
  let clickNavigationUrl = null
  let editReceipt = receipt => receipt
  const requests = []
  const sendToUi = async request => {
    requests.push(request)
    if (request.kind === 'bind') return { requestId: request.requestId, status: 'bound',
      binding: { cardId: 'browser-1', cardEpoch: 'card-epoch-1', profileId: 'firefox-default',
        accountId: 'fixture-account', userContextId: 0, url: bindUrl,
        engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0 } }
    if (request.kind === 'observe') return { requestId: request.requestId, status: 'observed', snapshot: current }
    if (request.kind === 'act') {
      actionCalls++
      assert.equal(request.guard.documentId, current.documentId)
      assert.equal(request.guard.revision, current.revision)
      if (request.action.type === 'click') current = clickNavigationUrl
        ? snapshot(4, { url: new URL(clickNavigationUrl).href, documentId: 'document-2',
          readyState: 'complete', text: ['Arrived'] })
        : snapshot(current.revision + 1, { documentId: current.documentId, url: current.url, text: ['Count: 1'] })
      if (request.action.type === 'fill') current = snapshot(current.revision + 1, { documentId: current.documentId,
        url: current.url, interactiveElements: [
        { ...current.interactiveElements[0], value: request.action.text, role: 'textbox', tag: 'input' }] })
      if (request.action.type === 'navigate') current = snapshot(4, {
        url: new URL(request.action.url).href, documentId: 'document-2', readyState: 'complete',
      })
      return { requestId: request.requestId, status: 'acted',
        receipt: editReceipt({ dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true,
            documentStillCurrent: true, ...(request.action.type === 'click'
              ? { clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true } : {}) },
          after: (navigationAfterNull && request.action.type === 'navigate') ||
            (clickNavigationUrl && request.action.type === 'click') ? null : current,
          observation: { visibleTextChanged: request.action.type === 'click' } }) }
    }
    throw new Error('unexpected UI request')
  }
  const service = createBrowserToolService({ sendToUi, getOwnerKey: () => owner })
  const nativeDispatch = service.dispatch
  let callSequence = 0
  service.dispatch = (boundRun, event) => nativeDispatch(boundRun,
    { ...event, callId: event.callId || `fixture-call-${++callSequence}` })
  return { service, requests, setOwner: value => { owner = value }, setSnapshot: value => { current = value },
    setNavigationAfterNull: value => { navigationAfterNull = value },
    setClickNavigation: value => { clickNavigationUrl = value },
    setReceiptEditor: value => { editReceipt = value },
    get actionCalls() { return actionCalls }, permission }
}

test('only explicitly selected Browser sources expose tools; read-only never grants actions', async () => {
  const f = fixture('observe')
  assert.equal(f.service.specs().length, 0)
  assert.throws(() => f.service.prepare({ selectedSources: [{ ...source('observe'), selectedByUser: false }] }),
    { code: 'INVALID_BROWSER_SELECTION' })
  assert.throws(() => f.service.prepare({ selectedSources: [{ ...source('observe'), browserToolSelection: null }] }),
    { code: 'INVALID_BROWSER_SELECTION' })
  const prepared = f.service.prepare({ selectedSources: [source('observe')] })
  assert.deepEqual(f.service.specs(prepared).map(item => item.name), ['egdesk_browser_observe', 'egdesk_browser_wait_text', 'egdesk_browser_list_cards', 'egdesk_browser_screenshot'],
    'an observe grant offers only the read tools')
  await f.service.bind(run, prepared)
  const observed = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  assert.equal(observed.snapshot.coordinateSpace, 'browser-viewport-local')
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: observed.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } }), { code: 'BROWSER_INTERACTION_NOT_GRANTED' })
  assert.equal(f.actionCalls, 0)
  assert.equal(BROWSER_TOOL_SPECS.length, 16)
})

test('fresh observed target dispatches once and returns DOM post-observation, never external success', async () => {
  const f = fixture()
  const prepared = f.service.prepare({ selectedSources: [source()] })
  assert.equal(f.service.specs(prepared).length, 16)
  await f.service.bind(run, prepared)
  const observed = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const args = { cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: observed.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' } }
  const result = await f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: args })
  assert.equal(result.status, 'postcondition-observed')
  assert.equal(result.after.text[0], 'Count: 1')
  assert.equal(result.externalEffectVerified, false)
  assert.equal(f.actionCalls, 1)
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: args }),
    { code: 'BROWSER_OBSERVATION_STALE' })
  assert.equal(f.actionCalls, 1)
})

test('an acted response cannot prove a click from another Card, an undispatched action, or a missed target click', async () => {
  for (const [reason, edit] of [
    ['wrong-card-readback', receipt => ({ ...receipt, after: { ...receipt.after, cardId: 'other-browser' } })],
    ['different-document-readback', receipt => ({ ...receipt, after: { ...receipt.after, documentId: 'other-document' } })],
    ['incomplete-readback', receipt => ({ ...receipt, after: { cardId: 'browser-1', text: ['Count: 1'] } })],
    ['no-dispatch', receipt => ({ ...receipt, dispatchReceipt: { ...receipt.dispatchReceipt, eventDispatched: false } })],
    ['missing-dispatch-receipt', receipt => ({ ...receipt, dispatchReceipt: undefined })],
    ['missing-current-window-global', receipt => omitDispatchFields(receipt, 'documentStillCurrent')],
    ['missing-click-route', receipt => omitDispatchFields(receipt, 'clickInputRoute')],
    ['missing-target-click', receipt => omitDispatchFields(receipt, 'targetClickObserved')],
    ['missing-all-click-diagnostics', receipt => omitDispatchFields(receipt,
      'documentStillCurrent', 'clickInputRoute', 'targetClickObserved')],
    ['missed-target', receipt => ({ ...receipt, dispatchReceipt: { ...receipt.dispatchReceipt, targetClickObserved: false } })],
    ['stale-window-global', receipt => ({ ...receipt, dispatchReceipt: { ...receipt.dispatchReceipt, documentStillCurrent: false } })],
    ['false-click-route', receipt => ({ ...receipt, dispatchReceipt: { ...receipt.dispatchReceipt, clickInputRoute: false } })],
    ['wrong-click-route', receipt => ({ ...receipt, dispatchReceipt: { ...receipt.dispatchReceipt, clickInputRoute: 'document-window' } })],
  ]) {
    const f = fixture()
    f.setReceiptEditor(edit)
    await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
    const seen = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
    const args = { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
      ref: 'el_1', expectedTarget: seen.snapshot.interactiveElements[0],
      postcondition: { kind: 'visible-text', value: 'Count: 1' } }
    const result = await f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: args })
    assert.equal(result.status, 'postcondition-unverified', reason)
    assert.equal(result.externalEffectVerified, false, reason)
    const again = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
    await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: {
      ...args, observationId: again.observationId, expectedRevision: again.snapshot.revision,
      expectedTarget: again.snapshot.interactiveElements[0],
    } }), { code: 'BROWSER_OUTCOME_UNKNOWN' }, reason)
    assert.equal(f.actionCalls, 1, reason)
  }
})

test('duplicate native call IDs share one action receipt and cannot change payload', async () => {
  const f = fixture()
  await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
  const observed = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const args = { cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: observed.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' } }
  const event = { callId: 'native-call-1', tool: 'egdesk_browser_click', arguments: args }
  const [first, duplicate] = await Promise.all([
    f.service.dispatch(run, event), f.service.dispatch(run, event),
  ])
  assert.deepEqual(duplicate, first)
  assert.equal(f.actionCalls, 1)
  await assert.rejects(f.service.dispatch(run, { ...event,
    arguments: { ...args, postcondition: { kind: 'visible-text', value: 'Count: 2' } } }),
  { code: 'BROWSER_CALL_ID_REUSED' })
  assert.equal(f.actionCalls, 1)
})

test('UI timeout means unknown outcome even if the click later completes; neither call ID nor re-observation repeats it', async () => {
  let current = snapshot(), releaseAction, actionCalls = 0
  const service = createBrowserToolService({ timeoutMs: 1000, getOwnerKey: () => 'engine-account-1',
    sendToUi: request => {
      if (request.kind === 'bind') return { requestId: request.requestId, status: 'bound', binding: {
        cardId: 'browser-1', cardEpoch: 'card-epoch-1', profileId: 'firefox-default',
        accountId: 'fixture-account', userContextId: 0, url: 'https://example.test/local',
        engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0,
      } }
      if (request.kind === 'observe') return { requestId: request.requestId, status: 'observed', snapshot: current }
      if (request.kind === 'act') {
        actionCalls++
        return new Promise(resolve => { releaseAction = () => {
          current = snapshot(4, { text: ['Count: 1'] })
          resolve({ requestId: request.requestId, status: 'acted', receipt: {
            dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true,
              documentStillCurrent: true, clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true },
            after: current,
          } })
        } })
      }
      throw new Error('unexpected UI request')
    } })
  await service.bind(run, service.prepare({ selectedSources: [source()] }))
  const seen = await service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const event = { callId: 'timed-out-click', tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: seen.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } }
  const pending = service.dispatch(run, event)
  await assert.rejects(pending, { code: 'BROWSER_UI_TIMEOUT', message: /outcome is unknown/ })
  assert.equal(actionCalls, 1)
  assert.equal(typeof releaseAction, 'function')
  releaseAction()
  await assert.rejects(service.dispatch(run, event), { code: 'BROWSER_UI_TIMEOUT' })
  const after = await service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  assert.equal(after.snapshot.text[0], 'Count: 1', 'late readback is visible but does not prove the timed-out call')
  await assert.rejects(service.dispatch(run, { ...event, callId: 'not-an-automatic-retry', arguments: {
    ...event.arguments, observationId: after.observationId, expectedRevision: after.snapshot.revision,
    expectedTarget: after.snapshot.interactiveElements[0],
  } }), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(actionCalls, 1)
})

test('cached native call result is inaccessible after cancellation or Engine account switch', async () => {
  for (const invalidation of ['cancel', 'account']) {
    const f = fixture()
    await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
    const observed = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
    const event = { callId: 'same-native-call', tool: 'egdesk_browser_click', arguments: {
      cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 3,
      ref: 'el_1', expectedTarget: observed.snapshot.interactiveElements[0],
      postcondition: { kind: 'visible-text', value: 'Count: 1' },
    } }
    assert.equal((await f.service.dispatch(run, event)).status, 'postcondition-observed')
    if (invalidation === 'cancel') await f.service.cancelRun(run)
    else f.setOwner('engine-account-2')
    await assert.rejects(f.service.dispatch(run, event), { code: 'BROWSER_RUN_ENDED' })
    assert.equal(f.actionCalls, 1)
  }
})

test('wrong Card, target mismatch, stale revision and malformed URL never reach UI action', async () => {
  const f = fixture()
  await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'other-open-browser' } }),
    { code: 'BROWSER_CARD_NOT_SELECTED' })
  const observed = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const base = { cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: observed.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' } }
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: { ...base, expectedRevision: 2 } }),
    { code: 'BROWSER_OBSERVATION_STALE' })
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: { ...base,
    expectedTarget: { ...base.expectedTarget, label: 'Submit' } } }), { code: 'BROWSER_TARGET_STALE' })
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_navigate', arguments: {
    cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 3,
    url: 'javascript:alert(1)', postcondition: { kind: 'url', value: 'javascript:alert(1)' },
  } }), { code: 'INVALID_BROWSER_TOOL' })
  assert.equal(f.actionCalls, 0)
})

test('account change and cancellation invalidate pending or later Browser actions', async () => {
  const f = fixture()
  await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
  const observed = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  f.setOwner('engine-account-2')
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: observed.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } }), { code: 'BROWSER_RUN_ENDED' })
  assert.equal(f.actionCalls, 0)
  f.setOwner('engine-account-1')
  await f.service.cancelRun(run)
  assert.equal(f.requests.at(-1).kind, 'cancel')
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } }),
    { code: 'BROWSER_RUN_ENDED' })
})

test('cancel before the deferred UI send suppresses a fresh click but delivers the cancel tombstone', async () => {
  const requests = []
  let actionCalls = 0
  const service = createBrowserToolService({ getOwnerKey: () => 'engine-account-1', sendToUi: request => {
    requests.push(request)
    if (request.kind === 'bind') return { requestId: request.requestId, status: 'bound', binding: {
      cardId: 'browser-1', cardEpoch: 'card-epoch-1', profileId: 'firefox-default',
      accountId: 'fixture-account', userContextId: 0, url: 'https://example.test/local',
      engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0,
    } }
    if (request.kind === 'observe') return { requestId: request.requestId, status: 'observed', snapshot: snapshot() }
    if (request.kind === 'cancel') return { requestId: request.requestId, status: 'cancelled' }
    if (request.kind === 'act') {
      actionCalls++
      return { requestId: request.requestId, status: 'acted', receipt: {} }
    }
    throw new Error('unexpected UI request')
  } })
  await service.bind(run, service.prepare({ selectedSources: [source()] }))
  const seen = await service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const pendingClick = service.dispatch(run, { callId: 'cancel-before-send', tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: seen.observationId, expectedRevision: seen.snapshot.revision,
    ref: 'el_1', expectedTarget: seen.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } })
  const cancelling = service.cancelRun(run) // no await: release the queued UI sends only after this closes the run
  await assert.rejects(pendingClick, { code: 'BROWSER_RUN_ENDED' })
  await cancelling
  assert.equal(actionCalls, 0)
  assert.equal(requests.filter(request => request.kind === 'act').length, 0)
  assert.equal(requests.filter(request => request.kind === 'cancel').length, 1)
})

test('cancel after UI action handoff ends the run without claiming the click was rolled back', async () => {
  const requests = []
  let actionCalls = 0
  let releaseAction
  const service = createBrowserToolService({ getOwnerKey: () => 'engine-account-1', sendToUi: request => {
    requests.push(request)
    if (request.kind === 'bind') return { requestId: request.requestId, status: 'bound', binding: {
      cardId: 'browser-1', cardEpoch: 'card-epoch-1', profileId: 'firefox-default',
      accountId: 'fixture-account', userContextId: 0, url: 'https://example.test/local',
      engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0,
    } }
    if (request.kind === 'observe') return { requestId: request.requestId, status: 'observed', snapshot: snapshot() }
    if (request.kind === 'cancel') return { requestId: request.requestId, status: 'cancelled' }
    if (request.kind === 'act') {
      actionCalls++
      return new Promise(resolve => { releaseAction = () => resolve({ requestId: request.requestId,
        status: 'acted', receipt: {} }) })
    }
    throw new Error('unexpected UI request')
  } })
  await service.bind(run, service.prepare({ selectedSources: [source()] }))
  const seen = await service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const pendingClick = service.dispatch(run, { callId: 'cancel-after-handoff', tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: seen.observationId, expectedRevision: seen.snapshot.revision,
    ref: 'el_1', expectedTarget: seen.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } })
  await Promise.resolve() // allow the queued action to reach sendToUi before cancelling
  assert.equal(actionCalls, 1)
  await service.cancelRun(run)
  releaseAction()
  await assert.rejects(pendingClick, { code: 'BROWSER_RUN_ENDED', message: /effect is unknown/ })
  assert.equal(requests.filter(request => request.kind === 'cancel').length, 1)
  assert.equal(actionCalls, 1)
})

test('cancel during pending UI bind sends tombstone and forbids late bind, observe and rebind', async () => {
  const requests = []
  let releaseBind
  const service = createBrowserToolService({ getOwnerKey: () => 'engine-account-1', sendToUi: request => {
    requests.push(request)
    if (request.kind === 'bind') return new Promise(resolve => { releaseBind = resolve })
    return { requestId: request.requestId, status: 'cancelled' }
  } })
  const prepared = service.prepare({ selectedSources: [source()] })
  const binding = service.bind(run, prepared)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(typeof releaseBind, 'function')
  await service.cancelRun(run)
  assert(requests.some(request => request.kind === 'cancel' &&
    request.selectionToken === 'grant-browser-1'), 'cancel must tombstone the selected Card even before binding is stored')
  const original = requests.find(request => request.kind === 'bind')
  releaseBind({ requestId: original.requestId, status: 'bound', binding: {
    cardId: 'browser-1', cardEpoch: 'card-epoch-1', profileId: 'firefox-default',
    accountId: 'fixture-account', userContextId: 0, url: 'https://example.test/local',
    engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0,
  } })
  await assert.rejects(binding, { code: 'BROWSER_RUN_ENDED' })
  await assert.rejects(service.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'later-call',
    arguments: { cardId: 'browser-1' } }), { code: 'BROWSER_RUN_ENDED' })
  await assert.rejects(service.bind(run, prepared), { code: 'BROWSER_RUN_ENDED' })
  assert.equal(requests.filter(request => request.kind === 'bind').length, 1)
})

test('Engine owner switch during pending bind sends UI cancel and never stores binding', async () => {
  let owner = 'engine-account-1', releaseBind
  const requests = []
  const service = createBrowserToolService({ getOwnerKey: () => owner, sendToUi: request => {
    requests.push(request)
    if (request.kind === 'bind') return new Promise(resolve => { releaseBind = resolve })
    return { requestId: request.requestId, status: 'cancelled' }
  } })
  const prepared = service.prepare({ selectedSources: [source()] })
  const pending = service.bind(run, prepared)
  await Promise.resolve(); await Promise.resolve()
  owner = 'engine-account-2'
  releaseBind({ requestId: requests[0].requestId, status: 'bound', binding: {
    cardId: 'browser-1', cardEpoch: 'card-epoch-1', profileId: 'firefox-default',
    accountId: 'fixture-account', userContextId: 0, url: 'https://example.test/local',
    engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0,
  } })
  await assert.rejects(pending, { code: 'BROWSER_OWNER_CHANGED' })
  assert(requests.some(request => request.kind === 'cancel'))
  await assert.rejects(service.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'later-call',
    arguments: { cardId: 'browser-1' } }), { code: 'BROWSER_RUN_ENDED' })
  owner = 'engine-account-1'
  await assert.rejects(service.bind(run, prepared), { code: 'BROWSER_RUN_ENDED' })
})

test('navigate and fill return scoped receipts and force a fresh observation for each action', async () => {
  const navigating = fixture()
  await navigating.service.bind(run, navigating.service.prepare({ selectedSources: [source()] }))
  const before = await navigating.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const url = 'https://example.test/next'
  const nav = await navigating.service.dispatch(run, { tool: 'egdesk_browser_navigate', arguments: {
    cardId: 'browser-1', observationId: before.observationId, expectedRevision: 3, url,
    postcondition: { kind: 'url', value: url },
  } })
  assert.equal(nav.status, 'postcondition-observed')
  assert.equal(nav.after.documentId, 'document-2', 'a navigation may read back a new document')
  assert.equal(nav.dispatchReceipt.documentStillCurrent, true)
  assert.equal(nav.pageLoadVerified, false)
  assert.equal(nav.externalEffectVerified, false)

  const filling = fixture()
  filling.setSnapshot(snapshot(3, { interactiveElements: [{ ref: 'el_1', role: 'textbox', label: 'Note',
    href: '', value: '', tag: 'input', disabled: false, bounds: { x: 12, y: 30, width: 80, height: 30 } }] }))
  await filling.service.bind(run, filling.service.prepare({ selectedSources: [source()] }))
  const seen = await filling.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const filled = await filling.service.dispatch(run, { tool: 'egdesk_browser_fill', arguments: {
    cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: seen.snapshot.interactiveElements[0], text: 'local note',
    postcondition: { kind: 'target-value', value: 'local note' },
  } })
  assert.equal(filled.status, 'postcondition-observed')
  assert.equal(filled.after.interactiveElements[0].value, 'local note')
  assert.equal(filled.dispatchReceipt.documentStillCurrent, true)
  assert.equal(filled.dispatchReceipt.clickInputRoute, undefined, 'fill does not need click diagnostics')
})

test('fill and navigation cannot claim a postcondition without current-window diagnostics', async () => {
  for (const tool of ['egdesk_browser_fill', 'egdesk_browser_navigate']) {
    for (const diagnostic of ['missing', 'false']) {
      const f = fixture()
      if (tool === 'egdesk_browser_fill') f.setSnapshot(snapshot(3, { interactiveElements: [
        { ref: 'el_1', role: 'textbox', label: 'Note', href: '', value: '', tag: 'input', disabled: false },
      ] }))
      f.setReceiptEditor(receipt => diagnostic === 'missing'
        ? omitDispatchFields(receipt, 'documentStillCurrent')
        : { ...receipt, dispatchReceipt: { ...receipt.dispatchReceipt, documentStillCurrent: false } })
      await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
      const seen = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
      const argumentsForTool = tool === 'egdesk_browser_fill'
        ? { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
          ref: 'el_1', expectedTarget: seen.snapshot.interactiveElements[0], text: 'local note',
          postcondition: { kind: 'target-value', value: 'local note' } }
        : { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
          url: 'https://example.test/next', postcondition: { kind: 'url', value: 'https://example.test/next' } }
      const result = await f.service.dispatch(run, { tool, arguments: argumentsForTool })
      assert.equal(result.status, 'postcondition-unverified', `${tool}: ${diagnostic}`)
      assert.equal(result.externalEffectVerified, false)
      assert.equal(f.actionCalls, 1)
    }
  }
})

test('fill cannot claim a readback from another document even with a current-window flag', async () => {
  const f = fixture()
  f.setSnapshot(snapshot(3, { interactiveElements: [
    { ref: 'el_1', role: 'textbox', label: 'Note', href: '', value: '', tag: 'input', disabled: false },
  ] }))
  f.setReceiptEditor(receipt => ({ ...receipt, after: { ...receipt.after, documentId: 'other-document' } }))
  await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
  const seen = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const result = await f.service.dispatch(run, { tool: 'egdesk_browser_fill', arguments: {
    cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: seen.snapshot.interactiveElements[0], text: 'local note',
    postcondition: { kind: 'target-value', value: 'local note' },
  } })
  assert.equal(result.status, 'postcondition-unverified')
  assert.equal(result.externalEffectVerified, false)
})

test('URL postcondition compares canonical browser URLs including normalized trailing slash', async () => {
  const f = fixture()
  await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
  const before = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const result = await f.service.dispatch(run, { tool: 'egdesk_browser_navigate', arguments: {
    cardId: 'browser-1', observationId: before.observationId, expectedRevision: 3,
    url: 'https://example.test', postcondition: { kind: 'url', value: 'https://example.test' },
  } })
  assert.equal(result.status, 'postcondition-observed')
  assert.equal(result.after.url, 'https://example.test/')
  assert.equal(result.externalEffectVerified, false)
})

test('unmet postcondition permits read-only re-observation but blocks blind retry', async () => {
  const f = fixture()
  await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
  const seen = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const args = { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: seen.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'unobserved external receipt' } }
  const first = await f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: args })
  assert.equal(first.status, 'postcondition-unverified')
  const reobserved = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: {
    ...args, observationId: reobserved.observationId, expectedRevision: reobserved.snapshot.revision,
    expectedTarget: reobserved.snapshot.interactiveElements[0],
  } }), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(f.actionCalls, 1)
})

test('new-document re-observation resolves navigation uncertainty without external-effect claim', async () => {
  const f = fixture()
  f.setNavigationAfterNull(true)
  await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
  const before = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const destination = 'https://example.test/next'
  const navigation = await f.service.dispatch(run, { tool: 'egdesk_browser_navigate', arguments: {
    cardId: 'browser-1', observationId: before.observationId, expectedRevision: 3,
    url: destination, postcondition: { kind: 'url', value: destination },
  } })
  assert.equal(navigation.status, 'postcondition-unverified')
  assert.equal(navigation.pageLoadVerified, false)
  const after = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  assert.equal(after.navigationPostconditionReobserved, true)
  assert.equal(after.snapshot.documentId, 'document-2')
  assert.equal(after.snapshot.url, destination)
  assert.equal(after.externalEffectVerified, false)
  const click = await f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: after.observationId, expectedRevision: 4,
    ref: 'el_1', expectedTarget: after.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } })
  assert.equal(click.status, 'postcondition-observed', 'fresh re-observation restores a safe action path')
  assert.equal(click.externalEffectVerified, false)
})

test('click-caused full document navigation recovers from after:null on fresh canonical URL observation', async () => {
  const f = fixture()
  f.setClickNavigation('https://example.com')
  await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
  const before = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const click = await f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: before.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: before.snapshot.interactiveElements[0],
    postcondition: { kind: 'url', value: 'https://example.com' },
  } })
  assert.equal(click.status, 'postcondition-unverified')
  assert.equal(click.after, null)
  const after = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  assert.equal(after.snapshot.url, 'https://example.com/')
  assert.equal(after.documentTransitionPostconditionReobserved, true)
  assert.equal(after.navigationPostconditionReobserved, false)
  assert.equal(after.externalEffectVerified, false)
  const next = await f.service.dispatch(run, { tool: 'egdesk_browser_navigate', arguments: {
    cardId: 'browser-1', observationId: after.observationId, expectedRevision: 4,
    url: 'https://example.com/next', postcondition: { kind: 'url', value: 'https://example.com/next' },
  } })
  assert.equal(next.status, 'postcondition-observed')
  assert.equal(next.externalEffectVerified, false)
})

test('navigation to a different final URL remains interaction-uncertain after observation', async () => {
  const f = fixture()
  f.setNavigationAfterNull(true)
  await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
  const before = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  const destination = 'https://example.test/expected'
  await f.service.dispatch(run, { tool: 'egdesk_browser_navigate', arguments: {
    cardId: 'browser-1', observationId: before.observationId, expectedRevision: 3,
    url: destination, postcondition: { kind: 'url', value: destination },
  } })
  f.setSnapshot(snapshot(4, { documentId: 'document-2', readyState: 'complete',
    url: 'https://example.test/unexpected' }))
  const observed = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  assert.equal(observed.navigationPostconditionReobserved, false)
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 4,
    ref: 'el_1', expectedTarget: observed.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } }), { code: 'BROWSER_OUTCOME_UNKNOWN' })
})

// Guarded scroll / press / wait / same-site navigate (BRW-05, BRW-06).
function guardedSnapshot(overrides = {}) {
  return snapshot(3, { readyState: 'complete', scroll: { x: 0, y: 0, maxY: 2000 }, focusedElement: null,
    interactiveElements: [
      { ref: 'el_1', role: 'button', label: 'Increment', href: '', value: '', tag: 'button', disabled: false,
        bounds: { x: 12, y: 30, width: 80, height: 30 } },
      { ref: 'el_2', role: 'searchbox', label: 'Search', href: '', value: '', tag: 'input', disabled: false,
        bounds: { x: 12, y: 80, width: 160, height: 30 } },
      { ref: 'el_3', role: 'link', label: 'Footer', href: 'https://example.test/about', value: '', tag: 'a',
        disabled: false, bounds: { x: 12, y: 1400, width: 80, height: 20 } },
    ], ...overrides })
}
const actorReceipt = (extra = {}) => ({ actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true, ...extra })
const scrollReceipt = (mode = 'document', extra = {}) => actorReceipt({ inputRoute: 'dom-scroll-api', scrollMode: mode, ...extra })
const keyReceipt = (key, focusPolicy, extra = {}) => actorReceipt({ inputRoute: 'dom-keyboard-event', key,
  trustedInput: false, targetKeyObserved: true, keydownDefaultPrevented: false, defaultActionEmulated: null, focusPolicy, ...extra })
function guardedFixture({ timeoutMs, clock, actionGatePolicy, secondCard = false } = {}) {
  let current = guardedSnapshot()
  let onAct = () => { throw new Error('unexpected act') }
  let onWait = null
  let onReconcile = null
  const requests = []
  const sendToUi = async request => {
    requests.push(request)
    if (request.kind === 'bind') return { requestId: request.requestId, status: 'bound', binding: {
      cardId: request.cardId, cardEpoch: 'card-epoch-1', profileId: 'firefox-default', accountId: 'fixture-account',
      userContextId: 0, url: 'https://example.test/local', engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0 } }
    if (request.kind === 'cancel') return { requestId: request.requestId, status: 'cancelled' }
    if (request.kind === 'observe' && request.options?.wait) {
      return onWait ? onWait(request) : { requestId: request.requestId, status: 'observed',
        snapshot: { ...current, wait: { for: request.options.wait.for, outcome: 'met', elapsedMs: 5 } } }
    }
    if (request.kind === 'observe') return { requestId: request.requestId, status: 'observed', snapshot: { ...current, cardId: request.cardId } }
    if (request.kind === 'history' && secondCard) return { requestId: request.requestId, status: 'acted',
      receipt: { dispatchReceipt: { actor: 'chrome', inputRoute: 'chrome-history', historyAction: request.historyAction,
        eventDispatched: true } } }
    if (request.kind === 'act') return onAct(request)
    if (request.kind === 'reconcile' && onReconcile) return onReconcile(request)
    throw new Error('unexpected UI request')
  }
  const service = createBrowserToolService({ sendToUi, getOwnerKey: () => 'engine-account-1',
    ...(timeoutMs ? { timeoutMs } : {}), ...(clock ? { clock } : {}), ...(actionGatePolicy ? { actionGatePolicy } : {}) })
  let sequence = 0
  const dispatch = (tool, args, callId = `guarded-call-${++sequence}`) => service.dispatch(run, { tool, callId, arguments: args })
  const observe = (cardId = 'browser-1') => dispatch('egdesk_browser_observe', { cardId })
  const acted = (request, after, dispatchReceipt) => ({ requestId: request.requestId, status: 'acted',
    receipt: { dispatchReceipt, after, observation: { visibleTextChanged: false } } })
  return { service, requests, dispatch, observe, acted,
    acts: () => requests.filter(request => request.kind === 'act'),
    waits: () => requests.filter(request => request.kind === 'observe' && request.options?.wait),
    get current() { return current }, set current(value) { current = value },
    setAct(fn) { onAct = fn }, setWait(fn) { onWait = fn }, setReconcile(fn) { onReconcile = fn },
    reconciles: () => requests.filter(request => request.kind === 'reconcile'),
    bind: () => service.bind(run, service.prepare({ selectedSources: secondCard ? [source(), source('interact', 'browser-2')] : [source()] })) }
}
const targetOf = (seen, ref) => seen.snapshot.interactiveElements.find(item => item.ref === ref)

test('guarded scroll sends one document-scoped request and returns the observed scrollY change', async () => {
  const f = guardedFixture()
  await f.bind()
  const seen = await f.observe()
  f.setAct(request => {
    f.current = guardedSnapshot({ scroll: { x: 0, y: 432, maxY: 2000 } })
    return f.acted(request, f.current, scrollReceipt('document'))
  })
  const args = { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3, direction: 'down' }
  const result = await f.dispatch('egdesk_browser_scroll', args)
  assert.equal(result.status, 'postcondition-observed')
  assert.deepEqual(result.scroll, { before: { x: 0, y: 0, maxY: 2000 }, after: { x: 0, y: 432, maxY: 2000 } })
  assert.deepEqual(result.postcondition, { kind: 'scroll-position', direction: 'down', amount: 'page', matched: true })
  assert.equal(result.dispatchReceipt.inputRoute, 'dom-scroll-api')
  assert.equal(result.externalEffectVerified, false)
  const [request] = f.acts()
  assert.deepEqual(request.action, { type: 'scroll', direction: 'down', amount: 'page' })
  assert.deepEqual(request.guard.scroll, { x: 0, y: 0, maxY: 2000 })
  assert.equal(request.guard.documentId, 'document-1')
  assert.equal(request.guard.revision, 3)
  assert.equal(request.guard.target, undefined)
  assert.equal(request.postcondition, undefined)
  await assert.rejects(f.dispatch('egdesk_browser_scroll', args), { code: 'BROWSER_OBSERVATION_STALE' })
  assert.equal(f.acts().length, 1)

  f.current = guardedSnapshot({ scroll: { x: 0, y: 2000, maxY: 2000 } })
  const bottom = await f.observe()
  f.setAct(request => f.acted(request, f.current, scrollReceipt('document')))
  const limited = await f.dispatch('egdesk_browser_scroll', { ...args, observationId: bottom.observationId, amount: 'half' })
  assert.equal(limited.status, 'scroll-at-limit', 'no movement at the end is a known state, not a success')
  assert.equal(limited.postcondition.matched, false)
})

test('scroll without an actor route stays unverified but only requires re-observation', async () => {
  const f = guardedFixture()
  await f.bind()
  const seen = await f.observe()
  f.setAct(request => {
    f.current = guardedSnapshot({ scroll: { x: 0, y: 432, maxY: 2000 } })
    return f.acted(request, f.current, actorReceipt())
  })
  const result = await f.dispatch('egdesk_browser_scroll', { cardId: 'browser-1', observationId: seen.observationId,
    expectedRevision: 3, direction: 'down' })
  assert.equal(result.status, 'postcondition-unverified', 'a moved viewport without the reported route is not confirmed')
  assert.equal(result.scroll.after, null)
  const again = await f.observe()
  f.setAct(request => f.acted(request, guardedSnapshot({ text: ['Count: 1'] }),
    actorReceipt({ clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true })))
  const click = await f.dispatch('egdesk_browser_click', { cardId: 'browser-1', observationId: again.observationId,
    expectedRevision: 3, ref: 'el_1', expectedTarget: targetOf(again, 'el_1'),
    postcondition: { kind: 'visible-text', value: 'Count: 1' } })
  assert.equal(click.status, 'postcondition-observed', 'scroll uncertainty does not lock the Card like an effectful action')
})

test('scroll into view requires the exact observed element and rejects malformed or stale requests before UI', async () => {
  const f = guardedFixture()
  await f.bind()
  const seen = await f.observe()
  const base = { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3 }
  for (const [args, code] of [
    // ref + direction means "scroll inside this container": a link is not one.
    [{ ...base, ref: 'el_3', expectedTarget: targetOf(seen, 'el_3'), direction: 'down' }, 'BROWSER_TARGET_STALE'],
    [{ ...base, ref: 'el_3', expectedTarget: targetOf(seen, 'el_3'), direction: 'sideways' }, 'INVALID_BROWSER_TOOL'],
    [{ ...base, direction: 'sideways' }, 'INVALID_BROWSER_TOOL'],
    [{ ...base, ref: 'el_3', expectedTarget: targetOf(seen, 'el_3'), amount: 'page' }, 'INVALID_BROWSER_TOOL'],
    [{ ...base, ref: 'el_3', expectedTarget: { ...targetOf(seen, 'el_3'), label: 'Changed' } }, 'BROWSER_TARGET_STALE'],
    [{ ...base, expectedRevision: 2, direction: 'down' }, 'BROWSER_OBSERVATION_STALE'],
  ]) await assert.rejects(f.dispatch('egdesk_browser_scroll', args), { code })
  assert.equal(f.acts().length, 0)
  f.setAct(request => {
    f.current = guardedSnapshot({ scroll: { x: 0, y: 1200, maxY: 2000 }, interactiveElements: [
      { ...targetOf(seen, 'el_3'), bounds: { x: 12, y: 200, width: 80, height: 20 } }] })
    return f.acted(request, f.current, scrollReceipt('into-view', { targetInView: true }))
  })
  const result = await f.dispatch('egdesk_browser_scroll', { ...base, ref: 'el_3', expectedTarget: targetOf(seen, 'el_3') })
  assert.equal(result.status, 'postcondition-observed')
  assert.deepEqual(result.postcondition, { kind: 'target-in-view', matched: true, wasAlreadyTrue: false })
  assert.deepEqual(f.acts()[0].action, { type: 'scroll', ref: 'el_3' })
  assert.equal(f.acts()[0].guard.target.ref, 'el_3')

  f.current = guardedSnapshot({ scroll: undefined })
  const unscrollable = await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_scroll', { cardId: 'browser-1', observationId: unscrollable.observationId,
    expectedRevision: 3, direction: 'down' }), { code: 'BROWSER_OBSERVATION_STALE' })
  assert.equal(f.acts().length, 1)
})

test('press reaches only the focused element or the field just filled and never asks to move focus', async () => {
  const f = guardedFixture()
  await f.bind()
  const unfocused = await f.observe()
  const pressArgs = (seen, key, extra = {}) => ({ cardId: 'browser-1', observationId: seen.observationId,
    expectedRevision: seen.snapshot.revision, ref: 'el_2', expectedTarget: targetOf(seen, 'el_2'), key, ...extra })
  await assert.rejects(f.dispatch('egdesk_browser_press', pressArgs(unfocused, 'Escape')), { code: 'BROWSER_PRESS_TARGET_NOT_FOCUSED' })
  await assert.rejects(f.dispatch('egdesk_browser_press', pressArgs(unfocused, 'Enter')), { code: 'INVALID_BROWSER_TOOL' },
    'Enter can submit, so it needs a testable postcondition')
  await assert.rejects(f.dispatch('egdesk_browser_press', pressArgs(unfocused, 'F5')), { code: 'INVALID_BROWSER_TOOL' })
  assert.equal(f.acts().length, 0)

  f.current = guardedSnapshot({ focusedElement: { ref: 'el_2', role: 'searchbox', label: 'Search', value: '' } })
  const focused = await f.observe()
  f.setAct(request => f.acted(request, f.current, keyReceipt('Escape', 'already-focused')))
  const escape = await f.dispatch('egdesk_browser_press', pressArgs(focused, 'Escape'))
  assert.equal(escape.status, 'key-dispatched', 'a key without a postcondition reports dispatch, never an effect')
  assert.equal(escape.postcondition, null)
  assert.equal(f.acts()[0].guard.pressPolicy, 'already-focused')
  assert.deepEqual(f.acts()[0].action, { type: 'press', ref: 'el_2', key: 'Escape' })

  f.current = guardedSnapshot()
  const beforeFill = await f.observe()
  f.setAct(request => {
    f.current = guardedSnapshot({ revision: 4, interactiveElements: [targetOf(beforeFill, 'el_1'),
      { ...targetOf(beforeFill, 'el_2'), value: 'seoul' }, targetOf(beforeFill, 'el_3')] })
    return f.acted(request, f.current, actorReceipt())
  })
  const filled = await f.dispatch('egdesk_browser_fill', { cardId: 'browser-1', observationId: beforeFill.observationId,
    expectedRevision: 3, ref: 'el_2', expectedTarget: targetOf(beforeFill, 'el_2'), text: 'seoul',
    postcondition: { kind: 'target-value', value: 'seoul' } })
  assert.equal(filled.status, 'postcondition-observed')
  const afterFill = await f.observe()
  f.setAct(request => {
    f.current = guardedSnapshot({ revision: 5, text: ['Results for seoul'] })
    return f.acted(request, f.current, keyReceipt('Enter', 'after-fill', { defaultActionEmulated: 'form-request-submit' }))
  })
  const submitted = await f.dispatch('egdesk_browser_press', pressArgs(afterFill, 'Enter', {
    postcondition: { kind: 'visible-text', value: 'Results for seoul' } }))
  assert.equal(submitted.status, 'postcondition-observed')
  assert.equal(submitted.dispatchReceipt.defaultActionEmulated, 'form-request-submit')
  assert.equal(submitted.dispatchReceipt.trustedInput, false)
  assert.equal(f.acts().at(-1).guard.pressPolicy, 'after-fill')
  assert.equal(f.acts().at(-1).guard.focusedRef, null)

  const next = await f.observe()
  f.setAct(request => f.acted(request, guardedSnapshot({ revision: 5, text: ['Count: 1'] }),
    actorReceipt({ clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true })))
  await f.dispatch('egdesk_browser_click', { cardId: 'browser-1', observationId: next.observationId,
    expectedRevision: 5, ref: 'el_1', expectedTarget: targetOf(next, 'el_1'),
    postcondition: { kind: 'visible-text', value: 'Count: 1' } })
  const afterClick = await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_press', pressArgs(afterClick, 'ArrowDown')),
    { code: 'BROWSER_PRESS_TARGET_NOT_FOCUSED' }, 'any other action ends the just-filled key eligibility')
  assert.equal(f.acts().length, 4)
})

test('press with an untrusted-route claim mismatch is unknown and blocks the next blind action', async () => {
  const f = guardedFixture()
  await f.bind()
  f.current = guardedSnapshot({ focusedElement: { ref: 'el_2', role: 'searchbox', label: 'Search', value: '' } })
  const seen = await f.observe()
  f.setAct(request => f.acted(request, f.current, keyReceipt('ArrowDown', 'already-focused', { trustedInput: true })))
  const result = await f.dispatch('egdesk_browser_press', { cardId: 'browser-1', observationId: seen.observationId,
    expectedRevision: 3, ref: 'el_2', expectedTarget: targetOf(seen, 'el_2'), key: 'ArrowDown' })
  assert.equal(result.status, 'postcondition-unverified')
  const again = await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_press', { cardId: 'browser-1', observationId: again.observationId,
    expectedRevision: 3, ref: 'el_2', expectedTarget: targetOf(again, 'el_2'), key: 'ArrowDown' }), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(f.acts().length, 1)
})

test('navigate is limited to http(s) on the current document site and spends the prior observation', async () => {
  const f = guardedFixture()
  await f.bind()
  const seen = await f.observe()
  const navigate = (observed, url) => f.dispatch('egdesk_browser_navigate', { cardId: 'browser-1',
    observationId: observed.observationId, expectedRevision: observed.snapshot.revision, url,
    postcondition: { kind: 'url', value: url } })
  for (const url of ['https://evil.test/', 'http://example.test/downgrade', 'https://example.test.evil.test/']) {
    await assert.rejects(navigate(seen, url), { code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' }, url)
  }
  assert.equal(f.acts().length, 0)
  f.setAct(request => {
    f.current = guardedSnapshot({ documentId: 'document-2', revision: 1, url: request.action.url })
    return f.acted(request, f.current, actorReceipt())
  })
  const moved = await navigate(seen, 'https://www.example.test/next')
  assert.equal(moved.status, 'postcondition-observed')
  assert.equal(moved.navigationScope, 'same-site')
  assert.equal(moved.pageLoadVerified, false)
  assert.equal(f.acts()[0].guard.navigationScope, 'same-site')
  await assert.rejects(navigate(seen, 'https://example.test/again'), { code: 'BROWSER_OBSERVATION_STALE' },
    'the pre-navigation observation is stale')
  assert.equal(f.acts().length, 1)
})

test('same-site navigation helper is conservative for suffixes, IP origins and downgrades', async () => {
  const { sameSiteNavigation } = await import('./egdesk-browser-tool-runtime.mjs')
  for (const [from, to, expected] of [
    ['https://a.example.co.kr/x', 'https://b.example.co.kr/y', true],
    ['https://alpha.co.kr/', 'https://beta.co.kr/', false],
    ['https://alice.github.io/', 'https://bob.github.io/', false],
    ['http://example.test/a', 'https://www.example.test/b', true],
    ['https://example.test/a', 'http://example.test/b', false],
    ['http://127.0.0.1:18181/a', 'http://127.0.0.1:18181/b', true],
    ['http://127.0.0.1:18181/a', 'http://127.0.0.1:18182/a', false],
    ['http://localhost:3000/', 'http://localhost:3000/next', true],
    ['https://example.test/', 'javascript:alert(1)', false],
    ['about:blank', 'https://example.test/', false],
  ]) assert.equal(sameSiteNavigation(from, to), expected, `${from} -> ${to}`)
})

test('wait reports met, not met before timeout, or unknown and never sends an action', async () => {
  const f = guardedFixture()
  await f.bind()
  const seen = await f.observe()
  const loaded = await f.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'load', timeoutMs: 3000 })
  assert.equal(loaded.status, 'wait-condition-met')
  assert.equal(loaded.wait.outcome, 'met')
  assert.equal(loaded.snapshot.wait, undefined, 'the actor wait report is not stored as page content')
  assert.deepEqual(f.waits()[0].options.wait, { for: 'load', timeoutMs: 3000 })
  await assert.rejects(f.dispatch('egdesk_browser_click', { cardId: 'browser-1', observationId: seen.observationId,
    expectedRevision: 3, ref: 'el_1', expectedTarget: targetOf(seen, 'el_1'),
    postcondition: { kind: 'visible-text', value: 'Count: 1' } }), { code: 'BROWSER_OBSERVATION_STALE' })

  f.setWait(request => ({ requestId: request.requestId, status: 'observed',
    snapshot: { ...f.current, wait: { for: 'idle', outcome: 'timeout', elapsedMs: 1000 } } }))
  const busy = await f.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'idle', timeoutMs: 1000 })
  assert.equal(busy.status, 'wait-timeout')
  assert.equal(busy.wait.outcome, 'not-met-before-timeout')
  f.setWait(request => ({ requestId: request.requestId, status: 'observed',
    snapshot: { ...f.current, readyState: 'loading', wait: { for: 'load', outcome: 'met', elapsedMs: 3 } } }))
  assert.equal((await f.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'load', timeoutMs: 1000 })).status,
    'wait-condition-unverified', 'the helper re-checks what the returned observation proves')
  for (const response of [
    request => ({ requestId: request.requestId, status: 'rejected', error: 'Browser document changed during wait' }),
    request => ({ requestId: request.requestId, status: 'observed', snapshot: f.current }),
  ]) {
    f.setWait(response)
    await assert.rejects(f.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'load', timeoutMs: 1000 }),
      { code: 'BROWSER_WAIT_OUTCOME_UNKNOWN' })
  }
  f.setWait(null)
  const fresh = await f.observe()
  for (const [args, code] of [
    [{ cardId: 'browser-1', for: 'load', timeoutMs: 10001 }, 'INVALID_BROWSER_TOOL'],
    [{ cardId: 'browser-1', for: 'load', timeoutMs: 99 }, 'INVALID_BROWSER_TOOL'],
    [{ cardId: 'browser-1', for: 'load', timeoutMs: 1000, ref: 'el_1' }, 'INVALID_BROWSER_TOOL'],
    [{ cardId: 'browser-1', for: 'selector-visible', timeoutMs: 1000, ref: 'el_1' }, 'INVALID_BROWSER_TOOL'],
    [{ cardId: 'browser-1', for: 'selector-visible', timeoutMs: 1000, ref: 'el_9', observationId: fresh.observationId }, 'BROWSER_TARGET_STALE'],
    [{ cardId: 'browser-1', for: 'selector-visible', timeoutMs: 1000, ref: 'el_1', observationId: 'old' }, 'BROWSER_OBSERVATION_STALE'],
  ]) await assert.rejects(f.dispatch('egdesk_browser_wait', args), { code })
  const visible = await f.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'selector-visible',
    timeoutMs: 1000, ref: 'el_1', observationId: fresh.observationId })
  assert.equal(visible.status, 'wait-condition-met')
  assert.deepEqual(f.waits().at(-1).options.wait, { for: 'selector-visible', timeoutMs: 1000, ref: 'el_1', documentId: 'document-1' })
  assert.equal(f.acts().length, 0)
})

test('wait after an unconfirmed navigation waits for the replacement document and can resolve it', async () => {
  const f = guardedFixture()
  f.current = guardedSnapshot({ innerWindowId: 41 })
  await f.bind()
  const seen = await f.observe()
  const destination = 'https://example.test/next'
  f.setAct(request => ({ requestId: request.requestId, status: 'rejected', error: 'actor destroyed during navigation' }))
  await assert.rejects(f.dispatch('egdesk_browser_navigate', { cardId: 'browser-1', observationId: seen.observationId,
    expectedRevision: 3, url: destination, postcondition: { kind: 'url', value: destination } }), { code: 'BROWSER_ACTION_UNVERIFIED' })
  f.current = guardedSnapshot({ documentId: 'document-2', revision: 1, url: destination })
  const loaded = await f.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'load', timeoutMs: 5000 })
  assert.equal(f.waits()[0].options.wait.notDocumentId, 'document-1')
  assert.equal(f.waits()[0].options.wait.notInnerWindowId, 41)
  assert.equal(loaded.status, 'wait-condition-met')
  assert.equal(loaded.wait.documentReplaced, true)
  assert.equal(loaded.navigationPostconditionReobserved, true)
  f.setAct(request => f.acted(request, guardedSnapshot({ documentId: 'document-2', revision: 1, url: destination,
    text: ['Count: 1'] }), actorReceipt({ clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true })))
  const click = await f.dispatch('egdesk_browser_click', { cardId: 'browser-1', observationId: loaded.observationId,
    expectedRevision: 1, ref: 'el_1', expectedTarget: targetOf(loaded, 'el_1'),
    postcondition: { kind: 'visible-text', value: 'Count: 1' } })
  assert.equal(click.status, 'postcondition-observed')
})

test('wait must fit inside the bounded UI response deadline', async () => {
  const f = guardedFixture({ timeoutMs: 5000 })
  await f.bind()
  await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'load', timeoutMs: 3500 }),
    { code: 'INVALID_BROWSER_TOOL' })
  assert.equal(f.waits().length, 0)
  assert.equal((await f.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'load', timeoutMs: 3000 })).status,
    'wait-condition-met')
})

test('after Stop new scroll, press, wait and navigate requests reach the UI zero times', async () => {
  const f = guardedFixture()
  await f.bind()
  f.current = guardedSnapshot({ focusedElement: { ref: 'el_2', role: 'searchbox', label: 'Search', value: '' } })
  const seen = await f.observe()
  f.setAct(request => f.acted(request, f.current, scrollReceipt('document')))
  const pendingScroll = f.dispatch('egdesk_browser_scroll', { cardId: 'browser-1', observationId: seen.observationId,
    expectedRevision: 3, direction: 'down' })
  const cancelling = f.service.cancelRun(run) // before the deferred UI send runs
  await assert.rejects(pendingScroll, { code: 'BROWSER_RUN_ENDED' })
  await cancelling
  const sentBefore = f.requests.length
  for (const [tool, args] of [
    ['egdesk_browser_scroll', { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3, direction: 'up' }],
    ['egdesk_browser_press', { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
      ref: 'el_2', expectedTarget: targetOf(seen, 'el_2'), key: 'Escape' }],
    ['egdesk_browser_wait', { cardId: 'browser-1', for: 'load', timeoutMs: 1000 }],
    ['egdesk_browser_navigate', { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
      url: 'https://example.test/next', postcondition: { kind: 'url', value: 'https://example.test/next' } }],
  ]) await assert.rejects(f.dispatch(tool, args), { code: 'BROWSER_RUN_ENDED' }, tool)
  assert.equal(f.requests.length, sentBefore)
  assert.equal(f.acts().length, 0)
  assert.equal(f.waits().length, 0)
  assert.equal(f.requests.filter(request => request.kind === 'cancel').length, 1)
})

test('UI timeouts leave press, scroll and wait outcomes unknown without automatic retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = guardedFixture()
  await f.bind()
  f.current = guardedSnapshot({ focusedElement: { ref: 'el_2', role: 'searchbox', label: 'Search', value: '' } })
  f.setAct(() => new Promise(() => {}))
  f.setWait(() => new Promise(() => {}))
  const seen = await f.observe()
  const press = { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
    ref: 'el_2', expectedTarget: targetOf(seen, 'el_2'), key: 'Enter', postcondition: { kind: 'visible-text', value: 'Results' } }
  const pressing = f.dispatch('egdesk_browser_press', press, 'timed-out-press')
  t.mock.timers.tick(15000)
  await assert.rejects(pressing, { code: 'BROWSER_UI_TIMEOUT', message: /outcome is unknown/ })
  await assert.rejects(f.dispatch('egdesk_browser_press', press, 'timed-out-press'), { code: 'BROWSER_UI_TIMEOUT' })
  assert.equal(f.acts().length, 1, 'the same call ID shares the unknown receipt instead of re-sending')
  const again = await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_press', { ...press, observationId: again.observationId }),
    { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(f.acts().length, 1)

  const s = guardedFixture()
  await s.bind()
  s.setAct(() => new Promise(() => {}))
  const before = await s.observe()
  const scrolling = s.dispatch('egdesk_browser_scroll', { cardId: 'browser-1', observationId: before.observationId,
    expectedRevision: 3, direction: 'down' })
  t.mock.timers.tick(15000)
  await assert.rejects(scrolling, { code: 'BROWSER_UI_TIMEOUT' })
  assert.equal(s.acts().length, 1)
  await assert.rejects(s.dispatch('egdesk_browser_scroll', { cardId: 'browser-1', observationId: before.observationId,
    expectedRevision: 3, direction: 'down' }), { code: 'BROWSER_OBSERVATION_STALE' })
  assert.equal(s.acts().length, 1, 'no automatic re-scroll; a new request needs a fresh observation')

  const w = guardedFixture()
  await w.bind()
  w.setWait(() => new Promise(() => {}))
  const old = await w.observe()
  const waiting = w.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'load', timeoutMs: 3000 })
  t.mock.timers.tick(15000)
  await assert.rejects(waiting, { code: 'BROWSER_UI_TIMEOUT' })
  await assert.rejects(w.dispatch('egdesk_browser_click', { cardId: 'browser-1', observationId: old.observationId,
    expectedRevision: 3, ref: 'el_1', expectedTarget: targetOf(old, 'el_1'),
    postcondition: { kind: 'visible-text', value: 'Count: 1' } }), { code: 'BROWSER_OBSERVATION_STALE' })
  assert.equal(w.acts().length, 0)
})

// BRW-08: frame refs, editors and long values through the B service.
const editorItem = (value = boundedFieldValue('', { editor: true })) => ({ ref: 'f2/el_7', role: 'textbox',
  label: 'Message body', href: '', value, tag: 'div', disabled: false, bounds: { x: 210, y: 140, width: 300, height: 120 } })
const draftItem = (value = '') => ({ ref: 'el_2', role: 'textbox', label: 'Draft', href: '', value, tag: 'textarea',
  disabled: false, bounds: { x: 12, y: 80, width: 300, height: 90 } })
function fillFixture(readback) {
  const f = guardedFixture()
  f.current = guardedSnapshot({ interactiveElements: [editorItem(), draftItem()] })
  f.setAct(request => {
    const value = readback(request.action.text)
    f.current = { ...f.current, interactiveElements: f.current.interactiveElements.map(item =>
      item.ref === request.action.ref ? { ...item, value: item.tag === 'div'
        ? boundedFieldValue(value, { editor: true }) : boundedFieldValue(value) } : item) }
    return f.acted(request, f.current, actorReceipt())
  })
  return f
}
const fillArgs = (seen, ref, text, value = text) => ({ cardId: 'browser-1', observationId: seen.observationId,
  expectedRevision: 3, ref, expectedTarget: targetOf(seen, ref), text, postcondition: { kind: 'target-value', value } })

test('fill advertises editors, frame refs and the 8000-character bound without changing its schema', () => {
  const fill = BROWSER_TOOL_SPECS.find(item => item.name === 'egdesk_browser_fill')
  const observe = BROWSER_TOOL_SPECS.find(item => item.name === 'egdesk_browser_observe')
  assert.match(fill.description, /contenteditable editor/)
  assert.match(fill.description, /up to 8000 characters/)
  assert.match(fill.description, /without moving focus/)
  assert.match(observe.description, /same-origin frames/)
  assert.match(observe.description, /inaccessibleFrames/)
  assert.deepEqual(fill.inputSchema.required, ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'text', 'postcondition'])
  assert.deepEqual(Object.keys(fill.inputSchema.properties), ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'text', 'postcondition'])
})

test('long and editor fills are confirmed only by the bounded readback of the full value', async () => {
  const long = 'Quarterly note. '.repeat(300).slice(0, 4000)
  const f = fillFixture(text => text)
  await f.bind()
  let seen = await f.observe()
  const filled = await f.dispatch('egdesk_browser_fill', fillArgs(seen, 'el_2', long))
  assert.equal(filled.status, 'postcondition-observed')
  assert.deepEqual(filled.postcondition, { kind: 'target-value', value: long, matched: true, wasAlreadyTrue: false })
  assert.equal(f.acts()[0].action.text, long)
  assert.equal(filled.externalEffectVerified, false)

  seen = await f.observe()
  const text = '안녕하세요\nSecond line'
  const edited = await f.dispatch('egdesk_browser_fill', fillArgs(seen, 'f2/el_7', text))
  assert.equal(edited.status, 'postcondition-observed')
  assert.equal(f.acts()[1].action.ref, 'f2/el_7', 'a frame ref reaches the actor unchanged')
  assert.equal(f.acts()[1].guard.target.ref, 'f2/el_7')

  seen = await f.observe()
  const repeated = await f.dispatch('egdesk_browser_fill', fillArgs(seen, 'el_2', long))
  assert.equal(repeated.status, 'postcondition-unverified', 'a value that was already there proves nothing')
  assert.equal(repeated.postcondition.wasAlreadyTrue, true)
})

test('an editor that restructures or drops the text leaves the fill unverified and blocks a blind retry', async () => {
  const f = fillFixture(text => text.replace(/\n/g, ''))
  await f.bind()
  const seen = await f.observe()
  const text = 'Hello team\nSee attached'
  const result = await f.dispatch('egdesk_browser_fill', fillArgs(seen, 'f2/el_7', text))
  assert.equal(result.status, 'postcondition-unverified')
  assert.equal(result.postcondition.matched, false)
  const again = await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_fill', fillArgs(again, 'f2/el_7', text)), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(f.acts().length, 1)
})

test('fill text and its postcondition stay bounded before any UI request', async () => {
  const f = fillFixture(text => text)
  await f.bind()
  const seen = await f.observe()
  for (const [text, value] of [['x'.repeat(8001), 'x'], ['x', 'x'.repeat(8001)],
    ['\u0001'.repeat(8000), '\u0001'.repeat(8000)]]) {
    await assert.rejects(f.dispatch('egdesk_browser_fill', fillArgs(seen, 'el_2', text, value)), { code: 'INVALID_BROWSER_TOOL' })
  }
  await assert.rejects(f.dispatch('egdesk_browser_click', { cardId: 'browser-1', observationId: seen.observationId,
    expectedRevision: 3, ref: 'el_2', expectedTarget: targetOf(seen, 'el_2'),
    postcondition: { kind: 'target-value', value: 'x'.repeat(513) } }), { code: 'INVALID_BROWSER_TOOL' },
    'other tools keep their 512-character postcondition bound')
  assert.equal(f.acts().length, 0)
  const longest = '가'.repeat(8000)
  assert.equal((await f.dispatch('egdesk_browser_fill', fillArgs(seen, 'el_2', longest))).status, 'postcondition-observed')
})

test('a frame-ref fill after Stop reaches the UI zero times, and a timed-out long fill stays unknown', async t => {
  const stopped = fillFixture(text => text)
  await stopped.bind()
  const seen = await stopped.observe()
  await stopped.service.cancelRun(run)
  await assert.rejects(stopped.dispatch('egdesk_browser_fill', fillArgs(seen, 'f2/el_7', 'after stop')), { code: 'BROWSER_RUN_ENDED' })
  assert.equal(stopped.acts().length, 0)

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fillFixture(text => text)
  await f.bind()
  f.setAct(() => new Promise(() => {}))
  const before = await f.observe()
  const long = 'Draft paragraph. '.repeat(400).slice(0, 6000)
  const pending = f.dispatch('egdesk_browser_fill', fillArgs(before, 'el_2', long), 'timed-out-fill')
  t.mock.timers.tick(15000)
  await assert.rejects(pending, { code: 'BROWSER_UI_TIMEOUT', message: /outcome is unknown/ })
  await assert.rejects(f.dispatch('egdesk_browser_fill', fillArgs(before, 'el_2', long), 'timed-out-fill'), { code: 'BROWSER_UI_TIMEOUT' })
  const again = await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_fill', fillArgs(again, 'el_2', long)), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(f.acts().length, 1, 'no automatic retry of an unknown fill')
})

// EGQ8 / REA 웹8(a), 웹10, 웹4: dispatchPhase, same-clock receipts, Gecko document identities.
const notSent = (request, extra = {}) => ({ requestId: request.requestId, status: 'rejected',
  error: 'Browser action authority was revoked before input [ui-denied]', dispatchPhase: 'not-dispatched', ...extra })
const clickArgs = seen => ({ cardId: 'browser-1', observationId: seen.observationId, expectedRevision: seen.snapshot.revision,
  ref: 'el_1', expectedTarget: targetOf(seen, 'el_1'), postcondition: { kind: 'visible-text', value: 'Count: 1' } })
const clicked = (f, request, extra = {}) => ({ ...f.acted(request, guardedSnapshot({ text: ['Count: 1'] }),
  actorReceipt({ clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true })), ...extra })
const flushHandoff = () => new Promise(resolve => setImmediate(resolve))

test('a refusal proven not-dispatched spends only the observation: no lock, no resend, a fresh observation may act', async () => {
  for (const timing of [undefined, { receivedAtMs: 10.5, authorizedAtMs: 11, performCallsBefore: 4, performCallsAfter: 4,
    performEnterMs: null, performExitMs: null, firstEventAtMs: null }]) {
    const f = guardedFixture()
    await f.bind()
    const seen = await f.observe()
    f.setAct(request => notSent(request, timing ? { timing } : {}))
    const refused = await f.dispatch('egdesk_browser_click', clickArgs(seen), 'not-sent-click').catch(error => error)
    assert.equal(refused.code, 'BROWSER_OBSERVATION_STALE')
    assert.equal(refused.dispatchPhase, 'not-dispatched')
    const publicError = classifyPublicToolError(refused, { browser: true })
    assert.equal(publicError.code, 'BROWSER_OBSERVATION_STALE', 'the model is told to observe again')
    assert.match(publicError.message, /rejected/)
    assert.doesNotMatch(publicError.message, /unknown/)
    assert.equal(await f.dispatch('egdesk_browser_click', clickArgs(seen), 'not-sent-click').catch(error => error), refused,
      'the same call ID returns the same refusal')
    await assert.rejects(f.dispatch('egdesk_browser_click', clickArgs(seen)), { code: 'BROWSER_OBSERVATION_STALE' },
      'the refused observation stays spent')
    assert.equal(f.acts().length, 1, 'no automatic resend under either call ID')
    const again = await f.observe()
    assert.equal(again.uncertainAction, undefined, 'the Card is not locked')
    f.setAct(request => clicked(f, request))
    assert.equal((await f.dispatch('egdesk_browser_click', clickArgs(again))).status, 'postcondition-observed')
    assert.equal(f.acts().length, 2)
  }
})

test('dispatched, unknown, missing, malformed or contradicted phases keep the Card locked', async () => {
  for (const [reason, response, phase] of [
    ['dispatched', request => notSent(request, { dispatchPhase: 'dispatched' }), 'dispatched'],
    ['unknown', request => notSent(request, { dispatchPhase: 'unknown' }), 'unknown'],
    ['missing (older surface)', request => ({ requestId: request.requestId, status: 'rejected', error: 'Browser action failed' }), 'unknown'],
    ['wrong case', request => notSent(request, { dispatchPhase: 'Not-Dispatched' }), 'unknown'],
    ['boolean', request => notSent(request, { dispatchPhase: true }), 'unknown'],
    ['object', request => notSent(request, { dispatchPhase: { phase: 'not-dispatched' } }), 'unknown'],
    ['not a rejection', request => notSent(request, { status: 'failed' }), 'unknown'],
    ['acted without receipt', request => notSent(request, { status: 'acted' }), 'unknown'],
    ['perform count moved', request => notSent(request, { timing: { performCallsBefore: 4, performCallsAfter: 5 } }), 'unknown'],
    ['partial perform count', request => notSent(request, { timing: { performCallsBefore: 4 } }), 'unknown'],
    ['malformed perform count', request => notSent(request, { timing: { performCallsBefore: '4', performCallsAfter: '4' } }), 'unknown'],
    ['perform entered', request => notSent(request, { timing: { performEnterMs: 1234.5 } }), 'unknown'],
    ['malformed perform entry', request => notSent(request, { timing: { performEnterMs: 'soon' } }), 'unknown'],
    ['first event seen', request => notSent(request, { timing: { firstEventAtMs: 1235 } }), 'unknown'],
    ['timing not an object', request => notSent(request, { timing: 'late' }), 'unknown'],
    ['dispatch receipt claims an event', request => notSent(request, { receipt: { dispatchReceipt: { eventDispatched: true } } }), 'unknown'],
  ]) {
    const f = guardedFixture()
    await f.bind()
    const seen = await f.observe()
    f.setAct(response)
    const error = await f.dispatch('egdesk_browser_click', clickArgs(seen)).catch(caught => caught)
    assert.equal(error.code, 'BROWSER_ACTION_UNVERIFIED', reason)
    assert.equal(error.dispatchPhase, phase, `${reason}: the error carries the helper's conclusion, not the UI claim`)
    const again = await f.observe()
    assert.equal(again.uncertainAction?.action, 'click', reason)
    await assert.rejects(f.dispatch('egdesk_browser_click', clickArgs(again)), { code: 'BROWSER_OUTCOME_UNKNOWN' }, reason)
    assert.equal(f.acts().length, 1, reason)
  }
})

test('every UI request carries a run-scoped rising seq and same-clock sentAtMs; receipts keep only well-formed UI timing', async () => {
  let time = 1000
  const f = guardedFixture({ clock: () => (time += 0.5) })
  f.current = guardedSnapshot({ innerWindowId: 2147483649, browsingContextId: 12 })
  await f.bind()
  const seen = await f.observe()
  assert.deepEqual(seen.timing, { seq: 2, sentAtMs: 1001.5, responseAtMs: 1002 })
  f.setAct(request => clicked(f, request, { timing: { receivedAtMs: 1002.6, authorizedAtMs: 1002.7,
    performEnterMs: 1002.75, performExitMs: 1002.9, firstEventAtMs: 1002.8, performCallsBefore: 0, performCallsAfter: 1,
    pageText: 'secret', sentAtMs: 1 } }))
  const click = await f.dispatch('egdesk_browser_click', clickArgs(seen))
  assert.deepEqual(click.timing, { seq: 3, sentAtMs: 1002.5, responseAtMs: 1003, receivedAtMs: 1002.6, authorizedAtMs: 1002.7,
    performEnterMs: 1002.75, performExitMs: 1002.9, firstEventAtMs: 1002.8, performCallsBefore: 0, performCallsAfter: 1 },
  'UI fields are kept as sent; unknown keys and a UI copy of sentAtMs never overwrite the helper record')
  const next = await f.observe()
  f.setAct(request => clicked(f, request, { timing: { receivedAtMs: '1004', authorizedAtMs: -1, performEnterMs: Number.NaN,
    performCallsBefore: 1.5, performCallsAfter: '2', firstEventAtMs: null } }))
  assert.deepEqual((await f.dispatch('egdesk_browser_click', clickArgs(next))).timing, { seq: 5, sentAtMs: 1004.5, responseAtMs: 1005 },
    'malformed UI timing is omitted, not coerced')
  const waited = await f.dispatch('egdesk_browser_wait', { cardId: 'browser-1', for: 'load', timeoutMs: 1000 })
  assert.equal(waited.timing.seq, 6)
  await f.service.cancelRun(run)
  assert.deepEqual(f.requests.map(request => request.kind), ['bind', 'observe', 'act', 'observe', 'act', 'observe', 'cancel'])
  assert.deepEqual(f.requests.map(request => request.seq), [1, 2, 3, 4, 5, 6, 7])
  assert(f.requests.every((request, index) => Number.isFinite(request.sentAtMs) &&
    (index === 0 || request.sentAtMs > f.requests[index - 1].sentAtMs)), 'sentAtMs rises on the same clock')
  assert(f.requests.every(request => Number.isSafeInteger(request.deadlineMs)), 'the deadline stays on its own wall clock')

  const other = guardedFixture()
  await other.service.bind({ ...run, answerId: 'answer-2', runId: 'run-2' }, other.service.prepare({ selectedSources: [source()] }))
  assert.equal(other.requests[0].seq, 1, 'each run starts its own sequence')
  assert(Math.abs(other.requests[0].sentAtMs - (performance.timeOrigin + performance.now())) < 1000,
    'the default clock is performance.timeOrigin + performance.now()')
})

test('a timed-out action records sentAtMs and timedOutAtMs, stays unknown, and the lock repeats that record', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let time = 5000.25
  const f = guardedFixture({ clock: () => time })
  await f.bind()
  const seen = await f.observe()
  f.setAct(() => new Promise(() => {}))
  const pending = f.dispatch('egdesk_browser_click', clickArgs(seen), 'timed-out-timing')
  await flushHandoff()
  time = 20000.75
  t.mock.timers.tick(15000)
  const timedOut = await pending.catch(error => error)
  assert.equal(timedOut.code, 'BROWSER_UI_TIMEOUT')
  assert.match(timedOut.message, /outcome is unknown/)
  assert.deepEqual(timedOut.timing, { seq: 3, sentAtMs: 5000.25, timedOutAtMs: 20000.75 })
  assert.equal(f.acts()[0].seq, 3)
  assert.equal(f.acts()[0].sentAtMs, 5000.25)
  assert.equal(await f.dispatch('egdesk_browser_click', clickArgs(seen), 'timed-out-timing').catch(error => error), timedOut)
  const again = await f.observe()
  assert.deepEqual(again.uncertainAction, { action: 'click', dispatched: 'unknown',
    timing: { seq: 3, sentAtMs: 5000.25, timedOutAtMs: 20000.75 } },
  'the reconcile question was not answered (this UI has no reconcile), so it stays unknown')
  assert.equal(timedOut.dispatched, 'unknown')
  assert.deepEqual(timedOut.reconcile, { answered: false, reason: 'no-answer' })
  await assert.rejects(f.dispatch('egdesk_browser_click', clickArgs(again)), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(f.acts().length, 1, 'no automatic retry after a timeout')
})

test('Gecko innerWindowId and browsingContextId pass from the observation into the guard unchanged', async () => {
  const f = guardedFixture()
  f.current = guardedSnapshot({ innerWindowId: 2147483649, browsingContextId: 12 })
  await f.bind()
  const seen = await f.observe()
  assert.equal(seen.snapshot.innerWindowId, 2147483649)
  assert.equal(seen.snapshot.browsingContextId, 12)
  f.setAct(request => clicked(f, request))
  await f.dispatch('egdesk_browser_click', clickArgs(seen))
  assert.equal(f.acts()[0].guard.innerWindowId, 2147483649)
  assert.equal(f.acts()[0].guard.browsingContextId, 12)
  f.current = guardedSnapshot({ innerWindowId: 'unexpected-form', browsingContextId: null })
  const odd = await f.observe()
  f.setAct(request => notSent(request, { dispatchPhase: 'not-dispatched' }))
  await assert.rejects(f.dispatch('egdesk_browser_click', clickArgs(odd)), { code: 'BROWSER_OBSERVATION_STALE' })
  assert.equal(f.acts()[1].guard.innerWindowId, 'unexpected-form', 'the helper forwards; Firefox chrome checks')
  assert.equal(f.acts()[1].guard.browsingContextId, null)
  f.current = guardedSnapshot()
  const legacy = await f.observe()
  f.setAct(request => clicked(f, request))
  await f.dispatch('egdesk_browser_click', clickArgs(legacy))
  assert.equal(Object.hasOwn(f.acts()[2].guard, 'innerWindowId'), false, 'an observation without the field adds nothing')
  assert.equal(Object.hasOwn(f.acts()[2].guard, 'browsingContextId'), false)
})

// ---- 1-A: tool classes, wait_text, container scroll, reconcile, obscuredBy, dialogs ----
import { createHash } from 'node:crypto'

test('tool classes are exported for the chat runtime; wait_text is appended and existing schemas are untouched', () => {
  assert.deepEqual(BROWSER_READ_TOOL_NAMES, ['egdesk_browser_observe', 'egdesk_browser_wait_text', 'egdesk_browser_list_cards', 'egdesk_browser_screenshot'])
  assert.deepEqual(BROWSER_INTERACTION_TOOL_NAMES, ['egdesk_browser_navigate', 'egdesk_browser_click', 'egdesk_browser_fill',
    'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait',
    'egdesk_browser_request_site', 'egdesk_browser_open_card', 'egdesk_browser_close_card', 'egdesk_browser_history',
    'egdesk_browser_pointer_click', 'egdesk_browser_type'])
  assert.throws(() => BROWSER_READ_TOOL_NAMES.push('x'), TypeError, 'frozen for importers')
  const names = BROWSER_TOOL_SPECS.map(item => item.name)
  assert.deepEqual(names, ['egdesk_browser_observe', 'egdesk_browser_navigate', 'egdesk_browser_click', 'egdesk_browser_fill',
    'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait', 'egdesk_browser_wait_text',
    'egdesk_browser_list_cards', 'egdesk_browser_request_site', 'egdesk_browser_open_card', 'egdesk_browser_close_card', 'egdesk_browser_history',
    'egdesk_browser_screenshot', 'egdesk_browser_pointer_click', 'egdesk_browser_type'])
  assert.deepEqual([...BROWSER_READ_TOOL_NAMES, ...BROWSER_INTERACTION_TOOL_NAMES].sort(), [...names].sort(),
    'every Browser tool is in exactly one class')
  // sha256 of [name, inputSchema] for the seven tools at d7aac51: native
  // thread manifests hash these schemas, so they must not move.
  const digest = createHash('sha256').update(JSON.stringify(BROWSER_TOOL_SPECS.slice(0, 7)
    .map(item => [item.name, item.inputSchema]))).digest('hex')
  assert.equal(digest, '9f92c38ddae6e6c19126d09675001535e8bfb2e1cb7abdeefc7e5165a9c1b684')
  const waitText = BROWSER_TOOL_SPECS[7]
  // BRW-09: appended after wait_text; read-only, cardId only.
  const screenshot = BROWSER_TOOL_SPECS.find(item => item.name === 'egdesk_browser_screenshot')
  assert.ok(BROWSER_TOOL_SPECS.indexOf(screenshot) > BROWSER_TOOL_SPECS.indexOf(waitText))
  assert.deepEqual(screenshot.inputSchema, { type: 'object', additionalProperties: false, properties: { cardId: { type: 'string' } }, required: ['cardId'] })
  assert.match(screenshot.description, /never input coordinates/)
  assert.deepEqual(waitText.inputSchema, { type: 'object', additionalProperties: false,
    properties: { cardId: { type: 'string' }, text: { type: 'string' }, textGone: { type: 'string' }, timeoutMs: { type: 'integer' } },
    required: ['cardId', 'timeoutMs'] })
  assert.match(waitText.description, /field values, editors, sensitive fields and hidden text are never read/)
  assert.match(BROWSER_TOOL_SPECS.find(item => item.name === 'egdesk_browser_scroll').description, /scrollContainers/)
})

function waitTextReply(request, { outcome = 'met', matchCount = 1, text = ['Order confirmed'], ...extra } = {}) {
  return { requestId: request.requestId, status: 'observed', snapshot: { ...guardedSnapshot({ text }),
    wait: { for: request.options.wait.for, outcome, elapsedMs: 40, matchCount, ...extra } } }
}

test('wait_text sends one read-only wait, never echoes the text, and states met, not met in time or unverified', async () => {
  const f = guardedFixture()
  await f.bind()
  for (const args of [
    { cardId: 'browser-1', timeoutMs: 1000 },
    { cardId: 'browser-1', text: 'a', textGone: 'b', timeoutMs: 1000 },
    { cardId: 'browser-1', text: '   ', timeoutMs: 1000 },
    { cardId: 'browser-1', text: 'x'.repeat(201), timeoutMs: 1000 },
    { cardId: 'browser-1', text: 'ok', timeoutMs: 99 },
    { cardId: 'browser-1', text: 'ok', timeoutMs: 10001 },
    { cardId: 'browser-1', text: 'ok', timeoutMs: 1000, ref: 'el_1' },
  ]) await assert.rejects(f.dispatch('egdesk_browser_wait_text', args), { code: 'INVALID_BROWSER_TOOL' }, JSON.stringify(args))
  assert.equal(f.waits().length, 0)
  f.setWait(request => waitTextReply(request))
  const met = await f.dispatch('egdesk_browser_wait_text', { cardId: 'browser-1', text: '  Order\n confirmed ', timeoutMs: 2000 })
  assert.deepEqual(f.waits()[0].options.wait, { for: 'text', text: 'Order confirmed', timeoutMs: 2000 },
    'whitespace collapses like the actor collapses page text')
  assert.equal(met.status, 'wait-condition-met')
  assert.equal(met.action, 'wait_text')
  assert.deepEqual(met.wait, { for: 'text', timeoutMs: 2000, elapsedMs: 40, outcome: 'met', documentReplaced: false })
  assert.equal(JSON.stringify(met.wait).includes('Order'), false, 'the wait record never echoes the text')
  assert.equal(typeof met.observationId, 'string', 'it leaves a fresh observation')
  f.setWait(request => waitTextReply(request, { outcome: 'timeout', matchCount: 0, text: ['Pending'] }))
  assert.equal((await f.dispatch('egdesk_browser_wait_text', { cardId: 'browser-1', text: 'Order confirmed', timeoutMs: 1000 })).status, 'wait-timeout')
  f.setWait(request => waitTextReply(request, { matchCount: 1, text: ['Something else'] }))
  assert.equal((await f.dispatch('egdesk_browser_wait_text', { cardId: 'browser-1', text: 'Order confirmed', timeoutMs: 1000 })).status,
    'wait-condition-unverified', 'a claimed match the returned text cannot show stays unverified')
  f.setWait(request => waitTextReply(request, { matchCount: 1, text: Array.from({ length: 60 }, (_, i) => `Line ${i}`) }))
  assert.equal((await f.dispatch('egdesk_browser_wait_text', { cardId: 'browser-1', text: 'Order confirmed', timeoutMs: 1000 })).status,
    'wait-condition-met', 'a text list cut at its limit cannot disprove the actor count')
  f.setWait(request => waitTextReply(request, { matchCount: 0, text: ['Done'] }))
  const gone = await f.dispatch('egdesk_browser_wait_text', { cardId: 'browser-1', textGone: 'Loading…', timeoutMs: 1000 })
  assert.equal(gone.status, 'wait-condition-met')
  assert.equal(f.waits().at(-1).options.wait.for, 'text-gone')
  f.setWait(request => waitTextReply(request, { matchCount: 0, text: ['Loading… still'] }))
  assert.equal((await f.dispatch('egdesk_browser_wait_text', { cardId: 'browser-1', textGone: 'Loading…', timeoutMs: 1000 })).status,
    'wait-condition-unverified')
  f.setWait(request => waitTextReply(request, { matchCount: 'many' }))
  await assert.rejects(f.dispatch('egdesk_browser_wait_text', { cardId: 'browser-1', text: 'Order confirmed', timeoutMs: 1000 }),
    { code: 'BROWSER_WAIT_OUTCOME_UNKNOWN' })
  assert.equal(f.acts().length, 0, 'never an action')
  const tight = guardedFixture({ timeoutMs: 5000 })
  await tight.bind()
  await assert.rejects(tight.dispatch('egdesk_browser_wait_text', { cardId: 'browser-1', text: 'ok', timeoutMs: 3500 }),
    { code: 'INVALID_BROWSER_TOOL' }, 'the wait leaves room for the reply inside the request budget')
})

test('wait_text works with an observe grant, where every interaction tool is refused', async () => {
  const requests = []
  const service = createBrowserToolService({ getOwnerKey: () => 'engine-account-1', sendToUi: async request => {
    requests.push(request)
    if (request.kind === 'bind') return { requestId: request.requestId, status: 'bound', binding: {
      cardId: 'browser-1', cardEpoch: 'card-epoch-1', profileId: 'firefox-default', accountId: 'fixture-account',
      userContextId: 0, url: 'https://example.test/local', engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0 } }
    if (request.kind === 'observe') return waitTextReply(request)
    throw new Error('unexpected UI request')
  } })
  await service.bind(run, service.prepare({ selectedSources: [source('observe')] }))
  const met = await service.dispatch(run, { tool: 'egdesk_browser_wait_text', callId: 'ro-wait-text',
    arguments: { cardId: 'browser-1', text: 'Order confirmed', timeoutMs: 1000 } })
  assert.equal(met.status, 'wait-condition-met')
  await assert.rejects(service.dispatch(run, { tool: 'egdesk_browser_wait', callId: 'ro-wait',
    arguments: { cardId: 'browser-1', for: 'load', timeoutMs: 1000 } }), { code: 'BROWSER_INTERACTION_NOT_GRANTED' })
  assert.deepEqual(requests.map(request => request.kind), ['bind', 'observe'])
})

function containerSnapshot(y, overrides = {}) {
  return guardedSnapshot({ interactiveElements: [...guardedSnapshot().interactiveElements,
    { ref: 'el_4', role: 'scrollable', label: 'Rows', href: '', value: '', tag: 'div', disabled: false,
      bounds: { x: 12, y: 200, width: 260, height: 200 } }],
  scrollContainers: [{ ref: 'el_4', x: 0, y, maxY: 600 }], ...overrides })
}
const containerReceipt = (before, after) => scrollReceipt('container', { containerScroll: {
  before: { x: 0, y: before, maxY: 600 }, after: { x: 0, y: after, maxY: 600 } } })

test('ref with direction scrolls inside one observed scroll container, guarded by its own offset', async () => {
  const f = guardedFixture()
  f.current = containerSnapshot(0)
  await f.bind()
  const seen = await f.observe()
  f.setAct(request => {
    f.current = containerSnapshot(180)
    return f.acted(request, f.current, containerReceipt(0, 180))
  })
  const args = { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3, ref: 'el_4',
    expectedTarget: targetOf(seen, 'el_4'), direction: 'down' }
  const result = await f.dispatch('egdesk_browser_scroll', args)
  assert.equal(result.status, 'postcondition-observed')
  assert.deepEqual(result.postcondition, { kind: 'container-scroll-position', ref: 'el_4', direction: 'down', amount: 'page', matched: true })
  assert.deepEqual(result.scroll, { container: { ref: 'el_4', before: { x: 0, y: 0, maxY: 600 }, after: { x: 0, y: 180, maxY: 600 } } })
  const [request] = f.acts()
  assert.deepEqual(request.action, { type: 'scroll', ref: 'el_4', direction: 'down', amount: 'page' })
  assert.deepEqual(request.guard.containerScroll, { x: 0, y: 0 })
  assert.deepEqual(request.guard.scroll, { x: 0, y: 0, maxY: 2000 }, 'the document offset is guarded as well')
  assert.equal(request.guard.target.ref, 'el_4')
  // At the bottom already: scroll-at-limit, never a lock.
  f.current = containerSnapshot(600)
  const bottom = await f.observe()
  f.setAct(request => f.acted(request, f.current, containerReceipt(600, 600)))
  assert.equal((await f.dispatch('egdesk_browser_scroll', { ...args, observationId: bottom.observationId,
    expectedTarget: targetOf(bottom, 'el_4') })).status, 'scroll-at-limit')
  // A document-mode receipt for a container request is not proof.
  const again = await f.observe()
  f.setAct(request => f.acted(request, containerSnapshot(600), scrollReceipt('document')))
  const odd = await f.dispatch('egdesk_browser_scroll', { ...args, observationId: again.observationId,
    expectedTarget: targetOf(again, 'el_4'), direction: 'up', amount: 'half' })
  assert.equal(odd.status, 'postcondition-unverified')
  assert.deepEqual(f.acts().at(-1).action, { type: 'scroll', ref: 'el_4', direction: 'up', amount: 'half' })
  const next = await f.observe()
  assert.equal(next.uncertainAction, undefined, 'a scroll never locks the Card')
  // An element missing from scrollContainers cannot take a direction.
  await assert.rejects(f.dispatch('egdesk_browser_scroll', { ...args, observationId: next.observationId, ref: 'el_1',
    expectedTarget: targetOf(next, 'el_1') }), { code: 'BROWSER_TARGET_STALE' })
  assert.equal(f.acts().length, 3)
})

test('act requests name their call ID and relative budget; a lost response is reconciled once and never resent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lose = async (answer, { dialog } = {}) => {
    const f = guardedFixture()
    await f.bind()
    const seen = await f.observe()
    f.setAct(() => new Promise(() => {}))
    f.setReconcile(request => ({ requestId: request.requestId, status: 'reconciled',
      ...(dialog ? { dialog } : {}), reconcile: typeof answer === 'function' ? answer(request) : answer }))
    const pending = f.dispatch('egdesk_browser_click', clickArgs(seen), 'lost-click')
    await flushHandoff()
    t.mock.timers.tick(15000)
    const error = await pending.catch(caught => caught)
    return { f, error, seen }
  }
  // Proven never entered, and fenced: the Card is free and nothing was resent.
  const fenced = await lose(request => ({ version: 1, callId: request.callId, entered: false, fenced: true,
    documentId: request.guard.documentId }))
  assert.equal(fenced.error.code, 'BROWSER_OBSERVATION_STALE')
  assert.equal(fenced.error.dispatchPhase, 'not-dispatched')
  assert.equal(fenced.error.dispatched, false)
  const act = fenced.f.acts()[0]
  assert.equal(act.callId, 'lost-click')
  assert.equal(act.budgetMs, 15000)
  const [question] = fenced.f.reconciles()
  assert.deepEqual(Object.keys(question).filter(key => !['requestId', 'version', 'targetCardEpoch', 'deadlineMs',
    'budgetMs', 'runId', 'clientThreadId', 'cardId', 'binding', 'seq', 'sentAtMs'].includes(key)).sort(),
  ['actSeq', 'callId', 'guard', 'kind'])
  assert.equal(question.kind, 'reconcile')
  assert.equal(question.callId, 'lost-click')
  assert.equal(question.actSeq, act.seq)
  assert.equal(question.budgetMs, 3000, 'the question has its own short budget')
  assert.deepEqual(question.guard, { documentId: 'document-1' })
  assert.equal(Object.hasOwn(question, 'action'), false, 'a reconcile carries no action')
  const free = await fenced.f.observe()
  assert.equal(free.uncertainAction, undefined)
  fenced.f.setAct(request => clicked(fenced.f, request))
  assert.equal((await fenced.f.dispatch('egdesk_browser_click', clickArgs(free))).status, 'postcondition-observed')
  assert.equal(fenced.f.acts().length, 2, 'only the model\'s own new call acted')
  // Entered (a page dialog may still hold it): sent, outcome unknown, Card locked.
  const entered = await lose(request => ({ version: 1, callId: request.callId, entered: true, performing: true,
    documentId: request.guard.documentId, timing: { performEnterMs: 1 } }), { dialog: { type: 'alert', message: 'Hi' } })
  assert.equal(entered.error.code, 'BROWSER_UI_TIMEOUT')
  assert.equal(entered.error.dispatched, true)
  assert.equal(entered.error.dispatchPhase, 'dispatched')
  assert.deepEqual(entered.error.reconcile, { answered: true, entered: true, performing: true })
  assert.deepEqual(entered.error.dialog, { type: 'alert' })
  const locked = await entered.f.observe()
  assert.equal(locked.uncertainAction.dispatched, true)
  await assert.rejects(entered.f.dispatch('egdesk_browser_click', clickArgs(locked)), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(entered.f.acts().length, 1)
  // Anything short of a fenced "never entered" for the observed document stays unknown and locked.
  for (const [label, answer] of [
    ['not fenced', request => ({ callId: request.callId, entered: false, documentId: request.guard.documentId })],
    ['other document', request => ({ callId: request.callId, entered: false, fenced: true, documentId: 'document-9' })],
    ['perform timing', request => ({ callId: request.callId, entered: false, fenced: true, documentId: request.guard.documentId,
      timing: { performEnterMs: 5 } })],
    ['another call', () => ({ callId: 'someone-else', entered: false, fenced: true, documentId: 'document-1' })],
    ['actor unsure', request => ({ callId: request.callId, entered: 'unknown', reason: 'other-document' })],
  ]) {
    const lost = await lose(answer)
    assert.equal(lost.error.code, 'BROWSER_UI_TIMEOUT', label)
    assert.equal(lost.error.dispatched, 'unknown', label)
    assert.equal(lost.error.dispatchPhase, 'unknown', label)
    const again = await lost.f.observe()
    assert.equal(again.uncertainAction?.action, 'click', label)
    assert.equal(lost.f.acts().length, 1, label)
  }
  const unsure = await lose(request => ({ callId: request.callId, entered: 'unknown', reason: 'other-document' }))
  assert.deepEqual(unsure.error.reconcile, { answered: false, reason: 'other-document' })
})

test('a refused click says what covered it; a page dialog with the action keeps the outcome unknown', async () => {
  const f = guardedFixture()
  await f.bind()
  let seen = await f.observe()
  f.setAct(request => notSent(request, { error: 'Browser target is obscured by div#cookie-consent role=dialog ref=el_7; observe again' }))
  const covered = await f.dispatch('egdesk_browser_click', clickArgs(seen)).catch(error => error)
  assert.equal(covered.code, 'BROWSER_OBSERVATION_STALE')
  assert.equal(covered.obscuredBy, 'div#cookie-consent role=dialog ref=el_7')
  assert.equal(covered.dispatched, false)
  seen = await f.observe()
  f.setAct(request => notSent(request, { error: 'Browser target is obscured; observe again', obscuredBy: 'div.banner inside section#top ref=f2/el_3' }))
  assert.equal((await f.dispatch('egdesk_browser_click', clickArgs(seen)).catch(error => error)).obscuredBy,
    'div.banner inside section#top ref=f2/el_3', 'the structured field wins')
  seen = await f.observe()
  f.setAct(request => notSent(request, { error: 'Browser target is obscured by <b onclick=x>Buy</b>; observe again' }))
  assert.equal((await f.dispatch('egdesk_browser_click', clickArgs(seen)).catch(error => error)).obscuredBy, undefined)
  assert.equal((await f.observe()).uncertainAction, undefined, 'a refused click never locks')
  // An alert open after the click: dispatched, never "matched".
  seen = await f.observe()
  f.setAct(request => ({ ...clicked(f, request), dialog: { type: 'alert', message: 'Saved!' } }))
  const held = await f.dispatch('egdesk_browser_click', clickArgs(seen))
  assert.equal(held.status, 'postcondition-unverified')
  assert.deepEqual(held.dialog, { type: 'alert' })
  assert.equal(JSON.stringify(held).includes('Saved!'), false)
  await assert.rejects(f.dispatch('egdesk_browser_click', clickArgs(await f.observe())), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  // A "not-dispatched" refusal that also reports a dialog is not trusted as not sent.
  const g = guardedFixture()
  await g.bind()
  const looked = await g.observe()
  g.setAct(request => notSent(request, { dialog: { type: 'confirm' } }))
  const contradicted = await g.dispatch('egdesk_browser_click', clickArgs(looked)).catch(error => error)
  assert.equal(contradicted.code, 'BROWSER_ACTION_UNVERIFIED')
  assert.deepEqual(contradicted.dialog, { type: 'confirm' })
})

test('the actor receipt stamp joins the same-clock record when the UI forwards it', async () => {
  let time = 1000
  const f = guardedFixture({ clock: () => (time += 0.5) })
  await f.bind()
  const seen = await f.observe()
  f.setAct(request => clicked(f, request, { timing: { receivedAtMs: 1002.6, authorizedAtMs: 1002.7, actorReceivedAtMs: 1002.65,
    performEnterMs: 1002.75, performExitMs: 1002.9, performCallsBefore: 0, performCallsAfter: 1 } }))
  const click = await f.dispatch('egdesk_browser_click', clickArgs(seen))
  assert.equal(click.timing.actorReceivedAtMs, 1002.65)
})

// BRW-05 / BRW-07 / BRW-11: a UI that answers bind with the conversation's
// navigation policy, opens and closes Cards, moves history and answers a site
// question. Every request is recorded so the tests can check what left.
function cardsFixture({ sites = [], answerSite = 'site-allowed' } = {}) {
  const policy = () => ({ scope: 'same-site', allow: sites.flatMap(site => [site, `*.${site}`]), block: [], allowDowngrade: false })
  const identity = { profileId: 'firefox-default', accountId: 'fixture-account', userContextId: 0,
    engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0 }
  const pages = new Map([['browser-1', guardedSnapshot()]])
  const requests = []
  let openedSeq = 1, siteAnswer = answerSite, openedIdentity = identity
  const sendToUi = async request => {
    requests.push(request)
    const reply = extra => ({ requestId: request.requestId, ...extra })
    if (request.kind === 'bind') return reply({ status: 'bound', navigationPolicy: policy(), binding: {
      cardId: 'browser-1', cardEpoch: 'card-epoch-1', url: 'https://example.test/local', ...identity } })
    if (request.kind === 'cancel') return reply({ status: 'cancelled' })
    if (request.kind === 'observe') return reply({ status: 'observed', navigationPolicy: policy(), snapshot: { ...pages.get(request.cardId), cardId: request.cardId } })
    if (request.kind === 'allow-site') {
      if (siteAnswer === 'timeout') throw Object.assign(new Error('no answer'), { code: 'BROWSER_UI_TIMEOUT' })
      if (siteAnswer === 'site-allowed') sites.push(request.site)
      return reply({ status: siteAnswer, navigationPolicy: policy() })
    }
    if (request.kind === 'open-card') {
      const cardId = `browser-${++openedSeq}`
      pages.set(cardId, guardedSnapshot({ documentId: `document-${cardId}`, url: request.url }))
      return reply({ status: 'card-opened', navigationPolicy: policy(), binding: { cardId, cardEpoch: `card-epoch-${openedSeq}`, url: request.url, ...openedIdentity } })
    }
    if (request.kind === 'close-card') { pages.delete(request.cardId); return reply({ status: 'card-closed' }) }
    if (request.kind === 'history') return reply({ status: 'acted', receipt: { dispatchReceipt: { actor: 'chrome', inputRoute: 'chrome-history',
      historyAction: request.historyAction, eventDispatched: true, documentStillCurrent: false }, after: null, observation: null } })
    if (request.kind === 'act' && request.action.type === 'navigate' && request.guard.navigationScope === 'allowed-site') {
      pages.set(request.cardId, guardedSnapshot({ documentId: 'document-moved', url: request.action.url }))
      return reply({ status: 'acted', receipt: { dispatchReceipt: { actor: 'chrome', inputRoute: 'chrome-load-uri',
        eventDispatched: true, documentStillCurrent: false }, after: null, observation: null } })
    }
    throw new Error(`unexpected UI request ${request.kind}`)
  }
  const service = createBrowserToolService({ sendToUi, getOwnerKey: () => 'engine-account-1' })
  let sequence = 0
  const dispatch = (tool, args, callId = `cards-call-${++sequence}`) => service.dispatch(run, { tool, callId, arguments: args })
  return { service, requests, dispatch, pages,
    of: kind => requests.filter(request => request.kind === kind),
    observe: (cardId = 'browser-1') => dispatch('egdesk_browser_observe', { cardId }),
    setSiteAnswer(value) { siteAnswer = value }, setOpenedIdentity(value) { openedIdentity = value },
    bind: () => service.bind(run, service.prepare({ selectedSources: [source()] })) }
}

test('D-B1: navigate reaches a site this conversation allowed through the chrome route and refuses others with host and reason', async () => {
  const f = cardsFixture({ sites: ['pay.test'] })
  await f.bind()
  const seen = await f.observe()
  const navigate = (observed, url) => f.dispatch('egdesk_browser_navigate', { cardId: 'browser-1',
    observationId: observed.observationId, expectedRevision: observed.snapshot.revision, url, postcondition: { kind: 'url', value: url } })
  await assert.rejects(navigate(seen, 'https://evil.test/'), error => error.code === 'BROWSER_NAVIGATE_OUT_OF_SCOPE' &&
    error.navigation.reason === 'outside-site' && error.navigation.host === 'evil.test')
  await assert.rejects(navigate(seen, 'http://pay.test/'), error => error.navigation.reason === 'insecure-downgrade', 'an allowed site never allows a downgrade')
  assert.equal(f.of('act').length, 0)
  const moved = await navigate(seen, 'https://checkout.pay.test/start')
  assert.equal(moved.status, 'postcondition-unverified', 'the chrome route reports dispatch, not the page')
  assert.equal(moved.navigationScope, 'allowed-site')
  assert.equal(moved.pageLoadVerified, false)
  const [act] = f.of('act')
  assert.equal(act.guard.navigationScope, 'allowed-site')
  assert.deepEqual(act.guard.allowedSites, ['pay.test', '*.pay.test'])
  await assert.rejects(f.dispatch('egdesk_browser_click', { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: seen.snapshot.interactiveElements[0], postcondition: { kind: 'visible-text', value: 'x' } }),
  { code: 'BROWSER_OUTCOME_UNKNOWN' }, 'the Card stays locked until the new document is observed')
  const after = await f.observe()
  assert.equal(after.navigationPostconditionReobserved, true, 'the new document on the allowed site resolves the transition')
  assert.equal(after.snapshot.url, 'https://checkout.pay.test/start')
  // From the allowed site the current site is now pay.test; the original site stays reachable only as an allowed one.
  await assert.rejects(navigate(after, 'https://example.test/back'), error => error.navigation.reason === 'outside-site')
})

test('request_site asks the person once on a long budget; the answer on the Card changes what the run may open', async () => {
  const f = cardsFixture()
  await f.bind()
  const seen = await f.observe()
  const navigate = (observed, url) => f.dispatch('egdesk_browser_navigate', { cardId: 'browser-1',
    observationId: observed.observationId, expectedRevision: observed.snapshot.revision, url, postcondition: { kind: 'url', value: url } })
  await assert.rejects(navigate(seen, 'https://other.test/'), { code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' })
  const allowed = await f.dispatch('egdesk_browser_request_site', { cardId: 'browser-1', site: 'https://www.other.test/some/path?q=1' })
  assert.equal(allowed.status, 'site-allowed')
  assert.equal(allowed.site, 'other.test', 'the registrable domain, never the path')
  const [ask] = f.of('allow-site')
  assert.equal(ask.budgetMs, 55000)
  assert.deepEqual(ask.patterns, ['other.test', '*.other.test'])
  assert.equal(ask.site, 'other.test')
  const moved = await navigate(seen, 'https://other.test/')
  assert.equal(moved.navigationScope, 'allowed-site')
  f.setSiteAnswer('site-refused')
  const refused = await f.dispatch('egdesk_browser_request_site', { cardId: 'browser-1', site: 'third.test' })
  assert.equal(refused.status, 'site-refused')
  await assert.rejects(f.dispatch('egdesk_browser_request_site', { cardId: 'browser-1', site: 'third.test' }),
    { code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' }, 'a refused site is not asked again in the same run')
  f.setSiteAnswer('timeout')
  const pending = await f.dispatch('egdesk_browser_request_site', { cardId: 'browser-1', site: 'slow.test' })
  assert.equal(pending.status, 'site-pending')
  await assert.rejects(f.dispatch('egdesk_browser_request_site', { cardId: 'browser-1', site: 'javascript:alert(1)' }), { code: 'INVALID_BROWSER_TOOL' })
  assert.equal(f.of('allow-site').length, 3)
})

test('D-B2: open_card binds a Card with the same identity under this run; list_cards shows it; close_card closes only that Card', async () => {
  const f = cardsFixture()
  await f.bind()
  await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_open_card', { cardId: 'browser-1', url: 'https://evil.test/' }), { code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' })
  const opened = await f.dispatch('egdesk_browser_open_card', { cardId: 'browser-1', url: 'https://www.example.test/compare' })
  assert.equal(opened.status, 'card-opened')
  assert.equal(opened.cardId, 'browser-2')
  assert.equal(opened.openedFrom, 'browser-1')
  assert.equal(opened.permission, 'interact')
  const [open] = f.of('open-card')
  assert.equal(open.permission, 'interact')
  assert.equal(open.navigationScope, 'same-site')
  const listed = await f.dispatch('egdesk_browser_list_cards', { cardId: 'browser-2' })
  assert.deepEqual(listed.cards.map(card => [card.cardId, card.openedByAgent]), [['browser-1', false], ['browser-2', true]])
  const seen2 = await f.observe('browser-2')
  assert.equal(seen2.snapshot.url, 'https://www.example.test/compare', 'the new Card is observed under its own cardId')
  await assert.rejects(f.dispatch('egdesk_browser_close_card', { cardId: 'browser-1' }), { code: 'BROWSER_CARD_NOT_AGENT_OPENED' })
  f.setOpenedIdentity({ profileId: 'firefox-default', accountId: 'someone-else', userContextId: 0, engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0 })
  await assert.rejects(f.dispatch('egdesk_browser_open_card', { cardId: 'browser-1', url: 'https://example.test/x' }), { code: 'BROWSER_BINDING_STALE' },
    'a Card bound to another account is never adopted')
  const closed = await f.dispatch('egdesk_browser_close_card', { cardId: 'browser-2' })
  assert.equal(closed.status, 'card-closed')
  assert.deepEqual(closed.cards.map(card => card.cardId), ['browser-1'])
  await assert.rejects(f.dispatch('egdesk_browser_observe', { cardId: 'browser-2' }), { code: 'BROWSER_CARD_NOT_SELECTED' })
  assert.equal(f.of('close-card').length, 1)
})

test('history moves are dispatched by chrome from a fresh observation and spend it', async () => {
  const f = cardsFixture()
  await f.bind()
  const seen = await f.observe()
  const args = { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: seen.snapshot.revision, action: 'back' }
  const moved = await f.dispatch('egdesk_browser_history', args)
  assert.equal(moved.status, 'history-dispatched')
  assert.equal(moved.historyAction, 'back')
  assert.equal(moved.pageLoadVerified, false)
  const [request] = f.of('history')
  assert.equal(request.guard.documentId, 'document-1')
  assert.equal(request.historyAction, 'back')
  await assert.rejects(f.dispatch('egdesk_browser_history', args), { code: 'BROWSER_OBSERVATION_STALE' })
  await assert.rejects(f.dispatch('egdesk_browser_history', { ...args, action: 'home' }), { code: 'INVALID_BROWSER_TOOL' })
  const again = await f.observe()
  assert.equal((await f.dispatch('egdesk_browser_history', { ...args, observationId: again.observationId, action: 'reload' })).status, 'history-dispatched')
  assert.equal(f.of('history').length, 2)
})

// ---- BRW-10 (REA 웹1·웹2, D-B4) and BRW-12: trusted pointer press and typing ----
import { RECOMMENDED_ACTION_GATE_POLICY } from './egdesk-browser-action-classifier.mjs'

const quietSettle = { waitedMs: 520, endedBy: 'quiet', domChanges: 0, requests: [] }
// The DOM click went out and changed nothing: same document, URL and revision, quiet settle.
const noEffectClick = (f, request, observation = { visibleTextChanged: false, settle: quietSettle }) => ({
  requestId: request.requestId, status: 'acted', receipt: { dispatchReceipt: actorReceipt({
    clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true }), after: f.current, observation } })
const pointerReceipt = (extra = {}) => actorReceipt({ inputRoute: 'trusted-pointer', apiRoute: 'synthesizeMouseEvent',
  trustedInput: true, point: { x: 52, y: 45 }, displayPoint: { x: 52, y: 45 }, moveDispatched: true, downDispatched: true,
  upDispatched: true, compensatedUp: false, targetPointerObserved: true, targetClickObserved: true, eventsTrusted: true, ...extra })
const pointerArgs = (seen, extra = {}) => ({ ...clickArgs(seen), ...extra })
async function afterNoEffectClick(options = {}) {
  const f = guardedFixture(options)
  await f.bind()
  f.current = guardedSnapshot({ zoom: 1.25, innerWindowId: 41, browsingContextId: 7 })
  const seen = await f.observe()
  f.setAct(request => noEffectClick(f, request))
  const click = await f.dispatch('egdesk_browser_click', clickArgs(seen))
  assert.equal(click.status, 'postcondition-unverified')
  return { f, seen: await f.observe() }
}

test('BRW-10: the press and typing tools are appended with their own schemas; click and press keep theirs', () => {
  const names = BROWSER_TOOL_SPECS.map(item => item.name)
  assert.deepEqual(names.slice(-2), ['egdesk_browser_pointer_click', 'egdesk_browser_type'])
  const pointer = BROWSER_TOOL_SPECS.find(item => item.name === 'egdesk_browser_pointer_click')
  const typing = BROWSER_TOOL_SPECS.find(item => item.name === 'egdesk_browser_type')
  const click = BROWSER_TOOL_SPECS.find(item => item.name === 'egdesk_browser_click')
  assert.deepEqual(pointer.inputSchema, click.inputSchema, 'same arguments as click; no coordinates from the model')
  assert.deepEqual(typing.inputSchema.required, ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'text', 'postcondition'])
  assert.deepEqual(typing.inputSchema.properties.key.enum, BROWSER_TOOL_SPECS.find(item => item.name === 'egdesk_browser_press').inputSchema.properties.key.enum)
  assert.equal(Object.hasOwn(pointer.inputSchema.properties, 'x'), false)
  assert.match(pointer.description, /only after egdesk_browser_click on the same element/)
  assert.match(pointer.description, /never retried and never replaces a click on its own/)
  assert.match(typing.description, /EG-Desk never moves focus/)
  assert.ok(BROWSER_INTERACTION_TOOL_NAMES.includes('egdesk_browser_pointer_click'))
  assert.ok(!BROWSER_READ_TOOL_NAMES.includes('egdesk_browser_type'))
})

test('BRW-10: a pointer press needs a dispatched DOM click on that element that changed nothing', async () => {
  const f = guardedFixture()
  await f.bind()
  let seen = await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_pointer_click', pointerArgs(seen)), { code: 'BROWSER_POINTER_NEEDS_CLICK_FIRST' })
  assert.equal(f.acts().length, 0, 'never chosen on its own')
  // A click that changed the DOM (revision moved) or fetched something is not "no effect".
  for (const [label, reply] of [
    ['mutation', request => { f.current = guardedSnapshot({ revision: 4 }); return noEffectClick(f, request) }],
    ['request', request => noEffectClick(f, request, { settle: { ...quietSettle, requests: [{ path: '/api', type: 'fetch' }] } })],
    ['no settle', request => noEffectClick(f, request, { visibleTextChanged: false })],
    ['navigation', request => noEffectClick(f, request, { settle: { ...quietSettle, endedBy: 'navigation-started' } })],
  ]) {
    const g = guardedFixture()
    await g.bind()
    const before = await g.observe()
    g.setAct(request => { const answer = reply.call(null, request); return { ...answer, receipt: { ...answer.receipt, after: label === 'mutation' ? guardedSnapshot({ revision: 4 }) : g.current } } })
    assert.equal((await g.dispatch('egdesk_browser_click', clickArgs(before))).status, 'postcondition-unverified', label)
    const again = await g.observe()
    await assert.rejects(g.dispatch('egdesk_browser_pointer_click', pointerArgs(again)), { code: 'BROWSER_OUTCOME_UNKNOWN' }, label)
    assert.equal(g.acts().length, 1, label)
  }
  // Another element than the one clicked.
  const { f: h, seen: after } = await afterNoEffectClick()
  await assert.rejects(h.dispatch('egdesk_browser_pointer_click', { ...pointerArgs(after), ref: 'el_2',
    expectedTarget: targetOf(after, 'el_2') }), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  seen = after
  assert.equal(h.acts().length, 1)
})

test('BRW-10: cap, contradictory observation and missing target-click evidence never qualify', async () => {
  for (const variant of ['cap', 'mutation', 'text', 'no click']) {
    const f = guardedFixture()
    await f.bind()
    const seen = await f.observe()
    f.setAct(request => {
      const settle = { ...quietSettle, endedBy: variant === 'cap' ? 'cap' : 'quiet', domChanges: variant === 'mutation' ? 1 : 0 }
      const reply = noEffectClick(f, request, { visibleTextChanged: variant === 'text', settle })
      if (variant === 'no click') reply.receipt.dispatchReceipt.targetClickObserved = false
      return reply
    })
    await f.dispatch('egdesk_browser_click', clickArgs(seen))
    await assert.rejects(f.dispatch('egdesk_browser_pointer_click', pointerArgs(await f.observe())),
      { code: 'BROWSER_OUTCOME_UNKNOWN' }, variant)
    assert.equal(f.acts().length, 1, variant)
  }
})

test('BRW-10: an observation outside the original scope permanently spends fallback', async () => {
  for (const changed of [{ url: 'https://example.test/local#other' }, { revision: 4 }, { documentId: 'document-2' }]) {
    const { f } = await afterNoEffectClick()
    const original = f.current
    f.current = { ...original, ...changed }
    await assert.rejects(f.dispatch('egdesk_browser_pointer_click', pointerArgs(await f.observe())), { code: 'BROWSER_OUTCOME_UNKNOWN' })
    f.current = original
    await assert.rejects(f.dispatch('egdesk_browser_pointer_click', pointerArgs(await f.observe())), { code: 'BROWSER_OUTCOME_UNKNOWN' })
    assert.equal(f.acts().length, 1)
  }
})

test('BRW-10: history on another Card invalidates fallback and blocks restoration by a delayed refusal', async () => {
  for (const pressInFlight of [false, true]) {
    const { f, seen } = await afterNoEffectClick({ secondCard: true })
    const other = await f.observe('browser-2')
    let press, refuse
    if (pressInFlight) {
      f.setAct(request => new Promise(resolve => { refuse = () => resolve(notSent(request)) }))
      press = f.dispatch('egdesk_browser_pointer_click', pointerArgs(seen))
      await flushHandoff()
    }
    const history = await f.dispatch('egdesk_browser_history', { cardId: 'browser-2', action: 'back',
      expectedRevision: other.snapshot.revision, observationId: other.observationId })
    assert.equal(history.status, 'history-dispatched')
    if (pressInFlight) {
      refuse()
      await assert.rejects(press, { dispatchPhase: 'not-dispatched' })
    }
    await assert.rejects(f.dispatch('egdesk_browser_pointer_click', pointerArgs(await f.observe())), { code: 'BROWSER_OUTCOME_UNKNOWN' })
    assert.equal(f.acts().length, pressInFlight ? 2 : 1)
  }
})

test('BRW-10: after a no-effect click and a fresh observation, one press goes out with observed bounds, scroll and zoom', async () => {
  const { f, seen } = await afterNoEffectClick()
  await assert.rejects(f.dispatch('egdesk_browser_click', clickArgs(seen)), { code: 'BROWSER_OUTCOME_UNKNOWN' },
    'the click itself stays locked: it is never retried')
  f.setAct(request => {
    f.current = guardedSnapshot({ text: ['Count: 1'], zoom: 1.25 })
    return { requestId: request.requestId, status: 'acted', receipt: { dispatchReceipt: pointerReceipt(), after: f.current,
      observation: { visibleTextChanged: true, settle: quietSettle } } }
  })
  // The model's copy of bounds is ignored; the guard carries the observed bounds.
  const args = pointerArgs(seen, { expectedTarget: { ...targetOf(seen, 'el_1'), bounds: { x: 500, y: 500, width: 1, height: 1 } } })
  const result = await f.dispatch('egdesk_browser_pointer_click', args)
  assert.equal(result.status, 'postcondition-observed')
  assert.equal(result.action, 'pointer-click')
  assert.equal(result.dispatchReceipt.inputRoute, 'trusted-pointer')
  assert.equal(result.externalEffectVerified, false)
  const request = f.acts().at(-1)
  assert.deepEqual(request.action, { type: 'pointer-click', ref: 'el_1' })
  assert.deepEqual(request.guard.target.bounds, { x: 12, y: 30, width: 80, height: 30 })
  assert.deepEqual(request.guard.pointer, { scroll: { x: 0, y: 0 }, zoom: 1.25 })
  assert.deepEqual([request.guard.innerWindowId, request.guard.browsingContextId], [41, 7], 'doc-id cross-check passes through')
  assert.equal(request.guard.revision, seen.snapshot.revision)
  // The press reached the goal: the Card is free again, and no second press is offered.
  const next = await f.observe()
  assert.equal(next.uncertainAction, undefined)
  await assert.rejects(f.dispatch('egdesk_browser_pointer_click', pointerArgs(next)), { code: 'BROWSER_POINTER_NEEDS_CLICK_FIRST' })
})

test('BRW-10: the press is spent once; an unverified, compensated or untargeted press keeps the Card locked', async () => {
  for (const [label, receipt, text] of [
    ['no effect', pointerReceipt(), ['Count: 0']],
    ['compensated up', pointerReceipt({ upDispatched: false, compensatedUp: true }), ['Count: 1']],
    ['missed target', pointerReceipt({ targetPointerObserved: false }), ['Count: 1']],
    ['untrusted route', pointerReceipt({ inputRoute: 'dom-click-no-pointerdown' }), ['Count: 1']],
    ['unknown api', pointerReceipt({ apiRoute: 'dispatchEvent' }), ['Count: 1']],
  ]) {
    const { f, seen } = await afterNoEffectClick()
    f.setAct(request => ({ requestId: request.requestId, status: 'acted', receipt: { dispatchReceipt: receipt,
      after: guardedSnapshot({ text, zoom: 1.25, innerWindowId: 41, browsingContextId: 7 }), observation: { settle: quietSettle } } }))
    assert.equal((await f.dispatch('egdesk_browser_pointer_click', pointerArgs(seen))).status, 'postcondition-unverified', label)
    const again = await f.observe()
    assert.equal(again.uncertainAction.action, 'pointer-click', label)
    await assert.rejects(f.dispatch('egdesk_browser_pointer_click', pointerArgs(again)), { code: 'BROWSER_OUTCOME_UNKNOWN' }, label)
    assert.equal(f.acts().length, 2, `${label}: one click and one press, nothing resent`)
  }
})

test('BRW-10: a press the actor refused before input keeps the click lock and gives the one press back', async () => {
  const { f, seen } = await afterNoEffectClick()
  f.setAct(request => notSent(request, { error: 'Browser pointer input refused [zoom-changed]; observe again',
    timing: { performCallsBefore: 3, performCallsAfter: 3 } }))
  const refused = await f.dispatch('egdesk_browser_pointer_click', pointerArgs(seen)).catch(error => error)
  assert.equal(refused.code, 'BROWSER_OBSERVATION_STALE')
  assert.equal(refused.dispatchPhase, 'not-dispatched')
  await assert.rejects(f.dispatch('egdesk_browser_pointer_click', pointerArgs(seen)), { code: 'BROWSER_OBSERVATION_STALE' })
  assert.equal(f.acts().length, 2, 'the refused press spent its observation')
  const again = await f.observe()
  assert.equal(again.uncertainAction.action, 'click', 'still locked by the click')
  await assert.rejects(f.dispatch('egdesk_browser_click', clickArgs(again)), { code: 'BROWSER_OUTCOME_UNKNOWN' })
  f.setAct(request => ({ requestId: request.requestId, status: 'acted', receipt: { dispatchReceipt: pointerReceipt(),
    after: guardedSnapshot({ text: ['Count: 1'] }), observation: { settle: quietSettle } } }))
  assert.equal((await f.dispatch('egdesk_browser_pointer_click', pointerArgs(again))).status, 'postcondition-observed')
  const changed = await afterNoEffectClick()
  changed.f.setAct(request => notSent(request))
  await assert.rejects(changed.f.dispatch('egdesk_browser_pointer_click', pointerArgs(changed.seen)), { dispatchPhase: 'not-dispatched' })
  changed.f.current = { ...changed.f.current, url: 'https://example.test/local#different' }
  await assert.rejects(changed.f.dispatch('egdesk_browser_pointer_click', pointerArgs(await changed.f.observe())),
    { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(changed.f.acts().length, 2)
  // An actor refusal that cannot prove "never sent" spends the press.
  const second = await afterNoEffectClick()
  second.f.setAct(request => ({ requestId: request.requestId, status: 'rejected', error: 'perform threw', dispatchPhase: 'dispatched',
    timing: { performCallsBefore: 3, performCallsAfter: 4, performEnterMs: 5 } }))
  assert.equal((await second.f.dispatch('egdesk_browser_pointer_click', pointerArgs(second.seen)).catch(error => error)).code,
    'BROWSER_ACTION_UNVERIFIED')
  const locked = await second.f.observe()
  await assert.rejects(second.f.dispatch('egdesk_browser_pointer_click', pointerArgs(locked)), { code: 'BROWSER_OUTCOME_UNKNOWN' })
})

test('BRW-12 (R-01): a lost press is reconciled once with seq, call ID and doc IDs; it is never resent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lose = async answer => {
    const { f, seen } = await afterNoEffectClick()
    f.setAct(() => new Promise(() => {}))
    f.setReconcile(request => ({ requestId: request.requestId, status: 'reconciled', reconcile: answer(request) }))
    const pending = f.dispatch('egdesk_browser_pointer_click', pointerArgs(seen), 'lost-press')
    await flushHandoff()
    t.mock.timers.tick(15000)
    return { f, seen, error: await pending.catch(caught => caught) }
  }
  const fenced = await lose(request => ({ version: 1, callId: request.callId, entered: false, fenced: true,
    documentId: request.guard.documentId }))
  assert.equal(fenced.error.dispatchPhase, 'not-dispatched')
  const [press] = fenced.f.acts().slice(-1)
  const [question] = fenced.f.reconciles()
  assert.equal(press.callId, 'lost-press')
  assert.equal(question.callId, 'lost-press')
  assert.equal(question.actSeq, press.seq, 'the question names the press by its run sequence')
  assert.ok(press.seq > fenced.f.acts()[0].seq, 'seq rises across the click and the press')
  assert.ok(Number.isFinite(press.sentAtMs))
  assert.deepEqual(question.guard, { documentId: 'document-1', innerWindowId: 41, browsingContextId: 7 })
  assert.equal(Object.hasOwn(question, 'action'), false)
  const after = await fenced.f.observe()
  assert.equal(after.uncertainAction.action, 'click', 'a fenced press leaves the click lock in place')
  assert.equal(fenced.f.acts().length, 2, 'no resend')
  // Entered, or any unproven answer: dispatched/unknown, locked, no second press.
  for (const [label, answer, phase] of [
    ['entered', request => ({ callId: request.callId, entered: true, documentId: request.guard.documentId }), 'dispatched'],
    ['other document', request => ({ callId: request.callId, entered: false, fenced: true, documentId: 'document-9' }), 'unknown'],
    ['performing timing', request => ({ callId: request.callId, entered: false, fenced: true, documentId: request.guard.documentId,
      timing: { performEnterMs: 3 } }), 'unknown'],
    ['contradictory event evidence', request => ({ callId: request.callId, entered: false, fenced: true,
      documentId: request.guard.documentId, timing: { firstEventAtMs: 3 } }), 'unknown'],
  ]) {
    const lost = await lose(answer)
    assert.equal(lost.error.code, 'BROWSER_UI_TIMEOUT', label)
    assert.equal(lost.error.dispatchPhase, phase, label)
    const again = await lost.f.observe()
    assert.equal(again.uncertainAction.action, 'pointer-click', label)
    assert.ok(Number.isFinite(again.uncertainAction.timing.timedOutAtMs), `${label}: same-clock timeout stamp`)
    await assert.rejects(lost.f.dispatch('egdesk_browser_pointer_click', pointerArgs(again)), { code: 'BROWSER_OUTCOME_UNKNOWN' }, label)
    assert.equal(lost.f.acts().length, 2, label)
  }
})

const typeReceipt = (extra = {}) => actorReceipt({ inputRoute: 'trusted-text-input', trustedInput: true, textLength: 5, key: null,
  textCommitted: true, keyDispatched: false, targetInputObserved: true, targetKeyObserved: false, keydownConsumed: null,
  eventsTrusted: true, documentHasFocus: true, focusPolicy: 'already-focused', ...extra })
const focusedSearch = () => guardedSnapshot({ focusedElement: { ref: 'el_2', role: 'searchbox', label: 'Search', value: '' } })
const typeArgs = (seen, extra = {}) => ({ cardId: 'browser-1', observationId: seen.observationId, expectedRevision: seen.snapshot.revision,
  ref: 'el_2', expectedTarget: targetOf(seen, 'el_2'), text: 'hello', postcondition: { kind: 'target-value', value: 'hello' }, ...extra })
const typedSnapshot = value => guardedSnapshot({ focusedElement: { ref: 'el_2', role: 'searchbox', label: 'Search', value },
  interactiveElements: guardedSnapshot().interactiveElements.map(item => item.ref === 'el_2' ? { ...item, value } : item) })

test('BRW-10: typing needs the observed focused element and sends text (and an optional key) once', async () => {
  const f = guardedFixture()
  await f.bind()
  let seen = await f.observe()
  await assert.rejects(f.dispatch('egdesk_browser_type', typeArgs(seen)), { code: 'BROWSER_PRESS_TARGET_NOT_FOCUSED' })
  assert.equal(f.acts().length, 0)
  f.current = focusedSearch()
  seen = await f.observe()
  for (const bad of [{ text: '' }, { text: 'x'.repeat(8001) }, { key: 'F5' }, { text: 1 }]) {
    await assert.rejects(f.dispatch('egdesk_browser_type', typeArgs(seen, bad)), { code: 'INVALID_BROWSER_TOOL' })
  }
  f.setAct(request => { f.current = typedSnapshot('hello'); return f.acted(request, f.current, typeReceipt()) })
  const typed = await f.dispatch('egdesk_browser_type', typeArgs(seen))
  assert.equal(typed.status, 'postcondition-observed')
  assert.deepEqual(f.acts()[0].action, { type: 'type-text', ref: 'el_2', text: 'hello' })
  assert.equal(f.acts()[0].guard.focusedRef, 'el_2')
  assert.equal(f.acts()[0].guard.pointer, undefined, 'typing carries no coordinates')
  // Text and Enter: the receipt must name the same key; the browser ran its default action.
  seen = await f.observe()
  f.setAct(request => { f.current = typedSnapshot('hello world'); return f.acted(request, f.current,
    typeReceipt({ textLength: 6, key: 'Enter', keyDispatched: true, keydownConsumed: false })) })
  assert.equal((await f.dispatch('egdesk_browser_type', typeArgs(seen, { text: ' world', key: 'Enter',
    postcondition: { kind: 'target-value', value: 'hello world' } }))).status, 'postcondition-observed')
  assert.deepEqual(f.acts()[1].action, { type: 'type-text', ref: 'el_2', text: ' world', key: 'Enter' })
})

test('BRW-10: a typing receipt that does not match the request stays unverified and locks the Card', async () => {
  for (const [label, receipt, extra] of [
    ['no input event', typeReceipt({ targetInputObserved: false }), {}],
    ['wrong key', typeReceipt({ key: 'Tab', keyDispatched: true }), { key: 'Enter' }],
    ['key not sent', typeReceipt({ key: 'Enter', keyDispatched: false }), { key: 'Enter' }],
    ['untrusted', typeReceipt({ trustedInput: false }), {}],
    ['focus policy', typeReceipt({ focusPolicy: 'after-fill' }), {}],
  ]) {
    const f = guardedFixture()
    await f.bind()
    f.current = focusedSearch()
    const seen = await f.observe()
    f.setAct(request => { f.current = typedSnapshot('hello'); return f.acted(request, f.current, receipt) })
    assert.equal((await f.dispatch('egdesk_browser_type', typeArgs(seen, extra))).status, 'postcondition-unverified', label)
    const again = await f.observe()
    assert.equal(again.uncertainAction.action, 'type-text', label)
    await assert.rejects(f.dispatch('egdesk_browser_type', typeArgs(again, extra)), { code: 'BROWSER_OUTCOME_UNKNOWN' }, label)
  }
})

test('BRW-10: click, pointer press and typing share the action-classifier gate; the default policy allows all', async () => {
  const pay = guardedSnapshot({ interactiveElements: [{ ref: 'el_1', role: 'button', label: 'Pay now', href: '', value: '',
    tag: 'button', disabled: false, bounds: { x: 12, y: 30, width: 80, height: 30 } }] })
  const gated = guardedFixture({ actionGatePolicy: RECOMMENDED_ACTION_GATE_POLICY })
  await gated.bind()
  gated.current = pay
  let seen = await gated.observe()
  const refused = await gated.dispatch('egdesk_browser_click', clickArgs(seen)).catch(error => error)
  assert.equal(refused.code, 'BROWSER_ACTION_NEEDS_PERSON')
  assert.equal(refused.dispatchPhase, 'not-dispatched')
  assert.deepEqual([refused.actionCategory, refused.actionGate], ['pay', 'user-step'])
  await assert.rejects(gated.dispatch('egdesk_browser_pointer_click', pointerArgs(seen)), { code: 'BROWSER_ACTION_NEEDS_PERSON' })
  assert.equal(gated.acts().length, 0)
  seen = await gated.observe()
  assert.equal(seen.uncertainAction, undefined, 'a gated action never locks')
  const open = guardedFixture()
  await open.bind()
  open.current = pay
  seen = await open.observe()
  open.setAct(request => clicked(open, request))
  assert.equal((await open.dispatch('egdesk_browser_click', clickArgs(seen))).status, 'postcondition-observed')
})

// L1 c34 compliance: with the terminal-opener flag (EGDESK_TERMINAL_OPEN_URL=on) a Browser Card that shows an AI provider's sign-in page is opaque to the Agent.
test('c34: a card on an AI provider\'s sign-in domain cannot be observed, screenshotted, clicked or navigated by an Agent when the flag is on; flag off and other sites are unchanged', async () => {
  const saved = process.env.EGDESK_TERMINAL_OPEN_URL, at = uri => ({ ...source(), sourceRef: { ...source().sourceRef, uri } })
  try {
    for (const url of ['https://claude.com/cai/oauth/authorize?state=s', 'https://platform.claude.com/oauth/code/callback?code=c', 'https://claude.ai/login', 'https://auth.openai.com/log-in']) {
      process.env.EGDESK_TERMINAL_OPEN_URL = 'on'
      const f = fixture('interact', { bindUrl: url }), prepared = f.service.prepare({ selectedSources: [at(url)] })
      await f.service.bind(run, prepared)
      const before = f.requests.length
      for (const tool of ['egdesk_browser_observe', 'egdesk_browser_screenshot']) await assert.rejects(f.service.dispatch(run, { tool, arguments: { cardId: 'browser-1' } }), { code: 'BROWSER_CARD_OPAQUE' }, `${tool} on ${url}`)
      assert.equal(f.requests.length, before, 'nothing was sent to the card')
      delete process.env.EGDESK_TERMINAL_OPEN_URL
      const off = fixture('interact', { bindUrl: url }); await off.service.bind(run, off.service.prepare({ selectedSources: [at(url)] }))
      assert.equal((await off.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })).status, 'observed', 'flag off: as before')
    }
    process.env.EGDESK_TERMINAL_OPEN_URL = 'on'
    const other = fixture('interact', { bindUrl: 'https://example.test/local' }); await other.service.bind(run, other.service.prepare({ selectedSources: [at('https://example.test/local')] }))
    assert.equal((await other.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })).status, 'observed')
  } finally { if (saved === undefined) delete process.env.EGDESK_TERMINAL_OPEN_URL; else process.env.EGDESK_TERMINAL_OPEN_URL = saved }
})

test('navigate with only its destination derives an exact URL assertion, not an authority grant', async () => {
  const f = guardedFixture()
  await f.bind()
  const seen = await f.observe()
  const url = 'https://example.test/?q=fixture'
  const base = { cardId: 'browser-1', observationId: seen.observationId, expectedRevision: seen.snapshot.revision, url }
  const go = patch => f.dispatch('egdesk_browser_navigate', { ...base, ...patch })
  await assert.rejects(go({ postcondition: { kind: 'visible-text', value: 'fixture' } }), { code: 'INVALID_BROWSER_TOOL', invalidBy: 'navigation-postcondition-kind' })
  for (const patch of [{ url: 'file:///tmp' }, { url: 'https://user@example.test/' }, { postcondition: null }, { extra: true }]) await assert.rejects(go(patch), { code: 'INVALID_BROWSER_TOOL' })
  for (const url of ['https://other.test/', 'http://example.test/']) await assert.rejects(go({ url }), { code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' })
  await assert.rejects(go({ expectedRevision: base.expectedRevision + 1 }), { code: 'BROWSER_OBSERVATION_STALE' })
  assert.equal(f.acts().length, 0)
  f.setAct(request => {
    assert.deepEqual(request.postcondition, { kind: 'url', value: url })
    f.current = guardedSnapshot({ documentId: 'document-2', revision: 1, url })
    return f.acted(request, f.current, actorReceipt())
  })
  assert.equal((await go({})).status, 'postcondition-observed')
  assert.equal(f.acts().length, 1)
})

test('only a confirmed fill + observed GET search recovers the navigation lock on a new document with added parameters', async () => {
  for (const [land, form, ok] of [['cat', true, true], ['other', true, false], ['cat', false, false]]) {
    const f = fixture(), cardId = 'browser-1', url = 'https://example.test/?q=cat'
    const field = { ...snapshot().interactiveElements[0], role: 'textbox', tag: 'input', label: '검색' }
    const call = (name, args = {}) => f.service.dispatch(run, { tool: `egdesk_browser_${name}`, arguments: { cardId, ...args } })
    f.setSnapshot(snapshot(3, { interactiveElements: [field] }))
    f.setNavigationAfterNull(true)
    await f.service.bind(run, f.service.prepare({ selectedSources: [source()] }))
    const before = await call('observe')
    const fill = await call('fill', { observationId: before.observationId, expectedRevision: 3, ref: field.ref, expectedTarget: field, text: 'cat', postcondition: { kind: 'target-value', value: 'cat' } })
    assert.equal(fill.status, 'postcondition-observed')
    f.setSnapshot(snapshot(4, { interactiveElements: [{ ...field, value: 'cat' }, { ...snapshot().interactiveElements[0], ref: 'el_2', nav: { type: 'submit', form: { method: form ? 'get' : 'post', fields: ['text'], submitUrl: url } } }] }))
    const typed = await call('observe')
    await call('navigate', { observationId: typed.observationId, expectedRevision: 4, url, postcondition: { kind: 'url', value: url } })
    f.setSnapshot(snapshot(5, { documentId: 'new', url: `https://example.test/?q=${land}&ia=web`, readyState: 'complete' }))
    const after = await call('observe')
    assert.equal(after.navigationPostconditionReobserved, ok)
    assert.equal(Boolean(after.uncertainAction), !ok)
  }
})
