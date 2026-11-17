// EG-Desk tools for a Claude conversation as an in-process ('sdk') MCP server (SUB-10).
//
// Patterns followed (rewritten here, not copied):
//   anthropics/claude-agent-sdk-python (MIT, Copyright (c) Anthropic, PBC):
//     _internal/query.py _handle_control_request 'mcp_message' branch — the CLI
//     sends JSON-RPC for an SDK server inside control_request
//     {subtype:'mcp_message', server_name, message}; the answer is
//     control_response {response:{mcp_response}}; a notification still gets an
//     ack ({jsonrpc:'2.0', result:{}}); an unknown server is JSON-RPC -32601.
//     _internal/sdk_mcp_bridge.py — initialize may repeat on a live session,
//     ping is answered, unsupported methods are "method not found".
//     transport/subprocess_cli.py — an SDK server is passed to the CLI in
//     --mcp-config as {type:'sdk', name} without the in-process instance.
//
// No port, token or extra process: the tool calls ride the same stdin/stdout
// pipe as the conversation. tools/list comes from the thread's EG-Desk tool
// catalog (the same specs the runtime gives Codex as dynamicTools, already
// filtered by execution policy and Agent ceiling). tools/call becomes the
// Codex-shaped server request item/tool/call, so runtime.handleServerRequest
// applies the existing checks (verified run binding, execution policy, Browser
// card grants, Agent ceiling) before provider.dispatch. Tool input schemas are
// passed through unchanged.
//
// Pure: no I/O, no clock, no process, no logging. Arguments and results pass
// through without being recorded; stats() holds counters with fixed keys only.

import { publicText } from './codex-chat-values.mjs'
import { CLAUDE_MCP_OUTPUT_LIMIT_TOKENS, claudeToolResultBound } from './egdesk-claude-limits.mjs'

export const EGDESK_MCP_SERVER_NAME = 'egdesk'
// Newest first. The CLI's requested version is echoed when listed here.
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
export const EGDESK_MCP_LIMITS = Object.freeze({
  maxTools: 64, // a native tool manifest holds at most 64 entries
  maxPending: 512, // the runtime keeps at most 512 dynamic tool callbacks
  maxToolNameChars: 64, // full `mcp__<server>__<tool>` name
  maxDescription: 4000,
})

const JSONRPC = '2.0'
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INVALID_REQUEST = -32600
const REQUEST_CANCELLED = -32800
const COUNTED_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized', 'notifications/cancelled'])

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
const idText = value => typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : null
const serverToken = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value) ? value : null
const specName = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null
const jsonRpcId = value => typeof value === 'string' ? (value.length <= 300 ? value : undefined)
  : Number.isSafeInteger(value) ? value : undefined

/** The --mcp-config value that registers the server with the CLI. */
export function egdeskMcpConfig(serverName = EGDESK_MCP_SERVER_NAME) {
  const name = serverToken(serverName)
  if (!name) throw new TypeError('egdeskMcpConfig requires a server name token')
  return { mcpServers: { [name]: { type: 'sdk', name } } }
}

/**
 * The --allowedTools entry so EG-Desk tools are not asked about through
 * can_use_tool (their authority is checked per call by the runtime).
 * [추정] `mcp__<server>` matching every tool of that server follows the CLI
 * permission rule docs; routePermissionRequest also allows them if asked.
 */
export function egdeskAllowedToolsRule(serverName = EGDESK_MCP_SERVER_NAME) {
  const name = serverToken(serverName)
  if (!name) throw new TypeError('egdeskAllowedToolsRule requires a server name token')
  return `mcp__${name}`
}

/**
 * Codex dynamic tool specs → MCP tools.
 *   function spec {type:'function', name, description, inputSchema} → tool `name`
 *   namespace spec {type:'namespace', name: ns, tools:[function...]} → tool `ns__name`
 * Returns { tools: [{name, description, inputSchema}], routes: Map(mcpName → {namespace, tool}), skipped }.
 */
