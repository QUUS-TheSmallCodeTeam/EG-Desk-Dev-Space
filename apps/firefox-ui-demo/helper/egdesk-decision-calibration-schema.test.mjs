import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
import { CALIBRATION_FILE, CALIBRATION_VERSION, NEXT_LABELS, attachLabel, chanceCorrected, normalizeEntry, openCalibrationLog, replayGate } from './egdesk-decision-calibration-log.mjs'
import { readChoice } from './egdesk-decision-questions.mjs'
import { runChatChoice } from './egdesk-chat-choice.mjs'

const quiet = () => {}
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), 'egdesk-calib-schema-')); await chmod(d, 0o700); return path.join(d, 'settings') }
const seed = async (dataDir, body) => { const l = openCalibrationLog({ dataDir, log: quiet }); void l; await writeFile(path.join(dataDir, CALIBRATION_FILE), body, { mode: 0o600 }) }

test('a version 1 file still loads; the next write upgrades it to version 2 and keeps the old entries', async () => {
  const dataDir = await tmp()
  await seed(dataDir, JSON.stringify({ version: 1, entries: [{ feature: 'turn_context', mode: 'advisory', day: new Date().toISOString().slice(0, 10),
    judgments: [{ q: 'relevance', would: 'skip', p: 0.42, threshold: 0.8 }], outcome: { run: 'completed', toolActivities: 1 } }] }))
  const log = openCalibrationLog({ dataDir, log: quiet })
  assert.equal(log.status, 'saved')
  assert.deepEqual(log.entries()[0].outcome, { run: 'completed', toolActivities: 1 })
  assert.ok(log.record({ feature: 'board_reply', mode: 'on', judgments: [] }))
  const file = JSON.parse(await readFile(path.join(dataDir, CALIBRATION_FILE), 'utf8'))
  assert.equal(file.version, CALIBRATION_VERSION)
  assert.equal(file.entries.length, 2)
})

test('a file from a newer version is left byte for byte untouched; recording still works in memory', async () => {
  const dataDir = await tmp()
  const future = JSON.stringify({ version: CALIBRATION_VERSION + 1, entries: [{ novel: 'SECRET_FUTURE_FIELD' }] })
  await seed(dataDir, future)
  const log = openCalibrationLog({ dataDir, log: quiet })
  assert.equal(log.status, 'unsupported')
  const handle = log.record({ feature: 'dm_chooser', mode: 'on', judgments: [] })
  assert.ok(handle)
  attachLabel(log, handle, { next: 'closed' })
  assert.equal(log.entries().length, 1)
  assert.equal(await readFile(path.join(dataDir, CALIBRATION_FILE), 'utf8'), future)
})

test('new numeric fields: bounded, rounded, content-free; closed no-pick and timeout_unsent; feature board_reply', () => {
  const e = normalizeEntry({ feature: 'board_reply', mode: 'on', fallback: 'timeout_unsent', judgments: [
    { q: 'choice', would: 'hold', confidence: 0.123456, margin: 0.2, options: 4, noPick: 'unclear', top: 0.5, second: 0.4 },
    { q: 'choice', would: 'hold', confidence: 1.2, margin: -1, options: 1, noPick: 'SECRET_REASON' },
    { q: 'choice', would: 'hold', options: 999, noPick: 'abstain' },
    { q: 'choice', would: 'hold', options: 2.5, confidence: 'SECRET' }] })
  assert.equal(e.feature, 'board_reply'); assert.equal(e.fallback, 'timeout_unsent')
  assert.deepEqual(e.judgments[0], { q: 'choice', would: 'hold', top: 0.5, second: 0.4, confidence: 0.1235, margin: 0.2, options: 4, noPick: 'unclear' })
  assert.deepEqual(e.judgments[1], { q: 'choice', would: 'hold' })
  assert.deepEqual(e.judgments[2], { q: 'choice', would: 'hold', noPick: 'abstain' })
  assert.deepEqual(e.judgments[3], { q: 'choice', would: 'hold' })
  assert.ok(!/SECRET/.test(JSON.stringify(e)))
})

