import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { Readable } from 'node:stream'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createEGDeskFileMount } from './egdesk-file-mount.mjs'
import { createEGDeskFileHttpAdapter, EGDESK_FILE_ENDPOINTS } from './egdesk-file-http.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { openBridgeSettings } from './egdesk-bridge-settings.mjs'
import { openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createAccountAccessTracker, createChatHttpHandler } from './codex-bridge-http.mjs'
import { accountAccessState, publicAuthIdentityKey } from './codex-auth-state.mjs'
import { chatError } from './codex-chat-values.mjs'
import { AppServerRpc } from './codex-app-server-rpc.mjs'

// Never import or boot the production entrypoint. Only these explicitly
// bounded service-wiring blocks run in a VM with fake server/process/native
// adapters. The file, context, chat and workflow modules below are real, with
// app data confined to each test's own directory. No socket or OS watcher opens.
const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
function block(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `missing bounded wiring block: ${start}`)
  return source.slice(from, to)
}
const rootSetup = block('let workflow = null', 'const contextStore = new ImmutableContextStore({')
const contextReplay = block('for (const root of pendingFileRoots.values()) contexts.noteRoot(root)', 'const browserTransport =')
const serviceAttachment = block('const detachContextServices = contexts.attachServices(', 'if (workflow.snapshot().taskError)')
const shutdownBlock = block('let shuttingDown = false', "process.on('SIGINT', shutdown)")
const resolverExpression = source.match(/^  resolveProjectWorkspace: (request => localFiles\.resolveProjectWorkspace\(request\)),\s*$/m)?.[1]
assert.ok(resolverExpression, 'the production Chat constructor must inject the file-mount resolver')
const originResolverExpression = source.match(/^  resolveRunProjectOrigin: (request => localFiles\.resolveRunProjectOrigin\(request\)),\s*$/m)?.[1]
assert.ok(originResolverExpression, 'the production Chat constructor must inject the read-only origin resolver')

// Execute the real request boundary and auth broadcast wiring, not the
// entrypoint. All RPCs are deferred synthetic replies; no process or socket.
function accessRequestHarness({ memoryRpc = false } = {}) {
  const authState = { isLoggedIn: true, accountEmail: 'owner@example.test', accessFailure: null, rateLimits: null }
  const calls = [], pending = [], events = [], effects = [], frames = []
  const connection = () => {
    if (memoryRpc) {
      const rpc = new AppServerRpc({ send: frame => frames.push(JSON.parse(frame)) })
      rpc.ready = true // a synthetic ready connection; request/receive are real
      return rpc
    }
    return { request(method, params) {
      calls.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'native-thread' } })
      return new Promise((resolve, reject) => pending.push({ method, resolve, reject }))
    } }
  }
  const sandbox = vm.createContext({ authState, rpc: connection(), appServerReady: true, createAccountAccessTracker,
    publicAuthIdentityKey, accountAccessState, chatError, usageDisplay: () => null,
    broadcast: event => events.push(structuredClone(event)), BRIDGE_PROTOCOL_VERSION: 1, PROVIDER_ID: 'codex',
    workflow: { observeAuth: value => effects.push(['observe', value]) }, engineStatus: { check: () => effects.push(['engine']) },
  })
  const epoch = source.match(/^let accountAccessEpoch = 0$/m)?.[0] || ''
  vm.runInContext(`${epoch}\n${block('const accessTracker = createAccountAccessTracker(', '\nfunction authSnapshot()')}\n`
    + `${block('function authSnapshot()', '\nfunction authStatusTextFor(')}\n`
    + `${block('function emitAuthStatus()', '\nfunction emitAuthLifecycle(')}\n`
    + `${block('function modelAccountKey(', '\nfunction appServerRequest(')}\n`
    + `${block('function appServerRequest(', '\nasync function refreshAccountState(')}\n`
    + 'this.request = appServerRequest; this.update = updateAuthState; this.snapshot = authSnapshot;', sandbox)
  return { state: authState, calls, pending, events, effects, frames, request: sandbox.request, update: sandbox.update, snapshot: sandbox.snapshot,
    get rpc() { return sandbox.rpc },
    replace: () => { sandbox.rpc = connection() }, offline: () => { sandbox.appServerReady = false } }
}

test('SUB-14 service request boundary publishes immediate turn/start rejections to auth.status and the state snapshot', async () => {
  for (const [message, expected] of [['Usage limit reached', 'quotaExhausted'], ['Unauthorized', 'authFailed'], ['Permission denied', 'permissionDenied']]) {
    const h = accessRequestHarness(), params = { threadId: 'native-thread', input: [{ type: 'text', text: 'synthetic request' }] }
    const before = structuredClone(params), failure = Object.assign(new Error(message), { code: -32000 })
    assert.equal(h.snapshot().access.state, 'ok')
    const result = h.request('turn/start', params)
    h.pending[0].reject(failure)
    await assert.rejects(result, error => error === failure)
    assert.equal(h.snapshot().access.state, expected)
    assert.equal(h.events.find(event => event.type === 'auth.status')?.status.access.state, expected)
    assert.equal(h.events.find(event => event.type === 'auth-status')?.status.access.state, expected)
    assert.deepEqual(h.calls, [{ method: 'turn/start', params: before }], 'same request, once only')
    assert.deepEqual(params, before)
  }
})

