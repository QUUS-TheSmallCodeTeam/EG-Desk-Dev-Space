import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createChatHttpHandler } from './codex-bridge-http.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'

const ids = { clientThreadId: 'dm-synthetic', conversationId: 'native-synthetic', profileId: 'agent-synthetic' }
const { clientThreadId, conversationId, profileId } = ids
const time = 1780000000000
const requestId = (at = time) => `choice-${at}-${randomUUID()}`
const reviewRevision = 'a'.repeat(64)
const choice = { ...ids, requestId: requestId(), question: 'Which color?', options: ['Red', 'Blue'], confirm: true, reviewRevision }
const engine = { id: 'codex', engineProfileId: 'codex-default' }
const profileBinding = { profileId, revision: 1, hash: 'synthetic-profile-hash' }
const author = 'synthetic-account'
const ownerHash = createHash('sha256').update(author).digest('hex')
const seedRequest = 'previous-send'
const localMessageId = 'previous-local-message'
const localRunId = 'previous-local-run'
const runId = 'previous-native-run'

function setup(t, { direct = true, durable = true, mode = 'on', policy = null, busy = false, forkedFrom = null, stateless = false, board = false, recordedOwner = ownerHash } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'egdesk-choice-db-'))
  const store = openChatStore({ dataDir, ownerScope: 'fixture-only' })
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }) })
  store.createConversation({ clientThreadId, createdAt: 1 })
  store.setRoomAgent({ clientThreadId, profileId, revision: 1, ts: 2 })
  if (board) store.setRoomMembers({ clientThreadId, members: [{ kind: 'user', role: 'owner' }], ts: 2 })
  if (durable) store.acceptRequest({ clientThreadId, requestId: seedRequest, fingerprint: 'synthetic-request', ts: 3, localMessageId,
    message: { role: 'user', text: 'Previous native message is not sent to Decisions' } })
  store.appendEvent({ clientThreadId, eventKey: 'native-binding', event: 'native.thread.bound', ts: 4,
    details: { conversationId, ownerHash: recordedOwner, ...(direct ? { replyDestination: 'direct' } : {}), engine, executionPolicy: policy, forkedFrom, stateless } })
  store.bindNative({ clientThreadId, conversationId, engineId: engine.id, engineProfileId: engine.engineProfileId, localRunId, runId })
  if (durable) store.recordRequestOutcome({ clientThreadId, requestId: seedRequest, ts: 5,
    outcome: { accepted: true, dispatchStatus: 'confirmed', conversationId, runId, localRunId, accountIdentity: { status: 'verified', ownerHash } } })
  store.appendEvent({ clientThreadId, eventKey: 'run-terminal', event: 'run.completed', ts: 6, requestId: seedRequest, localRunId, runId,
    details: { status: 'completed' }, runCheckpoint: { conversationId, clientThreadId, requestId: seedRequest, runId, localRunId,
      engine, profileBinding, status: 'completed', messages: [], pendingApprovals: [], pendingUserInputs: [] } })
  const state = { mode, generation: 1, reviewRevision, now: time, key: 'fixture-only-decision-credential', account: author, native: 0, attempts: 0, posts: [] }
  const noNative = () => { state.native++; throw Error('Unexpected native operation') }
  const createClient = () => createDecisionClient({
    getApiKey: async () => { state.attempts++; const key = state.key; await state.onKey?.(); return key },
    recipientForKey: (key, endpoint, model) => decisionTopicRecipient(key, 42, endpoint, model),
    fetchImpl: async (url, req) => {
      const body = JSON.parse(req.body)
      state.posts.push({ url, body }); await state.onFetch?.()
      const q = body.questions[0]
      return new Response(JSON.stringify({ answers: [{ name: q.name, probabilities: q.choices.map((item, i) => ({ value: item.value, probability: [0.96, 0.03, 0.01][i] })), type: 'choice', choice: q.choices[0].value, confidence: 0.96 }] }))
    },
  })
  const decisionContext = { client: createClient(), mode: () => state.mode, configured: () => !!state.key,
    settingsGeneration: () => state.generation, reviewRevision: () => state.reviewRevision, recipientForChatChoice: ({ ownerKey }) => ownerKey === state.account ? decisionTopicRecipient(state.key, 42) : null }
  const getOwnerKey = () => state.account
  const adapter = createCodexEngineAdapter({ request: noNative, respond: noNative, getOwnerKey,
    profiles: { ensureReady: noNative } })
  Object.assign(adapter, { ensureReady: noNative, startTurn: noNative })
  const chat = new CodexChatRuntime({ request: noNative, respond: noNative, engines: [adapter], store, requireStore: true,
    getOwnerKey, now: () => state.now, profiles: { runProfile: () => ({ binding: profileBinding, developerInstructions: 'synthetic instructions' }) }, decisionContext })
  chat.startTurn = noNative
  if (busy) chat.pendingApprovals.set('approval', { conversationId, status: 'pending' })
  const handle = createChatHttpHandler(chat, noNative)
  const post = async (body = choice, { origin = 'chrome://browser', method = 'POST', contentType = 'application/json', url = '/chat/choice', attach } = {}) => {
    const req = Object.assign(new EventEmitter(), { url, method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:39218', origin, 'content-type': contentType },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } })
    const response = {}
    const res = Object.assign(new EventEmitter(), { writeHead(status) { response.status = status }, end(data) { response.body = JSON.parse(data) } })
    attach?.(req, res)
    const handled = await handle(req, res, new URL(url, 'http://127.0.0.1:39218'))
    assert.equal(handled, true)
    return response
  }
  t.after(() => assert.equal(state.native, 0))
  return { post, state, chat, store }
}

test('chrome POST yields only the recommendation, leaves durable history untouched and spends once', async t => {
  const { post, state, store, chat } = setup(t)
  const before = store.listEvents(clientThreadId)
  const [first, second] = await Promise.all([post(), post()])
  assert.deepEqual(first, { status: 200, body: { status: 'recommended', index: 0 } })
  assert.deepEqual(second, { status: 200, body: { status: 'manual' } })
  assert.deepEqual(await post({ ...choice, options: ['Red', 'Green'] }), { status: 409, body: { code: 'CHAT_CHOICE_DUPLICATE' } })
  assert.equal(state.posts.length, 1)
  assert.equal(state.posts[0].body.questions.length, 1)
  for (const omitted of [clientThreadId, conversationId, profileId, reviewRevision, 'Previous native message', 'synthetic instructions']) {
    assert.equal(JSON.stringify(state.posts[0].body).includes(omitted), false)
  }
  assert.deepEqual(store.listEvents(clientThreadId), before)
  assert.equal(chat.runs.size, 0)
})

test('rejects forged fields, cross-origin, byte limits and unsupported methods before provider or native work', async t => {
  const { post, state } = setup(t)
  for (const [body, opts, status] of [
    [{ ...choice, confirm: false }, {}, 400], [{ ...choice, engineProfileId: 'forged' }, {}, 400],
    [{ ...choice, profileId: 'different-agent' }, {}, 403], [choice, { origin: 'https://example.invalid' }, 403],
    [choice, { method: 'GET' }, 405], [choice, { contentType: 'text/plain' }, 415],
    [{ ...choice, question: 'x'.repeat(16384) }, {}, 413], [choice, { url: '/chat/choice?extra=1' }, 400],
  ]) assert.equal((await post(body, opts)).status, status)
  assert.equal(state.attempts, 0)
})

for (const [label, opts] of Object.entries({ 'no direct binding': { direct: false }, 'no durable author': { durable: false },
  'approval pending': { busy: true }, 'restricted policy': { policy: 'readOnlyQa' }, fork: { forkedFrom: { conversationId: 'different-native' } },
  stateless: { stateless: true }, 'saved Board': { board: true }, 'wrong account': { recordedOwner: 'other-account' } })) {
  test(`scope rejects ${label} before asking Decisions`, async t => {
    const { post, state } = setup(t, opts)
    assert.equal((await post()).status, 403)
    assert.equal(state.attempts, 0)
  })
}

test('exact reviewed input rejects noncanonical or missing text before key lookup and accepts canonical Korean', async t => {
  const { post, state } = setup(t)
  const invalid = { status: 400, body: { code: 'CHAT_CHOICE_INVALID' } }
  const korean = { ...choice, question: '어떤 색이 좋나요?', options: ['빨강', '파랑'] }
  const missing = { ...korean }; delete missing.question
  assert.deepEqual(await post({ ...choice, question: ' Q ' }), invalid)
  assert.deepEqual(await post({ ...korean, options: [korean.options[0].normalize('NFD'), korean.options[1]] }), invalid)
  assert.deepEqual(await post({ ...korean, options: [' 빨강 ', '파랑'] }), invalid)
  assert.deepEqual(await post(missing), invalid)
  assert.equal(state.attempts, 0)
  assert.equal(state.posts.length, 0)
  assert.equal(state.native, 0)
  assert.deepEqual(await post(korean), { status: 200, body: { status: 'recommended', index: 0 } })
  assert.equal(state.attempts, 1)
  assert.equal(state.posts.length, 1)
})

test('off mode and revoked authority give manual; no restart or native fallback', async t => {
  const { post, state } = setup(t, { mode: 'off' })
  const manual = { status: 200, body: { status: 'manual' } }
  assert.deepEqual(await post(), manual)
  state.mode = 'on'
  assert.deepEqual(await post(), manual)
  assert.equal(state.attempts, 0)
  state.onKey = () => { state.generation++ }
  assert.deepEqual(await post({ ...choice, requestId: requestId() }), manual)
  assert.equal(state.posts.length, 0)
  state.onKey = () => { state.key += '-changed' }
  assert.deepEqual(await post({ ...choice, requestId: requestId() }), manual)
  assert.equal(state.posts.length, 0)
  state.onKey = null
  state.onFetch = () => { state.account = 'changed-account' }
  assert.deepEqual(await post({ ...choice, requestId: requestId() }), manual)
  assert.equal(state.posts.length, 1)
})

test('stalled key lookup reaches the host deadline and cannot fetch after release', async t => {
  const { post, state, chat } = setup(t)
  chat.decisionContext.choiceBudgetMs = 25
  let release
  const blocked = new Promise(resolve => { release = resolve })
  state.onKey = () => blocked
  assert.deepEqual(await post(), { status: 200, body: { status: 'manual' } })
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.attempts, 1)
  assert.equal(state.posts.length, 0)
})