test('labels: a closed next vocabulary per feature, small integers for Board reply, first explicit next wins, handles are opaque and never persisted', async () => {
  const dataDir = await tmp()
  const log = openCalibrationLog({ dataDir, log: quiet })
  const chooser = log.record({ feature: 'dm_chooser', mode: 'on', judgments: [] })
  assert.equal(typeof chooser, 'object'); assert.ok(Object.isFrozen(chooser)); assert.deepEqual(Object.keys(chooser), [])
  assert.equal(attachLabel(log, chooser, { next: 'applied' }), false, 'a Board arrangement label does not belong to the DM chooser')
  for (const next of NEXT_LABELS.dm_chooser) assert.ok(next)
  assert.equal(attachLabel(log, chooser, { next: 'asked_why', keptN: 3, free: 'SECRET' }), true)
  assert.equal(attachLabel(log, chooser, { next: 'retried' }), false, 'the first explicit next action is kept')
  const board = log.record({ feature: 'board_arrangement', mode: 'on', judgments: [] })
  for (const next of NEXT_LABELS.board_arrangement) assert.equal(attachLabel(log, log.record({ feature: 'board_arrangement', mode: 'on', judgments: [] }), { next }), true, next)
  assert.equal(attachLabel(log, board, { next: 'asked_agent' }), false)
  const reply = log.record({ feature: 'board_reply', mode: 'on', judgments: [] })
  assert.equal(attachLabel(log, reply, { run: 'completed', keptN: 3, removedN: 1, text: 'SECRET' }), true)
  assert.equal(attachLabel(log, reply, { keptN: 150 }), false, 'a count already set is not overwritten')
  const big = log.record({ feature: 'board_reply', mode: 'on', judgments: [] })
  attachLabel(log, big, { keptN: 5000, removedN: -2 })
  const turn = log.record({ feature: 'turn_context', mode: 'advisory', judgments: [] })
  assert.equal(attachLabel(log, turn, { run: 'completed', toolActivities: 2, next: 'asked_why', keptN: 1 }), true)
  const all = log.entries()
  assert.deepEqual(all[0].outcome, { next: 'asked_why' })
  assert.deepEqual(all.find(x => x.feature === 'board_reply').outcome, { run: 'completed', keptN: 3, removedN: 1 })
  assert.deepEqual(all.at(-1).outcome, { run: 'completed', toolActivities: 2 }, 'turn context keeps run/toolActivities only')
  assert.equal(all.findLast(x => x.feature === 'board_reply')?.outcome?.keptN, 99)
  for (const bad of [null, undefined, 'c1', {}, 7]) assert.equal(attachLabel(log, bad, { next: 'closed' }), false)
  assert.equal(attachLabel(null, chooser, { next: 'closed' }), false)
  const text = await readFile(path.join(dataDir, CALIBRATION_FILE), 'utf8')
  assert.ok(!/SECRET|"id"|handle|c\d+"/.test(text))
})

// ---- replay: the record alone reproduces the product's accept / hold decision ----
const split = (top, second, n) => {
  const rest = Array.from({ length: n - 2 }, () => Math.max(0, 1 - top - second) / (n - 2))
  return [top, second, ...rest]
}
const GRID = []
for (const n of [3, 4, 6, 9]) for (const top of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99]) for (const second of [0.005, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4]) {
  const rest = 1 - top - second
  if (second > top || rest < -1e-9 || rest / (n - 2) > second + 1e-9) continue
  GRID.push({ n, top, second })
}

