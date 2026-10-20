import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRustWindowsPtyProcess, RUST_TERMINAL_LIMITS } from './terminal-rust-process.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
class Driver extends EventEmitter {
  constructor({ ready = true, ack = true, backpressure = false, retainWrites = false } = {}) {
    super()
    this.pid = 4242; this.kills = 0; this.frames = []; this.autoReady = ready; this.autoAck = ack
    this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.stdin = new EventEmitter()
    this.stdin.destroyed = false; this.closed = false; this.retainedCallbacks = []
    this.stdin.write = (frame, encoding, callback) => {
      const message = JSON.parse(frame); this.frames.push(message)
      if (retainWrites) this.retainedCallbacks.push(callback)
      else queueMicrotask(() => callback?.(null))
      if (message.type === 'init' && this.autoReady) queueMicrotask(() => this.frame({
        type: 'ready', shellId: message.shellId, transport: 'conpty', usePty: true, pid: 123,
        shell: 'C:\\Windows\\System32\\cmd.exe', args: ['/D'], debugAssertions: false,
        implementation: 'portable-pty-0.9.0', version: '0.1.0',
      }))
      else if (message.type !== 'init' && this.autoAck) queueMicrotask(() => this.ack(message))
      return !backpressure
    }
  }
  frame(message) { this.stdout.emit('data', Buffer.from(JSON.stringify({ v: 1, ...message }) + '\n')) }
  ack(message, ok = true) { this.frame({ type: 'ack', requestId: message.requestId, ok }) }
  native(exitCode = 0, extra = {}) { this.frame({ type: 'native-exit', nativeWaitConfirmed: true,
    exitSource: 'conpty-rust.native-wait', exitCode, signal: null, ...extra }) }
  close(code = 0, signal = null) {
    if (this.closed) return
    this.closed = true; this.stdin.destroyed = true
    this.stdout.emit('end'); this.emit('close', code, signal)
  }
  kill() { this.kills++; this.close(null, 'SIGTERM'); return true }
}
const configuration = { executable: 'C:\\owned tools\\egdesk-terminal-worker.exe',
  shellId: 'cmd', cwd: 'C:\\Users\\한글 사용자', cols: 80, rows: 24,
  env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32',
    NODE_OPTIONS: '--require parent-only-preload' } }
const finish = driver => { driver.native(); driver.close() }
const create = (driver, extra = {}) => createRustWindowsPtyProcess({
  ...configuration, spawnDriver: () => driver, ...extra,
})
function clock() {
  const timers = []
  return { timers,
    setTimer(fn, ms) { const entry = { fn, ms, cleared: false, unref() {} }; timers.push(entry); return entry },
    clearTimer(entry) { if (entry) entry.cleared = true },
    run() { const active = timers.find(entry => !entry.cleared); assert.ok(active); active.cleared = true; active.fn() },
  }
}

test('adapter launches only the explicit executable and exposes distinct Rust provenance', async () => {
  const driver = new Driver(), calls = []
  const api = await createRustWindowsPtyProcess({ ...configuration,
    spawnDriver: (...args) => { calls.push(args); return driver } })
  assert.equal(calls[0][0], configuration.executable)
  assert.deepEqual(calls[0][1], ['--stdio-worker'])
  assert.equal(calls[0][2].shell, false); assert.equal(calls[0][2].windowsHide, true)
  assert.deepEqual(calls[0][2].env, configuration.env)
  assert.deepEqual(driver.frames[0].env, configuration.env)
  assert.equal(api.pid, 4242); assert.equal(api.nativeShellPid, 123)
  assert.equal(api.driverInfo.debugAssertions, false)
  assert.equal(api.driverInfo.implementation, 'portable-pty-0.9.0')
  assert.equal(api.requiresDriverExitReceipt, true)
  assert.equal(api.requiresWorkerExitReceipt, undefined)
  const copy = api.driverInfo; copy.args.push('changed')
  assert.deepEqual(api.driverInfo.args, ['/D'])
  finish(driver)
})

