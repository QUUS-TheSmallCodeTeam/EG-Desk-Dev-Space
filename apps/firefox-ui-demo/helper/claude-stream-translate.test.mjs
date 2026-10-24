import test from 'node:test'
import assert from 'node:assert/strict'
import { CLAUDE_TRANSLATE_LIMITS, createClaudeTranslator, splitMcpToolName } from './claude-stream-translate.mjs'
import { classifyClaudeError } from './engine-adapter.mjs'
import { publicError, publicText } from './codex-chat-values.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

// Fixtures: 공식 문서 예시 기반 — 실제 claude 실행으로 미검증.
// Shapes follow code.claude.com/docs/en/headless (stream-json, system/init,
// system/api_retry, parent_tool_use_id), /agent-sdk/typescript (SDKMessage
// types, tool input types, SDKContextUsage), /agent-sdk/streaming-output
// (stream event order: AssistantMessage before content_block_stop) and
// /agent-sdk/subagents (Agent tool, agent_id = task_id). Values are invented.

const THREAD = '7f1c6a52-3b1e-4c1a-9d55-0d6c2b8f4a10'
const TURN = 'turn-claude-1'
const MODEL = 'claude-opus-5-5'
const line = value => JSON.stringify(value)
const meta = (n = 1) => ({ uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, session_id: THREAD })

const INIT = {
  type: 'system', subtype: 'init', ...meta(), agents: ['general-purpose'], apiKeySource: 'none', betas: [],
  claude_code_version: '2.1.300', cwd: '/Users/demo/project',
  tools: ['Task', 'Bash', 'Edit', 'Write', 'Read', 'TodoWrite', 'mcp__egdesk__egdesk_browser_observe', 'mcp__github__create_issue'],
  mcp_servers: [{ name: 'egdesk', status: 'connected', source: '/Users/demo/MCP_SOURCE_SENTINEL.json' }, { name: 'github', status: 'pending' }],
  model: MODEL, permissionMode: 'default', slash_commands: ['/PRIVATE_COMMAND_SENTINEL'], output_style: 'default',
  skills: ['SKILL_SENTINEL'], plugins: [{ name: 'p', path: '/Users/demo/.claude/plugins/PLUGIN_PATH_SENTINEL' }],
  plugin_errors: [{ plugin: 'x', type: 'load', message: 'token=PLUGIN_ERROR_SENTINEL' }], effort: 'high', capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
}
const streamEvent = (event, n = 2) => ({ type: 'stream_event', ...meta(n), event, parent_tool_use_id: null })
const assistant = (id, content, extra = {}) => ({
  type: 'assistant', ...meta(3), parent_tool_use_id: null,
  message: { id, type: 'message', role: 'assistant', model: MODEL, content, stop_reason: null, usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
  ...extra,
})
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input })
const toolResult = (id, { isError = false, body = 'TOOL_RESULT_BODY_SENTINEL', toolUseResult, parent = null, agentId } = {}) => ({
  type: 'user', ...meta(4), parent_tool_use_id: parent, ...(agentId ? { agent_id: agentId } : {}),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body, is_error: isError }] },
  ...(toolUseResult ? { tool_use_result: toolUseResult } : {}),
})
const result = (subtype = 'success', extra = {}) => ({
  type: 'result', subtype, ...meta(9), duration_ms: 1234, duration_api_ms: 1000, is_error: subtype !== 'success', num_turns: 2,
  ...(subtype === 'success' ? { result: 'RESULT_TEXT_SENTINEL' } : { errors: ['ERRORS_SENTINEL'] }),
  stop_reason: 'end_turn', total_cost_usd: 0.42, usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 },
  modelUsage: { [MODEL]: { inputTokens: 20 } }, permission_denials: [], ...extra,
})
// One streamed text block (index) of message `id`, in the documented order.
const streamedText = (id, index, chunks, { start = true } = {}) => [
  ...(start ? [streamEvent({ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: MODEL } })] : []),
  streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
  ...chunks.map(text => streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
  assistant(id, [{ type: 'text', text: chunks.join('') }]),
  streamEvent({ type: 'content_block_stop', index }),
]

const translator = (options = {}) => createClaudeTranslator({ threadId: THREAD, turnId: TURN, ...options })
const feed = (t, inputs) => inputs.flatMap(input => t.translate(typeof input === 'string' ? input : line(input)))
const methods = events => events.map(event => event.method)
const items = (events, method) => events.filter(event => event.method === method).map(event => event.params.item)
const assertAbsent = (events, ...sentinels) => {
  const text = JSON.stringify(events)
  for (const sentinel of sentinels) assert.ok(!text.includes(sentinel), `${sentinel} leaked`)
}

