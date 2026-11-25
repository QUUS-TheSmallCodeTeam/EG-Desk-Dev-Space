// c30: the pure-engine override set computed from the person's config KEY NAMES. Synthetic config only (every value in the synthetic layers is a marker that must never come out).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PURE_CANDIDATE_FEATURES_ON, PURE_ENGINE_TIERS, inventoryFromConfigRead, loadPureEngineOverrides, pureEngineOverrides, readPureInventory, skillsFromList } from './egdesk-pure-engine-config.mjs'
import { loadOwnToolsIsolation } from './egdesk-own-tools-isolation.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const KEYS = JSON.parse(fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'fixtures', 'codex-config-keys-0.171.0-alpha.13.json'), 'utf8'))
const SECRET = 'SECRET-MARKER-9f3a'
const layers = () => [
  { name: { type: 'user' }, version: 'v', config: { mcp_servers: { 'my-notes': { command: SECRET, args: [SECRET], env: { TOKEN: SECRET } }, 'docs.site': { url: `https://${SECRET}.example` } }, plugins: { 'tools@market': { enabled: true } },
    hooks: { PreToolUse: [{ command: SECRET }], state: {} }, skills: { config: [{ name: 'my-skill', enabled: true }] }, model: 'x' } },
  { name: { type: 'project' }, version: 'v', config: { mcp_servers: { 'repo-server': { command: SECRET }, 'bad name with spaces': { command: SECRET } } } },
  { name: { type: 'system' }, version: 'v', config: null },
  { name: { type: 'project' }, version: 'v', disabledReason: 'untrusted project', config: { mcp_servers: { 'disabled-layer-server': { command: SECRET } } } },
]
const merge = (base, over) => { // the table merge of config layers: objects merge key by key, everything else (scalars, arrays) is replaced
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) }
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v)
  return out
}

test('every key the override set uses exists in the 0.171 config types (names fixture): a typo or a removed key fails here, not on the real engine', () => {
  const { config } = pureEngineOverrides({ mcpServers: ['a'], plugins: ['p@m'], skills: [{ name: 's', scope: 'user' }] }, { tier: 'candidates' })
  for (const key of Object.keys(config)) assert.ok(KEYS.topLevel.includes(key), `top-level ${key}`)
  for (const key of Object.keys(config.features)) assert.ok(KEYS.features.includes(key), `feature ${key}`)
  for (const key of PURE_CANDIDATE_FEATURES_ON) assert.ok(KEYS.features.includes(key), `candidate feature ${key}`)
  assert.ok(KEYS.pluginsDefaultProperties.includes('enabled')); for (const key of Object.keys(config.memories)) assert.ok(KEYS.memoriesProperties.includes(key))
  for (const entry of config.skills.config) for (const key of Object.keys(entry)) assert.ok(KEYS.skillConfigProperties.includes(key)); assert.ok(KEYS.rawMcpServerProperties.includes('enabled'))
})

test('the inventory is names only: no value of the person\'s config comes out; an odd name is skipped and counted; system layer and empty layers are fine', () => {
  const inv = inventoryFromConfigRead({ config: {}, layers: layers() })
  assert.deepEqual(inv.mcpServers, ['docs.site', 'my-notes', 'repo-server']); assert.deepEqual(inv.plugins, ['tools@market']); assert.deepEqual(inv.hookEvents, ['PreToolUse']); assert.deepEqual(inv.skillOverrides, ['my-skill'])
  assert.deepEqual(inv.skipped, { mcpServers: 1, plugins: 0 }); assert.equal(JSON.stringify(inv).includes(SECRET), false); assert.equal(inv.layers, 4); assert.equal(inv.mcpServers.includes('disabled-layer-server'), false, 'a layer the engine does not apply adds nothing')
  assert.deepEqual(inventoryFromConfigRead(null).mcpServers, []); assert.deepEqual(inventoryFromConfigRead({ layers: 'x' }).plugins, [])
  assert.deepEqual(skillsFromList({ data: [{ cwd: '/x', errors: [], skills: [{ name: 'mine', scope: 'user', path: '/home/x/.codex/skills/mine', description: SECRET, enabled: true }, { name: 'repo-skill', scope: 'repo' }, { name: 'bundled', scope: 'system' },
    { name: 'from-plugin', scope: 'user', pluginId: 'tools@market' }, { name: 'bad name!', scope: 'user' }] }] }), [{ name: 'mine', scope: 'user' }, { name: 'repo-skill', scope: 'repo' }])
})

