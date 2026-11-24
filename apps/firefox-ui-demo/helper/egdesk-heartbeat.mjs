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
// A beat costs nothing by itself: it computes facts and tells its listeners.
// Nothing is persisted: after a restart no heartbeat exists until a new message is accepted (restart-safe by construction).
//
// ---- Contract for other features (they use this API; they do not edit this module) ----
// 1. Facts.   hb.register(name, () => facts)  or  hb.register(name, { facts() })
//    name: a closed label /^[a-z][a-z0-9_]{0,31}$/. facts: a flat object of numbers, booleans and closed labels
//    (/^[a-z0-9_]{1,40}$/); anything else (free text, nested values) is dropped. Understood keys: phase (one of HEARTBEAT_PHASES),
//    active, waitingOnUser, stepsDone, stepsRunning, stepsRemaining, pendingQuestion. Every beat carries facts.sources[name].
// 2. Questions.   hb.register(name, { facts?, propose(beat), onVerdict({ beat, verdicts }) })
//    propose(beat) returns nothing (the common case: a quiet beat) or up to a few questions for THIS beat:
//      { name, instructions, options: [{ value, description }], none?, facts?, kinds? }
//      - name and every option value are closed labels of the provider's own vocabulary; 2 to 8 options, one of them the
//        "do nothing" value (`none`, default 'none'). A question is proposed only when there is a real choice right now.
//      - instructions and descriptions are fixed English prompt text (printable ASCII, at most 300 characters). Never put a
//        title, a name, a path or any other content there: such a question is refused.
//      - facts: numbers, booleans and closed labels for the judge, keys /^[a-z][a-z0-9_]{0,63}$/. No text.
//      - kinds: egress kinds the question needs besides run facts (egdesk-decision-egress.mjs). A question whose kind the run's
//        models may not receive is dropped alone; the other questions of the beat are still asked.
//    All questions proposed at a beat ride ONE Decision request (the message question and every provider's questions are
//    independent questions of that request). The request bounds below are shared by everyone on the heartbeat.
//    onVerdict({ beat, verdicts }) receives the verdicts of the provider's OWN questions only:
//      { name, value, accepted, failed, confidence, margin }  (value is one of the proposed options; `none` unless accepted)
//    It may return a closed label saying what it did (kept in the content-free record); it may be async. A provider that
//    throws, in propose or in onVerdict, is ignored for that beat.
// 3. Beats.   hb.subscribe(({ beat, internalMs, facts }) => {})   Facts only; verdicts never go to subscribers.
// 4. Bounds (HEARTBEAT_LIMITS): at most one request per beat and one judged round at a time (a round ends when every
//    onVerdict has settled, or after roundMs); at most maxQuestions per request; requests at least askGapMs (10 s) apart, and
//    20, 40, then 80 s apart after one, two, three or more rounds in a row in which every verdict was `none`, except that an
//    option never offered before on this heartbeat may ask at once; at most maxAsks requests per heartbeat. The owner supplies the judge (hb.setJudge) and with it
//    the egress gate, the Decision budget and the deadline; providers never call the Decision model through the heartbeat.

export const HEARTBEAT_LIMITS = Object.freeze({
  // 5 s: at least three times a cold Decision call (about 1.3-1.6 s after a long idle; 0.25-0.6 s warm), so one beat's judgment is
  // finished before the next beat even cold; and half of the 10 s after which a person should first hear something, so a
  // threshold is noticed at most 5 s late.
  beatMs: 5_000,
  // One hour of beats. A run that is still live after that keeps running; it just has no heartbeat any more.
  maxBeats: 720,
  maxLive: 64, maxProviders: 8, maxListeners: 8,
  // Judged rounds. One small Decision request takes 0.25-0.6 s warm and about 1.3-1.6 s after a long idle, so a request every
  // 10 s (two beats) at most, six per heartbeat, keeps the cost of a long run to a few seconds of judgment.
  askGapMs: 10_000, maxAsks: 6, maxQuestions: 6, maxOptions: 8, roundMs: 60_000,
})
export const HEARTBEAT_PHASES = Object.freeze(['thinking', 'tool_running', 'waiting_user', 'objective_step'])
export const HEARTBEAT_STOP_REASONS = Object.freeze(['run_end', 'cancel', 'disconnect', 'restart', 'start_failed', 'superseded', 'limit'])
const MARKS = Object.freeze(['user', 'posted', 'engine'])
const NAME = /^[a-z][a-z0-9_]{0,31}$/
const LABEL = /^[a-z0-9_]{1,40}$/
const KEY = /^[A-Za-z][A-Za-z0-9]{0,23}$/
const FACT_KEY = /^[a-z][a-z0-9_]{0,63}$/
const PROMPT = /^[\x20-\x7E]{1,300}$/

