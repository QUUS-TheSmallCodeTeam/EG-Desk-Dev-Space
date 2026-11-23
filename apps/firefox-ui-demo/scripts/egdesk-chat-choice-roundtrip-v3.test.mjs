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
function loadScope(state, protocol, profiles, chatRoomProjectDefaults) {
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
  return runInNewContext(deps + '\ncodexProfileCatalog = catalog;\n({' + scope + '}).chatChoiceScope', {
    state, protocol, ChatState, catalog: { status: 'ready', profiles }, chatRoomProjectDefaults,
    chatProjectDraftActions: new Map(), choiceSettingsWriting: 0, choiceSettingsGeneration: 0,
    document: { getElementById: () => assert.fail('no canvas entity is selected in the fixture') },
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

function createFixture(t) {
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
  const chat = new CodexChatRuntime({ engines: [engine], store, requireStore: true, profiles, getOwnerKey: ownerKey,
    decisionContext: { client, settingsGeneration: () => 1, reviewRevision: () => decisionStatus().boardRevision,
      recipientForChatChoice: ({ engineId, ownerKey: scopedOwner }) =>
        engineId === 'codex' && codexAuth?.isLoggedIn === true && codexAuth.authMode === 'chatgpt' && scopedOwner === ownerKey() ? decisionRecipient() : null,
      mode: () => decisionStatus().mode, configured: () => decisionStatus().configured, collect: async ({ body, context, memoryEvidenceFor, speech }) => {
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
    ChatState.registerChatRequest(protocol, { requestId: accepted.requestId, clientThreadId,
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
  const primaryRoom = projectRoom(primary, scope.clientThreadId, f.agent)
  const customRoom = projectRoom(other, 'qa-dm-other', f.custom)
  const realScope = loadScope(state, protocol, f.profileRows(), projectDefaults)
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
