// L2 cycle 6: completed-messages-only chat surface and replying to an early question while the run works.
//
// Real code under test (synthetic data, mock engine, no network, no Codex binary, no Firefox):
//   bridge side  : CodexChatRuntime (held answers + conversation flow flags on), the real /chat/send and /chat/history HTTP handlers,
//                  the real SQLite chat store. The engine is a scripted mock (same pattern as helper/egdesk-held-answers-flow.test.mjs).
//   screen side  : EGDeskChatState (event reducer, run projection, history restore) and these production Surface sections run in a vm:
//                  threadBusy, syncProtocolRun, updateThreadById/appendMessageToThread, createCodexMessage,
//                  the bridge methods setDraft / retryRun / sendMessage, and the composer's send button rule, submit and keydown handlers.
// Not mounted (fixtures here): the bubble DOM loop of mountCodexHUD (its one skip rule is asserted from source and mirrored in
// `bubbles()`), the first prompt's full send path (covered by the existing send-path tests; here it is accepted through the same
// ChatState calls), the profile catalog (codexThreadRuntimeConfig is a fixture) and normalizeThreads (its two busy lines are mirrored).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs'
import { createChatHttpHandler } from '../helper/codex-bridge-http.mjs'
import { openChatStore } from '../helper/egdesk-chat-store.mjs'
import { FLOW_COPY, FLOW_LIMITS } from '../helper/egdesk-conversation-flow.mjs'
// The mock Decision model's policy is the flow owner's (L3): this rig drifted once when the message question was renamed.
import { judge } from '../helper/egdesk-heartbeat-flow.fixture.mjs'

const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
function section(from, to) {
  const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, 'Surface section: ' + from)
  return surface.slice(a, b)
}

const DM = 'local-dm', A = 'first-agent'
const PROMPT = '서비스를 배포해 주세요'
const ASK = '어느 환경에 배포할까요? 운영인지 스테이징인지 알려 주세요.'
const MID = '이 부분은 시간이 좀 걸립니다. 계속 확인하고 있어요.'
const REPLY = '스테이징이요'
const FINAL = '스테이징 환경에 배포했습니다. 결과는 세 단계로 정리했습니다.'
const AUTH = { isLoggedIn: true, authMode: 'chatgpt', accountId: 'verified-account' }

