// c25 (owner decision, from L2's c21 finding): when the person stops a run ("그만해", turn/interrupt, or the run ends or is deleted), EG-Desk's own command executor
// stops the command it is running: the runner sends SIGTERM to the process group, then SIGKILL after its grace period (the time-limit path), the tool result says
// "stopped" (never "ran"), the facts say it was stopped, and its output is never judged as a finished command's. Fake spawn only; nothing runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { createCommandExecutorProvider, COMMAND_TOOL_NAME } from './egdesk-command-executor.mjs'
import { createCommandRunner } from './egdesk-command-runner.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { messageEvidence } from './egdesk-conversation-flow.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

/** A fake spawn: the child prints a first line, then runs until it is killed. stubborn: it ignores SIGTERM (only SIGKILL ends it). */
function fakeProcesses({ stubborn = false } = {}) {
  const spawned = [], signals = []
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    Object.assign(child, { pid: 7000 + spawned.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    spawned.push({ command: args[1], cwd: options.cwd, detached: options.detached, child })
    setImmediate(() => child.stdout.write('removing build/ …\n'))
    return child
  }
  const killGroup = (child, signal) => {
    signals.push([child.pid, signal])
    if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !stubborn)) setImmediate(() => child.emit('close', null, signal))
  }
  return { spawn, killGroup, spawned, signals }
}
const until = async (predicate, ms = 2000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate(), 'condition not reached in time') }
const parse = response => JSON.parse(response.contentItems[0].text)

function executorWith(procs, { decision = { decision: 'allow' } } = {}) {
  const facts = [], conditions = []
  const runner = createCommandRunner({ spawn: procs.spawn, env: { PATH: '/usr/bin' }, killGroup: procs.killGroup, limits: { killGraceMs: 25 } })
  const provider = createCommandExecutorProvider({ mode: () => 'on', ledger: { check: async () => decision }, workspaceOf: () => '/work/project', runner,
    onFacts: (run, row) => facts.push(row), onConditions: (run, record) => conditions.push(record) })
  return { provider, facts, conditions }
}
const call = (provider, run, command, callId = 'c1') => provider.dispatch(run, { callId, tool: COMMAND_TOOL_NAME, arguments: { command } })

test('a destructive-looking command that was approved is stopped mid-run: SIGTERM to the group, SIGKILL after the grace period, reported as stopped with what it printed', async () => {
  const procs = fakeProcesses({ stubborn: true }), { provider, facts, conditions } = executorWith(procs)
  const run = { answerId: 'a1', runId: 'r1', conversationId: 'cv1' }
  const pending = call(provider, run, 'rm -rf build dist node_modules/.cache')
  await until(() => procs.spawned.length === 1)
  assert.equal(procs.spawned[0].detached, true, 'its own process group'); assert.deepEqual(procs.signals, [])
  await until(() => facts.some(row => row.active === true))
  provider.cancelRun(run)
  await until(() => procs.signals.length >= 1)
  assert.deepEqual(procs.signals[0], [7000, 'SIGTERM'], 'the stop is a SIGTERM to the process group first')
  const out = parse(await pending)
  assert.deepEqual(procs.signals, [[7000, 'SIGTERM'], [7000, 'SIGKILL']], 'the command ignored SIGTERM: SIGKILL after the grace period')
  assert.equal(out.status, 'stopped'); assert.equal(out.stopped, true); assert.equal(out.executed, true); assert.equal(out.exitCode, null); assert.equal(out.signal, 'SIGKILL')
  assert.match(out.stdout, /removing build/, 'what ran before it was stopped is reported')
  assert.equal('timedOut' in out, false, 'a stop is not a time limit'); assert.notEqual(out.status, 'ran')
  assert.equal(out.health, 'unknown'); assert.deepEqual(out.healthReasons, ['stopped']); assert.equal(out.tests, undefined)
  const ended = facts.at(-1)
  assert.equal(ended.active, false); assert.equal(ended.stopped, true); assert.equal(ended.exitCode, null); assert.ok(Number.isFinite(ended.durationMs))
  assert.equal(conditions.length, 1); assert.equal(conditions[0].stopped, true); assert.equal(conditions[0].health.health, 'unknown'); assert.equal(conditions[0].exitCode, null)
})

test('a command that obeys SIGTERM ends with it: no SIGKILL, the signal is reported', async () => {
  const procs = fakeProcesses(), { provider } = executorWith(procs)
  const run = { answerId: 'a1', runId: 'r1' }
  const pending = call(provider, run, 'sleep 600')
  await until(() => procs.spawned.length === 1)
  provider.cancelRun(run)
  const out = parse(await pending)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(procs.signals, [[7000, 'SIGTERM']], 'no SIGKILL once it ended: the grace timer is cleared')
  assert.equal(out.status, 'stopped'); assert.equal(out.signal, 'SIGTERM')
})

test('only the stopped run\'s commands stop; a command that was not running is untouched; stopping twice is harmless', async () => {
  const procs = fakeProcesses(), { provider } = executorWith(procs)
  const one = { answerId: 'a1', runId: 'r1' }, two = { answerId: 'a2', runId: 'r2' }
  const first = call(provider, one, 'sleep 600', 'c1'), second = call(provider, two, 'sleep 700', 'c2')
  await until(() => procs.spawned.length === 2)
  provider.cancelRun(one); provider.cancelRun(one)
  assert.equal(parse(await first).status, 'stopped')
  assert.deepEqual(procs.signals.map(s => s[0]), [7000], 'only the first run\'s process group was signalled, once')
  procs.spawned[1].child.emit('close', 0, null)
  assert.equal(parse(await second).status, 'ran', 'the other run finished normally')
  provider.cancelRun({ answerId: 'nobody' }) // nothing running: nothing happens
})

