// The surface tells the bridge when the conversation on the screen was closed or left: POST /chat/session/close { clientThreadId }.
//
//   rule        : ChatState.openConversationChange (pure)
//   screen side : these production Surface pieces run in a vm: the head of emit(), the watcher, setActiveThread, and the bridge methods
//                 that change the open room (selectThread, setHudView, openHudHome, deleteThread, createThread)
//   bridge side : the all-on world (scripts/egdesk-all-on.support.mjs): the real HTTP route -> CodexChatRuntime.closeSession
// toggleHUD needs the whole Desk DOM, so opening and hiding the chat is done here by the same state writes it makes (asserted from source).
// Synthetic harness only; nothing here was checked in the installed app.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'
import { allOnWorld, DM } from './egdesk-all-on.support.mjs'

const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
function section(from, to) {
  const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, 'Surface section: ' + from)
  return surface.slice(a, b)
}
const room = (id, extra = {}) => ({ id, type: 'dm', title: id, messages: [], unreadCount: 0, conversationId: null, ...extra })

// The chat part of the Desk: rooms a/b/c, chat hidden at start (as the Desk starts). `post` receives every bridge request the surface makes.
function mount(post = async () => ({ accepted: true, closed: true }), threads = [room('a'), room('b'), room('c')]) {
  const state = { hudOpen: false, hudApp: null, codex: { threads, activeThreadId: threads[0].id, hudView: 'conversation', chatCardEntityId: null, chatDockMode: 'hud', threadDrafts: {}, messageThreadMap: {},
    threadNonce: 0, activityRoomGeneration: 0, conversationId: null, draft: '' } }
  const calls = []
  const sandbox = { state, ChatState, console, Date, window: { confirm: () => true }, SELF_MEMBER: '나',
    fetchJson: async (path, options = {}) => { const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ path, method: options.method || 'GET', body }); return post(path, body) },
    // normalizeThreads' one rule that matters here: an active room that no longer exists falls back to the first room.
    normalizeThreads: () => { if (!state.codex.threads.some(thread => thread.id === state.codex.activeThreadId)) state.codex.activeThreadId = state.codex.threads[0]?.id || null },
    findThreadIndexById: id => state.codex.threads.findIndex(thread => thread.id === id),
    memoReadWatches: new Map(), observeMemoReadWatch() {}, markUserMessagesReadBy() {},
    refreshConversation: async () => null, ensureNativeReadyForSend: async () => null, syncBoardMembers: async () => {}, update() {},
    createCodexThread: (type, label) => room(`new-${state.codex.threadNonce + 1}`, { type, title: label }) }
  const bridge = vm.runInNewContext([
    section('  function getCodexThreadById(', '  function withCodexThread('), // getCodexThreadById, getActiveCodexThread, getCodexThreadDraft
    section('  function normalizeHudView(', '  function codexRoleLabel('),
    section('    // Set below, once the bridge request helper exists', '      for (const watch of memoReadWatches.values())'), '};',
    section('    const markThreadRead = (threadId) => {', '    const resetThreadConversations ='),
    section('    let openConversation = null;', '    // CHAT-10: a Board Thread\'s members live in the chat store'),
    '({ emit, refreshRoomProjectDefault: async () => null,',
    section('      setHudView(view) {', '      toggleThreadMenu(threadId, anchorEl = null) {'),
    section('      selectThread(threadId, options = {}) {', '      toggleThreadPin(threadId) {'),
    section('      deleteThread(threadId) {', '      openFreshRoomAfterAccountHold(threadId) {'),
    section('      createThread(type = \'dm\', options = {}) {', '      setThreadMemberRole('),
    '})',
  ].join('\n'), sandbox, { filename: 'eg-desk-surface.uc.js (open conversation)' })
  const api = { state, calls, bridge,
    closes: () => calls.filter(call => call.path === '/chat/session/close').map(call => call.body.clientThreadId),
    // toggleHUD('chat', …): shows the chat; without preserveConversation it starts on the room list.
    showChat({ preserveConversation = false } = {}) { state.hudOpen = true; state.hudApp = 'chat'; if (preserveConversation) { state.codex.hudView = 'conversation'; bridge.emit() } else bridge.openHudHome() },
    // toggleHUD on the open chat: hides it. No emit there; a later chat event redraws.
    hideChat() { state.hudOpen = false; state.hudApp = null },
    open(id) { return bridge.selectThread(id, { openConversation: true }) },
    settle: () => new Promise(resolve => setTimeout(resolve, 5)) }
  return api
}

