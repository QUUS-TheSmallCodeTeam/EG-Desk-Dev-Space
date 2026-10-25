import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { rm, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createChatEngineAuth } from './codex-bridge-engine-auth.mjs'
import { createChatHttpHandler } from './codex-bridge-http.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { createContextHttpHandler } from './egdesk-context-http.mjs'
import { createPlanToolProvider } from './egdesk-plan-tool-provider.mjs'
import { ClaudeReaderClient } from './egdesk-claude-reader.mjs'
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

function reopenableStore(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-reopen-')
  const stores = []
  const open = () => { const store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' }); stores.push(store); return store }
  t.after(async () => { for (const store of stores) store.close(); await rm(dataDir, { recursive: true, force: true }) })
  return { store: open(), reopen: () => { for (const store of stores) store.close(); return open() } }
}

function trackClaudeStarts(h) {
  const calls = []
  for (const method of ['startThread', 'startTurn']) {
    const original = h.claude[method]
    h.claude[method] = async (...args) => { calls.push(method); return original(...args) }
  }
  return calls
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

function http(h, { codexLoggedIn = false } = {}) {
  let refreshes = 0
  const auth = createChatEngineAuth({ chat: h.chat, refreshCodexAccount: async () => { refreshes++ }, getCodexAuth: () => ({ isLoggedIn: codexLoggedIn }) })
  const handler = createChatHttpHandler(h.chat, auth)
  const contextHandler = h.chat.contexts ? createContextHttpHandler(h.chat.contexts, auth) : null
  const call = async (method, path, body = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
    const url = new URL(`http://localhost${path}`)
    if (!contextHandler || !await contextHandler(req, res, url)) await handler(req, res, url)
    return res
  }
  return { refreshes: () => refreshes, call, post: (path, body) => call('POST', path, body), get: path => call('GET', path) }
}

function scopedContextHarness(t, { store = withStore(t), contextDir, readerFactory, ...options } = {}) {
  if (!contextDir) {
    contextDir = createPrivateQaTempDirectory('egdesk-claude-b2-')
    t.after(() => rm(contextDir, { recursive: true, force: true }))
  }
  const contextStore = new ImmutableContextStore({ dataDir: contextDir, allowedRoots: [contextDir] })
  let h
  const readerCalls = []
  const readerService = readerFactory?.(() => h)
  const contexts = new ContextRuntime({ store: contextStore,
    reader: { read: async input => { readerCalls.push(input); throw new Error('Codex Reader must never serve Claude') }, disconnect() {} },
    getOwnerKey: options.getOwnerKey || (() => null), getAuthority: hints => h.chat.contextAuthority(hints), schemaReady: () => true,
    ...(readerService ? { readers: { claude: readerService.reader }, getReadCapacity: readerService.getReadCapacity } : {}),
  })
  h = harness(t, { ...options, store, contexts })
  return { ...h, store, contexts, contextStore, contextDir, readerCalls, readerService }
}

const contextRoute = { engineId: 'claude', engineProfileId: 'claude-default', clientThreadId: 'ui-claude' }
const contextQuery = route => new URLSearchParams(route).toString()
async function contextIntent(api, route = contextRoute) {
  const result = await api.get(`/context/capabilities?${contextQuery(route)}`)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.match(result.body.expectedContextScope, /^[a-f0-9]{64}$/)
  return { ...route, expectedContextScope: result.body.expectedContextScope }
}
const browserCapture = (text = 'SITE_CAPTURE_MARKER\n') => ({ kind: 'browser', label: 'Explicit site selection',
  sourceRef: { resourceId: 'site-card', viewId: 'site-view', url: 'https://site.example/document', browserProfileId: 'site-profile', siteAccount: 'site-user@different.example' },
  captureScope: { type: 'selection' }, content: { text, truncated: false },
})
async function readCaptured(h, run, sourceId, { requestId = 'source-read', range, query, readerSessionId, intent = 'Read exactly the selected immutable source' } = {}) {
  const transport = h.transports.at(-1)
  transport.control(requestId, mcp('tools/call', { name: 'egdesk_read_source', arguments: { snapshotId: sourceId, intent, ...(range ? { range } : {}), ...(query ? { query } : {}), ...(readerSessionId ? { readerSessionId } : {}) } }))
  await h.drain()
  await Promise.all([...h.contexts.calls.values()])
  await h.drain()
  return transport.replies.find(reply => reply.id === requestId)?.write.response.response.mcp_response.result
}
async function selectedTurn(t, options = {}) {
  const h = scopedContextHarness(t, options)
  const api = http(h), intent = await contextIntent(api)
  const captured = await api.post('/context/captures', { ...intent, attachments: [browserCapture()] })
  assert.equal(captured.status, 201, JSON.stringify(captured.body))
  const capture = captured.body.captures[0]
  const sent = await api.post('/chat/send', { ...intent, requestId: 'selected', message: 'Read selected source', contextSnapshotIds: [capture.sourceId] })
  assert.equal(sent.body.accepted, true, JSON.stringify(sent.body))
  return { ...h, api, intent, capture, run: sent.body, owner: h.contexts.owner(h.chat.contextAuthority(contextRoute)) }
}

// This fixture supplies explicit TEST evidence to the real Reader validator;
// negative cases revoke individual native inventories. It is never wired into
// bridge readiness and does not stand in for a production security check.
const READER_MODEL = 'claude-sonnet-4-6'
function claudeReaderFixture(getHarness) {
  const state = { mode: 'verified', hold: false, inputs: [], transports: [], pending: [], entered: null }
  const getScope = () => getHarness().chat.contextAuthority(contextRoute)
  const getReadCapacity = () => {
    const scope = getScope()
    if (state.mode === 'unknown') return null
    const capacity = { status: 'verified', engineId: 'claude', source: state.mode === 'documented' ? 'documented-model-policy' : 'native-observation',
      fallback: false, model: state.mode === 'model' ? 'claude-other' : READER_MODEL, modelSelectionRevision: 'fixture-selection-1',
      engineBuild: state.mode === 'build' ? 'old-build' : '2.1.300', observedAt: Date.now(), metadataHash: sha256('test-only capacity export'),
      scope: { ...scope, ...(state.mode === 'epoch' ? { epoch: scope.epoch - 1 } : {}), ...(state.mode === 'profile' ? { engineProfileId: 'another-profile' } : {}) },
      usableContextWindow: 64000, toolOutputLimitTokens: 8192, inputOverheadTokens: 128,
      estimator: { kind: 'utf8-upper-bound', verified: true, version: 'test-only-verified-text-path' } }
    return { capacity, selection: { model: READER_MODEL, effort: 'medium', revision: 'fixture-selection-1' }, engineBuild: '2.1.300',
      usage: { usedTokens: 1500 }, readerBudget: { maxInputTokens: 24000, inputOverheadTokens: 1500 } }
  }
  const reader = new ClaudeReaderClient({ getScope, getReadCapacity,
    snapshot: () => ({ version: '2.1.300', auth: { status: 'signedIn', method: 'claudeai' } }), executablePath: '/fake/never-launched-claude', env: {},
    getIsolationProof: ({ authority }) => ({ ...authority, status: 'verified', engineBuild: '2.1.300',
      metadataHash: sha256('test-only isolated policy inventory'), expiresAt: Date.now() + 60000, hooksDisabled: true, noApiKey: true }),
    createTransport: options => {
      assert.equal(options.readerIsolation, true)
      assert.deepEqual(options.tools, [])
      assert.equal(options.resume, null)
      const transport = {
        options, closed: false,
        async start() { return { managedMcpConfig: false, initialize: { models: [{ value: READER_MODEL }] } } },
        async request(method) {
          if (method === 'mcp_status') return { mcpServers: state.mode === 'mcp' ? [{ name: 'forbidden-server' }] : [] }
          assert.equal(method, 'get_context_usage')
          return { model: READER_MODEL, maxTokens: 64000, rawMaxTokens: 64000, totalTokens: 100, memoryFiles: [], mcpTools: [], agents: [], systemTools: [], deferredBuiltinTools: [] }
        },
        sendUserMessage(text) {
          const assigned = JSON.parse(text)
          state.inputs.push({ text, assigned, sessionId: options.sessionId })
          const finish = () => {
            options.onMessage({ type: 'system', subtype: 'init', session_id: options.sessionId, uuid: randomUUID(),
              cwd: options.cwd, claude_code_version: '2.1.300', model: READER_MODEL, effort: 'medium', permissionMode: 'dontAsk', apiKeySource: 'none',
              tools: [], mcp_servers: [], skills: [], plugins: [], slash_commands: [], agents: [], capabilities: [] })
            options.onMessage({ type: 'result', subtype: 'success', session_id: options.sessionId, uuid: randomUUID(), is_error: false, num_turns: 1,
              result: JSON.stringify({ summary: 'Evidence from the assigned immutable fragment, not a task conclusion.', structure: ['Source reading'], quotes: [assigned.sourceText.slice(0, 24)] }) })
          }
          if (state.hold) { state.pending.push(finish); state.entered?.() } else queueMicrotask(finish)
        },
        async interrupt() {},
        async close() { if (!this.closed) { this.closed = true; options.onExit() } return { code: 0, signal: null } },
      }
      state.transports.push(transport)
      return transport
    },
  })
  return { reader, state, getReadCapacity }
}

async function largeClaudeTurn(t, options = {}) {
  const h = scopedContextHarness(t, { readerFactory: claudeReaderFixture, ...options })
  t.after(() => h.readerService.reader.disconnect())
  const api = http(h), intent = await contextIntent(api)
  const file = path.join(h.contextDir, 'large-original.txt')
  const original = Array.from({ length: 1900 }, (_, i) => `ORIGINAL_${i} "quoted evidence" for immutable Reader coverage and range checks.\n`).join('')
  await writeFile(file, original)
  const captured = await api.post('/context/captures', { ...intent, attachments: [{ kind: 'file', label: 'Large original', sourceRef: { path: file }, captureScope: { type: 'file' } }] })
  assert.equal(captured.status, 201, JSON.stringify(captured.body))
  const capture = captured.body.captures[0]
  await writeFile(file, 'MODIFIED_LIVE_ORIGINAL_MUST_NOT_BE_READ')
  const body = { ...intent, requestId: 'large-source', message: 'Read every captured range', model: READER_MODEL, effort: 'medium', contextSnapshotIds: [capture.sourceId] }
  const sent = await api.post('/chat/send', body)
  assert.equal(sent.body.accepted, true, JSON.stringify(sent.body))
  assert.equal(h.readerService.state.inputs.length, 0, 'capture and preflight never execute Reader')
  const owner = h.contexts.owner(h.chat.contextAuthority(contextRoute))
  for (const kind of ['packets', 'readers', 'deliveries']) assert.deepEqual(await h.contextStore.listRecords(owner, kind), [])
  return { ...h, api, intent, file, original, capture, body, run: sent.body, owner }
}

test('B3 real HTTP/store/runtime/Claude adapter/Reader retain every large-file range, exact receipts and restart history', async t => {
  const durable = reopenableStore(t)
  const h = await largeClaudeTurn(t, { store: durable.store })
  let response = await readCaptured(h, h.run, h.capture.sourceId)
  assert.notEqual(response.isError, true, JSON.stringify(response))
  let packet = JSON.parse(response.content[0].text)
  assert.equal(packet.mode, 'reader')
  assert.equal(packet.coverage.complete, false, 'four partitions are progress, not complete-file coverage')
  const sessionId = packet.reader.sessionId
  for (let i = 0; packet.coverage.continuation && i < 10; i++) {
    response = await readCaptured(h, h.run, h.capture.sourceId, { requestId: `continue-${i}`, readerSessionId: sessionId })
    assert.notEqual(response.isError, true, JSON.stringify(response))
    packet = JSON.parse(response.content[0].text)
  }
  assert.equal(packet.coverage.complete, true)
  const manifest = await h.contextStore.getRecord(h.owner, 'readers', packet.coverage.manifestId)
  const pieces = []
  for (const part of manifest.completed) {
    const record = await h.contextStore.getRecord(h.owner, 'readers', part.recordId)
    const input = JSON.parse(record.inputPayload.text)
    assert.equal(input.sourceText, h.original.slice(part.startOffset, part.endOffset))
    assert.equal(record.result.receipt.fragmentHash, sha256(input.sourceText))
    assert.equal(record.result.receipt.nativeResultId, record.result.nativeTurnId)
    pieces.push(input.sourceText)
  }
  assert.equal(pieces.join(''), h.original)
  assert.ok(h.readerService.state.inputs.every(input => !input.text.includes('MODIFIED_LIVE_ORIGINAL')))
  const bound = { ...contextRoute, conversationId: h.run.conversationId }
  const before = await h.api.get(`/context/captures/${h.capture.sourceId}?${contextQuery(bound)}&packetId=${packet.packetId}`)
  assert.equal(before.status, 200, JSON.stringify(before.body))
  assert.equal(before.body.delivered.text, response.content[0].text)
  assert.equal(before.body.delivered.hash, sha256(response.content[0].text))
  const sentCount = h.readerService.state.inputs.length
  const nativeRead = h.requests.find(request => request.params?.tool === 'egdesk_read_source')
  assert.ok(nativeRead, 'the real Claude MCP adapter emitted the native tool request')
  await h.chat.handleServerRequest(nativeRead)
  await Promise.all([...h.contexts.calls.values()])
  assert.equal(h.readerService.state.inputs.length, sentCount, 'duplicate native call never repeats Reader work')
  const refined = await readCaptured(h, h.run, h.capture.sourceId, { requestId: 'refined-purpose', readerSessionId: sessionId,
    intent: 'Inspect the original row 100 evidence from a different angle', query: 'ORIGINAL_100 ' })
  assert.notEqual(refined.isError, true, JSON.stringify(refined))
  const refinedPacket = JSON.parse(refined.content[0].text)
  assert.equal(refinedPacket.coverage.scope, 'complete-literal-query-hit-set')
  assert.equal(refinedPacket.lineage.refines, packet.packetId)
  assert.match(h.readerService.state.inputs[sentCount].assigned.sourceText, /ORIGINAL_100 /)
  assert.match(h.readerService.state.inputs[sentCount].assigned.intent, /different angle/)
  await h.complete(h.transports[0])
  const restarted = scopedContextHarness(t, { store: durable.reopen(), contextDir: h.contextDir, readerFactory: claudeReaderFixture })
  t.after(() => restarted.readerService.reader.disconnect())
  const nextApi = http(restarted)
  restarted.readerService.state.mode = 'unknown'
  const resumed = await nextApi.post('/chat/resume', bound)
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
  const after = await nextApi.get(`/context/captures/${h.capture.sourceId}?${contextQuery(bound)}&packetId=${packet.packetId}`)
  assert.equal(after.body.delivered.text, before.body.delivered.text, 'receipt restoration does not require a new read or current capacity')
  assert.equal(restarted.readerService.state.transports.length, 0)
  assert.deepEqual([...h.codexCalls, ...h.readerCalls, ...restarted.codexCalls, ...restarted.readerCalls], [])
})

test('B3 server readiness rejects unknown/stale model-profile-epoch-build evidence, ignores caller capacity, preserves B2 small reads', async t => {
  for (const mode of ['unknown', 'model', 'profile', 'epoch', 'build', 'documented']) await t.test(mode, async t => {
    const h = scopedContextHarness(t, { readerFactory: claudeReaderFixture }), api = http(h)
    h.readerService.state.mode = mode
    const capabilities = await api.get(`/context/capabilities?${contextQuery(contextRoute)}`)
    assert.equal(capabilities.body.selectedAttachments, true)
    assert.equal(capabilities.body.largeReader, false)
    assert.equal(capabilities.body.reader.code, 'ENGINE_CAPACITY_UNKNOWN')
    const intent = await contextIntent(api)
    const captured = await api.post('/context/captures', { ...intent, attachments: [browserCapture('long source '.repeat(8000))] })
    const refused = await api.post('/chat/send', { ...intent, requestId: `capacity-${mode}`, message: 'Read', contextSnapshotIds: [captured.body.captures[0].sourceId],
      contextCapabilities: { read: true, reader: false }, capacity: { usableContextWindow: 1e9 }, contextUsage: { modelContextWindow: 1e9, usedTokens: 0 } })
    assert.equal(refused.body.accepted, false)
    assert.equal(refused.body.code, 'ENGINE_CAPACITY_UNKNOWN')
    assert.equal(h.readerService.state.transports.length, 0)
    const small = await api.post('/context/captures', { ...intent, attachments: [browserCapture()] })
    const sent = await api.post('/chat/send', { ...intent, requestId: `small-${mode}`, message: 'Read short source', contextSnapshotIds: [small.body.captures[0].sourceId] })
    assert.equal(sent.body.accepted, true, JSON.stringify(sent.body))
    const read = await readCaptured(h, sent.body, small.body.captures[0].sourceId)
    assert.equal(JSON.parse(read.content[0].text).content.text, 'SITE_CAPTURE_MARKER\n')
  })
})

test('B3 real Reader rejects nonempty native MCP inventory without source send or coverage receipt', async t => {
  const h = await largeClaudeTurn(t)
  h.readerService.state.mode = 'mcp'
  const response = await readCaptured(h, h.run, h.capture.sourceId)
  assert.equal(response.isError, true)
  assert.equal(h.readerService.state.inputs.length, 0)
  for (const kind of ['packets', 'readers', 'deliveries']) assert.deepEqual(await h.contextStore.listRecords(h.owner, kind), [])
})

test('B3 stop/account/epoch/model changes suppress late Reader output; unrelated Codex reset does not', async t => {
  for (const mode of ['stop', 'account', 'epoch', 'model', 'codex-reset']) await t.test(mode, async t => {
    const h = await largeClaudeTurn(t)
    const state = h.readerService.state
    state.hold = true
    const entered = new Promise(resolve => { state.entered = resolve })
    const pending = readCaptured(h, h.run, h.capture.sourceId)
    await entered
    if (mode === 'stop') await h.chat.interrupt(h.run)
    if (mode === 'account') h.setAccount('changed@example.com')
    if (mode === 'epoch') h.chat.reset('claude')
    if (mode === 'model') state.mode = 'model'
    if (mode === 'codex-reset') h.chat.reset('codex')
    state.hold = false
    for (const finish of state.pending.splice(0)) finish()
    const response = await pending
    const deliveries = await h.contextStore.listRecords(h.owner, 'deliveries')
    assert.equal(deliveries.length, mode === 'codex-reset' ? 1 : 0)
    if (mode === 'codex-reset') assert.notEqual(response.isError, true, JSON.stringify(response))
    else assert.equal(h.events.some(event => event.event === 'context.read.completed'), false)
    assert.deepEqual(h.readerCalls, [])
  })
})

test('B2 unbound client stale capabilities cannot stamp an A-account browser intent as B before SSE arrives', async t => {
  const h = scopedContextHarness(t), api = http(h)
  const intentA = await contextIntent(api)
  // Browser capture is asynchronous. The UI still holds A's routing/token;
  // no simulated SSE update or refreshed capability is delivered to it.
  await tick()
  h.setAccount('account-b@example.com')
  const authorityB = h.chat.contextAuthority(contextRoute)
  const pending = { ...intentA, attachments: [browserCapture('ACCOUNT_A_SELECTION')] }
  const capture = await api.post('/context/captures', pending)
  assert.deepEqual([capture.status, capture.body.code], [409, 'CONTEXT_SCOPE_CHANGED'])
  await assert.rejects(h.contexts.prepare(pending, authorityB), { code: 'CONTEXT_SCOPE_CHANGED' })
  const send = await api.post('/chat/send', { ...pending, message: 'Do not silently change my account', requestId: 'stale-intent' })
  assert.deepEqual([send.status, send.body.accepted, send.body.code], [409, false, 'CONTEXT_SCOPE_CHANGED'])
  assert.deepEqual(await h.contextStore.listRecords(h.contexts.owner(authorityB), 'sources'), [])
  assert.equal(h.transports.length, 0)
  assert.deepEqual([...h.codexCalls, ...h.readerCalls], [])
  // Only an explicit new intent can capture under the now-current account.
  const intentB = await contextIntent(api)
  assert.notEqual(intentB.expectedContextScope, intentA.expectedContextScope)
  const retry = await api.post('/context/captures', { ...intentB, attachments: [browserCapture('EXPLICIT_B_SELECTION')] })
  assert.equal(retry.status, 201)
  assert.equal(h.transports.length, 0, 'capturing never auto-sends a model turn')
})

test('B2 actual Claude MCP cannot read an unselected source from this or another conversation', async t => {
  const h = await selectedTurn(t)
  for (const clientThreadId of ['ui-claude', 'other-conversation']) {
    const intent = await contextIntent(h.api, { ...contextRoute, clientThreadId })
    const captured = await h.api.post('/context/captures', { ...intent, attachments: [browserCapture(`PRIVATE_${clientThreadId}`)] })
    assert.equal(captured.status, 201)
    const response = await readCaptured(h, h.run, captured.body.captures[0].sourceId, { requestId: `unselected-${clientThreadId}` })
    assert.equal(response.isError, true)
    assert.equal(JSON.parse(response.content[0].text).error.code, 'CONTEXT_FORBIDDEN')
    assert.equal(JSON.stringify(response).includes(`PRIVATE_${clientThreadId}`), false)
  }
  assert.deepEqual(await h.contextStore.listRecords(h.owner, 'deliveries'), [])
})

test('B2 bridge-scoped Context retains Codex legacy capture, read and native-only inspection without a Claude scope token', async t => {
  const h = scopedContextHarness(t, { getOwnerKey: () => 'email:codex-owner@example.com' })
  h.chat.setConnection(true)
  const api = http(h, { codexLoggedIn: true })
  const route = { clientThreadId: 'ui-codex' }
  const captured = await api.post('/context/captures', { ...route, attachments: [browserCapture('CODEX_CAPTURE_BYTES\n')] })
  assert.equal(captured.status, 201, JSON.stringify(captured.body))
  const sourceId = captured.body.captures[0].sourceId
  const sent = await api.post('/chat/send', { ...route, message: 'Read selected source', requestId: 'codex-context', contextSnapshotIds: [sourceId], contextCapabilities: { read: true, reader: false } })
  assert.equal(sent.body.accepted, true, JSON.stringify(sent.body))
  await h.chat.handleServerRequest({ id: 123, method: 'item/tool/call', params: { threadId: sent.body.conversationId, turnId: sent.body.runId, callId: 'codex-read', tool: 'egdesk_read_source', arguments: { snapshotId: sourceId, intent: 'Read the captured source' } } })
  await h.drain()
  await Promise.all([...h.contexts.calls.values()])
  const response = h.codexReplies.find(reply => reply[0] === 123)?.[1]
  assert.equal(response?.success, true, JSON.stringify(response))
  assert.equal(JSON.parse(response.contentItems[0].text).content.text, 'CODEX_CAPTURE_BYTES\n')
  const inspected = await api.get(`/context/captures/${sourceId}?${contextQuery({ conversationId: sent.body.conversationId })}`)
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body))
  assert.equal(inspected.body.source.text, 'CODEX_CAPTURE_BYTES\n')
  assert.equal(h.transports.length, 0)
  assert.deepEqual(h.readerCalls, [])
})

