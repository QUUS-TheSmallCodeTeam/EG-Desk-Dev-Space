import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { HOST_CONTROL_ACTIONS, HOST_CONTROL_CODES, HOST_CONTROL_SSE_EVENT, createHostControl, createHostControlHttpHandler } from './egdesk-host-control.mjs'
import { HOST_ACTIVITY_SSE_EVENT } from './egdesk-host-activity.mjs'

// CU-01/02/05 bridge wiring with a fake host agent, fake clocks and no timers,
// sockets, processes or OS input.
function fakeAgent({ alive = true, startFails = false } = {}) {
  const agent = {
    alive, leases: [], started: 0, stopped: 0, onEvent: null,
    status: () => ({ state: agent.alive ? 'ready' : 'restarting', alive: agent.alive, inputMonitor: false, mode: 'observe', code: null, failures: 0, pid: 4242, stderrTail: 'private stderr' }),
    guardAlive: () => agent.alive,
    attachLease(lease) { agent.leases.push(lease); lease.setInputMonitor(false); return () => {} },
    start() { agent.started += 1; return startFails ? Promise.reject(new Error('no')) : Promise.resolve() },
    stop() { agent.stopped += 1; return Promise.resolve() },
  }
  return agent
}
function rig({ agent = fakeAgent(), makeAgent, monitor = false } = {}) {
  const clock = { mono: 1000, wall: 1_800_000_000_000 }
  const sent = [], leaseEvents = [], repeats = []
  const control = createHostControl({
    makeAgent: makeAgent ?? (onEvent => { agent.onEvent = onEvent; return agent }),
    onLeaseEvent: event => leaseEvents.push(event),
    emit: event => sent.push(event),
    monotonic: () => clock.mono,
    now: () => clock.wall,
    setRepeat: (fn, ms) => { repeats.push({ fn, ms }); return repeats.length },
    clearRepeat: () => {},
    defer: fn => fn(),
  })
  if (monitor) control.lease.setInputMonitor(true)
  return { control, agent, clock, sent, leaseEvents, repeats, advance: ms => { clock.mono += ms; clock.wall += ms } }
}
// Read the state, then hand back with the epochs it showed (the screen's flow).
async function handBack(control) {
  const shown = control.state({ rows: false })
  return control.control({ action: 'handBack', epoch: shown.lease.epoch, gateEpoch: shown.gate.epoch })
}

test('fail closed from the start: no helper yet, the gate is closed and the lease unavailable', () => {
  const { control } = rig()
  const state = control.state()
  assert.equal(state.gate.state, 'closed')
  assert.equal(state.lease.state, 'unavailable')
  assert.ok(state.lease.reasons.includes('guard'))
  assert.equal(state.agent.state, 'idle')
  assert.equal(state.controller, 'none')
  assert.equal(state.chord, 'Ctrl+Alt+Shift+.')
  assert.ok(state.rows.every(row => row.kind === 'control'), 'only control rows before any observation')
  assert.throws(() => control.lease.begin('click', { target: { bundleId: 'com.apple.TextEdit' } }), error => error.code === 'CONTROL_UNAVAILABLE')
})

test('the host helper starts once, on the first view request, and its heartbeat is the gate\'s watchdog', async () => {
  const { control, agent, repeats, advance } = rig({ monitor: true })
  const first = control.ensureAgent()
  control.ensureAgent()
  assert.equal(agent.started, 1)
  assert.equal(agent.leases.length, 1, 'the lease is attached to the helper')
  assert.equal(first.mode, 'observe')
  assert.equal(repeats.length, 1)
  assert.equal(repeats[0].ms, 500)
  // In this stage the helper has no input monitor: the lease stays unavailable even with the gate open.
  control.pulse()
  const result = await handBack(control)
  assert.equal(result.ok, true)
  assert.equal(result.gateCode, null, 'a live helper heartbeat lets the explicit reopen through')
  assert.equal(result.control.gate.state, 'open')
  assert.equal(result.control.lease.state, 'unavailable')
  assert.deepEqual(result.control.lease.reasons, ['monitor'])
  // The helper goes quiet: no heartbeat, the gate closes and stays closed.
  agent.alive = false
  repeats[0].fn()
  assert.equal(control.state({ rows: false }).gate.state, 'closed')
  assert.equal(control.state({ rows: false }).gate.reason, 'heartbeat-missing')
  agent.alive = true
  repeats[0].fn()
  advance(100)
  assert.equal(control.state({ rows: false }).gate.state, 'closed', 'a returning helper never reopens by itself')
  assert.ok(!JSON.stringify(control.state()).includes('private stderr'), 'helper stderr is not shown')
})

