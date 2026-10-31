// EGDesk terminal run watch (CODE-06): reads the PTY output the bridge relays
// for a Terminal card and, once a test runner's summary is complete, prepares
// one result for the screen's next /terminal/read. The line the person typed
// is kept only as that result's command label. Nothing is run, stored or
// logged (D-X6); each session's window is bounded and dropped when the RT-06
// bus reports terminal.exit for it.
//
// A PTY has no command boundary. The window is reset when the person presses
// Enter, so it holds one command's output; node --test prints its failing
// tests after the summary line, so a detected run is read out at the next
// /terminal/read (or at the next Enter), not at the summary line itself.
import { runSummaryEnd, stripAnsi, summarizeCommandOutput } from './egdesk-run-result-parse.mjs'

export const TERMINAL_RUN_WATCH_LIMITS = Object.freeze({
  windowChars: 64 * 1024,
  outputChars: 64 * 1024,
  commandChars: 1000,
  maxSessions: 64,
  maxPending: 4,
})

export function createTerminalRunWatch({ bus = null, owner = null, now = Date.now, limits = {} } = {}) {
  const max = { ...TERMINAL_RUN_WATCH_LIMITS, ...limits }
  const sessions = new Map()
  let unsubscribe = null

  const validId = id => typeof id === 'string' && !!id && id.length <= 160 && !id.includes('\0')

  function session(id) {
    let entry = sessions.get(id)
    if (!entry) {
      entry = { window: '', detected: null, input: '', command: null, pending: [], seq: 0 }
      sessions.set(id, entry)
      while (sessions.size > max.maxSessions) sessions.delete(sessions.keys().next().value)
    }
    return entry
  }

  function finish(entry, text, runner) {
    const output = text.length > max.outputChars ? text.slice(-max.outputChars) : text
    const summary = summarizeCommandOutput({ command: entry.command, output })
    entry.pending.push(Object.freeze({
      protocolVersion: 1, seq: ++entry.seq, at: new Date(now()).toISOString(),
      command: summary.command, runner: summary.runner ?? runner ?? null,
      outcome: summary.outcome, headline: summary.headline, parsed: summary.parsed,
      counts: summary.counts, failures: summary.failures, durationMs: summary.durationMs,
      output, outputTruncated: summary.outputTruncated || output.length < text.length,
    }))
    while (entry.pending.length > max.maxPending) entry.pending.shift()
  }

  function flush(entry) {
    if (entry.detected) finish(entry, entry.window, entry.detected.runner)
    entry.window = ''
    entry.detected = null
  }

  // Keyboard traffic sent to the PTY: the line committed by Enter becomes the
  // next result's command label and starts a fresh output window. Escape
  // sequences (arrow keys, bracketed paste) are not read.
  function observeInput(id, data) {
    if (!validId(id)) return
    const text = typeof data === 'string' ? data : ''
    if (!text || text.startsWith('\u001b')) return
    const entry = session(id)
    for (const char of text) {
      if (char === '\r' || char === '\n') {
        const line = entry.input.trim()
        entry.input = ''
        if (!line) continue
        flush(entry)
        entry.command = line.slice(0, max.commandChars)
        continue
      }
      if (char === '\u007f' || char === '\b') { entry.input = entry.input.slice(0, -1); continue }
      if (char === '\u0003' || char === '\u0015') { entry.input = ''; continue }
      if (char < ' ') continue
      if (entry.input.length < max.commandChars) entry.input += char
    }
  }

  // PTY output for the session; detects a complete runner summary.
  function observeOutput(id, chunk) {
    if (!validId(id)) return
    const text = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : typeof chunk === 'string' ? chunk : '')
    if (!text) return
    const entry = session(id)
    entry.window += text
    if (entry.window.length > max.windowChars) {
      const cut = entry.window.length - max.windowChars
      entry.window = entry.window.slice(cut)
      if (entry.detected) entry.detected = { ...entry.detected, end: Math.max(0, entry.detected.end - cut) }
    }
    if (!/[\r\n]/.test(text)) return
    const found = runSummaryEnd(entry.window)
    if (found && (!entry.detected || found.end > entry.detected.end)) entry.detected = found
  }

  // The next prepared result for the session, or null. A detected run is read
  // out here with everything printed since its command started.
  function take(id) {
    if (!validId(id)) return null
    const entry = sessions.get(id)
    if (!entry) return null
    if (entry.detected) flush(entry)
    return entry.pending.shift() ?? null
  }

  function forget(id) {
    if (validId(id)) sessions.delete(id)
  }

  if (bus && typeof bus.subscribe === 'function' && typeof owner === 'string' && owner) {
    unsubscribe = bus.subscribe({ owner, topics: ['terminal.exit'] }, event => { forget(event?.payload?.sessionId) })
  }

  return {
    observeInput, observeOutput, take, forget,
    snapshot: () => ({ sessions: sessions.size, pending: [...sessions.values()].reduce((sum, entry) => sum + entry.pending.length, 0) }),
    close() { unsubscribe?.(); unsubscribe = null; sessions.clear() },
  }
}
