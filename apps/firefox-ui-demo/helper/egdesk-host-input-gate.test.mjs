import test from 'node:test'
import assert from 'node:assert/strict'
import { EMERGENCY_STOP_CHORD, HOST_GATE_CODES, HOST_GATE_REASONS, createHostInputGate, isEmergencyStopChord } from './egdesk-host-input-gate.mjs'
import { createHostLease } from './egdesk-host-lease.mjs'

// CU-05: the pure fail-closed gate. A fake clock; no timers, no OS input.
function rig(options = {}) {
  let t = 1000
  const changes = []
  const gate = createHostInputGate({ now: () => t, onChange: status => changes.push(status), ...options })
  const advance = ms => { t += ms }
  const openNow = () => {
    gate.heartbeat()
    gate.noteLeaseStatus({ state: 'ready' })
    const result = gate.open({ epoch: gate.status().epoch })
    assert.equal(result.ok, true, `open failed: ${result.code}`)
    return result.status.epoch
  }
  return { gate, advance, changes, openNow, set: value => { t = value } }
}

test('starts closed: no heartbeat and no open means no input', () => {
  const { gate } = rig()
  const status = gate.status()
  assert.equal(status.state, 'closed')
  assert.equal(status.reason, 'initial')
  assert.equal(gate.allows({ epoch: status.epoch }), false)
  assert.equal(gate.check({ epoch: 0 }).code, HOST_GATE_CODES.CLOSED)
  assert.equal(gate.isOpen(), false)
})

test('opening needs the current epoch, a fresh heartbeat and a known lease state', () => {
  const { gate, advance } = rig()
  let epoch = gate.status().epoch
  assert.equal(gate.open({ epoch }).code, HOST_GATE_CODES.NO_HEARTBEAT)
  gate.heartbeat()
  assert.equal(gate.open({ epoch }).code, HOST_GATE_CODES.UNKNOWN_STATE, 'no lease state seen yet')
  gate.noteLeaseStatus({ state: 'unavailable' })
  epoch = gate.status().epoch
  assert.equal(gate.open({}).code, HOST_GATE_CODES.STALE_EPOCH, 'no epoch is not an explicit reopen')
  assert.equal(gate.open({ epoch: epoch - 1 }).code, HOST_GATE_CODES.STALE_EPOCH)
  assert.equal(gate.open({ epoch: String(epoch) }).code, HOST_GATE_CODES.STALE_EPOCH)
  advance(1600)
  assert.equal(gate.open({ epoch }).code, HOST_GATE_CODES.NO_HEARTBEAT, 'a heartbeat older than 1.5 s is not fresh')
  gate.heartbeat()
  const opened = gate.open({ epoch })
  assert.equal(opened.ok, true)
  assert.equal(opened.status.epoch, epoch + 1, 'opening issues a new epoch')
  assert.equal(gate.allows({ epoch: epoch + 1 }), true)
  assert.equal(gate.allows({ epoch }), false, 'the epoch read before opening is not a ticket')
  assert.equal(gate.allows(epoch + 1), true, 'a bare epoch number works as a ticket too')
  assert.equal(gate.allows(null), false)
})

test('a missing or stale heartbeat closes the gate at the next check', () => {
  const { gate, advance, openNow } = rig()
  const ticket = { epoch: openNow() }
  advance(1500)
  assert.equal(gate.allows(ticket), true, 'exactly at the limit is still fresh')
  advance(1)
  const result = gate.check(ticket)
  assert.deepEqual([result.ok, result.code, result.reason], [false, HOST_GATE_CODES.CLOSED, 'heartbeat-stale'])
  assert.ok(gate.status().epoch > ticket.epoch)
  gate.heartbeat()
  assert.equal(gate.allows(ticket), false, 'a late heartbeat does not reopen by itself')
})

test('a lost watchdog closes at once; reopening still needs the explicit new epoch', () => {
  const { gate, openNow } = rig()
  const ticket = { epoch: openNow() }
  const status = gate.heartbeat({ alive: false })
  assert.equal(status.state, 'closed')
  assert.equal(status.reason, 'heartbeat-missing')
  gate.heartbeat()
  assert.equal(gate.allows(ticket), false)
  const reopened = gate.open({ epoch: status.epoch })
  assert.equal(reopened.ok, true)
  assert.equal(gate.allows(ticket), false, 'the old ticket never passes again')
  assert.equal(gate.allows({ epoch: reopened.status.epoch }), true)
})

test('a heartbeat seq that does not move forward closes the gate', () => {
  const { gate } = rig()
  gate.heartbeat({ seq: 1 })
  gate.heartbeat({ seq: 2 })
  gate.noteLeaseStatus({ state: 'ready' })
  const opened = gate.open({ epoch: gate.status().epoch })
  assert.equal(opened.ok, true)
  const status = gate.heartbeat({ seq: 2 })
  assert.equal(status.reason, 'heartbeat-replay')
  assert.equal(status.heartbeatAgeMs, null, 'the replayed beat is not counted as fresh')
  assert.equal(gate.heartbeat({ seq: 1.5 }).reason, 'heartbeat-replay')
  assert.equal(gate.open({ epoch: gate.status().epoch }).code, HOST_GATE_CODES.NO_HEARTBEAT)
})

