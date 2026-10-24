import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  HOST_CONTROL_POLICIES, HOST_LEASE_CODES, HOST_LEASE_STATES, HostLeaseBlocked,
  classifyHostTool, createDeviceLock, createHostLease, hostLaneKey, requiresHostControl,
} from './egdesk-host-lease.mjs'

const C = HOST_LEASE_CODES
const TEXTEDIT = { bundleId: 'com.apple.TextEdit', pid: 501 }
const FINDER = { bundleId: 'com.apple.finder', pid: 502 }

// A fake monotonic clock, a fake device lock and a lease whose input monitor is up.
function harness(options = {}) {
  const clock = { t: 1000 }
  const events = []
  const lease = createHostLease({ now: () => clock.t, onEvent: event => events.push(event), ...options })
  if (options.requireMonitor !== false) lease.setInputMonitor(true)
  events.length = 0
  return { clock, events, lease, advance: ms => { clock.t += ms } }
}
const blocked = (fn, code) => assert.throws(fn, error => error instanceof HostLeaseBlocked && error.code === code, code)
const flush = () => new Promise(resolve => setImmediate(resolve))

test('a tool is direct, possible or other by what it does to the desktop; an unknown tool keeps the gate', () => {
  for (const name of ['click', 'typeText', 'type_text', 'key', 'press_key', 'scroll', 'drag', 'set_value', 'select_text', 'perform_secondary_action', 'setWindowFrame']) {
    assert.equal(classifyHostTool(name), 'direct', name)
  }
  for (const name of ['launch_app', 'openApplication', 'run_script']) assert.equal(classifyHostTool(name), 'possible', name)
  for (const name of ['capture', 'listApps', 'list_windows', 'get_app_state', 'getWindowState', 'check_permissions', 'status']) assert.equal(classifyHostTool(name), 'other', name)
  for (const name of ['frobnicate', 'computer', '', null, 7]) assert.equal(classifyHostTool(name), 'direct', String(name))
  // Modes: an app with no mode launches; an unknown mode keeps the gate.
  assert.equal(classifyHostTool('app'), 'possible')
  assert.equal(classifyHostTool('app', { mode: 'activate' }), 'direct')
  assert.equal(classifyHostTool('app', { mode: 'list' }), 'other')
  assert.equal(classifyHostTool('app', { mode: 'teleport' }), 'direct')
  assert.equal(classifyHostTool('clipboard', { mode: 'get' }), 'other')
  assert.equal(classifyHostTool('clipboard', { mode: 'set' }), 'possible')
  assert.equal(classifyHostTool('clipboard'), 'direct')
  assert.deepEqual(HOST_CONTROL_POLICIES, ['strict', 'balanced', 'relaxed'])
  assert.equal(requiresHostControl('launch_app'), true, 'balanced is the default')
  assert.equal(requiresHostControl('launch_app', { policy: 'relaxed' }), false)
  assert.equal(requiresHostControl('capture', { policy: 'balanced' }), false)
  assert.equal(requiresHostControl('capture', { policy: 'strict' }), true)
  assert.equal(requiresHostControl('status', { policy: 'strict' }), false, 'reading the lease never takes it')
  assert.equal(requiresHostControl('frobnicate', { policy: 'relaxed' }), true)
  assert.throws(() => requiresHostControl('click', { policy: 'lenient' }), TypeError)
  assert.deepEqual(['com.apple.TextEdit', { app: ' TextEdit ' }, TEXTEDIT, { app: '' }, {}, null, { app: 'a\0b' }, { app: 'x'.repeat(300) }].map(hostLaneKey),
    ['com.apple.textedit', 'textedit', 'com.apple.textedit', null, null, null, null, null])
})

