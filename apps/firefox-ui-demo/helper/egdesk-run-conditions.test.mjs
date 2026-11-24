// c21: the condition arbiter. Structured facts decide; a yes/no predicate on the quoted output tail is only auxiliary and can never
// declare success. Fakes only (the probe, the predicate); no process, no socket.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CONDITION_PREDICATES, conditionRequest, judgeHealth, judgeServerReady, judgeWorktree, parsePorcelain, parseTestSummary, portsInOutput } from './egdesk-run-conditions.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { messageEvidence } from './egdesk-conversation-flow.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

const asking = p => { const calls = []; const ask = async request => { calls.push(request); return { answers: Object.fromEntries(request.questions.map(q => [q.name, { type: 'predicate', probability: p }])) } }; ask.calls = calls; return ask }

test('the test runner\'s own summary line, for the common runners; the last summary wins; none when there is none', () => {
  const cases = [
    ['# tests 40\n# suites 3\n# pass 39\n# fail 1\n# cancelled 0', { runner: 'node_test', passed: 39, failed: 1, total: 40, line: '# tests 40 / # pass 39 / # fail 1' }],
    ['ℹ tests 12\nℹ pass 12\nℹ fail 0', { runner: 'node_test', passed: 12, failed: 0, total: 12, line: 'ℹ tests 12 / ℹ pass 12 / ℹ fail 0' }],
    ['Test Suites: 1 failed, 4 passed, 5 total\nTests:       1 failed, 39 passed, 40 total', { runner: 'jest', passed: 39, failed: 1, total: 40, line: 'Tests:       1 failed, 39 passed, 40 total' }],
    [' Test Files  3 passed (3)\n      Tests  40 passed (40)', { runner: 'vitest', passed: 40, failed: 0, total: 40, line: 'Tests  40 passed (40)' }],
    ['========== 3 failed, 37 passed in 1.20s ==========', { runner: 'pytest', passed: 37, failed: 3, total: null, line: '========== 3 failed, 37 passed in 1.20s ==========' }],
    ['==== 2 failed in 0.40s ====', { runner: 'pytest', passed: 0, failed: 2, total: null, line: '==== 2 failed in 0.40s ====' }],
    ['test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured', { runner: 'cargo', passed: 40, failed: 0, total: null, line: 'test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured' }],
    ['  38 passing (1s)\n  2 failing', { runner: 'mocha', passed: 38, failed: 2, total: null, line: '38 passing (1s) / 2 failing' }],
  ]
  for (const [output, expected] of cases) assert.deepEqual(parseTestSummary(output), expected, output)
  for (const none of ['', 'Done in 2.1s.', 'all tests passed!', 'PASS src/a.test.js']) assert.equal(parseTestSummary(none), null, none)
})

test('health: exit status and summary decide; the predicate is asked only when the summary is missing, and can only lower it', async () => {
  const never = asking(0)
  assert.deepEqual(await judgeHealth({ exitCode: 1, output: '# pass 3\n# fail 0', ask: never }), { health: 'unhealthy', reasons: ['exit_status', 'summary_says_passed'], summary: { runner: 'node_test', passed: 3, failed: 0, total: null, line: '# pass 3 / # fail 0' } })
  assert.equal((await judgeHealth({ exitCode: 0, output: 'Tests:       1 failed, 3 passed, 4 total', ask: never })).health, 'unhealthy')
  assert.deepEqual((await judgeHealth({ exitCode: 0, output: '  4 passing (2ms)', ask: never })).reasons, ['summary_passed'])
  assert.equal(never.calls.length, 0, 'structured facts were enough: no question')
  assert.deepEqual((await judgeHealth({ exitCode: 0, output: '✖ 3 problems (3 errors, 0 warnings)', ask: asking(0.95) })).health, 'unknown', 'a reported problem lowers exit 0 to unknown')
  assert.deepEqual((await judgeHealth({ exitCode: 0, output: 'maybe fine', ask: asking(0.5) })).reasons, ['output_unsure'])
  assert.deepEqual((await judgeHealth({ exitCode: 0, output: 'compiled successfully', ask: asking(0.03) })).reasons, ['exit_ok'])
  assert.deepEqual((await judgeHealth({ exitCode: 0, output: 'compiled', ask: null })).reasons, ['exit_ok'], 'no judge: the exit status stands (P2)')
  assert.deepEqual((await judgeHealth({ exitCode: 0, output: 'x', ask: async () => { throw new Error('timeout') } })).reasons, ['exit_ok'])
  // a predicate never makes a failure healthy, and a command that did not finish is never healthy
  for (const p of [0, 0.5, 1]) assert.notEqual((await judgeHealth({ exitCode: 2, output: 'all good', ask: asking(p) })).health, 'healthy')
  assert.deepEqual(await judgeHealth({ exitCode: null, output: '  4 passing (2ms)', ask: asking(0) }), { health: 'unknown', reasons: ['no_exit_status'], summary: { runner: 'mocha', passed: 4, failed: 0, total: null, line: '4 passing (2ms)' } })
})

