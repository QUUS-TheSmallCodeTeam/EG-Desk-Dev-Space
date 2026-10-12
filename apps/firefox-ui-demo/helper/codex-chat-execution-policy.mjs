import { chatError } from './codex-chat-values.mjs'

export const READ_ONLY_QA = 'readOnlyQa'
export const BROWSER_BOUNDED = 'browserBounded'
export const FIXTURE_BROWSER_QA = 'fixtureBrowserQa'

export function requestedExecutionPolicy(value) {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || ![READ_ONLY_QA, BROWSER_BOUNDED, FIXTURE_BROWSER_QA].includes(value.mode)) {
    throw chatError('INVALID_EXECUTION_POLICY', 'Use an explicitly supported bounded execution mode', 400)
  }
  return value.mode
}

export async function listNativeMcpServers(request, threadId = null) {
  const servers = [], seen = new Set()
  let cursor = null
  for (let page = 0; page < 8; page++) {
    let result
    try {
      result = await request('mcpServerStatus/list', {
        limit: 100, ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}),
      })
    } catch {
      throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP inventory is unavailable', 502)
    }
    if (!Array.isArray(result?.data)) throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP inventory is unavailable', 502)
    for (const server of result.data) {
      if (typeof server?.name !== 'string' || !server.name || !server.tools || typeof server.tools !== 'object' || Array.isArray(server.tools) ||
          !Array.isArray(server.resources) || !Array.isArray(server.resourceTemplates) ||
          (server.pluginId != null && typeof server.pluginId !== 'string')) {
        throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP inventory has an unknown shape', 502)
      }
      servers.push(server)
    }
    if (result.nextCursor == null) return servers
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) {
      throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP inventory cursor did not advance', 502)
    }
    seen.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP inventory exceeds the bounded check', 502)
}

// The status catalog includes plugin/app-provided servers that do not have a
// direct mcp_servers declaration. Adding an enabled=false stub for one of
// those names creates a transport-less config entry on Codex 0.160.1. The
// flattened config/read Config intentionally omits mcp_servers; only its
// config layers show direct declarations. Inspect their shape, never copy
// commands, URLs or env.
export async function readNativeDirectMcpServerIds(request, cwd = null) {
  let result
  try { result = await request('config/read', { includeLayers: true, cwd }) }
  catch { throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP configuration cannot be classified', 502) }
  if (!Array.isArray(result?.layers)) throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP configuration layers are unavailable', 502)
  const direct = new Set()
  for (const layer of result.layers) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer) ||
        !layer.name || typeof layer.name.type !== 'string') {
      throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP configuration layer has an unknown shape', 502)
    }
    if (layer.disabledReason != null) continue
    if (!layer.config || typeof layer.config !== 'object' || Array.isArray(layer.config)) {
      throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP configuration layer has an unknown shape', 502)
    }
    const entries = layer.config.mcp_servers
    if (entries == null) continue
    if (typeof entries !== 'object' || Array.isArray(entries)) {
      throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP declarations have an unknown shape', 502)
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP declaration has an unknown shape', 502)
      }
      const command = typeof entry.command === 'string' && entry.command.length > 0
      const url = typeof entry.url === 'string' && entry.url.length > 0
      if (command && url) throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP declaration has ambiguous transport', 502)
      if (command || url) direct.add(name)
    }
  }
  return direct
}

export function disabledNativeMcpConfig(servers, directIds) {
  if (!Array.isArray(servers) || !(directIds instanceof Set)) {
    throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP origins were not verified', 502)
  }
  const mcp_servers = Object.create(null), plugins = Object.create(null)
  for (const server of servers) {
    if (typeof server?.name !== 'string' || !server.name ||
        (server.pluginId != null && typeof server.pluginId !== 'string')) {
      throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native MCP origin has an unknown shape', 502)
    }
    if (server.pluginId) plugins[server.pluginId] = { enabled: false }
    else if (directIds.has(server.name)) mcp_servers[server.name] = { enabled: false }
  }
  return { mcp_servers, plugins }
}

export function qaThreadOverrides(servers, directIds) {
  const { mcp_servers, plugins } = disabledNativeMcpConfig(servers, directIds)
  return {
    sandbox: 'read-only', approvalPolicy: 'never',
    config: {
      web_search: 'disabled',
      features: { apps: false, hooks: false, multi_agent: false, plugins: false, remote_plugin: false, code_mode: { enabled: false } },
      mcp_servers, plugins,
    },
  }
}

export async function loadQaThreadOverrides(request, { threadId = null, cwd = null } = {}) {
  const directIds = await readNativeDirectMcpServerIds(request, cwd)
  const servers = await listNativeMcpServers(request, threadId)
  return qaThreadOverrides(servers, directIds)
}

export function verifyQaNativeThread(result, mode = READ_ONLY_QA) {
  if (result?.sandbox?.type !== 'readOnly' || result.sandbox.networkAccess !== false || result.approvalPolicy !== 'never') {
    throw chatError('QA_POLICY_UNVERIFIED', 'Native thread did not confirm read-only, offline, never-approval policy; no turn was started', 502)
  }
  return {
    mode, status: 'native-thread-verified',
    sandbox: 'readOnly', networkAccess: false, approvalPolicy: 'never',
    externalMcpCatalog: 'pending',
    ...(mode === BROWSER_BOUNDED ? { browserEffects: 'observe-only-selected-card' } : {}),
    ...(mode === FIXTURE_BROWSER_QA ? { browserEffects: 'attested-local-fixture-only' } : {}),
  }
}

export async function verifyQaMcpIsolation(request, threadId, receipt) {
  const servers = await listNativeMcpServers(request, threadId)
  if (servers.some(server => Object.keys(server.tools).length || server.resources.length || server.resourceTemplates.length || server.toolsError != null)) {
    throw chatError('QA_TOOL_ISOLATION_UNVERIFIED', 'Native thread still exposes external MCP capabilities; no turn was started', 502)
  }
  return { ...receipt, externalMcpCatalog: 'empty', inspectedMcpServers: servers.length }
}

export const QA_TURN_OVERRIDES = Object.freeze({
  approvalPolicy: 'never',
  sandboxPolicy: Object.freeze({ type: 'readOnly', networkAccess: false }),
})
