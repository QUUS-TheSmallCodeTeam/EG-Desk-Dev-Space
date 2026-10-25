import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createChatEngineAuth } from './codex-bridge-engine-auth.mjs'
import { createChatHttpHandler } from './codex-bridge-http.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { createPlanToolProvider } from './egdesk-plan-tool-provider.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

// Real adapters, permission broker, MCP bridge, translator and durable store;
// only Claude's transport is fake. No CLI, login, OS input or model call.
const CWD = '/work/claude-original'
const OWNER = 'claude:claudeai:owner@example.com'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const spec = name => ({ type: 'function', name, description: name,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } })
const SPEC = spec('egdesk_list_context')
const tick = () => new Promise(resolve => setImmediate(resolve))

function withStore(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-claude-')
  const store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }) })
  return store
}

function harness(t, { store = null, env = {}, defaultCwd = CWD, toolProviders = [], contexts = null, residentLimit = 2,
  transportFailure = null, respondResult = true, getOwnerKey = () => null } = {}) {
  const transports = [], codexCalls = [], codexReplies = [], events = [], timers = [], requests = []
  let account = 'Owner@Example.com'
  let count = 0
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version: '2.1.300', versionStatus: 'untested',
      auth: { status: 'signedIn', method: 'claudeai', account, label: 'Claude Max' } }),
    env, defaultCwd, residentLimit, resolveExecutable: () => '/fake/claude',
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: timer => { timer.cleared = true },
    createTransport: options => {
      const transport = {
        options, sent: [], replies: [], closed: false,
        async start() { if (transportFailure) throw Object.assign(new Error('fake start failure'), { code: transportFailure }) },
        sendUserMessage(content) { this.sent.push(clone(content)) },
        respondControl(id, answer) { this.replies.push({ id, ...clone(answer) }); return respondResult },
        info: () => ({ init: { billsApiKey: false } }),
        async interrupt() {},
        async close() { if (!this.closed) { this.closed = true; options.onExit() } },
        message(message) { options.onMessage(message) },
        control(requestId, request) { return options.controlHandlers[request.subtype](request, { requestId }) },
      }
      transports.push(transport)
      return transport
    },
  })
  const codex = createCodexEngineAdapter({
    request: async (method, params) => {
      codexCalls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `codex-${++count}` }, cwd: '/work/codex' }
      if (method === 'turn/start') return { turn: { id: `codex-turn-${++count}`, status: 'inProgress', items: [] } }
      throw new Error(`Unexpected Codex call: ${method}`)
    }, respond: (...args) => { codexReplies.push(args); return true },
  })
  const chat = new CodexChatRuntime({ engines: [codex, claude], store, requireStore: Boolean(store), getOwnerKey,
    contexts, toolProviders, emit: event => events.push(event), verifyFile: async () => null })
  const unsubscribe = claude.subscribe({
    notification: (_, message) => chat.handleNotification(message),
    serverRequest: (_, message) => { requests.push(message); chat.handleServerRequest(message) },
    connection: (id, state) => chat.setConnection(id, state.ready, state),
  })
  claude.syncStatus()
  const drain = async () => { await chat.queue; await tick(); await chat.queue }
  const complete = async (transport, extra = {}) => {
    transport.message({ type: 'result', subtype: 'success', is_error: false,
      session_id: transport.options.sessionId || transport.options.resume, ...extra })
    await drain()
  }
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain() })
  const send = (extra = {}) => chat.send({ message: 'Test message', engineId: 'claude', clientThreadId: 'ui-claude', requestId: 'req-1', ...extra })
  const runOf = run => chat.runs.get(`${run.conversationId}/${run.runId}`)
  return { chat, claude, transports, codexCalls, codexReplies, events, timers, requests, send, runOf, drain, complete,
    setAccount: value => { account = value } }
}

const permission = (tool_name = 'Bash', input = { command: 'ls' }, extra = {}) => ({
  subtype: 'can_use_tool', tool_name, tool_use_id: 'toolu-1', input, ...extra,
})
const mcp = (method, params = {}) => ({ subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 1, method, params } })

function http(h) {
  let refreshes = 0
  const auth = createChatEngineAuth({ chat: h.chat, refreshCodexAccount: async () => { refreshes++ }, getCodexAuth: () => ({ isLoggedIn: false }) })
  const handler = createChatHttpHandler(h.chat, auth)
  return { refreshes: () => refreshes, async post(path, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method: 'POST', url: path, headers: { 'content-type': 'application/json' } })
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
    await handler(req, res, new URL(`http://localhost${path}`))
    return res
  } }
}