// ---- bridge side: real runtime + store + HTTP handlers over a scripted engine, virtual clock ---------------------------------
function bridgeWorld(t, { held = true, flow = true, writer = {}, forkHangs = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-l2c6-')); chmodSync(dir, 0o700)
  const store = openChatStore({ dataDir: dir, ownerScope: 'synthetic-l2c6' })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  let clock = 1_000_000, timerId = 0, threads = 0, forks = 0, turns = 0
  const timers = [], events = [], native = [], steers = []
  const state = { usedReply: null, steerFails: false, decides: 0 }
  const flowAsked = [] // every time the mock Decision model was asked the heartbeat's message question
  const chat = new CodexChatRuntime({
    store, requireStore: true, getOwnerKey: () => 'test-account', now: () => clock, monotonicNow: () => clock, // the heartbeat's counter follows the virtual clock
    setTimer: (fn, ms) => { const timer = { id: ++timerId, fn, at: clock + ms }; timers.push(timer); return timer },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    getBoardPeerContract: () => 'c'.repeat(64),
    profiles: { runProfile: profileId => ({ binding: { profileId, revision: 1, hash: `h-${profileId}` }, developerInstructions: `Agent ${profileId}` }) },
    resolveProjectWorkspace: async () => null, respond() {}, emit: e => events.push(e), emitLegacy() {}, verifyFile: async () => null,
    request: async (method, params) => {
      native.push([method, params])
      if (method === 'thread/start') return { thread: { id: `native-${++threads}` } }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'thread/fork') { if (forkHangs) return new Promise(() => {}); return { thread: { id: `fork-${++forks}`, forkedFromId: params.threadId } } }
      if (method === 'turn/steer') { if (state.steerFails) throw new Error('steer refused'); steers.push(params); state.usedReply = params.input[0].text; return { turnId: params.expectedTurnId } }
      if (method === 'turn/start' && String(params.threadId).startsWith('fork-')) {
        const prompt = params.input[0].text
        const text = /ask the person|need one piece of information/.test(prompt) ? writer.ask : writer.explain
        setTimeout(async () => {
          const n = (m, p) => chat.handleNotification({ method: m, params: p })
          const timing = { threadId: params.threadId, turnId: `fturn-${forks}` }
          if (text != null) await n('item/completed', { ...timing, item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text } })
          await n('turn/completed', { threadId: params.threadId, turn: { id: timing.turnId, status: text == null ? 'failed' : 'completed', items: [] } })
        }, 1)
        return { turn: { id: `fturn-${forks}`, status: 'inProgress', items: [] } }
      }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      assert.fail(`Unexpected native call: ${method}`)
    },
    decisionContext: { mode: () => 'on', configured: () => true, client: { model: 'mock', decide: async request => { state.decides++; return judge(request, flowAsked) } }, budgetMs: 800, collect: async () => [],
      draftCheck: held ? { mode: () => 'on' } : undefined, conversationFlow: flow ? { mode: () => 'on' } : undefined },
  })
  chat.setConnection(true)
  const handler = createChatHttpHandler(chat, async () => {})
  const n = (m, p) => chat.handleNotification({ method: m, params: p })
  // Settle without waiting on jobs that wait for virtual time (a hung writer fork waits for its virtual deadline).
  const settleAll = async () => {
    let quiet = 0, last = -1
    for (let i = 0; i < 80 && quiet < 5; i++) {
      await new Promise(r => setTimeout(r, 2))
      const mark = native.length + events.length + state.decides
      quiet = mark === last ? quiet + 1 : 0; last = mark
    }
  }
  const http = async (method, url, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', ...(body === undefined ? {} : { 'content-type': 'application/json' }) } })
    const res = Object.assign(new EventEmitter(), { status: null, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b ?? '' } })
    assert.equal(await handler(req, res, new URL(url, 'http://127.0.0.1:39218')), true, url)
    return { status: res.status, data: res.body ? JSON.parse(res.body) : null }
  }
  const w = { chat, store, events, native, steers, state, http, settleAll, timing: null, clock: () => clock, flowAsked,
    // Rig precondition, stated loudly: the flow's question reached the mock model and it picked this kind.
    picked(kind) { assert.ok(flowAsked.length > 0, 'rig: the mock Decision model was never asked the message question (was it renamed?)'); assert.ok(flowAsked.some(row => row.pick === kind), `rig: the message question never led to ${kind}: ${JSON.stringify(flowAsked.map(row => [row.offered, row.pick]))}`) },
    async advance(ms) {
      const end = clock + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift(); clock = Math.max(clock, next.at); next.fn(); await settleAll()
      }
      clock = end; await settleAll()
    },
    tool: async (id, status) => n(status === 'started' ? 'item/started' : 'item/completed', { ...w.timing, item: { id, type: 'commandExecution', command: 'ls', cwd: '/work', status: status === 'started' ? 'inProgress' : 'completed', commandActions: [], aggregatedOutput: '' } }),
    note: async (id, text) => { await n('item/started', { ...w.timing, item: { id, type: 'agentMessage', phase: 'commentary', text: '' } }); await n('item/completed', { ...w.timing, item: { id, type: 'agentMessage', phase: 'commentary', text } }) },
    // The native engine streams the final answer in pieces; held mode must keep all of it off the screen until it is complete.
    async finalStreamed(text) {
      await n('item/started', { ...w.timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text: '' } })
      for (const piece of [text.slice(0, 7), text.slice(7, 19), text.slice(19)]) await n('item/agentMessage/delta', { ...w.timing, itemId: 'ans', delta: piece })
      await n('item/completed', { ...w.timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text } })
      await settleAll()
    },
    async endTurn(status = 'completed') { await n('turn/completed', { threadId: w.timing.threadId, turn: { id: w.timing.turnId, status, items: [] } }); await settleAll() },
    notify: n,
    turnStarts: () => native.filter(([m, p]) => m === 'turn/start' && !String(p.threadId).startsWith('fork-')).length,
    stored: () => store.listMessages(DM).messages.map(m => [m.role, m.text]),
  }
  return w
}