test('SUB-14 service request boundary fences account transitions, replaced connections and offline late rejections', async () => {
  for (const change of ['account', 'account-roundtrip', 'signout', 'connection', 'offline']) {
    const h = accessRequestHarness(), failure = Object.assign(new Error('Unauthorized'), { code: -32000 })
    const result = h.request('turn/start', { threadId: 'native-thread' })
    if (change === 'account' || change === 'account-roundtrip') h.update({ accountEmail: 'other@example.test' })
    if (change === 'account-roundtrip') h.update({ accountEmail: 'owner@example.test' })
    if (change === 'signout') h.update({ isLoggedIn: false, accountEmail: null })
    if (change === 'connection') h.replace()
    if (change === 'offline') h.offline()
    const previousEvents = h.events.length
    h.pending[0].reject(failure)
    await assert.rejects(result, error => error === failure)
    assert.equal(h.state.accessFailure, null, change)
    assert.equal(h.events.length, previousEvents, 'late rejection emits no new account state')
  }
})

test('SUB-14 service HTTP failure keeps the original turn/start rejection while exposing the new account state, without retry', async () => {
  const h = accessRequestHarness()
  const chat = new CodexChatRuntime({ request: h.request, respond: () => assert.fail('no callback or automatic retry'), getOwnerKey: () => publicAuthIdentityKey(h.state) })
  chat.setConnection(true)
  const handler = createChatHttpHandler(chat, async () => {})
  const body = { message: 'Synthetic request', requestId: 'ui-request', clientThreadId: 'ui-thread' }
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
  const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
  const sending = handler(req, res, new URL('http://localhost/chat/send'))
  await until(() => h.pending.some(call => call.method === 'turn/start'))
  h.pending.find(call => call.method === 'turn/start').reject(Object.assign(new Error('You have hit your usage limit.'), { code: -32000 }))
  await sending
  assert.equal(res.status, 400)
  assert.deepEqual({ accepted: res.body.accepted, conversationId: res.body.conversationId, requestId: res.body.requestId, error: res.body.error },
    { accepted: false, conversationId: 'native-thread', requestId: 'ui-request', error: 'You have hit your usage limit.' })
  assert.equal(h.snapshot().access.state, 'quotaExhausted')
  assert.deepEqual(h.calls.map(call => call.method), ['thread/start', 'turn/start'])
})

async function memoryAccessRejection(h, message) {
  const rpc = h.rpc, request = rpc.request.bind(rpc)
  let original = null
  rpc.request = (...args) => request(...args).catch(error => { original = error; throw error })
  const rejected = h.request('turn/start', { threadId: 'native-thread', input: [] })
  const frame = h.frames.at(-1)
  assert.equal(frame.method, 'turn/start')
  rpc.receive(JSON.stringify({ id: frame.id, error: { code: -32000, message,
    data: { codexErrorInfo: 'usageLimitExceeded', privateDetail: 'synthetic-sensitive-payload' } } }))
  await assert.rejects(rejected, error => {
    assert.equal(error, original, 'the account observer rethrows the very same transport Error')
    assert.equal(error.code, -32000)
    assert.equal(error.message, message)
    assert.deepEqual(Object.keys(error), ['code'], 'no new transport error.data policy')
    return true
  })
  assert.equal(h.frames.length, 1, 'one RPC, no automatic retry')
  assert.equal(rpc.pending.size, 0)
  rpc.close()
}

test('SUB-14 memory RPC: ambiguous lookup and transport diagnostics never assert an account rejection', async () => {
  for (const message of [
    'usage limit lookup timed out',
    'rate limit read failed',
    'Failed to fetch quota exceeded status',
    'Unauthorized status lookup failed',
    'Could not check whether token expired',
    'Permission denied while writing to socket',
    'Access denied response stream disconnected',
    'Permission check failed: forbidden result is unavailable',
    'Usage limit information unavailable',
    'Rate limit reached status could not be read',
    'Could not determine whether token expired',
    'Unauthorized status lookup returned unknown',
    'You have not hit your usage limit',
    'The quota has not been exceeded',
  ]) for (const existingFailure of [false, true]) {
    const h = accessRequestHarness({ memoryRpc: true })
    if (existingFailure) h.state.accessFailure = { kind: 'auth', cause: 'unauthorized', at: 2_000_000, identity: 'email:owner@example.test' }
    const before = structuredClone(h.state), access = h.snapshot().access.state
    await memoryAccessRejection(h, message)
    assert.deepEqual(h.state, before, 'an RPC error code and account-related words are not evidence of account exhaustion or denial')
    assert.equal(h.snapshot().access.state, access)
    assert.deepEqual(h.events, [], 'diagnostic text never enters account-state broadcasts')
  }
})

