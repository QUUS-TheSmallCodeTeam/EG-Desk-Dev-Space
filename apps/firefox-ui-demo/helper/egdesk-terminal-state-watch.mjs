import { createHash } from 'node:crypto'
import { enumerateLogBlocks, judgeTerminalState, pickRelevantBlocks, stateResponse, terminalFactRow } from './egdesk-terminal-judge.mjs'

// Terminal state judge, wired next to the run watch (egdesk-terminal-run-watch.mjs).
//
// It wraps the run watch and is handed to TerminalSessionRegistry in its place. Every call is passed through unchanged
// and its return value is returned unchanged, so what a Terminal card reads, writes and shows is byte-identical with the
// flag off and in advisory. With the flag off nothing else happens at all: no tail is kept, no clock is read.
//
// Check points (no polling loop of its own): the screen's /terminal/read (take), the confirmed process exit (noteExit),
// and an external beat (beat) for a live-session heartbeat to call later. A check never blocks the caller.
//
// flag 'advisory': the judge runs and what the system WOULD do is recorded (content-free); nothing is sent to the process.
// flag 'on': the same, plus exactly one effect: a pager that holds an AGENT-OWNED session is quit with `q`, only when the
//   Decision mode is on, the choice was accepted, and neither output nor input arrived since the judged tail.
//   Every other response (yes/no, password, report, repair, hand-over) stays a record until the user decides.
//
// Egress: terminal text may leave only through the shared gate (egdesk-decision-egress.mjs, kind terminal_output) of the
// run the session belongs to. A session that belongs to no run (today: every Terminal card, which is the person's own
// terminal) has no gate, so its text is never sent; rules and process facts still give a recorded answer with 0 requests.
export const TERMINAL_STATE_FLAGS = Object.freeze(['off', 'advisory', 'on'])
export const TERMINAL_WOULD = Object.freeze(['wait', 'hand_yes_no', 'hand_secret', 'quit_pager', 'hand_close_pager', 'report', 'repair', 'hand_subjective'])
export const TERMINAL_STATE_WATCH_LIMITS = Object.freeze({ tailChars: 8192, maxSessions: 64, judgmentsPerCommand: 4, trail: 50, deadlineMs: 1500 })

const wouldOf = response => {
  switch (response.action) {
    case 'handoff_human': return response.input === 'yes_no' ? 'hand_yes_no' : response.input === 'secret' ? 'hand_secret' : 'hand_close_pager'
    case 'send_key': return 'quit_pager'
    case 'report': return 'report'
    case 'repair': return 'repair'
    case 'handoff_subjective': return 'hand_subjective'
    default: return 'wait'
  }
}
const hashOf = text => createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * createTerminalStateWatch({ runWatch, flag, decision, egressFor, isAgentOwned, sendKey, now, limits })
 *   runWatch: the run watch to wrap (required)
 *   flag(): 'off' | 'advisory' | 'on' (anything else is off)
 *   decision: { mode(): 'off'|'advisory'|'on', configured(): boolean, client, calibrationLog } or null
 *   egressFor(sessionId): the shared egress gate of the run this session belongs to, or null when it belongs to no run
 *   isAgentOwned(sessionId): true only for a session an Agent run started and owns
 *   sendKey(sessionId, key): writes one key to the session (used only for the flag-'on' pager effect)
 */
