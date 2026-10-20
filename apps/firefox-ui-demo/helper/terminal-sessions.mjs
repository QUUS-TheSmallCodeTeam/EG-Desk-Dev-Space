import { publicText } from './codex-chat-values.mjs'

const metadata = entry => ({
  shell: entry.shell, shellId: entry.shellId, shellLabel: entry.shellLabel,
  cols: entry.cols, rows: entry.rows, usePty: entry.usePty,
  transport: entry.transport, degraded: !entry.usePty,
  reason: entry.transportReason || null, resizeSupported: entry.usePty,
  windowsBuildNumber: entry.windowsBuildNumber ?? null,
})

// Process exit evidence outlives active ownership, but only in this bridge
// instance. Missing/expired sessions (including after restart) remain UNKNOWN.
export class TerminalSessionRegistry {
  constructor({ now = Date.now, maxExitReceipts = 128, exitReceiptTtlMs = 10 * 60 * 1000, maxOutputBytes = 256 * 1024 } = {}) {
    Object.assign(this, { now, maxExitReceipts, exitReceiptTtlMs, maxOutputBytes })
    this.active = new Map()
    this.exitReceipts = new Map()
  }

  pruneReceipts() {
    const now = this.now()
    for (const [id, receipt] of this.exitReceipts) {
      if (now - receipt.exitedAt >= this.exitReceiptTtlMs) this.exitReceipts.delete(id)
    }
    while (this.exitReceipts.size > this.maxExitReceipts) this.exitReceipts.delete(this.exitReceipts.keys().next().value)
  }

  register({ id, process: nativeProcess, usePty, shell, cols, rows,
    shellId = null, shellLabel = null, transport = usePty ? 'pty' : 'pipe', transportReason = null,
    windowsBuildNumber = null }) {
    this.pruneReceipts()
    if (this.active.has(id) || this.exitReceipts.has(id)) throw new Error('Terminal session ID is already registered')
    const entry = {
      id, process: nativeProcess, usePty, shell, cols, rows,
      shellId, shellLabel, transport, transportReason, windowsBuildNumber,
      createdAt: this.now(), stopRequested: false, stopRequestedAt: null,
      nativeError: null, output: Buffer.alloc(0), outputTruncated: false,
    }
    this.active.set(id, entry)
    const onData = data => this.appendOutput(id, data)
    if (usePty) {
      let dataSubscription, exitSubscription, errorSubscription
      const cleanup = () => {
        dataSubscription?.dispose?.(); exitSubscription?.dispose?.(); errorSubscription?.dispose?.()
      }
      dataSubscription = nativeProcess.onData(onData)
      errorSubscription = nativeProcess.onError?.(error => {
        if (this.active.get(id) === entry) entry.nativeError = publicText(error?.message || 'Terminal driver error', 2000)
      })
      exitSubscription = nativeProcess.onExit(receipt => {
        const isolated = nativeProcess.requiresWorkerExitReceipt === true
        if (isolated && (receipt?.nativeExitConfirmed !== true || receipt.workerCloseConfirmed !== true
          || receipt.workerExitCode !== 0 || receipt.workerExitSignal != null
          || receipt.exitSource !== 'conpty-worker.native-onExit')) {
          entry.nativeError = 'Isolated terminal exit evidence is incomplete'
          return
        }
        const evidence = isolated ? { nativeExitConfirmed: true, workerCloseConfirmed: true,
          workerExitCode: receipt.workerExitCode, workerExitSignal: receipt.workerExitSignal ?? null } : null
        this.confirmExit(entry, receipt.exitCode, receipt.signal,
          isolated ? receipt.exitSource : 'pty.onExit', evidence)
        cleanup()
      })
      if (!this.active.has(id)) cleanup()
    } else {
      const onExit = (exitCode, signal) => this.confirmExit(entry, exitCode, signal, 'process.exit')
      const onError = error => {
        if (this.active.get(id) === entry) entry.nativeError = publicText(error?.message || 'Terminal process error', 2000)
      }
      const onClose = () => {
        // Node can emit close after a spawn error without ever emitting exit.
        // Closing streams alone is not proof that a tracked process exited.
        if (this.active.get(id) === entry && !entry.nativeError) entry.nativeError = 'Terminal closed without an observed process exit'
        nativeProcess.stdout?.removeListener('data', onData)
        nativeProcess.stderr?.removeListener('data', onData)
        nativeProcess.removeListener('exit', onExit)
        nativeProcess.removeListener('error', onError)
      }
      nativeProcess.stdout?.on('data', onData)
      nativeProcess.stderr?.on('data', onData)
      nativeProcess.on('exit', onExit)
      nativeProcess.on('error', onError)
      nativeProcess.once('close', onClose)
    }
    return { id, ...metadata(entry) }
  }

