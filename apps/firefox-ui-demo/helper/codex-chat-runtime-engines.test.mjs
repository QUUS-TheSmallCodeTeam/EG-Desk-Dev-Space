import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter, describeCodexEngine } from './codex-engine-adapter.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { EngineRegistry, describeClaudeEngine } from './engine-registry.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const OWNER_KEY = 'email:owner@example.com'
const sha256 = text => createHash('sha256').update(text).digest('hex')

// Native-shaped answers for any engine: the internal reference is the Codex
// app-server vocabulary, which a non-Codex adapter must also return.
function nativeAnswers(prefix) {
  let threads = 0, turns = 0
  return (method, params) => {
    if (method === 'thread/start') return { thread: { id: `${prefix}-thread-${++threads}` }, cwd: '/work', model: `${prefix}-model` }
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work' }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    if (method === 'turn/start') return { turn: { id: `${prefix}-turn-${++turns}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    throw new Error(`Unexpected method: ${method}`)
  }
}

function codexEngine(calls, options = {}) {
  const answer = nativeAnswers('codex')
  return createCodexEngineAdapter({ request: async (method, params) => { calls.push(['codex', method, params]); return answer(method, params) }, respond: () => {}, ...options })
}

// A stand-in second engine (not the future Claude adapter): native-shaped
// results, no Codex escape hatch and no bounded-QA proof.
function claudeLikeEngine(calls, { ready = () => true } = {}) {
  const answer = nativeAnswers('claude')
  const call = (method, params) => { calls.push(['claude', method, params]); return Promise.resolve(answer(method, params)) }
  return {
    id: 'claude', describe: () => ({ id: 'claude', status: 'ready', version: '2.1.300', profiles: [{ id: 'claude-default', active: true }] }),
    refresh: async () => ({}), capabilities: () => new Set(['stream', 'resume', 'interrupt']), ownerKey: () => 'claude-account', isReady: () => ready(),
    startThread: params => call('thread/start', params), resumeThread: params => call('thread/resume', params),
    releaseThread: threadId => call('thread/unsubscribe', { threadId }), startTurn: params => call('turn/start', params),
    interruptTurn: (threadId, turnId) => call('turn/interrupt', { threadId, turnId }),
    respond: () => true, subscribe: () => () => {}, dispose: async () => {},
  }
}

test('runtime routes native conversation calls through injected engine adapters and keeps the Codex escape hatch', async () => {
  const calls = []
  const codex = codexEngine(calls)
  const chat = new CodexChatRuntime({ engines: [codex] })
  assert.equal(chat.request, codex.request)
  assert.equal(chat.engineOf('unknown-thread'), codex)
  chat.setConnection(true)
  const run = await chat.send({ message: 'Hello' })
  await chat.interrupt(run)
  assert.deepEqual(calls.map(call => call[1]), ['thread/start', 'turn/start', 'turn/interrupt'])
  assert.deepEqual(calls[2][2], { threadId: run.conversationId, turnId: run.runId })
})

test('runtime refuses missing, duplicate or invalid engine adapters before any work', () => {
  const claudeOnly = { ...codexEngine([]), id: 'claude' }
  delete claudeOnly.request
  assert.throws(() => new CodexChatRuntime({ engines: [claudeOnly] }), { code: 'INVALID_ENGINE_ADAPTER' })
  assert.throws(() => new CodexChatRuntime({ engines: [codexEngine([]), codexEngine([])] }), { code: 'INVALID_ENGINE_ADAPTER' })
  assert.throws(() => new CodexChatRuntime({ engines: [{ ...codexEngine([]), startTurn: undefined }] }), { code: 'INVALID_ENGINE_ADAPTER' })
})

