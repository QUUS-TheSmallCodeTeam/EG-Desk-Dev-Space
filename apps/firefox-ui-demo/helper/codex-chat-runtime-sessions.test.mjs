import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter, describeCodexEngine } from './codex-engine-adapter.mjs'
import { createChatHttpHandler } from './codex-bridge-http.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

// CHAT-09: one-time (stateless) conversations and branches (fork).
const OWNER_KEY = 'email:owner@example.com'
const sha256 = text => createHash('sha256').update(text).digest('hex')
const ORDINARY_CONFIG = { features: { default_mode_request_user_input: true } }

function nativeCodex(calls, { answer = () => undefined, capabilities } = {}) {
  let threads = 0, turns = 0, forks = 0
  const defaults = (method, params) => {
    if (method === 'thread/start') return { thread: { id: `thread-${++threads}`, ephemeral: params.ephemeral === true }, cwd: '/work', model: 'configured-model' }
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work' }
    if (method === 'thread/fork') return { thread: { id: `fork-${++forks}`, forkedFromId: params.threadId, ephemeral: false }, cwd: '/work', model: 'configured-model' }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    throw new Error(`Unexpected method: ${method}`)
  }
  const adapter = createCodexEngineAdapter({
    request: async (method, params) => { calls.push({ method, params }); return (await answer(method, params)) ?? defaults(method, params) },
    respond: () => {},
    describe: () => describeCodexEngine({ ready: true, version: '0.162.1', auth: { isLoggedIn: true } }),
  })
  if (capabilities) adapter.capabilities = () => new Set(capabilities)
  return adapter
}