test('without an input monitor the lease is unavailable and an Agent action cannot begin (fail closed)', () => {
  const clock = { t: 1000 }
  const lease = createHostLease({ now: () => clock.t })
  assert.deepEqual(HOST_LEASE_STATES, ['ready', 'user', 'ai', 'unavailable'])
  assert.equal(lease.status().state, 'unavailable')
  assert.deepEqual(lease.status().reasons, ['monitor'])
  blocked(() => lease.begin('click', { target: TEXTEDIT }), C.CONTROL_UNAVAILABLE)
  // A read does not take the lease and is not refused.
  assert.equal(lease.begin('capture', { target: TEXTEDIT }).control, false)
  assert.equal(lease.setInputMonitor(true).state, 'ready')
  const token = lease.begin('click', { target: TEXTEDIT })
  assert.equal(lease.status().state, 'ai')
  // Losing the monitor (tap off, permission lost) closes the gate at once.
  lease.setInputMonitor(false)
  blocked(() => lease.checkpoint(token), C.CONTROL_UNAVAILABLE)
  assert.equal(lease.status().state, 'unavailable')
})

test('an Agent action takes the lease, checks it before every event, and keeps it for 15 s after the last action', () => {
  const { lease, events, advance } = harness()
  const token = lease.begin('click', { target: TEXTEDIT, commandId: 'c1' })
  const status = lease.status()
  assert.equal(status.state, 'ai')
  assert.equal(token.epoch, status.epoch)
  assert.equal(token.control, true)
  const mark = lease.checkpoint(token)
  assert.match(mark, /^[A-Za-z0-9_-]{16}$/)
  assert.notEqual(lease.checkpoint(token), mark, 'each event gets its own mark')
  assert.equal(token.steps, 2)
  lease.end(token)
  assert.equal(lease.status().holdMs, 15000)
  // A second action inside the hold keeps the same epoch.
  advance(14000)
  const again = lease.begin('typeText', { target: TEXTEDIT })
  assert.equal(again.epoch, token.epoch)
  lease.end(again)
  advance(14999)
  assert.equal(lease.status().state, 'ai')
  advance(1)
  assert.equal(lease.status().state, 'ready')
  blocked(() => lease.checkpoint(again), C.LEASE_REVOKED)
  assert.deepEqual(events.filter(event => event.type === 'control.state').map(event => event.status.state), ['ai', 'ready'])
  assert.throws(() => lease.checkpoint(null), TypeError)
})

test('while a person uses the Mac an Agent action does not begin; after 10 s without input it may', () => {
  const { lease, advance } = harness()
  lease.observeInput({ kind: 'pointer' })
  assert.equal(lease.status().state, 'user')
  assert.equal(lease.status().waitMs, 10000)
  try { lease.begin('click', { target: TEXTEDIT }); assert.fail('should block') } catch (error) {
    assert.equal(error.code, C.USER_CONTROL)
    assert.equal(error.status.waitMs, 10000)
  }
  advance(4000)
  lease.observeInput({ kind: 'move', distance: 3 })
  advance(9999)
  assert.equal(lease.status().state, 'user')
  advance(1)
  assert.equal(lease.status().state, 'ready')
  // A key or button still down keeps it the person's, even when quiet.
  lease.observeInput({ kind: 'key', held: true })
  advance(30000)
  assert.equal(lease.status().state, 'user')
  assert.equal(lease.status().held, true)
  lease.observeInput({ kind: 'key', held: false })
  blocked(() => lease.begin('click', { target: TEXTEDIT }), C.USER_CONTROL)
  advance(10000)
  assert.equal(lease.status().state, 'ready')
  // A held key reported in 'ready' refuses an action too.
  lease.observeInput({ kind: 'move', distance: 0, held: true })
  blocked(() => lease.begin('click', { target: TEXTEDIT }), C.INPUT_HELD)
})

