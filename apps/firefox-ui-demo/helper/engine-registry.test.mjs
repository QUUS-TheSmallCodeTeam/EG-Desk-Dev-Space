import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EngineRegistry, describeClaudeEngine, publicEngineRow } from './engine-registry.mjs'
import { CODEX_CAPABILITIES, createCodexEngineAdapter, describeCodexEngine } from './codex-engine-adapter.mjs'

function bridgeLikeRegistry({ ready = true, auth = { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'owner@example.com', planType: 'pro' } } = {}) {
  const registry = new EngineRegistry({ defaultEngineId: 'codex' })
  const codex = registry.register(createCodexEngineAdapter({
    request: async () => ({}), respond: () => {}, isReady: () => ready,
    describe: () => describeCodexEngine({ ready, version: '0.162.1', versionSupported: false, auth, usage: { status: 'available', usedPercent: 20 }, residentProcesses: ready ? 1 : 0 }),
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
    },
    {
      id: 'claude', label: 'Claude', status: 'decisionPending', statusReason: 'SUB-12', version: null, versionSupported: null, isDefault: false,
      capabilities: [], profiles: [], runtime: { residentProcesses: 0, residentLimit: 2, idleTimeoutMs: 300000 },
    },
  ])
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
