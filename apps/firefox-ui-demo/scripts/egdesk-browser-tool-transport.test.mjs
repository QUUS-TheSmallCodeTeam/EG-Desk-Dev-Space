import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'

globalThis.JSWindowActorParent ||= class {}
const { EGDeskBrowserAgentRuntimeParent, registerBrowserActionAuthorizer } =
  await import('../overlay/resources/EGDeskBrowserAgentRuntimeParent.sys.mjs')

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
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
const menuSelection = between('    const selectBrowserForChat = (permission) => {', '    const showBrowserMenu = ')
const stopRevokeSource = between('  function revokeBrowserToolRunImmediately(run, thread) {', '  function registerBrowserToolSelection(')
const toolActSource = between('    const browserToolAct = async (expected, action, guard, lease) => {', '    card._browserControls = {')
const toolBindingSource = between('    const browserToolBinding = () => {', '    const assertBrowserToolBinding = (expected) => {')
const interruptBody = between('      async interrupt(threadId = state.codex.activeThreadId) {', '      },\n      subscribe(listener) {')
  .slice('      async interrupt(threadId = state.codex.activeThreadId) {'.length)
const clearTransportBody = between('    const clearBrowserToolTransport = ({ revoke = false } = {}) => {', '    };\n\n    // Read-only, sampled at call time')
  .slice('    const clearBrowserToolTransport = ({ revoke = false } = {}) => {'.length)
const rootSseReadyBody = between('    const rootSseReady = () => {', '    };\n\n    function threadBusy(')
  .slice('    const rootSseReady = () => {'.length)
const readyTransportBody = between("      connectionSource.addEventListener('ready', (event) => {", '      });\n\n      const receive =')
  .slice("      connectionSource.addEventListener('ready', (event) => {".length)
const errorTransportBody = between('      connectionSource.onerror = () => {', '      };\n      } finally')
  .slice('      connectionSource.onerror = () => {'.length)

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
  const runBindings = new Map(), pendingBindings = new Map(), cancelled = new Map(), receipts = new Map(), leases = new Map()
  const userSelections = new Map(), actionLeases = new Map(), stoppedRuns = new Set()
  const current = { cardId: 'browser-a', cardEpoch: 'card-generation-a', profileId: 'firefox-default',
    accountId: 'account-a', accountStatus: 'selected-metadata-unverified', userContextId: 0,
    engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 2, url: 'https://example.test/local' }
  const windowGlobal = { innerWindowId: 201 }
  const browser = { browsingContext: { id: 101, currentWindowGlobal: windowGlobal } }
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
        return { dispatchReceipt: { eventDispatched: true,
          clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true },
          after: { cardId: 'browser-a', text: ['Count: 1'] } }
      },
    } }
  const ownerDocument = { nodePrincipal: { isSystemPrincipal: true } }
  const ownerWindow = { document: ownerDocument, addEventListener() {}, removeEventListener() {} }
  ownerDocument.defaultView = ownerWindow
  Object.assign(browser, { localName: 'browser', isConnected: true, ownerDocument,
    closest: selector => selector === '.egd-browser-card' ? card : null,
    isSameNode: other => other === browser })
  const other = { ...card, id: 'browser-b' }
  const doc = { getElementById: id => id === 'browser-a' ? card : id === 'browser-b' ? other : null }
  let nonce = 0
  const transport = new Function('document', 'ChatState', 'browserToolRunBindings', 'browserToolCancelledRuns',
    'browserToolRequestReceipts', 'browserToolCardLeases', 'browserToolUserSelections', 'browserToolPendingBindings',
    'browserToolActionLeases', 'browserToolStoppedRuns', 'chatBindingNonce', 'Date',
    `let browserToolFixtureLastAction = null;\nconst browserToolFixtureAuthorizationByCard = new Map();\n${dispatchSource}\n` +
    'return {browserToolDispatch,browserToolAuthorizePhysicalAction,browserToolFixtureActionDiagnostic}')(doc,
    { knownCodexAccountKey: key => typeof key === 'string' && key.startsWith('codex:') },
    runBindings, cancelled, receipts, leases, userSelections, pendingBindings, actionLeases, stoppedRuns,
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
  return { dispatch: transport.browserToolDispatch, authorize: transport.browserToolAuthorizePhysicalAction,
    fixtureActionDiagnostic: transport.browserToolFixtureActionDiagnostic,
    req, selection, current, card, browser, ownerWindow,
    runBindings, pendingBindings, cancelled, stoppedRuns, userSelections, actionLeases,
    get actionCalls() { return actionCalls }, get domEffects() { return domEffects },
    hold(promise) { holdAction = promise }, advance(ms) { clockMs += ms } }
}

