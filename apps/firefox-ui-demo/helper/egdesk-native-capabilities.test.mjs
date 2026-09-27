import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildCodexAppServerLaunch, inspectNativeCapabilities, verifyCodexLaunchConfiguration } from './egdesk-native-capabilities.mjs'
import { AppServerRpc } from './codex-app-server-rpc.mjs'

test('version proof uses the exact executable later selected for app-server, not an SDK fallback', () => {
  const executable = '/configured/native/codex'
  const proof = inspectNativeCapabilities({ executable, run: (program, args) => { assert.equal(program, executable); assert.deepEqual(args, ['--version']); return { status: 0, stdout: 'codex-cli 0.157.1\n' } } })
  assert.equal(proof.schemaMatch, true)
  assert.equal(proof.dynamicTools, true)
  assert.equal(proof.executable, executable)
  const old = inspectNativeCapabilities({ executable, run: () => ({ status: 0, stdout: 'codex-cli 0.130.0\n' }) })
  assert.equal(old.schemaMatch, false)
  assert.equal(old.dynamicTools, false)
})

test('process-scoped launch uses only fixed TOML model/effort argv keys and leaves unset behavior unchanged', () => {
  const listen = 'ws://127.0.0.1:39219'
  assert.deepEqual(buildCodexAppServerLaunch({ env: {}, listen }).args, ['app-server', '--listen', listen])
  const launch = buildCodexAppServerLaunch({ env: {
    EGDESK_CODEX_MODEL: 'gpt-6-sol', EGDESK_CODEX_EFFORT: 'max', EGDESK_CODEX_CONFIG: 'sandbox_mode="danger-full-access"',
  }, listen })
  assert.deepEqual(launch.args, ['app-server', '-c', 'model="gpt-6-sol"', '-c', 'model_reasoning_effort="max"', '--listen', listen])
  assert.deepEqual([launch.configuredModel, launch.configuredEffort, launch.hasOverrides], ['gpt-6-sol', 'max', true])
  assert.deepEqual(buildCodexAppServerLaunch({ env: { EGDESK_CODEX_MODEL: 'gpt-6-sol' }, listen }).args, ['app-server', '-c', 'model="gpt-6-sol"', '--listen', listen])
  for (const value of [null, '', 'gpt-6-sol -c sandbox_mode="danger-full-access"', 'gpt-6-sol\n--profile hidden']) {
    assert.throws(() => buildCodexAppServerLaunch({ env: { EGDESK_CODEX_MODEL: value }, listen }), e => e.code === 'INVALID_CODEX_MODEL_OVERRIDE')
  }
  for (const value of [null, '', 'max --sandbox danger-full-access', 'MAX']) {
    assert.throws(() => buildCodexAppServerLaunch({ env: { EGDESK_CODEX_EFFORT: value }, listen }), e => e.code === 'INVALID_CODEX_EFFORT_OVERRIDE')
  }
})

test('config/read preflight proves both effective overrides and rejects missing or different evidence', () => {
  const launch = buildCodexAppServerLaunch({ env: { EGDESK_CODEX_MODEL: 'gpt-6-sol', EGDESK_CODEX_EFFORT: 'max' }, listen: 'ws://127.0.0.1:39219' })
  assert.deepEqual(verifyCodexLaunchConfiguration(launch, { config: { model: 'gpt-6-sol', model_reasoning_effort: 'max' } }), {
    status: 'verified', configuredModel: 'gpt-6-sol', configuredEffort: 'max', effectiveModel: 'gpt-6-sol', effectiveEffort: 'max',
  })
  assert.throws(() => verifyCodexLaunchConfiguration(launch, { config: { model: 'gpt-6-astra', model_reasoning_effort: 'max' } }), e => e.code === 'CODEX_LAUNCH_CONFIG_MISMATCH')
  assert.throws(() => verifyCodexLaunchConfiguration(launch, { config: { model: 'gpt-6-sol' } }), e => e.code === 'CODEX_LAUNCH_CONFIG_UNVERIFIED')
})

test('production spawn uses the validated argv without a shell and proves config before chat readiness', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('spawn(executable, appServerLaunch.args, {'))
  assert.ok(source.includes('shell: false'))
  const proof = source.indexOf('nativePreflight = verifyCodexLaunchConfiguration(appServerLaunch, config)')
  assert.ok(proof > source.indexOf("connection.request('config/read'"))
  assert.ok(proof < source.indexOf('appServerReady = true', proof))
})

test('dynamic tool transport explicitly opts into experimental API before native requests', async () => {
  const frames = []
  const rpc = new AppServerRpc({ experimentalApi: true, send: text => frames.push(JSON.parse(text)) })
  const init = rpc.initialize()
  assert.equal(frames[0].params.capabilities.experimentalApi, true)
  rpc.receive(JSON.stringify({ id: frames[0].id, result: {} }))
  await init
  assert.equal(frames[1].method, 'initialized')
  rpc.close()
})
