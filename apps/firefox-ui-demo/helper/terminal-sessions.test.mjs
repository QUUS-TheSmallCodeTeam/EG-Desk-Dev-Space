import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TerminalSessionRegistry, terminalResponseStatus } from './terminal-sessions.mjs'

class PtyProcess {
  constructor() { this.data = new Set(); this.exits = new Set(); this.killCalls = 0; this.killError = null }
  onData(handler) { this.data.add(handler); return { dispose: () => this.data.delete(handler) } }
  onExit(handler) { this.exits.add(handler); return { dispose: () => this.exits.delete(handler) } }
  kill() { this.killCalls++; if (this.killError) throw this.killError }
  write() {}
  resize() {}
  output(text) { for (const handler of this.data) handler(text) }
  exit(code = 0, signal = 0) { for (const handler of [...this.exits]) handler({ exitCode: code, signal }) }
}
class ChildProcess extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.stdin = { write() {} }; this.killCalls = 0 }
  kill() { this.killCalls++; return this.killResult ?? true }
}
function register(registry, process = new PtyProcess(), id = 'terminal-1', usePty = true) {
  registry.register({ id, process, usePty, shell: '/bin/zsh', cols: 80, rows: 24 })
  return process
}

test('production kill failure keeps the active process and never confirms exit; retry remains possible', () => {
  const registry = new TerminalSessionRegistry()
  const process = register(registry)
  process.killError = new Error('Native kill failed')
  const result = registry.kill('terminal-1')
  assert.equal(terminalResponseStatus(result), 500)
  assert.equal(result.code, 'KILL_FAILED')
  assert.equal(result.status, 'RUNNING')
  assert.equal(result.stopRequested, false)
  assert.equal(result.exited, false)
  assert.equal(result.exitConfirmed, false)
  assert.equal(registry.active.has('terminal-1'), true)
  assert.equal(registry.exitReceipts.size, 0)
  assert.equal(registry.read('terminal-1').exited, false)
  process.killError = null
  assert.equal(registry.kill('terminal-1').status, 'STOP_REQUESTED')
  assert.equal(process.killCalls, 2)
})

test('kill acknowledgement precedes native PTY exit and does not remove the active entry', () => {
  const registry = new TerminalSessionRegistry()
  const process = register(registry)
  const result = registry.kill('terminal-1')
  assert.equal(result.ok, true)
  assert.equal(result.status, 'STOP_REQUESTED')
  assert.equal(result.exited, false)
  assert.equal(result.exitConfirmed, false)
  assert.equal(registry.active.has('terminal-1'), true)
  assert.equal(registry.read('terminal-1').status, 'STOP_REQUESTED')
  registry.kill('terminal-1')
  assert.equal(process.killCalls, 1)
  process.output('last output\r\n')
  process.exit(143, 15)
  assert.equal(registry.active.has('terminal-1'), false)
  assert.equal(registry.exitReceipts.size, 1)
  const receipt = registry.read('terminal-1')
  assert.equal(receipt.status, 'EXITED')
  assert.equal(receipt.exitConfirmed, true)
  assert.equal(receipt.exited, true)
  assert.equal(receipt.exitCode, 143)
  assert.equal(receipt.exitSource, 'pty.onExit')
  assert.equal(receipt.data, 'last output\r\n')
})

test('exit receipt remains readable after active deletion and output consumption', () => {
  let now = 10
  const registry = new TerminalSessionRegistry({ now: () => now })
  const process = register(registry)
  process.exit(0)
  now = 20
  assert.equal(registry.active.size, 0)
  const first = registry.read('terminal-1')
  const second = registry.read('terminal-1')
  assert.deepEqual(first, second)
  assert.equal(second.exitedAt, 10)
  assert.equal(second.stopRequested, false)
  assert.equal(registry.kill('terminal-1').status, 'EXITED')
  assert.equal(process.killCalls, 0)
})