test('invalid paths, typed selections and dimensions never spawn any driver', async () => {
  let spawns = 0
  const spawnDriver = () => { spawns++; throw new Error('must not run') }
  for (const change of [
    { executable: 'worker.exe' }, { executable: '\\worker.exe' }, { executable: 'C:\\worker.cmd' },
    { executable: 'C:\\bad\nworker.exe' }, { shellId: 'cmd /C command' }, { cwd: 'relative' },
    { cols: 0 }, { rows: 1001 }, { requestTimeoutMs: 0 }, { powerShellInitialization: 'bad\0script' },
  ]) await assert.rejects(createRustWindowsPtyProcess({ ...configuration, ...change, spawnDriver }),
    error => error.code === 'INVALID_TERMINAL_RUST_CONFIG' && error.nativeCreated === false)
  assert.equal(spawns, 0)
})

test('init and write validate encoded frame bytes without truncation or spawning a fallback', async () => {
  let spawns = 0
  await assert.rejects(createRustWindowsPtyProcess({ ...configuration,
    env: { huge: '\0'.repeat(40000) }, spawnDriver: () => { spawns++; return new Driver() } }),
    error => error.code === 'TERMINAL_RUST_FRAME_LIMIT' && error.nativeCreated === false)
  assert.equal(spawns, 0)
  const driver = new Driver(), api = await create(driver)
  const before = driver.frames.length
  await assert.rejects(api.write('\0'.repeat(30000)), error => error.code === 'TERMINAL_RUST_FRAME_LIMIT')
  await assert.rejects(api.write('x'.repeat(65537)), error => error.code === 'INVALID_TERMINAL_INPUT')
  await assert.rejects(api.write('\ud800'), error => error.code === 'INVALID_TERMINAL_INPUT')
  assert.equal(driver.frames.length, before)
  await api.write('\u0003한글😺')
  assert.equal(driver.frames.at(-1).data, '\u0003한글😺')
  finish(driver)
})

test('split UTF-8 JSON and multiple frames retain exact output before readiness', async () => {
  const driver = new Driver({ ready: false })
  const started = create(driver)
  const output = Buffer.from(JSON.stringify({ v: 1, type: 'output', data: '처음😺' }) + '\n')
  const start = output.indexOf(Buffer.from('처'))
  driver.stdout.emit('data', output.subarray(0, start + 1))
  driver.stdout.emit('data', output.subarray(start + 1, start + 5))
  driver.stdout.emit('data', output.subarray(start + 5))
  driver.frame({ type: 'ready', shellId: 'cmd', transport: 'conpty', usePty: true, pid: null })
  const api = await started, data = []
  api.onData(text => data.push(text))
  const joined = [{ v: 1, type: 'output', data: '둘\n' }, { v: 1, type: 'output', data: '셋' }]
    .map(message => JSON.stringify(message) + '\r\n').join('')
  driver.stdout.emit('data', Buffer.from(joined))
  assert.deepEqual(data, ['처음😺', '둘\n', '셋'])
  assert.equal(api.nativeShellPid, null)
  finish(driver)
})

test('native wait and clean driver close are both required, never kill ACK or exit event alone', async () => {
  const driver = new Driver(), api = await create(driver), exits = []
  api.onExit(receipt => exits.push(receipt))
  await api.kill(); await api.kill()
  assert.equal(driver.frames.filter(frame => frame.type === 'kill').length, 1)
  assert.deepEqual(exits, [])
  driver.native(7); driver.emit('exit', 0, null)
  assert.deepEqual(exits, [])
  driver.close(0)
  assert.deepEqual(exits, [{ exitCode: 7, signal: null, exitSource: 'conpty-rust.native-wait',
    nativeWaitConfirmed: true, driverCloseConfirmed: true, driverExitCode: 0, driverExitSignal: null }])
  let replay
  api.onExit(receipt => { replay = receipt }); await tick()
  assert.equal(replay.exitSource, 'conpty-rust.native-wait')
})

