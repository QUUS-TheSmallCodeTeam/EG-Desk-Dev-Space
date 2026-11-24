// The advisory command judge inside the real chat runtime: Codex commandExecution notifications and a Claude Bash tool use through
// the real Claude adapter and translator. Virtual clock and timers; fake engine transports; mock decision model. No shell, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'

const KEY = 'egd-synthetic-not-a-key-0008'
const MATRIX = {}
const tick = () => new Promise(resolve => setImmediate(resolve))
const clone = value => JSON.parse(JSON.stringify(value))
const FAILING = 'running 2 tests\nok 1 - adds\n\nnot ok 2 - subtracts zeta-synthetic-fail\n  AssertionError: expected 2, actual 3\n\nSummary: 1 passed, 1 failed\n'

function modelAnswer(question, data) {
  if (question.type === 'predicate') {
    const block = (data?.blocks || []).find(b => `log_${b.id}` === question.name)
    return { name: question.name, type: 'predicate', probability: /not ok|AssertionError/.test(block?.text ?? '') ? 0.93 : 0.06 }
  }
  const tail = String(data?.output_tail ?? ''), offered = question.choices.map(c => c.value)
  const want = /\(y\/N\)/.test(tail) ? 'waiting_yn_input' : /not ok|failed/.test(tail) ? 'completed_error' : offered.includes('completed_ok') ? 'completed_ok' : offered.includes('running_output') ? 'running_output' : 'none'
  const top = offered.includes(want) ? want : offered[0]
  return { name: question.name, type: 'choice', choice: top, confidence: 0.95, probabilities: offered.map(v => ({ value: v, probability: v === top ? 0.95 : 0.05 / Math.max(1, offered.length - 1) })) }
}
function world(t, { judge = null, flow = false } = {}) {
  const root = createPrivateQaTempDirectory('egdesk-engine-command-wiring-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const clock = { t: 7_000_000 }
  const timers = [], requests = []
  const client = createDecisionClient({ getApiKey: () => KEY, recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); requests.push(init.body)
      const data = body.input.find(m => Array.isArray(m.content))?.content?.[0]?.data
      return Response.json({ answers: body.questions.map(q => modelAnswer(q, data)), usage: { input_tokens: 40 } }) } })
  const calibrationLog = openCalibrationLog({ dataDir: root, log: () => {} })
  const decisionContext = { mode: () => 'on', configured: () => true, client, calibrationLog,
    ...(judge ? { commandJudge: { mode: () => judge } } : {}), ...(flow ? { conversationFlow: { mode: () => 'on' } } : {}) }
  const time = { now: () => clock.t, monotonicNow: () => clock.t,
    setTimer: (fn, ms) => { const timer = { fn, at: clock.t + ms }; timers.push(timer); return timer }, clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) } }
  return { clock, timers, requests, calibrationLog, decisionContext, time,
    entries: () => calibrationLog.entries().filter(e => e.feature === 'terminal_state'), carrying: needle => requests.filter(body => body.includes(needle)).length }
}
function codexHarness(t, options = {}) {
  const w = world(t, options)
  const calls = [], events = [], replies = []
  let turnCount = 0, threadCount = 0
  const chat = new CodexChatRuntime({ ...w.time,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `thread-${++threadCount}` }, cwd: '/work', model: 'configured-model' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turnCount}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    },
    respond: (...args) => replies.push(args), emit: event => events.push(event), emitLegacy: () => {}, verifyFile: async () => null, decisionContext: w.decisionContext })
  chat.setConnection(true)
  const settle = async () => { for (let i = 0; i < 6; i++) { await chat.queue; await chat.commandJudgeIdle(); await tick() } }
  const notify = async (method, params) => { await chat.handleNotification({ method, params }); await settle() }
  const advance = async ms => {
    w.clock.t += ms
    for (const timer of w.timers.filter(x => x.at <= w.clock.t).sort((a, b) => a.at - b.at)) { const i = w.timers.indexOf(timer); if (i >= 0) { w.timers.splice(i, 1); timer.fn() } }
    await settle()
  }
  return { ...w, chat, calls, events, replies, notify, advance, settle }
}
const observable = h => JSON.stringify({ replies: h.replies, calls: h.calls.map(c => c.method), events: h.events, runs: h.chat.snapshot().runs },
  (key, value) => (['ts', 'at', 'seq', 'startedAt', 'updatedAt', 'createdAt', 'eventId', 'cursor'].includes(key) ? undefined : value))
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')