  appendOutput(id, data) {
    const entry = this.active.get(id) || this.exitReceipts.get(id)
    if (!entry) return
    if (entry.process?.outputTruncated) entry.outputTruncated = true
    const incoming = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    if (entry.output.length + incoming.length > this.maxOutputBytes) entry.outputTruncated = true
    const next = Buffer.concat([entry.output, incoming.subarray(Math.max(0, incoming.length - this.maxOutputBytes))])
    // Copy the retained suffix so a small receipt cannot keep a huge backing
    // buffer alive after a noisy process exits.
    entry.output = Buffer.from(next.subarray(Math.max(0, next.length - this.maxOutputBytes)))
  }

  confirmExit(entry, exitCode, signal, exitSource, driverEvidence = null) {
    if (this.active.get(entry.id) !== entry) return
    // This is the only active-registry deletion path. Kill acceptance, errors,
    // missing IDs, stream closure and bridge shutdown never synthesize an exit.
    this.active.delete(entry.id)
    this.exitReceipts.set(entry.id, {
      id: entry.id, ...metadata(entry), transportReason: entry.transportReason,
      createdAt: entry.createdAt, stopRequested: entry.stopRequested,
      stopRequestedAt: entry.stopRequestedAt, output: entry.output,
      outputTruncated: entry.outputTruncated,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: typeof signal === 'string' || Number.isInteger(signal) ? signal : null,
      exitedAt: this.now(), exitSource, ...(driverEvidence || {}),
    })
    this.pruneReceipts()
  }

  snapshot(id) {
    this.pruneReceipts()
    const entry = this.active.get(id)
    if (entry) return {
      ...metadata(entry),
      ok: !entry.nativeError, sessionId: id,
      status: entry.nativeError ? 'UNKNOWN' : entry.stopRequested ? 'STOP_REQUESTED' : 'RUNNING',
      stopRequested: entry.stopRequested,
      exited: entry.nativeError ? null : false, exitConfirmed: false,
      exitCode: null, signal: null, exitedAt: null, exitSource: null,
      outputTruncated: entry.outputTruncated,
      ...(entry.nativeError ? { code: 'PROCESS_ERROR', error: entry.nativeError } : {}),
    }
    const receipt = this.exitReceipts.get(id)
    if (receipt) return {
      ...metadata(receipt),
      ok: true, sessionId: id, status: 'EXITED', stopRequested: receipt.stopRequested,
      exited: true, exitConfirmed: true, exitCode: receipt.exitCode,
      signal: receipt.signal, exitedAt: receipt.exitedAt, exitSource: receipt.exitSource,
      outputTruncated: receipt.outputTruncated,
      ...(receipt.nativeExitConfirmed === true ? { nativeExitConfirmed: true, workerCloseConfirmed: receipt.workerCloseConfirmed,
        workerExitCode: receipt.workerExitCode, workerExitSignal: receipt.workerExitSignal } : {}),
    }
    return {
      ok: false, sessionId: typeof id === 'string' ? id : null,
      status: 'UNKNOWN', stopRequested: null, exited: null, exitConfirmed: false,
      exitCode: null, signal: null, exitedAt: null, exitSource: null,
      code: 'UNKNOWN_SESSION', error: 'Terminal session is unknown to this bridge instance',
    }
  }

  read(id) {
    const state = this.snapshot(id)
    const entry = this.active.get(id) || this.exitReceipts.get(id)
    const data = entry?.output.toString('utf8') || ''
    if (entry) entry.output = Buffer.alloc(0)
    return { ...state, data }
  }