test('SUB-14 memory RPC: explicit quota, auth and permission rejection controls still publish only allowlisted account state', async () => {
  for (const [message, expected] of [
    ['You have hit your usage limit.', 'quotaExhausted'], ['Usage limit reached', 'quotaExhausted'],
    ['Rate limit exceeded', 'quotaExhausted'], ['Quota exceeded', 'quotaExhausted'],
    ['Unauthorized', 'authFailed'], ['Token has expired', 'authFailed'],
    ['Permission denied by policy', 'permissionDenied'], ['Access denied', 'permissionDenied'],
  ]) {
    const h = accessRequestHarness({ memoryRpc: true })
    await memoryAccessRejection(h, message)
    assert.equal(h.snapshot().access.state, expected)
    assert.equal(h.events.find(event => event.type === 'auth.status')?.status.access.state, expected)
    const publicState = JSON.stringify([h.state, h.events])
    assert.equal(publicState.includes(message), false, 'the raw RPC error is not copied into account state')
    assert.equal(publicState.includes('synthetic-sensitive-payload'), false)
    assert.equal(h.state.accessFailure.cause, null, 'error.data is still neither forwarded nor interpreted')
  }
})

const accessDeclarations = [
  ['quota exceeded', 'quotaExhausted'], ['rate limit reached', 'quotaExhausted'],
  ['Unauthorized', 'authFailed'], ['Permission denied by policy', 'permissionDenied'],
]

test('SUB-14 clause RPC: a leading rejection cause is distinct from later advice, regardless of advice topic', async () => {
  for (const [declaration, expected] of accessDeclarations) for (const message of [
    `Request failed: ${declaration}. Please check your plan.`,
    `${declaration}. Please check your usage limit.`,
    `  Request   failed : ${declaration}! Please sign in again.  `,
  ]) {
    const h = accessRequestHarness({ memoryRpc: true })
    await memoryAccessRejection(h, message)
    assert.equal(h.snapshot().access.state, expected, 'only the declaration, never the advice topic, determines the account cause')
    assert.equal(h.events.find(event => event.type === 'auth.status')?.status.access.state, expected)
    assert.equal(JSON.stringify([h.state, h.events]).includes(message), false)
  }
})

test('SUB-14 clause RPC: quoted retrieval subjects, unknown envelopes and unverified statements remain unclassified', async () => {
  for (const [declaration] of accessDeclarations) for (const message of [
    `Failed to retrieve '${declaration}' status.`,
    `Failed to retrieve "${declaration}" status.`,
    `Failed to retrieve \`${declaration}\` status.`,
    `Failed to retrieve “${declaration}” status.`,
    `Request failed: '${declaration}'. Please check your plan.`,
    `Could not determine whether ${declaration}.`,
    `Unverified diagnostic: ${declaration}.`,
    `Status lookup failed: ${declaration}.`,
    `Please check your plan. ${declaration}.`,
    `${declaration}. The result could not be verified.`,
    `${declaration}?`,
    `Request failed: '${declaration}`,
  ]) for (const existingFailure of [false, true]) {
    const h = accessRequestHarness({ memoryRpc: true })
    if (existingFailure) h.state.accessFailure = { kind: 'auth', cause: 'unauthorized', at: 2_000_000, identity: 'email:owner@example.test' }
    const before = structuredClone(h.state)
    await memoryAccessRejection(h, message)
    assert.deepEqual(h.state, before, 'unsupported syntax is not guessed into account authority')
    assert.deepEqual(h.events, [])
  }
})

