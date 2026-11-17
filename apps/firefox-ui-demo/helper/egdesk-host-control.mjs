// CU-01/02/05 bridge wiring: the Mac host helper (egdesk-host-agent), this
// Mac's control lease (egdesk-host-lease), the fail-closed input gate
// (egdesk-host-input-gate) and the activity list (egdesk-host-activity) as
// one object the bridge holds, plus its HTTP routes:
//   GET  /host/activity?sinceAt=&limit=  → state() with timeline rows
//   POST /host/control {action, ...}     → pause | stop | stopApp | handBack | emergencyStop
// and SSE frames 'host.activity' { row } and 'host.control' { control }.
//
// Wiring:
// - The lease's guard is the gate: a closed gate makes the lease
//   'unavailable' (reason 'guard') and no Agent action begins or continues.
// - pulse() feeds the gate a heartbeat while the host helper is alive
//   (agent.guardAlive), and the lease's state. A dead or missing helper means
//   no heartbeat, so the gate closes within heartbeatTimeoutMs. This is the
//   stand-in watchdog until the helper's own watchdog child exists (CU-05 OS part).
// - Lease events go to the activity list, to onLeaseEvent (the bridge passes
//   chat.noteHostControl, so a stop or pause ends Codex computer runs) and,
//   as a fresh state, to the screen.
// - The host helper starts the first time the view asks (GET /host/activity),
//   not at bridge launch; it only observes (no OS input, no grant needed).
// Nothing here posts OS input. Rows and states carry names, ids, counts and
// epochs only: no screenshots, window titles, typed text, keys or coordinates.
import { performance } from 'node:perf_hooks'
import { createHostActivity, HOST_ACTIVITY_SSE_EVENT } from './egdesk-host-activity.mjs'
import { HOST_AGENT_INPUT_MONITOR } from './egdesk-host-agent.mjs'
import { EMERGENCY_STOP_CHORD, createHostInputGate } from './egdesk-host-input-gate.mjs'
import { createHostLease, hostLaneKey } from './egdesk-host-lease.mjs'
import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'

export const HOST_CONTROL_SSE_EVENT = 'host.control'
export const HOST_CONTROL_ACTIONS = Object.freeze(['pause', 'stop', 'stopApp', 'handBack', 'emergencyStop'])
// Who drives this Mac as far as EG-Desk can tell.
export const HOST_CONTROLLER_VIEWS = Object.freeze(['egdesk-agent', 'codex-computer-use', 'person', 'none'])
export const HOST_CONTROL_CODES = Object.freeze({
  INVALID_ACTION: 'HOST_CONTROL_INVALID_ACTION',
  STALE_EPOCH: 'HOST_CONTROL_STALE_EPOCH',
  INVALID_TARGET: 'HOST_CONTROL_INVALID_TARGET',
})
const issue = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus })

/**
 * createHostControl({ makeAgent, onLeaseEvent, emit, ... }) →
 * { lease, gate, activity, state, control, pulse, ensureAgent, onChatEvent, close }.
 * makeAgent(onEvent) returns a host agent (createHostAgent) or throws when no
 * helper can run here; it is called at most once, by ensureAgent().
 */
