// c22: an own-tools thread on the person's own Codex home inherits none of their own Codex setup (mock app-server; nothing runs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { OWN_TOOLS_INSTRUCTIONS, OWN_TOOLS_ISOLATION_FEATURES, composeOwnToolsInstructions, loadOwnToolsIsolation, ownToolsIsolationOverrides, readOwnToolsIsolation } from './egdesk-own-tools-isolation.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { egdeskCodexSelectionFromEnv } from './egdesk-native-capabilities.mjs'
import { COMMAND_TOOL_NAME } from './egdesk-command-executor.mjs'
import { FILE_TOOL_NAMES } from './egdesk-file-tools.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

// the person's setup as the app-server reports it: one direct MCP server, one plugin-provided server, one hook
const SERVERS = [
  { name: 'my-notes', tools: { search: {} }, resources: [], resourceTemplates: [], authStatus: 'unsupported' },
  { name: 'gh-plugin-server', pluginId: 'github@openai', tools: { pr: {} }, resources: [], resourceTemplates: [], authStatus: 'unsupported' },
]
const LAYERS = [{ name: { type: 'user' }, config: { mcp_servers: { 'my-notes': { command: 'synthetic-notes-server' } } } }]

function appServer({ inventory = true } = {}) {
  const calls = []
  const request = async (method, params) => {
    calls.push([method, structuredClone(params)])
    if (method === 'config/read') { if (!inventory) throw new Error('unavailable'); return { config: {}, layers: LAYERS } }
    if (method === 'mcpServerStatus/list') return { data: SERVERS, nextCursor: null }
    if (method === 'thread/start') return { thread: { id: 'conv-1', ephemeral: true }, cwd: params.cwd }
    if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
    return {}
  }
  return { calls, request }
}

test('the overrides switch the person\'s own MCP servers off by name, plugins by id, and Codex\'s own extension features off', () => {
  const { config } = ownToolsIsolationOverrides(SERVERS, new Set(['my-notes']))
  assert.deepEqual(config.mcp_servers, { 'my-notes': { enabled: false } })
  assert.deepEqual(config.plugins, { 'github@openai': { enabled: false } })
  for (const name of ['apps', 'hooks', 'plugins', 'remote_plugin', 'multi_agent', 'memories', 'skill_search', 'browser_use', 'browser_use_external', 'computer_use']) assert.equal(config.features[name], false, name)
  assert.deepEqual(config.features.code_mode, { enabled: false })
  assert.deepEqual(config.skills, { include_instructions: false, bundled: { enabled: false } })
  assert.equal(config.include_apps_instructions, false)
  assert.doesNotMatch(JSON.stringify(config), /synthetic-notes-server/, 'a declaration is read for its shape, never copied')
  // no inventory: the switches only, nothing guessed by name
  assert.deepEqual(Object.keys(ownToolsIsolationOverrides().config).sort(), ['features', 'include_apps_instructions', 'include_permissions_instructions', 'skills'])
})

test('loading never throws: an unreadable inventory is reported as unchecked and keeps the switches', async () => {
  assert.equal((await loadOwnToolsIsolation(appServer().request, '/x')).mcp, 'disabled_by_name')
  const bad = await loadOwnToolsIsolation(appServer({ inventory: false }).request, '/x')
  assert.equal(bad.mcp, 'unchecked'); assert.equal(bad.overrides.config.features.hooks, false)
  assert.equal((await loadOwnToolsIsolation(async m => (m === 'config/read' ? { layers: [] } : { data: [], nextCursor: null }))).mcp, 'none_found')
})

