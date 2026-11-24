import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label = 'expected state') {
  for (let count = 0; count < 1000; count += 1) { if (await predicate()) return; await delay(3) }
  assert.fail(`${label} did not arrive`)
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })

// A stand-in OAuth provider: /authorize redirects to the app's loopback
// callback with a one-time code, the way a real provider's consent step ends.
async function mockOAuthProvider(t) {
  const issued = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/authorize') {
      const code = `MOCK-CODE-${issued.length + 1}`
      issued.push(code)
      res.writeHead(302, { Location: `/oauth/callback?code=${code}&state=${url.searchParams.get('state')}` })
      return res.end()
    }
    if (url.pathname === '/oauth/callback') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('Authentication complete. You may close this window.')
    }
    res.writeHead(404); res.end()
  })
  const port = await listen(server)
  t.after(() => close(server))
  return { origin: `http://127.0.0.1:${port}`, issued }
}

async function bridge(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-workflow-'))
  const frames = []
  const turnStarts = []
  let runtime = null
  let threads = 0, turns = 0
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      if (method === 'thread/start') return { thread: { id: `native-thread-${++threads}` } }
      if (method === 'turn/start') { turnStarts.push(params); return { turn: { id: `native-turn-${++turns}`, status: 'inProgress', items: [] } } }
      if (method === 'turn/interrupt') return {}
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } }
      throw new Error(`Unexpected native RPC ${method}`)
    },
    respond: () => {}, verifyFile: async () => null,
    emit: event => { frames.push(event); runtime?.onChatEvent(event) },
  })
  chat.setConnection(true)
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    void runtime.handle(req, res, url).then(handled => { if (!handled) { res.writeHead(404); res.end('{}') } })
  })
  const port = await listen(server)
  runtime = await openWorkflowRuntime({ dataDir, chat, port, broadcast: frame => frames.push(frame),
    ensureAuth: async () => {}, getOwnerKey: () => 'id:test-account' })
  t.after(async () => { await runtime.close(); await close(server); await rm(dataDir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${port}`
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  async function finishTurn(index, status = 'completed') {
    const thread = turnStarts[index].threadId
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: thread, turn: { id: `native-turn-${index + 1}`, status, items: [] } } })
    await chat.queue
  }
  return { runtime, chat, frames, turnStarts, call, finishTurn, dataDir }
}

const graphScope = value => ({ graphId: value.graphId, requestId: value.requestId, runId: value.runId, parentTaskId: value.parentTaskId, requestedBy: value.requestedBy })
const taskOf = (state, taskId) => state.graph.tasks.find(entry => entry.taskId === taskId)

test('BRW-04: a local mock OAuth redirect, reported by the screen, opens the oauth gate and the next Agent task starts by itself', async t => {
  const provider = await mockOAuthProvider(t)
  const h = await bridge(t)
  const boardId = 'board-login'
  const prepare = await h.call('POST', '/task-sources', { boardId, message: 'Run gh auth login and wait for the browser step.', cwd: h.dataDir })
  const follow = await h.call('POST', '/task-sources', { boardId, message: 'List the repositories now that GitHub login is done.' })
  assert.equal(prepare.status, 201)
  assert.match(prepare.body.sourceRef, /^task-source-/)
  const graph = { graphId: 'graph-login', requestId: 'request-login', runId: 'run-parent', parentTaskId: null, requestedBy: 'local-user', tasks: [
    { taskId: 'start-login', ownerId: 'agent-coder', sourceRef: prepare.body.sourceRef, dependsOn: [], approvalRequired: false },
    { taskId: 'list-repos', ownerId: 'agent-coder', sourceRef: follow.body.sourceRef, dependsOn: ['start-login'], approvalRequired: false,
      gates: [{ gateId: 'github-login', kind: 'oauth', origin: provider.origin, pathPrefix: '/oauth/callback', cardId: 'card-login' }] },
  ] }
  assert.equal((await h.call('POST', '/tasks/submit', { boardId, graph })).status, 201)
  const activated = await h.call('POST', '/tasks/activate', { boardId, scope: graphScope(graph) })
  assert.equal(activated.status, 200)
  await until(() => h.turnStarts.length === 1, 'first native turn')
  assert.equal(JSON.stringify(h.turnStarts[0]).includes('Run gh auth login'), true)

  await h.finishTurn(0)
  await until(async () => taskOf((await h.call('GET', `/tasks/state?graphId=${graph.graphId}`)).body, 'start-login').status === 'completed', 'upstream completion')
  let state = (await h.call('GET', `/tasks/state?graphId=${graph.graphId}`)).body
  assert.equal(taskOf(state, 'list-repos').status, 'waiting-on-dependency')
  assert.deepEqual(taskOf(state, 'list-repos').gates.map(gate => [gate.gateId, gate.kind, gate.status]),
    [['task:start-login', 'task', 'satisfied'], ['github-login', 'oauth', 'waiting']])

  // Navigation to the callback, a look-alike origin and another card do not count.
  const callbackUrl = `${provider.origin}/oauth/callback`
  assert.equal((await h.call('POST', '/events/browser', { cardId: 'card-login', kind: 'navigated', url: callbackUrl })).status, 202)
  assert.equal((await h.call('POST', '/events/browser', { cardId: 'card-login', kind: 'oauthCompleted', url: callbackUrl.replace('127.0.0.1', 'localhost') })).status, 202)
  assert.equal((await h.call('POST', '/events/browser', { cardId: 'card-other', kind: 'oauthCompleted', url: callbackUrl })).status, 202)
  await h.runtime.bus.flush()
  assert.equal(h.turnStarts.length, 1)

  // The Browser card follows the provider's redirect to the loopback callback ...
  const consent = await fetch(`${provider.origin}/authorize?client_id=egdesk-test&state=s1`, { redirect: 'manual' })
  assert.equal(consent.status, 302)
  const landed = await fetch(new URL(consent.headers.get('location'), provider.origin))
  assert.match(await landed.text(), /Authentication complete/)
  assert.ok(landed.url.includes('code=MOCK-CODE-1'))
  // ... and the screen reports where it landed; the bridge keeps origin + path only.
  const reported = await h.call('POST', '/events/browser', { cardId: 'card-login', kind: 'oauthCompleted', url: landed.url })
  assert.equal(reported.status, 202)
  assert.deepEqual([reported.body.event.origin, reported.body.event.path], [provider.origin, '/oauth/callback'])

  await until(() => h.turnStarts.length === 2, 'downstream native turn')
  assert.equal(JSON.stringify(h.turnStarts[1]).includes('List the repositories'), true)
  state = (await h.call('GET', `/tasks/state?graphId=${graph.graphId}`)).body
  assert.equal(taskOf(state, 'list-repos').status, 'running')
  const login = taskOf(state, 'list-repos').gates.find(gate => gate.gateId === 'github-login')
  assert.equal(login.status, 'satisfied')
  assert.equal(login.satisfiedBy, 'browser.oauthCompleted')

  // SSE frames: every workflow event and task change reached the screen, and no one-time code did.
  const workflowFrames = h.frames.filter(frame => frame.type === 'workflow.event')
  assert.deepEqual(workflowFrames.map(frame => frame.event.topic), ['browser.navigated', 'browser.oauthCompleted', 'browser.oauthCompleted', 'browser.oauthCompleted'])
  assert.equal(JSON.stringify(h.frames).includes('MOCK-CODE'), false)
  const changes = h.frames.filter(frame => frame.type === 'task.graph' && frame.graphId === graph.graphId).map(frame => frame.change)
  for (const change of ['graph-submitted', 'graph-activated', 'task-started', 'task-outcome-recorded', 'task-gate-satisfied']) assert.ok(changes.includes(change), change)
  const last = h.frames.filter(frame => frame.type === 'task.graph').at(-1)
  assert.ok(!/"receiptId"|"receipt"|"approvalReceipt"/.test(JSON.stringify(last.graph)), 'public graph frames carry no private receipts')
  assert.ok(taskOf(last, 'start-login').evidenceRefs.length === 1, 'evidence references stay visible')
  assert.deepEqual(h.runtime.snapshot().tasks, 'ready')
  await until(() => h.frames.some(frame => frame.type === 'task.native'), 'native change hint')
  assert.deepEqual(Object.keys(h.frames.find(frame => frame.type === 'task.native')), ['type', 'v', 'ts'])
})

test('manual continue is the fallback: POST /tasks/continue opens one waiting gate; stale or foreign gates are refused', async t => {
  const h = await bridge(t)
  const boardId = 'board-manual'
  const source = await h.call('POST', '/task-sources', { boardId, message: 'Upload the report once the file is ready.' })
  const graph = { graphId: 'graph-manual', requestId: 'request-manual', runId: 'run-manual', parentTaskId: null, requestedBy: 'local-user', tasks: [
    { taskId: 'upload', ownerId: 'agent-ops', sourceRef: source.body.sourceRef, dependsOn: [], approvalRequired: false,
      gates: [{ gateId: 'report-arrived', kind: 'file', root: 'root-unknown', relativeGlob: 'report.pdf' }] },
  ] }
  await h.call('POST', '/tasks/submit', { boardId, graph })
  await h.call('POST', '/tasks/activate', { boardId, scope: graphScope(graph) })
  assert.equal(h.turnStarts.length, 0)
  assert.equal((await h.call('POST', '/tasks/continue', { boardId, scope: graphScope(graph), taskId: 'upload', gateId: 'missing' })).status, 409)
  assert.equal((await h.call('POST', '/tasks/continue', { boardId: 'board-other', scope: graphScope(graph), taskId: 'upload', gateId: 'report-arrived' })).status, 409)
  const foreign = await h.call('POST', '/tasks/continue', { boardId, scope: graphScope(graph), taskId: 'upload', gateId: 'report-arrived' }, { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  const continued = await h.call('POST', '/tasks/continue', { boardId, scope: graphScope(graph), taskId: 'upload', gateId: 'report-arrived' })
  assert.equal(continued.status, 200)
  assert.deepEqual(continued.body.graph.tasks[0].gates.map(gate => [gate.status, gate.satisfiedBy]), [['satisfied', 'user.action']])
  await until(() => h.turnStarts.length === 1, 'continued native turn')
  assert.equal((await h.call('POST', '/tasks/continue', { boardId, scope: graphScope(graph), taskId: 'upload', gateId: 'report-arrived' })).status, 409)
  assert.ok(h.frames.some(frame => frame.type === 'workflow.event' && frame.event.topic === 'user.action'))
})

test('Terminal exit, sign-in changes and connected-root changes reach the bus; auth carries signedIn only', async t => {
  const h = await bridge(t)
  h.runtime.observeAuth({ signedIn: false, accountKey: 'false:' })
  h.runtime.observeAuth({ signedIn: true, accountKey: 'true:email:someone@example.com' })
  h.runtime.observeAuth({ signedIn: true, accountKey: 'true:email:someone@example.com' })
  h.runtime.observeAuth({ signedIn: false, accountKey: 'false:' })
  h.runtime.publishTerminalExit({ sessionId: 'term-abc', exitCode: 0, signal: null, exitSource: 'pty.onExit' })
  await h.runtime.bus.flush()
  const events = h.frames.filter(frame => frame.type === 'workflow.event').map(frame => frame.event)
  assert.deepEqual(events.map(event => [event.topic, event.payload]), [
    ['auth.changed', { signedIn: true }], ['auth.changed', { signedIn: false }],
    ['terminal.exit', { sessionId: 'term-abc', exitCode: 0, signal: null }],
  ])
  assert.equal(JSON.stringify(h.frames).includes('someone@example.com'), false)
  assert.equal(h.runtime.watchRoot({ rootId: 'root-1', absolutePath: h.dataDir }), true)
  assert.equal(h.runtime.snapshot().watchedRoots, 1)
  const recent = await h.call('GET', '/events/recent?since=1')
  assert.deepEqual(recent.body.events.map(event => event.seq), [2, 3])
})

test('when task storage cannot open, events keep working and task routes answer 503', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-workflow-broken-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const runtime = await openWorkflowRuntime({ dataDir, chat: {}, port: 39218, ensureAuth: async () => {}, getOwnerKey: () => null,
    openStores: async () => { throw new Error('disk unavailable') } })
  t.after(() => runtime.close())
  assert.equal(runtime.snapshot().tasks, 'unavailable')
  assert.equal(runtime.snapshot().taskError, 'disk unavailable')
  const res = { status: null, body: null, setHeader() {}, writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
  const req = { method: 'GET', url: '/tasks/state?graphId=g', headers: { host: '127.0.0.1:39218' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(await runtime.handle(req, res, new URL('http://127.0.0.1:39218/tasks/state?graphId=g')), true)
  assert.equal(res.status, 503)
  assert.equal(await runtime.handle({ ...req, url: '/chat/send' }, res, new URL('http://127.0.0.1:39218/chat/send')), false)
  runtime.publishTerminalExit({ sessionId: 'term-1', exitCode: 1 })
  assert.equal(runtime.bus.recent({ owner: 'egdesk-local' }).events.length, 1)
})

test('the bridge opens the workflow runtime after Chat, mounts its routes behind the loopback guard and feeds it terminal, auth, file and chat events', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  at("import { WORKFLOW_OWNER, openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'")
  const files = at('const localFiles = createEGDeskFileMount({ dataDir, port: BRIDGE_PORT, onRootRegistered: root => {')
  assert.ok(at('let workflow = null') < files)
  const rootCallback = source.slice(files, at('const contextStore = new ImmutableContextStore({'))
  assert.match(rootCallback, /contexts\?\.noteRoot\(root\)/)
  assert.match(rootCallback, /workflow\?\.watchRoot\(root\)/)
  assert.ok(at('let workflow = null') < at('const chat = new CodexChatRuntime({'))
  assert.ok(at('  profiles: profileStore,') > at('const chat = new CodexChatRuntime({'))
  // CU-01/02 also hands chat events to the host-activity timeline (computer.used).
  at('  emit: event => { broadcast(event, 2); workflow?.onChatEvent(event); hostControl.onChatEvent(event) },')
  const open = at('workflow = await openWorkflowRuntime({')
  at("import { createChatEngineAuth } from './codex-bridge-engine-auth.mjs'")
  const auth = at('const ensureChatAuth = createChatEngineAuth({ chat, refreshCodexAccount: refreshAccountState, getCodexAuth: () => authState })')
  assert.ok(at('const chat = new CodexChatRuntime({') < auth && auth < open)
  assert.ok(auth < at('const handleChatHttp = createChatHttpHandler(chat, ensureChatAuth)'))
  at("  ensureAuth: hints => ensureChatAuth(hints), getOwnerKey: () => publicAuthIdentityKey(authState), maxConcurrency: 2,")
  // CODE-06 added the typed-command watch: it shares the workflow bus and owner scope, and the registry still feeds exits to the runtime.
  const runWatch = at('const terminalRunWatch = createTerminalRunWatch({ bus: workflow?.bus ?? null, owner: WORKFLOW_OWNER })')
  assert.ok(open < runWatch, 'the watch reads workflow.bus, so the runtime opens first')
  // The registry still publishes every confirmed exit to the workflow bus; the run watch is reached through the terminal state watch
  // (a pass-through wrapper that is inert unless EGDESK_TERMINAL_JUDGE is set), which wraps exactly that run watch.
  const stateWatch = at('const terminalStateWatch = createTerminalStateWatch({ runWatch: terminalRunWatch, flag: () => process.env.EGDESK_TERMINAL_JUDGE,')
  assert.ok(runWatch < stateWatch)
  assert.ok(stateWatch < at('const terminalRegistry = new TerminalSessionRegistry({ onExit: receipt => { terminalStateWatch.noteExit(receipt); workflow?.publishTerminalExit(receipt) }, runWatch: terminalStateWatch })'))
  const update = source.slice(at('function updateAuthState(patch, { broadcastStatus = true } = {}) {'), at('function authStatusTextFor(snapshot) {'))
  assert.match(update, /workflow\?\.observeAuth\(\{ signedIn: authState\.isLoggedIn === true, accountKey: modelAccountKey\(authState\) \}\)\n {2}engineStatus\.check\(\)\n\}/)
  const mount = at('if (await workflow.handle(req, res, url)) return')
  assert.ok(at('if (!guardBridgeRequest(req, BRIDGE_PORT))') < mount)
  assert.ok(at('if (await localFiles.handle(req, res, url)) return') < mount)
  assert.ok(at("if (req.method === 'GET' && route === '/events') {") < mount)
  assert.ok(mount < at('if (await handleChatHttp(req, res, url)) return'))
  assert.ok(mount < at('if (await handleTerminalHttp(req, res, url)) return'))
  at('      workflow: workflow.snapshot(),')
  const shutdown = source.slice(at('async function shutdown() {'), at("process.on('SIGINT', shutdown)"))
  assert.ok(shutdown.indexOf('await workflow?.close()') < shutdown.indexOf('process.exit(0)'))
})

test('task sources persist privately in the workflow store, stay bound to Board and owner, and drop the oldest past the bounds', async t => {
  const { openTaskSourceRegistry } = await import('./egdesk-task-sources.mjs')
  const { stat } = await import('node:fs/promises')
  const directory = path.join(await mkdtemp(path.join(os.tmpdir(), 'egdesk-sources-')), 'task-sources')
  const opened = []
  t.after(async () => { for (const registry of opened) registry.close(); await rm(path.dirname(directory), { recursive: true, force: true }) })
  const open = async options => { const registry = await openTaskSourceRegistry(options); opened.push(registry); return registry }
  let owner = 'owner-hash-A'
  const first = await open({ directory, getOwnerKey: () => owner, maxSources: 2 })
  const a = await first.register({ boardId: 'board-1', message: 'first task', cwd: '/tmp' })
  const b = await first.register({ boardId: 'board-1', message: 'second task' })
  await assert.rejects(first.register({ boardId: 'board-1', message: 'x', cwd: 'relative' }), { code: 'TASK_SOURCE_INPUT' })
  await assert.rejects(first.register({ boardId: '../board', message: 'x' }), { code: 'TASK_SOURCE_INPUT' })
  assert.equal((await stat(path.join(directory, 'workflow.sqlite'))).mode & 0o777, 0o600)
  const reopened = await open({ directory, getOwnerKey: () => owner, maxSources: 2 })
  assert.deepEqual(reopened.resolve({ binding: { sourceRef: a.sourceRef }, boardId: 'board-1' }), { message: 'first task', cwd: '/tmp' })
  assert.throws(() => reopened.resolve({ binding: { sourceRef: a.sourceRef }, boardId: 'board-2' }), { code: 'TASK_INPUT_UNRESOLVED' })
  owner = 'owner-hash-B'
  assert.throws(() => reopened.resolve({ binding: { sourceRef: b.sourceRef }, boardId: 'board-1' }), { code: 'TASK_INPUT_UNRESOLVED' })
  owner = 'owner-hash-A'
  await reopened.register({ boardId: 'board-1', message: 'third task' })
  assert.throws(() => reopened.resolve({ binding: { sourceRef: a.sourceRef }, boardId: 'board-1' }), { code: 'TASK_INPUT_UNRESOLVED' }, 'oldest dropped')
  assert.equal(reopened.stats().sources, 2)
  const third = await open({ directory, getOwnerKey: () => owner, maxSources: 2 })
  assert.throws(() => third.resolve({ binding: { sourceRef: a.sourceRef }, boardId: 'board-1' }), { code: 'TASK_INPUT_UNRESOLVED' }, 'the drop was saved')
  assert.equal(third.stats().sources, 2)
})

test('a task-sources.json written before is imported once and kept; a tampered one is refused and left for inspection', async t => {
  const { openTaskSourceRegistry } = await import('./egdesk-task-sources.mjs')
  const { readFile, writeFile, mkdir } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const root = await mkdtemp(path.join(os.tmpdir(), 'egdesk-sources-legacy-'))
  const opened = []
  t.after(async () => { for (const registry of opened) registry.close(); await rm(root, { recursive: true, force: true }) })
  const open = async options => { const registry = await openTaskSourceRegistry(options); opened.push(registry); return registry }
  const sources = [['task-source-old-1', { boardId: 'board-1', owner: 'owner-hash-A', message: 'written before', cwd: '/tmp' }]]
  const envelope = list => JSON.stringify({ version: 1, digest: createHash('sha256').update(JSON.stringify(list)).digest('hex'), sources: list })
  const good = path.join(root, 'good')
  await mkdir(good, { mode: 0o700 })
  await writeFile(path.join(good, 'task-sources.json'), envelope(sources), { mode: 0o600 })
  const registry = await open({ directory: good, getOwnerKey: () => 'owner-hash-A' })
  assert.deepEqual(registry.resolve({ binding: { sourceRef: 'task-source-old-1' }, boardId: 'board-1' }), { message: 'written before', cwd: '/tmp' })
  await registry.register({ boardId: 'board-1', message: 'written after' })
  assert.equal(await readFile(path.join(good, 'task-sources.json'), 'utf8'), envelope(sources), 'the old file is never rewritten')
  assert.equal((await open({ directory: good, getOwnerKey: () => 'owner-hash-A' })).stats().sources, 2, 'imported once')

  const bad = path.join(root, 'bad')
  await mkdir(bad, { mode: 0o700 })
  const tampered = envelope(sources).replace('written before', 'tampered task')
  await writeFile(path.join(bad, 'task-sources.json'), tampered, { mode: 0o600 })
  await assert.rejects(openTaskSourceRegistry({ directory: bad, getOwnerKey: () => 'owner-hash-A' }), { code: 'E_TASK_SOURCES_CORRUPT' })
  assert.equal(await readFile(path.join(bad, 'task-sources.json'), 'utf8'), tampered, 'a corrupt file is left for inspection')
})

test('a written gate answer is kept bound to its gate, Board and owner; secret-looking text is refused and never kept', async t => {
  const { looksSecret, openTaskSourceRegistry } = await import('./egdesk-task-sources.mjs')
  const directory = path.join(await mkdtemp(path.join(os.tmpdir(), 'egdesk-answers-')), 'task-sources')
  const opened = []
  t.after(async () => { for (const registry of opened) registry.close(); await rm(path.dirname(directory), { recursive: true, force: true }) })
  let owner = 'owner-hash-A'
  const registry = await openTaskSourceRegistry({ directory, getOwnerKey: () => owner, maxAnswers: 2 })
  opened.push(registry)
  const gate = { boardId: 'board-1', graphId: 'graph-1', taskId: 'step', gateId: 'note' }
  const { textRef } = await registry.recordAnswer({ ...gate, text: '내일 오전 10시 이후로 잡아 주세요' })
  assert.match(textRef, /^task-answer-/)
  const reopened = await openTaskSourceRegistry({ directory, getOwnerKey: () => owner, maxAnswers: 2 })
  opened.push(reopened)
  assert.equal(reopened.answerText({ textRef, ...gate }), '내일 오전 10시 이후로 잡아 주세요')
  assert.throws(() => reopened.answerText({ textRef, ...gate, gateId: 'other' }), { code: 'TASK_INPUT_UNRESOLVED' })
  assert.throws(() => reopened.answerText({ textRef, ...gate, boardId: 'board-2' }), { code: 'TASK_INPUT_UNRESOLVED' })
  owner = 'owner-hash-B'
  assert.throws(() => reopened.answerText({ textRef, ...gate }), { code: 'TASK_INPUT_UNRESOLVED' })
  owner = 'owner-hash-A'
  for (const text of ['password: hunter2', '비밀번호: 1234abcd', 'sk-proj-abcdefghijklmnop', 'AKIAABCDEFGHIJKLMNOP', '4111 1111 1111 1111', '900101-1234567',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'token=abc123def456']) {
    assert.equal(looksSecret(text), true, text)
    await assert.rejects(reopened.recordAnswer({ ...gate, text }), { code: 'TASK_GATE_ANSWER_PRIVATE' }, text)
  }
  for (const text of ['빠른 길로 가 주세요', 'https://github.com/org/repo/pull/12', '2026-10-25 오전 9시', '메일은 team@example.com 으로']) assert.equal(looksSecret(text), false, text)
  await assert.rejects(reopened.recordAnswer({ ...gate, text: 'x'.repeat(501) }), { code: 'TASK_GATE_ANSWER' })
  assert.equal(reopened.stats().answers, 1, 'refused answers are not kept')
  await reopened.recordAnswer({ ...gate, text: 'second' })
  await reopened.recordAnswer({ ...gate, text: 'third' })
  assert.throws(() => reopened.answerText({ textRef, ...gate }), { code: 'TASK_INPUT_UNRESOLVED' }, 'the oldest answer is dropped past the bound')
})