test('system/init becomes thread/started with the public session fields only', () => {
  const t = translator()
  const events = feed(t, [INIT])
  assert.deepEqual(methods(events), ['thread/started'])
  const { params } = events[0]
  assert.deepEqual(params.thread, { id: THREAD, model: MODEL, cwd: '/Users/demo/project', cliVersion: '2.1.300' })
  assert.equal(params.threadId, THREAD)
  assert.equal(params.engine.id, 'claude')
  assert.equal(params.engine.sessionIdMatches, true)
  assert.deepEqual(params.engine.tools, INIT.tools)
  assert.deepEqual(params.engine.mcpServers, [{ name: 'egdesk', status: 'connected' }, { name: 'github', status: 'pending' }])
  assert.deepEqual([params.engine.permissionMode, params.engine.effort, params.engine.apiKeySource], ['default', 'high', 'none'])
  assert.deepEqual(params.engine.capabilities, ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'])
  assertAbsent(events, 'MCP_SOURCE_SENTINEL', 'PRIVATE_COMMAND_SENTINEL', 'SKILL_SENTINEL', 'PLUGIN_PATH_SENTINEL', 'PLUGIN_ERROR_SENTINEL', 'general-purpose')
  assert.equal(t.session().engineVersion, '2.1.300')
  // A second init (e.g. a resumed process) updates session() without a new thread/started.
  assert.deepEqual(feed(t, [{ ...INIT, model: 'claude-sonnet-4-5', session_id: 'other-session' }]), [])
  assert.deepEqual([t.session().model, t.session().sessionIdMatches], ['claude-sonnet-4-5', false])
  assert.equal(t.stats().dropped.repeatedInit, 1)
})

test('streamed text_delta becomes agentMessage started → delta → completed with one item id', () => {
  const t = translator()
  const events = feed(t, [
    ...streamedText('msg_01', 0, ['Hello', ' world']),
    streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    streamEvent({ type: 'message_stop' }),
  ])
  assert.deepEqual(methods(events), ['item/started', 'item/agentMessage/delta', 'item/agentMessage/delta', 'item/completed'])
  assert.deepEqual(events[0].params, { threadId: THREAD, turnId: TURN, item: { id: 'msg_01:0', type: 'agentMessage', text: '', phase: null } })
  assert.deepEqual(events.slice(1, 3).map(event => [event.params.itemId, event.params.delta]), [['msg_01:0', 'Hello'], ['msg_01:0', ' world']])
  assert.deepEqual(events[3].params.item, { id: 'msg_01:0', type: 'agentMessage', text: 'Hello world', phase: null })
  assert.equal(t.stats().ignored['stream_event/message_delta'], 1)
  assert.equal(t.stats().ignored['stream_event/message_stop'], 1)
})

test('thinking and redacted thinking never leave the translator, not even as a summary', () => {
  const t = translator()
  const events = feed(t, [
    streamEvent({ type: 'message_start', message: { id: 'msg_think', content: [] } }),
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SECRET_THOUGHT_SENTINEL' } }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIGNATURE_SENTINEL' } }),
    // A stray text_delta aimed at the thinking block is not text.
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MISROUTED_SENTINEL' } }),
    assistant('msg_think', [{ type: 'thinking', thinking: 'SECRET_THOUGHT_SENTINEL', signature: 'SIGNATURE_SENTINEL' }]),
    streamEvent({ type: 'content_block_stop', index: 0 }),
    assistant('msg_think', [{ type: 'redacted_thinking', data: 'REDACTED_DATA_SENTINEL' }]),
    ...streamedText('msg_think', 1, ['Answer'], { start: false }),
  ])
  assertAbsent(events, 'SECRET_THOUGHT_SENTINEL', 'SIGNATURE_SENTINEL', 'REDACTED_DATA_SENTINEL', 'MISROUTED_SENTINEL', 'reasoning', 'thinking')
  assert.deepEqual(items(events, 'item/completed').map(item => [item.id, item.text]), [['msg_think:1', 'Answer']])
  const { withheld } = t.stats()
  assert.equal(withheld.thinkingBlocks, 3)
  assert.equal(withheld.thinkingDeltas, 2)
})

test('Bash becomes commandExecution with publicText applied to the command and no shell output', () => {
  const t = translator()
  feed(t, [INIT])
  const command = 'curl -H "Authorization: Bearer sk-ant-api03-BEARER_SENTINEL" --password hunter2SENTINEL https://example.test'
  const started = feed(t, [assistant('msg_bash', [toolUse('toolu_bash', 'Bash', { command, description: 'DESCRIPTION_SENTINEL' })])])
  assert.deepEqual(methods(started), ['item/started'])
  assert.deepEqual(started[0].params.item, {
    id: 'toolu_bash', type: 'commandExecution', status: 'inProgress',
    command: publicText(command, 2000), cwd: '/Users/demo/project', exitCode: null, durationMs: null,
  })
  assert.match(started[0].params.item.command, /\[REDACTED\]/)
  const done = feed(t, [toolResult('toolu_bash', { body: 'SHELL_OUTPUT_SENTINEL', toolUseResult: { stdout: 'SHELL_OUTPUT_SENTINEL', stderr: '', interrupted: false } })])
  assert.deepEqual(items(done, 'item/completed').map(item => [item.id, item.status, item.command]), [['toolu_bash', 'completed', started[0].params.item.command]])
  const failed = feed(t, [assistant('msg_bash2', [toolUse('toolu_bash2', 'Bash', { command: 'false' })]), toolResult('toolu_bash2', { isError: true, body: 'EXIT_SENTINEL' })])
  assert.equal(items(failed, 'item/completed')[0].status, 'failed')
  assertAbsent([started, done, failed], 'BEARER_SENTINEL', 'hunter2SENTINEL', 'DESCRIPTION_SENTINEL', 'SHELL_OUTPUT_SENTINEL', 'EXIT_SENTINEL', 'TOOL_RESULT_BODY_SENTINEL')
  assert.equal(t.stats().withheld.toolResultBodies, 2)
})

