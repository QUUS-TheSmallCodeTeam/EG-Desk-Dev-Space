import { chatError } from './codex-chat-values.mjs'

export const READ_ONLY_QA = 'readOnlyQa'
export const BROWSER_BOUNDED = 'browserBounded'

export function requestedExecutionPolicy(value) {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || ![READ_ONLY_QA, BROWSER_BOUNDED].includes(value.mode)) {
    throw chatError('INVALID_EXECUTION_POLICY', 'Use executionPolicy mode readOnlyQa or browserBounded', 400)
  }
  return value.mode
}

export async function listNativeMcpServers(request, threadId = null) {
  const servers = [], seen = new Set()
  let cursor = null
  for (let page = 0; page < 8; page++) {
    const result = await request('mcpServerStatus/list', {
      limit: 100, ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}),
    })
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

export function qaThreadOverrides(servers) {
  const mcp_servers = Object.create(null), plugins = Object.create(null)
  for (const server of servers) {
    mcp_servers[server.name] = { enabled: false }
    if (server.pluginId) plugins[server.pluginId] = { enabled: false }
  }
  return {
    sandbox: 'read-only', approvalPolicy: 'never',
    config: {
      web_search: 'disabled',
      features: { apps: false, hooks: false, multi_agent: false, remote_plugin: false, code_mode: { enabled: false } },
      mcp_servers, plugins,
    },
  }
}

export function verifyQaNativeThread(result, mode = READ_ONLY_QA) {
  if (result?.sandbox?.type !== 'readOnly' || result.sandbox.networkAccess !== false || result.approvalPolicy !== 'never') {
    throw chatError('QA_POLICY_UNVERIFIED', 'Native thread did not confirm read-only, offline, never-approval policy; no turn was started', 502)
  }
  return {
    mode, status: 'native-thread-verified',
    sandbox: 'readOnly', networkAccess: false, approvalPolicy: 'never',
    externalMcpCatalog: 'pending',
    ...(mode === BROWSER_BOUNDED ? { browserEffects: 'per-run-selected-card' } : {}),
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
