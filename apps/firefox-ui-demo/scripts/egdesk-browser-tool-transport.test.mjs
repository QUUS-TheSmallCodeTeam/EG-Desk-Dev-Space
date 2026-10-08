import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const between = (start, end) => {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first)
  assert(first >= 0 && last > first, `Browser transport source boundary missing: ${start}`)
  return source.slice(first, last)
}
const dispatchSource = between('  async function browserToolDispatchOnce(request) {', '  function attachBrowserToolTransport(')
const attachSource = between('  function attachBrowserToolTransport({ source, respond }) {', '\n\n  function spawnBrowserCard(')
const sourceSelection = between('  function chatInputSourceForView(view) {', '  function chatInputSources(')
const selectedSources = between('  function browserToolSelectedSources(threadId) {', '  async function browserToolDispatchOnce(')

test('Browser context source identifies exact live Card without silently selecting it for a run', () => {
  const current = { cardId: 'browser-a', cardEpoch: 'epoch-a', profileId: 'firefox-default',
    accountId: 'account-a', userContextId: 0, engineAccountKey: 'codex:chatgpt:fixture@example.test',
    authorityEpoch: 3, url: 'https://example.test/local' }
  const card = { id: 'browser-a', isConnected: true, dataset: { projectionId: 'projection-1' },
    classList: { contains: name => name === 'egd-browser-card' },
    _sourceRef: { profileId: current.profileId, accountId: current.accountId },
    _browserControls: { toolBinding: () => current } }
  const state = { boards: { projections: { 'projection-1': { boardId: 'board-1' } } },
    sourceRefs: { defaultProfileId: 'firefox-default' }, codex: { threads: [] } }
  const makeSource = new Function('state', 'chatBindingNonce', 'cardLabelForViewportRail', 'browserCardState',
    'servicesRef', 'Ci', `${sourceSelection}\nreturn chatInputSourceForView`)(state, () => 'nonce', () => 'Fixture Browser',
    () => ({ uri: current.url }), () => ({}), {})
  const source = makeSource(card)
  assert.equal(source.browserToolPermission, 'observe')
  assert.equal(source.selectedByUser, undefined)
  assert.deepEqual(source.browserToolIdentity, { cardEpoch: current.cardEpoch, userContextId: 0,
    engineAccountKey: current.engineAccountKey, authorityEpoch: 3 })
  assert.equal(source.sourceRef.profileId, current.profileId)
  assert.equal(source.sourceRef.accountId, current.accountId)

  state.codex.threads = [{ id: 'thread-a', inputSources: [source] }]
  const doc = { getElementById: id => id === 'browser-a' ? card : null }
  const selected = new Function('state', 'getCodexThreadById', 'document', 'structuredClone',
    `${selectedSources}\nreturn browserToolSelectedSources`)(state,
    (codex, id) => codex.threads.find(thread => thread.id === id), doc, structuredClone)
  assert.deepEqual(selected('thread-a'), [])
  source.selectedByUser = true
  assert.equal(selected('thread-a').length, 1)
  current.authorityEpoch++
  assert.deepEqual(selected('thread-a'), [], 'old account authority epochs are not auto-selected')
})

function fixture() {
  const runBindings = new Map(), cancelled = new Map(), receipts = new Map(), leases = new Map()
  const current = { cardId: 'browser-a', cardEpoch: 'card-generation-a', profileId: 'firefox-default',
    accountId: 'account-a', accountStatus: 'selected-metadata-unverified', userContextId: 0,
    engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 2, url: 'https://example.test/local' }
  let actionCalls = 0
  let holdAction = null
  const card = { id: 'browser-a', isConnected: true, classList: { contains: name => name === 'egd-browser-card' },
    _browserControls: {
      toolBinding: () => ({ ...current }),
      toolObserve: async () => ({ cardId: 'browser-a', documentId: 'doc-1', revision: 2,
        viewport: { width: 720, height: 480, devicePixelRatio: 1 }, url: current.url, text: ['Count: 0'], interactiveElements: [] }),
      toolAct: async () => { actionCalls++; if (holdAction) await holdAction; return {
        dispatchReceipt: { eventDispatched: true }, after: { cardId: 'browser-a', text: ['Count: 1'] } } },
    } }
  const other = { ...card, id: 'browser-b' }
  const doc = { getElementById: id => id === 'browser-a' ? card : id === 'browser-b' ? other : null }
  const dispatch = new Function('document', 'ChatState', 'browserToolRunBindings', 'browserToolCancelledRuns',
    'browserToolRequestReceipts', 'browserToolCardLeases', `${dispatchSource}\nreturn browserToolDispatch`)(doc,
    { knownCodexAccountKey: key => typeof key === 'string' && key.startsWith('codex:') }, runBindings, cancelled, receipts, leases)
  let sequence = 0
  const req = (kind, extra = {}) => ({ version: 1, requestId: `request-${++sequence}`,
    deadlineMs: Date.now() + 10000, runId: 'run-a', cardId: 'browser-a',
    targetCardEpoch: 'card-generation-a', kind, ...extra })
  return { dispatch, req, current, card, runBindings,
    get actionCalls() { return actionCalls }, hold(promise) { holdAction = promise } }
}