test('Edit, Write, MultiEdit and NotebookEdit become fileChange with the path only', () => {
  const t = translator()
  const events = feed(t, [assistant('msg_files', [
    toolUse('toolu_edit', 'Edit', { file_path: '/Users/demo/project/a.js', old_string: 'OLD_SENTINEL', new_string: 'NEW_SENTINEL' }),
    toolUse('toolu_write', 'Write', { file_path: '/Users/demo/project/b.md', content: 'CONTENT_SENTINEL' }),
    toolUse('toolu_multi', 'MultiEdit', { file_path: 'relative/c.ts', edits: [{ old_string: 'OLD_SENTINEL', new_string: 'NEW_SENTINEL' }] }),
    toolUse('toolu_nb', 'NotebookEdit', { notebook_path: '/Users/demo/project/d.ipynb', new_source: 'SOURCE_SENTINEL', edit_mode: 'replace' }),
  ]), toolResult('toolu_edit'), toolResult('toolu_write', { isError: true })])
  assert.deepEqual(items(events, 'item/started').map(item => [item.type, item.id, item.changes]), [
    ['fileChange', 'toolu_edit', [{ path: '/Users/demo/project/a.js', kind: { type: 'update' } }]],
    ['fileChange', 'toolu_write', [{ path: '/Users/demo/project/b.md', kind: { type: 'update' } }]],
    ['fileChange', 'toolu_multi', [{ path: 'relative/c.ts', kind: { type: 'update' } }]],
    ['fileChange', 'toolu_nb', [{ path: '/Users/demo/project/d.ipynb', kind: { type: 'update' } }]],
  ])
  assert.deepEqual(items(events, 'item/completed').map(item => [item.id, item.status]), [['toolu_edit', 'completed'], ['toolu_write', 'failed']])
  assertAbsent(events, 'OLD_SENTINEL', 'NEW_SENTINEL', 'CONTENT_SENTINEL', 'SOURCE_SENTINEL')
})

test('mcp__ tools split into server/tool, EG-Desk tools keep their own card, other tools show the name only', () => {
  assert.deepEqual(splitMcpToolName('mcp__github__create_issue'), { server: 'github', tool: 'create_issue' })
  assert.deepEqual(splitMcpToolName('mcp__my_server__do__thing'), { server: 'my_server', tool: 'do__thing' })
  for (const bad of ['mcp__', 'mcp____x', 'mcp__server__', 'mcp__server', 'Bash', 7, null]) assert.equal(splitMcpToolName(bad), null, String(bad))
  const t = translator()
  const events = feed(t, [assistant('msg_mcp', [
    toolUse('toolu_gh', 'mcp__github__create_issue', { title: 'ARGUMENT_SENTINEL' }),
    toolUse('toolu_eg', 'mcp__egdesk__egdesk_browser_observe', { cardId: 'ARGUMENT_SENTINEL' }),
    toolUse('toolu_read', 'Read', { file_path: '/Users/demo/ARGUMENT_SENTINEL' }),
    toolUse('toolu_odd', 'mcp__broken', {}),
    toolUse('toolu_weird', 'name with spaces', {}),
  ]), toolResult('toolu_gh'), toolResult('toolu_eg'), toolResult('toolu_read')])
  assert.deepEqual(items(events, 'item/started'), [
    { id: 'toolu_gh', type: 'mcpToolCall', status: 'inProgress', server: 'github', tool: 'create_issue', durationMs: null },
    { id: 'toolu_eg', type: 'dynamicToolCall', status: 'inProgress', tool: 'egdesk_browser_observe' },
    { id: 'toolu_read', type: 'dynamicToolCall', status: 'inProgress', tool: 'Read' },
    { id: 'toolu_odd', type: 'dynamicToolCall', status: 'inProgress', tool: 'mcp__broken' },
    { id: 'toolu_weird', type: 'dynamicToolCall', status: 'inProgress', tool: 'unknownTool' },
  ])
  assert.deepEqual(items(events, 'item/completed').map(item => [item.id, item.type, item.status]), [
    ['toolu_gh', 'mcpToolCall', 'completed'], ['toolu_eg', 'dynamicToolCall', 'completed'], ['toolu_read', 'dynamicToolCall', 'completed'],
  ])
  assertAbsent(events, 'ARGUMENT_SENTINEL')
})