test('child_process kill returning false is failure until actual exit arrives', () => {
  const registry = new TerminalSessionRegistry()
  const process = register(registry, new ChildProcess(), 'child', false)
  process.killResult = false
  assert.equal(registry.kill('child').code, 'KILL_FAILED')
  assert.equal(registry.active.has('child'), true)
  assert.equal(registry.read('child').exited, false)
  process.emit('exit', null, 'SIGTERM')
  process.stdout.emit('data', Buffer.from('final buffered output'))
  process.emit('close')
  const receipt = registry.read('child')
  assert.equal(receipt.exited, true)
  assert.equal(receipt.exitCode, null)
  assert.equal(receipt.signal, 'SIGTERM')
  assert.equal(receipt.exitSource, 'process.exit')
  assert.equal(receipt.data, 'final buffered output')
})

test('process error or stream close without exit never becomes exit confirmation', () => {
  const registry = new TerminalSessionRegistry()
  const process = register(registry, new ChildProcess(), 'failed-spawn', false)
  process.emit('error', new Error('spawn ENOENT'))
  process.emit('close', -2, null)
  const result = registry.read('failed-spawn')
  assert.equal(result.status, 'UNKNOWN')
  assert.equal(result.exited, null)
  assert.equal(result.exitConfirmed, false)
  assert.equal(result.code, 'PROCESS_ERROR')
  assert.equal(registry.active.has('failed-spawn'), true)
  assert.equal(registry.exitReceipts.size, 0)
})

test('unknown ID and a new bridge instance explicitly return UNKNOWN, not exited', () => {
  const registry = new TerminalSessionRegistry()
  const process = register(registry)
  process.exit(0)
  const restarted = new TerminalSessionRegistry()
  for (const result of [registry.read('missing'), restarted.read('terminal-1'), restarted.kill('terminal-1')]) {
    assert.equal(terminalResponseStatus(result), 404)
    assert.equal(result.status, 'UNKNOWN')
    assert.equal(result.code, 'UNKNOWN_SESSION')
    assert.equal(result.exited, null)
    assert.equal(result.exitConfirmed, false)
  }
})

test('exit receipts have count and time bounds; eviction returns UNKNOWN and never synthesizes exit', () => {
  let now = 0
  const registry = new TerminalSessionRegistry({ now: () => now, maxExitReceipts: 2, exitReceiptTtlMs: 100 })
  for (const id of ['one', 'two', 'three']) { const process = register(registry, new PtyProcess(), id); process.exit(0); now++ }
  assert.equal(registry.exitReceipts.size, 2)
  assert.equal(registry.read('one').status, 'UNKNOWN')
  assert.equal(registry.read('two').status, 'EXITED')
  now = 102
  assert.equal(registry.read('three').status, 'UNKNOWN')
  assert.equal(registry.exitReceipts.size, 0)
})

test('synchronous native exit during kill is confirmed by the event, not by the kill return value', () => {
  const registry = new TerminalSessionRegistry()
  const process = register(registry)
  process.kill = () => process.exit(0)
  const result = registry.kill('terminal-1')
  assert.equal(result.status, 'EXITED')
  assert.equal(result.exitConfirmed, true)
  assert.equal(result.stopRequested, true)
  assert.equal(result.exitSource, 'pty.onExit')
})

test('shutdown stop requests do not clear active sessions or invent receipts', () => {
  const registry = new TerminalSessionRegistry()
  register(registry)
  registry.requestStopAll()
  assert.equal(registry.active.size, 1)
  assert.equal(registry.exitReceipts.size, 0)
  assert.equal(registry.read('terminal-1').status, 'STOP_REQUESTED')
})

test('retained output is bounded and reports actual truncation', () => {
  const registry = new TerminalSessionRegistry({ maxOutputBytes: 4 })
  const process = register(registry)
  process.output('123456')
  process.exit(0)
  const result = registry.read('terminal-1')
  assert.equal(result.outputTruncated, true)
  assert.equal(result.data, '3456')
})