test('a person\'s input during an Agent action yields at once; the Agent waits until handed back', () => {
  const { lease, events, advance } = harness()
  const token = lease.begin('typeText', { target: TEXTEDIT })
  lease.checkpoint(token)
  const seen = lease.observeInput({ kind: 'key' })
  assert.equal(seen.attributed, 'human')
  assert.equal(seen.status.state, 'user')
  assert.equal(seen.status.yielded, true)
  const yielded = events.find(event => event.type === 'control.yielded')
  assert.deepEqual(Object.keys(yielded).sort(), ['at', 'epoch', 'reason', 'type'])
  assert.equal(yielded.reason, 'human-input')
  blocked(() => lease.checkpoint(token), C.USER_INTERVENTION)
  lease.end(token)
  // Quiet time alone does not give it back (맥6: resume only by the button).
  advance(60000)
  assert.equal(lease.status().state, 'user')
  assert.equal(lease.status().waitMs, 0)
  blocked(() => lease.begin('click', { target: TEXTEDIT }), C.USER_INTERVENTION)
  // Not while a key is still down.
  lease.observeInput({ kind: 'key', held: true })
  assert.deepEqual([lease.handBack().ok, lease.handBack().code], [false, C.INPUT_HELD])
  lease.observeInput({ kind: 'key', held: false })
  const back = lease.handBack()
  assert.equal(back.ok, true)
  assert.equal(back.status.state, 'ready')
  assert.equal(back.status.yielded, false)
  const next = lease.begin('click', { target: TEXTEDIT })
  assert.ok(next.epoch > token.epoch)
  blocked(() => lease.checkpoint(token), C.LEASE_REVOKED, 'an ended token stays refused')
})

test('the reason an epoch ended is kept for 60 s (tombstone), then an old token is simply revoked', () => {
  const { lease, advance } = harness()
  const token = lease.begin('click', { target: TEXTEDIT })
  lease.observeInput({ kind: 'scroll' })
  advance(59999)
  blocked(() => lease.checkpoint(token), C.USER_INTERVENTION)
  advance(1)
  blocked(() => lease.checkpoint(token), C.LEASE_REVOKED)
})

test('the Agent\'s own events are told apart only by an unused dispatch mark; a forged, reused or expired mark is a person', () => {
  const { lease, advance } = harness()
  const token = lease.begin('click', { target: TEXTEDIT })
  const mark = lease.checkpoint(token)
  assert.equal(lease.observeInput({ kind: 'pointer', mark }).attributed, 'agent')
  assert.equal(lease.status().state, 'ai', 'its own click does not yield')
  // The same mark a second time is not trusted.
  assert.equal(lease.observeInput({ kind: 'pointer', mark }).attributed, 'human')
  assert.equal(lease.status().state, 'user')
  lease.end(token)
  lease.handBack()
  const second = lease.begin('key', { target: TEXTEDIT })
  const pair = lease.checkpoint(second, { events: 2 })
  assert.equal(lease.observeInput({ kind: 'key', mark: pair }).attributed, 'agent')
  assert.equal(lease.observeInput({ kind: 'key', mark: pair }).attributed, 'agent', 'key down and up share one mark')
  assert.equal(lease.observeInput({ kind: 'key', mark: 'forged-mark-value' }).attributed, 'human')
  lease.end(second)
  lease.handBack()
  const third = lease.begin('click', { target: TEXTEDIT })
  const late = lease.checkpoint(third)
  advance(2000)
  assert.equal(lease.observeInput({ kind: 'pointer', mark: late }).attributed, 'human', 'an echo after markTtlMs is not ours')
  assert.throws(() => lease.observeInput({ kind: 'telepathy' }), TypeError)
})

test('small pointer jitter during an Agent action is not a takeover; a real movement is', () => {
  const { lease, advance } = harness()
  const token = lease.begin('click', { target: TEXTEDIT })
  for (let index = 0; index < 4; index += 1) { lease.observeInput({ kind: 'move', distance: 10 }); advance(100) }
  assert.equal(lease.status().state, 'ai', '40 points of path stays under 48')
  advance(500)
  lease.observeInput({ kind: 'move', distance: 40 })
  assert.equal(lease.status().state, 'ai', 'a 0.5 s pause starts a new path')
  advance(100)
  lease.observeInput({ kind: 'move', distance: 8 })
  assert.equal(lease.status().state, 'user')
  blocked(() => lease.checkpoint(token), C.USER_INTERVENTION)
})