// Facts are numbers, booleans and closed labels only. Free text can never ride along (these facts go to the decision model).
function sanitize(raw, keyRule = KEY, max = 16) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const [key, value] of Object.entries(raw).slice(0, max)) {
    if (!keyRule.test(key)) continue
    if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.max(-1e9, Math.min(1e9, Math.round(value)))
    else if (typeof value === 'string' && LABEL.test(value)) out[key] = value
    else if (value === null) out[key] = null
  }
  return out
}
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0)

// A provider's question, rebuilt from a whitelist. Null when it is not a closed-vocabulary question with a real choice.
function normalizeQuestion(provider, raw, maxOptions) {
  if (raw === null || typeof raw !== 'object' || !NAME.test(String(raw.name)) || typeof raw.instructions !== 'string' || !PROMPT.test(raw.instructions)) return null
  if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > maxOptions) return null
  const options = []
  for (const option of raw.options) {
    if (option === null || typeof option !== 'object' || typeof option.value !== 'string' || !LABEL.test(option.value) || options.some(o => o.value === option.value)) return null
    if (option.description !== undefined && (typeof option.description !== 'string' || !PROMPT.test(option.description))) return null
    options.push(Object.freeze({ value: option.value, ...(option.description ? { description: option.description } : {}) }))
  }
  const none = typeof raw.none === 'string' ? raw.none : 'none'
  if (!options.some(o => o.value === none)) return null
  const kinds = Array.isArray(raw.kinds) ? raw.kinds.filter(kind => typeof kind === 'string' && LABEL.test(kind)).slice(0, 4) : []
  return Object.freeze({ provider, name: raw.name, wire: `${provider}__${raw.name}`, instructions: raw.instructions, options: Object.freeze(options), none,
    facts: Object.freeze(sanitize(raw.facts, FACT_KEY, 24) ?? {}), kinds: Object.freeze(kinds) })
}

