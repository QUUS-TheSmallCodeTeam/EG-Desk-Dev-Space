// SUB-10 S1 Browser contract for Claude: a browserBounded conversation gets
// the same EG-Desk Browser tools and the same per-call checks as Codex
// (runtime.handleServerRequest: run binding, execution policy, selected Browser
// card grant, observe/click/fill limits), because the tools reach the runtime
// through the same item/tool/call path (egdesk-claude-mcp).
//
// What replaces Codex's native policy proof (verifyQaNativeThread +
// verifyQaMcpIsolation), following engine design §5 "Codex 한정 정책 ... 엔진 측
// 검증" row:
//   argv   --tools "" (no built-in tool, so no shell, file or web tool exists),
//          --permission-mode dontAsk (anything not pre-allowed is denied without
//          a prompt), --allowedTools mcp__egdesk, --strict-mcp-config with only the
//          EG-Desk 'sdk' server, --restricted and --no-chrome (CLI >= 2.1.248).
//   native every process start: system/init must list only mcp__egdesk__* tools,
//          only the egdesk MCP server, permissionMode dontAsk and no skills,
//          plugins or agents; otherwise the process is closed before any output
//          is accepted (claude-engine-adapter).
// Only browserBounded is offered: readOnlyQa needs Codex command receipts and
// fixtureBrowserQa is a Codex fixture lane.
//
// Pure: no I/O.

import { chatError } from './codex-chat-values.mjs'

export const CLAUDE_BOUNDED_POLICIES = Object.freeze(['browserBounded'])
/** `--restricted` first appears in this CLI version (official CLI reference, 2026-10-25). */
export const CLAUDE_BOUNDED_MIN_VERSION = '2.1.248'

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null

/** startThread/resumeThread overrides the runtime gives a bounded Claude thread. */
export function claudeBoundedThreadOverrides(policy) {
  if (!CLAUDE_BOUNDED_POLICIES.includes(policy)) throw chatError('QA_POLICY_UNAVAILABLE', 'Claude supports only the bounded Browser policy', 503)
  return { egdeskBoundedPolicy: policy }
}

/** The transport options a bounded Claude process is spawned with. */
export function claudeBoundedLaunch() {
  return { tools: [], permissionMode: 'dontAsk', bounded: true }
}

/** system/init of a bounded process → null when it matches, else a reason code. */
export function claudeBoundedInitViolation(message, { serverName = 'egdesk' } = {}) {
  const prefix = `mcp__${serverName}__`
  const empty = value => value === undefined || (Array.isArray(value) && value.length === 0)
  if (!Array.isArray(message?.tools) || message.tools.some(tool => typeof tool !== 'string' || !tool.startsWith(prefix))) return 'builtin-tools'
  if (!Array.isArray(message.mcp_servers) || message.mcp_servers.some(server => server?.name !== serverName)) return 'external-mcp'
  if (message.permissionMode !== 'dontAsk') return 'permission-mode'
  if (!empty(message.skills) || !empty(message.plugins) || !empty(message.agents)) return 'extensions'
  return null
}

/**
 * The receipt the runtime stores like Codex's qaReceipt. The adapter's
 * startThread/resumeThread result must carry the argv descriptor it applied.
 */
export function verifyClaudeBoundedThread(result, policy) {
  const applied = plainObject(result?.egdeskBounded)
  if (!CLAUDE_BOUNDED_POLICIES.includes(policy) || applied?.mode !== policy || applied.builtinTools !== 'none' ||
      applied.permissionMode !== 'dontAsk' || applied.mcp !== 'egdesk-only' || applied.restricted !== true) {
    throw chatError('QA_POLICY_UNVERIFIED', 'Claude did not confirm the bounded Browser launch (no built-in tools, EG-Desk tools only); no turn was started', 502)
  }
  return {
    mode: policy, status: 'claude-argv-verified', engineId: 'claude',
    builtinTools: 'none', permissionMode: 'dontAsk', externalMcpCatalog: 'egdesk-only',
    nativeInitCheck: 'every-process-start', approvalPolicy: 'never',
    browserEffects: 'observe-only-selected-card',
  }
}