test('a dead watchdog closes the gate before the next event and an action cannot begin; it recovers to ready, never to ai', () => {
  let guard = true
  const { lease } = harness({ guardAlive: () => guard })
  const token = lease.begin('drag', { target: TEXTEDIT })
  lease.checkpoint(token)
  guard = false
  blocked(() => lease.checkpoint(token), C.CONTROL_UNAVAILABLE)
  assert.deepEqual(lease.status().reasons, ['guard'])
  blocked(() => lease.begin('drag', { target: TEXTEDIT }), C.CONTROL_UNAVAILABLE)
  guard = true
  assert.equal(lease.status().state, 'ready')
  blocked(() => lease.checkpoint(token), C.CONTROL_UNAVAILABLE)
  // A throwing watchdog probe counts as dead.
  const { lease: other } = harness({ guardAlive: () => { throw new Error('probe failed') } })
  assert.equal(other.status().state, 'unavailable')
})

test('an action past its deadline is not sent; revoke ends the lease', () => {
  const { lease, advance } = harness()
  const token = lease.begin('click', { target: TEXTEDIT, deadlineMs: 500 })
  lease.checkpoint(token)
  advance(500)
  blocked(() => lease.checkpoint(token), C.EXPIRED)
  lease.end(token)
  const next = lease.begin('click', { target: TEXTEDIT })
  assert.equal(lease.revoke().state, 'ready')
  blocked(() => lease.checkpoint(next), C.LEASE_REVOKED)
  blocked(() => lease.checkpoint(next), C.LEASE_REVOKED)
  const ended = lease.begin('click', { target: TEXTEDIT })
  lease.end(ended)
  blocked(() => lease.checkpoint(ended), C.LEASE_REVOKED)
})

// A task like a provider's: one checkpoint per event, a release cleanup while
// a key is down, and a hook between events.
function keyTask(log, between = async () => {}) {
  return async ctx => {
    let down = false
    ctx.onCleanup(() => { if (down) { down = false; log.push('release') } })
    ctx.checkpoint(); log.push('down'); down = true
    await between()
    ctx.checkpoint(); log.push('up'); down = false
    return 'pressed'
  }
}

test('actions on one app run one at a time in order; another app\'s lane is separate', async () => {
  const { lease } = harness()
  const order = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const first = lease.run('click', { target: TEXTEDIT, commandId: 'first' }, async ctx => { order.push('first:start'); await gate; ctx.checkpoint(); order.push('first:end'); return 1 })
  const second = lease.run('click', { target: TEXTEDIT, commandId: 'second' }, async ctx => { ctx.checkpoint(); order.push('second'); return 2 })
  const other = lease.run('click', { target: FINDER, commandId: 'other' }, async ctx => { ctx.checkpoint(); order.push('other'); return 3 })
  await flush()
  assert.deepEqual(order, ['first:start', 'other'])
  release()
  const results = await Promise.all([first, second, other])
  assert.deepEqual(order, ['first:start', 'other', 'first:end', 'second'])
  assert.deepEqual(results.map(result => [result.commandId, result.dispatched, result.code, result.value]), [['first', true, null, 1], ['second', true, null, 2], ['other', true, null, 3]])
  // A read does not wait in a lane and does not take the lease.
  const read = await lease.run('capture', { target: TEXTEDIT }, async ctx => { assert.equal(ctx.checkpoint(), null); return 'frame' })
  assert.deepEqual([read.dispatched, read.value], [false, 'frame'])
})

