// c22: an own-tools thread on the person's own Codex home inherits none of their own Codex setup (mock app-server; nothing runs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { OWN_TOOLS_ISOLATION_FEATURES, loadOwnToolsIsolation, ownToolsIsolationOverrides, readOwnToolsIsolation } from './egdesk-own-tools-isolation.mjs'
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
  assert.deepEqual(Object.keys(ownToolsIsolationOverrides().config).sort(), ['features', 'include_apps_instructions', 'skills'])
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
