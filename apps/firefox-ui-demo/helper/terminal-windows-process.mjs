import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const workerEntry = fileURLToPath(new URL('./terminal-pty-worker.mjs', import.meta.url))
const problem = (code, message, nativeCreated = null) => Object.assign(new Error(message), { code, nativeCreated })
const startupFailure = (message, nativeCreated = null) => problem(nativeCreated === false
  ? 'WINDOWS_PTY_UNAVAILABLE' : 'WINDOWS_SPAWN_UNCONFIRMED', message, nativeCreated)
const validNativeExit = message => Number.isInteger(message.exitCode)
  && Math.abs(message.exitCode) <= 0xffffffff
  && (message.signal == null || typeof message.signal === 'string' || Number.isInteger(message.signal))

export function workerEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'NODE_OPTIONS'))
}

// This adapter never loads a native PTY into the long-lived bridge process.
// A worker close is not a shell exit receipt. Both observations are required.
export function createWindowsPtyProcess({ shellId, cwd, cols, rows, env,
  powerShellInitialization = null, spawnWorker = fork,
  startupTimeoutMs = 10000, requestTimeoutMs = 5000, workerCloseTimeoutMs = 5000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!['powershell', 'cmd'].includes(shellId) || typeof cwd !== 'string' || !path.win32.isAbsolute(cwd)
    || !Number.isSafeInteger(cols) || cols < 2 || cols > 1000 || !Number.isSafeInteger(rows) || rows < 1 || rows > 1000
    || !env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')
    || (powerShellInitialization !== null && (typeof powerShellInitialization !== 'string'
      || powerShellInitialization.length > 16384 || powerShellInitialization.includes('\0')))) {
    return Promise.reject(problem('INVALID_TERMINAL_WORKER_CONFIG', 'Invalid trusted Windows terminal worker configuration', false))
  }
  let child
  try {
    child = spawnWorker(workerEntry, [], { execPath: process.execPath, execArgv: [],
      cwd, env: workerEnvironment(env), windowsHide: true,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'json' })
  } catch {
    return Promise.reject(startupFailure('The owned Windows terminal driver could not start', false))
  }
  const dataListeners = new Set(), exitListeners = new Set(), errorListeners = new Set()
  const pending = new Map()
  let ready = false, closed = false, startupFailed = false, nativeExit = null, exitReceipt = null, lastError = null
  let workerCloseTimer = null
  let buffer = Buffer.alloc(0), truncated = false, nextRequest = 0
  let resolveReady, rejectReady
  const start = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const rejectPending = error => {
    for (const entry of pending.values()) { clearTimer(entry.timer); entry.reject(error) }
    pending.clear()
  }
  const reportError = error => {
    lastError = error
    if (!ready) { startupFailed = true; rejectReady(error) }
    rejectPending(error)
    for (const listener of [...errorListeners]) listener(error)
  }
  const stopOwnedWorker = () => {
    // Only this ChildProcess instance was created here. Never signal a shell PID.
    if (!closed) try { child.kill() } catch {}
  }
  const armWorkerCloseWatchdog = () => {
    if (closed || workerCloseTimer) return
    workerCloseTimer = setTimer(() => {
      if (closed) return
      reportError(problem('TERMINAL_DRIVER_EXIT_UNCONFIRMED', 'Windows terminal driver did not close within its cleanup deadline', ready ? true : null))
      stopOwnedWorker()
    }, workerCloseTimeoutMs)
    workerCloseTimer?.unref?.()
  }
  const startupTimer = setTimer(() => {
    reportError(startupFailure('Windows terminal driver startup timed out'))
    stopOwnedWorker()
  }, startupTimeoutMs)
  startupTimer?.unref?.()
  const request = (type, payload = {}) => {
    if (closed || !ready || child.connected === false || nativeExit) {
      return Promise.reject(problem('TERMINAL_DRIVER_CLOSED', 'Windows terminal driver is no longer accepting input'))
    }
    if (pending.size >= 64) return Promise.reject(problem('TERMINAL_DRIVER_BUSY', 'Windows terminal driver request limit reached'))
    const requestId = 'terminal-worker-' + (++nextRequest)
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(requestId)
        const error = problem('TERMINAL_DRIVER_TIMEOUT', 'Native terminal operation was not confirmed', true)
        reject(error)
        if (type === 'kill') { reportError(error); stopOwnedWorker() }
      }, requestTimeoutMs)
      timer?.unref?.()
      pending.set(requestId, { timer, resolve, reject, type })
      try {
        child.send({ v: 1, type, requestId, ...payload }, error => {
          if (!error) return
          const entry = pending.get(requestId)
          if (!entry) return
          clearTimer(entry.timer); pending.delete(requestId)
          entry.reject(problem('TERMINAL_DRIVER_CLOSED', 'Native terminal operation could not reach its driver'))
        })
      } catch {
        clearTimer(timer); pending.delete(requestId)
        reject(problem('TERMINAL_DRIVER_CLOSED', 'Native terminal operation could not reach its driver'))
      }
    })
  }
  const subscribe = (listeners, listener, replay) => {
    listeners.add(listener)
    if (replay !== undefined && replay !== null) queueMicrotask(() => {
      if (listeners.has(listener)) listener(replay)
    })
    return { dispose: () => listeners.delete(listener) }
  }
  const api = {
    requiresWorkerExitReceipt: true,
    get pid() { return child.pid },
    get outputTruncated() { return truncated },
    onData(listener) {
      dataListeners.add(listener)
      if (buffer.length) {
        const retained = buffer.toString('utf8')
        buffer = Buffer.alloc(0)
        listener(retained)
      }
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit: listener => subscribe(exitListeners, listener, exitReceipt),
    onError: listener => subscribe(errorListeners, listener, lastError),
    write: data => typeof data === 'string' && Buffer.byteLength(data, 'utf8') <= 64 * 1024
      ? request('write', { data }) : Promise.reject(problem('INVALID_TERMINAL_INPUT', 'Terminal input must be bounded text')),
    resize: (cols, rows) => Number.isSafeInteger(cols) && cols >= 2 && cols <= 1000
      && Number.isSafeInteger(rows) && rows >= 1 && rows <= 1000
      ? request('resize', { cols, rows }) : Promise.reject(problem('INVALID_TERMINAL_SIZE', 'Invalid terminal dimensions')),
    kill: () => nativeExit ? Promise.resolve(true) : request('kill'),
  }
  child.on('message', message => {
    if (!message || message.v !== 1 || closed) return
    if (message.type === 'ready') {
      if (startupFailed) { stopOwnedWorker(); return }
      if (ready || message.transport !== 'conpty' || message.usePty !== true || message.shellId !== shellId) {
        reportError(problem('TERMINAL_DRIVER_PROTOCOL', 'Windows terminal driver returned an invalid startup receipt'))
        stopOwnedWorker(); return
      }
      ready = true; clearTimer(startupTimer); resolveReady(api)
    } else if (message.type === 'spawn-error') {
      clearTimer(startupTimer)
      reportError(startupFailure('Windows ConPTY could not start in its isolated driver',
        !ready && message.nativeCreated === false ? false : ready ? true : null))
      armWorkerCloseWatchdog()
    } else if (message.type === 'runtime-error') {
      reportError(problem('TERMINAL_DRIVER_ERROR', 'Windows terminal driver reported a native error', true))
      armWorkerCloseWatchdog()
    } else if (message.type === 'output') {
      if (typeof message.data !== 'string' || message.data.length > 65536) {
        reportError(problem('TERMINAL_DRIVER_PROTOCOL', 'Windows terminal driver exceeded its output frame limit'))
        stopOwnedWorker(); return
      }
      if (dataListeners.size) for (const listener of [...dataListeners]) listener(message.data)
      else {
        const next = Buffer.concat([buffer, Buffer.from(message.data, 'utf8')])
        truncated ||= next.length > 256 * 1024
        buffer = Buffer.from(next.subarray(Math.max(0, next.length - 256 * 1024)))
      }
    } else if (message.type === 'ack') {
      const entry = pending.get(message.requestId)
      if (!entry) return
      clearTimer(entry.timer); pending.delete(message.requestId)
      if (message.ok === true) {
        if (entry.type === 'kill') armWorkerCloseWatchdog()
        entry.resolve(true)
      }
      else entry.reject(problem('TERMINAL_NATIVE_OPERATION_FAILED', 'The native terminal driver rejected the operation'))
    } else if (message.type === 'native-exit') {
      if (!ready || nativeExit || !validNativeExit(message)) {
        reportError(problem('TERMINAL_DRIVER_PROTOCOL', 'Windows terminal driver returned an invalid native exit receipt'))
        stopOwnedWorker(); return
      }
      nativeExit = { exitCode: message.exitCode, signal: message.signal ?? null }
      armWorkerCloseWatchdog()
    }
  })
  child.once('error', () => {
    clearTimer(startupTimer)
    reportError(ready ? problem('TERMINAL_DRIVER_ERROR', 'The owned Windows terminal driver failed', true)
      : startupFailure('The owned Windows terminal driver failed', Number.isInteger(child.pid) ? null : false))
    stopOwnedWorker()
  })
  child.once('disconnect', () => {
    if (closed) return
    if (!nativeExit) reportError(ready
      ? problem('TERMINAL_DRIVER_CLOSED', 'Windows terminal driver IPC disconnected without native exit evidence', true)
      : startupFailure('Windows terminal driver IPC disconnected during startup'))
    armWorkerCloseWatchdog()
  })
  child.once('close', (workerExitCode, workerExitSignal) => {
    closed = true; clearTimer(startupTimer)
    if (workerCloseTimer) clearTimer(workerCloseTimer)
    rejectPending(problem('TERMINAL_DRIVER_CLOSED', 'Windows terminal driver closed'))
    if (nativeExit && workerExitCode === 0 && workerExitSignal == null) {
      exitReceipt = { ...nativeExit, exitSource: 'conpty-worker.native-onExit',
        nativeExitConfirmed: true, workerCloseConfirmed: true,
        workerExitCode: Number.isInteger(workerExitCode) ? workerExitCode : null,
        workerExitSignal: workerExitSignal ?? null }
      for (const listener of [...exitListeners]) listener(exitReceipt)
    } else {
      reportError(!ready ? startupFailure('Terminal driver closed during startup without native creation evidence')
        : problem('TERMINAL_DRIVER_EXIT_UNCONFIRMED', nativeExit
          ? 'Terminal driver closed abnormally after native shell exit'
          : 'Terminal driver closed without a native shell exit receipt', true))
    }
  })
  try {
    child.send({ v: 1, type: 'init', shellId, cwd, cols, rows, env,
      powerShellInitialization }, error => {
      if (error) {
        clearTimer(startupTimer)
        reportError(startupFailure('Windows terminal driver initialization failed', Number.isInteger(child.pid) ? null : false))
        stopOwnedWorker()
      }
    })
  } catch {
    clearTimer(startupTimer)
    reportError(startupFailure('Windows terminal driver initialization failed', Number.isInteger(child.pid) ? null : false))
    stopOwnedWorker()
  }
  return start
}
