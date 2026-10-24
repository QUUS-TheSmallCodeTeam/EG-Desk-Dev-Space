import { publicText } from './codex-chat-values.mjs'
import { listNativeMcpServers, readNativeDirectMcpDeclarations } from './codex-chat-execution-policy.mjs'

// CU-07: the user's Codex MCP servers an ordinary EG-Desk thread inherits, and
// which of them can act outside EG-Desk (a browser, the desktop, or arbitrary
// code). Visibility only; whether to block them waits for a decision.
// A row is { name, enabled, status, controlsExternal, kind }. Commands, URLs,
// origins, env, headers, plugin ids, tool schemas and tokens never leave here.
export const INHERITED_MCP_KINDS = Object.freeze(['browser', 'desktop', 'repl', 'other'])
// What a Chat activity row shows for an MCP tool call (mcpToolCall controlKind):
// 'computer' is a server that can drive the Mac (kind 'desktop').
export const MCP_CONTROL_KINDS = Object.freeze(['computer', 'browser', 'repl', 'other'])
const CONTROL_KIND = Object.freeze({ desktop: 'computer', browser: 'browser', repl: 'repl', other: 'other' })
export const mcpControlKind = kind => CONTROL_KIND[kind] || 'other'
// The stronger of two control kinds; a lookup never weakens what the call itself showed.
export const strongerControlKind = (a, b) => MCP_CONTROL_KINDS[Math.min(...[a, b].map(kind => {
  const at = MCP_CONTROL_KINDS.indexOf(kind)
  return at < 0 ? MCP_CONTROL_KINDS.length - 1 : at
}))]
export const INHERITED_MCP_STATUSES = Object.freeze([
  'connected', 'starting', 'notStarted', 'available', 'authenticationRequired', 'failed', 'cancelled', 'disabled', 'unknown',
])
export const INHERITED_MCP_NOTIFICATION = 'mcpServer/startupStatus/updated'
const MAX_SERVERS = 64
const MAX_NAME = 128
const CONNECTION_STATUSES = new Set(['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'])

// Whole name tokens: lower case, split at anything but letters and digits
// and at camelCase humps ("chromeDevtools" → chrome, devtools).
const NAME_RULES = [
  ['browser', new Set(['playwright', 'puppeteer', 'selenium', 'webdriver', 'browser', 'browserbase', 'stagehand', 'chrome', 'chromium', 'firefox', 'devtools'])],
  // 'cua': Codex's own computer-use plugin server is named cua_repl.
  ['desktop', new Set(['computer', 'cua', 'desktop', 'applescript', 'osascript', 'accessibility', 'uiautomation', 'pyautogui', 'autogui', 'xdotool', 'peekaboo'])],
  ['repl', new Set(['repl', 'jupyter', 'ipython', 'shell', 'terminal', 'bash', 'exec'])],
]
// Used only when the name says nothing: the server's tool names.
const TOOL_RULES = [
  ['browser', /^(?:(?:browser|playwright|puppeteer)_\w+|navigate_page|new_page|list_pages|select_page|close_page|take_snapshot)$/],
  ['desktop', /^(?:computer(?:_\w+)?|app_(?:click|type|key|scroll|drag)|mouse_\w+|left_click|right_click|double_click|open_application)$/],
  ['repl', /^(?:js|js_reset|repl|eval|execute_code|run_code|run_python|exec_command|shell|bash|run_command|run_shell_command)$/],
]

const nameTokens = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

// Markers of OpenAI's Codex / ChatGPT Computer Use ("Sky") service in a direct
// mcp_servers declaration (~/.codex/config.toml): its service path variable,
// the cua_node runtime, the SkyComputerUse client or service, the
// unified-computer-use plugin or the cua-repl package. Whatever such a server
// is called (node_repl, say), it can drive the Mac.
const COMPUTER_USE_SIGNAL = /SKY_CUA_SERVICE_PATH|CUA_REPL_|cua_node|SkyComputerUse|unified-computer-use|cua-repl|com\.openai\.sky\b|Codex Computer Use\.app/i

/**
 * Whether direct declarations (readNativeDirectMcpDeclarations entries) carry
 * a Computer Use marker in their command, arguments, env names or values, or
 * env_vars names. The raw text is only tested here; it is never returned.
 */
export function hasComputerUseSignal(declarations) {
  const texts = []
  for (const entry of Array.isArray(declarations) ? declarations : [declarations]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    texts.push(entry.command)
    if (Array.isArray(entry.args)) texts.push(...entry.args)
    if (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)) texts.push(...Object.entries(entry.env).flat())
    if (Array.isArray(entry.env_vars)) texts.push(...entry.env_vars.map(variable => variable && typeof variable === 'object' ? variable.name : variable))
  }
  return texts.some(text => typeof text === 'string' && COMPUTER_USE_SIGNAL.test(text))
}

/** Direct server names whose declarations carry a Computer Use marker. */
export function computerUseServerNames(declarations) {
  return new Set(declarations instanceof Map ? [...declarations].filter(([, entries]) => hasComputerUseSignal(entries)).map(([name]) => name) : [])
}

// computerUse: the server's direct declaration carries a Computer Use marker
// (hasComputerUseSignal); that makes it 'desktop' before any name rule.
export function classifyMcpServer({ name, toolNames = [], computerUse = false } = {}) {
  const tokens = nameTokens(name || '')
  let kind = computerUse === true ? 'desktop' : NAME_RULES.find(([, words]) => tokens.some(token => words.has(token)))?.[0]
  if (!kind) {
    const tools = Array.isArray(toolNames) ? toolNames.filter(tool => typeof tool === 'string') : []
    kind = TOOL_RULES.find(([, pattern]) => tools.some(tool => pattern.test(tool)))?.[0] || 'other'
  }
  return { controlsExternal: kind !== 'other', kind }
}

