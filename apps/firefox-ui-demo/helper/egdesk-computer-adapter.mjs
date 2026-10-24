// The action result contract follows trycua/cua libs/cua-driver
// docs/action-result-contract.md (MIT License, Copyright (c) 2025 Cua AI, Inc.):
// effect / route / delivery / evidence / summary, the invariants, hint and a
// read-only next_call. Patterns only, no code: delivery ceilings from trycua
// cua-spacesd docs/architecture.md (FSL), background-only new sessions from
// openclaw/Peekaboo docs/security.md, metadata-only call records from
// tmustier/codex-computer-use-mcp src/audit.ts.
import { performance } from 'node:perf_hooks'
import { publicText } from './codex-chat-values.mjs'
import { HOST_LEASE_CODES, HostLeaseBlocked, hostLaneKey } from './egdesk-host-lease.mjs'

// CU-03: one EG-Desk tool surface for driving Mac apps, whatever does the work
// underneath (cua-driver, Codex Computer Use, EG-Desk's own Host Agent). A
// provider implements the methods below; this adapter validates arguments,
// takes the host lease (egdesk-host-lease.mjs) for every action, checks the
// delivery ceiling and the frame revision right before sending, and returns a
// closed result. It never retries.
export const COMPUTER_METHODS = Object.freeze(['capture', 'listApps', 'listWindows', 'click', 'typeText', 'key', 'scroll', 'drag'])
export const COMPUTER_READ_METHODS = Object.freeze(['capture', 'listApps', 'listWindows'])
export const COMPUTER_ACTION_METHODS = Object.freeze(['click', 'typeText', 'key', 'scroll', 'drag'])
export const ACTION_EFFECTS = Object.freeze(['confirmed', 'partial', 'unverifiable', 'suspected_noop', 'refused'])
export const ACTION_ROUTES = Object.freeze(['accessibility', 'synthetic_events', 'global_input'])
export const DELIVERY_MODES = Object.freeze(['background', 'foreground', 'not_applicable', 'unknown'])
export const EVIDENCE_KINDS = Object.freeze(['value_readback', 'window_change'])
// view-only: no action; background: only actions the provider can deliver
// without bringing the app forward (the default); allow-activation: both.
export const DELIVERY_CEILINGS = Object.freeze(['view-only', 'background', 'allow-activation'])
export const ACTION_GUARANTEES = Object.freeze(['background', 'may-activate', 'unsupported'])
export const COMPUTER_ADAPTER_CODES = Object.freeze({
  UNKNOWN_METHOD: 'unknown_method',
  UNSUPPORTED_METHOD: 'unsupported_method',
  INVALID_ARGUMENTS: 'invalid_arguments',
  NO_HOST_LEASE: 'no_host_lease',
  VIEW_ONLY: 'view_only',
  WOULD_REQUIRE_ACTIVATION: 'would_require_activation',
  UNSUPPORTED_ACTION: 'unsupported_action',
  STALE_FRAME: 'stale_frame',
  COORDINATES_UNSUPPORTED: 'coordinates_unsupported',
  PROVIDER_REFUSED: 'provider_refused',
  HOST_ACTION_FAILED: 'HOST_ACTION_FAILED',
  HOST_ACTION_OUTCOME_UNKNOWN: 'HOST_ACTION_OUTCOME_UNKNOWN',
})
const CODES = COMPUTER_ADAPTER_CODES
const DEFAULT_DEADLINE_MS = 15_000
const APP_MAX = 256
const ELEMENT_MAX = 128
const TEXT_MAX = 4000
const COORD_MAX = 100_000
const SUMMARY_MAX = 500
const HINT_MAX = 240
const DETAIL_MAX = 200
const LIST_MAX = 200

