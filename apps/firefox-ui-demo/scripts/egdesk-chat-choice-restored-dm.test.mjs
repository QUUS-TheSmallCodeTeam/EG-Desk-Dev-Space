import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
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
    section('      async sendMessage(options', '    };\n  }\n\n  function toggleHUD'),
  ].join('\n') : scope
  return runInNewContext(deps + pieces.join('\n') + '\ncodexProfileCatalog = catalog;\n({' + bridge + '})' +
    (sendHarness ? '' : '.chatChoiceScope'), {
    state, protocol, ChatState, catalog: { status: 'ready', profiles }, chatRoomProjectDefaults,
    chatProjectDraftActions: new Map(), choiceSettingsWriting: 0, choiceSettingsGeneration: 0,
    document: { getElementById: () => assert.fail('no canvas entity is selected in the fixture') },
    ...sendHarness,
  }, { filename: 'eg-desk-surface.uc.js (choice scope)' })
}

function element(tag, props = {}, ...children) {
  return {
    tag, props, children, value: '', textContent: '', hidden: false, disabled: false, isConnected: true,
    replaceChildren(...nodes) { this.children = nodes }, focus() {},
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

// ---------------------------------------------------------------------------
// L1: an existing DM restored with a retained native binding.
// Synthetic harness. The restored room is produced by the product's own
// ChatState.detachNativeThread -> reconcileNativeThread pair (the same pair the
// Surface restore path at "const restored = ChatState.reconcileNativeThread(" uses);
// nothing is injected to force a state. The runtime is NOT restarted here: /chat/resume
// is posted to the production handler over the same SQLite store.
// ---------------------------------------------------------------------------
const OTHER_ACCOUNT = { authMethod: 'chatgpt' }
const otherAccountAuth = () => normalizeNativeAuth(OTHER_ACCOUNT, { account: { type: 'chatgpt', id: 'QA_OTHER_ACCOUNT_77C1', planType: 'plus' } })

function restoreRoom(f, seeded, clientThreadId, authForReconcile, { flags = {} } = {}) {
  const stored = f.store.getConversation(clientThreadId)
  const savedAccount = ChatState.codexAccountKey(f.authStatus())
  const base = { id: clientThreadId, type: 'dm', engineId: stored.engineId, profileEnabled: true,
    agentProfileId: stored.agent.profileId, agent: stored.agent, messages: [], participants: ['나'],
    clientBindingId: clientThreadId, conversationId: seeded.conversationId, bindingAccountKey: savedAccount,
    retainedNativeBinding: null, ...flags }
  return ChatState.reconcileNativeThread(ChatState.detachNativeThread(base, null, 'restart-nonce'), authForReconcile)
}

// Same predicate the HUD Send button uses (sendButton.disabled / nativeSendHeld) for the binding part.
const ordinarySendBindingOpen = (room, codex) => !ChatState.nativeBindingHeld(room)
  && !(room.conversationId && !ChatState.canResumeNativeThread(room, codex.authStatus, codex))
  && ChatState.chatThreadReadiness(room, codex).ready

async function restoredFixture(t, { auth = 'same', flags } = {}) {
  const f = createFixture(t, ['restore'])
  await f.refreshCodexAccount()
  const seeded = await f.send(f.direct('qa-dm-restored'), 'seed-restored', PRIVATE.primaryHistory)
  await f.complete(seeded, PRIVATE.code)
  const env = createRoomProjection(f)
  const { codex } = env
  const signedOut = { ...f.authStatus(), isLoggedIn: false, accountId: null, accountEmail: null, identityStatus: 'unknown' }
  codex.authStatus = signedOut; codex.codexAccountKey = null
  const room = restoreRoom(f, seeded, 'qa-dm-restored', signedOut, { flags })
  codex.threads.push(room)
  env.projectDefaults.set(room.id, { binding: ChatState.clientThreadBinding(room), scope: { current: () => true }, status: 'ready', value: { status: 'none' } })
  const relogin = (status) => {
    codex.authStatus = status; codex.codexAccountKey = ChatState.codexAccountKey(status)
    codex.threads = codex.threads.map(row => ChatState.reconcileNativeThread(row, status))
    // Verified no-project read is a fixture keyed to the live binding (the reconcile re-attaches the original pair).
    env.projectDefaults.set(codex.threads[0].id, { binding: ChatState.clientThreadBinding(codex.threads[0]), scope: { current: () => true },
      status: 'ready', value: { status: 'none' } })
    return codex.threads[0]
  }
  return { f, seeded, env, codex, room, relogin, signedOut }
}

function mountChooser(f, env, roomId, input, journey) {
  const choiceResponses = [], requestIds = []
  let draft = ''
  const { mountChatChoiceComposer, readChatChoiceMode, postChatChoice } = loadComposer(async (path, { method, signal, body }) => {
    if (path === '/decision/status') return decisionStatus()
    const response = await f.post(path, JSON.parse(body))
    choiceResponses.push(response)
    return response.body
  })
  const ui = mountChatChoiceComposer({ el: element, makeController: () => new AbortController(),
    makeRequestId: () => { const id = `choice-${Date.now()}-${randomUUID()}`; requestIds.push(id); return id },
    readMode: readChatChoiceMode, postChoice: postChatChoice })
  ui.attach({ input, readScope: () => env.realScope(env.codex.activeThreadId, input.value),
    setDraft: text => { env.codex.threadDrafts[roomId] = text; draft = text } })
  return { ui, choiceResponses, requestIds, draft: () => draft }
}

test('L1 journey: restored existing DM (retainedNativeBinding) -> verified owner + resume -> [보기 추천] -> [이유 묻기] -> ordinary [보내기]', async t => {
  const { f, seeded, env, codex, room: held, relogin, signedOut } = await restoredFixture(t)
  const journey = []
  const note = (step, o) => journey.push({ step, ...o })
  const question = '회의 안내를 어디에 둘까요?'
  const input = element('textarea')
  codex.activeThreadId = held.id
  codex.threadDrafts[held.id] = question; codex.threadDraftRevisions[held.id] = 1; input.value = question
  const chooser = mountChooser(f, env, held.id, input)
  const { ui } = chooser
  ui.sync()

  // Step 1: signed-out restore. Owner unverified: everything must stay hidden.
  note('1 restored, owner unverified', { held: ChatState.nativeBindingHeld(held), bindingState: held.bindingState,
    reason: held.retainedNativeBinding?.reason, scope: !!env.realScope(held.id, question), trigger_hidden: ui.trigger.hidden,
    ordinarySend: ordinarySendBindingOpen(held, codex), holdText: ChatState.nativeBindingHoldText(held) })
  assert.equal(ChatState.nativeBindingHeld(held), true)
  assert.equal(env.realScope(held.id, question), null)
  assert.equal(ui.trigger.hidden, true)
  assert.equal(ordinarySendBindingOpen(held, codex), false)

  // Step 2: same account signs in. Product reconcile verifies the retained pair.
  f.phase = 'restore'
  const room = relogin(f.authStatus())
  note('2 same account re-auth (reconcile)', { held: ChatState.nativeBindingHeld(room), bindingState: room.bindingState,
    retainedStillPresent: !!room.retainedNativeBinding, conversationId: !!room.conversationId,
    canResume: ChatState.canResumeNativeThread(room, codex.authStatus, codex), ordinarySend: ordinarySendBindingOpen(room, codex) })
  assert.equal(room.bindingState, 'verified')
  assert.equal(ordinarySendBindingOpen(room, codex), true, 'the ordinary send gate is open for this room')

  // Step 3: /chat/resume by the production handler.
  const resume = await f.post('/chat/resume', { conversationId: room.conversationId, clientThreadId: ChatState.clientThreadBinding(room), engineId: 'codex' })
  note('3 /chat/resume', { status: resume.status, conversationId: resume.body.conversationId === room.conversationId })
  assert.equal(resume.status, 200, JSON.stringify(resume.body))

  // Step 4: recommendation must be discoverable now.
  ui.sync()
  const scope = env.realScope(room.id, question)
  note('4 [보기 추천] gate after verified+resumed', { scope: !!scope, trigger_hidden: ui.trigger.hidden })
  assert.ok(scope, 'chatChoiceScope admits the restored, verified, resumed DM')
  assert.equal(ui.trigger.hidden, false)
  click(ui.trigger)
  const fields = findAll(ui.panel, 'option')
  const options = ['상단 알림', '일정 공지']
  fields.forEach((field, i) => { field.value = options[i]; field.props.oninput() })
  const button = id => findAll(ui.panel, id)[0]
  f.phase = 'choice1'
  click(button('review'))
  click(await eventually(() => button('confirm'), 'confirm never shown'))
  const response = await eventually(() => chooser.choiceResponses[0], 'no /chat/choice response')
  assert.deepEqual(response.body, { status: 'recommended', index: 1 })
  const result = await eventually(() => button('result'), 'recommendation not rendered')
  assert.equal(result.textContent, 'EG-Desk 추천: 일정 공지 · 실행하지 않음')
  assert.deepEqual(f.counts.choice1, { decisionChoice: 1, decisionContext: 0, subscription: 0, contextCollection: 0 })
  assert.deepEqual(f.httpPosts.at(-1).body.clientThreadId, ChatState.clientThreadBinding(room))
  note('5 recommendation shown (mock Decisions)', { text: result.textContent, subscriptionTurnsForChoice: f.counts.choice1.subscription })

  // Step 6: [이유 묻기] produces an editable draft only; no subscription turn.
  f.phase = 'draft'
  click(button('explain'))
  const draft = await eventually(() => chooser.draft(), '이유 묻기 produced no draft')
  assert.match(draft, /EG-Desk 추천: 2\. 일정 공지/)
  assert.deepEqual(f.counts.draft, noWork())
  note('6 [이유 묻기] draft', { subscriptionTurns: f.counts.draft.subscription })

  // Step 7: ordinary send (same gates as any send) uses the original subscription conversation.
  f.phase = 'explanation'
  const accepted = await f.send({ ...f.direct('qa-dm-restored'), conversationId: seeded.conversationId }, 'send-restored-explain', draft)
  assert.equal(accepted.conversationId, seeded.conversationId)
  assert.equal(f.counts.explanation.subscription, 1)
  assert.equal(f.startTurns.at(-1).params.threadId, seeded.conversationId)
  note('7 ordinary [보내기]', { conversationId: 'same as seeded DM', subscriptionTurns: f.counts.explanation.subscription })
  assert.deepEqual(f.unexpected, [])
  t.diagnostic('JOURNEY ' + JSON.stringify(journey))
  ui.dispose()
})

test('L1 negative: owner not yet verified / different account / stateless-class threads / mismatched retained pair stay hidden', async t => {
  const q = '회의 안내를 어디에 둘까요?'
  const prep = (env, room) => { env.codex.activeThreadId = room.id; env.codex.threadDrafts[room.id] = q; env.codex.threadDraftRevisions[room.id] = 1 }
  // (a) owner not verified: still signed out
  {
    const x = await restoredFixture(t); prep(x.env, x.room)
    assert.equal(x.env.realScope(x.room.id, q), null, 'a: signed out')
  }
  // (b) different account: reconcile quarantines, identity-mismatch
  {
    const x = await restoredFixture(t)
    const room = x.relogin(otherAccountAuth()); prep(x.env, room)
    assert.equal(room.retainedNativeBinding.reason, 'identity-mismatch')
    assert.equal(ChatState.nativeBindingHeld(room), true)
    assert.equal(x.env.realScope(room.id, q), null, 'b: different account')
  }
  // (c) stateless / startStateless / executionBounded, even if otherwise verified
  for (const flag of ['stateless', 'startStateless', 'executionBounded']) {
    const x = await restoredFixture(t, { flags: { [flag]: true } })
    const room = x.relogin(x.f.authStatus()); prep(x.env, room)
    assert.equal(room.bindingState, 'verified')
    assert.equal(x.env.realScope(room.id, q), null, 'c: ' + flag)
  }
  // (d) verified, but retained pair does not describe this very binding (corrupt/rotated state)
  for (const mutate of [
    r => ({ ...r, retainedNativeBinding: { ...r.retainedNativeBinding, conversationId: 'some-other-conversation' } }),
    r => ({ ...r, retainedNativeBinding: { ...r.retainedNativeBinding, clientThreadId: 'some-other-binding' } }),
    r => ({ ...r, retainedNativeBinding: { ...r.retainedNativeBinding, accountKey: 'codex:chatgpt:QA_OTHER_ACCOUNT_77C1' } }),
  ]) {
    const x = await restoredFixture(t)
    const room = x.relogin(x.f.authStatus())
    x.codex.threads = [mutate(room)]; prep(x.env, x.codex.threads[0])
    assert.equal(x.env.realScope(room.id, q), null, 'd: inconsistent retained pair')
  }
  // (e) control: verified restored room with intact pair is admitted
  {
    const x = await restoredFixture(t)
    const room = x.relogin(x.f.authStatus()); prep(x.env, room)
    assert.ok(x.env.realScope(room.id, q), 'e: control')
    // (f) ordinary send not ready (bridge disconnected) -> hidden
    x.codex.connected = false
    assert.equal(x.env.realScope(room.id, q), null, 'f: disconnected')
    x.codex.connected = true
    // (g) busy thread
    x.codex.threads = [{ ...x.codex.threads[0], resuming: true }]
    const busy = x.env.realScope(room.id, q)
    t.diagnostic('g resuming-thread scope: ' + (busy ? 'admitted' : 'null'))
  }
})

test('L1 sim 2: restored DM, recommendation in flight, then the account link is lost again -> late reply is not shown, nothing sent', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = createFixture(t, ['restore'], decisionStatus, { holdChoiceResponse: () => gate })
  await f.refreshCodexAccount()
  const seeded = await f.send(f.direct('qa-dm-restored'), 'seed-restored', PRIVATE.primaryHistory)
  await f.complete(seeded, PRIVATE.code)
  const env = createRoomProjection(f), { codex } = env
  const signedOut = { ...f.authStatus(), isLoggedIn: false, accountId: null, accountEmail: null, identityStatus: 'unknown' }
  codex.authStatus = signedOut; codex.codexAccountKey = null
  codex.threads.push(restoreRoom(f, seeded, 'qa-dm-restored', signedOut))
  const setLive = status => {
    codex.authStatus = status; codex.codexAccountKey = ChatState.codexAccountKey(status)
    codex.threads = codex.threads.map(row => ChatState.reconcileNativeThread(row, status))
    env.projectDefaults.set(codex.threads[0].id, { binding: ChatState.clientThreadBinding(codex.threads[0]), scope: { current: () => true }, status: 'ready', value: { status: 'none' } })
  }
  setLive(f.authStatus())
  const room = codex.threads[0], question = '회의 안내를 어디에 둘까요?'
  codex.activeThreadId = room.id; codex.threadDrafts[room.id] = question; codex.threadDraftRevisions[room.id] = 1
  const input = element('textarea'); input.value = question
  const chooser = mountChooser(f, env, room.id, input), { ui } = chooser
  ui.sync()
  assert.equal(ui.trigger.hidden, false)
  click(ui.trigger)
  findAll(ui.panel, 'option').forEach((field, i) => { field.value = ['상단 알림', '일정 공지'][i]; field.props.oninput() })
  f.phase = 'choice1'
  click(findAll(ui.panel, 'review')[0])
  click(await eventually(() => findAll(ui.panel, 'confirm')[0], 'confirm never shown'))
  await eventually(() => f.httpPosts.some(p => p.path === '/chat/choice'), 'choice request not posted')
  // Restart-style re-detach while the request is pending: the account link is lost again.
  codex.authStatus = signedOut; codex.codexAccountKey = null
  codex.threads = [ChatState.reconcileNativeThread(ChatState.detachNativeThread(codex.threads[0], null, 'second-restart'), signedOut)]
  ui.sync()
  release()
  await eventually(() => chooser.choiceResponses[0], 'late response never arrived')
  await pause(30)
  const shown = findAll(ui.panel, 'result')[0]
  t.diagnostic('late result element after link loss: ' + (shown ? 'SHOWN ' + shown.textContent : 'absent') + '; trigger.hidden=' + ui.trigger.hidden)
  assert.equal(shown, undefined, 'late recommendation must not render once the room is held again')
  assert.equal(ui.trigger.hidden, true)
  assert.equal(f.counts.choice1.subscription, 0)
  assert.equal(f.startTurns.length, 1, 'only the seed turn; the recommendation never started a subscription turn')
  ui.dispose()
})