const serverToolNames = server => {
  const tools = server?.tools && typeof server.tools === 'object' && !Array.isArray(server.tools) ? server.tools : {}
  return Object.entries(tools).flatMap(([key, tool]) => [key, tool?.name])
}

/**
 * The kind of one native mcpServerStatus/list entry, with the same rules:
 * its name and, for a plugin's server, the plugin id are read together
 * ("cua_repl" + "unified-computer-use@…" → desktop), then its tool names.
 * Internal use only; plugin ids never reach a public row.
 */
export function nativeMcpServerKind(server, { computerUse = false } = {}) {
  const name = [server?.name, server?.pluginId].filter(part => typeof part === 'string').join(' ')
  return classifyMcpServer({ name, toolNames: serverToolNames(server), computerUse }).kind
}

const publicName = name => {
  if (typeof name !== 'string' || !name.trim() || name.includes('\0')) return null
  return publicText(name, MAX_NAME) || null
}

function listedStatus(server) {
  if (CONNECTION_STATUSES.has(server.runtimeStatus)) return server.runtimeStatus
  if (server.toolsError != null) return 'failed'
  if (server.authStatus === 'notLoggedIn') return 'authenticationRequired'
  // Configured and its tool catalog listed, not running for a thread yet.
  return 'available'
}

export function startupStatus(state, failureReason = null) {
  if (state === 'starting') return 'starting'
  if (state === 'ready') return 'connected'
  if (state === 'failed') return failureReason === 'reauthenticationRequired' ? 'authenticationRequired' : 'failed'
  if (state === 'cancelled') return 'cancelled'
  return null
}

// One mcpServerStatus/list entry → one public row, or null when unnamed.
// computerUse: its direct declaration carries a Computer Use marker.
export function publicInheritedMcpServer(server, { computerUse = false } = {}) {
  const name = publicName(server?.name)
  if (!name) return null
  const toolNames = serverToolNames(server)
  const status = listedStatus(server)
  return { name, enabled: status !== 'disabled', status, ...classifyMcpServer({ name: server.name, toolNames, computerUse }) }
}

/**
 * The inherited list for /v1/state: read once per app-server connection
 * (refresh) and updated by startup notifications (notify). null means
 * unknown: offline, not read yet, or the read failed.
 * - The direct declarations (config/read layers) are read after the list so a
 *   server with a Computer Use marker shows as 'desktop' whatever its name.
 *   If they cannot be read, rows keep the name and tool rules. Only the
 *   marked names are kept, never the declarations.
 * - ignoreThread(threadId): startup notices from threads that do not inherit
 *   (bounded QA) change nothing.
 * - onChange(rows) runs after the public value changed.
 * - kindOf(name): the known row's kind, or null (for Chat activity rows).
 */
export function createInheritedMcpSync({ request, ready = () => true, ignoreThread = () => false, onChange = () => {}, list = listNativeMcpServers, declarations = readNativeDirectMcpDeclarations } = {}) {
  let rows = null, generation = 0, inFlight = null, computerUse = new Set()
  const snapshot = () => rows ? rows.map(row => ({ ...row })) : null
  const set = next => {
    const changed = JSON.stringify(next) !== JSON.stringify(rows)
    rows = next
    if (changed) onChange(snapshot())
  }
  function refresh() {
    if (!ready()) { set(null); return Promise.resolve(null) }
    if (inFlight) return inFlight
    const mine = ++generation
    const read = (async () => {
      try {
        const servers = await list(request, null, { detail: 'toolsAndAuthOnly' })
        if (mine !== generation) return snapshot()
        let marked = new Set()
        try { marked = computerUseServerNames(await declarations(request, null)) } catch {}
        if (mine !== generation) return snapshot()
        computerUse = marked
        const seen = new Set()
        set(servers.map(server => publicInheritedMcpServer(server, { computerUse: marked.has(server?.name) }))
          .filter(row => row && !seen.has(row.name) && seen.add(row.name)).slice(0, MAX_SERVERS))
      } catch { if (mine === generation) set(null) }
      return snapshot()
    })().finally(() => { if (inFlight === read) inFlight = null })
    inFlight = read
    return read
  }
  function notify(message) {
    if (message?.method !== INHERITED_MCP_NOTIFICATION) return false
    const params = message.params
    const name = publicName(params?.name)
    const status = startupStatus(params?.status, params?.failureReason ?? null)
    // An unknown inventory stays unknown; one notice is not the whole list.
    if (!name || !status || !Array.isArray(rows) || ignoreThread(typeof params.threadId === 'string' ? params.threadId : null)) return true
    const index = rows.findIndex(row => row.name === name)
    if (index >= 0) set(rows.map((row, at) => at === index ? { ...row, enabled: true, status } : row))
    else if (rows.length < MAX_SERVERS) set([...rows, { name, enabled: true, status, ...classifyMcpServer({ name: params.name, computerUse: computerUse.has(params.name) }) }])
    return true
  }
  function reset() {
    generation += 1
    inFlight = null
    computerUse = new Set()
    set(null)
  }
  function kindOf(name) {
    return Array.isArray(rows) && typeof name === 'string' ? rows.find(row => row.name === name)?.kind ?? null : null
  }
  return { refresh, notify, reset, snapshot, kindOf }
}