test('TodoWrite becomes turn/plan/updated with Codex step statuses and a bounded list', () => {
  const t = translator()
  const todos = [
    { content: 'Inspect auth', status: 'completed', activeForm: 'Inspecting' },
    { content: 'Fix token=PLAN_SECRET handling', status: 'in_progress', activeForm: 'Fixing' },
    { content: 'Run tests', status: 'pending', activeForm: 'Running' },
    { content: 'Odd', status: 'weird', activeForm: 'x' },
  ]
  const events = feed(t, [assistant('msg_plan', [toolUse('toolu_todo', 'TodoWrite', { todos })]), toolResult('toolu_todo', { toolUseResult: { oldTodos: [], newTodos: todos } })])
  assert.deepEqual(methods(events), ['turn/plan/updated'])
  assert.equal(events[0].params.explanation, null)
  assert.deepEqual(events[0].params.plan.map(step => step.status), ['completed', 'inProgress', 'pending', 'pending'])
  assert.equal(events[0].params.plan[1].step, publicText('Fix token=PLAN_SECRET handling', 1000))
  assertAbsent(events, 'PLAN_SECRET')
  const many = Array.from({ length: CLAUDE_TRANSLATE_LIMITS.maxPlanSteps + 5 }, (_, i) => ({ content: `Step ${i}`, status: 'pending', activeForm: 's' }))
  const capped = feed(t, [assistant('msg_plan2', [toolUse('toolu_todo2', 'TodoWrite', { todos: many })])])
  assert.equal(capped[0].params.plan.length, CLAUDE_TRANSLATE_LIMITS.maxPlanSteps)
})

test('a foreground Agent call becomes the existing sub-Agent shapes and its messages stay out of the conversation', () => {
  const t = translator()
  const agentInput = { description: 'Find API endpoints', prompt: 'PROMPT_SENTINEL do the work', subagent_type: 'Explore', model: 'sonnet' }
  const events = feed(t, [
    assistant('msg_main', [toolUse('toolu_agent', 'Agent', agentInput)]),
    { type: 'user', ...meta(5), parent_tool_use_id: 'toolu_agent', agent_id: 'agent-a1', message: { role: 'user', content: 'PROMPT_SENTINEL do the work' } },
    { ...assistant('msg_child', [toolUse('toolu_child', 'Bash', { command: 'CHILD_COMMAND_SENTINEL' })]), parent_tool_use_id: 'toolu_agent', agent_id: 'agent-a1' },
    { ...toolResult('toolu_child', { body: 'CHILD_OUTPUT_SENTINEL' }), parent_tool_use_id: 'toolu_agent', agent_id: 'agent-a1' },
    // With --forward-subagent-text a child also sends text and thinking.
    { ...assistant('msg_child2', [{ type: 'thinking', thinking: 'CHILD_THOUGHT_SENTINEL' }, { type: 'text', text: 'CHILD_TEXT_SENTINEL' }]), parent_tool_use_id: 'toolu_agent', agent_id: 'agent-a1' },
    toolResult('toolu_agent', { body: 'FINAL_REPORT_SENTINEL agentId: agent-a1', toolUseResult: { status: 'completed', agentId: 'agent-a1', content: [{ type: 'text', text: 'FINAL_REPORT_SENTINEL' }] } }),
  ])
  assert.deepEqual(methods(events), ['item/started', 'item/completed', 'item/completed'])
  assert.deepEqual(events[0].params.item, {
    id: 'toolu_agent', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress', senderThreadId: THREAD,
    receiverThreadIds: ['toolu_agent'], prompt: 'Find API endpoints', model: 'sonnet', reasoningEffort: null,
    agentsStates: { toolu_agent: { status: 'pendingInit', message: null } },
  })
  assert.deepEqual(events[1].params.item, { id: 'toolu_agent:started', type: 'subAgentActivity', agentThreadId: 'toolu_agent', agentPath: 'Explore', kind: 'started', model: 'sonnet' })
  assert.deepEqual([events[2].params.item.status, events[2].params.item.agentsStates], ['completed', { toolu_agent: { status: 'completed', message: null } }])
  assertAbsent(events, 'PROMPT_SENTINEL', 'CHILD_COMMAND_SENTINEL', 'CHILD_OUTPUT_SENTINEL', 'CHILD_THOUGHT_SENTINEL', 'CHILD_TEXT_SENTINEL', 'FINAL_REPORT_SENTINEL', 'toolu_child')
  assert.equal(t.stats().withheld.subagentMessages, 4)
})