test('stop acceptance fences later input and resize without inventing native exit', () => {
  const registry = new TerminalSessionRegistry()
  const process = register(registry)
  let writes = 0, sizes = 0
  process.write = () => { writes++ }
  process.resize = () => { sizes++ }
  registry.kill('terminal-1')
  for (const result of [registry.write('terminal-1', 'must not run\r'), registry.resize('terminal-1', 100, 30)]) {
    assert.equal(result.ok, false)
    assert.equal(result.code, 'SESSION_STOPPING')
    assert.equal(terminalResponseStatus(result), 409)
    assert.equal(result.exitConfirmed, false)
  }
  assert.equal(writes, 0)
  assert.equal(sizes, 0)
  assert.equal(registry.active.size, 1)
  process.exit(0)
  assert.equal(registry.snapshot('terminal-1').exitConfirmed, true)
})

test('unknown native error cannot report successful later input or resize', () => {
  const registry = new TerminalSessionRegistry()
  const process = register(registry, new ChildProcess(), 'error-terminal', false)
  let writes = 0
  process.stdin.write = () => { writes++ }
  process.emit('error', new Error('native process unavailable'))
  for (const result of [registry.write('error-terminal', 'must not run'), registry.resize('error-terminal', 100, 30)]) {
    assert.equal(result.ok, false)
    assert.equal(result.status, 'UNKNOWN')
    assert.equal(result.code, 'PROCESS_ERROR')
    assert.equal(result.exitConfirmed, false)
  }
  assert.equal(writes, 0)
})

test('RT-06: a confirmed exit is reported once to onExit; kill acceptance and errors report nothing', () => {
  const exits = []
  const registry = new TerminalSessionRegistry({ onExit: receipt => { exits.push(receipt); throw new Error('observer failure is ignored') } })
  const pty = register(registry)
  registry.kill('terminal-1')
  assert.deepEqual(exits, [], 'a stop request is not an exit')
  pty.exit(0, 0)
  pty.exit(0, 0)
  assert.deepEqual(exits, [{ sessionId: 'terminal-1', exitCode: 0, signal: 0, exitSource: 'pty.onExit' }])
  assert.equal(registry.snapshot('terminal-1').status, 'EXITED')
  const child = register(registry, new ChildProcess(), 'terminal-2', false)
  child.emit('error', new Error('spawn failed'))
  child.emit('close')
  assert.equal(exits.length, 1, 'errors and stream closure never synthesize an exit')
  const piped = register(registry, new ChildProcess(), 'terminal-3', false)
  piped.emit('exit', null, 'SIGTERM')
  assert.deepEqual(exits[1], { sessionId: 'terminal-3', exitCode: null, signal: 'SIGTERM', exitSource: 'process.exit' })
})

test('held local PTY only transfers to a different view in the same runtime owner', () => {
  const registry = new TerminalSessionRegistry({ maxOutputBytes: 8 })
  const process = register(registry)
  const id = 'terminal-1', instance = registry.bridgeInstance
  assert.equal(registry.ownLocal(id, 'desk-a', 'view-a').detachSupported, true)
  assert.equal(registry.detachLocal(id, 'desk-other', 'view-a', instance).code, 'TERMINAL_IDENTITY_CHANGED')
  assert.equal(registry.detachLocal(id, 'desk-a', 'view-a', instance).status, 'HELD')
  assert.equal(registry.authorizeLocal(id, 'desk-a', 'view-a').code, 'TERMINAL_NOT_ATTACHED')
  assert.equal(registry.authorizeLocal(id, null, null).code, 'TERMINAL_IDENTITY_CHANGED')
  process.output('too much output')
  assert.equal(registry.attachLocal(id, 'desk-other', 'view-b', instance).code, 'TERMINAL_IDENTITY_CHANGED')
  assert.equal(registry.attachLocal(id, 'desk-a', 'view-a', instance).code, 'TERMINAL_NOT_HELD')
  const resumed = registry.attachLocal(id, 'desk-a', 'view-b', instance)
  assert.equal(resumed.sessionId, id)
  assert.equal(resumed.status, 'RUNNING')
  assert.equal(Object.hasOwn(resumed, 'local'), false)
  assert.strictEqual(registry.active.get(id).process, process)
  assert.equal(registry.authorizeLocal(id, 'desk-a', 'view-a').code, 'TERMINAL_IDENTITY_CHANGED')
  assert.equal(registry.authorizeLocal(id, 'desk-a', 'view-b'), null)
  assert.equal(registry.attachLocal(id, 'desk-a', 'view-c', instance).code, 'TERMINAL_NOT_HELD')
  assert.equal(registry.read(id).data, 'h output')
  assert.equal(process.killCalls, 0)
  process.exit()
  assert.equal(process.data.size, 0)
  assert.equal(process.exits.size, 0)
  assert.equal(registry.snapshot(id).exitConfirmed, true)
})

