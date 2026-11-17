// What happened on this Mac around Codex computer use, on one clock
// (docs/references/rea-mechanism-adoption.md 4장 맥10; owner decision
// computer-use-options.md Q1 (다): keep Codex computer control on and show it).
//
// Three kinds of rows, all stamped in Date.now milliseconds — the clock
// codex-chat-runtime stamps computer.used lastAt with:
// - 'front-app'      the front app changed (host helper app.activated)
// - 'service'        com.openai.sky.CUAService started or stopped (service.changed)
// - 'codex-computer' a Codex run's computer-control count changed (SSE computer.used)
// A front-app row taken while a Codex run is controlling the computer says
// duringCodex: true, and returnedAfterMs when the front app came back to the
// app that was in front just before (A→B→A within bounceWindowMs) — the
// pattern OpenAI's focus restore leaves. Only app names, bundle ids and pids
// are kept: no window titles, typed text, keys, coordinates or call content.
//
// Bridge wiring: egdesk-host-control.mjs (host helper events, lease and gate
// events, chat computer.used; GET /host/activity, SSE 'host.activity').
// CU-01/02 also keep who holds the input, from the lease and the input gate:
// - 'control'        the lease changed hands, yielded, stopped, or the gate closed/opened
// - 'command'        an EG-Desk Agent action's receipt (phase, app, code, step count)
// Sizes and metadata only, like the rows above: never arguments, text or keys.
export const HOST_ACTIVITY_KINDS = Object.freeze(['front-app', 'service', 'codex-computer', 'control', 'command'])
const LEASE_STATES = new Set(['ready', 'user', 'ai', 'unavailable'])
const RECEIPT_PHASES = new Set(['enqueued', 'dispatched', 'not-dispatched', 'finished', 'preempted', 'unknown', 'cleanup'])
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const LANE = /^[^\0]{1,256}$/
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null)
export const HOST_ACTIVITY_SSE_EVENT = 'host.activity'
export const CODEX_COMPUTER_SERVICE = 'com.openai.sky.CUAService'
// summary().controller: who is driving the computer as far as EG-Desk can see.
export const HOST_CONTROLLERS = Object.freeze(['codex-computer-use', 'none'])
const MAX_RUNS = 64
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,255}$/
const RUN_ID = /^[\w.:-]{1,128}$/

const appOf = value => {
  if (!value || typeof value !== 'object') return null
  const bundleId = typeof value.bundleId === 'string' && BUNDLE_ID.test(value.bundleId) ? value.bundleId : null
  const pid = Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null
  const name = typeof value.name === 'string' && value.name ? value.name.slice(0, 128) : null
  return bundleId || pid || name ? { bundleId, name, pid } : null
}
const sameApp = (a, b) => Boolean(a && b && (a.pid && b.pid ? a.pid === b.pid : a.bundleId && a.bundleId === b.bundleId))

/**
 * createHostActivity({ now, limit, bounceWindowMs }) →
 * { noteHostEvent, noteComputerUse, noteControlEvent, list, summary, clear }.
 * noteHostEvent / noteComputerUse / noteControlEvent return the new row, or null when the input
 * is not something this list records.
 */