test('actual bridge auth sends and resumes stored Claude with Codex logged out, including restart and lost-reply audit', async t => {
  const store = withStore(t)
  const h = harness(t, { store })
  const firstHttp = http(h)
  const first = await firstHttp.post('/chat/send', { engineId: 'claude', clientThreadId: 'ui-claude', requestId: 'first-http', message: 'First' })
  assert.equal(first.status, 202)
  await h.complete(h.transports[0])
  const restarted = harness(t, { store })
  const api = http(restarted)
  const binding = { clientThreadId: 'ui-claude', conversationId: first.body.conversationId }
  const resumed = await api.post('/chat/resume', binding)
  assert.equal(resumed.status, 200)
  assert.equal(restarted.transports.length, 0, 'resume does not start a real or fake model turn')
  const continued = await api.post('/chat/send', { ...binding, requestId: 'continued-http', message: 'Continue' })
  assert.equal(continued.body.accepted, true)
  assert.equal(restarted.transports[0].options.resume, binding.conversationId)
  await restarted.complete(restarted.transports[0])
  const cold = harness(t, { store })
  const audit = http(cold)
  // After a lost reply the UI may know only the local ID. The durable binding
  // still chooses Claude before the duplicate outcome is read.
  const replay = await audit.post('/chat/send', { clientThreadId: 'ui-claude', requestId: 'continued-http', message: 'Continue' })
  assert.equal(replay.body.duplicate, true)
  assert.equal(replay.body.conversationId, binding.conversationId)
  const missingNativeId = await audit.post('/chat/send', { clientThreadId: 'ui-claude', requestId: 'missing-id', message: 'Next' })
  assert.equal(missingNativeId.body.code, 'CONVERSATION_REQUIRED')
  for (const path of ['/chat/send', '/chat/resume']) {
    const conflict = await audit.post(path, { ...binding, engineId: 'codex', message: 'No switch', requestId: 'conflict' })
    assert.deepEqual([conflict.status, conflict.body.accepted, conflict.body.code], [409, false, 'ENGINE_MISMATCH'])
  }
  cold.setAccount('different@example.com')
  for (const path of ['/chat/send', '/chat/resume']) {
    const mismatch = await audit.post(path, { ...binding, message: 'Wrong account', requestId: 'wrong-account' })
    assert.deepEqual([mismatch.status, mismatch.body.accepted, mismatch.body.code], [403, false, 'NATIVE_ACCOUNT_MISMATCH'])
  }
  assert.equal(store.getRequest({ clientThreadId: 'ui-claude', requestId: 'wrong-account' }), null)
  assert.equal(firstHttp.refreshes() + api.refreshes() + audit.refreshes(), 0)
  assert.deepEqual([...h.codexCalls, ...restarted.codexCalls, ...cold.codexCalls], [])
  assert.equal(cold.transports.length, 0)
})

test('bridge rejects unrecorded or conflicting stored engine bindings before account refresh or dispatch', async t => {
  const store = withStore(t)
  const h = harness(t, { store })
  const first = await h.send()
  await h.complete(h.transports[0])
  const restarted = harness(t, { store })
  const api = http(restarted)
  const missing = await api.post('/chat/resume', { clientThreadId: 'ui-missing', conversationId: 'unbound' })
  assert.equal(missing.body.code, 'NATIVE_BINDING_MISMATCH')
  const binding = store.listEvents('ui-claude', { limit: 500 }).events.find(event => event.event === 'native.thread.bound')
  store.appendEvent({ clientThreadId: 'ui-claude', eventKey: 'conflicting-engine', event: 'native.thread.bound',
    details: { ...binding.details, engine: { id: 'codex', engineProfileId: 'codex-default' } }, ts: Date.now() })
  const conflict = await api.post('/chat/resume', { clientThreadId: 'ui-claude', conversationId: first.conversationId })
  assert.equal(conflict.body.code, 'ENGINE_MISMATCH')
  assert.equal(conflict.body.accepted, false)
  assert.equal(api.refreshes(), 0)
  assert.equal(restarted.transports.length, 0)
  assert.deepEqual(restarted.codexCalls, [])
})