// ---- screen side: production Surface sections in one vm context ----------------------------------------------------------------
function screen(w, { capabilities = ['send', 'stream'] } = {}) {
  const protocol = ChatState.createChatProtocolState()
  const room = { id: DM, type: 'dm', title: '배포 담당', engineId: 'codex', profileEnabled: true, agentProfileId: A, messages: [], unreadCount: 0,
    conversationId: null, bindingState: 'fresh', bindingAccountKey: null }
  const state = { codex: { threads: [room], activeThreadId: DM, hudView: 'conversation', authStatus: AUTH, connected: true, threadDrafts: {}, threadDraftRevisions: {},
    draft: '', liveRevision: 0, chatProtocol: protocol, messageThreadMap: {}, channelContextSupported: true, activityRoomGeneration: 0, chatCapabilities: capabilities,
    isSending: false, replyOpen: false }, contextSuggest: { byThread: {} } }
  const posts = [], notices = []
  const net = { order: 'http-first', fail: null }
  const sandbox = {
    // One clock for both sides: the screen stamps its bubbles with the same (virtual) time the bridge uses.
    Date: { now: () => w.clock() },
    state, protocol, ChatState, console, cloneJson: value => JSON.parse(JSON.stringify(value)), SELF_MEMBER: '나',
    findThreadIndexById: id => state.codex.threads.findIndex(thread => thread.id === id),
    memoReadWatches: new Map(), observeMemoReadWatch() {}, markUserMessagesReadBy() {}, attachMemoRepliesFromRun() {},
    memoAskSendReservations: new Map(), clearMemoManualSendNotice: () => false, showMemoManualSendNotice() {},
    watchMemoRead: () => ({ current: () => true, release() {} }), scheduleDeskSessionSave() {},
    boardNotice: text => notices.push(text),
    codexThreadRuntimeConfig: thread => ({ threadId: thread.id, profileId: A, profileRevision: 1 }), // fixture: no profile catalog here
    // The product's fetchJson contract: a refusal throws with status/code/accepted; here it reaches the real HTTP handler.
    fetchJson: async (pathname, options = {}) => {
      if (net.fail) throw net.fail
      const body = options.body ? JSON.parse(options.body) : undefined
      posts.push({ path: pathname, body })
      const { status, data } = await w.http(options.method || 'GET', pathname, body)
      if (net.order === 'events-first') api.pump()
      if (status >= 400) throw Object.assign(new Error(data?.error || String(status)), { status, code: data?.code ?? null, accepted: data?.accepted, dispatchStatus: data?.dispatchStatus, resumeRequired: data?.resumeRequired })
      return data
    },
    emit: () => api.normalize(),
  }
  const mounted = vm.runInNewContext([
    section('  function getCodexThreadById(', '  function withCodexThread('),
    section('  function codexRuns(', '  // Chat status view model'),
    section('  function createCodexMessage(', '  function installCodexBridge('),
    section('    const updateThreadById = (threadId, updater) => {', '    const resetThreadConversations ='),
    section('    function threadBusy(', '    async function requireClaudeContext('),
    `({ threadBusy, syncProtocolRun, updateThreadById, appendMessageToThread, createCodexMessage, codexCurrentRun, bridge: {`,
    section('      setDraft(draft,', '      captureManualSendOwner('),
    section('      retryRun(threadId, runId) {', '    };\n  }\n\n  function toggleHUD'),
    '} })',
  ].join('\n'), sandbox, { filename: 'eg-desk-surface.uc.js (chat send + run projection)' })
  const thread = () => state.codex.threads[0]
  const frames = []
  let cursor = 0
  const api = {
    state, protocol, posts, notices, net, mounted, thread, frames,
    // Mirror of the two busy lines of normalizeThreads (the function itself needs the whole Desk).
    normalize() { state.codex.isSending = mounted.threadBusy(thread()); state.codex.replyOpen = !!ChatState.replyRunForThread?.(protocol, thread()) },
    // The render loop skips exactly one kind of row (asserted from source below); everything else is drawn with its text.
    bubbles: () => [...thread().messages].filter(m => !(m.role === 'assistant' && m.status === 'streaming' && !m.content)).map(m => [m.role, m.status, m.content]),
    working: () => ChatState.agentWorkingView(mounted.codexCurrentRun(thread()), { connected: true }),
    // The product's SSE path for chat.event v2: admit, reduce, project into the room, redraw. One frame per event.
    pump() {
      for (; cursor < w.events.length; cursor++) {
        const event = w.events[cursor]
        if (!ChatState.canAdmitChatEvent(protocol, state.codex.threads, event)) continue
        const run = ChatState.reduceChatEvent(protocol, event, ['codex'])
        if (run) { mounted.syncProtocolRun(run); api.normalize() }
        frames.push({ event: event.event, bubbles: api.bubbles(), working: api.working()?.state ?? null, isSending: state.codex.isSending, replyOpen: state.codex.replyOpen })
      }
    },
    // First prompt: accepted through the same ChatState calls the product's registerPending / acceptChatRequest path makes.
    async firstPrompt(text = PROMPT, requestId = 'req-1') {
      ChatState.registerChatRequest(protocol, { requestId, clientThreadId: DM, localThreadId: DM, conversationId: null, authorName: 'Agent' }, AUTH, 'codex')
      mounted.appendMessageToThread(DM, mounted.createCodexMessage('user', text, 'submitting', { requestId }), { countUnread: false })
      const { status, data } = await w.http('POST', '/chat/send', { clientThreadId: DM, profileId: A, profileEnabled: true, replyDestination: 'direct', message: text, requestId })
      assert.equal(status, 202, JSON.stringify(data))
      w.timing = { threadId: data.conversationId, turnId: data.runId }
      mounted.syncProtocolRun(ChatState.acceptChatRequest(protocol, data, requestId))
      api.normalize(); api.pump()
      return data
    },
    // A fresh draw of the composer from current state (activeThread is the render-time snapshot, as in mountCodexHUD).
    composer() {
      const listeners = {}
      const input = { value: state.codex.threadDrafts[DM] || '', isConnected: true, addEventListener: (type, fn) => { listeners[type] = fn }, _mentionKeydown: null }
      const blockedSend = { textContent: '' }
      const sent = []
      const codexBridge = new Proxy(mounted.bridge, { get: (target, key) => key === 'sendMessage'
        ? (...args) => { const pending = Reflect.apply(target.sendMessage, target, args); sent.push(pending); return pending } : Reflect.get(target, key) })
      const ctx = { el: (tag, props = {}, ...children) => ({ tag, props, children, disabled: Boolean(props.disabled), title: props.title || '' }), deskIcon: () => null,
        ChatState, codexBridge, codex: state.codex, activeThread: thread(), input, blockedSend, choice: { reset() {}, sync() {} },
        compositionInProgress: false, boardInputState: null, boardPreview: null, boardDestination: null, boardCompositionEnded: 0, manualOwner: undefined,
        chatRoomProjectSendBlock: () => null, CHAT_REQUEST_PROJECT_INVALID: 'invalid project', Date }
      const out = vm.runInNewContext([
        section('            const submitComposer = () => {', '            const blockedSend ='),
        'function syncSendButton() {',
        section('              const readiness = ChatState.chatThreadReadiness(activeThread, codex);', '            };\n            choice.attach'),
        '}',
        section("            input.addEventListener('keydown', (ev) => {", "            input.addEventListener('compositionstart'"),
        '({ sendButton, syncSendButton })',
      ].join('\n'), ctx, { filename: 'eg-desk-surface.uc.js (composer)' })
      out.syncSendButton()
      return { ...out, input, blockedSend, sent,
        type(text) { input.value = text; mounted.bridge.setDraft(text, DM); api.normalize(); out.syncSendButton() },
        key(ev) { const event = { key: 'Enter', preventDefault() { event.prevented = true }, ...ev }; listeners.keydown(event); return event } }
    },
  }
  return api
}

