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
  at("import { openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'")
  assert.ok(at('let workflow = null') < at('const localFiles = createEGDeskFileMount({ dataDir, port: BRIDGE_PORT, onRootRegistered: root => workflow?.watchRoot(root) })'))
  assert.ok(at('let workflow = null') < at('const chat = new CodexChatRuntime({'))
  assert.ok(at('  profiles: profileStore,') > at('const chat = new CodexChatRuntime({'))
  at('  emit: event => { broadcast(event, 2); workflow?.onChatEvent(event) },')
  const open = at('workflow = await openWorkflowRuntime({')
  assert.ok(open > at('const chat = new CodexChatRuntime({') && open > at('const ensureChatAuth = async'))
  at("  ensureAuth: () => ensureChatAuth(), getOwnerKey: () => publicAuthIdentityKey(authState), maxConcurrency: 2,")
  at('const terminalRegistry = new TerminalSessionRegistry({ onExit: receipt => workflow?.publishTerminalExit(receipt) })')
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

test('task sources persist privately beside the journal, stay bound to Board and owner, and drop the oldest past the bounds', async t => {
  const { openTaskSourceRegistry } = await import('./egdesk-task-sources.mjs')
  const { readFile, stat, writeFile } = await import('node:fs/promises')
  const directory = path.join(await mkdtemp(path.join(os.tmpdir(), 'egdesk-sources-')), 'task-sources')
  t.after(() => rm(path.dirname(directory), { recursive: true, force: true }))
  let owner = 'owner-hash-A'
  const first = await openTaskSourceRegistry({ directory, getOwnerKey: () => owner, maxSources: 2 })
  const a = await first.register({ boardId: 'board-1', message: 'first task', cwd: '/tmp' })
  const b = await first.register({ boardId: 'board-1', message: 'second task' })
  await assert.rejects(first.register({ boardId: 'board-1', message: 'x', cwd: 'relative' }), { code: 'TASK_SOURCE_INPUT' })
  await assert.rejects(first.register({ boardId: '../board', message: 'x' }), { code: 'TASK_SOURCE_INPUT' })
  const file = path.join(directory, 'task-sources.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const reopened = await openTaskSourceRegistry({ directory, getOwnerKey: () => owner, maxSources: 2 })
  assert.deepEqual(reopened.resolve({ binding: { sourceRef: a.sourceRef }, boardId: 'board-1' }), { message: 'first task', cwd: '/tmp' })
  assert.throws(() => reopened.resolve({ binding: { sourceRef: a.sourceRef }, boardId: 'board-2' }), { code: 'TASK_INPUT_UNRESOLVED' })
  owner = 'owner-hash-B'
  assert.throws(() => reopened.resolve({ binding: { sourceRef: b.sourceRef }, boardId: 'board-1' }), { code: 'TASK_INPUT_UNRESOLVED' })
  owner = 'owner-hash-A'
  await reopened.register({ boardId: 'board-1', message: 'third task' })
  assert.throws(() => reopened.resolve({ binding: { sourceRef: a.sourceRef }, boardId: 'board-1' }), { code: 'TASK_INPUT_UNRESOLVED' }, 'oldest dropped')
  assert.equal(reopened.stats().sources, 2)
  const bytes = await readFile(file, 'utf8')
  await writeFile(file, bytes.replace('second task', 'tampered task'))
  await assert.rejects(openTaskSourceRegistry({ directory, getOwnerKey: () => owner }), { code: 'E_TASK_SOURCES_CORRUPT' })
  assert.match(await readFile(file, 'utf8'), /tampered task/, 'a corrupt file is left for inspection')
})
