import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BROWSER_TOOL_SPECS, createBrowserToolService } from './egdesk-browser-tool-runtime.mjs'

const run = { answerId: 'answer-1', runId: 'run-1', status: 'inProgress' }
function source(permission = 'interact', cardId = 'browser-1') {
  return { kind: 'browser', selectedByUser: true, browserToolPermission: permission,
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
function fixture(permission = 'interact') {
  let owner = 'engine-account-1'
  let current = snapshot()
  let actionCalls = 0
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
      if (request.action.type === 'click') current = snapshot(4, { text: ['Count: 1'] })
      if (request.action.type === 'fill') current = snapshot(4, { interactiveElements: [
        { ...current.interactiveElements[0], value: request.action.text, role: 'textbox', tag: 'input' }] })
      if (request.action.type === 'navigate') current = snapshot(4, { url: request.action.url })
      return { requestId: request.requestId, status: 'acted',
        receipt: { dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true },
          after: current, observation: { visibleTextChanged: request.action.type === 'click' } } }
    }
    throw new Error('unexpected UI request')
  }
  const service = createBrowserToolService({ sendToUi, getOwnerKey: () => owner })
  const nativeDispatch = service.dispatch
  let callSequence = 0
  service.dispatch = (boundRun, event) => nativeDispatch(boundRun,
    { ...event, callId: event.callId || `fixture-call-${++callSequence}` })
  return { service, requests, setOwner: value => { owner = value }, setSnapshot: value => { current = value },
    get actionCalls() { return actionCalls }, permission }
}

test('only explicitly selected Browser sources expose tools; read-only never grants actions', async () => {
  const f = fixture('observe')
  assert.equal(f.service.specs().length, 0)
  assert.throws(() => f.service.prepare({ selectedSources: [{ ...source('observe'), selectedByUser: false }] }),
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
