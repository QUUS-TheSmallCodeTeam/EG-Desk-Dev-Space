import test from 'node:test'
import assert from 'node:assert/strict'
import { CODEX_CAPABILITIES, CODEX_ENGINE_PROFILE_ID, createCodexEngineAdapter, describeCodexEngine } from './codex-engine-adapter.mjs'
import { ENGINE_STATUSES, validateEngineAdapter } from './engine-adapter.mjs'

function recorded() {
  const calls = [], replies = []
  const adapter = createCodexEngineAdapter({
    request: (method, params) => { calls.push([method, params]); return Promise.resolve({ method }) },
    respond: (...args) => { replies.push(args); return true },
    getOwnerKey: () => 'email:owner@example.com',
  })
  return { adapter, calls, replies }
}

test('Codex adapter satisfies the contract and passes conversation calls through with the same native method and params', async () => {
  const { adapter, calls } = recorded()
  assert.equal(validateEngineAdapter(adapter), adapter)
  const startParams = { cwd: '/work', dynamicTools: [] }
  await adapter.startThread(startParams)
  await adapter.resumeThread({ threadId: 'thread-1', config: {} })
  await adapter.releaseThread('thread-1')
  const turnParams = { threadId: 'thread-1', input: [{ type: 'text', text: 'Hi', text_elements: [] }], clientUserMessageId: 'request-1' }
  await adapter.startTurn(turnParams)
  await adapter.interruptTurn('thread-1', 'turn-1')
  await adapter.request('config/read', { includeLayers: false, cwd: null })
  assert.deepEqual(calls.map(call => call[0]), ['thread/start', 'thread/resume', 'thread/unsubscribe', 'turn/start', 'turn/interrupt', 'config/read'])
  assert.equal(calls[0][1], startParams, 'the params object is forwarded, not rebuilt')
  assert.equal(calls[3][1], turnParams)
  assert.deepEqual(calls[2][1], { threadId: 'thread-1' })
  assert.deepEqual(calls[4][1], { threadId: 'thread-1', turnId: 'turn-1' })
  assert.equal(adapter.ownerKey(CODEX_ENGINE_PROFILE_ID), 'email:owner@example.com')
  assert.deepEqual([...adapter.capabilities()], [...CODEX_CAPABILITIES])
  adapter.capabilities().add('approvals.tool')
  assert.equal(adapter.capabilities().has('approvals.tool'), false, 'callers cannot widen Codex capabilities')
})

test('Codex adapter keeps a synchronous native failure synchronous and preserves response arity', () => {
  const offline = createCodexEngineAdapter({ request: () => { throw Object.assign(new Error('offline'), { code: 'BRIDGE_OFFLINE' }) }, respond: () => {} })
  assert.throws(() => offline.interruptTurn('thread-1', 'turn-1'), { code: 'BRIDGE_OFFLINE' })
  const { adapter, replies } = recorded()
  adapter.respond('rpc-1', { decision: 'accept' })
  adapter.respond('rpc-2', null, { code: -32000, message: 'User skipped the question' })
  assert.deepEqual(replies, [['rpc-1', { decision: 'accept' }], ['rpc-2', null, { code: -32000, message: 'User skipped the question' }]])
})

test('Codex adapter tags fed app-server traffic for each subscriber until it unsubscribes', async () => {
  const { adapter } = recorded()
  const seen = []
  const stop = adapter.subscribe({
    notification: (engineId, message) => seen.push(['notification', engineId, message.method]),
    serverRequest: (engineId, message) => seen.push(['request', engineId, message.id]),
    connection: (engineId, state) => seen.push(['connection', engineId, state]),
  })
  adapter.notify({ method: 'turn/started', params: { threadId: 'thread-1' } })
  adapter.serverRequest({ id: 7, method: 'item/tool/call', params: {} })
  adapter.connection({ ready: false, processLost: true })
  stop()
  adapter.notify({ method: 'turn/completed', params: {} })
  assert.deepEqual(seen, [['notification', 'codex', 'turn/started'], ['request', 'codex', 7], ['connection', 'codex', { ready: false, processLost: true }]])
  await adapter.dispose()
})

