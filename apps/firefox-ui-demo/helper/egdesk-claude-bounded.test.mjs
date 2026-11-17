import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { buildClaudeArgs } from './claude-engine-transport.mjs'
import { BROWSER_INTERACTION_TOOL_NAMES, BROWSER_READ_TOOL_NAMES } from './egdesk-browser-tool-runtime.mjs'
import { claudeBoundedInitViolation, claudeBoundedThreadOverrides, verifyClaudeBoundedThread } from './egdesk-claude-bounded.mjs'

// SUB-10 S1 Browser contract for Claude. Real runtime, adapter, MCP bridge and
// permission broker; only the Claude transport and the Browser provider are fake.
const CWD = '/work/claude-bounded'
const tick = () => new Promise(resolve => setImmediate(resolve))
const spec = name => ({ type: 'function', name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })

test('bounded receipt, overrides and init check accept only the EG-Desk-tools-only launch', () => {
  assert.deepEqual(claudeBoundedThreadOverrides('browserBounded'), { egdeskBoundedPolicy: 'browserBounded' })
  for (const mode of ['readOnlyQa', 'fixtureBrowserQa', 'other']) assert.throws(() => claudeBoundedThreadOverrides(mode), { code: 'QA_POLICY_UNAVAILABLE' })
  const applied = { egdeskBounded: { mode: 'browserBounded', builtinTools: 'none', permissionMode: 'dontAsk', mcp: 'egdesk-only', restricted: true } }
  const receipt = verifyClaudeBoundedThread(applied, 'browserBounded')
  assert.equal(receipt.mode, 'browserBounded')
  assert.equal(receipt.status, 'claude-argv-verified')
  assert.equal(receipt.browserEffects, 'observe-only-selected-card')
  assert.throws(() => verifyClaudeBoundedThread({}, 'browserBounded'), { code: 'QA_POLICY_UNVERIFIED' })
  assert.throws(() => verifyClaudeBoundedThread({ egdeskBounded: { ...applied.egdeskBounded, builtinTools: 'default' } }, 'browserBounded'), { code: 'QA_POLICY_UNVERIFIED' })
  const init = { tools: ['mcp__egdesk__egdesk_browser_observe'], mcp_servers: [{ name: 'egdesk', status: 'connected' }], permissionMode: 'dontAsk', skills: [], plugins: [] }
  assert.equal(claudeBoundedInitViolation(init), null)
  assert.equal(claudeBoundedInitViolation({ ...init, tools: [...init.tools, 'Read'] }), 'builtin-tools')
  assert.equal(claudeBoundedInitViolation({ ...init, mcp_servers: [...init.mcp_servers, { name: 'github' }] }), 'external-mcp')
  assert.equal(claudeBoundedInitViolation({ ...init, permissionMode: 'manual' }), 'permission-mode')
  assert.equal(claudeBoundedInitViolation({ ...init, skills: ['pdf'] }), 'extensions')
})

test('bounded argv: no built-in tools, dontAsk, restricted, no Chrome; never with managed MCP, inherited settings or a Reader', () => {
  const args = buildClaudeArgs({ bounded: true, tools: [], permissionMode: 'dontAsk', mcpConfig: { mcpServers: { egdesk: { type: 'sdk', name: 'egdesk' } } }, allowedTools: ['mcp__egdesk'] })
  const value = flag => args[args.indexOf(flag) + 1]
  assert.equal(value('--tools'), '')
  assert.equal(value('--permission-mode'), 'dontAsk')
  assert.ok(args.includes('--restricted') && args.includes('--no-chrome') && args.includes('--strict-mcp-config'))
  assert.equal(value('--allowedTools'), 'mcp__egdesk')
  assert.throws(() => buildClaudeArgs({ bounded: true, tools: ['Read'], permissionMode: 'dontAsk' }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ bounded: true, tools: [], permissionMode: 'manual' }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ bounded: true, tools: [], permissionMode: 'dontAsk', inherit: { instructions: true } }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ bounded: true, tools: [], permissionMode: 'dontAsk', managedMcpConfig: true }), { code: 'CLAUDE_BOUNDED_UNAVAILABLE' })
  assert.equal(buildClaudeArgs({}).includes('--restricted'), false, 'ordinary conversations are unchanged')
})

