import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { terminalDimensions, terminalShellCatalog, resolveTerminalShell,
  supportsWindowsConpty, createTerminalSessionFactory } from './terminal-platform.mjs'
import { TerminalSessionRegistry } from './terminal-sessions.mjs'

const windowsEnv = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files',
  PATH: 'C:\\Hidden Codex Runtime\\native\\powershell', SHELL: '/bin/zsh' }
const legacyPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const cmd = 'C:\\Windows\\System32\\cmd.exe'
const modernPowerShell = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const options = { platform: 'win32', env: windowsEnv, release: '10.0.26200',
  exists: candidate => [legacyPowerShell, cmd].includes(candidate) }

class FakePty {
  constructor() { this.data = new Set(); this.exits = new Set(); this.writes = []; this.sizes = []; this.kills = 0 }
  onData(fn) { this.data.add(fn); return { dispose: () => this.data.delete(fn) } }
  onExit(fn) { this.exits.add(fn); return { dispose: () => this.exits.delete(fn) } }
  write(text) { this.writes.push(text) }
  resize(cols, rows) { this.sizes.push([cols, rows]) }
  kill() { this.kills++ }
  exit(exitCode = 0) { for (const fn of [...this.exits]) fn({ exitCode }) }
}

test('Windows chooses system PowerShell/CMD and does not use SHELL or a hidden pwsh PATH', () => {
  const catalog = terminalShellCatalog(options)
  assert.equal(catalog.defaultShellId, 'powershell')
  assert.deepEqual(catalog.shells.map(item => item.executable), [legacyPowerShell, cmd])
  assert.equal(catalog.transport, 'conpty')
  assert.equal(resolveTerminalShell({}, options).executable, legacyPowerShell)
  assert.deepEqual(resolveTerminalShell({ shellId: 'cmd' }, options).args, ['/D'])
  const modern = { ...options, exists: candidate => candidate === modernPowerShell || options.exists(candidate) }
  assert.equal(resolveTerminalShell({}, modern).executable, modernPowerShell)
  for (const selection of [{ shellId: 'powershell -Command unwanted' }, { shell: '/bin/zsh' },
    { shell: 'C:\\arbitrary.exe' }, { shellId: 'cmd', shell: 'powershell' }]) {
    assert.throws(() => resolveTerminalShell(selection, options), error => error.code === 'INVALID_TERMINAL_SHELL')
  }
})

test('shell availability, dimensions and old Windows versions fail explicitly', () => {
  assert.equal(supportsWindowsConpty('10.0.17763'), false)
  assert.equal(supportsWindowsConpty('10.0.18309'), true)
  assert.equal(supportsWindowsConpty('not known'), false)
  assert.throws(() => resolveTerminalShell({}, { ...options, exists: () => false }), error => error.code === 'TERMINAL_SHELL_UNAVAILABLE')
  assert.deepEqual(terminalDimensions(), { cols: 80, rows: 24 })
  for (const size of [[0, 24], [80, 0], [1001, 24], [80, '24'], [2.5, 3]]) {
    assert.throws(() => terminalDimensions(...size), error => error.code === 'INVALID_TERMINAL_SIZE')
  }
})