const assistantTexts = frame => frame.bubbles.filter(([role]) => role === 'assistant').map(([, , text]) => text)

test('the render loop skips only an empty streaming assistant row (the rule this test mirrors)', () => {
  assert.match(surface, /if \(message\.role === 'assistant' && message\.status === 'streaming' && !message\.content\) return;/)
  assert.match(surface, /if \(run\) \{ syncProtocolRun\(run\); emit\(\); \}/, 'each chat event is projected and redrawn on its own')
})

test('held answer + early question: only completed bubbles are ever drawn, the reply goes into the same run, restore shows the same sequence', async t => {
  const w = bridgeWorld(t, { writer: { ask: ASK } })
  const ui = screen(w)
  const first = await ui.firstPrompt()
  assert.deepEqual(ui.bubbles().map(([role, , text]) => [role, text]), [['user', PROMPT]])
  assert.equal(ui.working()?.text, 'Agent 작업 중')

  // Busy with no open question: today's rule. The button is disabled and Enter explains instead of sending.
  let c = ui.composer(); c.type('추가로 하나 더요')
  assert.equal(c.sendButton.disabled, true); assert.equal(c.sendButton.title, '요청을 보내는 중입니다.')
  assert.equal(c.key({}).prevented, true); assert.equal(c.blockedSend.textContent, '요청을 보내는 중입니다.'); assert.equal(c.sent.length, 0)
  assert.equal(await ui.mounted.bridge.sendMessage(), undefined, 'the bridge method refuses too')
  assert.equal(ui.posts.length, 0)
  c.type('')

  // The Agent's work note asks; the flow posts the question as one completed message.
  await w.advance(4000)
  await w.note('n1', '배포 환경이 정해져 있지 않네요. 어느 환경에 배포할까요?')
  await w.advance(2000)
  w.picked('ask_missing')
  ui.pump()
  assert.deepEqual(ui.bubbles().map(([role, status, text]) => [role, status, text]), [['user', 'complete', PROMPT], ['assistant', 'complete', ASK]])
  assert.equal(ui.working()?.state, 'working', 'the run keeps working; the indicator stays')
  assert.equal(ui.state.codex.isSending, true); assert.equal(ui.state.codex.replyOpen, true)

  // Composer: sending is allowed now. A Korean syllable still composing keeps its Enter; an attachment waits for the turn.
  c = ui.composer(); c.type(REPLY)
  assert.equal(c.sendButton.disabled, false); assert.equal(c.sendButton.title, '보내기')
  for (const composing of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) { c.key(composing); assert.equal(c.sent.length, 0, JSON.stringify(composing)) }
  ui.mounted.updateThreadById(DM, thread => ({ ...thread, inputSources: [{ id: 'file-1', kind: 'file' }] }))
  let withFile = ui.composer(); withFile.type(REPLY)
  assert.equal(withFile.sendButton.disabled, true, 'a reply carries text only'); assert.equal(await ui.mounted.bridge.sendMessage(), undefined); assert.equal(ui.posts.length, 0)
  ui.mounted.updateThreadById(DM, thread => ({ ...thread, inputSources: [] }))

  c = ui.composer(); c.type(REPLY)
  const turnsBefore = w.turnStarts()
  assert.equal(c.key({}).prevented, true)
  assert.equal(c.sent.length, 1)
  // At once: the person's bubble is there, the composer is empty and back under the busy rule (one reply per question).
  assert.deepEqual(ui.bubbles().at(-1), ['user', 'submitting', REPLY])
  assert.equal(ui.state.codex.threadDrafts[DM], ''); assert.equal(ui.state.codex.replyOpen, false)
  const second = ui.composer(); second.type('하나 더'); assert.equal(second.sendButton.disabled, true); second.type('')
  const outcome = await c.sent[0]
  assert.deepEqual({ accepted: outcome.accepted, inRun: outcome.inRun }, { accepted: true, inRun: true })
  assert.equal(ui.posts.length, 1)
  assert.deepEqual([ui.posts[0].path, ui.posts[0].body.message, ui.posts[0].body.inRunReplyTo, ui.posts[0].body.conversationId], ['/chat/send', REPLY, first.runId, first.conversationId])
  assert.equal(w.steers.length, 1); assert.deepEqual([w.steers[0].threadId, w.steers[0].expectedTurnId, w.steers[0].input[0].text], [first.conversationId, first.runId, REPLY])
  assert.equal(w.turnStarts(), turnsBefore, 'no second turn')
  ui.pump()
  assert.deepEqual(ui.bubbles().map(([role, status, text]) => [role, status, text]),
    [['user', 'complete', PROMPT], ['assistant', 'complete', ASK], ['user', 'complete', REPLY]], 'the reply is the person\'s bubble, once')
  assert.equal(ui.state.codex.replyOpen, false); assert.equal(ui.working()?.state, 'working')

  // The engine streams the final answer; held mode shows nothing of it until it is complete and checked.
  await w.advance(3000)
  await w.finalStreamed(FINAL)
  ui.pump()
  assert.deepEqual(assistantTexts(ui.frames.at(-1)), [ASK], 'nothing of the held answer is on screen while the turn still runs')
  assert.equal(ui.working()?.state, 'working', 'the working indicator covers the hold')
  await w.endTurn()
  ui.pump()

  // Every frame the screen drew: an assistant bubble is either absent or exactly a completed message. Never a fragment, never doubled.
  const allowed = new Set([ASK, FINAL])
  for (const frame of ui.frames) for (const text of assistantTexts(frame)) assert.ok(allowed.has(text), `${frame.event}: drew ${JSON.stringify(text)}`)
  const firstFinal = ui.frames.findIndex(frame => assistantTexts(frame).includes(FINAL))
  assert.ok(firstFinal > 0)
  assert.equal(ui.frames[firstFinal].working, 'working', 'the answer appears while the run is still shown as working (no gap before it)')
  assert.ok(ui.frames.slice(0, firstFinal).every(frame => frame.working === 'working'), 'the indicator shows through the whole hold')
  assert.equal(ui.frames.at(-1).event, 'run.completed'); assert.equal(ui.frames.at(-1).working, null)
  const live = ui.bubbles().map(([role, status, text]) => [role, status, text])
  assert.deepEqual(live, [['user', 'complete', PROMPT], ['assistant', 'complete', ASK], ['user', 'complete', REPLY], ['assistant', 'complete', FINAL]])
  assert.deepEqual(w.stored(), live.map(([role, , text]) => [role, text]), 'the store holds the same four messages in the same order')
  assert.equal(ui.state.codex.isSending, false)

  // '다시 시도' on this run would resend its own request, not the reply that was sent into it.
  const sentAgain = []
  const bridge = Object.assign(Object.create(ui.mounted.bridge), { sendMessage() { sentAgain.push(ui.state.codex.threadDrafts[DM]); return null } })
  bridge.retryRun(DM, first.runId)
  assert.deepEqual(sentAgain, [PROMPT])
  ui.mounted.bridge.setDraft('', DM)

  // Restore: a fresh screen reads the conversation from the local store through the real history routes.
  const restored = screen(w)
  const summaries = (await w.http('GET', '/chat/history/threads?limit=50')).data
  const summary = summaries.threads.find(row => row.clientThreadId === DM)
  assert.ok(summary, 'the room is listed')
  const page = (await w.http('GET', `/chat/history?clientThreadId=${DM}&afterSeq=0&limit=100`)).data
  const normalized = ChatState.normalizeLocalHistoryPage({ ...page, thread: { ...summary, ...(page.thread || {}) } }, DM)
  assert.ok(normalized && !normalized.knownGap)
  restored.mounted.updateThreadById(DM, current => ChatState.hydrateLocalChatThread(current, normalized, { liveFenceRevision: restored.state.codex.liveRevision }))
  restored.normalize()
  assert.deepEqual(restored.bubbles().map(([role, , text]) => [role, text]), live.map(([role, , text]) => [role, text]), 'same sequence after restore')
  assert.ok(restored.thread().messages.every(m => m.status !== 'streaming'))
  assert.equal(restored.working(), null); assert.equal(restored.state.codex.replyOpen, false); assert.equal(restored.state.codex.isSending, false)
  t.diagnostic(`frames=${ui.frames.length} events=${JSON.stringify(ui.frames.map(f => f.event))}`)
})

