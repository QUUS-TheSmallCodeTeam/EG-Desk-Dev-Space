import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RUN_RESULT_PARSE_LIMITS, commandDisplay, detectRunner, firstLocation, locationsInLine, parseCounts, parseDuration,
  parseFailures, resolveLocation, runSummaryEnd, stripAnsi, summarizeCommandOutput,
} from './egdesk-run-result-parse.mjs'

const ROOT = '/work/proj'

// Real `node --test` spec reporter shape (node 24); only the path was replaced.
const NODE_SPEC = `✔ adds numbers (0.235375ms)
✖ subtracts numbers (0.28075ms)
﹣ skipped one (0.028584ms) # SKIP
✔ multiplies (0.029792ms)
ℹ tests 4
ℹ suites 0
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 28.148125
`
const NODE_SPEC_FAILURES = `
✖ failing tests:

test at test/math.test.mjs:4:1
✖ subtracts numbers (0.28075ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 1

      at TestContext.<anonymous> (file:///work/proj/test/math.test.mjs:4:42)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1106:25) {
    generatedMessage: true,
    code: 'ERR_ASSERTION'
  }
`
const NODE_TAP = `TAP version 13
# Subtest: adds numbers
ok 1 - adds numbers
  ---
  duration_ms: 0.231875
  ...
# Subtest: subtracts numbers
not ok 2 - subtracts numbers
  ---
  duration_ms: 0.417958
  location: '/work/proj/test/math.test.mjs:4:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    2 !== 1

  code: 'ERR_ASSERTION'
  stack: |-
    TestContext.<anonymous> (file:///work/proj/test/math.test.mjs:4:42)
  ...
# Subtest: skipped one
ok 3 - skipped one # SKIP
1..4
# tests 4
# suites 0
# pass 2
# fail 1
# cancelled 0
# skipped 1
# todo 0
# duration_ms 28.0165
`
const JEST = `FAIL src/math.test.js
  math
    ✓ adds (2 ms)
    ✕ subtracts (3 ms)

  ● math › subtracts

    expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 2

      10 |   test('subtracts', () => {
    > 11 |     expect(3 - 1).toBe(1)
         |                   ^
      12 |   })

      at Object.toBe (node_modules/expect/build/index.js:1:1)
      at Object.toBe (src/math.test.js:11:19)

PASS src/other.test.js

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 12 passed, 13 total
Snapshots:   0 total
Time:        1.234 s
Ran all test suites.
`
const VITEST = ` ❯ src/math.test.ts (2 tests | 1 failed) 5ms
   × math > subtracts 3ms
     → expected 2 to be 1 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/math.test.ts > math > subtracts
AssertionError: expected 2 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 2

 ❯ src/math.test.ts:11:19
      9|   test('subtracts', () => {
     10|     expect(3 - 1).toBe(1)
     11|   })
       |                   ^

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 12 passed (13)
   Start at  10:00:00
   Duration  1.23s (transform 50ms, setup 0ms, collect 100ms, tests 5ms)
`
const CARGO = `running 2 tests
test tests::adds ... ok
test tests::subtracts ... FAILED

failures:

---- tests::subtracts stdout ----

thread 'tests::subtracts' panicked at src/lib.rs:12:9:
assertion \`left == right\` failed
  left: 2
 right: 1

failures:
    tests::subtracts

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests proj

running 1 test
test src/lib.rs - add (line 3) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s
`

test('node --test spec: counts, the failing test, its first message line and project line', () => {
  const result = summarizeCommandOutput({ command: 'node --test test/', output: NODE_SPEC + NODE_SPEC_FAILURES, cwd: ROOT })
  assert.deepEqual([result.parsed, result.runner, result.kind, result.outcome], [true, 'node-test', 'test', 'failed'])
  assert.deepEqual(result.counts, { passed: 2, failed: 1, skipped: 1, todo: 0, total: 4 })
  assert.equal(result.headline, '2 통과 · 1 실패 · 1 건너뜀')
  assert.equal(result.durationMs, 28)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].name, 'subtracts numbers')
  assert.equal(result.failures[0].message, 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:')
  assert.deepEqual(result.failures[0].location, { path: `${ROOT}/test/math.test.mjs`, relativePath: 'test/math.test.mjs', line: 4, column: 42, label: 'test/math.test.mjs:4:42', inProject: true })
  assert.equal(result.firstLocation, result.failures[0].location)
})

test('node --test TAP: the same counts, the YAML error field and the location line', () => {
  const result = summarizeCommandOutput({ command: 'node --test --test-reporter=tap test/', output: NODE_TAP })
  assert.deepEqual(result.counts, { passed: 2, failed: 1, skipped: 1, todo: 0, total: 4 })
  assert.equal(result.failures[0].name, 'subtracts numbers')
  assert.equal(result.failures[0].message, 'Expected values to be strictly equal:')
  // Without a cwd an absolute path is kept as printed and counts as a project file.
  assert.deepEqual(result.failures[0].location, { path: `${ROOT}/test/math.test.mjs`, relativePath: null, line: 4, column: 1, label: '/work/proj/test/math.test.mjs:4:1', inProject: true })
})