test('the gate closes when the heartbeat stops arriving, even without a timer tick', () => {
  const { control, advance } = rig()
  control.ensureAgent()
  control.pulse()
  const shown = control.state({ rows: false })
  return control.control({ action: 'handBack', epoch: shown.lease.epoch, gateEpoch: shown.gate.epoch }).then(result => {
    assert.equal(result.control.gate.state, 'open')
    advance(1600)
    assert.equal(control.gate.isOpen(), false)
    assert.equal(control.gate.status().reason, 'heartbeat-stale')
  })
})

test('a helper that cannot run here is reported by code and nothing opens', async () => {
  const { control } = rig({ makeAgent: () => { throw Object.assign(new Error('not built'), { code: 'HOST_AGENT_EXECUTABLE' }) } })
  const view = control.ensureAgent()
  assert.deepEqual([view.state, view.code], ['unavailable', 'HOST_AGENT_EXECUTABLE'])
  const result = await handBack(control)
  assert.equal(result.gateCode, 'INPUT_GATE_NO_HEARTBEAT')
  assert.equal(result.control.gate.state, 'closed')
})

test('a person-friendly flow with an input monitor: hand back opens, Agent may act; stop closes everything; old epochs are refused', async () => {
  const { control, leaseEvents } = rig({ monitor: true })
  // Simulate a helper with an input monitor by keeping the lease's monitor on after attach.
  control.ensureAgent()
  control.lease.setInputMonitor(true)
  control.pulse()
  const opened = await handBack(control)
  assert.equal(opened.control.lease.state, 'ready')
  const token = control.lease.begin('click', { target: { bundleId: 'com.apple.TextEdit' } })
  control.pulse()
  assert.equal(typeof control.lease.checkpoint(token), 'string')
  assert.equal(control.state({ rows: false }).controller, 'egdesk-agent')
  const stale = control.state({ rows: false })
  const stopped = await control.control({ action: 'stop' })
  assert.equal(stopped.ack.scope, 'all')
  assert.equal(stopped.control.gate.state, 'closed')
  assert.equal(stopped.control.gate.reason, 'stop-request')
  assert.equal(stopped.control.lease.state, 'unavailable')
  assert.throws(() => control.lease.checkpoint(token), error => ['STOPPED', 'CONTROL_UNAVAILABLE'].includes(error.code))
  assert.ok(leaseEvents.some(event => event.type === 'control.stopped' && event.scope === 'all'), 'the chat runtime hears the stop')
  await assert.rejects(control.control({ action: 'handBack', epoch: stale.lease.epoch, gateEpoch: stale.gate.epoch }), error => error.code === HOST_CONTROL_CODES.STALE_EPOCH && error.httpStatus === 409)
  const fresh = control.state({ rows: false })
  const wrongGate = await control.control({ action: 'handBack', epoch: fresh.lease.epoch, gateEpoch: stale.gate.epoch })
  assert.equal(wrongGate.gateCode, 'INPUT_GATE_STALE_EPOCH', 'reopening the gate needs the epoch shown after the stop')
  assert.equal(wrongGate.control.gate.state, 'closed')
  control.pulse()
  const again = await handBack(control)
  assert.equal(again.control.gate.state, 'open')
  assert.equal(again.control.lease.state, 'ready')
})

test('pause yields to the person and tells the chat runtime; emergency stop closes the gate by chord', async () => {
  const { control, leaseEvents } = rig({ monitor: true })
  control.ensureAgent()
  control.lease.setInputMonitor(true)
  control.pulse()
  await handBack(control)
  const paused = await control.control({ action: 'pause' })
  assert.equal(paused.control.lease.state, 'user')
  assert.equal(paused.control.lease.yielded, true)
  assert.equal(paused.control.controller, 'person')
  assert.ok(leaseEvents.some(event => event.type === 'control.yielded' && event.reason === 'user-request'))
  const emergency = await control.control({ action: 'emergencyStop' })
  assert.equal(emergency.control.gate.reason, 'emergency-stop')
  assert.equal(emergency.control.gate.stoppedBy, 'chord')
})

test('stopApp needs a target and stops that app only; unknown actions are refused', async () => {
  const { control } = rig({ monitor: true })
  const ack = await control.control({ action: 'stopApp', target: { bundleId: 'com.apple.TextEdit', title: 'secret' } })
  assert.deepEqual([ack.ack.scope, ack.ack.app], ['app', 'com.apple.textedit'])
  assert.deepEqual(ack.control.lease.stoppedApps, ['com.apple.textedit'])
  await assert.rejects(control.control({ action: 'stopApp' }), error => error.code === HOST_CONTROL_CODES.INVALID_TARGET)
  await assert.rejects(control.control({ action: 'click' }), error => error.code === HOST_CONTROL_CODES.INVALID_ACTION)
  await assert.rejects(control.control(null), error => error.code === HOST_CONTROL_CODES.INVALID_ACTION)
  assert.deepEqual(HOST_CONTROL_ACTIONS, ['pause', 'stop', 'stopApp', 'handBack', 'emergencyStop'])
  const shown = control.state({ rows: false })
  const resumed = await control.control({ action: 'handBack', epoch: shown.lease.epoch, target: { bundleId: 'com.apple.TextEdit' } })
  assert.equal(resumed.ok, true)
  assert.deepEqual(resumed.control.lease.stoppedApps, [])
})