test('a stop that arrives while the command waits for the gate starts nothing; a stopped run starts nothing', async () => {
  const procs = fakeProcesses()
  const slowGate = { check: () => new Promise(resolve => setTimeout(() => resolve({ decision: 'allow' }), 30)) }
  const facts = []
  const provider = createCommandExecutorProvider({ mode: () => 'on', ledger: slowGate, workspaceOf: () => '/work/project',
    runner: createCommandRunner({ spawn: procs.spawn, env: {}, killGroup: procs.killGroup }), onFacts: (run, row) => facts.push(row) })
  const run = { answerId: 'a1', runId: 'r1', conversationId: 'cv' }
  const pending = call(provider, run, 'rm -rf build')
  run.stopRequested = true // the interrupt marked the run while the gate was deciding
  const out = parse(await pending)
  assert.deepEqual([out.status, out.stopped, out.executed], ['stopped', true, false]); assert.equal(procs.spawned.length, 0)
  assert.equal(facts.at(-1).active, false)
})

test('the runner: an already-aborted signal spawns nothing, an abort is not a timeout', async () => {
  const procs = fakeProcesses()
  const runner = createCommandRunner({ spawn: procs.spawn, env: {}, killGroup: procs.killGroup, limits: { killGraceMs: 10 } })
  const controller = new AbortController(); controller.abort()
  assert.deepEqual(await runner({ command: 'rm -rf x', cwd: '/w', signal: controller.signal }), { exitCode: null, signal: null, timedOut: false, aborted: true, softNotice: false, durationMs: 0, stdout: '', stderr: '', truncated: false })
  assert.equal(procs.spawned.length, 0)
  const live = new AbortController(), pending = runner({ command: 'sleep 9', cwd: '/w', signal: live.signal })
  await until(() => procs.spawned.length === 1); live.abort()
  const result = await pending
  assert.equal(result.aborted, true); assert.equal(result.timedOut, false)
})

// ---- end to end through the runtime: the person's interrupt of a run with a command running ----
test('chat.interrupt stops the running command through the runtime: the process group is signalled, the tool result and the run\'s evidence say stopped, never finished', async t => {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-command-stop-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dataDir = path.join(base, 'egdesk-data'), project = path.join(base, 'demo-app')
  fs.mkdirSync(dataDir); fs.mkdirSync(project)
  const procs = fakeProcesses({ stubborn: true })
  let chat = null
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir, spawn: procs.spawn, getChat: () => chat, killGroup: procs.killGroup, home: '/home/synthetic', gitStatus: async () => null })
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0025', recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => Response.json({ answers: JSON.parse(init.body).questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.05 })), usage: { input_tokens: 20 } }) })
  const calls = [], replies = []
  let turns = 0
  chat = new CodexChatRuntime({
    request: async (method, params) => { calls.push([method, params]); if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }; return {} },
    respond: (...args) => replies.push(args), emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:stop',
    toolProviders: wiring.toolProviders, ownTools: wiring.ownTools,
    decisionContext: { mode: () => 'on', configured: () => true, client, calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }), terminalGate: wiring.terminalGate(null) },
  })
  chat.setConnection(true)
  const sent = await chat.send({ message: '빌드 폴더를 정리해줘', clientThreadId: 'ui', requestId: 'r1', cwd: project })
  const run = chat.runFor(sent)
  await chat.handleServerRequest({ id: 'call-1', method: 'item/tool/call', params: { threadId: sent.conversationId, turnId: sent.runId, callId: 'call-1', tool: COMMAND_TOOL_NAME, arguments: { command: 'sleep 600' } } })
  await until(() => procs.spawned.length === 1)
  assert.equal(procs.signals.length, 0, 'running')
  const interrupted = await chat.interrupt({ conversationId: sent.conversationId, runId: sent.runId })
  assert.equal(interrupted.accepted, true)
  await until(() => replies.some(r => r[0] === 'call-1'), 8000) // the runner's own kill grace (2 s) passes first: the command ignores SIGTERM here
  assert.equal(calls.some(([m, p]) => m === 'turn/interrupt' && p.turnId === sent.runId), true, 'the engine was told to stop the turn')
  assert.deepEqual(procs.signals, [[7000, 'SIGTERM'], [7000, 'SIGKILL']])
  const out = JSON.parse(replies.find(r => r[0] === 'call-1')[1].contentItems[0].text)
  assert.equal(out.status, 'stopped'); assert.equal(out.exitCode, null)
  assert.equal(run.ownCommandLast.stopped, true); assert.equal(run.ownCommandLast.health, 'unknown')
  assert.equal(chat.ownCommandFacts(sent.conversationId).stopped, true); assert.equal(chat.ownCommandFacts(sent.conversationId).exit_code, undefined)
})

test('the evidence a message is checked against says the command was stopped, not that it ended or worked', () => {
  const hb = { phase: 'tool_running', stepsDone: 0, workMs: 5000, elapsedMs: 5000 }
  const line = last => messageEvidence({ kind: 'progress', run: { activities: [], ownCommandLast: last }, heartbeatFacts: hb, allows: () => false }).find(i => i.id === 'now').text
  const stopped = line({ stopped: true, exitCode: null, durationMs: 4000, health: 'unknown', healthReasons: ['stopped'], summary: null, worktree: null })
  assert.match(stopped, /was stopped before it finished \(the person stopped the run\); it did not complete/); assert.doesNotMatch(stopped, /ended with exit code/)
  assert.match(line({ stopped: false, exitCode: 0, durationMs: 40, health: 'healthy', healthReasons: ['exit_ok'], summary: null, worktree: null }), /ended with exit code 0/)
})
