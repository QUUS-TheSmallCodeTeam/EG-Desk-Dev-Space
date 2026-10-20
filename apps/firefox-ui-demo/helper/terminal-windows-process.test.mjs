import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createWindowsPtyProcess } from './terminal-windows-process.mjs'
import { TerminalSessionRegistry } from './terminal-sessions.mjs'

class Child extends EventEmitter {
  constructor({ rejectOperations = false } = {}) {
    super(); this.connected = true; this.pid = 42; this.frames = []; this.kills = 0
    this.rejectOperations = rejectOperations
  }
  send(message, callback) {
    this.frames.push(message)
    queueMicrotask(() => {
      callback?.(null)
      if (message.type === 'init') this.emit('message', { v: 1, type: 'ready',
        shellId: message.shellId, transport: 'conpty', usePty: true })
      else this.emit('message', { v: 1, type: 'ack', requestId: message.requestId, ok: !this.rejectOperations })
    })
    return true
  }
  kill() { this.kills++; this.close(null, 'SIGTERM'); return true }
  close(code = 0, signal = null) { this.connected = false; this.emit('close', code, signal) }
}
const configuration = { shellId: 'powershell', cwd: 'C:\\Users\\한글 사용자', cols: 80, rows: 24,
  env: { SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--require private-parent-preload',
    PATH: 'C:\\Windows\\System32' } }

test('isolated worker clears parent Node flags but preserves the native shell environment as IPC data', async () => {
  const child = new Child(), calls = []
  const pty = await createWindowsPtyProcess({ ...configuration,
    spawnWorker: (...args) => { calls.push(args); return child } })
  assert.deepEqual(calls[0][2].execArgv, [])
  assert.equal(calls[0][2].windowsHide, true)
  assert.equal(calls[0][2].env.NODE_OPTIONS, undefined)
  assert.equal(child.frames[0].env.NODE_OPTIONS, configuration.env.NODE_OPTIONS)
  await pty.write('\u0003한글')
  await pty.resize(120, 40)
  assert.equal(child.kills, 0)
  assert.deepEqual(child.frames.slice(1).map(item => item.type), ['write', 'resize'])
  child.emit('message', { v: 1, type: 'native-exit', exitCode: 0, signal: null })
  child.close()
})

test('native receipt alone or worker close alone cannot synthesize an EXITED receipt', async () => {
  const first = new Child()
  const pty = await createWindowsPtyProcess({ ...configuration, spawnWorker: () => first })
  const exits = [], errors = [], output = []
  pty.onExit(event => exits.push(event)); pty.onError(error => errors.push(error)); pty.onData(data => output.push(data))
  first.emit('message', { v: 1, type: 'output', data: 'last output 한글' })
  first.emit('message', { v: 1, type: 'native-exit', exitCode: 7, signal: null })
  assert.equal(exits.length, 0)
  first.close(0)
  assert.equal(exits.length, 1)
  assert.equal(exits[0].exitCode, 7)
  assert.equal(exits[0].nativeExitConfirmed, true)
  assert.equal(exits[0].workerCloseConfirmed, true)
  assert.equal(exits[0].workerExitCode, 0)
  assert.equal(exits[0].exitSource, 'conpty-worker.native-onExit')
  assert.deepEqual(output, ['last output 한글'])
  assert.equal(errors.length, 0)

  const second = new Child(), unconfirmed = []
  const failed = await createWindowsPtyProcess({ ...configuration, spawnWorker: () => second })
  failed.onExit(() => assert.fail('worker close is not native exit evidence'))
  failed.onError(error => unconfirmed.push(error.code))
  second.close(1)
  assert.deepEqual(unconfirmed, ['TERMINAL_DRIVER_EXIT_UNCONFIRMED'])
})

test('native write/resize rejection propagates and kill acknowledgement does not confirm shell exit', async () => {
  const child = new Child({ rejectOperations: true })
  const pty = await createWindowsPtyProcess({ ...configuration, spawnWorker: () => child })
  await assert.rejects(pty.write('echo test\r'), error => error.code === 'TERMINAL_NATIVE_OPERATION_FAILED')
  await assert.rejects(pty.resize(120, 40), error => error.code === 'TERMINAL_NATIVE_OPERATION_FAILED')
  child.rejectOperations = false
  let exited = false
  pty.onExit(() => { exited = true })
  await pty.kill()
  assert.equal(exited, false)
  assert.equal(child.kills, 0, 'normal stop is IPC to the owned native driver, not a parent PID kill')
  child.emit('message', { v: 1, type: 'native-exit', exitCode: 1 })
  child.close()
  assert.equal(exited, true)
})

test('invalid configuration is rejected without forking any process', async () => {
  let calls = 0
  const spawnWorker = () => { calls++; throw new Error('must not run') }
  for (const change of [{ shellId: 'cmd /c command' }, { cwd: 'relative' }, { cols: 0 },
    { powerShellInitialization: 'bad\0script' }]) {
    await assert.rejects(createWindowsPtyProcess({ ...configuration, ...change, spawnWorker }))
  }
  assert.equal(calls, 0)
})

