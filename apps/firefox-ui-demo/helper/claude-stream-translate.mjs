import { publicEpochMs } from './codex-account-usage.mjs'
import { MAX_TEXT, publicText } from './codex-chat-values.mjs'
import { classifyClaudeError } from './engine-adapter.mjs'

// Claude output → the internal reference events (design
// docs/references/engine-adapter-design.md §5, step 8a). One Claude output
// line (`claude -p --output-format stream-json`) or one Agent SDK SDKMessage
// object (same shapes) becomes zero or more Codex app-server shaped
// notifications `{ method, params }` that the chat runtime already accepts in
// handleNotification. The runtime keeps cleanNotification/safeItem, so this
// module only narrows further; it never widens what reaches public state.
//
// Pure: no I/O, no clock, no process. State is per translator (one Claude
// session = one EG-Desk thread). Unknown or malformed input is counted in
// stats(), never turned into an invented event.
//
// Never emitted: thinking/redacted_thinking text or signatures (not even a
// summary), tool_result bodies, shell output, diffs, file contents, Agent
// prompts, subagent messages, result text, plugin paths, cost.

export const CLAUDE_TRANSLATE_LIMITS = Object.freeze({
  maxLineChars: 8 * 1024 * 1024, // one stream-json line; longer lines are dropped
  maxAgentText: 8 * 1024 * 1024, // same as the runtime's MAX_PUBLIC_EVENT_TEXT
  maxDelta: MAX_TEXT,
  maxCommand: 2000,
  maxPath: 4096,
  maxChanges: 30,
  maxPlanSteps: 40,
  maxToolNames: 200,
  maxMcpServers: 50,
  maxCapabilities: 50,
  maxBlocks: 256,
  maxPendingTools: 512,
  maxSubagents: 64,
  maxCounterKeys: 64, // named keys per stats counter; more share 'other'
})

// Literal type/subtype values seen in the official docs (headless,
// agent-sdk/typescript, agent-sdk/streaming-output). Anything else is still
// ignored, but counted as unrecognized so protocol drift is visible.
const DOCUMENTED = new Set([
  'assistant', 'user', 'result', 'stream_event', 'rate_limit_event', 'tool_progress',
  'system/init', 'system/api_retry', 'system/compact_boundary', 'system/permission_denied', 'system/informational',
  'system/task_started', 'system/task_progress', 'system/task_notification', 'system/thinking_tokens',
  'system/plugin_install', 'system/worker_shutting_down',
  'stream_event/message_start', 'stream_event/content_block_start', 'stream_event/content_block_delta',
  'stream_event/content_block_stop', 'stream_event/message_delta', 'stream_event/message_stop', 'stream_event/ping',
  'stream_event/text_delta', 'stream_event/input_json_delta', 'stream_event/thinking_delta',
  // The stdio control channel (claude-engine-permissions.mjs, egdesk-claude-mcp.mjs)
  // shares stdout; a transport routes these lines there before translating.
  'control_request', 'control_response', 'control_cancel_request',
])

