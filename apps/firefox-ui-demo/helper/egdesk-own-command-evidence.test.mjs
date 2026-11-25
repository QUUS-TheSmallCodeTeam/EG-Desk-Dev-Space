// c29: the draft check of an answer sees the commands EG-Desk ran itself, with the test runner's own summary line: "테스트가 모두 통과했습니다" is supported by a line that says so,
// and a false one is contradicted by a line that says "1 failed". Before: the run's own commands were content-free references to the check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { COMMAND_TOOL_NAME } from './egdesk-command-executor.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { OWN_COMMAND_LIMITS, ownCommandEntry, ownCommandEvidence } from './egdesk-own-command-evidence.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const PASS = 'ℹ tests 5\nℹ suites 0\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 52.1\n'
const FAIL = 'ℹ tests 5\nℹ suites 0\nℹ pass 4\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 49.3\n'
const until = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate(), 'condition not reached in time') }

test('the entry and the evidence text: a passing run, a failing run, a run without a summary, a stopped run; the quoted line only where command output may go', () => {
  const rec = (exitCode, health, summary, extra = {}) => ({ command: 'node --test', exitCode, durationMs: 1800, health: { health, reasons: [], summary }, worktree: null, ...extra })
  const pass = ownCommandEntry(rec(0, 'healthy', { runner: 'node_test', passed: 5, failed: 0, total: 5, line: 'ℹ pass 5' }))
  assert.ok(Object.isFrozen(pass)); assert.deepEqual([pass.command, pass.exitCode, pass.health, pass.summary.passed, pass.summary.failed], ['node --test', 0, 'healthy', 5, 0])
  const quoted = ownCommandEvidence(pass, 0, { quoteLine: true }), counted = ownCommandEvidence(pass, 0)
  assert.deepEqual([quoted.id, quoted.kind, quoted.source, quoted.pinned], ['own1', 'terminal', 'run', true])
  assert.match(quoted.text, /ran `node --test` with EG-Desk's own command tool; it finished after about 2 seconds with exit code 0, which means the command itself reported success\./)
  assert.match(quoted.text, /Its test runner's own summary line reads "ℹ pass 5" \(5 passed, 0 failed, 5 in total\)\./); assert.doesNotMatch(counted.text, /summary line reads/); assert.match(counted.text, /Its test runner counted 5 passed, 0 failed, 5 in total\./)
  const fail = ownCommandEvidence(ownCommandEntry(rec(1, 'unhealthy', { runner: 'node_test', passed: 4, failed: 1, total: 5, line: 'ℹ fail 1' })), 1, { quoteLine: true })
  assert.match(fail.text, /exit code 1, which means the command itself reported a failure\./); assert.match(fail.text, /\(4 passed, 1 failed, 5 in total\)/); assert.equal(fail.id, 'own2')
  assert.match(ownCommandEvidence(ownCommandEntry(rec(0, 'healthy', null)), 0).text, /No test summary was printed\./)
  assert.match(ownCommandEvidence(ownCommandEntry(rec(0, 'unknown', null)), 0).text, /Whether it fully worked is not confirmed\./)
  const stopped = ownCommandEvidence(ownCommandEntry(rec(null, 'unknown', null, { stopped: true })), 0, { quoteLine: true })
  assert.match(stopped.text, /was stopped before it finished[\s\S]*did not complete/); assert.doesNotMatch(stopped.text, /summary|exit code/)
  assert.match(ownCommandEvidence(ownCommandEntry({ exitCode: null }), 0).text, /ran a command with EG-Desk's own command tool; it ended without an exit code/)
  assert.equal(ownCommandEntry({ command: 'x'.repeat(900) }).command.length, OWN_COMMAND_LIMITS.commandChars)
})

function world(t, outputs) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-evidence-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dataDir = path.join(base, 'egdesk-data'), project = path.join(base, 'demo-app'); fs.mkdirSync(dataDir); fs.mkdirSync(project)
  let n = 0
  const spawn = () => {
    const child = new EventEmitter(), out = outputs[Math.min(n++, outputs.length - 1)]
    Object.assign(child, { pid: 6000 + n, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    setImmediate(() => { child.stdout.write(out.text); setTimeout(() => child.emit('close', out.code, null), 5) })
    return child
  }
  let chat = null
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir, spawn, getChat: () => chat, home: '/home/synthetic', gitStatus: async () => null })
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0029', recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => Response.json({ answers: JSON.parse(init.body).questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.05 })), usage: { input_tokens: 20 } }) })
  const replies = []
  chat = new CodexChatRuntime({
    request: async (method, params) => { if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }; if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }; return {} },
    respond: (...args) => replies.push(args), emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:own-evidence', toolProviders: wiring.toolProviders, ownTools: wiring.ownTools,
    decisionContext: { mode: () => 'on', configured: () => true, client, calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }), terminalGate: wiring.terminalGate(null) },
  })
  chat.setConnection(true)
  return { chat, project, replies, runCommand: (sent, id, command) => chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: sent.conversationId, turnId: sent.runId, callId: id, tool: COMMAND_TOOL_NAME, arguments: { command } } }) }
}

