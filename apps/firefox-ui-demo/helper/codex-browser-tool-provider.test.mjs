import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { BrowserToolTransport } from './codex-browser-tool-transport.mjs'
import { createBrowserToolService } from './egdesk-browser-tool-runtime.mjs'
import { classifyPublicToolError } from './codex-tool-errors.mjs'

function fixture() {
  const calls = [], events = []
  const runs = new Map()
  const transport = {
    runs,
    hasClient: id => id === 'ui-stream-1',
    bindRun: (runId, clientThreadId, id) => { calls.push(['bind-transport', runId, clientThreadId, id]); runs.set(runId, id) },
    unbindRun: runId => { calls.push(['unbind-transport', runId]); runs.delete(runId) },
    reset: () => calls.push(['reset-transport']),
  }
  const service = {
    prepare: input => { calls.push(['prepare', input]); return { selectedSources: input.selectedSources,
      cards: new Map([['card-1', { sourceId: input.selectedSources[0].id, cardEpoch: input.selectedSources[0].browserToolIdentity.cardEpoch }]]) } },
    bind: async (run, prepared) => { calls.push(['bind', run.runId, prepared]); return { cards: [{ cardId: 'card-1', permission: prepared.selectedSources[0].browserToolPermission, accountStatus: 'unverified' }] } },
    dispatch: async (run, event) => { calls.push(['dispatch', run.runId, event.tool]); return event.tool === 'egdesk_browser_click'
      ? { status: 'postcondition-unverified', cardId: 'card-1', action: 'click', postcondition: { matched: false }, externalEffectVerified: false }
      : { status: 'observed', cardId: 'card-1', observationId: 'observation-1', snapshot: { cardId: 'card-1' }, externalEffectVerified: false } },
    cancelRun: async run => { calls.push(['cancel', run.runId]); return [] },
    reset: async () => { calls.push(['reset']); return [] },
  }
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => 'codex:account-1', service })
  provider.runtime = { browserRegisteredThreads: new Set(), currentEpoch: () => 7, emit: (run, event, detail) => events.push({ runId: run.runId, event, detail }) }
  return { provider, calls, events, transport }
}

const selected = permission => [{ id: 'source-1', kind: 'browser', selectedByUser: true, browserToolPermission: permission,
  browserToolSelection: { token: 'one-time-token', threadId: 'ui-thread-1' }, browserToolIdentity: { cardEpoch: 'epoch-1' }, sourceRef: { viewId: 'card-1' } }]

test('QA Browser preparation requires an original observe selection and a live UI stream', async () => {
  const f = fixture()
  assert.throws(() => f.provider.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: null, browserTransportId: 'ui-stream-1' }), error => error.code === 'BROWSER_POLICY_REQUIRED')
  assert.throws(() => f.provider.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'readOnlyQa', browserTransportId: 'stale' }), error => error.code === 'BROWSER_UI_UNAVAILABLE')
  assert.throws(() => f.provider.prepare({ selectedSources: selected('observe'), clientThreadId: 'another-thread', effectiveExecutionPolicy: 'readOnlyQa', browserTransportId: 'ui-stream-1' }), error => error.code === 'INVALID_BROWSER_SELECTION')
  assert.throws(() => f.provider.prepare({ selectedSources: selected('interact'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'readOnlyQa', browserTransportId: 'ui-stream-1' }), error => error.code === 'BROWSER_INTERACTION_NOT_GRANTED')
  const prepared = f.provider.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'readOnlyQa', browserTransportId: 'ui-stream-1' })
  assert.equal(prepared.selection.selectedSources[0].browserToolPermission, 'observe')
  assert.equal(prepared.selection.selectedSources[0].id, 'source-1')
  assert.equal(prepared.selection.selectedSources[0].browserToolSelection.token, 'one-time-token')
  assert.equal(f.provider.specs().length, 7)
  assert.throws(() => f.provider.requireThread('old-native', prepared), error => error.code === 'BROWSER_TOOLS_UNAVAILABLE')
  f.provider.registerThread('new-native')
  f.provider.requireThread('new-native', prepared)
  const run = { answerId: 'new-native/turn-1', runId: 'turn-1', clientThreadId: 'ui-thread-1', status: 'inProgress' }
  await f.provider.bindRun(run, prepared)
  assert.equal(run.browserBinding.cards[0].permission, 'observe')
  assert.equal(run.browserBinding.cards[0].sourceId, 'source-1')
  assert.equal(run.browserBinding.cards[0].cardEpoch, 'epoch-1')
  assert.ok(f.events.some(event => event.event === 'browser.bound'))
  const response = await f.provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'call-1', arguments: { cardId: 'card-1' } })
  assert.equal(response.success, true)
  assert.equal(JSON.parse(response.contentItems[0].text).observationId, 'observation-1')
  assert.equal(f.events.find(event => event.event === 'browser.tool.completed').detail.externalEffectVerified, false)
  assert.equal(f.events.find(event => event.event === 'browser.tool.completed').detail.originalProviderId, 'egdesk-browser')
  assert.equal(f.events.find(event => event.event === 'browser.tool.completed').detail.targetCardEpoch, 'epoch-1')
  const unverified = await f.provider.dispatch(run, { tool: 'egdesk_browser_click', callId: 'call-2', arguments: { cardId: 'card-1' } })
  assert.equal(unverified.success, false)
  assert.equal(f.events.find(event => event.event === 'browser.tool.unverified').detail.postconditionMatched, false)
  await f.provider.cancelRun(run)
  assert.equal(f.transport.runs.size, 0)
  assert.equal(f.events.find(event => event.event === 'browser.cancel.requested').detail.cards[0].sourceId, 'source-1')
  assert.equal(JSON.stringify(f.events).includes('one-time-token'), false)
})