async function codexJourney(h) {
  const run = await h.chat.send({ message: 'Run the tests and fix what fails' })
  const base = { threadId: run.conversationId, turnId: run.runId }
  const item = (id, extra) => ({ id, type: 'commandExecution', command: `synthetic-command-${id}`, cwd: '/work', ...extra })
  await h.notify('item/started', { ...base, item: item('cmd-1', { status: 'inProgress' }) })
  await h.notify('item/commandExecution/outputDelta', { ...base, itemId: 'cmd-1', delta: 'running 2 tests\n' })
  await h.advance(2000)
  await h.notify('item/commandExecution/outputDelta', { ...base, itemId: 'cmd-1', delta: FAILING.slice('running 2 tests\n'.length) })
  await h.notify('item/completed', { ...base, item: item('cmd-1', { status: 'failed', exitCode: 1, durationMs: 2100, aggregatedOutput: FAILING }) })
  await h.notify('item/started', { ...base, item: item('cmd-2', { status: 'inProgress' }) })
  await h.notify('item/commandExecution/outputDelta', { ...base, itemId: 'cmd-2', delta: 'Install 12 packages? Proceed? (y/N) ' })
  await h.advance(2000)
  await h.notify('item/completed', { ...base, item: item('cmd-2', { status: 'completed', exitCode: 0, durationMs: 2500, aggregatedOutput: 'Install 12 packages? Proceed? (y/N) ' }) })
  const kept = [h.chat.commandOutput({ ...run, itemId: 'cmd-1' }), h.chat.commandOutput({ ...run, itemId: 'cmd-2' })]
  await h.notify('turn/completed', { ...base, turn: { id: run.runId, status: 'completed', items: [] } })
  return { run, kept }
}

test('Codex: with the flag off or in advisory, everything the engine and the screen can observe is identical; advisory only adds records', async t => {
  const none = codexHarness(t), advisory = codexHarness(t, { judge: 'advisory' })
  const a = await codexJourney(none), b = await codexJourney(advisory)
  assert.equal(observable(advisory), observable(none))
  assert.deepEqual(b.kept, a.kept, 'the kept command output the screen reads is the same')
  assert.deepEqual(advisory.replies, []); assert.deepEqual(none.replies, [], 'the judge answers nothing and sends nothing to the engine')
  assert.equal(none.requests.length, 0); assert.equal(none.entries().length, 0)
  const trail = advisory.chat.engineCommands.advisories().map(x => `${x.check}:${x.state}/${x.source}→${x.would}`)
  MATRIX.codex = { trail, requests: advisory.requests.length, observableBytes: observable(none).length, records: advisory.entries().length }
  assert.deepEqual(trail, ['quiet:running_output/fallback→wait', 'exit:completed_error/fallback→repair', 'quiet:waiting_yn_input/fallback→hand_yes_no', 'exit:completed_ok/runtime→report'])
  const failed = advisory.chat.engineCommands.advisories()[1]
  assert.deepEqual([failed.engine, failed.blocks.enumerated, [...failed.blocks.picked], failed.blocks.source], ['codex', 4, ['b2', 'b3'], 'decision'])
  assert.deepEqual(advisory.entries().map(e => [e.terminal.stream, e.terminal.engine, e.terminal.would, e.terminal.picked ?? null]),
    [['engine', 'codex', 'wait', null], ['engine', 'codex', 'repair', [2, 3]], ['engine', 'codex', 'hand_yes_no', null], ['engine', 'codex', 'report', null]])
  assert.ok(advisory.carrying('zeta-synthetic-fail') >= 1, 'the judge read the output the bridge already keeps for this run')
  assert.equal(advisory.carrying('synthetic-command-'), 0, 'the command line itself is not part of a judge request')
  assert.doesNotMatch(JSON.stringify(advisory.calibrationLog.entries()), /zeta|subtracts|Install|synthetic-command/)
})