test('registry awaits native IPC operation ACKs and publishes only combined native/worker exit evidence', async () => {
  const child = new Child({ rejectOperations: true })
  const adapter = await createWindowsPtyProcess({ ...configuration, spawnWorker: () => child })
  const registry = new TerminalSessionRegistry()
  registry.register({ id: 'isolated', process: adapter, usePty: true, shell: 'system-powershell',
    shellId: 'powershell', shellLabel: 'PowerShell', transport: 'conpty', cols: 80, rows: 24 })
  assert.equal((await registry.write('isolated', 'text')).code, 'WRITE_FAILED')
  const resize = await registry.resize('isolated', 120, 40)
  assert.equal(resize.code, 'RESIZE_FAILED')
  assert.equal(resize.resized, false)
  assert.equal(registry.snapshot('isolated').cols, 80)
  child.rejectOperations = false
  const accepted = await registry.kill('isolated')
  assert.equal(accepted.status, 'STOP_REQUESTED')
  assert.equal(accepted.exitConfirmed, false)
  child.emit('message', { v: 1, type: 'native-exit', exitCode: 0 })
  assert.equal(registry.snapshot('isolated').exitConfirmed, false)
  child.close(0)
  const receipt = registry.snapshot('isolated')
  assert.equal(receipt.status, 'EXITED')
  assert.equal(receipt.nativeExitConfirmed, true)
  assert.equal(receipt.workerCloseConfirmed, true)
  assert.equal(receipt.workerExitCode, 0)
  assert.equal(receipt.exitSource, 'conpty-worker.native-onExit')
})

test('registry marks worker-only closure UNKNOWN and refuses subsequent input without inventing an exit', async () => {
  const child = new Child()
  const adapter = await createWindowsPtyProcess({ ...configuration, spawnWorker: () => child })
  const registry = new TerminalSessionRegistry()
  registry.register({ id: 'failed', process: adapter, usePty: true, shell: 'system-cmd',
    transport: 'conpty', cols: 80, rows: 24 })
  child.close(1)
  const state = registry.snapshot('failed')
  assert.equal(state.status, 'UNKNOWN')
  assert.equal(state.exitConfirmed, false)
  assert.equal(state.exited, null)
  assert.equal((await registry.write('failed', 'must not dispatch')).code, 'PROCESS_ERROR')
  assert.equal(registry.exitReceipts.size, 0)
})


function manualWorkerTimers() {
  const timers = []
  return { timers,
    setTimer(fn) { const timer = { fn, cleared: false, unref() {} }; timers.push(timer); return timer },
    clearTimer(timer) { if (timer) timer.cleared = true },
    run() { const timer = timers.find(item => !item.cleared); assert.ok(timer); timer.cleared = true; timer.fn() },
  }
}

test('a kill ACK without native exit cannot leave an owned worker alive indefinitely or confirm EXITED', async () => {
  const clock = manualWorkerTimers(), child = new Child(), errors = []
  const api = await createWindowsPtyProcess({ ...configuration, spawnWorker: () => child,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  api.onExit(() => assert.fail('a kill ACK and watchdog cleanup are not native exit evidence'))
  api.onError(error => errors.push(error.code))
  await api.kill()
  assert.equal(child.kills, 0)
  clock.run()
  assert.equal(child.kills, 1)
  assert.ok(errors.includes('TERMINAL_DRIVER_EXIT_UNCONFIRMED'))
  assert.ok(clock.timers.every(item => item.cleared))
})

test('IPC disconnect and a native-exit worker hang are fenced UNKNOWN and terminate only the owned worker', async () => {
  for (const hasNativeExit of [false, true]) {
    const clock = manualWorkerTimers(), child = new Child(), errors = []
    const api = await createWindowsPtyProcess({ ...configuration, spawnWorker: () => child,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    api.onExit(() => assert.fail('watchdog termination is not a normal combined exit receipt'))
    api.onError(error => errors.push(error.code))
    if (hasNativeExit) child.emit('message', { v: 1, type: 'native-exit', exitCode: 0 })
    else { child.connected = false; child.emit('disconnect') }
    assert.equal(child.kills, 0)
    clock.run()
    assert.equal(child.kills, 1)
    assert.ok(errors.length > 0)
    assert.ok(clock.timers.every(item => item.cleared))
  }
})

test('startup timeout remains ambiguous, while explicit worker proof of no native creation is definite', async () => {
  class Silent extends Child { send(frame, callback) { this.frames.push(frame); callback?.(null); return true } }
  const clock = manualWorkerTimers(), silent = new Silent()
  const timeout = assert.rejects(createWindowsPtyProcess({ ...configuration, spawnWorker: () => silent,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer }),
  error => error.code === 'WINDOWS_SPAWN_UNCONFIRMED' && error.nativeCreated === null)
  clock.run()
  await timeout
  assert.equal(silent.kills, 1)

  class Absent extends Child {
    send(frame, callback) {
      queueMicrotask(() => { callback?.(null); this.emit('message',
        { v: 1, type: 'spawn-error', nativeCreated: false }); this.close(1) })
      return true
    }
  }
  await assert.rejects(createWindowsPtyProcess({ ...configuration, spawnWorker: () => new Absent() }),
    error => error.code === 'WINDOWS_PTY_UNAVAILABLE' && error.nativeCreated === false)
})