test('BrowserBounded accepts a single explicit current-turn interaction selection, not a thread-wide grant', async () => {
  const f = fixture()
  assert.throws(() => f.provider.prepare({ selectedSources: selected('interact'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' }), error => error.code === 'INVALID_BROWSER_SELECTION')
  const prepared = f.provider.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' })
  assert.equal(prepared.selection.selectedSources[0].browserToolPermission, 'observe')
  assert.equal(prepared.interactionRequested, false)
  assert.equal(f.provider.prepare({ effectiveExecutionPolicy: 'browserBounded' }), null)
  const source = { ...selected('interact')[0], sourceRef: { viewId: 'card-1', uri: 'https://example.test/owned-page' } }
  assert.throws(() => f.provider.prepare({ selectedSources: [source, { ...source, id: 'source-2' }], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' }), error => error.code === 'INVALID_BROWSER_SELECTION')
  const interacting = f.provider.prepare({ selectedSources: [source], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' })
  assert.equal(interacting.interactionRequested, true)
  const run = { answerId: 'native/turn-1', runId: 'turn-1', clientThreadId: 'ui-thread-1', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  await f.provider.bindRun(run, interacting)
  await f.provider.dispatch(run, { tool: 'egdesk_browser_click', callId: 'click', arguments: { cardId: 'card-1' } })
  assert.ok(f.calls.some(call => call[0] === 'dispatch' && call[1] === 'turn-1' && call[2] === 'egdesk_browser_click'))
  const before = f.calls.filter(call => call[0] === 'dispatch').length
  // Navigation is now a granted guarded tool; its same-site scope is enforced
  // by the B service against the live observation, not by this name gate.
  await f.provider.dispatch(run, { tool: 'egdesk_browser_navigate', callId: 'navigate', arguments: { cardId: 'card-1' } })
  const unlisted = await f.provider.dispatch(run, { tool: 'egdesk_browser_hover', callId: 'hover', arguments: { cardId: 'card-1' } })
  const foreign = await f.provider.dispatch(run, { tool: 'egdesk_browser_fill', callId: 'foreign', arguments: { cardId: 'card-other' } })
  const later = { ...run, answerId: 'native/turn-2', runId: 'turn-2', browserBinding: undefined }
  await f.provider.bindRun(later, null)
  const inherited = await f.provider.dispatch(later, { tool: 'egdesk_browser_click', callId: 'inherited', arguments: { cardId: 'card-1' } })
  assert.equal(unlisted.success, false)
  assert.equal(foreign.success, false)
  assert.equal(inherited.success, false)
  assert.deepEqual(f.calls.filter(call => call[0] === 'dispatch').slice(before).map(call => call[2]), ['egdesk_browser_navigate'])
})

test('unverified native dynamic-tool schema exposes no Browser specs or selected Card authority', () => {
  const f = fixture()
  const blocked = createCodexBrowserToolProvider({ transport: f.transport, getOwnerKey: () => 'codex:account-1', schemaReady: () => false,
    service: { prepare: () => { throw new Error('must not prepare') } } })
  assert.deepEqual(blocked.specs(), [])
  assert.throws(() => blocked.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' }), error => error.code === 'BROWSER_TOOLS_UNAVAILABLE')
})

test('fixtureBrowserQa requires opted-in exact local Card, live marker observation and bounded button action', async () => {
  const f = fixture()
  const fixtureQa = { url: 'http://127.0.0.1:43210/egdesk-qa/fixture_7f41ad982b6903ab', marker: 'EGDESK_FIXTURE_MARKER_94ab7d28' }
  const original = selected('interact')[0]
  const source = { ...original, sourceRef: { ...original.sourceRef, accountId: '', uri: fixtureQa.url } }
  let actions = 0, cancelled = 0
  const snapshot = { cardId: 'card-1', url: fixtureQa.url, text: [fixtureQa.marker, 'Count: 0'] }
  const service = {
    prepare: () => ({ cards: new Map([['card-1', { sourceId: source.id, cardEpoch: 'epoch-1' }]]) }),
    bind: async () => ({ cards: [{ cardId: 'card-1', permission: 'interact' }] }),
    dispatch: async (run, event) => event.tool === 'egdesk_browser_observe'
      ? { status: 'observed', cardId: 'card-1', observationId: 'observation-1', snapshot }
      : (actions++, { status: 'postcondition-observed', cardId: 'card-1', action: 'click', after: { ...snapshot, text: [fixtureQa.marker, 'Count: 1'] }, postcondition: { matched: true }, externalEffectVerified: false }),
    cancelRun: async () => { cancelled++; return [] }, reset: async () => [],
  }
  const unavailable = createCodexBrowserToolProvider({ transport: f.transport, getOwnerKey: () => 'codex:account-1', service })
  assert.throws(() => unavailable.prepare({ selectedSources: [source], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'fixtureBrowserQa', browserTransportId: 'ui-stream-1' }), error => error.code === 'BROWSER_FIXTURE_UNAVAILABLE')
  const provider = createCodexBrowserToolProvider({ transport: f.transport, getOwnerKey: () => 'codex:account-1', fixtureQa, service })
  provider.runtime = { browserRegisteredThreads: new Set(), currentEpoch: () => 11, emit: (run, event, detail) => f.events.push({ event, detail }) }
  assert.throws(() => provider.prepare({ selectedSources: [{ ...source, sourceRef: { ...source.sourceRef, uri: 'https://example.com/' } }], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'fixtureBrowserQa', browserTransportId: 'ui-stream-1' }), error => error.code === 'BROWSER_FIXTURE_UNAVAILABLE')
  const prepared = provider.prepare({ selectedSources: [source], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'fixtureBrowserQa', browserTransportId: 'ui-stream-1' })
  const run = { answerId: 'thread/turn', runId: 'turn', clientThreadId: 'ui-thread-1', status: 'inProgress', executionPolicy: { mode: 'fixtureBrowserQa' } }
  await provider.bindRun(run, prepared)
  const beforeObserve = await provider.dispatch(run, { tool: 'egdesk_browser_click', callId: 'early-click', arguments: { cardId: 'card-1' } })
  assert.equal(beforeObserve.success, false)
  assert.equal(actions, 0)
  const observed = await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'observe', arguments: { cardId: 'card-1' } })
  assert.equal(observed.success, true)
  const clicked = await provider.dispatch(run, { tool: 'egdesk_browser_click', callId: 'click', arguments: { cardId: 'card-1', expectedTarget: { tag: 'button', href: '' }, postcondition: { kind: 'visible-text', value: 'Count: 1' } } })
  assert.equal(clicked.success, true)
  assert.equal(actions, 1)
  const navigate = await provider.dispatch(run, { tool: 'egdesk_browser_navigate', callId: 'navigate', arguments: { cardId: 'card-1' } })
  assert.equal(navigate.success, false)
  assert.equal(actions, 1)
  snapshot.text = ['The selected Card is no longer the owned fixture']
  const staleObservation = await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'observe-stale', arguments: { cardId: 'card-1' } })
  assert.equal(staleObservation.success, false)
  const afterFailedAttestation = await provider.dispatch(run, { tool: 'egdesk_browser_click', callId: 'click-after-stale', arguments: {
    cardId: 'card-1', expectedTarget: { tag: 'button', href: '' }, postcondition: { kind: 'visible-text', value: 'Count: 2' },
  } })
  assert.equal(afterFailedAttestation.success, false)
  assert.equal(actions, 1)
  await provider.cancelRun(run)
  assert.ok(cancelled >= 1)
})

test('unknown Browser service diagnostics are replaced with fixed public classifications', async () => {
  const sentinel = 'RAW_BROWSER_SENTINEL_b904'
  const f = fixture()
  const failingPrepare = createCodexBrowserToolProvider({ transport: f.transport, getOwnerKey: () => 'codex:account-1',
    service: { prepare: () => { throw Object.assign(new Error(sentinel), { code: sentinel }) } } })
  assert.throws(() => failingPrepare.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' }), error => error.code === 'BROWSER_TOOL_FAILED' && !error.message.includes(sentinel))
  const failingDispatch = createCodexBrowserToolProvider({ transport: f.transport, getOwnerKey: () => 'codex:account-1',
    service: { prepare: () => ({}), bind: async () => ({ cards: [] }), dispatch: async () => { throw new Error(sentinel) }, cancelRun: async () => [], reset: async () => [] } })
  failingDispatch.runtime = { browserRegisteredThreads: new Set(), emit: (run, event, detail) => f.events.push({ event, detail }) }
  const prepared = failingDispatch.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' })
  const run = { answerId: 'thread/turn', runId: 'turn', clientThreadId: 'ui-thread-1', status: 'inProgress' }
  await failingDispatch.bindRun(run, prepared)
  const response = await failingDispatch.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'call-1', arguments: { cardId: sentinel } })
  assert.equal(response.success, false)
  assert.equal(JSON.stringify({ response, events: f.events, run }).includes(sentinel), false)
})

test('actual Browser provider, actual B service and actual targeted transport bind/observe/cancel together', async () => {
  const owner = 'codex:chatgpt:fixture-owner'
  const transport = new BrowserToolTransport({ getOwnerKey: () => owner })
  const sent = [], events = []
  let transportId
  const client = { chatProtocol: 2, closed: false, send(frame) {
    const request = JSON.parse(frame.split('data: ')[1])
    sent.push(request)
    queueMicrotask(() => {
      const response = request.kind === 'bind' ? { requestId: request.requestId, status: 'bound', binding: {
        cardId: 'card-1', cardEpoch: 'epoch-1', profileId: 'firefox-default', accountId: 'fixture-account',
        userContextId: 0, url: 'https://example.test/local', engineAccountKey: 'codex:chatgpt:fixture-owner', authorityEpoch: 1,
      } } : request.kind === 'observe' ? { requestId: request.requestId, status: 'observed', snapshot: {
        cardId: 'card-1', documentId: 'document-1', revision: 1, viewport: { width: 720, height: 480, devicePixelRatio: 1 },
        url: 'https://example.test/local', text: ['Fixture'], interactiveElements: [],
      } } : { requestId: request.requestId, status: 'cancelled' }
      transport.receive(transportId, response)
    })
    return true
  } }
  transportId = transport.registerClient(client)
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => owner })
  provider.runtime = { browserRegisteredThreads: new Set(['native-thread']), currentEpoch: () => 9,
    emit: (run, event, detail) => events.push({ runId: run.runId, event, detail }) }
  const source = { id: 'source-1', kind: 'browser', selectedByUser: true, browserToolPermission: 'observe',
    browserToolSelection: { token: 'one-time-token', threadId: 'ui-thread-1' },
    browserToolIdentity: { cardEpoch: 'epoch-1', userContextId: 0, engineAccountKey: owner, authorityEpoch: 1 },
    sourceRef: { viewId: 'card-1', profileId: 'firefox-default', accountId: 'fixture-account', uri: 'https://example.test/local' } }
  const prepared = provider.prepare({ selectedSources: [source], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: transportId })
  const run = { answerId: 'native-thread/native-turn', runId: 'native-turn', clientThreadId: 'ui-thread-1', status: 'inProgress' }
  await provider.bindRun(run, prepared)
  const observed = await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'native-call-1', arguments: { cardId: 'card-1' }, namespace: null })
  assert.equal(observed.success, true)
  assert.equal(JSON.parse(observed.contentItems[0].text).snapshot.cardId, 'card-1')
  await provider.cancelRun(run)
  assert.deepEqual(sent.map(request => request.kind), ['bind', 'observe', 'cancel'])
  assert.ok(sent.every(request => request.clientThreadId === 'ui-thread-1' && request.runId === 'native-turn' && request.targetCardEpoch === 'epoch-1'))
  assert.equal(sent[0].selection.sourceId, 'source-1')
  assert.equal(sent[2].selectionToken, 'one-time-token')
  assert.equal(transport.runs.size, 0)
  assert.equal(events.find(event => event.event === 'browser.tool.completed').detail.originalProviderId, 'egdesk-browser')
})

test('actual provider, B service and transport permit only an attested local fixture button effect', async () => {
  const owner = 'codex:chatgpt:fixture-owner'
  const fixtureQa = { url: 'http://127.0.0.1:43210/egdesk-qa/fixture_7f41ad982b6903ab', marker: 'EGDESK_FIXTURE_MARKER_94ab7d28' }
  const transport = new BrowserToolTransport({ getOwnerKey: () => owner })
  const sent = []
  let transportId, revision = 1
  const element = { ref: 'el_1', role: 'button', label: 'Increment', href: '', value: '', tag: 'button', disabled: false,
    bounds: { x: 10, y: 10, width: 80, height: 30 } }
  const snapshot = count => ({ cardId: 'card-1', documentId: 'document-1', revision,
    coordinateSpace: 'browser-viewport-local', viewport: { width: 720, height: 480, devicePixelRatio: 1 },
    url: fixtureQa.url, title: 'Owned QA fixture', text: [fixtureQa.marker, `Count: ${count}`], interactiveElements: [element] })
  const client = { chatProtocol: 2, closed: false, send(frame) {
    const request = JSON.parse(frame.split('data: ')[1])
    sent.push(request)
    queueMicrotask(() => {
      let response
      if (request.kind === 'bind') response = { requestId: request.requestId, status: 'bound', binding: {
        cardId: 'card-1', cardEpoch: 'epoch-1', profileId: 'firefox-default', accountId: '', userContextId: 0,
        url: fixtureQa.url, engineAccountKey: owner, authorityEpoch: 1,
      } }
      else if (request.kind === 'observe') response = { requestId: request.requestId, status: 'observed', snapshot: snapshot(0) }
      else if (request.kind === 'act') { revision = 2; response = { requestId: request.requestId, status: 'acted', receipt: {
        dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true,
          clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true },
        after: snapshot(1), observation: { visibleTextChanged: true },
      } } }
      else response = { requestId: request.requestId, status: 'cancelled' }
      transport.receive(transportId, response)
    })
    return true
  } }
  transportId = transport.registerClient(client)
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => owner, fixtureQa })
  const events = []
  provider.runtime = { browserRegisteredThreads: new Set(['native-thread']), currentEpoch: () => 12,
    emit: (run, event, detail) => events.push({ event, detail }) }
  const source = { id: 'source-1', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    browserToolSelection: { token: 'one-time-token', threadId: 'ui-thread-1' },
    browserToolIdentity: { cardEpoch: 'epoch-1', userContextId: 0, engineAccountKey: owner, authorityEpoch: 1 },
    sourceRef: { viewId: 'card-1', profileId: 'firefox-default', accountId: '', uri: fixtureQa.url } }
  assert.throws(() => provider.prepare({ selectedSources: [{ ...source, sourceRef: { ...source.sourceRef, uri: 'https://production.example/' } }],
    clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'fixtureBrowserQa', browserTransportId: transportId }), error => error.code === 'BROWSER_FIXTURE_UNAVAILABLE')
  assert.equal(sent.length, 0)
  const prepared = provider.prepare({ selectedSources: [source], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'fixtureBrowserQa', browserTransportId: transportId })
  const run = { answerId: 'native-thread/native-turn', runId: 'native-turn', clientThreadId: 'ui-thread-1', status: 'inProgress', executionPolicy: { mode: 'fixtureBrowserQa' } }
  await provider.bindRun(run, prepared)
  const observation = await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'observe-1', arguments: { cardId: 'card-1' } })
  assert.equal(observation.success, true)
  const observed = JSON.parse(observation.contentItems[0].text)
  const action = await provider.dispatch(run, { tool: 'egdesk_browser_click', callId: 'click-1', arguments: {
    cardId: 'card-1', observationId: observed.observationId, expectedRevision: 1, ref: 'el_1', expectedTarget: element,
    postcondition: { kind: 'visible-text', value: 'Count: 1' },
  } })
  assert.equal(action.success, true)
  assert.equal(JSON.parse(action.contentItems[0].text).status, 'postcondition-observed')
  const forbidden = await provider.dispatch(run, { tool: 'egdesk_browser_navigate', callId: 'navigate-1', arguments: { cardId: 'card-1' } })
  assert.equal(forbidden.success, false)
  await provider.cancelRun(run)
  assert.deepEqual(sent.map(request => request.kind), ['bind', 'observe', 'act', 'cancel'])
  assert.ok(sent.every(request => request.clientThreadId === 'ui-thread-1' && request.targetCardEpoch === 'epoch-1'))
  assert.equal(sent[3].selectionToken, 'one-time-token')
  assert.equal(events.find(event => event.event === 'browser.tool.completed' && event.detail.action === 'click').detail.externalEffectVerified, false)
})