// Agent-facing next steps (the model reads them; the screen words its own).
const HINTS = Object.freeze({
  [HOST_LEASE_CODES.USER_CONTROL]: 'The person is using the mouse or keyboard. Wait, then capture again before acting.',
  [HOST_LEASE_CODES.INPUT_HELD]: 'A key or mouse button is still held down. Wait until it is released, then capture again.',
  [HOST_LEASE_CODES.CONTROL_UNAVAILABLE]: 'Computer control is unavailable right now (no input monitor or watchdog). Do not act until it is ready.',
  [HOST_LEASE_CODES.DEVICE_BUSY]: 'Another program holds this computer\'s input. Do not act until it is released.',
  [HOST_LEASE_CODES.STOPPED]: 'The person stopped Agent input. Do not act again until they hand control back.',
  [HOST_LEASE_CODES.LEASE_REVOKED]: 'The control lease ended. Capture again before acting.',
  [HOST_LEASE_CODES.USER_INTERVENTION]: 'The person took over. Do not act again until they hand control back.',
  [HOST_LEASE_CODES.EXPIRED]: 'The action ran out of time before it was sent. Capture again before acting.',
  [CODES.NO_HOST_LEASE]: 'Computer actions are not enabled here.',
  [CODES.VIEW_ONLY]: 'This session can look but not act.',
  [CODES.WOULD_REQUIRE_ACTIVATION]: 'This action would bring the app forward, which this session does not allow. Try an element action instead.',
  [CODES.UNSUPPORTED_ACTION]: 'This app cannot take this action. Try another way.',
  [CODES.STALE_FRAME]: 'The window changed since that capture. Capture again and use the new frame number.',
  [CODES.COORDINATES_UNSUPPORTED]: 'This provider cannot check coordinates before sending. Use an element instead.',
  [CODES.HOST_ACTION_FAILED]: 'The action failed before anything was sent.',
  [CODES.HOST_ACTION_OUTCOME_UNKNOWN]: 'Part of the action may have been sent. Capture again and check before trying anything else.',
})

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonNegative = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
const count = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')

class ArgumentError extends Error {
  constructor(field) { super(field ? `invalid argument: ${field}` : 'unexpected argument'); this.field = field }
}
function only(value, keys) {
  if (!plainObject(value)) throw new ArgumentError(null)
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ArgumentError(null)
}
function targetOf(value, required = true) {
  if (value === undefined && !required) return undefined
  if (!plainObject(value)) throw new ArgumentError('target')
  only(value, ['app', 'windowId'])
  if (!text(value.app, APP_MAX) || !value.app.trim()) throw new ArgumentError('target.app')
  if (value.windowId !== undefined && !count(value.windowId, 0, Number.MAX_SAFE_INTEGER)) throw new ArgumentError('target.windowId')
  return value.windowId === undefined ? { app: value.app } : { app: value.app, windowId: value.windowId }
}
function pointOf(value, field) {
  if (!plainObject(value)) throw new ArgumentError(field)
  only(value, ['x', 'y'])
  if (!nonNegative(value.x, COORD_MAX) || !nonNegative(value.y, COORD_MAX)) throw new ArgumentError(field)
  return { x: value.x, y: value.y }
}
// An element (accessibility index or ref from the last state read) or a point
// in the pixels of capture frame `frame`. Not both.
function placeOf(args, { required }) {
  const hasElement = args.element !== undefined
  const hasPoint = args.x !== undefined || args.y !== undefined || args.frame !== undefined
  if (hasElement && hasPoint) throw new ArgumentError('element')
  if (hasElement) {
    if (!text(args.element, ELEMENT_MAX)) throw new ArgumentError('element')
    return { element: args.element }
  }
  if (hasPoint) {
    const point = pointOf({ x: args.x, y: args.y }, 'x')
    if (!count(args.frame, 0, Number.MAX_SAFE_INTEGER)) throw new ArgumentError('frame')
    return { ...point, frame: args.frame }
  }
  if (required) throw new ArgumentError('element')
  return {}
}

/**
 * Validates one call's arguments. Returns a clean copy with only the known
 * fields, or throws (caught by the adapter) naming the schema field that is
 * wrong, never the value. Unknown keys, native ids (pid, window handles) and
 * argument injection are refused.
 */
