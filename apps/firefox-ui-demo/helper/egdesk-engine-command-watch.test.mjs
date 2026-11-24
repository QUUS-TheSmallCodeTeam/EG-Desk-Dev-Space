// Advisory state judge on the engine's own command executions. Real output store (codex-run-outputs.mjs), real judge, real
// decision client and calibration log, real heartbeat; the clock and timers are virtual and the "model" is a mock fetch.
// No engine process, no shell, no network; synthetic output only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { RunOutputStore } from './codex-run-outputs.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createEgressGate, EGRESS_KINDS, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { commandQuestionFacts, createEngineCommandWatch } from './egdesk-engine-command-watch.mjs'
import { beatRequest } from './egdesk-heartbeat-judge.mjs'
import { createHeartbeat } from './egdesk-heartbeat.mjs'
import { observeTerminalLoop } from './egdesk-heartbeat-providers.mjs'
import { enumerateStateOptions, terminalFactRow } from './egdesk-terminal-judge.mjs'

const KEY = 'egd-synthetic-not-a-key-0008'
const MATRIX = {}
const OPEN = { browser: 'interact', files: 'write', terminal: 'ask', network: 'on', mcp: 'all' }
const FAILING = ['running 2 tests', 'ok 1 - adds zeta-synthetic-pass', '', 'not ok 2 - subtracts', '  AssertionError: expected 2, actual 3', '  at math.test.mjs:9:3', '', 'Summary: 1 passed, 1 failed', ''].join('\n')

function modelAnswer(question, data) {
  const tail = String(data?.output_tail ?? '')
  if (question.type === 'predicate') {
    const block = (data.blocks || []).find(b => `log_${b.id}` === question.name)
    return { name: question.name, type: 'predicate', probability: /not ok|AssertionError/.test(block?.text ?? '') ? 0.93 : 0.06 }
  }
  const offered = question.choices.map(c => c.value)
  const want = /\(END\)/.test(tail) ? 'stuck_in_pager' : /\(y\/N\)/.test(tail) ? 'waiting_yn_input' : /not ok|failed/.test(tail) ? 'completed_error'
    : /command not found/.test(tail) ? 'cannot_proceed' : offered.includes('completed_ok') ? 'completed_ok' : 'running_output'
  const top = offered.includes(want) ? want : offered[0]
  return { name: question.name, type: 'choice', choice: top, confidence: 0.95, probabilities: offered.map(v => ({ value: v, probability: v === top ? 0.95 : 0.05 / (offered.length - 1) })) }
}
function rig(t, { flag = 'advisory', decisionMode = 'on', configured = true, ceiling = OPEN, runLive = true, limits } = {}) {
  const root = createPrivateQaTempDirectory('egdesk-engine-command-watch-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const clock = { t: 5_000_000 }
  const timers = []
  const requests = []
  const client = createDecisionClient({ getApiKey: () => KEY, recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); requests.push(init.body)
      return Response.json({ answers: body.questions.map(q => modelAnswer(q, body.input[0].content[0].data)), usage: { input_tokens: 40 } }) } })
  const calibrationLog = openCalibrationLog({ dataDir: root, log: () => {} })
  const store = new RunOutputStore()
  const state = { flag, decisionMode, configured, runLive }
  const watch = createEngineCommandWatch({ flag: () => state.flag, limits, monotonicNow: () => clock.t,
    setTimer: (fn, ms) => { const timer = { fn, at: clock.t + ms }; timers.push(timer); return timer }, clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    decision: { mode: () => state.decisionMode, configured: () => state.configured, client, calibrationLog },
    readOutput: (key, itemId) => store.commandOutput(key, itemId),
    egressFor: () => (state.runLive ? createEgressGate(modelDataPermissions({ toolCeiling: ceiling, runActive: true })) : null) })
  const settle = async () => { for (let i = 0; i < 6; i++) { await watch.idle(); await new Promise(resolve => setImmediate(resolve)) } }
  // The bridge's own sequence for one engine command.
  const start = (itemId, engine = 'codex') => watch.started({ runKey: 'run-1', itemId, engine })
  const out = (itemId, delta) => { store.appendCommandOutput('run-1', itemId, delta); watch.output({ runKey: 'run-1', itemId }) }
  const end = (itemId, exitCode, status = exitCode === 0 ? 'completed' : 'failed', aggregated) => {
    if (aggregated !== undefined) store.completeCommand('run-1', itemId, aggregated)
    watch.completed({ runKey: 'run-1', itemId, exitCode, status })
  }
  const advance = async ms => { // virtual time: run the timers that fall due
    clock.t += ms
    for (const timer of timers.filter(x => x.at <= clock.t).sort((a, b) => a.at - b.at)) { timers.splice(timers.indexOf(timer), 1); timer.fn() }
    await settle()
  }
  const lines = () => watch.advisories().map(a => `${a.check}:${a.state}/${a.source}→${a.would}`)
  return { clock, timers, requests, calibrationLog, store, state, watch, settle, start, out, end, advance, lines, carrying: needle => requests.filter(body => body.includes(needle)).length,
    entries: () => calibrationLog.entries().filter(e => e.feature === 'terminal_state') }
}