test('the reply event may arrive before the HTTP answer: still one user bubble, never an Agent bubble with the person\'s words', async t => {
  const w = bridgeWorld(t, { writer: { ask: ASK } })
  const ui = screen(w)
  await ui.firstPrompt()
  await w.advance(4000); await w.note('n1', '어느 환경에 배포할까요?'); await w.advance(2000); w.picked('ask_missing'); ui.pump()
  ui.net.order = 'events-first'
  const c = ui.composer(); c.type(REPLY); c.key({})
  await c.sent[0]; ui.pump()
  assert.deepEqual(ui.bubbles().map(([role, status, text]) => [role, status, text]), [['user', 'complete', PROMPT], ['assistant', 'complete', ASK], ['user', 'complete', REPLY]])
  for (const frame of ui.frames) assert.ok(!assistantTexts(frame).includes(REPLY), `${frame.event}: the reply was drawn as an Agent bubble`)
})

test('a reply the run no longer waits for is refused before anything is saved or started; the words return to the composer', async t => {
  const w = bridgeWorld(t, { writer: { ask: ASK } })
  const ui = screen(w)
  const first = await ui.firstPrompt()
  await w.advance(4000); await w.note('n1', '어느 환경에 배포할까요?'); await w.advance(2000); w.picked('ask_missing'); ui.pump()
  // The question is answered elsewhere (another window): this screen has not heard yet.
  const other = await w.http('POST', '/chat/send', { clientThreadId: DM, conversationId: first.conversationId, profileId: A, profileEnabled: true, replyDestination: 'direct', message: '운영이요', requestId: 'req-other', inRunReplyTo: first.runId })
  assert.equal(other.status, 202)
  const storedBefore = w.stored(), turnsBefore = w.turnStarts(), steersBefore = w.steers.length
  const c = ui.composer(); c.type(REPLY)
  assert.equal(c.sendButton.disabled, false, 'stale screen: it still believes the question is open')
  c.key({})
  const outcome = await c.sent[0]
  assert.deepEqual({ accepted: outcome.accepted, status: outcome.status }, { accepted: false, status: 'failed' })
  assert.deepEqual(w.stored(), storedBefore, 'nothing was saved'); assert.equal(w.turnStarts(), turnsBefore, 'no turn was started'); assert.equal(w.steers.length, steersBefore)
  assert.deepEqual(ui.bubbles().at(-1), ['user', 'failed', REPLY])
  assert.equal(ui.state.codex.threadDrafts[DM], REPLY, 'the words are back in the composer')
  assert.equal(ui.thread().sendError, '아직 보낼 수 없습니다.')
  ui.pump()
  assert.equal(ui.state.codex.replyOpen, false, 'once the screen hears the question closed, it is back under the busy rule')

  // Bridge contract on its own: a named reply never becomes an ordinary send.
  const refused = await w.http('POST', '/chat/send', { clientThreadId: DM, conversationId: first.conversationId, profileId: A, profileEnabled: true, replyDestination: 'direct', message: '또 하나', requestId: 'req-late', inRunReplyTo: first.runId })
  assert.deepEqual([refused.status, refused.data.code, refused.data.accepted], [409, 'INRUN_REPLY_UNAVAILABLE', false])
  assert.deepEqual(w.stored(), storedBefore); assert.equal(w.turnStarts(), turnsBefore)
})

