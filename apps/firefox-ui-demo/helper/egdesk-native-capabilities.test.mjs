import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { buildCodexAppServerLaunch, CODEX_CHAT_VERSION_POLICY, ENGINE_VERSION_STATUSES, engineVersionStatus, inspectNativeCapabilities, preflightOwnedAppServer, resolveCodexExecutable, verifyCodexLaunchConfiguration, verifyCodexMemoryFeatureDisabled } from './egdesk-native-capabilities.mjs'
import { fingerprintNativeExecutable, verifyNativeSchemaDirectory } from './codex-native-schema-probe.mjs'
import { AppServerRpc } from './codex-app-server-rpc.mjs'

test('Windows native executable discovery respects Path and selects the executable rather than a shell wrapper', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-exe-resolver-'))
  try {
    const executable = path.join(dir, 'codex.exe')
    await writeFile(executable, 'public executable fixture', { mode: 0o700 })
    await writeFile(path.join(dir, 'codex.cmd'), 'not selected', { mode: 0o700 })
    const canonicalExecutable = await realpath(executable)
    assert.equal(resolveCodexExecutable({ Path: dir }, { platform: 'win32' }), canonicalExecutable)
    assert.equal(resolveCodexExecutable({ EGDESK_CODEX_BIN: executable, Path: '' }, { platform: 'win32' }), canonicalExecutable)
    assert.throws(() => resolveCodexExecutable({ EGDESK_CODEX_BIN: 'relative/codex', Path: dir }, { platform: 'win32' }), /unavailable/)
  } finally {
    assert.equal(path.dirname(dir), os.tmpdir())
    assert.match(path.basename(dir), /^egdesk-exe-resolver-/)
    await rm(dir, { recursive: true })
  }
})

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

test('only the schema-verified Windows prerelease can expose native QA tools', () => {
  const inspect = (version, options = {}) => inspectNativeCapabilities({ executable: '/selected/native',
    run: () => ({ status: 0, stdout: `codex-cli ${version}\n` }),
    probe: () => ({ contextContract: true, qaContract: true, schemaFingerprint: 'a'.repeat(64) }),
    fingerprint: () => 'b'.repeat(64), ...options })
  const proof = inspect('0.163.0-alpha.10.2')
  assert.equal(proof.version, '0.163.0-alpha.10.2')
  assert.equal(proof.qaReadOnly, true)
  assert.match(proof.contractFingerprint, /^[a-f0-9]{64}$/)
  for (const version of ['0.163.0-alpha.10.3', '0.163.0-alpha.10.1', '0.163.0', '0.164.0']) {
    assert.equal(inspect(version).schemaMatch, false)
  }
  assert.equal(inspect('0.163.0-alpha.10.2', { probe: () => null }).qaReadOnly, false)
  assert.equal(inspect('0.163.0-alpha.10.2', { fingerprint: () => 'bad' }).qaReadOnly, false)
  assert.equal(inspect('0.163.0-alpha.10.2', { probe: () => ({ contextContract: true,
    qaContract: false, schemaFingerprint: 'a'.repeat(64) }) }).qaReadOnly, false)
})

test('0.162.1 requires the selected executable fingerprint and context schema, but does not authorize QA', () => {
  const run = () => ({ status: 0, stdout: 'codex-cli 0.162.1\n' })
  const full = { contextContract: true, qaContract: true, schemaFingerprint: 'a'.repeat(64) }
  const inspect = (proof, fingerprint = () => 'b'.repeat(64)) => inspectNativeCapabilities({
    executable: '/selected/native', run, probe: () => proof, fingerprint,
  })
  assert.deepEqual([inspect(full).schemaMatch, inspect(full).qaReadOnly], [true, false])
  assert.deepEqual([inspect(null).schemaMatch, inspect(null).qaReadOnly], [false, false])
  assert.deepEqual([inspect({ ...full, contextContract: false }).schemaMatch, inspect({ ...full, contextContract: false }).qaReadOnly], [false, false])
  assert.deepEqual([inspect({ ...full, qaContract: false }).schemaMatch, inspect({ ...full, qaContract: false }).qaReadOnly], [true, false])
  assert.deepEqual([inspect({ ...full, schemaFingerprint: 'bad' }).schemaMatch, inspect({ ...full, schemaFingerprint: 'bad' }).qaReadOnly], [false, false])
  assert.deepEqual([inspect(full, () => 'bad').schemaMatch, inspect(full, () => 'bad').qaReadOnly], [false, false])
  let probes = 0
  const unknown = inspectNativeCapabilities({ executable: '/selected/native', run: () => ({ status: 0, stdout: 'codex-cli 0.162.2\n' }),
    probe: () => { probes++; return full }, fingerprint: () => 'b'.repeat(64) })
  assert.deepEqual([unknown.schemaMatch, unknown.qaReadOnly], [false, false])
  assert.equal(probes, 0, 'an unknown version is not accepted on generated shape alone')
})