async function harness(t, { constructionRoots = false, failingUnsubscribe = false, unavailableTasks = false,
  unavailableOntology = false, failingOntologyClose = false, durable = false } = {}) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'egdesk-bridge-services-')))
  const root = path.join(temp, 'project'), otherRoot = path.join(temp, 'room-project')
  const dataDir = path.join(temp, 'state')
  await mkdir(root); await mkdir(otherRoot)
  const sourceFile = path.join(root, 'source.txt')
  await writeFile(sourceFile, 'original selected bytes\n')
  const calls = [], events = [], lifecycle = [], warnings = [], projectRequests = [], searched = []
  const watchers = new Map()
  const selections = new Map([['pick-project', root], ['pick-room', otherRoot]])
  let adapter, localFiles, workflow, chat, onRootRegistered, durableChatStore, wired = false
  let owner = 'engine-account-a', requestSeq = 0, threadSeq = 0, turnSeq = 0
  const bridgeSettings = openBridgeSettings({ dataDir: path.join(dataDir, 'settings') })
  const deskStore = {
    searchBoards({ query }) { searched.push(query); return { boards: [{ boardId: 'board-evidence', title: 'Selected evidence', lifecycle: 'active' }] } },
    close() { lifecycle.push('desk.close') },
  }
  const sandbox = vm.createContext({
    dataDir, BRIDGE_PORT: 0, bridgeSettings, deskStore,
    console: { error: message => warnings.push(message) },
    createEGDeskFileMount(options) {
      onRootRegistered = options.onRootRegistered
      if (constructionRoots) onRootRegistered({ rootId: 'before-context', absolutePath: root })
      localFiles = createEGDeskFileMount({ ...options,
        createNativeAdapter: () => ({ capability: 'unavailable', createFile: () => assert.fail('no native file operation') }),
        createHttpAdapter: configuration => {
          assert.equal(configuration.localOwnerScope, 'egdesk-local')
          adapter = createEGDeskFileHttpAdapter({ ...configuration,
            gitReview: Object.fromEntries(['listFiles', 'grep', 'status', 'changes', 'fileDiff'].map(name => [name, () => assert.fail(`no Git operation: ${name}`)])),
            resolveRootSelection: async ({ selectionId, ownerScope }) => {
              assert.equal(ownerScope, 'egdesk-local')
              assert.ok(selections.has(selectionId), 'only a test-owned picker grant is accepted')
              return selections.get(selectionId)
            },
          })
          const resolve = adapter.resolveProjectWorkspace
          adapter.resolveProjectWorkspace = request => { projectRequests.push(request); return resolve(request) }
          return adapter
        },
      })
      const close = localFiles.close
      localFiles.close = async () => { lifecycle.push('files.close'); await close() }
      return localFiles
    },
    boardAgentAsk: { close() {} },
    bridgeServer: { close: () => lifecycle.push('server.close') },
    systemResourceMonitor: { close: () => lifecycle.push('monitor.close') },
    codexEngine: { dispose: async () => lifecycle.push('codex.dispose') },

    claudeEngine: { dispose: async () => lifecycle.push('engine.dispose') },
    chatStore: { close: () => lifecycle.push('chat.close') },
    profileStore: { close: () => lifecycle.push('profiles.close') },
    ontologyStore: unavailableOntology ? null : { close() {
      lifecycle.push('ontology.close')
      if (failingOntologyClose) throw new Error('test ontology close failure')
    } },
    process: { exit: code => lifecycle.push(`exit:${code}`) },
  })
  t.after(async () => {
    try { if (wired) await vm.runInContext('shutdown()', sandbox) }
    finally {
      try { await workflow?.close() }
      finally { try { await localFiles?.close(); durableChatStore?.close() } finally { await rm(temp, { recursive: true, force: true }) } }
    }
  })
  vm.runInContext(rootSetup, sandbox)
  const store = new ImmutableContextStore({ dataDir, allowedRoots: [root], managedFileView: localFiles.managedFileView })
  const contexts = new ContextRuntime({ store, reader: null, getOwnerKey: () => owner, getAuthority: hints => chat.contextAuthority(hints) })
  sandbox.providedContexts = contexts
  vm.runInContext(`contexts = providedContexts\n${contextReplay}`, sandbox)
  const resolver = vm.runInContext(`(${resolverExpression})`, sandbox)
  const originResolver = vm.runInContext(`(${originResolverExpression})`, sandbox)
  if (durable) durableChatStore = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: 'service-wiring' })
  chat = new CodexChatRuntime({ contexts, store: durableChatStore, getOwnerKey: () => owner, resolveProjectWorkspace: resolver, resolveRunProjectOrigin: originResolver,
    respond: () => assert.fail('no native tool or Reader response expected'),
    emit: event => { events.push(event); workflow?.onChatEvent(event) },
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `thread-${++threadSeq}` }, cwd: params.cwd || root, model: 'fixture-model' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: params.cwd || root }
      if (method === 'turn/start') return { turn: { id: `turn-${++turnSeq}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      assert.fail(`unexpected fake engine request: ${method}`)
    },
  })
  chat.setConnection(true)
  const opening = openWorkflowRuntime({ dataDir, chat, port: 0, broadcast: event => events.push(event),
    ensureAuth: async () => assert.fail('no workflow task may authenticate'), getOwnerKey: () => owner,
    watch: (folder, _options, change) => {
      const watcher = { change, closed: false, on() {}, close() { this.closed = true } }
      watchers.set(folder, watcher)
      return watcher
    },
    ...(unavailableTasks ? { openStores: async () => { throw new Error('test task storage unavailable') } } : {}),
  })
  if (constructionRoots) onRootRegistered({ rootId: 'during-workflow', absolutePath: otherRoot })
  workflow = await opening
  const subscribe = workflow.bus.subscribe.bind(workflow.bus)
  workflow.bus.subscribe = (...args) => {
    const unsubscribe = subscribe(...args)
    return () => {
      lifecycle.push('context.detach')
      unsubscribe()
      if (failingUnsubscribe) throw new Error('test unsubscribe failure')
    }
  }
  const closeWorkflow = workflow.close
  workflow.close = async () => { lifecycle.push('workflow.close'); await closeWorkflow() }
  sandbox.providedWorkflow = workflow
  vm.runInContext(`workflow = providedWorkflow\n${serviceAttachment}\n${shutdownBlock}`, sandbox)
  wired = true
  const file = async (operation, body) => {
    const result = await adapter.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS[operation], body })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    return result.body.result
  }
  const send = async (body = {}) => {
    const accepted = await chat.send({ message: 'Use the selected evidence', requestId: `send-${++requestSeq}`, clientThreadId: 'room-1', cwd: root, ...body })
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: accepted.conversationId,
      turn: { id: accepted.runId, status: 'completed', items: [], itemsView: 'notLoaded' } } })
    return accepted
  }
  return { temp, root, otherRoot, sourceFile, dataDir, store, contexts, chat, workflow, localFiles, adapter,
    bridgeSettings, deskStore, calls, events, lifecycle, warnings, projectRequests, searched, watchers, file, send,
    onRootRegistered, pendingRoots: () => vm.runInContext('pendingFileRoots.size', sandbox),
    shutdown: () => vm.runInContext('shutdown()', sandbox),
    owner: () => owner, changeOwner: next => { owner = next; chat.reset() },
  }
}

const capabilities = { read: true, reader: false, publishBriefing: true }
const tracked = (h, sourceId) => [...h.contexts.allTrackedSources()].find(entry => entry.sourceId === sourceId)
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('expected fake-watcher event was not delivered')
}

test('service integration: roots registered before Context and during workflow construction reach both real consumers', async t => {
  const h = await harness(t, { constructionRoots: true })
  assert.equal(h.contexts.rootPathOf('before-context'), h.root)
  assert.equal(h.contexts.rootPathOf('during-workflow'), h.otherRoot)
  assert.deepEqual([...h.watchers.keys()].sort(), [h.root, h.otherRoot].sort())
  assert.equal(h.workflow.snapshot().watchedRoots, 2)
  assert.equal(h.pendingRoots(), 0)
  const later = await h.adapter.registerAuthorizedRoot({ absolutePath: h.root })
  assert.equal(h.contexts.rootPathOf(later.rootId), h.root)
  assert.equal(h.workflow.snapshot().watchedRoots, 2, 'same folder reuses its OS watcher')
  assert.equal(h.pendingRoots(), 0, 'normal registration does not retain construction backlog')
  assert.equal(h.calls.length, 0)
})

test('service integration: persisted suggestions and Board search attach to the workflow without sending a model turn', async t => {
  const h = await harness(t)
  assert.equal(h.contexts.suggestSettings, h.bridgeSettings.contextSuggest)
  assert.equal(h.contexts.boards, h.deskStore)
  const saved = h.contexts.setSuggestSettings({ mode: 'firstMessage', neverSuggest: [{ kind: 'site', host: 'private.example' }] })
  assert.equal(saved.persisted, true)
  assert.deepEqual(openBridgeSettings({ dataDir: path.join(h.dataDir, 'settings') }).contextSuggest.value,
    { mode: 'firstMessage', neverSuggest: [{ kind: 'site', host: 'private.example' }] })
  assert.deepEqual(h.contexts.resolve({ firstMessage: true, query: 'evidence' }).candidates.map(item => item.ref), ['board-evidence'])
  assert.deepEqual(h.searched, ['evidence'])
  h.contexts.setSuggestSettings({ mode: 'off' })
  assert.deepEqual(h.contexts.resolve({ firstMessage: true, query: 'evidence' }).candidates, [])
  assert.deepEqual(h.searched, ['evidence'], 'off does not search or silently include anything')
  assert.equal(h.calls.length, 0)
  assert.equal(h.contexts.pendingSources.size, 0)
})

test('service integration: verified Board/room project cwd reaches fake Chat RPCs while file ownership stays local across engine accounts', async t => {
  const h = await harness(t)
  const project = await h.file('attachProject', { boardId: 'board-1', selectionId: 'pick-project' })
  await h.file('attachProject', { boardId: 'board-1', roomId: 'room-2', selectionId: 'pick-room' })
  await h.send({ boardId: 'board-1' })
  assert.equal(h.calls.find(call => call.method === 'thread/start').params.cwd, h.root)
  assert.equal(h.calls.find(call => call.method === 'turn/start').params.cwd, h.root)
  h.changeOwner('engine-account-b')
  await h.send({ clientThreadId: 'room-2', boardId: 'board-1' })
  assert.equal(h.calls.filter(call => call.method === 'thread/start').at(-1).params.cwd, h.otherRoot)
  assert.equal(h.calls.filter(call => call.method === 'turn/start').at(-1).params.cwd, h.otherRoot)
  assert.equal(h.localFiles.managedFileView.ownerScope, 'egdesk-local')
  for (const request of h.projectRequests) {
    assert.deepEqual(Object.keys(request).sort(), ['boardId', 'ownerScope', 'roomId'])
    assert.equal(request.ownerScope, 'egdesk-local')
  }
  const forged = await h.localFiles.resolveProjectWorkspace({ boardId: 'board-1', roomId: 'room-1', ownerScope: 'engine-account-b', absolutePath: h.otherRoot })
  assert.equal(forged.projectId, project.projectId)
  assert.equal(forged.absolutePath, h.root)
  assert.deepEqual(h.store.allowedRoots, [h.root], 'project cwd does not rewrite context file authorization')
  assert.ok(h.calls.every(call => !Object.hasOwn(call.params, 'allowedRoots')), 'no new permission field is sent')
})

test('service integration: saved defaults and accepted immutable origins traverse production mount/runtime/HTTP wiring without extra permissions or provider reads', async t => {
  const h = await harness(t, { durable: true })
  const a = await h.file('attachProject', { boardId: 'a', selectionId: 'pick-project' })
  const b = await h.file('attachProject', { boardId: 'b', selectionId: 'pick-room' })
  const save = (boardId, project) => h.file('saveRoomProjectDefault', { roomId: 'room-1', boardId, expectedProjectId: project.projectId, expectedRootId: project.rootId })
  await save('a', a)
  const first = await h.chat.send({ clientThreadId: 'room-1', requestId: 'first-default', message: 'Start in A' })
  await save('b', b)
  assert.equal(h.chat.snapshot(first.conversationId).runs[0].cwdPublic, h.root)
  const handler = createChatHttpHandler(h.chat, async () => assert.fail('origin reads never authenticate with a provider'))
  const readOrigin = async run => {
    const url = new URL(`http://localhost/chat/run-project-origin?conversationId=${run.conversationId}&runId=${run.runId}`)
    const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
    assert.equal(await handler({ method: 'GET' }, res, url), true)
    return res
  }
  const publicMetadata = origin => ({ rootId: origin.rootId, directoryId: origin.directoryId, displayPath: origin.displayPath })
  let before = h.calls.length
  assert.deepEqual(publicMetadata((await readOrigin(first)).body), publicMetadata(a))
  assert.equal(h.calls.length, before)
  await h.chat.handleNotification({ method: 'turn/completed', params: { threadId: first.conversationId, turn: { id: first.runId, status: 'completed', items: [] } } })
  const next = await h.send({ conversationId: first.conversationId })
  assert.equal(h.calls.filter(call => call.method === 'turn/start').at(-1).params.cwd, h.otherRoot)
  assert.deepEqual(publicMetadata((await readOrigin(next)).body), publicMetadata(b))
  assert.deepEqual(publicMetadata((await readOrigin(first)).body), publicMetadata(a))
  await h.file('attachProject', { roomId: 'room-1', selectionId: 'pick-project' })
  const defaults = await h.file('readRoomProjectDefault', { roomId: 'room-1' })
  const explicit = await h.send({ conversationId: first.conversationId, projectTarget: { boardId: 'b', projectId: b.projectId, rootId: b.rootId } })
  assert.equal((await readOrigin(explicit)).body.source, 'request')
  assert.deepEqual(await h.file('readRoomProjectDefault', { roomId: 'room-1' }), defaults)
  assert.deepEqual(h.store.allowedRoots, [h.root])
  assert.ok(h.calls.every(call => !Object.hasOwn(call.params, 'allowedRoots') && !Object.hasOwn(call.params, 'identity')))
  assert.doesNotMatch(JSON.stringify([h.events, h.chat.snapshot()]), /fsIdentity|fileOwnerScope|startCwd|privateProjectOrigin|directoryId|displayPath/)
  await h.file('inheritRoomProject', { roomId: 'room-1' })
  await h.file('detachProject', { boardId: 'a' })
  const unavailable = (await readOrigin(first)).body
  assert.equal(unavailable.status, 'unavailable')
  for (const key of ['rootId', 'directoryId', 'displayPath']) assert.equal(Object.hasOwn(unavailable, key), false)
  const reattached = await h.file('attachProject', { boardId: 'a', selectionId: 'pick-project' })
  assert.notEqual(reattached.projectId, a.projectId, 'the old unreferenced project row was removed')
  const retainedOrigin = (await readOrigin(first)).body
  assert.equal(retainedOrigin.projectId, a.projectId, 'origin does not cascade-delete or adopt the new project ID')
  assert.deepEqual(publicMetadata(retainedOrigin), publicMetadata(reattached))
  h.changeOwner('another-account')
  before = h.calls.length
  const wrongAccount = await readOrigin(first)
  assert.equal(wrongAccount.status, 403)
  assert.equal(wrongAccount.body.code, 'PROJECT_ORIGIN_SCOPE_MISMATCH')
  for (const key of ['rootId', 'directoryId', 'displayPath']) assert.equal(Object.hasOwn(wrongAccount.body, key), false)
  assert.equal(h.calls.length, before)
})

