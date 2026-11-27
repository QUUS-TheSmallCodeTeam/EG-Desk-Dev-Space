// c30 (U10, pure engine): the smallest thread-level override set that turns the person's own Codex setup off for an EG-Desk thread WITHOUT a separate CODEX_HOME (that is the owner's
// decision, not made here). Computed from the person's config KEY NAMES only: never a command, URL, env value, token, header or file content.
//
// What the 0.171 types say (core/config.schema.json and features/src/lib.rs of rust-v0.171.0-alpha.13, names in scripts/real-engine/fixtures/codex-config-keys-0.171.0-alpha.13.json):
//  * -c and thread/start `config` are MERGED over the person's layers table by table: `-c mcp_servers={}` merges an empty table, it removes nothing (Main's smoke-3: the same startup
//    events with and without it). A server is switched off by an entry of its own name, `mcp_servers.<name>.enabled = false` (RawMcpServerConfig.enabled), merged into the entry.
//  * Servers contributed by installed plugins have no entry of their own: `plugins._default.enabled = false` (PluginsDefaultConfig, "defaults for installed plugin activation")
//    switches every installed plugin off without naming any; `features.plugins = false` is the second lock. A stub entry for a plugin's server name would be a transport-less
//    server (the 0.160.1 finding), so no stub is ever written for a name that is not in the person's config layers.
//  * The READING of the inventory must not start the servers: mcpServerStatus/list without a thread starts every configured server to learn its tools (the old loader did that
//    before each EG-Desk thread: ~1-2 s and the startup events of every server the person has). The names come from config/read layers instead (shape only).
//  * Skills: skills.include_instructions=false (no catalog in the prompt), skills.bundled.enabled=false, features.skill_search=false, and skills.config entries { name, enabled:false }
//    for every non-system, non-plugin skill that skills/list reports (user, repo, admin). skip_host_skill_discovery (UnderDevelopment) is a candidate, not part of the base.
//  * Hooks: features.hooks=false. Memories: features.memories=false and memories.{use_memories,generate_memories}=false. Apps: features.apps=false, include_apps_instructions=false.
//  * AGENTS.md: project_doc_max_bytes = 0 ends the project documents (agents_md.rs returns early). The person's GLOBAL instructions file is read by the host (UserInstructionsProvider)
//    with no key in the 0.171 config: it cannot be switched off per thread (only an EG-Desk-owned CODEX_HOME removes it): measured, not hidden, by the probe.
// Tiers: 'names' = the keys above (each is a documented config key); 'candidates' = names + feature switches still UnderDevelopment in 0.171 whose effect the probe measures.
import { OWN_TOOLS_ISOLATION_FEATURES } from './egdesk-own-tools-isolation.mjs'

export const PURE_ENGINE_TIERS = Object.freeze(['names', 'candidates'])
export const PURE_EXTRA_FEATURES_OFF = Object.freeze(['tool_suggest', 'remote_control'])
export const PURE_CANDIDATE_FEATURES_ON = Object.freeze(['skip_host_skill_discovery', 'mcp_lazy_stdio_startup'])
export const PURE_LIMITS = Object.freeze({ names: 200, nameChars: 120 })
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_.@:+/-]{0,119}$/
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The names the person's config layers declare. Only table KEYS are read; every value is dropped on the spot. */
export function inventoryFromConfigRead(result) {
  const layers = Array.isArray(result?.layers) ? result.layers : []
  const mcp = new Set(), plugins = new Set(), hooks = new Set(), skillOverrides = new Set()
  for (const layer of layers) {
    const config = layer?.config
    if (layer?.disabledReason != null || !isObject(config)) continue // a layer the engine does not apply (disabledReason) contributes nothing
    if (isObject(config.mcp_servers)) for (const name of Object.keys(config.mcp_servers)) mcp.add(name)
    if (isObject(config.plugins)) for (const id of Object.keys(config.plugins)) if (id !== '_default') plugins.add(id)
    if (isObject(config.hooks)) for (const event of Object.keys(config.hooks)) if (event !== 'state') hooks.add(event)
    if (Array.isArray(config.skills?.config)) for (const entry of config.skills.config) { if (typeof entry?.name === 'string') skillOverrides.add(entry.name) }
  }
  const take = set => [...set].filter(name => typeof name === 'string' && NAME_OK.test(name)).sort().slice(0, PURE_LIMITS.names)
  return { mcpServers: take(mcp), plugins: take(plugins), hookEvents: [...hooks].sort().slice(0, 30), skillOverrides: take(skillOverrides), layers: layers.length,
    skipped: { mcpServers: mcp.size - take(mcp).length, plugins: plugins.size - take(plugins).length } }
}

