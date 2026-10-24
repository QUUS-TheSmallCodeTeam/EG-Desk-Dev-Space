import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  CLAUDE_ADAPTER_DEFAULTS, CLAUDE_CAPABILITIES, claudeRpcThreadId, claudeStartError, claudeTurnContent, createClaudeEngineAdapter,
} from './claude-engine-adapter.mjs'
import { ENGINE_CAPABILITIES, validateEngineAdapter } from './engine-adapter.mjs'
import { EngineRegistry, publicEngineRow } from './engine-registry.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

const EXE = '/Users/test/.local/bin/claude'
const CWD = '/Users/test/project'
const BASE_ENV = Object.freeze({ HOME: '/Users/test', PATH: '/usr/bin:/bin', USER: 'test', LANG: 'ko_KR.UTF-8' })
const SIGNED_IN = Object.freeze({
  installed: true, version: '2.1.300', versionStatus: 'untested', checkedAt: 1,
  auth: { status: 'signedIn', method: 'claudeai', label: 'Claude Max', account: 'Owner@Example.com', planType: 'max' },
})
const TOOL_SPECS = [{ type: 'function', name: 'egdesk_list_context', description: 'List context', inputSchema: { type: 'object', properties: {} } }]

const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

// A fake `claude`: stdin lines land in child.written; child.send writes a stdout line.
function fakeChild({ answerInterrupt = true } = {}) {
  const child = new EventEmitter()
  child.pid = 4000 + Math.floor(Math.random() * 1000)
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.written = []
  child.exited = false
  let buffer = ''
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', data => {
    buffer += data
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      child.written.push(message)
      const subtype = message.type === 'control_request' ? message.request.subtype : null
      if (subtype === 'initialize' || (subtype === 'interrupt' && answerInterrupt)) {
        child.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })
      }
    }
  })
  child.stdin.on('end', () => child.exit(0, null))
  child.kill = signal => { child.exit(null, signal); return true }
  child.exit = (code, signal) => {
    if (child.exited) return
    child.exited = true
    child.stdout.end()
    child.stderr.end()
    setImmediate(() => { child.emit('exit', code, signal); setImmediate(() => child.emit('close', code, signal)) })
  }
  child.send = message => child.stdout.write(JSON.stringify(message) + '\n')
  child.userLines = () => child.written.filter(message => message.type === 'user')
  child.controlResponses = () => child.written.filter(message => message.type === 'control_response')
  return child
}

const init = (sessionId, extra = {}) => ({
  type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-test', cwd: CWD, claude_code_version: '2.1.300',
  permissionMode: 'manual', apiKeySource: 'none', tools: ['Read', 'Bash', 'mcp__egdesk__egdesk_list_context'], mcp_servers: [{ name: 'egdesk', status: 'connected' }],
  capabilities: ['interrupt_receipt_v1'], ...extra,
})
// One streamed answer and the result, as `claude -p --output-format stream-json --include-partial-messages` writes it.
function answer(child, sessionId, text = 'ok', messageId = 'msg_1') {
  child.send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'message_start', message: { id: messageId } } })
  child.send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  child.send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
  child.send({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 3, output_tokens: 1 } } })
  child.send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })
  child.send({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, duration_ms: 12, usage: { input_tokens: 3, output_tokens: 1 } })
}

function harness({ check = SIGNED_IN, env = BASE_ENV, childOptions = {}, ...options } = {}) {
  const children = [], spawns = [], timers = []
  let current = check
  let ids = 0
  const statusChanges = { count: 0 }
  const adapter = createClaudeEngineAdapter({
    snapshot: () => current, refreshStatus: async () => current,
    env, platform: 'darwin', defaultCwd: CWD,
    resolveExecutable: () => EXE,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: timer => { if (timer) timer.cleared = true },
    onStatusChange: () => { statusChanges.count++ },
    transportOptions: {
      managedMcpConfig: false,
      spawnImpl: (file, args, opts) => {
        const child = fakeChild(childOptions)
        children.push(child)
        spawns.push({ file, args, opts })
        process.nextTick(() => child.emit('spawn'))
        return child
      },
      execFileImpl: (file, args, opts, callback) => process.nextTick(() => callback(null, '2.1.300 (Claude Code)\n', '')),
      timeouts: { closeGraceMs: 200, closeTermMs: 100, closeKillMs: 100, exitCloseFallbackMs: 50 },
    },
    ...options,
  })
  const events = { notifications: [], requests: [], connections: [] }
  adapter.subscribe({
    notification: (engineId, message) => { assert.equal(engineId, 'claude'); events.notifications.push(message) },
    serverRequest: (engineId, message) => events.requests.push(message),
    connection: (engineId, state) => events.connections.push(state),
  })
  const methods = () => events.notifications.map(message => message.method)
  const liveTimers = ms => timers.filter(timer => !timer.cleared && (ms === undefined || timer.ms === ms))
  return { adapter, children, spawns, events, methods, timers, liveTimers, statusChanges, setCheck: next => { current = next } }
}

