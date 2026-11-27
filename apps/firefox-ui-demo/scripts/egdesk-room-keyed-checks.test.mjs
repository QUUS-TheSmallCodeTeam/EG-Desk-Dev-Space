// L1 c24 (U11, owner decision "a room's checks use the ROOM's account"): the window's input-read, receipt, evidence and Briefing fences were keyed to the
// default sign-in (and its cache), so a room on another Codex engine profile worked only while the default account was signed in and unchanged. With the
// room-account flag (codex.roomAccountMode === 'on', mirroring pref egdesk.roomAccount) they are keyed to the room's own account. Each case below is
// run with the default signed out, the default being someone else, and the room's account changing mid-check. The window functions are the real ones
// (extracted from eg-desk-surface.uc.js); the chat state, requests and runs are built by the real ChatState reducers. Mocks only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const a = surface.indexOf(`  function ${name}(`); assert.ok(a >= 0, name); return surface.slice(a, surface.indexOf('\n  }\n', a) + 4) }
const SLOT = 'codex-p1b2c3d4e5'
const signedIn = email => ({ isLoggedIn: true, authMode: 'chatgpt', accountEmail: email })
const engines = (slotAccount = 'b@example.test') => [{ id: 'codex', status: 'ready', profiles: [
  { id: 'codex-default', active: true, auth: { status: 'signedIn', account: 'a@example.test' } },
  { id: SLOT, auth: slotAccount ? { status: 'signedIn', account: slotAccount } : { status: 'signedOut', account: null } }] }]
const SLOT_KEY = account => `codex:slot:${SLOT}:${account}`

// a chat state with one room; flag mirrors pref egdesk.roomAccount
function world({ flag = 'on', defaultAuth = signedIn('a@example.test'), room: roomKind = 'slot' } = {}) {
  const protocol = ChatState.createChatProtocolState()
  const room = { id: 'room-b', type: 'dm', title: 'B방', engineId: 'codex', engineProfileId: roomKind === 'slot' ? SLOT : 'codex-default', conversationId: 'conv-b', clientBindingId: 'room-b',
    localConversationId: 'local-b', bindingState: 'verified', bindingAccountKey: roomKind === 'slot' ? SLOT_KEY('b@example.test') : ChatState.codexAccountKey(defaultAuth), retainedNativeBinding: null,
    messages: [{ id: 'u1', role: 'user', requestId: 'req-1', content: '질문' }] }
  const codex = { threads: [room], engines: engines(), authStatus: defaultAuth, codexAccountKey: ChatState.codexAccountKey(defaultAuth), connected: true, chatProtocol: protocol, activeThreadId: 'room-b', roomAccountMode: flag }
  return { codex, room, protocol, state: { codex } }
}
// the window's registration, then the server's acceptance, as the product does them
function accepted(w) {
  const { codex, room, protocol } = w
  ChatState.registerChatRequest(protocol, { requestId: 'req-1', clientThreadId: 'room-b', localThreadId: 'room-b', conversationId: room.conversationId }, codex.authStatus, 'codex',
    ChatState.roomAccountScope(room, codex).accountKey)
  const identity = { conversationId: 'conv-b', runId: 'run-b', answerId: ChatState.runKey('conv-b', 'run-b') }
  const run = ChatState.acceptChatRequest(protocol, { accepted: true, requestId: 'req-1', clientThreadId: 'room-b', localThreadId: 'room-b', ...identity }, 'req-1')
  const result = { accepted: true, durable: true, requestId: 'req-1', clientThreadId: 'room-b', localConversationId: 'local-b', localRunId: 'lr-1', localMessageId: 'lm-1', ...identity }
  return { run, result, identity }
}
const windowFns = state => new Function('state', 'ChatState', `${decl('rememberAcceptedInputReceipt')}\n${decl('acceptedInputReceipt')}\nreturn { remember: rememberAcceptedInputReceipt, receipt: acceptedInputReceipt };`)(state, ChatState)

