import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const between = (start, end) => {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first)
  assert(first >= 0 && last > first, `Browser transport source boundary missing: ${start}`)
  return source.slice(first, last)
}
const dispatchSource = between('  function browserToolSameUrl(left, right) {', '  function attachBrowserToolTransport(')
const attachSource = between('  function attachBrowserToolTransport({ source, respond }) {', '\n\n  function spawnBrowserCard(')
const sourceSelection = between('  function chatInputSourceForView(view) {', '  function chatInputSources(')
const selectedSources = between('  function registerBrowserToolSelection(threadId, source, permission) {', '  function browserToolSafeNavigationUrl(value) {')
const menuSelection = between('    const selectBrowserForChat = (permission) => {', '    const showBrowserMenu = (anchor = menuButton) => {')

test('legacy Browser frame-script snapshot fallback retains valid syntax and sensitive-control masks', () => {
  const body = between('    const browserAgentFrameScriptSource = () => `', '`;\n    const browserAgentMessageManager')
    .slice('    const browserAgentFrameScriptSource = () => `'.length)
  const factory = new Function('agentBridgeRequestTopic', 'agentBridgeResponseTopic',
    `return () => \`${body}\``)('test-request', 'test-response')
  const generated = factory()
  assert.doesNotThrow(() => new Function(generated))
  assert.match(generated, /if \(isSensitive\(node\)\) return 'Sensitive field'/)
  assert.match(generated, /if \(isSensitive\(node\)\) return ''/)
  const visibleStart = generated.indexOf('const composedParent =')
  const visibleEnd = generated.indexOf('const isSensitive =', visibleStart)
  assert(visibleStart >= 0 && visibleEnd > visibleStart)
  const getStyle = node => ({ display: 'block', visibility: 'visible', opacity: node.opacity ?? '1' })
  const frameVisible = new Function('content', `${generated.slice(visibleStart, visibleEnd)}\nreturn isVisible`)(
    { getComputedStyle: getStyle })
  const sensitiveStart = generated.indexOf('const isSensitive =', visibleEnd)
  const sensitiveEnd = generated.indexOf('const isSensitiveText =', sensitiveStart)
  assert(sensitiveStart >= 0 && sensitiveEnd > sensitiveStart)
  const frameSensitive = new Function(`${generated.slice(sensitiveStart, sensitiveEnd)}\nreturn isSensitive`)()
  const chromeVisibility = between('    const agentComposedParent = (node) =>', '    const isAgentSensitiveControl = (node) =>')
  const chromeVisible = new Function(`${chromeVisibility}\nreturn isAgentVisibleElement`)()
  const chromeSensitiveSource = between('    const isAgentSensitiveControl = (node) =>', '    const isAgentSensitiveText = (node) =>')
  const chromeSensitive = new Function(`${chromeSensitiveSource}\nreturn isAgentSensitiveControl`)()
  const ownerDocument = { defaultView: { getComputedStyle: getStyle } }
  const host = { opacity: '0', ownerDocument }
  const child = { ownerDocument, parentElement: null, getRootNode: () => ({ host }),
    getBoundingClientRect: () => ({ width: 100, height: 20 }) }
  assert.equal(frameVisible(child), false)
  assert.equal(chromeVisible(child), false)
  host.opacity = '1'
  assert.equal(frameVisible(child), true)
  assert.equal(chromeVisible(child), true)
  for (const name of ['creditCardNumber', 'ssn', 'PAN']) {
    const field = { tagName: 'INPUT', type: 'text', getAttribute: key => key === 'name' ? name : null }
    assert.equal(frameSensitive(field), true, `frame fallback must mask ${name}`)
    assert.equal(chromeSensitive(field), true, `chrome fallback must mask ${name}`)
  }
  const ordinary = { tagName: 'INPUT', type: 'text', getAttribute: key => key === 'name' ? 'note' : null }
  assert.equal(frameSensitive(ordinary), false)
  assert.equal(chromeSensitive(ordinary), false)
})

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

  state.codex.threads = [{ id: 'thread-a', clientBindingId: 'client-binding-a', inputSources: [source] }]
  const doc = { getElementById: id => id === 'browser-a' ? card : null }
  const grants = new Map()
  const selectors = new Function('state', 'getCodexThreadById', 'document', 'structuredClone',
    'browserToolUserSelections', 'chatBindingNonce', 'ChatState', `${selectedSources}\nreturn {registerBrowserToolSelection,browserToolSelectedSources}`)(state,
    (codex, id) => codex.threads.find(thread => thread.id === id), doc, structuredClone, grants,
    () => 'explicit-user-token', ChatState)
  assert.deepEqual(selectors.browserToolSelectedSources('thread-a'), [])
  const selected = selectors.registerBrowserToolSelection('thread-a', source, 'observe')
  state.codex.threads[0].inputSources = [selected]
  assert.equal(selectors.browserToolSelectedSources('thread-a').length, 1)
  assert.equal(selected.browserToolSelection.token, 'explicit-user-token')
  assert.equal(selected.browserToolSelection.threadId, 'client-binding-a',
    'legacy local room ID must not replace its actual client binding ID')
  current.authorityEpoch++
  assert.deepEqual(selectors.browserToolSelectedSources('thread-a'), [], 'old account authority epochs are not auto-selected')
})

