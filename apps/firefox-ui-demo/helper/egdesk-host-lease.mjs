// Portions adapted from CursorTouch/Windows-MCP (MIT License, Copyright (c) 2025 JEOMON GEORGE):
// src/windows_mcp/desktop/control.py (ControlCoordinator: ready/user/ai/unavailable,
// _tick_locked, begin_call, checkpoint, end_call's 15 s hold, raw-motion takeover)
// and src/windows_mcp/tools/control_policy.py (DIRECT/POSSIBLE/OTHER, unknown tools
// keep the desktop gate). Patterns only, no code: trycua cua-spacesd
// docs/architecture.md (FSL; target epoch) and open-computer-use LockedUseActionScope
// (every event re-validated).
import { closeSync, constants, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'

// CU-02 (docs/references/rea-mechanism-adoption.md 4.2 맥5·맥6·맥7): who holds
// this Mac's mouse and keyboard. One state for the whole desktop:
// - 'ready': nobody is using it; an Agent action may begin.
// - 'user': a person is using it. An Agent action does not begin; after
//   userIdleSeconds without input it is 'ready' again. When the person took
//   over from an Agent (yielded), only handBack() ([Agent에게 돌려주기]) ends it.
// - 'ai': an Agent action holds it. Every input event checks the lease first
//   (checkpoint); after the last action it is kept for holdSeconds.
// - 'unavailable': no input monitor, a dead watchdog, or everything stopped.
// Every state change raises epoch; a token from an older epoch cannot send.
// Nothing here posts OS input, and no typed character, key, coordinate or
// screen content is kept or reported.
export const HOST_LEASE_STATES = Object.freeze(['ready', 'user', 'ai', 'unavailable'])
export const HOST_CONTROL_CATEGORIES = Object.freeze(['direct', 'possible', 'other'])
// strict: every tool takes the lease; balanced: direct and possible; relaxed: direct only.
export const HOST_CONTROL_POLICIES = Object.freeze(['strict', 'balanced', 'relaxed'])
export const HOST_UNAVAILABLE_REASONS = Object.freeze(['monitor', 'guard', 'stopped'])
export const HOST_INPUT_KINDS = Object.freeze(['pointer', 'key', 'scroll', 'move'])
export const HOST_LEASE_CODES = Object.freeze({
  USER_CONTROL: 'USER_CONTROL', // a person is using the Mac; status.waitMs says how long
  INPUT_HELD: 'INPUT_HELD', // a physical key or button is still down
  CONTROL_UNAVAILABLE: 'CONTROL_UNAVAILABLE', // no input monitor or watchdog
  DEVICE_BUSY: 'DEVICE_BUSY', // another process holds this Mac's input
  STOPPED: 'STOPPED', // stopApp / stopAll
  LEASE_REVOKED: 'LEASE_REVOKED',
  USER_INTERVENTION: 'USER_INTERVENTION', // the person took over from the Agent
  EXPIRED: 'EXPIRED', // the action's deadline passed
})
export const HOST_RECEIPT_PHASES = Object.freeze(['enqueued', 'dispatched', 'not-dispatched', 'finished', 'preempted', 'unknown', 'cleanup'])
const CODES = HOST_LEASE_CODES
const MOVE_WINDOW_MS = 500 // Windows-MCP: a 0.5 s gap starts a new motion path
const MAX_MARKS = 256
const MAX_STOPPED_SHOWN = 32

export class HostLeaseBlocked extends Error {
  constructor(code, status) {
    super(`${code}: ${status?.state ?? 'unknown'}`)
    this.name = 'HostLeaseBlocked'
    this.code = code
    this.status = status ?? null
  }
}

// What a tool does to the desktop, not whether it is destructive. Names are
// compared in snake_case, so the adapter's typeText and Codex Computer Use's
// type_text are the same row. A name not in the table is 'direct'.
const DIRECT_TOOLS = new Set([
  'click', 'double_click', 'right_click', 'type_text', 'key', 'press_key', 'hotkey', 'scroll', 'drag', 'mouse_drag',
  'move_cursor', 'mouse_button_down', 'mouse_button_up', 'set_value', 'select_text', 'perform_secondary_action',
  'invoke_menu', 'set_window_frame', 'focus_window', 'activate_app',
])
const POSSIBLE_TOOLS = new Set(['launch_app', 'open_application', 'open_url', 'notify', 'run_script'])
const OTHER_TOOLS = new Set(['capture', 'screenshot', 'list_apps', 'list_windows', 'read_elements', 'get_app_state', 'get_window_state', 'check_permissions', 'wait', 'status'])
const TOOL_MODES = new Map([
  ['app', new Map([['launch', 'possible'], ['activate', 'direct'], ['resize', 'direct'], ['list', 'other']])],
  ['clipboard', new Map([['get', 'other'], ['set', 'possible']])],
])
const toolKey = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

export function classifyHostTool(name, args = null) {
  if (typeof name !== 'string' || !name) return 'direct'
  const key = toolKey(name)
  const modes = TOOL_MODES.get(key)
  if (modes) {
    const mode = args && typeof args === 'object' && !Array.isArray(args) ? args.mode : undefined
    if (mode === undefined && key === 'app') return 'possible'
    return (typeof mode === 'string' && modes.get(mode)) || 'direct'
  }
  if (DIRECT_TOOLS.has(key)) return 'direct'
  if (POSSIBLE_TOOLS.has(key)) return 'possible'
  if (OTHER_TOOLS.has(key)) return 'other'
  return 'direct'
}

export function requiresHostControl(name, { policy = 'balanced', args = null } = {}) {
  if (!HOST_CONTROL_POLICIES.includes(policy)) throw new TypeError(`Unknown host control policy: ${policy}`)
  if (typeof name === 'string' && toolKey(name) === 'status') return false
  if (policy === 'strict') return true
  const category = classifyHostTool(name, args)
  return category === 'direct' || (policy === 'balanced' && category === 'possible')
}

// One lane per target app: { bundleId } or { app }, compared case-insensitively.
export function hostLaneKey(target) {
  const id = target && typeof target === 'object' ? (target.bundleId ?? target.app) : target
  if (typeof id !== 'string') return null
  const key = id.trim().toLowerCase()
  return key && key.length <= 256 && !key.includes('\0') ? key : null
}

const LOCK_VERSION = 1
const LOCK_MAX_BYTES = 512
const NOFOLLOW = constants.O_NOFOLLOW || 0
const defaultIsAlive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/**
 * This Mac's input lock across processes (two EG-Desk helpers, or a helper
 * that crashed). The file holds only { v, pid, nonce, at }; put it in a 0700
 * directory. It is stale when its owner process is gone, its heartbeat is
 * older than staleMs, or it is unreadable and older than staleMs.
 * - acquire(): true when this lock now holds it. A new lock is linked into
 *   place whole (no half-written file); a stale one is replaced and read back.
 * - heartbeat(): refreshes at most every staleMs/3; false when it is no longer ours.
 * - release(): removes it only while it is ours.
 * - inspect(): 'free' | 'mine' | 'other' | 'stale'.
 * Two takers of the same stale lock can both read back their own record for a
 * moment; the loser sees heartbeat() false at its next checkpoint.
 */
export function createDeviceLock({ lockPath, now = Date.now, pid = process.pid, isAlive = defaultIsAlive, staleMs = 30_000, nonce = randomBytes(12).toString('hex') } = {}) {
  if (typeof lockPath !== 'string' || !lockPath || lockPath.includes('\0')) throw new TypeError('createDeviceLock needs a lockPath')
  let lastBeat = 0
  function writeTemp() {
    const temporary = `${lockPath}.${pid}-${randomBytes(6).toString('hex')}.tmp`
    let fd = null
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600)
      const bytes = Buffer.from(JSON.stringify({ v: LOCK_VERSION, pid, nonce, at: now() }))
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
      closeSync(fd); fd = null
      return temporary
    } catch (error) {
      if (fd !== null) { try { closeSync(fd) } catch {} }
      try { unlinkSync(temporary) } catch {}
      throw error
    }
  }
  function read() {
    let text
    try {
      const fd = openSync(lockPath, constants.O_RDONLY | NOFOLLOW)
      try {
        const buffer = Buffer.alloc(LOCK_MAX_BYTES + 1)
        text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8')
      } finally { closeSync(fd) }
    } catch (error) { return error?.code === 'ENOENT' ? null : { invalid: true } }
    try {
      const value = JSON.parse(text)
      if (value?.v === LOCK_VERSION && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.nonce === 'string' && Number.isFinite(value.at)) {
        return { pid: value.pid, nonce: value.nonce, at: value.at }
      }
    } catch {}
    return { invalid: true }
  }
  const mine = held => Boolean(held && !held.invalid && held.pid === pid && held.nonce === nonce)
  function stale(held) {
    if (!held) return true
    if (held.invalid) {
      try { return now() - lstatSync(lockPath).mtimeMs > staleMs } catch { return false }
    }
    if (held.pid !== pid && !isAlive(held.pid)) return true
    return now() - held.at > staleMs
  }
  function acquire() {
    let temporary = null
    try {
      temporary = writeTemp()
      try {
        linkSync(temporary, lockPath)
        lastBeat = now()
        return true
      } catch (error) { if (error?.code !== 'EEXIST') return false }
      const held = read()
      if (mine(held)) return true
      if (!stale(held)) return false
      renameSync(temporary, lockPath)
      temporary = null
      if (!mine(read())) return false
      lastBeat = now()
      return true
    } catch { return false } finally {
      if (temporary) { try { unlinkSync(temporary) } catch {} }
    }
  }
  function heartbeat() {
    if (!mine(read())) return false
    if (now() - lastBeat < staleMs / 3) return true
    let temporary = null
    try {
      temporary = writeTemp()
      renameSync(temporary, lockPath)
      temporary = null
      lastBeat = now()
    } catch {} finally {
      if (temporary) { try { unlinkSync(temporary) } catch {} }
    }
    return mine(read())
  }
  function release() {
    if (mine(read())) { try { unlinkSync(lockPath) } catch {} }
  }
  function inspect() {
    const held = read()
    if (!held) return 'free'
    if (mine(held)) return 'mine'
    return stale(held) ? 'stale' : 'other'
  }
  return { acquire, heartbeat, release, inspect }
}