test('flag off (the default): a profile room is keyed to the default sign-in exactly as before', () => {
  const w = world({ flag: 'off' })
  const scope = ChatState.roomAccountScope(w.room, w.codex)
  assert.deepEqual({ ...scope }, { accountKey: ChatState.codexAccountKey(w.codex.authStatus), cachedAccountKey: w.codex.codexAccountKey, access: undefined, slot: false })
  assert.equal(ChatState.roomAccountScope(w.room, { ...w.codex, roomAccountMode: undefined }).slot, false, 'a plain state object without the property is "off"')
  w.codex.authStatus = { isLoggedIn: false }
  assert.equal(ChatState.roomAccountScope(w.room, w.codex).accountKey, null, 'default signed out: the profile room has no account (the old behaviour)')
  assert.deepEqual(ChatState.roomAccountParts(w.room, w.codex, ['x', 'y']), ['x', 'y'])
  const fns = windowFns(w.state), { run, result } = (() => { w.codex.authStatus = signedIn('a@example.test'); return accepted(w) })()
  assert.equal(fns.remember(w.room, result, 'req-1', run), true, 'default signed in and cached: accepted as before')
  w.codex.authStatus = { isLoggedIn: false }
  assert.equal(fns.receipt(w.room, { conversationId: 'conv-b', runId: 'run-b', answerId: ChatState.runKey('conv-b', 'run-b') }), null, 'default signed out: refused as before')
})

test('flag on, receipts: a profile room\'s accepted-input receipt is kept and read while the default is signed out, and while the default is someone else', () => {
  for (const defaultAuth of [{ isLoggedIn: false }, signedIn('someone-else@example.test')]) {
    const w = world({ defaultAuth }), fns = windowFns(w.state)
    const { run, result, identity } = accepted(w)
    assert.equal(run.accountKey, SLOT_KEY('b@example.test'), 'the request was registered with the room\'s own account')
    assert.equal(fns.remember(w.room, result, 'req-1', run), true, JSON.stringify(defaultAuth))
    const receipt = fns.receipt(w.room, identity)
    assert.deepEqual([receipt?.requestId, receipt?.localMessageId], ['req-1', 'lm-1'])
  }
})

test('flag on, account change mid-check: the room\'s OWN account changing ends the receipt; the default changing does not', () => {
  const w = world({ defaultAuth: signedIn('a@example.test') }), fns = windowFns(w.state)
  const { run, result, identity } = accepted(w)
  assert.equal(fns.remember(w.room, result, 'req-1', run), true)
  assert.ok(fns.receipt(w.room, identity))
  // the default account changes (another sign-in, then signed out): nothing about this room changed
  w.codex.authStatus = signedIn('c@example.test'); w.codex.codexAccountKey = ChatState.codexAccountKey(w.codex.authStatus)
  assert.ok(fns.receipt(w.room, identity), 'the default switched: the profile room\'s receipt stands')
  w.codex.authStatus = { isLoggedIn: false }
  assert.ok(fns.receipt(w.room, identity), 'the default signed out: still')
  // the room's own account changes (another account signs in to that profile)
  w.codex.engines = engines('z@example.test')
  assert.equal(fns.receipt(w.room, identity), null, 'the room\'s account changed: the receipt is no longer that account\'s')
  w.codex.engines = engines(null) // signed out on the profile
  assert.equal(fns.receipt(w.room, identity), null)
  // a receipt cannot be remembered for a request registered under a different account
  const other = world(), otherFns = windowFns(other.state)
  const first = accepted(other); other.codex.engines = engines('z@example.test')
  assert.equal(otherFns.remember(other.room, first.result, 'req-1', first.run), false)
})

test('flag on, the default room is unchanged: keyed to the default sign-in; default signed out or changed ends it', () => {
  const w = world({ room: 'default' }), fns = windowFns(w.state)
  const { run, result, identity } = accepted(w)
  assert.equal(run.accountKey, ChatState.codexAccountKey(w.codex.authStatus))
  assert.equal(fns.remember(w.room, result, 'req-1', run), true)
  assert.ok(fns.receipt(w.room, identity))
  w.codex.authStatus = signedIn('c@example.test') // the default account changed (the window's cache is not yet updated)
  assert.equal(fns.receipt(w.room, identity), null)
  w.codex.authStatus = { isLoggedIn: false }
  assert.equal(fns.receipt(w.room, identity), null)
  // the profile's account does not matter to a default room
  const d = world({ room: 'default' }), dFns = windowFns(d.state), got = accepted(d)
  assert.equal(dFns.remember(d.room, got.result, 'req-1', got.run), true)
  d.codex.engines = engines('z@example.test'); assert.ok(dFns.receipt(d.room, got.identity))
})