// Built-in file tools → the input field holding the path. MultiEdit is an
// older tool name kept for older CLIs; the current SDK tool list omits it.
const FILE_TOOLS = new Map([['Edit', 'file_path'], ['Write', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']])
// 'Task' is the pre-2.1.63 name of the Agent tool (agent-sdk/subagents).
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const THINKING_BLOCKS = new Set(['thinking', 'redacted_thinking'])
const PLAN_STATUS = { pending: 'pending', in_progress: 'inProgress', completed: 'completed' }
const TASK_AGENT_STATE = { completed: 'completed', failed: 'errored', stopped: 'interrupted' }
// Representative Codex error causes so today's runtime (publicErrorKind reads
// codexErrorInfo first) derives the same kind as classifyClaudeError. The
// value never leaves publicError; only kind does.
const KIND_INFO = { auth: 'unauthorized', quota: 'usageLimitExceeded', permission: 'sandboxError', network: 'serverOverloaded', model: 'badRequest' }
const HTTP_KINDS = new Map([[401, 'auth'], [403, 'permission'], [429, 'quota']])
// result.terminal_reason values (official enum); the kind per value is a judgement.
const TERMINAL_REASON_KINDS = new Map([
  ['prompt_too_long', 'model'], ['max_turns', 'model'], ['model_error', 'model'], ['image_error', 'model'],
  ['malformed_tool_use_exhausted', 'model'], ['structured_output_retry_exhausted', 'model'], ['budget_exhausted', 'quota'],
])
const ABORT_REASONS = new Set(['aborted_streaming', 'aborted_tools'])
// rate_limit_info.rateLimitType → which subscription limit (SUB-14). The first
// five are the official SDK RateLimitType (claude-agent-sdk-python types.py);
// seven_day_overage_included is a newer CLI bucket (pattern: pingdotgg/t3code
// apps/server/src/provider/claudeUsageLimits.ts, MIT). windowMinutes matches
// the Codex usage rows, so the same '5시간 한도'/'주간 한도' labels apply.
const RATE_LIMIT_WINDOWS = new Map([
  ['five_hour', { window: 'fiveHour', windowMinutes: 5 * 60 }],
  ['seven_day', { window: 'weekly', windowMinutes: 7 * 24 * 60 }],
  ['seven_day_opus', { window: 'weeklyOpus', windowMinutes: 7 * 24 * 60 }],
  ['seven_day_sonnet', { window: 'weeklySonnet', windowMinutes: 7 * 24 * 60 }],
  ['seven_day_overage_included', { window: 'weeklyIncluded', windowMinutes: 7 * 24 * 60 }],
  ['overage', { window: 'overage', windowMinutes: null }],
])
const RATE_LIMIT_STATUSES = new Set(['allowed', 'allowed_warning', 'rejected'])
/** Public window names in display order. */
export const CLAUDE_RATE_LIMIT_WINDOWS = Object.freeze([...RATE_LIMIT_WINDOWS.values()].map(entry => entry.window))
const WINDOW_MINUTES = new Map([...RATE_LIMIT_WINDOWS.values()].map(entry => [entry.window, entry.windowMinutes]))

/** rateLimitType → { window, windowMinutes }; unknown or missing → nulls. */
export function claudeRateLimitWindow(rateLimitType) {
  const hit = typeof rateLimitType === 'string' ? RATE_LIMIT_WINDOWS.get(rateLimitType) : undefined
  return hit ? { ...hit } : { window: null, windowMinutes: null }
}

/**
 * Keep one row per limit window from successive egdesk/engine/rateLimit params
 * so a screen can show "5시간 한도 42% · 주간 한도 10%" together.
 *   prev: the previous return value or null; now: epoch ms (optional; without
 *   it rows whose reset time passed are not pruned).
 * Returns { windows: [{window, windowMinutes, usedPercent, resetsAt, status}],
 *           rejected: {window, resetsAt} | null, creditsRequired, observedAt }.
 * Pure; unknown params return prev unchanged.
 */
export function applyClaudeRateLimit(prev, params, now = null) {
  const p = plainObject(params)
  const at = Number.isFinite(now) && now > 0 ? Math.round(now) : null
  const base = plainObject(prev) && Array.isArray(prev.windows) ? prev : null
  if (!p || !RATE_LIMIT_STATUSES.has(p.status)) return base
  const window = WINDOW_MINUTES.has(p.window) ? p.window : null
  const resetsAt = Number.isFinite(p.resetsAt) && p.resetsAt > 0 ? p.resetsAt : null
  const usedPercent = Number.isFinite(p.usedPercent) ? Math.min(100, Math.max(0, p.usedPercent)) : null
  const elapsed = row => at !== null && row.resetsAt !== null && row.resetsAt <= at
  let windows = (base?.windows || []).filter(row => row.window !== window && !elapsed(row))
  if (window) {
    const old = base?.windows.find(row => row.window === window)
    windows.push({ window, windowMinutes: WINDOW_MINUTES.get(window), usedPercent: usedPercent ?? old?.usedPercent ?? null, resetsAt: resetsAt ?? (old && !elapsed(old) ? old.resetsAt : null), status: p.status })
    windows = CLAUDE_RATE_LIMIT_WINDOWS.flatMap(name => windows.filter(row => row.window === name))
  }
  const kept = base?.rejected && !elapsed(base.rejected) && base.rejected.window !== window ? base.rejected : null
  return {
    windows,
    rejected: p.status === 'rejected' ? { window, resetsAt } : kept,
    creditsRequired: p.creditsRequired === true,
    observedAt: at ?? base?.observedAt ?? null,
  }
}

const idText = value => typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : null
const toolName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value) ? value : null
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:[\]-]{0,119}$/.test(value) ? value : null
const versionText = value => typeof value === 'string' && /^\d{1,4}\.\d{1,5}\.\d{1,6}[A-Za-z0-9.+-]{0,32}$/.test(value) ? value : null
const count = value => Number.isInteger(value) && value >= 0 ? value : null
const blockIndex = value => Number.isInteger(value) && value >= 0 && value < 100000 ? value : null
const counterKey = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}(?:\/[a-z][a-z0-9_]{0,47})?$/.test(value) ? value : 'malformed'
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null