async function firstTurn(h, params = {}, text = 'Reply with exactly: ok') {
  const started = await h.adapter.startThread({ dynamicTools: TOOL_SPECS, ...params })
  const turn = await h.adapter.startTurn({ threadId: started.thread.id, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: 'req-1' })
  return { threadId: started.thread.id, turnId: turn.turn.id, child: h.children.at(-1), started, turn }
}

test('the adapter meets the EngineAdapter contract and publishes a ready Claude row from the static check', () => {
  const { adapter } = harness()
  validateEngineAdapter(adapter)
  assert.equal(adapter.id, 'claude')
  assert.ok(CLAUDE_CAPABILITIES.every(name => ENGINE_CAPABILITIES.includes(name)))
  assert.deepEqual([...adapter.capabilities()], [...CLAUDE_CAPABILITIES])
  for (const absent of ['nativeHistory', 'boundedQa', 'ephemeralThreads', 'threadFork', 'approvals.tool']) assert.equal(adapter.capabilities().has(absent), false, absent)
  assert.equal(adapter.isReady(), true)
  assert.equal(adapter.models(), null, 'no model list is invented')
  assert.equal(adapter.request, undefined, 'no Codex escape hatch: profile-off sends no instructions')
  assert.equal(adapter.forkThread, undefined)
  assert.equal(adapter.ownerKey(), 'claude:claudeai:owner@example.com')
  const row = publicEngineRow(adapter.describe())
  assert.deepEqual(row, {
    id: 'claude', label: 'Claude', status: 'ready', version: '2.1.300', versionSupported: null, versionStatus: 'untested', installed: true, isDefault: false,
    capabilities: [...CLAUDE_CAPABILITIES],
    profiles: [{ id: 'claude-default', label: 'Claude Max', credentialStore: 'claude-cli', active: true,
      auth: { status: 'signedIn', method: 'claudeai', account: 'Owner@Example.com', planType: 'max' }, usage: null }],
    runtime: { residentProcesses: 0, residentLimit: 2, idleTimeoutMs: 300000 }, models: null,
  })
  assert.equal(/\/Users\/test|\.local\/bin/.test(JSON.stringify(row)), false, 'no executable or folder path in the row')
})

test('install, version range, init gate and sign-in decide the row, and a not-ready engine refuses before anything runs', async () => {
  const cases = [
    [{ installed: null, version: null, auth: null }, 'offline', 'notChecked', 'ENGINE_UNAVAILABLE'],
    [{ installed: false, version: null, auth: null }, 'notInstalled', undefined, 'ENGINE_NOT_INSTALLED'],
    [{ ...SIGNED_IN, version: null }, 'versionUnsupported', 'versionUnknown', 'ENGINE_VERSION_UNSUPPORTED'],
    [{ ...SIGNED_IN, version: '2.1.204', versionStatus: 'unsupported' }, 'versionUnsupported', 'belowMinimum', 'ENGINE_VERSION_UNSUPPORTED'],
    [{ ...SIGNED_IN, auth: { status: 'signedOut' } }, 'loginRequired', undefined, 'ENGINE_LOGIN_REQUIRED'],
    [{ ...SIGNED_IN, auth: { status: 'unknown' } }, 'offline', 'authUnknown', 'ENGINE_UNAVAILABLE'],
  ]
  for (const [check, status, reason, code] of cases) {
    const h = harness({ check })
    const row = publicEngineRow(h.adapter.describe())
    assert.deepEqual([row.status, row.statusReason], [status, reason], status)
    assert.equal(h.adapter.isReady(), false)
    await assert.rejects(h.adapter.startThread({}), error => error.code === code && error.definite === true, code)
    assert.equal(h.spawns.length, 0)
  }
  // 2.2.0 prereleases compare on their core version.
  assert.equal(harness({ check: { ...SIGNED_IN, version: '2.2.0-beta.1' } }).adapter.isReady(), true)
  const disposed = harness()
  await disposed.adapter.dispose()
  assert.equal(disposed.adapter.describe().status, 'disabled')
  await assert.rejects(disposed.adapter.startThread({}), { code: 'ENGINE_UNAVAILABLE' })
})