test('service integration: a replaced project blocks dispatch instead of falling back; an explicit unattached project remains ordinary Chat', async t => {
  const h = await harness(t)
  await h.file('attachProject', { boardId: 'board-1', selectionId: 'pick-project' })
  await rename(h.root, path.join(h.temp, 'retired-project'))
  await mkdir(h.root)
  await assert.rejects(h.send({ boardId: 'board-1' }), { code: 'PROJECT_RECONNECT_REQUIRED' })
  assert.equal(h.calls.length, 0, 'not even thread/start occurs for a missing/replaced association')
  assert.equal(await h.localFiles.resolveProjectWorkspace({ boardId: 'unattached', roomId: 'ordinary-room' }), null)
  await h.send({ boardId: 'unattached', clientThreadId: 'ordinary-room', cwd: h.otherRoot })
  assert.equal(h.calls.find(call => call.method === 'thread/start').params.cwd, h.otherRoot)
})

test('service integration: mounted working-copy and path captures become stale through the real workflow bus without recapture or a model call', async t => {
  const h = await harness(t)
  const project = await h.file('attachProject', { boardId: 'board-1', selectionId: 'pick-project' })
  const listing = await h.file('listDirectory', { directoryId: project.directoryId })
  const fileId = listing.entries.find(entry => entry.name === 'source.txt').id
  const draft = await h.file('createDraft', { fileId })
  const managedFileView = { fileId, draftId: draft.id, head: draft.head, revision: draft.bufferRevision }
  const captures = (await h.contexts.capture({ clientThreadId: 'room-1', attachments: [
    { id: 'managed-source', kind: 'file', managedFileView, captureScope: { type: 'file' } },
    { id: 'path-source', kind: 'file', sourceRef: { path: h.sourceFile }, captureScope: { type: 'file' } },
  ] })).captures
  assert.deepEqual(captures[0].sourceRef.location, { rootId: project.rootId, relativePath: 'source.txt' })
  assert.ok(captures.every(capture => tracked(h, capture.sourceId).state === 'active'))
  h.workflow.bus.publish({ owner: h.owner(), topic: 'file.changed', payload: { rootId: project.rootId, relativePath: 'source.txt', change: 'change' } })
  await h.workflow.bus.flush()
  assert.ok(captures.every(capture => tracked(h, capture.sourceId).state === 'active'), 'engine account is not the local workflow event owner')
  await writeFile(h.sourceFile, 'new original bytes, not recaptured\n')
  h.watchers.get(h.root).change('change', 'source.txt')
  await until(() => captures.every(capture => tracked(h, capture.sourceId).state === 'stale'))
  assert.equal(h.calls.length, 0)
  for (const capture of captures) assert.equal((await h.store.inspect(h.owner(), capture.sourceId)).source.text, 'original selected bytes\n')
  const run = await h.send({ boardId: 'board-1', contextSnapshotIds: captures.map(capture => capture.sourceId), contextCapabilities: capabilities })
  assert.ok(h.contexts.sourceStatus({ conversationId: run.conversationId }).sources.every(item => item.reason === 'fileChanged'))
  const note = h.calls.find(call => call.method === 'turn/start').params.additionalContext.egdesk_context_changes
  assert.equal(JSON.parse(note.value).changed.length, 2, 'explicit send hears the changes, not replacement content')
})