test('replay (Board arrangement style): confidence + options + margin reproduce readChoice; top and second alone do not', () => {
  let topOnlyWrong = 0, checked = 0
  for (const { n, top, second } of GRID) {
    const p = split(top, second, n), values = p.map((_, i) => `v${i}`)
    const confidence = chanceCorrected(top, n)
    const answers = { board_view: { type: 'choice', choice: 'v0', confidence, probabilities: p.map((probability, i) => ({ value: values[i], probability })) } }
    const product = readChoice(answers, 'board_view', { minConfidence: 0.75, minMargin: 0.2 }).state === 'accepted' ? 'accept' : 'reject'
    const entry = normalizeEntry({ feature: 'board_arrangement', mode: 'on', judgments: [{ q: 'choice', would: product, top, second, p: confidence, confidence, options: n,
      margin: top - second, threshold: 0.75, minMargin: 0.2 }] })
    const j = entry.judgments[0]
    assert.equal(replayGate('board_arrangement', j), product, JSON.stringify({ n, top, second, confidence }))
    const topOnly = j.top >= j.threshold && j.top - j.second >= j.minMargin ? 'accept' : 'reject'
    if (topOnly !== product) topOnlyWrong++
    checked++
  }
  assert.ok(checked > 40)
  assert.ok(topOnlyWrong > 0, `the old numbers (top, second) disagree with the product on ${topOnlyWrong}/${checked}: that is the gap this schema closes`)
})

test('replay (DM chooser): the recorded numbers reproduce runChatChoice accept / hold, including the abstain row in N', async () => {
  let mismatches = 0, checked = 0
  for (const { n, top, second } of GRID) {
    const nOptions = n - 1 // offered options; the abstain row makes N = nOptions + 1
    if (nOptions < 2 || nOptions > 8) continue
    const p = split(top, second, n)
    if (p.some((x, i) => i && x > p[i - 1])) continue // float noise made the rows not descending: not a valid answer shape
    const confidence = chanceCorrected(top, n)
    const measured = {}
    const client = { decide: async req => {
      req.authorizeDispatch?.()
      const values = req.questions[0].choices.map(c => c.value)
      assert.equal(values.length, n)
      return { answers: { chat_choice: { type: 'choice', choice: values[0], confidence, probabilities: p.map((probability, i) => ({ value: values[i], probability })) } } }
    } }
    const result = await runChatChoice({ question: 'q', options: Array.from({ length: nOptions }, (_, i) => `opt${i}`), client, isCurrent: () => true,
      signal: new AbortController().signal, onMeasure: m => Object.assign(measured, m) })
    const product = result.status === 'recommended' ? 'accept' : 'reject'
    const entry = normalizeEntry({ feature: 'dm_chooser', mode: 'on', judgments: [{ q: 'choice', would: product === 'accept' ? 'act' : 'hold', top: measured.top, second: measured.second,
      p: measured.p, confidence: measured.p, options: measured.options + 1, margin: measured.top - measured.second, threshold: 0.8, minMargin: 0.2,
      ...(result.reason && ['abstain', 'unclear', 'low_confidence'].includes(result.reason) ? { noPick: result.reason } : {}) }] })
    const j = entry.judgments[0]
    assert.ok(j, JSON.stringify({ n, top, second, result, measured }))
    assert.equal(j.options, n, JSON.stringify({ n, top, second, result, measured, confidence }))
    if (replayGate('dm_chooser', j) !== product) { mismatches++; console.log('MISMATCH', n, top, second, confidence, result) }
    checked++
  }
  assert.ok(checked > 20)
  assert.equal(mismatches, 0)
})

test('chanceCorrected matches the API formula and rejects nonsense', () => {
  assert.equal(chanceCorrected(1, 2), 1)
  assert.ok(Math.abs(chanceCorrected(0.5, 2)) < 1e-12)
  assert.ok(Math.abs(chanceCorrected(0.85, 8) - 0.8286) < 1e-4)
  for (const bad of [[NaN, 3], [0.9, 1], [0.9, 2.5], [0.9, undefined]]) assert.equal(chanceCorrected(...bad), null)
  assert.equal(replayGate('dm_chooser', { top: 0.9, second: 0.05, threshold: 0.8, minMargin: 0.2 }), null, 'without confidence the record cannot be replayed')
})

