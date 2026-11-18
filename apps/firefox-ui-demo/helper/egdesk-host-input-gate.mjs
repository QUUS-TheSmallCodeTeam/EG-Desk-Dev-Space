// CU-05: the fail-closed input gate behind the emergency stop key
// (Ctrl+Alt+Shift+., owner decision D-C6) and the watchdog
// (docs/references/rea-mechanism-adoption.md 맥11). Pure state machine: no
// timers, no OS hooks, no input. Whoever would send Agent input asks
// allows(ticket) right before each event; the bridge feeds it watchdog
// heartbeats, the lease's state, stop requests and the stop chord.
//
// Rules (fail closed):
// - It starts closed. Only open() with the gate's current epoch, a fresh
//   heartbeat and a known lease state opens it, and opening issues a new
//   epoch: a ticket from before any close never passes again.
// - A missing or stale heartbeat (older than heartbeatTimeoutMs, default
//   1.5 s like open-computer-use GuardianMain), a heartbeat whose seq does
//   not move forward, an unknown lease state, a stop request or the stop
//   chord closes it and raises the epoch.
// - Any throw while checking reads as closed.
// The real global hotkey (session event tap) and watchdog child process need
// macOS Input Monitoring; they are not built here (CU-05 OS part).
//
// Patterns only, no code: open-computer-use (MIT) DisplayGuardian.swift
// (--watchdog child) and GuardianMain.swift (1.5 s heartbeat).
import { performance } from 'node:perf_hooks'

export const HOST_GATE_STATES = Object.freeze(['closed', 'open'])
export const HOST_GATE_REASONS = Object.freeze([
  'initial', // never opened
  'heartbeat-missing', // no watchdog heartbeat yet, or the watchdog went away
  'heartbeat-stale', // the last heartbeat is older than heartbeatTimeoutMs
  'heartbeat-replay', // a heartbeat seq did not move forward
  'unknown-state', // the lease reported a state this gate does not know
  'stop-request', // [중지] or stopAll from the screen or the bridge
  'emergency-stop', // Ctrl+Alt+Shift+.
  'error', // a check threw
])
export const HOST_GATE_CODES = Object.freeze({
  CLOSED: 'INPUT_GATE_CLOSED',
  STALE_EPOCH: 'INPUT_GATE_STALE_EPOCH',
  NO_HEARTBEAT: 'INPUT_GATE_NO_HEARTBEAT',
  UNKNOWN_STATE: 'INPUT_GATE_UNKNOWN_STATE',
})
// The lease states the gate accepts as known (egdesk-host-lease HOST_LEASE_STATES).
const KNOWN_LEASE_STATES = new Set(['ready', 'user', 'ai', 'unavailable'])
export const EMERGENCY_STOP_CHORD = Object.freeze({ ctrl: true, alt: true, shift: true, meta: false, code: 'Period', label: 'Ctrl+Alt+Shift+.' })

/**
 * Whether a key event is the emergency stop chord. Shift turns '.' into '>'
 * on US layouts and Alt can change the character on macOS, so the physical
 * key (code 'Period') decides; key '.' or '>' is accepted when code is absent.
 * Command (meta) must be up so ⌘ shortcuts never stop by accident.
 */
export function isEmergencyStopChord(event) {
  if (!event || typeof event !== 'object') return false
  const flag = name => event[`${name}Key`] === true || event[name] === true
  if (!flag('ctrl') || !flag('alt') || !flag('shift') || flag('meta')) return false
  if (typeof event.code === 'string' && event.code) return event.code === 'Period'
  return event.key === '.' || event.key === '>'
}

/**
 * createHostInputGate({ now, heartbeatTimeoutMs }) →
 * { heartbeat, noteLeaseStatus, stop, emergencyStop, open, allows, check, status }.
 * now is a monotonic clock in ms. Every call that changes the gate returns
 * status(); onChange receives it too.
 */
