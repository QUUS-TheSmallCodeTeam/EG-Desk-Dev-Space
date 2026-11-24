// c26 (Main, real engine check-6 why-stopped): the run's live state as current-time evidence for the heartbeat's messages (liveRunLines), and what the runtime keeps of
// the command EG-Desk's own runner is running (run.ownCommandRunning, set when the tool call is dispatched, cleared when the command's conditions are noted). Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { COMMAND_TOOL_NAME, createCommandExecutorProvider, executorAssess } from './egdesk-command-executor.mjs'
import { createGateHookBroker } from './egdesk-gate-hook-broker.mjs'
import { liveRunLines, messageEvidence } from './egdesk-conversation-flow.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const running = { id: 'exec-1', kind: 'dynamicToolCall', status: 'inProgress', detail: { tool: 'egdesk_run_command' } }
const base = () => ({ status: 'inProgress', ownCommandRunning: { callId: 'c1', command: 'sleep 15 && echo done', startedMs: 1000 }, activities: [{ ...running }] })
const hb = { sinceUserMs: 9000, internalMs: 9500, sinceEngineMs: 500, stepsDone: 0, phase: 'tool_running', sources: {} }

test('liveRunLines: still in progress as of now, the command line, its age, not finished; the command line only where the run may send it; nothing for an ended run or another tool', () => {
  const all = liveRunLines({ run: base(), heartbeatFacts: hb, flow: { sent: [] }, allows: () => true })
  assert.deepEqual(all, ['As of now the run is still in progress. Nothing has finished it.',
    'The tool egdesk_run_command is the assistant\'s own command runner. It is running the command `sleep 15 && echo done`, started 9 seconds ago, and the command has not finished yet.'])
  const masked = liveRunLines({ run: base(), heartbeatFacts: hb, flow: { sent: [] }, allows: kind => kind !== 'terminal_command' })
  assert.match(masked[1], /It is running a command, started 9 seconds ago/); assert.doesNotMatch(masked.join('\n'), /sleep 15/)
  assert.deepEqual(liveRunLines({ run: { ...base(), status: 'completed' }, heartbeatFacts: hb, flow: { sent: [] } }), [], 'an ended run says nothing as of now')
  const other = base(); other.activities = [{ ...running, detail: { tool: 'egdesk_read_file' } }]
  assert.equal(liveRunLines({ run: other, heartbeatFacts: hb, flow: { sent: [] } }).length, 1, 'only the generic line: no command is claimed')
  const done = base(); done.activities = [{ ...running, status: 'completed' }]
  assert.equal(liveRunLines({ run: done, heartbeatFacts: hb, flow: { sent: [] } }).length, 1, 'the command step ended: the command is not said to be running')
  assert.deepEqual(liveRunLines({ run: base(), heartbeatFacts: null }), [])
})

test('the message evidence carries those lines (for the check), the beat questions\' material does not change', () => {
  const [, now] = messageEvidence({ kind: 'reply_status', run: base(), heartbeatFacts: hb, flow: { sent: [] }, userText: '명령 돌려줘', allows: () => true, own: new Set(['workNote']) })
  assert.match(now.text, /As of now the run is still in progress/); assert.match(now.text, /the command has not finished yet/)
  assert.equal(now.time, 'present'); assert.equal(now.kind, 'run_state')
})

function harness(t) {
  const dir = fs.realpathSync(createPrivateQaTempDirectory('egdesk-live-run-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const real = path.join(dir, 'project'), empty = path.join(dir, 'engine-folder'); fs.mkdirSync(real); fs.mkdirSync(empty)
  const replies = []; let chat = null, release = null
  const gate = new Promise(resolve => { release = resolve })
  const ledger = createGateHookBroker({ mode: () => 'on', home: '/home/synthetic', assess: executorAssess(async () => ({ approval: false, reasons: [], source: 'decision' }), { home: '/home/synthetic' }) })
  const executor = createCommandExecutorProvider({ mode: () => 'on', ledger, workspaceOf: run => chat.runFolder(run), runner: async () => { await gate; return { exitCode: 0, stdout: '', stderr: '', durationMs: 5 } },
    onConditions: (run, record) => chat.noteOwnCommand(run, record) })
  chat = new CodexChatRuntime({
    request: async method => (method === 'thread/start' ? { thread: { id: 'conv-1' }, cwd: empty } : method === 'turn/start' ? { turn: { id: 'turn-1', status: 'inProgress', items: [] } } : {}),
    respond: (...args) => replies.push(args), emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, toolProviders: [executor], ownTools: { mode: () => 'on', neutralFolder: () => empty },
  })
  chat.setConnection(true)
  return { chat, replies, real, release }
}

test('dispatch records the command being run (the heartbeat\'s evidence) and the conditions clear it', async t => {
  const h = harness(t)
  const run = await h.chat.send({ message: 'run the build', clientThreadId: 'ui', requestId: 'r1', cwd: h.real })
  const call = h.chat.handleServerRequest({ id: 'c1', method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'c1', tool: COMMAND_TOOL_NAME, arguments: { command: 'sleep 15 && echo build-finished' } } })
  const internal = h.chat.runs.get(`${run.conversationId}/${run.runId}`)
  const until = Date.now() + 2000
  while (!internal.ownCommandRunning && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(internal.ownCommandRunning?.command, 'sleep 15 && echo build-finished'); assert.equal(internal.ownCommandRunning?.callId, 'c1')
  h.release(); await call
  const until2 = Date.now() + 3000
  while (internal.ownCommandRunning && Date.now() < until2) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(internal.ownCommandRunning, null, 'the command ended: not running any more')
})