/**
 * The control lease (CU-02). now is a monotonic clock in ms (fake in tests).
 * - begin(name, {target, args, deadlineMs, commandId}) → token, or throws
 *   HostLeaseBlocked. A tool that requiresHostControl() does not take the
 *   lease returns a token with control false.
 * - checkpoint(token, {events}) right before each input event: throws
 *   HostLeaseBlocked (STOPPED, USER_INTERVENTION, LEASE_REVOKED, EXPIRED,
 *   CONTROL_UNAVAILABLE, DEVICE_BUSY) and then nothing may be sent. Returns a
 *   one-use dispatch mark (good for `events` observed events, markTtlMs) the
 *   input path stamps on the event so the monitor can tell it is the Agent's.
 * - end(token): after the last action the lease is kept for holdSeconds.
 * - run(name, options, task): the app lane (맥5). Actions on the same app run
 *   one at a time in order; task(ctx) gets ctx.checkpoint and ctx.onCleanup.
 *   Resolves { commandId, dispatched: true|false|'unknown', code, value }.
 * - observeInput({kind, mark, distance, held}): from the input monitor. An
 *   event whose mark matches an unused dispatch mark is the Agent's; any other
 *   input is a person's (a mark alone is not trusted). A person's input while
 *   an Agent holds the lease yields it at once (control.yielded).
 * - stopApp(target) / stopAll(): raise the epoch, drop actions not yet sent
 *   (not-dispatched), let a running action stop at its next checkpoint, run its
 *   cleanups (release held keys and buttons) and only then resolve the ACK.
 *   Input already sent is not reported as cancelled.
 * - takeOver(): [일시중지 · 내가 쓰기], a takeover asked for on screen.
 * - handBack({target}): [Agent에게 돌려주기]. Without a target it ends a
 *   takeover and every stop; with one it resumes that app only.
 * - revoke(code), setInputMonitor(ok), status().
 * onEvent receives { type: 'control.state', status }, { type:
 * 'control.yielded', reason: 'human-input', epoch, at }, { type:
 * 'control.stopped', scope, app, notDispatched, inFlight, epoch, at } and
 * { type: 'command.receipt', phase, commandId, seq, app, pid, at, ... }, all on
 * the same clock. None carries arguments, text, keys or coordinates.
 */