export function createHostControl({
  makeAgent = null,
  onLeaseEvent = () => {},
  emit = () => {},
  monotonic = () => performance.now(),
  now = Date.now,
  heartbeatTimeoutMs = 1500,
  pulseMs = 500,
  setRepeat = (fn, ms) => { const handle = setInterval(fn, ms); handle.unref?.(); return handle },
  clearRepeat = handle => clearInterval(handle),
  defer = fn => queueMicrotask(fn),
  activityLimit = 500,
} = {}) {
  let agent = null, agentCode = null, agentTried = false, repeat = null, closed = false
  let stateQueued = false
  const send = event => { try { emit(event) } catch {} }
  const activity = createHostActivity({ now, limit: activityLimit })
  const row = value => { if (value) send({ type: HOST_ACTIVITY_SSE_EVENT, row: value }) }
  // State frames are coalesced and sent after the current change settles, so
  // a lease reading the gate (or the reverse) never re-enters itself.
  const queueState = () => {
    if (stateQueued || closed) return
    stateQueued = true
    defer(() => { stateQueued = false; if (!closed) send({ type: HOST_CONTROL_SSE_EVENT, control: state({ rows: false }) }) })
  }
  const gate = createHostInputGate({
    now: monotonic,
    heartbeatTimeoutMs,
    onChange: status => { row(activity.noteControlEvent({ type: 'gate.state', status })); queueState() },
  })
  const lease = createHostLease({
    now: monotonic,
    guardAlive: () => gate.isOpen(),
    onEvent: event => {
      row(activity.noteControlEvent(event))
      if (event?.type !== 'command.receipt') { try { onLeaseEvent(event) } catch {} }
      if (event?.type === 'control.state') queueState()
    },
  })

  function agentView() {
    if (agent) {
      let status = null
      try { status = agent.status() } catch {}
      return {
        state: typeof status?.state === 'string' ? status.state : 'unknown',
        mode: 'observe',
        inputMonitor: status?.inputMonitor === true,
        alive: status?.alive === true,
        code: typeof status?.code === 'string' ? status.code : null,
        failures: Number.isSafeInteger(status?.failures) ? status.failures : 0,
      }
    }
    return { state: agentCode ? 'unavailable' : 'idle', mode: 'observe', inputMonitor: HOST_AGENT_INPUT_MONITOR, alive: false, code: agentCode, failures: 0 }
  }

  function pulse() {
    let alive = false
    try { alive = agent?.guardAlive() === true } catch {}
    gate.heartbeat({ alive })
    let status = null
    try { status = lease.status() } catch {}
    gate.noteLeaseStatus(status)
  }

  function ensureAgent() {
    if (agentTried || closed) return agentView()
    agentTried = true
    if (typeof makeAgent !== 'function') { agentCode = 'HOST_AGENT_UNAVAILABLE'; return agentView() }
    try {
      agent = makeAgent(event => {
        if (event?.type === 'host.event') row(activity.noteHostEvent(event))
        else if (event?.type === 'host.state') { pulse(); queueState() }
      })
      agent.attachLease(lease)
      Promise.resolve(agent.start()).catch(() => {}).finally(queueState)
    } catch (error) {
      agent = null
      agentCode = typeof error?.code === 'string' ? error.code : 'HOST_AGENT_UNAVAILABLE'
    }
    if (agent && !repeat) repeat = setRepeat(pulse, pulseMs)
    queueState()
    return agentView()
  }

  function controllerOf(leaseStatus, summary) {
    if (leaseStatus?.state === 'ai') return 'egdesk-agent'
    if (summary.controller === 'codex-computer-use') return 'codex-computer-use'
    if (leaseStatus?.state === 'user') return 'person'
    return 'none'
  }

  /** The view's whole state; rows: false leaves the timeline out (SSE frames). */
  function state({ rows = true, sinceAt = null, limit = 100 } = {}) {
    pulseIfIdle()
    const summary = activity.summary()
    let leaseStatus = null
    try { leaseStatus = lease.status() } catch {}
    const value = {
      agent: agentView(),
      lease: leaseStatus,
      gate: gate.status(),
      controller: controllerOf(leaseStatus, summary),
      target: summary.frontApp,
      codex: summary.codex,
      service: summary.service,
      chord: EMERGENCY_STOP_CHORD.label,
      at: now(),
    }
    if (rows) value.rows = activity.list({ sinceAt, limit })
    return value
  }
  // Without a running helper there is no timer: read the gate fresh anyway.
  function pulseIfIdle() { if (!repeat) pulse() }

  function epochOf(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null }

  /**
   * One control from the view. stop, emergencyStop and pause never need an
   * epoch (closing is always allowed). handBack needs the lease epoch the
   * screen showed, and reopening a closed gate needs the gate epoch it showed.
   */
  async function control(body = {}) {
    const action = body?.action
    if (!HOST_CONTROL_ACTIONS.includes(action)) throw issue(HOST_CONTROL_CODES.INVALID_ACTION, `action must be one of ${HOST_CONTROL_ACTIONS.join(', ')}`)
    if (action === 'pause') {
      const result = lease.takeOver()
      return { ok: true, action, notDispatched: result.notDispatched, control: state({ rows: false }) }
    }
    if (action === 'stop' || action === 'emergencyStop') {
      if (action === 'stop') gate.stop({ by: 'screen' })
      else gate.emergencyStop()
      const ack = await lease.stopAll()
      return { ok: true, action, ack: { scope: ack.scope, notDispatched: ack.notDispatched, inFlight: ack.inFlight, epoch: ack.epoch }, control: state({ rows: false }) }
    }
    const target = body.target && typeof body.target === 'object' && !Array.isArray(body.target) ? { bundleId: body.target.bundleId } : null
    if (action === 'stopApp') {
      if (!hostLaneKey(target)) throw issue(HOST_CONTROL_CODES.INVALID_TARGET, 'stopApp needs target.bundleId')
      const ack = await lease.stopApp(target)
      return { ok: true, action, ack: { scope: ack.scope, app: ack.app, notDispatched: ack.notDispatched, inFlight: ack.inFlight, epoch: ack.epoch }, control: state({ rows: false }) }
    }
    // handBack
    const leaseStatus = lease.status()
    if (epochOf(body.epoch) === null || body.epoch !== leaseStatus.epoch) {
      throw issue(HOST_CONTROL_CODES.STALE_EPOCH, 'The control state changed; look again before handing back', 409)
    }
    if (body.target !== undefined && body.target !== null) {
      if (!hostLaneKey(target)) throw issue(HOST_CONTROL_CODES.INVALID_TARGET, 'handBack target needs target.bundleId')
      const result = lease.handBack({ target })
      return { ok: result.ok, action, control: state({ rows: false }) }
    }
    const result = lease.handBack()
    let gateCode = null
    if (result.ok && !gate.isOpen()) {
      pulse()
      const opened = gate.open({ epoch: body.gateEpoch })
      gateCode = opened.code
    }
    pulse()
    return { ok: result.ok, action, code: result.code ?? null, gateCode, control: state({ rows: false }) }
  }

  // The chat runtime's protocol-2 events: a Codex run's computer-control count.
  function onChatEvent(event) {
    if (event?.type === 'chat.event' && event.event === 'computer.used') row(activity.noteComputerUse(event.details))
  }

  async function close() {
    closed = true
    if (repeat) { clearRepeat(repeat); repeat = null }
    gate.stop({ by: 'shutdown' })
    try { await lease.stopAll() } catch {}
    if (agent) { try { await agent.stop() } catch {} }
  }

  return { lease, gate, activity, state, control, pulse, ensureAgent, onChatEvent, close }
}