test('a new conversation starts claude on its first turn with the isolation flags, EG-Desk MCP only and the user line after initialize', async () => {
  const h = harness()
  const started = await h.adapter.startThread({ dynamicTools: TOOL_SPECS, model: 'claude-test', developerInstructions: 'Be brief.' })
  assert.match(started.thread.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual([started.cwd, started.model, started.thread.ephemeral], [CWD, 'claude-test', false])
  assert.equal(h.spawns.length, 0, 'no process before the first turn')
  const turn = await h.adapter.startTurn({ threadId: started.thread.id, input: [{ type: 'text', text: 'Reply with exactly: ok', text_elements: [] }], effort: 'low' })
  assert.equal(turn.turn.status, 'inProgress')
  const [{ file, args, opts }] = h.spawns
  assert.equal(file, EXE)
  assert.equal(opts.cwd, CWD)
  assert.equal(opts.shell, false)
  for (const flag of ['-p', '--verbose', '--strict-mcp-config', '--disable-slash-commands', '--include-partial-messages', '--setting-sources=', `--session-id=${started.thread.id}`, '--system-prompt-snapshot=off', '--append-system-prompt=Be brief.']) {
    assert.ok(args.includes(flag), flag)
  }
  const value = flag => args[args.indexOf(flag) + 1]
  assert.deepEqual([value('--permission-prompt-tool'), value('--settings'), value('--permission-mode'), value('--model'), value('--effort'), value('--allowedTools')],
    ['stdio', '{"disableAllHooks":true}', 'manual', 'claude-test', 'low', 'mcp__egdesk'])
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: { egdesk: { type: 'sdk', name: 'egdesk' } } })
  assert.equal(args.some(arg => arg.startsWith('--resume')), false)
  assert.equal(opts.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
  assert.equal(opts.env.HOME, '/Users/test', 'login stays shared')
  const child = h.children[0]
  assert.deepEqual(child.written.map(message => message.type === 'control_request' ? message.request.subtype : message.type), ['initialize', 'user'])
  assert.deepEqual(child.userLines()[0].message, { role: 'user', content: 'Reply with exactly: ok' })
  assert.deepEqual(h.methods(), ['turn/started'])
  assert.equal(h.events.notifications[0].params.turn.id, turn.turn.id)
  // The CLI answers; the runtime receives Codex-shaped events for this turn only.
  child.send(init(started.thread.id))
  answer(child, started.thread.id)
  await until(() => h.methods().includes('turn/completed'))
  // thread/started (the engine summary from system/init) is forwarded; the runtime keeps only child threads from it.
  assert.deepEqual(h.methods(), ['turn/started', 'thread/started', 'item/started', 'item/agentMessage/delta', 'item/completed', 'thread/tokenUsage/updated', 'turn/completed'])
  assert.ok(h.events.notifications.slice(1).every(message => message.params.threadId === started.thread.id && message.params.turnId === turn.turn.id))
  const summary = h.events.notifications[1].params.engine
  assert.deepEqual([summary.id, summary.sessionIdMatches, summary.permissionMode, summary.apiKeySource], ['claude', true, 'manual', 'none'])
  assert.equal(h.events.notifications.at(-1).params.turn.status, 'completed')
  assert.equal(h.events.notifications.find(message => message.method === 'item/completed').params.item.text, 'ok')
  assert.equal(h.adapter.stats().activeTurns, 0)
  assert.equal(h.liveTimers(CLAUDE_ADAPTER_DEFAULTS.idleTimeoutMs).length, 1, 'idle timer armed after the turn')
  assert.equal(h.adapter.describe().runtime.residentProcesses, 1)
})

