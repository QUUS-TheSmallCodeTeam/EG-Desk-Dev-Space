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
  const providerLog = [], requests = [], ontology = { graph: { snapshots: [], nodes: [] } }
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
    if (body.questions.some(q => q.name === 'answer_type')) {
      providerLog[providerLog.length - 1].kind = 'turn_context'
      counts[phase].decisionContext++
      if (providerState.context === '429') return { ok: false, status: 429, text: async () => JSON.stringify({ error: { code: 'insufficient_quota', type: 'insufficient_quota' } }) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: body.questions.map(q => q.type === 'predicate'
        ? { type: 'predicate', name: q.name, probability: 0.93 }
        : { type: 'choice', name: q.name, choice: q.choices[0].value, confidence: 0.9,
          probabilities: q.choices.map((c, k) => ({ value: c.value, probability: k === 0 ? 0.9 : 0.1 / Math.max(1, q.choices.length - 1) })) }) }) }
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
            excludeMessageId: context.localMessageId, chatStore: store, ontologyStore: { readGraph: async () => ontology.graph } })
          if (['selected', 'messages', 'board'].some(name => collected.sources[name] !== 0)) fail('expected no selected/speech/board candidates')
          return collected.candidates
        } },
    })
    chat.setConnection(true)
    const auth = createChatEngineAuth({ chat, refreshCodexAccount, getCodexAuth: () => codexAuth })
    routes = [createChatHttpHandler(chat, auth), decisionHandler]
  }
  const providerState = { verify: 'ok', choice: 'ok', context: 'ok' }
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
  return { store, agent, custom, direct, send, complete, post, request, refreshCodexAccount, nativeCalls, providerLog, requests, providerState, ontology, JOURNEY_KEY,
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

// The settings card the section closes over (runDecision reads card.querySelector / card.contains / card.ownerDocument and
// restores focus to the key field when a redraw destroyed the focused node). Nodes know whether they are still in the card's
// current tree, and focus() moves the card document's activeElement, so the real focus-repair code runs against real state.
function mountSettingsCard(state, decisionRequest) {
  const code = surfaceSlice('    const decision = { status: null, loaded: false', '    // --- 연결된 도구 (CU-07)')
  const ownerDocument = { activeElement: null, body: { tag: 'body' } }
  const inTree = (root, node) => !!root && (root === node || (root.children || []).some(child => child && typeof child === 'object' && inTree(child, node)))
  const el = (tag, props = {}, ...children) => {
    const node = settingsEl(tag, props, ...children)
    Object.defineProperty(node, 'isConnected', { get: () => inTree(card.section, node) })
    node.focus = () => { ownerDocument.activeElement = node; focusLog.push(props.data?.testid || tag) }
    return node
  }
  const card = { id: 'egd-settings-card-1', classList: { contains: () => false }, section: null, ownerDocument, _setWindowCollapsed() {},
    get isConnected() { return true },
    render() { this.section = api.renderDecisionModel() }, _settingsShowTab() { this.render() },
    contains(node) { return inTree(this.section, node) },
    querySelector(selector) {
      if (selector === '[data-testid="settings-tab-account"][aria-selected="true"]') return {}
      if (selector === '[data-testid="settings-decision"]') return this.section
      return this.section ? queryAll(this.section, selector)[0] || null : null
    } }
  const api = runInNewContext(code + '\n({ renderDecisionModel, decision })', { el, state, AccountSettingsView, activeTab: 'account', card,
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
  const document = { getElementById: id => id === 'egd-settings-card-1' ? { matches: () => false } : assert.fail('unexpected entity ' + id) }
  codex.activeThreadId = room.id
  const send = mountFixtureHudSend(f, env, room, { sync() {}, reset() {} }, input, false, {
    document, fetch: bridgeFetch, emit() {}, resumedNativeBindings: resumed, InputContext,
    refreshConversation: async (thread, resume) => {
      assert.equal(resume, true)
      const response = await f.post('/chat/resume', { conversationId: thread.conversationId, clientThreadId: ChatState.clientThreadBinding(thread), engineId: 'codex' })
      resumeCalls.push(response.status)
      return response.status === 200 ? response.body : null
    },
  })
  // The user opens Settings from the Desk menu (account tab). The card shell is a fixture; the section is product code.
  const openSettings = () => {
    if (settingsCard.current) settingsCard.current._settingsShowTab('account')
    else settingsCard.current = mountSettingsCard(state, (p, i) => send.bridge.decisionRequest(p, i))
    state.activeEntityId = settingsCard.current.id
    return settingsCard.current
  }
  const closeSettings = () => { settingsCard.current = null }
  const typeDraft = text => { input.value = text; send.bridge.setDraft(text, room.id) }
  // Ordinary [보내기]: the real HUD send button.
  async function sendOrdinary(phase, text) {
    f.phase = phase
    typeDraft(text)
    send.syncSendButton()
    const enabled = !send.sendButton.disabled
    const n = send.outcomes.length
    if (enabled) click(send.sendButton)
    const outcome = enabled ? await eventually(() => send.outcomes[n], phase + ': send did not settle ' + JSON.stringify(room.sendError)) : null
    return { enabled, outcome, post: send.posts[n] }
  }
  // The subscription reply finishes (mock) and the run is merged into the DM as the product's run sync does.
  async function finishTurn(accepted) {
    await f.complete(accepted, PRIVATE.subscriptionReply)
    ChatState.mergeChatSnapshot(env.protocol, f.snapshot(accepted.conversationId), ChatState.clientThreadBinding(codex.threads[0]))
  }
  return { input, send, typeDraft, notices, resumed, resumeCalls, settingsCard, openSettings, closeSettings, sendOrdinary, finishTurn, room }
}

const countBy = (rows, key) => rows.reduce((o, r) => ({ ...o, [r[key]]: (o[r[key]] || 0) + 1 }), {})
const secretFree = (value, secrets, label) => {
  const wire = typeof value === 'string' ? value : JSON.stringify(value)
  for (const s of secrets) assert.ok(!wire.includes(s), label + ' must not contain ' + s.slice(0, 6) + '…')
}
const keyInputOf = card => queryAll(card.section, 'input[type="password"][data-testid="settings-decision-key"]')[0]
const modeButton = (card, mode) => queryAll(card.section, `button[data-testid="settings-decision-mode"][data-mode="${mode}"]`)[0]
const resultOf = card => textOf(queryAll(card.section, '[data-testid="settings-decision-result"]')[0])
const pasteAndSave = async (card, value) => {
  keyInputOf(card).focus() // the person clicks into the field and pastes
  keyInputOf(card).value = value
  click(queryAll(card.section, 'button[data-testid="settings-decision-save"]')[0])
  await eventually(() => queryAll(card.section, '[data-testid="settings-decision-result"]')[0], 'no verification result shown')
  await eventually(() => card.ownerDocument.activeElement === keyInputOf(card), 'focus was not restored to the key field after the redraw')
}
const turnContextOf = (f, accepted) => {
  const run = f.snapshot(accepted.conversationId).runs.find(r => r.runId === accepted.runId)
  return { activity: (run?.activities || []).find(a => a.kind === 'decisionContext') || null, receipt: !!run?.decisionContextReceipt }
}

async function restoredDm(t, { candidates = true } = {}) {
  const f = createFixture(t, ['restore', 'settings', 'preKey', 'modeOn', 'restart', 'afterRestart'], undefined, { resolveProjectWorkspace: async () => null })
  if (candidates) f.ontology.graph = { snapshots: [], nodes: [{ id: 'n1', label: '회의 안내 장소', summary: '회의 안내는 상단 알림과 일정 공지 중 어디에 둘지 정리한 문서', timeSlice: 'present', body: 'synthetic body not sent unless selected' }] }
  await f.refreshCodexAccount()
  const seeded = await f.send(f.direct('qa-dm-restored'), 'seed-restored', PRIVATE.primaryHistory)
  await f.complete(seeded, PRIVATE.code)
  const env = createRoomProjection(f), { codex, state } = env
  const live = f.authStatus(), out = signedOutOf(live)
  codex.authStatus = out; codex.codexAccountKey = null
  codex.threads.push(restoreRoom(f, seeded, 'qa-dm-restored', out))
  const held = ChatState.nativeBindingHeld(codex.threads[0])
  const bind = () => env.projectDefaults.set(codex.threads[0].id, { binding: ChatState.clientThreadBinding(codex.threads[0]), scope: { current: () => true }, status: 'ready', value: { status: 'none' } })
  bind()
  codex.authStatus = live; codex.codexAccountKey = ChatState.codexAccountKey(live)
  codex.threads = codex.threads.map(row => ChatState.reconcileNativeThread(row, live)); bind()
  const m = mountJourneyUi({ f, env, codex, state }, t)
  const resumed = await f.post('/chat/resume', { conversationId: codex.threads[0].conversationId, clientThreadId: ChatState.clientThreadBinding(codex.threads[0]), engineId: 'codex' })
  return { f, m, env, codex, seeded, held, resumeStatus: resumed.status }
}

test('L1c5 first-run journey (ordinary chat): restored DM -> account screen -> key -> verify -> re-query -> mode on -> ordinary message runs turn-start Decisions -> bridge restart -> again', async t => {
  const { f, m, env, codex, seeded, held, resumeStatus } = await restoredDm(t)
  const KEY = f.JOURNEY_KEY
  const trace = [], stuck = []
  const snapNow = (step, extra = {}) => { trace.push({ step, provider: countBy(f.providerLog, 'kind'), bridgeState: f.bridgeState(),
    turns: f.startTurns.length, decisionHttp: countBy(f.requests.filter(r => r.path.startsWith('/decision/')), 'path'), ...extra }); return trace.at(-1) }
  const ctxParam = () => f.startTurns.at(-1).params.additionalContext?.egdesk_decision_context

  // 0. The restored DM: held until the owner is verified, then verified + resume 200.
  assert.equal(held, true)
  assert.equal(codex.threads[0].bindingState, 'verified')
  assert.equal(resumeStatus, 200)
  snapNow('0 restored DM verified + resumed')

  // 1. Key-missing state. An ordinary message works and nothing in the DM mentions Decisions.
  const first = await m.sendOrdinary('preKey', '회의 안내는 어디에 둘까요?')
  assert.ok(first.enabled && first.outcome.result.accepted === true && first.post.status === 202)
  await m.finishTurn(first.post.body)
  assert.equal(f.providerLog.length, 0, 'no key, mode off: no provider request')
  assert.equal(ctxParam(), undefined)
  assert.deepEqual(m.notices, [], 'the DM shows no Decisions notice')
  stuck.push('S1: with no key and mode 끔 the DM gives no sign that the Decisions model exists or is unconfigured; the only entry point is Settings > Account > 결정 모델')
  snapNow('1 ordinary message, no key (mode off): turn ran, provider 0')

  // 2. Settings > account > OpenAI Decisions. First render: status unknown, key field disabled until the GET returns.
  const card = m.openSettings()
  const firstRender = snapNow('2 settings opened', { sectionState: card.section.props.data.state, keyDisabled: keyInputOf(card).disabled })
  await eventually(() => card.section.props.data.state === 'empty', 'status never loaded')
  assert.equal(card.section.props.data.mode, 'off')
  assert.match(textOf(queryAll(card.section, '[data-testid="settings-decision-hint"]')[0]), /저장된 키 없음/)
  snapNow('3 status loaded: no key, mode 끔', { keyLine: '저장된 키 없음' })

  // 3. Paste the key, [확인 후 저장] (mock verifier).
  await pasteAndSave(card, KEY)
  const saved = snapNow('4 key verified and saved', { resultText: resultOf(card) })
  assert.deepEqual(f.providerLog.map(r => r.kind), ['key_check'])
  assert.equal(f.providerLog[0].authOk, true)
  assert.equal(keyInputOf(card).value, '', 'key field cleared')
  assert.match(saved.resultText, /^확인됨 · 모드가 ‘끔’이라 아직 쓰이지 않습니다\. 아래에서 ‘사용’을 고르면 쓸 수 있습니다\.$/)
  secretFree([saved, f.requests], [KEY], 'account screen and request log')
  // An ordinary message while the key is saved but the mode is still off sends nothing to Decisions.
  const mid = await m.sendOrdinary('preKey', '키만 저장했는데 지금은 어떻게 되나요?')
  await m.finishTurn(mid.post.body)
  assert.equal(f.providerLog.length, 1, 'key saved, mode off: still no turn-start request')
  snapNow('5 ordinary message with key saved but mode 끔: provider still only the key check')

  // 4. Re-query: reopen Settings; a fresh GET shows the configured key by its hint, never the key.
  m.closeSettings()
  const reopened = m.openSettings()
  await eventually(() => reopened.section.props.data.state === 'configured', 'reopened screen never showed configured')
  assert.match(textOf(queryAll(reopened.section, '[data-testid="settings-decision-hint"]')[0]), /저장된 키 …0001/)
  secretFree(textOf(reopened.section), [KEY], 're-queried screen')
  snapNow('6 settings reopened: 저장된 키 …0001, mode 끔', { section: textOf(reopened.section).slice(0, 200) })

  // 5. Turn it on from the same section.
  assert.equal(modeButton(reopened, 'on').disabled, false)
  click(modeButton(reopened, 'on'))
  await eventually(() => reopened.decision.status?.mode === 'on' && !reopened.decision.busy, 'mode never saved')
  snapNow('7 mode 사용', { modeNote: textOf(queryAll(reopened.section, '[data-testid="settings-decision-mode-note"]')[0]).slice(0, 120) })
  assert.equal(f.bridgeState().mode, 'on')
  assert.equal(f.providerLog.length, 1, 'switching the mode sends nothing')

  // 6. Back in the SAME DM: an ordinary message now runs the turn-start Decisions request, then the subscription turn.
  const second = await m.sendOrdinary('modeOn', '회의 안내는 상단 알림과 일정 공지 중 어디에 둘까요?')
  assert.ok(second.enabled && second.outcome.result.accepted === true && second.post.status === 202)
  assert.equal(second.post.body.conversationId, seeded.conversationId, 'same conversation')
  const firstDecisionTurn = turnContextOf(f, second.post.body)
  snapNow('8 ordinary message, mode on', { activity: firstDecisionTurn.activity && { title: firstDecisionTurn.activity.title, detail: firstDecisionTurn.activity.detail } })
  assert.deepEqual(countBy(f.providerLog, 'kind'), { key_check: 1, turn_context: 1 })
  assert.ok(f.providerLog.every(r => r.authOk && r.endpoint))
  assert.equal(f.counts.modeOn.decisionContext, 1)
  assert.equal(f.counts.modeOn.subscription, 1, 'the subscription turn proceeds')
  assert.equal(f.startTurns.at(-1).params.threadId, seeded.conversationId)
  assert.ok(firstDecisionTurn.activity, 'the run records a Decisions context activity')
  await m.finishTurn(second.post.body)

  // 7. Bridge restart: key and mode come back from disk; nothing is re-entered.
  f.phase = 'restart'
  f.restartBridge(); m.resumed.clear()
  assert.deepEqual([f.bridgeState().configured, f.bridgeState().mode, f.bridgeState().boots], [true, 'on', 2])
  const status = await f.request('GET', '/decision/status')
  secretFree(status.body, [KEY], 'status after restart')
  snapNow('9 bridge restarted', { status: { configured: status.body.configured, mode: status.body.mode, keyHint: status.body.keyHint } })

  // 8. Another ordinary message in the same DM uses Decisions again, with the saved key and no new key check.
  const third = await m.sendOrdinary('afterRestart', '다음 회의는 언제 열까요? 안내 위치도 같이 정해 주세요.')
  assert.ok(third.enabled && third.outcome.result.accepted === true, JSON.stringify(third.post?.body))
  assert.equal(third.post.body.conversationId, seeded.conversationId)
  const secondDecisionTurn = turnContextOf(f, third.post.body)
  snapNow('10 ordinary message after restart', { activity: secondDecisionTurn.activity && { title: secondDecisionTurn.activity.title } })
  assert.deepEqual(countBy(f.providerLog, 'kind'), { key_check: 1, turn_context: 2 })
  assert.deepEqual(f.providerLog.map(r => r.boot), [1, 1, 2])
  assert.ok(f.providerLog.every(r => r.authOk))
  assert.equal(f.counts.afterRestart.subscription, 1)
  assert.deepEqual(f.unexpected, [])
  secretFree([trace, f.requests], [KEY], 'whole visible trace and request log')
  t.diagnostic('TRACE ' + JSON.stringify(trace))
  t.diagnostic('STUCK ' + JSON.stringify(stuck))
  assert.ok(firstRender)
})

test('L1c5 variant: mode on but nothing to select (no candidates) -> no Decisions request, turn still proceeds', async t => {
  const { f, m } = await restoredDm(t, { candidates: false })
  const card = m.openSettings()
  await eventually(() => card.section.props.data.state === 'empty', 'status')
  await pasteAndSave(card, f.JOURNEY_KEY)
  click(modeButton(card, 'on'))
  await eventually(() => card.decision.status?.mode === 'on' && !card.decision.busy, 'mode')
  const sent = await m.sendOrdinary('modeOn', '회의 안내는 어디에 둘까요?')
  assert.equal(sent.post.status, 202)
  t.diagnostic('NOCANDIDATES ' + JSON.stringify({ provider: countBy(f.providerLog, 'kind'), subscription: f.counts.modeOn.subscription, activity: !!turnContextOf(f, sent.post.body).activity }))
  assert.deepEqual(countBy(f.providerLog, 'kind'), { key_check: 1 }, 'with no candidates the turn-start request is skipped')
  assert.equal(f.counts.modeOn.subscription, 1)
})

test('L1c5 variant: wrong key is rejected, nothing saved, field cleared', async t => {
  const { f, m } = await restoredDm(t)
  const card = m.openSettings()
  await eventually(() => card.section.props.data.state === 'empty', 'status')
  f.providerState.verify = 'invalid'
  await pasteAndSave(card, f.JOURNEY_KEY)
  assert.match(resultOf(card), /키가 올바르지 않습니다 · 키를 저장하지 않았습니다/)
  assert.equal(f.bridgeState().configured, false)
  assert.equal(keyInputOf(card).value, '')
})

test('L1c5 variant: key saved without credit, mode on, provider 429 at turn start -> the ordinary turn still proceeds', async t => {
  const { f, m } = await restoredDm(t)
  const card = m.openSettings()
  await eventually(() => card.section.props.data.state === 'empty', 'status')
  f.providerState.verify = 'no_credit'
  await pasteAndSave(card, f.JOURNEY_KEY)
  assert.match(resultOf(card), /^크레딧 없음 · 키는 저장했습니다\. 크레딧이 생기면 바로 쓸 수 있습니다\. 모드가 ‘끔’이라/)
  click(modeButton(card, 'on'))
  await eventually(() => card.decision.status?.mode === 'on' && !card.decision.busy, 'mode')
  f.providerState.context = '429'
  const sent = await m.sendOrdinary('modeOn', '회의 안내는 상단 알림과 일정 공지 중 어디에 둘까요?')
  const turn = turnContextOf(f, sent.post.body)
  t.diagnostic('NOCREDIT ' + JSON.stringify({ activity: turn.activity && { title: turn.activity.title, detail: turn.activity.detail }, subscription: f.counts.modeOn.subscription }))
  assert.equal(sent.post.status, 202)
  assert.equal(f.counts.modeOn.subscription, 1, 'a failed Decisions request never blocks the subscription turn')
  assert.equal(f.startTurns.at(-1).params.additionalContext?.egdesk_decision_context, undefined)
  assert.ok(turn.activity, 'the run shows that the Decisions request got no answer')
})