  kill(id) {
    const state = this.snapshot(id)
    const entry = this.active.get(id)
    if (!entry || entry.stopRequested) return state
    const previousTime = entry.stopRequestedAt
    entry.stopRequested = true
    entry.stopRequestedAt = this.now()
    const failed = error => {
      const observed = this.snapshot(id)
      if (observed.exitConfirmed === true) return observed
      if (this.active.get(id) === entry) {
        entry.stopRequested = false
        entry.stopRequestedAt = previousTime
      }
      return { ...this.snapshot(id), ok: false, code: 'KILL_FAILED', error: publicText(error?.message || 'Terminal stop request failed', 2000) }
    }
    const accepted = result => {
      if (result === false) throw new Error('Terminal process did not accept the stop request')
      return this.snapshot(id)
    }
    try {
      if (typeof entry.process.kill !== 'function') throw new Error('Terminal process cannot accept a stop request')
      const result = entry.process.kill()
      return result?.then ? Promise.resolve(result).then(accepted).catch(failed) : accepted(result)
    } catch (error) { return failed(error) }
  }

  write(id, data) {
    const state = this.snapshot(id)
    const entry = this.active.get(id)
    if (!entry) return state.exited === true ? { ...state, ok: false, code: 'SESSION_EXITED', error: 'Terminal session has exited' } : state
    if (!state.ok) return state
    if (entry.stopRequested) return { ...state, ok: false, code: 'SESSION_STOPPING', error: 'Terminal session is stopping' }
    const failed = error => ({ ...this.snapshot(id), ok: false, code: 'WRITE_FAILED',
      error: publicText(error?.message || 'Terminal write failed', 2000) })
    const accepted = () => {
      const current = this.snapshot(id)
      if (!current.ok || entry.stopRequested) return { ...current, ok: false,
        code: entry.stopRequested ? 'SESSION_STOPPING' : current.code,
        error: current.error || 'Terminal session is no longer accepting input' }
      if (this.active.get(id) !== entry) return { ...current, ok: false, code: 'SESSION_EXITED', error: 'Terminal session has exited' }
      return { ...current, ok: true }
    }
    try {
      const result = entry.usePty ? entry.process.write(data) : entry.process.stdin.write(data)
      return result?.then ? Promise.resolve(result).then(accepted).catch(failed) : accepted()
    } catch (error) { return failed(error) }
  }

  resize(id, cols, rows) {
    const state = this.snapshot(id)
    const entry = this.active.get(id)
    if (!entry) return state.exited === true ? { ...state, ok: false, code: 'SESSION_EXITED', error: 'Terminal session has exited' } : state
    if (!state.ok) return { ...state, resized: false }
    if (entry.stopRequested) return { ...state, ok: false, code: 'SESSION_STOPPING', error: 'Terminal session is stopping', resized: false }
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > 1000 ||
      !Number.isSafeInteger(rows) || rows < 1 || rows > 1000) {
      return { ...state, ok: false, code: 'INVALID_TERMINAL_SIZE', error: 'Invalid terminal dimensions', resized: false }
    }
    if (!entry.usePty) return { ...state, ok: false, code: 'RESIZE_UNSUPPORTED',
      error: 'Pipe terminal sessions do not support PTY resizing', resized: false, resizeSupported: false }
    const failed = error => ({ ...this.snapshot(id), ok: false, code: 'RESIZE_FAILED', resized: false,
      error: publicText(error?.message || 'Terminal resize failed', 2000) })
    const accepted = () => {
      const current = this.snapshot(id)
      if (!current.ok || entry.stopRequested) return { ...current, ok: false, resized: false,
        code: entry.stopRequested ? 'SESSION_STOPPING' : current.code,
        error: current.error || 'Terminal session is no longer accepting resize' }
      if (this.active.get(id) !== entry) return { ...current, ok: false, code: 'SESSION_EXITED',
        error: 'Terminal session has exited', resized: false }
      entry.cols = cols
      entry.rows = rows
      return { ...this.snapshot(id), ok: true, resized: true }
    }
    try {
      const result = entry.process.resize(cols, rows)
      return result?.then ? Promise.resolve(result).then(accepted).catch(failed) : accepted()
    } catch (error) { return failed(error) }
  }

  requestStopAll() {
    for (const id of [...this.active.keys()]) this.kill(id)
  }
}

export function terminalResponseStatus(result) {
  if (result.code === 'SESSION_STOPPING') return 409
  if (result.code === 'RESIZE_UNSUPPORTED') return 501
  if (result.code === 'UNKNOWN_SESSION') return 404
  if (result.code === 'KILL_FAILED' || result.code === 'PROCESS_ERROR') return 500
  if (result.code === 'SESSION_EXITED') return 410
  return result.error ? 400 : 200
}