test('flag on: the own-tools thread/start carries the isolation; flag off: nothing changes', async t => {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-isolation-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const real = path.join(base, 'project'), empty = path.join(base, 'engine-folder')
  fs.mkdirSync(real); fs.mkdirSync(empty)
  for (const flag of ['on', 'off']) {
    const a = appServer()
    const chat = new CodexChatRuntime({ request: a.request, respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
      ownTools: { mode: () => flag, neutralFolder: () => empty } })
    chat.setConnection(true)
    await chat.send({ message: 'hello', clientThreadId: `ui-${flag}`, requestId: `r-${flag}`, cwd: real })
    const start = a.calls.find(([m]) => m === 'thread/start')[1]
    if (flag === 'off') {
      assert.equal(start.config?.mcp_servers, undefined); assert.equal(start.config?.features?.hooks, undefined); assert.equal(start.config?.skills, undefined)
      assert.equal(a.calls.some(([m]) => m === 'mcpServerStatus/list'), false, 'off: no inventory is read')
      continue
    }
    assert.deepEqual(start.config.mcp_servers, { 'my-notes': { enabled: false } })
    assert.deepEqual(start.config.plugins, { 'github@openai': { enabled: false } })
    assert.equal(start.config.features.shell_tool, false, 'c18 switches kept'); assert.equal(start.config.features.memories, false)
    assert.equal(start.config.project_doc_max_bytes, 0)
    assert.equal(a.calls.find(([m]) => m === 'config/read')[1].cwd, empty, 'the inventory is read for the engine folder, never the real one')
    assert.doesNotMatch(JSON.stringify(a.calls), new RegExp(real.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  }
})

test('the read-back reports counts and Codex feature names only', async () => {
  const request = async (method) => {
    if (method === 'mcpServerStatus/list') return { data: SERVERS, nextCursor: null }
    if (method === 'experimentalFeature/list') return { data: OWN_TOOLS_ISOLATION_FEATURES.map(name => ({ name, enabled: name === 'hooks', defaultEnabled: true, stage: 'stable' })), nextCursor: null }
    if (method === 'hooks/list') return { data: [{ cwd: '/e', errors: [], warnings: [], hooks: [{}, {}] }] }
    throw new Error('unknown')
  }
  const out = await readOwnToolsIsolation(request, { threadId: 't', folders: ['/data/engine-folders/empty'],
    startResult: { model: 'gpt-x', reasoningEffort: 'low', instructionSources: ['/home/p/.codex/AGENTS.md', '/data/engine-folders/empty/AGENTS.md'] } })
  assert.deepEqual(out, { mcpServers: 2, mcpServersWithTools: 2, featuresNotOff: ['hooks'], featuresUnreported: [], hooks: 2, instructionSources: { total: 2, outside: 1 }, model: 'gpt-x', effort: 'low' })
  assert.doesNotMatch(JSON.stringify(out), /my-notes|github|AGENTS/)
  const none = await readOwnToolsIsolation(async () => { throw new Error('x') }, { threadId: 't' })
  assert.deepEqual([none.mcpServers, none.featuresNotOff, none.hooks, none.instructionSources], ['unreadable', 'unreadable', 'unreadable', 'unreported'])
})

test('environments: [] is added only when the developer flag asks for it', async t => {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-isolation-env-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const real = path.join(base, 'project'), empty = path.join(base, 'engine-folder')
  fs.mkdirSync(real); fs.mkdirSync(empty)
  for (const environments of [undefined, () => 'none', () => 'other']) {
    const a = appServer()
    const chat = new CodexChatRuntime({ request: a.request, respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, ownTools: { mode: () => 'on', neutralFolder: () => empty, ...(environments ? { environments } : {}) } })
    chat.setConnection(true)
    await chat.send({ message: 'hello', clientThreadId: 'ui', requestId: 'r1', cwd: real })
    const start = a.calls.find(([m]) => m === 'thread/start')[1]
    if (environments?.() === 'none') assert.deepEqual(start.environments, [])
    else assert.equal('environments' in start, false)
  }
})

// ---- c23: the engine is told what its egdesk_* tools are; its permissions block is off; EG-Desk's own model; restored threads are as pure as new ones ----
const AGENT = { binding: { profileId: 'agent', revision: 1, hash: 'h' }, developerInstructions: 'You are the bookkeeping agent.', toolCeiling: null, model: { engine: 'codex', engineProfileId: null, modelId: 'agent-model', effort: 'high' } }
function runtimeWith(t, { profile = null, agents = false, ownFlag = 'on', models = null } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-c23-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const real = path.join(base, 'project'), empty = path.join(base, 'engine-folder')
  fs.mkdirSync(real); fs.mkdirSync(empty)
  const a = appServer()
  const request = async (method, params) => {
    if (method === 'thread/resume') { a.calls.push([method, structuredClone(params)]); return { thread: { id: params.threadId, turns: [] }, cwd: params.cwd ?? empty, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' } }
    if (method === 'model/list') return { data: [], nextCursor: null }
    return a.request(method, params)
  }
  const chat = new CodexChatRuntime({ request, respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, ...(agents ? { profiles: { runProfile: () => AGENT } } : {}),
    ownTools: { mode: () => ownFlag, neutralFolder: () => empty, ...(profile ? { profile: () => profile } : {}) } })
  chat.setConnection(true)
  const finish = async run => { await chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [] } } }); await chat.queue }
  return { chat, calls: a.calls, real, empty, finish, of: method => a.calls.filter(([m]) => m === method).map(([, p]) => p) }
}