/** { server, tool } for `mcp__<server>__<tool>`, split at the first `__` after the prefix; else null. */
export function splitMcpToolName(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__') || name.length > 256) return null
  const rest = name.slice(5)
  const at = rest.indexOf('__')
  if (at <= 0 || at + 2 >= rest.length) return null
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) }
}

// Anthropic usage → Codex TokenUsageBreakdown. Anthropic input_tokens excludes
// cache reads/writes, Codex inputTokens includes cached input, so they are added.
function usageBreakdown(usage) {
  const u = plainObject(usage)
  if (!u) return null
  const input = count(u.input_tokens), output = count(u.output_tokens)
  if (input === null && output === null) return null
  const cacheRead = count(u.cache_read_input_tokens) ?? 0, cacheWrite = count(u.cache_creation_input_tokens) ?? 0
  const inputTokens = (input ?? 0) + cacheRead + cacheWrite
  return { inputTokens, cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite, outputTokens: output ?? 0, totalTokens: inputTokens + (output ?? 0) }
}

/**
 * createClaudeTranslator({ threadId, turnId?, egdeskMcpServer?, limits? })
 *   translate(lineOrMessage) → Array<{ method, params }>   never throws
 *   beginTurn(turnId)        → [turn/started]; later events carry this turnId
 *   markInterruptRequested() → the next result becomes turn/completed 'interrupted'
 *   session()                → public system/init fields (for ThreadStarted) or null
 *   stats()                  → counters for ignored, withheld and dropped input
 */
