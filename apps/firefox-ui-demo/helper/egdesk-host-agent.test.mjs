import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  HOST_AGENT_CODES, HOST_AGENT_INPUT_MONITOR, createHostAgent, createSocketDirectory, resolveHostAgentExecutable,
} from './egdesk-host-agent.mjs'
import { createHostActivity } from './egdesk-host-activity.mjs'
import { createHostLease } from './egdesk-host-lease.mjs'

const EXECUTABLE = '/opt/egdesk/egdesk-helper'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, ms = 3000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await wait(5)
  }
}

// Plays the Rust helper over a real Unix socket: reads the nonce line from
// stdin, binds the socket from argv, prints the ready line, checks hello.
class FakeHelper extends EventEmitter {
  constructor(args, options, behavior = {}) {
    super()
    this.args = args; this.options = options; this.behavior = behavior
    this.pid = 40_000 + Math.floor(Math.random() * 1000)
    this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.stdin = new EventEmitter()
    this.stdinText = ''; this.stdinEnded = false; this.exited = false; this.kills = []; this.received = []
    this.monoMs = behavior.monoMs ?? 100
    this.socketPath = args[args.indexOf('--socket') + 1]
    this.stdin.write = data => {
      this.stdinText += data
      if (!this.nonce && this.stdinText.includes('\n')) {
        this.nonce = JSON.parse(this.stdinText.split('\n')[0]).nonce
        queueMicrotask(() => this.listen())
      }
      return true
    }
    this.stdin.end = () => { this.stdinEnded = true; if (behavior.exitOnEof !== false) setImmediate(() => this.exit(0)) }
  }
  listen() {
    if (this.behavior.noReady) return
    this.server = net.createServer(connection => this.accept(connection))
    this.server.listen(this.socketPath, () => {
      const ready = this.behavior.badReady ? { v: 1, type: 'ready', socket: '/elsewhere' } : { v: 1, type: 'ready', pid: this.pid, socket: this.socketPath }
      this.stdout.emit('data', Buffer.from(JSON.stringify(ready) + '\n'))
    })
  }
  accept(connection) {
    this.connection = connection
    let buffer = ''
    connection.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        this.handle(JSON.parse(line))
      }
    })
    connection.on('error', () => {})
  }
  send(value) { if (this.connection && !this.connection.destroyed) this.connection.write(JSON.stringify(value) + '\n') }
  handle(message) {
    this.received.push(message)
    if (message.type === 'hello') {
      if (this.behavior.reject || message.nonce !== this.nonce) { this.send({ type: 'hello.rejected', code: 'bad_nonce' }); this.connection.end(); return }
      this.send({ type: 'hello.ok', v: 1, pid: this.pid, monoMs: this.monoMs, mode: 'observe', capabilities: { observe: true, input: false, capture: false, accessibility: false }, heartbeatTimeoutMs: 5000 })
      this.emit('authenticated')
      return
    }
    if (message.type === 'ping') { if (!this.behavior.silent) this.send({ type: 'pong', seq: message.seq, monoMs: this.monoMs }); return }
    if (this.behavior.ignoreRequests) return
    const results = {
      snapshot: { apps: [{ bundleId: 'com.apple.finder', pid: 1, name: 'Finder', active: true, policy: 'regular' }], frontmost: { bundleId: 'com.apple.finder', pid: 1, name: 'Finder' }, windows: { windows: [], titles: 'not-requested', truncated: false }, permissions: { accessibility: false, screenRecording: false, inputMonitoring: false, requested: false, bundled: false }, service: { bundleId: 'com.openai.sky.CUAService', running: false, pids: [] } },
      listWindows: { windows: [{ windowId: 7, pid: 1, ownerName: 'Finder', layer: 0, onScreen: true, bounds: { x: 0, y: 0, width: 10, height: 10 } }], titles: message.titles ? 'omitted-no-permission' : 'not-requested', truncated: false },
      permissions: { accessibility: false, screenRecording: false, inputMonitoring: false, requested: false, bundled: false },
    }
    if (message.type === 'shutdown') {
      this.send({ type: 'result', id: message.id, ok: true, result: { stopping: true } })
      if (!this.behavior.ignoreShutdown) setImmediate(() => this.exit(0))
      return
    }
    if (this.behavior.refuse) { this.send({ type: 'result', id: message.id, ok: false, code: 'observe_only', message: 'no' }); return }
    this.send({ type: 'result', id: message.id, ok: true, result: results[message.type] ?? {} })
  }
  exit(code) {
    if (this.exited) return
    this.exited = true
    try { this.connection?.destroy() } catch {}
    try { this.server?.close() } catch {}
    this.emit('exit', code, null)
  }
  kill(signal) { this.kills.push(signal); setImmediate(() => this.exit(null)); return true }
}