test('an Agent whose tool ceiling has terminal none: no command output is sent to the decision model', async t => {
  const h = codexHarness(t, { judge: 'advisory' })
  const run = await h.chat.send({ message: 'Work' })
  h.chat.runs.get(`${run.conversationId}/${run.runId}`).toolCeiling = { browser: 'none', files: 'read', terminal: 'none', network: 'off', mcp: 'none' }
  const base = { threadId: run.conversationId, turnId: run.runId }
  await h.notify('item/started', { ...base, item: { id: 'cmd-1', type: 'commandExecution', command: 'x', cwd: '/work', status: 'inProgress' } })
  await h.notify('item/commandExecution/outputDelta', { ...base, itemId: 'cmd-1', delta: FAILING })
  await h.notify('item/completed', { ...base, item: { id: 'cmd-1', type: 'commandExecution', command: 'x', cwd: '/work', status: 'failed', exitCode: 1, aggregatedOutput: FAILING } })
  assert.equal(h.requests.length, 0)
  assert.deepEqual(h.chat.engineCommands.advisories().map(x => [x.state, x.source, x.fallback, x.blocks.source]), [['completed_error', 'fallback', 'evidence_unavailable', 'runtime']])
})

test('heartbeat: the run\'s command facts join the conversation\'s heartbeat (one provider), and a beat is a check point', async t => {
  const h = codexHarness(t, { judge: 'advisory', flow: true })
  const run = await h.chat.send({ message: 'Run the long test suite', clientThreadId: 'ui-room', requestId: 'req-1' })
  const hb = h.chat.heartbeatFor('ui-room')
  assert.ok(hb, 'the conversation has a heartbeat (conversation flow flag on)')
  assert.deepEqual(hb.snapshot().providers, [], 'no command yet: nothing registered')
  const base = { threadId: run.conversationId, turnId: run.runId }
  await h.notify('item/started', { ...base, item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'inProgress' } })
  await h.notify('item/commandExecution/outputDelta', { ...base, itemId: 'cmd-1', delta: 'running 40 tests\n' })
  assert.deepEqual(hb.snapshot().providers, ['engine_commands'])
  await h.advance(5000); await h.advance(5000) // two beats on the virtual clock
  const facts = hb.facts()
  const row = facts.sources.engine_commands
  MATRIX.heartbeat = { phase: facts.phase, row: { ...row } }
  assert.deepEqual([facts.phase, row.active, row.phase, row.terminal, row.terminalState, row.commandsRunning, row.runningMs, row.quietMs], ['tool_running', true, 'tool_running', 'running', 'running_output', 1, 10_000, 10_000],
    '"tests are still running": running for 10 s, quiet for 10 s, judged still running')
  assert.equal(h.chat.engineCommands.advisories().length, 1, 'the quiet check and two beats on the same tail asked once')
  await h.notify('item/started', { ...base, item: { id: 'cmd-2', type: 'commandExecution', command: 'ls', cwd: '/work', status: 'inProgress' } })
  assert.deepEqual(hb.snapshot().providers, ['engine_commands'], 'still one provider')
  await h.notify('item/completed', { ...base, item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'completed', exitCode: 0, aggregatedOutput: 'running 40 tests\nall passed\n' } })
  await h.notify('item/completed', { ...base, item: { id: 'cmd-2', type: 'commandExecution', command: 'ls', cwd: '/work', status: 'completed', exitCode: 0, aggregatedOutput: 'a\nb\n' } })
  const after = hb.facts().sources.engine_commands
  assert.deepEqual([after.active, after.terminal, after.commandsDone, after.commandsFailed, after.exitCode], [false, 'idle', 2, 0, 0])
  // without the judge flag the heartbeat has no such provider
  const plain = codexHarness(t, { flow: true })
  const run2 = await plain.chat.send({ message: 'Work', clientThreadId: 'ui-room', requestId: 'req-1' })
  await plain.notify('item/started', { threadId: run2.conversationId, turnId: run2.runId, item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'inProgress' } })
  assert.deepEqual(plain.chat.heartbeatFor('ui-room').snapshot().providers, [])
})