test('flag on, input reads of a restored room: the pair is accepted against the room\'s own account (default signed out or someone else), refused when that account changed', () => {
  for (const defaultAuth of [{ isLoggedIn: false }, signedIn('someone-else@example.test')]) {
    const w = world({ defaultAuth })
    const key = SLOT_KEY('b@example.test')
    const room = { ...w.room, retainedNativeBinding: { conversationId: 'conv-b', clientThreadId: 'room-b', accountKey: key } }
    const scope = { engineId: 'codex', engineProfileId: SLOT, clientThreadId: 'room-b', conversationId: 'conv-b' }
    const reference = { sourceId: 's1', snapshotId: 's1', hash: 'h'.repeat(64), contextScope: { ...scope } }
    const acct = ChatState.roomAccountScope(room, w.codex)
    assert.doesNotThrow(() => InputContext.inputReadContext(reference, scope, { thread: room, accountKey: acct.accountKey, cachedAccountKey: acct.cachedAccountKey }), JSON.stringify(defaultAuth))
    // the room's account changed mid-check: the same read is refused
    w.codex.engines = engines('z@example.test')
    const changed = ChatState.roomAccountScope(room, w.codex)
    assert.throws(() => InputContext.inputReadContext(reference, scope, { thread: room, accountKey: changed.accountKey, cachedAccountKey: changed.cachedAccountKey }), /원래 연결/)
    // and the default's key would have refused the unchanged room (the old coupling)
    w.codex.engines = engines()
    assert.throws(() => InputContext.inputReadContext(reference, scope, { thread: room, accountKey: ChatState.codexAccountKey(defaultAuth), cachedAccountKey: w.codex.codexAccountKey }), /원래 연결/)
  }
})

test('flag on, change signatures (the async fences): a profile room\'s signature moves with ITS account and not with the default; a default room\'s the other way round', () => {
  const w = world(), parts = () => JSON.stringify(ChatState.roomAccountParts(w.room, w.codex, [w.codex.codexAccountKey, w.codex.authStatus.accountEmail, w.codex.authStatus.isLoggedIn]))
  const before = parts()
  w.codex.authStatus = signedIn('c@example.test'); w.codex.codexAccountKey = ChatState.codexAccountKey(w.codex.authStatus)
  assert.equal(parts(), before, 'the default account changed: a pending check on the profile room is not cancelled')
  w.codex.authStatus = { isLoggedIn: false }
  assert.equal(parts(), before, 'the default signed out: still')
  w.codex.engines = engines('z@example.test')
  assert.notEqual(parts(), before, 'the room\'s own account changed: the check ends')
  w.codex.engines = engines(); assert.equal(parts(), before, 'back (the signature is a value; ABA is the callers\' latch)')
  const d = world({ room: 'default' }), dParts = () => JSON.stringify(ChatState.roomAccountParts(d.room, d.codex, [d.codex.codexAccountKey, d.codex.authStatus.accountEmail, d.codex.authStatus.isLoggedIn]))
  const dBefore = dParts(); d.codex.engines = engines('z@example.test'); assert.equal(dParts(), dBefore, 'a default room ignores the profile')
  d.codex.authStatus = signedIn('c@example.test'); assert.notEqual(dParts(), dBefore)
})