test('jest: 12 통과 · 1 실패, the first project frame (node_modules skipped), Time as duration', () => {
  const result = summarizeCommandOutput({ command: 'npm test', output: JEST, cwd: ROOT })
  assert.deepEqual([result.runner, result.headline, result.durationMs], ['jest', '12 통과 · 1 실패', 1234])
  assert.deepEqual(result.counts, { passed: 12, failed: 1, skipped: 0, todo: 0, total: 13 })
  assert.deepEqual(result.failures.map(failure => [failure.name, failure.message, failure.location?.label]), [
    ['math › subtracts', 'expect(received).toBe(expected) // Object.is equality', 'src/math.test.js:11:19'],
  ])
})

test('vitest: counts with the (total), the FAIL block message and the ❯ frame', () => {
  const result = summarizeCommandOutput({ command: 'npx vitest run', output: VITEST, cwd: ROOT })
  assert.deepEqual([result.runner, result.headline, result.durationMs], ['vitest', '12 통과 · 1 실패', 1230])
  assert.deepEqual(result.failures.map(failure => [failure.name, failure.message, failure.location?.label]), [
    ['src/math.test.ts > math > subtracts', 'AssertionError: expected 2 to be 1 // Object.is equality', 'src/math.test.ts:11:19'],
  ])
})

test('cargo test: binaries are summed, the panic message is the line after "panicked at"', () => {
  const result = summarizeCommandOutput({ command: 'cargo test', output: CARGO, cwd: ROOT })
  assert.deepEqual([result.runner, result.headline, result.durationMs], ['cargo-test', '2 통과 · 1 실패', 100])
  assert.deepEqual(result.counts, { passed: 2, failed: 1, skipped: 0, todo: 0, total: 3 })
  assert.deepEqual(result.failures.map(failure => [failure.name, failure.message, failure.location?.label]), [
    ['tests::subtracts', 'assertion `left == right` failed', 'src/lib.rs:12:9'],
  ])
  const old = parseFailures(`---- tests::old stdout ----\nthread 'tests::old' panicked at 'boom', src/old.rs:3:5\n`, 'cargo-test')
  assert.deepEqual([old[0].message, old[0].location.label], ['boom', 'src/old.rs:3:5'])
})

test('no runner: the exit code decides; a path:line in the first error line is the target', () => {
  const tsc = summarizeCommandOutput({ command: 'npx tsc', exitCode: 2, output: "src/app.ts:3:5 - error TS2322: Type 'string' is not assignable to type 'number'.\n", cwd: ROOT })
  assert.deepEqual([tsc.parsed, tsc.runner, tsc.kind, tsc.outcome, tsc.headline], [false, null, 'other', 'failed', '실패 · 종료 코드 2'])
  assert.equal(tsc.failures[0].name, null)
  assert.equal(tsc.failures[0].location.label, 'src/app.ts:3:5')
  const ok = summarizeCommandOutput({ command: 'npm run build', exitCode: 0, output: 'built in 1.2s\n' })
  assert.deepEqual([ok.outcome, ok.headline, ok.failures], ['passed', '완료', []])
  const windows = summarizeCommandOutput({ command: 'tsc', exitCode: 1, output: 'C:\\work\\src\\a.ts(3,5): error TS2322: no\r\n', cwd: 'C:\\work' })
  assert.deepEqual(windows.failures[0].location, { path: 'C:\\work\\src\\a.ts', relativePath: 'src/a.ts', line: 3, column: 5, label: 'src/a.ts:3:5', inProject: true })
})

test("unparseable output with no exit code falls to '요약 없음 · 원문 보기'", () => {
  const result = summarizeCommandOutput({ command: 'make', output: 'building…\ndone\n' })
  assert.deepEqual([result.parsed, result.outcome, result.headline, result.counts, result.failures, result.durationMs], [false, 'unknown', '요약 없음 · 원문 보기', null, [], null])
  assert.equal(summarizeCommandOutput({ output: '' }).headline, '요약 없음 · 원문 보기')
})

test('a wrapper can fail the run with every test passing; counts then carry the exit code', () => {
  const result = summarizeCommandOutput({ command: 'npm test', exitCode: 1, output: 'Tests:       5 passed, 5 total\n' })
  assert.deepEqual([result.outcome, result.headline], ['failed', '5 통과 · 종료 코드 1'])
})

