// Runs and supervises `egdesk-helper host-observe` (helper-rust/src/host/),
// EG-Desk's own Mac host helper in its observation-only first stage (owner
// decisions 2026-10-24 D-C1: Rust, merged with the RT-04 helper; D-C4:
// observe first, no OS input). docs/references/rea-mechanism-adoption.md
// 4장 맥1 (process, socket, nonce) and 맥10 (observation feed).
//
// Patterns only, no code: trycua/cua libs/cua-driver/rust (MIT)
// crates/cua-driver/src/serve.rs (peer uid, stdin EOF ends the helper) and
// open-computer-use (MIT) MacOSAppAgentProxy.swift (socket 0600, the
// launcher reconnects to a fresh agent instead of reusing a stale one).
//
// What it does:
// - Spawns the built helper by absolute path (no PATH lookup, no shell),
//   hands it a per-run nonce on stdin and keeps stdin open (EOF = parent
//   gone), connects to the Unix socket the helper binds inside a 0700
//   directory, says hello with the nonce and pings every heartbeatMs.
// - A helper that exits, goes silent or breaks the protocol is replaced
//   with exponential backoff; after restart.maxFailures failures in a row it
//   stops trying (state 'failed'). Nothing is retried on the helper's behalf
//   and no input is ever sent: the helper has no input request.
// - Observation events become onEvent({ type: 'host.event', ... }) stamped
//   with `now` (Date.now by default — the clock codex-chat-runtime stamps
//   computer.used lastAt with), mapped from the helper's monotonic monoMs.
// - guardAlive() and attachLease() are where egdesk-host-lease.mjs connects:
//   createHostLease({ guardAlive: agent.guardAlive }) then
//   agent.attachLease(lease). Input monitoring is the next stage, so the
//   lease's input monitor stays false (the lease stays 'unavailable'/monitor).
import { spawn as spawnChild } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

export const HOST_AGENT_STATES = Object.freeze(['idle', 'starting', 'ready', 'restarting', 'stopped', 'failed'])
export const HOST_AGENT_REQUESTS = Object.freeze(['snapshot', 'listApps', 'listWindows', 'permissions', 'service'])
// B1 (flag EGDESK_COMPUTER_OBSERVE, option observeContent): one window's pixels with sensitive fields masked, and that window's accessibility
// elements. The helper answers them only when started with --observe-content (otherwise observe_only).
export const HOST_AGENT_CONTENT_REQUESTS = Object.freeze(['capture', 'readElements'])
const WINDOW_ID_MAX = 2 ** 32 - 1
export const HOST_AGENT_EVENTS = Object.freeze(['app.activated', 'service.changed'])
// Observation stage: there is no input monitor in the helper yet.
export const HOST_AGENT_INPUT_MONITOR = false
export const HOST_AGENT_LIMITS = Object.freeze({
  inboundLineBytes: 1024 * 1024, outboundLineBytes: 16 * 1024,
  readyLineBytes: 4096, pendingRequests: 32, stderrTailBytes: 2048,
})
export const HOST_AGENT_CODES = Object.freeze({
  UNSUPPORTED: 'HOST_AGENT_UNSUPPORTED', // not macOS
  EXECUTABLE: 'HOST_AGENT_EXECUTABLE', // no usable built helper
  SOCKET_PATH: 'HOST_AGENT_SOCKET_PATH',
  START_FAILED: 'HOST_AGENT_START_FAILED',
  NOT_READY: 'HOST_AGENT_NOT_READY',
  BUSY: 'HOST_AGENT_BUSY',
  TIMEOUT: 'HOST_AGENT_TIMEOUT',
  DISCONNECTED: 'HOST_AGENT_DISCONNECTED',
  REFUSED: 'HOST_AGENT_REFUSED', // the helper answered ok:false (e.g. observe_only)
  INVALID_REQUEST: 'HOST_AGENT_INVALID_REQUEST',
  STOPPED: 'HOST_AGENT_STOPPED',
  FAILED: 'HOST_AGENT_FAILED', // gave up after restart.maxFailures
})
const CODES = HOST_AGENT_CODES
const MAX_SOCKET_PATH_BYTES = 103 // macOS sun_path is 104 bytes with the NUL
const issue = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra })
const boundedMs = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const HELPER_RUST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'helper-rust')