export function createHeartbeat({ key = null, monotonicNow = () => performance.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle),
  limits = HEARTBEAT_LIMITS, onStop = null } = {}) {
  const beatMs = Number.isSafeInteger(limits.beatMs) && limits.beatMs >= 100 ? limits.beatMs : HEARTBEAT_LIMITS.beatMs
  const maxBeats = Number.isSafeInteger(limits.maxBeats) && limits.maxBeats > 0 ? limits.maxBeats : HEARTBEAT_LIMITS.maxBeats
  let state = 'idle', stopReason = null
  let base = 0, resumedAt = 0, beats = 0, timer = null, engineEvents = 0, lastEngineKind = null
  const marks = { user: 0, posted: null, engine: 0 }
  const providers = new Map(), listeners = new Set()
  let source = null
  // Judged rounds (see the contract in the header).
  let judge = null, onRound = null, asks = 0, lastAskAt = -Infinity, noneStreak = 0, roundBusy = false, roundCap = null
  const offered = new Set()
  const lim = name => (Number.isSafeInteger(limits[name]) && limits[name] > 0 ? limits[name] : HEARTBEAT_LIMITS[name])

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
      if (!provider.facts) continue
      let row = null
      try { row = sanitize(provider.facts()) } catch { row = null }
      if (row) { sources[name] = Object.freeze(row); take(row) }
    }
    if (waiting) phase = 'waiting_user'
    else if (objective) phase = 'objective_step'
    else if (stepsRunning > 0) phase = 'tool_running'
    return Object.freeze({ internalMs: t, beat: beats, sinceUserMs: t - marks.user, sincePostedMs: marks.posted === null ? null : t - marks.posted,
      sinceEngineMs: t - marks.engine, engineEvents, lastEngineKind, phase, pendingQuestion, stepsDone, stepsRunning, stepsRemaining: remaining, sources: Object.freeze(sources) })
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
    round(beat)
    if (beats >= maxBeats) { api.stop('limit'); return }
    schedule()
  }

  // One judged round at a beat: collect the questions proposed for this beat, apply the shared bounds, ask ONE request, and give
  // each provider the verdicts of its own questions. A beat on which nobody proposes costs nothing.
  function round(beat) {
    if (!judge || roundBusy || asks >= lim('maxAsks')) return
    const questions = []
    for (const [name, provider] of providers) {
      if (!provider.propose || questions.length >= lim('maxQuestions')) continue
      let list = null
      try { list = provider.propose(beat) } catch { list = null }
      for (const raw of Array.isArray(list) ? list : list ? [list] : []) {
        const question = normalizeQuestion(name, raw, lim('maxOptions'))
        if (question && !questions.some(q => q.wire === question.wire) && questions.length < lim('maxQuestions')) questions.push(question)
      }
    }
    if (!questions.length) return
    const key = (q, o) => `${q.wire}\0${o.value}`
    const fresh = questions.some(q => q.options.some(o => !offered.has(key(q, o))))
    if (!fresh && beat.internalMs - lastAskAt < lim('askGapMs') * 2 ** Math.min(noneStreak, 3)) return
    for (const q of questions) for (const o of q.options) offered.add(key(q, o))
    asks++; lastAskAt = beat.internalMs; roundBusy = true
    const asked = monotonicNow()
    const done = () => { if (roundCap != null) { clearTimer(roundCap); roundCap = null } roundBusy = false }
    roundCap = setTimer(() => { roundCap = null; roundBusy = false }, lim('roundMs')); roundCap?.unref?.()
    void (async () => {
      let answers = null, failure = null
      try { answers = await judge({ beat, questions }) } catch (error) { failure = typeof error?.code === 'string' && LABEL.test(error.code) ? error.code : 'unreachable' }
      const decisionMs = Math.max(0, monotonicNow() - asked)
      const verdicts = questions.map(q => {
        const row = answers && typeof answers === 'object' ? answers[q.wire] : null
        const value = row && q.options.some(o => o.value === row.value) ? row.value : q.none
        const accepted = Boolean(row) && row.accepted === true && value === row.value
        const num = name => (Number.isFinite(row?.[name]) ? row[name] : null)
        return { question: q, verdict: Object.freeze({ name: q.name, value: accepted ? value : q.none, accepted, failed: !row, skipped: row?.skipped === true,
          confidence: num('confidence'), margin: num('margin'), top: num('top'), second: num('second') }) }
      })
      noneStreak = verdicts.every(v => v.verdict.value === v.question.none) ? noneStreak + 1 : 0
      const outcomes = {}
      if (state !== 'stopped') {
        await Promise.all([...new Set(questions.map(q => q.provider))].map(async name => {
          const provider = providers.get(name)
          if (!provider?.onVerdict) return
          try {
            const label = await provider.onVerdict({ beat, verdicts: Object.freeze(verdicts.filter(v => v.question.provider === name).map(v => v.verdict)) })
            if (typeof label === 'string' && LABEL.test(label)) outcomes[name] = label
          } catch { /* a provider never breaks the round */ }
        }))
      }
      try { onRound?.({ beat, decisionMs, failure, outcomes, questions: verdicts.map(v => ({ provider: v.question.provider, name: v.question.name, options: v.question.options.length, none: v.question.none, verdict: v.verdict })) }) } catch { /* ignore */ }
    })().catch(() => {}).finally(done)
  }

  const api = Object.freeze({
    key,
    get state() { return state },
    get stopReason() { return stopReason },
    get beats() { return beats },
    get asks() { return asks },
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
      if (roundCap != null) { clearTimer(roundCap); roundCap = null }
      providers.clear(); listeners.clear(); source = null; judge = null; onRound = null
      try { onStop?.(api) } catch { /* ignore */ }
      return true
    },
    /** label (engine only): a closed word for what kind of engine activity it was (reasoning, output, tool, usage, turn, other). */
    mark(kind, label = null) {
      if (state === 'stopped' || !MARKS.includes(kind)) return false
      marks[kind] = internalMs()
      if (kind === 'engine') { engineEvents++; lastEngineKind = typeof label === 'string' && LABEL.test(label) ? label : 'other' }
      return true
    },
    /** The owner's judge: async ({ beat, questions }) → { [question.wire]: { value, accepted, confidence?, margin?, top?, second?, skipped? } }. onRound gets a content-free summary of every asked beat. */
    setJudge(fn, { onRound: summary = null } = {}) { judge = typeof fn === 'function' ? fn : null; onRound = typeof summary === 'function' ? summary : null },
    /** The owner's own facts (the runtime reads them from the run). One source; providers are for others. */
    setSource(fn) { source = typeof fn === 'function' ? fn : null },
    /** Registration (see the contract in the header): a facts function, or { facts?, propose?, onVerdict? }. Returns unregister(). */
    register(name, provider) {
      const entry = typeof provider === 'function' ? { facts: provider, propose: null, onVerdict: null }
        : provider && typeof provider === 'object' ? { facts: typeof provider.facts === 'function' ? provider.facts.bind(provider) : null,
          propose: typeof provider.propose === 'function' ? provider.propose.bind(provider) : null, onVerdict: typeof provider.onVerdict === 'function' ? provider.onVerdict.bind(provider) : null } : null
      if (state === 'stopped' || !NAME.test(String(name)) || !entry || (!entry.facts && !entry.propose)) return () => {}
      if (!providers.has(name) && providers.size >= (limits.maxProviders ?? HEARTBEAT_LIMITS.maxProviders)) return () => {}
      providers.set(name, entry)
      return () => { if (providers.get(name) === entry) providers.delete(name) }
    },
    subscribe(listener) {
      if (state === 'stopped' || typeof listener !== 'function' || listeners.size >= (limits.maxListeners ?? HEARTBEAT_LIMITS.maxListeners)) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot() { return { key, state, stopReason, beats, asks, internalMs: internalMs(), providers: [...providers.keys()] } },
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