test('Codex undefined response remains successful for approvals, answers and skipped questions', async () => {
  const calls = [], replies = []
  const chat = new CodexChatRuntime({ engines: [codexEngine(calls, { respond: (...args) => { replies.push(args) } })] })
  chat.setConnection(true)
  const run = await chat.send({ message: 'Ask me' })
  await chat.handleServerRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: {
    threadId: run.conversationId, turnId: run.runId, itemId: 'bash', command: 'ls', availableDecisions: ['accept', 'decline'],
  } })
  const approval = chat.snapshot(run.conversationId).runs[0].pendingApprovals[0]
  assert.equal((await chat.replyApproval({ ...run, approvalId: approval.approvalId, decision: 'accept' })).accepted, true)
  for (const [index, action] of ['submit', 'skip'].entries()) {
    await chat.handleServerRequest({ id: 2 + index, method: 'item/tool/requestUserInput', params: {
      threadId: run.conversationId, turnId: run.runId, itemId: `question-${index}`, questions: [{ id: 'q0', header: 'Pick', question: 'Which?', options: [{ label: 'First', description: 'One' }] }],
    } })
    const input = chat.snapshot(run.conversationId).runs[0].pendingUserInputs.at(-1)
    const accepted = await chat.replyUserInput({ ...run, userInputId: input.userInputId, action, answers: [{ questionId: 'q0', optionIndex: 0 }] })
    assert.deepEqual([accepted.accepted, accepted.status], [true, 'replySent'])
  }
  assert.deepEqual(replies.map(reply => reply[0]), [1, 2, 3])
})

async function withStore(prefix, action) {
  const dataDir = createPrivateQaTempDirectory(prefix)
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
    await action(store)
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
}

test('a durable Codex turn records engine, version and account slot without changing event order or the owner hash', async () => {
  await withStore('egdesk-runtime-engine-', async store => {
    const calls = [], events = []
    const codex = codexEngine(calls, { describe: () => describeCodexEngine({ ready: true, version: '0.162.1', auth: { isLoggedIn: true } }) })
    const chat = new CodexChatRuntime({ engines: [codex], store, requireStore: true, getOwnerKey: () => OWNER_KEY, emit: event => events.push(event) })
    chat.setConnection(true)
    const accepted = await chat.send({ message: 'Record the engine', clientThreadId: 'ui-1', requestId: 'req-1' })
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: accepted.conversationId, turn: { id: accepted.runId, status: 'completed', items: [] } } })
    const history = chat.getLocalHistory({ clientThreadId: 'ui-1', limit: 500 })
    const bound = history.events.find(event => event.event === 'native.thread.bound')
    assert.deepEqual(bound.details.engine, { id: 'codex', version: '0.162.1', engineProfileId: 'codex-default' })
    assert.equal(bound.details.ownerHash, sha256(OWNER_KEY), 'Codex keeps its unprefixed owner key')
    assert.deepEqual(history.runs[0].engine, { id: 'codex', version: '0.162.1', engineProfileId: 'codex-default' })
    // Schema v2: the local chat itself is locked to the engine of its first send.
    assert.deepEqual([history.thread.engineId, history.thread.engineProfileId], ['codex', 'codex-default'])
    assert.deepEqual(history.runs[0].accountIdentity, { ownerHash: sha256(OWNER_KEY), status: 'verified' })
    assert.ok(events.length > 0 && events.every(event => event.provider === 'codex' && event.engineId === 'codex'))
    assert.deepEqual(history.events.map(event => event.event).filter(name => ['run.dispatching', 'native.thread.bound', 'run.started', 'run.configuration'].includes(name)),
      ['run.dispatching', 'native.thread.bound', 'run.started', 'run.configuration'])
    // An older binding without an engine record continues as Codex.
    const continued = await chat.send({ message: 'Continue', clientThreadId: 'ui-1', requestId: 'req-2', conversationId: accepted.conversationId, engineId: 'codex' })
    assert.equal(continued.accepted, true)
    assert.deepEqual(calls.map(call => call[1]), ['thread/start', 'turn/start', 'turn/start'])
  })
})