test('B2 late own-engine results and failed Claude responses never acquire delivery receipts; Codex reset does not cancel Claude', async t => {
  for (const mode of ['own-epoch', 'owner-change', 'codex-reset', 'respond-false']) await t.test(mode, async t => {
    const h = await selectedTurn(t, { respondResult: mode !== 'respond-false' })
    let entered, release
    const began = new Promise(resolve => { entered = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    const originalRead = h.contextStore.readProjection.bind(h.contextStore)
    h.contextStore.readProjection = async (...args) => { entered(); await blocked; return originalRead(...args) }
    const pending = readCaptured(h, h.run, h.capture.sourceId)
    await began
    if (mode === 'own-epoch') h.chat.reset('claude')
    if (mode === 'owner-change') h.setAccount('late-account@example.com')
    if (mode === 'codex-reset') { h.chat.setConnection(false); h.chat.reset('codex') }
    release()
    const response = await pending
    const receipts = await h.contextStore.listRecords(h.owner, 'deliveries')
    if (mode === 'codex-reset') {
      assert.equal(JSON.parse(response.content[0].text).content.text, 'SITE_CAPTURE_MARKER\n')
      assert.equal(receipts.length, 1)
    } else {
      assert.equal(receipts.length, 0)
      assert.equal(h.events.some(event => event.event === 'context.read.completed'), false)
      if (mode !== 'respond-false') assert.equal(response, undefined)
      else assert.ok(h.events.some(event => event.event === 'context.read.failed' && event.details.code === 'CONTEXT_DELIVERY_FAILED'))
    }
    assert.deepEqual([...h.codexCalls, ...h.readerCalls], [])
  })
})

test('B2 resume refuses missing original source, blob, binding or Context manifest without another thread', async t => {
  for (const missing of ['source', 'blob', 'binding', 'manifest']) await t.test(missing, async t => {
    const h = await selectedTurn(t)
    await h.complete(h.transports[0])
    let file
    if (missing === 'source') file = path.join(await h.contextStore.directory(h.owner, 'sources'), `${h.capture.sourceId}.json`)
    if (missing === 'blob') file = path.join(await h.contextStore.directory(h.owner, 'blobs'), h.capture.hash)
    if (missing === 'binding') {
      const [binding] = await h.contextStore.listRecords(h.owner, 'bindings')
      file = path.join(await h.contextStore.directory(h.owner, 'bindings'), `${binding.id}.json`)
    }
    if (missing === 'manifest') {
      const [marker] = await h.contextStore.listRecords(h.owner, 'threads')
      file = path.join(await h.contextStore.directory(h.owner, 'threads'), `${marker.id}.json`)
    }
    // Explicit private test fixture only: emulate durable data loss, never a
    // production source deletion or recapture from the live page/file.
    await unlink(file)
    const restarted = scopedContextHarness(t, { store: h.store, contextDir: h.contextDir })
    const result = await http(restarted).post('/chat/resume', { ...contextRoute, conversationId: h.run.conversationId })
    assert.notEqual(result.status, 200, JSON.stringify(result.body))
    assert.equal(restarted.transports.length, 0)
    assert.equal(h.store.getConversation('ui-claude').conversationId, h.run.conversationId)
    assert.deepEqual([...restarted.codexCalls, ...restarted.readerCalls], [])
  })
})

test('B2 incomplete and over-budget captures refuse the whole selected set before dispatch, with no NativeReader fallback', async t => {
  for (const mode of ['truncated', 'too-large', 'aggregate']) await t.test(mode, async t => {
    const h = scopedContextHarness(t), api = http(h), intent = await contextIntent(api)
    const attachments = mode === 'aggregate' ? Array.from({ length: 12 }, (_, i) => browserCapture(`${i}\n${'complete selected text '.repeat(40)}`))
      : [browserCapture(mode === 'too-large' ? 'selected text '.repeat(5000) : 'partial source')]
    if (mode === 'truncated') attachments[0].content.truncated = true
    const captured = await api.post('/context/captures', { ...intent, attachments })
    if (mode === 'truncated') assert.deepEqual([captured.status, captured.body.code], [409, 'CONTEXT_CAPTURE_INCOMPLETE'])
    else assert.equal(captured.status, 201, JSON.stringify(captured.body))
    const selection = { ...intent, message: 'Read all selected materials', requestId: 'unavailable',
      ...(mode === 'truncated' ? { attachments } : { contextSnapshotIds: captured.body.captures.map(capture => capture.sourceId) }) }
    await assert.rejects(h.contexts.prepare(selection, h.chat.contextAuthority(contextRoute)), { code: mode === 'truncated' ? 'CONTEXT_CAPTURE_INCOMPLETE' : 'CLAUDE_CONTEXT_READER_UNSUPPORTED' })
    const sent = await api.post('/chat/send', selection)
    assert.equal(sent.body.accepted, false)
    assert.equal(sent.body.code, mode === 'truncated' ? 'CONTEXT_CAPTURE_INCOMPLETE' : 'CLAUDE_CONTEXT_READER_UNSUPPORTED')
    assert.equal(h.transports.length, 0)
    assert.deepEqual([...h.codexCalls, ...h.readerCalls], [])
    const owner = h.contexts.owner(h.chat.contextAuthority(contextRoute))
    assert.deepEqual(await h.contextStore.listRecords(owner, 'bindings'), [])
    assert.deepEqual(await h.contextStore.listRecords(owner, 'deliveries'), [])
  })
})

test('B2 definitive prestart refusals survive reopening both real stores and replay without any native start', async t => {
  for (const [mode, code, status] of [
    ['too-large', 'CLAUDE_CONTEXT_READER_UNSUPPORTED', 409],
    ['binary', 'UNSUPPORTED_SOURCE_FORMAT', 422],
    ['truncated', 'CONTEXT_CAPTURE_INCOMPLETE', 409],
    ['stale-scope', 'CONTEXT_SCOPE_CHANGED', 409],
    ['wrong-thread', 'CONTEXT_THREAD_MISMATCH', 403],
  ]) await t.test(mode, async t => {
    const durable = reopenableStore(t)
    const h = scopedContextHarness(t, { store: durable.store }), api = http(h), intent = await contextIntent(api)
    const starts = trackClaudeStarts(h)
    let attachments = [browserCapture(mode === 'too-large' ? 'selected text '.repeat(5000) : 'Complete selected bytes')]
    if (mode === 'binary') {
      const file = path.join(h.contextDir, 'selected.bin')
      await writeFile(file, Buffer.from([0, 255, 0, 1]))
      attachments = [{ kind: 'file', label: 'Selected binary', sourceRef: { path: file }, captureScope: { type: 'file' } }]
    }
    let selection
    if (mode === 'truncated') {
      attachments[0].content.truncated = true
      selection = { attachments }
    } else {
      const captureIntent = mode === 'wrong-thread' ? await contextIntent(api, { ...contextRoute, clientThreadId: 'other-chat' }) : intent
      const captured = await api.post('/context/captures', { ...captureIntent, attachments })
      assert.equal(captured.status, 201, JSON.stringify(captured.body))
      if (mode === 'binary') {
        assert.equal(captured.body.captures[0].hash, sha256(Buffer.from([0, 255, 0, 1])))
        assert.equal(captured.body.captures[0].shape.readable, false)
      }
      selection = { contextSnapshotIds: captured.body.captures.map(capture => capture.sourceId) }
    }
    if (mode === 'stale-scope') h.chat.reset('claude')
    const body = { ...intent, ...selection, message: 'Keep this draft if the complete selection cannot be sent', requestId: `rejected-${mode}` }
    const refused = await api.post('/chat/send', body)
    assert.deepEqual([refused.status, refused.body.accepted, refused.body.code, refused.body.dispatchStatus, refused.body.resumeRequired], [status, false, code, 'rejected', false])
    const record = h.store.getRequest({ clientThreadId: contextRoute.clientThreadId, requestId: body.requestId })
    assert.equal(record.status, 'settled')
    assert.deepEqual([record.outcome?.accepted, record.outcome?.dispatchStatus, record.outcome?.code, record.outcome?.error.code], [false, 'rejected', code, code])
    assert.equal(h.store.getConversation(contextRoute.clientThreadId).conversationId, null)
    assert.deepEqual(starts, [])
    assert.equal(h.transports.length, 0)

    const restarted = scopedContextHarness(t, { store: durable.reopen(), contextDir: h.contextDir })
    const restartStarts = trackClaudeStarts(restarted)
    // Deliberately replay the original request/token. This is an outcome
    // audit, not a fresh capture or an automatic retry against a new scope.
    const replay = await http(restarted).post('/chat/send', body)
    assert.deepEqual([replay.status, replay.body.duplicate, replay.body.accepted, replay.body.dispatchStatus, replay.body.code, replay.body.error?.code], [202, true, false, 'rejected', code, code])
    assert.equal(replay.body.conversationId, null)
    assert.deepEqual(restarted.store.getRequest({ clientThreadId: contextRoute.clientThreadId, requestId: body.requestId }).outcome, record.outcome)
    assert.deepEqual(restartStarts, [])
    assert.equal(restarted.transports.length, 0)
    assert.deepEqual([...h.codexCalls, ...h.readerCalls, ...restarted.codexCalls, ...restarted.readerCalls], [])
  })
})

test('B2-like errors after an attempted Claude dispatch remain unknown across real-store reopen', async t => {
  const durable = reopenableStore(t)
  const h = scopedContextHarness(t, { store: durable.store }), api = http(h), intent = await contextIntent(api)
  const captured = await api.post('/context/captures', { ...intent, attachments: [browserCapture()] })
  assert.equal(captured.status, 201)
  const start = h.claude.startTurn
  h.claude.startTurn = async params => {
    await start(params)
    // Inject a lost reply only AFTER the actual adapter accepted the fake
    // transport write. A familiar Context code cannot prove non-dispatch.
    throw Object.assign(new Error('Fake lost native reply'), { code: 'CLAUDE_CONTEXT_READER_UNSUPPORTED', httpStatus: 409 })
  }
  const body = { ...intent, contextSnapshotIds: [captured.body.captures[0].sourceId], message: 'Already attempted', requestId: 'ambiguous-context-code' }
  const result = await api.post('/chat/send', body)
  assert.deepEqual([result.body.accepted, result.body.dispatchStatus, result.body.resumeRequired], [false, 'unknown', true])
  assert.equal(h.transports[0].sent.length, 1)
  const record = h.store.getRequest({ clientThreadId: contextRoute.clientThreadId, requestId: body.requestId })
  assert.equal(record.outcome.dispatchStatus, 'unknown')
  await h.claude.dispose()
  await h.drain()
  const restarted = scopedContextHarness(t, { store: durable.reopen(), contextDir: h.contextDir })
  const replay = await http(restarted).post('/chat/send', body)
  assert.deepEqual([replay.status, replay.body.duplicate, replay.body.dispatchStatus], [202, true, 'unknown'])
  assert.equal(restarted.transports.length, 0)
})

test('B2 actual capture HTTP/store/runtime/Claude MCP delivers immutable bytes and exact range receipts after live change and restart', async t => {
  const h = scopedContextHarness(t)
  const api = http(h)
  const capabilities = await api.get(`/context/capabilities?${contextQuery(contextRoute)}`)
  assert.equal(capabilities.status, 200)
  assert.equal(capabilities.body.contract, 'egdesk-context-b2')
  assert.deepEqual(capabilities.body.tools, ['egdesk_list_context', 'egdesk_read_source'])
  const intent = { ...contextRoute, expectedContextScope: capabilities.body.expectedContextScope }
  const original = 'heading\nORIGINAL_CAPTURE_MARKER_7041\ntail\n'
  const file = path.join(h.contextDir, 'selected.txt')
  await writeFile(file, original)
  const captured = await api.post('/context/captures', { ...intent, attachments: [
    { kind: 'file', label: 'Selected file', sourceRef: { path: file }, captureScope: { type: 'file' } },
    browserCapture('DIFFERENT_SITE_ACCOUNT_MARKER\n'),
  ] })
  assert.equal(captured.status, 201, JSON.stringify(captured.body))
  const [capture, siteCapture] = captured.body.captures
  assert.equal(capture.hash, sha256(original))
  assert.equal(siteCapture.sourceRef.browserProfileId, 'site-profile')
  assert.equal(siteCapture.sourceRef.siteAccount, 'site-user@different.example')
  assert.equal(siteCapture.sourceRef.url, 'https://site.example/document')
  assert.equal(h.events.some(event => event.event === 'context.read.completed'), false, 'captured is not delivered/read')
  const scope = h.chat.contextAuthority(contextRoute)
  const savedSite = await h.contextStore.getCapture(h.contexts.owner(scope), siteCapture.sourceId)
  assert.equal(savedSite.sourceRef.browserProfileId, 'site-profile')
  assert.equal(savedSite.sourceRef.siteAccount, 'site-user@different.example')
  assert.deepEqual(await h.contextStore.listRecords(h.contexts.owner(scope), 'deliveries'), [])
  await writeFile(file, 'LIVE_REPLACEMENT_MARKER\n')
  const body = { ...intent, message: 'Read the selected immutable material', requestId: 'b2-first', contextSnapshotIds: [capture.sourceId, siteCapture.sourceId],
    contextCapabilities: { read: true, reader: false, publishBriefing: false } }
  const sent = await api.post('/chat/send', body)
  assert.equal(sent.status, 202, JSON.stringify(sent.body))
  assert.equal(sent.body.accepted, true)
  const run = sent.body
  const response = await readCaptured(h, run, capture.sourceId, { range: { startLine: 2, endLine: 2 } })
  assert.notEqual(response.isError, true)
  const returned = response.content[0].text
  const packet = JSON.parse(returned)
  assert.equal(packet.content.text, original.slice(packet.content.ranges[0].startOffset, packet.content.ranges[0].endOffset))
  assert.match(packet.content.text, /ORIGINAL_CAPTURE_MARKER_7041/)
  assert.equal(packet.content.text.includes('LIVE_REPLACEMENT_MARKER'), false)
  assert.equal(packet.sourceHash, capture.hash)
  assert.equal(packet.coverage.scope, 'line-range')
  assert.deepEqual(packet.coverage.reviewedRanges, packet.content.ranges)
  const receipts = await h.contextStore.listRecords(h.contexts.owner(scope), 'deliveries')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].deliveryHash, sha256(returned))
  assert.equal(receipts[0].binding.runId, run.runId)
  const site = await readCaptured(h, run, siteCapture.sourceId, { requestId: 'site-read' })
  assert.equal(JSON.parse(site.content[0].text).content.text, 'DIFFERENT_SITE_ACCOUNT_MARKER\n', 'site account need not match Claude subscription account')
  await h.complete(h.transports[0])
  const restarted = scopedContextHarness(t, { store: h.store, contextDir: h.contextDir })
  const nextApi = http(restarted)
  const bound = { ...contextRoute, conversationId: run.conversationId }
  const resumed = await nextApi.post('/chat/resume', bound)
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
  assert.equal(restarted.transports.length, 0)
  const siteAfterRestart = await nextApi.get(`/context/captures/${siteCapture.sourceId}?${contextQuery(bound)}`)
  assert.equal(siteAfterRestart.status, 200)
  assert.equal(siteAfterRestart.body.capture.sourceRef.browserProfileId, 'site-profile')
  assert.equal(siteAfterRestart.body.capture.sourceRef.siteAccount, 'site-user@different.example')
  const next = await nextApi.post('/chat/send', { ...body, ...await contextIntent(nextApi, bound), requestId: 'b2-next' })
  assert.equal(next.body.accepted, true, JSON.stringify(next.body))
  const readAgain = await readCaptured(restarted, next.body, capture.sourceId)
  assert.equal(JSON.parse(readAgain.content[0].text).content.text, original)
  assert.equal(restarted.transports[0].options.resume, run.conversationId)
  assert.equal(restarted.transports[0].options.cwd, CWD)
  assert.deepEqual([...h.codexCalls, ...restarted.codexCalls, ...h.readerCalls, ...restarted.readerCalls], [])
  assert.equal(api.refreshes() + nextApi.refreshes(), 0)
  assert.equal(h.chat.connection, 'offline')
})