test('a later turn reuses the process; a new model or effort restarts it with --resume; folder and effort are checked', async () => {
  const h = harness()
  const { threadId, child } = await firstTurn(h)
  child.send(init(threadId))
  answer(child, threadId)
  await until(() => h.methods().includes('turn/completed'))
  await h.adapter.startTurn({ threadId, input: [{ type: 'text', text: 'again' }] })
  assert.equal(h.spawns.length, 1, 'same process')
  assert.equal(child.userLines().length, 2)
  answer(child, threadId, 'two', 'msg_2')
  await until(() => h.methods().filter(method => method === 'turn/completed').length === 2)
  await assert.rejects(h.adapter.startTurn({ threadId, input: [{ type: 'text', text: 'x' }], effort: 'ultra' }), error => error.code === 'EFFORT_UNSUPPORTED' && error.httpStatus === 400 && error.definite)
  await assert.rejects(h.adapter.startTurn({ threadId, input: [{ type: 'text', text: 'x' }], cwd: '/Users/test/other' }), error => error.code === 'CWD_CHANGE_UNSUPPORTED' && error.definite)
  await assert.rejects(h.adapter.startTurn({ threadId, input: [{ type: 'text', text: 'x' }], model: '--dangerously-skip-permissions' }), { code: 'INVALID_MODEL' })
  await h.adapter.startTurn({ threadId, input: [{ type: 'text', text: 'switch' }], model: 'claude-other' })
  assert.equal(child.exited, true, 'old process closed')
  assert.equal(h.spawns.length, 2)
  const args = h.spawns[1].args
  assert.ok(args.includes(`--resume=${threadId}`))
  assert.equal(args.some(arg => arg.startsWith('--session-id')), false)
  assert.equal(args[args.indexOf('--model') + 1], 'claude-other')
  await assert.rejects(h.adapter.startTurn({ threadId, input: [{ type: 'text', text: 'busy' }] }), error => error.code === 'RUN_IN_PROGRESS' && error.definite)
})

