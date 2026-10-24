import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EGDESK_MCP_LIMITS, EGDESK_MCP_SERVER_NAME, MCP_PROTOCOL_VERSIONS,
  callToolResultFromResponse, createEgdeskClaudeMcp, egdeskAllowedToolsRule, egdeskMcpConfig, mcpToolsFromSpecs,
} from './egdesk-claude-mcp.mjs'
import { classifyControlMessage } from './claude-engine-permissions.mjs'
import { BROWSER_TOOL_SPECS } from './egdesk-browser-tool-runtime.mjs'
import { CONTEXT_TOOL_SPECS } from './egdesk-context-runtime.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

// Fixtures follow the SDK MCP control shapes in anthropics/claude-agent-sdk-python
// (_internal/query.py 'mcp_message', _internal/sdk_mcp_bridge.py) and MCP JSON-RPC
// (initialize, tools/list, tools/call, notifications/*) — not checked against a
// real claude run (D1 pending). Values are invented.

const THREAD = '7f1c6a52-3b1e-4c1a-9d55-0d6c2b8f4a10'
const TURN = 'turn-claude-1'
let seq = 0
const mcp = (message, server = 'egdesk') => ({ type: 'control_request', request_id: `req-${++seq}`, request: { subtype: 'mcp_message', server_name: server, message } })
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
const mcpResponse = out => out.write.response.response.mcp_response
const ECHO = { type: 'function', name: 'egdesk_test_echo', description: 'Echo for tests', inputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] } }

test('the CLI registration names an in-process sdk server and an allow rule for its tools', () => {
  assert.deepEqual(egdeskMcpConfig(), { mcpServers: { egdesk: { type: 'sdk', name: 'egdesk' } } })
  assert.equal(egdeskAllowedToolsRule(), 'mcp__egdesk')
  assert.equal(EGDESK_MCP_SERVER_NAME, 'egdesk')
  assert.throws(() => egdeskMcpConfig('bad name'), TypeError)
  assert.throws(() => egdeskAllowedToolsRule(''), TypeError)
})