export function validateComputerArgs(method, args = {}) {
  const value = args === undefined ? {} : args
  switch (method) {
    case 'listApps':
      only(value, [])
      return {}
    case 'listWindows': {
      only(value, ['target'])
      const target = targetOf(value.target, false)
      return target ? { target } : {}
    }
    case 'capture':
      only(value, ['target', 'maxEdge'])
      if (value.maxEdge !== undefined && !count(value.maxEdge, 256, 4096)) throw new ArgumentError('maxEdge')
      return { target: targetOf(value.target), ...(value.maxEdge === undefined ? {} : { maxEdge: value.maxEdge }) }
    case 'click': {
      only(value, ['target', 'element', 'x', 'y', 'frame', 'button', 'count'])
      if (value.button !== undefined && !['left', 'right', 'middle'].includes(value.button)) throw new ArgumentError('button')
      if (value.count !== undefined && !count(value.count, 1, 3)) throw new ArgumentError('count')
      return { target: targetOf(value.target), ...placeOf(value, { required: true }), button: value.button ?? 'left', count: value.count ?? 1 }
    }
    case 'typeText':
      only(value, ['target', 'text', 'element'])
      if (!text(value.text, TEXT_MAX)) throw new ArgumentError('text')
      if (value.element !== undefined && !text(value.element, ELEMENT_MAX)) throw new ArgumentError('element')
      return { target: targetOf(value.target), text: value.text, ...(value.element === undefined ? {} : { element: value.element }) }
    case 'key':
      only(value, ['target', 'key'])
      if (typeof value.key !== 'string' || !/^[a-z0-9_]{1,16}(?:\+[a-z0-9_]{1,16}){0,4}$/i.test(value.key)) throw new ArgumentError('key')
      return { target: targetOf(value.target), key: value.key }
    case 'scroll': {
      only(value, ['target', 'direction', 'amount', 'element', 'x', 'y', 'frame'])
      if (!['up', 'down', 'left', 'right'].includes(value.direction)) throw new ArgumentError('direction')
      if (value.amount !== undefined && !count(value.amount, 1, 50)) throw new ArgumentError('amount')
      return { target: targetOf(value.target), direction: value.direction, amount: value.amount ?? 3, ...placeOf(value, { required: false }) }
    }
    case 'drag':
      only(value, ['target', 'from', 'to', 'frame'])
      if (!count(value.frame, 0, Number.MAX_SAFE_INTEGER)) throw new ArgumentError('frame')
      return { target: targetOf(value.target), from: pointOf(value.from, 'from'), to: pointOf(value.to, 'to'), frame: value.frame }
    default:
      throw new ArgumentError('method')
  }
}

const usesPoint = args => args.frame !== undefined
const codeText = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : null
const hintText = value => publicText(typeof value === 'string' ? value : '', HINT_MAX) || null

function nextCallOf(value) {
  if (!plainObject(value) || !COMPUTER_READ_METHODS.includes(value.tool)) return null
  try {
    return { tool: value.tool, arguments: validateComputerArgs(value.tool, value.arguments ?? {}) }
  } catch { return null }
}

/**
 * One provider action result → the closed EG-Desk result:
 * { effect, route, delivery?, evidence?, summary, dispatched, error?, hint?, nextCall?, outcomeCode? }.
 * Invariants (cua contract): confirmed has evidence (else unverifiable);
 * partial has delivery.deliveredCount (else unverifiable); refused has neither
 * delivery nor evidence and is never dispatched; error appears only on
 * refused; nextCall is only a read. Unknown fields are dropped, text is capped
 * and common secrets are redacted. cua's snake_case fields are accepted.
 */
export function normalizeActionResult(raw, { dispatched = true } = {}) {
  const source = plainObject(raw) ? raw : {}
  let effect = ACTION_EFFECTS.includes(source.effect) ? source.effect : 'unverifiable'
  const route = ACTION_ROUTES.includes(source.route) ? source.route : null
  const summary = publicText(typeof source.summary === 'string' ? source.summary : '', SUMMARY_MAX)
  const hint = hintText(source.hint)
  const nextCall = nextCallOf(source.nextCall ?? source.next_call)
  const tail = { ...(hint ? { hint } : {}), ...(nextCall ? { nextCall } : {}) }
  if (effect === 'refused') {
    const code = codeText(source.error?.code) || CODES.PROVIDER_REFUSED
    return { effect, route, summary, dispatched: false, error: { code, hint: hintText(source.error?.hint) || HINTS[code] || null }, ...tail }
  }
  const delivery = { mode: DELIVERY_MODES.includes(source.delivery?.mode) ? source.delivery.mode : 'unknown' }
  const delivered = source.delivery?.deliveredCount ?? source.delivery?.delivered_count
  if (Number.isSafeInteger(delivered) && delivered > 0) delivery.deliveredCount = delivered
  const evidence = (Array.isArray(source.evidence) ? source.evidence : [])
    .filter(item => plainObject(item) && EVIDENCE_KINDS.includes(item.kind)).slice(0, 8)
    .map(item => {
      const detail = publicText(typeof item.detail === 'string' ? item.detail : '', DETAIL_MAX)
      return detail ? { kind: item.kind, detail } : { kind: item.kind }
    })
  if (effect === 'confirmed' && !evidence.length) effect = 'unverifiable'
  if (effect === 'partial' && !delivery.deliveredCount) effect = 'unverifiable'
  return { effect, route, delivery, evidence, summary, dispatched: dispatched === 'unknown' ? 'unknown' : true, ...tail }
}