function harness({ behaviors = [], ...options } = {}) {
  const helpers = [], events = []
  const agent = createHostAgent({
    executable: EXECUTABLE,
    spawnDriver: (file, args, spawnOptions) => {
      const helper = new FakeHelper(args, spawnOptions, behaviors[helpers.length] ?? behaviors.at(-1) ?? {})
      helper.file = file
      helpers.push(helper)
      return helper
    },
    heartbeatMs: 20_000, heartbeatTimeoutMs: 40_000, startupTimeoutMs: 2000, requestTimeoutMs: 1000, stopTimeoutMs: 500,
    restart: { baseMs: 1, maxMs: 4, maxFailures: 4, stableMs: 60_000 },
    env: { HOME: '/Users/someone', NODE_OPTIONS: '--require evil', OPENAI_API_KEY: 'sk-secret', PATH: '/anything' },
    onEvent: event => events.push(event),
    ...options,
  })
  return { agent, helpers, events }
}

test('starts the explicit helper without a shell, with a private socket and a per-run nonce', async () => {
  const { agent, helpers, events } = harness()
  const status = await agent.start()
  assert.equal(status.state, 'ready')
  assert.equal(status.mode, 'observe')
  assert.equal(status.inputMonitor, false)
  const [helper] = helpers
  assert.equal(helper.file, EXECUTABLE)
  assert.deepEqual(helper.args.slice(0, 3), ['host-observe', '--socket', helper.socketPath])
  assert.deepEqual(helper.args.slice(3), ['--heartbeat-timeout-ms', '40000', '--connect-timeout-ms', '2000'])
  assert.equal(helper.options.shell, false)
  assert.equal(helper.options.cwd, '/')
  assert.deepEqual(Object.keys(helper.options.env).sort(), ['HOME', 'PATH'])
  assert.equal(helper.options.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
  // The nonce goes over stdin only (not argv or env) and is what hello carries.
  assert.match(helper.nonce, /^[0-9a-f]{64}$/)
  assert.equal(helper.args.includes(helper.nonce), false)
  assert.equal(helper.received[0].nonce, helper.nonce)
  const dir = path.dirname(helper.socketPath)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(agent.guardAlive(), true)
  assert.deepEqual(events.filter(event => event.type === 'host.state').map(event => event.state), ['starting', 'ready'])
  await agent.stop()
  assert.equal(helper.received.at(-1).type, 'shutdown')
  assert.equal(helper.stdinEnded, true)
  assert.equal(fs.existsSync(dir), false)
  assert.equal(agent.status().state, 'stopped')
  assert.equal(agent.guardAlive(), false)
})

test('read requests round-trip; anything else is refused before it is sent', async () => {
  const { agent, helpers } = harness()
  await agent.start()
  const snapshot = await agent.snapshot()
  assert.equal(snapshot.frontmost.bundleId, 'com.apple.finder')
  assert.equal(snapshot.permissions.requested, false)
  const windows = await agent.listWindows({ titles: true })
  assert.equal(windows.titles, 'omitted-no-permission')
  assert.deepEqual(helpers[0].received.at(-1), { id: helpers[0].received.at(-1).id, type: 'listWindows', titles: true })
  await assert.rejects(agent.request('click', { x: 1, y: 2 }), { code: HOST_AGENT_CODES.INVALID_REQUEST })
  await assert.rejects(agent.listWindows({ titles: 'yes' }), { code: HOST_AGENT_CODES.INVALID_REQUEST })
  await assert.rejects(agent.listWindows({ x: true }), { code: HOST_AGENT_CODES.INVALID_REQUEST })
  assert.equal(helpers[0].received.some(message => message.type === 'click'), false)
  await agent.stop()
  await assert.rejects(agent.snapshot(), { code: HOST_AGENT_CODES.NOT_READY })
})

test('helper refusals and silence come back as codes, not retries', async () => {
  const refused = harness({ behaviors: [{ refuse: true }] })
  await refused.agent.start()
  await assert.rejects(refused.agent.permissions(), error => error.code === HOST_AGENT_CODES.REFUSED && error.helperCode === 'observe_only')
  await refused.agent.stop()
  const slow = harness({ behaviors: [{ ignoreRequests: true }] })
  await slow.agent.start()
  await assert.rejects(slow.agent.snapshot({ timeoutMs: 100 }), { code: HOST_AGENT_CODES.TIMEOUT })
  assert.equal(slow.helpers[0].received.filter(message => message.type === 'snapshot').length, 1)
  await slow.agent.stop()
})

test('events are stamped on the caller clock and feed the activity list', async () => {
  let wall = 50_000
  const activity = createHostActivity({ now: () => wall })
  const { agent, helpers } = harness({
    behaviors: [{ monoMs: 1000 }],
    now: () => wall,
    onEvent: event => activity.noteHostEvent(event),
  })
  await agent.start() // offset = 50_000 - 1000
  const helper = helpers[0]
  wall = 50_500
  helper.send({ type: 'event', event: 'app.activated', seq: 1, monoMs: 1200, app: { bundleId: 'com.apple.Safari', pid: 9, name: 'Safari', title: 'not forwarded' } })
  helper.send({ type: 'event', event: 'service.changed', seq: 2, monoMs: 1300, service: { bundleId: 'com.openai.sky.CUAService', running: true, pids: [77] } })
  await until(() => activity.list().length === 2)
  const [front, service] = activity.list()
  assert.equal(front.at, 50_200)
  assert.deepEqual(front.app, { bundleId: 'com.apple.Safari', name: 'Safari', pid: 9 })
  assert.equal(service.at, 50_300)
  assert.equal(service.running, true)
  // A helper clock ahead of ours never produces a future time.
  helper.send({ type: 'event', event: 'app.activated', seq: 3, monoMs: 99_999, app: { bundleId: 'com.apple.Notes', pid: 10, name: 'Notes' } })
  await until(() => activity.list().length === 3)
  assert.equal(activity.list()[2].at, 50_500)
  await agent.stop()
})

test('a rejected hello or a bad ready line restarts with backoff until one is accepted', async () => {
  const { agent, helpers, events } = harness({ behaviors: [{ reject: true }, { badReady: true }, {}] })
  const status = await agent.start()
  assert.equal(status.state, 'ready')
  assert.equal(helpers.length, 3)
  assert.equal(status.failures, 2)
  const states = events.filter(event => event.type === 'host.state')
  assert.equal(states.find(event => event.state === 'restarting').code, 'rejected:bad_nonce')
  // Every failed helper was told to leave (stdin EOF) and its directory removed.
  await until(() => helpers.slice(0, 2).every(helper => helper.exited))
  for (const helper of helpers.slice(0, 2)) {
    assert.equal(helper.stdinEnded, true)
    assert.equal(fs.existsSync(path.dirname(helper.socketPath)), false)
  }
  // Each run had its own nonce.
  assert.equal(new Set(helpers.map(helper => helper.nonce)).size, 3)
  await agent.stop()
})

test('backoff doubles up to its cap and the agent gives up after maxFailures', async () => {
  const delays = []
  const agent = createHostAgent({
    executable: EXECUTABLE,
    spawnDriver: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
    setTimer: (fn, ms) => { delays.push(ms); const timer = setTimeout(fn, 0); return timer },
    clearTimer: timer => clearTimeout(timer),
    restart: { baseMs: 500, maxMs: 1500, maxFailures: 4, stableMs: 60_000 },
  })
  await assert.rejects(agent.start(), error => error.code === HOST_AGENT_CODES.FAILED && error.lastCode === 'spawn-failed')
  // Startup timers are not created for a spawn that throws; these are restart delays.
  assert.deepEqual(delays, [500, 1000, 1500])
  assert.equal(agent.status().state, 'failed')
  assert.equal(agent.status().failures, 4)
})

test('a silent helper is replaced after the heartbeat timeout', async () => {
  const { agent, helpers, events } = harness({ behaviors: [{ silent: true }, {}], heartbeatMs: 100, heartbeatTimeoutMs: 500 })
  await agent.start()
  await until(() => helpers.length === 2 && agent.status().state === 'ready', 4000)
  assert.equal(events.find(event => event.state === 'restarting').code, 'heartbeat-lost')
  assert.equal(helpers[0].stdinEnded, true)
  await agent.stop()
})

test('a helper that exits on its own is restarted and pending requests fail as disconnected', async () => {
  const { agent, helpers } = harness({ behaviors: [{ ignoreRequests: true }, {}] })
  await agent.start()
  const pending = agent.snapshot({ timeoutMs: 2000 })
  await until(() => helpers[0].received.some(message => message.type === 'snapshot'))
  helpers[0].exit(1)
  await assert.rejects(pending, { code: HOST_AGENT_CODES.DISCONNECTED })
  await until(() => helpers.length === 2 && agent.status().state === 'ready')
  assert.match(agent.status().code, /^(socket-closed|exited:1)$/)
  await agent.stop()
})

test('stop() escalates to SIGKILL for a helper that ignores shutdown and stdin EOF', async () => {
  const { agent, helpers } = harness({ behaviors: [{ ignoreShutdown: true, exitOnEof: false }], stopTimeoutMs: 100 })
  await agent.start()
  const started = Date.now()
  await agent.stop()
  assert.deepEqual(helpers[0].kills, ['SIGKILL'])
  assert.ok(Date.now() - started >= 150)
  assert.equal(fs.existsSync(path.dirname(helpers[0].socketPath)), false)
})

test('the lease sees the helper as its watchdog and keeps input monitoring off', async () => {
  const { agent } = harness()
  const lease = createHostLease({ guardAlive: agent.guardAlive })
  agent.attachLease(lease)
  assert.equal(HOST_AGENT_INPUT_MONITOR, false)
  assert.deepEqual(lease.status().reasons, ['monitor', 'guard'])
  await agent.start()
  assert.deepEqual(lease.status().reasons, ['monitor'])
  assert.equal(lease.status().state, 'unavailable')
  await agent.stop()
  assert.deepEqual(lease.status().reasons, ['monitor', 'guard'])
  assert.throws(() => agent.attachLease({}), TypeError)
})

test('executable resolution: macOS only, absolute, built and runnable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-host-test-'))
  try {
    const binary = path.join(dir, 'egdesk-helper')
    fs.writeFileSync(binary, '#!/bin/sh\n')
    fs.chmodSync(binary, 0o600)
    assert.throws(() => resolveHostAgentExecutable({ executable: binary, platform: 'linux' }), { code: HOST_AGENT_CODES.UNSUPPORTED })
    assert.throws(() => resolveHostAgentExecutable({ executable: 'egdesk-helper', platform: 'darwin' }), { code: HOST_AGENT_CODES.EXECUTABLE })
    assert.throws(() => resolveHostAgentExecutable({ executable: path.join(dir, 'missing'), platform: 'darwin' }), { code: HOST_AGENT_CODES.EXECUTABLE })
    assert.throws(() => resolveHostAgentExecutable({ executable: binary, platform: 'darwin' }), { code: HOST_AGENT_CODES.EXECUTABLE })
    fs.chmodSync(binary, 0o700)
    assert.equal(resolveHostAgentExecutable({ executable: binary, platform: 'darwin' }), binary)
    fs.mkdirSync(path.join(dir, 'target', 'debug'), { recursive: true })
    fs.copyFileSync(binary, path.join(dir, 'target', 'debug', 'egdesk-helper'))
    fs.chmodSync(path.join(dir, 'target', 'debug', 'egdesk-helper'), 0o700)
    assert.equal(resolveHostAgentExecutable({ helperRustDir: dir, platform: 'darwin' }), path.join(dir, 'target', 'debug', 'egdesk-helper'))
    assert.throws(() => resolveHostAgentExecutable({ helperRustDir: dir, profile: 'other', platform: 'darwin' }), { code: HOST_AGENT_CODES.EXECUTABLE })
    assert.throws(() => createHostAgent({ executable: 'relative/egdesk-helper' }), { code: HOST_AGENT_CODES.EXECUTABLE })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('socket directories are private, short enough and cleaned up', () => {
  const made = createSocketDirectory()
  assert.equal(fs.statSync(made.dir).mode & 0o777, 0o700)
  assert.ok(Buffer.byteLength(made.socketPath) <= 103)
  made.cleanup()
  assert.equal(fs.existsSync(made.dir), false)
  const deep = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-host-test-'))
  const long = path.join(deep, 'x'.repeat(100))
  fs.mkdirSync(long)
  try {
    assert.throws(() => createSocketDirectory({ base: long }), { code: HOST_AGENT_CODES.SOCKET_PATH })
    assert.deepEqual(fs.readdirSync(long), [])
  } finally { fs.rmSync(deep, { recursive: true, force: true }) }
})

// One real observation run against the built Rust helper. Opt-in because it
// reads this Mac's app and window list (no input, no permission prompt):
// EGDESK_HOST_REAL=1 node --test helper/egdesk-host-agent.test.mjs
test('real helper: observe-only snapshot (opt-in)', { skip: process.env.EGDESK_HOST_REAL !== '1' || process.platform !== 'darwin' }, async () => {
  const executable = resolveHostAgentExecutable()
  const events = []
  const agent = createHostAgent({ executable, onEvent: event => events.push(event) })
  try {
    const status = await agent.start()
    assert.equal(status.state, 'ready')
    const snapshot = await agent.snapshot()
    assert.ok(Array.isArray(snapshot.apps) && snapshot.apps.length > 0)
    assert.equal(snapshot.permissions.requested, false)
    assert.equal(typeof snapshot.service.running, 'boolean')
    assert.ok(snapshot.windows.windows.every(window => !('title' in window)))
    await assert.rejects(agent.request('click'), { code: HOST_AGENT_CODES.INVALID_REQUEST })
  } finally { await agent.stop() }
})