test('plain Claude catalogs and resume never consult Codex Context/plan authority; selected Context is explicitly refused', async t => {
  const store = withStore(t)
  let schemaReady = true, contextOwnerReads = 0
  const makeContext = () => new ContextRuntime({ store: {}, reader: {}, schemaReady: () => schemaReady,
    getOwnerKey: () => { contextOwnerReads++; throw new Error('Codex authority must not be read') } })
  const providers = () => [createPlanToolProvider({ plans: () => null, schemaReady: () => schemaReady })]
  const h = harness(t, { store, contexts: makeContext(), toolProviders: providers() })
  const api = http(h)
  const selections = [
    { contextSnapshotIds: ['selected-source'] }, { attachments: [{ id: 'source' }] },
    { selectedSources: [{ id: 'browser-tab' }] }, { contextCapabilities: { read: true } },
    { contextCapabilities: { reader: true } }, { contextCapabilities: { publishBriefing: true } },
    { contextResolution: { resolutionId: 'chosen', chosen: ['source'] } },
  ]
  for (const [index, selection] of selections.entries()) {
    const rejected = await api.post('/chat/send', { engineId: 'claude', clientThreadId: `selected-${index}`, requestId: `selected-${index}`, message: 'Use selected context', ...selection })
    assert.deepEqual([rejected.status, rejected.body.accepted, rejected.body.code], [409, false, 'CLAUDE_CONTEXT_UNSUPPORTED'])
    assert.equal(rejected.body.error, '현재 Claude 연결에서는 선택한 자료를 사용할 수 없어 보내지 않았습니다. 자료를 제외한 뒤 다시 보내세요.')
    assert.equal(store.getConversation(`selected-${index}`), null, 'refuse before accepting local input')
  }
  const first = await h.send({ contextSnapshotIds: [], attachments: [], selectedSources: [], contextCapabilities: { read: false, reader: false, publishBriefing: false } })
  const binding = store.listEvents('ui-claude', { limit: 500 }).events.find(event => event.event === 'native.thread.bound')
  assert.deepEqual(binding.details.toolManifest, [])
  assert.deepEqual(h.transports[0].control('list', mcp('tools/list')).write.response.response.mcp_response.result.tools, [])
  await h.complete(h.transports[0])
  schemaReady = false // Codex disconnected before helper restart.
  const restarted = harness(t, { store, contexts: makeContext(), toolProviders: providers() })
  const resumed = await http(restarted).post('/chat/resume', { clientThreadId: 'ui-claude', conversationId: first.conversationId })
  assert.equal(resumed.status, 200)
  const next = await restarted.send({ conversationId: first.conversationId, requestId: 'plain-resume', engineId: undefined })
  assert.equal(next.accepted, true)
  assert.equal(contextOwnerReads, 0)
  assert.deepEqual([...h.codexCalls, ...restarted.codexCalls], [])
  assert.equal(api.refreshes(), 0)
})

test('legacy Claude manifests requiring unsupported Context remain unverifiable, never silently narrowed', async t => {
  const store = withStore(t)
  const provider = { providerId: 'test-context', specs: () => [SPEC] }
  const h = harness(t, { store, toolProviders: [provider] })
  const first = await h.send()
  await h.complete(h.transports[0])
  const binding = store.listEvents('ui-claude', { limit: 500 }).events.find(event => event.event === 'native.thread.bound')
  const toolManifest = binding.details.toolManifest.map(entry => ({ ...entry, providerId: 'egdesk-context-v1' }))
  store.appendEvent({ clientThreadId: 'ui-claude', eventKey: 'old-context-manifest', event: 'native.thread.bound', details: { ...binding.details, toolManifest }, ts: Date.now() })
  const restarted = harness(t, { store, contexts: { specs: () => [SPEC] } })
  await assert.rejects(restarted.chat.resume({ clientThreadId: 'ui-claude', conversationId: first.conversationId }), { code: 'NATIVE_TOOL_MANIFEST_UNVERIFIED' })
  assert.deepEqual(restarted.chat.threadToolManifests.get(first.conversationId), toolManifest)
  assert.equal(restarted.transports.length, 0)
})

test('stored Claude binding and run use Claude owner scope with Codex disconnected, including after restart', async t => {
  const store = withStore(t)
  const h = harness(t, { store })
  const first = await h.send({ cwd: CWD })
  await h.complete(h.transports[0])
  assert.equal(h.chat.connection, 'offline')
  assert.equal(h.chat.storeHealthy, true)
  const binding = store.listEvents('ui-claude', { limit: 500 }).events.find(event => event.event === 'native.thread.bound')
  assert.equal(binding.details.ownerHash, sha256(OWNER))
  assert.equal(binding.details.cwd, CWD)
  assert.equal(binding.details.engine.id, 'claude')
  assert.equal(store.getConversation('ui-claude').engineId, 'claude')
  assert.equal(h.runOf(first).accountIdentity.ownerHash, sha256(OWNER))
  assert.equal(JSON.stringify(binding).includes('owner@example.com'), false)
  const restarted = harness(t, { store, defaultCwd: '/work/different-default' })
  const next = await restarted.send({ conversationId: first.conversationId, requestId: 'req-2', engineId: undefined })
  assert.equal(next.conversationId, first.conversationId)
  assert.equal(restarted.transports[0].options.resume, first.conversationId)
  assert.equal(restarted.transports[0].options.cwd, CWD)
  assert.deepEqual(restarted.codexCalls, [])
})

