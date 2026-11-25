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

/**
 * startThread/resumeThread overrides the runtime gives a bounded Claude thread. relaxed (u6, U19): the Claude browser capability is live (EGDESK_CLAUDE_HARNESS=on and
 * EGDESK_PAGE_TOOLS=on); the init check then judges a real CLI's init by what can RUN (below). Without it the check is exactly the strict one it always was.
 */
export function claudeBoundedThreadOverrides(policy, { relaxed = false } = {}) {
  if (!CLAUDE_BOUNDED_POLICIES.includes(policy)) throw chatError('QA_POLICY_UNAVAILABLE', 'Claude supports only the bounded Browser policy', 503)
  return { egdeskBoundedPolicy: policy, ...(relaxed === true ? { egdeskBoundedRelaxed: true } : {}) }
}

/** The transport options a bounded Claude process is spawned with. */
export function claudeBoundedLaunch() {
  return { tools: [], permissionMode: 'dontAsk', bounded: true }
}

/**
 * What a real Claude Code CLI lists in system/init next to the one EG-Desk MCP server although the launch is as narrow as the CLI allows (official docs, code.claude.com/docs, read 2026-11):
 *   - tools: `EndConversation` is in the list whenever an MCP tool exists and no `--tools` list or deny rule can remove it ("the exemption is deliberate: the tool does nothing except end the conversation",
 *     tools-reference, EndConversation tool behavior); `ToolSearch` loads *deferred tools* and with --strict-mcp-config the only deferred tools are EG-Desk's own (tools-reference, ToolSearch).
 *   - skills, plugins, agents: SDKSystemMessage (agent-sdk/typescript) lists `skills`, `plugins` and `agents` as plain name lists the CLI knows about (built-in agents and bundled skills included);
 *     the list is information, not a means to run them: a skill runs through the `Skill` tool, a subagent through `Agent`, and a plugin's tools, MCP servers and hooks would show up as tools,
 *     mcp_servers (both checked) or hook events (the adapter counts them); with --tools "" none of Skill or Agent exists.
 * So with the capability live the check keeps what proves "nothing can run" (every tool is EG-Desk's, only the EG-Desk server, dontAsk) and lets those two named tools and the lists be.
 */
export const CLAUDE_BOUNDED_RELAXED_TOOLS = Object.freeze(['EndConversation', 'ToolSearch'])

/**
 * system/init of a bounded process → null when it matches, else { kind, count } (closed words, no names): kind is builtin-tools | external-mcp | permission-mode | extensions,
 * count the number of entries that broke it (tools or servers not allowed; skills + plugins + agents listed; 1 for the mode).
 */
export function claudeBoundedInitDiagnosis(message, { serverName = 'egdesk', relaxed = false } = {}) {
  const prefix = `mcp__${serverName}__`
  const empty = value => value === undefined || (Array.isArray(value) && value.length === 0)
  const allowedTool = tool => typeof tool === 'string' && (tool.startsWith(prefix) || (relaxed === true && CLAUDE_BOUNDED_RELAXED_TOOLS.includes(tool)))
  if (!Array.isArray(message?.tools)) return { kind: 'builtin-tools', count: 0 }
  const badTools = message.tools.filter(tool => !allowedTool(tool)).length
  if (badTools) return { kind: 'builtin-tools', count: badTools }
  if (!Array.isArray(message.mcp_servers)) return { kind: 'external-mcp', count: 0 }
  const badServers = message.mcp_servers.filter(server => server?.name !== serverName).length
  if (badServers) return { kind: 'external-mcp', count: badServers }
  if (message.permissionMode !== 'dontAsk') return { kind: 'permission-mode', count: 1 }
  const listed = [message.skills, message.plugins, message.agents].reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0)
  if (relaxed !== true && (!empty(message.skills) || !empty(message.plugins) || !empty(message.agents))) return { kind: 'extensions', count: listed }
  return null
}

/** system/init of a bounded process → null when it matches, else a reason code. */
export function claudeBoundedInitViolation(message, options = {}) {
  return claudeBoundedInitDiagnosis(message, options)?.kind ?? null
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
