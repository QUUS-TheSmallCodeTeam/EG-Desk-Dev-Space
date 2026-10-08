import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { buildCodexAppServerLaunch, inspectNativeCapabilities, resolveCodexExecutable, verifyCodexLaunchConfiguration, verifyCodexMemoryFeatureDisabled } from './egdesk-native-capabilities.mjs'
import { fingerprintNativeExecutable, verifyNativeSchemaDirectory } from './codex-native-schema-probe.mjs'
import { AppServerRpc } from './codex-app-server-rpc.mjs'

test('version proof uses the exact executable later selected for app-server, not an SDK fallback', () => {
  const executable = '/configured/native/codex'
  const probe = ({ executable: selected }) => { assert.equal(selected, executable); return { contextContract: true, qaContract: true, schemaFingerprint: 'a'.repeat(64) } }
  const fingerprint = selected => { assert.equal(selected, executable); return 'b'.repeat(64) }
  const proof = inspectNativeCapabilities({ executable, probe, fingerprint, run: (program, args) => { assert.equal(program, executable); assert.deepEqual(args, ['--version']); return { status: 0, stdout: 'codex-cli 0.157.1\n' } } })
  assert.equal(proof.schemaMatch, true)
  assert.equal(proof.dynamicTools, true)
  assert.equal(proof.executable, executable)
  const old = inspectNativeCapabilities({ executable, run: () => ({ status: 0, stdout: 'codex-cli 0.130.0\n' }) })
  assert.equal(old.schemaMatch, false)
  assert.equal(old.dynamicTools, false)
  assert.equal(old.qaReadOnly, false)
  const current = inspectNativeCapabilities({ executable, probe, fingerprint, run: () => ({ status: 0, stdout: 'codex-cli 0.160.1\n' }) })
  assert.equal(current.schemaMatch, true)
  assert.equal(current.dynamicTools, true)
  assert.equal(current.readerReadOnly, true)
  assert.equal(current.qaReadOnly, true)
  assert.match(current.contractFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(proof.qaReadOnly, false)
  assert.equal(inspectNativeCapabilities({ executable, run: () => ({ status: 0, stdout: 'codex-cli 0.160.2\n' }) }).schemaMatch, false)
  assert.equal(inspectNativeCapabilities({ executable, run: () => ({ status: 0, stdout: 'codex-cli 0.160.1\n' }), probe: () => null, fingerprint }).schemaMatch, false)
  assert.equal(inspectNativeCapabilities({ executable, run: () => ({ status: 0, stdout: 'codex-cli 0.160.1\n' }), probe: () => ({ contextContract: true, qaContract: true, schemaFingerprint: 'bad' }), fingerprint }).qaReadOnly, false)
  assert.equal(inspectNativeCapabilities({ executable, run: () => ({ status: 0, stdout: 'codex-cli 0.160.1\n' }), probe, fingerprint: () => { throw new Error('Unreadable selected binary') } }).dynamicTools, false)
})

test('installed 0.160.1 generated experimental schema has the exact native contracts used by context, Reader and read-only QA', async t => {
  const cli = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 })
  if (cli.status !== 0 || cli.stdout.trim() !== 'codex-cli 0.160.1') return t.skip('Codex 0.160.1 CLI is not installed on this test host')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-app-server-schema-'))
  try {
    const generated = spawnSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', dir], { encoding: 'utf8', timeout: 10000 })
    assert.equal(generated.status, 0, generated.stderr)
    assert.deepEqual({ contextContract: verifyNativeSchemaDirectory(dir)?.contextContract, qaContract: verifyNativeSchemaDirectory(dir)?.qaContract }, { contextContract: true, qaContract: true })
    const actual = inspectNativeCapabilities({ executable: resolveCodexExecutable() })
    assert.equal(actual.schemaMatch, true)
    assert.equal(actual.qaReadOnly, true)
    assert.match(actual.contractFingerprint, /^[a-f0-9]{64}$/)
    const schema = async name => JSON.parse(await readFile(path.join(dir, name), 'utf8'))
    const start = await schema('v2/ThreadStartParams.json')
    const startResponse = await schema('v2/ThreadStartResponse.json')
    const resume = await schema('v2/ThreadResumeParams.json')
    const turn = await schema('v2/TurnStartParams.json')
    const turnResponse = await schema('v2/TurnStartResponse.json')
    const call = await schema('DynamicToolCallParams.json')
    const callResponse = await schema('DynamicToolCallResponse.json')
    const config = await schema('v2/ConfigReadResponse.json')
    const models = await schema('v2/ModelListResponse.json')
    const mcp = await schema('v2/ListMcpServerStatusResponse.json')
    for (const key of ['dynamicTools', 'sandbox', 'approvalPolicy', 'config', 'ephemeral']) assert.ok(start.properties[key], `thread/start ${key}`)
    assert.ok(start.definitions.SandboxMode.enum.includes('read-only'))
    assert.ok(start.definitions.AskForApproval.oneOf[0].enum.includes('never'))
    assert.ok(start.definitions.DynamicToolSpec.oneOf.some(variant => variant.properties?.inputSchema && variant.properties?.name))
    for (const key of ['sandbox', 'approvalPolicy', 'thread']) assert.ok(startResponse.required.includes(key), `thread/start response ${key}`)
    for (const key of ['sandbox', 'approvalPolicy', 'config', 'threadId']) assert.ok(resume.properties[key], `thread/resume ${key}`)
    for (const key of ['sandboxPolicy', 'approvalPolicy', 'input', 'threadId', 'additionalContext', 'effort']) assert.ok(turn.properties[key], `turn/start ${key}`)
    const readOnly = turn.definitions.SandboxPolicy.oneOf.find(variant => variant.title === 'ReadOnlySandboxPolicy')
    assert.deepEqual(readOnly.properties.type.enum, ['readOnly'])
    assert.equal(readOnly.properties.networkAccess.default, false)
    assert.ok(!turnResponse.properties.sandboxPolicy, 'turn/start response does not independently prove effective policy')
    for (const key of ['threadId', 'turnId', 'callId', 'tool', 'arguments']) assert.ok(call.required.includes(key), `item/tool/call ${key}`)
    assert.deepEqual(callResponse.required.sort(), ['contentItems', 'success'])
    for (const key of ['model', 'model_reasoning_effort', 'developer_instructions']) assert.ok(config.definitions.Config.properties[key], `config/read ${key}`)
    for (const key of ['id', 'model', 'defaultReasoningEffort', 'supportedReasoningEfforts']) assert.ok(models.definitions.Model.properties[key], `model/list ${key}`)
    assert.equal(models.definitions.ReasoningEffort.type, 'string')
    for (const key of ['name', 'pluginId', 'tools', 'toolsError']) assert.ok(mcp.definitions.McpServerStatus.properties[key], `MCP status ${key}`)
    const callPath = path.join(dir, 'DynamicToolCallParams.json')
    const damaged = JSON.parse(await readFile(callPath, 'utf8'))
    delete damaged.properties.callId
    await writeFile(callPath, JSON.stringify(damaged))
    assert.equal(verifyNativeSchemaDirectory(dir)?.contextContract, false, 'missing required native call field must close the gate')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an unrecognized executable wrapper is not accepted on a version banner alone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-unknown-codex-wrapper-'))
  try {
    const wrapper = path.join(dir, 'codex-wrapper')
    await writeFile(wrapper, '#!/bin/sh\nprintf "codex-cli 0.160.1\\n"\n')
    assert.throws(() => fingerprintNativeExecutable(wrapper), /Unrecognized Codex launcher/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('process-scoped launch uses only fixed model/effort and explicit memory-disable argv keys', () => {
  const listen = 'ws://127.0.0.1:39219'
  assert.deepEqual(buildCodexAppServerLaunch({ env: {}, listen }).args, ['app-server', '--listen', listen])
  const launch = buildCodexAppServerLaunch({ env: {
    EGDESK_CODEX_MODEL: 'gpt-6-sol', EGDESK_CODEX_EFFORT: 'max', EGDESK_CODEX_CONFIG: 'sandbox_mode="danger-full-access"',
  }, listen })
  assert.deepEqual(launch.args, ['app-server', '-c', 'model="gpt-6-sol"', '-c', 'model_reasoning_effort="max"', '--listen', listen])
  assert.deepEqual([launch.configuredModel, launch.configuredEffort, launch.hasOverrides], ['gpt-6-sol', 'max', true])
  assert.deepEqual(buildCodexAppServerLaunch({ env: { EGDESK_CODEX_MODEL: 'gpt-6-sol' }, listen }).args, ['app-server', '-c', 'model="gpt-6-sol"', '--listen', listen])
  const isolated = buildCodexAppServerLaunch({ env: { EGDESK_CODEX_DISABLE_MEMORIES: '1' }, listen })
  assert.deepEqual(isolated.args, ['app-server', '-c', 'features.memories=false', '--listen', listen])
  assert.equal(isolated.disableMemories, true)
  assert.equal(isolated.hasOverrides, false)
  assert.deepEqual(buildCodexAppServerLaunch({ env: { EGDESK_CODEX_MODEL: 'gpt-6-sol', EGDESK_CODEX_EFFORT: 'max', EGDESK_CODEX_DISABLE_MEMORIES: '1' }, listen }).args,
    ['app-server', '-c', 'model="gpt-6-sol"', '-c', 'model_reasoning_effort="max"', '-c', 'features.memories=false', '--listen', listen])
  for (const value of [null, '', 'gpt-6-sol -c sandbox_mode="danger-full-access"', 'gpt-6-sol\n--profile hidden']) {
    assert.throws(() => buildCodexAppServerLaunch({ env: { EGDESK_CODEX_MODEL: value }, listen }), e => e.code === 'INVALID_CODEX_MODEL_OVERRIDE')
  }
  for (const value of [null, '', 'max --sandbox danger-full-access', 'MAX']) {
    assert.throws(() => buildCodexAppServerLaunch({ env: { EGDESK_CODEX_EFFORT: value }, listen }), e => e.code === 'INVALID_CODEX_EFFORT_OVERRIDE')
  }
  for (const value of [null, '', '0', 'true', 1, '1 -c sandbox_mode="danger-full-access"']) {
    assert.throws(() => buildCodexAppServerLaunch({ env: { EGDESK_CODEX_DISABLE_MEMORIES: value }, listen }), e => e.code === 'INVALID_CODEX_MEMORY_OVERRIDE')
  }
})

test('owned App Server memory isolation requires native effective memories=false before readiness', async () => {
  const calls = []
  const verified = await verifyCodexMemoryFeatureDisabled(async (method, params) => {
    calls.push([method, params])
    return params.cursor ? { data: [{ name: 'memories', enabled: false }], nextCursor: null }
      : { data: [{ name: 'other', enabled: true }], nextCursor: 'page-two' }
  })
  assert.deepEqual(verified, { status: 'verified-disabled', feature: 'memories' })
  assert.deepEqual(calls, [
    ['experimentalFeature/list', { limit: 100 }],
    ['experimentalFeature/list', { limit: 100, cursor: 'page-two' }],
  ])
  const sentinel = 'PRIVATE_MEMORY_JOB_SENTINEL'
  for (const request of [
    async () => { throw new Error(sentinel) },
    async () => ({ data: [], nextCursor: null }),
    async () => ({ data: [{ name: 'memories', enabled: true }], nextCursor: null }),
    async () => ({ data: [{ name: 'memories', enabled: false }, { name: 'memories', enabled: false }], nextCursor: null }),
    async () => ({ data: [], nextCursor: '' }),
    async () => ({ data: [], nextCursor: 7 }),
    async () => ({ data: [], nextCursor: 'same' }),
  ]) {
    await assert.rejects(verifyCodexMemoryFeatureDisabled(request), error =>
      error.code === 'CODEX_MEMORY_ISOLATION_UNVERIFIED' && !error.message.includes(sentinel))
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
  assert.ok(source.includes('qaReady: () => nativeCapabilities.qaReadOnly && appServerReady'))
  const proof = source.indexOf('nativePreflight = verifyCodexLaunchConfiguration(appServerLaunch, config)')
  assert.ok(proof > source.indexOf("connection.request('config/read'"))
  assert.ok(proof < source.indexOf('appServerReady = true', proof))
  const memoryProof = source.indexOf('memoryIsolation = verified')
  assert.ok(memoryProof > source.indexOf('const verified = await verifyCodexMemoryFeatureDisabled'))
  assert.ok(memoryProof < source.indexOf('appServerReady = true', memoryProof))
  assert.ok(source.includes("appServerProcess.kill('SIGTERM')"))
  assert.ok(source.includes('memoryIsolation, node: nodeRuntime'))
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