test('request fingerprints change only when an engine is named, so pre-engine requests replay as duplicates', async () => {
  await withStore('egdesk-runtime-fingerprint-', async store => {
    const chat = new CodexChatRuntime({ engines: [codexEngine([])], store, requireStore: true, getOwnerKey: () => OWNER_KEY })
    chat.setConnection(true)
    const body = { message: 'Hi', clientThreadId: 'ui-1', requestId: 'req-1' }
    await chat.send(body)
    // The exact fingerprint an EG-Desk build without engine selection recorded.
    assert.equal(store.getRequest({ clientThreadId: 'ui-1', requestId: 'req-1' }).fingerprint, sha256(JSON.stringify({ message: 'Hi', clientThreadId: 'ui-1', profileEnabled: false })))
    const restarted = new CodexChatRuntime({ engines: [codexEngine([])], store, requireStore: true, getOwnerKey: () => OWNER_KEY })
    restarted.setConnection(true)
    assert.equal((await restarted.send(body)).duplicate, true)
    await assert.rejects(restarted.send({ ...body, engineId: 'codex' }), error => error.code === 'REQUEST_CONFLICT')
  })
})

test('unknown engines are unavailable and a conversation bound to another engine is never continued here', async () => {
  const calls = []
  const chat = new CodexChatRuntime({ engines: [codexEngine(calls)] })
  chat.setConnection(true)
  for (const engineId of ['claude', 'gemini', 7, '']) {
    await assert.rejects(chat.send({ message: 'Hi', engineId }), error => error.code === 'ENGINE_UNAVAILABLE' && error.httpStatus === 503)
  }
  assert.deepEqual(calls, [])
  const bound = new CodexChatRuntime({
    engines: [codexEngine(calls)], getOwnerKey: () => OWNER_KEY,
    store: {
      getConversation: () => ({ clientThreadId: 'client-1', localConversationId: 'local-1', conversationId: 'native-1' }),
      getRequest: () => null,
      listEvents: () => ({ events: [{ event: 'native.thread.bound', details: { conversationId: 'native-1', ownerHash: sha256(OWNER_KEY), engine: { id: 'claude', version: '2.1.300', engineProfileId: 'claude-default' } } }], nextCursor: null, hasMore: false }),
    },
  })
  bound.setConnection(true)
  await assert.rejects(bound.send({ clientThreadId: 'client-1', conversationId: 'native-1', message: 'Continue', engineId: 'codex' }), error => error.code === 'ENGINE_MISMATCH' && error.httpStatus === 409)
  await assert.rejects(bound.send({ clientThreadId: 'client-1', conversationId: 'native-1', message: 'Continue' }), error => error.code === 'ENGINE_UNAVAILABLE')
  await assert.rejects(bound.resume({ clientThreadId: 'client-1', conversationId: 'native-1' }), error => error.code === 'ENGINE_UNAVAILABLE')
  assert.equal(bound.storeHealthy, true, 'an engine refusal is not a storage failure')
  assert.deepEqual(calls, [])
})

test('a listed but undecided engine is refused with its reason, and bounded QA needs an engine that can prove it', async () => {
  const registry = new EngineRegistry()
  const calls = []
  registry.register(codexEngine(calls))
  registry.describe(describeClaudeEngine())
  const chat = new CodexChatRuntime({ engines: registry })
  chat.setConnection(true)
  await assert.rejects(chat.send({ message: 'Hi', engineId: 'claude' }), error => error.code === 'ENGINE_UNAVAILABLE' && /being decided/.test(error.message))
  const both = new EngineRegistry()
  both.register(codexEngine(calls))
  both.register(claudeLikeEngine(calls))
  const mixed = new CodexChatRuntime({ engines: both })
  mixed.setConnection(true)
  mixed.setConnection('claude', true)
  await assert.rejects(mixed.send({ message: 'Read only', engineId: 'claude', executionPolicy: { mode: 'readOnlyQa' } }), error => error.code === 'QA_POLICY_UNAVAILABLE')
  assert.deepEqual(calls, [])
})