test('stopApp drops what was not sent, stops the running action at its next event, releases held keys and only then ACKs', async () => {
  const { lease, events } = harness()
  const log = []
  let midway
  const reached = new Promise(resolve => { midway = resolve })
  let resume
  const paused = new Promise(resolve => { resume = resolve })
  const running = lease.run('key', { target: TEXTEDIT, commandId: 'held' }, keyTask(log, async () => { midway(); await paused }))
  const queued = lease.run('typeText', { target: TEXTEDIT, commandId: 'queued' }, async () => { log.push('queued ran'); return null })
  const elsewhere = lease.run('click', { target: FINDER, commandId: 'elsewhere' }, async ctx => { ctx.checkpoint(); return 'ok' })
  await reached
  const stopping = lease.stopApp({ app: 'COM.APPLE.TEXTEDIT' })
  let acked = false
  stopping.then(() => { acked = true })
  await flush()
  assert.equal(acked, false, 'no ACK while the running action has not cleaned up')
  resume()
  const ack = await stopping
  assert.deepEqual(log, ['down', 'release'], 'the key that went down is released; nothing after the stop is sent')
  assert.deepEqual({ ...ack, at: 0, epoch: 0 }, { type: 'control.stopped', scope: 'app', app: 'com.apple.textedit', notDispatched: 1, inFlight: 1, epoch: 0, at: 0 })
  const [held, dropped, other] = await Promise.all([running, queued, elsewhere])
  assert.deepEqual([held.dispatched, held.code], [true, C.STOPPED], 'what was sent stays sent; it is not called cancelled')
  assert.deepEqual([dropped.dispatched, dropped.code], [false, C.STOPPED])
  assert.deepEqual([other.dispatched, other.code], [true, null], 'another app keeps going')
  // The ACK comes after the cleanup receipt.
  const phases = events.filter(event => event.type === 'command.receipt' && event.commandId === 'held').map(event => event.phase)
  assert.deepEqual(phases, ['enqueued', 'dispatched', 'preempted', 'cleanup'])
  assert.ok(events.findIndex(event => event.type === 'control.stopped') > events.findIndex(event => event.phase === 'cleanup'))
  // The app stays stopped until handed back, for that app only.
  assert.deepEqual(lease.status().stoppedApps, ['com.apple.textedit'])
  assert.deepEqual((await lease.run('click', { target: TEXTEDIT }, async () => 'x')).code, C.STOPPED)
  assert.equal(lease.handBack({ target: FINDER }).ok, false)
  assert.equal(lease.handBack({ target: TEXTEDIT }).ok, true)
  assert.deepEqual((await lease.run('click', { target: TEXTEDIT }, async ctx => { ctx.checkpoint(); return 'x' })).code, null)
  await assert.rejects(lease.stopApp({}), TypeError)
})

test('a stop raised inside the first synchronous step of an action still waits for that action\'s cleanup', async () => {
  const { lease } = harness()
  const log = []
  let stop
  const running = lease.run('key', { target: TEXTEDIT }, keyTask(log, async () => { stop = lease.stopApp(TEXTEDIT).then(ack => { log.push(`ack:${ack.inFlight}`); return ack }) }))
  await running
  await stop
  assert.deepEqual(log, ['down', 'release', 'ack:1'])
})

test('stopAll stops every lane, refuses new actions until handed back, and ACKs after cleanup', async () => {
  const { lease, events } = harness()
  const log = []
  let midway
  const reached = new Promise(resolve => { midway = resolve })
  const running = lease.run('key', { target: TEXTEDIT }, keyTask(log, async () => { midway(); await flush() }))
  const queued = lease.run('key', { target: TEXTEDIT }, keyTask(log))
  await reached
  const ack = await lease.stopAll()
  assert.equal(ack.scope, 'all')
  assert.equal(ack.notDispatched, 1)
  assert.deepEqual(log, ['down', 'release'])
  assert.deepEqual([(await running).code, (await queued).code], [C.STOPPED, C.STOPPED])
  const status = lease.status()
  assert.deepEqual([status.state, status.reasons], ['unavailable', ['stopped']])
  blocked(() => lease.begin('click', { target: FINDER }), C.STOPPED)
  assert.equal(lease.handBack().status.state, 'ready')
  assert.equal(lease.begin('click', { target: FINDER }).control, true)
  assert.ok(events.some(event => event.type === 'control.stopped' && event.scope === 'all'))
})