test('read-only Browser attachment remains available when actor binding is unavailable', () => {
  const source = { id: 'source-a', kind: 'browser', browserToolIdentity: null,
    sourceRef: { viewId: 'browser-a', uri: 'data:text/html,local' } }
  const thread = { inputSources: [source] }
  const added = [], removed = [], notices = []
  const state = { codex: { activeThreadId: 'thread-a' }, codexBridge: {
    removeInputSource: (_threadId, id) => { removed.push(id); thread.inputSources = [] },
    addInputSources: (_threadId, sources) => { added.push(...sources); thread.inputSources.push(...sources) },
  } }
  const select = new Function('state', 'card', 'chatInputSourceForView', 'registerBrowserToolSelection',
    'getCodexThreadById', 'boardNotice', 'showAgentActivity', `${menuSelection}\nreturn selectBrowserForChat`)(
    state, { id: 'browser-a' }, () => source, () => null, () => thread,
    message => notices.push(message), () => {})
  select('interact')
  assert.deepEqual(removed, [])
  assert.deepEqual(added, [])
  assert.equal(notices.length, 1)
  select('observe')
  assert.deepEqual(removed, ['source-a'])
  assert.equal(added[0].browserToolPermission, 'observe')
  assert.equal(added[0].selectedByUser, true)
})

function fixture() {
  const runBindings = new Map(), cancelled = new Map(), receipts = new Map(), leases = new Map()
  const userSelections = new Map(), actionLeases = new Map()
  const current = { cardId: 'browser-a', cardEpoch: 'card-generation-a', profileId: 'firefox-default',
    accountId: 'account-a', accountStatus: 'selected-metadata-unverified', userContextId: 0,
    engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 2, url: 'https://example.test/local' }
  const windowGlobal = { id: 'window-global-a' }
  const browser = { browsingContext: { currentWindowGlobal: windowGlobal } }
  let actionCalls = 0, domEffects = 0
  let clockMs = Date.now()
  let holdAction = null
  let authorizePhysicalAction
  const card = { id: 'browser-a', isConnected: true, classList: { contains: name => name === 'egd-browser-card' },
    _browserControls: {
      toolBinding: () => ({ ...current }),
      toolBrowser: () => browser,
      toolObserve: async () => ({ cardId: 'browser-a', documentId: 'doc-1', revision: 2,
        viewport: { width: 720, height: 480, devicePixelRatio: 1 }, url: current.url, text: ['Count: 0'], interactiveElements: [] }),
      toolAct: async (_binding, action, _guard, lease) => {
        actionCalls++
        if (holdAction) await holdAction
        const permitted = authorizePhysicalAction({ browser, browsingContext: browser.browsingContext,
          windowGlobal, leaseId: lease.leaseId, requestId: lease.requestId,
          deadlineMs: lease.deadlineMs, actionType: action.type,
          actionRef: action.ref || null, actionUrl: action.url || null })
        if (!permitted) throw new Error('Browser action authority was revoked before input')
        domEffects++
        return { dispatchReceipt: { eventDispatched: true }, after: { cardId: 'browser-a', text: ['Count: 1'] } }
      },
    } }
  const other = { ...card, id: 'browser-b' }
  const doc = { getElementById: id => id === 'browser-a' ? card : id === 'browser-b' ? other : null }
  let nonce = 0
  const transport = new Function('document', 'ChatState', 'browserToolRunBindings', 'browserToolCancelledRuns',
    'browserToolRequestReceipts', 'browserToolCardLeases', 'browserToolUserSelections',
    'browserToolActionLeases', 'chatBindingNonce', 'Date', `${dispatchSource}\nreturn {browserToolDispatch,browserToolAuthorizePhysicalAction}`)(doc,
    { knownCodexAccountKey: key => typeof key === 'string' && key.startsWith('codex:') },
    runBindings, cancelled, receipts, leases, userSelections, actionLeases,
    () => `lease-${++nonce}`, { now: () => clockMs })
  authorizePhysicalAction = transport.browserToolAuthorizePhysicalAction
  let sequence = 0
  const req = (kind, extra = {}) => ({ version: 1, requestId: `request-${++sequence}`,
    deadlineMs: clockMs + 10000, runId: 'run-a', clientThreadId: 'thread-a', cardId: 'browser-a',
    targetCardEpoch: 'card-generation-a', kind, ...extra })
  const selection = (permission = 'interact') => {
    const value = { cardId: 'browser-a', cardEpoch: current.cardEpoch,
      profileId: current.profileId, accountId: current.accountId,
      userContextId: current.userContextId, engineAccountKey: current.engineAccountKey,
      authorityEpoch: current.authorityEpoch, selectedUrl: current.url, permission,
      selectionToken: 'explicit-selection-a', clientThreadId: 'thread-a', sourceId: 'selected-source-a' }
    userSelections.set(value.selectionToken, { ...value, token: value.selectionToken,
      threadId: value.clientThreadId, usedRunId: null })
    return value
  }
  return { dispatch: transport.browserToolDispatch, req, selection, current, card, browser,
    runBindings, userSelections, actionLeases,
    get actionCalls() { return actionCalls }, get domEffects() { return domEffects },
    hold(promise) { holdAction = promise }, advance(ms) { clockMs += ms } }
}

