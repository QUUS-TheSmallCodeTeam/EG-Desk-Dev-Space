// L1 c19: the two couplings c18 left (A6, A7), now removed. Contract §14.1: "Run은 engineProfileId를 고정하며, 나중에 기본값을 바꿔도 active Run이
// 다른 account 또는 quota bucket으로 이동하지 않는다." A room on another Codex engine profile runs on that profile's account, so:
//   A6  the DEFAULT sign-in changing or signing out keeps that room's requests and runs in flight, its binding and its profile's epoch tokens;
//   A7  forking that room and saving a Briefing comment in it check that profile's account, not the default sign-in.
// The production functions run here (window update/reset, fork availability, the Briefing comment scope) over synthetic state; mocks only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const between = (from, to) => { const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, from); return surface.slice(a, b) }
const fn = name => { const a = surface.indexOf(`  function ${name}(`); assert.ok(a >= 0, name); return surface.slice(a, surface.indexOf('\n  }\n', a) + 4) }
const SLOT = 'codex-p1b2c3d4e5'
const signedIn = email => ({ isLoggedIn: true, authMode: 'chatgpt', accountEmail: email })
const enginesRows = ({ slotAccount = 'b@example.test', slotSignedIn = true } = {}) => [{ id: 'codex', status: 'ready', profiles: [
  { id: 'codex-default', active: true, owned: false, auth: { status: 'signedIn', method: 'chatgpt', account: 'a@example.test' } },
  { id: SLOT, active: false, owned: true, auth: slotSignedIn ? { status: 'signedIn', method: 'chatgpt', account: slotAccount } : { status: 'signedOut', method: null, account: null } }] }]
const slotKey = account => `codex:slot:${SLOT}:${account}`

function world({ rooms }) {
  const auth = signedIn('a@example.test')
  const state = { codex: { threads: rooms, engines: enginesRows(), authStatus: auth, codexAccountKey: ChatState.codexAccountKey(auth), connected: true, activeThreadId: rooms[0].id,
    chatProtocol: null, taskBoard: ChatState.createTaskBoard(), planProposals: ChatState.createPlanProposals(), contextSuggest: { byThread: {} } }, contextSuggest: { byThread: {} } }
  const protocol = ChatState.createChatProtocolState(); state.codex.chatProtocol = protocol
  const epochScope = ChatState.createChatEpochScope()
  const effects = { reconnect: 0, resets: [] }
  const definitions = between('    const resetThreadConversations = () => {', '    const fetchJson = async') + '\n' + between('    const update = (patch) => {', '    const findThreadIndexById')
  const sandbox = { ChatState, state, protocol, userInputDrafts: new Map(), document: { getElementById: () => null }, console,
    epochScope: { ...epochScope, reset: (scope, profile) => { effects.resets.push([scope, profile ?? null]); epochScope.reset(scope, profile) } },
    clearBrowserToolTransport() {}, resumedNativeBindings: new Set(), refreshing: new Map(), chatBindingNonce: () => 'fresh-binding',
    normalizeThreads() {}, emit() {}, scheduleReconnect: () => { effects.reconnect++ }, forgetContextSuggestions() {}, closeAnswerBriefing() {}, forkingThreads: new Set() }
  const api = vm.runInNewContext(`(() => { let streamReady = true, source = null, activityPanelComposing = false, activityPanelDeferred = false;
    let browserToolAuthorityEpoch = 0, browserToolFixtureLastAction = null; const browserToolFixtureAuthorizationByCard = new Map(), browserToolRunBindings = new Map(),
    browserToolPendingBindings = new Map(), browserToolUserSelections = new Map(), browserToolActionLeases = new Map();
    ${definitions}
    return { update, reset: resetThreadConversations }; })()`, sandbox)
  return { state, protocol, epochScope, effects, ...api }
}
const room = (id, engineProfileId, conversationId, bindingAccountKey) => ({ id, type: 'dm', title: id, engineId: 'codex', engineProfileId, conversationId, clientBindingId: id,
  bindingAccountKey, bindingState: 'verified', retainedNativeBinding: null, messages: [{ id: `${id}-m`, role: 'user', content: '질문', status: 'complete' }] })

