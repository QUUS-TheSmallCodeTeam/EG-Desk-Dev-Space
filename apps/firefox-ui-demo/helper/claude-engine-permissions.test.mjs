import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_DECISIONS, CLAUDE_PERMISSION_LIMITS, USER_SKIPPED_CODE, USER_SKIPPED_MESSAGE,
  approvalToPermissionResult, askAnswersToUpdatedInput, buildControlRequest, classifyControlMessage,
  controlErrorResponse, controlSuccessResponse, createClaudePermissionBroker, resolvedNotification,
  routePermissionRequest, serverResponseToPermissionResult,
} from './claude-engine-permissions.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

// Fixtures follow the official control protocol shapes in
// anthropics/claude-agent-sdk-python (_internal/query.py _handle_control_request,
// types.py SDKControlPermissionRequest / PermissionUpdate) — not checked
// against a real claude run (D1 pending). Values are invented.

const THREAD = '7f1c6a52-3b1e-4c1a-9d55-0d6c2b8f4a10'
const TURN = 'turn-claude-1'
const canUseTool = (requestId, request) => ({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', permission_suggestions: null, blocked_path: null, ...request } })
const bash = (extra = {}) => ({ tool_name: 'Bash', tool_use_id: 'toolu_bash', input: { command: 'npm test', description: 'Run tests' }, ...extra })
const edit = (extra = {}) => ({ tool_name: 'Edit', tool_use_id: 'toolu_edit', input: { file_path: '/Users/demo/project/a.js', old_string: 'a', new_string: 'b' }, title: 'Claude wants to edit a.js', ...extra })
const askInput = () => ({ questions: [
  { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }] },
  { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'Cache' }, { label: 'Queue, durable' }] },
] })
const ask = (input = askInput()) => ({ tool_name: 'AskUserQuestion', tool_use_id: 'toolu_ask', input })
const route = (request, extra = {}) => routePermissionRequest(request, { threadId: THREAD, turnId: TURN, rpcId: 'rpc-1', requestId: 'req-1', ...extra })

test('control lines are classified by channel; ordinary SDK messages go to the translator', () => {
  assert.deepEqual(classifyControlMessage(canUseTool('req-1', bash())).kind, 'canUseTool')
  assert.equal(classifyControlMessage(canUseTool('req-1', bash())).requestId, 'req-1')
  assert.equal(classifyControlMessage({ type: 'control_request', request_id: 'r', request: { subtype: 'mcp_message', server_name: 'egdesk', message: {} } }).kind, 'mcpMessage')
  assert.equal(classifyControlMessage({ type: 'control_request', request_id: 'r', request: { subtype: 'hook_callback', callback_id: 'h' } }).kind, 'hookCallback')
  assert.equal(classifyControlMessage({ type: 'control_request', request_id: 'r', request: { subtype: 'request_user_dialog' } }).kind, 'otherRequest')
  assert.deepEqual(classifyControlMessage({ type: 'control_cancel_request', request_id: 'req-9' }), { kind: 'controlCancel', requestId: 'req-9' })
  assert.deepEqual(classifyControlMessage({ type: 'control_response', response: { subtype: 'success', request_id: 'req_1', response: { pid: 1 } } }), { kind: 'controlResponse', requestId: 'req_1', ok: true, response: { pid: 1 }, error: null })
  assert.equal(classifyControlMessage({ type: 'control_response', response: { subtype: 'error', request_id: 'req_2', error: 'nope' } }).error, 'nope')
  assert.equal(classifyControlMessage({ type: 'assistant', message: {} }).kind, 'sdkMessage')
  for (const bad of [null, 5, [], {}, { type: 'control_request' }, { type: 'control_request', request_id: 'r', request: { subtype: 'Bad Subtype' } }, { type: 'control_cancel_request' }, { type: 'control_response', response: {} }]) {
    assert.equal(classifyControlMessage(bad).kind, 'invalid', JSON.stringify(bad))
  }
})