export function refusedResult(code, { hint = null, nextCall = null } = {}) {
  const call = nextCallOf(nextCall)
  return { effect: 'refused', route: null, summary: '', dispatched: false, error: { code, hint: hint || HINTS[code] || null }, ...(call ? { nextCall: call } : {}) }
}

const captureAgain = target => ({ tool: 'capture', arguments: { target } })
// Lease refusals after which looking again is the right next step; after a
// stop or a takeover the Agent waits for the person instead.
const RECAPTURE_CODES = new Set([HOST_LEASE_CODES.USER_CONTROL, HOST_LEASE_CODES.INPUT_HELD, HOST_LEASE_CODES.LEASE_REVOKED, HOST_LEASE_CODES.EXPIRED, CODES.STALE_FRAME])
const refusedLease = (code, target) => refusedResult(code, RECAPTURE_CODES.has(code) ? { nextCall: captureAgain(target) } : {})
// Something may have reached the app but nothing confirms what: dispatched is
// true when input was sent and then stopped, 'unknown' when the provider
// failed or ran out of time after the gate let input through.
function unknownOutcome(target, { code = CODES.HOST_ACTION_OUTCOME_UNKNOWN, dispatched = 'unknown' } = {}) {
  const outcome = {
    effect: 'unverifiable', route: null, delivery: { mode: 'unknown' }, evidence: [], summary: '', dispatched,
    outcomeCode: code, hint: HINTS[code] || HINTS[CODES.HOST_ACTION_OUTCOME_UNKNOWN],
  }
  return RECAPTURE_CODES.has(code) || code === CODES.HOST_ACTION_OUTCOME_UNKNOWN ? { ...outcome, nextCall: captureAgain(target) } : outcome
}

function normalizeFrame(raw, target) {
  const frame = plainObject(raw?.frame) ? raw.frame : {}
  const out = {
    target,
    windowId: count(frame.windowId, 0, Number.MAX_SAFE_INTEGER) ? frame.windowId : target.windowId ?? null,
    width: count(frame.width, 1, 100_000) ? frame.width : null,
    height: count(frame.height, 1, 100_000) ? frame.height : null,
    scale: typeof frame.scale === 'number' && Number.isFinite(frame.scale) && frame.scale > 0 ? frame.scale : null,
    geometryRevision: count(frame.geometryRevision, 0, Number.MAX_SAFE_INTEGER) ? frame.geometryRevision : null,
  }
  const image = plainObject(raw?.image) && /^image\/(?:png|jpeg|webp)$/.test(raw.image.mime) && typeof raw.image.data === 'string' ? { mime: raw.image.mime, data: raw.image.data } : null
  return { frame: out, image }
}
const optionalText = (value, max) => typeof value === 'string' && value && !value.includes('\0') ? publicText(value, max) : null
const pidOf = value => count(value, 1, 2 ** 31) ? value : null
function normalizeApps(raw) {
  return (Array.isArray(raw?.apps) ? raw.apps : []).filter(plainObject).map(app => ({
    name: optionalText(app.name, 128), bundleId: optionalText(app.bundleId, APP_MAX), pid: pidOf(app.pid), active: app.active === true,
  })).filter(app => app.name || app.bundleId).slice(0, LIST_MAX)
}
function boundsOf(value) {
  if (!plainObject(value)) return null
  const numbers = ['x', 'y', 'width', 'height'].map(key => value[key])
  return numbers.every(number => typeof number === 'number' && Number.isFinite(number)) ? { x: value.x, y: value.y, width: value.width, height: value.height } : null
}
function normalizeWindows(raw) {
  return (Array.isArray(raw?.windows) ? raw.windows : []).filter(plainObject).map(window => ({
    windowId: count(window.windowId, 0, Number.MAX_SAFE_INTEGER) ? window.windowId : null,
    app: optionalText(window.app, APP_MAX), pid: pidOf(window.pid), title: optionalText(window.title, 256),
    bounds: boundsOf(window.bounds), onScreen: window.onScreen === true,
  })).filter(window => window.windowId !== null).slice(0, LIST_MAX)
}