test('BrowserBounded interaction grants navigate, scroll, press and wait through the actual B service scope checks', async () => {
  const owner = 'codex:chatgpt:fixture-owner'
  const sent = [], events = []
  let page = { cardId: 'card-1', documentId: 'document-1', revision: 1, readyState: 'complete',
    viewport: { width: 720, height: 480, devicePixelRatio: 1 }, scroll: { x: 0, y: 0, maxY: 900 },
    url: 'https://example.test/owned-page', text: ['Owned'], focusedElement: null, interactiveElements: [] }
  const sendToUi = async request => {
    sent.push(request)
    if (request.kind === 'bind') return { requestId: request.requestId, status: 'bound', binding: {
      cardId: 'card-1', cardEpoch: 'epoch-1', profileId: 'firefox-default', accountId: 'fixture-account',
      userContextId: 0, url: 'https://example.test/owned-page', engineAccountKey: owner, authorityEpoch: 1 } }
    if (request.kind === 'observe') return { requestId: request.requestId, status: 'observed',
      snapshot: request.options?.wait ? { ...page, wait: { for: request.options.wait.for, outcome: 'met', elapsedMs: 4 } } : page }
    if (request.kind === 'act' && request.action.type === 'scroll') {
      page = { ...page, scroll: { x: 0, y: 432, maxY: 900 } }
      return { requestId: request.requestId, status: 'acted', receipt: { after: page, observation: {},
        dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true,
          inputRoute: 'dom-scroll-api', scrollMode: 'document' } } }
    }
    if (request.kind === 'cancel') return { requestId: request.requestId, status: 'cancelled' }
    throw new Error('unexpected UI request')
  }
  const transport = { runs: new Map(), hasClient: id => id === 'ui-stream-1', bindRun: runId => transport.runs.set(runId, true),
    unbindRun: runId => transport.runs.delete(runId), reset() {} }
  const service = createBrowserToolService({ sendToUi, getOwnerKey: () => owner })
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => owner, service })
  provider.runtime = { browserRegisteredThreads: new Set(['native-thread']), currentEpoch: () => 3,
    emit: (run, event, detail) => events.push({ event, detail }) }
  const source = { id: 'source-1', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    browserToolSelection: { token: 'one-time-token', threadId: 'ui-thread-1' },
    browserToolIdentity: { cardEpoch: 'epoch-1', userContextId: 0, engineAccountKey: owner, authorityEpoch: 1 },
    sourceRef: { viewId: 'card-1', profileId: 'firefox-default', accountId: 'fixture-account', uri: 'https://example.test/owned-page' } }
  const prepared = provider.prepare({ selectedSources: [source], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' })
  const run = { answerId: 'native-thread/turn', runId: 'turn', clientThreadId: 'ui-thread-1', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  await provider.bindRun(run, prepared)
  const parse = response => JSON.parse(response.contentItems[0].text)
  let observed = parse(await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'observe-1', arguments: { cardId: 'card-1' } }))
  const outside = await provider.dispatch(run, { tool: 'egdesk_browser_navigate', callId: 'navigate-out', arguments: {
    cardId: 'card-1', observationId: observed.observationId, expectedRevision: 1, url: 'https://elsewhere.test/',
    postcondition: { kind: 'url', value: 'https://elsewhere.test/' } } })
  assert.equal(outside.success, false)
  assert.equal(parse(outside).error.code, classifyPublicToolError({ code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' }, { browser: true }).code)
  assert.equal(sent.filter(request => request.kind === 'act').length, 0)
  const scrolled = await provider.dispatch(run, { tool: 'egdesk_browser_scroll', callId: 'scroll-1', arguments: {
    cardId: 'card-1', observationId: observed.observationId, expectedRevision: 1, direction: 'down' } })
  assert.equal(scrolled.success, true)
  assert.equal(parse(scrolled).scroll.after.y, 432)
  assert.equal(events.find(event => event.detail.action === 'scroll').detail.inputRoute, 'dom-scroll-api')
  const waited = await provider.dispatch(run, { tool: 'egdesk_browser_wait', callId: 'wait-1', arguments: { cardId: 'card-1', for: 'idle', timeoutMs: 2000 } })
  assert.equal(waited.success, true)
  assert.equal(parse(waited).status, 'wait-condition-met')
  observed = parse(waited)
  const unfocused = await provider.dispatch(run, { tool: 'egdesk_browser_press', callId: 'press-1', arguments: {
    cardId: 'card-1', observationId: observed.observationId, expectedRevision: 1, ref: 'el_1',
    expectedTarget: { ref: 'el_1', role: 'textbox', label: 'Search', href: '', value: '', tag: 'input' }, key: 'Escape' } })
  assert.equal(unfocused.success, false, 'press reaches the B service, which applies its own target and focus checks')
  assert.deepEqual(sent.filter(request => request.kind === 'act').map(request => request.action.type), ['scroll'])
  await provider.cancelRun(run)
})

test('read-only grants and fixture QA still refuse the new guarded tools before the B service', async () => {
  const f = fixture()
  const prepared = f.provider.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' })
  const run = { answerId: 'native/turn-ro', runId: 'turn-ro', clientThreadId: 'ui-thread-1', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  await f.provider.bindRun(run, prepared)
  for (const tool of ['egdesk_browser_navigate', 'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait']) {
    const response = await f.provider.dispatch(run, { tool, callId: `ro-${tool}`, arguments: { cardId: 'card-1' } })
    assert.equal(response.success, false, tool)
    assert.equal(JSON.parse(response.contentItems[0].text).error.code, 'BROWSER_INTERACTION_NOT_GRANTED', tool)
  }
  const fixtureRun = { ...run, answerId: 'native/turn-fx', runId: 'turn-fx', executionPolicy: { mode: 'fixtureBrowserQa' } }
  for (const tool of ['egdesk_browser_navigate', 'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait']) {
    const response = await f.provider.dispatch(fixtureRun, { tool, callId: `fx-${tool}`, arguments: { cardId: 'card-1' } })
    assert.equal(response.success, false, tool)
  }
  assert.equal(f.calls.filter(call => call[0] === 'dispatch').length, 0)
})