test('tools/list is the thread catalog; Browser and Context input schemas pass through unchanged', () => {
  const specs = [...CONTEXT_TOOL_SPECS, ...BROWSER_TOOL_SPECS]
  const { tools, routes, skipped } = mcpToolsFromSpecs(specs)
  assert.equal(skipped, 0)
  assert.deepEqual(tools.map(tool => tool.name), specs.map(spec => spec.name))
  for (const [index, spec] of specs.entries()) {
    assert.deepEqual(tools[index].inputSchema, spec.inputSchema, spec.name)
    assert.notEqual(tools[index].inputSchema, spec.inputSchema, 'a copy, never the shared spec object')
    assert.equal(tools[index].description, spec.description)
    assert.deepEqual(routes.get(spec.name), { namespace: null, tool: spec.name })
  }
  const namespaced = mcpToolsFromSpecs([{ type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read', inputSchema: { type: 'object', properties: {} } }] }])
  assert.deepEqual(namespaced.tools, [{ name: 'files__read', inputSchema: { type: 'object', properties: {} } }])
  assert.deepEqual(namespaced.routes.get('files__read'), { namespace: 'files', tool: 'read' })
  // Malformed, duplicate, non-object-schema and over-long entries are skipped and counted.
  const odd = mcpToolsFromSpecs([
    null, { type: 'function', name: 'ok_tool', inputSchema: { type: 'object' } }, { type: 'function', name: 'ok_tool', inputSchema: { type: 'object' } },
    { type: 'function', name: 'no_schema' }, { type: 'function', name: 'array_schema', inputSchema: { type: 'array' } },
    { type: 'function', name: `x${'y'.repeat(60)}`, inputSchema: { type: 'object' } }, { type: 'namespace', name: 'empty', tools: [] },
    { type: 'function', name: 'bad-name', inputSchema: { type: 'object' } },
  ])
  assert.deepEqual([odd.tools.map(tool => tool.name), odd.skipped], [['ok_tool'], 7])
  assert.equal(mcpToolsFromSpecs(Array.from({ length: 70 }, (_, i) => ({ type: 'function', name: `t${i}`, inputSchema: { type: 'object' } }))).tools.length, EGDESK_MCP_LIMITS.maxTools)
})

test('handshake, ping, notifications and unsupported methods follow the SDK bridge', () => {
  const server = createEgdeskClaudeMcp({ threadId: THREAD, tools: [ECHO] })
  const init = mcp(rpc(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.300' } }))
  assert.deepEqual(server.handle(init), { write: { type: 'control_response', response: { subtype: 'success', request_id: init.request_id, response: { mcp_response: {
    jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'egdesk', version: '1' } },
  } } } } })
  // An unknown requested version gets a supported one; a repeated handshake is answered again.
  assert.equal(mcpResponse(server.handle(mcp(rpc(1, 'initialize', { protocolVersion: '1999-01-01' })))).result.protocolVersion, MCP_PROTOCOL_VERSIONS[1])
  // Notifications get an ack on the control channel, never a JSON-RPC reply.
  assert.deepEqual(mcpResponse(server.handle(mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }))), { jsonrpc: '2.0', result: {} })
  assert.deepEqual(mcpResponse(server.handle(mcp(rpc(2, 'ping')))), { jsonrpc: '2.0', id: 2, result: {} })
  assert.deepEqual(mcpResponse(server.handle(mcp(rpc(3, 'tools/list', {})))).result.tools, [{ name: 'egdesk_test_echo', description: 'Echo for tests', inputSchema: ECHO.inputSchema }])
  assert.deepEqual(mcpResponse(server.handle(mcp(rpc(4, 'resources/list', {})))).error, { code: -32601, message: 'resources/list is not supported by the EG-Desk server' })
  assert.deepEqual(mcpResponse(server.handle(mcp(rpc(5, 'tools/list'), 'github'))), { jsonrpc: '2.0', id: 5, error: { code: -32601, message: "Server 'github' not found" } })
  // A malformed frame still acknowledges the control request.
  assert.deepEqual(mcpResponse(server.handle(mcp({ id: 6 }))), { jsonrpc: '2.0', result: {} })
  assert.deepEqual(server.handle({ type: 'control_request', request_id: 'x', request: { subtype: 'can_use_tool' } }), {})
  assert.deepEqual(server.handle({ type: 'assistant' }), {})
  // The permission module's classification is accepted as input too.
  assert.deepEqual(mcpResponse(server.handle(classifyControlMessage(mcp(rpc(7, 'ping'))))), { jsonrpc: '2.0', id: 7, result: {} })
  const stats = server.stats()
  assert.deepEqual([stats.methods.initialize, stats.methods.ping, stats.methods['tools/list'], stats.methods['notifications/initialized'], stats.methods.other], [2, 2, 1, 1, 1])
  assert.ok(!JSON.stringify(stats).includes('resources/list'), 'stats keys are fixed')
})

test('tools/call becomes item/tool/call; the reply becomes a CallToolResult once', () => {
  const server = createEgdeskClaudeMcp({ threadId: THREAD, tools: [ECHO, { type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read', inputSchema: { type: 'object' } }] }] })
  const control = mcp(rpc(11, 'tools/call', { name: 'egdesk_test_echo', arguments: { text: 'hi' }, _meta: { 'claudecode/toolUseId': 'toolu_echo' } }))
  const out = server.handle(control, { turnId: TURN })
  assert.deepEqual(out, { serverRequest: { id: `claude:${THREAD}:mcp:1`, method: 'item/tool/call', params: {
    threadId: THREAD, turnId: TURN, callId: 'toolu_echo', tool: 'egdesk_test_echo', namespace: null, arguments: { text: 'hi' },
  } } })
  assert.equal(server.owns(out.serverRequest.id), true)
  const done = server.respond(out.serverRequest.id, { success: true, contentItems: [{ type: 'inputText', text: '{"ok":true}' }] })
  assert.deepEqual(done, { write: { type: 'control_response', response: { subtype: 'success', request_id: control.request_id, response: { mcp_response: {
    jsonrpc: '2.0', id: 11, result: { content: [{ type: 'text', text: '{"ok":true}' }] },
  } } } } })
  assert.equal(server.respond(out.serverRequest.id, { success: true, contentItems: [] }), null)

  const ns = server.handle(mcp(rpc(12, 'tools/call', { name: 'files__read' })), { turnId: TURN })
  assert.deepEqual([ns.serverRequest.params.namespace, ns.serverRequest.params.tool, ns.serverRequest.params.arguments, ns.serverRequest.params.callId], ['files', 'read', {}, `mcp-claude:${THREAD}:mcp:2`])

  assert.deepEqual(mcpResponse(server.handle(mcp(rpc(13, 'tools/call', { name: 'egdesk_unknown' })), { turnId: TURN })).error, { code: -32602, message: 'Unknown tool' })
  assert.deepEqual(mcpResponse(server.handle(mcp(rpc(14, 'tools/call', { name: 'egdesk_test_echo', arguments: ['x'] })), { turnId: TURN })).error, { code: -32602, message: 'Tool arguments must be an object' })
})

test('tool results: failures, refusals, inline images; cancellation and process loss', () => {
  assert.deepEqual(callToolResultFromResponse({ success: false, contentItems: [{ type: 'inputText', text: '{"error":{"code":"BROWSER_STALE"}}' }] }), { content: [{ type: 'text', text: '{"error":{"code":"BROWSER_STALE"}}' }], isError: true })
  assert.deepEqual(callToolResultFromResponse(null, { code: -32601, message: 'This run does not authorize the requested dynamic tool' }), {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: 'EGDESK_TOOL_REFUSED', message: 'This run does not authorize the requested dynamic tool' } }) }], isError: true,
  })
  assert.deepEqual(callToolResultFromResponse({ success: true, contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' }, { type: 'inputImage', imageUrl: 'https://example.com/a.png' }, { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,UklGRg==' }, { type: 'mystery' }] }), {
    content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { type: 'text', text: '[image not inline; omitted]' }, { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }],
  })
  assert.equal(callToolResultFromResponse({ success: true, contentItems: [{ type: 'inputImage', imageUrl: 'data:text/html;base64,PGI+' }] }).content[0].type, 'text')
  // Credentials in a refusal message are masked like every other public text.
  assert.ok(!JSON.stringify(callToolResultFromResponse(null, { code: -32000, message: 'failed Authorization: Bearer SECRET_TOKEN_SENTINEL' })).includes('SECRET_TOKEN_SENTINEL'))

  const server = createEgdeskClaudeMcp({ threadId: THREAD, tools: [ECHO] })
  const first = server.handle(mcp(rpc(21, 'tools/call', { name: 'egdesk_test_echo', arguments: { text: 'a' } })), { turnId: TURN })
  // MCP cancellation: the late reply closes the control request with "cancelled".
  server.handle(mcp({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 21, reason: 'user' } }))
  assert.deepEqual(mcpResponse(server.respond(first.serverRequest.id, { success: true, contentItems: [] })), { jsonrpc: '2.0', id: 21, error: { code: -32800, message: 'Request cancelled' } })
  // control_cancel_request: the CLI abandoned it, so nothing is written later.
  const second = mcp(rpc(22, 'tools/call', { name: 'egdesk_test_echo', arguments: { text: 'b' } }))
  const secondOut = server.handle(second, { turnId: TURN })
  assert.equal(server.cancel(second.request_id), true)
  assert.equal(server.respond(secondOut.serverRequest.id, { success: true, contentItems: [] }), null)
  assert.equal(server.cancel(second.request_id), false)
  server.handle(mcp(rpc(23, 'tools/call', { name: 'egdesk_test_echo', arguments: { text: 'c' } })), { turnId: TURN })
  assert.equal(server.abortAll(), 1)
  const tight = createEgdeskClaudeMcp({ threadId: THREAD, tools: [ECHO], limits: { maxPending: 1 } })
  tight.handle(mcp(rpc(1, 'tools/call', { name: 'egdesk_test_echo', arguments: { text: 'x' } })), { turnId: TURN })
  assert.deepEqual(mcpResponse(tight.handle(mcp(rpc(2, 'tools/call', { name: 'egdesk_test_echo', arguments: { text: 'y' } })), { turnId: TURN })).error, { code: -32600, message: 'Too many EG-Desk tool calls in flight' })
  assert.throws(() => createEgdeskClaudeMcp({}), TypeError)
  assert.throws(() => createEgdeskClaudeMcp({ threadId: THREAD, serverName: 'a b' }), TypeError)
})

