import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { runInNewContext, runInContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'

import { normalizeNativeAuth, publicAuthIdentityKey } from '../helper/codex-auth-state.mjs'
import { createChatEngineAuth } from '../helper/codex-bridge-engine-auth.mjs'
import { createChatHttpHandler, guardBridgeRequest } from '../helper/codex-bridge-http.mjs'
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from '../helper/codex-engine-adapter.mjs'
import { openChatStore } from '../helper/egdesk-chat-store.mjs'
import { openProfileStore } from '../helper/egdesk-profile-store.mjs'
import { createDecisionClient, DECISION_MODEL, DECISIONS_ENDPOINT, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'
import { collectDecisionCandidates } from '../helper/egdesk-decision-candidates.mjs'


const REVIEW_REVISION = 'a'.repeat(64) // successful local /decision/status epoch, not the provider recipient
const decisionStatus = () => ({ mode: 'on', configured: true, boardRevision: REVIEW_REVISION })

const PRIVATE = {
  account: 'QA_ACCOUNT_PRIVATE_3B9D', agent: 'QA_PROFILE_INSTRUCTIONS_38FD',
  primaryHistory: 'QA_PRIMARY_ROOM_HISTORY_27A9', otherHistory: 'QA_OTHER_DM_HISTORY_3E77',
  code: 'QA_NATIVE_CODE_12E9', evidence: 'QA_PRIOR_EVIDENCE_486A',
  file: 'QA_PRIOR_FILE_590C', memory: 'QA_PRIOR_MEMORY_F278',
  modelReason: 'QA_DECISION_MODEL_REASON_529B', subscriptionReply: 'QA_MOCK_SUBSCRIPTION_REPLY_E39E',
}

// Extract the exact Surface closure used by mountCodexHUD; no Firefox globals or profile.
function loadComposer(fetchJson) {
  const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
  const begin = source.indexOf('  function chatChoiceExplanationDraft(')
  const end = source.indexOf('  function mountCodexHUD(', begin)
  assert.ok(begin >= 0 && end > begin, 'production composer extraction boundaries')
  const bridgeMethod = name => {
    const line = source.split('\n').find(row => row.trimStart().startsWith(name + '('))
    assert.ok(line?.trimEnd().endsWith('},'), 'production UI bridge method: ' + name)
    return line
  }
  return runInNewContext(source.slice(begin, end) + '\n({ mountChatChoiceComposer, ' +
    bridgeMethod('readChatChoiceMode') + bridgeMethod('postChatChoice') + ' })',
    { fetchJson }, { filename: 'eg-desk-surface.uc.js' })
}

// Extract only production Surface dependencies needed by the choice gate. The outer
// chrome window state, account transport and the verified no-project read are fixtures.
function loadScope(state, protocol, profiles, chatRoomProjectDefaults, sendHarness) {
  const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
  const section = (begin, end) => {
    const start = source.indexOf(begin), stop = source.indexOf(end, start + begin.length)
    assert.ok(start >= 0 && stop > start, 'Surface section: ' + begin)
    return source.slice(start, stop)
  }
  const deps = [
    section('  const DEFAULT_CODEX_AGENT_PROFILE_ID =', '  function codexThreadKindMeta('),
    section('  function codexServerAgentProfile(', '  // Agent avatar:'),
    section('  function defaultCodexAgentProfileIdForThread(', '  function codexThreadToolMode('),
    section('  function getCodexThreadById(', '  function withCodexThread('),
    section('  function chatRoomProjectState(', '  function createChatProjectScope('),
    section('    const manualOwnerIdentity =', '    const memoWatchIdentity ='),
    section('    function threadBusy(', '    function syncProtocolRun('),
  ].join('\n')
  const scope = section('      chatChoiceScope(', '      readChatChoiceMode(')
  const pieces = sendHarness ? [
    section('  function codexThreadToolMode(', '  function codexThreadKindLabel('),
    section('  function chatRequestProjectSelection(', '  function chatRoomProjectState('),
    section('  function createChatProjectScope(', '  function chatRoomProjectTargetsMatch('),
    section('  function chatRoomProjectTargetsMatch(', '  function observeFileProjectAssociation('),
    section('    async function ensureNativeReadyForSend(', '    async function refreshConversation('),
  ] : []
  const bridge = sendHarness ? [scope,
    section('      setDraft(draft,', '      createMemoAskScope('),
    section('      async prepareRoomProjectSend(', '      async saveRoomProjectDefault('),
    section('      async decisionRequest(path', '      createProfileTransferScope('),
    section('      async sendMessage(options', '    };\n  }\n\n  function toggleHUD'),
  ].join('\n') : scope
  const sandbox = {
    state, protocol, ChatState, catalog: { status: 'ready', profiles }, chatRoomProjectDefaults,
    chatProjectDraftActions: new Map(), choiceSettingsWriting: 0, choiceSettingsGeneration: 0,
    document: { getElementById: () => assert.fail('no canvas entity is selected in the fixture') },
    ...sendHarness,
  }
  const out = runInNewContext(deps + pieces.join('\n') + '\ncodexProfileCatalog = catalog;\n({' + bridge + '})' +
    (sendHarness ? '' : '.chatChoiceScope'), sandbox, { filename: 'eg-desk-surface.uc.js (choice scope)' })
  if (sendHarness) Object.defineProperty(out, '__sandbox', { value: sandbox })
  return out
}

const focusLog = []
function element(tag, props = {}, ...children) {
  return {
    tag, props, children, value: '', textContent: '', hidden: false, disabled: false, isConnected: true,
    replaceChildren(...nodes) { this.children = nodes }, focus() { focusLog.push(this.props.data?.testid || this.tag) },
    querySelector(selector) {
      const key = /^\[data-testid="([^"\]]+)"\]$/.exec(selector)?.[1]
      assert.ok(key, 'unsupported test DOM selector: ' + selector)
      return findAll(this, key)[0] || null
    },
  }
}
function findAll(node, id) {
  if (!node || typeof node !== 'object') return []
  return [...(node.props.data?.testid === 'chat-choice-' + id || node.props.data?.testid === id ? [node] : []),
    ...node.children.flatMap(child => findAll(child, id))]
}
function click(node) {
  assert.ok(node && !node.hidden && !node.disabled, 'the control is present and actionable')
  node.props.onclick()
}
async function eventually(check, label) {
  for (let index = 0; index < 100; index++) {
    const value = check()
    if (value) return value
    await pause(5)
  }
  assert.fail(label)
}