test('options come from the engine\'s own facts: running, exit code, or only a failed status', () => {
  assert.deepEqual(enumerateStateOptions({ alive: true }), ['running_output', 'waiting_yn_input', 'waiting_password', 'stuck_in_pager', 'need_user_context', 'cannot_proceed'])
  assert.deepEqual(enumerateStateOptions({ alive: false, exitCode: 2 }), ['completed_error', 'need_user_context', 'cannot_proceed'])
  assert.deepEqual(enumerateStateOptions({ alive: false, exitCode: null, failed: true }), ['completed_error', 'need_user_context', 'cannot_proceed'], 'Claude reports no exit code, only failed')
  assert.ok(enumerateStateOptions({ alive: false, exitCode: 0 }).includes('completed_ok'))
})

test('one run, advisory: what the system WOULD do for each state of the engine\'s commands; nothing is typed, sent back or injected', async t => {
  const r = rig(t)
  // 1) a test command that prints, goes quiet and is still running
  r.start('c1'); r.out('c1', 'running 2 tests\n'); await r.advance(1500)
  // 2) more output, then it ends with exit 1
  r.out('c1', FAILING); r.end('c1', 1, 'failed', 'running 2 tests\n' + FAILING); await r.settle()
  // 3) a command that asks yes/no and waits
  r.start('c2'); r.out('c2', 'Install 12 packages? Proceed? (y/N) '); await r.advance(1500)
  r.end('c2', 0); await r.settle()
  // 4) a pager
  r.start('c3'); r.out('c3', 'commit 3f2a\nAuthor: A <a@example.test>\n(END)'); await r.advance(1500); r.end('c3', 0); await r.settle()
  // 5) a clean exit without a failure mark: settled by rule, no question
  r.start('c4'); r.out('c4', 'src/a.mjs\nsrc/b.mjs\n'); r.end('c4', 0); await r.settle()
  // 6) exit 0 but the output says a test failed: worth a question
  r.start('c5'); r.out('c5', 'ok 1\nnot ok 2 - hidden\nSummary: 1 failed\n'); r.end('c5', 0); await r.settle()
  // 7) exit 127
  r.start('c6'); r.out('c6', 'bash: pnpm: command not found\n'); r.end('c6', 127); await r.settle()
  MATRIX.states = { trail: r.lines(), requests: r.requests.length }
  assert.deepEqual(r.lines(), [
    'quiet:running_output/fallback→wait',
    'exit:completed_error/fallback→repair',
    'quiet:waiting_yn_input/fallback→hand_yes_no',
    'exit:completed_ok/runtime→report',
    'quiet:stuck_in_pager/fallback→hand_close_pager',
    'exit:completed_ok/runtime→report',
    'exit:completed_ok/runtime→report',
    'exit:completed_error/fallback→repair',
    'exit:cannot_proceed/fallback→hand_subjective',
  ])
  assert.ok(r.watch.advisories().every(a => a.acted === false))
  const entries = r.entries()
  assert.equal(entries.length, 9)
  assert.ok(entries.every(e => e.mode === 'advisory' && e.attached === false && e.terminal.stream === 'engine' && e.terminal.engine === 'codex' && e.terminal.acted === false))
  assert.doesNotMatch(JSON.stringify(entries), /subtracts|zeta|Install|commit|example\.test|pnpm|math\.test/, 'records hold no output text')
})