test('hold expiry, native exit, bridge restart and missing identity stay distinct', async () => {
  let time = 0, sequence = 0
  const jobs = new Map()
  const registry = new TerminalSessionRegistry({ now: () => time, detachedTtlMs: 10,
    maxDetached: 1, schedule: fn => { jobs.set(++sequence, fn); return sequence }, cancel: id => jobs.delete(id) })
  const instance = registry.bridgeInstance
  const one = register(registry, new PtyProcess(), 'one')
  const two = register(registry, new PtyProcess(), 'two')
  register(registry, new ChildProcess(), 'pipe', false)
  for (const id of ['one', 'two', 'pipe']) registry.ownLocal(id, 'desk-a', id)
  assert.equal(registry.detachLocal('pipe', 'desk-a', 'pipe', instance).code, 'TERMINAL_DETACH_UNAVAILABLE')
  assert.equal(registry.detachLocal('one', 'desk-a', 'one', instance).expiresAt, 10)
  assert.equal(registry.detachLocal('two', 'desk-a', 'two', instance).code, 'TERMINAL_DETACH_LIMIT')
  time = 10
  assert.equal(registry.attachLocal('one', 'desk-a', 'new', instance).code, 'TERMINAL_DETACH_EXPIRED')
  assert.equal(one.killCalls, 1)
  assert.equal(registry.snapshot('one').status, 'STOP_REQUESTED')
  assert.equal(registry.snapshot('one').exitConfirmed, false)
  one.exit(143)
  assert.equal(registry.snapshot('one').exitConfirmed, true)
  assert.equal(registry.detachLocal('two', 'desk-a', 'two', instance).status, 'HELD')
  two.output('discard me when no attached viewer exists')
  two.exit()
  assert.equal(registry.attachLocal('two', 'desk-a', 'new', instance).code, 'ORIGINAL_EXITED')
  assert.equal(registry.exitReceipts.get('two').output.length, 0)
  assert.equal(jobs.size, 0)
  assert.equal(registry.attachLocal('missing', 'desk-a', 'new', instance).code, 'ORIGINAL_UNAVAILABLE')
  assert.equal(new TerminalSessionRegistry().attachLocal('one', 'desk-a', 'new', instance).code, 'TERMINAL_BRIDGE_RESTARTED')
})

test('closing a Desk scope requests native stop on its held sessions only', () => {
  const registry = new TerminalSessionRegistry()
  const own = register(registry, new PtyProcess(), 'own')
  const other = register(registry, new PtyProcess(), 'other')
  registry.ownLocal('own', 'desk-a', 'view-a')
  registry.ownLocal('other', 'desk-b', 'view-b')
  const instance = registry.bridgeInstance
  registry.detachLocal('own', 'desk-a', 'view-a', instance)
  registry.closeLocalScope('desk-a')
  assert.equal(own.killCalls, 1)
  assert.equal(other.killCalls, 0)
  assert.equal(registry.snapshot('own').exitConfirmed, false)
  own.exit()
  assert.equal(registry.snapshot('own').exitConfirmed, true)
  other.exit()
  assert.equal(registry.active.size, 0)
})
