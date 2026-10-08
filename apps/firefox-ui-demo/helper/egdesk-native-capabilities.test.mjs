import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
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
  assert.equal(old.qaReadOnly, false)
  const current = inspectNativeCapabilities({ executable, run: () => ({ status: 0, stdout: 'codex-cli 0.160.1\n' }) })
  assert.equal(current.schemaMatch, true)
  assert.equal(current.dynamicTools, true)
  assert.equal(current.readerReadOnly, true)
  assert.equal(current.qaReadOnly, true)
  assert.equal(proof.qaReadOnly, false)
  assert.equal(inspectNativeCapabilities({ executable, run: () => ({ status: 0, stdout: 'codex-cli 0.160.2\n' }) }).schemaMatch, false)
})

test('installed 0.160.1 generated experimental schema has the exact native contracts used by context, Reader and read-only QA', async t => {
  const cli = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 })
  if (cli.status !== 0 || cli.stdout.trim() !== 'codex-cli 0.160.1') return t.skip('Codex 0.160.1 CLI is not installed on this test host')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-app-server-schema-'))
  try {
    const generated = spawnSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', dir], { encoding: 'utf8', timeout: 10000 })
    assert.equal(generated.status, 0, generated.stderr)
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
  } finally { await rm(dir, { recursive: true, force: true }) }
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
  assert.ok(source.includes('qaReady: () => nativeCapabilities.qaReadOnly && appServerReady'))
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