test('error hand-off (recorded only): the log blocks that WOULD be highlighted are the runtime\'s blocks the model picked, as ordinals', async t => {
  const r = rig(t)
  r.start('c1'); r.out('c1', FAILING); r.end('c1', 1); await r.settle()
  const [advisory] = r.watch.advisories()
  assert.deepEqual({ ...advisory.blocks, picked: [...advisory.blocks.picked] }, { enumerated: 4, picked: ['b2', 'b3'], source: 'decision' })
  const [entry] = r.entries()
  assert.deepEqual([entry.candidates, entry.judgedTotal, entry.terminal.picked, entry.terminal.would], [4, 2, [2, 3], 'repair'])
  assert.equal(r.requests.length, 2, 'one state question, one block question')
  assert.equal(r.carrying('zeta-synthetic-pass'), 2, 'the output the run\'s model already has is what the judge reads')
  // decision unavailable: the runtime's own failure marks are used instead, and nothing is sent
  const off = rig(t, { configured: false })
  off.start('c1'); off.out('c1', FAILING); off.end('c1', 1); await off.settle()
  assert.equal(off.requests.length, 0)
  assert.deepEqual([off.watch.advisories()[0].state, off.watch.advisories()[0].source, off.watch.advisories()[0].blocks.source, [...off.watch.advisories()[0].blocks.picked]], ['completed_error', 'fallback', 'runtime', ['b2', 'b3', 'b4']])
  MATRIX.handoff = { picked: [...advisory.blocks.picked], enumerated: advisory.blocks.enumerated, withoutDecision: [...off.watch.advisories()[0].blocks.picked] }
})

test('a password prompt is settled by rule and never sent; Claude gives no output at all, so its commands are judged from status only', async t => {
  const r = rig(t)
  r.start('c1'); r.out('c1', 'Enter passphrase for key zeta-synthetic-key: '); await r.advance(1500)
  assert.deepEqual(r.lines(), ['quiet:waiting_password/rule→hand_secret']); assert.equal(r.requests.length, 0)
  const c = rig(t)
  c.start('t1', 'claude'); await c.advance(4000) // no output ever reaches the bridge for a Claude Bash call
  c.end('t1', null, 'failed'); await c.settle()
  c.start('t2', 'claude'); c.end('t2', null, 'completed'); await c.settle()
  c.start('t3', 'claude'); c.end('t3', null, 'declined'); await c.settle()
  assert.deepEqual(c.lines(), ['exit:completed_error/runtime→repair', 'exit:completed_ok/runtime→report'], 'a declined command never ran and is not judged')
  assert.equal(c.requests.length, 0); assert.equal(c.watch.advisories()[0].blocks, undefined)
  assert.deepEqual(c.entries().map(e => e.terminal.engine), ['claude', 'claude'])
})

test('egress: command_output follows the run\'s model permissions (tool ceiling, live run); mode off or no key means no request', async t => {
  assert.deepEqual([...EGRESS_KINDS.command_output.data], ['terminal', 'run'])
  for (const [name, options] of [['ceiling terminal none', { ceiling: { ...OPEN, terminal: 'none' } }], ['run no longer live', { runLive: false }], ['no key', { configured: false }], ['decision off', { decisionMode: 'off' }]]) {
    const r = rig(t, options)
    r.start('c1'); r.out('c1', 'Proceed? (y/N) zeta-synthetic-output'); await r.advance(1500); r.end('c1', 1); await r.settle()
    assert.equal(r.requests.length, 0, name)
    assert.deepEqual(r.lines(), ['exit:completed_error/fallback→repair'], name)
  }
  const sent = rig(t)
  sent.start('c1'); sent.out('c1', 'Proceed? (y/N) zeta-synthetic-output'); await sent.advance(1500)
  assert.equal(sent.carrying('zeta-synthetic-output'), 1)
  // a gate without the run class (e.g. a Terminal card's world) does not open this kind
  assert.equal(createEgressGate(modelDataPermissions({ toolCeiling: OPEN, runActive: false })).allows('command_output'), false)
  assert.equal(createEgressGate(modelDataPermissions({ toolCeiling: OPEN, runActive: true })).allows('command_output'), true)
})