test('the override set: table-level switches always; per-name entries only for names the person\'s layers declare; no empty table, no stub for an unknown name', () => {
  const none = pureEngineOverrides(); assert.equal(none.config.mcp_servers, undefined); assert.equal(none.config.skills.config, undefined); assert.deepEqual(none.report.inventoryRead, { mcpServers: false, skills: false })
  const c = none.config
  assert.deepEqual(c.plugins, { _default: { enabled: false } }); assert.equal(c.project_doc_max_bytes, 0); assert.equal(c.include_permissions_instructions, false); assert.equal(c.include_apps_instructions, false)
  assert.deepEqual(c.memories, { use_memories: false, generate_memories: false }); assert.deepEqual(c.skills, { include_instructions: false, bundled: { enabled: false } })
  for (const name of ['apps', 'hooks', 'plugins', 'remote_plugin', 'multi_agent', 'memories', 'skill_search', 'tool_suggest', 'remote_control', 'browser_use', 'computer_use']) assert.equal(c.features[name], false, name)
  assert.deepEqual(c.features.code_mode, { enabled: false }); assert.equal('skip_host_skill_discovery' in c.features, false, 'candidates are not in the base')
  const full = pureEngineOverrides({ mcpServers: ['my-notes', 'docs.site'], plugins: ['tools@market'], skills: [{ name: 'mine', scope: 'user' }] })
  assert.deepEqual(full.config.mcp_servers, { 'my-notes': { enabled: false }, 'docs.site': { enabled: false } }); assert.deepEqual(full.config.plugins, { _default: { enabled: false }, 'tools@market': { enabled: false } })
  assert.deepEqual(full.config.skills.config, [{ name: 'mine', enabled: false }]); assert.deepEqual(full.report, { tier: 'names', mcpServers: 2, plugins: 1, skills: 1, inventoryRead: { mcpServers: true, skills: true } })
  const cand = pureEngineOverrides({}, { tier: 'candidates' }); for (const name of PURE_CANDIDATE_FEATURES_ON) assert.equal(cand.config.features[name], true); assert.deepEqual(PURE_ENGINE_TIERS, ['names', 'candidates'])
  assert.throws(() => pureEngineOverrides({}, { tier: 'other' }), /unknown tier/)
  const odd = pureEngineOverrides({ mcpServers: ['ok', 'not ok', 'x'.repeat(300), 7, null] }); assert.deepEqual(Object.keys(odd.config.mcp_servers), ['ok'])
})

test('merge semantics: -c style tables merge, so an empty table removes nothing and a per-name entry switches the server off while keeping its transport; a plugin default switches all plugins off', () => {
  const person = { mcp_servers: { 'my-notes': { command: 'run-it', args: ['--x'] }, other: { url: 'https://example.invalid' } }, plugins: { 'tools@market': { enabled: true } }, skills: { include_instructions: true, config: [{ name: 'mine', enabled: true }] }, project_doc_max_bytes: 32768 }
  assert.deepEqual(merge(person, { mcp_servers: {} }).mcp_servers, person.mcp_servers, '-c mcp_servers={} changes nothing (Main\'s smoke-3)')
  const { config } = pureEngineOverrides({ mcpServers: ['my-notes', 'other'], plugins: ['tools@market'], skills: [{ name: 'mine', scope: 'user' }] })
  const effective = merge(person, config)
  assert.deepEqual(effective.mcp_servers['my-notes'], { command: 'run-it', args: ['--x'], enabled: false }, 'the entry stays valid (a transport) and is off')
  assert.equal(effective.mcp_servers.other.enabled, false); assert.equal(effective.plugins['tools@market'].enabled, false); assert.equal(effective.plugins._default.enabled, false)
  assert.deepEqual(effective.skills.config, [{ name: 'mine', enabled: false }]); assert.equal(effective.skills.include_instructions, false); assert.equal(effective.project_doc_max_bytes, 0)
  // a server only a plugin contributes has no entry of its own in the person's layers: it gets no stub (a stub is a transport-less server); the plugin default covers it
  assert.equal(config.mcp_servers['plugin-only-server'], undefined)
})