test('worker-only closure, stdout EOF and abnormal close after native wait never invent an exit', async () => {
  for (const scenario of ['close-only', 'eof-only', 'abnormal']) {
    const driver = new Driver(), api = await create(driver), errors = []
    api.onExit(() => assert.fail('incomplete proof cannot confirm exit'))
    api.onError(error => errors.push(error.code))
    if (scenario === 'abnormal') { driver.native(); driver.close(1) }
    else if (scenario === 'close-only') driver.close(0)
    else { driver.stdout.emit('end'); driver.close(0) }
    assert.ok(errors.includes('TERMINAL_RUST_EXIT_UNCONFIRMED'))
  }
})

test('false wait proof, wrong source, malformed frames and truncated final lines are fatal and latched', async () => {
  const corruptions = [
    driver => driver.native(0, { nativeWaitConfirmed: false }),
    driver => driver.native(0, { exitSource: 'conpty-worker.native-onExit' }),
    driver => driver.stdout.emit('data', Buffer.from('not json\n')),
    driver => driver.stdout.emit('data', Buffer.from([0xff, 0x0a])),
    driver => driver.stdout.emit('data', Buffer.alloc(RUST_TERMINAL_LIMITS.frameBytes, 120)),
    driver => { driver.stdout.emit('data', Buffer.from('{"v":1')); driver.stdout.emit('end') },
  ]
  for (const corrupt of corruptions) {
    const driver = new Driver(), api = await create(driver), errors = []
    api.onExit(() => assert.fail('later valid frames cannot recover poisoned protocol'))
    api.onError(error => errors.push(error.code))
    corrupt(driver)
    driver.native(); driver.close(0)
    assert.equal(driver.kills, 1)
    assert.ok(errors.includes('TERMINAL_RUST_PROTOCOL'))
    await assert.rejects(api.write('do not send'))
  }
})

test('backpressure never retries a frame and ACK, not stream drain, resolves the operation', async () => {
  const driver = new Driver({ ack: false, backpressure: true, retainWrites: true })
  const api = await create(driver)
  let resolved = false
  const operation = api.write('one 한글').then(() => { resolved = true })
  await tick()
  assert.equal(driver.frames.filter(frame => frame.type === 'write').length, 1)
  driver.stdin.emit('drain')
  for (const callback of driver.retainedCallbacks) callback?.(null)
  await tick(); assert.equal(resolved, false)
  const written = driver.frames.at(-1)
  driver.ack(written); await operation
  driver.ack(written); await tick()
  assert.equal(driver.frames.filter(frame => frame.type === 'write').length, 1)
  finish(driver)
})

test('negative ACKs reject only the requested operation and an explicit retry can stop', async () => {
  const driver = new Driver({ ack: false }), api = await create(driver)
  const write = api.write('x'); driver.ack(driver.frames.at(-1), false)
  await assert.rejects(write, error => error.code === 'TERMINAL_NATIVE_OPERATION_FAILED')
  const resize = api.resize(100, 30); driver.ack(driver.frames.at(-1), false)
  await assert.rejects(resize, error => error.code === 'TERMINAL_NATIVE_OPERATION_FAILED')
  const kill = api.kill(); driver.ack(driver.frames.at(-1), false)
  await assert.rejects(kill, error => error.code === 'TERMINAL_NATIVE_OPERATION_FAILED')
  await tick()
  const retry = api.kill(); driver.ack(driver.frames.at(-1), true); await retry
  finish(driver)
})