test('host events, lease events and Codex computer use reach the timeline and SSE, metadata only', async () => {
  const { control, agent, sent } = rig()
  control.ensureAgent()
  agent.onEvent({ type: 'host.event', event: 'app.activated', app: { bundleId: 'com.apple.Safari', pid: 7, name: 'Safari', title: 'Bank – secret' }, at: 1_800_000_000_000 })
  control.onChatEvent({ type: 'chat.event', event: 'computer.used', details: { runId: 'run-1', calls: 1, lastAt: 1_800_000_000_000, active: true } })
  control.onChatEvent({ type: 'chat.event', event: 'message.delta', details: { text: 'typed secret' } })
  await control.control({ action: 'stop' })
  const state = control.state()
  assert.equal(state.target.bundleId, 'com.apple.Safari')
  assert.equal(state.codex.active, true)
  assert.equal(state.controller, 'codex-computer-use', 'the lease is not held by an EG-Desk Agent, Codex is driving')
  const kinds = state.rows.map(row => row.kind)
  for (const kind of ['front-app', 'codex-computer', 'control']) assert.ok(kinds.includes(kind), kind)
  const rowFrames = sent.filter(event => event.type === HOST_ACTIVITY_SSE_EVENT)
  const stateFrames = sent.filter(event => event.type === HOST_CONTROL_SSE_EVENT)
  assert.ok(rowFrames.length >= 3)
  assert.ok(stateFrames.length >= 1)
  assert.equal(stateFrames.at(-1).control.rows, undefined, 'state frames do not repeat the timeline')
  const text = JSON.stringify([state, sent])
  for (const secret of ['Bank', 'typed secret', 'private stderr']) assert.ok(!text.includes(secret), secret)
})

test('close stops the helper and closes the gate', async () => {
  const { control, agent } = rig()
  control.ensureAgent()
  await control.close()
  assert.equal(agent.stopped, 1)
  assert.equal(control.gate.status().stoppedBy, 'shutdown')
})

function fakeRequest(method, url, body, headers = {}) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
function fakeResponse() {
  const res = { status: null, body: null, headers: null }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = text => { res.body = text ? JSON.parse(text) : null }
  return res
}
async function call(handler, method, url, body, headers) {
  const res = fakeResponse()
  const handled = await handler(fakeRequest(method, url, body, headers), res, new URL(url, 'http://127.0.0.1:39218'))
  return { handled, status: res.status, data: res.body }
}

test('HTTP: guarded GET /host/activity and POST /host/control', async () => {
  const { control, agent } = rig({ monitor: true })
  const handler = createHostControlHttpHandler(control, { port: 39218 })
  assert.equal((await call(handler, 'GET', '/chat/history')).handled, false)
  const got = await call(handler, 'GET', '/host/activity?limit=5')
  assert.equal(got.status, 200)
  assert.equal(agent.started, 1, 'the first view request starts the observer')
  assert.ok(Array.isArray(got.data.rows))
  assert.equal(got.data.gate.state, 'closed')
  const foreign = await call(handler, 'GET', '/host/activity', undefined, { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  const crossSite = await call(handler, 'POST', '/host/control', { action: 'stop' }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSite.status, 403)
  assert.equal((await call(handler, 'POST', '/host/activity', {})).status, 405)
  assert.equal((await call(handler, 'GET', '/host/control')).status, 405)
  const bad = await call(handler, 'POST', '/host/control', { action: 'teleport' })
  assert.deepEqual([bad.status, bad.data.code], [400, HOST_CONTROL_CODES.INVALID_ACTION])
  const big = await call(handler, 'POST', '/host/control', { action: 'stop', pad: 'x'.repeat(2000) })
  assert.equal(big.status, 413)
  const stop = await call(handler, 'POST', '/host/control', { action: 'stop' }, { origin: 'chrome://userchrome' })
  assert.equal(stop.status, 200)
  assert.equal(stop.data.control.gate.reason, 'stop-request')
  const stale = await call(handler, 'POST', '/host/control', { action: 'handBack', epoch: 0 })
  assert.deepEqual([stale.status, stale.data.code], [409, HOST_CONTROL_CODES.STALE_EPOCH])
})