test('an unreachable bridge leaves the reply as unconfirmed and never resends it', async t => {
  const w = bridgeWorld(t, { writer: { ask: ASK } })
  const ui = screen(w)
  await ui.firstPrompt()
  await w.advance(4000); await w.note('n1', '어느 환경에 배포할까요?'); await w.advance(2000); w.picked('ask_missing'); ui.pump()
  ui.net.fail = new TypeError('NetworkError when attempting to fetch resource.')
  const c = ui.composer(); c.type(REPLY); c.key({})
  const outcome = await c.sent[0]
  assert.equal(outcome.status, 'unconfirmed')
  assert.deepEqual(ui.bubbles().at(-1), ['user', 'unconfirmed', REPLY])
  assert.equal(ui.thread().sendError, '접수 여부를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.')
  assert.equal(ui.state.codex.threadDrafts[DM], '', 'the words are not put back: they may have been taken')
  assert.equal(ui.state.codex.replyOpen, false, 'no second reply while the first is unconfirmed')
  assert.equal(w.steers.length, 0); assert.equal(ui.posts.length, 0)
})

test('a long run: the wait-explaining message and the final answer are each drawn once, whole; no reply is open', async t => {
  const w = bridgeWorld(t, { writer: { explain: MID } })
  const ui = screen(w)
  await ui.firstPrompt('PostgreSQL 마이그레이션 상태는?')
  let at = 0
  for (const [id, when] of [['s1', 8000], ['s2', 18000], ['s3', 28000]]) { await w.advance(when - at); at = when; await w.tool(id, 'started'); await w.advance(2000); at += 2000; await w.tool(id, 'completed'); ui.pump() }
  await w.advance(40000 - at)
  w.picked('explain_wait')
  await w.finalStreamed(FINAL); await w.endTurn(); ui.pump()
  const allowed = new Set([MID, FINAL])
  for (const frame of ui.frames) for (const text of assistantTexts(frame)) assert.ok(allowed.has(text), `${frame.event}: drew ${JSON.stringify(text)}`)
  assert.ok(ui.frames.every(frame => frame.replyOpen === false), 'an explanation is not a question: the busy rule holds throughout')
  assert.deepEqual(ui.bubbles().map(([role, , text]) => [role, text]), [['user', 'PostgreSQL 마이그레이션 상태는?'], ['assistant', MID], ['assistant', FINAL]])
})