test('envelopes match the SDK control_response / control_request wire shape', () => {
  assert.deepEqual(controlSuccessResponse('req-1', { behavior: 'allow', updatedInput: {} }), { type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: {} } } })
  assert.deepEqual(controlErrorResponse('req-2', 'Unsupported'), { type: 'control_response', response: { subtype: 'error', request_id: 'req-2', error: 'Unsupported' } })
  assert.deepEqual(buildControlRequest('req_3', 'interrupt'), { type: 'control_request', request_id: 'req_3', request: { subtype: 'interrupt' } })
  assert.deepEqual(buildControlRequest('req_4', 'initialize', { hooks: null, systemPromptSnapshot: false, subtype: 'ignored' }).request, { hooks: null, systemPromptSnapshot: false, subtype: 'initialize' })
  assert.throws(() => buildControlRequest('req_5', 'rewind_files'), TypeError)
  assert.throws(() => controlSuccessResponse('', {}), TypeError)
})

test('Bash and file tools become the runtime approval requests with the tool_use id as item', () => {
  const command = route(bash({ title: 'Claude wants to run npm test' }), { cwd: '/Users/demo/project' })
  assert.equal(command.route, 'approval')
  assert.deepEqual(command.serverRequest, { id: 'rpc-1', method: 'item/commandExecution/requestApproval', params: {
    threadId: THREAD, turnId: TURN, itemId: 'toolu_bash', reason: 'Claude wants to run npm test', command: 'npm test', cwd: '/Users/demo/project',
    availableDecisions: ['accept', 'decline', 'cancel'],
  } })
  assert.deepEqual([command.pending.kind, command.pending.toolName, command.pending.requestId, command.pending.rpcId], ['commandExecution', 'Bash', 'req-1', 'rpc-1'])
  assert.ok(Object.isFrozen(command.pending))

  const file = route(edit())
  assert.deepEqual(file.serverRequest, { id: 'rpc-1', method: 'item/fileChange/requestApproval', params: {
    threadId: THREAD, turnId: TURN, itemId: 'toolu_edit', reason: 'Claude wants to edit a.js', availableDecisions: ['accept', 'decline', 'cancel'],
  } })
  for (const name of ['Write', 'MultiEdit', 'NotebookEdit']) assert.equal(route(edit({ tool_name: name })).serverRequest.method, 'item/fileChange/requestApproval', name)
  assert.equal(route(bash({ tool_name: 'PowerShell' })).serverRequest.method, 'item/commandExecution/requestApproval')
  // '이번 대화 동안 허용' is offered only when the screen and runtime support it.
  assert.deepEqual(route(bash(), { offerSessionGrant: true }).serverRequest.params.availableDecisions, ['accept', 'acceptForSession', 'decline', 'cancel'])
  assert.deepEqual(APPROVAL_DECISIONS, ['accept', 'acceptForSession', 'decline', 'cancel'])
})