test('operation timeouts reject once and late ACKs never replay native input', async () => {
  const driver = new Driver({ ack: false }), timers = clock()
  const api = await create(driver, { setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  const waiting = api.write('once'), failed = assert.rejects(waiting,
    error => error.code === 'TERMINAL_RUST_DRIVER_TIMEOUT')
  const sent = driver.frames.at(-1)
  timers.run(); await failed; driver.ack(sent); await tick()
  assert.equal(driver.frames.filter(frame => frame.type === 'write').length, 1)
  finish(driver)
  assert.ok(timers.timers.every(entry => entry.cleared))
})

test('pending operations, stop phase and retained output are bounded', async () => {
  const driver = new Driver({ ack: false }), api = await create(driver)
  const pending = Array.from({ length: 64 }, () => api.write('bounded'))
  const settling = Promise.allSettled(pending)
  await assert.rejects(api.write('overflow'), error => error.code === 'TERMINAL_RUST_DRIVER_BUSY')
  for (let index = 0; index < 20; index++) driver.frame({ type: 'output', data: '한'.repeat(10000) })
  let retained = ''
  api.onData(data => { retained += data })
  assert.ok(Buffer.byteLength(retained) <= RUST_TERMINAL_LIMITS.outputBytes)
  assert.equal(retained.includes('\ufffd'), false)
  assert.equal(api.outputTruncated, true)
  finish(driver); await settling
})

test('startup timeout is ambiguous, owns cleanup, and late readiness cannot resurrect it', async () => {
  const driver = new Driver({ ready: false }), timers = clock()
  const rejected = assert.rejects(create(driver, { setTimer: timers.setTimer, clearTimer: timers.clearTimer }),
    error => error.code === 'WINDOWS_SPAWN_UNCONFIRMED' && error.nativeCreated === null)
  timers.run(); await rejected
  driver.frame({ type: 'ready', shellId: 'cmd', transport: 'conpty', usePty: true, pid: 123 })
  assert.equal(driver.kills, 1)
  assert.ok(timers.timers.every(entry => entry.cleared))
})

test('only an explicit no-native claim plus observed driver close is a definite startup rejection', async () => {
  const absent = new Driver({ ready: false })
  let rejected = false
  const start = create(absent).catch(error => { rejected = true; throw error })
  const checked = assert.rejects(start, error => error.code === 'WINDOWS_PTY_UNAVAILABLE' && error.nativeCreated === false)
  absent.frame({ type: 'spawn-error', nativeCreated: false })
  await tick(); assert.equal(rejected, false)
  absent.close(1); await checked
  for (const contradiction of ['late-ready', 'early-output']) {
    const driver = new Driver({ ready: false })
    const failure = assert.rejects(create(driver), error => error.code === 'WINDOWS_SPAWN_UNCONFIRMED')
    if (contradiction === 'early-output') driver.frame({ type: 'output', data: 'native existed' })
    driver.frame({ type: 'spawn-error', nativeCreated: false })
    if (contradiction === 'late-ready') driver.frame({ type: 'ready', shellId: 'cmd', transport: 'conpty', usePty: true, pid: 123 })
    driver.close(1); await failure
  }
})

test('driver or stdin failure rejects operations and cleanup never signals the native PID', async () => {
  const driver = new Driver({ ack: false }), api = await create(driver), errors = []
  api.onError(error => errors.push(error.code))
  const waiting = api.write('pending'), checked = assert.rejects(waiting)
  driver.stdin.emit('error', new Error('private error content'))
  await checked
  assert.equal(driver.kills, 1)
  assert.ok(errors.includes('TERMINAL_RUST_DRIVER_CLOSED'))
  assert.equal(api.pid, 4242)
  assert.equal(api.nativeShellPid, 123)
})

test('kill ACK without native wait triggers only owned-driver cleanup and no exit receipt', async () => {
  const driver = new Driver(), timers = clock()
  const api = await create(driver, { setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  api.onExit(() => assert.fail('watchdog kill is not native wait evidence'))
  await api.kill()
  await assert.rejects(api.write('after stop'))
  timers.run()
  assert.equal(driver.kills, 1)
  assert.ok(timers.timers.every(entry => entry.cleared))
})

test('native wait without driver close is bounded and remains unconfirmed after forced cleanup', async () => {
  const driver = new Driver(), timers = clock()
  const api = await create(driver, { setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  api.onExit(() => assert.fail('forced driver cleanup cannot claim a clean Rust exit'))
  driver.native()
  timers.run()
  assert.equal(driver.kills, 1)
  assert.ok(timers.timers.every(entry => entry.cleared))
})