test('flag off: nothing is tracked, no timer is armed, nothing is asked or recorded', async t => {
  const r = rig(t, { flag: 'off' })
  r.start('c1'); r.out('c1', 'Proceed? (y/N) '); await r.advance(5000); r.end('c1', 1); await r.settle()
  assert.deepEqual([r.timers.length, r.requests.length, r.entries().length, r.watch.advisories().length, r.watch.facts('run-1'), r.watch.snapshot()], [0, 0, 0, 0, null, { runs: 0, commands: 0 }])
})

test('bounded: one quiet tail is judged once, a command has a judgment cap, a run has a request cap', async t => {
  const r = rig(t, { limits: { judgmentsPerCommand: 2, requestsPerRun: 3 } })
  r.start('c1'); r.out('c1', 'building a\n'); await r.advance(1500)
  r.watch.beat('run-1'); r.watch.beat('run-1'); await r.settle()
  assert.equal(r.requests.length, 1, 'beats on an unchanged quiet tail ask nothing more')
  for (const part of ['b', 'c', 'd']) { r.out('c1', `building ${part}\n`); await r.advance(1500) }
  assert.equal(r.requests.length, 2, 'a spinner-like command cannot pass the per-command cap')
  assert.equal(r.timers.length, 0, 'and no quiet timer stays armed for it')
  r.end('c1', 0); await r.settle()
  for (const id of ['c2', 'c3', 'c4']) { r.start(id); r.out(id, 'not ok 1 - x\nSummary: 1 failed\n'); r.end(id, 1); await r.settle() }
  assert.equal(r.requests.length, 3, 'the run\'s request cap holds; later commands fall back to exit code and runtime marks')
  assert.deepEqual(r.watch.advisories().slice(-1).map(a => [a.state, a.source, a.would, a.blocks.source]), [['completed_error', 'fallback', 'repair', 'runtime']])
})

test('one fact-row shape: engine commands, the objective-loop adapter and the Terminal card use the same keys and labels', async t => {
  const r = rig(t)
  assert.equal(r.watch.facts('run-1'), null)
  r.start('c1'); r.out('c1', 'running 40 tests\n'); r.clock.t += 12_000
  assert.deepEqual({ ...r.watch.facts('run-1') }, { active: true, waitingOnUser: false, terminal: 'running', phase: 'tool_running', runningMs: 12_000, quietMs: 12_000, exitCode: null,
    commandsRunning: 1, commandsDone: 0, commandsFailed: 0 })
  r.out('c1', 'Proceed? (y/N) '); await r.advance(1500)
  const waiting = r.watch.facts('run-1')
  assert.deepEqual([waiting.terminal, waiting.terminalState, waiting.terminalWould, waiting.waitingOnUser, waiting.phase], ['waiting', 'waiting_yn_input', 'hand_yes_no', false, 'tool_running'],
    'a judged waiting state is a label; the person is not asked through EG-Desk for an engine command')
  r.end('c1', 1); await r.settle()
  const done = r.watch.facts('run-1')
  assert.deepEqual([done.active, done.terminal, done.phase, done.terminalState, done.exitCode, done.commandsDone, done.commandsFailed, done.runningMs], [false, 'idle', undefined, 'completed_error', 1, 1, 1, null])
  // the adapter L3 built for EG-Desk's own loop goes through the same builder
  const loop = observeTerminalLoop({ judge: async () => ({ state: 'waiting_yn_input' }), runtime: { start: async () => ({}) }, applyFix: async () => {}, human: { approve: async () => true, answer: async () => 'y' } })
  await loop.deps.runtime.start('x'); await loop.deps.judge({})
  assert.deepEqual(loop.facts(), { active: true, phase: 'waiting_user', waitingOnUser: true, stepsDone: 1, repairs: 0, terminal: 'waiting', terminalState: 'waiting_yn_input' })
  const shared = ['active', 'waitingOnUser', 'terminal', 'phase', 'terminalState']
  assert.deepEqual(shared.filter(key => !(key in waiting)), []); assert.deepEqual(shared.filter(key => !(key in loop.facts())), [])
  assert.deepEqual(Object.keys(terminalFactRow({ kind: 'card', running: true, state: 'stuck_in_pager', source: 'decision', would: 'hand_close_pager', runningMs: 5, quietMs: 5 })).sort(),
    ['active', 'exitCode', 'phase', 'quietMs', 'runningMs', 'terminal', 'terminalSource', 'terminalState', 'terminalWould', 'waitingOnUser'])
  assert.doesNotMatch(JSON.stringify([waiting, done]), /Proceed|running 40/)
})