test('a background Agent finishes in a later turn on its original run; the legacy Task name and agent_id pairing work', () => {
  const t = translator()
  const first = feed(t, [
    assistant('msg_bg', [toolUse('toolu_bg', 'Task', { description: 'Audit', prompt: 'PROMPT_SENTINEL', subagent_type: 'general-purpose', run_in_background: true })]),
    toolResult('toolu_bg', { body: 'Launched', toolUseResult: { status: 'async_launched', agentId: 'agent-bg', description: 'Audit', prompt: 'PROMPT_SENTINEL', outputFile: '/tmp/OUTPUT_FILE_SENTINEL' } }),
    result('success'),
  ])
  assert.deepEqual(items(first, 'item/completed').map(item => [item.status, item.agentsStates]), [['completed', { toolu_bg: { status: 'running', message: null } }]])
  assert.deepEqual(t.beginTurn('turn-claude-2'), [{ method: 'turn/started', params: { threadId: THREAD, turnId: 'turn-claude-2', turn: { id: 'turn-claude-2', status: 'inProgress', items: [] } } }])
  const later = feed(t, [
    { type: 'system', subtype: 'task_started', ...meta(6), task_id: 'agent-bg', tool_use_id: 'toolu_bg', description: 'Audit', task_type: 'local_agent' },
    { type: 'system', subtype: 'task_progress', ...meta(7), task_id: 'agent-bg', tool_use_id: 'toolu_bg', description: 'Audit', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, summary: 'PROGRESS_SENTINEL' },
    // A resumed child can lose parent_tool_use_id; agent_id still pairs it.
    { ...assistant('msg_bg_child', [{ type: 'text', text: 'CHILD_TEXT_SENTINEL' }]), agent_id: 'agent-bg' },
    { type: 'system', subtype: 'task_notification', ...meta(8), task_id: 'agent-bg', status: 'failed', output_file: '/tmp/OUTPUT_FILE_SENTINEL', summary: 'SUMMARY_SENTINEL' },
    { type: 'system', subtype: 'task_notification', ...meta(8), task_id: 'agent-bg', status: 'failed', output_file: '', summary: '' },
    { type: 'system', subtype: 'task_started', ...meta(6), task_id: 'shell-1', tool_use_id: 'toolu_unknown', description: 'npm run dev', task_type: 'local_bash' },
  ])
  assert.deepEqual(later.map(event => [event.method, event.params.turnId, event.params.item.type]), [
    ['item/completed', TURN, 'subAgentActivity'],
    ['item/completed', TURN, 'collabAgentToolCall'],
  ])
  assert.deepEqual([later[1].params.item.status, later[1].params.item.agentsStates], ['failed', { toolu_bg: { status: 'errored', message: null } }])
  assertAbsent([first, later], 'PROMPT_SENTINEL', 'OUTPUT_FILE_SENTINEL', 'PROGRESS_SENTINEL', 'SUMMARY_SENTINEL', 'CHILD_TEXT_SENTINEL')
  assert.equal(t.stats().ignored['system/task_progress'], 1)
  assert.equal(t.stats().ignored['system/task_started'], 1)
})

