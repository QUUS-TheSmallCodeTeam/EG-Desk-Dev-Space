import test from 'node:test'
import assert from 'node:assert/strict'
import { prefixBytes, RUN_OUTPUT_LIMITS, RunOutputStore, suffixBytes } from './codex-run-outputs.mjs'

test('limits match the 1-R plan: 256 KiB per file, 1 MiB per run and turn, 8 KiB head and 64 KiB tail', () => {
  assert.deepEqual([RUN_OUTPUT_LIMITS.fileDiffBytes, RUN_OUTPUT_LIMITS.runDiffBytes, RUN_OUTPUT_LIMITS.turnDiffBytes, RUN_OUTPUT_LIMITS.commandHeadBytes, RUN_OUTPUT_LIMITS.commandTailBytes],
    [256 * 1024, 1024 * 1024, 1024 * 1024, 8 * 1024, 64 * 1024])
  assert.ok(Object.isFrozen(RUN_OUTPUT_LIMITS))
})

test('byte cuts never split a UTF-8 character', () => {
  assert.equal(prefixBytes('가나다', 4), '가')
  assert.equal(prefixBytes('가나다', 6), '가나')
  assert.equal(prefixBytes('abc', 0), '')
  assert.equal(suffixBytes('가나다', 4), '다')
  assert.equal(suffixBytes('ab가', 3), '가')
  assert.equal(suffixBytes('abc', 10), 'abc')
})

test('command output keeps the first and last bytes in order and counts what fell between', () => {
  const store = new RunOutputStore({ limits: { commandHeadBytes: 8, commandTailBytes: 6 } })
  store.appendCommandOutput('run', 'cmd', 'HEAD1234')
  store.appendCommandOutput('run', 'cmd', 'middle-')
  store.appendCommandOutput('run', 'cmd', 'TAIL56')
  let output = store.commandOutput('run', 'cmd')
  assert.deepEqual([output.head, output.tail, output.omittedBytes, output.totalBytes, output.complete], ['HEAD1234', 'TAIL56', 7, 21, false])
  // Once text spills past the head, later short pieces go to the tail, not back to the head.
  const split = new RunOutputStore({ limits: { commandHeadBytes: 4, commandTailBytes: 64 } })
  split.appendCommandOutput('run', 'cmd', 'ab가나')
  split.appendCommandOutput('run', 'cmd', 'z')
  output = split.commandOutput('run', 'cmd')
  assert.deepEqual([output.head, output.tail], ['ab', '가나z'])
  // Codex's own copy replaces a shorter stream and completes the command.
  store.completeCommand('run', 'cmd', 'HEAD1234-the-whole-output-TAIL56!')
  output = store.commandOutput('run', 'cmd')
  assert.deepEqual([output.head, output.tail, output.totalBytes, output.complete], ['HEAD1234', 'AIL56!', 33, true])
  store.completeCommand('run', 'cmd', 'short')
  assert.equal(store.commandOutput('run', 'cmd').totalBytes, 33, 'a shorter copy never replaces what streamed')
  store.completeCommand('run', 'none', undefined)
  assert.equal(store.commandOutput('run', 'none'), null)
  store.completeCommand('run', 'empty', '')
  assert.deepEqual([store.commandOutput('run', 'empty').totalBytes, store.commandOutput('run', 'empty').complete], [0, true])
})

test('command output and diffs are redacted when read, not rewritten when kept', () => {
  const store = new RunOutputStore()
  store.appendCommandOutput('run', 'cmd', 'export API_KEY=SECRET_VALUE\n')
  assert.equal(store.commandOutput('run', 'cmd').head, 'export API_KEY=[REDACTED]\n')
  assert.ok(store.entries.get('run').commands.get('cmd').head.includes('SECRET_VALUE'))
  store.setFileChanges('run', 'edit', [{ path: '/w/.env', kind: { type: 'add' }, diff: 'token=SECRET_TOKEN\n' }])
  assert.equal(store.changes('run').items[0].files[0].diff, 'token=[REDACTED]\n')
})

test('file diffs over the file or run limit are dropped whole, and an item update replaces its files', () => {
  const store = new RunOutputStore({ limits: { fileDiffBytes: 10, runDiffBytes: 14 } })
  store.setFileChanges('run', 'edit-1', [
    { path: 'a', kind: { type: 'update', move_path: 'b' }, diff: '12345678' },
    { path: 'big', kind: { type: 'add' }, diff: '12345678901' },
    { path: 'c', kind: { type: 'delete' }, diff: '1234567' },
    { path: 'd', kind: { type: 'mystery' } },
    { kind: { type: 'add' }, diff: 'no path' },
  ], 'inProgress')
  let files = store.changes('run').items[0].files
  assert.deepEqual(files.map(file => [file.path, file.kind, file.movePath, file.diff, file.bytes, file.omitted]), [
    ['a', 'update', 'b', '12345678', 8, null], ['big', 'add', null, null, 11, 'fileLimit'],
    ['c', 'delete', null, null, 7, 'runLimit'], ['d', 'update', null, null, 0, 'unavailable']])
  store.setFileChanges('run', 'edit-1', [{ path: 'c', kind: { type: 'delete' }, diff: '1234567' }], 'completed')
  files = store.changes('run').items[0].files
  assert.deepEqual(files.map(file => [file.path, file.omitted]), [['c', null]])
  assert.equal(store.changes('run').items[0].status, 'completed')
  store.setFileChanges('run', 'edit-1', [{ path: 'c', kind: { type: 'delete' }, diff: '1234567' }])
  assert.equal(store.changes('run').items[0].status, 'completed', 'a patch update keeps the known status')
  store.setTurnDiff('run', 'x'.repeat(RUN_OUTPUT_LIMITS.turnDiffBytes + 1))
  assert.deepEqual(store.changes('run').turn, { diff: null, bytes: RUN_OUTPUT_LIMITS.turnDiffBytes + 1, omitted: 'turnLimit' })
  assert.deepEqual(store.changes('missing'), { retained: false, turn: null, items: [], commands: [], limits: store.changes('missing').limits })
})

test('a run keeps a bounded number of items and commands, and all runs together stay within the total', () => {
  const store = new RunOutputStore({ limits: { itemsPerRun: 2, commandsPerRun: 2, totalBytes: 30 } })
  for (const id of ['e1', 'e2', 'e3']) store.setFileChanges('run-a', id, [{ path: id, kind: { type: 'add' }, diff: 'x' }])
  assert.deepEqual(store.changes('run-a').items.map(item => item.itemId), ['e2', 'e3'])
  for (const id of ['c1', 'c2', 'c3']) store.appendCommandOutput('run-a', id, 'yy')
  assert.deepEqual(store.changes('run-a').commands.map(output => output.itemId), ['c2', 'c3'])
  assert.equal(store.totalBytes, 2 + 4)
  store.appendCommandOutput('run-b', 'c1', 'z'.repeat(28))
  assert.deepEqual(store.keys(), ['run-b'], 'the oldest other run goes first')
  assert.equal(store.totalBytes, 28)
  store.forget('run-b')
  assert.deepEqual([store.keys(), store.totalBytes], [[], 0])
})
