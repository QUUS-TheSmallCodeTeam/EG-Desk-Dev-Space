import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  CODEX_CAPABILITIES, CODEX_ENGINE_PROFILE_ID, CODEX_LOGIN_MODES, codexDeviceLoginPatch, codexLoginInProgressResponse, codexLoginMode,
  codexLoginStartParams, createCodexEngineAdapter, describeCodexEngine, isStaleLoginFailure,
} from './codex-engine-adapter.mjs'
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
  const row = describeCodexEngine({ ready: true, version: '0.162.1', versionSupported: false, versionStatus: 'supported', auth, usage, residentProcesses: 1 })
  assert.deepEqual(row, {
    id: 'codex', label: 'Codex', status: 'ready', version: '0.162.1', versionSupported: false, versionStatus: 'supported', installed: true,
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
  assert.deepEqual([signedOut.installed, signedOut.versionStatus], [null, null], 'no reported version: not known, never invented')
  assert.equal(describeCodexEngine({ versionStatus: 'broken' }).versionStatus, null)
  assert.equal(describeCodexEngine({ installed: false }).installed, false)
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

// SUB-04: code entry when the browser cannot come back (codex-acp CodexAcpClient.ts:301-354).
const DEVICE_ANSWER = { type: 'chatgptDeviceCode', loginId: 'login-7', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345' }

test('ChatGPT sign-in offers browser and code entry, and code entry needs a complete device-code answer', () => {
  assert.deepEqual(CODEX_LOGIN_MODES, ['browser', 'device'])
  assert.equal(codexLoginMode(undefined), 'browser', 'no body keeps the existing browser flow')
  assert.equal(codexLoginMode(null), 'browser')
  assert.equal(codexLoginMode('device'), 'device')
  for (const mode of ['code', 'DEVICE', '', 1, {}, ['device']]) assert.throws(() => codexLoginMode(mode), error => error.code === 'INVALID_LOGIN_MODE' && error.httpStatus === 400)
  assert.deepEqual(codexLoginStartParams('device'), { type: 'chatgptDeviceCode' })
  assert.deepEqual(codexLoginStartParams('browser'), { type: 'chatgpt' })
  assert.deepEqual(codexDeviceLoginPatch(DEVICE_ANSWER), {
    loginInProgress: true, authSessionId: 'login-7', authUrl: null, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345',
    callbackUrl: null, loginMode: 'device', loginError: null, statusText: 'Signing in…',
  })
  for (const broken of [
    null, {}, { ...DEVICE_ANSWER, type: 'chatgpt' }, { ...DEVICE_ANSWER, loginId: '' }, { ...DEVICE_ANSWER, loginId: 'x'.repeat(201) },
    { ...DEVICE_ANSWER, verificationUrl: 'http://auth.openai.com/codex/device' }, { ...DEVICE_ANSWER, verificationUrl: 'javascript:alert(1)' },
    { ...DEVICE_ANSWER, verificationUrl: 'https://user:pass@auth.openai.com/device' }, { ...DEVICE_ANSWER, verificationUrl: `https://a.example/${'x'.repeat(2050)}` },
    { ...DEVICE_ANSWER, userCode: '' }, { ...DEVICE_ANSWER, userCode: 'AB' }, { ...DEVICE_ANSWER, userCode: '<script>' }, { ...DEVICE_ANSWER, userCode: 'ABCD 1234' }, { ...DEVICE_ANSWER, userCode: 42 },
  ]) assert.throws(() => codexDeviceLoginPatch(broken), /Unexpected login response/)
})

test('a running sign-in answers again with its own link or code, and only a stale failure is ignored', () => {
  const device = codexLoginInProgressResponse({ loginMode: 'device', authSessionId: 'login-7', verificationUrl: DEVICE_ANSWER.verificationUrl, userCode: 'ABCD-12345', authUrl: 'https://never.example' })
  assert.deepEqual(device, { started: false, loginInProgress: true, loginId: 'login-7', mode: 'device', verificationUrl: DEVICE_ANSWER.verificationUrl, userCode: 'ABCD-12345', message: 'Codex code sign-in is already running.' })
  const browser = codexLoginInProgressResponse({ loginMode: 'browser', authSessionId: 'login-6', userCode: 'NOT-SHOWN' })
  assert.deepEqual(browser, { started: false, loginInProgress: true, loginId: 'login-6', mode: 'browser', message: 'Codex browser login is already running.' })
  assert.equal(isStaleLoginFailure({ success: false, loginId: 'login-6' }, 'login-7'), true, 'the cancelled browser login')
  assert.equal(isStaleLoginFailure({ success: false, loginId: 'login-6' }, null), true, 'after a cancel')
  assert.equal(isStaleLoginFailure({ success: false, loginId: 'login-7' }, 'login-7'), false)
  assert.equal(isStaleLoginFailure({ success: false }, 'login-7'), false, 'an answer without loginId still ends the login')
  assert.equal(isStaleLoginFailure({ success: false, loginId: null }, 'login-7'), false)
  assert.equal(isStaleLoginFailure({ success: true, loginId: 'login-6' }, 'login-7'), false, 'a success is never ignored')
  assert.equal(isStaleLoginFailure(undefined, 'login-7'), false)
})

test('bridge starts code entry from POST /auth/start { mode: device }, switches modes by cancelling first, and keeps the code out of lifecycle details', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  const start = source.slice(at("if (req.method === 'POST' && route === '/auth/start') {"), at("if (req.method === 'POST' && route === '/auth/cancel') {"))
  assert.ok(start.indexOf('await readJsonBody(req, { maxBytes: 1024 })') < start.indexOf('const mode = codexLoginMode(body.mode)'))
  assert.ok(start.indexOf('const mode = codexLoginMode(body.mode)') < start.indexOf('await refreshAccountState()'), 'a bad mode is refused before any account call')
  assert.match(start, /if \(authState\.loginMode === mode\) \{\n {10}sendJson\(res, 200, codexLoginInProgressResponse\(authState\)\)/)
  assert.ok(start.indexOf("appServerRequest('account/login/cancel', { loginId: authState.authSessionId })") < start.indexOf('resetLoginState()'))
  assert.ok(start.indexOf('resetLoginState()') < start.indexOf('await startChatgptDeviceLogin()'))
  assert.match(start, /sendJson\(res, 200, \{ started: true, mode, loginId: patch\.authSessionId, verificationUrl: patch\.verificationUrl, userCode: patch\.userCode \}\)/)
  assert.match(start, /sendJson\(res, error\.httpStatus, \{ started: false, code: error\.code \|\| 'INVALID_REQUEST', message \}\)/)
  const device = source.slice(at('async function startChatgptDeviceLogin() {'), at('// ── Terminal PTY support ──'))
  assert.match(device, /appServerRequest\('account\/login\/start', codexLoginStartParams\('device'\)\)/)
  assert.match(device, /emitAuthLifecycle\('started', \{ loginId: patch\.authSessionId, mode: 'device' \}\)/)
  assert.ok(device.indexOf("appServerRequest('account/login/cancel', { loginId: result.loginId })") < device.indexOf('updateAuthState(patch'), 'a malformed answer cancels its login before any state change')
  assert.equal(/console\.|userCode/.test(device.replace('patch.userCode', '')), false, 'the code is never logged or put in lifecycle details')
  assert.ok(at('async function startChatgptLogin() {') < at('async function startChatgptDeviceLogin() {'), 'browser flow marker unchanged and first')
  const completed = source.slice(at("case 'account/login/completed': {"), at("case 'account/rateLimits/updated':"))
  assert.ok(completed.indexOf('if (isStaleLoginFailure(message.params, authState.authSessionId)) return') < completed.indexOf('clearInterval(loginPollTimer)'))
  assert.match(completed, /authSessionId: null,\n {8}authUrl: null,\n {8}verificationUrl: null,\n {8}userCode: null,/)
  at("auth: ['status', 'start', 'cancel', 'signout', 'usage', 'device-code'],")
})