export function mcpToolsFromSpecs(specs, { serverName = EGDESK_MCP_SERVER_NAME, limits = {} } = {}) {
  const L = { ...EGDESK_MCP_LIMITS, ...limits }
  const server = serverToken(serverName)
  if (!server) throw new TypeError('mcpToolsFromSpecs requires a server name token')
  const tools = [], routes = new Map()
  let skipped = 0
  const add = (namespace, fn) => {
    const name = specName(fn?.name)
    const mcpName = name && (namespace ? `${namespace}__${name}` : name)
    const schema = plainObject(fn?.inputSchema)
    if (!mcpName || fn?.type !== 'function' || !schema || schema.type !== 'object' || routes.has(mcpName) ||
        `mcp__${server}__${mcpName}`.length > L.maxToolNameChars || tools.length >= L.maxTools) { skipped++; return }
    let inputSchema
    try { inputSchema = structuredClone(schema) } catch { skipped++; return }
    routes.set(mcpName, Object.freeze({ namespace: namespace || null, tool: name }))
    tools.push({ name: mcpName, ...(typeof fn.description === 'string' && fn.description ? { description: fn.description.slice(0, L.maxDescription) } : {}), inputSchema })
  }
  for (const spec of Array.isArray(specs) ? specs : []) {
    if (spec?.type === 'namespace') {
      const ns = specName(spec.name)
      if (!ns || !Array.isArray(spec.tools) || !spec.tools.length) { skipped++; continue }
      for (const fn of spec.tools) add(ns, fn)
    } else add(null, spec)
  }
  return { tools, routes, skipped }
}

function dataUrl(value) {
  const match = typeof value === 'string' ? /^data:([a-z]+\/[A-Za-z0-9.+-]{1,60});base64,([A-Za-z0-9+/]+={0,2})$/.exec(value) : null
  return match ? { mimeType: match[1], data: match[2] } : null
}

/**
 * The runtime's reply to item/tool/call → MCP CallToolResult.
 *   result {success, contentItems:[inputText|inputImage|inputAudio]} → content + isError
 *   error {code, message} (the runtime refused) → isError result with a fixed-shape JSON text
 * A tool refusal is a tool result Claude can read, not a protocol error.
 */
export function callToolResultFromResponse(result, error) {
  if (error !== undefined || !plainObject(result) || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems)) {
    const message = publicText(typeof error?.message === 'string' ? error.message : 'EG-Desk refused the tool call', 300) || 'EG-Desk refused the tool call'
    return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'EGDESK_TOOL_REFUSED', message } }) }], isError: true }
  }
  const content = []
  for (const item of result.contentItems) {
    if (item?.type === 'inputText' && typeof item.text === 'string') content.push({ type: 'text', text: item.text })
    else if (item?.type === 'inputImage' || item?.type === 'inputAudio') {
      const inline = dataUrl(item.type === 'inputImage' ? item.imageUrl : item.audioUrl)
      const kind = item.type === 'inputImage' ? 'image' : 'audio'
      if (inline && inline.mimeType.startsWith(`${kind}/`)) content.push({ type: kind, data: inline.data, mimeType: inline.mimeType })
      else content.push({ type: 'text', text: `[${kind} not inline; omitted]` })
    }
  }
  return { content, ...(result.success === false ? { isError: true } : {}) }
}

/**
 * SUB-09 MCP output limit: a result whose token upper bound
 * (claudeToolResultBound) exceeds the MAX_MCP_OUTPUT_TOKENS EG-Desk gave the
 * process is replaced by a tool error. Nothing is clipped; the model reads
 * why and may ask for a narrower read (e.g. egdesk_read_source with a range).
 */