test('dev server: ready only when a loopback port accepts a connection; the output only names candidates; "it says it listens" stays a hint', async () => {
  const probed = []
  const probe = open => async port => { probed.push(port); return open.includes(port) }
  assert.deepEqual(await judgeServerReady({ exited: true, probe: probe([5173]) }), { ready: 'not_ready', reasons: ['exited'] })
  assert.deepEqual(await judgeServerReady({ port: 3000, probe: probe([3000]) }), { ready: 'ready', reasons: ['port_accepts'], port: 3000 })
  const ask = asking(0.99)
  assert.deepEqual(await judgeServerReady({ port: 3000, output: 'ready - started server on 0.0.0.0:3000', probe: probe([]), ask }), { ready: 'not_ready', reasons: ['port_refused'] })
  assert.equal(ask.calls.length, 0, 'the probe answered: no question')
  assert.deepEqual(await judgeServerReady({ output: '  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.0.2.7:5173/', probe: probe([5173]) }), { ready: 'ready', reasons: ['port_accepts'], port: 5173 })
  assert.deepEqual(portsInOutput('http://example.test:8080 and http://127.0.0.1:4000 and localhost:99999'), [4000], 'loopback only, valid ports only')
  assert.deepEqual(await judgeServerReady({ output: 'Server started, listening', ask: asking(0.97) }), { ready: 'unknown', reasons: ['no_port', 'output_says_listening'] }, 'never ready from the predicate')
  assert.deepEqual(await judgeServerReady({ output: 'http://localhost:5173/', ask: asking(0.97) }), { ready: 'unknown', reasons: ['no_probe', 'output_says_listening'] })
})

test('worktree: git status porcelain decides (conflicts, uncommitted, untracked); without it the predicate is only a hint', async () => {
  assert.deepEqual(parsePorcelain('UU src/a.js\nAA src/b.js\n M src/c.js\nM  src/d.js\n?? notes.md\n!! dist/x.js\n'), { conflicts: 2, uncommitted: 2, untracked: 1 })
  assert.deepEqual(await judgeWorktree({ porcelain: 'UU src/a.js\n' }), { state: 'conflict', reasons: ['git_status'], conflicts: 1, uncommitted: 0, untracked: 0 })
  assert.equal((await judgeWorktree({ porcelain: ' M src/c.js\n' })).state, 'uncommitted_work')
  assert.equal((await judgeWorktree({ porcelain: '?? notes.md\n' })).state, 'uncommitted_work')
  assert.equal((await judgeWorktree({ porcelain: '' })).state, 'clean')
  const ask = asking(0.96)
  assert.deepEqual(await judgeWorktree({ porcelain: null, output: 'CONFLICT (content): Merge conflict in src/a.js', ask }), { state: 'unknown', reasons: ['no_git_status', 'output_reports_conflict'] })
  assert.equal((await judgeWorktree({ porcelain: 'UU x\n', ask })).state, 'conflict'); assert.equal(ask.calls.length, 1, 'with git status no question')
})

test('requests: one condition per question, the output tail quoted once, bounded; each passes the grouped-question lint', () => {
  const tail = 'x'.repeat(5000) + '\nCONFLICT (content): Merge conflict in a.js'
  const request = conditionRequest(Object.keys(CONDITION_PREDICATES), { command: 'git merge topic', output: tail })
  assert.deepEqual(request.questions.map(q => [q.type, q.name]), Object.keys(CONDITION_PREDICATES).map(name => ['predicate', name]))
  assert.equal(request.input[1].content[0].data.output_tail.length, 3000); assert.match(request.input[1].content[0].data.output_tail, /CONFLICT/)
  assert.equal(lintGroupedRequest({ input: request.input, questions: request.questions }).ok, true)
})

test('terminal facts: the heartbeat gets flat facts; the message evidence quotes the runner\'s own summary line only where command output may be sent', () => {
  const chat = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null })
  const run = { conversationId: 'c', runId: 'T', answerId: 'c/T', activities: [] }
  chat.runs.set('c/T', run)
  chat.noteOwnCommand(run, { exitCode: 0, durationMs: 4200, health: { health: 'healthy', reasons: ['summary_passed'], summary: { runner: 'node_test', passed: 40, failed: 0, total: 40, line: '# tests 40 / # pass 40 / # fail 0' } },
    worktree: { state: 'uncommitted_work', reasons: ['git_status'], conflicts: 0, uncommitted: 2, untracked: 0 } })
  assert.deepEqual(chat.ownCommandFacts('c'), { exit_code: 0, duration_ms: 4200, health: 'healthy', test_summary: true, tests_passed: 40, tests_failed: 0, tests_total: 40, worktree: 'uncommitted_work', conflicts: 0, uncommitted: 2 })
  const hb = { sinceUserMs: 9000, sinceEngineMs: 1000, stepsDone: 1, sources: {} }
  const text = kinds => messageEvidence({ kind: 'progress', run, heartbeatFacts: hb, allows: k => kinds.includes(k) }).find(i => i.id === 'now').text
  assert.match(text(['command_output']), /The last command EG-Desk ran ended with exit code 0; its test runner's own summary line reads "# tests 40 \/ # pass 40 \/ # fail 0" \(40 passed, 0 failed, 40 in total\); the folder has uncommitted changes\./)
  assert.match(text([]), /its test runner counted 40 passed, 0 failed, 40 in total/); assert.doesNotMatch(text([]), /# pass/)
  chat.noteOwnCommand(run, { exitCode: 0, health: { health: 'unknown', reasons: ['output_reports_problem'], summary: null }, worktree: { state: 'conflict', conflicts: 1, uncommitted: 0, untracked: 0 } })
  assert.match(text(['command_output']), /exit code 0; whether it fully worked is not confirmed; git reports 1 file in conflict\./)
  const bare = { conversationId: 'd', runId: 'U', answerId: 'd/U', activities: [] }
  assert.doesNotMatch(messageEvidence({ kind: 'progress', run: bare, heartbeatFacts: hb }).find(i => i.id === 'now').text, /EG-Desk ran/, 'nothing new without an own command')
})
