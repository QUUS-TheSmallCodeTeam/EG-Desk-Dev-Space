// The heartbeat of a live session. One per live conversation: it starts when the person's message is accepted and beats on its
// OWN internal time counter until the run ends, is cancelled or the connection drops. It does not listen to the engine to keep
// time, so it still beats when the engine is silent or hung; engine events only move a mark ("last engine event") on its clock.
//
//   const beats = createHeartbeats({ monotonicNow, setTimer, clearTimer })
//   const hb = beats.open(key)            // one per key; an older live heartbeat for the key is stopped ('superseded')
//   hb.start({ sinceMs })                 // internal time zero = the moment the person's message was accepted
//   hb.mark('user' | 'posted' | 'engine') // moves a mark to "now" on the internal clock
//   hb.register(name, () => facts)        // objective loops feed read-only progress facts; returns unregister()
//   hb.subscribe(({ beat, internalMs, facts }) => {})   // receive beats; returns unsubscribe()
//   hb.pause() / hb.resume() / hb.stop(reason)
//
// Cadence (bounded): one beat every HEARTBEAT_LIMITS.beatMs on the internal clock, never replayed after a late timer (a late
// beat counts once), at most maxBeats per heartbeat (then it stops itself with reason 'limit'), at most maxLive heartbeats.
// A beat costs nothing by itself: it computes facts and tells its listeners. Whether anything is asked or sent is the listener's
// business (egdesk-conversation-flow.mjs keeps the prefilter and the rate bounds).
// Nothing is persisted: after a restart no heartbeat exists until a new message is accepted (restart-safe by construction).

export const HEARTBEAT_LIMITS = Object.freeze({
  // 5 s: at least three times a cold Decision call (about 1.3-1.6 s after a long idle; 0.25-0.6 s warm), so one beat's judgment is
  // finished before the next beat even cold; and half of the 10 s after which a person should first hear something, so a
  // threshold is noticed at most 5 s late.
  beatMs: 5_000,
  // One hour of beats. A run that is still live after that keeps running; it just has no heartbeat any more.
  maxBeats: 720,
  maxLive: 64, maxProviders: 8, maxListeners: 8,
})
export const HEARTBEAT_PHASES = Object.freeze(['thinking', 'tool_running', 'waiting_user', 'objective_step'])
export const HEARTBEAT_STOP_REASONS = Object.freeze(['run_end', 'cancel', 'disconnect', 'restart', 'start_failed', 'superseded', 'limit'])
const MARKS = Object.freeze(['user', 'posted', 'engine'])
const NAME = /^[a-z][a-z0-9_]{0,31}$/
const LABEL = /^[a-z0-9_]{1,40}$/
const KEY = /^[A-Za-z][A-Za-z0-9]{0,23}$/

// Facts are numbers, booleans and closed labels only. Free text can never ride along (these facts go to the decision model).
function sanitize(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const [key, value] of Object.entries(raw).slice(0, 16)) {
    if (!KEY.test(key)) continue
    if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.max(-1e9, Math.min(1e9, Math.round(value)))
    else if (typeof value === 'string' && LABEL.test(value)) out[key] = value
    else if (value === null) out[key] = null
  }
  return out
}
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0)