test('B2 actual Context HTTP rejects forged authority and cross-thread/engine sources before any Claude dispatch', async t => {
  const h = scopedContextHarness(t, { getOwnerKey: () => OWNER })
  h.chat.setConnection(true)
  const api = http(h, { codexLoggedIn: true })
  for (const forged of [{ ownerKey: OWNER }, { epoch: 0 }, { authority: { ...contextRoute, ownerKey: OWNER, epoch: 0 } }]) {
    const rejected = await api.post('/context/captures', { ...contextRoute, attachments: [browserCapture()], ...forged })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.code, 'INVALID_CONTEXT_ROUTE')
  }
  const captured = await api.post('/context/captures', { ...await contextIntent(api), attachments: [browserCapture()] })
  assert.equal(captured.status, 201, JSON.stringify(captured.body))
  const sourceId = captured.body.captures[0].sourceId
  const codex = await api.get(`/context/captures/${sourceId}?${contextQuery({ engineId: 'codex', engineProfileId: 'codex-default', clientThreadId: 'ui-claude' })}`)
  assert.notEqual(codex.status, 200, 'identical raw ownerKey still cannot cross engines')
  const crossThread = await api.post('/chat/send', { ...await contextIntent(api, { ...contextRoute, clientThreadId: 'ui-other' }), message: 'Not selected for this conversation', requestId: 'cross-thread', contextSnapshotIds: [sourceId], contextCapabilities: { read: true } })
  assert.equal(crossThread.body.accepted, false)
  assert.equal(h.transports.length, 0)
  assert.deepEqual(h.codexCalls, [])
  h.setAccount('different-account@example.com')
  const wrongAccount = await api.get(`/context/captures/${sourceId}?${contextQuery(contextRoute)}`)
  assert.notEqual(wrongAccount.status, 200)
})