export function createHostActivity({ now = Date.now, limit = 500, bounceWindowMs = 3000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('limit must be 1..10000')
  if (!Number.isFinite(bounceWindowMs) || bounceWindowMs < 0) throw new TypeError('bounceWindowMs must be >= 0')
  let rows = [], seq = 0
  let front = null, previousFront = null, frontAt = null
  let service = { running: null, at: null }
  const activeRuns = new Map() // runId → { calls, lastAt }
  const runs = new Map()

  const stampOf = value => (Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), now()) : now())
  // Rows stay ordered by (at, seq); a host event mapped a little earlier than
  // a row already stored goes in its place.
  function insert(row) {
    let index = rows.length
    while (index > 0 && rows[index - 1].at > row.at) index -= 1
    rows.splice(index, 0, row)
    if (rows.length > limit) rows = rows.slice(rows.length - limit)
    return row
  }

  function noteFrontApp(app, at) {
    const row = { seq: ++seq, at, kind: 'front-app', app, previous: front, duringCodex: activeRuns.size > 0 }
    if (previousFront && front && frontAt !== null && sameApp(app, previousFront) && !sameApp(app, front) && at - frontAt <= bounceWindowMs) {
      row.returnedAfterMs = Math.max(0, at - frontAt)
    }
    previousFront = front
    front = app
    frontAt = at
    return insert(row)
  }

  function noteHostEvent(event) {
    if (!event || typeof event !== 'object' || event.type !== 'host.event') return null
    const at = stampOf(event.at)
    if (event.event === 'app.activated') {
      const app = appOf(event.app)
      if (!app || sameApp(app, front)) return null
      return noteFrontApp(app, at)
    }
    if (event.event === 'service.changed') {
      const value = event.service
      if (!value || typeof value !== 'object' || (value.bundleId != null && value.bundleId !== CODEX_COMPUTER_SERVICE)) return null
      const running = value.running === true
      if (service.running === running) return null
      service = { running, at }
      const pidCount = Array.isArray(value.pids) ? Math.min(value.pids.length, 16) : 0
      return insert({ seq: ++seq, at, kind: 'service', bundleId: CODEX_COMPUTER_SERVICE, running, pidCount })
    }
    return null
  }

  // SSE computer.used details { runId, calls, lastAt, active }.
  function noteComputerUse(details) {
    if (!details || typeof details !== 'object' || typeof details.runId !== 'string' || !RUN_ID.test(details.runId)) return null
    const calls = Number.isSafeInteger(details.calls) && details.calls >= 0 ? details.calls : 0
    const active = details.active === true
    const lastAt = Number.isFinite(details.lastAt) ? details.lastAt : null
    const before = runs.get(details.runId)
    if (before && before.calls === calls && before.active === active) return null
    // A call that ended without a new lastAt (the runtime keeps the old one
    // when the real end is unknown) is placed at the time we learned it.
    const at = before && before.lastAt === lastAt ? now() : stampOf(lastAt)
    runs.set(details.runId, { calls, active, lastAt })
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value)
    if (active) activeRuns.set(details.runId, { calls, lastAt: at })
    else activeRuns.delete(details.runId)
    return insert({ seq: ++seq, at, kind: 'codex-computer', runId: details.runId, calls, active })
  }

  /**
   * The lease's onEvent (egdesk-host-lease) and the input gate's onChange
   * (egdesk-host-input-gate, as { type: 'gate.state', status }). A lease
   * control.state row is kept only when the state itself changed.
   */
  let leaseState = null, gateState = null
  function noteControlEvent(event) {
    if (!event || typeof event !== 'object') return null
    const at = now()
    if (event.type === 'control.state') {
      const status = event.status
      if (!status || !LEASE_STATES.has(status.state) || status.state === leaseState) return null
      const previous = leaseState
      leaseState = status.state
      return insert({ seq: ++seq, at, kind: 'control', event: 'state', state: status.state, from: previous, epoch: count(status.epoch), yielded: status.yielded === true, reasons: Array.isArray(status.reasons) ? status.reasons.filter(reason => typeof reason === 'string').slice(0, 4) : [] })
    }
    if (event.type === 'control.yielded') {
      return insert({ seq: ++seq, at, kind: 'control', event: 'yielded', reason: event.reason === 'user-request' ? 'user-request' : 'human-input', epoch: count(event.epoch) })
    }
    if (event.type === 'control.stopped') {
      const app = typeof event.app === 'string' && LANE.test(event.app) ? event.app : null
      return insert({ seq: ++seq, at, kind: 'control', event: 'stopped', scope: event.scope === 'app' ? 'app' : 'all', app, notDispatched: count(event.notDispatched) ?? 0, inFlight: count(event.inFlight) ?? 0, epoch: count(event.epoch) })
    }
    if (event.type === 'gate.state') {
      const status = event.status
      if (!status || !['open', 'closed'].includes(status.state)) return null
      const key = `${status.state}:${status.epoch}`
      if (key === gateState) return null
      gateState = key
      return insert({ seq: ++seq, at, kind: 'control', event: 'gate', state: status.state, reason: typeof status.reason === 'string' ? status.reason.slice(0, 32) : null, epoch: count(status.epoch) })
    }
    if (event.type === 'command.receipt') {
      if (!RECEIPT_PHASES.has(event.phase) || event.phase === 'enqueued') return null
      const app = typeof event.app === 'string' && LANE.test(event.app) ? event.app : null
      const row = { seq: ++seq, at, kind: 'command', phase: event.phase, commandId: typeof event.commandId === 'string' ? event.commandId.slice(0, 128) : null, app }
      if (typeof event.code === 'string' && CODE.test(event.code)) row.code = event.code
      if (count(event.steps) !== null) row.steps = event.steps
      return insert(row)
    }
    return null
  }

  function list({ sinceAt = null, limit: count = 100 } = {}) {
    const n = Number.isSafeInteger(count) && count > 0 ? Math.min(count, limit) : 100
    const from = Number.isFinite(sinceAt) ? rows.filter(row => row.at > sinceAt) : rows
    const copyOf = value => (value && typeof value === 'object' ? (Array.isArray(value) ? [...value] : { ...value }) : value)
    return from.slice(-n).map(row => ({ ...row, app: copyOf(row.app), previous: copyOf(row.previous), ...(row.reasons ? { reasons: [...row.reasons] } : {}) }))
  }

  function summary() {
    const latest = [...activeRuns.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt)[0] ?? null
    return {
      controller: activeRuns.size > 0 ? 'codex-computer-use' : 'none',
      frontApp: front ? { ...front, since: frontAt } : null,
      service: { bundleId: CODEX_COMPUTER_SERVICE, running: service.running, since: service.at },
      codex: latest ? { active: true, runId: latest[0], calls: latest[1].calls, lastAt: latest[1].lastAt } : { active: false, runId: null, calls: 0, lastAt: null },
    }
  }

  function clear() {
    rows = []
    front = previousFront = frontAt = null
    service = { running: null, at: null }
    activeRuns.clear()
    runs.clear()
    leaseState = gateState = null
  }

  return { noteHostEvent, noteComputerUse, noteControlEvent, list, summary, clear }
}