export function createHeartbeat({ key = null, monotonicNow = () => performance.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle),
  limits = HEARTBEAT_LIMITS, onStop = null } = {}) {
  const beatMs = Number.isSafeInteger(limits.beatMs) && limits.beatMs >= 100 ? limits.beatMs : HEARTBEAT_LIMITS.beatMs
  const maxBeats = Number.isSafeInteger(limits.maxBeats) && limits.maxBeats > 0 ? limits.maxBeats : HEARTBEAT_LIMITS.maxBeats
  let state = 'idle', stopReason = null
  let base = 0, resumedAt = 0, beats = 0, timer = null, engineEvents = 0
  const marks = { user: 0, posted: null, engine: 0 }
  const providers = new Map(), listeners = new Set()
  let source = null

  // The internal time counter: milliseconds this heartbeat has been running, excluding pauses. Never goes backwards.
  const internalMs = () => (state === 'running' ? base + Math.max(0, monotonicNow() - resumedAt) : base)

  function facts() {
    const t = internalMs()
    const sources = {}
    let waiting = false, objective = false, stepsDone = 0, stepsRunning = 0, remaining = null, pendingQuestion = false, phase = 'thinking'
    const take = row => {
      if (!row) return
      if (row.waitingOnUser === true || row.phase === 'waiting_user') waiting = true
      if (row.active !== false && row.phase === 'objective_step') objective = true
      if (row.phase === 'tool_running') stepsRunning = Math.max(stepsRunning, 1)
      stepsDone += count(row.stepsDone); stepsRunning += count(row.stepsRunning)
      if (Number.isSafeInteger(row.stepsRemaining) && row.stepsRemaining >= 0) remaining = (remaining ?? 0) + row.stepsRemaining
      if (row.pendingQuestion === true) pendingQuestion = true
    }
    let own = null
    try { own = sanitize(source?.()) } catch { own = null }
    take(own)
    for (const [name, provider] of providers) {
      let row = null
      try { row = sanitize(provider()) } catch { row = null }
      if (row) { sources[name] = Object.freeze(row); take(row) }
    }
    if (waiting) phase = 'waiting_user'
    else if (objective) phase = 'objective_step'
    else if (stepsRunning > 0) phase = 'tool_running'
    return Object.freeze({ internalMs: t, beat: beats, sinceUserMs: t - marks.user, sincePostedMs: marks.posted === null ? null : t - marks.posted,
      sinceEngineMs: t - marks.engine, engineEvents, phase, pendingQuestion, stepsDone, stepsRunning, stepsRemaining: remaining, sources: Object.freeze(sources) })
  }

  function schedule() {
    if (state !== 'running') return
    const t = internalMs()
    const due = (Math.floor(t / beatMs) + 1) * beatMs
    timer = setTimer(fire, Math.max(1, Math.min(beatMs, due - t)))
    timer?.unref?.()
  }
  function fire() {
    timer = null
    if (state !== 'running') return
    beats++
    const beat = Object.freeze({ beat: beats, internalMs: internalMs(), facts: facts() })
    for (const listener of [...listeners]) { try { listener(beat) } catch { /* a listener never stops the heartbeat */ } }
    if (state !== 'running') return
    if (beats >= maxBeats) { api.stop('limit'); return }
    schedule()
  }

  const api = Object.freeze({
    key,
    get state() { return state },
    get stopReason() { return stopReason },
    get beats() { return beats },
    internalMs, facts,
    /** Starts the internal counter. sinceMs: how long ago (monotonic) the person's message was accepted. Only once. */
    start({ sinceMs = 0 } = {}) {
      if (state !== 'idle') return false
      base = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0
      resumedAt = monotonicNow(); state = 'running'
      schedule()
      return true
    },
    pause() {
      if (state !== 'running') return false
      base = internalMs(); state = 'paused'
      if (timer != null) { clearTimer(timer); timer = null }
      return true
    },
    resume() {
      if (state !== 'paused') return false
      resumedAt = monotonicNow(); state = 'running'
      schedule()
      return true
    },
    stop(reason = 'run_end') {
      if (state === 'stopped') return false
      base = internalMs(); state = 'stopped'; stopReason = HEARTBEAT_STOP_REASONS.includes(reason) ? reason : 'run_end'
      if (timer != null) { clearTimer(timer); timer = null }
      providers.clear(); listeners.clear(); source = null
      try { onStop?.(api) } catch { /* ignore */ }
      return true
    },
    mark(kind) {
      if (state === 'stopped' || !MARKS.includes(kind)) return false
      marks[kind] = internalMs()
      if (kind === 'engine') engineEvents++
      return true
    },
    /** The owner's own facts (the runtime reads them from the run). One source; providers are for others. */
    setSource(fn) { source = typeof fn === 'function' ? fn : null },
    /** Registration for objective loops: read-only facts { phase?, active?, waitingOnUser?, stepsDone?, stepsRunning?, stepsRemaining?, ...closed labels }. */
    register(name, provider) {
      if (state === 'stopped' || !NAME.test(String(name)) || typeof provider !== 'function') return () => {}
      if (!providers.has(name) && providers.size >= (limits.maxProviders ?? HEARTBEAT_LIMITS.maxProviders)) return () => {}
      providers.set(name, provider)
      return () => { if (providers.get(name) === provider) providers.delete(name) }
    },
    subscribe(listener) {
      if (state === 'stopped' || typeof listener !== 'function' || listeners.size >= (limits.maxListeners ?? HEARTBEAT_LIMITS.maxListeners)) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot() { return { key, state, stopReason, beats, internalMs: internalMs(), providers: [...providers.keys()] } },
  })
  return api
}

/** One heartbeat per key. */
export function createHeartbeats({ monotonicNow, setTimer, clearTimer, limits = HEARTBEAT_LIMITS } = {}) {
  const live = new Map()
  return Object.freeze({
    open(key) {
      if (typeof key !== 'string' || !key) return null
      live.get(key)?.stop('superseded')
      if (live.size >= (limits.maxLive ?? HEARTBEAT_LIMITS.maxLive)) return null
      const hb = createHeartbeat({ key, monotonicNow, setTimer, clearTimer, limits, onStop: self => { if (live.get(key) === self) live.delete(key) } })
      live.set(key, hb)
      return hb
    },
    get: key => live.get(key) ?? null,
    stop(key, reason) { return live.get(key)?.stop(reason) ?? false },
    stopAll(reason) { for (const hb of [...live.values()]) hb.stop(reason) },
    get size() { return live.size },
    keys: () => [...live.keys()],
  })
}
