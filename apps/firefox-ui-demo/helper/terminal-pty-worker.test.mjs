import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runTerminalPtyWorker, windowsNativeShellEnvironment } from './terminal-pty-worker.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('Windows PowerShell and CMD rebuild only inherited module paths without changing policy or installed PowerShell 7', () => {
  const env = { PSModulePath: 'inherited PowerShell 7 modules', psMODULEpath: 'another inherited casing',
    PSExecutionPolicyPreference: 'Restricted', SystemRoot: 'C:\\Windows', CUSTOM_VALUE: 'preserved' }
  for (const choice of [
    { id: 'powershell', executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    { id: 'cmd', executable: 'C:\\Windows\\System32\\cmd.exe' },
  ]) {
    const clean = windowsNativeShellEnvironment(env, choice)
    assert.ok(!Object.keys(clean).some(key => key.toLowerCase() === 'psmodulepath'))
    assert.equal(clean.PSExecutionPolicyPreference, 'Restricted')
    assert.equal(clean.CUSTOM_VALUE, 'preserved')
  }
  assert.deepEqual(windowsNativeShellEnvironment(env,
    { id: 'powershell', executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }), env)
  assert.equal(env.PSModulePath, 'inherited PowerShell 7 modules', 'caller environment is not changed')
})

