import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { readSurfaceSource } from './egdesk-surface-source.mjs'
import { captureInputSources } from '../overlay/resources/EGDeskInputContext.sys.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'

globalThis.JSWindowActorParent ||= class {}
const BrowserAgentReceipts = await import('../overlay/resources/EGDeskBrowserAgentRuntimeParent.sys.mjs')
const { EGDeskBrowserAgentRuntimeParent, registerBrowserActionAuthorizer } = BrowserAgentReceipts
// BRW-05/07/11: the conversation grant and site rules the chrome slices use.
const BrowserGrant = await import('../overlay/resources/EGDeskBrowserGrant.sys.mjs')
const servicesRef = () => ({ eTLD: { getBaseDomainFromHost: host => host.split('.').slice(-2).join('.') } })

const source = readSurfaceSource()
const between = (start, end) => {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first)
  assert(first >= 0 && last > first, `Browser transport source boundary missing: ${start}`)
  return source.slice(first, last)
}
const dispatchSource = between('  function browserToolSameUrl(left, right) {', '  function attachBrowserToolTransport(')
const grantSource = between('  const browserToolThreadGrants = new Map();', '  const browserToolFixtureAuthorizationByCard = new Map();')
const attachSource = between('  function attachBrowserToolTransport({ source, respond }) {', '\n\n  function spawnBrowserCard(')
const sourceSelection = between('  function chatInputSourceForView(view) {', '  function chatInputSources(')
const selectedSources = between('  function registerBrowserToolSelection(threadId, source, permission) {', '  function browserToolSafeNavigationUrl(value) {')
const menuSelection = between('    const selectBrowserForChat = (permission) => {', '    const showBrowserMenu = ')
const stopRevokeSource = between('  function revokeBrowserToolRunImmediately(run, thread) {', '  function registerBrowserToolSelection(')
const toolActSource = between('    const browserToolAct = async (expected, action, guard, lease) => {', '    card._browserControls = {')
const budgetSource = between('  function browserToolRemainingBudget(', '  function browserToolDialog(')
const dialogSource = between('  function browserToolDialog(', '  // Only the helper contract C keys')
function cardTools({ browser, query, bindingCheck = () => {}, activity = () => {}, now = Date.now,
  dialogs = { checkpoint: () => 0, read: () => ({ open: false, seen: false, dialog: null }) },
  scheduler = { setTimeout, clearTimeout } } = {}) {
  const remaining = new Function('Date', 'browserToolClock', 'BROWSER_TOOL_REPLY_MARGIN_MS',
    `${budgetSource}\nreturn browserToolRemainingBudget`)({ now }, now, 500)
  return new Function('assertBrowserToolBinding', 'xulBrowser', 'showAgentActivity', 'browserAgentActorRequest',
    'card', 'BrowserAgentReceipts', 'browserToolRemainingBudget', 'toolDialogs', 'window',
    `${toolActSource}\nreturn { act: browserToolAct, reconcile: browserToolReconcile }`)(
    bindingCheck, browser, activity, query, { id: 'browser-a' }, BrowserAgentReceipts, remaining, dialogs, scheduler)
}
const toolBindingSource = between('    const browserToolBinding = (roomKey) => {', '    const assertBrowserToolBinding = (expected) => {')
const interruptBody = between('      async interrupt(threadId = state.codex.activeThreadId) {', '      },\n      subscribe(listener) {')
  .slice('      async interrupt(threadId = state.codex.activeThreadId) {'.length)
const clearTransportBody = between('    const clearBrowserToolTransport = ({ revoke = false } = {}) => {', '    };\n\n    // Read-only, sampled at call time')
  .slice('    const clearBrowserToolTransport = ({ revoke = false } = {}) => {'.length)
const rootSseReadyBody = between('    const rootSseReady = () => {', '    };\n\n    function threadBusy(')
  .slice('    const rootSseReady = () => {'.length)
const readyTransportBody = between("      connectionSource.addEventListener('ready', (event) => {", '      });\n\n      const fileEventStreamCurrent =')
  .slice("      connectionSource.addEventListener('ready', (event) => {".length)
assert.equal(source.split("      connectionSource.addEventListener('ready', (event) => {").length, 2, 'exactly one actual ready callback')
assert.match(readyTransportBody, /attachBrowserToolTransport/)
assert.match(readyTransportBody, /streamReady = true/)
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
    'browserToolUserSelections', 'chatBindingNonce', 'ChatState', 'BrowserGrant', 'servicesRef', 'browserToolRoomKeyFor',
    `${grantSource}\n${selectedSources}\nreturn {registerBrowserToolSelection,browserToolSelectedSources,browserToolThreadGrants,browserToolGrantFor,revokeBrowserToolGrants}`)(state,
    (codex, id) => codex.threads.find(thread => thread.id === id), doc, structuredClone, grants,
    () => 'explicit-user-token', ChatState, BrowserGrant, servicesRef, () => undefined /* L1 c25: no room-account flag here: the default sign-in */)
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

test('BRW-11: a standing interaction grant re-issues the one-time token each turn until the Card, account or site changes', async () => {
  const current = { cardId: 'browser-a', cardEpoch: 'epoch-a', profileId: 'firefox-default', accountId: 'account-a', userContextId: 0,
    engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 3, url: 'https://shop.example.test/cart' }
  const card = { id: 'browser-a', isConnected: true, dataset: {}, classList: { contains: name => name === 'egd-browser-card' },
    _browserControls: { toolBinding: () => ({ ...current }), agentControlState: () => ({ held: false }) } }
  const source = { id: 'source-a', kind: 'browser', browserToolPermission: 'observe',
    sourceRef: { viewId: 'browser-a', uri: current.url, profileId: current.profileId, accountId: current.accountId },
    browserToolIdentity: { cardEpoch: current.cardEpoch, userContextId: 0, engineAccountKey: current.engineAccountKey, authorityEpoch: 3 } }
  const state = { codex: { threads: [{ id: 'thread-a', clientBindingId: 'client-a', inputSources: [] }] } }
  const tokens = new Map()
  let minted = 0
  const selectors = new Function('state', 'getCodexThreadById', 'document', 'structuredClone',
    'browserToolUserSelections', 'chatBindingNonce', 'ChatState', 'BrowserGrant', 'servicesRef', 'browserToolRoomKeyFor',
    `${grantSource}\n${selectedSources}\nreturn {registerBrowserToolSelection,browserToolSelectedSources,browserToolThreadGrants,revokeBrowserToolGrants}`)(state,
    (codex, id) => codex.threads.find(thread => thread.id === id), { getElementById: id => id === 'browser-a' ? card : null }, structuredClone,
    tokens, () => `token-${++minted}`, ChatState, BrowserGrant, servicesRef, () => undefined)
  const selected = selectors.registerBrowserToolSelection('thread-a', source, 'interact')
  state.codex.threads[0].inputSources = [selected]
  assert.equal(selectors.browserToolThreadGrants.size, 1, 'an interaction pick is a standing grant for the conversation')
  assert.equal(selectors.browserToolThreadGrants.get('client-a\u0000browser-a').site, 'example.test')
  assert.equal(selectors.browserToolSelectedSources('thread-a')[0].browserToolSelection.token, 'token-1')
  tokens.get('token-1').usedRunId = 'run-1'
  const next = selectors.browserToolSelectedSources('thread-a')
  assert.equal(next.length, 1, 'the next turn is not asked again')
  assert.equal(next[0].browserToolSelection.token, 'token-2')
  assert.equal(next[0].browserToolPermission, 'interact')
  assert.equal(next[0].id, 'source-a', 'same chip, fresh one-time token')
  assert.equal(tokens.get('token-2').usedRunId, null)
  current.url = 'https://www.example.test/other'
  tokens.get('token-2').usedRunId = 'run-2'
  // Replay the Codex send order: capture preparation used to throw on the old URL before the selection could renew.
  const capture = async inputs => captureInputSources(ChatState.claudeBrowserSendPlan({ engineId: 'codex', selectedInputs: inputs }).captureInputs,
    { browser: async () => ({ text: 'result page', url: current.url }) }, { nextId: () => 'snap' })
  assert.notEqual(selected.sourceRef.uri, current.url)
  assert.deepEqual(await capture(state.codex.threads[0].inputSources), [], 'the live Card carries no immutable snapshot')
  await assert.rejects(capture([{ ...selected, browserToolPermission: 'observe' }]), /첨부 후 페이지 주소가 바뀌었습니다/, 'a read attachment remains locked to its original page')
  assert.equal(selectors.browserToolSelectedSources('thread-a')[0].sourceRef.uri, current.url, 'same site, another page: still granted, current URL')
  assert.equal(tokens.get('token-3').selectedUrl, current.url)
  assert.deepEqual(selectors.browserToolSelectedSources('thread-b', [selected]), [], 'cannot carry the live chip to another conversation')
  current.url = 'https://elsewhere.test/'
  tokens.get('token-3').usedRunId = 'run-3'
  assert.deepEqual(selectors.browserToolSelectedSources('thread-a'), [], 'the person steered the Card to another site: the grant ends')
  assert.equal(selectors.browserToolThreadGrants.size, 0)
  current.url = 'https://shop.example.test/cart'
  selectors.registerBrowserToolSelection('thread-a', source, 'interact')
  assert.equal(selectors.browserToolThreadGrants.size, 1)
  selectors.registerBrowserToolSelection('thread-a', source, 'observe')
  assert.equal(selectors.browserToolThreadGrants.size, 0, 'a read pick turns the grant read-only')
  state.codex.threads[0].inputSources = [selectors.registerBrowserToolSelection('thread-a', source, 'interact')]
  tokens.get('token-6').usedRunId = 'run-6'
  current.authorityEpoch = 4
  assert.deepEqual(selectors.browserToolSelectedSources('thread-a'), [], 'an account authority change ends the grant')
  assert.equal(selectors.browserToolThreadGrants.size, 0)
  current.authorityEpoch = 3
  selectors.registerBrowserToolSelection('thread-a', source, 'interact')
  assert.equal(selectors.revokeBrowserToolGrants({ clientThreadId: 'client-a', cardId: 'browser-a' }), 1, 'explicit revocation')
  assert.equal(selectors.browserToolThreadGrants.size, 0)
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
  let holdAction = null, holdAfterAuthorization = null
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
        if (holdAfterAuthorization) await holdAfterAuthorization
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
    'browserToolActionLeases', 'browserToolStoppedRuns', 'chatBindingNonce', 'Date', 'performance', 'BROWSER_TOOL_REPLY_MARGIN_MS',
    'BrowserGrant', 'servicesRef', 'browserToolRoomKeyFor', 'browserToolRoomKeyOf', 'browserToolBindingRooms',
    `let browserToolFixtureLastAction = null;\nconst browserToolFixtureAuthorizationByCard = new Map();\n${grantSource}\n${dispatchSource}\n` +
    'return {browserToolDispatch,browserToolAuthorizePhysicalAction,browserToolFixtureActionDiagnostic,browserToolThreadGrants,browserToolThreadSites}')(doc,
    { knownCodexAccountKey: key => typeof key === 'string' && key.startsWith('codex:') },
    runBindings, cancelled, receipts, leases, userSelections, pendingBindings, actionLeases, stoppedRuns,
    () => `lease-${++nonce}`, { now: () => clockMs }, { timeOrigin: 0, now: () => clockMs }, 500, BrowserGrant, servicesRef,
    () => undefined, () => undefined, new WeakMap() /* L1 c25: no room-account flag here: the default sign-in */)
  authorizePhysicalAction = transport.browserToolAuthorizePhysicalAction
  let sequence = 0
  const req = (kind, extra = {}) => ({ version: 1, requestId: `request-${++sequence}`,
    deadlineMs: clockMs + 10000, runId: 'run-a', clientThreadId: 'thread-a', cardId: 'browser-a',
    targetCardEpoch: 'card-generation-a', kind, ...extra })
  const selection = (permission = 'interact', clientThreadId = 'thread-a', selectionToken = 'explicit-selection-a') => {
    const value = { cardId: 'browser-a', cardEpoch: current.cardEpoch,
      profileId: current.profileId, accountId: current.accountId,
      userContextId: current.userContextId, engineAccountKey: current.engineAccountKey,
      authorityEpoch: current.authorityEpoch, selectedUrl: current.url, permission,
      selectionToken, clientThreadId, sourceId: 'selected-source-a' }
    userSelections.set(value.selectionToken, { ...value, token: value.selectionToken,
      threadId: value.clientThreadId, usedRunId: null })
    return value
  }
  return { dispatch: transport.browserToolDispatch, authorize: transport.browserToolAuthorizePhysicalAction,
    fixtureActionDiagnostic: transport.browserToolFixtureActionDiagnostic,
    threadGrants: transport.browserToolThreadGrants, threadSites: transport.browserToolThreadSites,
    req, selection, current, card, browser, ownerWindow,
    runBindings, pendingBindings, cancelled, stoppedRuns, userSelections, actionLeases, leases,
    get actionCalls() { return actionCalls }, get domEffects() { return domEffects },
    hold(promise) { holdAction = promise }, holdAfterAuthorization(promise) { holdAfterAuthorization = promise },
    now: () => clockMs, advance(ms) { clockMs += ms } }
}