test('the instructions: an own-tools thread starts with EG-Desk\'s block, the permissions block off; an Agent\'s instructions come first; without the flag nothing is added', async t => {
  const w = runtimeWith(t)
  await w.chat.send({ message: 'edit it', clientThreadId: 'ui', requestId: 'r1', cwd: w.real })
  const [start] = w.of('thread/start')
  assert.equal(start.developerInstructions, OWN_TOOLS_INSTRUCTIONS)
  assert.equal(start.config.include_permissions_instructions, false)
  // what the block says, in the model's terms: the engine's own tools are off, the egdesk tools have EG-Desk's permissions, the preview/undo, the ask
  for (const part of ['shell and patch tools are off', 'does not apply to the egdesk_* tools', 'EG-Desk', FILE_TOOL_NAMES.read, FILE_TOOL_NAMES.search, FILE_TOOL_NAMES.edit, FILE_TOOL_NAMES.undo, COMMAND_TOOL_NAME, 'dryRun', 'needs_person']) assert.ok(OWN_TOOLS_INSTRUCTIONS.includes(part), part)
  assert.ok(OWN_TOOLS_INSTRUCTIONS.length < 1200, 'minimal: ' + OWN_TOOLS_INSTRUCTIONS.length)
  assert.doesNotMatch(JSON.stringify(start), new RegExp(w.real.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), 'the real folder is not in what the engine is told')
  assert.equal(composeOwnToolsInstructions(''), OWN_TOOLS_INSTRUCTIONS); assert.equal(composeOwnToolsInstructions('  Agent  '), 'Agent\n\n' + OWN_TOOLS_INSTRUCTIONS)
  const agent = runtimeWith(t, { agents: true })
  await agent.chat.send({ message: 'edit it', clientThreadId: 'ui', requestId: 'r1', cwd: agent.real, profileId: 'agent' })
  assert.equal(agent.of('thread/start')[0].developerInstructions, 'You are the bookkeeping agent.\n\n' + OWN_TOOLS_INSTRUCTIONS)
  const off = runtimeWith(t, { ownFlag: 'off' })
  await off.chat.send({ message: 'edit it', clientThreadId: 'ui', requestId: 'r1', cwd: off.real })
  const [plain] = off.of('thread/start')
  assert.equal(plain.developerInstructions, undefined); assert.equal(plain.config?.include_permissions_instructions, undefined)
})

test('a restored own-tools thread is resumed with the same pure switches, isolation and instructions as a new one', async t => {
  const w = runtimeWith(t)
  const run = await w.chat.send({ message: 'first', clientThreadId: 'ui', requestId: 'r1', cwd: w.real })
  await w.finish(run)
  w.chat.loadedThreads.delete(run.conversationId) // as after a restart: the native thread is not loaded
  await w.chat.send({ message: 'second', clientThreadId: 'ui', requestId: 'r2', conversationId: run.conversationId, cwd: w.real })
  const [resume] = w.of('thread/resume')
  assert.ok(resume, 'the thread was resumed')
  assert.equal(resume.sandbox, 'read-only'); assert.equal(resume.approvalPolicy, 'never')
  assert.equal(resume.config.features.shell_tool, false); assert.equal(resume.config.features.hooks, false); assert.equal(resume.config.include_permissions_instructions, false)
  assert.deepEqual(resume.config.mcp_servers, { 'my-notes': { enabled: false } })
  assert.equal(resume.developerInstructions, OWN_TOOLS_INSTRUCTIONS)
})