test('Windows factory starts an isolated driver with the selected shell and Unicode cwd', async () => {
  const registry = new TerminalSessionRegistry(), native = new FakePty(), spawned = []
  const factory = createTerminalSessionFactory({ registry, ...options,
    cwd: 'C:\\Users\\한글 사용자\\작업 폴더', newId: () => 'windows-test',
    startWindowsProcess: async configuration => { spawned.push(configuration); return native },
    loadPty: async () => assert.fail('Windows must not load native PTY into the bridge') })
  const session = await factory.create({ shellId: 'powershell', cols: 100, rows: 30 })
  assert.equal(spawned[0].shellId, 'powershell')
  assert.equal(spawned[0].cwd, 'C:\\Users\\한글 사용자\\작업 폴더')
  assert.equal(spawned[0].cols, 100)
  assert.equal(spawned[0].powerShellInitialization, null)
  assert.equal(registry.snapshot(session.id).transport, 'conpty')
  assert.equal(registry.snapshot(session.id).windowsBuildNumber, 26200)
  registry.write(session.id, '\u0003')
  assert.deepEqual(native.writes, ['\u0003'])
  assert.equal(native.kills, 0)
  assert.equal(registry.resize(session.id, 120, 40).resized, true)
  assert.deepEqual(native.sizes, [[120, 40]])
  assert.equal(registry.kill(session.id).exitConfirmed, false)
  native.exit(0)
  const exited = registry.snapshot(session.id)
  assert.equal(exited.exitConfirmed, true)
  assert.equal(exited.shellId, 'powershell')
  assert.equal(exited.transport, 'conpty')
})

test('Windows fails closed without an isolated driver and never starts pipe fallback', async () => {
  const registry = new TerminalSessionRegistry()
  let pipes = 0, starts = 0
  const common = { registry, ...options, cwd: 'C:\\Users\\Example',
    startWindowsProcess: async () => { starts++; throw Object.assign(new Error('driver failed'), { nativeCreated: false }) },
    loadPty: async () => assert.fail('Windows must not load native PTY into the bridge'),
    spawnPipe: () => { pipes++; throw new Error('must not run') } }
  await assert.rejects(createTerminalSessionFactory(common).create(), error =>
    error.code === 'WINDOWS_PTY_UNAVAILABLE' && error.httpStatus === 503 && error.usePty === false)
  await assert.rejects(createTerminalSessionFactory({ ...common, release: '10.0.17763' }).create(),
    error => error.code === 'WINDOWS_CONPTY_UNSUPPORTED')
  assert.equal(starts, 1)
  assert.equal(pipes, 0)
  assert.equal(registry.active.size, 0)
})

test('POSIX default/custom shell behavior remains and pipe fallback advertises limited capabilities', async () => {
  assert.equal(resolveTerminalShell({}, { platform: 'darwin', env: {} }).executable, '/bin/zsh')
  assert.equal(resolveTerminalShell({}, { platform: 'linux', env: {} }).executable, '/bin/bash')
  assert.equal(resolveTerminalShell({ shell: '/custom/shell' }, { platform: 'linux', env: {} }).executable, '/custom/shell')
  const registry = new TerminalSessionRegistry(), child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { write() {} }; child.kill = () => true
  const calls = []
  const factory = createTerminalSessionFactory({ registry, platform: 'darwin', env: {}, cwd: '/user/home',
    loadPty: async () => { throw new Error('unavailable') }, warn: () => {},
    spawnPipe: (...args) => { calls.push(args); return child }, newId: () => 'pipe-test' })
  await factory.create()
  assert.equal(calls[0][0], '/bin/zsh')
  assert.equal(calls[0][2].shell, false)
  const state = registry.snapshot('pipe-test')
  assert.equal(state.transport, 'pipe')
  assert.equal(state.usePty, false)
  assert.equal(state.degraded, true)
  assert.equal(state.reason, 'PTY_UNAVAILABLE')
  const resize = registry.resize('pipe-test', 120, 40)
  assert.equal(resize.ok, false)
  assert.equal(resize.code, 'RESIZE_UNSUPPORTED')
  assert.equal(registry.active.get('pipe-test').cols, 80)
})


test('ambiguous Windows startup failure never becomes a definite no-session error', async () => {
  const registry = new TerminalSessionRegistry()
  await assert.rejects(createTerminalSessionFactory({ registry, ...options, cwd: 'C:\\Users\\Example',
    startWindowsProcess: async () => { throw new Error('worker startup outcome unknown') } }).create(),
  error => error.code === 'WINDOWS_SPAWN_UNCONFIRMED' && error.nativeCreated === null)
  assert.equal(registry.active.size, 0)
})