test('rounding never moves a number across the bar it was judged against', () => {
  const below = normalizeEntry({ feature: 'dm_chooser', mode: 'on', judgments: [{ q: 'choice', would: 'hold', top: 0.85, second: 0.1, confidence: 0.7999999999999999, margin: 0.19999999999, options: 4, threshold: 0.8, minMargin: 0.2 }] }).judgments[0]
  assert.ok(below.confidence < 0.8 && below.margin < 0.2)
  assert.equal(replayGate('dm_chooser', below), 'reject')
  const at = normalizeEntry({ feature: 'dm_chooser', mode: 'on', judgments: [{ q: 'choice', would: 'act', top: 0.8, second: 0.6, confidence: 0.8, margin: 0.2, options: 4, threshold: 0.8, minMargin: 0.2 }] }).judgments[0]
  assert.equal(replayGate('dm_chooser', at), 'accept')
})

test('terminal records are closed words, booleans and one rounded number: a command, path or output text cannot be stored', async () => {
  const { normalizeEntry } = await import('./egdesk-decision-calibration-log.mjs')
  const state = normalizeEntry({ feature: 'terminal_state', mode: 'advisory', judgments: [], attached: false,
    terminal: { state: 'stuck_in_pager', source: 'decision', would: 'quit_pager', acted: false, check: 'read', agentOwned: true, tail: 'git log output', command: 'git log' } })
  assert.deepEqual(state.terminal, { state: 'stuck_in_pager', source: 'decision', would: 'quit_pager', check: 'read', acted: false, agentOwned: true })
  assert.equal(normalizeEntry({ feature: 'terminal_state', mode: 'advisory', terminal: { state: 'rm -rf src', would: 'type y', source: 'model said so' } }).terminal, undefined)
  const gate = normalizeEntry({ feature: 'terminal_gate', mode: 'on', judgments: [], attached: true,
    gate: { rule: true, would: true, scored: false, gitFacts: true, sessionWithheld: true, reasons: ['tracked_files', 'rm -rf src/', 'tracked_files', 7], score: 3.74, engine: 'claude', command: 'rm -rf src/', cwd: '/work' } })
  assert.deepEqual(gate.gate, { rule: true, would: true, scored: false, gitFacts: true, sessionWithheld: true, reasons: ['tracked_files'], score: 3.7, engine: 'claude' })
  assert.equal(normalizeEntry({ feature: 'terminal_gate', mode: 'advisory', gate: { score: 9, engine: 'bash', reasons: 'all' } }).gate, undefined)
  // the fields belong to their own feature only
  assert.equal(normalizeEntry({ feature: 'dm_chooser', mode: 'on', terminal: { state: 'completed_ok' }, gate: { rule: true } }).terminal, undefined)
  assert.doesNotMatch(JSON.stringify([state, gate]), /git log|rm -rf|\/work/)
})

test('engine-command terminal records: stream, engine and the ordinals of the blocks that would be highlighted; never text', async () => {
  const { normalizeEntry } = await import('./egdesk-decision-calibration-log.mjs')
  const entry = normalizeEntry({ feature: 'terminal_state', mode: 'advisory', judgments: [], attached: false, candidates: 4, judgedTotal: 2,
    terminal: { state: 'completed_error', source: 'fallback', would: 'repair', acted: false, check: 'exit', stream: 'engine', engine: 'codex', picked: [2, 3, 3, 99, 'b4', 0], output: 'not ok 2' } })
  assert.deepEqual(entry.terminal, { state: 'completed_error', source: 'fallback', would: 'repair', check: 'exit', acted: false, stream: 'engine', engine: 'codex', picked: [2, 3] })
  assert.equal(normalizeEntry({ feature: 'terminal_state', mode: 'advisory', terminal: { stream: 'ssh', engine: 'bash', check: 'poll', picked: ['not ok 2'] } }).terminal, undefined)
  assert.equal(normalizeEntry({ feature: 'terminal_state', mode: 'advisory', terminal: { check: 'quiet', state: 'waiting_yn_input' } }).terminal.check, 'quiet')
})