test('rule: which conversation is open, and which one was left', () => {
  const a = room('a'), b = room('b'), change = ChatState.openConversationChange
  assert.deepEqual(change(null, { chatOpen: true, hudView: 'conversation', thread: a }), { open: 'a', left: null }, 'opening is not leaving')
  assert.deepEqual(change('a', { chatOpen: true, hudView: 'conversation', thread: a }), { open: 'a', left: null }, 'a redraw of the same room')
  assert.deepEqual(change('a', { chatOpen: true, hudView: 'conversation', thread: b }), { open: 'b', left: 'a' }, 'another room')
  assert.deepEqual(change('a', { chatOpen: true, hudView: 'list', thread: a }), { open: null, left: 'a' }, 'back to the room list')
  assert.deepEqual(change(null, { chatOpen: true, hudView: 'list', thread: a }), { open: null, left: null })
  assert.deepEqual(change('a', { chatOpen: false, hudView: 'conversation', thread: a }), { open: 'a', left: null }, 'hidden chat: still the open conversation')
  assert.deepEqual(change('a', { chatOpen: false, hudView: 'list', thread: b }), { open: 'a', left: null }, 'nothing is decided while the chat is not shown')
  assert.deepEqual(change(null, { chatOpen: false, hudView: 'conversation', thread: a }), { open: null, left: null }, 'a room that was never shown is not open')
  assert.deepEqual(change('a', { chatOpen: true, hudView: 'conversation', thread: null }), { open: null, left: 'a' }, 'the room is gone')
  // The bridge knows a room by its client binding, which can differ from the room id and can be replaced.
  assert.deepEqual(change(null, { chatOpen: true, hudView: 'conversation', thread: room('a', { clientBindingId: 'a-binding-1' }) }), { open: 'a-binding-1', left: null })
  assert.deepEqual(change('a-binding-1', { chatOpen: true, hudView: 'conversation', thread: room('a', { clientBindingId: 'a-binding-2' }) }), { open: 'a-binding-2', left: 'a-binding-1' })
  assert.deepEqual(change(undefined, {}), { open: null, left: null })
})