/** GET /host/activity and POST /host/control; false for any other path. */
export function createHostControlHttpHandler(hostControl, { port = 39218 } = {}) {
  return async (req, res, url) => {
    if (url.pathname !== '/host/activity' && url.pathname !== '/host/control') return false
    if (!guardBridgeRequest(req, port)) {
      sendJson(res, 403, { code: 'HOST_LOOPBACK_REQUIRED', error: 'Untrusted host control request origin' })
      return true
    }
    try {
      if (url.pathname === '/host/activity') {
        if (req.method !== 'GET') { sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'Use GET' }); return true }
        const sinceAt = Number(url.searchParams.get('sinceAt'))
        const limit = Number(url.searchParams.get('limit'))
        hostControl.ensureAgent()
        sendJson(res, 200, hostControl.state({
          sinceAt: url.searchParams.has('sinceAt') && Number.isFinite(sinceAt) ? sinceAt : null,
          limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100,
        }))
        return true
      }
      if (req.method !== 'POST') { sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'Use POST with {action}' }); return true }
      const body = await readJsonBody(req, { maxBytes: 1024 })
      sendJson(res, 200, await hostControl.control(body))
    } catch (error) {
      sendJson(res, error.httpStatus || 500, { code: typeof error.code === 'string' ? error.code : 'HOST_CONTROL_ERROR', error: String(error.message || 'Host control failed').slice(0, 500) })
    }
    return true
  }
}