async function withStore(action) {
  const dataDir = createPrivateQaTempDirectory('egdesk-runtime-sessions-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    await action(store)
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
}

function runtime(store, { calls = [], events = [], ownerKey = OWNER_KEY, ...engine } = {}) {
  const chat = new CodexChatRuntime({ engines: [nativeCodex(calls, engine)], store, requireStore: Boolean(store), getOwnerKey: () => ownerKey, emit: event => events.push(event) })
  chat.setConnection(true)
  return { chat, calls, events }
}

const finish = (chat, accepted) => chat.handleNotification({ method: 'turn/completed', params: { threadId: accepted.conversationId, turn: { id: accepted.runId, status: 'completed', items: [] } } })

test('a one-time conversation starts its native thread ephemeral and says so on the chat, the run and the binding', async () => {
  await withStore(async store => {
    const { chat, calls, events } = runtime(store)
    const accepted = await chat.send({ message: 'Just once', clientThreadId: 'ui-once', requestId: 'req-1', stateless: true })
    assert.equal(accepted.stateless, true)
    assert.deepEqual(calls[0], { method: 'thread/start', params: { config: ORDINARY_CONFIG, ephemeral: true } })
    const started = events.find(event => event.event === 'run.started')
    assert.deepEqual(started.details, { status: 'inProgress', stateless: true })
    assert.equal(chat.snapshot(accepted.conversationId).runs[0].stateless, true)
    await finish(chat, accepted)
    const history = chat.getLocalHistory({ clientThreadId: 'ui-once', limit: 500 })
    assert.deepEqual([history.thread.stateless, history.thread.forkedFrom], [true, null])
    assert.equal(history.runs[0].stateless, true)
    assert.deepEqual(history.runs[0].engine, { id: 'codex', version: '0.162.1', engineProfileId: 'codex-default' })
    const bound = history.events.find(event => event.event === 'native.thread.bound')
    assert.equal(bound.details.stateless, true)
    assert.equal(bound.details.ownerHash, sha256(OWNER_KEY))
    // No new events: the existing order is kept.
    assert.deepEqual(history.events.map(event => event.event).filter(name => ['run.dispatching', 'native.thread.bound', 'run.started', 'run.configuration'].includes(name)),
      ['run.dispatching', 'native.thread.bound', 'run.started', 'run.configuration'])
    assert.equal(chat.listLocalThreads({ limit: 10 }).threads.find(thread => thread.clientThreadId === 'ui-once').stateless, true)
    // Only an explicit one-time request changes the request identity.
    assert.notEqual(store.getRequest({ clientThreadId: 'ui-once', requestId: 'req-1' }).fingerprint, sha256(JSON.stringify({ message: 'Just once', clientThreadId: 'ui-once', profileEnabled: false })))
    // A follow-up continues the same one-time thread, which a restarted bridge still recognizes.
    const restarted = runtime(store, { calls })
    const next = await restarted.chat.send({ message: 'And this', clientThreadId: 'ui-once', requestId: 'req-2', conversationId: accepted.conversationId })
    assert.equal(next.stateless, true)
    assert.equal(restarted.chat.snapshot(accepted.conversationId).runs.find(run => run.runId === next.runId).stateless, true)
  })
})

test('an ordinary conversation is unchanged: no ephemeral option, stateless false and no forkedFrom', async () => {
  await withStore(async store => {
    const { chat, calls, events } = runtime(store)
    const accepted = await chat.send({ message: 'Hi', clientThreadId: 'ui-1', requestId: 'req-1', stateless: false })
    assert.deepEqual(calls[0].params, { config: ORDINARY_CONFIG })
    assert.equal(Object.hasOwn(accepted, 'stateless'), false)
    assert.deepEqual(events.find(event => event.event === 'run.started').details, { status: 'inProgress' })
    assert.equal(Object.hasOwn(chat.snapshot(accepted.conversationId).runs[0], 'stateless'), false)
    const thread = store.getConversation('ui-1')
    assert.deepEqual([thread.stateless, thread.forkedFrom], [false, null])
    assert.equal(Object.hasOwn(chat.getLocalHistory({ clientThreadId: 'ui-1' }).events.find(event => event.event === 'native.thread.bound').details, 'stateless'), false)
    assert.equal(store.getRequest({ clientThreadId: 'ui-1', requestId: 'req-1' }).fingerprint, sha256(JSON.stringify({ message: 'Hi', clientThreadId: 'ui-1', profileEnabled: false })))
  })
})

test('stateless is refused for an existing conversation, an invalid value, an engine without it, or a saved native thread', async () => {
  await withStore(async store => {
    const { chat, calls } = runtime(store)
    const first = await chat.send({ message: 'Hi', clientThreadId: 'ui-1', requestId: 'req-1' })
    const before = calls.length
    await assert.rejects(chat.send({ message: 'Again', clientThreadId: 'ui-1', requestId: 'req-2', conversationId: first.conversationId, stateless: true }),
      error => error.code === 'STATELESS_REQUIRES_NEW' && error.httpStatus === 400)
    assert.equal(store.getRequest({ clientThreadId: 'ui-1', requestId: 'req-2' }), null, 'nothing was saved')
    // The same room without its conversationId is still an existing conversation, not a storage failure.
    await assert.rejects(chat.send({ message: 'Again', clientThreadId: 'ui-1', requestId: 'req-3', stateless: true }),
      error => error.code === 'STATELESS_REQUIRES_NEW' && error.httpStatus === 400)
    assert.equal(chat.storeHealthy, true)
    const restarted = runtime(store, { calls: [] })
    await assert.rejects(restarted.chat.send({ message: 'Again', clientThreadId: 'ui-1', requestId: 'req-4', stateless: true }),
      error => error.code === 'STATELESS_REQUIRES_NEW')
    assert.equal(restarted.chat.storeHealthy, true)
    for (const stateless of ['yes', 1, null]) await assert.rejects(chat.send({ message: 'Hi', clientThreadId: 'ui-x', stateless }), error => error.code === 'INVALID_STATELESS' && error.httpStatus === 400)
    assert.equal(calls.length, before)
    assert.equal(store.getConversation('ui-x'), null)
    // A lost reply is replayed, not refused.
    const once = await chat.send({ message: 'Once', clientThreadId: 'ui-once', requestId: 'req-once', stateless: true })
    const replay = await runtime(store, { calls: [] }).chat.send({ message: 'Once', clientThreadId: 'ui-once', requestId: 'req-once', stateless: true })
    assert.deepEqual([replay.duplicate, replay.conversationId], [true, once.conversationId])
  })
  await withStore(async store => {
    const { chat, calls } = runtime(store, { capabilities: ['stream', 'resume'] })
    await assert.rejects(chat.send({ message: 'Hi', clientThreadId: 'ui-1', stateless: true }), error => error.code === 'STATELESS_UNSUPPORTED' && error.httpStatus === 409)
    assert.deepEqual(calls, [])
  })
  await withStore(async store => {
    const { chat, calls } = runtime(store, { answer: method => method === 'thread/start' ? { thread: { id: 'saved-thread', ephemeral: false } } : undefined })
    await assert.rejects(chat.send({ message: 'Hi', clientThreadId: 'ui-1', requestId: 'req-1', stateless: true }), error => error.code === 'STATELESS_UNVERIFIED' && error.httpStatus === 502)
    assert.deepEqual(calls.map(call => call.method), ['thread/start'], 'no turn was started')
    assert.equal(store.getConversation('ui-1').conversationId, null, 'the saved native thread was not bound')
  })
})

async function sourceConversation(chat, clientThreadId = 'ui-source') {
  const accepted = await chat.send({ message: 'Plan the launch', clientThreadId, requestId: `req-${clientThreadId}` })
  await finish(chat, accepted)
  return accepted
}

test('a branch is a new native thread bound to the new chat with the same account and engine and a record of its source', async () => {
  await withStore(async store => {
    const { chat, calls } = runtime(store)
    const source = await sourceConversation(chat)
    const sourceBinding = chat.getLocalHistory({ clientThreadId: 'ui-source', limit: 500 }).events.find(event => event.event === 'native.thread.bound').details
    const forked = await chat.fork({ conversationId: source.conversationId, clientThreadId: 'ui-branch', fromTurnId: source.runId })
    const forkedFrom = { conversationId: source.conversationId, turnId: source.runId, clientThreadId: 'ui-source' }
    assert.deepEqual(calls.at(-1), { method: 'thread/fork', params: { threadId: source.conversationId, lastTurnId: source.runId, excludeTurns: true, config: ORDINARY_CONFIG } })
    assert.deepEqual(forked, { accepted: true, durable: true, conversationId: 'fork-1', clientThreadId: 'ui-branch', localConversationId: forked.localConversationId, forkedFrom, engineId: 'codex' })
    const thread = store.getConversation('ui-branch')
    assert.deepEqual([thread.conversationId, thread.engineId, thread.engineProfileId, thread.stateless, thread.forkedFrom], ['fork-1', 'codex', 'codex-default', false, forkedFrom])
    assert.deepEqual(store.getConversationByNative('fork-1').clientThreadId, 'ui-branch')
    const bound = chat.getLocalHistory({ clientThreadId: 'ui-branch' }).events.find(event => event.event === 'native.thread.bound').details
    assert.deepEqual(bound, { conversationId: 'fork-1', ownerHash: sha256(OWNER_KEY), executionPolicy: null, browserToolsRegistered: sourceBinding.browserToolsRegistered, toolManifest: sourceBinding.toolManifest, engine: { id: 'codex', version: '0.162.1', engineProfileId: 'codex-default' }, forkedFrom })
    // The source chat is unchanged.
    assert.deepEqual([store.getConversation('ui-source').forkedFrom, store.getConversation('ui-source').conversationId], [null, source.conversationId])
    // The branch continues with its own conversationId; its history loads first.
    await assert.rejects(chat.send({ message: 'Next', clientThreadId: 'ui-branch', requestId: 'b-1' }), error => error.code === 'CONVERSATION_REQUIRED')
    const next = await chat.send({ message: 'Next', clientThreadId: 'ui-branch', requestId: 'b-2', conversationId: 'fork-1' })
    assert.deepEqual(calls.slice(-2).map(call => [call.method, call.params.threadId]), [['thread/resume', 'fork-1'], ['turn/start', 'fork-1']])
    assert.deepEqual(chat.snapshot('fork-1').runs.find(run => run.runId === next.runId).engine, { id: 'codex', version: '0.162.1', engineProfileId: 'codex-default' })
    // Without fromTurnId the whole conversation is branched.
    const whole = await chat.fork({ conversationId: source.conversationId, clientThreadId: 'ui-branch-2' })
    assert.deepEqual(calls.at(-1).params, { threadId: source.conversationId, excludeTurns: true, config: ORDINARY_CONFIG })
    assert.equal(whole.forkedFrom.turnId, null)
  })
})

test('a branch keeps the source\'s EG-Desk tools: their provider owns the new thread and its first send verifies them', async () => {
  await withStore(async store => {
    const registered = [], calls = []
    const notes = {
      providerId: 'egdesk-notes',
      specs: () => [{ type: 'function', name: 'egdesk_notes_read', description: 'Read notes', inputSchema: { type: 'object', properties: {} } }],
      prepare: async () => ({ selected: true }),
      registerThread: async cid => { registered.push(cid) },
      requireThread: cid => { if (!registered.includes(cid)) throw Object.assign(new Error('not registered'), { code: 'NOTES_UNAVAILABLE', httpStatus: 409 }) },
    }
    const chat = new CodexChatRuntime({ engines: [nativeCodex(calls)], toolProviders: [notes], store, requireStore: true, getOwnerKey: () => OWNER_KEY })
    chat.setConnection(true)
    const source = await sourceConversation(chat)
    assert.deepEqual(registered, [source.conversationId])
    await chat.fork({ conversationId: source.conversationId, clientThreadId: 'ui-branch' })
    assert.deepEqual(registered, [source.conversationId, 'fork-1'])
    const bound = chat.getLocalHistory({ clientThreadId: 'ui-branch' }).events.find(event => event.event === 'native.thread.bound').details
    assert.deepEqual(bound.toolManifest.map(entry => entry.providerId), ['egdesk-notes'])
    // A restarted bridge reads the branch's record and accepts a send that uses the tool.
    const restarted = new CodexChatRuntime({ engines: [nativeCodex(calls)], toolProviders: [notes], store, requireStore: true, getOwnerKey: () => OWNER_KEY })
    restarted.setConnection(true)
    const next = await restarted.send({ message: 'Use notes', clientThreadId: 'ui-branch', requestId: 'b-1', conversationId: 'fork-1' })
    assert.equal(next.accepted, true)
  })
})

test('a retried branch answers with the branch it made; other targets are refused', async () => {
  await withStore(async store => {
    const { chat, calls } = runtime(store)
    const source = await sourceConversation(chat)
    const other = await sourceConversation(chat, 'ui-other')
    const body = { conversationId: source.conversationId, clientThreadId: 'ui-branch', fromTurnId: source.runId }
    const first = await chat.fork(body)
    const forks = calls.filter(call => call.method === 'thread/fork').length
    const again = await chat.fork(body)
    assert.deepEqual(again, { ...first, duplicate: true })
    assert.equal(calls.filter(call => call.method === 'thread/fork').length, forks)
    const refused = [
      { ...body, fromTurnId: undefined },
      { conversationId: other.conversationId, clientThreadId: 'ui-branch' },
      { conversationId: source.conversationId, clientThreadId: 'ui-other' },
      { conversationId: source.conversationId, clientThreadId: 'ui-source' },
    ]
    for (const attempt of refused) await assert.rejects(chat.fork(attempt), error => error.code === 'FORK_TARGET_EXISTS' && error.httpStatus === 409, JSON.stringify(attempt))
    // An empty chat left by an interrupted attempt can still receive the branch.
    store.createConversation({ clientThreadId: 'ui-empty', createdAt: 1 })
    assert.equal((await chat.fork({ conversationId: source.conversationId, clientThreadId: 'ui-empty' })).clientThreadId, 'ui-empty')
    assert.equal(calls.filter(call => call.method === 'thread/fork').length, forks + 1)
  })
})

test('a branch is refused for bounded QA, one-time or unknown conversations, another account, and invalid requests', async () => {
  await withStore(async store => {
    const { chat, calls } = runtime(store)
    // A bounded QA conversation as its binding records it.
    store.createConversation({ clientThreadId: 'ui-qa', createdAt: 1 })
    store.appendEvent({ clientThreadId: 'ui-qa', eventKey: 'qa-bound', event: 'native.thread.bound', ts: 2, details: { conversationId: 'qa-native', ownerHash: sha256(OWNER_KEY), executionPolicy: 'readOnlyQa', toolManifest: [], engine: { id: 'codex', version: null, engineProfileId: 'codex-default' } } })
    store.bindNative({ clientThreadId: 'ui-qa', conversationId: 'qa-native', engineId: 'codex', engineProfileId: 'codex-default' })
    await assert.rejects(chat.fork({ conversationId: 'qa-native', clientThreadId: 'ui-b1' }), error => error.code === 'FORK_BOUNDED_FORBIDDEN' && error.httpStatus === 409)
    const once = await chat.send({ message: 'Once', clientThreadId: 'ui-once', requestId: 'r-once', stateless: true })
    await finish(chat, once)
    await assert.rejects(chat.fork({ conversationId: once.conversationId, clientThreadId: 'ui-b2' }), error => error.code === 'FORK_STATELESS_FORBIDDEN' && error.httpStatus === 409)
    await assert.rejects(chat.fork({ conversationId: 'never-bound', clientThreadId: 'ui-b3' }), error => error.code === 'CONVERSATION_NOT_FOUND' && error.httpStatus === 404)
    const source = await sourceConversation(chat)
    const stranger = runtime(store, { ownerKey: 'email:someone-else@example.com' })
    await assert.rejects(stranger.chat.fork({ conversationId: source.conversationId, clientThreadId: 'ui-b4' }), error => error.code === 'NATIVE_ACCOUNT_MISMATCH' && error.httpStatus === 403)
    await assert.rejects(chat.fork({ conversationId: source.conversationId, clientThreadId: 'ui-b5', engineId: 'claude' }), error => error.code === 'ENGINE_UNAVAILABLE')
    for (const [body, code] of [
      [{ clientThreadId: 'ui-b6' }, 'MISSING_THREAD_ID'],
      [{ conversationId: source.conversationId }, 'INVALID_CLIENT_THREAD_ID'],
      [{ conversationId: source.conversationId, clientThreadId: '  ' }, 'INVALID_CLIENT_THREAD_ID'],
      [{ conversationId: source.conversationId, clientThreadId: 'ui-b7', fromTurnId: 42 }, 'INVALID_TURN_ID'],
    ]) await assert.rejects(chat.fork(body), error => error.code === code, code)
    // A turn still running cannot be the branch point.
    const running = await chat.send({ message: 'Still going', clientThreadId: 'ui-source', requestId: 'r-run', conversationId: source.conversationId })
    await assert.rejects(chat.fork({ conversationId: source.conversationId, clientThreadId: 'ui-b8', fromTurnId: running.runId }), error => error.code === 'RUN_IN_PROGRESS')
    assert.equal(calls.some(call => call.method === 'thread/fork'), false)
    for (const id of ['ui-b1', 'ui-b2', 'ui-b3', 'ui-b4', 'ui-b8']) assert.equal(store.getConversation(id), null, `${id} was not created`)
  })
})

test('a branch needs local history, an engine that can branch, and a new native thread from the source', async () => {
  const chat = new CodexChatRuntime({ engines: [nativeCodex([])] })
  chat.setConnection(true)
  await assert.rejects(chat.fork({ conversationId: 'thread-1', clientThreadId: 'ui-2' }), error => error.code === 'CHAT_STORE_UNAVAILABLE' && error.httpStatus === 503)
  await withStore(async store => {
    const { chat } = runtime(store, { capabilities: ['stream', 'resume', 'interrupt'] })
    const source = await sourceConversation(chat)
    await assert.rejects(chat.fork({ conversationId: source.conversationId, clientThreadId: 'ui-2' }), error => error.code === 'FORK_UNSUPPORTED' && error.httpStatus === 409)
  })
  for (const [reply, code] of [[{ thread: { id: 'thread-1' } }, 'INVALID_THREAD_RESPONSE'], [{ thread: {} }, 'INVALID_THREAD_RESPONSE'], [{ thread: { id: 'fork-x', forkedFromId: 'someone-else' } }, 'THREAD_MISMATCH']]) {
    await withStore(async store => {
      const { chat } = runtime(store, { answer: method => method === 'thread/fork' ? reply : undefined })
      const source = await sourceConversation(chat)
      await assert.rejects(chat.fork({ conversationId: source.conversationId, clientThreadId: 'ui-2' }), error => error.code === code, code)
      assert.equal(store.getConversation('ui-2'), null)
      assert.equal(chat.locks.size, 0, 'the new chat is not left locked')
    })
  }
})

test('the store reads stateless and forkedFrom from the binding of the bound native thread only', async () => {
  await withStore(async store => {
    store.createConversation({ clientThreadId: 'c-1', createdAt: 1 })
    assert.deepEqual([store.getConversation('c-1').stateless, store.getConversation('c-1').forkedFrom], [false, null])
    // A binding event for another native thread is not this chat's session.
    store.appendEvent({ clientThreadId: 'c-1', eventKey: 'stray', event: 'native.thread.bound', ts: 2, details: { conversationId: 'other-native', stateless: true } })
    store.bindNative({ clientThreadId: 'c-1', conversationId: 'native-1' })
    assert.equal(store.getConversation('c-1').stateless, false)
    store.createConversation({ clientThreadId: 'c-2', createdAt: 3 })
    store.appendEvent({ clientThreadId: 'c-2', eventKey: 'bound', event: 'native.thread.bound', ts: 4, details: { conversationId: 'native-2', forkedFrom: { conversationId: 'native-1', turnId: 7, clientThreadId: 'c-1' } } })
    store.bindNative({ clientThreadId: 'c-2', conversationId: 'native-2' })
    assert.deepEqual(store.getConversation('c-2').forkedFrom, { conversationId: 'native-1', turnId: null, clientThreadId: 'c-1' })
    assert.deepEqual(store.listConversations({ limit: 10 }).threads.map(thread => [thread.clientThreadId, Boolean(thread.forkedFrom)]), [['c-2', true], ['c-1', false]])
    assert.equal(store.getConversationByNative('native-1').clientThreadId, 'c-1')
    assert.equal(store.getConversationByNative('missing'), null)
    assert.throws(() => store.getConversationByNative(''), { code: 'INVALID_CHAT_RECORD' })
  })
})

function request(body, url) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method: 'POST', url, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
  return req
}
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, end(body) { this.body = body ? JSON.parse(body) : null } }
}