test('approvals and questions become runtime server requests, and answers go back as control responses', async () => {
  const h = harness()
  const { threadId, turnId, child } = await firstTurn(h)
  child.send({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu_1', input: { command: 'ls' }, title: 'Claude wants to run ls' } })
  await until(() => h.events.requests.length === 1)
  const approval = h.events.requests[0]
  assert.equal(approval.method, 'item/commandExecution/requestApproval')
  assert.deepEqual([approval.params.threadId, approval.params.turnId, approval.params.itemId, approval.params.command, approval.params.cwd], [threadId, turnId, 'toolu_1', 'ls', CWD])
  assert.deepEqual(approval.params.availableDecisions, ['accept', 'acceptForSession', 'decline', 'cancel'])
  assert.equal(claudeRpcThreadId(approval.id), threadId)
  assert.equal(h.adapter.owns(approval.id), true)
  assert.equal(h.adapter.owns('claude:00000000-0000-4000-8000-999999999999:perm:1'), false)
  assert.equal(h.adapter.owns(42), false, 'a Codex id is never claimed')
  assert.equal(h.adapter.respond(approval.id, { decision: 'accept' }), true)
  await until(() => child.controlResponses().length === 1)
  assert.deepEqual(child.controlResponses()[0].response, { subtype: 'success', request_id: 'perm-1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } })
  assert.equal(h.adapter.respond(approval.id, { decision: 'accept' }), false, 'answered once')
  // AskUserQuestion: skip is allow with empty answers.
  child.send({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_2', input: { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] } } })
  await until(() => h.events.requests.length === 2)
  const question = h.events.requests[1]
  assert.equal(question.method, 'item/tool/requestUserInput')
  assert.equal(question.params.questions[0].multiSelect, true)
  h.adapter.respond(question.id, { answers: { q0: { answers: ['A', 'B'] } } })
  await until(() => child.controlResponses().length === 2)
  assert.deepEqual(child.controlResponses()[1].response.response.updatedInput.answers, { 'Which?': 'A, B' })
  // An EG-Desk tool call through the in-process MCP server.
  child.send({ type: 'control_request', request_id: 'mcp-1', request: { subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'egdesk_list_context', arguments: {} } } } })
  await until(() => h.events.requests.length === 3)
  const call = h.events.requests[2]
  assert.deepEqual([call.method, call.params.tool, call.params.turnId], ['item/tool/call', 'egdesk_list_context', turnId])
  // While a call waits, the process is not put to sleep.
  child.send({ type: 'result', subtype: 'success', is_error: false, session_id: threadId })
  await until(() => h.methods().includes('turn/completed'))
  assert.equal(h.liveTimers(CLAUDE_ADAPTER_DEFAULTS.idleTimeoutMs).length, 0)
  assert.equal(h.adapter.respond(call.id, { success: true, contentItems: [{ type: 'inputText', text: '[]' }] }), true)
  await until(() => child.controlResponses().length === 3)
  assert.deepEqual(child.controlResponses()[2].response.response.mcp_response, { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: '[]' }] } })
  assert.equal(h.liveTimers(CLAUDE_ADAPTER_DEFAULTS.idleTimeoutMs).length, 1, 'idle once nothing waits')
  // A tool EG-Desk cannot show a card for is refused without asking.
  child.send({ type: 'control_request', request_id: 'perm-2', request: { subtype: 'can_use_tool', tool_name: 'WebFetch', tool_use_id: 'toolu_3', input: { url: 'https://example.com' } } })
  await until(() => child.controlResponses().length === 4)
  assert.equal(child.controlResponses()[3].response.response.behavior, 'deny')
  assert.equal(h.events.requests.length, 3)
})

test('D-S4: an API key in EG-Desk\'s environment stops new starts until confirmed, and the key never reaches claude', async () => {
  const env = { ...BASE_ENV, ANTHROPIC_API_KEY: 'PRIVATE_TEST_VALUE' }
  const h = harness({ env })
  const row = publicEngineRow(h.adapter.describe())
  assert.deepEqual([row.status, row.statusReason], ['ready', 'CLAUDE_API_KEY_DETECTED'])
  await assert.rejects(h.adapter.startThread({}), error => error.code === 'CLAUDE_API_KEY_DETECTED' && error.httpStatus === 409 && error.definite === true
    && JSON.stringify(error.detected) === '["ANTHROPIC_API_KEY"]' && !JSON.stringify(error).includes('PRIVATE'))
  assert.equal(h.spawns.length, 0)
  assert.deepEqual(h.adapter.apiKeyEnv(), { detected: ['ANTHROPIC_API_KEY'], confirmed: false })
  assert.deepEqual(h.adapter.confirmApiKeyEnv(), { detected: ['ANTHROPIC_API_KEY'], confirmed: true })
  assert.equal(publicEngineRow(h.adapter.describe()).statusReason, undefined)
  const { child } = await firstTurn(h)
  assert.equal(h.spawns.length, 1)
  assert.equal(Object.hasOwn(h.spawns[0].opts.env, 'ANTHROPIC_API_KEY'), false)
  assert.equal(JSON.stringify(h.spawns[0]).includes('PRIVATE'), false)
  // apiKeySource on system/init says who pays: the row shows per-use billing.
  child.send(init(h.events.notifications[0].params.threadId, { apiKeySource: '/login managed key' }))
  await until(() => h.adapter.usage()?.billing === 'apiKey')
  assert.equal(publicEngineRow(h.adapter.describe()).profiles[0].usage.billing, 'apiKey')
  h.adapter.confirmApiKeyEnv(false)
  await assert.rejects(h.adapter.startThread({}), { code: 'CLAUDE_API_KEY_DETECTED' })
})

test('stop: the interrupt control request ends the turn interrupted; a CLI that does not answer is closed and the turn still ends', async () => {
  const h = harness()
  const { threadId, turnId, child } = await firstTurn(h)
  assert.deepEqual(await h.adapter.interruptTurn(threadId, 'other-turn'), {}, 'another turn id is ignored')
  assert.equal(child.written.some(message => message.request?.subtype === 'interrupt'), false)
  await h.adapter.interruptTurn(threadId, turnId)
  assert.ok(child.written.some(message => message.request?.subtype === 'interrupt'))
  assert.equal(h.liveTimers(CLAUDE_ADAPTER_DEFAULTS.interruptSettleMs).length, 1, 'backstop armed')
  child.send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: threadId, terminal_reason: 'aborted_streaming' })
  await until(() => h.methods().includes('turn/completed'))
  assert.equal(h.events.notifications.at(-1).params.turn.status, 'interrupted')
  assert.equal(h.liveTimers(CLAUDE_ADAPTER_DEFAULTS.interruptSettleMs).length, 0, 'backstop cleared')
  assert.equal(child.exited, false, 'the process stays for the next turn')

  const silent = harness({ childOptions: { answerInterrupt: false }, interruptMs: 20 })
  const stuck = await firstTurn(silent)
  await silent.adapter.interruptTurn(stuck.threadId, stuck.turnId)
  await until(() => silent.methods().includes('turn/completed'))
  const completed = silent.events.notifications.at(-1).params.turn
  assert.deepEqual([completed.id, completed.status, completed.error], [stuck.turnId, 'interrupted', null])
  assert.equal(stuck.child.exited, true)
  // The conversation continues in a new process from its saved session.
  await silent.adapter.startTurn({ threadId: stuck.threadId, input: [{ type: 'text', text: 'continue' }] })
  assert.equal(silent.spawns.length, 2)
})