test('changed Claude account refuses send and resume before dispatch without poisoning the store', async t => {
  const store = withStore(t)
  const h = harness(t, { store })
  const first = await h.send()
  await h.complete(h.transports[0])
  const other = harness(t, { store, getOwnerKey: () => OWNER })
  other.setAccount('other@example.com')
  for (const action of [
    () => other.send({ conversationId: first.conversationId, requestId: 'wrong-owner', engineId: undefined }),
    () => other.chat.resume({ conversationId: first.conversationId, clientThreadId: 'ui-claude' }),
  ]) await assert.rejects(action(), { code: 'NATIVE_ACCOUNT_MISMATCH' })
  assert.equal(store.getRequest({ clientThreadId: 'ui-claude', requestId: 'wrong-owner' }), null)
  assert.equal(other.chat.storeHealthy, true)
  assert.equal(other.transports.length, 0)
  assert.deepEqual(other.codexCalls, [])
  await assert.rejects(h.send({ conversationId: first.conversationId, requestId: 'wrong-engine', engineId: 'codex' }), { code: 'ENGINE_MISMATCH' })
})

test('Claude account changes during asynchronous preparation are rejected before binding or dispatch', async t => {
  const store = withStore(t)
  let h
  const provider = { providerId: 'test-context', specs: () => [], prepare: async () => { await tick(); h.setAccount('other@example.com') } }
  h = harness(t, { store, toolProviders: [provider] })
  await assert.rejects(h.send(), error => error.code === 'ACCOUNT_CHANGED' && error.definite && !error.resumeRequired)
  assert.equal(h.transports.length, 0)
  assert.equal(store.getConversation('ui-claude').conversationId, null)
  assert.equal(store.getRequest({ clientThreadId: 'ui-claude', requestId: 'req-1' }).outcome.dispatchStatus, 'rejected')
  assert.equal(h.chat.storeHealthy, true)
})

test('Claude approvals route to their real broker with Codex offline and session permission stays session-scoped', async t => {
  const h = harness(t)
  const run = await h.send()
  const transport = h.transports[0]
  transport.control('permission-1', permission('Bash', { command: 'ls' }, {
    permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], destination: 'userSettings' }],
  }))
  await h.drain()
  const pending = h.runOf(run).pendingApprovals[0]
  assert.deepEqual(pending.choices, ['accept', 'acceptForSession', 'decline', 'cancel'])
  await h.chat.replyApproval({ ...run, approvalId: pending.approvalId, decision: 'acceptForSession' })
  const response = transport.replies[0].write.response.response
  assert.equal(response.behavior, 'allow')
  assert.deepEqual(response.updatedPermissions, [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], destination: 'session' }])
  assert.deepEqual(h.codexReplies, [])
  assert.equal(h.chat.respond(h.requests[0].id, { decision: 'accept' }), false, 'late Claude id never goes to Codex')
  assert.deepEqual(h.codexReplies, [])
  transport.control('permission-2', permission('Write', { file_path: '/work/note.txt', content: 'private' }))
  await h.drain()
  const file = h.runOf(run).pendingApprovals.at(-1)
  assert.equal(file.kind, 'fileChange')
  await h.chat.replyApproval({ ...run, approvalId: file.approvalId, decision: 'decline' })
  assert.equal(transport.replies.at(-1).write.response.response.behavior, 'deny')
})

test('session grants cannot bypass run ownership, bounded policy, ceiling or missing command details', async t => {
  const h = harness(t)
  const run = await h.send()
  const transport = h.transports[0]
  transport.control('permission', permission('Bash', { command: 'ls' }, {
    permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }],
  }))
  await h.drain()
  const state = h.runOf(run)
  const reply = { ...run, approvalId: state.pendingApprovals[0].approvalId, decision: 'acceptForSession' }
  h.chat.ownedRuns.delete(state)
  await assert.rejects(h.chat.replyApproval(reply), { code: 'NATIVE_RUN_UNBOUND' })
  h.chat.ownedRuns.add(state)
  state.executionPolicy = { mode: 'readOnlyQa' }
  await assert.rejects(h.chat.replyApproval(reply), { code: 'BOUNDED_APPROVAL_FORBIDDEN' })
  delete state.executionPolicy
  state.toolCeiling = { terminal: 'none' }
  await assert.rejects(h.chat.replyApproval(reply), { code: 'PROFILE_CEILING_FORBIDDEN' })
  delete state.toolCeiling
  assert.equal(transport.replies.length, 0)
  await h.chat.handleServerRequest({ id: 'unsafe-target', method: 'item/commandExecution/requestApproval',
    params: { threadId: run.conversationId, turnId: run.runId, availableDecisions: ['accept', 'acceptForSession', 'decline'] } })
  assert.deepEqual(state.pendingApprovals.at(-1).choices, ['decline'])
})

