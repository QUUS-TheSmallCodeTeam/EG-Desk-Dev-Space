// c22 (behind EGDESK_OWN_TOOLS=on, the same developer flag as EG-Desk's own tools; default off): Codex as a PURE model engine also
// when it runs on the person's own Codex home. pureEngineThreadOverrides() (c18) turns Codex's own shell, exec, image, web and
// project-doc tools off; it does not touch what the person configured for their own Codex: MCP servers, plugins, apps, hooks, skills,
// memories, sub-agents. With the person's home those would ride into every EG-Desk thread (owner rule U11: profile, account, folder and
// screen combine independently; EG-Desk does not follow Codex's config hierarchy and inherits nothing but the login).
//
// Keys come from the 0.171 config types (core/config.schema.json, features/src/lib.rs; Main's 0.171.0-alpha.13 app-server schema):
//   features.apps / hooks / plugins / remote_plugin / multi_agent / memories / skill_search, features.code_mode.enabled,
//   features.browser_use / browser_use_external / computer_use, skills.include_instructions, skills.bundled.enabled,
//   include_apps_instructions, mcp_servers.<name>.enabled, plugins.<id>.enabled.
// MCP servers are switched off by NAME (enabled = false), the same way the bounded QA thread does it (codex-chat-execution-policy.mjs
// qaThreadOverrides): config layers merge, so an empty table at a later layer is not known to remove the person's entries, and a stub
// for a plugin-provided name makes a transport-less entry (the 0.160.1 finding). Names are read from mcpServerStatus/list and
// config/read layers (shape only; commands, URLs and env are never copied or kept).
// Whether each key holds at thread/start on the real binary is NOT confirmed here: the real-engine check reads it back per thread
// (mcpServerStatus/list, experimentalFeature/list and hooks/list with the thread id; instructionSources on the thread/start result).
import { NATIVE_COMPUTER_FEATURES, disabledNativeMcpConfig, listNativeMcpServers, readNativeDirectMcpServerIds } from './codex-chat-execution-policy.mjs'

// c23 (model-facing text, not user copy). Main's check-1 on the official 0.171: asked to edit a file, the engine answered that "the session's
// filesystem permissions are read-only" and never called egdesk_edit_file. Two causes, both fixed here and both behind the own-tools flag:
//   1. Codex injects a <permissions instructions> developer block that describes the read-only sandbox and the never-asking approval policy
//      (config key include_permissions_instructions, core/config.schema.json: "Whether to inject the <permissions instructions> developer
//      block"). It is true for Codex's own tools and false for ours, so the block is switched off for the thread.
//   2. Nothing told the model that the egdesk_* tools act with EG-Desk's permissions. ThreadStartParams.developerInstructions (0.171 schema,
//      string | null; it is the same field an Agent profile's instructions use) carries one short factual block. It is thread-level
//      (TurnStartParams has no such field), so it is set at thread start and again on every thread resume.
export const OWN_TOOLS_INSTRUCTIONS = [
  'Your own shell and patch tools are off in this session, and this session\'s read-only filesystem setting does not apply to the egdesk_* tools.',
  'EG-Desk carries out file and command work with its own permissions on the person\'s project folder: egdesk_read_file and egdesk_search_files read; egdesk_edit_file changes a file (replace an exact string, apply a diff, write or delete a whole file), applies the change directly, returns a diff, keeps an undo record for egdesk_undo_edit, and with dryRun true only previews; egdesk_run_command runs a command.',
  'When a tool result has status needs_person (a risky command, or deleting or overwriting a whole file), ask the person in your own words, end your turn, and do not repeat that call until they have answered.',
].join('\n')

/** The thread's developer instructions: an Agent's own (if any) first, then the own-tools block. Never empty. */
export function composeOwnToolsInstructions(base) {
  const own = typeof base === 'string' && base.trim() ? base.trim() : ''
  return own ? `${own}\n\n${OWN_TOOLS_INSTRUCTIONS}` : OWN_TOOLS_INSTRUCTIONS
}

export const OWN_TOOLS_ISOLATION_FEATURES = Object.freeze(['apps', 'hooks', 'plugins', 'remote_plugin', 'multi_agent', 'memories', 'skill_search', ...NATIVE_COMPUTER_FEATURES])