const noWork = () => ({ decisionChoice: 0, decisionContext: 0, subscription: 0, contextCollection: 0 })

function createFixture(t, extraPhases = [], getDecisionStatus = decisionStatus, { holdChoiceResponse, resolveProjectWorkspace } = {}) {
  const root = tmpdir()
  if (process.env.EGDESK_QA_CHOICE_VERIFY_ISOLATION === '1') {
    assert.equal(process.permission?.has('net'), false, 'run with Node --permission and no network grant')
    assert.equal(process.permission?.has('child'), false, 'do not grant child-process execution')
    assert.equal(process.permission?.has('fs.write', root), true, 'grant only the owned tmpdir for SQLite')
    assert.equal(process.permission?.has('fs.write', fileURLToPath(new URL('../', import.meta.url))), false, 'source tree remains read-only')
  }
  const dir = mkdtempSync(join(root, 'chat-choice-roundtrip-v3-'))
  const store = openChatStore({ dataDir: dir, ownerScope: 'qa-roundtrip' })
  const profiles = openProfileStore({ dataDir: dir, ownerHash: 'qa-roundtrip' })
  t.after(() => { profiles.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const agentId = 'conversational-coding'
  assert.ok(profiles.seedTemplates().seeded.includes(agentId))
  const agent = profiles.get(agentId)
  const draft = profiles.createDraft({ name: '왕복 비교용 custom Agent', instructions: PRIVATE.agent }, { toolPreset: 'open' })
  const custom = profiles.activate(draft.id, draft.revision, null)
  assert.equal(agent.origin, 'template')
  assert.equal(agent.lifecycle, 'active')
  assert.equal(custom.origin, 'user')
  assert.equal(custom.lifecycle, 'active')
  let phase = 'seed', codexAuth
  const counts = {
    seed: { decisionChoice: 0, decisionContext: 0, subscription: 0, contextCollection: 0 },
    choice1: { decisionChoice: 0, decisionContext: 0, subscription: 0, contextCollection: 0 },
    draft: { decisionChoice: 0, decisionContext: 0, subscription: 0, contextCollection: 0 },
    explanation: { decisionChoice: 0, decisionContext: 0, subscription: 0, contextCollection: 0 },
    choice2: { decisionChoice: 0, decisionContext: 0, subscription: 0, contextCollection: 0 },
  }
  for (const phase of extraPhases) counts[phase] = noWork()
  const threads = new Map(), startTurns = [], decisionRequests = [], httpPosts = [], nativeCalls = [], unexpected = []
  const fail = message => { unexpected.push(message); assert.fail(message) }
  const transport = async (method, params) => {
    nativeCalls.push({ phase, method })
    switch (method) {
      case 'getAuthStatus': return { authMethod: 'chatgpt' }

      case 'account/read': return { account: { type: 'chatgpt', id: PRIVATE.account, planType: 'plus' } }
      case 'thread/start': {
        const thread = { id: `qa-native-dm-${threads.size + 1}`, turns: [] }
        threads.set(thread.id, thread)
        return { thread }
      }
      case 'thread/resume': {
        const thread = threads.get(params.threadId)
        if (!thread) return fail(`unknown resume destination: ${params.threadId}`)
        return { thread: structuredClone(thread) }
      }
      case 'thread/unsubscribe': return { status: 'unsubscribed' }
      case 'turn/start': {
        counts[phase].subscription++
        startTurns.push({ phase, params: structuredClone(params) })
        const thread = threads.get(params.threadId)
        if (!thread) return fail(`unknown turn destination: ${params.threadId}`)
        const turn = { id: `qa-native-turn-${startTurns.length}`, status: 'inProgress', items: [] }
        thread.turns.push(turn)
        return { turn: structuredClone(turn) }
      }
      default: return fail(`unexpected Codex RPC: ${method}`)
    }
  }
  const syntheticDecisionKey = 'synthetic-fixture-not-an-api-key'
  const savedAt = 123456789
  const recipientForKey = (key, endpoint, model) => decisionTopicRecipient(key, savedAt, endpoint, model)
  const decisionRecipient = () => recipientForKey(syntheticDecisionKey)
  assert.match(decisionRecipient(), /^[a-f0-9]{64}$/)
  const client = createDecisionClient({ getApiKey: () => syntheticDecisionKey, recipientForKey,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      const isChoice = body.questions.length === 1 && body.questions[0].name === 'chat_choice'
      counts[phase][isChoice ? 'decisionChoice' : 'decisionContext']++
      decisionRequests.push({ phase, url, method: init.method, body })
      if (!isChoice) return fail(`unexpected decision fetch during ${phase}`)
      const [q] = body.questions
      const picked = q.choices[phase === 'choice1' ? 1 : 0].value
      if (holdChoiceResponse) await holdChoiceResponse({ signal: init.signal })
      return { ok: true, status: 200, text: async () => JSON.stringify({
        answers: [{ type: 'choice', name: q.name, choice: picked, confidence: 0.92,
          probabilities: q.choices.map(({ value }) => ({ value, probability: value === picked ? 0.92 : value === 'abstain' ? 0.02 : 0.06 })),
          reason: PRIVATE.modelReason, explanation: PRIVATE.modelReason }],
      }) }
    },
  })
  const ownerKey = () => publicAuthIdentityKey(codexAuth)
  const refreshCodexAccount = async () => { codexAuth = normalizeNativeAuth(await transport('getAuthStatus', {}), await transport('account/read', {})) }
  const engine = createCodexEngineAdapter({ request: transport, respond: () => fail('unexpected user/approval response'), getOwnerKey: ownerKey })
  const chat = new CodexChatRuntime({ engines: [engine], store, requireStore: true, profiles, getOwnerKey: ownerKey, resolveProjectWorkspace,
    decisionContext: { client, settingsGeneration: () => getDecisionStatus().generation ?? 1, reviewRevision: () => getDecisionStatus().boardRevision,
      recipientForChatChoice: ({ engineId, ownerKey: scopedOwner }) =>
        engineId === 'codex' && codexAuth?.isLoggedIn === true && codexAuth.authMode === 'chatgpt' && scopedOwner === ownerKey() ? decisionRecipient() : null,
      mode: () => getDecisionStatus().mode, configured: () => getDecisionStatus().configured, collect: async ({ body, context, memoryEvidenceFor, speech }) => {
      counts[phase].contextCollection++
      const collected = await collectDecisionCandidates({ body, memoryEvidenceFor, speech, clientThreadId: context.clientThreadId,
        excludeMessageId: context.localMessageId, chatStore: store })
      if (Object.values(collected.sources).some(count => count !== 0)) fail('expected no authorized pre-turn context candidates')
      return collected.candidates
    } },
  })
  chat.setConnection(true)
  const auth = createChatEngineAuth({ chat, refreshCodexAccount, getCodexAuth: () => codexAuth })
  const routes = [createChatHttpHandler(chat, auth)]
  async function post(path, body) {
    httpPosts.push({ phase, path, body: structuredClone(body) })
    const url = new URL(path, 'http://127.0.0.1:39218')
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method: 'POST', url: path, headers: {
      host: url.host, origin: 'chrome://browser', 'content-type': 'application/json',
    }, socket: { remoteAddress: '127.0.0.1' } })
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, setHeader() {}, writeHead(status) { this.status = status }, end(raw) { this.body = JSON.parse(raw) },
    })
    assert.equal(guardBridgeRequest(req), true)
    for (const route of routes) if (await route(req, res, url)) return res
    return fail(`production route did not handle ${path}`)
  }
  async function complete(accepted, text) {
    const { conversationId: threadId, runId: turnId } = accepted
    const nativeTurn = threads.get(threadId)?.turns.find(({ id }) => id === turnId)
    assert.ok(nativeTurn, 'completion references the actual dispatched turn, not a synthetic grant')
    const item = { id: `${turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text }
    nativeTurn.items = [item]
    nativeTurn.status = 'completed'
    await chat.handleNotification({ method: 'item/completed', params: { threadId, turnId, item } })
    await chat.handleNotification({ method: 'turn/completed', params: { threadId, turn: structuredClone(nativeTurn) } })
    for (let n = 0; n < 50; n++) {
      if (chat.snapshot(threadId).runs.find(run => run.runId === turnId)?.status === 'completed') return
      await pause(5)
    }
    assert.fail('mock subscription completion was not observed by runtime')
  }
  const direct = (clientThreadId, profile = agent) => ({ clientThreadId, profileId: profile.id,
    profileRevision: profile.activeRevision, profileEnabled: true, replyDestination: 'direct' })
  async function send(scope, requestId, message) {
    const res = await post('/chat/send', { ...scope, requestId, message })
    assert.equal(res.status, 202, JSON.stringify(res.body))
    assert.equal(res.body.accepted, true)
    assert.equal(res.body.requestId, requestId)
    assert.ok(res.body.conversationId && res.body.runId, JSON.stringify(res.body))
    return res.body
  }
  return { store, agent, custom, direct, send, complete, post, refreshCodexAccount, nativeCalls,
    authStatus: () => codexAuth, profileRows: () => profiles.list().profiles,
    snapshot: cid => chat.snapshot(cid),
    get phase() { return phase }, set phase(value) { phase = value }, counts, startTurns, decisionRequests, httpPosts, unexpected, threads }
}

function createRoomProjection(f) {
  const protocol = ChatState.createChatProtocolState()
  const authStatus = f.authStatus()
  const account = ChatState.codexAccountKey(authStatus)
  assert.ok(account, 'same synthetic signed-in account used by HTTP/runtime')
  const codex = { authStatus, codexAccountKey: account, connected: true, threads: [], threadDrafts: {},
    threadDraftRevisions: {}, activeThreadId: null, hudView: 'conversation', chatCapabilities: ['choice'] }
  const state = { codex }
  const projectDefaults = new Map()
  function projectRoom(accepted, clientThreadId, profile) {
    const stored = f.store.getConversation(clientThreadId)
    const durable = f.store.getLatestRun(clientThreadId)
    const snapshot = f.snapshot(accepted.conversationId)
    assert.equal(stored.conversationId, accepted.conversationId)
    assert.deepEqual([durable.runId, durable.profileBinding.profileId, durable.profileBinding.revision],
      [accepted.runId, profile.id, profile.activeRevision])
    const room = codex.threads.find(row => row.id === clientThreadId) || {
      id: clientThreadId, clientBindingId: clientThreadId, type: 'dm', engineId: stored.engineId,
      profileEnabled: true, agentProfileId: stored.agent.profileId, agent: stored.agent,
    }
    if (!codex.threads.includes(room)) codex.threads.push(room)
    // UI-side submission provenance from the same accepted HTTP request, not a server grant.
    if (!protocol.requests[accepted.requestId]) ChatState.registerChatRequest(protocol, { requestId: accepted.requestId, clientThreadId,
      localThreadId: room.id, conversationId: room.conversationId }, authStatus, stored.engineId)
    const run = ChatState.mergeChatSnapshot(protocol, snapshot, clientThreadId).find(row => row.runId === accepted.runId)
    assert.ok(run, 'real runtime run must reach the ChatState projection')
    assert.equal(run.conversationId, accepted.conversationId)
    assert.equal(run.status, 'completed')
    assert.equal(run.accountKey, account)
    Object.assign(room, ChatState.nativeBindingForRun(room, run), {
      conversationId: run.conversationId, engineProfileId: run.engineProfileId,
    })
    assert.equal(room.bindingState, 'verified')
    assert.ok(ChatState.runsForThread(protocol, room).includes(run))
    assert.equal(ChatState.canResumeNativeThread(room, authStatus, codex), true)
    projectDefaults.set(room.id, { binding: ChatState.clientThreadBinding(room), scope: { current: () => true },
      status: 'ready', value: { status: 'none' } })
    return room
  }
  return { codex, state, protocol, projectRoom, projectDefaults, realScope: loadScope(state, protocol, f.profileRows(), projectDefaults) }
}

function mountFixtureHudSend(f, { state, protocol, projectDefaults }, room, choice, input, editReason, extra = {}) {
  const codex = state.codex
  const noProject = { roomId: room.id, source: null, status: 'none', inheritance: null, override: null, project: null }
  projectDefaults.get(room.id).value = noProject
  const find = id => codex.threads.find(thread => thread.id === id)
  const posts = [], projectedAcceptances = [], unexpectedCalls = []
  const unexpected = what => { unexpectedCalls.push(what); assert.fail(what) }
  const epochScope = ChatState.createChatEpochScope()
  const bridge = loadScope(state, protocol, f.profileRows(), projectDefaults, {
    epochScope, chatRequestProjectDisplays: new Map(), chatRequestProjectDisplayScopes: new Map(), memoAskSendReservations: new Map(),
    CHAT_ROOM_PROJECT_UNAVAILABLE: 'unexpected unavailable project', CHAT_REQUEST_PROJECT_INVALID: 'unexpected invalid project',
    watchMemoRead: id => {
      const active = codex.activeThreadId, generation = codex.activityRoomGeneration || 0
      const binding = ChatState.clientThreadBinding(find(id))
      return { current: () => active === codex.activeThreadId && generation === (codex.activityRoomGeneration || 0)
        && binding === ChatState.clientThreadBinding(find(id)), release() {} }
    },
    clearMemoManualSendNotice: () => false,
    scheduleDeskSessionSave() {}, emit() {},
    updateThreadById: (id, update) => Object.assign(find(id), update(find(id))),
    // The seeded room already has a verified, completed run in the live runtime.
    resumedNativeBindings: new Set([`${room.id}|${room.conversationId}`]),
    refreshConversation: () => unexpected('unexpected renderer refresh/resume transport'),
    captureThreadInputs: (_thread, selected) => { assert.equal(selected.length, 0); return [] },
    browserToolSelectedSources: (_id, selected) => { assert.equal(selected.length, 0); return [] },
    rootSseReady: () => ({ sourceReady: false, browserTransportId: null }),
    SELF_MEMBER: '나',
    createCodexMessage: (role, content, status, extra) => ({ role, content, status, ...extra }),
    appendMessageToThread: (id, message) => { (find(id).messages ??= []).push(message) },
    createAcceptedReceiptWatch: () => ({ current: () => false, dispose() {} }),
    syncProtocolRun: run => projectedAcceptances.push(run.runId),
    fetchJson: async (path, { method, signal, body }) => {
      assert.deepEqual([path, method, signal.aborted], ['/chat/send', 'POST', false])
      const response = await f.post(path, JSON.parse(body))
      posts.push(response)
      return response.body
    },
    ...extra,
  })
  bridge.readRoomProjectDefault = async id => {
    assert.equal(id, room.id)
    return projectDefaults.get(id).value // verified none; never resolves a filesystem path
  }
  // Observe the promise returned by the actual bridge; do not replace its implementation.
  const outcomes = []
  const codexBridge = new Proxy(bridge, { get(target, key) {
    if (key !== 'sendMessage') return Reflect.get(target, key)
    return (...args) => {
      const pending = Reflect.apply(target.sendMessage, target, args)
      pending.then(result => outcomes.push({ result: structuredClone(result) }), error => outcomes.push({ error: String(error) }))
      return pending
    }
  } })
  state.codexBridge = bridge
  const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
  const slice = (begin, end) => {
    const i = surface.indexOf(begin), j = surface.indexOf(end, i + begin.length)
    assert.ok(i >= 0 && j > i, 'HUD source slice: ' + begin)
    return surface.slice(i, j)
  }
  if (editReason) {
    const events = new EventTarget()
    input.addEventListener = events.addEventListener.bind(events)
    input.dispatchEvent = events.dispatchEvent.bind(events)
  }
  const hud = runInNewContext([
    slice('            const manualOwner = codexBridge.captureManualSendOwner', '            const input = el(\'textarea\''),
    slice('            const submitComposer = () => {', '            const blockedSend ='),
    'function syncSendButton() {',
    slice('              const readiness = ChatState.chatThreadReadiness(activeThread, codex);', '            };\n            choice.attach'),
    '}',
    ...(editReason ? [
      'const blockedSend = { textContent: "" }; const resizeComposer = syncSendButton;',
      slice('            input.addEventListener(\'input\', ev => {', '            // Enter sends as in a messenger'),
    ] : []),
    '({ sendButton, syncSendButton })',
  ].join('\n'), {
    el: (tag, props, ...children) => Object.assign(element(tag, props, ...children), { disabled: Boolean(props.disabled) }),
    deskIcon: () => null, body: {}, codexBridge, choice, activeThread: room, codex, ChatState, input,
    boardPreview: null, boardInputState: null, boardDestination: null, compositionInProgress: false,
    composerViewport: { cancel() {} },
    chatRoomProjectSendBlock: thread => { assert.equal(projectDefaults.get(thread.id).value, noProject); return null },
  }, { filename: 'eg-desk-surface.uc.js (actual HUD send button)' })
  return { ...hud, bridge, posts, outcomes, projectedAcceptances, unexpectedCalls }
}

// ---------------------------------------------------------------------------
// L1 cycle 2: restored DM, Decisions key saved in account settings while the
// recommendation panel is open. Synthetic harness. Product code used verbatim:
// mountChatChoiceComposer, chatChoiceScope, decisionRequest (settings write
// window), the HUD send-button/submitComposer/sendMessage slices, ChatState
// restore/reconcile, the /chat/* HTTP handler + runtime + SQLite.
// Fixtures: settings HTTP responses, the settings card (an active canvas entity
// that is not file/browser/shape), emit() -> choice.sync() (the HUD render calls
// choice.sync every paint), and /chat/resume called by refreshConversation.
// ---------------------------------------------------------------------------
function restoreRoom(f, seeded, clientThreadId, authForReconcile) {
  const stored = f.store.getConversation(clientThreadId)
  const base = { id: clientThreadId, type: 'dm', engineId: stored.engineId, profileEnabled: true,
    agentProfileId: stored.agent.profileId, agent: stored.agent, messages: [], participants: ['나'],
    clientBindingId: clientThreadId, conversationId: seeded.conversationId, bindingAccountKey: ChatState.codexAccountKey(f.authStatus()),
    retainedNativeBinding: null }
  return ChatState.reconcileNativeThread(ChatState.detachNativeThread(base, null, 'restart-nonce'), authForReconcile)
}
const REV_A = 'a'.repeat(64), REV_B = 'b'.repeat(64)
const QUESTION = '회의 안내를 어디에 둘까요?'
const OPTIONS = ['상단 알림', '일정 공지']
const otherAccountAuth = () => normalizeNativeAuth({ authMethod: 'chatgpt' }, { account: { type: 'chatgpt', id: 'QA_OTHER_ACCOUNT_77C1', planType: 'plus' } })
const signedOutOf = auth => ({ ...auth, isLoggedIn: false, accountId: null, accountEmail: null, identityStatus: 'unknown' })

async function settingsFixture(t, { restores = 1, keyStatus = 'missing', savedSession = false, alreadyOn = false } = {}) {
  const status = { mode: 'off', configured: false, store: 'missing', boardRevision: REV_A, generation: 1 }
  if (alreadyOn) Object.assign(status, { mode: 'on', configured: true, store: 'ok' })
  if (keyStatus === 'off-mode') Object.assign(status, { configured: true, store: 'ok' })
  const f = createFixture(t, ['restore', 'settings'], () => status, { resolveProjectWorkspace: async () => null })
  await f.refreshCodexAccount()
  const seeded = await f.send(f.direct('qa-dm-restored'), 'seed-restored', PRIVATE.primaryHistory)
  await f.complete(seeded, PRIVATE.code)
  const env = createRoomProjection(f), { codex, state } = env
  const live = f.authStatus(), out = signedOutOf(live)
  codex.authStatus = out; codex.codexAccountKey = null
  let room = restoreRoom(f, seeded, 'qa-dm-restored', out)
  // Further Desk restarts: the saved session carries the thread (with its retained pair) and goes through detach+reconcile again.
  const sessionRounds = []
  for (let i = 1; i < restores; i++) {
    const saved = JSON.parse(JSON.stringify(savedSession === 'verified-first' ? (() => {
      const verified = ChatState.reconcileNativeThread(room, live); return verified })() : room))
    sessionRounds.push({ saved: { conversationId: saved.conversationId, bindingState: saved.bindingState, retained: saved.retainedNativeBinding, clientBindingId: saved.clientBindingId } })
    room = ChatState.reconcileNativeThread(ChatState.detachNativeThread(saved, ChatState.codexAccountKey(live), 'restart-' + i), out)
  }
  codex.threads.push(room)
  const bindProject = () => env.projectDefaults.set(codex.threads[0].id, { binding: ChatState.clientThreadBinding(codex.threads[0]),
    scope: { current: () => true }, status: 'ready', value: { status: 'none' } })
  bindProject()
  const relogin = () => {
    codex.authStatus = live; codex.codexAccountKey = ChatState.codexAccountKey(live)
    codex.threads = codex.threads.map(row => ChatState.reconcileNativeThread(row, live)); bindProject()
    return codex.threads[0]
  }
  return { f, seeded, env, codex, state, status, relogin, room: () => codex.threads[0], sessionRounds, live }
}

function mountSettingsUi(x, t, { setupSpy } = {}) {
  const { f, env, codex, state } = x
  const input = element('textarea'), opens = []
  const settingsCard = { matches: () => false }
  const ui = { current: null }
  const calls = { writes: [], midWrite: [] }
  let emitCount = 0, pendingStatusRefresh = false
  const room = codex.threads[0]
  const resumeCalls = []
  // The settings card is an active entity that is neither a file/browser/shape.
  state.activeEntityId = null
  const document = { getElementById: id => id === 'egd-settings-card-1' ? settingsCard : assert.fail('unexpected entity ' + id) }
  const fetchSettings = async (url, init) => {
    const path = new URL(url).pathname, method = init.method
    calls.writes.push([path, method])
    calls.midWrite.push({ path, scope: !!send.bridge.chatChoiceScope(room.id, input.value), triggerHidden: ui.current.trigger.hidden })
    await pause(1)
    if (path === '/decision/credential') Object.assign(x.status, { configured: true, store: 'ok', generation: x.status.generation + 1 })
    if (path === '/decision/mode') Object.assign(x.status, { mode: 'on', boardRevision: REV_B, generation: x.status.generation + 1 })
    return { ok: true, status: 200, json: async () => ({}) }
  }
  codex.activeThreadId = room.id
  const send = mountFixtureHudSend(f, env, room, { sync: () => ui.current.sync(), reset: () => ui.current.reset() }, input, false, {
    document, fetch: fetchSettings, emit: () => { emitCount++; ui.current?.sync() },
    resumedNativeBindings: new Set(), InputContext,
    refreshConversation: async (thread, resume) => {
      assert.equal(resume, true)
      const response = await f.post('/chat/resume', { conversationId: thread.conversationId, clientThreadId: ChatState.clientThreadBinding(thread), engineId: 'codex' })
      resumeCalls.push(response.status)
      return response.status === 200 ? response.body : null
    },
  })
  const ownerAtMount = runInContext('manualOwnerIdentity("qa-dm-restored")', send.bridge.__sandbox)
  const readScope = () => send.bridge.chatChoiceScope(codex.activeThreadId, input.value)
  const choiceResponses = [], requestIds = []
  const { mountChatChoiceComposer, readChatChoiceMode, postChatChoice } = loadComposer(async (path, { method, signal, body }) => {
    if (path === '/decision/status') return structuredClone(x.status)
    const response = await f.post(path, JSON.parse(body))
    choiceResponses.push(response)
    return response.body
  })
  ui.current = mountChatChoiceComposer({ el: element, makeController: () => new AbortController(),
    makeRequestId: () => { const id = `choice-${Date.now()}-${randomUUID()}`; requestIds.push(id); return id },
    readMode: readChatChoiceMode, postChoice: postChatChoice,
    openSettings: reason => { opens.push(reason); state.activeEntityId = 'egd-settings-card-1'; state.canvasSelectionRevision = (state.canvasSelectionRevision || 0) + 1 } })
  t.after(() => ui.current.dispose())
  let draftWrites = 0
  ui.current.attach({ input, readScope, setDraft: text => { draftWrites++; send.bridge.setDraft(text, room.id); } })
  codex.activeThreadId = room.id
  const typeDraft = text => { input.value = text; send.bridge.setDraft(text, room.id) }
  const fields = () => findAll(ui.current.panel, 'option')
  const button = id => findAll(ui.current.panel, id)[0]
  const saveKeyInSettings = async () => {
    await send.bridge.decisionRequest('/decision/credential', { method: 'PUT', body: { apiKey: 'egd-synthetic-not-a-key-0001' } })
    await send.bridge.decisionRequest('/decision/mode', { method: 'PUT', body: { mode: 'on' } })
  }
  return { ownerAtMount, ui: ui.current, input, opens, calls, send, readScope, typeDraft, fields, button, saveKeyInSettings, choiceResponses, requestIds,
    resumeCalls, get draftWrites() { return draftWrites }, get emitCount() { return emitCount }, room }
}

const snap = (m, x) => ({ trigger_hidden: m.ui.trigger.hidden, panel_hidden: m.ui.panel.hidden, options: m.fields().map(n => n.value),
  composer: m.input.value, storedDraft: x.codex.threadDrafts[x.room().id], draftRevision: x.codex.threadDraftRevisions[x.room().id] || 0,
  scope: !!m.readScope(), generation: m.send.bridge.__sandbox.choiceSettingsGeneration, writing: m.send.bridge.__sandbox.choiceSettingsWriting })

async function finishFromRestoredOptions(t, x, m, label) {
  const { f } = x
  f.phase = 'choice1'
  click(m.button('review'))
  const confirm = await eventually(() => m.button('confirm'), label + ': confirm never offered')
  click(confirm)
  const result = await eventually(() => m.button('result'), label + ': no recommendation')
  assert.equal(result.textContent, 'EG-Desk 추천: 일정 공지 · 실행하지 않음')
  f.phase = 'draft'
  click(m.button('explain'))
  const draft = await eventually(() => m.draftWrites === 1 && m.input.value, label + ': no reason draft')
  m.send.syncSendButton()
  const sendEnabled = !m.send.sendButton.disabled
  f.phase = 'explanation'
  if (sendEnabled) click(m.send.sendButton)
  const outcome = sendEnabled ? await eventually(() => m.send.outcomes[0], label + ': send did not settle ' + JSON.stringify(x.room())) : null
  return { draft, sendEnabled, outcome }
}

test('L1c2 sim A: restored DM, panel -> [계정 설정 열기] -> key saved (off -> on) -> back: options survive, no retyping, real HUD [보내기]', async t => {
  const x = await settingsFixture(t)
  x.relogin()
  const { f, codex } = x
  const m = mountSettingsUi(x, t)
  const trace = []
  const mark = (step, extra = {}) => trace.push({ step, ...snap(m, x), focus: focusLog.at(-1), ...extra })
  m.typeDraft(QUESTION); m.ui.sync()
  mark('1 composer holds question; ready')
  assert.equal(m.ui.trigger.hidden, false)
  click(m.ui.trigger)
  m.fields().forEach((field, i) => { field.value = OPTIONS[i]; field.props.oninput() })
  mark('2 panel open, options typed')
  f.phase = 'settings'
  click(m.button('review'))
  await eventually(() => m.button('settings'), 'setup panel never shown')
  mark('3 reviewed while key missing -> setup panel', { text: m.ui.panel.children[0].textContent })
  assert.match(m.ui.panel.children[0].textContent, /저장한 API 키가 없습니다/)
  click(m.button('settings'))
  mark('4 [계정 설정 열기] clicked', { opens: [...m.opens] })
  assert.deepEqual(m.opens, ['key'])
  assert.equal(m.ui.panel.hidden, true)
  // Settings card: save key, then mode on. Both are real decisionRequest writes.
  const before = snap(m, x)
  await m.saveKeyInSettings()
  mark('5 key saved, mode on (settings done)', { writes: m.calls.writes, midWrite: m.calls.midWrite })
  assert.ok(m.calls.midWrite.every(row => row.scope === false && row.triggerHidden === true), 'trigger hidden only while the write is in flight')
  assert.equal(m.send.bridge.__sandbox.choiceSettingsGeneration, before.generation + 4)
  assert.equal(m.send.bridge.__sandbox.choiceSettingsWriting, 0)
  // Return to the same DM.
  m.ui.sync()
  mark('6 back in the same DM')
  assert.equal(m.ui.trigger.hidden, false, '[보기 추천] is offered again')
  assert.equal(codex.threadDrafts[x.room().id], QUESTION, 'composer draft untouched')
  click(m.ui.trigger)
  mark('7 reopened')
  assert.deepEqual(m.fields().map(n => n.value), OPTIONS, 'options restored without retyping')
  assert.equal(m.button('confirm'), undefined, 'old review authority is gone; a fresh review is required')
  const done = await finishFromRestoredOptions(t, x, m, 'A')
  mark('8 recommendation -> 이유 묻기 -> HUD [보내기]', { sendEnabled: done.sendEnabled })
  assert.equal(done.sendEnabled, true, 'real HUD send button enabled')
  assert.deepEqual(done.outcome && Object.keys(done.outcome), ['result'])
  assert.deepEqual([done.outcome.result.accepted, m.send.posts[0].status], [true, 202], JSON.stringify(m.send.posts[0]?.body))
  assert.equal(f.startTurns.at(-1).params.threadId, x.seeded.conversationId)
  assert.deepEqual(m.resumeCalls, [200])
  assert.deepEqual(f.unexpected, [])
  assert.equal(f.counts.draft.subscription + f.counts.settings.subscription + f.counts.choice1.subscription, 0)
  t.diagnostic('TRACE ' + JSON.stringify(trace))
})

test('L1c2 sim B: panel left OPEN in edit phase (not via setup), key saved elsewhere -> what survives', async t => {
  const x = await settingsFixture(t)
  x.relogin()
  const m = mountSettingsUi(x, t)
  m.typeDraft(QUESTION); m.ui.sync()
  click(m.ui.trigger)
  m.fields().forEach((field, i) => { field.value = OPTIONS[i]; field.props.oninput() })
  const open = snap(m, x)
  assert.deepEqual(open.options, OPTIONS)
  await m.saveKeyInSettings()
  m.ui.sync()
  const after = snap(m, x)
  t.diagnostic('B before=' + JSON.stringify(open) + ' after=' + JSON.stringify(after))
  assert.equal(after.composer, QUESTION)
  assert.equal(after.trigger_hidden, false)
  click(m.ui.trigger)
  const reopened = m.fields().map(n => n.value)
  t.diagnostic('B reopened options=' + JSON.stringify(reopened))
  assert.deepEqual(reopened, OPTIONS, 'typed options survive a settings save while the panel was open')
})

test('L1c2 sim A2: setup path, but the user edits the composer text while in settings -> options must not follow a different question', async t => {
  const x = await settingsFixture(t)
  x.relogin()
  const m = mountSettingsUi(x, t)
  m.typeDraft(QUESTION); m.ui.sync(); click(m.ui.trigger)
  m.fields().forEach((field, i) => { field.value = OPTIONS[i]; field.props.oninput() })
  x.f.phase = 'settings'
  click(m.button('review')); await eventually(() => m.button('settings'), 'setup')
  click(m.button('settings'))
  await m.saveKeyInSettings()
  m.typeDraft('다음 회의는 언제 열까요?'); m.ui.sync()
  click(m.ui.trigger)
  assert.deepEqual(m.fields().map(n => n.value), ['', ''])
  assert.equal(m.input.value, '다음 회의는 언제 열까요?', 'the new draft is kept as typed')
})

test('L1c2 sim C: second restore from a saved session keeps the retained pair and the gate behaves the same', async t => {
  const results = []
  for (const mode of ['verified-first', 'held-first']) {
    for (const restores of [1, 2, 3]) {
      const x = await settingsFixture(t, { restores, savedSession: mode })
      const held = x.room()
      const heldInfo = { held: ChatState.nativeBindingHeld(held), retained: held.retainedNativeBinding, scopeWhileHeld: false }
      x.codex.activeThreadId = held.id; x.codex.threadDrafts[held.id] = QUESTION; x.codex.threadDraftRevisions[held.id] = 1
      const room = x.relogin()
      const scope = x.env.realScope(room.id, QUESTION)
      results.push({ mode, restores, retainedAfterHeld: heldInfo.retained, bindingState: room.bindingState, binding: ChatState.clientThreadBinding(room),
        retainedAfter: room.retainedNativeBinding, scope: !!scope })
      assert.equal(heldInfo.held, true, 'held after restore until owner verified')
      assert.equal(room.bindingState, 'verified')
      assert.equal(room.conversationId, x.seeded.conversationId)
      assert.equal(ChatState.clientThreadBinding(room), 'qa-dm-restored', 'original native client binding preserved')
      assert.equal(room.retainedNativeBinding.conversationId, x.seeded.conversationId)
      assert.equal(room.retainedNativeBinding.clientThreadId, 'qa-dm-restored')
      assert.ok(scope, `${mode} x${restores}: recommendation gate open after verification`)
    }
  }
  t.diagnostic('C ' + JSON.stringify(results))
})

test('L1c2 sim D: raw options kept across a settings save only for the same room/question; review, approval and results are never kept', async t => {
  const open = async (x, m, phase) => {
    m.typeDraft(QUESTION); m.ui.sync(); click(m.ui.trigger)
    m.fields().forEach((field, i) => { field.value = OPTIONS[i]; field.props.oninput() })
    if (phase === 'edit') return
    x.f.phase = 'choice1'
    click(m.button('review'))
    await eventually(() => m.button('confirm'), 'confirm')
    if (phase === 'review') return
    click(m.button('confirm'))
    await eventually(() => m.button('result'), 'result')
  }
  // review phase: settings saved -> confirm authority gone, raw options back, fresh review needed
  {
    const x = await settingsFixture(t, { alreadyOn: true }); x.relogin(); const m = mountSettingsUi(x, t)
    await open(x, m, 'review')
    const posts = x.f.httpPosts.length
    await m.saveKeyInSettings(); m.ui.sync()
    assert.equal(m.button('confirm'), undefined, 'review authority dropped')
    click(m.ui.trigger)
    assert.deepEqual(m.fields().map(n => n.value), OPTIONS)
    assert.equal(m.button('confirm'), undefined)
    assert.equal(x.f.httpPosts.length, posts, 'nothing sent by the settings save or reopen')
  }
  // recommended result shown: settings saved -> result cleared, nothing kept
  {
    const x = await settingsFixture(t, { alreadyOn: true }); x.relogin(); const m = mountSettingsUi(x, t)
    await open(x, m, 'recommended')
    await m.saveKeyInSettings(); m.ui.sync()
    assert.equal(m.button('result'), undefined)
    click(m.ui.trigger)
    assert.deepEqual(m.fields().map(n => n.value), ['', ''], 'a delivered recommendation leaves no reusable options')
  }
  // composer text changed while away (different question) -> not followed
  {
    const x = await settingsFixture(t, { alreadyOn: true }); x.relogin(); const m = mountSettingsUi(x, t)
    await open(x, m, 'edit')
    await m.saveKeyInSettings(); m.typeDraft('다음 회의는 언제 열까요?'); m.ui.sync()
    click(m.ui.trigger)
    assert.deepEqual(m.fields().map(n => n.value), ['', ''])
  }
  // same text re-typed after an edit (new draft revision) -> not followed
  {
    const x = await settingsFixture(t, { alreadyOn: true }); x.relogin(); const m = mountSettingsUi(x, t)
    await open(x, m, 'edit')
    await m.saveKeyInSettings(); m.typeDraft(QUESTION + ' '); m.typeDraft(QUESTION); m.ui.sync()
    click(m.ui.trigger)
    assert.deepEqual(m.fields().map(n => n.value), ['', ''], 'new draft revision is a new edit')
  }
  // different account signs in while away -> held, then not followed
  {
    const x = await settingsFixture(t, { alreadyOn: true }); x.relogin(); const m = mountSettingsUi(x, t)
    await open(x, m, 'edit')
    x.codex.authStatus = otherAccountAuth(); x.codex.codexAccountKey = ChatState.codexAccountKey(x.codex.authStatus)
    x.codex.threads = x.codex.threads.map(row => ChatState.reconcileNativeThread(ChatState.detachNativeThread(row, null, 'acct-switch'), x.codex.authStatus))
    m.ui.sync()
    assert.equal(m.ui.trigger.hidden, true); assert.equal(m.ui.panel.hidden, true)
    assert.equal(m.readScope(), null)
  }
})