test('source: emit() checks the open conversation after every normalize; toggleHUD writes the state this test writes', () => {
  assert.match(surface, /const emit = \(\) => \{\n\s+normalizeThreads\(\);\n\s+if \(typeof syncOpenConversation === 'function'\) syncOpenConversation\(\);/)
  assert.equal(surface.split('/chat/session/close').length - 1, 2, 'one call site (and its comment)')
  const toggle = section('    if (!appId || (state.hudOpen && state.hudApp === appId)) {', '      mountCodexHUD(body, state.codexBridge, {')
  assert.match(toggle, /state\.hudOpen = false;\n\s+state\.hudApp = null;/)
  assert.match(toggle, /state\.hudOpen = true;\n\s+state\.hudApp = appId;/)
  assert.match(toggle, /if \(options\.preserveConversation && getCodexThreadById\(state\.codex, state\.codex\.activeThreadId\)\) \{\n\s+state\.codex\.hudView = 'conversation';\n\s+\} else \{\n\s+state\.codexBridge\.openHudHome\?\.\(\);/)
  assert.ok(!/emit\(\)/.test(section('    if (!appId || (state.hudOpen && state.hudApp === appId)) {', '    state.hudOpen = true;')), 'hiding the chat redraws nothing by itself')
})

test('surface: one close per conversation that is left; none for opening, redrawing, hiding or showing again', async () => {
  const ui = mount()
  // Start-up: the Desk has an active room in state but the chat was never shown.
  ui.bridge.emit(); ui.bridge.emit()
  ui.showChat()
  assert.deepEqual(ui.closes(), [], 'a room that was never on the screen is not closed')
  await ui.open('a')
  assert.deepEqual(ui.closes(), [], 'opening a room')
  ui.bridge.emit(); ui.bridge.emit(); ui.bridge.emit()
  assert.deepEqual(ui.closes(), [], 'redraws (new messages, scrolling, menus) say nothing')
  await ui.open('b')
  assert.deepEqual(ui.closes(), ['a'], 'another room opened: the first one was left')
  await ui.open('b')
  assert.deepEqual(ui.closes(), ['a'], 'the same room again')
  ui.bridge.setHudView('list')
  assert.deepEqual(ui.closes(), ['a', 'b'], 'back to the room list')
  ui.bridge.setHudView('list'); ui.bridge.openHudHome(); ui.bridge.emit()
  assert.deepEqual(ui.closes(), ['a', 'b'], 'the list is not a conversation: nothing more to close')
  await ui.open('c')
  ui.hideChat(); ui.bridge.emit(); ui.bridge.emit()
  assert.deepEqual(ui.closes(), ['a', 'b'], 'hidden chat: the conversation is not left (events keep arriving and redrawing)')
  ui.showChat({ preserveConversation: true })
  assert.deepEqual(ui.closes(), ['a', 'b'], 'shown again on the same conversation')
  ui.hideChat(); ui.showChat()
  assert.deepEqual(ui.closes(), ['a', 'b', 'c'], 'shown again on the room list: now it was left')
  assert.ok(ui.calls.every(call => call.method === 'POST' && Object.keys(call.body).join() === 'clientThreadId'), 'only the room\'s client id is sent')
})

test('surface: deleting the open room, creating a room, the chat as a canvas card, a replaced client binding', async () => {
  const ui = mount()
  ui.showChat(); await ui.open('b')
  ui.bridge.deleteThread('b')
  assert.deepEqual(Array.from(ui.state.codex.threads, thread => thread.id), ['a', 'c'])
  assert.deepEqual(ui.closes(), ['b'], 'the deleted room\'s session is closed; the next room is now open')
  ui.bridge.deleteThread('c')
  assert.deepEqual(ui.closes(), ['b'], 'deleting a room that is not on the screen closes nothing (it was closed when it was left)')
  ui.bridge.createThread('dm', { engineId: 'codex', openConversation: true })
  assert.deepEqual(ui.closes(), ['b', 'a'], 'a new room opens in place of the one on the screen')
  // The chat moved to a canvas card (detachCodexChatFromHud): the panel is hidden, the card shows the same conversation.
  ui.state.codex.chatDockMode = 'canvas'; ui.state.codex.chatCardEntityId = 'card-1'; ui.hideChat(); ui.bridge.emit()
  assert.deepEqual(ui.closes(), ['b', 'a'], 'moving the chat to a card is not leaving')
  await ui.open('a')
  assert.deepEqual(ui.closes(), ['b', 'a', 'new-1'], 'room switch inside the card')
  // The card is closed (its cleanup clears chatCardEntityId and returns to the panel, which is hidden): treated like a hidden chat.
  ui.state.codex.chatCardEntityId = null; ui.state.codex.chatDockMode = 'hud'; ui.bridge.emit()
  assert.deepEqual(ui.closes(), ['b', 'a', 'new-1'])
  ui.showChat()
  assert.deepEqual(ui.closes(), ['b', 'a', 'new-1', 'a'], 'and left once the chat is shown again on the list')
  // The room's client binding is replaced while it is open (account change): the old name is closed, the room stays open.
  const other = mount(undefined, [room('a', { clientBindingId: 'a-binding-1' })])
  other.showChat(); await other.open('a')
  other.state.codex.threads[0] = { ...other.state.codex.threads[0], clientBindingId: 'a-binding-2' }; other.bridge.emit()
  assert.deepEqual(other.closes(), ['a-binding-1'])
})

test('surface: a bridge that refuses or is unreachable changes nothing on the screen and is not asked again', async () => {
  const unhandled = []; const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const ui = mount(async () => { throw Object.assign(new Error('Not found'), { status: 404 }) })
    ui.showChat(); await ui.open('a'); await ui.open('b'); await ui.settle()
    assert.deepEqual(ui.closes(), ['a'])
    ui.bridge.emit(); ui.bridge.emit(); await ui.settle()
    assert.deepEqual(ui.closes(), ['a'], 'no retry')
    assert.equal(ui.state.codex.activeThreadId, 'b'); assert.equal(ui.state.codex.hudView, 'conversation')
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', onUnhandled) }
})

// ---- end to end: the surface's request reaches the real route; what the bridge then does with the session ------------------------
const rect = (x, y, width, height) => ({ x, y, width, height })
const people = [{ member: 'self', self: true, active: true, viewport: rect(0, 0, 1200, 800), focusCard: null, lastInputAgeMs: 500 }]
async function pointerDecided(w) {
  w.presenceMirror.accept(people)
  const cards = [{ id: 'agent-result', rect: rect(-2600, 100, 720, 520), kind: 'result', creator: 'agent', taskId: 'run-1' }]
  const scene = WP.enumerateWorkScene({ presence: w.presenceMirror.snapshot(), cards, tasks: [{ id: 'run-1', state: 'waiting_owner', requester: 'self', waiting: ['self'], ownerMustAct: true, surfaces: [{ kind: 'result', cardId: 'agent-result' }] }] })
  const attention = WP.attentionRequest(scene, { taskId: 'run-1', cardId: 'agent-result' })
  const out = (await w.http('POST', '/decision/work-placement/request', { clientThreadId: DM, dto: attention.dto })).body
  await w.advance(25000); w.presenceMirror.accept(people); await w.advance(40000); await w.idle()
  return out
}
async function world(t) {
  const w = allOnWorld(t)
  const replies = []
  const ui = mount(async (path, body) => { const { status, body: data } = await w.http('POST', path, body); replies.push({ status, data }); if (status >= 400) throw Object.assign(new Error(String(status)), { status }); return data },
    [room(DM), room('other-room')])
  ui.showChat(); await ui.open(DM)
  w.step('turn'); await w.send('전체 테스트 돌리고 결과 알려줘'); await w.idle()
  return { w, ui, replies }
}

test('end to end: leaving an idle conversation ends its live session; nothing is posted into it afterwards; a new message opens it again', async t => {
  const { w, ui, replies } = await world(t)
  await w.advance(2000); await w.answer('테스트가 모두 통과했습니다.'); await w.idle()
  assert.equal(w.chat.heartbeatFor(DM)?.tempo, 'idle', 'after the run the session idles')
  const before = w.history()
  ui.bridge.setHudView('list'); await ui.settle()
  assert.deepEqual(ui.closes(), [DM])
  assert.deepEqual(replies, [{ status: 200, data: { accepted: true, closed: true } }])
  assert.ok(!w.chat.heartbeatFor(DM) || w.chat.heartbeatFor(DM).state === 'stopped', 'the session heartbeat ended')
  w.step('away')
  await pointerDecided(w)
  assert.deepEqual(w.byFeature('away').heartbeat ?? 0, 0, 'no heartbeat question for a closed conversation')
  assert.deepEqual(w.subjectiveTurnsIn('away'), { main: 0, fork: 0, steer: 0 })
  assert.deepEqual(w.history(), before, 'no message is posted into a conversation the person left')
  w.step('back')
  await ui.open(DM)
  assert.deepEqual(ui.closes(), [DM], 'opening it again sends nothing')
  await w.send('결과 어디서 봐?'); await w.idle()
  assert.equal(w.chat.heartbeatFor(DM)?.state !== 'stopped' && w.chat.heartbeatFor(DM)?.tempo, 'active', 'the next message is a live session again')
})

test('end to end: leaving while the run still works keeps the run; its answer is stored and shown when the room is opened again', async t => {
  const { w, ui, replies } = await world(t)
  await w.advance(2000)
  await ui.open('other-room'); await ui.settle()
  assert.deepEqual(ui.closes(), [DM])
  assert.deepEqual(replies, [{ status: 200, data: { accepted: true, closed: false, afterRun: true } }])
  assert.equal(w.chat.heartbeatFor(DM)?.tempo, 'active', 'the working run keeps its heartbeat')
  await w.answer('테스트가 모두 통과했습니다.'); await w.idle()
  assert.equal(w.runs().at(-1).status, 'completed')
  assert.deepEqual(w.history().at(-1), ['assistant', '테스트가 모두 통과했습니다.'])
  assert.ok(!w.chat.heartbeatFor(DM) || w.chat.heartbeatFor(DM).state === 'stopped', 'and ends with the run instead of idling')
})

test('end to end: hiding the chat is not leaving; the pointer still arrives in that conversation', async t => {
  const { w, ui } = await world(t)
  await w.advance(2000); await w.answer('테스트가 모두 통과했습니다.'); await w.idle()
  ui.hideChat(); ui.bridge.emit(); await ui.settle()
  assert.deepEqual(ui.closes(), [])
  const before = w.history().length
  w.step('hidden')
  await pointerDecided(w)
  assert.deepEqual(w.byFeature('hidden'), { work_placement: 1, heartbeat: 1 })
  assert.equal(w.history().length, before + 1, 'one pointer message')
})