function harness(t, { version = '2.1.300' } = {}) {
  const transports = [], events = [], dispatched = [], prepared = []
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version, versionStatus: 'untested', auth: { status: 'signedIn', method: 'claudeai', account: 'owner@example.com', label: 'Max' } }),
    env: {}, defaultCwd: CWD, resolveExecutable: () => '/fake/claude', collectContextUsage: false,
    setTimer: () => ({}), clearTimer: () => {},
    createTransport: options => {
      const transport = {
        options, sent: [], replies: [], closed: false,
        async start() {},
        sendUserMessage(content) { this.sent.push(content) },
        respondControl(id, answer) { this.replies.push({ id, ...answer }); return true },
        info: () => ({ init: { billsApiKey: false } }),
        async interrupt() {},
        async close() { if (!this.closed) { this.closed = true; options.onExit() } },
        message(message) { options.onMessage(message) },
        control(requestId, request) { return options.controlHandlers[request.subtype](request, { requestId }) },
      }
      transports.push(transport)
      return transport
    },
  })
  const codex = createCodexEngineAdapter({ request: async method => { throw new Error(`Unexpected Codex call: ${method}`) }, respond: () => true })
  // Stand-in for codex-browser-tool-provider: the runtime, not this fake, decides the catalog and the per-call policy.
  const browser = {
    providerId: 'egdesk-browser',
    specs: () => [...BROWSER_READ_TOOL_NAMES, ...BROWSER_INTERACTION_TOOL_NAMES].map(spec),
    prepare(body) {
      if (!body.selectedSources?.length) return null
      prepared.push(body.effectiveExecutionPolicy)
      return { interactionRequested: body.selectedSources.some(source => source.browserToolPermission === 'interact') }
    },
    requireThread() {}, registerThread(threadId) { this.runtime.browserRegisteredThreads.add(threadId) },
    async bindRun(run, value) { if (value) run.browserBinding = { cards: [{ cardId: 'card-1', permission: 'observe' }] } },
    async dispatch(run, event) { dispatched.push({ tool: event.tool, mode: run.executionPolicy?.mode }); return { success: true, contentItems: [{ type: 'inputText', text: 'observed' }] } },
  }
  const chat = new CodexChatRuntime({ engines: [codex, claude], toolProviders: [browser], emit: event => events.push(event), verifyFile: async () => null })
  const unsubscribe = claude.subscribe({
    notification: (_, message) => chat.handleNotification(message),
    serverRequest: (_, message) => chat.handleServerRequest(message),
    connection: (id, state) => chat.setConnection(id, state.ready, state),
  })
  claude.syncStatus()
  t.after(async () => { unsubscribe(); await claude.dispose(); await chat.queue })
  const drain = async () => { await chat.queue; await tick(); await chat.queue }
  const selected = permission => [{ id: 'card-1', kind: 'browser', browserToolPermission: permission, selectedByUser: true, sourceRef: { uri: 'https://example.com/' }, browserToolSelection: { token: 't', threadId: 'ui-claude' } }]
  const send = (extra = {}) => chat.send({ message: 'Look at the card', engineId: 'claude', clientThreadId: 'ui-claude', requestId: `req-${Math.random()}`, ...extra })
  return { chat, claude, transports, events, dispatched, prepared, drain, selected, send }
}

