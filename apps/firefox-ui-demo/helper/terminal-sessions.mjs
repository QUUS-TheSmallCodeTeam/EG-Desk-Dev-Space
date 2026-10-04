import { publicText } from './codex-chat-values.mjs'

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

  register({ id, process: nativeProcess, usePty, shell, cols, rows }) {
    this.pruneReceipts()
    if (this.active.has(id) || this.exitReceipts.has(id)) throw new Error('Terminal session ID is already registered')
    const entry = {
      id, process: nativeProcess, usePty, shell, cols, rows,
      createdAt: this.now(), stopRequested: false, stopRequestedAt: null,
      nativeError: null, output: Buffer.alloc(0), outputTruncated: false,
    }
    this.active.set(id, entry)
    const onData = data => this.appendOutput(id, data)
    if (usePty) {
      let dataSubscription, exitSubscription
      const cleanup = () => { dataSubscription?.dispose?.(); exitSubscription?.dispose?.() }
      dataSubscription = nativeProcess.onData(onData)
      exitSubscription = nativeProcess.onExit(({ exitCode, signal }) => {
        this.confirmExit(entry, exitCode, signal, 'pty.onExit')
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
    return { id, shell, cols, rows }
  }

  appendOutput(id, data) {
    const entry = this.active.get(id) || this.exitReceipts.get(id)
    if (!entry) return
    const incoming = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    if (entry.output.length + incoming.length > this.maxOutputBytes) entry.outputTruncated = true
    const next = Buffer.concat([entry.output, incoming.subarray(Math.max(0, incoming.length - this.maxOutputBytes))])
    // Copy the retained suffix so a small receipt cannot keep a huge backing
    // buffer alive after a noisy process exits.
    entry.output = Buffer.from(next.subarray(Math.max(0, next.length - this.maxOutputBytes)))
  }

  confirmExit(entry, exitCode, signal, exitSource) {
    if (this.active.get(entry.id) !== entry) return
    // This is the only active-registry deletion path. Kill acceptance, errors,
    // missing IDs, stream closure and bridge shutdown never synthesize an exit.
    this.active.delete(entry.id)
    this.exitReceipts.set(entry.id, {
      id: entry.id, shell: entry.shell, cols: entry.cols, rows: entry.rows,
      createdAt: entry.createdAt, stopRequested: entry.stopRequested,
      stopRequestedAt: entry.stopRequestedAt, output: entry.output,
      outputTruncated: entry.outputTruncated,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: typeof signal === 'string' || Number.isInteger(signal) ? signal : null,
      exitedAt: this.now(), exitSource,
    })
    this.pruneReceipts()
  }

  snapshot(id) {
    this.pruneReceipts()
    const entry = this.active.get(id)
    if (entry) return {
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
      ok: true, sessionId: id, status: 'EXITED', stopRequested: receipt.stopRequested,
      exited: true, exitConfirmed: true, exitCode: receipt.exitCode,
      signal: receipt.signal, exitedAt: receipt.exitedAt, exitSource: receipt.exitSource,
      outputTruncated: receipt.outputTruncated,
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
    try {
      if (typeof entry.process.kill !== 'function' || entry.process.kill() === false) throw new Error('Terminal process did not accept the stop request')
      return this.snapshot(id)
    } catch (error) {
      // Keep ownership and permit a retry. If a real exit happened meanwhile,
      // its independent receipt still reports that evidence truthfully.
      if (this.active.get(id) === entry) {
        entry.stopRequested = false
        entry.stopRequestedAt = previousTime
      }
      return { ...this.snapshot(id), ok: false, code: 'KILL_FAILED', error: publicText(error?.message || 'Terminal stop request failed', 2000) }
    }
  }

  write(id, data) {
    const state = this.snapshot(id)
    const entry = this.active.get(id)
    if (!entry) return state.exited === true ? { ...state, ok: false, code: 'SESSION_EXITED', error: 'Terminal session has exited' } : state
    try {
      if (entry.usePty) entry.process.write(data)
      else entry.process.stdin.write(data)
      return { ...this.snapshot(id), ok: true }
    } catch (error) {
      return { ...this.snapshot(id), ok: false, code: 'WRITE_FAILED', error: publicText(error?.message || 'Terminal write failed', 2000) }
    }
  }

  resize(id, cols, rows) {
    const state = this.snapshot(id)
    const entry = this.active.get(id)
    if (!entry) return state.exited === true ? { ...state, ok: false, code: 'SESSION_EXITED', error: 'Terminal session has exited' } : state
    try {
      if (entry.usePty) entry.process.resize(cols, rows)
      entry.cols = cols
      entry.rows = rows
      return { ...this.snapshot(id), ok: true }
    } catch (error) {
      return { ...this.snapshot(id), ok: false, code: 'RESIZE_FAILED', error: publicText(error?.message || 'Terminal resize failed', 2000) }
    }
  }

  requestStopAll() {
    for (const id of [...this.active.keys()]) this.kill(id)
  }
}

export function terminalResponseStatus(result) {
  if (result.code === 'UNKNOWN_SESSION') return 404
  if (result.code === 'KILL_FAILED' || result.code === 'PROCESS_ERROR') return 500
  if (result.code === 'SESSION_EXITED') return 410
  return result.error ? 400 : 200
}
