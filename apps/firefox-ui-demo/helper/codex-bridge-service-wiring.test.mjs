import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createEGDeskFileMount } from './egdesk-file-mount.mjs'
import { createEGDeskFileHttpAdapter, EGDESK_FILE_ENDPOINTS } from './egdesk-file-http.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { openBridgeSettings } from './egdesk-bridge-settings.mjs'
import { openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'

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

async function harness(t, { constructionRoots = false, failingUnsubscribe = false, unavailableTasks = false } = {}) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'egdesk-bridge-services-')))
  const root = path.join(temp, 'project'), otherRoot = path.join(temp, 'room-project')
  const dataDir = path.join(temp, 'state')
  await mkdir(root); await mkdir(otherRoot)
  const sourceFile = path.join(root, 'source.txt')
  await writeFile(sourceFile, 'original selected bytes\n')
  const calls = [], events = [], lifecycle = [], warnings = [], projectRequests = [], searched = []
  const watchers = new Map()
  const selections = new Map([['pick-project', root], ['pick-room', otherRoot]])
  let adapter, localFiles, workflow, chat, onRootRegistered, wired = false
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
    bridgeServer: { close: () => lifecycle.push('server.close') },
    systemResourceMonitor: { close: () => lifecycle.push('monitor.close') },
    claudeEngine: { dispose: async () => lifecycle.push('engine.dispose') },
    chatStore: { close: () => lifecycle.push('chat.close') },
    profileStore: { close: () => lifecycle.push('profiles.close') },
    process: { exit: code => lifecycle.push(`exit:${code}`) },
  })
  t.after(async () => {
    try { if (wired) await vm.runInContext('shutdown()', sandbox) }
    finally {
      try { await workflow?.close() }
      finally { try { await localFiles?.close() } finally { await rm(temp, { recursive: true, force: true }) } }
    }
  })
  vm.runInContext(rootSetup, sandbox)
  const store = new ImmutableContextStore({ dataDir, allowedRoots: [root], managedFileView: localFiles.managedFileView })
  const contexts = new ContextRuntime({ store, reader: null, getOwnerKey: () => owner, getAuthority: hints => chat.contextAuthority(hints) })
  sandbox.providedContexts = contexts
  vm.runInContext(`contexts = providedContexts\n${contextReplay}`, sandbox)
  const resolver = vm.runInContext(`(${resolverExpression})`, sandbox)
  chat = new CodexChatRuntime({ contexts, getOwnerKey: () => owner, resolveProjectWorkspace: resolver,
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
  assert.deepEqual(h.lifecycle, ['context.detach', 'server.close', 'monitor.close', 'engine.dispose', 'workflow.close', 'files.close', 'chat.close', 'profiles.close', 'desk.close', 'exit:0'])
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
  assert.deepEqual(h.lifecycle, ['context.detach', 'server.close', 'monitor.close', 'engine.dispose', 'workflow.close', 'files.close', 'chat.close', 'profiles.close', 'desk.close', 'exit:0'])
  assert.deepEqual(h.warnings, ['[egdesk-codex-bridge] context services did not detach cleanly'])
  assert.ok([...h.watchers.values()].every(watcher => watcher.closed))
  assert.equal(h.workflow.bus.stats().subscribers, 0)
  await h.shutdown()
  assert.equal(h.warnings.length, 1, 'shutdown and its exact detach function are idempotent')
})