test('a person taking over drops queued actions; a provider failure after the gate is an unknown outcome and is not retried', async () => {
  const { lease } = harness()
  let midway
  const reached = new Promise(resolve => { midway = resolve })
  let resume
  const paused = new Promise(resolve => { resume = resolve })
  const log = []
  const running = lease.run('key', { target: TEXTEDIT }, keyTask(log, async () => { midway(); await paused }))
  const queued = lease.run('click', { target: TEXTEDIT }, async () => 'never')
  await reached
  lease.observeInput({ kind: 'pointer' })
  resume()
  assert.deepEqual([(await running).code, (await queued).code, (await queued).dispatched], [C.USER_INTERVENTION, C.USER_INTERVENTION, false])
  assert.deepEqual(log, ['down', 'release'])
  lease.handBack()
  let attempts = 0
  const lost = await lease.run('click', { target: TEXTEDIT }, async ctx => { attempts += 1; ctx.checkpoint(); throw new Error('socket closed') })
  assert.deepEqual([lost.dispatched, lost.code, attempts], ['unknown', 'HOST_ACTION_OUTCOME_UNKNOWN', 1])
  const early = await lease.run('click', { target: TEXTEDIT }, async () => { throw new Error('no such window') })
  assert.deepEqual([early.dispatched, early.code], [false, 'HOST_ACTION_FAILED'])
  assert.throws(() => lease.run('click', { target: TEXTEDIT }), TypeError)
})

test('receipts carry one clock, the command id, order and pid, and never the arguments or text', async () => {
  const { lease, events, advance } = harness()
  const secret = 'Hunter2 typed into the password field'
  await lease.run('typeText', { target: TEXTEDIT, args: { text: secret }, commandId: 'typed-1' }, async ctx => {
    advance(5); ctx.checkpoint(); advance(5); ctx.checkpoint(); return { text: secret }
  })
  const receipts = events.filter(event => event.type === 'command.receipt')
  assert.deepEqual(receipts.map(event => event.phase), ['enqueued', 'dispatched', 'finished'])
  assert.deepEqual(receipts.map(event => event.at), [1000, 1005, 1010])
  for (const event of receipts) {
    assert.equal(event.commandId, 'typed-1')
    assert.equal(event.seq, 1)
    assert.equal(event.app, 'com.apple.textedit')
    assert.equal(event.pid, 501)
  }
  assert.equal(receipts.at(-1).steps, 2)
  assert.doesNotMatch(JSON.stringify(events), /Hunter2|password field/)
  // A command id that is not a plain id is replaced.
  await lease.run('click', { target: TEXTEDIT, commandId: '../../etc' }, async () => null)
  assert.match(events.filter(event => event.type === 'command.receipt').at(-1).commandId, /^cmd-\d+$/)
  // A listener that throws cannot hold the lease.
  const { lease: noisy } = harness({ onEvent: () => { throw new Error('listener down') } })
  assert.equal(noisy.begin('click', { target: TEXTEDIT }).control, true)
})