function withDeadline(promise, ms, timers, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let handle
  const timeout = new Promise(resolve => { handle = timers.setTimeout(() => resolve(onTimeout()), ms) })
  return Promise.race([promise, timeout]).finally(() => timers.clearTimeout(handle))
}

const frameKey = target => `${hostLaneKey(target)}\u0000${target.windowId ?? ''}`

/**
 * createComputerAdapter({ provider, lease, deliveryCeiling, timers, now, onRecord })
 * - methods(): the COMPUTER_METHODS this provider implements.
 * - call(method, args, { commandId, deadlineMs }) → for an action the closed
 *   result above; for a read { ok: true, frame, image } / { ok: true, apps } /
 *   { ok: true, windows } or { ok: false, error }.
 * An action needs a lease (fail closed without one). Before the provider is
 * called: arguments, the delivery ceiling against provider.guarantee(), and
 * for a point the frame number of the last capture this adapter returned and
 * provider.currentRevision(target) read again inside the lease (EG-02). The
 * provider gets ctx.checkpoint (call it before every input event and stamp the
 * returned mark on the event), ctx.onCleanup (release held keys/buttons) and
 * ctx.delivery. On the deadline the call answers at once; the provider's next
 * checkpoint refuses, so nothing more is sent. onRecord gets metadata only:
 * { at, commandId, method, app, inputBytes, effect, route, deliveryMode,
 * dispatched, code, durationMs } — never text, keys, coordinates, titles,
 * images or the summary.
 */