test('B2 existing stored conversation owner is checked before capability, capture and inspect even with the same profile id', async t => {
  const h = scopedContextHarness(t)
  const api = http(h)
  const first = await h.send()
  await h.complete(h.transports[0])
  const bound = { ...contextRoute, conversationId: first.conversationId }
  assert.equal(h.chat.contextAuthority({ conversationId: first.conversationId }).clientThreadId, 'ui-claude', 'native-only inspector routing resolves its verified local binding')
  const wrongEngine = await api.get(`/context/capabilities?${contextQuery({ ...bound, engineId: 'codex' })}`)
  assert.deepEqual([wrongEngine.status, wrongEngine.body.code], [409, 'ENGINE_MISMATCH'])
  const wrongProfile = await api.get(`/context/capabilities?${contextQuery({ ...bound, engineProfileId: 'another-profile' })}`)
  assert.deepEqual([wrongProfile.status, wrongProfile.body.code], [403, 'ENGINE_PROFILE_MISMATCH'])
  const capture = await api.post('/context/captures', { ...await contextIntent(api, bound), attachments: [browserCapture()] })
  assert.equal(capture.status, 201)
  const sourceId = capture.body.captures[0].sourceId
  h.setAccount('changed-owner@example.com')
  assert.throws(() => h.chat.contextAuthority(bound), { code: 'NATIVE_ACCOUNT_MISMATCH' })
  for (const action of [
    () => api.get(`/context/capabilities?${contextQuery(bound)}`),
    () => api.post('/context/captures', { ...bound, attachments: [browserCapture()] }),
    () => api.get(`/context/captures/${sourceId}?${contextQuery(bound)}`),
  ]) {
    const result = await action()
    assert.deepEqual([result.status, result.body.code], [403, 'NATIVE_ACCOUNT_MISMATCH'])
  }
  const unsent = await api.post('/context/captures', { ...await contextIntent(api, { ...contextRoute, clientThreadId: 'new-unsent' }), attachments: [browserCapture()] })
  assert.equal(unsent.status, 201, 'new unsent chat uses the current Claude account')
  assert.equal(api.refreshes(), 0)
})

