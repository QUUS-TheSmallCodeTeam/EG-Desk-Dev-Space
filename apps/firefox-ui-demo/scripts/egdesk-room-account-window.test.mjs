// L1 c21, owner decisions (2), (3), (5), provisional; window side, pref egdesk.roomAccount "on" (2, 3) and the presence flag (5). The window's
// own functions run (extracted from eg-desk-surface.uc.js) over synthetic state; the bridge routes are the real ones. Mocks only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import * as JP from '../overlay/resources/EGDeskJointPresence.sys.mjs'
import { RUN_REQUESTER, RUN_REQUESTER_READ_PATH, createRunRequesterHttpHandler, createRunRequesterReadHttpHandler, createRunRequesters } from '../helper/egdesk-presence-mirror.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const between = (from, to) => { const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, from); return surface.slice(a, b) }
const SLOT = 'codex-p1b2c3d4e5'
const engines = () => [{ id: 'codex', status: 'ready', profiles: [{ id: 'codex-default', active: true, auth: { status: 'signedIn', account: 'a@example.test' } }, { id: SLOT, auth: { status: 'signedIn', account: 'b@example.test' } }] }]
const room = () => ({ id: 'room-a', type: 'dm', title: 'A사 견적', engineId: 'codex', engineProfileId: 'codex-default', conversationId: 'conv-1', clientBindingId: 'room-a',
  bindingAccountKey: 'codex:chatgpt:a@example.test', bindingState: 'verified', retainedNativeBinding: null, messages: [{ id: 'm1', role: 'user', content: '견적 정리해 줘', status: 'complete' }] })

test('(2) the room continues on the other account: same room, messages and draft kept; no engine thread until the next send; then bound to the new account', () => {
  const before = room(), after = ChatState.continueRoomOnAccount(before, SLOT)
  assert.deepEqual([after.id, after.clientBindingId, after.title, after.messages], [before.id, 'room-a', before.title, before.messages])
  assert.deepEqual([after.engineProfileId, after.conversationId, after.bindingAccountKey, after.bindingState, after.retainedNativeBinding], [SLOT, null, null, 'fresh', null])
  const context = { engines: engines(), authStatus: { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'a@example.test' }, connected: true }
  assert.equal(ChatState.nativeBindingHeld(after), false, 'not held: it is not "another account\'s room"')
  assert.equal(ChatState.chatThreadReadiness(after, context).ready, true, 'the new account is signed in')
  assert.deepEqual(ChatState.reconcileNativeThread(after, context.authStatus, context), after)
  const bound = { ...after, conversationId: 'conv-2', ...ChatState.nativeBindingForRun(after, { conversationId: 'conv-2', accountKey: 'codex:chatgpt:a@example.test', engineProfileId: SLOT }, context) }
  assert.deepEqual([bound.bindingAccountKey, bound.bindingState], [`codex:slot:${SLOT}:b@example.test`, 'verified'], 'the next run binds the room to the new account (c18 fence)')
  assert.equal(ChatState.canResumeNativeThread(bound, context.authStatus, context), true)
  assert.equal(ChatState.continueRoomOnAccount(before, ''), before)
})

function bridgeApi({ pref = 'on', reply, busy = false }) {
  const body = surface.match(/      async switchRoomAccount\(threadId, engineProfileId\) \{\n([\s\S]*?)\n      \},\n      forkAvailability/)?.[1]
  assert.ok(body, 'the bridge API method is extractable')
  const state = { codex: { threads: [room()], threadDrafts: { 'room-a': '쓰던 글' } } }, posts = [], emits = []
  const run = new Function('threadId', 'engineProfileId', 'readSurfacePref', 'getCodexThreadById', 'state', 'threadBusy', 'fetchJson', 'ChatState', 'updateThreadById', 'emit',
    `return (async () => {${body}\n})();`)
  const call = (threadId, slot) => run(threadId, slot, () => pref, (codex, id) => codex.threads.find(t => t.id === id) || null, state, () => busy,
    async (path, init) => { posts.push([path, JSON.parse(init.body)]); if (reply instanceof Error) throw reply; return reply },
    ChatState, (id, fn) => { state.codex.threads = state.codex.threads.map(t => (t.id === id ? fn(t) : t)) }, () => emits.push(1))
  return { call, state, posts, emits }
}

