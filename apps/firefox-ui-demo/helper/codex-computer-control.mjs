import { chatError } from './codex-chat-values.mjs'
import { featuresNotOff, listNativeMcpServers, readNativeDirectMcpDeclarations, readNativeThreadFeatures } from './codex-chat-execution-policy.mjs'
import { computerUseServerNames, nativeMcpServerKind } from './codex-inherited-mcp.mjs'

// CU-01 stage 1 (docs/references/computer-use-options.md §6): whether ordinary
// EG-Desk Chat threads keep the Codex computer control the user's own Codex
// setup gives them.
// - 'inherit' (the default until the decision): thread settings stay exactly
//   as before; nothing extra is read or sent.
// - 'off': ordinary thread starts and resumes turn off Codex's computer-use
//   plugin (and any plugin whose server drives a browser or the desktop),
//   Codex's own computer and external-browser switches, and the user's direct
//   mcp_servers entries that can drive the Mac; the thread is read back before
//   any turn and COMPUTER_CONTROL_UNVERIFIED refuses the turn on a mismatch.
// Only thread settings change; the user's ~/.codex/config.toml never does.
export const COMPUTER_CONTROL_POLICIES = Object.freeze(['inherit', 'off'])
export const DEFAULT_COMPUTER_CONTROL_POLICY = 'inherit'
// Codex's own switches for driving the Mac and the user's external browser.
// browser_use (Codex's in-app browser) stays as the user set it: EG-Desk
// Browser tools are EG-Desk dynamic tools and do not go through it (§6).
export const COMPUTER_CONTROL_FEATURES = Object.freeze(['computer_use', 'browser_use_external'])
// Plugin servers turned off by pluginId (the browser-ceiling rule, 9ce901c).
// cua_repl serves browser and computer control together.
const PLUGIN_CONTROL_KINDS = new Set(['browser', 'desktop'])
const LIVE_SERVER_STATUSES = new Set(['connected', 'starting'])

export function normalizeComputerControlPolicy(value) {
  if (!COMPUTER_CONTROL_POLICIES.includes(value)) throw chatError('INVALID_COMPUTER_CONTROL_POLICY', "Computer control policy must be 'inherit' or 'off'", 400)
  return value
}

const unverified = message => chatError('COMPUTER_CONTROL_UNVERIFIED', `${message}; no turn was started`, 502)

// Which listed server 'off' turns off, or must find off on the thread.
function controlTarget(server, computerUse, directNames) {
  const kind = nativeMcpServerKind(server, { computerUse: computerUse.has(server.name) })
  if (server.pluginId) return PLUGIN_CONTROL_KINDS.has(kind) ? 'plugin' : null
  if (kind !== 'desktop') return null
  return directNames.has(server.name) ? 'direct' : 'unmanaged'
}

/**
 * thread/start or thread/resume overrides for 'off', read from the inherited
 * MCP inventory (no thread) and the direct declarations of that cwd.
 * Returns { overrides: { config }, plan } where plan is internal (plugin ids,
 * server names, marker names) and is only passed to verifyComputerControlOff.
 */
export async function loadComputerControlOffOverrides(request, { cwd = null } = {}) {
  let servers, declarations
  try {
    servers = await listNativeMcpServers(request, null)
    declarations = await readNativeDirectMcpDeclarations(request, cwd)
  } catch { throw unverified('Computer control could not be turned off: the Codex MCP configuration could not be read') }
  const computerUse = computerUseServerNames(declarations)
  const directNames = new Set(declarations.keys())
  const plugins = Object.create(null), mcp_servers = Object.create(null)
  for (const server of servers) {
    const target = controlTarget(server, computerUse, directNames)
    if (target === 'plugin') plugins[server.pluginId] = { enabled: false }
    else if (target === 'direct') mcp_servers[server.name] = { enabled: false }
  }
  // A direct declaration the inventory did not list is still turned off when
  // its name or a Computer Use marker says it drives the desktop.
  for (const name of directNames) {
    if (!(name in mcp_servers) && controlTarget({ name }, computerUse, directNames) === 'direct') mcp_servers[name] = { enabled: false }
  }
  const config = { features: Object.fromEntries(COMPUTER_CONTROL_FEATURES.map(name => [name, false])) }
  if (Object.keys(plugins).length) config.plugins = plugins
  if (Object.keys(mcp_servers).length) config.mcp_servers = mcp_servers
  return { overrides: { config }, plan: { computerUse, directNames } }
}

/**
 * Reads the started or resumed thread back before any turn: no plugin server
 * that drives a browser or the desktop, and no server that drives the desktop
 * (by name, tools or a Computer Use marker), is live on it, and Codex reports
 * computer_use and browser_use_external off. nativeFeatures is 'verified', or
 * 'unavailable' when this Codex build cannot report thread features (the MCP
 * check still ran). Throws COMPUTER_CONTROL_UNVERIFIED otherwise.
 */
export async function verifyComputerControlOff(request, threadId, plan) {
  let servers
  try { servers = await listNativeMcpServers(request, threadId) } catch { throw unverified('The thread\'s MCP servers could not be read to confirm computer control is off') }
  const computerUse = plan?.computerUse instanceof Set ? plan.computerUse : new Set()
  const directNames = plan?.directNames instanceof Set ? plan.directNames : new Set()
  for (const server of servers) {
    if (!controlTarget(server, computerUse, directNames)) continue
    if (Object.keys(server.tools).length || LIVE_SERVER_STATUSES.has(server.runtimeStatus)) throw unverified('The thread still has a tool that can control the computer')
  }
  let features
  try { features = await readNativeThreadFeatures(request, threadId) } catch { throw unverified('The thread\'s feature switches could not be read to confirm computer control is off') }
  if (features === null) return { nativeFeatures: 'unavailable' }
  if (featuresNotOff(features, COMPUTER_CONTROL_FEATURES).length) throw unverified('The thread still allows Codex computer or external browser control')
  return { nativeFeatures: 'verified' }
}