test('B2 unsupported Reader and original empty manifest refuse attachments without fallback or another native turn', async t => {
  const store = withStore(t)
  const old = harness(t, { store })
  const first = await old.send()
  await old.complete(old.transports[0])
  const h = scopedContextHarness(t, { store })
  const api = http(h)
  const intent = await contextIntent(api)
  const captured = await api.post('/context/captures', { ...intent, attachments: [browserCapture()] })
  assert.equal(captured.status, 201)
  const ids = captured.body.captures.map(capture => capture.sourceId)
  const selection = { ...intent, conversationId: first.conversationId, message: 'Read selected source', contextSnapshotIds: ids, contextCapabilities: { read: true } }
  const reader = await api.post('/chat/send', { ...selection, requestId: 'reader', contextCapabilities: { read: true, reader: true } })
  assert.deepEqual([reader.status, reader.body.accepted, reader.body.code], [409, false, 'CLAUDE_CONTEXT_READER_UNSUPPORTED'])
  const unavailable = await api.post('/chat/send', { ...selection, requestId: 'empty-manifest' })
  assert.equal(unavailable.body.accepted, false)
  assert.equal(unavailable.body.code, 'CONTEXT_TOOLS_UNAVAILABLE')
  assert.equal(h.transports.length, 0)
  assert.deepEqual([...h.codexCalls, ...h.readerCalls], [])
  assert.deepEqual(h.chat.threadToolManifests.get(first.conversationId), [], 'original empty catalog is not widened')
})

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