/**
 * The helper binary to run: an explicit absolute path, or the cargo build in
 * helper-rust/target/<profile>/egdesk-helper. Never a PATH lookup.
 */
export function resolveHostAgentExecutable({ executable = null, helperRustDir = HELPER_RUST_DIR, profile = 'debug', platform = process.platform, fsImpl = fs } = {}) {
  if (platform !== 'darwin') throw issue(CODES.UNSUPPORTED, 'The Mac host helper runs on macOS only')
  if (!['debug', 'release'].includes(profile)) throw issue(CODES.EXECUTABLE, 'Unknown helper build profile')
  const candidate = executable ?? path.join(helperRustDir, 'target', profile, 'egdesk-helper')
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.length > 4096 || /[\0\r\n]/.test(candidate)) {
    throw issue(CODES.EXECUTABLE, 'The helper executable must be an absolute path')
  }
  let stat
  try { stat = fsImpl.statSync(candidate) } catch { throw issue(CODES.EXECUTABLE, 'The helper executable is not built') }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw issue(CODES.EXECUTABLE, 'The helper executable is not a runnable file')
  return candidate
}

/** A fresh 0700 directory (mkdtemp) under os.tmpdir() and the socket path in it. */
export function createSocketDirectory({ base = os.tmpdir(), fsImpl = fs, getuid = process.getuid } = {}) {
  const dir = fsImpl.mkdtempSync(path.join(base, 'egdesk-host-'))
  const cleanup = () => {
    try { fsImpl.unlinkSync(socketPath) } catch {}
    try { fsImpl.rmdirSync(dir) } catch {}
  }
  const socketPath = path.join(dir, 'host.sock')
  try {
    fsImpl.chmodSync(dir, 0o700)
    const stat = fsImpl.lstatSync(dir)
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (typeof getuid === 'function' && stat.uid !== getuid())) {
      throw issue(CODES.SOCKET_PATH, 'The socket directory is not private')
    }
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw issue(CODES.SOCKET_PATH, 'The socket path is too long')
  } catch (error) {
    cleanup()
    throw error.code ? error : issue(CODES.SOCKET_PATH, 'The socket directory could not be prepared')
  }
  return { dir, socketPath, cleanup }
}

const minimalEnv = source => Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'USER']
  .filter(name => typeof source[name] === 'string').map(name => [name, source[name]])
  .concat([['PATH', '/usr/bin:/bin:/usr/sbin:/sbin']]))

// Splits a byte stream into '\n' lines; false when a line outgrows `limit`.
function lineSplitter(limit, onLine) {
  let pending = Buffer.alloc(0)
  return chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
    let index
    while ((index = pending.indexOf(0x0a)) >= 0) {
      const line = pending.subarray(0, index).toString('utf8').replace(/\r$/, '')
      pending = pending.subarray(index + 1)
      if (line && onLine(line) === false) return false
    }
    return pending.length <= limit
  }
}

const parseJson = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch { return null } }

/**
 * createHostAgent({ executable, ... }) → { start, stop, request, snapshot,
 * listApps, listWindows, permissions, service, status, guardAlive, attachLease }.
 * start() resolves with status() once a helper is ready and rejects when the
 * agent stops or gives up. onEvent receives:
 *   { type: 'host.state', state, attempt, failures, code, at }
 *   { type: 'host.event', event: 'app.activated', app: { bundleId, pid, name }, at, seq }
 *   { type: 'host.event', event: 'service.changed', service: { bundleId, running, pids }, at, seq }
 */