const manual = { status: 200, body: { status: 'manual' } }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('the reviewed epoch cannot be relabeled after credential change or an off/on round trip', async t => {
  const { post, state } = setup(t)
  const missing = { ...choice }; delete missing.reviewRevision
  assert.equal((await post(missing)).status, 400)
  state.key += '-replacement'
  state.reviewRevision = 'b'.repeat(64)
  assert.deepEqual(await post(), manual)
  state.mode = 'off'; state.mode = 'on'
  state.reviewRevision = 'c'.repeat(64)
  assert.deepEqual(await post({ ...choice, requestId: requestId(), reviewRevision: 'b'.repeat(64) }), manual)
  assert.equal(state.attempts, 0)
  assert.equal(state.posts.length, 0)
  state.onKey = () => { state.reviewRevision = 'd'.repeat(64) }
  assert.deepEqual(await post({ ...choice, requestId: requestId(), reviewRevision: 'c'.repeat(64) }), manual)
  assert.equal(state.attempts, 1)
  assert.equal(state.posts.length, 0)
  state.onKey = null
  state.onFetch = () => { state.reviewRevision = 'e'.repeat(64) }
  assert.deepEqual(await post({ ...choice, requestId: requestId(), reviewRevision: 'd'.repeat(64) }), manual)
  assert.equal(state.posts.length, 1)
})