test('runSummaryEnd: only a complete summary-closing line ends a run, the last one wins', () => {
  assert.equal(runSummaryEnd(''), null)
  assert.equal(runSummaryEnd('building…\ndone\n'), null)
  const partial = NODE_SPEC.replace(/\n$/, '')
  assert.equal(runSummaryEnd(partial), null, 'a duration line without its newline is not complete')
  assert.deepEqual(runSummaryEnd(NODE_SPEC), { runner: 'node-test', end: NODE_SPEC.length })
  const stream = `$ node --test test/\r\n${NODE_SPEC.replace(/\n/g, '\r\n')}${NODE_SPEC_FAILURES.replace(/\n/g, '\r\n')}`
  const found = runSummaryEnd(stream)
  assert.equal(found.runner, 'node-test')
  assert.ok(stream.slice(0, found.end).endsWith('ℹ duration_ms 28.148125\r\n'))
  assert.deepEqual(runSummaryEnd(JEST), { runner: 'jest', end: JEST.length })
  assert.deepEqual(runSummaryEnd(VITEST), { runner: 'vitest', end: VITEST.length })
  assert.deepEqual(runSummaryEnd(CARGO), { runner: 'cargo-test', end: CARGO.length })
  assert.equal(runSummaryEnd('Time: 1.2 s\n'), null, 'a closing line without the summary before it is not a run')
  assert.equal(runSummaryEnd('\u001b[32mTests:\u001b[0m 2 passed, 2 total\n\u001b[1mTime:\u001b[0m 0.5 s\n')?.runner, 'jest')
})

test('ANSI colour and PTY line endings do not change counts, failures or durations', () => {
  const coloured = JEST.replace(/\n/g, '\r\n').replace('Tests:', '\u001b[1mTests:\u001b[22m').replace('● math › subtracts', '\u001b[31m● math › subtracts\u001b[39m')
  assert.deepEqual(parseCounts(coloured, 'jest'), { passed: 12, failed: 1, skipped: 0, todo: 0, total: 13 })
  assert.equal(parseDuration(coloured, 'jest'), 1234)
  assert.equal(detectRunner(coloured), 'jest')
  assert.equal(parseFailures(coloured, 'jest')[0].name, 'math › subtracts')
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red')
})

test('locations: path:line[:col], path(line,col), file URLs; node internals and node_modules are never targets', () => {
  assert.deepEqual(locationsInLine('    at Object.toBe (src/math.test.js:11:19)').map(location => location.label), ['src/math.test.js:11:19'])
  assert.deepEqual(locationsInLine('at run (node:internal/test_runner/test:1106:25)'), [])
  assert.deepEqual(locationsInLine('at x (node_modules/expect/build/index.js:1:1)'), [])
  assert.deepEqual(locationsInLine('at TestContext.<anonymous> (file:///work/proj/test/math.test.mjs:4:42)').map(location => location.path), ['/work/proj/test/math.test.mjs'])
  assert.deepEqual(locationsInLine('src/a.ts(3,5): error TS2322').map(location => [location.line, location.column]), [[3, 5]])
  assert.equal(resolveLocation('~/notes.txt', 3, null).inProject, false)
  assert.equal(resolveLocation('/tmp/other/x.js', 3, null, { cwd: ROOT }).inProject, false)
  assert.equal(resolveLocation('../outside.js', 3, null, { cwd: ROOT }).inProject, false)
  assert.equal(resolveLocation('src/x.js', 0, null), null)
  assert.equal(firstLocation(['Error: no', '  at a (node:fs:1:1)', '  at b (/work/proj/src/b.js:7:3)'], { cwd: ROOT }).label, 'src/b.js:7:3')
})

test('commandDisplay strips control characters and stays short; large output stays bounded', () => {
  assert.equal(commandDisplay('  npm \u001b[1mtest\u001b[0m\u0007  --  watch '), 'npm test -- watch')
  assert.equal(commandDisplay(''), null)
  assert.equal(commandDisplay('x'.repeat(300)).length, RUN_RESULT_PARSE_LIMITS.commandChars + 1)
  const huge = `${'noise\n'.repeat(60000)}${JEST}`
  const started = Date.now()
  const result = summarizeCommandOutput({ command: 'npm test', output: huge, cwd: ROOT })
  assert.ok(Date.now() - started < 1000)
  assert.deepEqual([result.outputTruncated, result.counts.failed, result.failures.length], [true, 1, 1])
  const many = `${'● test n\n  boom\n\n'.repeat(50)}Tests: 50 failed, 50 total\n`
  assert.equal(summarizeCommandOutput({ output: many }).failures.length, 1, 'repeated names are reported once')
  const distinct = `${Array.from({ length: 50 }, (_, i) => `● test ${i}\n  boom\n\n`).join('')}Tests: 50 failed, 50 total\n`
  assert.equal(summarizeCommandOutput({ output: distinct }).failures.length, RUN_RESULT_PARSE_LIMITS.maxFailures)
})