export function createTerminalStateWatch({ runWatch, flag = () => 'off', decision = null, egressFor = () => null, isAgentOwned = () => false,
  sendKey = null, now = Date.now, limits = {} } = {}) {
  if (!runWatch || typeof runWatch.take !== 'function') throw new TypeError('createTerminalStateWatch requires the run watch it wraps')
  const max = { ...TERMINAL_STATE_WATCH_LIMITS, ...limits }
  const sessions = new Map()
  const trail = []
  const jobs = new Set()

  const flagNow = () => { try { const value = flag(); return value === 'advisory' || value === 'on' ? value : 'off' } catch { return 'off' } }
  const validId = id => typeof id === 'string' && !!id && id.length <= 160 && !id.includes('\0')
  const session = id => {
    let entry = sessions.get(id)
    if (!entry) {
      entry = { tail: '', startedAt: now(), lastOutputAt: null, lastInputAt: null, exit: null, judged: null, judgedKey: null, judgments: 0, busy: false, rev: 0 }
      sessions.set(id, entry)
      while (sessions.size > max.maxSessions) sessions.delete(sessions.keys().next().value)
    }
    return entry
  }
  // The judge's mode: never above the person's own Decision mode, and nothing without a saved key.
  const judgeMode = flagValue => {
    try {
      const mode = decision?.mode?.()
      if (decision?.configured?.() !== true || (mode !== 'advisory' && mode !== 'on') || !decision.client) return 'off'
      return flagValue === 'on' && mode === 'on' ? 'on' : 'advisory'
    } catch { return 'off' }
  }
  const owned = id => { try { return isAgentOwned(id) === true } catch { return false } }
  const gateOf = id => { try { return egressFor(id) ?? null } catch { return null } }

  async function check(id, reason) {
    const flagValue = flagNow()
    if (flagValue === 'off' || !validId(id)) return null
    const entry = sessions.get(id)
    if (!entry || entry.busy) return null
    const alive = entry.exit === null
    const at = now()
    const quietMs = Math.max(0, at - (entry.lastOutputAt ?? entry.startedAt))
    const tail = entry.tail
    const key = `${alive}|${entry.exit?.exitCode ?? ''}|${hashOf(tail)}`
    if (entry.judgedKey === key) return entry.judged
    if (alive && entry.judgments >= max.judgmentsPerCommand) return entry.judged
    entry.busy = true
    const rev = entry.rev
    try {
      const mode = judgeMode(flagValue), egress = gateOf(id), agentOwned = owned(id)
      let captured = null
      const judged = await judgeTerminalState({ tail, alive, exitCode: entry.exit?.exitCode ?? null, quietMs, mode, client: decision?.client ?? null, egress,
        timeoutMs: max.deadlineMs, calibration: { record: raw => { captured = raw } } })
      // In advisory the judge acts on the fallback and reports the model's pick as `shadow`; the record says what that pick would do.
      const state = judged.shadow ?? judged.state
      const would = wouldOf(stateResponse(state, { agentOwned }))
      const settled = judged.requests > 0 || judged.source === 'rule' || !alive
      let blocks = null
      if (settled && would === 'repair') {
        const all = enumerateLogBlocks(tail)
        const picked = await pickRelevantBlocks({ blocks: all, mode, client: decision?.client ?? null, egress, timeoutMs: max.deadlineMs })
        blocks = { enumerated: all.length, picked: picked.blocks.length, source: picked.source, requests: picked.requests }
      }
      let acted = false
      // The one flag-'on' effect. Re-check everything at the moment of acting: still alive, same tail, no input since, still agent-owned.
      if (flagValue === 'on' && mode === 'on' && judged.source === 'decision' && judged.state === 'stuck_in_pager' && agentOwned && typeof sendKey === 'function') {
        const current = sessions.get(id)
        if (current === entry && entry.exit === null && entry.rev === rev && owned(id) && flagNow() === 'on') {
          try { await sendKey(id, 'q'); acted = true } catch { acted = false }
        }
      }
      const result = Object.freeze({ sessionId: id, at, check: reason, state, source: judged.source, would, acted, agentOwned,
        requests: judged.requests + (blocks?.requests ?? 0), ...(judged.fallback ? { fallback: judged.fallback } : {}), ...(blocks ? { blocks: Object.freeze({ enumerated: blocks.enumerated, picked: blocks.picked }) } : {}) })
      entry.judged = result
      if (settled) {
        entry.judgedKey = key
        if (alive) entry.judgments++
        trail.push(result)
        while (trail.length > max.trail) trail.shift()
        try {
          decision?.calibrationLog?.record?.({ feature: 'terminal_state', mode: flagValue === 'on' && mode === 'on' ? 'on' : 'advisory', judgments: captured?.judgments ?? [],
            ...(captured?.fallback ?? judged.fallback ? { fallback: captured?.fallback ?? judged.fallback } : {}), attached: acted,
            ...(blocks ? { candidates: blocks.enumerated, judgedTotal: blocks.picked } : {}),
            terminal: { state, source: judged.source, would, acted, check: reason, agentOwned } })
        } catch { /* recording never changes behaviour */ }
      }
      return result
    } catch { return null } finally { entry.busy = false; if (entry.exit !== null && sessions.get(id) === entry) sessions.delete(id) }
  }
  // A Terminal card is a long-lived shell: a finished command does not end the process. The run watch already parses a finished
  // test/build run; that parsed outcome is the runtime's own fact, so no state question is asked for it.
  async function checkRun(id, run) {
    const flagValue = flagNow()
    const entry = sessions.get(id)
    if (flagValue === 'off' || !entry || (run?.outcome !== 'failed' && run?.outcome !== 'passed')) return null
    const state = run.outcome === 'failed' ? 'completed_error' : 'completed_ok'
    const agentOwned = owned(id), would = wouldOf(stateResponse(state, { agentOwned })), at = now()
    entry.judgedKey = `${entry.exit === null}|${entry.exit?.exitCode ?? ''}|${hashOf(entry.tail)}` // this tail is answered; do not ask about it again
    let blocks = null
    try {
      if (would === 'repair') {
        const all = enumerateLogBlocks(run.output)
        const picked = await pickRelevantBlocks({ blocks: all, mode: judgeMode(flagValue), client: decision?.client ?? null, egress: gateOf(id), timeoutMs: max.deadlineMs })
        blocks = { enumerated: all.length, picked: picked.blocks.length, requests: picked.requests }
      }
    } catch { blocks = null }
    const result = Object.freeze({ sessionId: id, at, check: 'read', state, source: 'runtime', would, acted: false, agentOwned, requests: blocks?.requests ?? 0,
      ...(blocks ? { blocks: Object.freeze({ enumerated: blocks.enumerated, picked: blocks.picked }) } : {}) })
    if (sessions.get(id) === entry) entry.judged = result
    trail.push(result)
    while (trail.length > max.trail) trail.shift()
    try {
      decision?.calibrationLog?.record?.({ feature: 'terminal_state', mode: 'advisory', judgments: [], attached: false,
        ...(blocks ? { candidates: blocks.enumerated, judgedTotal: blocks.picked } : {}), terminal: { state, source: 'runtime', would, acted: false, check: 'read', agentOwned } })
    } catch { /* recording never changes behaviour */ }
    return result
  }
  const track = job => { jobs.add(job); void job.finally(() => jobs.delete(job)); return job }
  const launch = (id, reason) => {
    const job = check(id, reason).catch(() => null)
    jobs.add(job)
    void job.finally(() => jobs.delete(job))
    return job
  }

  return {
    // ---- the run watch interface, passed through unchanged ----
    observeInput(id, data) {
      const out = runWatch.observeInput?.(id, data)
      try {
        if (flagNow() !== 'off' && validId(id) && typeof data === 'string' && data && !data.startsWith('\u001b')) {
          const entry = session(id)
          entry.lastInputAt = now(); entry.rev++
          // Enter starts a new command: its output is a new window. The typed text itself is never kept.
          if (/[\r\n]/.test(data)) { entry.tail = ''; entry.judgments = 0; entry.judgedKey = null; entry.judged = null }
        }
      } catch { /* the judge never affects the terminal */ }
      return out
    },
    observeOutput(id, chunk) {
      const out = runWatch.observeOutput?.(id, chunk)
      try {
        if (flagNow() !== 'off' && validId(id)) {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : typeof chunk === 'string' ? chunk : ''
          if (text) {
            const entry = session(id)
            entry.tail = (entry.tail + text).slice(-max.tailChars)
            entry.lastOutputAt = now(); entry.rev++
          }
        }
      } catch { /* ignore */ }
      return out
    },
    take(id) {
      const out = runWatch.take(id)
      try {
        if (flagNow() !== 'off' && sessions.has(id)) {
          if (out && (out.outcome === 'failed' || out.outcome === 'passed')) track(checkRun(id, out).catch(() => null))
          else launch(id, 'read')
        }
      } catch { /* ignore */ }
      return out
    },
    forget(id) {
      const out = runWatch.forget?.(id)
      try { const entry = sessions.get(id); if (entry && !entry.busy) sessions.delete(id) } catch { /* ignore */ }
      return out
    },
    snapshot: () => runWatch.snapshot(),
    close() { sessions.clear(); trail.length = 0; return runWatch.close?.() },

    // ---- additions ----
    /** The registry's confirmed exit ({ sessionId, exitCode }). One last check, then the session is dropped. */
    noteExit(receipt) {
      try {
        const id = receipt?.sessionId
        if (flagNow() === 'off' || !validId(id) || !sessions.has(id)) return
        const entry = sessions.get(id)
        entry.exit = { exitCode: Number.isInteger(receipt.exitCode) ? receipt.exitCode : null }
        entry.rev++
        launch(id, 'exit')
      } catch { /* ignore */ }
    },
    /** An external heartbeat may ask for a check instead of waiting for the next read. Resolves with the content-free result or null. */
    beat(id) { return flagNow() === 'off' ? Promise.resolve(null) : launch(id, 'beat') },
    /**
     * Read-only, content-free facts about live terminal sessions for other system parts (e.g. a live-session heartbeat):
     * no output text, no typed text, no command. Empty while the flag is off (nothing is tracked then).
     */
    terminalFacts() {
      if (flagNow() === 'off') return Object.freeze([])
      const at = now()
      // One row shape for every terminal-like source (terminalFactRow in egdesk-terminal-judge.mjs), plus which session it is.
      return Object.freeze([...sessions].map(([sessionId, entry]) => Object.freeze({ sessionId,
        ...terminalFactRow({ kind: 'card', running: entry.exit === null, state: entry.judged?.state ?? null, source: entry.judged?.source ?? null, would: entry.judged?.would ?? null,
          runningMs: at - entry.startedAt, quietMs: at - (entry.lastOutputAt ?? entry.startedAt), exitCode: entry.exit?.exitCode ?? null }),
        agentOwned: owned(sessionId), runBound: gateOf(sessionId) !== null })))
    },
    /** Content-free trail of settled checks (most recent last), for tests and diagnostics. */
    advisories: () => trail.slice(),
    idle: () => Promise.allSettled([...jobs]),
  }
}
