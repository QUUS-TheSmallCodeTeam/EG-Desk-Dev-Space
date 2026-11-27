// Terminal state judge wiring (advisory first). Real TerminalSessionRegistry + real run watch + real judge + real decision client;
// the processes are fakes and the "model" is a mock fetch. No shell, no PTY, no network, synthetic text only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { createTerminalRunWatch } from './egdesk-terminal-run-watch.mjs'
import { createTerminalStateWatch } from './egdesk-terminal-state-watch.mjs'
import { TerminalSessionRegistry } from './terminal-sessions.mjs'

const KEY = 'egd-synthetic-not-a-key-0007'
const MATRIX = {}
class FakePty {
  constructor() { this.data = new Set(); this.exits = new Set(); this.writes = [] }
  onData(handler) { this.data.add(handler); return { dispose: () => this.data.delete(handler) } }
  onExit(handler) { this.exits.add(handler); return { dispose: () => this.exits.delete(handler) } }
  kill() {}
  write(data) { this.writes.push(data) }
  resize() {}
  output(text) { for (const handler of this.data) handler(text) }
  exit(code = 0) { for (const handler of [...this.exits]) handler({ exitCode: code, signal: 0 }) }
}
function modelAnswer(question, data) {
  const tail = String(data?.output_tail ?? '')
  if (question.type === 'predicate') {
    const block = (data.blocks || []).find(b => `log_${b.id}` === question.name)
    return { name: question.name, type: 'predicate', probability: /✖|AssertionError|expected|actual/.test(block?.text ?? '') ? 0.93 : 0.06 }
  }
  const offered = question.choices.map(c => c.value)
  const want = /\(END\)|--More--/.test(tail) ? 'stuck_in_pager' : /\(y\/N\)|\[Y\/n\]/.test(tail) ? 'waiting_yn_input'
    : /✖|ℹ fail [1-9]/.test(tail) ? 'completed_error' : /ℹ fail 0/.test(tail) ? 'completed_ok' : 'running_output'
  const top = offered.includes(want) ? want : offered[0]
  return { name: question.name, type: 'choice', choice: top, confidence: 0.95, probabilities: offered.map(v => ({ value: v, probability: v === top ? 0.95 : 0.05 / (offered.length - 1) })) }
}
const CRLF = text => text.replace(/\n/g, '\r\n')
const FAILING = CRLF(`✔ adds numbers (0.2ms)
✖ subtracts numbers (0.3ms)
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 28.1

✖ failing tests:

test at test/math.test.mjs:4:1
✖ subtracts numbers (0.3ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  actual: 3
  expected: 2
`)
const PASSING = CRLF(`✔ adds numbers (0.2ms)
✔ subtracts numbers (0.3ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21.4
`)
const OPEN = { browser: 'interact', files: 'write', terminal: 'ask', network: 'on', mcp: 'all' }
const runGate = (ceiling = OPEN) => createEgressGate(modelDataPermissions({ toolCeiling: ceiling, runActive: true }))

function rig(t, { flag = 'advisory', decisionMode = 'on', configured = true, wrap = true, runBound = true, agentOwned = false, ceiling = OPEN, limits } = {}) {
  const root = createPrivateQaTempDirectory('egdesk-terminal-state-watch-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const clock = { t: 1_780_000_000_000 }
  const now = () => clock.t
  const requests = []
  const client = createDecisionClient({ getApiKey: () => KEY, recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); requests.push(init.body)
      return Response.json({ answers: body.questions.map(q => modelAnswer(q, body.input[0].content[0].data)), usage: { input_tokens: 40 } }) } })
  const calibrationLog = openCalibrationLog({ dataDir: root, log: () => {} })
  const state = { flag, decisionMode, configured, agentOwned, runBound }
  const runWatch = createTerminalRunWatch({ now })
  let registry
  const watch = wrap ? createTerminalStateWatch({ runWatch, flag: () => state.flag, now, limits,
    decision: { mode: () => state.decisionMode, configured: () => state.configured, client, calibrationLog },
    egressFor: () => (state.runBound ? runGate(ceiling) : null), isAgentOwned: () => state.agentOwned, sendKey: (id, key) => registry.write(id, key) }) : null
  registry = new TerminalSessionRegistry({ now, runWatch: watch ?? runWatch, onExit: receipt => watch?.noteExit(receipt) })
  const pty = new FakePty()
  registry.register({ id: 'term-1', process: pty, usePty: true, shell: '/bin/zsh', cols: 80, rows: 24 })
  const settle = async () => { for (let i = 0; i < 6; i++) { await watch?.idle(); await new Promise(resolve => setImmediate(resolve)) } }
  return { clock, requests, calibrationLog, state, registry, watch, pty, settle, carrying: needle => requests.filter(body => body.includes(needle)).length }
}