function twoEngines(override = {}) {
  const calls = [], events = [], legacy = [], lifecycle = []
  const registry = new EngineRegistry()
  registry.register(codexEngine(calls))
  registry.register(claudeLikeEngine(calls))
  const provider = { providerId: 'test-provider', disconnect: () => lifecycle.push('disconnect'), reset: () => lifecycle.push('reset'), cancelRun: run => lifecycle.push(['cancel', run.runId]) }
  const chat = new CodexChatRuntime({ engines: registry, toolProviders: [provider], emit: event => events.push(event), emitLegacy: event => legacy.push(event), ...override })
  chat.setConnection(true)
  chat.setConnection('claude', true)
  const runOf = reply => chat.snapshot().runs.find(run => run.runId === reply.runId)
  return { chat, calls, events, legacy, lifecycle, runOf }
}

test('losing the Codex process fails only Codex runs; the other engine keeps running and accepting turns', async () => {
  const { chat, calls, events, lifecycle, runOf } = twoEngines()
  const codexRun = await chat.send({ message: 'Codex work' })
  const claudeRun = await chat.send({ message: 'Other engine work', engineId: 'claude' })
  assert.deepEqual(calls.map(call => `${call[0]}:${call[1]}`), ['codex:thread/start', 'codex:turn/start', 'claude:thread/start', 'claude:turn/start'])
  assert.deepEqual(runOf(claudeRun).engine, { id: 'claude', version: '2.1.300', engineProfileId: 'claude-default' })
  assert.ok(events.filter(event => event.runId === claudeRun.runId).every(event => event.engineId === 'claude' && event.provider === 'codex'))
  const epoch = chat.epochOf('claude')
  chat.setConnection(false, { processLost: true })
  assert.equal(chat.connection, 'offline')
  assert.equal(chat.connectionOf('claude'), 'ready')
  assert.equal(chat.epochOf('claude'), epoch)
  assert.equal(runOf(codexRun).status, 'failed')
  assert.equal(runOf(codexRun).error.code, 'RUNTIME_LOST')
  assert.equal(runOf(claudeRun).status, 'inProgress')
  assert.equal(runOf(claudeRun).error, null)
  assert.equal(events.some(event => event.event === 'run.unavailable' && event.runId === claudeRun.runId), false)
  assert.deepEqual(lifecycle, ['disconnect'])
  // The other engine's notifications still apply and its conversations continue.
  await chat.handleNotification({ method: 'turn/completed', params: { threadId: claudeRun.conversationId, turn: { id: claudeRun.runId, status: 'completed', items: [] } } })
  assert.equal(runOf(claudeRun).status, 'completed')
  const continued = await chat.send({ message: 'Continue there', conversationId: claudeRun.conversationId })
  assert.equal(runOf(continued).engine.id, 'claude')
  await chat.interrupt(continued)
  assert.deepEqual(calls.slice(4).map(call => `${call[0]}:${call[1]}`), ['claude:turn/start', 'claude:turn/interrupt'])
  await assert.rejects(chat.send({ message: 'Codex is down' }), error => error.code === 'BRIDGE_OFFLINE')
  await assert.rejects(chat.send({ message: 'Wrong engine', conversationId: claudeRun.conversationId, engineId: 'codex' }), error => error.code === 'ENGINE_MISMATCH')
})

test('a lost non-Codex engine and a Codex account reset each leave the other engine untouched', async () => {
  const { chat, legacy, lifecycle, runOf } = twoEngines()
  const codexRun = await chat.send({ message: 'Codex work' })
  const claudeRun = await chat.send({ message: 'Other engine work', engineId: 'claude' })
  const codexEpoch = chat.epoch
  chat.setConnection('claude', false)
  assert.equal(chat.connectionOf('claude'), 'offline')
  assert.equal(chat.connection, 'ready')
  assert.equal(chat.epoch, codexEpoch, 'the Codex epoch alias is untouched')
  assert.equal(runOf(claudeRun).status, 'unknown')
  assert.equal(runOf(claudeRun).error.code, 'CONNECTION_LOST')
  assert.equal(runOf(codexRun).status, 'inProgress')
  assert.deepEqual(legacy.filter(event => event.type === 'assistant-error').map(event => event.conversationId), [claudeRun.conversationId])
  assert.deepEqual(lifecycle, [['cancel', claudeRun.runId]], 'shared tool providers are not disconnected for another engine')
  await assert.rejects(chat.send({ message: 'Offline engine', engineId: 'claude' }), error => error.code === 'ENGINE_UNAVAILABLE' && error.httpStatus === 503)
  const streamId = chat.streamId
  chat.reset()
  assert.notEqual(chat.streamId, streamId)
  assert.deepEqual(chat.snapshot().runs.map(run => run.runId), [claudeRun.runId], 'a Codex account change keeps the other engine history')
  assert.ok(lifecycle.includes('reset'))
  chat.reset('claude')
  assert.deepEqual(chat.snapshot().runs, [])
  // A reset engine's request IDs are forgotten; the other engine's are kept until its own reset.
  assert.equal(chat.requests.size, 0)
})