class Parent extends EventEmitter {
  constructor() { super(); this.connected = true; this.frames = []; this.exits = []; this.holdNativeExit = null }
  send(frame, callback) {
    this.frames.push(frame)
    if (frame.type === 'native-exit' && this.holdNativeExit) { this.holdNativeExit(callback); return true }
    queueMicrotask(() => callback?.(null)); return true
  }
  exit(code) { this.exits.push(code) }
}
class Pty extends EventEmitter {
  constructor() { super(); this.data = new Set(); this.exits = new Set(); this.kills = 0; this.writes = []; this.resizes = [] }
  onData(fn) { this.data.add(fn); return { dispose: () => this.data.delete(fn) } }
  onExit(fn) { this.exits.add(fn); return { dispose: () => this.exits.delete(fn) } }
  write(data) { if (this.badWrite) throw new Error('native write failed'); this.writes.push(data) }
  resize(cols, rows) { if (this.badResize) throw new Error('native resize failed'); this.resizes.push([cols, rows]) }
  kill() { this.kills++ }
  output(data) { for (const fn of this.data) fn(data) }
  finish(exitCode = 0) { for (const fn of [...this.exits]) fn({ exitCode }) }
}
async function harness(initialization = null) {
  const parent = new Parent(), native = new Pty(), spawns = [], timers = []
  const run = runTerminalPtyWorker({ parent, platform: 'win32', release: '10.0.26200',
    resolveShell: ({ shellId }) => ({ id: shellId, executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoLogo', '-NoProfile'] }),
    loadPty: async () => ({ spawn: (...args) => { spawns.push(args); return native } }),
    setTimer: fn => { timers.push(fn); return { unref() {} } }, clearTimer: () => {} })
  parent.emit('message', { v: 1, type: 'init', shellId: 'powershell', cwd: 'C:\\Users\\owned fixture',
    cols: 80, rows: 24, env: { SystemRoot: 'C:\\Windows' }, powerShellInitialization: initialization })
  await tick()
  return { parent, native, spawns, run, timers }
}

test('worker drains exact Unicode output and flushes the native receipt before its own exit', async () => {
  const h = await harness()
  let acknowledgeNative
  h.parent.holdNativeExit = callback => { acknowledgeNative = callback }
  h.native.output('exact 한글 😀 output')
  h.native.finish(0)
  await tick()
  assert.deepEqual(h.parent.frames.map(frame => frame.type), ['ready', 'output', 'native-exit'])
  assert.equal(h.parent.frames[1].data, 'exact 한글 😀 output')
  assert.deepEqual(h.parent.exits, [], 'IPC native evidence has not been flushed yet')
  acknowledgeNative(null)
  await tick()
  assert.deepEqual(h.parent.exits, [0])
  assert.equal(h.native.kills, 0)
})

test('typed operations acknowledge actual native calls, propagate errors, and never treat kill ACK as exit', async () => {
  const h = await harness()
  h.native.badWrite = true; h.native.badResize = true
  h.parent.emit('message', { v: 1, type: 'write', requestId: 'w', data: 'test' })
  h.parent.emit('message', { v: 1, type: 'resize', requestId: 'r', cols: 100, rows: 30 })
  h.parent.emit('message', { v: 1, type: 'kill', requestId: 'k' })
  await tick()
  assert.deepEqual(h.parent.frames.filter(frame => frame.type === 'ack').map(frame => [frame.requestId, frame.ok]),
    [['w', false], ['r', false], ['k', true]])
  assert.equal(h.native.kills, 1)
  assert.deepEqual(h.parent.exits, [])
  h.native.finish(1)
  await tick()
  assert.equal(h.parent.frames.find(frame => frame.type === 'native-exit').exitCode, 1)
  assert.deepEqual(h.parent.exits, [0])
})

test('trusted local PowerShell initialization is separate from HTTP shell selection', async () => {
  const script = 'Set-PSReadLineOption -HistorySaveStyle SaveNothing'
  const h = await harness(script)
  assert.deepEqual(h.spawns[0][1], ['-NoLogo', '-NoProfile', '-NoExit', '-Command', script])
  assert.equal(h.spawns[0][2].useConpty, true)
  assert.equal(h.spawns[0][2].cwd, 'C:\\Users\\owned fixture')
  h.native.finish()
  await tick()
})

test('parent disconnect stops only this worker native instance; no exit evidence is invented', async () => {
  const h = await harness()
  h.parent.connected = false
  h.parent.emit('disconnect')
  assert.equal(h.native.kills, 1)
  assert.deepEqual(h.parent.exits, [])
  assert.equal(h.parent.frames.some(frame => frame.type === 'native-exit'), false)
  h.timers[0]()
  assert.deepEqual(h.parent.exits, [1])
})


test('disconnect during asynchronous driver loading cannot spawn a late native terminal', async () => {
  const parent = new Parent()
  let finishLoading, spawns = 0
  const loading = new Promise(resolve => { finishLoading = resolve })
  runTerminalPtyWorker({ parent, platform: 'win32', release: '10.0.26200',
    loadPty: () => loading, resolveShell: () => ({ id: 'powershell', executable: 'system-powershell', args: [] }),
    setTimer: () => ({ unref() {} }), clearTimer: () => {} })
  parent.emit('message', { v: 1, type: 'init', shellId: 'powershell', cwd: 'C:\\owned fixture',
    cols: 80, rows: 24, env: {} })
  parent.emit('disconnect')
  finishLoading({ spawn() { spawns++; return new Pty() } })
  await tick()
  assert.equal(spawns, 0)
  assert.deepEqual(parent.exits, [1])
  assert.ok(!parent.frames.some(frame => frame.type === 'native-exit'))
})

test('runtime-error plus disconnect never repeats the native kill request', async () => {
  const h = await harness()
  h.native.kill = function () { this.kills++; this.emit('error', new Error('native shutdown error')) }
  h.parent.emit('message', { v: 1, type: 'kill', requestId: 'stop' })
  await tick()
  h.parent.emit('disconnect')
  assert.equal(h.native.kills, 1)
  h.timers[0]()
  assert.deepEqual(h.parent.exits, [1])
})

test('spawn-error proves absent only before attempting native spawn', async () => {
  for (const attempt of [false, true]) {
    const parent = new Parent()
    runTerminalPtyWorker({ parent, platform: 'win32', release: '10.0.26200',
      resolveShell: () => ({ id: 'powershell', executable: 'system-powershell', args: [] }),
      loadPty: async () => {
        if (!attempt) throw new Error('module unavailable before spawn')
        return { spawn() { throw new Error('native constructor outcome unknown') } }
      } })
    parent.emit('message', { v: 1, type: 'init', shellId: 'powershell', cwd: 'C:\\owned fixture',
      cols: 80, rows: 24, env: {} })
    await tick()
    assert.equal(parent.frames.find(frame => frame.type === 'spawn-error').nativeCreated, attempt ? null : false)
    assert.deepEqual(parent.exits, [1])
  }
})