test('flag on, sending: context tools need the ROOM\'s sign-in, the resolver\'s account is the room\'s, and the request carries it', () => {
  const w = world({ defaultAuth: { isLoggedIn: false } })
  const thread = { ...w.room, conversationId: null }
  assert.ok(ChatState.contextCapabilitiesForRequest(thread, w.codex.authStatus, [], w.codex), 'default signed out: the profile room still gets context capabilities')
  assert.equal(ChatState.contextCapabilitiesForRequest(thread, w.codex.authStatus, []), null, 'the old call (default only) is unchanged')
  const off = world({ flag: 'off', defaultAuth: { isLoggedIn: false } })
  assert.equal(ChatState.contextCapabilitiesForRequest({ ...off.room, conversationId: null }, off.codex.authStatus, [], off.codex), null, 'flag off: as before')
  const key = ChatState.roomAccountScope(w.room, w.codex).accountKey
  // the resolver's list is reused for the room only under the room's own account key
  const entry = { accountKey: key, receivedAt: Date.now(), resolution: { resolutionId: 'res-1', candidates: [] } }
  assert.deepEqual(ChatState.contextResolutionForSend(entry, [], { accountKey: key }), { resolutionId: 'res-1', chosen: [] })
  assert.equal(ChatState.contextResolutionForSend(entry, [], { accountKey: ChatState.codexAccountKey(signedIn('a@example.test')) }), null, 'the default\'s key is not this room\'s'
  )
  assert.equal(ChatState.roomAccountScope(w.room, w.codex).access, null, 'the default account\'s quota state is not a profile room\'s')
  w.codex.authStatus = { ...signedIn('a@example.test'), access: { state: 'permissionDenied' } }
  assert.equal(ChatState.roomAccountScope(w.room, w.codex).access, null)
  assert.equal(ChatState.roomAccountScope({ ...w.room, engineProfileId: 'codex-default' }, w.codex).access, 'permissionDenied', 'a default room still sees it')
  const registered = ChatState.createChatProtocolState()
  ChatState.registerChatRequest(registered, { requestId: 'r' }, w.codex.authStatus, 'codex', key); assert.equal(registered.requests.r.accountKey, key)
  ChatState.registerChatRequest(registered, { requestId: 'd' }, signedIn('a@example.test'), 'codex'); assert.equal(registered.requests.d.accountKey, ChatState.codexAccountKey(signedIn('a@example.test')), 'no key given: the default sign-in, as before')
  ChatState.registerChatRequest(registered, { requestId: 'n' }, w.codex.authStatus, 'codex', null); assert.equal(registered.requests.n.accountKey, null, 'a room not signed in has no key: its fences fail closed')
})

test('the window wires the flag and every fence through the room-keyed helpers; what stays on the default sign-in is listed', () => {
  assert.match(surface, /Object\.defineProperty\(state\.codex, 'roomAccountMode', \{ enumerable: false, configurable: true,\n    get: \(\) => \{ try \{ return readSurfacePref\('egdesk\.roomAccount'\) === 'on' \? 'on' : 'off'; \} catch \{ return 'off'; \} \} \}\);/)
  assert.match(surface, /ChatState\.registerChatRequest\(protocol, \{ requestId, clientThreadId: ChatState\.clientThreadBinding\(activeThread\)/)
  assert.match(surface, /ChatState\.roomAccountScope\(activeThread, state\.codex\)\.accountKey\); \/\/ L1 c24: the request carries the room's own account/)
  assert.match(surface, /ChatState\.contextCapabilitiesForRequest\(activeThread, state\.codex\.authStatus, runtimeConfig\.contextSnapshotIds, state\.codex\)/)
  // no fence reads the default key by itself any more: what is left is the default part of a room-keyed signature, a settings screen and a Browser card
  const left = surface.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /ChatState\.codexAccountKey\((state\.codex\.authStatus|codex\.authStatus|auth)\)/.test(line)
    && !/roomAccountParts/.test(line)).map(([, line]) => line.trim())
  assert.deepEqual(left.map(line => line.replace(/\s+/g, ' ')), [
    '|| !!ChatState.codexAccountKey(state.codex.authStatus);', // the Agent-profile settings screen: the default sign-in gates the local profile store (not a room)
    'engineAccountKey: (roomKey === undefined ? ChatState.codexAccountKey(state.codex.authStatus) : roomKey) || null,', // the Browser card's binding without a room: the default sign-in is only the fallback when no room key is given (c25 passes every room's own key); listed in the c24 report
  ])
  // the room-keyed helpers are the ChatState module's, flag-aware and pure
  assert.equal(typeof ChatState.roomAccountScope, 'function'); assert.equal(typeof ChatState.roomAccountParts, 'function'); assert.equal(ChatState.roomAccountModeOn({ roomAccountMode: 'on' }), true)
})
