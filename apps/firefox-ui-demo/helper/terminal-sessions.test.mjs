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