test('a crashed process ends only its own turn and pending approvals; the next turn resumes the session', async () => {
  const h = harness()
  const { threadId, turnId, child } = await firstTurn(h)
  child.send(init(threadId))
  child.send({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Edit', tool_use_id: 'toolu_9', input: { file_path: `${CWD}/a.js` } } })
  await until(() => h.events.requests.length === 1)
  const rpcId = h.events.requests[0].id
  child.exit(1, null)
  await until(() => h.methods().includes('turn/completed'))
  const resolved = h.events.notifications.find(message => message.method === 'serverRequest/resolved')
  assert.deepEqual(resolved.params, { threadId, turnId, requestId: rpcId })
  const completed = h.events.notifications.find(message => message.method === 'turn/completed').params
  assert.deepEqual([completed.turnId, completed.turn.status, completed.turn.error.code, completed.turn.error.origin], [turnId, 'failed', 'RUNTIME_LOST', 'claude'])
  assert.deepEqual(h.events.connections, [], 'the engine stays connected')
  assert.equal(h.adapter.respond(rpcId, { decision: 'accept' }), false)
  await h.adapter.startTurn({ threadId, input: [{ type: 'text', text: 'again' }] })
  assert.ok(h.spawns[1].args.includes(`--resume=${threadId}`))
})

test('two resident processes at most: a busy third is refused, an idle one makes room, and idle conversations quit after 5 minutes', async () => {
  const h = harness()
  const a = await firstTurn(h)
  const b = await firstTurn(h)
  const c = await h.adapter.startThread({})
  await assert.rejects(h.adapter.startTurn({ threadId: c.thread.id, input: [{ type: 'text', text: 'third' }] }), error => error.code === 'ENGINE_BUSY' && error.httpStatus === 429 && error.definite)
  answer(a.child, a.threadId)
  await until(() => h.events.notifications.some(message => message.method === 'turn/completed' && message.params.threadId === a.threadId))
  await h.adapter.startTurn({ threadId: c.thread.id, input: [{ type: 'text', text: 'third' }] })
  assert.equal(a.child.exited, true, 'the idle conversation made room')
  assert.equal(b.child.exited, false)
  assert.equal(h.adapter.describe().runtime.residentProcesses, 2)
  // Idle timeout: the process quits; the conversation stays and resumes later.
  answer(b.child, b.threadId)
  await until(() => h.events.notifications.some(message => message.method === 'turn/completed' && message.params.threadId === b.threadId))
  const idle = h.liveTimers(CLAUDE_ADAPTER_DEFAULTS.idleTimeoutMs).at(-1)
  idle.fn()
  await until(() => b.child.exited)
  await until(() => h.adapter.describe().runtime.residentProcesses === 1)
})

test('release closes the process and forgets nothing; resume reopens it with --resume, also for a conversation from an earlier run', async () => {
  const h = harness()
  const { threadId, child } = await firstTurn(h)
  child.send(init(threadId))
  answer(child, threadId)
  await until(() => h.methods().includes('turn/completed'))
  assert.deepEqual(await h.adapter.releaseThread(threadId), { status: 'unsubscribed' })
  assert.equal(child.exited, true)
  assert.deepEqual(await h.adapter.releaseThread(threadId), { status: 'notLoaded' })
  await assert.rejects(h.adapter.startTurn({ threadId, input: [{ type: 'text', text: 'x' }] }), error => error.code === 'THREAD_NOT_LOADED' && error.definite)
  await assert.rejects(h.adapter.resumeThread({ threadId, cwd: '/Users/test/elsewhere' }), error => error.code === 'CWD_CHANGE_UNSUPPORTED' && error.definite)
  const resumed = await h.adapter.resumeThread({ threadId, developerInstructions: 'New persona' })
  assert.deepEqual(resumed, { thread: { id: threadId, turns: [], cwd: CWD }, cwd: CWD, model: null })
  await h.adapter.startTurn({ threadId, input: [{ type: 'text', text: 'x' }] })
  assert.ok(h.spawns[1].args.includes(`--resume=${threadId}`))
  assert.ok(h.spawns[1].args.includes('--append-system-prompt=New persona'))
  assert.ok(h.spawns[1].args.includes('--mcp-config'), 'the thread keeps its EG-Desk tools across resume')
  // Unknown here (an earlier helper run): resumed by id; tools come only if the runtime passes them.
  const earlier = '11111111-2222-4333-8444-555555555555'
  await h.adapter.resumeThread({ threadId: earlier })
  await h.adapter.startTurn({ threadId: earlier, input: [{ type: 'text', text: 'hi' }] })
  assert.ok(h.spawns[2].args.includes(`--resume=${earlier}`))
  assert.equal(h.spawns[2].args.includes('--mcp-config'), false)
  await assert.rejects(h.adapter.resumeThread({ threadId: 'codex-thread-1' }), error => error.code === 'THREAD_NOT_FOUND' && error.httpStatus === 404)
  await assert.rejects(h.adapter.resumeThread({ threadId }), error => error.code === 'RUN_IN_PROGRESS', 'not while a turn runs')
})

test('usage limits are kept for display only (D-S5) and a refused init marks this claude version unusable', async () => {
  const h = harness()
  const { threadId, child } = await firstTurn(h)
  const resetsAt = Math.floor(Date.now() / 1000) + 3600
  child.send({ type: 'rate_limit_event', session_id: threadId, rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.81, resetsAt: resetsAt + 86400 } })
  child.send({ type: 'rate_limit_event', session_id: threadId, rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } })
  await until(() => h.adapter.usage()?.rejected)
  const usage = publicEngineRow(h.adapter.describe()).profiles[0].usage
  assert.equal(usage.level, 'limit')
  assert.equal(usage.autoResume, false)
  assert.deepEqual(usage.rejected, { window: 'fiveHour', resetsAt: resetsAt * 1000 })
  assert.deepEqual(usage.windows.map(row => [row.window, row.status]), [['fiveHour', 'rejected'], ['weekly', 'allowed_warning']])
  assert.ok(h.methods().includes('egdesk/engine/rateLimit'), 'the runtime receives the same notice')
  assert.ok(h.statusChanges.count > 0)
  // Nothing is sent by itself after the limit.
  assert.equal(child.userLines().length, 1)

  const gated = harness()
  gated.adapter.syncStatus()
  assert.deepEqual(gated.events.connections, [{ ready: true }])
  const g = await firstTurn(gated)
  const { capabilities, ...noCapabilities } = init(g.threadId)
  g.child.send(noCapabilities)
  await until(() => gated.methods().includes('turn/completed'))
  const turn = gated.events.notifications.at(-1).params.turn
  assert.deepEqual([turn.status, turn.error.code], ['failed', 'CLAUDE_CAPABILITIES_MISSING'])
  assert.deepEqual([gated.adapter.describe().status, gated.adapter.describe().statusReason], ['versionUnsupported', 'CLAUDE_CAPABILITIES_MISSING'])
  assert.deepEqual(gated.events.connections, [{ ready: true }, { ready: false }])
  // A new claude version clears the mark.
  gated.setCheck({ ...SIGNED_IN, version: '2.1.301' })
  assert.equal(gated.adapter.syncStatus(), true)
})