test('flags off (today): a message first seen already complete is drawn once, never doubled; no reply path opens', async t => {
  const w = bridgeWorld(t, { held: false, flow: false })
  const ui = screen(w)
  await ui.firstPrompt('상태 알려 주세요')
  await w.advance(3000)
  // No item/started: the engine reports the answer only when it is complete.
  await w.notify('item/completed', { ...w.timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text: FINAL } })
  await w.endTurn(); ui.pump()
  for (const frame of ui.frames) for (const text of assistantTexts(frame)) assert.equal(text, FINAL, `${frame.event}: drew ${JSON.stringify(text)}`)
  assert.ok(ui.frames.every(frame => frame.replyOpen === false))
  assert.equal(w.steers.length, 0)
})

test('a reconnect snapshot carries the open question and keeps the reply the person\'s own', async t => {
  const w = bridgeWorld(t, { writer: { ask: ASK } })
  const ui = screen(w)
  const first = await ui.firstPrompt()
  await w.advance(4000); await w.note('n1', '어느 환경에 배포할까요?'); await w.advance(2000); w.picked('ask_missing')
  // This screen missed the live events (SSE dropped): it only has the prompt, then reads /chat/state as the product does on reconnect.
  const readState = async () => {
    const snapshot = (await w.http('GET', `/chat/state?conversationId=${first.conversationId}`)).data
    for (const run of ChatState.mergeChatSnapshot(ui.protocol, snapshot, DM)) ui.mounted.syncProtocolRun(run, { liveEvent: false })
    ui.normalize()
  }
  await readState()
  assert.deepEqual(ui.bubbles().map(([role, , text]) => [role, text]), [['user', PROMPT], ['assistant', ASK]])
  assert.equal(ui.state.codex.replyOpen, true, 'the open question survives a reconnect')
  const c = ui.composer(); c.type(REPLY); c.key({}); await c.sent[0]
  await readState()
  assert.deepEqual(ui.bubbles().map(([role, status, text]) => [role, status, text]), [['user', 'complete', PROMPT], ['assistant', 'complete', ASK], ['user', 'complete', REPLY]])
  assert.equal(ui.state.codex.replyOpen, false); assert.equal(w.steers.length, 1)
})

// ---- heartbeat path (int/c11): the question closes when the flow pauses; the system-written stalled line -----------------------
test('an unanswered question closes when the final answer is being prepared (flow pause): the composer returns to the busy rule', async t => {
  const w = bridgeWorld(t, { writer: { ask: ASK } })
  const ui = screen(w)
  await ui.firstPrompt()
  await w.advance(4000); await w.note('n1', '어느 환경에 배포할까요?'); await w.advance(2000); w.picked('ask_missing'); ui.pump()
  assert.equal(ui.state.codex.replyOpen, true)
  await w.advance(3000)
  await w.finalStreamed(FINAL); ui.pump()
  assert.equal(ui.state.codex.replyOpen, true, 'the answer is only held: the question is still open while the turn runs')
  await w.endTurn(); ui.pump()
  const names = ui.frames.map(frame => frame.event)
  assert.ok(names.indexOf('reply.closed') > names.indexOf('reply.opened'))
  assert.ok(names.indexOf('reply.closed') < names.lastIndexOf('message.completed'), 'closed before the final answer is posted')
  assert.equal(ui.frames[names.indexOf('reply.closed')].replyOpen, false)
  assert.equal(ui.frames[names.indexOf('reply.closed')].isSending, true, 'busy rule while the answer is checked')
  assert.equal(w.steers.length, 0)
  assert.deepEqual(ui.bubbles().map(([role, , text]) => [role, text]), [['user', PROMPT], ['assistant', ASK], ['assistant', FINAL]])
  assert.equal(w.chat.snapshot().runs[0].replyOpen, null, 'the stored run does not keep an open question')
})

// The production render block for a system notice row, run on one message: returns the drawn row or 'agent-bubble' (falls through).
function drawRow(message) {
  const drawn = []
  const el = (tag, props = {}, ...children) => ({ tag, props, children: children.filter(child => child != null) })
  const out = vm.runInNewContext(`(function (message) {\n${section('            const systemNotice = ChatState.systemNoticeMessageView(message);', '            const previous = activeThread.messages[index - 1] || null;')}\n return 'agent-bubble' })`,
    { ChatState, el, messages: { appendChild: node => drawn.push(node) }, formatMessageTime: () => '오후 3:00' })(message)
  return out === 'agent-bubble' ? out : drawn[0]
}

async function stalledRun(t, { asNotice }) {
  const w = bridgeWorld(t, { forkHangs: true })
  if (asNotice) {
    // The one-line switch, applied from the test: the runtime's own stalled fallback item carries presentation 'notice'.
    const apply = w.chat.applyItem.bind(w.chat)
    w.chat.applyItem = (run, item, ...rest) => apply(run, String(item?.id).startsWith('egdesk-flow:') && item.text === FLOW_COPY.stalled ? { ...item, presentation: 'notice' } : item, ...rest)
  }
  const ui = screen(w)
  await ui.firstPrompt('상태 알려 주세요')
  await w.advance(1000); await w.note('n1', '자료를 확인하는 중입니다.')
  await w.advance(24000)                                  // 24 s without an engine event: the stall is offered at this beat
  await w.advance(FLOW_LIMITS.stalledWriterMs); ui.pump() // the engine cannot write either: the fixed line is posted
  w.picked('stalled')
  return { w, ui }
}