test('Codex-only process configuration and ordinary instructions never apply to another engine conversation', async () => {
  const { chat, calls, runOf } = twoEngines({ expectedProcessConfiguration: { model: 'codex-configured-model', effort: null } })
  const first = await chat.send({ message: 'Other engine work', engineId: 'claude' })
  await chat.handleNotification({ method: 'turn/completed', params: { threadId: first.conversationId, turn: { id: first.runId, status: 'completed', items: [] } } })
  const next = await chat.send({ message: 'Without a profile', conversationId: first.conversationId, profileEnabled: false })
  assert.equal(runOf(next).engine.id, 'claude')
  assert.equal(calls.some(call => call[0] === 'codex'), false, 'no Codex config/read or process check for another engine')
  assert.deepEqual(calls.map(call => call[1]), ['thread/start', 'turn/start', 'thread/unsubscribe', 'thread/resume', 'turn/start'])
  assert.equal(calls[3][2].developerInstructions, '')
  // The same Codex process check still guards Codex threads.
  await assert.rejects(chat.send({ message: 'Codex work' }), error => error.code === 'NATIVE_CONFIGURATION_MISMATCH')
})

// model/list rows as codex-model-catalog.mjs publishes them (engines[].models).
const LISTED_MODELS = [
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedEfforts: ['low', 'medium', 'high', 'ultra'], defaultEffort: 'low' },
  { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', isDefault: false, supportedEfforts: ['low', 'medium', 'max'], defaultEffort: 'medium' },
  { id: 'codex-model', displayName: 'Thread model', isDefault: false, supportedEfforts: ['low'], defaultEffort: 'low' },
]

test('a turn may name only a listed model and an effort that model lists; without a list it passes as before', async () => {
  const calls = []
  let listed = LISTED_MODELS
  const chat = new CodexChatRuntime({ engines: [codexEngine(calls, { getModels: () => listed })] })
  chat.setConnection(true)
  const refused = code => error => error.code === code && error.httpStatus === 400
  await assert.rejects(chat.send({ message: 'Hi', model: 'gpt-reserve' }), refused('MODEL_UNAVAILABLE'))
  await assert.rejects(chat.send({ message: 'Hi', model: 'gpt-6-luna', effort: 'ultra' }), refused('EFFORT_UNSUPPORTED'))
  await assert.rejects(chat.send({ message: 'Hi', effort: 'xhigh' }), refused('EFFORT_UNSUPPORTED'), 'no listed model supports it')
  assert.deepEqual(calls, [], 'refused before any native call')
  // Unchosen settings are not checked against the list (the process default runs).
  const plain = await chat.send({ message: 'Hi', requestId: 'plain-1' })
  await chat.handleNotification({ method: 'turn/completed', params: { threadId: plain.conversationId, turn: { id: plain.runId, status: 'completed', items: [] } } })
  const chosen = await chat.send({ message: 'Again', conversationId: plain.conversationId, model: 'gpt-6-luna', effort: 'max', requestId: 'chosen-1' })
  assert.equal(chosen.accepted, true)
  const turn = calls.filter(call => call[1] === 'turn/start').at(-1)[2]
  assert.deepEqual([turn.model, turn.effort], ['gpt-6-luna', 'max'])
  await chat.handleNotification({ method: 'turn/completed', params: { threadId: plain.conversationId, turn: { id: chosen.runId, status: 'completed', items: [] } } })
  // Effort alone on a conversation: checked against that conversation's model (codex-model lists only low).
  await assert.rejects(chat.send({ message: 'More', conversationId: plain.conversationId, effort: 'max' }), refused('EFFORT_UNSUPPORTED'))
  const low = await chat.send({ message: 'More', conversationId: plain.conversationId, effort: 'low', requestId: 'low-1' })
  assert.equal(low.accepted, true)
  await chat.handleNotification({ method: 'turn/completed', params: { threadId: plain.conversationId, turn: { id: low.runId, status: 'completed', items: [] } } })
  // A replayed request keeps its first answer even after the list changed.
  listed = [LISTED_MODELS[0]]
  const replay = await chat.send({ message: 'Again', conversationId: plain.conversationId, model: 'gpt-6-luna', effort: 'max', requestId: 'chosen-1' })
  assert.equal(replay.runId, chosen.runId)
  await assert.rejects(chat.send({ message: 'New', conversationId: plain.conversationId, model: 'gpt-6-luna', requestId: 'chosen-2' }), refused('MODEL_UNAVAILABLE'))
  // Unknown list (offline catalog, failed read): every per-turn choice passes as before.
  listed = null
  const free = await chat.send({ message: 'Free', conversationId: plain.conversationId, model: 'gpt-reserve', effort: 'whatever', requestId: 'free-1' })
  assert.equal(free.accepted, true)
  // Invalid values are still refused first by the existing checks.
  listed = LISTED_MODELS
  await assert.rejects(chat.send({ message: 'Bad', model: '' }), error => error.code === 'INVALID_MODEL')
  await assert.rejects(chat.send({ message: 'Bad', effort: ' ' }), error => error.code === 'INVALID_EFFORT')
})