export function createComputerAdapter({ provider, lease = null, deliveryCeiling = 'background', timers = globalThis, now = () => performance.now(), onRecord = () => {} } = {}) {
  if (!provider || typeof provider !== 'object') throw new TypeError('createComputerAdapter needs a provider')
  if (!DELIVERY_CEILINGS.includes(deliveryCeiling)) throw new TypeError(`Unknown delivery ceiling: ${deliveryCeiling}`)
  const frames = new Map()
  let seq = 0
  const methods = () => COMPUTER_METHODS.filter(method => typeof provider?.[method] === 'function')
  const record = entry => { try { onRecord(entry) } catch {} }

  async function read(method, args) {
    try {
      const raw = await provider[method](args, { delivery: 'not_applicable' })
      if (method === 'capture') {
        const { frame, image } = normalizeFrame(raw, args.target)
        if (frame.geometryRevision !== null) frames.set(frameKey(args.target), frame.geometryRevision)
        return { ok: true, frame, image }
      }
      return method === 'listApps' ? { ok: true, apps: normalizeApps(raw) } : { ok: true, windows: normalizeWindows(raw) }
    } catch {
      return { ok: false, error: { code: CODES.HOST_ACTION_FAILED, hint: 'Reading the screen state failed. Try again.' } }
    }
  }

  async function act(method, args, { commandId, deadlineMs }) {
    if (!lease) return refusedResult(CODES.NO_HOST_LEASE)
    let guarantee = 'may-activate'
    try {
      const reported = provider.guarantee?.(method, args)
      if (ACTION_GUARANTEES.includes(reported)) guarantee = reported
    } catch {}
    if (deliveryCeiling === 'view-only') return refusedResult(CODES.VIEW_ONLY)
    if (guarantee === 'unsupported') return refusedResult(CODES.UNSUPPORTED_ACTION)
    if (guarantee === 'may-activate' && deliveryCeiling === 'background') return refusedResult(CODES.WOULD_REQUIRE_ACTIVATION)
    const point = usesPoint(args)
    if (point) {
      if (typeof provider.currentRevision !== 'function') return refusedResult(CODES.COORDINATES_UNSUPPORTED)
      if (frames.get(frameKey(args.target)) !== args.frame) return refusedResult(CODES.STALE_FRAME, { nextCall: captureAgain(args.target) })
    }
    const delivery = guarantee === 'background' ? 'background' : 'foreground'
    const flags = { dispatched: false, timedOut: false }
    const task = async ctx => {
      if (point) {
        let current = null
        try { current = await provider.currentRevision(args.target) } catch {}
        if (current !== args.frame) return { refused: CODES.STALE_FRAME }
      }
      const providerCtx = {
        delivery,
        deadlineAt: ctx.deadlineAt,
        onCleanup: ctx.onCleanup,
        checkpoint(options) {
          if (flags.timedOut) throw new HostLeaseBlocked(HOST_LEASE_CODES.EXPIRED, null)
          const mark = ctx.checkpoint(options)
          flags.dispatched = true
          return mark
        },
      }
      return { raw: await provider[method](args, providerCtx) }
    }
    const ran = lease.run(method, { target: args.target, args, deadlineMs, commandId }, task)
    const outcome = await withDeadline(ran, deadlineMs, timers, () => {
      flags.timedOut = true
      return { timedOut: true }
    })
    if (outcome.timedOut) return flags.dispatched ? unknownOutcome(args.target) : refusedLease(HOST_LEASE_CODES.EXPIRED, args.target)
    if (outcome.dispatched === 'unknown') return unknownOutcome(args.target)
    if (outcome.dispatched === true && outcome.code) {
      // Sent, then stopped or preempted at a later checkpoint: what was sent
      // stays sent and is not called cancelled.
      return unknownOutcome(args.target, { code: outcome.code, dispatched: true })
    }
    if (outcome.code) return refusedLease(outcome.code, args.target)
    if (outcome.value?.refused) return refusedLease(outcome.value.refused, args.target)
    const result = normalizeActionResult(outcome.value?.raw, { dispatched: true })
    // A provider that reports an effect without passing the gate broke the
    // contract; its claim is not vouched for.
    if (outcome.dispatched === false && result.effect !== 'refused') return unknownOutcome(args.target)
    return result
  }

  async function call(method, args = {}, { commandId = null, deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
    const started = now()
    const id = typeof commandId === 'string' && /^[\w.:-]{1,128}$/.test(commandId) ? commandId : `computer-${++seq}`
    let clean = null, result
    if (!COMPUTER_METHODS.includes(method)) result = refusedResult(CODES.UNKNOWN_METHOD)
    else if (typeof provider?.[method] !== 'function') result = refusedResult(CODES.UNSUPPORTED_METHOD)
    else {
      try { clean = validateComputerArgs(method, args) } catch (error) {
        result = refusedResult(CODES.INVALID_ARGUMENTS, { hint: error.field ? `Check the ${error.field} argument.` : 'Remove arguments this tool does not take.' })
      }
    }
    if (!result) result = COMPUTER_READ_METHODS.includes(method) ? await read(method, clean) : await act(method, clean, { commandId: id, deadlineMs })
    let inputBytes = 0
    try { inputBytes = Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8') } catch {}
    record({
      at: now(),
      commandId: id,
      method: COMPUTER_METHODS.includes(method) ? method : 'invalid',
      app: clean?.target ? hostLaneKey(clean.target) : null,
      inputBytes,
      effect: result.effect ?? (result.ok ? 'read' : 'refused'),
      route: result.route ?? null,
      deliveryMode: result.delivery?.mode ?? null,
      dispatched: result.dispatched ?? false,
      code: result.error?.code ?? result.outcomeCode ?? null,
      durationMs: Math.max(0, Math.round(now() - started)),
    })
    return result
  }

  return { methods, call }
}

const DEFAULT_APPS = Object.freeze([
  { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 501, active: false },
  { name: 'Finder', bundleId: 'com.apple.finder', pid: 502, active: true },
])
const DEFAULT_WINDOWS = Object.freeze([
  { windowId: 11, app: 'com.apple.TextEdit', pid: 501, title: 'Untitled', bounds: { x: 0, y: 0, width: 800, height: 600 }, onScreen: true },
])

/**
 * A provider that sends nothing to the OS, for tests and fixture QA. Every
 * input event it "sends" first passes ctx.checkpoint and is appended to
 * `events` ({ method, kind, ... } — character counts, never characters).
 * - guarantees: { method: 'background'|'may-activate'|'unsupported' }; drag is
 *   'may-activate' by default (a macOS drag needs the real pointer).
 * - fail: { method: 'throw-before'|'throw-after'|'hang-before'|'hang-after' }.
 * - between({ method, kind, index }): awaited after each event (tests put a
 *   person's input or a stop there). echo({ kind, mark }): the input monitor
 *   seeing the fake's own event.
 * - setRevision(target, n): the window moved or resized.
 */
export function createFakeComputerProvider({ apps = DEFAULT_APPS, windows = DEFAULT_WINDOWS, guarantees = {}, fail = {}, chunk = 8, between = null, echo = null } = {}) {
  const events = []
  const calls = []
  const revisions = new Map()
  const revisionOf = target => revisions.get(hostLaneKey(target)) ?? 1
  const never = () => new Promise(() => {})
  async function send(ctx, method, kind, extra = {}) {
    const mark = ctx.checkpoint()
    events.push({ method, kind, ...extra })
    if (echo) await echo({ kind: kind === 'release' ? 'key' : kind, mark })
    if (between) await between({ method, kind, index: events.length })
  }
  async function act(method, body) {
    calls.push({ method })
    if (fail[method] === 'throw-before') throw new Error('fake provider failed before sending')
    if (fail[method] === 'hang-before') await never()
    const result = await body()
    if (fail[method] === 'throw-after') throw new Error('fake provider lost the reply')
    if (fail[method] === 'hang-after') await never()
    return result
  }
  const delivered = (ctx, route, evidence, summary) => ({ effect: evidence.length ? 'confirmed' : 'unverifiable', route, delivery: { mode: ctx.delivery }, evidence, summary })
  return {
    id: 'fake',
    events,
    calls,
    setRevision(target, revision) { revisions.set(hostLaneKey(target), revision) },
    guarantee: method => guarantees[method] ?? (method === 'drag' ? 'may-activate' : 'background'),
    currentRevision: target => revisionOf(target),
    async capture(args) {
      calls.push({ method: 'capture' })
      return { frame: { windowId: args.target.windowId ?? 11, width: 800, height: 600, scale: 2, geometryRevision: revisionOf(args.target) }, image: { mime: 'image/png', data: 'iVBORw0KGgo=' } }
    },
    async listApps() { calls.push({ method: 'listApps' }); return { apps: apps.map(app => ({ ...app })) } },
    async listWindows(args) {
      calls.push({ method: 'listWindows' })
      const lane = args.target ? hostLaneKey(args.target) : null
      return { windows: windows.filter(window => !lane || hostLaneKey({ app: window.app }) === lane).map(window => ({ ...window })) }
    },
    click: (args, ctx) => act('click', async () => {
      for (let index = 0; index < args.count; index += 1) await send(ctx, 'click', 'pointer')
      return delivered(ctx, args.element ? 'accessibility' : 'synthetic_events', [{ kind: 'window_change' }], args.element ? 'Pressed the element' : 'Clicked inside the window')
    }),
    typeText: (args, ctx) => act('typeText', async () => {
      for (let at = 0; at < args.text.length; at += chunk) await send(ctx, 'typeText', 'key', { chars: Math.min(chunk, args.text.length - at) })
      return delivered(ctx, 'accessibility', [{ kind: 'value_readback', detail: `${args.text.length} characters read back` }], 'Typed the text')
    }),
    key: (args, ctx) => act('key', async () => {
      let down = false
      ctx.onCleanup(() => { if (down) { down = false; events.push({ method: 'key', kind: 'release' }) } })
      await send(ctx, 'key', 'key', { phase: 'down' })
      down = true
      await send(ctx, 'key', 'key', { phase: 'up' })
      down = false
      return delivered(ctx, 'synthetic_events', [], 'Pressed the key')
    }),
    scroll: (args, ctx) => act('scroll', async () => {
      for (let index = 0; index < args.amount; index += 1) await send(ctx, 'scroll', 'scroll')
      return delivered(ctx, args.element ? 'accessibility' : 'synthetic_events', [{ kind: 'window_change' }], 'Scrolled')
    }),
    drag: (args, ctx) => act('drag', async () => {
      let down = false
      ctx.onCleanup(() => { if (down) { down = false; events.push({ method: 'drag', kind: 'release' }) } })
      await send(ctx, 'drag', 'pointer', { phase: 'down' })
      down = true
      await send(ctx, 'drag', 'pointer', { phase: 'move' })
      await send(ctx, 'drag', 'pointer', { phase: 'up' })
      down = false
      return delivered(ctx, 'global_input', [{ kind: 'window_change' }], 'Dragged')
    }),
  }
}