test('HTTP response close while waiting for the key prevents the POST', async t => {
  const { post, state } = setup(t)
  const entered = deferred(), key = deferred()
  let response
  state.onKey = () => { entered.resolve(); return key.promise }
  const result = post(choice, { attach: (_req, res) => { response = res } })
  await entered.promise
  response.emit('close')
  assert.deepEqual(await result, {})
  key.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.attempts, 1)
  assert.equal(state.posts.length, 0)
  assert.equal(response.listenerCount('close'), 0)
})

test('HTTP response close after dispatch discards the result without retry or recall', async t => {
  const { post, state } = setup(t)
  const sent = deferred(), provider = deferred()
  let response
  state.onFetch = () => { sent.resolve(); return provider.promise }
  const result = post(choice, { attach: (_req, res) => { response = res } })
  await sent.promise
  response.emit('close')
  assert.deepEqual(await result, {})
  provider.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.posts.length, 1)
})

test('live IDs never evict; expiry recovers space without reviving charged IDs even after clock rollback', async t => {
  const { post, state, chat } = setup(t)
  const recommended = { status: 200, body: { status: 'recommended', index: 0 } }
  assert.deepEqual(await post(), recommended)
  state.mode = 'off'
  for (let i = 0; i < 255; i++) assert.deepEqual(await post({ ...choice, requestId: requestId() }), manual)
  assert.equal(chat.choiceRequests.size, 256)
  state.mode = 'on'
  assert.deepEqual(await post(), manual)
  assert.deepEqual(await post({ ...choice, requestId: requestId() }), manual)
  assert.deepEqual(await post({ ...choice, requestId: requestId(time + 1) }), manual)
  assert.equal(state.posts.length, 1)
  state.now += 120000
  assert.deepEqual(await post(), manual)
  assert.deepEqual(await post({ ...choice, requestId: requestId(state.now) }), recommended)
  assert.equal(chat.choiceRequests.size, 1)
  state.now = time
  assert.deepEqual(await post(), manual)
  assert.equal(state.posts.length, 2)
})