export function boundedCallToolResult(result, limitTokens = CLAUDE_MCP_OUTPUT_LIMIT_TOKENS) {
  const bound = claudeToolResultBound(result)
  if (bound <= limitTokens) return { result, bound, limited: false }
  const text = JSON.stringify({ error: { code: 'EGDESK_TOOL_OUTPUT_LIMIT',
    message: `The tool result (upper bound ${bound} tokens) exceeds the ${limitTokens} token tool-output limit; nothing was clipped. Request a narrower range or use a source Reader.` } })
  return { result: { content: [{ type: 'text', text }], isError: true }, bound, limited: true }
}

/**
 * createEgdeskClaudeMcp({ threadId, tools, serverName?, serverVersion?, nextRpcId?, limits?, outputLimitTokens? })
 * One per Claude session. `tools` is the thread's EG-Desk catalog (the specs
 * the runtime passed as dynamicTools to startThread).
 *   handle(controlMessage, { turnId })  → { write?: controlResponse, serverRequest?: {id, method:'item/tool/call', params} }
 *       controlMessage: a control_request {subtype:'mcp_message'} line object or
 *       classifyControlMessage() output for it.
 *   respond(rpcId, result, error)       → { write } | null (not ours, settled or abandoned)
 *   cancel(requestId)                   → true when an in-flight call was abandoned (control_cancel_request; nothing is written)
 *   abortAll()                          → number of in-flight calls dropped (process ended)
 *   owns(rpcId) / listTools() / stats()
 * rpcIds are strings `claude:<threadId>:mcp:<n>` unless nextRpcId is given.
 */
