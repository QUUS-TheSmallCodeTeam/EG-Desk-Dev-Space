import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'

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
  assert.equal(f.provider.specs().length, 4)
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

test('BrowserBounded preserves explicit per-source interaction permission without granting it globally', async () => {
  const f = fixture()
  const prepared = f.provider.prepare({ selectedSources: selected('interact'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' })
  assert.equal(prepared.selection.selectedSources[0].browserToolPermission, 'interact')
  assert.equal(f.provider.prepare({ effectiveExecutionPolicy: 'browserBounded' }), null)
})

test('unverified native dynamic-tool schema exposes no Browser specs or selected Card authority', () => {
  const f = fixture()
  const blocked = createCodexBrowserToolProvider({ transport: f.transport, getOwnerKey: () => 'codex:account-1', schemaReady: () => false,
    service: { prepare: () => { throw new Error('must not prepare') } } })
  assert.deepEqual(blocked.specs(), [])
  assert.throws(() => blocked.prepare({ selectedSources: selected('observe'), clientThreadId: 'ui-thread-1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui-stream-1' }), error => error.code === 'BROWSER_TOOLS_UNAVAILABLE')
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