test('effort alone on a new conversation is checked against the launch-configured model, and a refused request saves nothing', async () => {
  await withStore('egdesk-runtime-models-', async store => {
    const calls = []
    const chat = new CodexChatRuntime({
      engines: [codexEngine(calls, { getModels: () => LISTED_MODELS })], store, requireStore: true, getOwnerKey: () => OWNER_KEY,
      expectedProcessConfiguration: { model: 'gpt-6-luna', effort: null },
    })
    chat.setConnection(true)
    await assert.rejects(chat.send({ message: 'Hi', clientThreadId: 'ui-1', requestId: 'req-1', effort: 'ultra' }), error => error.code === 'EFFORT_UNSUPPORTED' && error.httpStatus === 400)
    assert.equal(store.getConversation('ui-1'), null, 'nothing was saved for a refused choice')
    assert.deepEqual(calls, [])
    const accepted = await chat.send({ message: 'Hi', clientThreadId: 'ui-1', requestId: 'req-2', effort: 'max' })
    assert.equal(accepted.accepted, true)
    assert.equal(calls.find(call => call[1] === 'turn/start')[2].effort, 'max')
  })
})

test('a turn error names its own engine as origin, and a non-Codex child is never read through the Codex escape hatch', async () => {
  const { chat, calls, runOf } = twoEngines()
  const codexRun = await chat.send({ message: 'Codex work' })
  const claudeRun = await chat.send({ message: 'Other engine work', engineId: 'claude' })
  await chat.handleNotification({ method: 'error', params: { threadId: claudeRun.conversationId, turnId: claudeRun.runId, error: { message: 'engine hiccup' }, willRetry: true } })
  assert.equal(runOf(claudeRun).error.origin, 'claude')
  await chat.handleNotification({ method: 'turn/completed', params: { threadId: codexRun.conversationId, turn: { id: codexRun.runId, status: 'failed', items: [], error: { message: 'codex failed' } } } })
  assert.equal(runOf(codexRun).error.origin, 'codex')
  await chat.handleNotification({ method: 'item/completed', params: { threadId: claudeRun.conversationId, turnId: claudeRun.runId, item: {
    id: 'spawn-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['claude-child'], agentsStates: {} } } })
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(runOf(claudeRun).subAgents.map(row => row.threadId), ['claude-child'])
  assert.equal(calls.some(call => call[1] === 'thread/read'), false)
})