test('decisions map to PermissionResult: accept keeps the input, cancel interrupts, session grants use destination session', () => {
  const command = route(bash({ permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }] })).pending
  assert.deepEqual(approvalToPermissionResult(command, 'accept'), { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run tests' } })
  assert.deepEqual(approvalToPermissionResult(command, 'acceptForSession'), {
    behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run tests' },
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }],
  })
  assert.deepEqual(approvalToPermissionResult(command, 'decline'), { behavior: 'deny', message: 'User declined tool execution.' })
  assert.deepEqual(approvalToPermissionResult(command, 'cancel'), { behavior: 'deny', message: 'User cancelled tool execution.', interrupt: true })
  assert.deepEqual(approvalToPermissionResult(command, 'yes please'), { behavior: 'deny', message: 'EG-Desk did not grant this tool.' })

  // No usable suggestion: a command is allowed once (a bare "Bash" rule would allow every command).
  const bare = route(bash()).pending
  assert.deepEqual(approvalToPermissionResult(bare, 'acceptForSession'), { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run tests' } })
  const file = route(edit()).pending
  assert.deepEqual(approvalToPermissionResult(file, 'acceptForSession').updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }])
  const accepting = route(edit({ permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] })).pending
  assert.deepEqual(approvalToPermissionResult(accepting, 'acceptForSession').updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])

  // Suggestions that would widen beyond an allow are dropped as a whole bundle.
  for (const unsafe of [
    [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
    [{ type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }],
    [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }],
    [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow' }, { type: 'setMode', mode: 'auto' }],
    [{ type: 'addDirectories', directories: ['/tmp\u0001x'] }],
  ]) {
    const pending = route(edit({ permission_suggestions: unsafe })).pending
    assert.equal(pending.suggestions, null, JSON.stringify(unsafe))
    assert.deepEqual(approvalToPermissionResult(pending, 'acceptForSession').updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }])
  }
  // The approved input is a snapshot: later mutation of the request does not change what Claude runs.
  const request = bash()
  const snap = route(request).pending
  request.input.command = 'rm -rf /'
  assert.equal(approvalToPermissionResult(snap, 'accept').updatedInput.command, 'npm test')
  assert.throws(() => approvalToPermissionResult(route(ask()).pending, 'accept'), TypeError)
})

test('AskUserQuestion becomes a runtime question card with private q<index> ids', () => {
  const routed = route(ask())
  assert.equal(routed.route, 'userInput')
  assert.deepEqual(routed.serverRequest, { id: 'rpc-1', method: 'item/tool/requestUserInput', params: {
    threadId: THREAD, turnId: TURN, itemId: 'toolu_ask', isBlocking: true, questions: [
      { id: 'q0', header: 'DB', question: 'Which database?', options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: null }] },
      { id: 'q1', header: 'Extras', question: 'Which extras?', options: [{ label: 'Cache', description: null }, { label: 'Queue, durable', description: null }], multiSelect: true },
    ],
  } })
  assert.deepEqual(routed.pending.questions, [{ text: 'Which database?', multiSelect: false }, { text: 'Which extras?', multiSelect: true }])
  // Invalid question sets are refused without a card; Claude reads why.
  for (const input of [
    {}, { questions: [] }, { questions: [{ question: '' }] },
    { questions: [{ question: 'Same?', options: [{ label: 'a' }] }, { question: 'Same?', options: [{ label: 'b' }] }] },
    { questions: [{ question: 'Q', options: [{ label: '' }] }] },
    { questions: Array.from({ length: CLAUDE_PERMISSION_LIMITS.maxQuestions + 1 }, (_, i) => ({ question: `Q${i}`, options: [{ label: 'a' }] })) },
    { questions: [{ question: 'Q', header: 'x'.repeat(201), options: [{ label: 'a' }] }] },
  ]) assert.deepEqual(route(ask(input)), { route: 'deny', reason: 'invalidQuestions', result: { behavior: 'deny', message: 'AskUserQuestion called with no valid questions.' } }, JSON.stringify(input))
})