test('native-shaped Parent actor preserves exact authority across Gecko wrappers', async () => {
  for (const variant of ['exact', 'same-native-wrappers', 'other-browser', 'other-context',
    'other-window-global', 'stale-window-global', 'other-action-ref']) {
    const f = fixture()
    f.current.url = 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef'
    f.current.accountId = ''
    const context = f.browser.browsingContext
    const currentWindowGlobal = context.currentWindowGlobal
    context.top = context
    context.embedderElement = f.browser
    currentWindowGlobal.browsingContext = context
    const unregister = registerBrowserActionAuthorizer(f.browser, f.ownerWindow, f.authorize)
    const parent = new EGDeskBrowserAgentRuntimeParent()
    parent.browsingContext = context
    parent.manager = variant === 'other-window-global'
      ? { innerWindowId: 999, browsingContext: context } : currentWindowGlobal
    if (variant === 'same-native-wrappers') {
      const wrappedWindowGlobal = { innerWindowId: currentWindowGlobal.innerWindowId,
        isClosed: false, isCurrentGlobal: true }
      const wrappedContext = { id: context.id, currentWindowGlobal: wrappedWindowGlobal }
      const wrappedBrowser = { browsingContext: wrappedContext,
        isSameNode: other => other === f.browser }
      f.browser.isSameNode = other => other === wrappedBrowser
      wrappedContext.top = wrappedContext
      wrappedContext.embedderElement = wrappedBrowser
      wrappedWindowGlobal.browsingContext = wrappedContext
      parent.browsingContext = wrappedContext
      parent.manager = wrappedWindowGlobal
      assert.notEqual(parent.browsingContext, context)
      assert.notEqual(parent.manager, currentWindowGlobal)
      assert.notEqual(wrappedBrowser, f.browser)
    }
    if (variant === 'other-browser') context.embedderElement = {
      browsingContext: { id: 999 },
    }
    if (variant === 'other-context') parent.browsingContext = {
      id: 999, top: { embedderElement: f.browser }, currentWindowGlobal,
    }
    let physicalEffects = 0
    f.card._browserControls.toolAct = async (_binding, action, _guard, lease) => {
      if (variant === 'stale-window-global') context.currentWindowGlobal = { innerWindowId: 998,
        browsingContext: context, isCurrentGlobal: true }
      const authorization = parent.receiveMessage({ name: 'authorizeAct', data: {
        leaseId: lease.leaseId, requestId: lease.requestId, deadlineMs: lease.deadlineMs,
        actionType: action.type, actionRef: variant === 'other-action-ref' ? 'el_other' : action.ref,
        actionUrl: null,
      } })
      if (!authorization.authorized) throw new Error(
        `Browser action authority was revoked before input [${authorization.reason}]`)
      physicalEffects++
      return { dispatchReceipt: { actor: 'JSWindowActor' }, after: { cardId: 'browser-a' } }
    }
    const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
    assert.equal(bound.status, 'bound')
    const result = await f.dispatch(f.req('act', { binding: bound.binding,
      guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
    const shouldAct = ['exact', 'same-native-wrappers'].includes(variant)
    assert.equal(result.status, shouldAct ? 'acted' : 'rejected', variant)
    assert.equal(physicalEffects, shouldAct ? 1 : 0, variant)
    assert.equal(f.fixtureActionDiagnostic('browser-a')?.authorizationReason, {
      exact: 'approved', 'same-native-wrappers': 'approved',
      'other-browser': null,
      'other-context': null,
      'other-window-global': 'window-global-identity-mismatch',
      'stale-window-global': 'window-global-not-current',
      'other-action-ref': 'action-ref-mismatch',
    }[variant], variant)
    assert.equal(f.fixtureActionDiagnostic('browser-a')?.parentReason,
      shouldAct ? null : ['other-browser', 'other-context'].includes(variant)
        ? 'missing-authorizer' : 'ui-denied', variant)
    unregister()
  }
})

test('production Card binding registers and disposes its exact chrome Browser controller', () => {
  const ownerDocument = { nodePrincipal: { isSystemPrincipal: true } }
  const listeners = new Map()
  const ownerWindow = { document: ownerDocument,
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) },
  }
  ownerDocument.defaultView = ownerWindow
  const card = { id: 'browser-a', isConnected: true,
    _sourceRef: { profileId: 'firefox-default', accountId: '' } }
  const windowGlobal = { innerWindowId: 201 }
  const context = { id: 101, currentWindowGlobal: windowGlobal,
    originAttributes: { userContextId: 0 } }
  context.top = context
  windowGlobal.browsingContext = context
  const xulBrowser = { localName: 'browser', isConnected: true, ownerDocument,
    browsingContext: context, closest: selector => selector === '.egd-browser-card' ? card : null,
    getAttribute: () => '' }
  context.embedderElement = xulBrowser
  const controller = request => request.browser === xulBrowser && request.leaseId === 'exact-lease'
  const install = new Function('card', 'xulBrowser', 'window', 'ChromeUtils', 'ensureBrowserAgentActor',
    'browserToolAuthorizePhysicalAction', 'state', 'ChatState', 'browserToolAuthorityEpoch',
    'agentBridgeId', 'browserCardState', `let unregisterBrowserAuthorizer = null;\n${toolBindingSource}\n` +
    'return {browserToolBinding, dispose: () => unregisterBrowserAuthorizer?.()};')(
    card, xulBrowser, ownerWindow, { importESModule(uri) {
      assert.equal(uri, 'chrome://userchrome/content/EGDeskBrowserAgentRuntimeParent.sys.mjs')
      return { registerBrowserActionAuthorizer }
    } }, () => true, controller,
    { sourceRefs: { defaultProfileId: 'firefox-default' }, codex: {} },
    { codexAccountKey: () => 'codex:chatgpt:fixture@example.test' }, 2,
    'card-epoch-a', () => ({ uri: 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef' }))
  assert.equal(install.browserToolBinding().cardId, 'browser-a')
  assert.equal(install.browserToolBinding().cardEpoch, 'card-epoch-a')
  assert.equal(listeners.size, 1, 'repeated observation must not register a second controller')
  const parent = new EGDeskBrowserAgentRuntimeParent()
  parent.browsingContext = context
  parent.manager = windowGlobal
  assert.deepEqual(parent.receiveMessage({ name: 'authorizeAct', data: { leaseId: 'exact-lease' } }),
    { authorized: true, reason: 'approved' })
  install.dispose()
  assert.equal(listeners.size, 0)
  assert.equal(parent.receiveMessage({ name: 'authorizeAct', data: { leaseId: 'exact-lease' } }).authorized, false)
  assert.match(source, /const cleanupCard = \(\) => \{\s*try \{ unregisterBrowserAuthorizer\?\.\(\)/)
})

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

test('owned local fixture exposes only a bounded action phase and safe failure enum', async () => {
  const f = fixture()
  f.current.url = 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef'
  f.current.accountId = ''
  const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
  assert.equal(bound.status, 'bound')
  f.card._browserControls.toolAct = async () => { throw new Error('Browser action authority was revoked before input') }
  const denied = await f.dispatch(f.req('act', { binding: bound.binding,
    guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
  assert.equal(denied.status, 'rejected')
  assert.deepEqual({ phase: f.fixtureActionDiagnostic('browser-a')?.phase,
    status: f.fixtureActionDiagnostic('browser-a')?.status,
    reason: f.fixtureActionDiagnostic('browser-a')?.reason },
  { phase: 'actor', status: 'rejected', reason: 'authority-denied' })
  assert.equal(f.fixtureActionDiagnostic('browser-a').error, undefined,
    'fixture diagnostics must not publish raw actor messages')
  assert.equal(f.domEffects, 0)
  f.current.accountId = 'site-account'
  assert.equal(f.fixtureActionDiagnostic('browser-a'), null,
    'the diagnostic is unavailable outside the exact account-free fixture')
  assert.match(source, /fixtureActionDiagnostic: browserToolFixtureActionDiagnostic/)
})

test('fixture diagnostics distinguish Gecko rejection from a routed actor receipt', async () => {
  const fixtureUrl = 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef'
  const rejected = fixture()
  rejected.current.url = fixtureUrl
  rejected.current.accountId = ''
  const first = await rejected.dispatch(rejected.req('bind', { selection: rejected.selection('interact') }))
  rejected.card._browserControls.toolAct = async () => { throw new Error('NS_ERROR_FAILURE: widget dispatch') }
  assert.equal((await rejected.dispatch(rejected.req('act', { binding: first.binding,
    guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))).status, 'rejected')
  const denied = rejected.fixtureActionDiagnostic('browser-a')
  assert.equal(denied.reason, 'gecko-error')
  assert.equal(denied.geckoError, 'NS_ERROR_FAILURE')
  assert.equal(denied.inputRoute, null)
  assert.equal(denied.error, undefined)

  const acted = fixture()
  acted.current.url = fixtureUrl
  acted.current.accountId = ''
  const second = await acted.dispatch(acted.req('bind', { selection: acted.selection('interact') }))
  assert.equal((await acted.dispatch(acted.req('act', { binding: second.binding,
    guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))).status, 'acted')
  assert.equal(acted.domEffects, 1)
  assert.deepEqual({ status: acted.fixtureActionDiagnostic('browser-a')?.status,
    reason: acted.fixtureActionDiagnostic('browser-a')?.reason,
    inputRoute: acted.fixtureActionDiagnostic('browser-a')?.inputRoute,
    targetClickObserved: acted.fixtureActionDiagnostic('browser-a')?.targetClickObserved },
  { status: 'acted', reason: 'none', inputRoute: 'dom-click-no-pointerdown', targetClickObserved: true })
  acted.current.authorityEpoch++
  assert.equal(acted.fixtureActionDiagnostic('browser-a'), null)
})

test('production Browser Card receipt carries only the bounded click route, not actor internals', async () => {
  const binding = { cardId: 'browser-a' }
  const windowGlobal = { id: 'window-global-a' }
  const context = { currentWindowGlobal: windowGlobal }
  const xulBrowser = { browsingContext: context }
  const card = { id: 'browser-a' }
  const actorResult = { ok: true, result: { clickDiagnostics: {
    dispatchScope: 'dom-click-no-pointerdown', targetClickObserved: true, x: 442, y: 218,
  } }, after: { documentId: 'doc-a' }, observation: { visibleTextChanged: true } }
  const toolAct = new Function('assertBrowserToolBinding', 'xulBrowser', 'showAgentActivity',
    'browserAgentActorRequest', 'card', `${toolActSource}\nreturn browserToolAct`)(
    expected => assert.equal(expected, binding), xulBrowser, () => {},
    async (method, payload) => {
      assert.equal(method, 'act')
      assert.deepEqual(payload.action, { type: 'click', ref: 'el_2' })
      return actorResult
    }, card)
  const receipt = await toolAct(binding, { type: 'click', ref: 'el_2' }, { revision: 2 }, {
    leaseId: 'lease-a', requestId: 'request-a', deadlineMs: Date.now() + 5000,
  })
  assert.equal(receipt.dispatchReceipt.clickInputRoute, 'dom-click-no-pointerdown')
  assert.equal(receipt.dispatchReceipt.targetClickObserved, true)
  assert.equal(receipt.dispatchReceipt.x, undefined)
  assert.equal(receipt.dispatchReceipt.y, undefined)
  assert.equal(receipt.after.documentId, 'doc-a')
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

function productionStopHarness(f) {
  const revoke = new Function('browserToolRunBindings', 'browserToolPendingBindings',
    'browserToolActionLeases', 'browserToolCancelledRuns', 'browserToolStoppedRuns',
    'browserToolUserSelections', 'ChatState',
    `${stopRevokeSource}\nreturn revokeBrowserToolRunImmediately`)(
    f.runBindings, f.pendingBindings, f.actionLeases, f.cancelled, f.stoppedRuns, f.userSelections,
    { clientThreadBinding: thread => thread.clientBindingId })
  const run = { runId: 'run-a', clientThreadId: 'thread-a', conversationId: 'conversation-a',
    status: 'inProgress', stopPending: false }
  const thread = { id: 'local-room', clientBindingId: 'thread-a' }
  const state = { codex: { activeThreadId: thread.id } }
  let releaseHttp
  const interrupt = new Function('state', 'getCodexThreadById', 'ChatState', 'protocol',
    'epochScope', 'revokeBrowserToolRunImmediately', 'emit', 'fetchJson', 'updateThreadById',
    `return async function interrupt(threadId = state.codex.activeThreadId) {${interruptBody}\n      }`)(
    state, (_codex, id) => id === thread.id ? thread : null,
    { runsForThread: () => [run], isRunBusy: candidate => candidate.status === 'inProgress' }, {},
    { begin: () => ({ signal: {} }), valid: () => true, finish() {} }, revoke, () => {},
    async (path, options) => {
      assert.equal(path, '/chat/interrupt')
      assert.deepEqual(JSON.parse(options.body), { conversationId: run.conversationId, runId: run.runId })
      return new Promise(resolve => { releaseHttp = resolve })
    }, () => {})
  return { run, interrupt, get releaseHttp() { return releaseHttp } }
}

test('human Stop revokes Browser actor authority synchronously before interrupt HTTP resolves', async () => {
  const f = fixture()
  const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
  let releaseActor
  f.hold(new Promise(resolve => { releaseActor = resolve }))
  const action = f.dispatch(f.req('act', { binding: bound.binding,
    guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
  await Promise.resolve()
  assert.equal(f.actionLeases.size, 1)
  const stop = productionStopHarness(f)

  const stopping = stop.interrupt()
  assert.equal(typeof stop.releaseHttp, 'function')
  assert.equal(stop.run.stopPending, true)
  assert.equal(f.runBindings.size, 0, 'UI binding is revoked before the first HTTP await')
  assert.equal(f.actionLeases.size, 0, 'Parent approval has no live action lease after Stop')
  releaseActor()
  assert.equal((await action).status, 'rejected')
  assert.equal(f.domEffects, 0, 'Stop before physical approval must produce zero DOM effects')
  stop.releaseHttp({ accepted: true, stopRequested: true })
  await stopping
})

test('human Stop tombstones run before delayed first UI bind arrives', async () => {
  const f = fixture()
  const selection = f.selection('interact')
  const delayedFirstBind = f.req('bind', { selection })
  assert.equal(f.runBindings.size, 0)
  assert.equal(f.pendingBindings.size, 0)
  const stop = productionStopHarness(f)

  const stopping = stop.interrupt()
  assert.equal(typeof stop.releaseHttp, 'function')
  assert.equal(stop.run.stopPending, true)
  assert(f.stoppedRuns.has(JSON.stringify(['run-a', 'thread-a'])),
    'Stop must record run/client-thread authority even with no Card binding to revoke')
  assert.equal(f.cancelled.size, 0, 'no per-Card tombstone exists before first bind')
  assert.equal(f.userSelections.has(selection.selectionToken), true,
    'the delayed request still carries a valid one-time selection token')

  const late = await f.dispatch(delayedFirstBind)
  assert.equal(late.status, 'rejected')
  assert.match(late.error, /stopped/)
  const attemptedAct = await f.dispatch(f.req('act', { binding: { ...f.current },
    guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
  assert.equal(attemptedAct.status, 'rejected')
  assert.equal(f.runBindings.size, 0)
  assert.equal(f.pendingBindings.size, 0)
  assert.equal(f.actionCalls, 0)
  assert.equal(f.domEffects, 0, 'Stop before first bind must leave the DOM unchanged')
  f.current.authorityEpoch++
  const staleEpoch = await f.dispatch(f.req('bind', { runId: 'run-b', selection }))
  assert.equal(staleEpoch.status, 'rejected', 'a new run cannot use the prior authority epoch')
  assert.match(staleEpoch.error, /changed/)
  stop.releaseHttp({ accepted: true, stopRequested: true })
  await stopping
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

test('normal root Chat ready SSE attaches Browser transport, posts correlated receipt, and revokes on disconnect', async () => {
  assert.match(source, /browserAgentTools:\s*\{[\s\S]*?rootSseReady: \(\) => state\.codexBridge\?\.rootSseReady\?\.\(\)/,
    'public Browser diagnostics must delegate to the current root Chat closure');
  const listeners = new Map(), posts = [], grants = new Map([['selected', {}]])
  const runBindings = new Map([['run-a', {}]]), pendingBindings = new Map(), actionLeases = new Map([['lease-a', {}]])
  const sseSource = { closed: false, readyState: 1, addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name) },
    close() { this.closed = true; this.readyState = 2 },
    emit(name, data) { return listeners.get(name)?.({ data: JSON.stringify(data) }) } }
  const card = { _browserControls: { toolBinding: () => ({ cardEpoch: 'card-epoch-a' }) } }
  const doc = { getElementById: id => id === 'browser-a' ? card : null }
  const directAttach = new Function('browserToolDispatch', 'console', 'TAG', 'document',
    'browserToolRunBindings', 'browserToolCancelledRuns', `${attachSource}\nreturn attachBrowserToolTransport`)(
    async request => ({ requestId: request.requestId, status: 'observed' }), { warn() {} }, '[test]',
    doc, runBindings, new Map())
  let attached = 0, boundRespond
  const attach = options => { attached++; boundRespond = options.respond; return directAttach(options) }
  const state = { codex: { localHistoryStatus: 'ready', threads: [{ inputSources: [{ kind: 'browser',
    browserToolPermission: 'interact', browserToolSelection: { token: 'selected' } }] }] } }
  const fetchJson = async (path, options) => {
    assert.equal(path, '/browser-tool/respond')
    const payload = JSON.parse(options.body)
    posts.push(payload)
    return { accepted: true, requestId: payload.response.requestId }
  }
  const harness = new Function('deps', `
    const { state, source: initialSource, fetchJson, attachBrowserToolTransport,
      browserToolRunBindings, browserToolPendingBindings, browserToolActionLeases, browserToolUserSelections } = deps;
    const window = { AbortController, EventSource: { OPEN: 1 } };
    const epochScope = { valid: () => true };
    const resumedNativeBindings = new Set();
    const protocol = { connection: 'online' };
    const connectionSource = initialSource, streamEpoch = 0;
    let source = initialSource, streamReady = false, browserTransportId = null,
      browserTransportSource = null, browserTransportAbort = null,
      detachBrowserToolTransport = null, browserToolAuthorityEpoch = 0;
    let browserToolFixtureLastAction = { status: 'acted' };
    const browserToolFixtureAuthorizationByCard = new Map([['browser-a', { reason: 'approved' }]]);
    let localAutoRetryEligible = false, localRetryBudget = 1, localRetryTimer = null;
    let reconnects = 0;
    const update = patch => Object.assign(state.codex, patch);
    const loadLocalHistory = async () => {};
    const scheduleReconnect = () => { reconnects++ };
    const clearBrowserToolTransport = ({ revoke = false } = {}) => {${clearTransportBody}\n    };
    const rootSseReady = () => {${rootSseReadyBody}\n    };
    const onReady = event => {${readyTransportBody}\n    };
    const onError = () => {${errorTransportBody}\n    };
    return { onReady, onError, rootSseReady, state: () => ({ streamReady, browserTransportId, source,
      browserToolAuthorityEpoch, browserToolFixtureLastAction,
      authorizationCount: browserToolFixtureAuthorizationByCard.size, reconnects, protocol }) };
  `)({ state, source: sseSource, fetchJson, attachBrowserToolTransport: attach,
    browserToolRunBindings: runBindings, browserToolPendingBindings: pendingBindings,
    browserToolActionLeases: actionLeases,
    browserToolUserSelections: grants })

  assert.deepEqual(Object.keys(harness.rootSseReady()).sort(),
    ['browserTransportId', 'eventSourceReadyState', 'sampledAtMs', 'sourceReady', 'stable'].sort())
  assert.equal(harness.rootSseReady().sourceReady, false, 'OPEN alone is not a bound Browser stream')
  harness.onReady({ data: JSON.stringify({ ok: true, browserTransportId: 'transport-a' }) })
  harness.onReady({ data: JSON.stringify({ ok: true, browserTransportId: 'transport-a' }) })
  assert.equal(attached, 1, 'duplicate ready must not attach another Browser listener')
  assert.equal(harness.state().browserTransportId, 'transport-a')
  const sampledAt = Date.now()
  const ready = harness.rootSseReady()
  assert.equal(ready.sourceReady, true)
  assert.equal(ready.stable, true)
  assert.equal(ready.eventSourceReadyState, 1)
  assert.equal(ready.browserTransportId, 'transport-a')
  assert(ready.sampledAtMs >= sampledAt && ready.sampledAtMs <= Date.now())
  sseSource.readyState = 0
  assert.equal(harness.rootSseReady().sourceReady, false, 'current CONNECTING state overrides an earlier ready event')
  assert.equal(harness.rootSseReady().browserTransportId, null)
  sseSource.readyState = 1
  assert.equal(harness.rootSseReady().sourceReady, true)
  await sseSource.emit('browser-tool-request', { requestId: 'request-a', runId: 'run-a',
    cardId: 'browser-a', targetCardEpoch: 'card-epoch-a' })
  assert.deepEqual(posts, [{ browserTransportId: 'transport-a',
    response: { requestId: 'request-a', status: 'observed' } }])
  harness.onError()
  assert.equal(sseSource.closed, true)
  assert.equal(harness.state().browserTransportId, null)
  assert.equal(harness.rootSseReady().sourceReady, false)
  assert.equal(harness.rootSseReady().browserTransportId, null)
  assert.equal(harness.state().browserToolAuthorityEpoch, 1)
  assert.equal(harness.state().browserToolFixtureLastAction, null)
  assert.equal(harness.state().authorizationCount, 0)
  assert.equal(harness.state().reconnects, 1)
  assert.equal(runBindings.size, 0)
  assert.equal(actionLeases.size, 0)
  assert.equal(grants.size, 0)
  assert.equal(state.codex.threads[0].inputSources[0].browserToolPermission, 'observe')
  await assert.rejects(boundRespond({ requestId: 'late-request', status: 'observed' }), /stream changed/)
  assert.equal(posts.length, 1, 'late responses must not post through a replacement Chat stream')
})