test('(2) the window\'s switch: pref off does nothing; on, the bridge decides; a refusal (e.g. a run in flight) changes nothing; the draft stays', async () => {
  const off = bridgeApi({ pref: null, reply: { status: 'switched' } })
  assert.deepEqual(await off.call('room-a', SLOT), { status: 'off' }); assert.equal(off.posts.length, 0)
  const ok = bridgeApi({ reply: { status: 'switched', clientThreadId: 'room-a', engineProfileId: SLOT } })
  assert.deepEqual(await ok.call('room-a', SLOT), { status: 'switched' })
  assert.deepEqual(ok.posts, [['/chat/room-account', { clientThreadId: 'room-a', engineProfileId: SLOT }]])
  const t = ok.state.codex.threads[0]
  assert.deepEqual([t.engineProfileId, t.conversationId, t.messages.length], [SLOT, null, 1]); assert.equal(ok.state.codex.threadDrafts['room-a'], '쓰던 글')
  const inFlight = bridgeApi({ reply: Object.assign(new Error('working'), { code: 'RUN_IN_PROGRESS' }) })
  assert.deepEqual(await inFlight.call('room-a', SLOT), { status: 'refused', code: 'RUN_IN_PROGRESS' })
  assert.deepEqual(inFlight.state.codex.threads[0], room(), 'nothing changed')
  const busy = bridgeApi({ busy: true, reply: { status: 'switched' } })
  assert.deepEqual(await busy.call('room-a', SLOT), { status: 'refused', code: null }); assert.equal(busy.posts.length, 0, 'a working room does not even ask')
})

test('(3) a default-account change keeps the task list with the pref on; off, it is cleared as before', () => {
  const board = ChatState.taskBoardWithGraph(ChatState.createTaskBoard(), { graphId: 'g1', tasks: [] })
  const codex = { taskBoard: board, taskContinue: { graphId: 'g1' }, taskApproval: null, taskResume: null, planProposals: ChatState.createPlanProposals() }
  assert.equal(ChatState.keptTasksOnDefaultSwitch(codex, null), null)
  assert.equal(ChatState.keptTasksOnDefaultSwitch(codex, 'off'), null)
  assert.deepEqual(ChatState.keptTasksOnDefaultSwitch(codex, 'on'), { taskBoard: board, taskContinue: { graphId: 'g1' }, taskApproval: null, taskResume: null, planProposals: codex.planProposals })
  // the real update(): with the pref on the list survives the reset; off, it is the empty board as before
  const update = pref => {
    const auth = { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'a@example.test' }
    const state = { codex: { threads: [], engines: engines(), authStatus: auth, codexAccountKey: ChatState.codexAccountKey(auth), connected: true, ...structuredClone(codex) }, contextSuggest: { byThread: {} } }
    const protocol = ChatState.createChatProtocolState(); state.codex.chatProtocol = protocol
    const definitions = between('    const resetThreadConversations = () => {', '    const fetchJson = async') + '\n' + between('    const update = (patch) => {', '    const findThreadIndexById')
    const sandbox = { ChatState, state, protocol, userInputDrafts: new Map(), document: { getElementById: () => null }, console, epochScope: ChatState.createChatEpochScope(),
      clearBrowserToolTransport() {}, resumedNativeBindings: new Set(), refreshing: new Map(), chatBindingNonce: () => 'n', normalizeThreads() {}, emit() {},
      scheduleReconnect() {}, forgetContextSuggestions() {}, closeAnswerBriefing() {}, forkingThreads: new Set(), ...(pref === undefined ? {} : { readSurfacePref: key => (key === 'egdesk.roomAccount' ? pref : null) }) }
    const api = vm.runInNewContext(`(() => { let streamReady = true, source = null, activityPanelComposing = false, activityPanelDeferred = false;
      let browserToolAuthorityEpoch = 0, browserToolFixtureLastAction = null; const browserToolFixtureAuthorizationByCard = new Map(), browserToolRunBindings = new Map(),
      browserToolPendingBindings = new Map(), browserToolUserSelections = new Map(), browserToolActionLeases = new Map();
      ${definitions}
      return { update }; })()`, sandbox)
    api.update({ authStatus: { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'c@example.test' } })
    return state.codex
  }
  assert.equal(ChatState.taskBoardEntry(update('on').taskBoard, 'g1')?.graphId, 'g1', 'kept')
  assert.equal(update('on').taskContinue?.graphId, 'g1')
  for (const pref of ['off', null, undefined]) assert.equal(ChatState.taskBoardEntry(update(pref).taskBoard, 'g1'), null, `${pref}: cleared as before`)
})

