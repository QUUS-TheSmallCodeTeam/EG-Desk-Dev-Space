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

test('v3 built-in Codex Agent DM (real UI scope): recommendation → draft and explicit subscription send → new recommendation in one execution', async t => {
  const f = createFixture(t)
  await f.refreshCodexAccount()
  const primary = await f.send(f.direct('qa-dm-primary'), 'seed-primary', PRIVATE.primaryHistory)
  await f.complete(primary, [PRIVATE.code, PRIVATE.evidence, PRIVATE.file, PRIVATE.memory].join(' '))
  const other = await f.send(f.direct('qa-dm-other', f.custom), 'seed-other', PRIVATE.otherHistory)
  await f.complete(other, 'Fixture-only preparation reply in the other DM')
  assert.notEqual(primary.conversationId, other.conversationId)
  assert.deepEqual(f.counts.seed, { decisionChoice: 0, decisionContext: 0, subscription: 2, contextCollection: 2 })
  const scope = { ...f.direct('qa-dm-primary'), conversationId: primary.conversationId }
  const { codex, projectRoom, realScope } = createRoomProjection(f)
  const primaryRoom = projectRoom(primary, scope.clientThreadId, f.agent)
  const customRoom = projectRoom(other, 'qa-dm-other', f.custom)
  const questions = [
    { question: '회의 안내를 어디에 둘까요?', options: ['상단 알림', '일정 공지'], index: 1 },
    { question: '다음 회의는 언제 열까요?', options: ['오전', '오후'], index: 0 },
  ]
  const input = element('textarea')
  let draft = '', draftWrites = 0
  const requestIds = [], localStatusReads = []
  const choiceResponses = []
  const { mountChatChoiceComposer, readChatChoiceMode, postChatChoice } = loadComposer(async (path, { method, signal, body }) => {
    assert.ok(signal instanceof AbortSignal && !signal.aborted)
    if (path === '/decision/status') {
      assert.equal(method, 'GET')
      assert.equal(body, undefined, 'status is local and contains no question/options')
      localStatusReads.push(f.phase)
      return decisionStatus()
    }
    assert.equal(method, 'POST')
    const response = await f.post(path, JSON.parse(body))
    choiceResponses.push(response)
    return response.body
  })
  const ui = mountChatChoiceComposer({ el: element, makeController: () => new AbortController(),
    makeRequestId: () => {
      const id = `choice-${Date.now()}-${randomUUID()}`
      requestIds.push(id)
      return id
    },
    readMode: readChatChoiceMode,
    postChoice: postChatChoice,
  })
  t.after(() => ui.dispose())
  const readScope = () => realScope(codex.activeThreadId, input.value)
  ui.attach({ input, readScope, setDraft: text => {
    codex.threadDrafts[primaryRoom.id] = text
    draftWrites++; draft = text
  } })
  const enterQuestion = (room, question) => {
    codex.activeThreadId = room.id
    codex.threadDrafts[room.id] = question
    codex.threadDraftRevisions[room.id] = (codex.threadDraftRevisions[room.id] || 0) + 1
    input.value = question
    ui.sync()
  }
  enterQuestion(customRoom, questions[0].question)
  assert.equal(ChatState.chatThreadReadiness(customRoom, codex).ready, true)
  assert.equal(readScope(), null, 'a runnable custom Agent in a verified DM is not an eligible template')
  assert.equal(ui.trigger.hidden, true, 'the real controller hides its trigger for the custom Agent')
  const button = id => findAll(ui.panel, id)[0]
  const assertPrivateAbsent = value => {
    const wire = JSON.stringify(value)
    for (const token of Object.values(PRIVATE)) assert.ok(!wire.includes(token), 'not sent: ' + token)
    assert.ok(!wire.includes(other.conversationId) && !wire.includes('qa-dm-other'), 'no cross-DM data or routing')
  }
  async function choose(index) {
    const spec = questions[index]
    f.phase = 'choice' + (index + 1)
    enterQuestion(primaryRoom, spec.question)
    const eligible = readScope()
    assert.ok(eligible, 'the actual Surface gate admits the completed built-in Agent DM')
    assert.deepEqual([eligible.clientThreadId, eligible.conversationId, eligible.profileId, eligible.question],
      [scope.clientThreadId, scope.conversationId, scope.profileId, spec.question])
    assert.equal(ui.trigger.hidden, false)
    click(ui.trigger)
    const edit = findAll(ui.panel, 'option')
    assert.equal(edit.length, spec.options.length)
    edit.forEach((field, i) => { field.value = spec.options[i]; field.props.oninput() })
    click(button('review'))
    const confirm = await eventually(() => button('confirm'), 'preview never became confirmable')
    assert.deepEqual(f.counts[f.phase], { decisionChoice: 0, decisionContext: 0, subscription: 0, contextCollection: 0 })
    click(confirm)
    const response = await eventually(() => choiceResponses[index], 'no /chat/choice response')
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(response.body, { status: 'recommended', index: spec.index }, 'response recommends, without run/action authority')
    assertPrivateAbsent(response.body)
    const rendered = await eventually(() => button('result'), 'product UI did not render recommendation')
    assert.equal(rendered.textContent, 'EG-Desk 추천: ' + spec.options[spec.index] + ' · 실행하지 않음')
    assert.equal(input.value, spec.question, 'recommendation does not mutate or send the regular composer')
    const requestId = requestIds[index]
    assert.match(requestId, /^choice-[0-9]+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    assert.deepEqual(f.httpPosts.at(-1), { phase: f.phase, path: '/chat/choice', body: {
      clientThreadId: scope.clientThreadId, conversationId: scope.conversationId, profileId: scope.profileId,
      requestId, question: spec.question, options: spec.options, confirm: true, reviewRevision: REVIEW_REVISION,
    } })
    const sent = f.decisionRequests[index]
    assert.equal(sent.url, DECISIONS_ENDPOINT)
    assert.equal(sent.method, 'POST')
    assertPrivateAbsent(sent.body)
    assert.ok(!JSON.stringify(sent.body).includes(REVIEW_REVISION), 'reviewRevision remains local')
    const { questions: wireQuestions, ...wireMetadata } = sent.body
    assert.deepEqual(wireMetadata, { model: DECISION_MODEL, input: [{ role: 'user', content: [{ type: 'input_json', data: {
      question: spec.question, options: { c1: spec.options[0], c2: spec.options[1] },
    } }] }] }, 'only the approved question and options reach Decision, with no room/account identifiers')
    assert.equal(wireQuestions.length, 1)
    assert.equal(wireQuestions[0].type, 'choice')
    assert.deepEqual(wireQuestions[0].choices.map(({ value }) => value), ['c1', 'c2', 'abstain'])
    assert.deepEqual(f.counts[f.phase], { decisionChoice: 1, decisionContext: 0, subscription: 0, contextCollection: 0 })
  }
  await choose(0)
  assert.equal(draftWrites, 0)
  f.phase = 'draft'
  const explain = button('explain')
  assert.deepEqual(explain.children, ['이유 묻기'])
  click(explain)
  await eventually(() => draft, '이유 묻기 did not generate an editable draft')
  assert.equal(draftWrites, 1)
  assert.equal(input.value, draft)
  assertPrivateAbsent(draft)
  assert.deepEqual(draft.split('\n').slice(2), [
    '질문: ' + questions[0].question, '1. ' + questions[0].options[0], '2. ' + questions[0].options[1],
    'EG-Desk 추천: 2. ' + questions[0].options[1],
  ])
  assert.match(draft, /내부 판단 근거는 알 수 없으니/)
  assert.deepEqual(f.counts.draft, { decisionChoice: 0, decisionContext: 0, subscription: 0, contextCollection: 0 })
  assert.deepEqual(f.httpPosts.map(({ path }) => path), ['/chat/send', '/chat/send', '/chat/choice'])

  // Explicit user Send boundary. The actual HUD draft/controller is above;
  // here we model the separate user's Send action by posting its normal DTO.
  f.phase = 'explanation'
  const accepted = await f.send(scope, 'send-explanation', input.value)
  assert.equal(accepted.conversationId, primary.conversationId)
  assert.notEqual(accepted.runId, primary.runId)
  const { phase, params } = f.startTurns.at(-1)
  assert.equal(phase, 'explanation')
  assert.equal(params.threadId, primary.conversationId)
  assert.equal(params.clientUserMessageId, 'send-explanation')
  assert.deepEqual(params.input, [{ type: 'text', text: draft, text_elements: [] }])
  assertPrivateAbsent(params)
  assert.ok(!JSON.stringify(params).includes(REVIEW_REVISION), 'reviewRevision does not reach Codex')
  assert.equal(params.additionalContext?.egdesk_decision_context, undefined)
  assert.deepEqual(f.counts.explanation, { decisionChoice: 0, decisionContext: 0, subscription: 1, contextCollection: 1 })
  await f.complete(accepted, PRIVATE.subscriptionReply) // local mock response, not actual model output
  assert.equal(projectRoom(accepted, scope.clientThreadId, f.agent), primaryRoom, 'same room reprojects the real explanation run before opening the second choice')

  await choose(1)
  assert.deepEqual(f.startTurns.map(({ phase, params }) => [phase, params.threadId]), [
    ['seed', primary.conversationId], ['seed', other.conversationId], ['explanation', primary.conversationId],
  ])
  assert.deepEqual(f.decisionRequests.map(({ phase }) => phase), ['choice1', 'choice2'])
  assert.deepEqual(f.httpPosts.map(({ phase, path }) => [phase, path]), [
    ['seed', '/chat/send'], ['seed', '/chat/send'], ['choice1', '/chat/choice'], ['explanation', '/chat/send'], ['choice2', '/chat/choice'],
  ])
  assert.equal(f.threads.size, 2, 'neither recommendation opens a native thread')
  assert.equal(f.store.getLatestRun(scope.clientThreadId).runId, accepted.runId, 'the explicit send is the latest durable primary turn')
  assert.equal(f.store.getLatestRun('qa-dm-other').runId, other.runId, 'the other DM remains unchanged')
  assert.deepEqual([...new Set(f.nativeCalls.map(({ phase }) => phase))], ['seed', 'explanation'], 'choice and draft do not touch subscription RPCs')
  assert.equal(new Set(requestIds).size, 2)
  assert.deepEqual(localStatusReads, ['choice1', 'choice1', 'choice1', 'draft', 'choice2', 'choice2', 'choice2'],
    'local GET /decision/status requests are accounted separately, not as provider calls')
  assert.deepEqual(f.unexpected, [])
  t.diagnostic(JSON.stringify({ ...f.counts, localStatusReads: localStatusReads.length }))
  t.diagnostic('Scope/controller, profile records, ChatState and runtime routes are real. DOM, chrome state, account and provider transport/replies are fixtures.')
})

async function verifyRecoveredChoice(t, { throughAdvisory = false, throughSend = false, editReason = false } = {}) {
  let status = decisionStatus()
  const f = createFixture(t, ['recovery', 'reasonDraft', 'reasonEdit', 'reasonSend', 'nextChoice'], () => status,
    throughSend ? { resolveProjectWorkspace: async () => null } : undefined)
  await f.refreshCodexAccount()
  const primaryId = 'qa-dm-recovery', otherId = 'qa-dm-recovery-other'
  const primary = await f.send(f.direct(primaryId), 'seed-recovery-primary', PRIVATE.primaryHistory)
  await f.complete(primary, 'Completed preparation reply in the target DM')
  const other = await f.send(f.direct(otherId), 'seed-recovery-other', PRIVATE.otherHistory)
  await f.complete(other, 'Completed preparation reply in the other DM')
  assert.notEqual(primary.conversationId, other.conversationId)
  assert.deepEqual(f.counts.seed, { ...noWork(), subscription: 2, contextCollection: 2 })
  assert.deepEqual(f.httpPosts.map(({ phase, path }) => [phase, path]), [['seed', '/chat/send'], ['seed', '/chat/send']])
  const seedNativeCalls = f.nativeCalls.length
  const seedTurns = f.startTurns.length
  assert.equal(seedTurns, 2)

  const projection = createRoomProjection(f)
  const { codex, projectRoom, realScope } = projection
  const room = projectRoom(primary, primaryId, f.agent)
  // Use the same default Agent in the other DM: isolation cannot be inferred
  // from the custom-Agent eligibility gate exercised by the positive test.
  const otherRoom = projectRoom(other, otherId, f.agent)
  const question = '회의 안내를 어디에 둘까요?'
  const initialOptions = throughAdvisory ? ['  상단 알림 ', ' 일정 공지  '] : ['상단 알림', '일정 공지']
  const revisedOptions = ['팀 공지 고정', initialOptions[1].trim()]
  codex.activeThreadId = room.id
  codex.threadDrafts[room.id] = question
  codex.threadDraftRevisions[room.id] = 1
  const input = element('textarea')
  input.value = question
  const readScope = () => realScope(codex.activeThreadId, input.value)
  const scope = readScope()
  assert.ok(scope, 'the actual Surface gate admits the completed owned default-Agent DM')
  assert.deepEqual([scope.clientThreadId, scope.conversationId, scope.profileId, scope.question],
    [primaryId, primary.conversationId, f.agent.id, question])

  const stateAfterSeed = () => structuredClone({
    threads: codex.threads, otherRoom, drafts: codex.threadDrafts, draftRevisions: codex.threadDraftRevisions,
    conversations: f.store.listConversations(),
    rooms: [primary, other].map((accepted, index) => {
      const id = [primaryId, otherId][index]
      return { runtime: f.snapshot(accepted.conversationId), messages: f.store.listMessages(id),
        runs: f.store.listRuns(id), events: f.store.listEvents(id) }
    }),
    nativeThreads: f.threads,
  })
  const before = stateAfterSeed()
  f.phase = 'recovery'
  const localStatusReads = [], choiceResponses = [], requestIds = [], statusSignals = [], settingsOpens = []
  const browserBoundary = []
  let stage = 'first review'
  const { mountChatChoiceComposer, readChatChoiceMode, postChatChoice } = loadComposer(async (path, { method, signal, body }) => {
    assert.ok(signal instanceof AbortSignal && !signal.aborted)
    if (path === '/decision/status') {
      assert.equal(method, 'GET')
      assert.equal(body, undefined, 'local status reads carry no question or options')
      const first = localStatusReads.length === 0
      localStatusReads.push({ stage, path, method, outcome: first ? 'transport rejection' : 'fixture response' })
      // Sole fault at the UI fetchJson/loopback boundary, before route dispatch.
      // This is a rejected GET, not HTTP error JSON, a provider fault or a real socket.
      statusSignals.push(signal)
      browserBoundary.push([stage, method, path, first ? 'transport rejection' : status.mode, first ? null : status.boardRevision])
      if (first) throw new TypeError('synthetic fixture: local status transport unavailable')
      const { mode, configured, boardRevision } = status
      return { mode, configured, boardRevision }
    }
    assert.equal(path, '/chat/choice')
    assert.equal(method, 'POST')
    browserBoundary.push([stage, method, path, status.mode, status.boardRevision])
    const response = await f.post(path, JSON.parse(body))
    choiceResponses.push(response)
    return response.body
  })
  const ui = mountChatChoiceComposer({ el: element, makeController: () => new AbortController(),
    makeRequestId: () => {
      const id = `choice-${Date.now()}-${randomUUID()}`
      requestIds.push(id)
      return id
    },
    readMode: readChatChoiceMode, postChoice: postChatChoice,
    ...(throughAdvisory ? { openSettings: reason => settingsOpens.push(reason) } : {}) })
  t.after(() => ui.dispose())
  let draftWrites = 0
  const send = throughSend ? mountFixtureHudSend(f, projection, room, ui, input, editReason) : null
  ui.attach({ input, readScope, setDraft: text => { draftWrites++; send?.bridge.setDraft(text, room.id) } })
  ui.sync()
  const button = id => findAll(ui.panel, id)[0]
  const fields = () => findAll(ui.panel, 'option')
  const setOption = (field, value) => { field.value = value; field.props.oninput() }
  const statusReads = (...steps) => steps.map((step, i) => ({ stage: step, path: '/decision/status', method: 'GET',
    outcome: i === 0 ? 'transport rejection' : 'fixture response' }))
  const chooserPosts = () => f.httpPosts.filter(({ phase }) => phase === 'recovery')
  const assertNoSend = () => {
    assert.deepEqual(f.counts.recovery, noWork())
    assert.deepEqual([chooserPosts().length, f.decisionRequests.length, requestIds.length], [0, 0, 0])
    assert.equal(f.nativeCalls.length, seedNativeCalls)
    assert.equal(input.value, question)
    assert.equal(draftWrites, 0)
  }

  assert.deepEqual(ui.trigger.children, ['보기 추천'])
  click(ui.trigger)
  assert.equal(fields().length, 2)
  fields().forEach((field, i) => setOption(field, initialOptions[i]))
  click(button('review'))
  const close = await eventually(() => {
    const node = button('cancel')
    return node?.children[0] === '닫기' && node
  }, 'first failed local GET did not show the no-send close control')
  assert.match(ui.panel.children.find(node => node.props.role === 'status')?.textContent,
    /질문과 보기를 보내지 않았습니다/)
  assert.equal(button('confirm'), undefined)
  // Give pending callbacks a turn before checking that no automatic work started.
  await pause(20)
  assert.deepEqual(localStatusReads, statusReads('first review'))
  assertNoSend()

  stage = 'close/reopen without review'
  const advisoryRevision = 'b'.repeat(64), restoredRevision = 'c'.repeat(64)
  if (throughAdvisory) status = { mode: 'advisory', configured: true, boardRevision: advisoryRevision, generation: 2 }
  click(close)
  assert.equal(statusSignals[0].aborted, true, 'closing invalidates the failed review controller')
  assert.equal(ui.panel.hidden, true)
  assert.equal(ui.trigger.hidden, false)
  click(ui.trigger)
  await pause(20)
  assert.deepEqual(localStatusReads, statusReads('first review'), 'no automatic status retry after close/reopen')
  assertNoSend()
  assert.deepEqual(fields().map(({ value }) => value), initialOptions,
    'both user-entered options must survive [닫기] and reopening [보기 추천]')
  const reviewStages = ['first review']
  if (throughAdvisory) {
    assert.equal(button('confirm'), undefined, 'reopening restores raw edits, not the confirm control')
    assert.equal(button('result'), undefined)
    stage = 'advisory review'
    click(button('review'))
    const settings = await eventually(() => button('settings'), 'configured advisory must show settings guidance')
    assert.deepEqual(settings.children, ['계정 설정 열기'])
    assert.match(ui.panel.children.find(node => node.props.role === 'status')?.textContent,
      /‘기록만’ 모드입니다.*질문과 보기를 다시 검토해 주세요/)
    assert.equal(button('confirm'), undefined)
    assert.equal(button('result'), undefined)
    assert.notEqual(statusSignals[1], statusSignals[0])
    reviewStages.push(stage)
    await pause(20)
    assert.deepEqual(localStatusReads, statusReads(...reviewStages))
    assertNoSend()
    assert.deepEqual(stateAfterSeed(), before, 'advisory review leaves both histories unchanged')

    // A separate settings surface changes mode and epoch. sync() models the
    // composer being repainted; this does not click either approval control.
    stage = 'on again without review'
    status = { mode: 'on', configured: true, boardRevision: restoredRevision, generation: 3 }
    ui.sync()
    await pause(20)
    assert.equal(button('confirm'), undefined, 'returning to on does not revive any previous review')
    assert.equal(button('result'), undefined)
    assert.deepEqual(localStatusReads, statusReads(...reviewStages))
    assertNoSend()
    const advisoryClose = button('cancel')
    assert.deepEqual(advisoryClose.children, ['닫기'])
    click(advisoryClose)
    assert.equal(statusSignals[1].aborted, true, 'return to edit invalidates the advisory review controller')
    assert.deepEqual(fields().map(({ value }) => value), initialOptions, 'even surrounding whitespace remains in the raw edits')
    assert.equal(button('confirm'), undefined)
    await pause(20)
    assert.deepEqual(localStatusReads, statusReads(...reviewStages))
    assertNoSend()
    assert.deepEqual(settingsOpens, [], 'no settings navigation is triggered on its own')
  }
  setOption(fields()[0], revisedOptions[0])
  assert.deepEqual(fields().map(({ value }) => value), throughAdvisory ? [revisedOptions[0], initialOptions[1]] : revisedOptions)

  stage = throughAdvisory ? 'fresh on review' : 'second review'
  reviewStages.push(stage)
  click(button('review'))
  const confirm = await eventually(() => button('confirm'), 'retry review did not reach the confirm control')
  assert.deepEqual(confirm.children, ['질문과 보기만 보내기'])
  assert.ok(ui.panel.children.some(node => node.textContent === `질문: ${question}`))
  assert.deepEqual(ui.panel.children.find(node => node.tag === 'ol').children.map(({ textContent }) => textContent), revisedOptions,
    'the rendered review must show the edited text, not the first review snapshot')
  assert.deepEqual(localStatusReads, statusReads(...reviewStages))
  if (throughAdvisory) assert.notEqual(statusSignals[2], statusSignals[1], 'on review gets fresh controller')
  assertNoSend()
  assert.deepEqual(stateAfterSeed(), before, 'neither room or history changes before explicit approval')

  stage = 'explicit confirm'
  click(confirm)
  const response = await eventually(() => choiceResponses[0], 'no /chat/choice response after explicit confirmation')
  assert.deepEqual({ status: response.status, body: response.body }, { status: 200, body: { status: 'recommended', index: 0 } })
  const result = await eventually(() => button('result'), 'no recommendation was rendered after explicit confirmation')
  assert.equal(result.textContent, `EG-Desk 추천: ${revisedOptions[0]} · 실행하지 않음`)
  await pause(20)
  assert.deepEqual(localStatusReads, statusReads(...reviewStages, 'explicit confirm', 'explicit confirm'),
    'only first review, manual review, confirmation check and post-response check (no retry)')
  assert.equal(requestIds.length, 1)
  const [requestId] = requestIds
  assert.match(requestId, /^choice-[0-9]+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.deepEqual(chooserPosts(), [{ phase: 'recovery', path: '/chat/choice', body: {
    clientThreadId: primaryId, conversationId: primary.conversationId, profileId: f.agent.id,
    requestId, question, options: revisedOptions, confirm: true, reviewRevision: status.boardRevision,
  } }])
  if (throughAdvisory) assert.deepEqual(browserBoundary, [
    ['first review', 'GET', '/decision/status', 'transport rejection', null],
    ['advisory review', 'GET', '/decision/status', 'advisory', advisoryRevision],
    ['fresh on review', 'GET', '/decision/status', 'on', restoredRevision],
    ['explicit confirm', 'GET', '/decision/status', 'on', restoredRevision],
    ['explicit confirm', 'POST', '/chat/choice', 'on', restoredRevision],
    ['explicit confirm', 'GET', '/decision/status', 'on', restoredRevision],
  ], 'the only chooser POST follows the fresh on review and confirmation recheck')
  assert.equal(choiceResponses.length, 1)
  assert.equal(f.decisionRequests.length, 1)
  const [{ phase, url, method, body }] = f.decisionRequests
  assert.deepEqual([phase, url, method], ['recovery', DECISIONS_ENDPOINT, 'POST'])
  const { questions, ...metadata } = body
  assert.deepEqual(metadata, { model: DECISION_MODEL, input: [{ role: 'user', content: [{ type: 'input_json', data: {
    question, options: { c1: revisedOptions[0], c2: revisedOptions[1] },
  } }] }] }, 'only the approved edited question/options reach the Decision mock')
  assert.equal(questions.length, 1)
  assert.deepEqual(questions[0].choices.map(({ value }) => value), ['c1', 'c2', 'abstain'])
  const wire = JSON.stringify(body)
  for (const forbidden of [...Object.values(PRIVATE), primaryId, otherId, primary.conversationId, other.conversationId,
    REVIEW_REVISION, status.boardRevision, ...(throughAdvisory ? [advisoryRevision] : []), initialOptions[0].trim()]) {
    assert.ok(!wire.includes(forbidden), 'unapproved or local-only data did not reach Decision')
  }
  assert.deepEqual(f.counts.recovery, { ...noWork(), decisionChoice: 1 })
  assert.equal(f.startTurns.length, seedTurns, 'no answer engine turn beyond preparation')
  assert.equal(f.nativeCalls.length, seedNativeCalls, 'no answer engine RPC beyond preparation')
  assert.equal(input.value, question)
  assert.equal(draftWrites, 0)
  assert.deepEqual(stateAfterSeed(), before, 'both rooms, native bindings and persisted messages/runs/events stay unchanged')
  assert.deepEqual(f.unexpected, [])
  t.diagnostic(JSON.stringify({ preparation: { ...f.counts.seed, chatSendHTTP: 2 }, recovery: { ...f.counts.recovery,
    chooserHTTP: chooserPosts().length, localStatusGET: localStatusReads.length, rejectedGET: 1, automaticRetry: 0 } }))
  if (throughSend) await verifyReasonSendAndNextChoice(t, {
    f, primary, other, primaryId, otherId, projection, room, ui, input, send, button, fields, setOption,
    question, initialOptions, revisedOptions, requestIds, choiceResponses, localStatusReads,
    setStage: value => { stage = value }, stateAfterSeed, before, draftWrites: () => draftWrites, editReason,
  })
  if (throughAdvisory) t.diagnostic('Advisory guidance and later on, before fresh review/confirmation: chooser HTTP 0, Decision 0, subscription RPC/turn 0; exact raw whitespace retained, old controllers aborted. Only explicit confirmation uses the restored on epoch.')
  t.diagnostic('The first GET is rejected in the UI/loopback transport fixture; successful GETs use local fixture metadata. Chooser POST executes the real HTTP handler and SQLite-backed runtime. DOM, account and Decision/subscription transports are synthetic.')
}

test('v3 built-in Codex Agent DM: first status GET rejects → close → reopen with both options → edit, review and explicitly confirm', t => verifyRecoveredChoice(t))

test('v3 built-in Codex Agent DM: first status GET rejects → raw options restored → advisory blocks → on needs fresh review and explicit confirm',
  t => verifyRecoveredChoice(t, { throughAdvisory: true }))

test('v3 built-in Codex Agent DM: active room changes after Decision receives explicit approval but before the valid reply', async t => {
  let providerAccepted, releaseResponse
  const accepted = new Promise(resolve => { providerAccepted = resolve })
  const held = new Promise(resolve => { releaseResponse = resolve })
  const f = createFixture(t, ['lateChoice'], decisionStatus, { holdChoiceResponse: async ({ signal }) => {
    providerAccepted({ signal })
    await held
  } })
  // Cleanup never leaves the mock waiting after a failed assertion.
  t.after(() => releaseResponse())
  await f.refreshCodexAccount()
  const firstId = 'qa-dm-late-choice', nextId = 'qa-dm-late-choice-next'
  const first = await f.send(f.direct(firstId), 'seed-late-first', PRIVATE.primaryHistory)
  await f.complete(first, 'Fixture reply in first DM')
  const next = await f.send(f.direct(nextId), 'seed-late-next', PRIVATE.otherHistory)
  await f.complete(next, 'Fixture reply in next DM')
  assert.notEqual(first.conversationId, next.conversationId)
  assert.deepEqual(f.counts.seed, { ...noWork(), subscription: 2, contextCollection: 2 })
  assert.deepEqual(f.httpPosts.map(({ phase, path }) => [phase, path]), [['seed', '/chat/send'], ['seed', '/chat/send']])
  const seedTurns = f.startTurns.length, seedNativeCalls = f.nativeCalls.length
  const { codex, projectRoom, realScope } = createRoomProjection(f)
  const firstRoom = projectRoom(first, firstId, f.agent), nextRoom = projectRoom(next, nextId, f.agent)
  const question = '첫 DM에서 어느 안내를 고를까요?'
  const nextDraft = '다른 DM의 아직 보내지 않은 초안입니다.'
  const options = ['팀 공지', '회의 안내']
  const firstInput = element('textarea'), nextInput = element('textarea')
  Object.assign(codex.threadDrafts, { [firstId]: question, [nextId]: nextDraft })
  Object.assign(codex.threadDraftRevisions, { [firstId]: 1, [nextId]: 1 })
  codex.activeThreadId = firstRoom.id
  codex.activityRoomGeneration = 1
  firstInput.value = question
  nextInput.value = nextDraft
  const draftWrites = []
  const history = () => structuredClone({
    conversations: f.store.listConversations(), nativeThreads: f.threads,
    rooms: [[firstId, first], [nextId, next]].map(([id, run]) => ({
      runtime: f.snapshot(run.conversationId), messages: f.store.listMessages(id),
      runs: f.store.listRuns(id), events: f.store.listEvents(id),
    })),
  })
  const before = history()
  const draftsBefore = structuredClone([codex.threadDrafts, codex.threadDraftRevisions])
  f.phase = 'lateChoice'
  const statusReads = [], choiceResponses = [], requestIds = []
  let rendererSignal
  const { mountChatChoiceComposer, readChatChoiceMode, postChatChoice } = loadComposer(async (path, { method, signal, body }) => {
    assert.ok(signal instanceof AbortSignal && !signal.aborted)
    if (path === '/decision/status') {
      assert.equal(method, 'GET')
      assert.equal(body, undefined)
      statusReads.push(codex.activeThreadId)
      return decisionStatus()
    }
    assert.equal(path, '/chat/choice')
    assert.equal(method, 'POST')
    rendererSignal = signal
    // Model a late completion even though the renderer aborts: do not
    // translate that signal into synthetic IncomingMessage/response close.
    // The real handler/runtime still process the one already-received POST.
    const response = await f.post(path, JSON.parse(body))
    choiceResponses.push({ status: response.status, body: response.body, activeRoom: codex.activeThreadId })
    return response.body
  })
  const ui = mountChatChoiceComposer({ el: element, makeController: () => new AbortController(),
    makeRequestId: () => {
      const id = `choice-${Date.now()}-${randomUUID()}`
      requestIds.push(id)
      return id
    }, readMode: readChatChoiceMode, postChoice: postChatChoice })
  t.after(() => ui.dispose())
  const bindComposer = (room, input) => ui.attach({ input, readScope: () => realScope(room.id, input.value),
    setDraft: text => {
      draftWrites.push([room.id, text])
      codex.threadDrafts[room.id] = text
      codex.threadDraftRevisions[room.id]++
    },
  })
  const button = id => findAll(ui.panel, id)[0]
  const chooserPosts = () => f.httpPosts.filter(({ phase }) => phase === 'lateChoice')
  bindComposer(firstRoom, firstInput)
  ui.sync()
  assert.equal(realScope(firstRoom.id, firstInput.value)?.conversationId, first.conversationId)
  click(ui.trigger)
  const fields = findAll(ui.panel, 'option')
  assert.equal(fields.length, 2)
  fields.forEach((field, i) => { field.value = options[i]; field.props.oninput() })
  click(button('review'))
  const confirm = await eventually(() => button('confirm'), 'review did not expose the user confirm control')
  assert.deepEqual([chooserPosts().length, f.decisionRequests.length, requestIds.length], [0, 0, 0])
  assert.deepEqual(statusReads, [firstId])
  click(confirm)
  await eventually(() => f.decisionRequests.length, 'Decision mock did not receive the explicitly confirmed request')
  const { signal: providerSignal } = await accepted
  assert.equal(providerSignal.aborted, false)
  assert.equal(rendererSignal.aborted, false)
  assert.match(ui.panel.children.find(node => node.props.role === 'status')?.textContent, /추천을 기다리는 중/)
  assert.deepEqual(choiceResponses, [], 'response is still held at the Decision mock')
  assert.equal(requestIds.length, 1)
  assert.deepEqual(chooserPosts(), [{ phase: 'lateChoice', path: '/chat/choice', body: {
    clientThreadId: firstId, conversationId: first.conversationId, profileId: f.agent.id,
    requestId: requestIds[0], question, options, confirm: true, reviewRevision: REVIEW_REVISION,
  } }])
  assert.equal(f.decisionRequests.length, 1)
  const [{ url, method, body }] = f.decisionRequests
  assert.deepEqual([url, method], [DECISIONS_ENDPOINT, 'POST'])
  assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_json', data: {
    question, options: { c1: options[0], c2: options[1] },
  } }] }])
  const wire = JSON.stringify(body)
  assert.ok(!wire.includes(nextDraft) && !wire.includes(nextId) && !wire.includes(next.conversationId))

  // Model the HUD room-selection/rebind seam: active identity and generation
  // change, the next input is attached, and the real controller synchronizes.
  // Do not force panel state, call reset directly, or fake the scope result.
  codex.activeThreadId = nextRoom.id
  codex.activityRoomGeneration++
  assert.equal(realScope(firstRoom.id, firstInput.value), null, 'the old room fails the actual active-room scope gate')
  const nextScope = realScope(nextRoom.id, nextInput.value)
  assert.equal(nextScope?.conversationId, next.conversationId, 'the new DM is independently choice-eligible')
  bindComposer(nextRoom, nextInput)
  ui.sync()
  assert.equal(rendererSignal.aborted, true, 'switching rooms invalidates the former renderer controller')
  assert.equal(providerSignal.aborted, false, 'this seam permits already received work to finish')
  assert.equal(ui.panel.hidden, true)
  assert.equal(ui.trigger.hidden, false)
  assert.equal(button('result'), undefined)
  assert.deepEqual(choiceResponses, [])

  releaseResponse()
  const response = await eventually(() => choiceResponses[0], 'no successful late HTTP reply at the old renderer boundary')
  assert.deepEqual(response, { status: 200, body: { status: 'recommended', index: 0 }, activeRoom: nextId })
  await pause(20)
  assert.equal(codex.activeThreadId, nextId)
  assert.equal(ui.panel.hidden, true)
  assert.equal(button('result'), undefined, 'late successful result is never rendered in the new DM')
  assert.equal(button('explain'), undefined)
  assert.equal(button('confirm'), undefined)
  assert.equal(firstInput.value, question)
  assert.equal(nextInput.value, nextDraft)
  assert.deepEqual([codex.threadDrafts, codex.threadDraftRevisions], draftsBefore)
  assert.deepEqual(draftWrites, [])
  assert.deepEqual(history(), before, 'both rooms’ native and SQLite messages/runs/events are unchanged')
  assert.deepEqual(statusReads, [firstId, firstId], 'only original review and confirm GETs; no post-response check or retry')
  assert.deepEqual([chooserPosts().length, f.decisionRequests.length, choiceResponses.length, requestIds.length], [1, 1, 1, 1])
  assert.deepEqual(f.counts.lateChoice, { ...noWork(), decisionChoice: 1 })
  assert.equal(f.nativeCalls.length, seedNativeCalls)
  assert.equal(f.startTurns.length, seedTurns)
  assert.deepEqual(f.unexpected, [])
  t.diagnostic(JSON.stringify({ preparation: { chatSendHTTP: 2, subscriptionTurns: seedTurns }, switchedWhilePending: {
    chooserHTTP: 1, decisionMock: 1, lateHTTP200: 1, recommendationShown: 0, draftWrites: 0,
    subscriptionRPC: f.nativeCalls.length - seedNativeCalls, subscriptionTurns: f.startTurns.length - seedTurns,
    localStatusGET: statusReads.length, automaticRetry: 0,
  } }))
  t.diagnostic('Synthetic HUD activation/rebind and late transport fulfillment; real controller scope/sync, HTTP handler, runtime, and two SQLite-backed DMs. This verifies discard of a successful late reply, not cancellation of a provider request or Firefox navigation.')
})