test('service integration: Browser navigation marks only the selected local-owner source stale and does not dispatch or recapture', async t => {
  const h = await harness(t)
  const capture = (await h.contexts.capture({ clientThreadId: 'room-1', attachments: [{
    id: 'page', kind: 'browser', label: 'Selected page', sourceRef: { viewId: 'browser-card', url: 'https://example.test/first' },
    captureScope: { type: 'document-text', locator: 'body' }, content: { mime: 'text/plain', text: 'original page words', truncated: false },
  }] })).captures[0]
  for (const [owner, cardId] of [[h.owner(), 'browser-card'], ['egdesk-local', 'other-card']]) {
    h.workflow.bus.publish({ owner, topic: 'browser.navigated', payload: { cardId, origin: 'https://example.test', path: '/next' } })
  }
  await h.workflow.bus.flush()
  assert.equal(tracked(h, capture.sourceId).state, 'active')
  h.workflow.bus.publish({ owner: 'egdesk-local', topic: 'browser.navigated', payload: { cardId: 'browser-card', origin: 'https://example.test', path: '/next' } })
  await h.workflow.bus.flush()
  assert.equal(tracked(h, capture.sourceId).reason, 'navigated')
  assert.equal((await h.store.inspect(h.owner(), capture.sourceId)).source.text, 'original page words')
  assert.equal(h.calls.length, 0)
})