test('the model and effort: EG-Desk\'s own for a thread that names none; the request wins over the Agent, the Agent over EG-Desk; no flag, no change', async t => {
  const modelOf = w => ({ start: w.of('thread/start')[0]?.model, turn: w.of('turn/start')[0] })
  const own = runtimeWith(t, { profile: { model: 'egdesk-model', effort: 'low' } })
  await own.chat.send({ message: 'hi', clientThreadId: 'ui', requestId: 'r1', cwd: own.real })
  assert.equal(modelOf(own).start, 'egdesk-model'); assert.equal(modelOf(own).turn.model, 'egdesk-model'); assert.equal(modelOf(own).turn.effort, 'low')
  const agent = runtimeWith(t, { profile: { model: 'egdesk-model', effort: 'low' }, agents: true })
  await agent.chat.send({ message: 'hi', clientThreadId: 'ui', requestId: 'r1', cwd: agent.real, profileId: 'agent' })
  assert.equal(modelOf(agent).turn.model, 'agent-model'); assert.equal(modelOf(agent).turn.effort, 'high')
  const asked = runtimeWith(t, { profile: { model: 'egdesk-model', effort: 'low' }, agents: true })
  await asked.chat.send({ message: 'hi', clientThreadId: 'ui', requestId: 'r1', cwd: asked.real, profileId: 'agent', model: 'asked-model', effort: 'medium' })
  assert.equal(modelOf(asked).turn.model, 'asked-model'); assert.equal(modelOf(asked).turn.effort, 'medium')
  const effortOnly = runtimeWith(t, { profile: { effort: 'low' } })
  await effortOnly.chat.send({ message: 'hi', clientThreadId: 'ui', requestId: 'r1', cwd: effortOnly.real })
  assert.equal(modelOf(effortOnly).start, undefined); assert.equal(modelOf(effortOnly).turn.effort, 'low')
  const off = runtimeWith(t, { profile: { model: 'egdesk-model', effort: 'low' }, ownFlag: 'off' })
  await off.chat.send({ message: 'hi', clientThreadId: 'ui', requestId: 'r1', cwd: off.real })
  assert.equal(modelOf(off).start, undefined); assert.equal(modelOf(off).turn.model, undefined); assert.equal(modelOf(off).turn.effort, undefined)
  const none = runtimeWith(t)
  await none.chat.send({ message: 'hi', clientThreadId: 'ui', requestId: 'r1', cwd: none.real })
  assert.equal(modelOf(none).start, undefined, 'nothing configured: Codex keeps its default (the gap is reported, not hidden)')
})

test('EG-Desk\'s selection comes from the launch env names with the launch validation; the wiring exposes it; bad values stop the wiring', () => {
  assert.equal(egdeskCodexSelectionFromEnv({}), null)
  assert.deepEqual(egdeskCodexSelectionFromEnv({ EGDESK_CODEX_MODEL: 'gpt-6-astra', EGDESK_CODEX_EFFORT: 'low' }), { model: 'gpt-6-astra', effort: 'low' })
  assert.deepEqual(egdeskCodexSelectionFromEnv({ EGDESK_CODEX_EFFORT: 'ultra' }), { effort: 'ultra' })
  assert.throws(() => egdeskCodexSelectionFromEnv({ EGDESK_CODEX_MODEL: 'bad model!' }), { code: 'INVALID_CODEX_MODEL_OVERRIDE' })
  assert.throws(() => egdeskCodexSelectionFromEnv({ EGDESK_CODEX_EFFORT: 'warp' }), { code: 'INVALID_CODEX_EFFORT_OVERRIDE' })
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-c23-wiring-'))
  const make = extra => createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', PATH: '/usr/bin', ...extra }, dataDir: base, spawn: () => { throw new Error('no') }, getChat: () => null })
  assert.equal(make({}).ownTools.profile(), null)
  assert.deepEqual(make({ EGDESK_CODEX_MODEL: 'm1', EGDESK_CODEX_EFFORT: 'high' }).ownTools.profile(), { model: 'm1', effort: 'high' })
  assert.throws(() => make({ EGDESK_CODEX_EFFORT: 'warp' }), { code: 'INVALID_CODEX_EFFORT_OVERRIDE' })
  fs.rmSync(base, { recursive: true, force: true })
})
