import { spawn as spawnChild } from 'node:child_process'
import path from 'node:path'
import { TextDecoder } from 'node:util'

export const RUST_TERMINAL_LIMITS = Object.freeze({
  frameBytes: 128 * 1024, inputBytes: 64 * 1024,
  outputBytes: 256 * 1024, pendingRequests: 64,
})
const issue = (code, message, nativeCreated = null) => Object.assign(new Error(message), { code, nativeCreated })
const startupIssue = (message, nativeCreated = null) => issue(nativeCreated === false
  ? 'WINDOWS_PTY_UNAVAILABLE' : 'WINDOWS_SPAWN_UNCONFIRMED', message, nativeCreated)
const fullWindowsPath = value => typeof value === 'string' && path.win32.isAbsolute(value)
  && /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/i.test(value)
const dimensions = (cols, rows) => Number.isSafeInteger(cols) && cols >= 2 && cols <= 1000
  && Number.isSafeInteger(rows) && rows >= 1 && rows <= 1000
const boundedTime = value => Number.isSafeInteger(value) && value >= 1 && value <= 120000
const encodeFrame = value => {
  const frame = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(frame, 'utf8') > RUST_TERMINAL_LIMITS.frameBytes) {
    throw issue('TERMINAL_RUST_FRAME_LIMIT', 'Encoded terminal protocol frame exceeds its byte limit')
  }
  return frame
}