test('service integration: an unavailable selected source or failed Board search never becomes a successful empty context', async t => {
  const h = await harness(t)
  const attachments = [{ id: 'missing', kind: 'file', sourceRef: { path: path.join(h.root, 'missing.txt') }, captureScope: { type: 'file' } }]
  await assert.rejects(h.contexts.capture({ clientThreadId: 'room-1', attachments }), { code: 'SOURCE_UNAVAILABLE' })
  await assert.rejects(h.send({ attachments, contextCapabilities: capabilities }), error => error.code === 'TOOL_PROVIDER_FAILED' && !error.message.includes(h.root))
  assert.equal(h.calls.length, 0)
  h.deskStore.searchBoards = () => { throw new Error('test Board search unavailable') }
  assert.throws(() => h.contexts.resolve({ query: 'evidence' }, h.contexts.authority({ clientThreadId: 'room-1' })), { code: 'CONTEXT_BOARD_SEARCH_UNAVAILABLE' })
  assert.equal(h.calls.length, 0)
  assert.equal(h.contexts.pendingSources.size, 0)
})

test('service integration: context subscription works when task storage is unavailable and detaches before remaining resources close', async t => {
  const h = await harness(t, { constructionRoots: true, unavailableTasks: true })
  assert.equal(h.workflow.snapshot().tasks, 'unavailable')
  assert.equal(h.contexts.suggestSettings, h.bridgeSettings.contextSuggest)
  const capture = (await h.contexts.capture({ clientThreadId: 'room-1', attachments: [{ id: 'path-source', kind: 'file', sourceRef: { path: h.sourceFile }, captureScope: { type: 'file' } }] })).captures[0]
  h.workflow.bus.publish({ owner: 'egdesk-local', topic: 'file.changed', payload: { rootId: 'before-context', relativePath: 'source.txt', change: 'change' } })
  await h.workflow.bus.flush()
  assert.equal(tracked(h, capture.sourceId).state, 'stale')
  await h.shutdown()
  assert.deepEqual(h.lifecycle, ['context.detach', 'server.close', 'monitor.close', 'codex.dispose', 'engine.dispose', 'workflow.close', 'files.close', 'chat.close', 'profiles.close', 'desk.close', 'ontology.close', 'exit:0'])
  const count = h.contexts.roots.size
  h.onRootRegistered({ rootId: 'after-close', absolutePath: h.root })
  assert.equal(h.contexts.roots.size, count, 'late file callbacks cannot restart tracking')
  assert.equal(h.pendingRoots(), 0)
  assert.ok([...h.watchers.values()].every(watcher => watcher.closed))
  assert.equal(h.workflow.bus.stats().subscribers, 0)
  await h.shutdown()
  assert.equal(h.lifecycle.filter(item => item === 'context.detach').length, 1)
  assert.deepEqual(h.warnings, [])
})