test('Claude browserBounded: EG-Desk Browser tools only, launched without built-ins, same runtime policy per call', async t => {
  const h = harness(t)
  const run = await h.send({ executionPolicy: { mode: 'browserBounded' }, selectedSources: h.selected('observe') })
  await h.drain()
  assert.deepEqual(h.prepared, ['browserBounded'])
  const [transport] = h.transports
  const options = transport.options
  assert.deepEqual(options.tools, [])
  assert.equal(options.permissionMode, 'dontAsk')
  assert.equal(options.bounded, true)
  assert.deepEqual(options.allowedTools, ['mcp__egdesk'])
  const state = h.chat.runs.get(`${run.conversationId}/${run.runId}`)
  assert.equal(state.executionPolicy.mode, 'browserBounded')
  assert.equal(state.executionPolicy.status, 'claude-argv-verified')
  // The catalog Claude sees: observe-only tools (no interaction was granted).
  const listed = transport.control('list', { subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
  const names = listed.write.response.response.mcp_response.result.tools.map(tool => tool.name)
  assert.ok(names.length > 0)
  assert.ok(names.every(name => BROWSER_READ_TOOL_NAMES.includes(name)), names.join(','))
  // A native init that is not EG-Desk-tools-only closes the process before any output.
  transport.message({ type: 'system', subtype: 'init', session_id: run.conversationId, model: 'claude-x', cwd: CWD, claude_code_version: '2.1.300',
    permissionMode: 'dontAsk', apiKeySource: 'none', tools: ['mcp__egdesk__egdesk_browser_observe'], mcp_servers: [{ name: 'egdesk', status: 'connected' }], capabilities: [] })
  // A tool call takes the same runtime path as Codex (item/tool/call → provider.dispatch under the run policy).
  const immediate = {}
  const call = (id, name, cardId) => { immediate[id] = transport.control(`call-${id}`, { subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { cardId } } } }) }
  const answer = id => (immediate[id]?.write || transport.replies.find(reply => reply.id === `call-${id}`)?.write)?.response?.response?.mcp_response
  call(2, 'egdesk_browser_observe', 'card-1')
  call(3, 'egdesk_browser_observe', 'card-not-selected') // the Card grant check is the runtime's, as for Codex
  call(4, 'egdesk_browser_click', 'card-1') // observe grant: interaction refused
  await h.drain()
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.drain()
  assert.deepEqual(h.dispatched, [{ tool: 'egdesk_browser_observe', mode: 'browserBounded' }])
  assert.deepEqual(answer(2).result, { content: [{ type: 'text', text: 'observed' }] })
  assert.equal(JSON.parse(answer(3).result.content[0].text).error.code, 'EGDESK_TOOL_REFUSED', 'unselected Card: runtime refusal')
  assert.equal(answer(4).error.message, 'Unknown tool', 'click is not even in an observe-only catalog')
  // Built-in tools are denied without an approval card.
  const denied = transport.control('perm', { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu-1', input: { command: 'ls' } })
  assert.equal(denied.response.behavior, 'deny')
  assert.equal(h.events.some(event => event.event === 'approval.requested'), false)
})

test('Claude bounded refusals: readOnlyQa, an old CLI and a non-isolated native init', async t => {
  const h = harness(t)
  await assert.rejects(h.send({ executionPolicy: { mode: 'readOnlyQa' } }), { code: 'QA_POLICY_UNAVAILABLE' })
  const old = harness(t, { version: '2.1.210' })
  await assert.rejects(old.send({ executionPolicy: { mode: 'browserBounded' }, selectedSources: old.selected('observe') }), { code: 'QA_POLICY_UNAVAILABLE' })
  assert.equal(old.transports.length, 0, 'no process for a CLI without --restricted')
  const run = await h.send({ executionPolicy: { mode: 'browserBounded' }, selectedSources: h.selected('observe') })
  const [transport] = h.transports
  transport.message({ type: 'system', subtype: 'init', session_id: run.conversationId, model: 'claude-x', cwd: CWD, claude_code_version: '2.1.300',
    permissionMode: 'dontAsk', apiKeySource: 'none', tools: ['Read', 'mcp__egdesk__egdesk_browser_observe'], mcp_servers: [{ name: 'egdesk' }], capabilities: [] })
  await h.drain()
  assert.equal(transport.closed, true)
  const call = transport.control('call', { subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'egdesk_browser_observe', arguments: {} } } })
  assert.ok(call.error, 'a blocked process gets no tool')
  assert.deepEqual(h.dispatched, [])
  const state = h.chat.runs.get(`${run.conversationId}/${run.runId}`)
  assert.equal(state.status, 'failed')
})

test('ordinary Claude conversations still get no Browser tools', async t => {
  const h = harness(t)
  await h.send()
  const [transport] = h.transports
  assert.equal(transport.options.bounded, undefined)
  assert.notEqual(transport.options.permissionMode, 'dontAsk')
  const tools = transport.options.mcpConfig ? transport.control('l', { subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }).write.response.response.mcp_response.result.tools : []
  assert.equal(tools.some(tool => tool.name.startsWith('egdesk_browser_')), false)
})