test('UI dispatch binds only exact Card/profile/account/epoch and deduplicates one action request', async () => {
  const f = fixture()
  const selection = { cardId: 'browser-a', cardEpoch: f.current.cardEpoch,
    profileId: f.current.profileId, accountId: f.current.accountId,
    userContextId: f.current.userContextId, engineAccountKey: f.current.engineAccountKey,
    authorityEpoch: f.current.authorityEpoch, selectedUrl: f.current.url, permission: 'interact' }
  const bind = await f.dispatch(f.req('bind', { selection }))
  assert.equal(bind.status, 'bound')
  const observed = await f.dispatch(f.req('observe', { binding: bind.binding }))
  assert.equal(observed.status, 'observed')
  const action = f.req('act', { binding: bind.binding, guard: { documentId: 'doc-1', revision: 2 },
    action: { type: 'click', ref: 'el_1' } })
  const first = await f.dispatch(action)
  const duplicate = await f.dispatch(action)
  assert.deepEqual(duplicate, first)
  assert.equal(first.status, 'acted')
  assert.equal(f.actionCalls, 1)
  const wrongCard = await f.dispatch(f.req('act', { cardId: 'browser-b', binding: bind.binding,
    guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
  assert.equal(wrongCard.status, 'rejected')
  assert.equal(f.actionCalls, 1)
  f.current.accountId = 'account-b'
  const changed = await f.dispatch(f.req('observe', { binding: bind.binding }))
  assert.equal(changed.status, 'rejected')
  assert.equal(f.runBindings.size, 0)
})

test('read-only, expired, cancelled and late bind requests fail closed', async () => {
  const f = fixture()
  const selection = { cardId: 'browser-a', cardEpoch: f.current.cardEpoch,
    profileId: f.current.profileId, accountId: f.current.accountId,
    userContextId: f.current.userContextId, engineAccountKey: f.current.engineAccountKey,
    authorityEpoch: f.current.authorityEpoch, selectedUrl: f.current.url, permission: 'observe' }
  const bound = await f.dispatch(f.req('bind', { selection }))
  assert.equal(bound.status, 'bound')
  const denied = await f.dispatch(f.req('act', { binding: bound.binding,
    guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
  assert.equal(denied.status, 'rejected')
  assert.equal(f.actionCalls, 0)
  const cancelled = await f.dispatch(f.req('cancel'))
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await f.dispatch(f.req('bind', { selection }))).status, 'rejected')
  assert.equal((await f.dispatch(f.req('observe', { binding: bound.binding }))).status, 'rejected')
  assert.equal((await f.dispatch(f.req('observe', { binding: bound.binding, deadlineMs: Date.now() - 1 }))).status, 'rejected')
})

test('cancellation during an in-flight actor action reports unknown rather than confirmed completion', async () => {
  const f = fixture()
  const selection = { cardId: 'browser-a', cardEpoch: f.current.cardEpoch,
    profileId: f.current.profileId, accountId: f.current.accountId,
    userContextId: f.current.userContextId, engineAccountKey: f.current.engineAccountKey,
    authorityEpoch: f.current.authorityEpoch, selectedUrl: f.current.url, permission: 'interact' }
  const bound = await f.dispatch(f.req('bind', { selection }))
  let release
  f.hold(new Promise(resolve => { release = resolve }))
  const action = f.dispatch(f.req('act', { binding: bound.binding,
    guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
  await Promise.resolve()
  const concurrent = await f.dispatch(f.req('act', { binding: bound.binding,
    guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
  assert.equal(concurrent.status, 'rejected')
  assert.match(concurrent.error, /already being operated/)
  assert.equal(f.actionCalls, 1)
  assert.equal((await f.dispatch(f.req('cancel'))).status, 'cancelled')
  release()
  const result = await action
  assert.equal(result.status, 'rejected')
  assert.match(result.error, /outcome is unknown/)
})

test('event-source transport returns correlated UI receipts without Chat transcript mutation', async () => {
  const listeners = new Map(), responses = []
  const source = { addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) } }
  const attach = new Function('browserToolDispatch', 'console', 'TAG', 'document',
    'browserToolRunBindings', 'browserToolCancelledRuns', `${attachSource}\nreturn attachBrowserToolTransport`)(
    async request => ({ requestId: request.requestId, status: 'observed' }), console, '[test]',
    { getElementById: () => ({ _browserControls: { toolBinding: () => ({ cardEpoch: 'selected-epoch' }) } }) },
    new Map(), new Map())
  const detach = attach({ source, respond: async response => { responses.push(response) } })
  await listeners.get('browser-tool-request')({ data: JSON.stringify({ requestId: 'wrong-window', cardId: 'browser-a',
    targetCardEpoch: 'other-epoch', runId: 'run-a' }) })
  assert.equal(responses.length, 0, 'other Firefox windows must not answer a selected Card request')
  await listeners.get('browser-tool-request')({ data: JSON.stringify({ requestId: 'correlation-1', cardId: 'browser-a',
    targetCardEpoch: 'selected-epoch', runId: 'run-a' }) })
  assert.deepEqual(responses, [{ requestId: 'correlation-1', status: 'observed' }])
  detach()
  assert.equal(listeners.size, 0)
})