test('service integration: a throwing unsubscribe is reported and does not prevent server, workflow or local-store cleanup', async t => {
  const h = await harness(t, { constructionRoots: true, failingUnsubscribe: true })
  await h.shutdown()
  assert.deepEqual(h.lifecycle, ['context.detach', 'server.close', 'monitor.close', 'codex.dispose', 'engine.dispose', 'workflow.close', 'files.close', 'chat.close', 'profiles.close', 'desk.close', 'ontology.close', 'exit:0'])
  assert.deepEqual(h.warnings, ['[egdesk-codex-bridge] context services did not detach cleanly'])
  assert.ok([...h.watchers.values()].every(watcher => watcher.closed))
  assert.equal(h.workflow.bus.stats().subscribers, 0)
  await h.shutdown()
  assert.equal(h.warnings.length, 1, 'shutdown and its exact detach function are idempotent')
})

test('service integration: absent ontology storage does not produce a shutdown warning', async t => {
  const h = await harness(t, { unavailableOntology: true })
  await h.shutdown()
  assert.deepEqual(h.lifecycle, ['context.detach', 'server.close', 'monitor.close', 'codex.dispose', 'engine.dispose', 'workflow.close', 'files.close', 'chat.close', 'profiles.close', 'desk.close', 'exit:0'])
  assert.deepEqual(h.warnings, [])
  await h.shutdown()
  assert.equal(h.lifecycle.filter(item => item === 'exit:0').length, 1)
})

test('service integration: ontology close failure is reported without preventing shutdown', async t => {
  const h = await harness(t, { failingUnsubscribe: true, failingOntologyClose: true })
  await h.shutdown()
  assert.deepEqual(h.lifecycle, ['context.detach', 'server.close', 'monitor.close', 'codex.dispose', 'engine.dispose', 'workflow.close', 'files.close', 'chat.close', 'profiles.close', 'desk.close', 'ontology.close', 'exit:0'])
  assert.deepEqual(h.warnings, [
    '[egdesk-codex-bridge] context services did not detach cleanly',
    '[egdesk-codex-bridge] ontology store did not close cleanly',
  ])
  assert.equal(h.workflow.bus.stats().subscribers, 0)
  await h.shutdown()
  assert.equal(h.lifecycle.filter(item => item === 'ontology.close').length, 1)
  assert.equal(h.warnings.length, 2)
})