export function createEgdeskClaudeMcp({ threadId, tools = [], serverName = EGDESK_MCP_SERVER_NAME, serverVersion = '1', nextRpcId = null, limits = {}, outputLimitTokens = CLAUDE_MCP_OUTPUT_LIMIT_TOKENS } = {}) {
  if (!idText(threadId)) throw new TypeError('createEgdeskClaudeMcp requires a threadId')
  if (!Number.isSafeInteger(outputLimitTokens) || outputLimitTokens <= 0) throw new TypeError('createEgdeskClaudeMcp requires a positive outputLimitTokens')
  const L = { ...EGDESK_MCP_LIMITS, ...limits }
  const server = serverToken(serverName)
  if (!server) throw new TypeError('createEgdeskClaudeMcp requires a server name token')
  const catalog = mcpToolsFromSpecs(tools, { serverName: server, limits: L })
  let counter = 0
  const makeId = typeof nextRpcId === 'function' ? nextRpcId : () => `claude:${threadId}:mcp:${++counter}`
  const pending = new Map() // rpcId → { requestId, jsonId, cancelled }
  const byRequest = new Map() // control request_id → rpcId
  const stats = { messages: 0, methods: {}, refused: 0, cancelled: 0, abandoned: 0, skippedTools: catalog.skipped, outputLimited: 0 }

  const bump = method => { const key = COUNTED_METHODS.has(method) ? method : 'other'; stats.methods[key] = (stats.methods[key] || 0) + 1 }
  const reply = (requestId, mcpResponse) => ({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { mcp_response: mcpResponse } } })
  const ok = (requestId, id, result) => reply(requestId, { jsonrpc: JSONRPC, id, result })
  const fail = (requestId, id, code, message) => { stats.refused++; return reply(requestId, { jsonrpc: JSONRPC, id: id ?? null, error: { code, message } }) }

  function call(requestId, id, params, turnId) {
    const p = plainObject(params)
    const route = typeof p?.name === 'string' ? catalog.routes.get(p.name) : undefined
    if (!route) return { write: fail(requestId, id, INVALID_PARAMS, 'Unknown tool') }
    if (p.arguments !== undefined && !plainObject(p.arguments)) return { write: fail(requestId, id, INVALID_PARAMS, 'Tool arguments must be an object') }
    if (pending.size >= L.maxPending) return { write: fail(requestId, id, INVALID_REQUEST, 'Too many EG-Desk tool calls in flight') }
    const rpcId = makeId()
    // [추정] Claude names the calling tool_use in _meta; otherwise a local id.
    const callId = idText(plainObject(p._meta)?.['claudecode/toolUseId']) || `mcp-${rpcId}`
    pending.set(rpcId, { requestId, jsonId: id, cancelled: false })
    byRequest.set(requestId, rpcId)
    return { serverRequest: { id: rpcId, method: 'item/tool/call', params: {
      threadId, turnId: idText(turnId), callId, tool: route.tool, namespace: route.namespace, arguments: p.arguments ?? {},
    } } }
  }

  return {
    handle(message, { turnId = null } = {}) {
      const control = message?.kind ? message : (message?.type === 'control_request' ? {
        kind: message.request?.subtype === 'mcp_message' ? 'mcpMessage' : 'other', requestId: idText(message.request_id), request: plainObject(message.request),
      } : null)
      if (control?.kind !== 'mcpMessage' || !idText(control.requestId)) return {}
      stats.messages++
      const requestId = control.requestId
      const rpc = plainObject(control.request?.message)
      const name = control.request?.server_name
      const id = jsonRpcId(rpc?.id)
      if (name !== server) return { write: fail(requestId, id, METHOD_NOT_FOUND, `Server '${typeof name === 'string' ? name.slice(0, 64) : ''}' not found`) }
      if (!rpc || rpc.jsonrpc !== JSONRPC || typeof rpc.method !== 'string') {
        // A JSON-RPC response or malformed frame: nothing to answer inside, but the control request needs its ack.
        return { write: reply(requestId, { jsonrpc: JSONRPC, result: {} }) }
      }
      bump(rpc.method)
      if (id === undefined) {
        // Notifications get no JSON-RPC reply; the control request still gets an ack.
        if (rpc.method === 'notifications/cancelled') {
          const target = jsonRpcId(plainObject(rpc.params)?.requestId)
          for (const entry of pending.values()) if (entry.jsonId === target) { entry.cancelled = true; stats.cancelled++ }
        }
        return { write: reply(requestId, { jsonrpc: JSONRPC, result: {} }) }
      }
      switch (rpc.method) {
        case 'initialize': {
          const asked = plainObject(rpc.params)?.protocolVersion
          return { write: ok(requestId, id, {
            protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: server, version: typeof serverVersion === 'string' && serverVersion ? serverVersion.slice(0, 40) : '1' },
          }) }
        }
        case 'ping': return { write: ok(requestId, id, {}) }
        case 'tools/list': return { write: ok(requestId, id, { tools: structuredClone(catalog.tools) }) }
        case 'tools/call': return call(requestId, id, rpc.params, turnId)
        default: return { write: fail(requestId, id, METHOD_NOT_FOUND, `${rpc.method.slice(0, 64)} is not supported by the EG-Desk server`) }
      }
    },
    respond(rpcId, result, error) {
      const entry = pending.get(rpcId)
      if (!entry) return null
      pending.delete(rpcId)
      byRequest.delete(entry.requestId)
      if (entry.cancelled) return { write: fail(entry.requestId, entry.jsonId, REQUEST_CANCELLED, 'Request cancelled') }
      const bounded = boundedCallToolResult(callToolResultFromResponse(result, error), outputLimitTokens)
      if (bounded.limited) stats.outputLimited++
      return { write: ok(entry.requestId, entry.jsonId, bounded.result) }
    },
    cancel(requestId) {
      const rpcId = byRequest.get(requestId)
      if (rpcId === undefined) return false
      byRequest.delete(requestId)
      pending.delete(rpcId)
      stats.abandoned++
      return true
    },
    abortAll() {
      const dropped = pending.size
      stats.abandoned += dropped
      pending.clear()
      byRequest.clear()
      return dropped
    },
    owns: rpcId => pending.has(rpcId),
    listTools: () => structuredClone(catalog.tools),
    outputLimitTokens: () => outputLimitTokens,
    stats: () => JSON.parse(JSON.stringify(stats)),
  }
}