// A provider like the real ones: specs() for the catalog, dispatch() for calls.
function echoProvider() {
  const calls = []
  return {
    calls,
    providerId: 'test-echo',
    specs: () => [ECHO, { type: 'function', name: 'egdesk_browser_observe', description: 'Fake Browser tool name for the policy check', inputSchema: { type: 'object', properties: { cardId: { type: 'string' } }, required: ['cardId'] } }],
    dispatch: async (run, event) => { calls.push([event.tool, event.arguments]); return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ echoed: event.arguments.text }) }] } },
  }
}

test('the existing runtime authorizes and dispatches Claude MCP tool calls with its own checks', async () => {
  const provider = echoProvider()
  let started = null, turns = 0
  const replies = []
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      if (method === 'thread/start') { started = params; return { thread: { id: 'thread-1' }, cwd: '/Users/demo/project' } }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      throw new Error(`Unexpected method: ${method}`)
    },
    respond: (...args) => { replies.push(args) },
    emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, toolProviders: [provider],
  })
  chat.setConnection(true)
  const run = await chat.send({ message: 'Use the tools' })
  // The thread's catalog is exactly what Codex would get as dynamicTools.
  const server = createEgdeskClaudeMcp({ threadId: run.conversationId, tools: started.dynamicTools })
  assert.deepEqual(server.listTools().map(tool => tool.name), ['egdesk_test_echo', 'egdesk_browser_observe'])
  const settle = async () => { for (let i = 0; i < 5 && !replies.length; i++) await new Promise(resolve => setImmediate(resolve)); return replies.splice(0).map(([id, result, error]) => server.respond(id, result, error)) }

  const ok = server.handle(mcp(rpc(1, 'tools/call', { name: 'egdesk_test_echo', arguments: { text: 'hello' } })), { turnId: run.runId })
  await chat.handleServerRequest(ok.serverRequest)
  const [okReply] = await settle()
  assert.deepEqual(mcpResponse(okReply).result, { content: [{ type: 'text', text: '{"echoed":"hello"}' }] })
  assert.deepEqual(provider.calls, [['egdesk_test_echo', { text: 'hello' }]])

  // Execution policy: an ordinary run never gets Browser tools, whatever Claude asks.
  const browser = server.handle(mcp(rpc(2, 'tools/call', { name: 'egdesk_browser_observe', arguments: { cardId: 'c1' } })), { turnId: run.runId })
  await chat.handleServerRequest(browser.serverRequest)
  const [browserReply] = await settle()
  assert.equal(mcpResponse(browserReply).result.isError, true)
  assert.match(mcpResponse(browserReply).result.content[0].text, /EGDESK_TOOL_REFUSED/)
  assert.equal(provider.calls.length, 1, 'the provider was never reached')

  // Run binding: a call outside the owned run is refused before dispatch.
  const stray = server.handle(mcp(rpc(3, 'tools/call', { name: 'egdesk_test_echo', arguments: { text: 'x' } })), { turnId: 'turn-unknown' })
  await chat.handleServerRequest(stray.serverRequest)
  const [strayReply] = await settle()
  assert.equal(mcpResponse(strayReply).result.isError, true)
  assert.equal(provider.calls.length, 1)
})