// One scripted Terminal-card session: everything the card gets back and everything the process is sent.
async function scriptedSession(r) {
  const seen = []
  const read = () => seen.push(JSON.stringify(r.registry.read('term-1')))
  const type = text => seen.push(JSON.stringify(r.registry.write('term-1', text)))
  type('npm test\r'); r.pty.output('running tests\r\n'); read(); await r.settle()
  r.clock.t += 2000; read(); await r.settle()
  r.pty.output(FAILING); read(); await r.settle()
  r.clock.t += 2000; read(); await r.settle()
  type('git log\r'); r.pty.output('commit 3f2a\r\nAuthor: A <a@example.test>\r\n(END)'); r.clock.t += 2000; read(); await r.settle()
  type('q'); r.pty.output('\r\n$ '); read(); await r.settle()
  type('npm install\r'); r.pty.output('Install 12 packages? Proceed? (y/N) '); r.clock.t += 2000; read(); await r.settle()
  type('y\r'); r.pty.output(PASSING); r.clock.t += 2000; read(); await r.settle()
  seen.push(JSON.stringify(r.registry.snapshot('term-1')))
  r.pty.exit(0); await r.settle()
  read(); seen.push(JSON.stringify(r.registry.snapshot('term-1')))
  return { seen, writes: [...r.pty.writes] }
}

test('byte-identical Terminal card behaviour: no wrapper = flag off = advisory (reads, writes, run results, process input)', async t => {
  const bare = await scriptedSession(rig(t, { wrap: false }))
  const offRig = rig(t, { flag: 'off' }), off = await scriptedSession(offRig)
  const advRig = rig(t, { flag: 'advisory' }), advisory = await scriptedSession(advRig)
  assert.ok(bare.seen.some(line => line.includes('"runResult"')), 'the scripted session really produced a run result')
  assert.deepEqual(off.seen, bare.seen); assert.deepEqual(off.writes, bare.writes)
  assert.deepEqual(advisory.seen, bare.seen); assert.deepEqual(advisory.writes, bare.writes)
  // off: nothing tracked, nothing asked, nothing recorded
  assert.equal(offRig.requests.length, 0); assert.deepEqual(offRig.watch.terminalFacts(), []); assert.equal(offRig.calibrationLog.entries().length, 0)
  // advisory: the judge really ran and recorded, and still nothing differs
  assert.ok(advRig.requests.length > 0); assert.ok(advRig.calibrationLog.entries().length > 0)
  MATRIX.identical = { reads: bare.seen.length, processWrites: bare.writes.length, advisoryRequests: advRig.requests.length, advisoryRecords: advRig.calibrationLog.entries().length }
})

test('advisory records what the system WOULD do per state, content-free, and sends nothing to the process', async t => {
  const r = rig(t, { agentOwned: false })
  const { writes } = await scriptedSession(r)
  const trail = r.watch.advisories().map(a => `${a.check}:${a.state}/${a.source}→${a.would}${a.acted ? '!' : ''}`)
  MATRIX.advisory = { trail, requests: r.requests.length }
  assert.deepEqual(trail, [
    'read:running_output/fallback→wait',             // the model's pick (shadow) for a quiet, still-running command
    'read:completed_error/runtime→repair',           // the run watch's own parsed result: no state question is asked
    'read:stuck_in_pager/fallback→hand_close_pager', // a person's terminal: the pager is theirs to close
    'read:waiting_yn_input/fallback→hand_yes_no',
    'read:completed_ok/runtime→report',
    'exit:completed_ok/fallback→report',
  ], JSON.stringify(trail))
  assert.deepEqual(writes, ['npm test\r', 'git log\r', 'q', 'npm install\r', 'y\r'], 'only what the person typed reached the process')
  const entries = r.calibrationLog.entries().filter(e => e.feature === 'terminal_state')
  assert.equal(entries.length, trail.length)
  assert.ok(entries.every(e => e.mode === 'advisory' && e.attached === false && e.terminal.acted === false))
  assert.deepEqual(entries.map(e => e.terminal.would), ['wait', 'repair', 'hand_close_pager', 'hand_yes_no', 'report', 'report'])
  assert.deepEqual([entries[1].candidates > 0, entries[1].judgedTotal > 0], [true, true], 'the error blocks that would be handed over are counted')
  assert.doesNotMatch(JSON.stringify(entries), /subtracts|adds numbers|npm|Install|commit|example\.test|Proceed/, 'records hold no terminal text')
})