test('UI dispatch binds only exact Card/profile/account/epoch and deduplicates one action request', async () => {
  const f = fixture()
  const selection = f.selection('interact')
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
  assert.equal(f.domEffects, 1)
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
  const selection = f.selection('observe')
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

test('UI cancel tombstone wins a bind still awaiting actor observation', async () => {
  const f = fixture()
  const selection = f.selection('observe')
  let releaseObservation
  f.card._browserControls.toolObserve = () => new Promise(resolve => { releaseObservation = resolve })
  const pendingBind = f.dispatch(f.req('bind', { selection }))
  await Promise.resolve()
  assert.equal(typeof releaseObservation, 'function')
  assert.equal((await f.dispatch(f.req('cancel', { selectionToken: selection.selectionToken }))).status, 'cancelled')
  releaseObservation({ url: f.current.url })
  const late = await pendingBind
  assert.equal(late.status, 'rejected')
  assert.equal(f.runBindings.size, 0)
  assert.equal(f.userSelections.has(selection.selectionToken), false)
  assert.equal((await f.dispatch(f.req('observe', { binding: f.current }))).status, 'rejected')
})

test('UI rejects forged unselected Card and observe-to-interact escalation before binding', async () => {
  const unselected = fixture()
  const forged = unselected.selection('interact')
  unselected.userSelections.clear()
  assert.equal((await unselected.dispatch(unselected.req('bind', { selection: forged }))).status, 'rejected')
  assert.equal(unselected.runBindings.size, 0)

  const readOnly = fixture()
  const observeSelection = readOnly.selection('observe')
  const escalated = await readOnly.dispatch(readOnly.req('bind', {
    selection: { ...observeSelection, permission: 'interact' },
  }))
  assert.equal(escalated.status, 'rejected')
  assert.equal(readOnly.runBindings.size, 0)
  assert.equal(readOnly.domEffects, 0)
})

test('UI selection grant is bound to its Chat thread and only one run', async () => {
  const wrongThread = fixture()
  const selected = wrongThread.selection('interact')
  assert.equal((await wrongThread.dispatch(wrongThread.req('bind', {
    clientThreadId: 'thread-b', selection: { ...selected, clientThreadId: 'thread-b' },
  }))).status, 'rejected')
  assert.equal(wrongThread.runBindings.size, 0)

  const oneShot = fixture()
  const source = oneShot.selection('observe')
  assert.equal((await oneShot.dispatch(oneShot.req('bind', { selection: source }))).status, 'bound')
  assert.equal((await oneShot.dispatch(oneShot.req('bind', {
    runId: 'run-b', selection: source,
  }))).status, 'rejected', 'a selection cannot silently authorize a second run')
})

test('UI bind accepts canonical equivalent trailing-slash URL without broadening Card identity', async () => {
  const f = fixture()
  f.current.url = 'https://example.com/'
  const selected = f.selection('observe')
  selected.selectedUrl = 'https://example.com'
  f.userSelections.get(selected.selectionToken).selectedUrl = selected.selectedUrl
  const response = await f.dispatch(f.req('bind', { selection: selected }))
  assert.equal(response.status, 'bound')
  assert.equal(response.binding.url, 'https://example.com/')
})

test('UI denies non-http navigation even with a bound interaction selection', async () => {
  const f = fixture()
  const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
  for (const url of ['javascript:alert(1)', 'data:text/html,local', 'file:///tmp/local.html']) {
    const response = await f.dispatch(f.req('act', { binding: bound.binding,
      guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'navigate', url } }))
    assert.equal(response.status, 'rejected')
  }
  assert.equal(f.actionCalls, 0)
  assert.equal(f.domEffects, 0)
})

test('cancellation during an in-flight actor action reports unknown rather than confirmed completion', async () => {
  const f = fixture()
  const selection = f.selection('interact')
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
  assert.match(result.error, /revoked before input/)
  assert.equal(f.domEffects, 0)
})

test('account change or deadline expiry while actor pending leaves DOM unchanged', async () => {
  for (const invalidation of ['account', 'deadline']) {
    const f = fixture()
    const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
    let release
    f.hold(new Promise(resolve => { release = resolve }))
    const action = f.dispatch(f.req('act', { binding: bound.binding,
      guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
    await Promise.resolve()
    if (invalidation === 'account') f.current.accountId = 'switched-account'
    else f.advance(11000)
    release()
    const result = await action
    assert.equal(result.status, 'rejected')
    assert.equal(f.domEffects, 0)
  }
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
