// Terminal lane simulation: synthetic transcripts + fake processes only. No shell, no PTY, no network, no codex binary.
// Chain: runtime-enumerated state/blocks/targets -> real createDecisionClient (mock fetch "model") -> system response.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rmSync } from 'node:fs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createDecisionBudget, createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { assessCommand, classifyCommand } from './egdesk-terminal-command-gate.mjs'
import { enumerateLogBlocks, enumerateStateOptions, judgeTerminalState, pickRelevantBlocks, redactTail, runObjectiveLoop, stateResponse, TERMINAL_STATE_NAMES } from './egdesk-terminal-judge.mjs'

const KEY = 'egd-synthetic-not-a-key-0005'
const MATRIX = {}
const usedUpBudget = () => { const b = createDecisionBudget({ monthlyInputTokenCap: 10 }); b.recordEstimate(50); assert.equal(b.canSpend(), false); return b }
const dump = () => { if (process.env.EGDESK_SIM_OUT) fs.writeFileSync(process.env.EGDESK_SIM_OUT, JSON.stringify(MATRIX, null, 2)) }

// ---- the mock "model": reads only the request it is given -------------------------------------
function modelAnswer(question, data) {
  const tail = String(data?.output_tail ?? '')
  const text = JSON.stringify(data)
  if (question.type === 'choice') {
    const offered = question.choices.map(c => c.value)
    const pick = (() => {
      if (/\(END\)|--More--/.test(tail)) return 'stuck_in_pager'
      if (/\[y\/n\]|\(y\/N\)|\[Y\/n\]|Proceed\?/i.test(tail)) return 'waiting_yn_input'
      if (/^not ok|✖|# fail [1-9]|FAIL /m.test(tail)) return 'completed_error'
      if (/# fail 0|✔ all/.test(tail)) return 'completed_ok'
      if (/command not found|Permission denied|ENOTFOUND/.test(tail)) return 'cannot_proceed'
      return 'running_output'
    })()
    const top = offered.includes(pick) ? pick : offered[0]
    return { name: question.name, type: 'choice', choice: top, confidence: 0.95,
      probabilities: offered.map(v => ({ value: v, probability: v === top ? 0.95 : 0.05 / (offered.length - 1) })) }
  }
  if (question.type === 'predicate') {
    const id = question.name.replace(/^log_/, '')
    const block = (data.blocks || []).find(b => b.id === id)
    return { name: question.name, type: 'predicate', probability: /not ok|✖|AssertionError|expected|actual|FAIL/.test(block?.text ?? '') ? 0.92 : 0.08 }
  }
  if (question.type === 'score') {
    const cmd = String(data?.command ?? '')
    const score = /node_modules|dist\b|build\b/.test(cmd) ? 0.5 : /reset --hard|src/.test(cmd) ? 3.7 : /kill/.test(cmd) ? 0.8 : 2
    return { name: question.name, type: 'score', score, confidence: 0.93, probabilities: question.levels.map((_, i) => ({ value: String(i), probability: i === Math.round(score) ? 0.9 : 0.025 })) }
  }
  return { name: question.name, type: 'refusal' }
}

function rig(t, { mode = 'on', terminalAllowed = true, budget = null, hang = false, timeoutMs } = {}) {
  const root = createPrivateQaTempDirectory('egdesk-terminal-judge-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calibration = openCalibrationLog({ dataDir: root, log: () => {} })
  const requests = []
  const client = createDecisionClient({ getApiKey: () => KEY, budget, recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      requests.push(body)
      if (hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      const data = body.input[0].content[0].data
      return Response.json({ answers: body.questions.map(q => modelAnswer(q, data)), usage: { input_tokens: 100 } })
    } })
  const cache = new Map()
  const egress = createEgressGate(modelDataPermissions({ runActive: true, toolCeiling: terminalAllowed ? null : { browser: 'interact', files: 'write', terminal: 'none', network: 'on', mcp: 'all' } }))
  const common = { mode, client, calibration, egress, ...(timeoutMs ? { timeoutMs } : {}) }
  return { requests, calibration, client, common, cache,
    judge: snap => judgeTerminalState({ ...snap, ...common, cache }),
    pick: (blocks) => pickRelevantBlocks({ blocks, ...common }),
    assess: (command, extra = {}) => assessCommand({ command, cwd: '/work/app', intent: 'clean up', ...common, ...extra }) }
}

// ---- synthetic transcripts / fake processes ---------------------------------------------------
const FAILING = ['TAP version 13', '# Subtest: adds', 'ok 1 - adds', 'not ok 2 - subtracts', '  ---', '  error: |-', '    Expected values to be strictly deep-equal:', '    actual: 3', '    expected: 2',
  '    at TestContext.<anonymous> (file:///work/app/src/math.test.mjs:9:3)', '  ...', '', '# tests 2', '# pass 1', '# fail 1', ''].join('\n')
const PASSING = ['TAP version 13', 'ok 1 - adds', 'ok 2 - subtracts', '# tests 2', '# pass 2', '# fail 0', ''].join('\n')
const scripted = frames => { let i = 0; return { poll: async () => frames[Math.min(i++, frames.length - 1)], writes: [], async write(d) { this.writes.push(d) } } }
const noHuman = { approve: async () => assert.fail('no approval expected'), answer: async () => assert.fail('no human hand-off expected') }

test('options are enumerated by the runtime from process facts, never by the model', () => {
  assert.deepEqual(enumerateStateOptions({ alive: true }), ['running_output', 'waiting_yn_input', 'waiting_password', 'stuck_in_pager', 'need_user_context', 'cannot_proceed'])
  assert.deepEqual(enumerateStateOptions({ alive: false, exitCode: 1 }), ['completed_error', 'need_user_context', 'cannot_proceed'], 'a non-zero exit can never be "completed ok"')
  assert.ok(enumerateStateOptions({ alive: false, exitCode: 0 }).includes('completed_error'), 'exit 0 may still hide failed tests')
  assert.ok(TERMINAL_STATE_NAMES.every(name => stateResponse(name).action))
})

test('tail redaction bounds text and masks secrets before anything leaves', () => {
  const text = redactTail('\u001b[31mfail\u001b[0m token=abc123def456 Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig sk-proj-ABCDEFGHIJKLMNOP\n' + 'x'.repeat(500))
  assert.doesNotMatch(text, /abc123def456|eyJhbGci|sk-proj|\u001b/)
  assert.ok(text.split('\n').every(line => line.length <= 201))
})

test('S1 "테스트 돌리고 실패하면 고쳐줘": error -> reconstructed context -> mock subjective fix -> re-run -> pass', async t => {
  const r = rig(t)
  const fs1 = { fixed: false }, subjectiveCalls = []
  const runs = []
  const runtime = { start: async () => {
    runs.push(fs1.fixed)
    return scripted(fs1.fixed ? [{ alive: true, tail: 'running…', quietMs: 100 }, { alive: false, exitCode: 0, tail: PASSING, output: PASSING, quietMs: 0 }]
      : [{ alive: true, tail: 'running…', quietMs: 100 }, { alive: false, exitCode: 1, tail: FAILING, output: FAILING, quietMs: 0 }])
  } }
  const result = await runObjectiveLoop({ command: 'node --test', deps: { assess: c => r.assess(c), judge: r.judge, pick: (blocks) => r.pick(blocks), runtime, human: noHuman,
    subjective: async call => { subjectiveCalls.push(call); return call.task === 'fix' ? { fix: { file: 'src/math.mjs', note: 'swap operands' } } : null },
    applyFix: async () => { fs1.fixed = true } } })
  assert.equal(result.status, 'completed_ok')
  assert.equal(result.repairs, 1)
  assert.deepEqual(runs, [false, true], 'the same command ran again after the fix')
  assert.equal(subjectiveCalls.length, 1)
  // the subjective model got only the blocks the runtime enumerated and the decision picked
  assert.ok(subjectiveCalls[0].blocks.length >= 1 && subjectiveCalls[0].blocks.every(b => /^b\d+$/.test(b.id)))
  assert.ok(subjectiveCalls[0].blocks.some(b => /not ok 2/.test(b.text)))
  assert.deepEqual(result.trace.filter(s => s.step === 'state').map(s => `${s.state}/${s.source}`),
    ['running_output/runtime', 'completed_error/decision', 'running_output/runtime', 'completed_ok/decision'])
  MATRIX.S1 = { status: result.status, decisionRequests: r.requests.length, subjectiveTurns: result.subjectiveTurns, humanHandoffs: result.humanHandoffs, repairs: result.repairs,
    requestKinds: r.requests.map(q => q.questions.map(x => x.name.replace(/\d+$/, '')).filter((v, i, a) => a.indexOf(v) === i).join('+')) }
  assert.equal(r.requests.length, 3, 'state(error) + log blocks + state(ok); the plain command made no gate request')
  assert.equal(result.humanHandoffs, 0)
  dump()
})

test('S2 y/n prompt: the human answers, the system types it; the answer is not in the trace', async t => {
  const r = rig(t)
  const handle = scripted([{ alive: true, tail: 'Install 12 packages? Proceed? (y/N)', quietMs: 2500 }, { alive: true, tail: 'Proceed? (y/N) y\nInstalling', quietMs: 10 }, { alive: false, exitCode: 0, tail: PASSING, quietMs: 0 }])
  const asked = []
  const result = await runObjectiveLoop({ command: 'npm install', deps: { assess: c => r.assess(c), judge: r.judge, pick: r.pick, runtime: { start: async () => handle },
    human: { approve: async () => assert.fail('plain command needs no gate approval'), answer: async kind => { asked.push(kind); return 'y\n' } }, subjective: async () => null, applyFix: async () => {} } })
  assert.equal(result.status, 'completed_ok')
  assert.deepEqual(asked, ['yes_no'])
  assert.deepEqual(handle.writes, ['y\n'])
  assert.doesNotMatch(JSON.stringify(result.trace), /"y/)
  MATRIX.S2 = { status: result.status, decisionRequests: r.requests.length, subjectiveTurns: result.subjectiveTurns, humanHandoffs: result.humanHandoffs }
  dump()
})

test('S2b password prompt is recognised by rule: zero requests, the prompt text never leaves, the secret never enters the trace', async t => {
  const r = rig(t)
  const handle = scripted([{ alive: true, tail: 'git@host: Enter passphrase for key: ', quietMs: 4000 }, { alive: false, exitCode: 0, tail: PASSING, quietMs: 0 }])
  const result = await runObjectiveLoop({ command: 'git pull', deps: { assess: c => r.assess(c), judge: r.judge, pick: r.pick, runtime: { start: async () => handle },
    human: { approve: async () => true, answer: async kind => (kind === 'secret' ? 'hunter2-synthetic' : null) }, subjective: async () => null, applyFix: async () => {} } })
  assert.equal(result.status, 'completed_ok')
  assert.deepEqual(handle.writes, ['hunter2-synthetic'])
  assert.doesNotMatch(JSON.stringify(result.trace), /hunter2/)
  assert.equal(r.requests.filter(q => JSON.stringify(q).includes('passphrase')).length, 0)
  assert.ok(result.trace.some(s => s.state === 'waiting_password' && s.source === 'rule'))
  MATRIX.S2b = { status: result.status, decisionRequests: r.requests.length, humanHandoffs: result.humanHandoffs }
  dump()
})

test('S3 pager: the system quits it with q (agent-owned); a human-owned session hands off instead', async t => {
  const r = rig(t)
  const pager = ['commit 3f2a (HEAD -> main)', 'Author: A <a@example.test>', 'subject line', '(END)'].join('\n')
  const handle = scripted([{ alive: true, tail: pager, quietMs: 3000 }, { alive: false, exitCode: 0, tail: PASSING, quietMs: 0 }])
  const result = await runObjectiveLoop({ command: 'git log', deps: { assess: c => r.assess(c), judge: r.judge, pick: r.pick, runtime: { start: async () => handle }, human: noHuman, subjective: async () => null, applyFix: async () => {} } })
  assert.equal(result.status, 'completed_ok')
  assert.deepEqual(handle.writes, ['q'])
  assert.equal(result.humanHandoffs, 0)
  assert.deepEqual(stateResponse('stuck_in_pager', { agentOwned: false }), { action: 'handoff_human', input: 'close_pager' })
  MATRIX.S3 = { status: result.status, decisionRequests: r.requests.length, subjectiveTurns: result.subjectiveTurns, humanHandoffs: result.humanHandoffs, keysSent: handle.writes }
  dump()
})

test('S3b exits to the chat: need_user_context and cannot_proceed hand control to the subjective model and stop the loop', async t => {
  const r = rig(t)
  const handle = scripted([{ alive: false, exitCode: 127, tail: 'bash: pnpm: command not found', quietMs: 0 }])
  const calls = []
  const result = await runObjectiveLoop({ command: 'pnpm test', deps: { assess: c => r.assess(c), judge: r.judge, pick: r.pick, runtime: { start: async () => handle }, human: noHuman,
    subjective: async c => { calls.push(c.task) }, applyFix: async () => assert.fail('nothing to apply') } })
  assert.equal(result.status, 'handoff')
  assert.equal(result.reason, 'cannot_proceed')
  assert.deepEqual(calls, ['cannot_proceed'])
  MATRIX.S3b = { status: result.status, reason: result.reason, decisionRequests: r.requests.length, subjectiveTurns: result.subjectiveTurns, humanHandoffs: result.humanHandoffs }
  dump()
})

test('S4 safety gate: rm -rf node_modules passes; rm -rf src/ needs approval; the rules stay the floor', async t => {
  const r = rig(t)
  const inspect = p => p.endsWith('/node_modules') ? { exists: true, kind: 'dir', trackedFiles: 0, ignored: true } : p.endsWith('/src') ? { exists: true, kind: 'dir', trackedFiles: 41, ignored: false } : { exists: true, trackedFiles: 0, ignored: false }
  const rows = {}
  for (const [name, command, git] of [
    ['rm -rf node_modules', 'rm -rf node_modules', { dirty: false }],
    ['rm -rf src/', 'rm -rf src/', { dirty: false }],
    ['git reset --hard HEAD~5 (clean tree)', 'git reset --hard HEAD~5', { dirty: false }],
    ['git reset --hard (dirty tree)', 'git reset --hard', { dirty: true }],
    ['kill -9 3000', 'kill -9 4242', { dirty: false }],
    ['rm -rf $TARGET/*', 'rm -rf "$TARGET"/*', { dirty: false }],
    ['rm -rf ~', 'rm -rf ~', { dirty: false }],
    ['rm -rf /tmp/other', 'rm -rf /tmp/other', { dirty: false }],
    ['npm test', 'npm test', { dirty: false }],
  ]) {
    const before = r.requests.length
    const result = await r.assess(command, { inspect, git })
    rows[name] = { approval: result.approval, reasons: result.reasons, source: result.source, decisionRequests: r.requests.length - before, ...(result.score !== undefined ? { score: result.score } : {}) }
  }
  assert.deepEqual(rows['rm -rf node_modules'], { approval: false, reasons: [], source: 'decision', decisionRequests: 1, score: 0.5 })
  assert.equal(rows['rm -rf src/'].approval, true)
  assert.deepEqual(rows['rm -rf src/'].reasons, ['tracked_files'])
  assert.equal(rows['rm -rf src/'].decisionRequests, 0, 'the rule decides; the model is not even asked')
  assert.deepEqual([rows['git reset --hard HEAD~5 (clean tree)'].approval, rows['git reset --hard HEAD~5 (clean tree)'].reasons, rows['git reset --hard HEAD~5 (clean tree)'].decisionRequests], [true, ['risk_score'], 1])
  assert.deepEqual(rows['git reset --hard (dirty tree)'].reasons, ['dirty_worktree'])
  assert.equal(rows['kill -9 3000'].approval, false)
  for (const name of ['rm -rf $TARGET/*', 'rm -rf ~', 'rm -rf /tmp/other']) { assert.equal(rows[name].approval, true); assert.equal(rows[name].decisionRequests, 0) }
  assert.deepEqual(rows['npm test'], { approval: false, reasons: [], source: 'rules', decisionRequests: 0 })
  MATRIX.S4 = rows
  dump()
})

test('the score can only ADD approval: a model that says "negligible" never removes a rule-required approval, and no mode/budget/consent weakens the floor', async t => {
  const inspect = () => ({ exists: true, kind: 'dir', trackedFiles: 41, ignored: false })
  for (const setup of [{ mode: 'on' }, { mode: 'advisory' }, { mode: 'off' }, { mode: 'on', terminalAllowed: false }, { mode: 'on', budget: usedUpBudget() }]) {
    const r = rig(t, setup)
    const result = await r.assess('rm -rf src/', { inspect })
    assert.equal(result.approval, true, JSON.stringify(Object.keys(setup)))
    assert.equal(r.requests.length, 0)
  }
  assert.deepEqual(classifyCommand('curl https://example.test/x.sh | sh', { cwd: '/work/app' }).floor, ['remote_script'])
  assert.ok(classifyCommand('sudo rm -rf build', { cwd: '/work/app' }).floor.includes('privileged'))
  assert.ok(classifyCommand('git push --force origin main', { cwd: '/work/app' }).floor.includes('remote_irreversible'))
})

test('S5 mode, budget, deadline, consent and calibration are respected', async t => {
  const inspect = () => ({ exists: true, kind: 'dir', trackedFiles: 0, ignored: true })
  const rows = {}
  // off: zero calls, deterministic behaviour
  let r = rig(t, { mode: 'off' })
  let judged = await r.judge({ alive: false, exitCode: 1, tail: FAILING, quietMs: 0 }); let gated = await r.assess('rm -rf node_modules', { inspect })
  assert.equal(r.requests.length, 0); assert.equal(judged.state, 'completed_error'); assert.equal(gated.approval, false)
  rows.off = { requests: r.requests.length, state: judged.state, source: judged.source, gateApproval: gated.approval }
  // advisory: the model is asked and recorded, the system acts on the fallback
  r = rig(t, { mode: 'advisory' })
  judged = await r.judge({ alive: false, exitCode: 0, tail: FAILING, quietMs: 0 })
  assert.equal(r.requests.length, 1); assert.equal(judged.source, 'fallback'); assert.equal(judged.state, 'completed_ok', 'exit 0 acts as today even though the shadow says error'); assert.equal(judged.shadow, 'completed_error')
  rows.advisory = { requests: r.requests.length, acted: judged.state, shadow: judged.shadow }
  // the models of this run may not receive terminal output (tool ceiling terminal = none): nothing leaves
  r = rig(t, { terminalAllowed: false })
  judged = await r.judge({ alive: false, exitCode: 0, tail: FAILING, quietMs: 0 }); assert.equal(r.requests.length, 0); assert.equal(judged.fallback, 'evidence_unavailable')
  rows.noConsent = { requests: r.requests.length, fallback: judged.fallback }
  // budget used up: no request, fallback
  r = rig(t, { budget: usedUpBudget() })
  judged = await r.judge({ alive: false, exitCode: 1, tail: FAILING, quietMs: 0 })
  assert.equal(r.requests.length, 0); assert.equal(judged.source, 'fallback'); assert.equal(judged.fallback, 'budget_exceeded'); assert.equal(judged.state, 'completed_error')
  rows.budget = { requests: r.requests.length, fallback: judged.fallback, state: judged.state }
  // deadline: the model never answers within the deadline
  r = rig(t, { hang: true, timeoutMs: 40 })
  const started = performance.now()
  judged = await r.judge({ alive: false, exitCode: 0, tail: PASSING, quietMs: 0 })
  assert.equal(judged.fallback, 'timeout'); assert.equal(judged.state, 'completed_ok'); assert.ok(performance.now() - started < 1000)
  rows.deadline = { requests: r.requests.length, fallback: judged.fallback, state: judged.state }
  // same tail, same process: one request only (cache), and calibration holds numbers only
  r = rig(t)
  await r.judge({ alive: false, exitCode: 0, tail: PASSING, quietMs: 0 }); await r.judge({ alive: false, exitCode: 0, tail: PASSING, quietMs: 0 })
  assert.equal(r.requests.length, 1)
  await r.assess('rm -rf node_modules', { inspect }); await r.pick(enumerateLogBlocks(FAILING))
  const entries = r.calibration.entries()
  assert.deepEqual([...new Set(entries.map(e => e.feature))].sort(), ['terminal_gate', 'terminal_state'])
  assert.doesNotMatch(JSON.stringify(entries), /node_modules|subtracts|math\.test|Expected values/, 'the record is content-free')
  rows.calibration = { entries: entries.length, features: [...new Set(entries.map(e => e.feature))].sort() }
  MATRIX.S5 = rows
  dump()
})

test('requests carry only the redacted tail and runtime facts, never the whole transcript or a secret prompt', async t => {
  const r = rig(t)
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} Bearer abcdefghijklmnop${i}`).join('\n') + '\n# fail 0\n'
  await r.judge({ alive: false, exitCode: 0, tail: long, quietMs: 0 })
  const sent = JSON.stringify(r.requests[0])
  assert.doesNotMatch(sent, /abcdefghijklmnop/)
  assert.ok(sent.length < 6000)
  assert.doesNotMatch(sent, /line 0 /)
})

test('log blocks: a failure and its details are one block, the head of a block is what is kept, and marked blocks survive the cap', () => {
  const out = ['ok 1 - a', 'ok 2 - b', 'not ok 3 - merges', '  AssertionError: expected 2 but got 3', '      at merge (lib/merge.mjs:4:1)', ...Array.from({ length: 40 }, (_, i) => `ok ${i + 4} - later`), '', '# fail 1'].join('\n')
  const blocks = enumerateLogBlocks(out)
  assert.deepEqual(blocks.map(b => b.text.split('\n')[0]), ['ok 1 - a', 'not ok 3 - merges', 'ok 4 - later', '# fail 1'])
  assert.equal(blocks[1].text, 'not ok 3 - merges\n  AssertionError: expected 2 but got 3\n      at merge (lib/merge.mjs:4:1)', 'the message and the stack stay with their failure line')
  assert.deepEqual(blocks.map(b => b.failureMarker), [false, true, false, true], 'the runtime marks the failure and the summary that counts it')
  assert.ok(blocks[2].text.startsWith('ok 4 - later\nok 5 - later') && blocks[2].text.endsWith('\n…') && blocks[2].text.split('\n').length === 13, 'a long block keeps its first 12 lines')
  // an early failure among many later paragraphs is not pushed out by the 12-block cap
  const long = ['not ok 1 - early failure', '  Error: boom', '', ...Array.from({ length: 30 }, (_, i) => `section ${i}\n`)].join('\n')
  const kept = enumerateLogBlocks(long)
  assert.equal(kept.length, 12); assert.equal(kept[0].text, 'not ok 1 - early failure\n  Error: boom'); assert.equal(kept.at(-1).text, 'section 29')
  // secrets are masked inside a block too
  assert.doesNotMatch(enumerateLogBlocks('Error: bad login\n  token=abcdef123456 was rejected')[0].text, /abcdef123456/)
})