export function createHostAgent({
  executable,
  spawnDriver = spawnChild,
  connect = socketPath => createConnection(socketPath),
  makeSocketDirectory = () => createSocketDirectory(),
  makeNonce = () => randomBytes(32).toString('hex'),
  now = Date.now,
  monotonic = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  heartbeatMs = 1000,
  heartbeatTimeoutMs = 5000,
  startupTimeoutMs = 10_000,
  requestTimeoutMs = 5000,
  stopTimeoutMs = 3000,
  restart = {},
  env = process.env,
  onEvent = () => {},
  observeContent = false,
} = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) {
    throw issue(CODES.EXECUTABLE, 'createHostAgent needs the absolute helper path from resolveHostAgentExecutable()')
  }
  const backoff = { baseMs: 500, maxMs: 30_000, maxFailures: 6, stableMs: 60_000, ...restart }
  if (!boundedMs(heartbeatMs, 100, 30_000) || !boundedMs(heartbeatTimeoutMs, 500, 60_000) || heartbeatTimeoutMs <= heartbeatMs
    || !boundedMs(startupTimeoutMs, 500, 120_000) || !boundedMs(requestTimeoutMs, 100, 120_000) || !boundedMs(stopTimeoutMs, 100, 60_000)
    || !boundedMs(backoff.baseMs, 1, 600_000) || !boundedMs(backoff.maxMs, backoff.baseMs, 600_000)
    || !boundedMs(backoff.maxFailures, 1, 1000) || !boundedMs(backoff.stableMs, 0, 3_600_000)) {
    throw new TypeError('Invalid host agent timing')
  }

  let state = 'idle', attempt = 0, failures = 0, lastCode = null, stopping = false
  let current = null, restartTimer = null, requestSeq = 0
  let startWaiters = []
  const leases = new Set()
  const emit = event => { try { onEvent(event) } catch {} }
  const refreshLeases = () => {
    for (const lease of leases) {
      try { lease.setInputMonitor(HOST_AGENT_INPUT_MONITOR); lease.status() } catch {}
    }
  }
  const setState = (next, code = null) => {
    if (code) lastCode = code
    if (next === state) return
    state = next
    emit({ type: 'host.state', state, attempt, failures, code: lastCode, at: now() })
    refreshLeases()
    if (next === 'ready') for (const waiter of startWaiters.splice(0)) waiter.resolve(status())
    if (next === 'stopped' || next === 'failed') {
      const error = issue(next === 'stopped' ? CODES.STOPPED : CODES.FAILED, `The host helper ${next}`, { lastCode })
      for (const waiter of startWaiters.splice(0)) waiter.reject(error)
    }
  }

  function status() {
    const gen = current
    return {
      state, attempt, failures, code: lastCode,
      pid: gen?.helperPid ?? null,
      alive: guardAlive(),
      inputMonitor: HOST_AGENT_INPUT_MONITOR,
      mode: 'observe',
      stderrTail: gen?.stderrTail ?? '',
    }
  }

  function guardAlive() {
    const gen = current
    return Boolean(gen && state === 'ready' && gen.authenticated && monotonic() - gen.lastHeardAt < heartbeatTimeoutMs)
  }

  function attachLease(lease) {
    if (!lease || typeof lease.setInputMonitor !== 'function' || typeof lease.status !== 'function') {
      throw new TypeError('attachLease needs a lease from createHostLease()')
    }
    leases.add(lease)
    refreshLeases()
    // Next stage (맥6): an 'input.observed' helper event will call
    // lease.observeInput({ kind, mark, distance, held }) here, and
    // setInputMonitor(true) only while the helper's event tap is live.
    return () => { leases.delete(lease) }
  }

  // Helper monoMs → our clock: offset = now - monoMs, best estimate kept from
  // the lowest ping round trip; never in the future.
  const stamp = (gen, monoMs) => {
    if (!Number.isFinite(monoMs) || gen.offset === null) return now()
    return Math.min(now(), Math.round(gen.offset + monoMs))
  }

  function writeLine(gen, value) {
    if (!gen.socket || gen.socket.destroyed) return false
    const line = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(line) > HOST_AGENT_LIMITS.outboundLineBytes) return false
    try { gen.socket.write(line); return true } catch { return false }
  }

  function endGeneration(gen, code) {
    if (gen.ended) return
    gen.ended = true
    for (const timer of [gen.startupTimer, gen.heartbeatTimer]) if (timer) clearTimer(timer)
    for (const entry of gen.pending.values()) { clearTimer(entry.timer); entry.reject(issue(CODES.DISCONNECTED, 'The host helper connection ended', { helperCode: code })) }
    gen.pending.clear()
    try { gen.socket?.destroy() } catch {}
    try { gen.child?.stdin?.end() } catch {}
    if (gen.child && !gen.exited) {
      // Our own child only; give it stopTimeoutMs to leave on stdin EOF.
      gen.killTimer = setTimer(() => { if (!gen.exited) { try { gen.child.kill('SIGKILL') } catch {} } }, stopTimeoutMs)
      gen.killTimer?.unref?.()
    }
    // A child that is still running removes its socket; the directory goes on exit.
    if (gen.exited || !gen.child) gen.directory?.cleanup()
    if (current !== gen) return
    const wasReady = gen.authenticated
    const stable = wasReady && monotonic() - gen.readyAt >= backoff.stableMs
    current = null
    if (stopping) return
    failures = stable ? 1 : failures + 1
    lastCode = code
    if (failures >= backoff.maxFailures) { setState('failed', code); return }
    setState('restarting', code)
    const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (failures - 1))
    restartTimer = setTimer(() => { restartTimer = null; if (!stopping) launch() }, delay)
    restartTimer?.unref?.()
  }

  function handleLine(gen, line) {
    if (current !== gen || gen.ended) return false
    const message = parseJson(line)
    if (!message) { endGeneration(gen, 'protocol'); return false }
    gen.lastHeardAt = monotonic()
    if (!gen.authenticated) {
      if (message.type === 'hello.ok' && message.v === 1 && message.mode === 'observe'
        && message.capabilities?.input === false && Number.isFinite(message.monoMs)) {
        gen.authenticated = true
        gen.readyAt = monotonic()
        gen.offset = now() - message.monoMs
        gen.helperPid = Number.isSafeInteger(message.pid) ? message.pid : gen.helperPid
        clearTimer(gen.startupTimer)
        gen.startupTimer = null
        scheduleHeartbeat(gen)
        setState('ready')
        return true
      }
      endGeneration(gen, message.type === 'hello.rejected' ? `rejected:${String(message.code).slice(0, 32)}` : 'protocol')
      return false
    }
    if (message.type === 'pong') {
      const sentAt = gen.pings.get(message.seq)
      gen.pings.delete(message.seq)
      if (sentAt !== undefined && Number.isFinite(message.monoMs)) {
        const rtt = monotonic() - sentAt
        if (rtt <= gen.bestRtt) { gen.bestRtt = rtt; gen.offset = now() - rtt / 2 - message.monoMs }
      }
      return true
    }
    if (message.type === 'event') {
      const at = stamp(gen, message.monoMs)
      const seq = Number.isSafeInteger(message.seq) ? message.seq : null
      if (message.event === 'app.activated' && message.app && typeof message.app === 'object') {
        emit({ type: 'host.event', event: 'app.activated', app: publicApp(message.app), at, seq })
      } else if (message.event === 'service.changed' && message.service && typeof message.service === 'object') {
        emit({ type: 'host.event', event: 'service.changed', service: publicService(message.service), at, seq })
      }
      return true
    }
    if (message.type === 'result' && typeof message.id === 'string') {
      const entry = gen.pending.get(message.id)
      if (!entry) return true
      gen.pending.delete(message.id)
      clearTimer(entry.timer)
      if (message.ok === true) entry.resolve(message.result ?? null)
      else entry.reject(issue(CODES.REFUSED, 'The host helper refused the request', { helperCode: typeof message.code === 'string' ? message.code.slice(0, 64) : null,
        helperMessage: typeof message.message === 'string' ? message.message.slice(0, 200) : null }))
      return true
    }
    return true
  }

  function scheduleHeartbeat(gen) {
    gen.heartbeatTimer = setTimer(() => {
      gen.heartbeatTimer = null
      if (gen.ended || current !== gen) return
      if (monotonic() - gen.lastHeardAt >= heartbeatTimeoutMs) { endGeneration(gen, 'heartbeat-lost'); return }
      const seq = ++gen.pingSeq
      gen.pings.set(seq, monotonic())
      if (gen.pings.size > 16) gen.pings.delete(gen.pings.keys().next().value)
      if (!writeLine(gen, { type: 'ping', seq })) { endGeneration(gen, 'write-failed'); return }
      scheduleHeartbeat(gen)
    }, heartbeatMs)
    gen.heartbeatTimer?.unref?.()
  }

  function connectSocket(gen) {
    let socket
    try { socket = connect(gen.directory.socketPath) } catch { endGeneration(gen, 'connect-failed'); return }
    gen.socket = socket
    const feed = lineSplitter(HOST_AGENT_LIMITS.inboundLineBytes, line => handleLine(gen, line))
    socket.on('connect', () => {
      if (current !== gen || gen.ended) return
      if (!writeLine(gen, { type: 'hello', v: 1, nonce: gen.nonce })) endGeneration(gen, 'write-failed')
    })
    socket.on('data', chunk => { if (current === gen && !gen.ended && !feed(chunk)) endGeneration(gen, 'protocol') })
    socket.on('error', () => endGeneration(gen, 'socket-error'))
    socket.on('close', () => endGeneration(gen, 'socket-closed'))
  }

  function launch() {
    attempt += 1
    if (state !== 'restarting') setState('starting')
    const gen = {
      child: null, socket: null, directory: null, nonce: null, ended: false, exited: false,
      authenticated: false, readyAt: 0, lastHeardAt: monotonic(), offset: null, bestRtt: Infinity,
      pending: new Map(), pings: new Map(), pingSeq: 0, helperPid: null, stderrTail: '',
      startupTimer: null, heartbeatTimer: null, killTimer: null,
    }
    current = gen
    try {
      gen.directory = makeSocketDirectory()
      gen.nonce = makeNonce()
    } catch (error) { endGeneration(gen, error?.code || CODES.SOCKET_PATH); return }
    const args = ['host-observe', '--socket', gen.directory.socketPath,
      '--heartbeat-timeout-ms', String(heartbeatTimeoutMs), '--connect-timeout-ms', String(startupTimeoutMs),
      ...(observeContent === true ? ['--observe-content'] : [])]
    try {
      gen.child = spawnDriver(executable, args, { cwd: '/', env: minimalEnv(env), shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch { endGeneration(gen, 'spawn-failed'); return }
    gen.helperPid = Number.isSafeInteger(gen.child.pid) ? gen.child.pid : null
    gen.startupTimer = setTimer(() => { gen.startupTimer = null; endGeneration(gen, 'startup-timeout') }, startupTimeoutMs)
    gen.startupTimer?.unref?.()

    let readySeen = false, readyBytes = 0
    const readyFeed = lineSplitter(HOST_AGENT_LIMITS.readyLineBytes, line => {
      if (readySeen) return true
      readySeen = true
      const ready = parseJson(line)
      if (!ready || ready.v !== 1 || ready.type !== 'ready' || ready.socket !== gen.directory.socketPath) {
        endGeneration(gen, 'protocol'); return false
      }
      connectSocket(gen)
      return true
    })
    gen.child.stdout?.on('data', chunk => {
      if (readySeen || gen.ended) return
      readyBytes += chunk.length
      if (readyBytes > HOST_AGENT_LIMITS.readyLineBytes || !readyFeed(chunk)) endGeneration(gen, 'protocol')
    })
    gen.child.stderr?.on('data', chunk => {
      gen.stderrTail = (gen.stderrTail + chunk.toString('utf8')).slice(-HOST_AGENT_LIMITS.stderrTailBytes)
    })
    gen.child.stdin?.on?.('error', () => {})
    gen.child.on('error', () => { gen.exited = true; endGeneration(gen, 'spawn-failed'); gen.directory?.cleanup() })
    gen.child.on('exit', code => {
      gen.exited = true
      if (gen.killTimer) clearTimer(gen.killTimer)
      endGeneration(gen, Number.isInteger(code) ? `exited:${code}` : 'exited')
      gen.directory?.cleanup()
    })
    try { gen.child.stdin.write(JSON.stringify({ v: 1, nonce: gen.nonce }) + '\n') } catch { endGeneration(gen, 'write-failed') }
  }

  function start() {
    if (state === 'ready') return Promise.resolve(status())
    const waiting = new Promise((resolve, reject) => startWaiters.push({ resolve, reject }))
    if (state === 'idle' || state === 'stopped' || state === 'failed') {
      stopping = false
      failures = 0
      lastCode = null
      launch()
    }
    return waiting
  }

  // shutdown request first (the helper exits on it), then stdin EOF, then
  // SIGKILL for our own child after stopTimeoutMs.
  async function stop() {
    stopping = true
    if (restartTimer) { clearTimer(restartTimer); restartTimer = null }
    const gen = current
    if (gen && !gen.ended) {
      const exited = gen.child && !gen.exited ? new Promise(resolve => gen.child.once('exit', resolve)) : null
      if (exited && gen.authenticated && writeLine(gen, { id: `r${++requestSeq}`, type: 'shutdown' })) {
        let timer
        await Promise.race([exited, new Promise(resolve => { timer = setTimer(resolve, stopTimeoutMs) })])
        clearTimer(timer)
      }
      current = null
      endGeneration(gen, 'stopped')
      if (exited) await exited
    }
    setState('stopped', 'stopped')
    return status()
  }

  function request(type, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
    const content = HOST_AGENT_CONTENT_REQUESTS.includes(type)
    if (!HOST_AGENT_REQUESTS.includes(type) && !(content && observeContent === true)) return Promise.reject(issue(CODES.INVALID_REQUEST, 'Unknown host helper request'))
    const frame = { type }
    if (content) {
      const ok = params != null && typeof params === 'object' && !Array.isArray(params)
        && Number.isSafeInteger(params.windowId) && params.windowId >= 0 && params.windowId <= WINDOW_ID_MAX
        && Number.isSafeInteger(params.pid) && params.pid > 0 && params.pid <= 2 ** 31 - 1
        && (type === 'capture' ? Object.keys(params).every(key => ['windowId', 'pid', 'maxEdge'].includes(key))
          && (params.maxEdge === undefined || (Number.isSafeInteger(params.maxEdge) && params.maxEdge >= 256 && params.maxEdge <= 2048))
          : Object.keys(params).every(key => ['windowId', 'pid'].includes(key)))
      if (!ok) return Promise.reject(issue(CODES.INVALID_REQUEST, `${type} takes { windowId, pid${type === 'capture' ? ', maxEdge?' : ''} } as integers`))
      Object.assign(frame, params)
    }
    if (type === 'listWindows') {
      if (params == null || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some(key => !['allLayers', 'titles'].includes(key))
        || Object.values(params).some(value => typeof value !== 'boolean')) {
        return Promise.reject(issue(CODES.INVALID_REQUEST, 'listWindows takes { allLayers, titles } booleans'))
      }
      Object.assign(frame, params)
    }
    const gen = current
    if (!gen || state !== 'ready' || !gen.authenticated || gen.ended) return Promise.reject(issue(CODES.NOT_READY, 'The host helper is not ready'))
    if (gen.pending.size >= HOST_AGENT_LIMITS.pendingRequests) return Promise.reject(issue(CODES.BUSY, 'Too many host helper requests in flight'))
    if (!boundedMs(timeoutMs, 100, 120_000)) return Promise.reject(issue(CODES.INVALID_REQUEST, 'Invalid request timeout'))
    const id = `r${++requestSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        if (gen.pending.delete(id)) reject(issue(CODES.TIMEOUT, 'The host helper did not answer in time'))
      }, timeoutMs)
      timer?.unref?.()
      gen.pending.set(id, { resolve, reject, timer })
      if (!writeLine(gen, { id, ...frame })) {
        gen.pending.delete(id)
        clearTimer(timer)
        reject(issue(CODES.DISCONNECTED, 'The host helper connection is closed'))
      }
    })
  }

  return {
    start, stop, request, status, guardAlive, attachLease,
    snapshot: options => request('snapshot', {}, options),
    listApps: options => request('listApps', {}, options),
    listWindows: (query = {}, options) => request('listWindows', query, options),
    permissions: options => request('permissions', {}, options),
    service: options => request('service', {}, options),
    capture: (query, options) => request('capture', query, options),
    readElements: (query, options) => request('readElements', query, options),
    /** Whether this agent was made to ask the helper for window content (the helper's hello.ok says the same in capabilities). */
    observesContent: observeContent === true,
  }
}

const BUNDLE_ID = /^[A-Za-z0-9.-]{1,255}$/
const boundedName = value => (typeof value === 'string' && value ? value.slice(0, 128) : null)
export function publicApp(app) {
  return {
    bundleId: typeof app?.bundleId === 'string' && BUNDLE_ID.test(app.bundleId) ? app.bundleId : null,
    pid: Number.isSafeInteger(app?.pid) && app.pid > 0 ? app.pid : null,
    name: boundedName(app?.name),
  }
}
export function publicService(service) {
  const pids = Array.isArray(service?.pids) ? service.pids.filter(pid => Number.isSafeInteger(pid) && pid > 0).slice(0, 16) : []
  return {
    bundleId: typeof service?.bundleId === 'string' && BUNDLE_ID.test(service.bundleId) ? service.bundleId : null,
    running: service?.running === true,
    pids,
  }
}