test('sign-in changes reach the runtime as whole-engine connection events and close running processes', async () => {
  const h = harness({ check: { ...SIGNED_IN, auth: { status: 'signedOut' } } })
  assert.equal(h.adapter.syncStatus(), false)
  assert.deepEqual(h.events.connections, [])
  h.setCheck(SIGNED_IN)
  assert.equal((await h.adapter.refresh()).status, 'ready')
  assert.deepEqual(h.events.connections, [{ ready: true }])
  const { child } = await firstTurn(h)
  h.setCheck({ ...SIGNED_IN, auth: { ...SIGNED_IN.auth, account: 'other@example.com' } })
  h.adapter.syncStatus()
  assert.deepEqual(h.events.connections, [{ ready: true }, { ready: false }, { ready: true }], 'another account restarts the engine state')
  await until(() => child.exited)
  h.setCheck({ ...SIGNED_IN, auth: { status: 'signedOut' } })
  h.adapter.syncStatus()
  assert.deepEqual(h.events.connections.at(-1), { ready: false })
})

test('turn content keeps one text as the SDK prompt line and puts context and images in blocks', () => {
  assert.equal(claudeTurnContent({ input: [{ type: 'text', text: 'Hi', text_elements: [] }] }), 'Hi')
  assert.deepEqual(claudeTurnContent({
    input: [{ type: 'text', text: 'Look' }, { type: 'image', url: 'data:image/png;base64,AAAA' }],
    additionalContext: { egdesk_context: { kind: 'application', value: '{"contract":"egdesk-context-v1"}' }, 'bad key': { value: 'x' } },
  }), [
    { type: 'text', text: '[EG-Desk context: egdesk_context]\n{"contract":"egdesk-context-v1"}' },
    { type: 'text', text: 'Look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ])
  assert.throws(() => claudeTurnContent({ input: [] }), error => error.code === 'EMPTY_MESSAGE' && error.definite)
  assert.throws(() => claudeTurnContent({ input: [{ type: 'text', text: '  ' }] }), { code: 'EMPTY_MESSAGE' })
  assert.throws(() => claudeTurnContent({ input: [{ type: 'image', url: 'https://example.com/a.png' }] }), { code: 'UNSUPPORTED_INPUT' })
  assert.throws(() => claudeTurnContent({ input: [{ type: 'localImage', path: '/etc/passwd' }] }), { code: 'UNSUPPORTED_INPUT' })
  assert.equal(claudeRpcThreadId('claude:00000000-0000-4000-8000-000000000001:mcp:3'), '00000000-0000-4000-8000-000000000001')
  for (const id of [7, 'claude:x:perm:1', 'codex:00000000-0000-4000-8000-000000000001:perm:1', null]) assert.equal(claudeRpcThreadId(id), null)
  assert.deepEqual([claudeStartError({ code: 'CLAUDE_NOT_FOUND' }).code, claudeStartError({ code: 'CLAUDE_VERSION_UNKNOWN' }).code, claudeStartError({ code: 'CLAUDE_CONTROL_TIMEOUT' }).engineCode, claudeStartError(new Error('/secret/path')).message],
    ['ENGINE_NOT_INSTALLED', 'ENGINE_VERSION_UNSUPPORTED', 'CLAUDE_CONTROL_TIMEOUT', 'Claude could not be started'])
})

// The bridge wiring (codex-bridge-server.mjs) in miniature: the Claude
// adapter feeds the same runtime, and runtime answers for Claude ids are
// routed to it through the Codex responder.
test('the chat runtime runs a Claude conversation end to end through the adapter: answer, approval, stop', async () => {
  const h = harness()
  const registry = new EngineRegistry({ defaultEngineId: 'codex' })
  const codexAnswers = []
  registry.register(createCodexEngineAdapter({
    request: async method => { throw new Error(`no Codex call expected: ${method}`) },
    respond: (...args) => h.adapter.owns(args[0]) ? h.adapter.respond(...args) : codexAnswers.push(args),
  }))
  registry.register(h.adapter)
  const chat = new CodexChatRuntime({ engines: registry })
  h.adapter.subscribe({
    notification: (_, message) => { void chat.handleNotification(message) },
    serverRequest: (_, message) => { void chat.handleServerRequest(message) },
    connection: (_, state) => chat.setConnection('claude', state.ready, state.processLost ? { processLost: true } : undefined),
  })
  chat.setConnection(true)
  assert.equal(h.adapter.syncStatus(), true)
  assert.equal(chat.connectionOf('claude'), 'ready')
  const accepted = await chat.send({ message: 'Reply with exactly: ok', engineId: 'claude' })
  assert.equal(accepted.accepted, true)
  const child = h.children[0]
  assert.equal(child.userLines()[0].message.content, 'Reply with exactly: ok')
  const runOf = () => chat.snapshot().runs.find(run => run.runId === accepted.runId)
  assert.deepEqual(runOf().engine, { id: 'claude', version: '2.1.300', engineProfileId: 'claude-default' })
  child.send(init(accepted.conversationId))
  child.send({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu_1', input: { command: 'echo hi' } } })
  await until(() => runOf().pendingApprovals.length === 1)
  const approval = runOf().pendingApprovals[0]
  await chat.replyApproval({ conversationId: accepted.conversationId, runId: accepted.runId, approvalId: approval.approvalId, decision: 'accept' })
  await until(() => child.controlResponses().length === 1)
  assert.equal(child.controlResponses()[0].response.response.behavior, 'allow')
  assert.deepEqual(codexAnswers, [], 'nothing reached Codex')
  answer(child, accepted.conversationId)
  await until(() => runOf().status === 'completed')
  assert.ok(runOf().messages.some(message => message.text === 'ok'))
  // A second turn on the same conversation, then stop.
  const next = await chat.send({ message: 'Count slowly', conversationId: accepted.conversationId })
  assert.equal(h.spawns.length, 1)
  await chat.interrupt({ conversationId: accepted.conversationId, runId: next.runId })
  child.send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: accepted.conversationId, terminal_reason: 'aborted_streaming' })
  await until(() => chat.snapshot().runs.find(run => run.runId === next.runId)?.status === 'interrupted')
  await h.adapter.dispose()
  assert.equal(chat.connectionOf('claude'), 'offline')
  await tick()
})