// Experimental only: importing this module never starts a process. The caller
// names a built absolute executable; no PATH lookup, shell wrapper or download.
// A Rust child.wait receipt is distinct from node-pty's native onExit callback.
export function createRustWindowsPtyProcess({
  executable, shellId, cwd, cols, rows, env, powerShellInitialization = null,
  spawnDriver = spawnChild, startupTimeoutMs = 10000, requestTimeoutMs = 5000,
  driverCloseTimeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (!fullWindowsPath(executable)
    || executable.length > 4096 || /[\0\r\n]/.test(executable)
    || path.win32.extname(executable).toLowerCase() !== '.exe'
    || !['powershell', 'cmd'].includes(shellId)
    || !fullWindowsPath(cwd) || /[\0\r\n]/.test(cwd)
    || !dimensions(cols, rows)
    || !env || typeof env !== 'object' || Array.isArray(env)
    || Object.values(env).some(value => typeof value !== 'string')
    || ![startupTimeoutMs, requestTimeoutMs, driverCloseTimeoutMs].every(boundedTime)
    || (powerShellInitialization !== null && (typeof powerShellInitialization !== 'string'
      || powerShellInitialization.length > 16384 || powerShellInitialization.includes('\0')))) {
    return Promise.reject(issue('INVALID_TERMINAL_RUST_CONFIG', 'Invalid explicit Rust terminal configuration', false))
  }
  let initialization
  try {
    initialization = encodeFrame({ v: 1, type: 'init', shellId, cwd, cols, rows, env, powerShellInitialization })
  } catch (error) { error.nativeCreated = false; return Promise.reject(error) }

  let child
  try {
    child = spawnDriver(executable, ['--stdio-worker'], {
      cwd, env: { ...env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch { return Promise.reject(startupIssue('The owned Rust terminal executable could not start', false)) }

  const dataListeners = new Set(), exitListeners = new Set(), errorListeners = new Set(), pending = new Map()
  let ready = false, closed = false, faulted = false, forcedStop = false, stopping = false
  let nativeExit = null, exitReceipt = null, lastError = null, noNativeClaim = false, observedNativeOutput = false
  let driverCloseTimer = null, nextRequest = 0, bufferedLine = Buffer.alloc(0)
  let retainedOutput = Buffer.alloc(0), truncated = false, driverInfo = null
  let resolveStart, rejectStart
  const start = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject })
  const cancelPending = error => {
    for (const entry of pending.values()) { clearTimer(entry.timer); entry.reject(error) }
    pending.clear()
  }
  const stopOwnedDriver = () => {
    if (closed || forcedStop) return
    forcedStop = true
    try { child.kill() } catch { /* Only this owned ChildProcess is eligible. */ }
  }
  const report = error => {
    if (closed && exitReceipt) return
    faulted = true
    lastError = error
    if (!ready) rejectStart(error)
    cancelPending(error)
    for (const listener of [...errorListeners]) listener(error)
  }
  const armCloseDeadline = () => {
    if (closed || driverCloseTimer) return
    driverCloseTimer = setTimer(() => {
      if (closed) return
      report(ready
        ? issue('TERMINAL_RUST_EXIT_UNCONFIRMED', 'Rust terminal driver did not close within its cleanup deadline', true)
        : startupIssue('Rust terminal driver cleanup was not observed'))
      stopOwnedDriver()
    }, driverCloseTimeoutMs)
    driverCloseTimer?.unref?.()
  }
  const protocolFailure = () => {
    if (closed || faulted) return
    report(ready
      ? issue('TERMINAL_RUST_PROTOCOL', 'Rust terminal protocol is invalid', true)
      : startupIssue('Rust terminal startup protocol is invalid'))
    clearTimer(startupTimer)
    stopOwnedDriver()
  }
  const startupTimer = setTimer(() => {
    report(startupIssue('Rust terminal startup was not confirmed before its deadline'))
    stopOwnedDriver()
  }, startupTimeoutMs)
  startupTimer?.unref?.()

  const subscribe = (listeners, listener, replay) => {
    if (typeof listener !== 'function') throw new TypeError('A terminal listener is required')
    listeners.add(listener)
    if (replay != null) queueMicrotask(() => { if (listeners.has(listener)) listener(replay) })
    return { dispose: () => listeners.delete(listener) }
  }
  const request = (type, payload = {}) => {
    if (!ready || closed || forcedStop || nativeExit || child.stdin?.destroyed
      || (faulted && type !== 'kill') || (stopping && type !== 'kill')) {
      return Promise.reject(issue('TERMINAL_RUST_DRIVER_CLOSED', 'Rust terminal driver is no longer accepting input', ready ? true : null))
    }
    if (pending.size >= RUST_TERMINAL_LIMITS.pendingRequests) {
      return Promise.reject(issue('TERMINAL_RUST_DRIVER_BUSY', 'Rust terminal request limit reached', true))
    }
    let frame
    const requestId = 'rust-terminal-' + (++nextRequest)
    try { frame = encodeFrame({ v: 1, type, requestId, ...payload }) } catch (error) { return Promise.reject(error) }
    if (type === 'kill') stopping = true
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(requestId)
        const error = issue('TERMINAL_RUST_DRIVER_TIMEOUT', 'Rust native terminal operation was not confirmed', true)
        reject(error)
        if (type === 'kill') { report(error); stopOwnedDriver() }
      }, requestTimeoutMs)
      timer?.unref?.()
      pending.set(requestId, { type, timer, resolve, reject })
      try {
        // write(false) is buffered backpressure, not a request to resend. The
        // frame has one owner and one deadline; ACK is still required.
        child.stdin.write(frame, 'utf8', error => {
          if (!error || closed) return
          report(issue('TERMINAL_RUST_DRIVER_CLOSED', 'Rust terminal input transport failed', true))
          stopOwnedDriver()
        })
      } catch {
        report(issue('TERMINAL_RUST_DRIVER_CLOSED', 'Rust terminal input transport failed', true))
        stopOwnedDriver()
      }
    })
  }
  let pendingKill = null
  const api = {
    requiresDriverExitReceipt: true,
    get pid() { return child.pid },
    get nativeShellPid() { return driverInfo?.nativeShellPid ?? null },
    get driverInfo() { return driverInfo ? { ...driverInfo, ...(driverInfo.args ? { args: [...driverInfo.args] } : {}) } : null },
    get outputTruncated() { return truncated },
    onData(listener) {
      const subscription = subscribe(dataListeners, listener)
      if (retainedOutput.length) {
        const data = retainedOutput.toString('utf8'); retainedOutput = Buffer.alloc(0); listener(data)
      }
      return subscription
    },
    onExit: listener => subscribe(exitListeners, listener, exitReceipt),
    onError: listener => subscribe(errorListeners, listener, lastError),
    write: data => typeof data === 'string' && Buffer.byteLength(data, 'utf8') <= RUST_TERMINAL_LIMITS.inputBytes
      && Buffer.from(data, 'utf8').toString('utf8') === data
      ? request('write', { data }) : Promise.reject(issue('INVALID_TERMINAL_INPUT', 'Terminal input must be bounded UTF-8 text', true)),
    resize: (cols, rows) => dimensions(cols, rows)
      ? request('resize', { cols, rows }) : Promise.reject(issue('INVALID_TERMINAL_SIZE', 'Invalid terminal dimensions', true)),
    kill() {
      if (nativeExit) return Promise.resolve(true)
      if (pendingKill) return pendingKill
      pendingKill = request('kill')
      // A rejected stop can be retried only by another explicit caller.
      void pendingKill.catch(() => { pendingKill = null })
      return pendingKill
    },
  }

  const acceptOutput = data => {
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > RUST_TERMINAL_LIMITS.inputBytes
      || Buffer.from(data, 'utf8').toString('utf8') !== data || nativeExit) return protocolFailure()
    observedNativeOutput = true
    if (dataListeners.size) {
      for (const listener of [...dataListeners]) listener(data)
    } else {
      const all = Buffer.concat([retainedOutput, Buffer.from(data, 'utf8')])
      let offset = Math.max(0, all.length - RUST_TERMINAL_LIMITS.outputBytes)
      truncated ||= offset > 0
      while (offset < all.length && (all[offset] & 0xc0) === 0x80) offset++
      retainedOutput = Buffer.from(all.subarray(offset))
    }
  }
  const onMessage = message => {
    if (closed || faulted) return
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.v !== 1 || typeof message.type !== 'string') {
      protocolFailure(); return
    }
    if (noNativeClaim) { protocolFailure(); return }
    if (message.type === 'ready') {
      if (ready || message.transport !== 'conpty' || message.usePty !== true || message.shellId !== shellId
        || !(message.pid === null || (Number.isSafeInteger(message.pid) && message.pid > 0))
        || (message.shell !== undefined && (typeof message.shell !== 'string' || message.shell.length > 4096))
        || (message.args !== undefined && (!Array.isArray(message.args) || message.args.length > 32
          || message.args.some(value => typeof value !== 'string' || value.length > 16384)))
        || (message.debugAssertions !== undefined && typeof message.debugAssertions !== 'boolean')
        || ['implementation', 'version'].some(key => message[key] !== undefined
          && (typeof message[key] !== 'string' || message[key].length > 80))) {
        protocolFailure(); return
      }
      ready = true
      driverInfo = { executable, shellId, nativeShellPid: message.pid,
        ...(message.shell === undefined ? {} : { shell: message.shell }),
        ...(message.args === undefined ? {} : { args: [...message.args] }),
        ...(message.debugAssertions === undefined ? {} : { debugAssertions: message.debugAssertions }),
        ...(message.implementation === undefined ? {} : { implementation: message.implementation }),
        ...(message.version === undefined ? {} : { version: message.version }) }
      clearTimer(startupTimer); resolveStart(api)
    } else if (message.type === 'output') acceptOutput(message.data)
    else if (message.type === 'ack') {
      if (typeof message.requestId !== 'string' || message.requestId.length > 160 || typeof message.ok !== 'boolean') {
        protocolFailure(); return
      }
      const entry = pending.get(message.requestId)
      if (!entry) return // Timed-out and duplicate ACKs never trigger a resend.
      clearTimer(entry.timer); pending.delete(message.requestId)
      if (message.ok) {
        if (entry.type === 'kill') armCloseDeadline()
        entry.resolve(true)
      } else {
        if (entry.type === 'kill') stopping = false
        entry.reject(issue('TERMINAL_NATIVE_OPERATION_FAILED', 'Rust native terminal rejected the operation', true))
      }
    } else if (message.type === 'native-exit') {
      if (!ready || nativeExit || message.nativeWaitConfirmed !== true
        || message.exitSource !== 'conpty-rust.native-wait'
        || !Number.isInteger(message.exitCode) || message.exitCode < 0 || message.exitCode > 0xffffffff
        || message.signal !== null) { protocolFailure(); return }
      nativeExit = { exitCode: message.exitCode, signal: null }
      cancelPending(issue('TERMINAL_RUST_DRIVER_CLOSED', 'Native terminal has exited', true))
      armCloseDeadline()
    } else if (message.type === 'spawn-error') {
      clearTimer(startupTimer)
      if (!ready && message.nativeCreated === false && observedNativeOutput) { protocolFailure(); return }
      if (!ready && message.nativeCreated === false) {
        // Wait for owned-driver close before treating this as definite: a
        // contradictory late ready/output/native-exit cannot revoke a promise
        // that has already told its caller that no native process existed.
        noNativeClaim = true
        armCloseDeadline()
      } else {
        report(startupIssue('Rust native terminal creation was not confirmed', ready ? true : null))
        armCloseDeadline()
      }
    } else if (message.type === 'runtime-error') {
      report(issue('TERMINAL_RUST_DRIVER_ERROR', 'Rust terminal driver reported a native error', true))
      armCloseDeadline()
    } else protocolFailure()
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })
  child.stdout.on('data', chunk => {
    if (closed || faulted) return
    if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') return protocolFailure()
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    let offset = 0
    while (offset < bytes.length && !closed && !faulted) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline
      const segment = bytes.subarray(offset, end)
      if (bufferedLine.length + segment.length + 1 > RUST_TERMINAL_LIMITS.frameBytes) return protocolFailure()
      bufferedLine = Buffer.concat([bufferedLine, segment])
      if (newline < 0) break
      let message
      try {
        const line = bufferedLine.length && bufferedLine.at(-1) === 13 ? bufferedLine.subarray(0, -1) : bufferedLine
        message = JSON.parse(decoder.decode(line))
      } catch { protocolFailure(); return }
      bufferedLine = Buffer.alloc(0)
      onMessage(message)
      offset = newline + 1
    }
  })
  child.stdout.once('end', () => {
    if (closed) return
    if (bufferedLine.length) protocolFailure()
    else if (!nativeExit && !noNativeClaim && !faulted) report(ready
      ? issue('TERMINAL_RUST_EXIT_UNCONFIRMED', 'Rust driver output ended without native wait evidence', true)
      : startupIssue('Rust driver output ended during startup'))
    armCloseDeadline()
  })
  child.stdout.once('error', () => { if (!closed) { protocolFailure() } })
  child.stderr?.on('data', () => { /* Drain diagnostics; never retain unbounded or private stderr. */ })
  child.stderr?.once('error', () => {
    if (!closed) { report(issue('TERMINAL_RUST_DRIVER_ERROR', 'Rust driver diagnostic stream failed', ready ? true : null)); armCloseDeadline() }
  })
  child.stdin.once('error', () => {
    if (closed) return
    report(ready ? issue('TERMINAL_RUST_DRIVER_CLOSED', 'Rust terminal input stream failed', true)
      : startupIssue('Rust terminal initialization transport failed', Number.isInteger(child.pid) ? null : false))
    stopOwnedDriver()
  })
  child.once('error', () => {
    if (closed) return
    clearTimer(startupTimer)
    report(ready ? issue('TERMINAL_RUST_DRIVER_ERROR', 'The owned Rust terminal driver failed', true)
      : startupIssue('The owned Rust terminal driver could not start', Number.isInteger(child.pid) ? null : false))
    stopOwnedDriver()
  })
  child.once('close', (driverExitCode, driverExitSignal) => {
    if (closed) return
    closed = true; clearTimer(startupTimer)
    if (driverCloseTimer) clearTimer(driverCloseTimer)
    cancelPending(issue('TERMINAL_RUST_DRIVER_CLOSED', 'Rust terminal driver closed', ready ? true : null))
    if (nativeExit && ready && !faulted && !forcedStop && driverExitCode === 0 && driverExitSignal == null) {
      exitReceipt = { ...nativeExit, exitSource: 'conpty-rust.native-wait',
        nativeWaitConfirmed: true, driverCloseConfirmed: true, driverExitCode: 0, driverExitSignal: null }
      for (const listener of [...exitListeners]) listener(exitReceipt)
    } else if (!ready && noNativeClaim && !faulted && !forcedStop
      && (driverExitCode === 0 || driverExitCode === 1) && driverExitSignal == null) {
      rejectStart(startupIssue('Rust confirmed that no native terminal was created', false))
    } else if (!lastError) {
      report(ready
        ? issue('TERMINAL_RUST_EXIT_UNCONFIRMED', 'Rust driver closed without complete native-wait and cleanup evidence', true)
        : startupIssue('Rust driver closed before native creation was established'))
    }
  })
  try {
    child.stdin.write(initialization, 'utf8', error => {
      if (!error || closed) return
      report(startupIssue('Rust terminal initialization could not be delivered', Number.isInteger(child.pid) ? null : false))
      stopOwnedDriver()
    })
  } catch {
    report(startupIssue('Rust terminal initialization could not be delivered', Number.isInteger(child.pid) ? null : false))
    stopOwnedDriver()
  }
  return start
}