test('Claude: a Bash tool use arrives as started/completed with a status only; its output never reaches the bridge runtime, so nothing can be sent', async t => {
  const w = world(t, { judge: 'advisory' })
  const transports = [], events = []
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version: '2.1.300', versionStatus: 'untested', auth: { status: 'signedIn', method: 'claudeai', account: 'owner@example.test', label: 'Claude Max' } }),
    env: {}, defaultCwd: '/work/claude-synthetic', residentLimit: 2, resolveExecutable: () => '/fake/claude', setTimer: (fn, ms) => ({ fn, ms }), clearTimer: () => {},
    createTransport: options => {
      const transport = { options, sent: [], replies: [], closed: false, async start() {}, sendUserMessage(content) { this.sent.push(clone(content)) },
        respondControl(id, answer) { this.replies.push({ id, ...clone(answer) }); return true }, info: () => ({ init: { billsApiKey: false } }), async interrupt() {},
        async close() { if (!this.closed) { this.closed = true; options.onExit() } }, message(message) { options.onMessage(message) } }
      transports.push(transport)
      return transport
    } })
  const codex = createCodexEngineAdapter({ request: async () => { throw new Error('Codex is not used here') }, respond: () => true })
  const chat = new CodexChatRuntime({ ...w.time, engines: [codex, claude], emit: event => events.push(event), verifyFile: async () => null, decisionContext: w.decisionContext })
  const unsubscribe = claude.subscribe({ notification: (_, message) => chat.handleNotification(message), serverRequest: (_, message) => chat.handleServerRequest(message),
    connection: (id, state) => chat.setConnection(id, state.ready, state) })
  claude.syncStatus()
  const drain = async () => { for (let i = 0; i < 6; i++) { await chat.queue; await chat.commandJudgeIdle(); await tick() } }
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain() })
  const run = await chat.send({ message: 'Work', engineId: 'claude', clientThreadId: 'ui-claude', requestId: 'req-1' })
  const transport = transports[0], session = transport.options.sessionId || transport.options.resume
  const meta = () => ({ session_id: session, uuid: randomUUID() })
  const use = (id, command) => transport.message({ type: 'assistant', ...meta(), parent_tool_use_id: null,
    message: { id: `msg-${id}`, type: 'message', role: 'assistant', model: 'claude-synthetic', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  const result = (id, isError) => transport.message({ type: 'user', ...meta(), parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'zeta-synthetic-claude-output\nnot ok 1 - x', is_error: isError }] } })
  use('toolu-1', 'npm test'); await drain(); result('toolu-1', true); await drain()
  use('toolu-2', 'ls'); await drain(); result('toolu-2', false); await drain()
  const live = chat.runs.get(`${run.conversationId}/${run.runId}`)
  assert.deepEqual(live.activities.filter(a => a.kind === 'commandExecution').map(a => [a.status, a.detail.exitCode ?? null]), [['failed', null], ['completed', null]], 'Claude reports a status, never an exit code')
  assert.equal(chat.runOutputs.commandOutput(live.answerId, 'toolu-1'), null, 'no output of a Claude command is kept by the bridge runtime')
  assert.deepEqual(chat.engineCommands.advisories().map(x => [x.engine, x.check, x.state, x.source, x.would, x.blocks ?? null]),
    [['claude', 'exit', 'completed_error', 'runtime', 'repair', null], ['claude', 'exit', 'completed_ok', 'runtime', 'report', null]])
  assert.equal(w.requests.length, 0); assert.equal(w.carrying('zeta-synthetic-claude-output'), 0)
  assert.doesNotMatch(JSON.stringify(events), /zeta-synthetic-claude-output/, 'and it is in no event either')
  MATRIX.claude = { trail: chat.engineCommands.advisories().map(x => `${x.check}:${x.state}/${x.source}→${x.would}`), requests: w.requests.length }
})

test.after(() => { if (process.env.EGDESK_SIM_OUT) writeFileSync(process.env.EGDESK_SIM_OUT, JSON.stringify(MATRIX, null, 2)) })