test('installed 0.160.1 or 0.162.1 generated experimental schema is checked without expanding QA authorization', async t => {
  let executable
  try { executable = resolveCodexExecutable() } catch { return t.skip('No configured Codex CLI is available on this test host') }
  const cli = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 })
  if (cli.status !== 0 || !['codex-cli 0.160.1', 'codex-cli 0.162.1'].includes(cli.stdout.trim())) return t.skip('A checked Codex CLI is not installed on this test host')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-app-server-schema-'))
  try {
    const generated = spawnSync(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', dir], { encoding: 'utf8', timeout: 10000 })
    assert.equal(generated.status, 0, generated.stderr)
    assert.deepEqual({ contextContract: verifyNativeSchemaDirectory(dir)?.contextContract, qaContract: verifyNativeSchemaDirectory(dir)?.qaContract }, { contextContract: true, qaContract: true })
    const actual = inspectNativeCapabilities({ executable })
    assert.equal(actual.schemaMatch, true)
    assert.equal(actual.qaReadOnly, cli.stdout.trim() === 'codex-cli 0.160.1')
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

test('combined memory-disable and model mismatch blocks startup and stops only the owned child before memory RPC', async () => {
  const launch = buildCodexAppServerLaunch({ env: {
    EGDESK_CODEX_MODEL: 'gpt-6-sol', EGDESK_CODEX_EFFORT: 'max', EGDESK_CODEX_DISABLE_MEMORIES: '1',
  }, listen: 'ws://127.0.0.1:39219' })
  let reconnectBlocked = false
  const ownedChild = { killed: false, kill(signal) { assert.equal(signal, 'SIGTERM'); assert.equal(reconnectBlocked, true); this.killed = true } }
  let stopped = 0, memoryChecks = 0
  const request = async method => {
    if (method === 'config/read') return { config: { model: 'gpt-6-astra', model_reasoning_effort: 'max' } }
    if (method === 'experimentalFeature/list') { memoryChecks++; return { data: [{ name: 'memories', enabled: false }], nextCursor: null } }
    throw new Error(`Unexpected metadata method ${method}`)
  }
  const result = await preflightOwnedAppServer({ launch, request, cwd: '/fixture', stopOwnedChild: () => { reconnectBlocked = true; stopped++; ownedChild.kill('SIGTERM') } })
  assert.equal(result.ready, false)
  assert.equal(result.reconnectBlocked, true)
  assert.equal(reconnectBlocked, true)
  assert.equal(result.failedStage, 'model')
  assert.equal(result.error.code, 'CODEX_LAUNCH_CONFIG_MISMATCH')
  assert.equal(result.modelProof, null)
  assert.equal(result.memoryProof, null)
  assert.equal(memoryChecks, 0)
  assert.equal(stopped, 1)
  assert.equal(ownedChild.killed, true)
  const stale = await preflightOwnedAppServer({ launch, request, cwd: '/fixture', isCurrent: () => false,
    stopOwnedChild: () => { stopped++ } })
  assert.deepEqual(stale, { stale: true })
  assert.equal(stopped, 1)
})

test('combined startup reaches readiness only with both model and memory proofs', async () => {
  const launch = buildCodexAppServerLaunch({ env: {
    EGDESK_CODEX_MODEL: 'gpt-6-sol', EGDESK_CODEX_EFFORT: 'max', EGDESK_CODEX_DISABLE_MEMORIES: '1',
  }, listen: 'ws://127.0.0.1:39219' })
  let stopped = 0
  const request = enabled => async method => method === 'config/read'
    ? { config: { model: 'gpt-6-sol', model_reasoning_effort: 'max' } }
    : { data: [{ name: 'memories', enabled }], nextCursor: null }
  const healthy = await preflightOwnedAppServer({ launch, cwd: '/fixture', request: request(false), stopOwnedChild: () => { stopped++ } })
  assert.equal(healthy.ready, true)
  assert.equal(healthy.reconnectBlocked, false)
  assert.equal(healthy.modelProof.status, 'verified')
  assert.equal(healthy.memoryProof.status, 'verified-disabled')
  assert.equal(stopped, 0)
  const unsafe = await preflightOwnedAppServer({ launch, cwd: '/fixture', request: request(true), stopOwnedChild: () => { stopped++ } })
  assert.equal(unsafe.ready, false)
  assert.equal(unsafe.reconnectBlocked, true)
  assert.equal(unsafe.failedStage, 'memories')
  assert.equal(unsafe.modelProof.status, 'verified')
  assert.equal(stopped, 1)
})

test('production spawn uses the validated argv without a shell and proves config before chat readiness', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('spawn(executable, appServerLaunch.args, {'))
  assert.ok(source.includes('shell: false'))
  assert.ok(source.includes('qaReady: () => nativeCapabilities.qaReadOnly && appServerReady'))
  const proof = source.indexOf('const preflight = await preflightOwnedAppServer')
  assert.ok(proof > source.indexOf('await connection.initialize()'))
  assert.ok(proof < source.indexOf('appServerReady = true', proof))
  assert.ok(source.includes('launchConfigBlocked = preflight.reconnectBlocked'))
  assert.ok(source.includes('if (!preflight.ready)'))
  assert.ok(source.includes('stopOwnedChild: () => {'))
  const stopStart = source.indexOf('stopOwnedChild: () => {')
  const reconnectFence = source.indexOf('launchConfigBlocked = true', stopStart)
  const readinessFence = source.indexOf('appServerReady = false', stopStart)
  const childSignal = source.indexOf("appServerProcess.kill('SIGTERM')", stopStart)
  assert.ok(stopStart < reconnectFence && reconnectFence < childSignal)
  assert.ok(stopStart < readinessFence && readinessFence < childSignal)
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

// SUB-13: ordinary Chat uses a range (verified / not verified / below minimum),
// the experimental schema features keep the exact sets (t3code providerCompatibility.ts).
test('Chat version range: checked versions are supported, newer ones untested, older ones unsupported, and schema features stay exact', () => {
  assert.deepEqual(ENGINE_VERSION_STATUSES, ['supported', 'untested', 'unsupported'])
  const status = version => engineVersionStatus(version, CODEX_CHAT_VERSION_POLICY)
  for (const version of ['0.157.1', '0.160.1', '0.162.1', '0.163.0-alpha.10.2']) assert.equal(status(version), 'supported', version)
  for (const version of ['0.157.0', '0.160.2', '0.163.0', '0.163.0-alpha.10.3', '0.170.0', '1.0.0', '0.162.1+build.7']) assert.equal(status(version), 'untested', version)
  for (const version of ['0.156.9', '0.130.0', '0.157.0-alpha.1', '0.0.1']) assert.equal(status(version), 'unsupported', version)
  for (const version of [null, undefined, '', 'codex-cli 0.162.1', '0.162', 'v0.162.1', '/usr/local/bin/codex', 162, `0.162.1-${'x'.repeat(90)}`]) assert.equal(status(version), null, String(version))
  assert.equal(engineVersionStatus('2.1.300', { verified: [], minimum: 'bad' }), 'untested', 'no usable minimum: never invented as unsupported')
  assert.equal(engineVersionStatus('2.1.300', null), 'untested')
  // A supported banner is not enough: Context/QA still needs proof from the
  // exact executable and its generated schema, and unknown versions stay shut.
  const inspect = version => inspectNativeCapabilities({ executable: '/selected/native', run: () => ({ status: 0, stdout: `codex-cli ${version}\n` }),
    probe: () => ({ contextContract: true, qaContract: true, schemaFingerprint: 'a'.repeat(64) }), fingerprint: () => 'b'.repeat(64) })
  const daily = inspect('0.162.1')
  assert.deepEqual([daily.versionStatus, daily.schemaMatch, daily.qaReadOnly], ['supported', true, false])
  const pinned = inspect('0.160.1')
  assert.deepEqual([pinned.versionStatus, pinned.schemaMatch, pinned.qaReadOnly], ['supported', true, true])
  assert.deepEqual([inspect('0.165.0').versionStatus, inspect('0.165.0').schemaMatch], ['untested', false])
  assert.equal(inspect('0.150.0').versionStatus, 'unsupported')
  assert.equal(inspectNativeCapabilities({ executable: '/selected/native', run: () => ({ status: 1, stdout: '' }) }).versionStatus, null)
})

test('SUB-11: codexHome becomes CODEX_HOME for the spawn and must be absolute', () => {
  const listen = 'ws://127.0.0.1:39219'
  assert.deepEqual(buildCodexAppServerLaunch({ env: {}, listen }).envOverrides, {})
  assert.deepEqual(buildCodexAppServerLaunch({ env: {}, listen, codexHome: '/x/engines/codex-abcdef01' }).envOverrides, { CODEX_HOME: '/x/engines/codex-abcdef01' })
  for (const bad of ['relative/dir', '/a\0b', 7]) assert.throws(() => buildCodexAppServerLaunch({ env: {}, listen, codexHome: bad }), { code: 'INVALID_CODEX_HOME' })
})