test('heartbeat: the facts pass the heartbeat\'s own sanitizer unchanged and say "a command has been running for N s, quiet for M s"', async t => {
  const r = rig(t)
  const hbClock = { t: 0 }
  const hb = createHeartbeat({ key: 'room', monotonicNow: () => hbClock.t, setTimer: () => ({}), clearTimer: () => {} })
  hb.start({ sinceMs: 0 })
  hb.register('engine_commands', () => r.watch.facts('run-1'))
  assert.deepEqual(hb.facts().sources, {}, 'no command yet: the provider gives nothing')
  r.start('c1'); r.out('c1', 'running 40 tests\n'); r.clock.t += 20_000
  const beat = hb.facts()
  assert.deepEqual({ ...beat.sources.engine_commands }, { ...r.watch.facts('run-1') }, 'nothing is dropped or altered by the heartbeat')
  assert.deepEqual([beat.phase, beat.stepsRunning, beat.sources.engine_commands.runningMs, beat.sources.engine_commands.quietMs], ['tool_running', 1, 20_000, 20_000])
  r.end('c1', 0); await r.settle()
  assert.deepEqual([hb.facts().phase, hb.facts().sources.engine_commands.terminal, hb.facts().sources.engine_commands.terminalState], ['thinking', 'idle', 'completed_ok'])
  MATRIX.heartbeat = { running: { ...beat.sources.engine_commands }, after: { ...hb.facts().sources.engine_commands } }
  hb.stop('run_end')
})

test('question facts for a beat question: the command row becomes closed facts the heartbeat accepts unchanged, and they reach the one beat request', async t => {
  const r = rig(t)
  const fired = []
  const hbClock = { t: 0 }
  const hb = createHeartbeat({ key: 'room', monotonicNow: () => hbClock.t, setTimer: fn => { fired.push(fn); return {} }, clearTimer: () => {} })
  hb.start({ sinceMs: 0 })
  hb.register('engine_commands', { facts: () => r.watch.facts('run-1') }) // facts only: this feature has no question of its own
  // A stand-in for a feature that does ask at a beat (the wait-explaining message question is one): it spreads the command facts into its own question.
  hb.register('waiting', { propose: beat => ({ name: 'need', instructions: 'Should the assistant explain the wait now?', options: [{ value: 'none' }, { value: 'explain_wait' }],
    facts: { ...commandQuestionFacts(beat.facts.sources.engine_commands) } }) })
  const rounds = []
  hb.setJudge(async round => { rounds.push(round); return {} })
  assert.deepEqual(commandQuestionFacts(null), {}); assert.deepEqual(commandQuestionFacts(r.watch.facts('run-1')), {}, 'no command: nothing to add')
  r.start('c1'); r.out('c1', 'running 40 tests zeta-synthetic-output\n'); await r.advance(1500) // judged: still running
  r.clock.t += 18_500; hbClock.t = 20_000
  const expected = { command_running: true, commands_finished: 0, commands_failed: 0, command_running_seconds: 20, seconds_since_command_output: 20, command_state: 'running_output' }
  assert.deepEqual(commandQuestionFacts(r.watch.facts('run-1')), expected)
  fired.shift()(); await new Promise(resolve => setImmediate(resolve)) // one beat
  assert.equal(rounds.length, 1)
  const [question] = rounds[0].questions
  assert.deepEqual({ ...question.facts }, expected, 'the heartbeat\'s own whitelist keeps every fact as given')
  const request = beatRequest({ beat: rounds[0].beat, questions: rounds[0].questions })
  const text = request.input.map(part => part.content).join('\n')
  assert.match(text, /current_phase: tool_running/); assert.match(text, /command_running_seconds: 20\nseconds_since_command_output: 20\ncommand_state: running_output/)
  assert.doesNotMatch(text, /zeta-synthetic-output|running 40 tests/, 'numbers and closed labels only: no output text')
  r.end('c1', 1); await r.settle()
  assert.deepEqual(commandQuestionFacts(r.watch.facts('run-1')), { command_running: false, commands_finished: 1, commands_failed: 1, command_state: 'completed_error' })
  hb.stop('run_end')
})

test.after(() => { if (process.env.EGDESK_SIM_OUT) writeFileSync(process.env.EGDESK_SIM_OUT, JSON.stringify(MATRIX, null, 2)) })