test('a password prompt is recognised by rule: recorded as hand_secret, and the prompt text never leaves', async t => {
  const r = rig(t)
  r.registry.write('term-1', 'git pull\r'); r.pty.output('Enter passphrase for key zeta-synthetic-key: ')
  r.clock.t += 3000; r.registry.read('term-1'); await r.settle()
  assert.deepEqual(r.watch.advisories().map(a => [a.state, a.source, a.would, a.requests]), [['waiting_password', 'rule', 'hand_secret', 0]])
  assert.equal(r.requests.length, 0); assert.equal(r.carrying('zeta-synthetic-key'), 0)
  r.registry.write('term-1', 'hunter2-synthetic\r'); await r.settle()
  assert.doesNotMatch(JSON.stringify([r.watch.advisories(), r.watch.terminalFacts(), r.calibrationLog.entries()]), /hunter2|passphrase|zeta/)
})

test('egress: a session that belongs to no run (every Terminal card today) sends no terminal text; the tool ceiling closes it too', async t => {
  for (const options of [{ runBound: false }, { runBound: true, ceiling: { ...OPEN, terminal: 'none' } }]) {
    const r = rig(t, options)
    r.registry.write('term-1', 'npm test\r'); r.pty.output('zeta-synthetic-output\r\n' + FAILING); r.clock.t += 2500
    r.registry.read('term-1'); await r.settle()
    r.pty.exit(1); await r.settle()
    assert.equal(r.requests.length, 0, JSON.stringify(options))
    const last = r.watch.advisories().at(-1)
    assert.deepEqual([last.check, last.state, last.source, last.would, last.fallback], ['exit', 'completed_error', 'fallback', 'repair', 'evidence_unavailable'])
  }
  const sent = rig(t, { runBound: true })
  sent.registry.write('term-1', 'npm test\r'); sent.pty.output('zeta-synthetic-output\r\n' + FAILING); sent.clock.t += 2500
  sent.registry.read('term-1'); await sent.settle()
  assert.ok(sent.carrying('zeta-synthetic-output') >= 1, 'a run-bound session whose models may receive terminal output is judged by the model')
})

test('mode and key: no key or Decision mode off means zero requests; the flag never raises the mode above the person\'s own setting', async t => {
  for (const options of [{ configured: false }, { decisionMode: 'off' }]) {
    const r = rig(t, options)
    r.registry.write('term-1', 'git log\r'); r.pty.output('(END)'); r.clock.t += 2500; r.registry.read('term-1'); await r.settle()
    assert.equal(r.requests.length, 0)
  }
  const r = rig(t, { flag: 'on', decisionMode: 'advisory', agentOwned: true })
  r.registry.write('term-1', 'git log\r'); r.pty.output('(END)'); r.clock.t += 2500; r.registry.read('term-1'); await r.settle()
  assert.deepEqual(r.pty.writes, ['git log\r'], 'Decision mode advisory: the pager is not quit even with the flag on')
  assert.equal(r.watch.advisories()[0].would, 'quit_pager'); assert.equal(r.watch.advisories()[0].acted, false)
})