function projectionFixture(f = fixture()) {
  const projectionSource = between('  function browserToolDisplayPoint(action, guard) {',
    '  function browserToolAuthorizePhysicalAction(')
  const { createBrowserAgentProjection, browserToolDisplayPoint, browserToolProjectionCurrent } = new Function(
    'browserToolActionLeases', 'browserToolRunBindings', 'browserToolCardLeases',
    'browserToolCancelledRuns', 'browserToolStoppedRuns', 'browserToolRoomKeyOf', `${projectionSource}\n` +
    'return {createBrowserAgentProjection,browserToolDisplayPoint,browserToolProjectionCurrent}')(
    f.actionLeases, f.runBindings, f.leases, f.cancelled, f.stoppedRuns, () => undefined /* L1 c25: no room-account flag here */)
  let seq = 0
  const timers = new Map(), frames = new Map()
  const scheduler = {
    setTimeout(fn, delay) { const id = ++seq; timers.set(id, { fn, at: f.now() + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    requestAnimationFrame(fn) { const id = ++seq; frames.set(id, fn); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
  }
  f.card.dataset = {}
  const marker = { hidden: true, style: {} }
  const projection = createBrowserAgentProjection({ card: f.card, marker,
    current: browserToolProjectionCurrent, scheduler, now: f.now })
  f.card._browserControls.toolPrepareAgentProjection = projection.prepare
  const guard = { documentId: 'doc-1', revision: 2,
    viewport: { width: 720, height: 480, devicePixelRatio: 2 },
    target: { ref: 'el_1', bounds: { x: 90, y: 80, width: 180, height: 80 } } }
  return { ...f, f, marker, projection, guard, point: browserToolDisplayPoint, timers, frames,
    frame() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn() },
    tick(ms) { f.advance(ms); for (const [id, timer] of [...timers]) {
      if (timer.at <= f.now()) { timers.delete(id); timer.fn() }
    } },
  }
}

async function pendingProjection(p) {
  const bound = await p.f.dispatch(p.f.req('bind', { selection: p.f.selection('interact') }))
  let release
  p.f.holdAfterAuthorization(new Promise(resolve => { release = resolve }))
  const request = p.f.req('act', { binding: bound.binding, guard: p.guard, action: { type: 'click', ref: 'el_1' } })
  const result = p.f.dispatch(request)
  await Promise.resolve()
  return { result, release, request, lease: [...p.f.actionLeases.values()][0] }
}

test('approved request projects its observed target without waiting for drawing or input ACK', async () => {
  const p = projectionFixture()
  const pending = await pendingProjection(p)
  assert.equal(p.marker.hidden, false)
  assert.equal(p.marker.style.left, '25%')
  assert.equal(p.marker.style.top, '25%')
  assert.equal(p.f.card.dataset.egdAgentActivity, 'true')
  assert.equal(p.f.domEffects, 1, 'no animation/timer/arrival gate before existing input')
  assert.equal(p.frames.size, 1)
  const before = JSON.stringify(p.guard)
  p.f.card.style = { transform: 'translate(500px, 200px) scale(0.2)' }
  p.frame()
  assert.equal(p.marker.hidden, false, 'Desk camera-only changes do not revoke a stable target')
  assert.equal(JSON.stringify(p.guard), before)
  pending.release()
  assert.equal((await pending.result).status, 'acted')
  assert.equal(p.marker.hidden, true)
  assert.equal(p.f.card.dataset.egdAgentActivity, undefined)
  assert.equal(p.timers.size + p.frames.size, 0)
})

test('unapproved or denied requests never display an Agent target', async () => {
  const p = projectionFixture()
  const bound = await p.f.dispatch(p.f.req('bind', { selection: p.f.selection('interact') }))
  let release
  p.f.hold(new Promise(resolve => { release = resolve }))
  const result = p.f.dispatch(p.f.req('act', { binding: bound.binding, guard: p.guard,
    action: { type: 'click', ref: 'el_1' } }))
  await Promise.resolve()
  assert.equal(p.marker.hidden, true)
  assert.equal(p.f.card.dataset.egdAgentActivity, undefined)
  p.f.current.accountId = 'changed'
  release()
  assert.equal((await result).status, 'rejected')
  assert.equal(p.marker.hidden, true)
  assert.equal(p.f.domEffects, 0)
})

test('projection clears on cancel, Stop, deadline, document/card/authority change and cannot resurrect', async () => {
  for (const reason of ['cancel', 'Stop', 'deadline', 'document', 'closed', 'account', 'card-epoch', 'request', 'reload', 'dispose']) {
    const p = projectionFixture()
    const pending = await pendingProjection(p)
    assert.equal(p.marker.hidden, false, reason)
    if (reason === 'cancel') {
      await p.f.dispatch(p.f.req('cancel'))
      assert.equal(p.marker.hidden, true, 'cancel clears before its receipt, without waiting for paint')
    }
    if (reason === 'Stop') productionStopHarness(p.f).interrupt()
    if (reason === 'deadline') p.tick(11000)
    if (reason === 'document') p.f.browser.browsingContext.currentWindowGlobal = { innerWindowId: 999 }
    if (reason === 'closed') p.f.card.isConnected = false
    if (reason === 'account') p.f.current.authorityEpoch++
    if (reason === 'card-epoch') p.f.current.cardEpoch = 'replacement-card'
    if (reason === 'request') p.f.leases.set(p.f.current.cardEpoch, 'different-request')
    if (reason === 'reload') p.projection.invalidate()
    if (reason === 'dispose') p.projection.dispose()
    p.frame()
    assert.equal(p.marker.hidden, true, reason)
    assert.equal(p.f.card.dataset.egdAgentActivity, undefined, reason)
    pending.lease.projection.show()
    assert.equal(p.marker.hidden, true, `${reason}: old callback cannot resurrect`)
    pending.release()
    await pending.result
    assert.equal(p.marker.hidden, true, `${reason}: late receipt cannot resurrect`)
  }
})

test('display geometry is bounded, numeric-only and never changes guarded input geometry', async () => {
  const p = projectionFixture()
  const action = { type: 'click', ref: 'el_1' }
  const original = JSON.stringify(p.guard)
  assert.deepEqual(p.point(action, p.guard), { x: 25, y: 25 })
  for (const bounds of [null, { x: NaN, y: 1, width: 2, height: 2 },
    { x: 0, y: 0, width: Infinity, height: 2 }, { x: '1', y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: -1, height: 2 }, { x: 900, y: 10, width: 30, height: 20 }]) {
    const guard = { ...p.guard, target: { ref: 'el_1', bounds } }
    assert.equal(p.point(action, guard), null)
  }
  assert.equal(p.point(action, { ...p.guard, viewport: { width: 0, height: 480 } }), null)
  assert.equal(p.point(action, { ...p.guard, target: { ...p.guard.target, ref: 'other' } }), null)
  assert.equal(p.point({ type: 'navigate' }, p.guard), null)
  assert.equal(JSON.stringify(p.guard), original)
  p.guard.target.bounds.x = 900
  const pending = await pendingProjection(p)
  assert.equal(p.marker.hidden, true, 'offscreen display is omitted, not an input rejection')
  assert.equal(p.f.card.dataset.egdAgentActivity, 'true')
  assert.equal(p.f.domEffects, 1)
  pending.release()
  assert.equal((await pending.result).status, 'acted')
})

test('projection failures do not change physical authorization or receipts', async () => {
  for (const phase of ['prepare', 'show', 'clear']) {
    const f = fixture()
    f.card._browserControls.toolPrepareAgentProjection = () => {
      if (phase === 'prepare') throw Error('display unavailable')
      return { show() { if (phase === 'show') throw Error('paint failed') },
        clear() { if (phase === 'clear') throw Error('cleanup failed') } }
    }
    const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
    const result = await f.dispatch(f.req('act', { binding: bound.binding,
      guard: { documentId: 'doc-1', revision: 2 }, action: { type: 'click', ref: 'el_1' } }))
    assert.equal(result.status, 'acted', phase)
    assert.equal(f.domEffects, 1, phase)
  }
})

test('a pending authorization cannot restore a projection invalidated by reload', async () => {
  const p = projectionFixture()
  const bound = await p.f.dispatch(p.f.req('bind', { selection: p.f.selection('interact') }))
  let release
  p.f.hold(new Promise(resolve => { release = resolve }))
  const result = p.f.dispatch(p.f.req('act', { binding: bound.binding, guard: p.guard,
    action: { type: 'click', ref: 'el_1' } }))
  await Promise.resolve()
  p.projection.invalidate()
  release()
  assert.equal((await result).status, 'acted', 'display invalidation does not override actor authority')
  assert.equal(p.marker.hidden, true)
  assert.equal(p.frames.size + p.timers.size, 0)
})

test('old request cleanup cannot clear a newer projection, and Cards remain isolated', async () => {
  const p = projectionFixture(), other = projectionFixture()
  const first = await pendingProjection(p)
  const simultaneous = await pendingProjection(other)
  first.release()
  await first.result
  assert.equal(other.marker.hidden, false)
  let release
  p.f.holdAfterAuthorization(new Promise(resolve => { release = resolve }))
  const second = p.f.dispatch(p.f.req('act', { binding: first.lease.bound.binding, guard: p.guard,
    action: { type: 'click', ref: 'el_1' } }))
  await Promise.resolve()
  assert.equal(p.marker.hidden, false)
  first.lease.projection.clear()
  first.lease.projection.show()
  assert.equal(p.marker.hidden, false)
  p.frame()
  assert.equal(p.marker.hidden, false)
  release()
  await second
  simultaneous.release()
  await simultaneous.result
})

test('human reload clears display synchronously without changing the reload path', () => {
  const reloadSource = between('    const reloadBrowser = () => {', '    const stopBrowser = () => {')
  const order = []
  const reload = new Function('agentProjection', 'setBrowserLoading', 'xulBrowser', 'loadBrowserUri', 'browserState',
    `let agentNavigationGuard = null;\n${reloadSource}\nreturn reloadBrowser`)(
    { invalidate: () => order.push('hide') }, () => order.push('loading'),
    { reload: () => order.push('reload') }, () => assert.fail('unexpected fallback'), {})
  assert.equal(reload(), true)
  assert.deepEqual(order, ['hide', 'loading', 'reload'])
})

test('only real viewport changes clear target display; camera fitting remains display-only', () => {
  const layout = between('    const updateFitScale = () => {', '    presentation.layout = updateFitScale;')
  const realResize = layout.slice(layout.indexOf('if (size !== lastCardSize)'), layout.indexOf('const zoom = canvasZoom()'))
  assert(realResize.includes('agentProjection.invalidate()'))
  assert(!layout.slice(layout.indexOf('const zoom = canvasZoom()')).includes('agentProjection.invalidate()'))
  const pageZoom = between('    const onBrowserPageZoom = () => {', '    const onBrowserTitle = ')
  assert(pageZoom.includes('agentProjection.invalidate()'))
})

test('Agent target is decorative; outline dot preserves the existing center icon and hide rules', () => {
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8')
  assert.match(source, /class: 'egd-browser-agent-target', 'aria-hidden': 'true', hidden: true/)
  assert.match(source, /wrap\.appendChild\(agentTargetMarker\)/)
  assert.match(css, /\.egd-browser-agent-target\s*\{[^}]*pointer-events: none !important/s)
  assert.match(css, /data-egd-agent-activity="true"[^\n]*\.egd-semantic-proxy\[data-lod="outline"\]::after/)
  assert.match(css, /\.egd-semantic-center\s*\{[^}]*justify-content: center/s)
  const helper = between('  function browserToolDisplayPoint(action, guard) {', '  function browserToolAuthorizePhysicalAction(')
  assert.doesNotMatch(helper, /\.focus\(|\.click\(|dispatchEvent\(|scrollIntoView|canvasZoom|expectedRevision/)
  const load = between('    const onBrowserLoadStart = () => {', '    const onBrowserPageZoom = ')
  assert.match(load, /agentProjection\.invalidate\(\)/)
  const cleanup = between('    const cleanupCard = () => {\n      try { unregisterBrowserAuthorizer', '    console.warn(TAG, \'browser Desk Window spawned\'')
  assert.match(cleanup, /agentProjection\.dispose\(\)/)
})

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
    'agentBridgeId', 'browserCardState', `let unregisterBrowserAuthorizer = null, registeredBrowserContextId = null;\n${toolBindingSource}\n` +
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
  // The chrome browser survives a Gecko browsing-context replacement. A later binding
  // must register only the new context; retaining the old dispose handle is not enough.
  const nextGlobal = { innerWindowId: 202 }
  const nextContext = { ...context, id: 102, currentWindowGlobal: nextGlobal }
  nextContext.top = nextContext
  nextGlobal.browsingContext = nextContext
  xulBrowser.browsingContext = nextContext
  const nextParent = new EGDeskBrowserAgentRuntimeParent()
  nextParent.browsingContext = nextContext
  nextParent.manager = nextGlobal
  const ask = (actor, leaseId) => actor.receiveMessage({ name: 'authorizeAct', data: { leaseId } })
  assert.equal(ask(nextParent, 'exact-lease').reason, 'missing-authorizer')
  install.browserToolBinding()
  assert.equal(ask(nextParent, 'exact-lease').authorized, true, 'rebind exact current context after replacement')
  assert.equal(ask(nextParent, 'ungranted-lease').authorized, false)
  assert.equal(ask(parent, 'exact-lease').authorized, false, 'old context stays revoked')
  install.dispose()
  assert.equal(ask(nextParent, 'exact-lease').authorized, false)
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

test('same Card across conversations: old token cannot grant; fresh selection acts once; stopped run stays refused', async () => {
  const f = fixture()
  const guard = { documentId: 'doc-1', revision: 2 }, action = { type: 'click', ref: 'el_1' }
  const first = f.selection()
  const bind1 = await f.dispatch(f.req('bind', { selection: first }))
  assert.equal((await f.dispatch(f.req('act', { binding: bind1.binding, guard, action }))).status, 'acted')
  await f.dispatch(f.req('cancel'))
  const next = { runId: 'run-b', clientThreadId: 'thread-b' }
  assert.equal((await f.dispatch(f.req('bind', { ...next, selection: first }))).status, 'rejected')
  assert.equal((await f.dispatch(f.req('act', { ...next, binding: bind1.binding, guard, action }))).status, 'rejected')
  const selection = f.selection('interact', next.clientThreadId, 'token-b')
  const bind2 = await f.dispatch(f.req('bind', { ...next, selection }))
  assert.equal(bind2.status, 'bound')
  assert.equal((await f.dispatch(f.req('act', { ...next, binding: bind2.binding, guard, action }))).status, 'acted')
  f.stoppedRuns.add(JSON.stringify([next.runId, next.clientThreadId]))
  assert.equal((await f.dispatch(f.req('act', { ...next, binding: bind2.binding, guard, action }))).status, 'rejected')
  assert.equal(f.domEffects, 2)
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
  const toolAct = cardTools({ browser: xulBrowser, bindingCheck: expected => assert.equal(expected, binding),
    query: async (method, payload) => {
      assert.equal(method, 'act')
      assert.deepEqual(payload.action, { type: 'click', ref: 'el_2' })
      return actorResult
    } }).act
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

function productionStopHarness(f, { run: runFields = {}, thread: threadFields = {}, engines = [] } = {}) {
  const revoke = new Function('browserToolRunBindings', 'browserToolPendingBindings',
    'browserToolActionLeases', 'browserToolCancelledRuns', 'browserToolStoppedRuns',
    'browserToolUserSelections', 'ChatState', 'document', 'BrowserGrant', 'servicesRef',
    `${grantSource}\n${stopRevokeSource}\nreturn revokeBrowserToolRunImmediately`)(
    f.runBindings, f.pendingBindings, f.actionLeases, f.cancelled, f.stoppedRuns, f.userSelections,
    ChatState, { getElementById: () => null }, BrowserGrant, servicesRef)
  const run = { runId: 'run-a', clientThreadId: 'thread-a', conversationId: 'conversation-a',
    status: 'inProgress', stopPending: false, ...runFields }
  const thread = { id: 'local-room', clientBindingId: 'thread-a', ...threadFields }
  const state = { codex: { activeThreadId: thread.id, engines } }
  const protocol = ChatState.createChatProtocolState()
  protocol.runs[ChatState.runKey(run.conversationId, run.runId)] = run
  const epochScope = ChatState.createChatEpochScope()
  const begunScopes = []
  let releaseHttp
  const interrupt = new Function('state', 'getCodexThreadById', 'ChatState', 'protocol',
    'epochScope', 'revokeBrowserToolRunImmediately', 'emit', 'fetchJson', 'updateThreadById',
    `return async function interrupt(threadId = state.codex.activeThreadId) {${interruptBody}\n      }`)(
    state, (_codex, id) => id === thread.id ? thread : null,
    ChatState, protocol,
    { ...epochScope, begin: (...scope) => { begunScopes.push(scope); return epochScope.begin(...scope) } }, revoke, () => {},
    async (path, options) => {
      assert.equal(path, '/chat/interrupt')
      assert.deepEqual(JSON.parse(options.body), { conversationId: run.conversationId, runId: run.runId })
      return new Promise(resolve => { releaseHttp = resolve })
    }, () => {})
  return { run, interrupt, begunScopes, get releaseHttp() { return releaseHttp } }
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
  assert.deepEqual(stop.begunScopes, [['codex', 'codex-default']])
  assert.equal(stop.run.stopPending, true)
  assert.equal(f.runBindings.size, 0, 'UI binding is revoked before the first HTTP await')
  assert.equal(f.actionLeases.size, 0, 'Parent approval has no live action lease after Stop')
  releaseActor()
  assert.equal((await action).status, 'rejected')
  assert.equal(f.domEffects, 0, 'Stop before physical approval must produce zero DOM effects')
  stop.releaseHttp({ accepted: true, stopRequested: true })
  await stopping
})

test('production Stop uses the recorded Claude run profile, then the actual thread profile resolver', async () => {
  for (const [run, thread, expected] of [
    [{ engineId: 'claude', engineProfileId: 'claude-run-slot' },
      { engineId: 'claude', engineProfileId: 'claude-thread-slot' }, 'claude-run-slot'],
    [{ engine: { id: 'claude', engineProfileId: 'claude-envelope-slot' } },
      { engineId: 'claude', engineProfileId: 'claude-thread-slot' }, 'claude-envelope-slot'],
    [{ engineId: 'claude' }, { engineId: 'claude', engineProfileId: 'claude-thread-slot' }, 'claude-thread-slot'],
    [{ engineId: 'claude' }, { engineId: 'claude' }, 'claude-active-slot'],
  ]) {
    const f = fixture()
    const stop = productionStopHarness(f, { run, thread,
      engines: [{ id: 'claude', profiles: [{ id: 'claude-active-slot', active: true }] }] })
    const stopping = stop.interrupt()
    assert.deepEqual(stop.begunScopes, [['claude', expected]])
    assert.equal(typeof stop.releaseHttp, 'function')
    assert.equal(stop.run.stopPending, true)
    assert(f.stoppedRuns.has(JSON.stringify(['run-a', 'thread-a'])),
      'profile-aware Stop still tombstones the run before its HTTP response')
    stop.releaseHttp({ accepted: true, stopRequested: true })
    await stopping
    assert.equal(stop.run.status, 'stopping')
    assert.equal(stop.run.stopRequested, true)
    assert.equal(stop.run.stopPending, false)
    assert.equal(await stop.interrupt(), false, 'no duplicate Stop while stopping')
    assert.equal(stop.begunScopes.length, 1)
  }
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

// BRW-06: wait is read-only and travels on the existing observe request.
test('UI observe forwards a read-only wait to the actor without an action lease, and not after Stop', async () => {
  const f = fixture()
  const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
  const seen = []
  f.card._browserControls.toolObserve = async (_binding, options) => {
    seen.push(options)
    return { cardId: 'browser-a', documentId: 'doc-1', revision: 2, readyState: 'complete',
      viewport: { width: 720, height: 480, devicePixelRatio: 1 }, url: f.current.url, text: [], interactiveElements: [],
      wait: { for: options.wait?.for, outcome: 'met', elapsedMs: 3 } }
  }
  const wait = { for: 'load', timeoutMs: 3000, notDocumentId: 'doc-0' }
  const response = await f.dispatch(f.req('observe', { binding: bound.binding, options: { textLimit: 60, elementLimit: 80, wait } }))
  assert.equal(response.status, 'observed')
  assert.deepEqual(seen[0].wait, wait)
  assert.equal(response.snapshot.wait.outcome, 'met')
  assert.equal(f.actionLeases.size, 0)
  assert.equal(f.actionCalls, 0)
  f.stoppedRuns.add(JSON.stringify(['run-a', 'thread-a']))
  const stopped = await f.dispatch(f.req('observe', { binding: bound.binding, options: { wait } }))
  assert.equal(stopped.status, 'rejected')
  assert.equal(seen.length, 1, 'a stopped run never reaches the actor wait')
})

// These two turn on when Main wires scroll/press into eg-desk-surface.uc.js
// (browserToolDispatchOnce action allow-list and browserToolAct receipt).
const surfaceScrollPressWired = /'scroll'/.test(dispatchSource) && /'press'/.test(dispatchSource)
const surfaceReceiptWired = toolActSource.includes('browserToolDispatchReceiptFields')

test('UI dispatch leases guarded scroll and press by exact action type and refuses them after Stop',
  { skip: !surfaceScrollPressWired && 'pending Main wiring: scroll/press in browserToolDispatchOnce action allow-list' }, async () => {
  const f = fixture()
  const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
  const guard = { documentId: 'doc-1', revision: 2, scroll: { x: 0, y: 0, maxY: 900 } }
  const scrolled = await f.dispatch(f.req('act', { binding: bound.binding, guard,
    action: { type: 'scroll', direction: 'down', amount: 'page' } }))
  assert.equal(scrolled.status, 'acted')
  const pressed = await f.dispatch(f.req('act', { binding: bound.binding, guard: { ...guard, pressPolicy: 'already-focused' },
    action: { type: 'press', ref: 'el_2', key: 'Escape' } }))
  assert.equal(pressed.status, 'acted')
  for (const action of [{ type: 'press', key: 'Enter' }, { type: 'scroll', selector: 'body', direction: 'down', amount: 'page' }]) {
    assert.equal((await f.dispatch(f.req('act', { binding: bound.binding, guard, action }))).status, 'rejected', JSON.stringify(action))
  }
  assert.equal(f.domEffects, 2)
  f.stoppedRuns.add(JSON.stringify(['run-a', 'thread-a']))
  const stopped = await f.dispatch(f.req('act', { binding: bound.binding, guard,
    action: { type: 'scroll', direction: 'up', amount: 'page' } }))
  assert.equal(stopped.status, 'rejected')
  assert.equal(f.actionCalls, 2, 'no actor dispatch after Stop')
})

test('production Browser Card receipt carries only the bounded scroll/press route fields',
  { skip: !surfaceReceiptWired && 'pending Main wiring: browserToolAct -> browserToolDispatchReceiptFields' }, async () => {
  const windowGlobal = { id: 'window-global-a' }
  const xulBrowser = { browsingContext: { currentWindowGlobal: windowGlobal } }
  let actorResult
  const toolAct = cardTools({ browser: xulBrowser, query: async () => actorResult }).act
  const lease = { leaseId: 'lease-a', requestId: 'request-a', deadlineMs: Date.now() + 5000 }
  actorResult = { ok: true, result: { dispatchDiagnostics: { inputRoute: 'dom-scroll-api', mode: 'document',
    scrollBefore: { x: 0, y: 0 }, scrollAfter: { x: 0, y: 432 }, raw: 'actor-internal' } },
    after: { documentId: 'doc-a' }, observation: {} }
  const scroll = await toolAct({}, { type: 'scroll', direction: 'down', amount: 'page' }, {}, lease)
  assert.deepEqual(scroll.dispatchReceipt, { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true,
    inputRoute: 'dom-scroll-api', scrollMode: 'document' })
  actorResult = { ok: true, result: { dispatchDiagnostics: { inputRoute: 'dom-keyboard-event', key: 'Enter',
    trustedInput: false, targetKeyObserved: true, keydownDefaultPrevented: false,
    defaultActionEmulated: 'form-request-submit', focusPolicy: 'after-fill', value: 'typed text' } },
    after: { documentId: 'doc-a' }, observation: {} }
  const press = await toolAct({}, { type: 'press', ref: 'el_2', key: 'Enter' }, {}, lease)
  assert.equal(press.dispatchReceipt.inputRoute, 'dom-keyboard-event')
  assert.equal(press.dispatchReceipt.defaultActionEmulated, 'form-request-submit')
  assert.equal(JSON.stringify(press).includes('typed text'), false)
})

// BRW-08: frame refs and long fill text cross the surface unchanged; the fill
// receipt route needs Main to add 'fill' to browserToolAct's receipt list.
test('UI dispatch passes a same-origin frame ref and long fill text to the actor once, and none after Stop', async () => {
  const f = fixture()
  const actions = []
  const toolAct = f.card._browserControls.toolAct
  f.card._browserControls.toolAct = async (binding, action, guard, lease) => {
    actions.push({ action, guard })
    return toolAct(binding, action, guard, lease)
  }
  const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
  const text = '대표님께 드리는 보고. '.repeat(700).slice(0, 8000)
  const target = { ref: 'f3/el_12', role: 'textbox', label: 'Message body', href: '', value: '[editor text hidden: empty]', tag: 'div' }
  const filled = await f.dispatch(f.req('act', { binding: bound.binding, guard: { documentId: 'doc-1', revision: 2, target },
    action: { type: 'fill', ref: 'f3/el_12', text } }))
  assert.equal(filled.status, 'acted')
  assert.equal(actions.length, 1)
  assert.equal(actions[0].action.ref, 'f3/el_12', 'the lease and actor see the frame path unchanged')
  assert.equal(actions[0].action.text.length, 8000)
  assert.equal(actions[0].guard.target.ref, 'f3/el_12')
  f.stoppedRuns.add(JSON.stringify(['run-a', 'thread-a']))
  const stopped = await f.dispatch(f.req('act', { binding: bound.binding, guard: { documentId: 'doc-1', revision: 3, target },
    action: { type: 'fill', ref: 'f3/el_12', text: 'after stop' } }))
  assert.equal(stopped.status, 'rejected')
  assert.equal(f.actionCalls, 1, 'no actor dispatch after Stop')
  assert.equal(f.domEffects, 1)
})

const surfaceFillReceiptWired = /\[([^\]]*)\]\.includes\(action\.type\)\s*\?\s*BrowserAgentReceipts\.browserToolDispatchReceiptFields/
  .exec(toolActSource)?.[1]?.includes("'fill'") === true
test('production Browser Card receipt carries only the bounded fill event order',
  { skip: !surfaceFillReceiptWired && 'pending Main wiring: fill in browserToolAct receipt route list' }, async () => {
  const windowGlobal = { id: 'window-global-a' }
  const xulBrowser = { browsingContext: { currentWindowGlobal: windowGlobal } }
  const actorResult = { ok: true, result: { ok: true, ref: 'f1/el_2', dispatchDiagnostics: { inputRoute: 'dom-editor-replace',
    trustedInput: false, focusApi: 'not-called', selectionApi: 'not-called', eventOrder: ['beforeinput', 'input'],
    beforeInputCanceled: false, egdeskWroteContent: true, readbackMatches: true, text: 'TYPED_SECRET' } },
  after: { documentId: 'doc-a' }, observation: {} }
  const toolAct = cardTools({ browser: xulBrowser, query: async () => actorResult }).act
  const fill = await toolAct({}, { type: 'fill', ref: 'f1/el_2', text: 'TYPED_SECRET' }, {},
    { leaseId: 'lease-a', requestId: 'request-a', deadlineMs: Date.now() + 5000 })
  assert.deepEqual(fill.dispatchReceipt, { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true,
    inputRoute: 'dom-editor-replace', trustedInput: false, eventOrder: ['beforeinput', 'input'],
    beforeInputCanceled: false, egdeskWroteContent: true, readbackMatches: true })
  assert.equal(JSON.stringify(fill.dispatchReceipt).includes('TYPED_SECRET'), false)
})

// REA 웹8 (a), 웹4, 웹10: a refusal says whether input could have been sent.
// actorLike stands in for browserToolAct + the guarded actor: it asks the
// Parent-side authorizer with the native identities, then refuses or acts.
function actorLike(f, behavior = {}) {
  f.card._browserControls.toolAct = async (_binding, action, _guard, lease) => {
    const windowGlobal = f.browser.browsingContext.currentWindowGlobal
    if (behavior.beforeAuthorization) throw behavior.beforeAuthorization()
    const permitted = f.authorize({ browser: f.browser, browsingContext: f.browser.browsingContext, windowGlobal,
      leaseId: lease.leaseId, requestId: lease.requestId, deadlineMs: lease.deadlineMs, actionType: action.type,
      actionRef: action.ref || null, actionUrl: action.url || null,
      innerWindowId: windowGlobal.innerWindowId, browsingContextId: f.browser.browsingContext.id })
    if (!permitted) {
      throw Object.assign(new Error('Browser action authority was revoked before input [ui-denied]'),
        { browserToolActor: { dispatchPhase: 'not-dispatched', timing: { performCallsBefore: 4, performCallsAfter: 4 } } })
    }
    if (behavior.afterAuthorization) throw behavior.afterAuthorization()
    return { dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true,
      clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true },
    after: { cardId: 'browser-a' }, observation: null,
    timing: { performEnterMs: 10.5, firstEventAtMs: 11.25, performExitMs: 12, performCallsBefore: 4, performCallsAfter: 5 } }
  }
}
const actRequest = (f, bound, extra = {}) => f.req('act', { binding: bound.binding,
  guard: { documentId: 'doc-1', revision: 2, innerWindowId: 201, browsingContextId: 101 },
  action: { type: 'click', ref: 'el_1' }, ...extra })

test('refusals before any lease or actor work are not-dispatched and carry the receive time', async () => {
  for (const reason of ['hold', 'stop', 'cancel', 'size', 'reused']) {
    const f = fixture()
    const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
    let request = actRequest(f, bound)
    if (reason === 'hold') f.card._browserControls.toolUserHold = () => true
    if (reason === 'stop') f.stoppedRuns.add(JSON.stringify(['run-a', 'thread-a']))
    if (reason === 'cancel') f.cancelled.set(`run-a\u0000browser-a\u0000card-generation-a`, f.now() + 60000)
    // A newline-heavy fill the helper accepts (JSON 2 chars per newline,
    // text plus postcondition under 40000) still exceeds the 24000 UI limit.
    if (reason === 'size') {
      const text = 'Q\n\n\n'.repeat(1800)
      request = actRequest(f, bound, { action: { type: 'fill', ref: 'el_1', text },
        postcondition: { kind: 'target-value', value: text } })
      assert.ok(text.length <= 8000 && JSON.stringify(text).length * 2 < 40000 && JSON.stringify(request).length > 24000)
    }
    if (reason === 'reused') {
      await f.dispatch(request)
      request = { ...request, action: { type: 'click', ref: 'el_2' } }
    }
    const before = f.actionCalls
    const refused = await f.dispatch(request)
    assert.equal(refused.status, 'rejected', reason)
    assert.equal(refused.dispatchPhase, 'not-dispatched', reason)
    assert.ok(Number.isFinite(refused.timing.receivedAtMs) && refused.timing.receivedAtMs > 0, reason)
    assert.deepEqual(Object.keys(refused.timing), ['receivedAtMs'], reason)
    assert.equal(f.actionCalls, before, reason)
    // An observation refusal never claims a dispatch phase.
    const observe = await f.dispatch(f.req('observe', { binding: bound.binding,
      ...(reason === 'size' ? { options: { pad: 'x'.repeat(25000) } } : {}) }))
    if (observe.status === 'rejected') assert.equal(observe.dispatchPhase, undefined, reason)
  }
})

test('pause during an in-flight act keeps the person-only reason only for proven unsent input', async () => {
  for (const phase of ['not-dispatched', 'unknown']) {
    const f = fixture(), bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
    actorLike(f, { afterAuthorization: () => {
      f.card._browserControls.toolUserHold = () => true
      return Object.assign(new Error('Browser action authority was revoked before input [ui-denied]'), { browserToolActor: { dispatchPhase: phase, timing: phase === 'not-dispatched' ? { performCallsBefore: 4, performCallsAfter: 4 } : {} } })
    } })
    const refused = await f.dispatch(actRequest(f, bound))
    assert.equal(refused.dispatchPhase, phase); assert.equal(/operating this Browser Card directly/.test(refused.error), phase === 'not-dispatched')
  }
})

test('an actor refusal is not-dispatched only without lease approval or with an unchanged perform count', async () => {
  const expectations = {
    'denied-identity': 'not-dispatched', 'before-authorization': 'not-dispatched',
    'actor-proved-after-approval': 'not-dispatched', 'abort-after-approval': 'unknown',
    'actor-claim-without-counts': 'unknown', 'perform-entered': 'dispatched', 'contradicted-claim': 'unknown',
  }
  for (const [variant, phase] of Object.entries(expectations)) {
    const f = fixture()
    f.current.url = 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef'
    f.current.accountId = ''
    const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
    const abort = () => Object.assign(new Error("Actor 'EGDeskBrowserAgentRuntime' destroyed before query 'act' was resolved"),
      { name: 'AbortError' })
    actorLike(f, {
      'before-authorization': { beforeAuthorization: abort },
      'actor-proved-after-approval': { afterAuthorization: () => Object.assign(new Error('Browser observation is stale'),
        { browserToolActor: { dispatchPhase: 'not-dispatched', timing: { performCallsBefore: 4, performCallsAfter: 4 } } }) },
      'abort-after-approval': { afterAuthorization: abort },
      'actor-claim-without-counts': { afterAuthorization: () => Object.assign(new Error('Browser observation is stale'),
        { browserToolActor: { dispatchPhase: 'not-dispatched', timing: {} } }) },
      'perform-entered': { afterAuthorization: () => Object.assign(new Error('page click handler failed'),
        { browserToolActor: { dispatchPhase: 'dispatched', timing: { performEnterMs: 3, performExitMs: 4,
          performCallsBefore: 4, performCallsAfter: 5 } } }) },
      'contradicted-claim': { afterAuthorization: () => Object.assign(new Error('Browser observation is stale'),
        { browserToolActor: { dispatchPhase: 'not-dispatched', timing: { performEnterMs: 3, performCallsBefore: 4, performCallsAfter: 4 } } }) },
    }[variant] || {})
    const request = actRequest(f, bound, variant === 'denied-identity'
      ? { guard: { documentId: 'doc-1', revision: 2, innerWindowId: 999, browsingContextId: 101 } } : {})
    const refused = await f.dispatch(request)
    assert.equal(refused.status, 'rejected', variant)
    assert.equal(refused.dispatchPhase, phase, variant)
    const authorized = !['denied-identity', 'before-authorization'].includes(variant)
    assert.equal(Number.isFinite(refused.timing.authorizedAtMs), authorized, variant)
    assert.ok(refused.timing.receivedAtMs <= (refused.timing.authorizedAtMs ?? Infinity), variant)
    if (phase === 'not-dispatched') {
      for (const key of ['performEnterMs', 'performExitMs', 'firstEventAtMs']) assert.equal(refused.timing[key], undefined, variant)
      assert.equal(refused.timing.performCallsBefore, refused.timing.performCallsAfter, variant)
    }
    if (variant === 'denied-identity') {
      assert.equal(f.fixtureActionDiagnostic('browser-a').authorizationReason, 'inner-window-id-mismatch')
    }
  }
})

test('the Parent check refuses a guard from another Gecko document and a malformed identity never leases', async () => {
  const f = fixture()
  f.current.url = 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef'
  f.current.accountId = ''
  const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
  actorLike(f)
  const otherContext = await f.dispatch(actRequest(f, bound,
    { guard: { documentId: 'doc-1', revision: 2, innerWindowId: 201, browsingContextId: 555 } }))
  assert.equal(otherContext.dispatchPhase, 'not-dispatched')
  assert.equal(f.fixtureActionDiagnostic('browser-a').authorizationReason, 'browsing-context-id-mismatch')
  const calls = f.actionCalls
  for (const innerWindowId of [0, -1, 1.5, '201', null]) {
    const malformed = await f.dispatch(actRequest(f, bound, { guard: { documentId: 'doc-1', revision: 2, innerWindowId } }))
    assert.equal(malformed.dispatchPhase, 'not-dispatched', String(innerWindowId))
    assert.match(malformed.error, /stale/)
  }
  assert.equal(f.actionCalls, calls, 'no lease or actor call for a malformed identity')
  assert.equal(f.actionLeases.size, 0)
  // Without guard identities (an older helper) the native window-global checks still apply.
  const plain = await f.dispatch(actRequest(f, bound, { guard: { documentId: 'doc-1', revision: 2 } }))
  assert.equal(plain.status, 'acted')
  assert.equal(f.domEffects, 0, 'actorLike counts no DOM effects')
})

test('an acted reply lifts actor timing out of the receipt into one top-level same-clock record', async () => {
  const f = fixture()
  const bound = await f.dispatch(f.req('bind', { selection: f.selection('interact') }))
  actorLike(f)
  const acted = await f.dispatch(actRequest(f, bound))
  assert.equal(acted.status, 'acted')
  assert.equal(acted.receipt.timing, undefined)
  assert.deepEqual(Object.keys(acted.timing).sort(), ['authorizedAtMs', 'firstEventAtMs', 'performCallsAfter',
    'performCallsBefore', 'performEnterMs', 'performExitMs', 'receivedAtMs'])
  assert.ok(acted.timing.receivedAtMs <= acted.timing.authorizedAtMs)
  assert.equal(acted.timing.performCallsAfter, acted.timing.performCallsBefore + 1)
  const observed = await f.dispatch(f.req('observe', { binding: bound.binding }))
  assert.deepEqual(Object.keys(observed.timing), ['receivedAtMs'])
  assert.deepEqual(Object.keys((await f.dispatch(f.req('cancel'))).timing), ['receivedAtMs'])
})

// The helper (4c156f1) and this UI together: EGQ8 no longer needs a reselect.
async function helperOverUi() {
  const { createBrowserToolService } = await import('../helper/egdesk-browser-tool-runtime.mjs')
  const f = fixture()
  const selection = f.selection('interact')
  const note = { value: '' }
  const snapshot = () => ({ cardId: 'browser-a', documentId: 'doc-1', revision: 2, readyState: 'complete',
    innerWindowId: 201, browsingContextId: 101,
    viewport: { width: 720, height: 480, devicePixelRatio: 1 }, url: f.current.url, text: ['QA page'],
    interactiveElements: [{ ref: 'el_note', role: 'textbox', label: 'QA note', tag: 'input', href: '',
      value: note.value, disabled: false, bounds: { x: 10, y: 10, width: 100, height: 20 } }],
    focusedElement: null, scroll: { x: 0, y: 0, maxY: 0 } })
  f.card._browserControls.toolObserve = async () => snapshot()
  const acts = []
  f.card._browserControls.toolAct = async (_binding, action, guard, lease) => {
    acts.push({ action, guard })
    const windowGlobal = f.browser.browsingContext.currentWindowGlobal
    if (!f.authorize({ browser: f.browser, browsingContext: f.browser.browsingContext, windowGlobal,
      leaseId: lease.leaseId, requestId: lease.requestId, deadlineMs: lease.deadlineMs, actionType: action.type,
      actionRef: action.ref || null, actionUrl: null, innerWindowId: windowGlobal.innerWindowId,
      browsingContextId: f.browser.browsingContext.id })) throw new Error('Browser action authority was revoked before input')
    if (f.abortAfterApproval) throw Object.assign(new Error('actor destroyed'), { name: 'AbortError' })
    note.value = action.text
    return { dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true,
      inputRoute: 'dom-value-setter', trustedInput: false, eventOrder: ['input', 'change'] },
    after: snapshot(), observation: null }
  }
  const service = createBrowserToolService({ sendToUi: request => f.dispatch(request), getOwnerKey: () => selection.engineAccountKey })
  const source = { id: selection.sourceId, kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    sourceRef: { viewId: 'browser-a', profileId: selection.profileId, accountId: selection.accountId, uri: selection.selectedUrl },
    browserToolIdentity: { cardEpoch: selection.cardEpoch, userContextId: 0, engineAccountKey: selection.engineAccountKey,
      authorityEpoch: selection.authorityEpoch },
    browserToolSelection: { token: selection.selectionToken, threadId: 'thread-a' } }
  const prepared = service.prepare({ selectedSources: [source], ownerKey: selection.engineAccountKey })
  const run = { answerId: 'answer-a', runId: 'run-a', clientThreadId: 'thread-a', status: 'inProgress' }
  await service.bind(run, prepared)
  let calls = 0
  const observe = () => service.dispatch(run, { tool: 'egdesk_browser_observe', callId: `observe-${++calls}`, arguments: { cardId: 'browser-a' } })
  const fill = (observed, text) => service.dispatch(run, { tool: 'egdesk_browser_fill', callId: `fill-${++calls}`,
    arguments: { cardId: 'browser-a', observationId: observed.observationId, expectedRevision: observed.snapshot.revision,
      ref: 'el_note', expectedTarget: observed.snapshot.interactiveElements[0], text,
      postcondition: { kind: 'target-value', value: text } } })
  return { f, acts, note, observe, fill }
}

test('a newline-heavy fill refused for size spends only the observation; the same run re-observes and fills', async () => {
  const h = await helperOverUi()
  const first = await h.observe()
  assert.equal(first.snapshot.innerWindowId, 201)
  const long = 'Q\n\n\n'.repeat(1800)
  await assert.rejects(h.fill(first, long), error => error.code === 'BROWSER_OBSERVATION_STALE' &&
    error.dispatchPhase === 'not-dispatched' && Number.isFinite(error.timing.receivedAtMs))
  assert.equal(h.acts.length, 0, 'nothing reached the actor')
  await assert.rejects(h.fill(first, 'short'), error => error.code === 'BROWSER_OBSERVATION_STALE',
    'the refused attempt spent its observation')
  const again = await h.observe()
  const filled = await h.fill(again, 'QA after refusal')
  assert.equal(filled.status, 'postcondition-observed', 'no reselection was needed')
  assert.equal(h.note.value, 'QA after refusal')
  assert.equal(h.acts[0].guard.innerWindowId, 201)
  assert.equal(h.acts[0].guard.browsingContextId, 101)
  assert.ok(filled.timing.authorizedAtMs >= filled.timing.receivedAtMs)
})

test('an action whose outcome is unknown after approval still locks the Card (EG-01)', async () => {
  const h = await helperOverUi()
  h.f.abortAfterApproval = true
  await assert.rejects(h.fill(await h.observe(), 'QA unknown'), error => error.code === 'BROWSER_ACTION_UNVERIFIED' &&
    error.dispatchPhase === 'unknown')
  h.f.abortAfterApproval = false
  await assert.rejects(h.fill(await h.observe(), 'QA retry'), error => error.code === 'BROWSER_OUTCOME_UNKNOWN')
  assert.equal(h.note.value, '')
})

// REA 웹9: shared document-ready wait and the single AbortError retry.
const observeSource = between('    // REA 웹9: one shared wait per Card for a current, ready document.',
  '    const browserToolAct = async (expected, action, guard, lease) => {')
function observeFixture({ now = Date.now, scheduler = { setTimeout, clearTimeout } } = {}) {
  const timers = new Set()
  const win = {
    setTimeout(fn, ms) { const id = scheduler.setTimeout(() => { timers.delete(id); fn() }, ms); timers.add(id); return id },
    clearTimeout(id) { timers.delete(id); scheduler.clearTimeout(id) },
  }
  const windowGlobal = id => ({ innerWindowId: id, isClosed: false, isCurrentGlobal: true, getActor() { return {} } })
  const context = { currentWindowGlobal: windowGlobal(1) }
  const xulBrowser = { isConnected: true, browsingContext: context }
  const card = { id: 'browser-a', isConnected: true }
  const browserState = { loading: false }
  const activity = []
  const requests = []
  let actor = async () => ({ documentId: 'doc-a' })
  const api = new Function('xulBrowser', 'card', 'browserState', 'window', 'BROWSER_TOOL_REPLY_MARGIN_MS',
    'assertBrowserToolBinding', 'showAgentActivity', 'browserAgentActorRequest', 'Date',
    `${observeSource}\nreturn { whenToolWindowGlobalReady, browserToolObserve, disposeToolWindowGlobalWaits,
      diagnostic: () => lastToolObserve }`)(
    xulBrowser, card, browserState, win, 500,
    () => { if (!xulBrowser.browsingContext?.currentWindowGlobal) throw new Error('Selected Browser Card is unavailable') },
    message => activity.push(message),
    async (method, payload) => { requests.push({ method, payload, innerWindowId: context.currentWindowGlobal?.innerWindowId }); return actor(payload) }, { now })
  return { ...api, context, xulBrowser, card, browserState, windowGlobal, timers, activity, requests,
    setActor(fn) { actor = fn } }
}
const abortError = () => Object.assign(new Error("Actor 'EGDeskBrowserAgentRuntime' destroyed before query 'snapshot' was resolved"),
  { name: 'AbortError' })
const later = ms => new Promise(resolve => setTimeout(resolve, ms))

test('an observation retries once on the replacement document after its actor is destroyed mid-query', async () => {
  const o = observeFixture()
  let call = 0
  o.setActor(async () => {
    if (++call === 1) {
      o.context.currentWindowGlobal = null // replacement document not committed yet
      setTimeout(() => { o.context.currentWindowGlobal = o.windowGlobal(2) }, 60)
      throw abortError()
    }
    return { documentId: 'doc-b', url: 'http://127.0.0.1/egdesk-qa/next' }
  })
  const snapshot = await o.browserToolObserve({}, { textLimit: 60 }, { deadlineMs: Date.now() + 5000 })
  assert.equal(snapshot.documentId, 'doc-b')
  assert.equal(snapshot.cardId, 'browser-a')
  assert.deepEqual(o.requests.map(item => item.innerWindowId), [1, 2])
  const record = o.diagnostic()
  assert.equal(record.attempts, 2)
  assert.equal(record.abortRetried, true)
  assert.deepEqual(record.innerWindowIds, [1, 2])
  assert.equal(o.timers.size, 0)
})

test('a second AbortError, any other failure, or a spent deadline is not retried', async () => {
  for (const variant of ['second-abort', 'timeout', 'deadline']) {
    const o = observeFixture()
    o.setActor(async () => {
      if (variant === 'timeout') throw Object.assign(new Error('Browser UI response timed out'), { name: 'Error' })
      throw abortError()
    })
    const deadlineMs = Date.now() + (variant === 'deadline' ? 400 : 5000)
    await assert.rejects(o.browserToolObserve({}, {}, { deadlineMs }), variant === 'timeout' ? /timed out/ : /destroyed/)
    assert.equal(o.requests.length, variant === 'second-abort' ? 2 : 1, variant)
    assert.equal(o.activity.at(-1), 'Browser 관찰 불가 · 다시 확인 필요', variant)
  }
  // No deadline (an internal caller) keeps the old single attempt.
  const o = observeFixture()
  o.setActor(async () => { throw abortError() })
  await assert.rejects(o.browserToolObserve({}, {}), /destroyed/)
  assert.equal(o.requests.length, 1)
})

test('a retried wait gets only the rest of its own timeout and reports the whole elapsed time', async t => {
  // A real setTimeout(80) is not proof that Date.now() advanced by >= 80.
  // Exercise the unchanged production source against one local clock/timer
  // boundary; exact measured costs replace scheduling-dependent tolerances.
  const cases = [
    { name: '79 measured ms leaves exactly 2921 ms', spentMs: 79, timeoutMs: 3000, deadlineInMs: 10000, remainingMs: 2921, elapsedMs: 84 },
    { name: '80 measured ms leaves exactly 2920 ms', spentMs: 80, timeoutMs: 3000, deadlineInMs: 10000, remainingMs: 2920, elapsedMs: 85 },
    { name: 'request deadline minus its reply margin caps the retry at 1420 ms', spentMs: 80, timeoutMs: 9000, deadlineInMs: 2000, remainingMs: 1420, elapsedMs: 85 },
  ]
  for (const row of cases) await t.test(row.name, async () => {
    let clockMs = 10000, sequence = 0
    const pending = new Map()
    const now = () => clockMs
    const scheduler = {
      setTimeout(fn, ms) { const id = ++sequence; pending.set(id, { fn, at: clockMs + ms }); return id },
      clearTimeout(id) { pending.delete(id) },
    }
    const delay = ms => new Promise(resolve => scheduler.setTimeout(resolve, ms))
    const tick = ms => {
      const until = clockMs + ms
      for (;;) {
        const next = [...pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        pending.delete(id); clockMs = timer.at; timer.fn()
      }
      clockMs = until
    }
    const o = observeFixture({ now, scheduler }), firstStarted = Promise.withResolvers(), retryStarted = Promise.withResolvers()
    const waits = [], retryElapsedMs = 5, startedAt = now()
    o.setActor(async payload => {
      waits.push(payload.options.wait)
      if (waits.length === 1) {
        firstStarted.resolve()
        await delay(row.spentMs)
        o.context.currentWindowGlobal = o.windowGlobal(2)
        throw abortError()
      }
      retryStarted.resolve()
      await delay(retryElapsedMs)
      return { documentId: 'doc-b', readyState: 'complete', wait: { for: 'load', outcome: 'met', elapsedMs: retryElapsedMs } }
    })
    const wait = { for: 'load', timeoutMs: row.timeoutMs, notDocumentId: 'doc-a' }
    const observing = o.browserToolObserve({}, { wait }, { deadlineMs: startedAt + row.deadlineInMs })
    await firstStarted.promise
    assert.equal(waits.length, 1)
    assert.deepEqual(waits[0], wait)
    tick(row.spentMs)
    await retryStarted.promise
    assert.deepEqual(waits[1], { ...wait, timeoutMs: row.remainingMs }, 'only the measured remaining budget is sent')
    assert.notEqual(waits[1], wait, 'retry options are a separate object')
    tick(retryElapsedMs)
    const snapshot = await observing
    assert.equal(snapshot.wait.elapsedMs, row.elapsedMs, 'elapsed includes the first attempt exactly once')
    assert.deepEqual(o.diagnostic(), { attempts: 2, abortRetried: true, innerWindowIds: [1, 2],
      waitOffsetMs: row.spentMs, sampledAtMs: startedAt + row.elapsedMs })
    assert.deepEqual(wait, { for: 'load', timeoutMs: row.timeoutMs, notDocumentId: 'doc-a' }, 'caller options are not mutated')
    assert.equal(o.requests.length, 2, 'one retry, never a new full wait')
    assert.equal(o.timers.size, 0); assert.equal(pending.size, 0)
  })
})

test('post-navigation load waits in chrome before querying the actor, without restarting the budget', async () => {
  for (const replaced of [true, false]) {
    let now = 1000, poll
    const o = observeFixture({ now: () => now, scheduler: { setTimeout(fn) { poll = fn; return 1 }, clearTimeout() {} } })
    const wait = { for: 'load', timeoutMs: 10000, notDocumentId: 'doc-a', notInnerWindowId: 1 }
    o.setActor(({ options }) => {
      assert.equal(options.wait.notDocumentId, 'doc-a', 'actor still checks the excluded document')
      assert.equal(options.wait.timeoutMs, replaced ? 9600 : 0)
      return { documentId: replaced ? 'doc-b' : 'doc-a', wait: { for: 'load', outcome: replaced ? 'met' : 'timeout', elapsedMs: 0 } }
    })
    const result = o.browserToolObserve({}, { wait }, { deadlineMs: now + 15000 })
    now += 200; poll()
    assert.equal(o.requests.length, 0, 'never start a long wait on the departing actor')
    if (replaced) o.context.currentWindowGlobal = o.windowGlobal(2)
    now += replaced ? 200 : 9800; poll()
    const snapshot = await result
    assert.deepEqual(o.requests.map(r => r.innerWindowId), [replaced ? 2 : 1])
    assert.equal(snapshot.wait.outcome, replaced ? 'met' : 'timeout')
    assert.equal(snapshot.wait.elapsedMs, replaced ? 400 : 10000)
    assert.equal(o.timers.size, 0)
  }
})

test('document-ready waiters share one poll per Card and each keeps its own deadline', async () => {
  const o = observeFixture()
  o.context.currentWindowGlobal = null
  const early = o.whenToolWindowGlobalReady(Date.now() + 560)
  const patient = o.whenToolWindowGlobalReady(Date.now() + 5000)
  assert.equal(o.timers.size, 1, 'one shared poll')
  await assert.rejects(early, /not ready before the request deadline/)
  assert.equal(o.timers.size, 1, 'the patient waiter keeps polling')
  const replacement = o.windowGlobal(9)
  o.context.currentWindowGlobal = replacement
  assert.equal(await patient, replacement)
  assert.equal(o.timers.size, 0)
  // A tab still loading its first page shows only the placeholder document.
  o.context.currentWindowGlobal = { ...o.windowGlobal(10), isInitialDocument: true }
  o.browserState.loading = true
  const initial = o.whenToolWindowGlobalReady(Date.now() + 5000)
  await later(50)
  o.browserState.loading = false
  assert.equal((await initial).innerWindowId, 10)
  // Closed globals and a closed Card never count as ready; closing rejects waiters.
  o.context.currentWindowGlobal = { ...o.windowGlobal(11), isClosed: true }
  const closing = o.whenToolWindowGlobalReady(Date.now() + 5000)
  o.disposeToolWindowGlobalWaits()
  await assert.rejects(closing, /unavailable/)
  assert.equal(o.timers.size, 0)
  assert.equal(await o.whenToolWindowGlobalReady(undefined), null, 'no deadline means no wait')
})

test('toolAct turns an actor refusal into a phase-carrying error and marks post-perform failures dispatched', async () => {
  const binding = { cardId: 'browser-a' }
  const context = { currentWindowGlobal: { id: 'window-global-a' } }
  const xulBrowser = { browsingContext: context }
  let actorResult, bindingFails = false
  const activity = []
  const toolAct = cardTools({ browser: xulBrowser,
    bindingCheck: () => { if (bindingFails) throw new Error('Browser Card, profile or account context changed') },
    activity: message => activity.push(message), query: async (method, payload) => {
      assert.equal(method, 'act')
      assert.equal(payload.options.settleMs, undefined, 'guarded settle uses the actor contract, not the legacy delay')
      assert.ok(payload.options.budgetMs > 0 && payload.options.budgetMs <= 4500)
      bindingFails = actorResult.failAfter === true
      return actorResult.value
    } }).act
  const lease = { leaseId: 'lease-a', requestId: 'request-a', deadlineMs: Date.now() + 5000 }
  actorResult = { value: { ok: false, refused: true, error: 'Browser observation is stale', dispatchPhase: 'not-dispatched',
    timing: { performCallsBefore: 2, performCallsAfter: 2 } } }
  await assert.rejects(toolAct(binding, { type: 'click', ref: 'el_1' }, {}, lease), error =>
    /stale/.test(error.message) && error.browserToolActor.dispatchPhase === 'not-dispatched' &&
    error.browserToolActor.timing.performCallsAfter === 2)
  assert.equal(activity.at(-1), '조작을 보내지 않음 · 다시 관찰 필요')
  const timing = { performEnterMs: 1, performExitMs: 2, performCallsBefore: 2, performCallsAfter: 3 }
  actorResult = { failAfter: true, value: { ok: true, result: {}, after: {}, observation: null, timing } }
  await assert.rejects(toolAct(binding, { type: 'click', ref: 'el_1' }, {}, lease), error =>
    error.browserToolActor.dispatchPhase === 'dispatched' && error.browserToolActor.timing === timing)
  bindingFails = false
  actorResult = { value: { ok: true, result: { clickDiagnostics: { dispatchScope: 'dom-click-no-pointerdown',
    targetClickObserved: true } }, after: { documentId: 'doc-a' }, observation: null, timing } }
  const receipt = await toolAct(binding, { type: 'click', ref: 'el_1' }, {}, lease)
  assert.equal(receipt.timing, timing, 'dispatch lifts this into the reply')
  assert.equal(receipt.dispatchReceipt.eventDispatched, true)
})

function connectCardTools(f, options) {
  const controls = cardTools({ browser: f.browser, now: f.now,
    bindingCheck(expected) {
      for (const key of ['cardId', 'cardEpoch', 'profileId', 'accountId', 'userContextId', 'engineAccountKey', 'authorityEpoch']) {
        if (expected[key] !== f.current[key]) throw new Error('Browser Card, profile or account context changed')
      }
    }, ...options })
  f.card._browserControls.toolAct = controls.act
  f.card._browserControls.toolReconcile = controls.reconcile
  return controls
}
const reconcileRequest = (f, bound, extra = {}) => f.req('reconcile', { binding: bound.binding,
  callId: 'native-call-a', actRequestId: 'wire-act-a', actSeq: 2, budgetMs: 3000, sentAtMs: f.now(),
  guard: { documentId: 'doc-1', innerWindowId: 201, browsingContextId: 101 }, ...extra })

test('S1 forwards original call and wire IDs with only the budget left after transport and UI work', async () => {
  const f = fixture(), queries = []
  const bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
  connectCardTools(f, { query: async (method, payload) => {
    queries.push({ method, payload })
    return { ok: true, result: {}, after: {}, timing: { actorReceivedAtMs: f.now() } }
  } })
  f.card._browserControls.toolPrepareAgentProjection = () => { f.advance(200) }
  const request = f.req('act', { binding: bound.binding, callId: 'native-original-call',
    budgetMs: 4000, sentAtMs: f.now() - 1000, guard: { documentId: 'doc-1', revision: 2 },
    action: { type: 'click', ref: 'el_1' } })
  const result = await f.dispatch(request)
  assert.equal(result.status, 'acted')
  assert.equal(queries.length, 1)
  assert.equal(queries[0].payload.options.callId, 'native-original-call')
  assert.equal(queries[0].payload.options.lease.requestId, request.requestId)
  assert.equal(queries[0].payload.options.budgetMs, 2300)
  assert.equal(queries[0].payload.options.settleMs, undefined)
  assert.equal(result.timing.actorReceivedAtMs, f.now())
  assert.equal(result.receipt.timing, undefined)
  assert.deepEqual(await f.dispatch(request), result, 'a duplicate wire request returns its original receipt')
  assert.equal((await f.dispatch({ ...request, callId: 'replacement-call' })).dispatchPhase, 'not-dispatched')
  assert.equal(queries.length, 1, 'neither a duplicate nor changed payload dispatches a second action')
})

test('S1 rejects malformed or spent relative budgets and spends projection time before the actor hop', async () => {
  for (const extra of [{ budgetMs: 0 }, { budgetMs: 60001 }, { budgetMs: 1.5 }, { budgetMs: '1000' },
    { callId: '' }, { callId: 'x'.repeat(161) }, { callId: 42 }, { sentAtMs: NaN }, { sentAtMs: 0 },
    { budgetMs: 500 }, { budgetMs: 1000, spent: 500 }, { budgetMs: 1000, projectionTime: 500 }]) {
    const f = fixture()
    const bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
    let queries = 0
    connectCardTools(f, { query: async () => { queries++; return { ok: true } } })
    f.card._browserControls.toolPrepareAgentProjection = () => { f.advance(extra.projectionTime || 0) }
    const request = f.req('act', { binding: bound.binding, guard: { documentId: 'doc-1', revision: 2 },
      action: { type: 'click', ref: 'el_1' }, ...extra })
    if (extra.spent) request.sentAtMs = f.now() - extra.spent
    const result = await f.dispatch(request)
    assert.equal(result.dispatchPhase, 'not-dispatched', JSON.stringify(extra))
    assert.equal(queries, 0)
    assert.equal(f.actionLeases.size, 0)
    assert.equal(f.leases.size, 0)
  }
})

test('S1 reconcile bypasses only the in-flight card lock, preserving call identity without a new lease', async () => {
  const f = fixture(), queries = []
  const bound = await f.dispatch(f.req('bind', { selection: f.selection('observe') }))
  f.leases.set(f.current.cardEpoch, 'in-flight-original-act')
  f.card._browserControls.toolWhenReady = () => { throw new Error('reconcile must not wait for navigation') }
  connectCardTools(f, { query: async (method, payload) => {
    queries.push({ method, payload })
    return { version: 1, ...payload, entered: false, fenced: true }
  } })
  const response = await f.dispatch(reconcileRequest(f, bound))
  assert.equal(response.status, 'reconciled')
  assert.deepEqual(queries, [{ method: 'reconcile', payload: {
    callId: 'native-call-a', requestId: 'wire-act-a', documentId: 'doc-1' } }])
  assert.equal(response.reconcile.entered, false)
  assert.equal(response.reconcile.fenced, true)
  assert.equal(f.leases.get(f.current.cardEpoch), 'in-flight-original-act')
  assert.equal(f.actionLeases.size, 0)
  assert.equal(f.domEffects, 0)
  assert.deepEqual(Object.keys(response.timing), ['receivedAtMs'])
})

test('S1 reconcile keeps stopped, cancelled, held, cross-chat, account and malformed-identity requests closed', async () => {
  for (const variant of ['stopped', 'cancelled', 'held', 'thread', 'account', 'epoch', 'call', 'document', 'window', 'context', 'request', 'sequence']) {
    const f = fixture(), bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
    let queries = 0
    connectCardTools(f, { query: async () => { queries++; return {} } })
    const request = reconcileRequest(f, bound)
    if (variant === 'stopped') f.stoppedRuns.add(JSON.stringify(['run-a', 'thread-a']))
    if (variant === 'cancelled') await f.dispatch(f.req('cancel'))
    if (variant === 'held') f.card._browserControls.toolUserHold = () => true
    if (variant === 'thread') request.clientThreadId = 'other-chat'
    if (variant === 'account') f.current.engineAccountKey = 'codex:other-account'
    if (variant === 'epoch') f.current.authorityEpoch++
    if (variant === 'call') delete request.callId
    if (variant === 'document') request.guard.documentId = ''
    if (variant === 'window') request.guard.innerWindowId = '201'
    if (variant === 'context') request.guard.browsingContextId = -1
    if (variant === 'request') request.actRequestId = ''
    if (variant === 'sequence') request.actSeq = 0
    assert.equal((await f.dispatch(request)).status, 'rejected', variant)
    assert.equal(queries, 0, variant)
    assert.equal(f.actionLeases.size, 0)
  }
})

test('S1 never asks a replacement document to prove an old call was not dispatched', async () => {
  for (const field of ['innerWindowId', 'browsingContextId']) {
    const f = fixture(), bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
    let queries = 0
    connectCardTools(f, { query: async () => { queries++; return {} } })
    const request = reconcileRequest(f, bound)
    request.guard[field]++
    const response = await f.dispatch(request)
    assert.equal(response.status, 'reconciled')
    assert.equal(response.reconcile.entered, 'unknown')
    assert.equal(response.reconcile.reason, 'other-document')
    assert.equal(queries, 0)
  }
})

test('S1 discards a late reconcile proof after document, account or run replacement', async () => {
  for (const variant of ['document', 'account', 'cancel']) {
    const f = fixture(), bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
    let release
    connectCardTools(f, { query: () => new Promise(resolve => { release = resolve }) })
    const pending = f.dispatch(reconcileRequest(f, bound))
    if (variant === 'document') f.browser.browsingContext.currentWindowGlobal = { innerWindowId: 202 }
    if (variant === 'account') f.current.authorityEpoch++
    if (variant === 'cancel') await f.dispatch(f.req('cancel'))
    release({ version: 1, callId: 'native-call-a', documentId: 'doc-1', entered: false, fenced: true })
    const response = await pending
    if (variant === 'document') assert.equal(response.reconcile.entered, 'unknown')
    else assert.equal(response.status, 'rejected', variant)
  }
})

function dialogFixture() {
  const listeners = new Map()
  const browser = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  const observer = new Function('browserToolSameNativeBrowser', `${dialogSource}\nreturn createBrowserToolDialogObserver`)(
    (a, b) => a === b)(browser)
  return { browser, observer, listeners,
    emit(name, detail, extra = {}) { listeners.get(name)?.({ isTrusted: true, target: browser, detail, ...extra }) } }
}

test('S1 native dialog observation keeps only four types and never reads prompt text or values', () => {
  const d = dialogFixture(), start = d.observer.checkpoint()
  const secret = { get text() { assert.fail('prompt text was read') }, get value() { assert.fail('prompt value was read') } }
  d.emit('DOMWillOpenModalDialog', { promptType: 'alert' }, { isTrusted: false })
  d.emit('DOMWillOpenModalDialog', { promptType: 'alert' }, { target: {} })
  assert.deepEqual(d.observer.read(start), { open: false, seen: false, dialog: null })
  for (const type of ['alert', 'confirm', 'prompt', 'beforeunload']) {
    const args = Object.create(secret)
    args.promptType = type === 'beforeunload' ? 'confirmEx' : type
    args.inPermitUnload = type === 'beforeunload'
    d.emit('DOMWillOpenModalDialog', { inPermitUnload: args.inPermitUnload })
    d.browser.tabDialogBox = { getContentDialogManager: () => ({ dialogs: [{ frameContentWindow: { Dialog: { args } } }] }) }
    assert.deepEqual(d.observer.read().dialog, { type })
    d.browser.tabDialogBox = null
    const checkpoint = d.observer.checkpoint()
    d.emit('DOMModalDialogClosed', { promptType: type, get value() { assert.fail('close value was read') } })
    assert.deepEqual(d.observer.read(checkpoint), { open: false, seen: true, dialog: { type } })
    assert.equal(d.observer.read().dialog, null, 'closed dialogs do not leak into later calls')
  }
  d.emit('DOMWillOpenModalDialog', { promptType: 'promptPassword' })
  assert.deepEqual(d.observer.read(), { open: true, seen: true, dialog: null })
  d.observer.dispose()
  assert.equal(d.listeners.size, 0)
  assert.match(source, /toolDialogs\.dispose\(\)/)
})

test('S1 carries dialog type through acted, rejected and bounded reconcile replies without inventing success', async () => {
  for (const kind of ['acted', 'refused', 'lost', 'reconcile']) {
    const f = fixture(), bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
    const dialogs = { checkpoint: () => 0, read: () => ({ open: true, seen: true, dialog: { type: 'prompt', text: 'SECRET' } }) }
    let timeout, cleared = 0
    connectCardTools(f, { dialogs, scheduler: { setTimeout(fn, ms) { timeout = fn; assert.equal(ms, 2500); return 1 },
      clearTimeout() { cleared++ } }, query: async () => {
      if (kind === 'reconcile') return new Promise(() => {})
      if (kind === 'lost') throw new Error('actor disappeared')
      if (kind === 'refused') return { refused: true, dispatchPhase: 'not-dispatched', error: 'stale' }
      return { ok: true, result: {}, after: {} }
    } })
    const pending = f.dispatch(kind === 'reconcile' ? reconcileRequest(f, bound) : actRequest(f, bound))
    if (kind === 'reconcile') timeout()
    const response = await pending
    assert.deepEqual(response.dialog, { type: 'prompt' }, kind)
    assert.equal(JSON.stringify(response).includes('SECRET'), false)
    assert.equal(response.receipt?.dialog, undefined)
    if (kind === 'reconcile') {
      assert.equal(response.reconcile.entered, 'unknown')
      assert.equal(response.reconcile.reason, 'no-answer')
      assert.equal(cleared, 1)
    }
  }
  assert.match(source, /const outcome = response\?\.dialog \|\| response\?\.dispatchPhase === 'unknown' \? 'unknown'/,
    'the visible activity row must not turn a dialog-bound response into confirmed success')
})

test('S1 an untyped native modal cannot turn a fenced response into proof of no input', async () => {
  const f = fixture(), bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
  connectCardTools(f, { dialogs: { checkpoint: () => 0, read: () => ({ open: true, seen: true, dialog: null }) },
    query: async (_method, payload) => ({ version: 1, ...payload, entered: false, fenced: true }) })
  const response = await f.dispatch(reconcileRequest(f, bound))
  assert.equal(response.reconcile.entered, 'unknown')
  assert.equal(response.reconcile.reason, 'dialog-open')
  assert.equal(response.dialog, undefined, 'unknown types are not mislabeled')
})

test('S1 an untyped native modal also keeps actor refusal and lost response outcomes unknown', async () => {
  for (const lost of [false, true]) {
    const f = fixture(), bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
    connectCardTools(f, { dialogs: { checkpoint: () => 0, read: () => ({ open: true, seen: true, dialog: null }) },
      query: async () => {
        if (lost) throw new Error('actor lost')
        return { refused: true, dispatchPhase: 'not-dispatched', timing: { performCallsBefore: 0, performCallsAfter: 0 } }
      } })
    const response = await f.dispatch(actRequest(f, bound))
    assert.equal(response.status, 'rejected')
    assert.equal(response.dispatchPhase, 'unknown')
    assert.equal(response.dialog, undefined)
  }
})

test('S1 relays structural obscuredBy and actor hop timing on refusals, never arbitrary actor fields', async () => {
  for (const obscuredBy of ['div#shade.modal role=dialog', 'SECRET\nvalue', { text: 'SECRET' }, 'x'.repeat(161)]) {
    const f = fixture(), bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
    connectCardTools(f, { query: async () => ({ refused: true, error: 'Browser target is obscured',
      obscuredBy, secret: 'SECRET', dispatchPhase: 'not-dispatched',
      timing: { actorReceivedAtMs: f.now(), performCallsBefore: 4, performCallsAfter: 4, secret: 'SECRET' } }) })
    const response = await f.dispatch(actRequest(f, bound))
    assert.equal(response.dispatchPhase, 'not-dispatched')
    assert.equal(response.obscuredBy, typeof obscuredBy === 'string' && obscuredBy.startsWith('div') ? obscuredBy : undefined)
    assert.equal(response.timing.actorReceivedAtMs, f.now())
    assert.equal(JSON.stringify(response).includes('SECRET'), false)
  }
})

test('S1 actual actor fencing prevents a late approved call from entering perform after reconciliation', async () => {
  globalThis.JSWindowActorChild ||= class {}
  const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs')
  const f = fixture(), bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
  const actor = new EGDeskBrowserAgentRuntimeChild()
  actor.documentId = 'doc-1'
  actor.assertGuard = () => {}
  actor.snapshot = () => ({ documentId: 'doc-1' })
  actor.clockMs = f.now
  actor.monoNow = f.now
  let release, performed = 0
  actor.perform = () => { performed++; return {} }
  actor.sendQuery = async (_name, lease) => {
    await new Promise(resolve => { release = resolve })
    return { authorized: f.authorize({ ...lease, browser: f.browser,
      browsingContext: f.browser.browsingContext, windowGlobal: f.browser.browsingContext.currentWindowGlobal }) }
  }
  connectCardTools(f, { query: (name, data) => actor.receiveMessage({ name, data }) })
  const request = actRequest(f, bound)
  request.callId = 'native-call-a'
  const pending = f.dispatch(request)
  assert.equal(f.leases.size, 1)
  const reconciled = await f.dispatch(reconcileRequest(f, bound, { actRequestId: request.requestId }))
  assert.equal(reconciled.reconcile.entered, false)
  assert.equal(reconciled.reconcile.fenced, true)
  assert.equal(actor.fences.has('call:native-call-a'), true)
  assert.equal(actor.fences.has(`request:${request.requestId}`), true)
  release()
  const refused = await pending
  assert.equal(refused.dispatchPhase, 'not-dispatched')
  assert.equal(refused.timing.performCallsBefore, refused.timing.performCallsAfter)
  assert.equal(actor.actorPerformCalls, 0)
  assert.equal(performed, 0)
  assert.equal(f.leases.size, 0)
  actor.recordPerformEntry(['call:entered-call'], f.now())
  const entered = await f.dispatch(reconcileRequest(f, bound, { callId: 'entered-call' }))
  assert.equal(entered.reconcile.entered, true)
  assert.equal(entered.reconcile.performing, true)
  assert.equal(entered.reconcile.timing.performEnterMs, f.now())
})

test('S1 wait_text activity recording never stores the sought text', async () => {
  const SurfaceState = await import('../overlay/resources/EGDeskSurfaceState.sys.mjs')
  const recorded = SurfaceState.browserAgentActivityRecord({ kind: 'observe', options: { wait: {
    for: 'text', text: 'SECRET_WAIT_NEEDLE', timeoutMs: 1000 } } })
  assert.equal(recorded.action.type, 'wait')
  assert.equal(JSON.stringify(recorded).includes('SECRET_WAIT_NEEDLE'), false)
})

test('BRW-10: the UI accepts guarded pointer-click and type-text acts and returns only the Parent-filtered route fields', async () => {
  const f = fixture()
  const bound = await f.dispatch(f.req('bind', { selection: f.selection() }))
  const diagnostics = {
    'pointer-click': { inputRoute: 'trusted-pointer', apiRoute: 'synthesizeMouseEvent', trustedInput: true,
      point: { x: 50, y: 25 }, displayPoint: { x: 250, y: 125 }, moveDispatched: true, downDispatched: true, upDispatched: true,
      compensatedUp: false, targetPointerObserved: true, targetClickObserved: true, eventsTrusted: true, label: 'LEAK' },
    'type-text': { inputRoute: 'trusted-text-input', trustedInput: true, textLength: 2, key: null, textCommitted: true,
      keyDispatched: false, targetInputObserved: true, targetKeyObserved: false, keydownConsumed: null, eventsTrusted: true,
      documentHasFocus: true, focusPolicy: 'already-focused', text: 'LEAK' },
  }
  const queries = []
  let projected = null
  f.card._browserControls.toolPrepareAgentProjection = lease => { projected = lease.displayPoint }
  for (const [type, extra] of [['pointer-click', {}], ['type-text', { text: 'hi' }]]) {
    connectCardTools(f, { query: async (method, payload) => {
      queries.push({ method, payload })
      return { ok: true, result: { dispatchDiagnostics: diagnostics[type] }, after: { documentId: 'doc-1' }, observation: null }
    } })
    const result = await f.dispatch(f.req('act', { binding: bound.binding, callId: `call-${type}`,
      guard: { documentId: 'doc-1', revision: 2, viewport: { width: 720, height: 480, devicePixelRatio: 1 },
        target: { ref: 'el_1', bounds: { x: 90, y: 80, width: 180, height: 80 } } },
      action: { type, ref: 'el_1', ...extra } }))
    assert.equal(result.status, 'acted', type)
    assert.equal(queries.at(-1).payload.action.type, type)
    assert.equal(JSON.stringify(result.receipt.dispatchReceipt).includes('LEAK'), false, `${type}: no page text or typed text`)
    assert.equal(result.receipt.dispatchReceipt.inputRoute, diagnostics[type].inputRoute)
    assert.equal(result.receipt.dispatchReceipt.trustedInput, true)
    assert.equal(result.receipt.dispatchReceipt.clickInputRoute, undefined, `${type} is not reported as a DOM click`)
    assert.deepEqual(projected, { x: 25, y: 25 }, `${type}: the Agent dot points at the observed target`)
  }
  assert.equal(queries.length, 2, 'one actor query per request; nothing retried')
})

test('BRW-13 (REA 5): the Agent dot glides from the Card\'s previous target and never delays input', async () => {
  const p = projectionFixture()
  const moves = []
  const marker = { hidden: true, layoutReads: 0, style: {
    set left(value) { moves.push(['left', value]) }, set top(value) { moves.push(['top', value]) } },
  getBoundingClientRect() { this.layoutReads++; moves.push(['layout']); return {} } }
  const projection = new Function('browserToolActionLeases', 'browserToolRunBindings', 'browserToolCardLeases',
    'browserToolCancelledRuns', 'browserToolStoppedRuns', `${between('  function browserToolDisplayPoint(action, guard) {',
      '  function browserToolAuthorizePhysicalAction(')}\nreturn createBrowserAgentProjection`)(
    p.f.actionLeases, p.f.runBindings, p.f.leases, p.f.cancelled, p.f.stoppedRuns)({ card: p.f.card, marker,
    current: () => true, scheduler: { setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} },
    now: p.f.now })
  const lease = point => ({ card: p.f.card, deadlineMs: p.f.now() + 5000, displayPoint: point })
  projection.prepare(lease({ x: 10, y: 20 })).show()
  assert.deepEqual(moves, [['left', '10%'], ['top', '20%']], 'the first target appears in place')
  assert.equal(marker.layoutReads, 0)
  moves.length = 0
  projection.prepare(lease({ x: 60, y: 40 })).show()
  assert.deepEqual(moves, [['left', '10%'], ['top', '20%'], ['layout'], ['left', '60%'], ['top', '40%']],
    'the next one starts where the last ended, so CSS eases the move')
  assert.equal(marker.hidden, false)
  // A request without a point moves nothing and keeps the last point for the next glide.
  moves.length = 0
  projection.prepare(lease(null)).show()
  assert.deepEqual(moves, [])
  projection.prepare(lease({ x: 5, y: 5 })).show()
  assert.deepEqual(moves.slice(0, 2), [['left', '60%'], ['top', '40%']])
})

test('BRW-13 (REA 5): the glide is a 150-250 ms ease on left/top and is off with reduced motion', () => {
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8')
  const rule = css.match(/\n\.egd-browser-agent-target \{\n  transition: ([^;]+);\n\}/)?.[1]
  assert.ok(rule, 'transition rule on the Agent dot')
  for (const part of rule.split(/,\s*(?=left|top)/)) {
    const [, property, ms] = part.trim().match(/^(left|top) (\d+)ms cubic-bezier\(/) || []
    assert.ok(property, part)
    assert.ok(Number(ms) >= 150 && Number(ms) <= 250, `${property} ${ms}ms`)
  }
  // The shared reduced-motion block turns every egd- transition off, the dot included.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] || ''
  assert.match(reduced, /\[class\*="egd-"\][\s\S]*transition: none !important;/)
  assert.match(css, /\.egd-browser-agent-target \{[^}]*pointer-events: none !important;/, 'still never takes input')
})