test('result becomes turn/completed with completed, failed (classified) or interrupted, plus public token counts', () => {
  const kindOf = event => publicError(event.params.turn.error, 'TURN_FAILED', 'claude').kind
  const last = events => events.at(-1)

  const ok = translator()
  const okEvents = feed(ok, [
    { ...assistant('msg_u', [{ type: 'text', text: 'Done' }]), context_usage: { model: MODEL, total_tokens: 4200, raw_max_tokens: 200000, percentage: 2.1, categories: [], mcp_tools: [], memory_files: [{ path: '/Users/demo/MEMORY_PATH_SENTINEL', type: 'x', tokens: 1 }], agents: [] } },
    result('success'),
  ])
  assert.deepEqual(methods(okEvents), ['item/completed', 'thread/tokenUsage/updated', 'turn/completed'])
  assert.deepEqual(okEvents[1].params.tokenUsage, {
    last: { totalTokens: 4200 }, modelContextWindow: 200000,
    total: { inputTokens: 230, cachedInputTokens: 200, cacheWriteInputTokens: 10, outputTokens: 30, totalTokens: 260 },
  })
  assert.deepEqual(last(okEvents).params.turn, { id: TURN, status: 'completed', items: [], error: null, durationMs: 1234 })
  assertAbsent(okEvents, 'RESULT_TEXT_SENTINEL', 'MEMORY_PATH_SENTINEL', 'total_cost', '0.42')

  const maxTurns = last(feed(translator(), [result('error_max_turns')]))
  assert.deepEqual([maxTurns.params.turn.status, maxTurns.params.turn.error.code, maxTurns.params.turn.error.kind, kindOf(maxTurns)], ['failed', 'error_max_turns', 'model', 'model'])
  assertAbsent([maxTurns], 'ERRORS_SENTINEL')

  const budget = last(feed(translator(), [result('error_max_budget_usd')]))
  assert.deepEqual([budget.params.turn.error.kind, kindOf(budget)], ['quota', 'quota'])

  // The assistant error notice is withheld; the turn reports the classified code.
  const limited = translator()
  const limitedEvents = feed(limited, [assistant('msg_err', [{ type: 'text', text: 'API_ERROR_TEXT_SENTINEL' }], { error: 'rate_limit' }), result('error_during_execution')])
  assert.deepEqual([last(limitedEvents).params.turn.error.code, last(limitedEvents).params.turn.error.kind, kindOf(last(limitedEvents))], ['rate_limit', 'quota', 'quota'])
  assertAbsent(limitedEvents, 'API_ERROR_TEXT_SENTINEL')
  assert.equal(limited.stats().withheld.errorNotices, 1)

  const rejected = translator()
  const resetsAt = 1_800_000_000
  const rejectedEvents = feed(rejected, [{ type: 'rate_limit_event', ...meta(), rate_limit_info: { status: 'rejected', resetsAt, utilization: 1 } }, result('error_during_execution')])
  assert.deepEqual(rejectedEvents[0], { method: 'egdesk/engine/rateLimit', params: { threadId: THREAD, turnId: TURN, engineId: 'claude', status: 'rejected', resetsAt: resetsAt * 1000, utilization: 1, creditsRequired: false } })
  assert.deepEqual([last(rejectedEvents).params.turn.error.kind, last(rejectedEvents).params.turn.error.retryAt], ['quota', resetsAt * 1000])

  const auth = last(feed(translator(), [result('success', { is_error: true, api_error_status: 401, result: 'Invalid API key RESULT_TEXT_SENTINEL' })]))
  assert.deepEqual([auth.params.turn.status, auth.params.turn.error.code, auth.params.turn.error.kind, kindOf(auth)], ['failed', 'http_401', 'auth', 'auth'])
  assertAbsent([auth], 'RESULT_TEXT_SENTINEL', 'Invalid API key')

  const unknown = last(feed(translator(), [result('error_during_execution')]))
  assert.deepEqual([unknown.params.turn.error.kind, kindOf(unknown)], ['unknown', 'unknown'])

  const aborted = last(feed(translator(), [result('error_during_execution', { terminal_reason: 'aborted_streaming' })]))
  assert.deepEqual([aborted.params.turn.status, aborted.params.turn.error], ['interrupted', null])

  const stopped = translator()
  stopped.markInterruptRequested()
  assert.equal(last(feed(stopped, [result('success')])).params.turn.status, 'interrupted')
  // The flag lasts one turn.
  assert.equal(last(feed(stopped, [result('success')])).params.turn.status, 'completed')
})

test('system/api_retry becomes error {willRetry:true} whose kind is classifyClaudeError and survives publicError', () => {
  const categories = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error', 'rate_limit', 'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown', 'Brand New Category']
  for (const category of categories) {
    const retry = { type: 'system', subtype: 'api_retry', ...meta(), attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: category }
    const events = feed(translator(), [retry])
    assert.deepEqual(methods(events), ['error'], category)
    const { error, willRetry } = events[0].params
    const expected = classifyClaudeError(retry)
    assert.equal(willRetry, true)
    assert.deepEqual([error.kind, error.code, error.origin], [expected.kind, expected.code, 'claude'], category)
    assert.equal(publicError(error, 'TURN_ERROR', 'claude').kind, expected.kind, `${category} through publicError`)
    assert.equal(error.message, `Claude is retrying an API request (${expected.code}, attempt 2 of 10)`)
  }
})

test('a denied tool ends declined, and its later error result is not a second completion', () => {
  const t = translator()
  const events = feed(t, [
    assistant('msg_deny', [toolUse('toolu_rm', 'Bash', { command: 'rm -rf build' }), toolUse('toolu_sub', 'Agent', { description: 'x', prompt: 'y' })]),
    { type: 'system', subtype: 'permission_denied', ...meta(), tool_name: 'Bash', tool_use_id: 'toolu_rm', message: 'DENY_MESSAGE_SENTINEL', decision_reason: 'REASON_SENTINEL' },
    toolResult('toolu_rm', { isError: true, body: 'Permission denied' }),
    { type: 'system', subtype: 'permission_denied', ...meta(), tool_name: 'Agent', tool_use_id: 'toolu_sub', message: 'm' },
    { type: 'system', subtype: 'permission_denied', ...meta(), tool_name: 'Bash', tool_use_id: 'toolu_child', agent_id: 'agent-x', message: 'm' },
  ])
  assert.deepEqual(items(events, 'item/completed').map(item => [item.id, item.status]), [['toolu_rm', 'declined'], ['toolu_sub', 'failed']])
  assertAbsent(events, 'DENY_MESSAGE_SENTINEL', 'REASON_SENTINEL')
  assert.equal(t.stats().dropped.duplicateToolResults, 1)
})