test('an unknown lease state closes the gate; every known state keeps it', () => {
  const { gate, openNow } = rig()
  const ticket = { epoch: openNow() }
  for (const state of ['ready', 'user', 'ai', 'unavailable']) {
    gate.noteLeaseStatus({ state })
    gate.heartbeat()
    assert.equal(gate.allows(ticket), true, state)
  }
  for (const bad of [{ state: 'paused' }, {}, null, 'ready', { state: undefined }]) {
    const { gate: other, openNow: openOther } = rig()
    const own = { epoch: openOther() }
    const status = other.noteLeaseStatus(bad)
    assert.equal(status.reason, 'unknown-state', JSON.stringify(bad))
    assert.equal(other.allows(own), false)
    other.heartbeat()
    assert.equal(other.open({ epoch: other.status().epoch }).code, HOST_GATE_CODES.UNKNOWN_STATE, 'it stays shut until a known state is seen')
  }
})

test('a stop request and the emergency chord close it and void a reopen prepared before', () => {
  const { gate, openNow } = rig()
  openNow()
  const before = gate.status().epoch
  const stopped = gate.stop({ by: 'screen' })
  assert.deepEqual([stopped.state, stopped.reason, stopped.stoppedBy], ['closed', 'stop-request', 'screen'])
  const prepared = stopped.epoch
  const chord = gate.emergencyStop({ ctrlKey: true, altKey: true, shiftKey: true, code: 'Period', key: '>' })
  assert.equal(chord.stopped, true)
  assert.equal(chord.status.reason, 'emergency-stop')
  assert.equal(chord.status.stoppedBy, 'chord')
  assert.ok(chord.status.epoch > prepared && prepared > before)
  gate.heartbeat()
  assert.equal(gate.open({ epoch: prepared }).code, HOST_GATE_CODES.STALE_EPOCH, 'a stop while closed still raises the epoch')
  const reopened = gate.open({ epoch: chord.status.epoch })
  assert.equal(reopened.ok, true)
  assert.equal(reopened.status.stoppedBy, null)
})

test('a key that is not the chord does nothing', () => {
  const { gate, openNow } = rig()
  const ticket = { epoch: openNow() }
  const result = gate.emergencyStop({ ctrlKey: true, altKey: true, code: 'Period' })
  assert.equal(result.stopped, false)
  assert.equal(gate.allows(ticket), true)
})

test('isEmergencyStopChord matches Ctrl+Alt+Shift+. by physical key, never with Command', () => {
  assert.equal(EMERGENCY_STOP_CHORD.label, 'Ctrl+Alt+Shift+.')
  assert.equal(isEmergencyStopChord({ ctrlKey: true, altKey: true, shiftKey: true, code: 'Period', key: '≥' }), true)
  assert.equal(isEmergencyStopChord({ ctrl: true, alt: true, shift: true, key: '>' }), true, 'helper-style flags, no code')
  assert.equal(isEmergencyStopChord({ ctrlKey: true, altKey: true, shiftKey: true, key: '.' }), true)
  assert.equal(isEmergencyStopChord({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: true, code: 'Period' }), false)
  assert.equal(isEmergencyStopChord({ ctrlKey: true, altKey: true, shiftKey: true, code: 'Comma', key: '.' }), false, 'the code decides when present')
  assert.equal(isEmergencyStopChord({ ctrlKey: true, shiftKey: true, code: 'Period' }), false)
  assert.equal(isEmergencyStopChord({ ctrlKey: 1, altKey: true, shiftKey: true, code: 'Period' }), false)
  assert.equal(isEmergencyStopChord(null), false)
  assert.equal(isEmergencyStopChord('Ctrl+Alt+Shift+.'), false)
})

test('a clock that throws or goes non-finite reads as closed', () => {
  let broken = false
  let t = 0
  const gate = createHostInputGate({ now: () => { if (broken) throw new Error('clock'); return t } })
  gate.heartbeat()
  gate.noteLeaseStatus({ state: 'ready' })
  const ticket = { epoch: gate.open({ epoch: gate.status().epoch }).status.epoch }
  assert.equal(gate.allows(ticket), true)
  broken = true
  assert.equal(gate.allows(ticket), false)
  assert.equal(gate.isOpen(), false)
  broken = false
  t = NaN
  assert.equal(gate.heartbeat().reason, 'error')
})

test('a clock running backwards is not a fresh heartbeat', () => {
  const { gate, set, openNow } = rig()
  const ticket = { epoch: openNow() }
  set(500)
  assert.equal(gate.allows(ticket), false)
  assert.equal(gate.status().reason, 'heartbeat-stale')
})

test('onChange hears every open and close; reasons stay in the published list', () => {
  const { gate, changes, openNow } = rig()
  openNow()
  gate.stop()
  gate.emergencyStop()
  assert.deepEqual(changes.map(change => change.state), ['open', 'closed', 'closed'])
  for (const change of changes) if (change.reason) assert.ok(HOST_GATE_REASONS.includes(change.reason))
  assert.throws(() => createHostInputGate({ heartbeatTimeoutMs: 0 }), TypeError)
})

test('as the lease guard: a closed gate makes the lease unavailable and refuses begin', () => {
  const { gate, openNow, advance } = rig()
  const lease = createHostLease({ now: () => 0, requireMonitor: false, guardAlive: () => gate.isOpen() })
  assert.equal(lease.status().state, 'unavailable', 'closed from the start')
  assert.deepEqual(lease.status().reasons, ['guard'])
  openNow()
  assert.equal(lease.status().state, 'ready')
  const token = lease.begin('click', { target: { bundleId: 'com.apple.TextEdit' } })
  gate.heartbeat()
  assert.equal(typeof lease.checkpoint(token), 'string')
  advance(2000)
  assert.throws(() => lease.checkpoint(token), error => error.code === 'CONTROL_UNAVAILABLE')
  assert.equal(lease.status().state, 'unavailable')
})