test('flag on: the only effect is q to a pager in an agent-owned session, once, and only if nothing changed since the judged tail', async t => {
  const pager = 'commit 3f2a\r\nAuthor: A <a@example.test>\r\n(END)'
  // agent-owned + Decision on + accepted choice -> exactly one q
  const a = rig(t, { flag: 'on', agentOwned: true })
  a.registry.write('term-1', 'git log\r'); a.pty.output(pager); a.clock.t += 2500
  a.registry.read('term-1'); a.registry.read('term-1'); await a.settle(); a.registry.read('term-1'); await a.settle()
  assert.deepEqual(a.pty.writes, ['git log\r', 'q'])
  assert.deepEqual(a.watch.advisories().map(x => [x.state, x.source, x.would, x.acted]), [['stuck_in_pager', 'decision', 'quit_pager', true]])
  const entry = a.calibrationLog.entries().at(-1)
  assert.deepEqual([entry.mode, entry.attached, entry.terminal.acted, entry.terminal.agentOwned], ['on', true, true, true])
  // a person's own terminal: never
  const h = rig(t, { flag: 'on', agentOwned: false })
  h.registry.write('term-1', 'git log\r'); h.pty.output(pager); h.clock.t += 2500; h.registry.read('term-1'); await h.settle()
  assert.deepEqual(h.pty.writes, ['git log\r']); assert.equal(h.watch.advisories()[0].would, 'hand_close_pager')
  // the session stops being agent-owned / output arrives while the judge is out -> no key
  const c = rig(t, { flag: 'on', agentOwned: true })
  c.registry.write('term-1', 'git log\r'); c.pty.output(pager); c.clock.t += 2500
  c.registry.read('term-1'); c.pty.output('\r\n$ '); await c.settle()
  assert.deepEqual(c.pty.writes, ['git log\r'], 'the screen changed after the judged tail: nothing is typed')
  // every other state with the flag on: recorded, nothing typed (yes/no, completed error, completed ok)
  const o = rig(t, { flag: 'on', agentOwned: true })
  o.registry.write('term-1', 'npm install\r'); o.pty.output('Proceed? (y/N) '); o.clock.t += 2500; o.registry.read('term-1'); await o.settle()
  o.registry.write('term-1', 'npm test\r'); o.pty.output(FAILING); o.clock.t += 2500; o.registry.read('term-1'); await o.settle()
  o.pty.exit(1); await o.settle()
  assert.deepEqual(o.pty.writes, ['npm install\r', 'npm test\r'])
  assert.deepEqual(o.watch.advisories().map(x => [x.would, x.acted]), [['hand_yes_no', false], ['repair', false], ['repair', false]])
  MATRIX.on = { agentOwnedPager: a.pty.writes, humanPager: h.pty.writes, changedScreen: c.pty.writes, otherStates: o.pty.writes }
})

test('bounded: the same quiet tail is judged once, and one command gets at most the configured number of judgments', async t => {
  const r = rig(t, { limits: { judgmentsPerCommand: 2 } })
  r.registry.write('term-1', 'npm run dev\r'); r.pty.output('compiling a\r\n'); r.clock.t += 2500
  for (let i = 0; i < 5; i++) { r.registry.read('term-1'); await r.settle() }
  assert.equal(r.requests.length, 1, 'five reads of the same quiet tail: one request')
  for (const line of ['b', 'c', 'd', 'e']) { r.pty.output(`compiling ${line}\r\n`); r.clock.t += 2500; r.registry.read('term-1'); await r.settle() }
  assert.equal(r.requests.length, 2, 'a changing spinner-like tail cannot spend more than the per-command cap')
  r.registry.write('term-1', 'npm install\r'); r.pty.output('Proceed? (y/N) '); r.clock.t += 2500; r.registry.read('term-1'); await r.settle()
  assert.equal(r.requests.length, 3, 'Enter starts a new command window')
})

test('terminalFacts() is a read-only, content-free fact provider; beat() is a check point an external heartbeat can use', async t => {
  const r = rig(t)
  r.registry.write('term-1', 'npm install zeta-synthetic-package\r'); r.pty.output('Proceed? (y/N) zeta-synthetic-output'); r.clock.t += 4000
  const before = r.watch.terminalFacts()
  assert.deepEqual({ ...before[0] }, { sessionId: 'term-1', active: true, waitingOnUser: false, terminal: 'running', phase: 'tool_running', runningMs: 4000, quietMs: 4000, exitCode: null, agentOwned: false, runBound: true })
  assert.ok(Object.isFrozen(before) && Object.isFrozen(before[0]))
  const result = await r.watch.beat('term-1')
  assert.deepEqual([result.check, result.state, result.would], ['beat', 'waiting_yn_input', 'hand_yes_no'])
  const facts = r.watch.terminalFacts()
  // the same row shape as the engine-command facts and the objective-loop adapter: a judged waiting state, but the person is not asked through EG-Desk here
  assert.deepEqual([facts[0].terminal, facts[0].terminalState, facts[0].terminalSource, facts[0].terminalWould, facts[0].waitingOnUser, facts[0].phase], ['waiting', 'waiting_yn_input', 'fallback', 'hand_yes_no', false, 'tool_running'])
  assert.doesNotMatch(JSON.stringify(facts), /zeta-synthetic|Proceed|npm/)
  assert.deepEqual(r.pty.writes, ['npm install zeta-synthetic-package\r'])
  r.pty.exit(0); await r.settle()
  assert.deepEqual(r.watch.terminalFacts(), [], 'an exited session is dropped after its last check')
})

test.after(() => { if (process.env.EGDESK_SIM_OUT) import('node:fs').then(fs => fs.writeFileSync(process.env.EGDESK_SIM_OUT, JSON.stringify(MATRIX, null, 2))) })
