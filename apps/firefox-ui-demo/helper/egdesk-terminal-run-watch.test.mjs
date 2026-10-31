import test from 'node:test'
import assert from 'node:assert/strict'
import { TERMINAL_RUN_WATCH_LIMITS, createTerminalRunWatch } from './egdesk-terminal-run-watch.mjs'
import { TerminalSessionRegistry } from './terminal-sessions.mjs'
import { createWorkflowEventBus } from './egdesk-event-bus.mjs'

// PTY output of `node --test test/` as a shell relays it: echo, CRLF lines,
// the summary, then (node 24) the failing-tests details after the summary.
const CRLF = text => text.replace(/\n/g, '\r\n')
const SUMMARY = CRLF(`$ node --test test/
\u001b[32m✔\u001b[0m adds numbers (0.2ms)
\u001b[31m✖\u001b[0m subtracts numbers (0.3ms)
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 28.1
`)
const DETAILS = CRLF(`
✖ failing tests:

test at test/math.test.mjs:4:1
✖ subtracts numbers (0.3ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

      at TestContext.<anonymous> (file:///work/proj/test/math.test.mjs:4:42)
      at Test.runInAsyncScope (node:async_hooks:214:14)
`)
const JEST = CRLF(`Tests:       2 passed, 2 total
Time:        0.5 s
`)

test('a typed test command whose summary completes becomes one result on the next read', () => {
  const watch = createTerminalRunWatch({ now: () => 1_700_000_000_000 })
  watch.observeInput('t1', 'node --test test/\r')
  watch.observeOutput('t1', SUMMARY)
  assert.equal(watch.snapshot().pending, 0, 'the summary line alone prepares nothing yet')
  watch.observeOutput('t1', Buffer.from(DETAILS))
  const result = watch.take('t1')
  assert.deepEqual([result.protocolVersion, result.seq, result.at, result.command, result.runner, result.outcome, result.parsed],
    [1, 1, '2023-11-14T22:13:20.000Z', 'node --test test/', 'node-test', 'failed', true])
  assert.deepEqual(result.counts, { passed: 1, failed: 1, skipped: 0, todo: 0, total: 2 })
  assert.equal(result.headline, '1 통과 · 1 실패')
  assert.equal(result.durationMs, 28)
  assert.deepEqual(result.failures.map(failure => [failure.name, failure.location?.label, failure.location?.inProject]),
    [['subtracts numbers', '/work/proj/test/math.test.mjs:4:42', true]])
  assert.ok(result.output.includes('✖ failing tests:'), 'the details printed after the summary are part of the run')
  assert.ok(!result.output.includes('\u001b['), 'colour codes are removed')
  assert.equal(result.outputTruncated, false)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(watch.take('t1'), null)
  assert.equal(watch.take('unknown'), null)
})

test('Enter closes a detected run before its read; the next command starts a fresh window', () => {
  const watch = createTerminalRunWatch()
  watch.observeInput('t1', 'npm test\r')
  watch.observeOutput('t1', JEST)
  watch.observeInput('t1', 'npm run build\r')
  watch.observeOutput('t1', CRLF('built in 1.2s\n'))
  const first = watch.take('t1')
  assert.deepEqual([first.command, first.runner, first.headline], ['npm test', 'jest', '2 통과'])
  assert.ok(!first.output.includes('built in'), 'the later command output is not part of the run')
  assert.equal(watch.take('t1'), null, 'a build without a runner summary is not a result')
})

test('typed lines: backspace edits, Ctrl-C and Ctrl-U clear, escape sequences and empty Enter are ignored', () => {
  const watch = createTerminalRunWatch()
  watch.observeInput('t1', 'npm tesr\u007ft')
  watch.observeInput('t1', '\u001b[A')
  watch.observeInput('t1', '\r')
  watch.observeOutput('t1', JEST)
  assert.equal(watch.take('t1').command, 'npm test')
  watch.observeInput('t1', 'rm -rf x\u0003')
  watch.observeInput('t1', '\r')
  watch.observeInput('t1', 'ls\u0015')
  watch.observeInput('t1', 'npx jest\r')
  watch.observeOutput('t1', JEST)
  assert.equal(watch.take('t1').command, 'npx jest')
  watch.observeInput('t1', '\r\r')
  watch.observeOutput('t1', JEST)
  assert.equal(watch.take('t1').command, 'npx jest', 'an empty Enter keeps the last command label')
})