test('answers: pick, typed text, multi-select join, skip as allow with empty answers', () => {
  const { pending } = route(ask())
  const picked = askAnswersToUpdatedInput(pending, { q0: { answers: ['Postgres'] }, q1: { answers: ['Cache', 'Queue, durable'] } })
  assert.equal(JSON.stringify(picked), JSON.stringify({ ...askInput(), answers: { 'Which database?': 'Postgres', 'Which extras?': 'Cache, "Queue, durable"' } }))
  const typed = askAnswersToUpdatedInput(pending, { q0: { answers: ['MySQL please'] } })
  assert.deepEqual(JSON.parse(JSON.stringify(typed.answers)), { 'Which database?': 'MySQL please' })
  const skipped = askAnswersToUpdatedInput(pending, null)
  assert.deepEqual(JSON.parse(JSON.stringify(skipped)), { ...askInput(), answers: {} })
  // Junk values are dropped, never forwarded.
  const junk = askAnswersToUpdatedInput(pending, { q0: { answers: [5, '', 'x'.repeat(CLAUDE_PERMISSION_LIMITS.maxAnswer + 1), 'a\0b'] }, q9: { answers: ['ghost'] } })
  assert.deepEqual(JSON.parse(JSON.stringify(junk.answers)), {})
  // A question text such as "__proto__" stays an ordinary answer key.
  const proto = route(ask({ questions: [{ question: '__proto__', header: 'P', options: [{ label: 'yes' }] }] })).pending
  const protoAnswer = askAnswersToUpdatedInput(proto, { q0: { answers: ['yes'] } })
  assert.equal(JSON.stringify(protoAnswer.answers), '{"__proto__":"yes"}')
  assert.equal(Object.getPrototypeOf(protoAnswer.answers), null)

  assert.deepEqual(JSON.parse(JSON.stringify(serverResponseToPermissionResult(pending, { answers: { q0: { answers: ['SQLite'] } } }))), {
    behavior: 'allow', updatedInput: { ...askInput(), answers: { 'Which database?': 'SQLite' } },
  })
  // The runtime's skip error is a skip (Claude continues), not a refusal.
  assert.equal(USER_SKIPPED_CODE, -32000)
  assert.deepEqual(JSON.parse(JSON.stringify(serverResponseToPermissionResult(pending, null, { code: USER_SKIPPED_CODE, message: USER_SKIPPED_MESSAGE }))), {
    behavior: 'allow', updatedInput: { ...askInput(), answers: {} },
  })
  for (const error of [{ code: -32601, message: 'EG-Desk run is no longer active' }, { code: -32000, message: 'Too many pending user input requests' }, { code: -32602, message: 'Invalid user input request' }]) {
    assert.deepEqual(serverResponseToPermissionResult(pending, null, error), { behavior: 'deny', message: 'EG-Desk could not show this question to the user.' })
  }
})

test('EG-Desk MCP tools are allowed here (checked per call); other tools are refused without a card', () => {
  assert.deepEqual(route({ tool_name: 'mcp__egdesk__egdesk_browser_observe', tool_use_id: 'toolu_m', input: { cardId: 'c1' } }), { route: 'allow', reason: 'egdeskTool', result: { behavior: 'allow', updatedInput: { cardId: 'c1' } } })
  assert.equal(route({ tool_name: 'mcp__egdesk__', tool_use_id: 'toolu_m', input: {} }).route, 'deny')
  assert.equal(route({ tool_name: 'mcp__egdesk__x', tool_use_id: 'toolu_m', input: {} }, { egdeskServer: 'other' }).route, 'deny')
  for (const name of ['WebFetch', 'WebSearch', 'Skill', 'ExitPlanMode', 'mcp__github__create_issue', 'SandboxNetworkAccess']) {
    assert.deepEqual(route({ tool_name: name, tool_use_id: 'toolu_x', input: {} }), { route: 'deny', reason: 'unsupportedTool', result: { behavior: 'deny', message: 'EG-Desk cannot ask the user to approve this tool yet; it was not run.' } }, name)
  }
  for (const bad of [null, {}, { tool_name: 'Bash', input: {} }, { tool_name: 'Bash', tool_use_id: 't', input: 'x' }, { tool_name: 'bad name', tool_use_id: 't', input: {} }]) {
    assert.equal(route(bad).reason, 'invalidRequest', JSON.stringify(bad))
  }
  assert.equal(route(bash({ input: { command: 'x'.repeat(100) } }), { limits: { maxInputChars: 50 } }).reason, 'invalidRequest')
  assert.throws(() => routePermissionRequest(bash(), { threadId: THREAD }), TypeError)
})