test('end to end: the answer\'s check is offered the run\'s own commands in order with the runner\'s summary lines (a failing run, then the passing re-run), in place of an opaque reference', async t => {
  const w = world(t, [{ text: FAIL, code: 1 }, { text: PASS, code: 0 }])
  const sent = await w.chat.send({ message: '테스트 실패 고쳐 주고 다시 돌려 줘', clientThreadId: 'ui', requestId: 'r1', cwd: w.project })
  const run = w.chat.runFor(sent)
  // the run's activities carry the two tool calls as the engine reports them (dynamic tool calls)
  for (const [i, command] of ['node --test', 'node --test'].entries()) {
    await w.chat.handleNotification({ method: 'item/started', params: { threadId: sent.conversationId, turnId: sent.runId, item: { type: 'dynamicToolCall', id: `call-${i + 1}`, tool: COMMAND_TOOL_NAME, status: 'inProgress', arguments: { command } } } })
    await w.runCommand(sent, `call-${i + 1}`, command); await until(() => w.replies.some(r => r[0] === `call-${i + 1}`))
  }
  assert.deepEqual(run.ownCommands.map(c => [c.command, c.exitCode, c.health, c.summary.passed, c.summary.failed]), [['node --test', 1, 'unhealthy', 4, 1], ['node --test', 0, 'healthy', 5, 0]])
  const items = w.chat.answerFactsEvidence(run)
  const own = items.filter(i => /^own\d/.test(i.id))
  assert.equal(own.length, 2, JSON.stringify(items.map(i => [i.id, i.opaque ?? false])))
  assert.match(own[0].text, /exit code 1[\s\S]*\(4 passed, 1 failed, 5 in total\)/); assert.match(own[1].text, /exit code 0[\s\S]*summary line reads "ℹ tests 5 \/ ℹ pass 5 \/ ℹ fail 0" \(5 passed, 0 failed, 5 in total\)/)
  assert.equal(items.filter(i => i.opaque && i.source === 'tool:dynamicToolCall').length, 0, 'the own commands are no longer content-free references')
})

test('a run with no own command keeps its evidence exactly as before; an own tool call the arbiter never recorded stays a reference', async t => {
  const w = world(t, [{ text: PASS, code: 0 }])
  const sent = await w.chat.send({ message: 'hi', clientThreadId: 'ui', requestId: 'r1', cwd: w.project })
  const run = w.chat.runFor(sent)
  await w.chat.handleNotification({ method: 'item/started', params: { threadId: sent.conversationId, turnId: sent.runId, item: { type: 'dynamicToolCall', id: 'call-9', tool: 'egdesk_read_file', status: 'inProgress', arguments: { path: 'a' } } } })
  assert.equal(run.ownCommands, undefined)
  assert.deepEqual(w.chat.answerFactsEvidence(run).map(i => [i.id, i.opaque === true]), [['tool1', true]], 'another own tool stays a reference')
})