/** The skills a thread must not see: non-system, non-plugin skills of the skills/list answer (names and scopes only). */
export function skillsFromList(result) {
  const names = new Map()
  for (const entry of Array.isArray(result?.data) ? result.data : []) for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
    if (typeof skill?.name !== 'string' || !NAME_OK.test(skill.name)) continue
    if (skill.scope === 'system' || (typeof skill.pluginId === 'string' && skill.pluginId)) continue
    names.set(skill.name, skill.scope ?? null)
  }
  return [...names].map(([name, scope]) => ({ name, scope })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, PURE_LIMITS.names)
}

/**
 * The overrides for a thread. inventory: { mcpServers, plugins, skills } (names only; a part that is null/absent was not read and gets no per-name entries: the table-level
 * switches still apply). Returns { config, report } where report holds counts and closed words only.
 */
export function pureEngineOverrides(inventory = {}, { tier = 'names' } = {}) {
  if (!PURE_ENGINE_TIERS.includes(tier)) throw new TypeError(`unknown tier ${tier}`)
  const inv = isObject(inventory) ? inventory : {}
  const features = { ...Object.fromEntries([...OWN_TOOLS_ISOLATION_FEATURES, ...PURE_EXTRA_FEATURES_OFF].map(name => [name, false])), code_mode: { enabled: false } }
  if (tier === 'candidates') for (const name of PURE_CANDIDATE_FEATURES_ON) features[name] = true
  const config = {
    features,
    plugins: { _default: { enabled: false } },
    skills: { include_instructions: false, bundled: { enabled: false } },
    include_apps_instructions: false,
    include_permissions_instructions: false,
    memories: { use_memories: false, generate_memories: false },
    project_doc_max_bytes: 0,
  }
  const names = list => (Array.isArray(list) ? list : []).filter(name => typeof name === 'string' && NAME_OK.test(name)).slice(0, PURE_LIMITS.names)
  const mcpServers = names(inv.mcpServers), plugins = names(inv.plugins)
  if (mcpServers.length) config.mcp_servers = Object.fromEntries(mcpServers.map(name => [name, { enabled: false }]))
  for (const id of plugins) config.plugins[id] = { enabled: false }
  const skills = (Array.isArray(inv.skills) ? inv.skills : []).filter(s => typeof s?.name === 'string' && NAME_OK.test(s.name)).slice(0, PURE_LIMITS.names)
  if (skills.length) config.skills.config = skills.map(s => ({ name: s.name, enabled: false }))
  return { config, report: { tier, mcpServers: mcpServers.length, plugins: plugins.length, skills: skills.length, inventoryRead: { mcpServers: Array.isArray(inv.mcpServers), skills: Array.isArray(inv.skills) } } }
}

/**
 * readPureInventory(request, cwd) → names only; never starts a server (config/read and skills/list read files). Never throws: a part that cannot be read is null.
 */
export async function readPureInventory(request, cwd = null) {
  const out = { mcpServers: null, plugins: null, hookEvents: null, skills: null, layers: 0 }
  try { const inv = inventoryFromConfigRead(await request('config/read', { includeLayers: true, ...(cwd ? { cwd } : {}) })); Object.assign(out, { mcpServers: inv.mcpServers, plugins: inv.plugins, hookEvents: inv.hookEvents, layers: inv.layers }) } catch { /* unread */ }
  try { out.skills = skillsFromList(await request('skills/list', { cwds: cwd ? [cwd] : [], forceReload: false })) } catch { /* unread */ }
  return out
}

/** loadPureEngineOverrides(request, cwd, { tier }) → { overrides: { config }, mcp, report }: never throws (the table-level switches alone when the names cannot be read, P2). */
export async function loadPureEngineOverrides(request, cwd = null, { tier = 'names' } = {}) {
  const inventory = await readPureInventory(request, cwd)
  const { config, report } = pureEngineOverrides(inventory, { tier })
  const mcp = inventory.mcpServers === null ? 'unchecked' : config.mcp_servers ? 'disabled_by_name' : 'none_found'
  return { overrides: { config }, mcp, report }
}

// ---- c31 (probe): the same overrides as PROCESS-level `-c path=value` arguments, so that the engine's global listings (skills/list, mcpServerStatus/list without a thread) answer under them ----
const BARE = /^[A-Za-z0-9_-]+$/
const key = k => (BARE.test(k) ? k : JSON.stringify(k))
const inline = value => {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`
  if (value !== null && typeof value === 'object') return `{ ${Object.entries(value).map(([k, v]) => `${key(k)} = ${inline(v)}`).join(', ')} }`
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}
/** `path=value` strings (TOML values, quoted keys where needed) for every leaf of a config object; arrays are one inline value. Only our own keys and the person's NAMES are in it. */
export function configOverrideArgs(config, prefix = []) {
  const out = []
  for (const [k, v] of Object.entries(config ?? {})) {
    const path = [...prefix, k]
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) out.push(...configOverrideArgs(v, path))
    else out.push(`${path.map(key).join('.')}=${inline(v)}`)
  }
  return out
}