test('through the registry: /terminal/read carries runResult once, write feeds the command label', async () => {
  const watch = createTerminalRunWatch()
  const registry = new TerminalSessionRegistry({ runWatch: watch })
  const handlers = new Set()
  const process = { onData: handler => { handlers.add(handler); return { dispose() {} } }, onExit: () => ({ dispose() {} }), write() {}, kill() {}, resize() {} }
  registry.register({ id: 'pty-1', process, usePty: true, shell: '/bin/zsh', cols: 80, rows: 24 })
  const written = await registry.write('pty-1', 'node --test test/\r')
  assert.equal(written.ok, true)
  for (const handler of handlers) handler(SUMMARY + DETAILS)
  const read = registry.read('pty-1')
  assert.equal(read.data, SUMMARY + DETAILS, 'the terminal still gets every byte')
  assert.equal(read.runResult.command, 'node --test test/')
  assert.equal(read.runResult.headline, '1 통과 · 1 실패')
  assert.equal(Object.hasOwn(registry.read('pty-1'), 'runResult'), false, 'a result is handed out once')
  const plain = new TerminalSessionRegistry()
  plain.register({ id: 'pty-2', process, usePty: true, shell: '/bin/zsh', cols: 80, rows: 24 })
  assert.equal(Object.hasOwn(plain.read('pty-2'), 'runResult'), false, 'a registry without a watch is unchanged')
})

test('RT-06 terminal.exit on the bus drops that session; close unsubscribes', async () => {
  const bus = createWorkflowEventBus()
  const watch = createTerminalRunWatch({ bus, owner: 'egdesk-local' })
  watch.observeInput('t1', 'npm test\r')
  watch.observeOutput('t1', JEST)
  watch.observeInput('t2', 'npm test\r')
  watch.observeOutput('t2', JEST)
  assert.equal(watch.snapshot().sessions, 2)
  bus.publish({ topic: 'terminal.exit', owner: 'egdesk-local', payload: { sessionId: 't1', exitCode: 0 } })
  await bus.flush()
  assert.equal(watch.take('t1'), null, 'an exited shell leaves no result behind')
  assert.equal(watch.take('t2').headline, '2 통과', 'other sessions keep theirs')
  bus.publish({ topic: 'terminal.exit', owner: 'other-owner', payload: { sessionId: 't2', exitCode: 0 } })
  await bus.flush()
  assert.equal(watch.snapshot().sessions, 1, 'another owner scope is not ours')
  watch.close()
  assert.equal(bus.stats().subscribers, 0)
  assert.equal(watch.snapshot().sessions, 0)
})

test('bounds: the window, the handed-out output, pending results and the session count stay limited', () => {
  const limits = { windowChars: 4096, outputChars: 2048, maxPending: 2, maxSessions: 2 }
  const watch = createTerminalRunWatch({ limits })
  watch.observeInput('t1', 'npm test\r')
  watch.observeOutput('t1', `${'noise line\r\n'.repeat(1000)}${JEST}`)
  const result = watch.take('t1')
  assert.equal(result.headline, '2 통과')
  assert.equal(result.output.length, limits.outputChars)
  assert.equal(result.outputTruncated, true)
  for (let i = 0; i < 4; i++) { watch.observeInput('t1', `npm test ${i}\r`); watch.observeOutput('t1', JEST) }
  assert.equal(watch.snapshot().pending, limits.maxPending, 'older unread results are dropped first')
  assert.deepEqual([watch.take('t1').command, watch.take('t1').command, watch.take('t1')], ['npm test 2', 'npm test 3', null])
  for (const id of ['a', 'b', 'c']) watch.observeOutput(id, 'x\r\n')
  assert.equal(watch.snapshot().sessions, limits.maxSessions)
  assert.equal(TERMINAL_RUN_WATCH_LIMITS.windowChars, 64 * 1024)
  watch.observeOutput('', JEST); watch.observeOutput(null, JEST); watch.observeInput(undefined, 'x\r')
  assert.equal(watch.snapshot().sessions, limits.maxSessions, 'invalid session IDs are ignored')
})