export function createClaudeTranslator({ threadId, turnId = null, egdeskMcpServer = 'egdesk', limits = {} } = {}) {
  if (!idText(threadId)) throw new TypeError('createClaudeTranslator requires a threadId string (1-300 chars)')
  if (turnId !== null && !idText(turnId)) throw new TypeError('turnId must be null or a string (1-300 chars)')
  const L = { ...CLAUDE_TRANSLATE_LIMITS, ...limits }
  const egdeskServer = token(egdeskMcpServer)

  let currentTurn = turnId
  let session = null
  // Per turn: the open streamed message, fallback text ids, the error that a
  // failed result should report, abort hints and the latest context usage.
  let stream = null
  let ordinals = new Map()
  let turnFailure = null
  let turnAborted = false
  let interruptRequested = false
  let lastUsage = null
  // Across turns (background tools and Agents finish later): bounded.
  const tools = new Map() // tool_use_id → { kind, turnId, item, done, declined }
  const agents = new Map() // Agent tool_use_id → { turnId, label, model, effort, preview, started, state }
  const agentIds = new Map() // agent_id / task_id → Agent tool_use_id

  const stats = {
    lines: 0, events: 0, blank: 0, invalidJson: 0, oversized: 0, notMessage: 0, translateErrors: 0,
    ignored: {}, unrecognized: {},
    withheld: { thinkingBlocks: 0, thinkingDeltas: 0, toolResultBodies: 0, subagentMessages: 0, errorNotices: 0 },
    dropped: { orphanToolResults: 0, duplicateToolResults: 0, deltasWithoutMessage: 0, unmatchedSubagentMessages: 0, evicted: 0, truncatedText: 0, repeatedInit: 0 },
  }

  const bump = (counter, key) => {
    const k = counterKey(key)
    const slot = Object.hasOwn(counter, k) || Object.keys(counter).length < L.maxCounterKeys ? k : 'other'
    counter[slot] = (counter[slot] || 0) + 1
  }
  // documented: the key is a documented value (or a content block of a documented message).
  const skip = (key, documented = DOCUMENTED.has(key)) => { bump(documented ? stats.ignored : stats.unrecognized, key); return [] }
  const remember = (map, key, value, limit) => {
    if (!map.has(key) && map.size >= limit) { map.delete(map.keys().next().value); stats.dropped.evicted++ }
    map.set(key, value)
  }
  const n = (method, params, turn = currentTurn) => ({ method, params: { threadId, turnId: turn, ...params } })
  const isSubagent = msg => msg.parent_tool_use_id != null || idText(msg.agent_id) !== null
  const resetTurn = () => { stream = null; ordinals = new Map(); turnFailure = null; turnAborted = false; interruptRequested = false; lastUsage = null }

  function claudeError(classified, message) {
    const info = KIND_INFO[classified.kind]
    return {
      message, code: classified.code, kind: classified.kind, origin: 'claude',
      ...(info ? { codexErrorInfo: info } : {}),
      ...(classified.retryAt ? { retryAt: classified.retryAt } : {}),
    }
  }

  // ── system/init → thread/started (Codex Thread fields + an engine summary)
  function onInit(msg) {
    const sessionId = idText(msg.session_id)
    const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : []
    const next = {
      sessionId, sessionIdMatches: sessionId === threadId,
      model: modelId(msg.model),
      cwd: typeof msg.cwd === 'string' ? publicText(msg.cwd, L.maxPath) || null : null,
      engineVersion: versionText(msg.claude_code_version),
      permissionMode: token(msg.permissionMode), effort: token(msg.effort), apiKeySource: token(msg.apiKeySource),
      tools: (Array.isArray(msg.tools) ? msg.tools : []).slice(0, L.maxToolNames).map(toolName).filter(Boolean),
      toolsTruncated: Array.isArray(msg.tools) && msg.tools.length > L.maxToolNames,
      // name + status only: `source` can be a settings path.
      mcpServers: servers.slice(0, L.maxMcpServers).map(server => ({ name: toolName(server?.name), status: token(server?.status) })).filter(server => server.name),
      capabilities: (Array.isArray(msg.capabilities) ? msg.capabilities : []).slice(0, L.maxCapabilities).map(token).filter(Boolean),
    }
    const first = session === null
    session = next
    if (!first) { stats.dropped.repeatedInit++; return [] }
    return [n('thread/started', {
      thread: { id: threadId, model: next.model, cwd: next.cwd, cliVersion: next.engineVersion },
      engine: { id: 'claude', ...next },
    })]
  }

  // ── stream_event → agentMessage started/delta (text only)
  function onStreamEvent(msg) {
    if (msg.parent_tool_use_id != null) { stats.withheld.subagentMessages++; return [] }
    const event = plainObject(msg.event)
    if (!event || typeof event.type !== 'string') return skip('stream_event/malformed')
    switch (event.type) {
      case 'message_start': {
        const messageId = idText(event.message?.id)
        stream = messageId ? { messageId, blocks: new Map() } : null
        return []
      }
      case 'content_block_start': {
        const index = blockIndex(event.index)
        const type = event.content_block?.type
        if (!stream || index === null) { stats.dropped.deltasWithoutMessage++; return [] }
        if (THINKING_BLOCKS.has(type)) { stream.blocks.set(index, { type: 'thinking', open: true }); stats.withheld.thinkingBlocks++; return [] }
        if (type !== 'text') { if (stream.blocks.size < L.maxBlocks) stream.blocks.set(index, { type: String(type).slice(0, 40), open: true }); return [] }
        const out = openText(index)
        const initial = typeof event.content_block.text === 'string' ? event.content_block.text : ''
        if (initial) out.push(...textDelta(stream.blocks.get(index), initial))
        return out
      }
      case 'content_block_delta': {
        const delta = plainObject(event.delta)
        const index = blockIndex(event.index)
        if (delta?.type === 'thinking_delta' || delta?.type === 'signature_delta') { stats.withheld.thinkingDeltas++; return [] }
        if (delta?.type !== 'text_delta') return skip(`stream_event/${delta?.type}`)
        if (!stream || index === null) { stats.dropped.deltasWithoutMessage++; return [] }
        const block = stream.blocks.get(index)
        if (block && block.type !== 'text') return []
        const out = block ? [] : openText(index)
        return out.concat(textDelta(stream.blocks.get(index), typeof delta.text === 'string' ? delta.text : ''))
      }
      case 'content_block_stop': {
        const block = stream?.blocks.get(blockIndex(event.index))
        if (block) block.open = false
        return []
      }
      default: return skip(`stream_event/${event.type}`)
    }
  }

  function openText(index) {
    if (stream.blocks.size >= L.maxBlocks) { stats.dropped.deltasWithoutMessage++; return [] }
    const itemId = `${stream.messageId}:${index}`
    stream.blocks.set(index, { type: 'text', itemId, open: true, completed: false })
    return [n('item/started', { item: { id: itemId, type: 'agentMessage', text: '', phase: null } })]
  }

  function textDelta(block, text) {
    if (!block || !text) return []
    if (text.length > L.maxDelta) stats.dropped.truncatedText++
    return [n('item/agentMessage/delta', { itemId: block.itemId, delta: text.slice(0, L.maxDelta) })]
  }

  // The complete AssistantMessage of a streamed text block arrives before that
  // block's content_block_stop (agent-sdk/streaming-output "Message flow").
  // Without partial messages, ids fall back to a per-message ordinal.
  function textItemId(messageId) {
    if (stream && messageId && stream.messageId === messageId) {
      const candidates = [...stream.blocks.entries()].filter(([, block]) => block.type === 'text' && !block.completed)
      const pick = candidates.find(([, block]) => block.open) || candidates.sort(([a], [b]) => a - b)[0]
      if (pick) { pick[1].completed = true; return pick[1].itemId }
    }
    if (!messageId) return null
    const next = ordinals.get(messageId) || 0
    if (!ordinals.has(messageId) && ordinals.size >= L.maxBlocks) ordinals.delete(ordinals.keys().next().value)
    ordinals.set(messageId, next + 1)
    return `${messageId}:m${next}`
  }

  // ── assistant → agentMessage completed, tool items, plan
  function onAssistant(msg) {
    if (isSubagent(msg)) return onSubagentMessage(msg)
    const message = plainObject(msg.message)
    const messageId = idText(message?.id)
    const failure = classifyClaudeError(msg)
    if (failure) turnFailure = failure
    if (msg.aborted === true) turnAborted = true
    const contextUsage = plainObject(msg.context_usage)
    if (contextUsage && count(contextUsage.total_tokens) !== null) {
      lastUsage = { totalTokens: contextUsage.total_tokens, contextWindow: count(contextUsage.raw_max_tokens) }
    } else {
      const breakdown = usageBreakdown(message?.usage)
      if (breakdown) lastUsage = { totalTokens: breakdown.totalTokens, contextWindow: lastUsage?.contextWindow ?? null }
    }
    const content = Array.isArray(message?.content) ? message.content : []
    const out = []
    for (const block of content.slice(0, L.maxBlocks)) {
      const type = block?.type
      if (type === 'text') {
        // An assistant message with `error` carries Claude's own error notice,
        // not an answer; the classified error reaches the turn instead.
        if (failure) { stats.withheld.errorNotices++; continue }
        let text = typeof block.text === 'string' ? block.text : ''
        const itemId = textItemId(messageId)
        if (!itemId) { skip('assistant/malformed'); continue }
        if (text.length > L.maxAgentText) { text = text.slice(0, L.maxAgentText); stats.dropped.truncatedText++ }
        out.push(n('item/completed', { item: { id: itemId, type: 'agentMessage', text, phase: null } }))
      } else if (THINKING_BLOCKS.has(type)) stats.withheld.thinkingBlocks++
      else if (type === 'tool_use') out.push(...onToolUse(block))
      else skip(`assistant/${type}`, typeof type === 'string')
    }
    return out
  }

  function onToolUse(block) {
    const id = idText(block.id)
    const name = typeof block.name === 'string' ? block.name : ''
    if (!id) return skip('assistant/malformed')
    if (tools.has(id)) return []
    const input = plainObject(block.input) || {}
    const keep = (kind, item) => { remember(tools, id, { kind, turnId: currentTurn, item, done: false, declined: false }, L.maxPendingTools); return item }
    if (name === 'Bash') {
      return [n('item/started', { item: keep('item', {
        id, type: 'commandExecution', status: 'inProgress',
        command: publicText(input.command, L.maxCommand), cwd: session?.cwd ?? null, exitCode: null, durationMs: null,
      }) })]
    }
    if (FILE_TOOLS.has(name)) {
      const target = input[FILE_TOOLS.get(name)]
      // Path only. Write cannot tell a new file from an overwrite → update.
      return [n('item/started', { item: keep('item', {
        id, type: 'fileChange', status: 'inProgress',
        changes: typeof target === 'string' && target ? [{ path: target.slice(0, L.maxPath), kind: { type: 'update' } }] : [],
      }) })]
    }
    if (AGENT_TOOLS.has(name)) {
      remember(agents, id, {
        turnId: currentTurn, label: toolName(input.subagent_type) || toolName(input.name), model: modelId(input.model), effort: token(input.effort),
        // The short description, never the Agent prompt.
        preview: publicText(input.description, 160) || null, started: false, state: 'pendingInit',
      }, L.maxSubagents)
      keep('agent', null)
      return [n('item/started', { item: collabItem(id, 'inProgress', 'pendingInit') })]
    }
    if (name === 'TodoWrite') {
      keep('plan', null)
      const todos = Array.isArray(input.todos) ? input.todos : []
      return [n('turn/plan/updated', {
        explanation: null,
        plan: todos.slice(0, L.maxPlanSteps).filter(plainObject).map(todo => ({ step: publicText(todo.content, 1000), status: PLAN_STATUS[todo.status] || 'pending' })),
      })]
    }
    const mcp = splitMcpToolName(name)
    if (mcp && egdeskServer && mcp.server === egdeskServer) {
      return [n('item/started', { item: keep('item', { id, type: 'dynamicToolCall', status: 'inProgress', tool: toolName(mcp.tool) || 'unknownTool' }) })]
    }
    if (mcp) {
      return [n('item/started', { item: keep('item', {
        id, type: 'mcpToolCall', status: 'inProgress',
        server: publicText(mcp.server, 120), tool: publicText(mcp.tool, 120), durationMs: null,
      }) })]
    }
    // Read, Grep, Glob, WebFetch, WebSearch, Skill, AskUserQuestion, ...: name only.
    return [n('item/started', { item: keep('item', { id, type: 'dynamicToolCall', status: 'inProgress', tool: toolName(name) || 'unknownTool' }) })]
  }

  function collabItem(id, status, agentStatus) {
    const agent = agents.get(id)
    return {
      id, type: 'collabAgentToolCall', tool: 'spawnAgent', status, senderThreadId: threadId,
      // The Agent tool_use_id is the child "thread" id; rows key on it.
      receiverThreadIds: [id], prompt: agent?.preview ?? null, model: agent?.model ?? null, reasoningEffort: agent?.effort ?? null,
      agentsStates: agentStatus ? { [id]: { status: agentStatus, message: null } } : {},
    }
  }

  // ── user → tool completions (bodies never read)
  function onUser(msg) {
    if (isSubagent(msg)) return onSubagentMessage(msg)
    if (msg.isReplay === true) return skip('user/replay', true)
    const content = msg.message?.content
    if (!Array.isArray(content)) return skip('user/text', typeof content === 'string')
    const results = content.slice(0, L.maxBlocks).filter(block => block?.type === 'tool_result')
    const out = []
    for (const block of content.slice(0, L.maxBlocks)) if (block?.type !== 'tool_result') skip(`user/${block?.type}`, typeof block?.type === 'string')
    for (const block of results) {
      stats.withheld.toolResultBodies++
      // tool_use_result is per message; read only the Agent launch status token.
      const launchStatus = results.length === 1 ? plainObject(msg.tool_use_result)?.status : undefined
      out.push(...onToolResult(block, launchStatus))
    }
    return out
  }

  function onToolResult(block, launchStatus) {
    const id = idText(block.tool_use_id)
    const entry = id && tools.get(id)
    if (!entry) { stats.dropped.orphanToolResults++; return [] }
    if (entry.done) { stats.dropped.duplicateToolResults++; return [] }
    entry.done = true
    const failed = block.is_error === true
    if (entry.kind === 'plan') return []
    if (entry.kind === 'agent') {
      const agent = agents.get(id)
      // Background Agents return async_launched now and finish in a later task_notification.
      const launched = launchStatus === 'async_launched' || launchStatus === 'remote_launched'
      const state = failed ? 'errored' : launched ? 'running' : 'completed'
      if (agent) agent.state = state
      return [n('item/completed', { item: collabItem(id, failed ? 'failed' : 'completed', state) }, entry.turnId)]
    }
    return [n('item/completed', { item: { ...entry.item, status: failed ? 'failed' : 'completed' } }, entry.turnId)]
  }

  // ── subagent traffic → one subAgentActivity 'started' per Agent call
  function onSubagentMessage(msg) {
    stats.withheld.subagentMessages++
    const parent = idText(msg.parent_tool_use_id)
    const agentId = idText(msg.agent_id)
    if (parent && agentId && agents.has(parent)) remember(agentIds, agentId, parent, L.maxSubagents)
    const owner = parent && agents.has(parent) ? parent : agentId ? agentIds.get(agentId) : null
    if (!owner) { stats.dropped.unmatchedSubagentMessages++; return [] }
    return startSubagent(owner)
  }

  function startSubagent(id) {
    const agent = agents.get(id)
    if (!agent || agent.started) return []
    agent.started = true
    if (agent.state === 'pendingInit') agent.state = 'running'
    return [n('item/completed', { item: { id: `${id}:started`, type: 'subAgentActivity', agentThreadId: id, agentPath: agent.label, kind: 'started', model: agent.model } }, agent.turnId)]
  }

  function onTaskStarted(msg) {
    const id = idText(msg.tool_use_id)
    if (!id || !agents.has(id)) return skip('system/task_started')
    const taskId = idText(msg.task_id)
    if (taskId) remember(agentIds, taskId, id, L.maxSubagents)
    return startSubagent(id)
  }

  function onTaskNotification(msg) {
    const id = idText(msg.tool_use_id) || agentIds.get(idText(msg.task_id))
    const agent = id && agents.get(id)
    const state = TASK_AGENT_STATE[msg.status]
    if (!agent || !state) return skip('system/task_notification')
    if (agent.state === state) return []
    agent.state = state
    const status = state === 'completed' ? 'completed' : state === 'errored' ? 'failed' : 'interrupted'
    return [n('item/completed', { item: collabItem(id, status, state) }, agent.turnId)]
  }

  // ── permission_denied → the tool's item ends 'declined' (not a failed Run)
  function onPermissionDenied(msg) {
    if (idText(msg.agent_id)) { stats.withheld.subagentMessages++; return [] }
    const id = idText(msg.tool_use_id)
    const entry = id && tools.get(id)
    if (!entry || entry.done) return skip('system/permission_denied')
    entry.done = true
    entry.declined = true
    if (entry.kind === 'plan') return []
    if (entry.kind === 'agent') return [n('item/completed', { item: collabItem(id, 'failed', null) }, entry.turnId)]
    return [n('item/completed', { item: { ...entry.item, status: 'declined' } }, entry.turnId)]
  }

  // ── system/api_retry → error {willRetry:true}
  function onApiRetry(msg) {
    const classified = classifyClaudeError(msg)
    const attempt = count(msg.attempt), max = count(msg.max_retries)
    const progress = attempt ? `, attempt ${attempt}${max ? ` of ${max}` : ''}` : ''
    return [n('error', { error: claudeError(classified, `Claude is retrying an API request (${classified.code}${progress})`), willRetry: true })]
  }

  // ── rate_limit_event → extension notification; a rejection colours the turn's failure
  // window/windowMinutes name the limit ('fiveHour' 300 / 'weekly' 10080 / ...);
  // utilization is the official 0-1 fraction, usedPercent the same as 0-100.
  function onRateLimit(msg) {
    const info = plainObject(msg.rate_limit_info) || {}
    const classified = classifyClaudeError(msg)
    if (classified) turnFailure = classified
    if (!RATE_LIMIT_STATUSES.has(info.status)) return skip('rate_limit_event')
    const utilization = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? Math.min(1, Math.max(0, info.utilization)) : null
    return [n('egdesk/engine/rateLimit', {
      engineId: 'claude', status: info.status, ...claudeRateLimitWindow(info.rateLimitType),
      resetsAt: publicEpochMs(info.resetsAt), utilization, usedPercent: utilization === null ? null : Math.round(utilization * 1000) / 10,
      overageStatus: RATE_LIMIT_STATUSES.has(info.overageStatus) ? info.overageStatus : null,
      creditsRequired: info.errorCode === 'credits_required',
    })]
  }

  // ── result → thread/tokenUsage/updated + turn/completed
  function onResult(msg) {
    const out = []
    const total = usageBreakdown(msg.usage)
    if (total || lastUsage) {
      out.push(n('thread/tokenUsage/updated', { tokenUsage: {
        last: lastUsage ? { totalTokens: lastUsage.totalTokens } : null,
        total, modelContextWindow: lastUsage?.contextWindow ?? null,
      } }))
    }
    const reason = token(msg.terminal_reason)
    let status = 'failed', error = null
    if (interruptRequested || turnAborted || ABORT_REASONS.has(reason)) status = 'interrupted'
    else if (msg.subtype === 'success' && msg.is_error !== true) status = 'completed'
    else error = turnError(msg, reason)
    const durationMs = count(msg.duration_ms)
    out.push(n('turn/completed', { turn: { id: currentTurn, status, items: [], error, ...(durationMs !== null ? { durationMs } : {}) } }))
    resetTurn()
    return out
  }

  function turnError(msg, reason) {
    const own = msg.subtype !== 'success' && msg.subtype !== 'error_during_execution' ? classifyClaudeError(msg) : null
    const httpStatus = count(msg.api_error_status)
    const httpKind = httpStatus === null ? null : HTTP_KINDS.get(httpStatus) || (httpStatus >= 500 && httpStatus < 600 ? 'network' : null)
    const reasonKind = TERMINAL_REASON_KINDS.get(reason)
    const classified = own || turnFailure
      || (httpKind && { kind: httpKind, code: `http_${httpStatus}` })
      || (reasonKind && { kind: reasonKind, code: reason })
      || classifyClaudeError(msg)
      || { kind: 'unknown', code: 'result_error' }
    return claudeError(classified, `Claude could not finish the turn (${classified.code})`)
  }

  function route(msg) {
    switch (msg.type) {
      case 'system':
        switch (msg.subtype) {
          case 'init': return onInit(msg)
          case 'api_retry': return onApiRetry(msg)
          case 'permission_denied': return onPermissionDenied(msg)
          case 'task_started': return onTaskStarted(msg)
          case 'task_notification': return onTaskNotification(msg)
          default: return skip(`system/${msg.subtype}`)
        }
      case 'stream_event': return onStreamEvent(msg)
      case 'assistant': return onAssistant(msg)
      case 'user': return onUser(msg)
      case 'result': return onResult(msg)
      case 'rate_limit_event': return onRateLimit(msg)
      default: return skip(msg.type)
    }
  }

  return {
    translate(input) {
      stats.lines++
      let msg = input
      if (typeof input === 'string') {
        if (input.length > L.maxLineChars) { stats.oversized++; return [] }
        const line = input.trim()
        if (!line) { stats.blank++; return [] }
        try { msg = JSON.parse(line) } catch { stats.invalidJson++; return [] }
      }
      if (!plainObject(msg) || typeof msg.type !== 'string') { stats.notMessage++; return [] }
      try {
        const events = route(msg)
        stats.events += events.length
        return events
      } catch {
        stats.translateErrors++
        return []
      }
    },
    beginTurn(nextTurnId) {
      if (!idText(nextTurnId)) throw new TypeError('beginTurn requires a turnId string (1-300 chars)')
      currentTurn = nextTurnId
      resetTurn()
      const events = [n('turn/started', { turn: { id: nextTurnId, status: 'inProgress', items: [] } })]
      stats.events += events.length
      return events
    },
    markInterruptRequested() { interruptRequested = true },
    session: () => session && JSON.parse(JSON.stringify(session)),
    stats: () => JSON.parse(JSON.stringify(stats)),
  }
}