test('stalled fallback line, default rendering (today): one whole Agent bubble, never doubled', async t => {
  const { w, ui } = await stalledRun(t, { asNotice: false })
  for (const frame of ui.frames) for (const text of assistantTexts(frame)) assert.equal(text, FLOW_COPY.stalled, `${frame.event}: drew ${JSON.stringify(text)}`)
  const row = ui.thread().messages.find(m => m.content === FLOW_COPY.stalled)
  assert.equal(row.role, 'assistant'); assert.equal(row.status, 'complete'); assert.equal(row.presentation, undefined)
  assert.equal(ChatState.systemNoticeMessageView(row), null)
  assert.equal(drawRow(row), 'agent-bubble', 'falls through to the ordinary Agent bubble')
  assert.equal(ui.state.codex.replyOpen, false, 'the fallback line is not a question')
  await w.advance(2000); await w.finalStreamed(FINAL); await w.endTurn(); ui.pump()
  assert.deepEqual(ui.bubbles().map(([role, , text]) => [role, text]), [['user', '상태 알려 주세요'], ['assistant', FLOW_COPY.stalled], ['assistant', FINAL]])
})

test('stalled fallback line, notice rendering (prepared option, not the default): a system row, live and after restore', async t => {
  const { w, ui } = await stalledRun(t, { asNotice: true })
  const row = ui.thread().messages.find(m => m.content === FLOW_COPY.stalled)
  assert.equal(row.presentation, 'notice'); assert.equal(row.role, 'assistant')
  assert.deepEqual(ChatState.systemNoticeMessageView(row), { line: FLOW_COPY.stalled })
  const drawn = drawRow(row)
  assert.equal(drawn.props.role, 'note'); assert.equal(drawn.props.data.testid, 'chat-system-notice'); assert.equal(drawn.props.class, 'egd-codex-await-resume egd-codex-system-notice')
  assert.deepEqual(drawn.children.map(child => [child.props.class, child.children[0]]), [['egd-codex-await-resume-text', FLOW_COPY.stalled], ['egd-codex-message-time', '오후 3:00']])
  for (const frame of ui.frames) for (const text of assistantTexts(frame)) assert.equal(text, FLOW_COPY.stalled, `${frame.event}: drew ${JSON.stringify(text)}`)
  await w.advance(2000); await w.finalStreamed(FINAL); await w.endTurn(); ui.pump()
  const final = ui.thread().messages.find(m => m.content === FINAL)
  assert.equal(drawRow(final), 'agent-bubble', 'the Agent\'s own answer stays an Agent bubble')
  // Restore from the local store: the same line is still a system row.
  const restored = screen(w)
  const summary = (await w.http('GET', '/chat/history/threads?limit=50')).data.threads.find(item => item.clientThreadId === DM)
  const page = (await w.http('GET', `/chat/history?clientThreadId=${DM}&afterSeq=0&limit=100`)).data
  const normalized = ChatState.normalizeLocalHistoryPage({ ...page, thread: { ...summary, ...(page.thread || {}) } }, DM)
  restored.mounted.updateThreadById(DM, current => ChatState.hydrateLocalChatThread(current, normalized, { liveFenceRevision: 0 }))
  assert.deepEqual(restored.bubbles().map(([role, , text]) => [role, text]), [['user', '상태 알려 주세요'], ['assistant', FLOW_COPY.stalled], ['assistant', FINAL]])
  assert.equal(drawRow(restored.thread().messages[1]).props.data.testid, 'chat-system-notice')
  assert.equal(drawRow(restored.thread().messages[2]), 'agent-bubble')
})

test('the notice field is the runtime\'s own: an engine item cannot mark itself, and unfinished or other-role rows are never notices', async t => {
  const w = bridgeWorld(t, { held: false, flow: false })
  const ui = screen(w)
  await ui.firstPrompt('상태 알려 주세요')
  await w.notify('item/completed', { ...w.timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text: FINAL, presentation: 'notice' } })
  await w.endTurn(); ui.pump()
  const row = ui.thread().messages.find(m => m.content === FINAL)
  assert.equal(row.presentation, undefined); assert.equal(drawRow(row), 'agent-bubble')
  assert.equal(ChatState.systemNoticeMessageView({ role: 'user', presentation: 'notice', content: 'x', status: 'complete' }), null)
  assert.equal(ChatState.systemNoticeMessageView({ role: 'assistant', presentation: 'notice', content: 'x', status: 'streaming' }), null)
  assert.equal(ChatState.systemNoticeMessageView({ role: 'assistant', presentation: 'notice', content: '  ', status: 'complete' }), null)
  assert.equal(ChatState.systemNoticeMessageView({ role: 'assistant', presentation: 'other', content: 'x', status: 'complete' }), null)
  // The row never groups with an Agent answer.
  assert.match(surface, /const groupRole = \(message\) => \(message && \(ChatState\.awaitResumeMessageView\(message\) \|\| ChatState\.systemNoticeMessageView\(message\)\) \? 'system' : message\?\.role\);/)
})