test('unknown, malformed and untranslated input is ignored and counted, never turned into events', () => {
  const t = translator()
  const inputs = [
    'not json', '[1,2]', '42', '{"foo":1}', '', '   \n',
    line({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool' } }),
    line({ type: 'system', subtype: 'brand_new_thing', ...meta() }),
    line({ type: 'system', subtype: 'compact_boundary', ...meta(), compact_metadata: { trigger: 'auto', pre_tokens: 9000 } }),
    line({ type: 'tool_progress', ...meta(), tool_use_id: 't', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 3 }),
    line({ type: 'user', ...meta(), parent_tool_use_id: null, isReplay: true, message: { role: 'user', content: 'REPLAY_SENTINEL' } }),
    line(toolResult('toolu_never_started')),
    line(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ARG_SENTINEL' } })),
  ]
  for (const input of inputs) assert.deepEqual(t.translate(input), [], JSON.stringify(input))
  // Odd shapes from either transport must not throw or invent events.
  const odd = [
    { type: 'assistant', message: null }, { type: 'assistant', message: { content: 'text' } }, { type: 'assistant', message: { id: 'm', content: [null, 5, { type: 'tool_use' }] } },
    { type: 'user', message: { content: 'plain' } }, { type: 'user', message: { content: [null, { type: 'tool_result' }] } },
    { type: 'stream_event', event: 5 }, { type: 'stream_event', event: { type: 'content_block_start', index: -1 } },
    { type: 'result' }, { type: 'rate_limit_event' }, { type: 'system' }, { type: 'system', subtype: 'task_notification' },
  ]
  const oddEvents = odd.flatMap(value => t.translate(value))
  // Only a bare result still closes the turn, with an honest unknown failure.
  assert.deepEqual(oddEvents.map(event => event.method), ['turn/completed'])
  assert.deepEqual([oddEvents[0].params.turn.status, oddEvents[0].params.turn.error.kind], ['failed', 'unknown'])
  const stats = t.stats()
  assert.deepEqual([stats.invalidJson, stats.notMessage, stats.blank, stats.translateErrors], [1, 3, 2, 0])
  assert.equal(stats.unrecognized.control_request, 1)
  assert.equal(stats.unrecognized['system/brand_new_thing'], 1)
  assert.equal(stats.ignored['system/compact_boundary'], 1)
  assert.equal(stats.ignored.tool_progress, 1)
  assert.equal(stats.ignored['user/replay'], 1)
  assert.equal(stats.ignored['stream_event/input_json_delta'], 1)
  assert.equal(stats.dropped.orphanToolResults, 2)
  assert.equal(stats.lines, inputs.length + odd.length)
})

test('size limits drop oversized lines, cap text and bound every retained map', () => {
  const t = translator({ limits: { maxLineChars: 300, maxAgentText: 10, maxPendingTools: 2, maxToolNames: 3, maxCounterKeys: 2 } })
  assert.deepEqual(t.translate(line(assistant('msg_big', [{ type: 'text', text: 'x'.repeat(400) }]))), [])
  assert.equal(t.stats().oversized, 1)
  // Objects (Agent SDK path) have no line length; their text is capped instead.
  const capped = t.translate(assistant('msg_obj', [{ type: 'text', text: 'abcdefghijKLMNOP' }]))
  assert.equal(capped[0].params.item.text, 'abcdefghij')
  assert.equal(t.stats().dropped.truncatedText, 1)
  t.translate(assistant('m1', [toolUse('t1', 'Read', {}), toolUse('t2', 'Read', {}), toolUse('t3', 'Read', {})]))
  assert.equal(t.stats().dropped.evicted, 1)
  assert.deepEqual(t.translate(toolResult('t1')), [])
  assert.equal(t.translate(toolResult('t3'))[0].params.item.status, 'completed')
  const init = t.translate({ ...INIT })
  assert.deepEqual(init[0].params.engine.tools, INIT.tools.slice(0, 3))
  assert.equal(init[0].params.engine.toolsTruncated, true)
  for (const subtype of ['a_one', 'b_two', 'c_three']) t.translate({ type: 'system', subtype })
  // At most maxCounterKeys named keys; the rest share 'other'.
  assert.deepEqual(Object.keys(t.stats().unrecognized).sort(), ['other', 'system/a_one', 'system/b_two'])
})

test('without message_start or partial messages, text still completes under unique fallback ids', () => {
  const t = translator()
  const events = feed(t, [
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'orphan' } }),
    assistant('msg_np', [{ type: 'text', text: 'First' }]),
    assistant('msg_np', [toolUse('toolu_np', 'Read', {})]),
    assistant('msg_np', [{ type: 'text', text: 'Second' }]),
  ])
  assert.equal(t.stats().dropped.deltasWithoutMessage, 1)
  assert.deepEqual(items(events, 'item/completed').map(item => [item.id, item.text]), [['msg_np:m0', 'First'], ['msg_np:m1', 'Second']])
})

test('constructor and beginTurn reject ids the runtime would not accept', () => {
  assert.throws(() => createClaudeTranslator({}), TypeError)
  assert.throws(() => createClaudeTranslator({ threadId: 'x'.repeat(301) }), TypeError)
  assert.throws(() => createClaudeTranslator({ threadId: THREAD, turnId: 5 }), TypeError)
  const t = createClaudeTranslator({ threadId: THREAD })
  assert.throws(() => t.beginTurn(''), TypeError)
  assert.equal(t.translate(INIT)[0].params.turnId, null)
})