function fakeRequest(log, { fail = [] } = {}) {
  return async (method, params) => {
    log.push([method, params]); if (fail.includes(method)) throw new Error('refused')
    if (method === 'config/read') return { config: {}, layers: layers().map(l => (l.config ? l : { ...l, config: {} })) }
    if (method === 'skills/list') return { data: [{ cwd: '/work', errors: [], skills: [{ name: 'mine', scope: 'user' }, { name: 'bundled', scope: 'system' }] }] }
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'my-notes', tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null }
    throw new Error(`unexpected ${method}`)
  }
}

test('reading the inventory starts nothing: config/read and skills/list only, never mcpServerStatus/list; an unreadable part is null and the switches still apply', async () => {
  const log = []
  const out = await loadPureEngineOverrides(fakeRequest(log), '/work')
  assert.deepEqual(log.map(([m]) => m).sort(), ['config/read', 'skills/list']); assert.deepEqual(log.find(([m]) => m === 'config/read')[1], { includeLayers: true, cwd: '/work' })
  assert.equal(out.mcp, 'disabled_by_name'); assert.deepEqual(Object.keys(out.overrides.config.mcp_servers), ['docs.site', 'my-notes', 'repo-server']); assert.equal(JSON.stringify(out).includes(SECRET), false)
  assert.deepEqual(out.report, { tier: 'names', mcpServers: 3, plugins: 1, skills: 1, inventoryRead: { mcpServers: true, skills: true } })
  const down = await loadPureEngineOverrides(fakeRequest([], { fail: ['config/read', 'skills/list'] }), '/work')
  assert.equal(down.mcp, 'unchecked'); assert.equal(down.overrides.config.mcp_servers, undefined); assert.equal(down.overrides.config.plugins._default.enabled, false); assert.equal(down.overrides.config.project_doc_max_bytes, 0)
  const inv = await readPureInventory(fakeRequest([], { fail: ['skills/list'] })); assert.equal(inv.skills, null); assert.ok(Array.isArray(inv.mcpServers))
})

test('loadOwnToolsIsolation: unchanged without the flag (it asks mcpServerStatus/list); with the flag the pure set, and no server is started to read names', async () => {
  const before = [], old = await loadOwnToolsIsolation(fakeRequest(before), '/work')
  assert.ok(before.some(([m]) => m === 'mcpServerStatus/list'), 'the old inventory starts the servers'); assert.equal(old.pure, undefined); assert.equal(old.overrides.config.plugins?._default, undefined)
  const log = [], pure = await loadOwnToolsIsolation(fakeRequest(log), '/work', { pure: 'names' })
  assert.equal(log.some(([m]) => m === 'mcpServerStatus/list'), false); assert.equal(pure.overrides.config.plugins._default.enabled, false); assert.equal(pure.pure.tier, 'names'); assert.equal(pure.mcp, 'disabled_by_name')
  assert.equal((await loadOwnToolsIsolation(fakeRequest([]), '/work', { pure: 'other' })).pure, undefined, 'an unknown word is the old behaviour')
})

test('the wiring offers the pure engine only for the two known words', () => {
  const make = env => createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', PATH: '/usr/bin', HOME: '/home/synthetic', ...env }, dataDir: fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'pure-wiring-')), spawn: () => { throw new Error('never spawned') }, getChat: () => null, home: '/home/synthetic', gitStatus: async () => null }).ownTools
  assert.equal(make({}).pureEngine, undefined); assert.equal(make({ EGDESK_OWN_TOOLS_PURE: 'names' }).pureEngine(), 'names'); assert.equal(make({ EGDESK_OWN_TOOLS_PURE: 'candidates' }).pureEngine(), 'candidates'); assert.equal(make({ EGDESK_OWN_TOOLS_PURE: 'yes' }).pureEngine, undefined)
})
