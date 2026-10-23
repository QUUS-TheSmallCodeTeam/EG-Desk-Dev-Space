import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EngineRegistry, createEngineStatusEmitter, describeClaudeEngine, publicEngineRow } from './engine-registry.mjs'
import { CODEX_CAPABILITIES, createCodexEngineAdapter, describeCodexEngine } from './codex-engine-adapter.mjs'

const MODELS = [
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
  { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', isDefault: false, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
]

function bridgeLikeRegistry({ ready = true, auth = { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'owner@example.com', planType: 'pro' }, models = MODELS } = {}) {
  const registry = new EngineRegistry({ defaultEngineId: 'codex' })
  const codex = registry.register(createCodexEngineAdapter({
    request: async () => ({}), respond: () => {}, isReady: () => ready, getModels: () => models,
    describe: () => describeCodexEngine({ ready, version: '0.162.1', versionSupported: false, auth, usage: { status: 'available', usedPercent: 20 }, residentProcesses: ready ? 1 : 0, models }),
  }))
  registry.describe(describeClaudeEngine())
  return { registry, codex }
}

test('/v1/state engines lists runnable Codex as default and Claude as decision pending, in the documented shape', () => {
  const { registry } = bridgeLikeRegistry()
  assert.deepEqual(registry.publicEngines(), [
    {
      id: 'codex', label: 'Codex', status: 'ready', version: '0.162.1', versionSupported: false, isDefault: true,
      capabilities: [...CODEX_CAPABILITIES],
      profiles: [{ id: 'codex-default', label: 'ChatGPT', credentialStore: 'shared-user-default', active: true,
        auth: { status: 'signedIn', method: 'chatgpt', account: 'owner@example.com', planType: 'pro' }, usage: { status: 'available', usedPercent: 20 } }],
      runtime: { residentProcesses: 1, residentLimit: 1, idleTimeoutMs: null },
      models: MODELS,
    },
    {
      id: 'claude', label: 'Claude', status: 'decisionPending', statusReason: 'SUB-12', version: null, versionSupported: null, isDefault: false,
      capabilities: [], profiles: [], runtime: { residentProcesses: 0, residentLimit: 2, idleTimeoutMs: 300000 }, models: null,
    },
  ])
  assert.equal(bridgeLikeRegistry({ models: null }).registry.publicEngines()[0].models, null, 'unknown models stay null')
  assert.equal(bridgeLikeRegistry({ ready: false }).registry.publicEngines()[0].status, 'offline')
  assert.equal(bridgeLikeRegistry({ auth: { isLoggedIn: false } }).registry.publicEngines()[0].status, 'loginRequired')
})

test('engine rows are rebuilt from an allow-list so adapters cannot publish credentials or paths', () => {
  const row = publicEngineRow({
    id: 'codex', label: 'Codex', status: 'hacked', version: '/Users/me/.codex/bin/codex', executable: '/usr/local/bin/codex', apiKey: 'sk-PRIVATE',
    capabilities: ['stream', 'rootShell'], runtime: { residentProcesses: -1, residentLimit: 1, idleTimeoutMs: 0, pid: 4242 },
    profiles: [{ id: 'codex-default', token: 'PRIVATE_TOKEN', credentialsPath: '/Users/me/.codex/auth.json', active: 'yes', auth: { status: 'admin', method: 'chatgpt', accessToken: 'PRIVATE_TOKEN' } }],
  })
  const text = JSON.stringify(row)
  for (const hidden of ['PRIVATE', '/Users/me', '/usr/local', 'pid', 'executable', 'apiKey']) assert.equal(text.includes(hidden), false, hidden)
  assert.equal(row.status, 'offline')
  assert.equal(row.version, null)
  assert.deepEqual(row.capabilities, ['stream'])
  assert.deepEqual(row.runtime, { residentProcesses: 0, residentLimit: 1, idleTimeoutMs: null })
  assert.deepEqual(row.profiles[0].auth, { status: 'unknown', method: 'chatgpt', account: null, planType: null })
  assert.equal(row.profiles[0].active, false)
  const failing = new EngineRegistry()
  failing.register(createCodexEngineAdapter({ request: async () => ({}), respond: () => {}, describe: () => { throw new Error('/secret/path') } }))
  assert.deepEqual(failing.publicEngines().map(entry => [entry.id, entry.status]), [['codex', 'offline']])
})

test('engine resolution prefers the request, then the conversation binding, then the default, and never switches a bound conversation', () => {
  const { registry, codex } = bridgeLikeRegistry()
  assert.equal(registry.resolve(), 'codex')
  assert.equal(registry.resolve({ requested: 'codex' }), 'codex')
  assert.equal(registry.resolve({ bound: 'codex' }), 'codex')
  assert.equal(registry.require('codex'), codex)
  assert.throws(() => registry.resolve({ requested: 'claude' }), error => error.code === 'ENGINE_UNAVAILABLE' && error.httpStatus === 503 && /being decided/.test(error.message))
  assert.throws(() => registry.resolve({ requested: 'gemini' }), { code: 'ENGINE_UNAVAILABLE' })
  assert.throws(() => registry.resolve({ requested: 7 }), { code: 'ENGINE_UNAVAILABLE' })
  assert.throws(() => registry.resolve({ bound: 'claude' }), { code: 'ENGINE_UNAVAILABLE' })
  const both = new EngineRegistry()
  both.register(createCodexEngineAdapter({ request: async () => ({}), respond: () => {} }))
  both.register({ ...createCodexEngineAdapter({ request: async () => ({}), respond: () => {} }), id: 'claude' })
  assert.throws(() => both.resolve({ requested: 'codex', bound: 'claude' }), error => error.code === 'ENGINE_MISMATCH' && error.httpStatus === 409)
  assert.equal(both.resolve({ bound: 'claude' }), 'claude')
  assert.equal(registry.has('claude'), false)
  assert.deepEqual(registry.adapters(), [codex])
})

test('registry refuses duplicate or unknown engines and reports an offline engine as unavailable', () => {
  const { registry } = bridgeLikeRegistry({ ready: false })
  assert.throws(() => registry.register(createCodexEngineAdapter({ request: async () => ({}), respond: () => {} })), { code: 'INVALID_ENGINE_ADAPTER' })
  assert.throws(() => registry.describe(describeClaudeEngine()), { code: 'INVALID_ENGINE_ADAPTER' })
  assert.throws(() => registry.describe({ id: 'gemini', label: 'Gemini' }), { code: 'INVALID_ENGINE_ADAPTER' })
  assert.throws(() => registry.assertReady('codex'), error => error.code === 'ENGINE_UNAVAILABLE' && error.httpStatus === 503)
  assert.equal(bridgeLikeRegistry().registry.assertReady('codex').id, 'codex')
})

test('bridge registers only Codex, lists Claude, authenticates the requested engine and publishes engines in /v1/state', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  assert.ok(at('engineRegistry.register(codexEngine)') < at('const chat = new CodexChatRuntime({'))
  at('engineRegistry.describe(describeClaudeEngine())')
  assert.equal(source.match(/engineRegistry\.register\(/g).length, 1, 'Claude is listed, never registered as runnable')
  assert.ok(at('  engines: engineRegistry,') > at('const chat = new CodexChatRuntime({'))
  at('const engine = engineRegistry.require(body?.engineId ?? engineRegistry.defaultEngineId)')
  assert.ok(at("route === '/v1/state'") < at('engines: engineRegistry.publicEngines(),'))
  at("engines: ['registry', 'thread-lock'],")
  // The top-level Codex fields remain for overlays that predate engines[].
  assert.ok(at('provider: PROVIDER_ID,\n      appServerReady,') < at('engines: engineRegistry.publicEngines(),'))
})

test('engine rows publish models only through the allow-list, in order, and never an empty or invented list', () => {
  const row = publicEngineRow({
    id: 'codex', status: 'ready',
    models: [
      { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedEfforts: ['low', 'ultra'], defaultEffort: 'low', description: 'PRIVATE', upgradeInfo: { modelLink: 'https://private.example' } },
      { id: '/Users/me/.codex/model', displayName: 'path' },
      { id: 'gpt-6.1-sol', displayName: 'duplicate' },
      { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', isDefault: true, supportedEfforts: ['medium', 'BAD EFFORT'], defaultEffort: 'ultra' },
    ],
  })
  assert.deepEqual(Object.keys(row).at(-1), 'models', 'models is the last row field')
  assert.deepEqual(row.models, [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedEfforts: ['low', 'ultra'], defaultEffort: 'low' },
    { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', isDefault: false, supportedEfforts: ['medium'], defaultEffort: null },
  ])
  assert.equal(JSON.stringify(row).includes('PRIVATE') || JSON.stringify(row).includes('/Users/me'), false)
  for (const models of [undefined, null, [], {}, 'gpt-6.1-sol', [{ id: '' }]]) assert.equal(publicEngineRow({ id: 'codex', models }).models, null)
})

test('engine.status is sent once per change of the public engines[] rows, in the documented envelope', () => {
  let rows = [{ id: 'codex', status: 'starting', models: null }]
  const sent = []
  let clock = 1000
  const status = createEngineStatusEmitter({ engines: () => rows, emit: event => sent.push(event), now: () => clock })
  assert.equal(status.check(), true)
  assert.equal(status.check(), false, 'unchanged rows send nothing')
  rows = [{ id: 'codex', status: 'ready', models: null }]
  clock = 2000
  assert.equal(status.check(), true)
  rows = [{ id: 'codex', status: 'ready', models: [{ id: 'gpt-6.1-sol' }] }]
  status.check()
  status.check()
  assert.deepEqual(sent.map(event => Object.keys(event)), [['type', 'v', 'engines', 'ts'], ['type', 'v', 'engines', 'ts'], ['type', 'v', 'engines', 'ts']])
  assert.deepEqual(sent.map(event => [event.type, event.v, event.engines[0].status, event.ts]), [['engine.status', 1, 'starting', 1000], ['engine.status', 1, 'ready', 2000], ['engine.status', 1, 'ready', 2000]])
  assert.deepEqual(sent[2].engines[0].models, [{ id: 'gpt-6.1-sol' }])
  const failing = createEngineStatusEmitter({ engines: () => { throw new Error('/secret') }, emit: () => assert.fail('nothing to send') })
  assert.equal(failing.check(), false)
  // The bridge feeds it the real registry rows.
  const { registry } = bridgeLikeRegistry()
  const bridgeSent = []
  createEngineStatusEmitter({ engines: () => registry.publicEngines(), emit: event => bridgeSent.push(event), v: 1 }).check()
  assert.deepEqual(bridgeSent[0].engines, registry.publicEngines())
})

test('bridge reads the model list after each ready connection and account change, forgets it offline, and announces engine changes', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  // The catalog is created before the Codex adapter that publishes it, and bounded to a signed-in, ready app-server.
  assert.ok(at('const modelCatalog = createModelCatalogSync({') < at('const codexEngine = createCodexEngineAdapter({'))
  at('  ready: () => appServerReady && authState.isLoggedIn,')
  at('  identity: () => modelAccountKey(authState),')
  at('  onChange: () => engineStatus.check(),')
  at('  getModels: () => modelCatalog.snapshot(),')
  at('    models: modelCatalog.snapshot(),')
  // engine.status rides the same SSE broadcast as auth.status and mcp.inherited.
  assert.ok(at('const engineStatus = createEngineStatusEmitter({') > at('engineRegistry.describe(describeClaudeEngine())'))
  at('  engines: () => engineRegistry.publicEngines(),')
  at('  emit: event => broadcast(event),')
  at('  v: BRIDGE_PROTOCOL_VERSION,')
  const update = source.slice(at('function updateAuthState(patch, { broadcastStatus = true } = {}) {'), at('function authStatusTextFor(snapshot) {'))
  assert.match(update, /engineStatus\.check\(\)\n\}/)
  // Read once a connection is ready and signed in; again, cleared first, whenever the account changes.
  // The ready connection is announced by the account refresh that follows it,
  // so the row never flashes 'loginRequired' before the account is known.
  const open = source.slice(at('socket.onopen = async () => {'), at('socket.onmessage = event => {'))
  assert.ok(open.indexOf('appServerReady = true') < open.indexOf('await refreshAccountState()'))
  assert.ok(open.indexOf('await refreshAccountState()') < open.indexOf('void modelCatalog.refresh()'))
  assert.equal(open.includes('engineStatus.check()'), false)
  at('return `${state.isLoggedIn === true}:${publicAuthIdentityKey(state) ?? \'\'}`')
  const account = source.slice(at('async function refreshAccountState('), at('function handleAppServerNotification(message) {'))
  assert.ok(account.indexOf('const previousAccount = modelAccountKey(authState)') < account.indexOf('updateAuthState({'))
  assert.match(account, /if \(modelAccountKey\(authState\) !== previousAccount\) void modelCatalog\.refresh\(\{ clear: true \}\)/)
  assert.equal(source.split('modelCatalog.refresh(').length, 3, 'only the ready connection and the account change read model/list, never /v1/state itself')
  // Unknown again when the app-server goes away, and the row change is announced.
  const close = source.slice(at('socket.onclose = () => {'), at('async function startChatgptLogin() {'))
  assert.match(close, /inheritedMcp\.reset\(\)\n {4}modelCatalog\.reset\(\)\n {4}engineStatus\.check\(\)/)
  const lost = source.slice(at('const lost = () => {'), at("child.on('error', lost)"))
  assert.match(lost, /modelCatalog\.reset\(\)/)
  const error = source.slice(at('socket.onerror = () => {'), at('socket.onclose = () => {'))
  assert.match(error, /engineStatus\.check\(\)/)
  const spawned = source.slice(at('function spawnAppServer() {'), at('async function connectToAppServer() {'))
  assert.ok(spawned.indexOf('appServerProcess = child') < spawned.indexOf('engineStatus.check()'), 'the starting status is announced')
})