export function createHostInputGate({ now = () => performance.now(), heartbeatTimeoutMs = 1500, onChange = () => {} } = {}) {
  if (!Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) throw new TypeError('heartbeatTimeoutMs must be > 0')
  let state = 'closed', reason = 'initial', epoch = 0
  let lastBeatAt = null, lastSeq = null, leaseState = null
  let closedAt = null, stoppedBy = null

  const clock = () => { try { const t = now(); return Number.isFinite(t) ? t : NaN } catch { return NaN } }
  const snapshot = (t = clock()) => ({
    state,
    open: state === 'open',
    epoch,
    reason: state === 'open' ? null : reason,
    heartbeatAgeMs: lastBeatAt === null || !Number.isFinite(t) ? null : Math.max(0, Math.round(t - lastBeatAt)),
    heartbeatTimeoutMs,
    leaseState,
    closedAt,
    stoppedBy,
    chord: EMERGENCY_STOP_CHORD.label,
  })
  const notify = () => { try { onChange(snapshot()) } catch {} }

  // Closing always raises the epoch, even when already closed: a stop that
  // lands while closed still voids an open() prepared against the old epoch.
  function close(why, by = null) {
    state = 'closed'
    reason = why
    epoch += 1
    closedAt = clock()
    if (by) stoppedBy = by
    notify()
    return snapshot()
  }

  function beatFresh(t) {
    return lastBeatAt !== null && Number.isFinite(t) && t - lastBeatAt >= 0 && t - lastBeatAt <= heartbeatTimeoutMs
  }

  // Re-check time and heartbeat; closes when the watchdog went quiet.
  function refresh(t = clock()) {
    if (state !== 'open') return false
    if (lastBeatAt === null) { close('heartbeat-missing'); return true }
    if (!beatFresh(t)) { close('heartbeat-stale'); return true }
    return false
  }

  /** A watchdog heartbeat. seq, when given, must grow; alive false is a lost watchdog. */
  function heartbeat({ seq = null, alive = true } = {}) {
    if (alive !== true) {
      lastBeatAt = null
      if (state === 'open') return close('heartbeat-missing')
      return snapshot()
    }
    if (seq !== null) {
      if (!Number.isSafeInteger(seq) || (lastSeq !== null && seq <= lastSeq)) {
        lastBeatAt = null
        return close('heartbeat-replay')
      }
      lastSeq = seq
    }
    const t = clock()
    if (!Number.isFinite(t)) {
      lastBeatAt = null
      return close('error')
    }
    // A late heartbeat is fresh for a future open, not for the old ticket.
    refresh(t)
    lastBeatAt = t
    return snapshot(t)
  }

  /** The lease's status(); a state outside ready/user/ai/unavailable closes the gate. */
  function noteLeaseStatus(status) {
    const next = status && typeof status === 'object' ? status.state : undefined
    if (!KNOWN_LEASE_STATES.has(next)) {
      leaseState = null
      return close('unknown-state')
    }
    leaseState = next
    return snapshot()
  }

  function stop({ by = 'screen' } = {}) { return close('stop-request', typeof by === 'string' ? by.slice(0, 32) : 'screen') }

  /** The chord, already matched or as a key event (isEmergencyStopChord). */
  function emergencyStop(event = null) {
    if (event !== null && !isEmergencyStopChord(event)) return { stopped: false, status: snapshot() }
    return { stopped: true, status: close('emergency-stop', 'chord') }
  }

  /**
   * Reopen: needs the epoch the caller last read (so a request from before a
   * stop is refused), a fresh heartbeat and a known lease state. Opening
   * raises the epoch; tickets are { epoch } from this result.
   */
  function open({ epoch: asked } = {}) {
    const t = clock()
    refresh(t)
    if (!Number.isSafeInteger(asked) || asked !== epoch) return { ok: false, code: HOST_GATE_CODES.STALE_EPOCH, status: snapshot(t) }
    if (!beatFresh(t)) return { ok: false, code: HOST_GATE_CODES.NO_HEARTBEAT, status: snapshot(t) }
    if (!KNOWN_LEASE_STATES.has(leaseState)) return { ok: false, code: HOST_GATE_CODES.UNKNOWN_STATE, status: snapshot(t) }
    state = 'open'
    reason = null
    stoppedBy = null
    epoch += 1
    notify()
    return { ok: true, code: null, status: snapshot(t) }
  }

  /** { ok, code } for one input event carrying ticket { epoch }. */
  function check(ticket = null) {
    try {
      refresh()
      if (state !== 'open') return { ok: false, code: HOST_GATE_CODES.CLOSED, reason }
      const asked = ticket && typeof ticket === 'object' ? ticket.epoch : ticket
      if (!Number.isSafeInteger(asked) || asked !== epoch) return { ok: false, code: HOST_GATE_CODES.STALE_EPOCH, reason: null }
      return { ok: true, code: null, reason: null }
    } catch {
      try { close('error') } catch {}
      return { ok: false, code: HOST_GATE_CODES.CLOSED, reason: 'error' }
    }
  }
  const allows = ticket => check(ticket).ok === true

  /** For createHostLease({ guardAlive }): open now, with no ticket needed. */
  function isOpen() {
    try { refresh(); return state === 'open' } catch { return false }
  }

  function status() {
    try { refresh() } catch {}
    return snapshot()
  }

  return { heartbeat, noteLeaseStatus, stop, emergencyStop, open, check, allows, isOpen, status }
}