// Actual source closures, without Firefox layout, account refresh, file access or sockets.
function mountFixtureHudSend(f, { state, protocol, projectDefaults }, room, choice, input, editReason) {
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

async function verifyReasonSendAndNextChoice(t, x) {
  const { f, primary, other, primaryId, otherId, projection, room, ui, input, send, button, fields, setOption,
    question, initialOptions, revisedOptions, requestIds, choiceResponses, localStatusReads, setStage, stateAfterSeed, before, draftWrites, editReason } = x
  const { codex, projectRoom } = projection
  const expectCounts = (phase, counts, paths) => {
    assert.deepEqual(f.counts[phase], { ...noWork(), ...counts })
    assert.deepEqual(f.httpPosts.filter(row => row.phase === phase).map(row => row.path), paths)
  }
  f.phase = 'reasonDraft'; setStage('reason draft')
  const explain = button('explain')
  assert.equal(explain.props.data.testid, 'chat-choice-explain')
  assert.deepEqual(explain.children, ['이유 묻기'])
  click(explain)
  const draft = await eventually(() => draftWrites() === 1 && input.value, 'reason click did not produce a draft')
  assert.equal(draft, ['아래 질문과 보기만 놓고, 표시된 추천이 적절한지 독립적으로 비교해 주세요. 실제 추천 모델의 내부 판단 근거는 알 수 없으니 재현했다고 말하지 말고, 선택하거나 실행하지 마세요.', '',
    `질문: ${question}`, `1. ${revisedOptions[0]}`, `2. ${revisedOptions[1]}`, `EG-Desk 추천: 1. ${revisedOptions[0]}`].join('\n'))
  assert.ok(!draft.includes(initialOptions[0]))
  assert.equal(codex.threadDrafts[room.id], draft)
  assert.equal(ui.panel.hidden, true)
  await pause(20)
  expectCounts('reasonDraft', {}, [])
  assert.deepEqual(send.outcomes, [])
  const afterDraft = stateAfterSeed()
  assert.deepEqual(afterDraft.rooms, before.rooms)
  assert.deepEqual(afterDraft.nativeThreads, before.nativeThreads)

  const ownSentence = '팀 공지를 위에 두면 참석자가 일정을 찾기 쉬울까요?'
  const sentText = editReason ? ownSentence : draft
  const approvalEvidence = () => structuredClone({
    posts: f.httpPosts.filter(row => row.path === '/chat/choice'), decisions: f.decisionRequests,
    requestIds, responses: choiceResponses.map(({ status, body }) => ({ status, body })),
  })
  const approvalBefore = editReason ? approvalEvidence() : null
  if (editReason) {
    f.phase = 'reasonEdit'; setStage('reason edit')
    const revision = codex.threadDraftRevisions[room.id]
    const nativeCalls = f.nativeCalls.length
    const statusCount = localStatusReads.length
    input.value = ownSentence
    assert.equal(codex.threadDrafts[room.id], draft, 'setting the synthetic textarea alone cannot update the product draft')
    input.dispatchEvent(new Event('input'))
    assert.equal(codex.threadDrafts[room.id], ownSentence, 'the product input listener forwards the edited text')
    assert.equal(codex.threadDraftRevisions[room.id], revision + 1)
    assert.equal(draftWrites(), 1, 'the edit did not invoke the recommendation-to-draft callback again')
    assert.equal(send.sendButton.disabled, false, 'the real input listener refreshed the send button')
    await pause(20)
    expectCounts('reasonEdit', {}, [])
    assert.deepEqual(send.outcomes, [])
    assert.equal(f.nativeCalls.length, nativeCalls)
    assert.equal(localStatusReads.length, statusCount)
    assert.deepEqual(approvalEvidence(), approvalBefore)
    assert.deepEqual(stateAfterSeed().rooms, afterDraft.rooms)
    assert.equal(ui.panel.hidden, true)
    assert.equal(button('confirm'), undefined)
    assert.equal(button('result'), undefined)
  }

  f.phase = 'reasonSend'; setStage('reason send')
  if (!editReason) send.syncSendButton()
  assert.deepEqual([send.sendButton.props.data.testid, send.sendButton.props['aria-label'], send.sendButton.title],
    ['chat-send', '메시지 보내기', '보내기'])
  click(send.sendButton)
  const outcome = await eventually(() => send.outcomes[0], `HUD send did not settle: ${JSON.stringify(room)}`)
  assert.equal(send.posts.length, 1, JSON.stringify({ outcome, roomError: room.sendError }))
  const sendResponse = send.posts[0]
  const accepted = sendResponse.body
  assert.equal(sendResponse.status, 202, JSON.stringify(accepted))
  assert.deepEqual(outcome, { result: { requestId: accepted.requestId, accepted: true } })
  assert.equal(accepted.conversationId, primary.conversationId)
  assert.notEqual(accepted.runId, primary.runId)
  assert.deepEqual(send.projectedAcceptances, [accepted.runId])
  const { body: outgoing } = f.httpPosts.find(row => row.phase === 'reasonSend')
  assert.deepEqual([outgoing.message, outgoing.clientThreadId, outgoing.conversationId, outgoing.requestId, outgoing.replyDestination],
    [sentText, primaryId, primary.conversationId, accepted.requestId, undefined])
  assert.equal(codex.threadDrafts[room.id], '', 'production bridge consumed only the submitted DM draft')
  expectCounts('reasonSend', { subscription: 1, contextCollection: 1 }, ['/chat/send'])
  const started = f.startTurns.filter(row => row.phase === 'reasonSend')
  assert.equal(started.length, 1)
  assert.equal(started[0].params.threadId, primary.conversationId)
  assert.deepEqual(started[0].params.input, [{ type: 'text', text: sentText, text_elements: [] }])
  assert.equal(started[0].params.additionalContext?.egdesk_decision_context, undefined)
  const answer = '합성 구독 응답: 수정해서 검토한 팀 공지 고정과 일정 공지를 비교합니다.'
  await f.complete(accepted, answer)
  assert.equal(projectRoom(accepted, primaryId, f.agent), room, 'the accepted run completes in the same projected DM')
  const afterSend = stateAfterSeed()
  const roomRecords = ({ runtime: { seq, lastSeq, ...runtime }, ...records }) => ({ runtime, ...records })
  // seq/lastSeq are the shared runtime stream cursor, not other-room rows.
  assert.deepEqual(roomRecords(afterSend.rooms[1]), roomRecords(before.rooms[1]))
  assert.deepEqual(afterSend.conversations.threads.find(row => row.clientThreadId === otherId),
    before.conversations.threads.find(row => row.clientThreadId === otherId))
  assert.deepEqual(afterSend.nativeThreads.get(other.conversationId), before.nativeThreads.get(other.conversationId))
  const beforeMessages = afterDraft.rooms[0].messages.messages
  const afterMessages = afterSend.rooms[0].messages.messages
  assert.deepEqual(afterMessages.slice(0, beforeMessages.length), beforeMessages)
  assert.deepEqual(afterMessages.slice(beforeMessages.length).map(({ role, text }) => [role, text]), [['user', sentText], ['assistant', answer]])
  assert.deepEqual(afterSend.rooms[0].runs.runs.slice(0, -1), afterDraft.rooms[0].runs.runs)
  assert.equal(afterSend.rooms[0].runs.runs.at(-1).runId, accepted.runId)
  assert.deepEqual(afterSend.rooms[0].events.events.slice(0, afterDraft.rooms[0].events.events.length), afterDraft.rooms[0].events.events)

  if (editReason) {
    await pause(20)
    expectCounts('reasonSend', { subscription: 1, contextCollection: 1 }, ['/chat/send'])
    assert.equal(send.posts.length, 1)
    assert.equal(send.outcomes.length, 1)
    assert.deepEqual(approvalEvidence(), approvalBefore, 'the edit/send did not change or repeat chooser authorization or result')
    assert.equal(ui.panel.hidden, true)
    assert.equal(button('confirm'), undefined)
    assert.equal(button('result'), undefined)
    assert.deepEqual(localStatusReads.map(row => row.stage), ['first review', 'second review', 'explicit confirm', 'explicit confirm', 'reason draft'])
    assert.deepEqual([afterSend.drafts[otherId], afterSend.draftRevisions[otherId], afterSend.otherRoom],
      [before.drafts[otherId], before.draftRevisions[otherId], before.otherRoom])
    assert.deepEqual(f.nativeCalls.filter(row => row.phase !== 'seed').map(row => row.phase),
      f.nativeCalls.filter(row => row.phase === 'reasonSend').map(row => row.phase))
    assert.deepEqual(send.unexpectedCalls, [])
    assert.deepEqual(f.unexpected, [])
    t.diagnostic(JSON.stringify({ editedReason: ownSentence, seedTurns: f.counts.seed.subscription,
      priorChooser: f.counts.recovery, editBeforeClick: { ...f.counts.reasonEdit, chatSendHTTP: 0 },
      explicitSend: { ...f.counts.reasonSend, chatSendHTTP: 1, status: sendResponse.status, accepted: accepted.accepted },
      persistedAuthoredMessage: afterMessages.at(-2).text, otherRoomUnchanged: true, approvalUnchanged: true, automaticSend: 0 }))
    t.diagnostic('Node EventTarget delivers the synthetic input event to the exact production HUD input listener. Actual Send onclick, sendMessage, HTTP handler, runtime, adapter and SQLite; no layout, network or real engine.')
    return
  }

  f.phase = 'nextChoice'; setStage('next question entry')
  const nextQuestion = '다음 회의는 언제 열까요?'
  const nextOptions = ['월요일 오전', '화요일 오후']
  input.value = nextQuestion
  send.bridge.setDraft(input.value, room.id)
  ui.sync()
  assert.equal(codex.activeThreadId, primaryId)
  assert.equal(projection.realScope(room.id, input.value)?.conversationId, primary.conversationId)
  click(ui.trigger)
  assert.deepEqual(fields().map(({ value }) => value), ['', ''], 'a new question has no inherited choices or approval')
  fields().forEach((field, i) => setOption(field, nextOptions[i]))
  setStage('next review'); click(button('review'))
  const confirm = await eventually(() => button('confirm'), 'new review did not expose a fresh confirm')
  assert.ok(ui.panel.children.some(node => node.textContent === `질문: ${nextQuestion}`))
  assert.deepEqual(ui.panel.children.find(node => node.tag === 'ol').children.map(({ textContent }) => textContent), nextOptions)
  expectCounts('nextChoice', {}, [])
  setStage('next explicit confirm'); click(confirm)
  const nextResult = await eventually(() => button('result'), 'second recommendation not rendered')
  assert.equal(nextResult.textContent, `EG-Desk 추천: ${nextOptions[0]} · 실행하지 않음`)
  await pause(20)
  assert.deepEqual(choiceResponses.map(({ status, body }) => [status, body]),
    [[200, { status: 'recommended', index: 0 }], [200, { status: 'recommended', index: 0 }]])
  assert.equal(new Set(requestIds).size, 2)
  assert.deepEqual(f.httpPosts.find(row => row.phase === 'nextChoice').body, {
    clientThreadId: primaryId, conversationId: primary.conversationId, profileId: f.agent.id, requestId: requestIds[1],
    question: nextQuestion, options: nextOptions, confirm: true, reviewRevision: REVIEW_REVISION,
  })
  assert.deepEqual(f.decisionRequests.map(({ phase, body }) => [phase, body.input[0].content[0].data]), [
    ['recovery', { question, options: { c1: revisedOptions[0], c2: revisedOptions[1] } }],
    ['nextChoice', { question: nextQuestion, options: { c1: nextOptions[0], c2: nextOptions[1] } }],
  ])
  expectCounts('nextChoice', { decisionChoice: 1 }, ['/chat/choice'])
  assert.deepEqual(f.httpPosts.filter(row => row.phase !== 'seed').map(row => [row.phase, row.path]),
    [['recovery', '/chat/choice'], ['reasonSend', '/chat/send'], ['nextChoice', '/chat/choice']])
  assert.deepEqual(localStatusReads.map(row => row.stage), ['first review', 'second review', 'explicit confirm', 'explicit confirm',
    'reason draft', 'next review', 'next explicit confirm', 'next explicit confirm'])
  const afterNext = stateAfterSeed()
  assert.deepEqual(afterNext.rooms, afterSend.rooms)
  assert.deepEqual(afterNext.conversations, afterSend.conversations)
  assert.deepEqual(afterNext.nativeThreads, afterSend.nativeThreads)
  assert.deepEqual([afterNext.drafts[otherId], afterNext.draftRevisions[otherId], afterNext.otherRoom],
    [before.drafts[otherId], before.draftRevisions[otherId], before.otherRoom])
  assert.deepEqual(f.nativeCalls.filter(row => row.phase !== 'seed').map(row => row.phase),
    f.nativeCalls.filter(row => row.phase === 'reasonSend').map(row => row.phase))
  assert.equal(f.nativeCalls.filter(row => row.phase === 'reasonSend' && row.method === 'turn/start').length, 1)
  assert.equal(input.value, nextQuestion)
  assert.equal(draftWrites(), 1)
  assert.deepEqual(send.unexpectedCalls, [])
  assert.deepEqual(f.unexpected, [])
  t.diagnostic(JSON.stringify({ selectors: ['chat-choice-explain', 'chat-send', 'chat-choice-review', 'chat-choice-confirm', 'chat-choice-result'],
    seed: f.counts.seed, ...Object.fromEntries(['recovery', 'reasonDraft', 'reasonSend', 'nextChoice'].map(phase => [phase,
      { ...f.counts[phase], http: f.httpPosts.filter(row => row.phase === phase).map(row => row.path) }])),
    sendHTTP: sendResponse.status, sendAccepted: accepted.accepted, sameConversation: true, autoSendOrRetry: 0 }))
  t.diagnostic('Actual HUD send button, submitComposer, sendMessage, buildChatRequest, HTTP routes and runtime; DOM, no-project lookup, pre-existing UI resume cache, outer repaint/session and provider/engine transports are fixtures.')
}

test('v3 #221: recovered choice → actual Reason draft → actual HUD Send → one same-DM reply → new explicitly approved choice',
  t => verifyRecoveredChoice(t, { throughSend: true }))

test('v3: actual HUD input edits a Reason draft before one explicit same-DM send',
  t => verifyRecoveredChoice(t, { throughSend: true, editReason: true }))
