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
import { createDecisionBudget, createDecisionClient, DECISION_MODEL, DECISIONS_ENDPOINT, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'
import { openDecisionCredentialStore } from '../helper/egdesk-decision-credential.mjs'
import { openBridgeSettings } from '../helper/egdesk-bridge-settings.mjs'
import { createDecisionHttpHandler } from '../helper/egdesk-decision-http.mjs'
import { createBoardPresentationHttpHandler } from '../helper/egdesk-board-presentation-http.mjs'
import * as AccountSettingsView from '../overlay/resources/EGDeskAccountSettingsView.sys.mjs'
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
  const JOURNEY_KEY = 'egd-synthetic-not-a-key-0001'
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
  // --- Real bridge decision layer over a real temp settings dir (key file, mode file); restartable. ---
  const settingsDir = join(dir, 'settings')
  const providerLog = [], requests = []
  let boots = 0, chat, routes, decisionCreds, bridgeSettings, decisionClient, boardPres, generation = 0
  const providerFetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const name = body.questions[0].name
    const kind = name === 'key_check' ? 'key_check' : name === 'chat_choice' ? 'chat_choice' : 'other'
    providerLog.push({ phase, boot: boots, kind, endpoint: url === DECISIONS_ENDPOINT, authOk: init.headers.authorization === `Bearer ${JOURNEY_KEY}` })
    counts[phase] ??= noWork()
    if (kind === 'key_check') {
      if (providerState.verify === 'invalid') return { ok: false, status: 401, text: async () => JSON.stringify({ error: { code: 'invalid_api_key' } }) }
      if (providerState.verify === 'no_credit') return { ok: false, status: 429, text: async () => JSON.stringify({ error: { code: 'insufficient_quota', type: 'insufficient_quota' } }) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: DECISION_MODEL, answers: [{ name: 'key_check', type: 'predicate', probability: 0.99 }] }) }
    }
    if (kind !== 'chat_choice') return fail(`unexpected decision request kind ${kind}`)
    if (providerState.choice === '429') return { ok: false, status: 429, text: async () => JSON.stringify({ error: { code: 'insufficient_quota', type: 'insufficient_quota' } }) }
    if (providerState.verify === 'invalid') return { ok: false, status: 401, text: async () => JSON.stringify({ error: { code: 'invalid_api_key' } }) }
    counts[phase].decisionChoice++
    decisionRequests.push({ phase, url, method: init.method, body })
    const [q] = body.questions
    const picked = q.choices[phase === 'choice1' ? 1 : 0].value
    return { ok: true, status: 200, text: async () => JSON.stringify({
      answers: [{ type: 'choice', name: q.name, choice: picked, confidence: 0.92,
        probabilities: q.choices.map(({ value }) => ({ value, probability: value === picked ? 0.92 : value === 'abstain' ? 0.02 : 0.06 })),
        reason: PRIVATE.modelReason, explanation: PRIVATE.modelReason }],
    }) }
  }
  const ownerKey = () => publicAuthIdentityKey(codexAuth)
  const refreshCodexAccount = async () => { codexAuth = normalizeNativeAuth(await transport('getAuthStatus', {}), await transport('account/read', {})) }
  const engine = createCodexEngineAdapter({ request: transport, respond: () => fail('unexpected user/approval response'), getOwnerKey: ownerKey })
  function bootBridge() {
    boots++
    decisionCreds = openDecisionCredentialStore({ dataDir: settingsDir, log() {} })
    bridgeSettings = openBridgeSettings({ dataDir: settingsDir, log() {} })
    const budget = createDecisionBudget()
    decisionClient = createDecisionClient({ getApiKey: () => decisionCreds.getApiKey(), budget, fetchImpl: providerFetch,
      recipientForKey: (key, endpoint, model) => decisionTopicRecipient(key, decisionCreds.savedAt(), endpoint, model) })
    boardPres = createBoardPresentationHttpHandler({ credentials: decisionCreds, getMode: () => bridgeSettings.decisionContext.mode, budget, fetchImpl: providerFetch })
    const decisionHandler = createDecisionHttpHandler({ store: decisionCreds, verifyKey: key => decisionClient.verifyKey(key), budget, model: decisionClient.model,
      mode: bridgeSettings.decisionContext, boardPresentation: boardPres, onSettingsChanged: () => { generation++ } })
    chat = new CodexChatRuntime({ engines: [engine], store, requireStore: true, profiles, getOwnerKey: ownerKey, resolveProjectWorkspace,
      decisionContext: { client: decisionClient, settingsGeneration: () => generation, reviewRevision: () => boardPres.settingsRevision(),
        recipientForChatChoice: ({ engineId, ownerKey: scopedOwner }) => engineId === 'codex' && codexAuth?.isLoggedIn === true && codexAuth.authMode === 'chatgpt' && scopedOwner === ownerKey()
          ? decisionTopicRecipient(decisionCreds.getApiKey(), decisionCreds.savedAt(), undefined, decisionClient.model) : null,
        mode: () => bridgeSettings.decisionContext.mode, configured: () => decisionCreds.getApiKey() !== null,
        collect: async ({ body, context, memoryEvidenceFor, speech }) => {
          counts[phase].contextCollection++
          const collected = await collectDecisionCandidates({ body, memoryEvidenceFor, speech, clientThreadId: context.clientThreadId,
            excludeMessageId: context.localMessageId, chatStore: store })
          if (Object.values(collected.sources).some(count => count !== 0)) fail('expected no authorized pre-turn context candidates')
          return collected.candidates
        } },
    })
    chat.setConnection(true)
    const auth = createChatEngineAuth({ chat, refreshCodexAccount, getCodexAuth: () => codexAuth })
    routes = [createChatHttpHandler(chat, auth), decisionHandler]
  }
  const providerState = { verify: 'ok', choice: 'ok' }
  bootBridge()
  async function request(method, path, body) {
    requests.push({ phase, boot: boots, method, path })
    const url = new URL(path, 'http://127.0.0.1:39218')
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: { host: url.host, origin: 'chrome://browser', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      socket: { remoteAddress: '127.0.0.1' } })
    const res = Object.assign(new EventEmitter(), { destroyed: false, setHeader() {}, writeHead(status) { this.status = status }, end(raw) { this.body = JSON.parse(raw) } })
    assert.equal(guardBridgeRequest(req), true)
    for (const route of routes) if (await route(req, res, url)) return res
    return fail(`production route did not handle ${path}`)
  }
  async function post(path, body) {
    httpPosts.push({ phase, path, body: structuredClone(body) })
    return request('POST', path, body)
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
  return { store, agent, custom, direct, send, complete, post, request, refreshCodexAccount, nativeCalls, providerLog, requests, providerState, JOURNEY_KEY,
    restartBridge: () => { chat?.close?.(); bootBridge() }, bridgeState: () => ({ boots, mode: bridgeSettings.decisionContext.mode, configured: decisionCreds.getApiKey() !== null, savedAtSet: decisionCreds.savedAt() !== null }),
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
    threadDraftRevisions: {}, activeThreadId: null, hudView: 'conversation' }
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


// ===========================================================================
// L1 cycle 5: the user's first-run journey, in one test.
// Product code used verbatim: restore/reconcile (ChatState), the real bridge decision layer
// (credential store file, bridge settings file, /decision/* handler, board settingsRevision, chat runtime,
// /chat/* handler, SQLite), the Surface account-screen Decisions section (extracted slice), the real
// openChatChoiceSettings, mountChatChoiceComposer, chatChoiceScope, decisionRequest, HUD send slice.
// Fixtures: the settings card shell (active canvas entity; account tab selected), emit -> choice.sync,
// refreshConversation -> real /chat/resume, the Decisions provider (mock), the Codex native threads (mock).
// ===========================================================================
const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const surfaceSlice = (begin, end) => {
  const i = surfaceSource.indexOf(begin), j = surfaceSource.indexOf(end, i + begin.length)
  assert.ok(i >= 0 && j > i, 'surface slice: ' + begin)
  return surfaceSource.slice(i, j)
}
const attrOf = (node, name) => name === 'data-testid' ? node.props.data?.testid : name === 'data-mode' ? node.props.data?.mode : node.props[name]
function queryAll(node, selector) {
  const m = /^([a-z]+)?((?:\[[a-z-]+="[^"]*"\])*)$/.exec(selector)
  assert.ok(m, 'unsupported selector ' + selector)
  const attrs = [...m[2].matchAll(/\[([a-z-]+)="([^"]*)"\]/g)].map(a => [a[1], a[2]])
  const out = []
  const walk = n => {
    if (!n || typeof n !== 'object') return
    if ((!m[1] || n.tag === m[1]) && attrs.every(([k, v]) => String(attrOf(n, k)) === v)) out.push(n)
    for (const c of n.children || []) walk(c)
  }
  walk(node)
  return out
}
const settingsEl = (tag, props = {}, ...children) => {
  const node = element(tag, props, ...children.filter(c => c !== null && c !== undefined))
  node.disabled = props.disabled === 'true' || props.disabled === true
  node.scrollIntoView = () => {}
  node.querySelector = selector => queryAll(node, selector)[0] || null
  return node
}
const textOf = node => node == null ? '' : typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join(' ') : [node.textContent, ...(node.children || []).map(textOf)].filter(Boolean).join(' ')

function mountSettingsCard(state, decisionRequest) {
  const code = surfaceSlice('    const decision = { status: null, loaded: false', '    // --- 연결된 도구 (CU-07)')
  const card = { id: 'egd-settings-card-1', isConnected: true, classList: { contains: () => false }, section: null, _setWindowCollapsed() {},
    render() { this.section = api.renderDecisionModel() }, _settingsShowTab() { this.render() },
    querySelector(selector) {
      if (selector === '[data-testid="settings-tab-account"][aria-selected="true"]') return {}
      if (selector === '[data-testid="settings-decision"]') return this.section
      return null
    } }
  const api = runInNewContext(code + '\n({ renderDecisionModel, decision })', { el: settingsEl, state, AccountSettingsView, activeTab: 'account',
    bridge: () => ({ decisionRequest }), renderAccountTab: () => card.render() }, { filename: 'eg-desk-surface.uc.js (account decision section)' })
  card.decision = api.decision
  card.render()
  return card
}

function mountJourneyUi(x, t) {
  const { f, env, codex, state } = x
  const input = element('textarea'), notices = []
  const room = codex.threads[0]
  const settingsCard = { current: null }
  const resumed = new Set(), resumeCalls = []
  const bridgeFetch = async (url, init) => {
    const u = new URL(url)
    const res = await f.request(init.method, u.pathname, init.body === undefined ? undefined : JSON.parse(init.body))
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body }
  }
  const ui = { current: null }
  const document = { getElementById: id => id === 'egd-settings-card-1' ? { matches: () => false } : assert.fail('unexpected entity ' + id) }
  codex.activeThreadId = room.id
  const send = mountFixtureHudSend(f, env, room, { sync: () => ui.current.sync(), reset: () => ui.current.reset() }, input, false, {
    document, fetch: bridgeFetch, emit: () => ui.current?.sync(), resumedNativeBindings: resumed, InputContext,
    refreshConversation: async (thread, resume) => {
      assert.equal(resume, true)
      const response = await f.post('/chat/resume', { conversationId: thread.conversationId, clientThreadId: ChatState.clientThreadBinding(thread), engineId: 'codex' })
      resumeCalls.push(response.status)
      return response.status === 200 ? response.body : null
    },
  })
  const spawnSettingsCard = () => {
    if (settingsCard.current) settingsCard.current._settingsShowTab('account')
    else settingsCard.current = mountSettingsCard(state, (p, i) => send.bridge.decisionRequest(p, i))
    state.activeEntityId = settingsCard.current.id
    state.canvasSelectionRevision = (state.canvasSelectionRevision || 0) + 1
    return settingsCard.current
  }
  const openChatChoiceSettings = runInNewContext(surfaceSlice('  function openChatChoiceSettings(reason) {', '  function mountChatChoiceComposer(') + '\nopenChatChoiceSettings',
    { spawnSettingsCard, revealOpenCanvasCard() {}, state, boardNotice: text => notices.push(text) }, { filename: 'eg-desk-surface.uc.js (openChatChoiceSettings)' })
  const readScope = () => send.bridge.chatChoiceScope(codex.activeThreadId, input.value)
  const choiceResponses = [], requestIds = []
  const { mountChatChoiceComposer, readChatChoiceMode, postChatChoice } = loadComposer(async (path, { method, signal, body }) => {
    const res = path === '/decision/status' ? await f.request('GET', path) : await f.post(path, JSON.parse(body))
    if (path === '/chat/choice') choiceResponses.push(res)
    if (res.status >= 400) throw Object.assign(new Error('http ' + res.status), { status: res.status })
    return res.body
  })
  ui.current = mountChatChoiceComposer({ el: element, makeController: () => new AbortController(),
    makeRequestId: () => { const id = `choice-${Date.now()}-${randomUUID()}`; requestIds.push(id); return id },
    readMode: readChatChoiceMode, postChoice: postChatChoice, openSettings: openChatChoiceSettings })
  t.after(() => ui.current.dispose())
  let draftWrites = 0
  ui.current.attach({ input, readScope, setDraft: text => { draftWrites++; send.bridge.setDraft(text, room.id) } })
  const typeDraft = text => { input.value = text; send.bridge.setDraft(text, room.id) }
  return { ui: ui.current, input, send, readScope, typeDraft, notices, resumed, resumeCalls, settingsCard, spawnSettingsCard, choiceResponses, requestIds,
    fields: () => findAll(ui.current.panel, 'option'), button: id => findAll(ui.current.panel, id)[0],
    panelText: () => textOf(ui.current.panel.children), get draftWrites() { return draftWrites }, room }
}

const countBy = (rows, key) => rows.reduce((o, r) => ({ ...o, [r[key]]: (o[r[key]] || 0) + 1 }), {})
const secretFree = (value, secrets, label) => {
  const wire = typeof value === 'string' ? value : JSON.stringify(value)
  for (const s of secrets) assert.ok(!wire.includes(s), label + ' must not contain ' + s.slice(0, 6) + '…')
}

test('L1c5 first-run journey: restored DM -> key-missing guidance -> settings -> paste key -> verify -> mode on -> same DM recommendation -> reason -> send -> bridge restart -> second recommendation', async t => {
  const f = createFixture(t, ['restore', 'settings', 'restart'], undefined, { resolveProjectWorkspace: async () => null })
  await f.refreshCodexAccount()
  const seeded = await f.send(f.direct('qa-dm-restored'), 'seed-restored', PRIVATE.primaryHistory)
  await f.complete(seeded, PRIVATE.code)
  const env = createRoomProjection(f), { codex, state } = env
  const live = f.authStatus(), signedOut = signedOutOf(live)
  codex.authStatus = signedOut; codex.codexAccountKey = null
  codex.threads.push(restoreRoom(f, seeded, 'qa-dm-restored', signedOut))
  const bind = () => env.projectDefaults.set(codex.threads[0].id, { binding: ChatState.clientThreadBinding(codex.threads[0]), scope: { current: () => true }, status: 'ready', value: { status: 'none' } })
  bind()
  const heldInfo = { held: ChatState.nativeBindingHeld(codex.threads[0]) }
  codex.authStatus = live; codex.codexAccountKey = ChatState.codexAccountKey(live)
  codex.threads = codex.threads.map(row => ChatState.reconcileNativeThread(row, live)); bind()
  const x = { f, env, codex, state }
  const m = mountJourneyUi(x, t)
  const trace = [], stuck = []
  let focusMark = focusLog.length
  const snapNow = (step, extra = {}) => {
    const entry = { step, focus: focusLog.slice(focusMark).join('>') || '-', triggerHidden: m.ui.trigger.hidden, panelHidden: m.ui.panel.hidden,
      panel: m.panelText().slice(0, 160), options: m.fields().map(n => n.value), composer: m.input.value.slice(0, 40),
      provider: countBy(f.providerLog, 'kind'), bridge: { ...countBy(f.requests.filter(r => !r.path.startsWith('/chat/send')), 'path'), boots: f.bridgeState().boots },
      bridgeState: f.bridgeState(), ...extra }
    focusMark = focusLog.length
    trace.push(entry); return entry
  }
  const QUESTION1 = '회의 안내를 어디에 둘까요?', OPTIONS1 = ['상단 알림', '일정 공지']
  const KEY = f.JOURNEY_KEY
  const room = () => codex.threads[0]

  // 0. Restored DM: owner verified, resume 200.
  assert.equal(heldInfo.held, true, 'restored DM starts held')
  assert.equal(room().bindingState, 'verified')
  const resumed = await f.post('/chat/resume', { conversationId: room().conversationId, clientThreadId: ChatState.clientThreadBinding(room()), engineId: 'codex' })
  assert.equal(resumed.status, 200)
  m.typeDraft(QUESTION1); m.ui.sync()
  snapNow('0 restored+verified+resumed, question typed')
  assert.equal(m.ui.trigger.hidden, false)

  // 1. [보기 추천] -> options -> review while the key is missing.
  click(m.ui.trigger)
  m.fields().forEach((field, i) => { field.value = OPTIONS1[i]; field.props.oninput() })
  f.phase = 'settings'
  click(m.button('review'))
  await eventually(() => m.button('settings'), 'setup guidance never appeared')
  const guidance1 = snapNow('1 review with no key')
  assert.match(guidance1.panel, /저장한 API 키가 없습니다/)
  assert.equal(f.providerLog.length, 0, 'review is local only')

  // 2. [계정 설정 열기]: account screen opens (first render: status still unknown).
  click(m.button('settings'))
  const card = m.settingsCard.current
  assert.ok(card, 'settings card opened')
  const open1 = snapNow('2 settings opened', { sectionState: card.section.props.data.state, keyInputDisabled: queryAll(card.section, 'input[type="password"][data-testid="settings-decision-key"]')[0].disabled })
  if (!focusLog.slice(-3).includes('settings-decision-key')) stuck.push('S1: opening settings from the key-missing guidance does not focus the key field on first open (status not loaded yet, input disabled)')
  await eventually(() => card.section.props.data.state === 'empty', 'status never loaded')
  const loaded = snapNow('3 status loaded', { keyLine: textOf(queryAll(card.section, 'span')), result: null })
  assert.equal(queryAll(card.section, 'input[type="password"][data-testid="settings-decision-key"]')[0].disabled, false)
  assert.equal(card.section.props.data.mode, 'off')

  // 3. Paste the key and [확인 후 저장] (mock verifier).
  const keyInput = () => queryAll(card.section, 'input[type="password"][data-testid="settings-decision-key"]')[0]
  keyInput().value = KEY
  click(queryAll(card.section, 'button[data-testid="settings-decision-save"]')[0])
  await eventually(() => queryAll(card.section, '[data-testid="settings-decision-result"]')[0], 'no verification result shown')
  const saved = snapNow('4 key saved', { section: textOf(card.section).slice(0, 400), resultText: textOf(queryAll(card.section, '[data-testid="settings-decision-result"]')[0]) })
  assert.deepEqual(f.providerLog.map(r => r.kind), ['key_check'], 'exactly one verification request reached the provider')
  assert.equal(f.providerLog[0].authOk, true)
  assert.equal(f.bridgeState().configured, true)
  assert.equal(keyInput().value, '', 'key field cleared')
  secretFree(saved, [KEY], 'visible account screen after save')
  secretFree(f.requests, [KEY], 'request log')
  assert.equal(card.decision.status.mode, 'off', 'mode is still off after the key is saved')
  assert.match(saved.resultText, /모드가 ‘끔’이라 아직 쓰이지 않습니다.*‘사용’을 고르면/, 'the saved-key result points to the mode switch while the mode is still off')

  // 4. Re-query: close Settings, reopen -> fresh GET shows configured + hint, never the key.
  m.settingsCard.current = null
  const reopened = m.spawnSettingsCard()
  await eventually(() => reopened.section.props.data.state === 'configured', 'reopened screen never showed configured')
  const requery = snapNow('5 settings reopened (re-query)', { section: textOf(reopened.section).slice(0, 300) })
  assert.match(textOf(queryAll(reopened.section, '[data-testid="settings-decision-hint"]')[0]), /저장된 키 …0001/)
  secretFree(requery, [KEY], 're-queried account screen')
  secretFree(f.requests, [KEY], 'request log after re-query')

  // 5. Back in the same DM: typed question/options survive; review now says the mode is off.
  m.ui.sync()
  assert.equal(m.ui.trigger.hidden, false, '[보기 추천] offered again')
  assert.equal(codex.threadDrafts[room().id], QUESTION1)
  click(m.ui.trigger)
  snapNow('6 back in DM, reopened panel')
  assert.deepEqual(m.fields().map(n => n.value), OPTIONS1, 'options survived the settings detour')
  click(m.button('review'))
  await eventually(() => m.button('settings'), 'mode guidance never appeared')
  const modeGuidance = snapNow('7 review with key saved but mode off')
  assert.match(modeGuidance.panel, /꺼져 있습니다/)
  stuck.push('S3: after saving the key the user must go back to the DM, review again, and only then learns the mode is off (second trip to Settings); typed options survive both trips')
  click(m.button('settings'))
  snapNow('8 [계정 설정 열기] for the mode (focus target)', { sectionMode: m.settingsCard.current.section.props.data.mode })
  assert.ok(focusLog.slice(focusMark - 1).length >= 0)

  // 6. Switch mode to 사용 in the account screen.
  const settings2 = m.settingsCard.current
  await eventually(() => settings2.section.props.data.state === 'configured', 'status')
  const onButton = () => queryAll(settings2.section, 'button[data-testid="settings-decision-mode"][data-mode="on"]')[0]
  assert.equal(onButton().disabled, false)
  click(onButton())
  await eventually(() => settings2.decision.status?.mode === 'on' && !settings2.decision.busy, 'mode never saved')
  snapNow('9 mode on', { modeNote: textOf(queryAll(settings2.section, '[data-testid="settings-decision-mode-note"]')[0]), bridge: f.bridgeState() })
  assert.equal(f.bridgeState().mode, 'on')
  assert.deepEqual(f.providerLog.map(r => r.kind), ['key_check'], 'saving the mode sends nothing to the provider')

  // 7. Back to the SAME DM: options still there -> review -> confirm -> recommendation.
  m.ui.sync()
  assert.equal(m.ui.trigger.hidden, false)
  click(m.ui.trigger)
  assert.deepEqual(m.fields().map(n => n.value), OPTIONS1, 'options survived two settings detours')
  assert.equal(m.input.value, QUESTION1)
  f.phase = 'choice1'
  click(m.button('review'))
  const confirm = await eventually(() => m.button('confirm'), 'confirm never offered after mode on')
  snapNow('10 review ok, confirm offered')
  assert.deepEqual(f.counts.choice1, noWork(), 'review is local')
  click(confirm)
  const result = await eventually(() => m.button('result'), 'no recommendation')
  snapNow('11 recommendation')
  assert.equal(result.textContent, 'EG-Desk 추천: 일정 공지 · 실행하지 않음')
  assert.deepEqual(f.providerLog.map(r => r.kind), ['key_check', 'chat_choice'])
  assert.ok(f.providerLog.every(r => r.authOk && r.endpoint), 'the saved key and the provider endpoint, nothing else')

  // 8. [이유 묻기] -> real HUD [보내기].
  f.phase = 'draft'
  click(m.button('explain'))
  const draft = await eventually(() => m.draftWrites === 1 && m.input.value, 'no reason draft')
  snapNow('12 reason draft in composer')
  m.send.syncSendButton()
  assert.equal(m.send.sendButton.disabled, false)
  f.phase = 'explanation'
  click(m.send.sendButton)
  const outcome = await eventually(() => m.send.outcomes[0], 'send did not settle')
  assert.deepEqual([outcome.result.accepted, m.send.posts[0].status], [true, 202], JSON.stringify(m.send.posts[0]?.body))
  assert.equal(f.startTurns.at(-1).params.threadId, seeded.conversationId)
  assert.equal(f.counts.draft.subscription, 0)
  snapNow('13 ordinary send accepted on the original conversation', { subscriptionTurns: f.startTurns.length })
  await f.complete(m.send.posts[0].body, PRIVATE.subscriptionReply)
  // Reproject the finished run into the DM, as the product's run sync does.
  for (const run of ChatState.mergeChatSnapshot(env.protocol, f.snapshot(seeded.conversationId), ChatState.clientThreadBinding(room()))) void run

  // 9. The bridge restarts: key and mode come back from disk without re-entry.
  f.phase = 'restart'
  const before = f.bridgeState()
  f.restartBridge()
  m.resumed.clear()
  const after = f.bridgeState()
  snapNow('14 bridge restarted', { before, after })
  assert.deepEqual([after.configured, after.mode, after.savedAtSet, after.boots], [true, 'on', true, 2])
  const status2 = await f.request('GET', '/decision/status')
  assert.equal(status2.body.configured, true); assert.equal(status2.body.mode, 'on')
  secretFree(status2.body, [KEY], 'status after restart')

  // 10. Second recommendation in the same DM; the saved key is reused (no key_check again).
  const QUESTION2 = '다음 회의는 언제 열까요?', OPTIONS2 = ['오전', '오후']
  m.typeDraft(QUESTION2); m.ui.sync()
  if (m.ui.trigger.hidden) {
    stuck.push('S4: after the first send the DM could not offer [보기 추천] again until the run was reprojected/resumed (harness reprojection incomplete or product gap) — see trace')
  }
  assert.equal(m.ui.trigger.hidden, false, 'second recommendation is offered in the same DM')
  click(m.ui.trigger)
  m.fields().forEach((field, i) => { field.value = OPTIONS2[i]; field.props.oninput() })
  f.phase = 'choice2'
  click(m.button('review'))
  const confirm2 = await eventually(() => m.button('confirm'), 'confirm never offered after restart')
  click(confirm2)
  const result2 = await eventually(() => m.button('result'), 'no second recommendation')
  snapNow('15 second recommendation after restart')
  assert.equal(result2.textContent, 'EG-Desk 추천: 오전 · 실행하지 않음')
  assert.deepEqual(countBy(f.providerLog, 'kind'), { key_check: 1, chat_choice: 2 })
  assert.deepEqual(f.providerLog.map(r => r.boot), [1, 1, 2], 'the second recommendation came from the restarted bridge')
  assert.ok(f.providerLog.every(r => r.authOk))
  assert.deepEqual(f.unexpected, [])
  secretFree(trace, [KEY], 'whole visible trace')
  secretFree(f.requests, [KEY], 'every bridge request record')
  t.diagnostic('TRACE ' + JSON.stringify(trace))
  t.diagnostic('STUCK ' + JSON.stringify(stuck))
})

async function restoredToSettings(t) {
  const f = createFixture(t, ['restore', 'settings', 'restart'], undefined, { resolveProjectWorkspace: async () => null })
  await f.refreshCodexAccount()
  const seeded = await f.send(f.direct('qa-dm-restored'), 'seed-restored', PRIVATE.primaryHistory)
  await f.complete(seeded, PRIVATE.code)
  const env = createRoomProjection(f), { codex, state } = env
  const live = f.authStatus()
  codex.authStatus = signedOutOf(live); codex.codexAccountKey = null
  codex.threads.push(restoreRoom(f, seeded, 'qa-dm-restored', codex.authStatus))
  codex.authStatus = live; codex.codexAccountKey = ChatState.codexAccountKey(live)
  codex.threads = codex.threads.map(row => ChatState.reconcileNativeThread(row, live))
  env.projectDefaults.set(codex.threads[0].id, { binding: ChatState.clientThreadBinding(codex.threads[0]), scope: { current: () => true }, status: 'ready', value: { status: 'none' } })
  const m = mountJourneyUi({ f, env, codex, state }, t)
  m.typeDraft('회의 안내를 어디에 둘까요?'); m.ui.sync()
  click(m.ui.trigger)
  m.fields().forEach((field, i) => { field.value = ['상단 알림', '일정 공지'][i]; field.props.oninput() })
  f.phase = 'settings'
  click(m.button('review'))
  await eventually(() => m.button('settings'), 'guidance')
  click(m.button('settings'))
  const card = m.settingsCard.current
  await eventually(() => card.section.props.data.state === 'empty', 'status')
  return { f, m, card, seeded, codex }
}
const keyInputOf = card => queryAll(card.section, 'input[type="password"][data-testid="settings-decision-key"]')[0]
const resultOf = card => textOf(queryAll(card.section, '[data-testid="settings-decision-result"]')[0])
const pasteAndSave = async (card, value) => {
  keyInputOf(card).value = value
  click(queryAll(card.section, 'button[data-testid="settings-decision-save"]')[0])
  await eventually(() => queryAll(card.section, '[data-testid="settings-decision-result"]')[0], 'no result')
}

test('L1c5 variant: wrong key is rejected, nothing saved, field cleared, DM unchanged', async t => {
  const { f, m, card } = await restoredToSettings(t)
  f.providerState.verify = 'invalid'
  await pasteAndSave(card, f.JOURNEY_KEY)
  t.diagnostic('REJECT ' + JSON.stringify({ text: resultOf(card), bridge: f.bridgeState(), fieldAfter: keyInputOf(card).value }))
  assert.match(resultOf(card), /키를 저장하지 않았습니다/)
  assert.equal(f.bridgeState().configured, false)
  assert.equal(keyInputOf(card).value, '')
  m.ui.sync()
  assert.equal(m.ui.trigger.hidden, false)
  click(m.ui.trigger)
  assert.deepEqual(m.fields().map(n => n.value), ['상단 알림', '일정 공지'], 'the typed options are still there after a rejected key')
})

test('L1c5 variant: key saved with no credit, mode on, provider 429 on the recommendation: what the user sees and whether the options survive', async t => {
  const { f, m, card } = await restoredToSettings(t)
  f.providerState.verify = 'no_credit'
  await pasteAndSave(card, f.JOURNEY_KEY)
  const saveText = resultOf(card)
  assert.match(saveText, /크레딧 없음 · 키는 저장했습니다/)
  assert.equal(f.bridgeState().configured, true)
  click(queryAll(card.section, 'button[data-testid="settings-decision-mode"][data-mode="on"]')[0])
  await eventually(() => card.decision.status?.mode === 'on' && !card.decision.busy, 'mode')
  m.ui.sync(); click(m.ui.trigger)
  f.providerState.choice = '429'
  f.phase = 'choice1'
  click(m.button('review'))
  click(await eventually(() => m.button('confirm'), 'confirm'))
  await eventually(() => /크레딧이 부족/.test(m.panelText()), 'no-credit guidance')
  const manual = m.panelText()
  click(m.button('edit'))
  const keptOptions = m.fields().map(n => n.value)
  t.diagnostic('NOCREDIT ' + JSON.stringify({ saveText, manual, keptOptions, providerKinds: f.providerLog.map(r => r.kind) }))
  assert.match(manual, /OpenAI 결제 설정에서 크레딧을 확인해 주세요/)
  assert.deepEqual(keptOptions, ['상단 알림', '일정 공지'], '[질문·보기 수정] keeps the typed options')
  assert.deepEqual(f.providerLog.map(r => r.kind), ['key_check', 'chat_choice'])
  assert.equal(f.counts.choice1.subscription, 0, 'a failed recommendation starts no subscription turn')
})