export function createHostLease({
  now = () => performance.now(),
  userIdleSeconds = 10,
  holdSeconds = 15,
  moveTakeoverDistance = 48,
  markTtlMs = 2000,
  tombstoneMs = 60_000,
  guardAlive = () => true,
  requireMonitor = true,
  policy = 'balanced',
  lockPath = null,
  lock = null,
  onEvent = () => {},
} = {}) {
  if (!HOST_CONTROL_POLICIES.includes(policy)) throw new TypeError(`Unknown host control policy: ${policy}`)
  for (const [name, value] of Object.entries({ userIdleSeconds, holdSeconds, moveTakeoverDistance, markTtlMs, tombstoneMs })) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative number`)
  }
  const idleMs = userIdleSeconds * 1000
  const holdMs = holdSeconds * 1000
  const device = lock || (lockPath ? createDeviceLock({ lockPath }) : null)
  let state = 'ready', epoch = 0
  let holdUntil = 0, lastHuman = 0, held = false, yielded = false
  let moveDistance = 0, lastMoveAt = -Infinity
  let deviceHeld = false
  let leaseSeq = 0, commandSeq = 0
  const reasons = new Set(requireMonitor ? ['monitor'] : [])
  const tombstones = new Map() // ended epoch → { code, until }
  const stoppedLanes = new Set()
  const laneEpochs = new Map()
  const marks = new Map() // dispatch mark → { uses, until }
  const lanes = new Map() // lane ('' for no target) → { queue, running }
  const openTokens = new Set()

  const emit = event => { try { onEvent(event) } catch {} }
  const alive = () => { try { return guardAlive() === true } catch { return false } }
  const active = () => { let count = 0; for (const token of openTokens) if (token.epoch === epoch) count += 1; return count }
  const recentHuman = t => lastHuman > 0 && t - lastHuman < idleMs

  function snapshot(t = now()) {
    const calls = active()
    return {
      state,
      epoch,
      waitMs: state === 'user' && !yielded && lastHuman > 0 ? Math.max(0, Math.ceil(lastHuman + idleMs - t)) : 0,
      yielded,
      held,
      reasons: HOST_UNAVAILABLE_REASONS.filter(reason => reasons.has(reason)),
      stoppedApps: [...stoppedLanes].sort().slice(0, MAX_STOPPED_SHOWN),
      activeCalls: calls,
      holdMs: state === 'ai' && !calls ? Math.max(0, Math.ceil(holdUntil - t)) : 0,
      device: device ? (deviceHeld ? 'held' : 'idle') : 'off',
      policy,
    }
  }
  const emitState = () => emit({ type: 'control.state', status: snapshot() })

  function releaseDevice() {
    if (!device || !deviceHeld) return
    deviceHeld = false
    try { device.release() } catch {}
  }
  function setState(next, cause) {
    if (next === state) return false
    if (cause) tombstones.set(epoch, { code: cause, until: now() + tombstoneMs })
    if (state === 'ai') releaseDevice()
    state = next
    epoch += 1
    moveDistance = 0
    holdUntil = 0
    return true
  }
  function causeOf(oldEpoch, t) {
    for (const [ended, entry] of tombstones) if (entry.until <= t) tombstones.delete(ended)
    return tombstones.get(oldEpoch)?.code ?? CODES.LEASE_REVOKED
  }
  function tick() {
    const t = now()
    if (alive()) reasons.delete('guard')
    else reasons.add('guard')
    if (reasons.size) return setState('unavailable', reasons.has('stopped') ? CODES.STOPPED : CODES.CONTROL_UNAVAILABLE)
    const recent = recentHuman(t)
    if (state === 'unavailable') return setState(recent || yielded ? 'user' : 'ready', null)
    if (state === 'ready' && recent) return setState('user', null)
    if (state === 'user' && !held && !yielded && !recent) return setState('ready', null)
    if (state === 'ai' && !active() && t >= holdUntil) return setState(recent ? 'user' : 'ready', CODES.EXPIRED)
    return false
  }
  function status() {
    if (tick()) emitState()
    return snapshot()
  }
  function pruneMarks(t) {
    for (const [mark, entry] of marks) if (entry.until <= t) marks.delete(mark)
    while (marks.size > MAX_MARKS) marks.delete(marks.keys().next().value)
  }

  function begin(name, { target = null, args = null, deadlineMs = null, commandId = null } = {}) {
    const control = requiresHostControl(name, { policy, args })
    const lane = hostLaneKey(target)
    const t = now()
    const token = {
      leaseId: `lease-${++leaseSeq}`,
      commandId: typeof commandId === 'string' ? commandId : null,
      control,
      lane,
      epoch: null,
      laneEpoch: null,
      deadlineAt: Number.isFinite(deadlineMs) && deadlineMs > 0 ? t + deadlineMs : null,
      steps: 0,
      ended: false,
    }
    if (!control) return token
    let changed = tick()
    const block = code => {
      if (changed) emitState()
      throw new HostLeaseBlocked(code, snapshot())
    }
    if (state === 'unavailable') block(reasons.has('stopped') ? CODES.STOPPED : CODES.CONTROL_UNAVAILABLE)
    if (held) block(CODES.INPUT_HELD)
    if (state === 'user') block(yielded ? CODES.USER_INTERVENTION : CODES.USER_CONTROL)
    if (lane && stoppedLanes.has(lane)) block(CODES.STOPPED)
    if (device && !deviceHeld) {
      let acquired = false
      try { acquired = device.acquire() === true } catch {}
      if (!acquired) block(CODES.DEVICE_BUSY)
      deviceHeld = true
    }
    changed = setState('ai', null) || changed
    token.epoch = epoch
    token.laneEpoch = lane ? laneEpochs.get(lane) || 0 : 0
    openTokens.add(token)
    if (changed) emitState()
    return token
  }

  function revokeInternal(code) {
    if (state !== 'ai') return false
    return setState(recentHuman(now()) ? 'user' : 'ready', code)
  }

  function checkpoint(token, { events = 1 } = {}) {
    if (!token || typeof token !== 'object') throw new TypeError('checkpoint needs a token from begin()')
    if (!token.control) return null
    const t = now()
    let changed = false
    if (!alive()) {
      reasons.add('guard')
      changed = setState('unavailable', CODES.CONTROL_UNAVAILABLE)
    }
    const fail = code => {
      if (changed) emitState()
      throw new HostLeaseBlocked(code, snapshot(t))
    }
    if (token.ended) fail(CODES.LEASE_REVOKED)
    if (token.epoch !== epoch || state !== 'ai') fail(causeOf(token.epoch, t))
    if (token.lane && (stoppedLanes.has(token.lane) || (laneEpochs.get(token.lane) || 0) !== token.laneEpoch)) fail(CODES.STOPPED)
    if (token.deadlineAt !== null && t >= token.deadlineAt) fail(CODES.EXPIRED)
    if (device) {
      let ours = false
      try { ours = device.heartbeat() === true } catch {}
      if (!ours) {
        deviceHeld = false
        changed = revokeInternal(CODES.DEVICE_BUSY) || changed
        fail(CODES.DEVICE_BUSY)
      }
    }
    token.steps += 1
    const mark = randomBytes(12).toString('base64url')
    marks.set(mark, { uses: Math.min(16, Math.max(1, Number.isSafeInteger(events) ? events : 1)), until: t + markTtlMs })
    pruneMarks(t)
    return mark
  }

  function end(token) {
    if (!token?.control || token.ended) return snapshot()
    token.ended = true
    openTokens.delete(token)
    if (state === 'ai' && token.epoch === epoch && !active()) holdUntil = now() + holdMs
    return snapshot()
  }

  function flushQueues(code, lane = null) {
    let count = 0
    for (const [key, entry] of lanes) {
      if (lane !== null && key !== lane) continue
      for (const item of entry.queue.splice(0)) {
        count += 1
        item.settle(notDispatched(item, code))
      }
    }
    return count
  }
  async function settleRunning(lane = null) {
    const running = []
    for (const [key, entry] of lanes) if ((lane === null || key === lane) && entry.running) running.push(entry.running.done)
    await Promise.allSettled(running)
    return running.length
  }

  function observeInput({ kind, mark = null, distance = 0, held: heldNow } = {}) {
    if (!HOST_INPUT_KINDS.includes(kind)) throw new TypeError(`Unknown input kind: ${kind}`)
    const t = now()
    pruneMarks(t)
    if (typeof mark === 'string') {
      const entry = marks.get(mark)
      if (entry && entry.until > t) {
        entry.uses -= 1
        if (entry.uses <= 0) marks.delete(mark)
        return { attributed: 'agent', status: snapshot(t) }
      }
    }
    let changed = tick()
    if (typeof heldNow === 'boolean' && heldNow !== held) { held = heldNow; changed = true }
    let takeover = false
    if (kind === 'move') {
      const length = Number.isFinite(distance) && distance > 0 ? distance : 0
      if (state === 'ai') {
        // Sum the path, not the displacement; small jitter is not a takeover.
        if (t - lastMoveAt >= MOVE_WINDOW_MS) moveDistance = 0
        lastMoveAt = t
        moveDistance += length
        if (moveDistance >= moveTakeoverDistance) takeover = true
      } else if (length > 0) {
        lastHuman = t
        if (state === 'ready') changed = setState('user', null) || changed
      }
    } else {
      lastHuman = t
      if (state === 'ai') takeover = true
      else if (state === 'ready') changed = setState('user', null) || changed
    }
    if (takeover) {
      lastHuman = t
      yielded = true
      setState('user', CODES.USER_INTERVENTION)
      flushQueues(CODES.USER_INTERVENTION)
      emit({ type: 'control.yielded', reason: 'human-input', epoch, at: t })
      changed = true
    }
    if (changed) emitState()
    return { attributed: 'human', status: snapshot(t) }
  }

  function handBack({ target = null } = {}) {
    if (target !== null && target !== undefined) {
      const lane = hostLaneKey(target)
      const resumed = Boolean(lane && stoppedLanes.delete(lane))
      if (resumed) emitState()
      return { ok: resumed, status: snapshot() }
    }
    if (held) return { ok: false, code: CODES.INPUT_HELD, status: snapshot() }
    yielded = false
    lastHuman = 0
    moveDistance = 0
    stoppedLanes.clear()
    reasons.delete('stopped')
    tick()
    emitState()
    return { ok: true, status: snapshot() }
  }

  // [일시중지 · 내가 쓰기] from the host-activity view (CU-01): the person
  // takes the Mac on purpose. Like a takeover by input: actions not yet sent
  // are dropped, a running one stops at its next checkpoint, and only
  // handBack() gives it back. control.yielded says reason 'user-request'.
  function takeOver() {
    const t = now()
    lastHuman = t
    yielded = true
    moveDistance = 0
    if (state === 'ai' || state === 'ready') setState('user', CODES.USER_INTERVENTION)
    const dropped = flushQueues(CODES.USER_INTERVENTION)
    emit({ type: 'control.yielded', reason: 'user-request', epoch, at: t })
    emitState()
    return { ok: true, notDispatched: dropped, status: snapshot(t) }
  }

  async function stopApp(target) {
    const lane = hostLaneKey(target)
    if (!lane) throw new TypeError('stopApp needs a target app')
    stoppedLanes.add(lane)
    laneEpochs.set(lane, (laneEpochs.get(lane) || 0) + 1)
    const dropped = flushQueues(CODES.STOPPED, lane)
    emitState()
    const inFlight = await settleRunning(lane)
    const ack = { type: 'control.stopped', scope: 'app', app: lane, notDispatched: dropped, inFlight, epoch, at: now() }
    emit(ack)
    return ack
  }

  async function stopAll() {
    reasons.add('stopped')
    setState('unavailable', CODES.STOPPED)
    const dropped = flushQueues(CODES.STOPPED)
    emitState()
    const inFlight = await settleRunning()
    const ack = { type: 'control.stopped', scope: 'all', app: null, notDispatched: dropped, inFlight, epoch, at: now() }
    emit(ack)
    return ack
  }

  function revoke(code = CODES.LEASE_REVOKED) {
    const cause = Object.values(CODES).includes(code) ? code : CODES.LEASE_REVOKED
    const changed = revokeInternal(cause)
    flushQueues(cause)
    if (changed) emitState()
    return snapshot()
  }

  function setInputMonitor(ok) {
    if (ok === true) reasons.delete('monitor')
    else reasons.add('monitor')
    if (tick()) emitState()
    return snapshot()
  }

  function receipt(item, phase, extra = {}) {
    emit({ type: 'command.receipt', phase, commandId: item.commandId, seq: item.seq, app: item.lane, pid: item.pid, at: now(), ...extra })
  }
  function notDispatched(item, code) {
    receipt(item, 'not-dispatched', { code })
    return { commandId: item.commandId, dispatched: false, code, value: null }
  }

  async function execute(item) {
    let token
    try {
      token = begin(item.name, { target: item.target, args: item.args, deadlineMs: item.deadlineMs, commandId: item.commandId })
    } catch (error) {
      return notDispatched(item, error instanceof HostLeaseBlocked ? error.code : CODES.CONTROL_UNAVAILABLE)
    }
    const cleanups = []
    let dispatched = false
    const ctx = {
      token,
      commandId: item.commandId,
      deadlineAt: token.deadlineAt,
      checkpoint(options) {
        const mark = checkpoint(token, options)
        if (token.control && !dispatched) {
          dispatched = true
          receipt(item, 'dispatched', { epoch: token.epoch })
        }
        return mark
      },
      onCleanup(fn) { if (typeof fn === 'function') cleanups.push(fn) },
    }
    let result
    try {
      const value = await item.task(ctx)
      result = { commandId: item.commandId, dispatched, code: null, value }
      receipt(item, 'finished', { steps: token.steps })
    } catch (error) {
      if (error instanceof HostLeaseBlocked) {
        result = { commandId: item.commandId, dispatched, code: error.code, value: null }
        receipt(item, dispatched ? 'preempted' : 'not-dispatched', { code: error.code, steps: token.steps })
      } else {
        // EG-01: once an event may have gone out, a failure is an unknown
        // outcome, never a retry.
        const code = dispatched ? 'HOST_ACTION_OUTCOME_UNKNOWN' : 'HOST_ACTION_FAILED'
        result = { commandId: item.commandId, dispatched: dispatched ? 'unknown' : false, code, value: null }
        receipt(item, dispatched ? 'unknown' : 'not-dispatched', { code, steps: token.steps })
      }
    } finally {
      if (cleanups.length) {
        let released = 0
        for (const fn of cleanups.reverse()) {
          try { await fn(); released += 1 } catch {}
        }
        receipt(item, 'cleanup', { released, total: cleanups.length })
      }
      end(token)
    }
    return result
  }

  function pump(key) {
    const entry = lanes.get(key)
    if (!entry || entry.running) return
    if (!entry.queue.length) { lanes.delete(key); return }
    const item = entry.queue.shift()
    // Running is marked before the task starts, so a stop raised from inside
    // the task's first synchronous step still waits for its cleanup.
    let finish
    const done = new Promise(resolve => { finish = resolve })
    entry.running = { item, done }
    execute(item).then(result => { item.settle(result); finish() })
    done.then(() => { entry.running = null; pump(key) })
  }

  function run(name, { target = null, args = null, deadlineMs = null, commandId = null } = {}, task) {
    if (typeof task !== 'function') throw new TypeError('run needs a task function')
    const seq = ++commandSeq
    const item = {
      name,
      target,
      args,
      deadlineMs,
      commandId: typeof commandId === 'string' && /^[\w.:-]{1,128}$/.test(commandId) ? commandId : `cmd-${seq}`,
      seq,
      lane: hostLaneKey(target),
      pid: Number.isSafeInteger(target?.pid) && target.pid > 0 ? target.pid : null,
      task,
    }
    receipt(item, 'enqueued')
    if (!requiresHostControl(name, { policy, args })) return execute(item)
    return new Promise(resolve => {
      item.settle = resolve
      const key = item.lane ?? ''
      let entry = lanes.get(key)
      if (!entry) lanes.set(key, entry = { queue: [], running: null })
      entry.queue.push(item)
      pump(key)
    })
  }

  return { begin, checkpoint, end, run, observeInput, handBack, takeOver, stopApp, stopAll, revoke, setInputMonitor, status }
}