// The translated stream drives the real chat runtime unchanged (Codex-shaped input).
function runtimeHarness() {
  let turns = 0, threads = 0
  const chat = new CodexChatRuntime({
    request: async method => {
      if (method === 'thread/start') return { thread: { id: `thread-${++threads}` }, cwd: '/Users/demo/project', model: MODEL }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
  })
  chat.setConnection(true)
  return chat
}

test('the existing runtime renders a translated Claude turn: answer, redacted command, file, plan and sub-Agent row', async () => {
  const chat = runtimeHarness()
  const run = await chat.send({ message: 'Fix the bug' })
  const t = createClaudeTranslator({ threadId: run.conversationId, turnId: run.runId })
  const events = feed(t, [
    { ...INIT, session_id: run.conversationId },
    streamEvent({ type: 'message_start', message: { id: 'msg_r', content: [] } }),
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SECRET_THOUGHT_SENTINEL' } }),
    assistant('msg_r', [{ type: 'thinking', thinking: 'SECRET_THOUGHT_SENTINEL', signature: 's' }]),
    streamEvent({ type: 'content_block_stop', index: 0 }),
    assistant('msg_r', [toolUse('toolu_todo', 'TodoWrite', { todos: [{ content: 'Patch', status: 'in_progress', activeForm: 'Patching' }] })]),
    assistant('msg_r', [toolUse('toolu_bash', 'Bash', { command: 'deploy --token sk-live-RUNTIME_SECRET' })]),
    toolResult('toolu_bash', { body: 'SHELL_OUTPUT_SENTINEL' }),
    assistant('msg_r', [toolUse('toolu_edit', 'Edit', { file_path: '/Users/demo/project/src/a.js', old_string: 'a', new_string: 'b' })]),
    toolResult('toolu_edit'),
    assistant('msg_r', [toolUse('toolu_agent', 'Agent', { description: 'Check tests', prompt: 'PROMPT_SENTINEL', subagent_type: 'Explore' })]),
    { ...assistant('msg_c', [toolUse('toolu_c', 'Read', {})]), parent_tool_use_id: 'toolu_agent', agent_id: 'agent-r' },
    toolResult('toolu_agent', { body: 'FINAL_REPORT_SENTINEL' }),
    ...streamedText('msg_r2', 0, ['Fixed ', 'the bug.']),
    result('success'),
  ])
  for (const event of events) await chat.handleNotification(event)
  const state = chat.snapshot().runs[0]
  assert.equal(state.status, 'completed')
  assert.equal(state.error, null)
  assert.deepEqual(state.messages.filter(message => message.role === 'assistant').map(message => [message.text, message.status]), [['Fixed the bug.', 'complete']])
  const activity = id => state.activities.find(entry => entry.id === id)
  assert.deepEqual([activity('toolu_bash').status, activity('toolu_bash').detail.command], ['completed', publicText('deploy --token sk-live-RUNTIME_SECRET', 2000)])
  assert.deepEqual(activity('toolu_edit').detail.changes, [{ path: '/Users/demo/project/src/a.js', kind: 'update' }])
  assert.deepEqual(activity(`${run.runId}:plan`).detail.plan, [{ step: 'Patch', status: 'inProgress' }])
  assert.deepEqual(state.subAgents.map(row => [row.threadId, row.label, row.state, row.taskPreview, row.lastTool]), [['toolu_agent', 'Explore', 'completed', 'Check tests', 'spawnAgent']])
  // last = the latest main assistant message usage: 12 input + 100 cache read + 5 output.
  assert.deepEqual([state.contextUsage.usedTokens, state.contextUsage.modelContextWindow], [117, null])
  assertAbsent(state, 'SECRET_THOUGHT_SENTINEL', 'RUNTIME_SECRET', 'SHELL_OUTPUT_SENTINEL', 'PROMPT_SENTINEL', 'FINAL_REPORT_SENTINEL', 'TOOL_RESULT_BODY_SENTINEL')
})

test('the existing runtime shows a translated retry and a classified Claude failure', async () => {
  const chat = runtimeHarness()
  const run = await chat.send({ message: 'Try' })
  const t = createClaudeTranslator({ threadId: run.conversationId, turnId: run.runId })
  const events = feed(t, [
    { type: 'system', subtype: 'api_retry', ...meta(), attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: 'rate_limit' },
    result('error_max_budget_usd'),
  ])
  const seen = []
  for (const event of events) { await chat.handleNotification(event); seen.push(structuredClone(chat.snapshot().runs[0].error)) }
  assert.deepEqual([seen[0].kind, seen[0].code], ['quota', 'TURN_ERROR'])
  const state = chat.snapshot().runs[0]
  assert.deepEqual([state.status, state.error.kind, state.error.code, state.error.message], ['failed', 'quota', 'TURN_FAILED', 'Claude could not finish the turn (error_max_budget_usd)'])
})
