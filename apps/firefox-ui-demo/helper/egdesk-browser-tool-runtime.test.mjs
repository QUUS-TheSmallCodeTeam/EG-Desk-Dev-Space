import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BROWSER_TOOL_SPECS, createBrowserToolService } from './egdesk-browser-tool-runtime.mjs'

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
function fixture(permission = 'interact') {
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
        accountId: 'fixture-account', userContextId: 0, url: 'https://example.test/local',
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
  assert.deepEqual(f.service.specs(prepared).map(item => item.name), ['egdesk_browser_observe'])
  await f.service.bind(run, prepared)
  const observed = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  assert.equal(observed.snapshot.coordinateSpace, 'browser-viewport-local')
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 3,
    ref: 'el_1', expectedTarget: observed.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } }), { code: 'BROWSER_INTERACTION_NOT_GRANTED' })
  assert.equal(f.actionCalls, 0)
  assert.equal(BROWSER_TOOL_SPECS.length, 4)
})

test('fresh observed target dispatches once and returns DOM post-observation, never external success', async () => {
  const f = fixture()
  const prepared = f.service.prepare({ selectedSources: [source()] })
  assert.equal(f.service.specs(prepared).length, 4)
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
    url: 'https://example.com', postcondition: { kind: 'url', value: 'https://example.com' },
  } })
  assert.equal(result.status, 'postcondition-observed')
  assert.equal(result.after.url, 'https://example.com/')
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
  const destination = 'http://127.0.0.1:18181/next'
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
  const destination = 'http://127.0.0.1:18181/expected'
  await f.service.dispatch(run, { tool: 'egdesk_browser_navigate', arguments: {
    cardId: 'browser-1', observationId: before.observationId, expectedRevision: 3,
    url: destination, postcondition: { kind: 'url', value: destination },
  } })
  f.setSnapshot(snapshot(4, { documentId: 'document-2', readyState: 'complete',
    url: 'http://127.0.0.1:18181/unexpected' }))
  const observed = await f.service.dispatch(run, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' } })
  assert.equal(observed.navigationPostconditionReobserved, false)
  await assert.rejects(f.service.dispatch(run, { tool: 'egdesk_browser_click', arguments: {
    cardId: 'browser-1', observationId: observed.observationId, expectedRevision: 4,
    ref: 'el_1', expectedTarget: observed.snapshot.interactiveElements[0],
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } }), { code: 'BROWSER_OUTCOME_UNKNOWN' })
})