test('actual Claude approvals without valid session rules offer only one-off and forged session responses deny', async t => {
  const h = harness(t)
  const run = await h.send()
  const transport = h.transports[0]
  const cases = [
    permission(), permission('Bash', { command: 'ls' }, { permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] }),
    permission('Write', { file_path: '/work/file', content: 'text' }),
  ]
  for (const [index, request] of cases.entries()) {
    transport.control(`no-rules-${index}`, request)
    await h.drain()
    const pending = h.runOf(run).pendingApprovals.at(-1)
    assert.deepEqual(pending.choices, ['accept', 'decline', 'cancel'])
    await assert.rejects(h.chat.replyApproval({ ...run, approvalId: pending.approvalId, decision: 'acceptForSession' }), { code: 'INVALID_DECISION' })
    // Defense in depth: a forged response delivered directly to the adapter
    // cannot turn the old one-off fallback into a purported session grant.
    assert.equal(h.claude.respond(h.requests.at(-1).id, { decision: 'acceptForSession' }), true)
    assert.equal(transport.replies.at(-1).write.response.response.behavior, 'deny')
    assert.equal(transport.replies.at(-1).write.response.response.updatedPermissions, undefined)
  }
  transport.control('one-off-still-works', permission())
  await h.drain()
  const pending = h.runOf(run).pendingApprovals.at(-1)
  await h.chat.replyApproval({ ...run, approvalId: pending.approvalId, decision: 'accept' })
  assert.deepEqual(transport.replies.at(-1).write.response.response, { behavior: 'allow', updatedInput: { command: 'ls' } })
  assert.deepEqual(h.codexReplies, [])
})

test('terminal ask filters session permission and rejects a forged grant while one-off Bash acceptance remains valid', async t => {
  const h = harness(t)
  const run = await h.send()
  const state = h.runOf(run)
  state.toolCeiling = { browser: 'interact', files: 'write', terminal: 'ask', network: 'on', mcp: 'inherited' }
  const transport = h.transports[0]
  transport.control('bash-session-suggestion', permission('Bash', { command: 'ls' }, {
    permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], destination: 'userSettings' }],
  }))
  await h.drain()
  const pending = state.pendingApprovals[0]
  assert.deepEqual(pending.choices, ['accept', 'decline', 'cancel'])
  const reply = { ...run, approvalId: pending.approvalId, decision: 'acceptForSession' }
  await assert.rejects(h.chat.replyApproval(reply), { code: 'INVALID_DECISION' })
  // Even a stale/forged card that advertises the choice cannot grant it.
  h.chat.pendingApprovals.get(pending.approvalId).choices = [...pending.choices, 'acceptForSession']
  await assert.rejects(h.chat.replyApproval(reply), { code: 'PROFILE_CEILING_FORBIDDEN' })
  assert.equal(transport.replies.length, 0)
  const accepted = await h.chat.replyApproval({ ...reply, decision: 'accept' })
  assert.equal(accepted.accepted, true)
  const result = transport.replies[0].write.response.response
  assert.equal(result.behavior, 'allow')
  assert.equal(result.updatedPermissions, undefined, 'one-off approval must not install session rules')
  assert.deepEqual(h.codexReplies, [])
})

test('actual Claude adapter response false is an HTTP failure for approval, answer and skip, never replySent', async t => {
  for (const kind of ['approval', 'submit', 'skip']) {
    const h = harness(t, { respondResult: false })
    const run = await h.send()
    const transport = h.transports[0]
    transport.control(`failed-${kind}`, kind === 'approval' ? permission() : permission('AskUserQuestion', {
      questions: [{ header: 'Choice', question: 'Which?', options: [{ label: 'First' }] }],
    }))
    await h.drain()
    const pending = kind === 'approval' ? h.runOf(run).pendingApprovals[0] : h.runOf(run).pendingUserInputs[0]
    const body = kind === 'approval' ? { ...run, approvalId: pending.approvalId, decision: 'accept' }
      : { ...run, userInputId: pending.userInputId, action: kind, answers: [{ questionId: 'q0', optionIndex: 0 }] }
    const result = await http(h).post(kind === 'approval' ? '/chat/approval' : '/chat/user-input', body)
    assert.deepEqual([result.status, result.body.accepted, result.body.code],
      [502, false, kind === 'approval' ? 'APPROVAL_DELIVERY_FAILED' : 'USER_INPUT_DELIVERY_FAILED'])
    assert.equal(pending.status, 'pending')
    const map = kind === 'approval' ? h.chat.pendingApprovals : h.chat.pendingUserInputs
    assert.equal(map.get(pending.approvalId || pending.userInputId).status, 'pending')
    assert.deepEqual(h.codexReplies, [])
    assert.equal(transport.replies.length, 1, 'no automatic response retry')
  }
})