test('the device lock: one holder across processes, stale when its owner is gone or quiet, never follows a symlink', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'egdesk-host-lease-'))
  try {
    const lockPath = path.join(dir, 'host-input.lock')
    const clock = { t: 1_700_000_000_000 }
    const alive = new Set([111, 222])
    const make = (pid, extra = {}) => createDeviceLock({ lockPath, now: () => clock.t, pid, isAlive: candidate => alive.has(candidate), staleMs: 30000, ...extra })
    const a = make(111)
    const b = make(222)
    assert.equal(a.inspect(), 'free')
    assert.equal(a.acquire(), true)
    assert.equal((lstatSync(lockPath).mode & 0o777), 0o600)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(lockPath, 'utf8'))).sort(), ['at', 'nonce', 'pid', 'v'])
    assert.deepEqual([a.inspect(), b.inspect()], ['mine', 'other'])
    assert.equal(b.acquire(), false, 'a live, fresh holder keeps it')
    // Heartbeats keep it fresh; a quiet holder goes stale.
    clock.t += 20000
    assert.equal(a.heartbeat(), true)
    clock.t += 20000
    assert.equal(b.acquire(), false, 'refreshed 20 s ago')
    clock.t += 31000
    assert.equal(b.inspect(), 'stale')
    assert.equal(b.acquire(), true, 'quiet for over 30 s')
    assert.equal(a.heartbeat(), false, 'the old holder finds out at its next heartbeat')
    a.release()
    assert.equal(b.inspect(), 'mine', 'release by a non-holder changes nothing')
    // A holder whose process is gone is stale at once.
    alive.delete(222)
    assert.equal(a.acquire(), true)
    a.release()
    assert.equal(existsSync(lockPath), false)
    // Another lock in the same process (another nonce) is not mistaken for this one.
    const sibling = make(111)
    assert.equal(sibling.acquire(), true)
    assert.equal(a.acquire(), false)
    sibling.release()
    // An unreadable lock is stale only once it is old.
    writeFileSync(lockPath, '{not json', { mode: 0o600 })
    utimesSync(lockPath, new Date(clock.t), new Date(clock.t))
    assert.equal(a.acquire(), false)
    utimesSync(lockPath, new Date(clock.t - 60000), new Date(clock.t - 60000))
    assert.equal(a.acquire(), true)
    a.release()
    // A symlink in its place is never followed or written through: fresh, it
    // is someone else's; old, it is replaced by a regular lock file.
    const victim = path.join(dir, 'victim.txt')
    writeFileSync(victim, 'keep me')
    symlinkSync(victim, lockPath)
    clock.t = lstatSync(lockPath).mtimeMs
    assert.equal(a.acquire(), false)
    clock.t += 60000
    assert.equal(a.acquire(), true)
    assert.equal(lstatSync(lockPath).isSymbolicLink(), false)
    assert.equal(readFileSync(victim, 'utf8'), 'keep me')
    a.release()
    assert.throws(() => createDeviceLock({}), TypeError)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the lease takes the device lock with its first action, refuses when another holds it and lets go after the hold', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'egdesk-host-lease-'))
  try {
    const lockPath = path.join(dir, 'host-input.lock')
    const one = harness({ lockPath })
    const two = harness({ lockPath })
    assert.equal(one.lease.status().device, 'idle')
    const token = one.lease.begin('click', { target: TEXTEDIT })
    assert.equal(one.lease.status().device, 'held')
    blocked(() => two.lease.begin('click', { target: TEXTEDIT }), C.DEVICE_BUSY)
    assert.equal(two.lease.status().state, 'ready', 'a busy device does not change who holds this desktop')
    one.lease.checkpoint(token)
    one.lease.end(token)
    one.advance(15000)
    assert.equal(one.lease.status().device, 'idle')
    const other = two.lease.begin('click', { target: TEXTEDIT })
    assert.equal(two.lease.status().device, 'held')
    // Losing the lock mid-action stops the next event.
    rmSync(lockPath)
    blocked(() => two.lease.checkpoint(other), C.DEVICE_BUSY)
    assert.equal(two.lease.status().state, 'ready')
    // An injected lock that throws is a busy device.
    const broken = harness({ lock: { acquire() { throw new Error('io') }, heartbeat: () => true, release() {} } })
    blocked(() => broken.lease.begin('click', { target: TEXTEDIT }), C.DEVICE_BUSY)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('options are checked and status carries only the fixed fields', () => {
  assert.throws(() => createHostLease({ policy: 'lenient' }), TypeError)
  assert.throws(() => createHostLease({ holdSeconds: -1 }), TypeError)
  assert.throws(() => createHostLease({ userIdleSeconds: Number.NaN }), TypeError)
  const { lease } = harness()
  assert.deepEqual(Object.keys(lease.status()), ['state', 'epoch', 'waitMs', 'yielded', 'held', 'reasons', 'stoppedApps', 'activeCalls', 'holdMs', 'device', 'policy'])
  assert.equal(lease.status().device, 'off')
})