// ---- (5) a second Desk window reads the requester from the bridge ----
const BOARD = '0b6f3f1e-2d4c-4a5b-8c7d-9e0f1a2b3c4d', B = 'm-0123456789abcdef'
function http(handler, path) {
  return async body => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: path, method: 'POST', headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(c) { this.status = c }, end(j) { this.body = JSON.parse(j); this.writableEnded = true } })
    await handler(req, res, new URL(path, 'http://127.0.0.1:39218')); return { status: res.status, body: res.body }
  }
}
function bridge() {
  const rows = [{ member: B, self: false, active: true, viewport: null }]
  const registry = createRunRequesters({ presence: { snapshot: () => rows } })
  return { registry, write: http(createRunRequesterHttpHandler({ requesters: registry, enabled: () => true }), RUN_REQUESTER.path),
    read: http(createRunRequesterReadHttpHandler({ requesters: registry, presence: { snapshot: () => rows }, enabled: () => true }), RUN_REQUESTER_READ_PATH) }
}
function deskWindow(br) {
  const state = {}
  state.runRequesters = JP.createRunRequesters({ snapshot: () => [{ member: 'self', self: true }, { member: B, self: false }], seated: (board, alias) => board === BOARD && alias === B,
    post: body => br.current.write(body) })
  const hook = surface.match(/    state\.noteRunRequester = \(event, run\) => \{\n([\s\S]*?)\n    \};/)?.[1]
  assert.ok(hook, 'the window hook is extractable')
  new Function('state', 'deskStoreRequest', `state.noteRunRequester = (event, run) => {\n${hook}\n};`)(state, async (method, path, body) => (path === RUN_REQUESTER_READ_PATH ? br.current.read(body) : { status: 404 }))
  return state
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)) }

test('(5) window 1 set B as the requester; window 2 learns it from the bridge when the run starts; after a bridge restart window 1 tells it again', async () => {
  const br = { current: bridge() }
  const one = deskWindow(br), two = deskWindow(br)
  const ref = { runId: 'run-1', conversationId: 'conv-1', clientThreadId: 'room-a' }
  assert.equal(one.runRequesters.set(ref, { board: BOARD, alias: B }), true); await settle()
  assert.equal(br.current.registry.audience({ run: { clientThreadId: 'room-a', conversationId: 'conv-1' } })?.requester, B)
  assert.equal(two.runRequesters.for(ref), null, 'window 2 knows nothing yet')
  const started = { event: 'run.started', runId: 'run-1' }, run = { runId: 'run-1', conversationId: 'conv-1', clientThreadId: 'room-a' }
  two.noteRunRequester(started, run); await settle()
  assert.equal(two.runRequesters.for(ref), B, 'window 2 read it from the bridge')
  assert.equal(two.runRequesters.retell(ref), false, 'an adopted requester is not re-told (the bridge vouched for it)')
  // the bridge restarts: its registry is empty; window 1 tells it again at the next run start, then window 2 can read it
  br.current = bridge()
  const three = deskWindow(br)
  three.noteRunRequester(started, run); await settle()
  assert.equal(three.runRequesters.for(ref), null, 'nothing known yet after the restart')
  one.noteRunRequester(started, run); await settle()
  assert.equal(br.current.registry.audience({ run: { clientThreadId: 'room-a', conversationId: 'conv-1' } })?.requester, B, 're-told')
  const four = deskWindow(br); four.noteRunRequester(started, run); await settle()
  assert.equal(four.runRequesters.for(ref), B)
  // other events, and a read route that is off, change nothing
  const five = deskWindow({ current: { read: async () => ({ status: 404, body: { status: 'off' } }), write: async () => ({}) } })
  five.noteRunRequester({ event: 'run.completed' }, run); five.noteRunRequester(started, run); await settle()
  assert.equal(five.runRequesters.for(ref), null)
  assert.equal(five.runRequesters.adopt(ref, 'not-an-alias'), false)
  assert.match(surface, /            state\.noteWorkChatEvent\?\.\(event, run\); \/\/ L1 c17[^\n]*\n            state\.noteRunRequester\?\.\(event, run\);/)
})

test('(5) the read route: off -> 404; only an alias the presence feed lists now', async () => {
  const rows = [{ member: B, self: false, active: true }]
  const registry = createRunRequesters({ presence: { snapshot: () => rows } })
  const off = http(createRunRequesterReadHttpHandler({ requesters: registry, presence: { snapshot: () => rows }, enabled: () => false }), RUN_REQUESTER_READ_PATH)
  assert.deepEqual(await off({ clientThreadId: 'room-a', conversationId: 'conv-1' }), { status: 404, body: { status: 'off' } })
  const read = http(createRunRequesterReadHttpHandler({ requesters: registry, presence: { snapshot: () => rows }, enabled: () => true }), RUN_REQUESTER_READ_PATH)
  registry.set(['room-a', 'conv-1'], { board: BOARD, alias: B })
  assert.deepEqual((await read({ clientThreadId: 'room-a', conversationId: 'conv-1' })).body, { requester: B })
  assert.deepEqual((await read({ clientThreadId: 'room-a', conversationId: 'conv-2' })).body, { requester: B }, 'by the room: the same requester for the room\'s new engine thread')
  rows.length = 0
  assert.deepEqual((await read({ clientThreadId: 'room-a', conversationId: 'conv-1' })).body, { requester: null }, 'gone from the feed')
  assert.equal((await read({ clientThreadId: 'room-a' })).status, 400)
})