test('multiSelect survives public questions and original option labels reach Claude with Codex disconnected', async t => {
  const store = withStore(t)
  const h = harness(t, { store })
  const run = await h.send()
  const transport = h.transports[0]
  transport.control('question', permission('AskUserQuestion', { questions: [
    { header: 'Pick', question: 'Which?', multiSelect: true, options: [{ label: 'A, B' }, { label: 'C' }] },
    { header: 'One', question: 'Only one?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ] }))
  await h.drain()
  const pending = h.runOf(run).pendingUserInputs[0]
  assert.equal(pending.questions[0].multiSelect, true)
  assert.equal(Object.hasOwn(pending.questions[1], 'multiSelect'), false)
  const reply = answers => h.chat.replyUserInput({ ...run, userInputId: pending.userInputId, action: 'submit', answers })
  for (const optionIndices of [[], [0, 0], [-1], [2], ['0'], [0.5]]) {
    await assert.rejects(reply([{ questionId: 'q0', optionIndices }, { questionId: 'q1', optionIndex: 0 }]), { code: 'INVALID_USER_INPUT_ANSWER' })
  }
  await assert.rejects(reply([{ questionId: 'q0', optionIndices: [0], optionIndex: 1 }, { questionId: 'q1', optionIndex: 0 }]), { code: 'INVALID_USER_INPUT_ANSWER' })
  await assert.rejects(reply([{ questionId: 'q0', optionIndices: [0] }, { questionId: 'q1', optionIndices: [0, 1] }]), { code: 'INVALID_USER_INPUT_ANSWER' })
  await reply([{ questionId: 'q0', optionIndices: [0, 1] }, { questionId: 'q1', text: 'PRIVATE_TYPED_ANSWER' }])
  assert.deepEqual(transport.replies[0].write.response.response.updatedInput.answers, { 'Which?': '"A, B", C', 'Only one?': 'PRIVATE_TYPED_ANSWER' })
  assert.deepEqual(h.codexReplies, [])
  const publicState = JSON.stringify([h.events, h.chat.snapshot(), h.chat.getLocalHistory({ clientThreadId: 'ui-claude', limit: 500 })])
  assert.equal(publicState.includes('PRIVATE_TYPED_ANSWER'), false)
  transport.control('skip-question', permission('AskUserQuestion', { questions: [{ header: 'Pick', question: 'Skip?', options: [{ label: 'Yes' }] }] }))
  await h.drain()
  const skipped = h.runOf(run).pendingUserInputs.at(-1)
  await h.chat.replyUserInput({ ...run, userInputId: skipped.userInputId, action: 'skip' })
  assert.deepEqual(transport.replies.at(-1).write.response.response.updatedInput.answers, {})
  assert.deepEqual(h.codexReplies, [])
})

test('dynamic tools and denied unowned requests return to Claude, never to Codex', async t => {
  const dispatched = []
  const provider = { providerId: 'test-context', specs: () => [SPEC], dispatch: async (run, event) => {
    dispatched.push(event.tool)
    return { success: true, contentItems: [{ type: 'inputText', text: 'tool result' }] }
  } }
  const h = harness(t, { toolProviders: [provider] })
  const run = await h.send()
  const transport = h.transports[0]
  transport.control('tool-1', mcp('tools/call', { name: SPEC.name, arguments: {} }))
  await h.drain()
  assert.deepEqual(dispatched, [SPEC.name])
  assert.equal(transport.replies[0].write.response.response.mcp_response.result.content[0].text, 'tool result')
  h.chat.ownedRuns.delete(h.runOf(run))
  transport.control('tool-2', mcp('tools/call', { name: SPEC.name, arguments: {} }))
  await h.drain()
  assert.equal(transport.replies.at(-1).write.response.response.mcp_response.result.isError, true)
  assert.deepEqual(dispatched, [SPEC.name])
  assert.deepEqual(h.codexReplies, [])
  h.chat.respond(23, { decision: 'decline' })
  assert.deepEqual(h.codexReplies, [[23, { decision: 'decline' }]], 'ordinary Codex IDs retain their responder')
})

test('Claude rate limits become bounded public run events with reset time and never auto-resend', async t => {
  const store = withStore(t)
  const h = harness(t, { store })
  const run = await h.send()
  const transport = h.transports[0]
  const resetsAt = 1800000000000
  transport.message({ type: 'rate_limit_event', rate_limit_info: {
    status: 'rejected', rateLimitType: 'five_hour', resetsAt, utilization: 1,
    overageStatus: 'rejected', errorCode: 'credits_required', token: 'PRIVATE_SENTINEL',
  } })
  await h.drain()
  const state = h.runOf(run)
  assert.deepEqual(state.rateLimit, { engineId: 'claude', status: 'rejected', window: 'fiveHour', windowMinutes: 300,
    resetsAt, utilization: 1, usedPercent: 100, overageStatus: 'rejected', creditsRequired: true, autoResume: false })
  assert.equal(state.error.kind, 'quota')
  assert.equal(state.error.retryAt, resetsAt)
  assert.equal(h.events.at(-1).event, 'run.rateLimit')
  assert.equal(h.timers.length, 0, 'no quota retry or auto-resume timer')
  await h.chat.handleNotification({ method: 'egdesk/engine/rateLimit', params: {
    threadId: run.conversationId, turnId: run.runId, engineId: 'codex', status: 'allowed', secret: 'PRIVATE_SENTINEL',
  } })
  assert.equal(state.rateLimit.status, 'rejected', 'a mismatched engine cannot overwrite the limit')
  await h.complete(transport, { subtype: 'error_during_execution', is_error: true, errors: ['limited'] })
  assert.equal(state.status, 'failed')
  assert.equal(state.error.kind, 'quota')
  assert.equal(state.error.retryAt, resetsAt)
  assert.equal(transport.sent.length, 1)
  assert.equal(h.transports.length, 1)
  assert.equal(h.timers.every(timer => timer.ms === 300000), true, 'only adapter process-idle cleanup may be scheduled')
  assert.equal(JSON.stringify(h.chat.getLocalHistory({ clientThreadId: 'ui-claude', limit: 500 })).includes('PRIVATE_SENTINEL'), false)
})

test('rate-limit sanitizer keeps only bounded fields and unknown status never creates a public event', async t => {
  const h = harness(t)
  const run = await h.send()
  const params = { threadId: run.conversationId, turnId: run.runId, engineId: 'claude', status: 'allowed_warning',
    window: 'PRIVATE_SENTINEL', windowMinutes: Infinity, resetsAt: 'PRIVATE_SENTINEL', utilization: 5, usedPercent: -5,
    overageStatus: 'PRIVATE_SENTINEL', creditsRequired: 'true', credentials: 'PRIVATE_SENTINEL' }
  await h.chat.handleNotification({ method: 'egdesk/engine/rateLimit', params })
  assert.deepEqual(h.runOf(run).rateLimit, { engineId: 'claude', status: 'allowed_warning', window: null,
    windowMinutes: null, resetsAt: null, utilization: 1, usedPercent: 0, overageStatus: null, creditsRequired: false, autoResume: false })
  assert.equal(h.runOf(run).error, null)
  const before = h.events.length
  await h.chat.handleNotification({ method: 'egdesk/engine/rateLimit', params: { ...params, status: 'PRIVATE_SENTINEL' } })
  assert.equal(h.events.length, before)
  assert.equal(JSON.stringify([h.events, h.chat.snapshot()]).includes('PRIVATE_SENTINEL'), false)
  assert.equal(h.transports[0].sent.length, 1)
  assert.equal(h.timers.length, 0)
})

test('API-key refusal before thread creation is durably rejected, not left dispatching', async t => {
  const store = withStore(t)
  const h = harness(t, { store, env: { ANTHROPIC_API_KEY: 'test-only-not-a-key' } })
  await assert.rejects(h.send(), error => error.code === 'CLAUDE_API_KEY_DETECTED' && error.definite && !error.resumeRequired)
  assert.equal(h.transports.length, 0)
  assert.equal(h.chat.uncertainThreads.size, 0)
  assert.equal(store.getRequest({ clientThreadId: 'ui-claude', requestId: 'req-1' }).outcome.dispatchStatus, 'rejected')
  await assert.rejects(h.send(), { code: 'CLAUDE_API_KEY_DETECTED' }, 'in-memory replay keeps the same refusal')
  const restarted = harness(t, { store })
  assert.equal((await restarted.send()).dispatchStatus, 'rejected', 'durable replay does not send again')
  assert.equal(restarted.transports.length, 0)
})

test('ENGINE_BUSY before turn dispatch is definite, preserves other runs and permits an explicit later send', async t => {
  const store = withStore(t)
  const h = harness(t, { store, residentLimit: 1 })
  const first = await h.send()
  let failed
  await assert.rejects(h.send({ clientThreadId: 'ui-second', requestId: 'second' }), error => {
    failed = error
    return error.code === 'ENGINE_BUSY' && error.definite && !error.resumeRequired
  })
  assert.equal(h.transports.length, 1)
  assert.equal(h.runOf(first).status, 'inProgress')
  assert.equal(h.chat.uncertainThreads.has(failed.conversationId), false)
  assert.equal(store.getRequest({ clientThreadId: 'ui-second', requestId: 'second' }).outcome.dispatchStatus, 'rejected')
  await h.complete(h.transports[0])
  const later = await h.send({ clientThreadId: 'ui-second', requestId: 'second-explicit', conversationId: failed.conversationId })
  assert.equal(later.accepted, true)
  assert.equal(h.transports.length, 2)
})

test('transport startup failure remains a definite rejected dispatch', async t => {
  const store = withStore(t)
  const h = harness(t, { store, transportFailure: 'CLAUDE_NOT_FOUND' })
  await assert.rejects(h.send(), error => error.code === 'ENGINE_NOT_INSTALLED' && error.definite && !error.resumeRequired)
  assert.equal(h.chat.uncertainThreads.size, 0)
  assert.equal(h.transports[0].sent.length, 0)
  assert.equal(store.getRequest({ clientThreadId: 'ui-claude', requestId: 'req-1' }).outcome.dispatchStatus, 'rejected')
})

test('resume reconstructs original verified tools, including namespace subsets, and recorded cwd', async t => {
  const store = withStore(t)
  const original = [SPEC, { type: 'namespace', name: 'notes', description: 'Notes', tools: [spec('read')] }]
  const provider = specs => ({ providerId: 'test-context', specs: () => specs })
  const h = harness(t, { store, toolProviders: [provider(original)] })
  const first = await h.send({ cwd: CWD })
  await h.complete(h.transports[0])
  const expanded = [SPEC, spec('new_tool'), { ...original[1], tools: [...original[1].tools, spec('write')] }]
  const restarted = harness(t, { store, defaultCwd: '/work/wrong-default', toolProviders: [provider(expanded)] })
  await restarted.chat.resume({ clientThreadId: 'ui-claude', conversationId: first.conversationId })
  assert.equal(restarted.transports.length, 0, 'resume records only; does not run Claude')
  const next = await restarted.send({ conversationId: first.conversationId, requestId: 'req-2', engineId: undefined, profileEnabled: false })
  const transport = restarted.transports[0]
  assert.equal(transport.options.cwd, CWD)
  assert.equal(transport.options.resume, first.conversationId)
  const listed = transport.control('list', mcp('tools/list')).write.response.response.mcp_response.result.tools
  assert.deepEqual(listed.map(tool => tool.name), ['egdesk_list_context', 'notes__read'])
  assert.deepEqual(listed[0].inputSchema, SPEC.inputSchema)
  assert.equal(restarted.chat.threadToolManifestStatus.get(next.conversationId), 'verified')
  assert.deepEqual(restarted.codexCalls, [])
  await restarted.complete(transport)
  await assert.rejects(restarted.send({ conversationId: first.conversationId, requestId: 'wrong-cwd', cwd: '/work/other' }),
    error => error.code === 'CWD_CHANGE_UNSUPPORTED' && !error.resumeRequired)
})

test('resume fails closed on schema drift or missing recorded cwd before starting any process', async t => {
  const store = withStore(t)
  const provider = schema => ({ providerId: 'test-context', specs: () => [{ ...SPEC, inputSchema: schema }] })
  const h = harness(t, { store, toolProviders: [provider(SPEC.inputSchema)] })
  const first = await h.send()
  await h.complete(h.transports[0])
  const drifted = harness(t, { store, toolProviders: [provider({ type: 'object', additionalProperties: true })] })
  await assert.rejects(drifted.chat.resume({ clientThreadId: 'ui-claude', conversationId: first.conversationId }), { code: 'NATIVE_TOOL_MANIFEST_UNVERIFIED' })
  assert.equal(drifted.transports.length, 0)
  assert.deepEqual(drifted.codexCalls, [])
  const binding = store.listEvents('ui-claude', { limit: 500 }).events.find(event => event.event === 'native.thread.bound')
  const { cwd, ...details } = binding.details
  store.appendEvent({ clientThreadId: 'ui-claude', eventKey: 'legacy-binding-without-cwd', event: 'native.thread.bound', details, ts: Date.now() })
  const missing = harness(t, { store, toolProviders: [provider(SPEC.inputSchema)] })
  await assert.rejects(missing.chat.resume({ clientThreadId: 'ui-claude', conversationId: first.conversationId }), { code: 'NATIVE_CWD_UNVERIFIED' })
  assert.equal(missing.transports.length, 0)
})