test('POST /chat/fork signs in first, answers 201 for a new branch, 200 for a retried one and a public error otherwise', async () => {
  const seen = [], auth = []
  const chat = { fork: async body => {
    seen.push(body)
    if (body.clientThreadId === 'bad') throw Object.assign(new Error('A bounded QA conversation cannot be branched'), { code: 'FORK_BOUNDED_FORBIDDEN', httpStatus: 409 })
    return { accepted: true, conversationId: 'fork-1', clientThreadId: body.clientThreadId, ...(body.clientThreadId === 'again' ? { duplicate: true } : {}) }
  } }
  const handler = createChatHttpHandler(chat, async body => { auth.push(body) })
  const call = async body => {
    const res = response()
    assert.equal(await handler(request(body, '/chat/fork'), res, new URL('http://127.0.0.1:39218/chat/fork')), true)
    return res
  }
  const created = await call({ conversationId: 'thread-1', clientThreadId: 'ui-2', fromTurnId: 'turn-1' })
  assert.equal(created.status, 201)
  assert.deepEqual(created.body, { accepted: true, conversationId: 'fork-1', clientThreadId: 'ui-2' })
  assert.deepEqual(seen[0], { conversationId: 'thread-1', clientThreadId: 'ui-2', fromTurnId: 'turn-1' })
  assert.equal(auth.length, 1, 'a branch needs the signed-in account')
  assert.equal((await call({ conversationId: 'thread-1', clientThreadId: 'again' })).status, 200)
  const refused = await call({ conversationId: 'thread-1', clientThreadId: 'bad' })
  assert.equal(refused.status, 409)
  assert.deepEqual(refused.body, { accepted: false, conversationId: 'thread-1', requestId: null, code: 'FORK_BOUNDED_FORBIDDEN', error: 'A bounded QA conversation cannot be branched' })
  const getRes = response()
  const get = request({}, '/chat/fork'); get.method = 'GET'
  assert.equal(await handler(get, getRes, new URL('http://127.0.0.1:39218/chat/fork')), false)
})