test('runtime refusals are plain denies; only an explicit cancel interrupts', () => {
  const { pending } = route(bash())
  assert.deepEqual(serverResponseToPermissionResult(pending, { decision: 'accept' }), { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run tests' } })
  for (const error of [{ code: -32601, message: 'This interactive request is not supported by EG-Desk' }, { code: -32000, message: 'Too many pending approval requests' }, { code: -32601, message: 'No matching EG-Desk run' }]) {
    assert.deepEqual(serverResponseToPermissionResult(pending, null, error), { behavior: 'deny', message: 'EG-Desk could not show this approval; nothing was granted.' })
  }
  assert.deepEqual(serverResponseToPermissionResult(pending, {}), { behavior: 'deny', message: 'EG-Desk could not show this approval; nothing was granted.' })
  assert.deepEqual(resolvedNotification(pending), { method: 'serverRequest/resolved', params: { threadId: THREAD, turnId: TURN, requestId: 'rpc-1' } })
})

test('broker: answers immediately, holds pending, settles once, and handles cancel and process loss', () => {
  const broker = createClaudePermissionBroker({ threadId: THREAD })
  // Hooks are not registered by EG-Desk; unknown control requests fail that one request.
  assert.deepEqual(broker.request({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback', callback_id: 'hook_0' } }), { write: controlErrorResponse('h1', 'Unsupported control request subtype: hook_callback') })
  assert.deepEqual(broker.request({ type: 'assistant' }), {})
  assert.deepEqual(broker.request(canUseTool('w1', { tool_name: 'WebFetch', tool_use_id: 't', input: { url: 'https://example.com' } })).write.response.response.behavior, 'deny')

  const first = broker.request(canUseTool('req-a', bash()), { turnId: TURN, cwd: '/p' })
  assert.equal(first.serverRequest.id, `claude:${THREAD}:perm:2`)
  assert.equal(broker.owns(first.serverRequest.id), true)
  assert.deepEqual(broker.request(canUseTool('req-a', bash()), { turnId: TURN }), {}, 'a repeated request id is ignored')
  assert.deepEqual(broker.respond(first.serverRequest.id, { decision: 'cancel' }), { write: controlSuccessResponse('req-a', { behavior: 'deny', message: 'User cancelled tool execution.', interrupt: true }) })
  assert.equal(broker.respond(first.serverRequest.id, { decision: 'accept' }), null, 'settled once')
  assert.equal(broker.respond('claude:other:perm:1', { decision: 'accept' }), null)

  const second = broker.request(canUseTool('req-b', ask()), { turnId: TURN })
  assert.deepEqual(broker.cancel('req-b'), { notification: { method: 'serverRequest/resolved', params: { threadId: THREAD, turnId: TURN, requestId: second.serverRequest.id } } })
  assert.equal(broker.respond(second.serverRequest.id, { answers: {} }), null, 'abandoned requests are never answered')
  assert.equal(broker.cancel('req-b'), null)

  const third = broker.request(canUseTool('req-c', edit()), { turnId: TURN })
  assert.deepEqual(broker.abortAll(), [{ method: 'serverRequest/resolved', params: { threadId: THREAD, turnId: TURN, requestId: third.serverRequest.id } }])
  assert.equal(broker.size(), 0)

  const tight = createClaudePermissionBroker({ threadId: THREAD, limits: { maxPending: 1 } })
  tight.request(canUseTool('x1', bash()), { turnId: TURN })
  assert.deepEqual(tight.request(canUseTool('x2', bash()), { turnId: TURN }), { write: controlSuccessResponse('x2', { behavior: 'deny', message: 'Too many pending EG-Desk approvals; nothing was granted.' }) })
  assert.throws(() => createClaudePermissionBroker({}), TypeError)
})

function runtimeHarness() {
  let turns = 0, threads = 0
  const replies = []
  const chat = new CodexChatRuntime({
    request: async method => {
      if (method === 'thread/start') return { thread: { id: `thread-${++threads}` }, cwd: '/Users/demo/project' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    },
    respond: (...args) => { replies.push(args) },
    emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
  })
  chat.setConnection(true)
  return { chat, replies }
}

test('the existing runtime shows Claude approval and question cards and its replies become control_responses', async () => {
  const { chat, replies } = runtimeHarness()
  const run = await chat.send({ message: 'Deploy' })
  const broker = createClaudePermissionBroker({ threadId: run.conversationId })
  const relay = () => replies.splice(0).map(([id, result, error]) => broker.respond(id, result, error))

  const command = broker.request(canUseTool('req-1', bash()), { turnId: run.runId, cwd: '/Users/demo/project' })
  await chat.handleServerRequest(command.serverRequest)
  const approval = chat.snapshot().runs[0].pendingApprovals[0]
  assert.deepEqual([approval.kind, approval.command, approval.choices], ['commandExecution', 'npm test', ['accept', 'decline', 'cancel']])
  await chat.replyApproval({ ...run, approvalId: approval.approvalId, decision: 'accept' })
  assert.deepEqual(relay(), [{ write: controlSuccessResponse('req-1', { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run tests' } }) }])

  const file = broker.request(canUseTool('req-2', edit()), { turnId: run.runId })
  await chat.handleServerRequest(file.serverRequest)
  const fileApproval = chat.snapshot().runs[0].pendingApprovals.find(entry => entry.status === 'pending')
  assert.equal(fileApproval.kind, 'fileChange')
  await chat.replyApproval({ ...run, approvalId: fileApproval.approvalId, decision: 'cancel' })
  assert.deepEqual(relay()[0].write.response.response, { behavior: 'deny', message: 'User cancelled tool execution.', interrupt: true })

  const question = broker.request(canUseTool('req-3', ask()), { turnId: run.runId })
  await chat.handleServerRequest(question.serverRequest)
  const input = chat.snapshot().runs[0].pendingUserInputs[0]
  assert.deepEqual(input.questions.map(q => [q.questionId, q.allowsOther, q.options.map(o => o.label)]), [['q0', true, ['Postgres', 'SQLite']], ['q1', true, ['Cache', 'Queue, durable']]])
  await chat.replyUserInput({ ...run, userInputId: input.userInputId, action: 'submit', answers: [{ questionId: 'q0', optionIndex: 1 }, { questionId: 'q1', text: 'Both' }] })
  assert.deepEqual(JSON.parse(JSON.stringify(relay()[0].write.response.response)), { behavior: 'allow', updatedInput: { ...askInput(), answers: { 'Which database?': 'SQLite', 'Which extras?': 'Both' } } })

  const skipped = broker.request(canUseTool('req-4', ask()), { turnId: run.runId })
  await chat.handleServerRequest(skipped.serverRequest)
  const skippedInput = chat.snapshot().runs[0].pendingUserInputs.find(entry => entry.status === 'pending')
  await chat.replyUserInput({ ...run, userInputId: skippedInput.userInputId, action: 'skip' })
  assert.deepEqual(JSON.parse(JSON.stringify(relay()[0].write.response.response)), { behavior: 'allow', updatedInput: { ...askInput(), answers: {} } })

  // A request for a run EG-Desk does not own is refused by the runtime → plain deny.
  const stray = broker.request(canUseTool('req-5', bash()), { turnId: 'turn-unknown' })
  await chat.handleServerRequest(stray.serverRequest)
  assert.deepEqual(relay()[0].write.response.response, { behavior: 'deny', message: 'EG-Desk could not show this approval; nothing was granted.' })

  // control_cancel_request → the runtime's card disappears through serverRequest/resolved.
  const abandoned = broker.request(canUseTool('req-6', bash()), { turnId: run.runId })
  await chat.handleServerRequest(abandoned.serverRequest)
  assert.equal(chat.snapshot().runs[0].pendingApprovals.filter(entry => entry.status === 'pending').length, 1)
  await chat.handleNotification(broker.cancel('req-6').notification)
  assert.equal(chat.snapshot().runs[0].pendingApprovals.filter(entry => entry.status === 'pending').length, 0)
  // The answer map (question text as key) and tool inputs never reach public state.
  const exposed = JSON.stringify(chat.snapshot())
  for (const hidden of ['"Which database?":', '"rpcId"', 'old_string', 'Run tests']) assert.ok(!exposed.includes(hidden), hidden)
})