test('A6: a request and a run in flight on profile B survive the DEFAULT sign-in switching; the default room\'s are dropped as before', () => {
  const w = world({ rooms: [room('room-d', 'codex-default', 'conv-d', 'codex:chatgpt:a@example.test'), room('room-b', SLOT, 'conv-b', slotKey('b@example.test'))] })
  w.protocol.requests['req-b'] = { requestId: 'req-b', engineId: 'codex', localThreadId: 'room-b', clientThreadId: 'room-b', conversationId: 'conv-b', engineProfileId: SLOT, status: 'submitting' }
  w.protocol.requests['req-d'] = { requestId: 'req-d', engineId: 'codex', localThreadId: 'room-d', clientThreadId: 'room-d', conversationId: 'conv-d', status: 'submitting' }
  w.protocol.runs['conv-b/run-b'] = { runId: 'run-b', engineId: 'codex', localThreadId: 'room-b', clientThreadId: 'room-b', conversationId: 'conv-b', engineProfileId: SLOT, status: 'running' }
  w.protocol.runs['conv-d/run-d'] = { runId: 'run-d', engineId: 'codex', localThreadId: 'room-d', clientThreadId: 'room-d', conversationId: 'conv-d', status: 'running' }
  const tokB = w.epochScope.begin('codex', SLOT), tokD = w.epochScope.begin('codex', 'codex-default'), legacy = w.epochScope.begin('codex')
  const before = structuredClone({ req: w.protocol.requests['req-b'], run: w.protocol.runs['conv-b/run-b'], room: w.state.codex.threads[1] })
  w.update({ authStatus: signedIn('c@example.test') })
  // profile B: untouched
  assert.deepEqual(w.protocol.requests['req-b'], before.req, 'the in-flight request on B is kept')
  assert.deepEqual(w.protocol.runs['conv-b/run-b'], before.run, 'its run is kept')
  const b = w.state.codex.threads.find(t => t.id === 'room-b')
  assert.deepEqual([b.conversationId, b.bindingState, b.bindingAccountKey, b.engineProfileId, ChatState.nativeBindingHeld(b)], ['conv-b', 'verified', slotKey('b@example.test'), SLOT, false])
  assert.equal(w.epochScope.valid(tokB), true); assert.equal(tokB.signal.aborted, false, 'B\'s epoch token is not aborted')
  // the default room: as before (its account changed)
  assert.equal(w.protocol.requests['req-d'], undefined); assert.equal(w.protocol.runs['conv-d/run-d'], undefined)
  const d = w.state.codex.threads.find(t => t.id === 'room-d')
  assert.equal(ChatState.nativeBindingHeld(d), true)
  for (const token of [tokD, legacy]) { assert.equal(w.epochScope.valid(token), false); assert.equal(token.signal.aborted, true) }
  assert.deepEqual(w.effects.resets, [['codex', 'codex-default']], 'only the default profile\'s (and unrecorded) tokens end')
  w.update({ connected: true })
  assert.equal(ChatState.canResumeNativeThread(b, w.state.codex.authStatus, w.state.codex), true)
  assert.equal(ChatState.chatThreadReadiness(b, w.state.codex).ready, true)
})

test('A6: the default signing OUT keeps profile B\'s room working; a room on a profile this window does not know follows the old rule', () => {
  const w = world({ rooms: [room('room-b', SLOT, 'conv-b', slotKey('b@example.test')), room('room-u', 'codex-pzzzzzzzz', 'conv-u', 'codex:chatgpt:a@example.test')] })
  w.protocol.runs['conv-b/run-b'] = { runId: 'run-b', engineId: 'codex', localThreadId: 'room-b', clientThreadId: 'room-b', conversationId: 'conv-b', engineProfileId: SLOT, status: 'running' }
  w.protocol.runs['conv-u/run-u'] = { runId: 'run-u', engineId: 'codex', localThreadId: 'room-u', clientThreadId: 'room-u', conversationId: 'conv-u', status: 'running' }
  // the window's sign-out (POST /auth/signout, then resetThreadConversations, then the status update)
  w.reset(); w.update({ authStatus: { isLoggedIn: false } })
  assert.ok(w.protocol.runs['conv-b/run-b']); assert.equal(w.protocol.runs['conv-u/run-u'], undefined)
  assert.equal(ChatState.nativeBindingHeld(w.state.codex.threads.find(t => t.id === 'room-b')), false)
  assert.equal(ChatState.nativeBindingHeld(w.state.codex.threads.find(t => t.id === 'room-u')), true)
  // with no room on another profile the reset is exactly the old full reset
  const plain = world({ rooms: [room('room-d', 'codex-default', 'conv-d', 'codex:chatgpt:a@example.test')] })
  plain.update({ authStatus: signedIn('c@example.test') })
  assert.deepEqual(plain.effects.resets, [[undefined, null]], 'the whole epoch, as before')
})