test('Codex engine row reports status, version support, account slot and usage from public bridge state only', async () => {
  const auth = { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'owner@example.com', planType: 'pro', accountId: 'acct-1', authUrl: 'https://auth.example/secret-code', userCode: 'PRIVATE-CODE' }
  const usage = { status: 'available', usedPercent: 20 }
  const row = describeCodexEngine({ ready: true, version: '0.162.1', versionSupported: false, auth, usage, residentProcesses: 1 })
  assert.deepEqual(row, {
    id: 'codex', label: 'Codex', status: 'ready', version: '0.162.1', versionSupported: false,
    capabilities: [...CODEX_CAPABILITIES],
    profiles: [{ id: 'codex-default', label: 'ChatGPT', credentialStore: 'shared-user-default', active: true,
      auth: { status: 'signedIn', method: 'chatgpt', account: 'owner@example.com', planType: 'pro' }, usage }],
    runtime: { residentProcesses: 1, residentLimit: 1, idleTimeoutMs: null },
    models: null,
  })
  assert.equal(JSON.stringify(row).includes('PRIVATE-CODE') || JSON.stringify(row).includes('secret-code'), false)
  const statusOf = state => describeCodexEngine(state).status
  assert.equal(statusOf({ ready: true, auth: { isLoggedIn: false } }), 'loginRequired')
  assert.equal(statusOf({ ready: false, starting: true }), 'starting')
  assert.equal(statusOf({ ready: false }), 'offline')
  assert.equal(statusOf({ ready: true, blocked: true, auth }), 'disabled')
  for (const state of [{}, { ready: true, auth }, { starting: true }]) assert.ok(ENGINE_STATUSES.includes(statusOf(state)))
  const signedOut = describeCodexEngine({ ready: true, version: '/usr/local/bin/codex', auth: { isLoggedIn: false, loginInProgress: true, accountEmail: 'old@example.com' } })
  assert.equal(signedOut.version, null)
  assert.deepEqual(signedOut.profiles[0].auth, { status: 'signingIn', method: null, account: null, planType: null })
  assert.equal(describeCodexEngine().profiles[0].auth.status, 'unknown')
  const adapter = createCodexEngineAdapter({ request: () => {}, respond: () => {}, isReady: () => false })
  assert.equal(adapter.describe().status, 'offline')
  assert.equal((await adapter.refresh()).status, 'offline')
  assert.equal(adapter.isReady(), false)
})

test('Codex branches through thread/fork with the same params object and reports one-time and branch support', async () => {
  const { adapter, calls } = recorded()
  const params = { threadId: 'thread-1', lastTurnId: 'turn-2', excludeTurns: true, config: {} }
  await adapter.forkThread(params)
  assert.deepEqual(calls, [['thread/fork', params]])
  assert.equal(calls[0][1], params, 'the params object is forwarded, not rebuilt')
  assert.ok(adapter.capabilities().has('threadFork') && adapter.capabilities().has('ephemeralThreads'))
  assert.ok(CODEX_CAPABILITIES.includes('threadFork') && CODEX_CAPABILITIES.includes('ephemeralThreads'))
})

test('Codex row and adapter carry the listed models, or null while they are unknown', async () => {
  const models = [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedEfforts: ['low', 'medium'], defaultEffort: 'low' }]
  assert.deepEqual(describeCodexEngine({ ready: true, models }).models, models)
  for (const unknown of [undefined, null, 'gpt-6.1-sol', {}]) assert.equal(describeCodexEngine({ models: unknown }).models, null)
  let listed = null
  const adapter = createCodexEngineAdapter({ request: () => {}, respond: () => {}, getModels: () => listed })
  assert.equal(validateEngineAdapter(adapter), adapter)
  assert.equal(adapter.models(), null)
  assert.equal(adapter.describe().models, null)
  listed = models
  assert.deepEqual(adapter.models(), models)
  assert.deepEqual(adapter.describe().models, models)
  assert.deepEqual((await adapter.refresh()).models, models)
  const broken = createCodexEngineAdapter({ request: () => {}, respond: () => {}, getModels: () => { throw new Error('/secret') } })
  assert.equal(broken.models(), null)
  assert.equal(createCodexEngineAdapter({ request: () => {}, respond: () => {} }).models(), null, 'no catalog: unknown')
  assert.throws(() => validateEngineAdapter({ ...adapter, models: 'gpt-6.1-sol' }), { code: 'INVALID_ENGINE_ADAPTER' })
})
