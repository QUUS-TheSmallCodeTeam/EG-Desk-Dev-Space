import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { BrowserToolTransport } from './codex-browser-tool-transport.mjs'
import { boundedFieldValue, createBrowserToolService } from './egdesk-browser-tool-runtime.mjs'
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
  assert.equal(f.provider.specs().length, 16)
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
  // BRW-07 / BRW-11: several explicitly granted Cards may share one run, but
  // an interact Card the person did not pick is still refused.
  assert.throws(() => f.provider.prepare({ selectedSources: [source, { ...source, id: 'source-2', selectedByUser: false }], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' }), error => error.code === 'INVALID_BROWSER_SELECTION')
  assert.throws(() => f.provider.prepare({ selectedSources: [1, 2, 3, 4, 5].map(n => ({ ...source, id: `source-${n}`, sourceRef: { viewId: `card-${n}`, uri: 'https://example.test/' } })), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' }), error => error.code === 'INVALID_BROWSER_SELECTION')
  assert.equal(f.provider.prepare({ selectedSources: [source, { ...source, id: 'source-2', sourceRef: { viewId: 'card-2', uri: 'https://example.test/other' } }], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' }).interactionRequested, true)
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

test('Codex transport records parent and lease refusals without copying free text into the failure event', async () => {
  const owner = 'codex:chatgpt:fixture-owner', events = []
  const transport = new BrowserToolTransport({ getOwnerKey: () => owner })
  let transportId, refusal
  const url = 'https://example.test/'
  const client = { chatProtocol: 2, closed: false, send(frame) {
    const request = JSON.parse(frame.split('data: ')[1])
    const reply = request.kind === 'bind' ? { status: 'bound', binding: { cardId: 'card-1', cardEpoch: 'epoch-1', profileId: 'firefox-default',
      accountId: '', userContextId: 0, url, engineAccountKey: owner, authorityEpoch: 1 } }
      : request.kind === 'observe' ? { status: 'observed', snapshot: { cardId: 'card-1', documentId: 'doc', revision: 1,
        url, text: [], interactiveElements: [], viewport: { width: 720, height: 480, devicePixelRatio: 1 } } }
      : request.kind === 'act' ? { status: 'rejected', dispatchPhase: 'not-dispatched', timing: {}, ...refusal } : { status: 'cancelled' }
    queueMicrotask(() => transport.receive(transportId, { requestId: request.requestId, ...reply }))
    return true
  } }
  transportId = transport.registerClient(client)
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => owner })
  provider.runtime = { browserRegisteredThreads: new Set(['native-thread']), currentEpoch: () => 1, emit: (_run, event, detail) => events.push({ event, detail }) }
  const source = { ...selected('interact')[0], browserToolIdentity: { cardEpoch: 'epoch-1', userContextId: 0, engineAccountKey: owner, authorityEpoch: 1 },
    sourceRef: { viewId: 'card-1', profileId: 'firefox-default', accountId: '', uri: url } }
  const run = { answerId: 'native-thread/native-turn', runId: 'native-turn', clientThreadId: 'ui-thread-1', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  await provider.bindRun(run, provider.prepare({ selectedSources: [source], clientThreadId: run.clientThreadId, effectiveExecutionPolicy: 'browserBounded', browserTransportId: transportId }))
  for (const [word, lease, want] of [['missing-authorizer', null, 'missing-authorizer'], ['ui-denied', 'selection-run-mismatch', 'selection-run-mismatch'], ['private-text', 'private-text', undefined]]) {
    refusal = { error: 'Browser action authority was revoked before input [' + word + ']', inputDeniedBy: lease }
    const obs = await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'obs-' + word, arguments: { cardId: 'card-1' } })
    const { observationId } = JSON.parse(obs.contentItems[0].text)
    const result = await provider.dispatch(run, { tool: 'egdesk_browser_navigate', callId: 'act-' + events.length, arguments: { cardId: 'card-1', observationId,
      expectedRevision: 1, url: url + 'next', postcondition: { kind: 'url', value: url + 'next' } } })
    const { error } = JSON.parse(result.contentItems[0].text)
    assert.deepEqual([error.code, error.staleBy, error.inputDeniedBy], ['BROWSER_OBSERVATION_STALE', 'input-authority', want])
    const { detail } = events.filter(e => e.event === 'browser.tool.failed').at(-1)
    assert.deepEqual([detail.originalProviderId, detail.staleBy, detail.inputDeniedBy], ['egdesk-browser', 'input-authority', want])
    assert.ok(!JSON.stringify(detail).includes('private-text'))
  }
  await provider.cancelRun(run)
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

test('BrowserBounded fill reaches a same-origin frame editor and reports only its fixed fill route', async () => {
  const owner = 'codex:chatgpt:fixture-owner'
  const sent = [], events = []
  const editor = { ref: 'f1/el_4', role: 'textbox', label: 'Message body', href: '', tag: 'div', disabled: false,
    value: boundedFieldValue('', { editor: true }), bounds: { x: 210, y: 140, width: 300, height: 120 } }
  let page = { cardId: 'card-1', documentId: 'document-1', revision: 1, readyState: 'complete',
    viewport: { width: 720, height: 480, devicePixelRatio: 1 }, scroll: { x: 0, y: 0, maxY: 0 },
    url: 'https://example.test/mail', text: ['Compose'], focusedElement: null, interactiveElements: [editor],
    inaccessibleFrames: [{ label: 'Payment', reason: 'cross-origin', bounds: { x: 0, y: 300, width: 200, height: 100 } }] }
  let route = 'dom-editor-replace'
  const sendToUi = async request => {
    sent.push(request)
    if (request.kind === 'bind') return { requestId: request.requestId, status: 'bound', binding: {
      cardId: 'card-1', cardEpoch: 'epoch-1', profileId: 'firefox-default', accountId: 'fixture-account',
      userContextId: 0, url: 'https://example.test/mail', engineAccountKey: owner, authorityEpoch: 1 } }
    if (request.kind === 'observe') return { requestId: request.requestId, status: 'observed', snapshot: page }
    if (request.kind === 'act' && request.action.type === 'fill') {
      page = { ...page, interactiveElements: [{ ...editor, value: boundedFieldValue(request.action.text, { editor: true }) }] }
      return { requestId: request.requestId, status: 'acted', receipt: { after: page, observation: {},
        dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true,
          ...(route ? { inputRoute: route, trustedInput: false, eventOrder: ['beforeinput', 'input'] } : {}) } } }
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
    sourceRef: { viewId: 'card-1', profileId: 'firefox-default', accountId: 'fixture-account', uri: 'https://example.test/mail' } }
  const prepared = provider.prepare({ selectedSources: [source], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' })
  const run = { answerId: 'native-thread/turn', runId: 'turn', clientThreadId: 'ui-thread-1', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  await provider.bindRun(run, prepared)
  const parse = response => JSON.parse(response.contentItems[0].text)
  const fill = async (callId, text) => {
    const observed = parse(await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: `observe-${callId}`, arguments: { cardId: 'card-1' } }))
    return provider.dispatch(run, { tool: 'egdesk_browser_fill', callId, arguments: { cardId: 'card-1',
      observationId: observed.observationId, expectedRevision: 1, ref: 'f1/el_4',
      expectedTarget: observed.snapshot.interactiveElements[0], text, postcondition: { kind: 'target-value', value: text } } })
  }
  const text = `Hello team. ${'Status update. '.repeat(40)}`
  const filled = await fill('fill-1', text)
  assert.equal(filled.success, true)
  assert.equal(parse(filled).status, 'postcondition-observed')
  const completed = events.filter(event => event.event === 'browser.tool.completed').at(-1).detail
  assert.equal(completed.action, 'fill')
  assert.equal(completed.inputRoute, 'dom-editor-replace')
  assert.equal(JSON.stringify(completed).includes('Status update'), false, 'the run event carries no fill text')
  route = null
  const unrouted = await fill('fill-2', 'Short reply')
  assert.equal(unrouted.success, true, 'until the surface forwards the fill route, the readback alone decides')
  assert.equal(events.filter(event => event.event === 'browser.tool.completed').at(-1).detail.inputRoute, undefined)
  assert.deepEqual(sent.filter(request => request.kind === 'act').map(request => request.action.ref), ['f1/el_4', 'f1/el_4'])
  await provider.cancelRun(run)
})

test('wait_text is a read tool: an observe grant reaches the B service with it, fixture QA does not', async () => {
  const f = fixture()
  const prepared = f.provider.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' })
  const run = { answerId: 'native/turn-wt', runId: 'turn-wt', clientThreadId: 'ui-thread-1', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  await f.provider.bindRun(run, prepared)
  const waited = await f.provider.dispatch(run, { tool: 'egdesk_browser_wait_text', callId: 'wt-1',
    arguments: { cardId: 'card-1', text: 'Order confirmed', timeoutMs: 2000 } })
  assert.equal(waited.success, true)
  assert.deepEqual(f.calls.filter(call => call[0] === 'dispatch').map(call => call[2]), ['egdesk_browser_wait_text'])
  const fixtureRun = { ...run, answerId: 'native/turn-wt-fx', runId: 'turn-wt-fx', executionPolicy: { mode: 'fixtureBrowserQa' } }
  const refused = await f.provider.dispatch(fixtureRun, { tool: 'egdesk_browser_wait_text', callId: 'wt-fx',
    arguments: { cardId: 'card-1', text: 'Order confirmed', timeoutMs: 2000 } })
  assert.equal(refused.success, false)
  assert.equal(f.calls.filter(call => call[0] === 'dispatch').length, 1)
})

test('a failed Browser call shows only fixed facts beside the public code: sent or not, what covered it, dialog type', async () => {
  const f = fixture()
  const run = { answerId: 'native/turn-err', runId: 'turn-err', clientThreadId: 'ui-thread-1', status: 'inProgress',
    browserBinding: { cards: [{ cardId: 'card-1', permission: 'interact' }] } }
  const parse = response => JSON.parse(response.contentItems[0].text).error
  for (const [thrown, expected] of [
    [Object.assign(new Error('Browser target is obscured by div#cookie-consent role=dialog ref=el_7; observe again We use cookies'),
      { code: 'BROWSER_OBSERVATION_STALE', dispatchPhase: 'not-dispatched', dispatched: false, obscuredBy: 'div#cookie-consent role=dialog ref=el_7' }),
    { code: 'BROWSER_OBSERVATION_STALE', dispatchPhase: 'not-dispatched', dispatched: false, obscuredBy: 'div#cookie-consent role=dialog ref=el_7' }],
    [Object.assign(new Error('raw'), { code: 'BROWSER_UI_TIMEOUT', dispatchPhase: 'dispatched', dispatched: true,
      dialog: { type: 'confirm', message: 'Delete everything?' },
      reconcile: { answered: true, entered: true, performing: true, raw: 'x' } }),
    { code: 'BROWSER_UI_TIMEOUT', dispatchPhase: 'dispatched', dispatched: true, dialog: { type: 'confirm' },
      reconcile: { answered: true, entered: true, performing: true } }],
    [Object.assign(new Error('raw'), { code: 'BROWSER_ACTION_UNVERIFIED', dispatchPhase: 'sent?', dispatched: 'maybe',
      obscuredBy: '<img src=x onerror=alert(1)>', dialog: { type: 'custom' } }),
    { code: 'BROWSER_ACTION_UNVERIFIED' }],
  ]) {
    const service = { dispatch: async () => { throw thrown }, cancelRun: async () => [], reset: async () => [] }
    const provider = createCodexBrowserToolProvider({ transport: f.transport, getOwnerKey: () => 'codex:account-1', service })
    provider.runtime = f.provider.runtime
    const response = await provider.dispatch(run, { tool: 'egdesk_browser_click', callId: `err-${expected.code}`, arguments: { cardId: 'card-1' } })
    assert.equal(response.success, false)
    const error = parse(response)
    const { message, ...rest } = error
    assert.equal(message, classifyPublicToolError(thrown, { browser: true }).message, 'the raw message stays withheld')
    assert.deepEqual(rest, expected)
    assert.equal(JSON.stringify(error).includes('cookies'), false)
    assert.equal(JSON.stringify(error).includes('Delete everything'), false)
  }
})

test('a Card the Agent opened joins the run binding and leaves it when closed; other Cards stay refused', async () => {
  const f = fixture()
  f.provider.runtime.browserRegisteredThreads.add('native-thread')
  const service = {
    prepare: input => ({ selectedSources: input.selectedSources, cards: new Map([['card-1', { sourceId: 'source-1', cardEpoch: 'epoch-1' }]]) }),
    bind: async () => ({ cards: [{ cardId: 'card-1', permission: 'interact', accountStatus: 'unverified' }] }),
    dispatch: async (run, event) => event.tool === 'egdesk_browser_open_card'
      ? { status: 'card-opened', cardId: 'card-2', action: 'open_card', openedFrom: 'card-1', permission: 'interact', cardEpoch: 'epoch-2', externalEffectVerified: false }
      : event.tool === 'egdesk_browser_close_card' ? { status: 'card-closed', cardId: event.arguments.cardId, action: 'close_card', externalEffectVerified: false }
      : { status: 'observed', cardId: event.arguments.cardId, observationId: 'o', snapshot: { cardId: event.arguments.cardId }, externalEffectVerified: false },
    cancelRun: async () => [], reset: async () => [],
  }
  const provider = createCodexBrowserToolProvider({ transport: f.transport, getOwnerKey: () => 'codex:account-1', service })
  provider.runtime = f.provider.runtime
  const source = { ...selected('interact')[0], sourceRef: { viewId: 'card-1', uri: 'https://example.test/owned-page' } }
  const prepared = provider.prepare({ selectedSources: [source], clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' })
  const run = { answerId: 'native-thread/turn', runId: 'turn', clientThreadId: 'ui-thread-1', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  await provider.bindRun(run, prepared)
  assert.equal((await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'o-2', arguments: { cardId: 'card-2' } })).success, false, 'not yet a Card of this run')
  const opened = await provider.dispatch(run, { tool: 'egdesk_browser_open_card', callId: 'open', arguments: { cardId: 'card-1', url: 'https://example.test/x' } })
  assert.equal(opened.success, true)
  assert.deepEqual(run.browserBinding.cards.map(card => [card.cardId, card.openedByAgent === true]), [['card-1', false], ['card-2', true]])
  assert.equal(f.events.find(event => event.event === 'browser.card.opened').detail.openedFrom, 'card-1')
  assert.equal((await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'o-3', arguments: { cardId: 'card-2' } })).success, true)
  const closed = await provider.dispatch(run, { tool: 'egdesk_browser_close_card', callId: 'close', arguments: { cardId: 'card-2' } })
  assert.equal(closed.success, true)
  assert.deepEqual(run.browserBinding.cards.map(card => card.cardId), ['card-1'])
  assert.equal((await provider.dispatch(run, { tool: 'egdesk_browser_observe', callId: 'o-4', arguments: { cardId: 'card-2' } })).success, false)
  assert.equal(f.events.filter(event => event.event === 'browser.card.closed').length, 1)
})

test('egdesk_browser_reflex is appended only with a decision key and mode on; dispatch runs each step through the provider', async () => {
  const { BROWSER_TOOL_SPECS } = await import('./egdesk-browser-tool-runtime.mjs')
  const { BROWSER_REFLEX_TOOL_SPEC } = await import('./egdesk-browser-reflex.mjs')
  const { specManifestEntries, verifiedManifestOwners } = await import('./codex-native-tool-manifest.mjs')
  const transport = { runs: new Map(), hasClient: () => true, bindRun() {}, unbindRun() {}, reset() {} }
  const baseline = createCodexBrowserToolProvider({ transport, getOwnerKey: () => 'codex:account-1', service: {} })
  const before = JSON.stringify(baseline.specs())
  let mode = 'off', configured = true
  const dispatched = [], events = []
  const service = { dispatch: async (run, event) => { dispatched.push({ tool: event.tool, callId: event.callId, args: event.arguments })
    return { status: 'observed', cardId: 'card-1', observationId: 'observation-1', snapshot: { cardId: 'card-1' }, externalEffectVerified: false } } }
  const reflexCalls = []
  const runReflex = async input => {
    reflexCalls.push(input)
    const first = await input.callTool('egdesk_browser_observe', { cardId: input.cardId })
    await input.callTool('egdesk_browser_observe', { cardId: input.cardId })
    await assert.rejects(input.callTool('egdesk_browser_reflex', { cardId: input.cardId, goal: 'x' }), error => error.code === 'BROWSER_REFLEX_SCOPE')
    return { outcome: 'done', observationId: first.observationId, steps: [{ actions: [] }, { actions: [] }], decisions: 1, secret: 'step log stays out' }
  }
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => 'codex:account-1', service, runReflex,
    decision: { mode: () => mode, configured: () => configured, client: { name: 'fake-client' } } })
  provider.runtime = { browserRegisteredThreads: new Set(), currentEpoch: () => 7, emit: (run, event, detail) => events.push({ event, detail }) }
  // Off (or advisory, or on without a key): byte-identical to today.
  assert.equal(JSON.stringify(provider.specs()), before)
  assert.equal(provider.specs(), BROWSER_TOOL_SPECS)
  mode = 'advisory'; assert.equal(JSON.stringify(provider.specs()), before)
  mode = 'on'; configured = false; assert.equal(JSON.stringify(provider.specs()), before)
  const run = { runId: 'run-1', answerId: 'answer-1', executionPolicy: { mode: 'browserBounded' }, browserBinding: { cards: [{ cardId: 'card-1', permission: 'interact' }] } }
  const refused = await provider.dispatch(run, { tool: 'egdesk_browser_reflex', callId: 'call-0', arguments: { cardId: 'card-1', goal: 'find docs' } })
  assert.equal(refused.success, false)
  assert.match(refused.contentItems[0].text, /BROWSER_REFLEX_UNAVAILABLE/)
  assert.equal(reflexCalls.length, 0)
  // On + key: appended after the unchanged specs.
  configured = true
  const specs = provider.specs()
  assert.deepEqual(specs.map(spec => spec.name), [...BROWSER_TOOL_SPECS.map(spec => spec.name), 'egdesk_browser_reflex'])
  assert.equal(specs.at(-1), BROWSER_REFLEX_TOOL_SPEC)
  assert.equal(JSON.stringify(specs.slice(0, -1)), before)
  const output = await provider.dispatch(run, { tool: 'egdesk_browser_reflex', callId: 'call-1', arguments: { cardId: 'card-1', goal: 'find docs', maxSteps: 3 } })
  assert.equal(output.success, true)
  assert.deepEqual(JSON.parse(output.contentItems[0].text), { outcome: 'done', observationId: 'observation-1', steps: 2, decisions: 1 })
  assert.equal(reflexCalls[0].client.name, 'fake-client')
  assert.equal(reflexCalls[0].maxSteps, 3)
  assert.deepEqual(dispatched.map(item => item.tool), ['egdesk_browser_observe', 'egdesk_browser_observe'])
  const callIds = dispatched.map(item => item.callId)
  assert.equal(new Set([...callIds, 'call-1']).size, 3)
  assert.ok(callIds.every(id => id.startsWith('call-1.reflex-')))
  // Same receipts as direct calls, under the fresh callIds.
  assert.deepEqual(events.filter(item => item.event === 'browser.tool.completed').map(item => item.detail.callId), callIds)
  // The action gate still applies: an ungranted Card fails inside the step.
  const ungranted = await provider.dispatch({ ...run, browserBinding: { cards: [] } }, { tool: 'egdesk_browser_reflex', callId: 'call-2', arguments: { cardId: 'card-1', goal: 'x' } })
  assert.equal(ungranted.success, false)
  assert.match(ungranted.contentItems[0].text, /BROWSER_CARD_NOT_SELECTED|BROWSER_|TOOL/)
  // A manifest recorded while off still verifies against the on catalog.
  const manifestOf = list => list.flatMap(spec => specManifestEntries(spec, 'egdesk-browser'))
  const ownersOf = list => new Map(list.map(spec => [`\0${spec.name}`, provider]))
  const recorded = manifestOf(baseline.specs())
  assert.equal(verifiedManifestOwners(recorded, manifestOf(specs), ownersOf(specs)).status, 'verified')
  mode = 'off'
  assert.equal(verifiedManifestOwners(recorded, manifestOf(provider.specs()), ownersOf(provider.specs())).status, 'verified')
})