test('A7 fork: a room on profile B can be forked with the default signed out; not when B is signed out or B\'s account changed; the default room as before', () => {
  const context = { engines: enginesRows() }
  const b = room('room-b', SLOT, 'conv-b', slotKey('b@example.test')), d = room('room-d', 'codex-default', 'conv-d', 'codex:chatgpt:a@example.test')
  const fork = (thread, auth, engines) => ChatState.chatForkAvailability(thread, { connected: true, auth, capabilities: ['fork'], engines })
  assert.equal(fork(b, { isLoggedIn: false }, context.engines).available, true)
  assert.equal(fork(b, signedIn('c@example.test'), context.engines).available, true, 'another default account does not matter')
  assert.deepEqual(fork(b, { isLoggedIn: false }, enginesRows({ slotSignedIn: false })), { available: false, reason: '코덱스에 연결해 로그인하면 분기할 수 있습니다.' })
  assert.deepEqual(fork(b, signedIn('a@example.test'), enginesRows({ slotAccount: 'z@example.test' })), { available: false, reason: '지금 로그인한 계정의 대화인지 확인한 뒤 분기할 수 있습니다.' })
  assert.equal(fork(d, signedIn('a@example.test'), context.engines).available, true)
  assert.equal(fork(d, { isLoggedIn: false }, context.engines).available, false)
  assert.equal(fork(d, signedIn('c@example.test'), context.engines).available, false)
  assert.match(surface, /capabilities: state\.codex\.chatCapabilities, engines: state\.codex\.engines,/, 'the window passes its engine rows')
})

function briefingScope({ thread, auth, engines, cached }) {
  const briefing = { id: 'brief-1', conversationId: thread.conversationId, runId: 'run-1', answerId: 'ans-1', steps: [{ id: 'step-1' }] }
  const state = { codex: { threads: [thread], engines, authStatus: auth, codexAccountKey: cached, activeThreadId: thread.id, activityRoomGeneration: 0, briefingSession: { presentationId: 'p1', index: 0, briefing } } }
  const calls = []
  const sandbox = { state, ChatState, getCodexThreadById: (codex, id) => codex.threads.find(t => t.id === id) || null, window: { AbortController, setTimeout, clearTimeout }, JSON, encodeURIComponent, Promise, Error }
  const make = vm.runInNewContext(`(() => { ${fn('createBriefingCommentScope')}\nreturn createBriefingCommentScope; })()`, sandbox)
  const session = { threadId: thread.id, briefing, identity: { conversationId: briefing.conversationId, runId: 'run-1', answerId: 'ans-1' }, index: 0, presentationId: 'p1' }
  return { state, calls, open: () => make(session, ChatState.createChatEpochScope(), async (path, init) => { calls.push({ path, method: init.method }); return { comments: [] } }) }
}

test('A7 Briefing comment: a room on profile B saves with the default signed out and stops when B\'s account changes; the default room as before', async () => {
  const b = room('room-b', SLOT, 'conv-b', slotKey('b@example.test'))
  const w = briefingScope({ thread: b, auth: { isLoggedIn: false }, engines: enginesRows(), cached: null })
  const scope = w.open()
  assert.equal(scope.current(), true)
  await scope.request('GET')
  assert.equal(w.calls.length, 1); assert.match(w.calls[0].path, new RegExp(`engineProfileId=${SLOT}`))
  w.state.codex.engines = enginesRows({ slotAccount: 'z@example.test' })
  assert.equal(scope.current(), false, 'B\'s account changed: the scope ends')
  await assert.rejects(scope.request('GET'), /브리핑 연결이 바뀌었습니다/)
  // the default room: needs the default sign-in, and the window's cached default to name it (unchanged rule)
  const d = room('room-d', 'codex-default', 'conv-d', 'codex:chatgpt:a@example.test')
  assert.throws(() => briefingScope({ thread: d, auth: { isLoggedIn: false }, engines: enginesRows(), cached: null }).open(), /의견을 저장할 원래 대화와 계정 연결을 확인하지 못했습니다/)
  const ok = briefingScope({ thread: d, auth: signedIn('a@example.test'), engines: enginesRows(), cached: 'codex:chatgpt:a@example.test' })
  const dScope = ok.open(); assert.equal(dScope.current(), true)
  ok.state.codex.codexAccountKey = 'codex:chatgpt:c@example.test'
  assert.equal(dScope.current(), false, 'a stale cached default ends the default room\'s scope, as before')
  assert.throws(() => briefingScope({ thread: d, auth: signedIn('a@example.test'), engines: enginesRows(), cached: 'codex:chatgpt:c@example.test' }).open(), /계정 연결을 확인하지 못했습니다/)
})