/** The thread overrides for a given inventory. servers/directIds null: the inventory could not be read (features and skills only). */
export function ownToolsIsolationOverrides(servers = null, directIds = null) {
  const config = {
    features: { ...Object.fromEntries(OWN_TOOLS_ISOLATION_FEATURES.map(name => [name, false])), code_mode: { enabled: false } },
    skills: { include_instructions: false, bundled: { enabled: false } },
    include_apps_instructions: false,
    include_permissions_instructions: false,
  }
  if (Array.isArray(servers) && directIds instanceof Set) {
    const { mcp_servers, plugins } = disabledNativeMcpConfig(servers, directIds)
    if (Object.keys(mcp_servers).length) config.mcp_servers = { ...mcp_servers }
    if (Object.keys(plugins).length) config.plugins = { ...plugins }
  }
  return { config }
}

/**
 * loadOwnToolsIsolation(request, cwd) → { overrides, mcp: 'disabled_by_name' | 'none_found' | 'unchecked' }
 * Never throws: an inventory that cannot be read leaves the features and skills switches only and says so ('unchecked', P2).
 */
export async function loadOwnToolsIsolation(request, cwd = null) {
  try {
    const directIds = await readNativeDirectMcpServerIds(request, cwd)
    const servers = await listNativeMcpServers(request, null, { detail: 'toolsAndAuthOnly' })
    const overrides = ownToolsIsolationOverrides(servers, directIds)
    const named = Object.keys(overrides.config.mcp_servers ?? {}).length + Object.keys(overrides.config.plugins ?? {}).length
    return { overrides, mcp: named ? 'disabled_by_name' : 'none_found' }
  } catch {
    return { overrides: ownToolsIsolationOverrides(), mcp: 'unchecked' }
  }
}

/**
 * readOwnToolsIsolation(request, { threadId, startResult, folders }) → counts and closed words only (no server, hook, skill or file names):
 *   mcpServersWithTools, featuresNotOff (Codex's own feature names), hooks, instructionSources { total, outside }, model, effort.
 * outside: instruction files loaded from anywhere but the given folders (the person's global AGENTS.md would count here).
 * Each part that cannot be read is 'unreadable'. Used by the real-engine check; the product does not call it per turn.
 */
export async function readOwnToolsIsolation(request, { threadId, startResult = null, folders = [] } = {}) {
  const out = {}
  try {
    const servers = await listNativeMcpServers(request, threadId, { detail: 'toolsAndAuthOnly' })
    out.mcpServers = servers.length
    out.mcpServersWithTools = servers.filter(s => Object.keys(s.tools).length > 0).length
  } catch { out.mcpServers = 'unreadable'; out.mcpServersWithTools = 'unreadable' }
  try {
    const result = await request('experimentalFeature/list', { limit: 100, threadId })
    const rows = Array.isArray(result?.data) ? result.data : null
    if (!rows) throw new Error('shape')
    const enabled = new Map(rows.filter(r => typeof r?.name === 'string').map(r => [r.name, r.enabled]))
    out.featuresNotOff = OWN_TOOLS_ISOLATION_FEATURES.filter(name => enabled.has(name) && enabled.get(name) !== false)
    out.featuresUnreported = OWN_TOOLS_ISOLATION_FEATURES.filter(name => !enabled.has(name))
  } catch { out.featuresNotOff = 'unreadable' }
  try {
    const result = await request('hooks/list', { threadId })
    const rows = Array.isArray(result?.data) ? result.data : null
    if (!rows) throw new Error('shape')
    out.hooks = rows.reduce((n, row) => n + (Array.isArray(row?.hooks) ? row.hooks.length : 0), 0)
  } catch { out.hooks = 'unreadable' }
  const sources = Array.isArray(startResult?.instructionSources) ? startResult.instructionSources.filter(s => typeof s === 'string') : null
  if (sources) {
    const inside = s => folders.some(folder => typeof folder === 'string' && folder && (s === folder || s.startsWith(folder.endsWith('/') ? folder : `${folder}/`)))
    out.instructionSources = { total: sources.length, outside: sources.filter(s => !inside(s)).length }
  } else out.instructionSources = 'unreported'
  out.model = typeof startResult?.model === 'string' ? startResult.model.slice(0, 80) : null
  out.effort = typeof startResult?.reasoningEffort === 'string' ? startResult.reasoningEffort.slice(0, 20) : null
  return out
}
