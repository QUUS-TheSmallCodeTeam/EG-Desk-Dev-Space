import { CONTENT_FREE_REQUESTS, createEgressGate } from './egdesk-decision-egress.mjs'

// Idle warm-up for the Decisions endpoint (L6 c18; developer flag EGDESK_DECISION_WARMUP = advisory | on, default OFF; nothing here runs without it).
//
// Why (measured, evidence/l6-c15, c17, c18): the first Decisions request after a long quiet is slow, and it is not the size of the body.
// 0 of 43 first requests within 2 minutes of the previous one took over 800 ms; 6 of 9 after 10 minutes or more did. The warm-up probe
// (set turn-context-warmup-v1): after about 12 minutes idle the measured turn_context took 1,812 ms (connect 12 ms, TLS 20 ms: the time went to
// the first response), and the SAME body sent 1 s after a tiny request that had landed took 324 ms. That tiny request itself took 1,597 ms: a
// warm-up moves the slow tail, it does not remove it. So it only pays when it is sent BEFORE the person needs the answer.
//
// What it does: when something that will soon need a Decisions request happens, and the last Decisions request (of any kind, the key check
// included) ended at least `idleMs` ago, it sends ONE fixed, content-free request (CONTENT_FREE_REQUESTS.warmup: no person, run, page or text)
// and nobody waits for it. Triggers:
//   'composer'  the person starts typing in a chat composer (the overlay posts /decision/warmup, at most once a minute): the typing time is the lead.
//   'turn'      a turn is about to ask for its context. A warm-up started at that moment cannot be in time for that turn's own request (it takes as
//               long as the slow request would), so by default this trigger does not delay the turn (joinMs 0): it starts a warm-up that helps
//               the turn's LATER requests and is counted as a turn miss. With joinMs > 0 the turn waits for the warm-up to land for at most
//               joinMs (capped at the turn's cold budget; a failed or slow warm-up just ends the wait).
//   advisory    records what it WOULD have done (no request, no tokens): how often the idle condition happens in real use.
// Rules shared with the other Decisions call sites: the request goes through the egress gate (guardContentFree: exactly the registered body), the
// client's own key / budget / timeout rules apply, never retried, a failed warm-up pauses warm-ups for `idleMs`, and nothing is ever thrown into
// the caller. At most one warm-up per idle period follows from the rule itself: the warm-up is traffic, so the next trigger sees "recent traffic".
// Cost per idle period: stats() / periods() count the warm-ups, their reported input tokens, whether a real request followed (else the warm-up
// was wasted), the warm-up's own time, the lead (end of the warm-up to the start of the first real request) and that request's time.

export const WARMUP_IDLE_MS = 5 * 60_000 // first requests over 800 ms: 0 of 6 at 2 to 5 min, 3 of 7 at 5 to 10 min, 6 of 9 at 10 min or more (latency-v7.json)
export const WARMUP_TIMEOUT_MS = 5_000
export const WARMUP_MAX_JOIN_MS = 1_500 // the turn's cold budget when this was set (1,500 ms; it is 1,800 since u5, a join this short stays inside it): a longer wait than the turn itself allows is never useful
export const WARMUP_RECENT_PERIODS = 50
export const WARMUP_REASONS = Object.freeze(['composer', 'turn'])
export const WARMUP_SKIP_CODES = Object.freeze(['disabled', 'mode_off', 'no_key', 'recent_traffic', 'in_flight', 'paused_after_failure', 'bad_reason'])

/** The flag value: only 'advisory' and 'on' turn anything on. */
export const warmupMode = value => (value === 'advisory' || value === 'on' ? value : 'off')
const clampInt = (value, low, high, fallback) => { const n = Number(value); return Number.isSafeInteger(n) && n >= low && n <= high ? n : fallback }
/** EGDESK_DECISION_WARMUP (mode), EGDESK_DECISION_WARMUP_IDLE_MIN (1..60 minutes, default 5), EGDESK_DECISION_WARMUP_JOIN_MS (0..1500, default 0). */
export function warmupConfigFromEnv(env = {}) {
  return { mode: warmupMode(env.EGDESK_DECISION_WARMUP), idleMs: clampInt(env.EGDESK_DECISION_WARMUP_IDLE_MIN, 1, 60, WARMUP_IDLE_MS / 60_000) * 60_000,
    joinMs: clampInt(env.EGDESK_DECISION_WARMUP_JOIN_MS, 0, WARMUP_MAX_JOIN_MS, 0) }
}

const isWarmupBody = body => {
  try {
    const x = JSON.parse(String(body)), fixed = CONTENT_FREE_REQUESTS.warmup
    return x?.input === fixed.input && Array.isArray(x.questions) && x.questions.length === 1 && x.questions[0]?.name === fixed.questions[0].name
  } catch { return false }
}

/**
 * createDecisionActivity({ now?, idleMs?, keep? }) -> { wrap(fetchImpl), lastEndedAt(), busy(), periods() }
 * wrap() returns a fetch that notes, for every request, when it started, when its response (headers) or error came back, the status, and
 * whether it was the fixed warm-up body. Times and closed words only; nothing else is read from the request or the response.
 * A period starts with a request that began at least idleMs after the previous request ended (or the very first request); a warm-up, being
 * traffic, belongs to the period it starts in.
 */
export function createDecisionActivity({ now = () => Date.now(), idleMs = WARMUP_IDLE_MS, keep = WARMUP_RECENT_PERIODS } = {}) {
  let lastEnd = null, open = 0
  const list = []
  function wrap(fetchImpl) {
    if (typeof fetchImpl !== 'function') throw new TypeError('wrap needs a fetch')
    return async (url, init) => {
      const startedAt = now(), warmup = isWarmupBody(init?.body)
      if (list.length === 0 || (open === 0 && lastEnd !== null && startedAt - lastEnd >= idleMs)) {
        list.push({ startedAt, idleBeforeMs: lastEnd === null ? null : startedAt - lastEnd, requests: [] })
        while (list.length > keep) list.shift()
      }
      const mine = list[list.length - 1]
      open++
      let status = 0
      try { const response = await fetchImpl(url, init); status = Number(response?.status) || 0; return response } finally {
        open--
        const endedAt = now()
        lastEnd = endedAt
        mine.requests.push({ kind: warmup ? 'warmup' : 'real', offsetMs: startedAt - mine.startedAt, ms: Math.max(0, endedAt - startedAt), status })
      }
    }
  }
  return Object.freeze({
    wrap, lastEndedAt: () => lastEnd, busy: () => open > 0,
    /** Copies of the recent periods, oldest first; the last may still be open. */
    periods: () => list.map(p => ({ ...p, requests: p.requests.map(r => ({ ...r })).sort((a, b) => a.offsetMs - b.offsetMs) })),
  })
}

/**
 * createDecisionWarmup({ client, activity, mode, decisionsMode, hasKey, now?, idleMs?, joinMs?, timeoutMs? })
 *   client: the Decisions client; activity: createDecisionActivity() whose wrap() is that client's fetch
 *   mode(): the flag ('off' | 'advisory' | 'on'); decisionsMode(): the Decisions mode ('off' | 'advisory' | 'on'); hasKey(): a key is saved
 * -> { trigger(reason), beforeTurn(), settled(), stats(), periods() }
 */
export function createDecisionWarmup({ client, activity, mode = () => 'off', decisionsMode = () => 'off', hasKey = () => false,
  now = () => Date.now(), idleMs = WARMUP_IDLE_MS, joinMs = 0, timeoutMs = WARMUP_TIMEOUT_MS } = {}) {
  if (!client || typeof client.decide !== 'function') throw new TypeError('client.decide is required')
  if (!activity || typeof activity.lastEndedAt !== 'function') throw new TypeError('activity is required')
  const gated = createEgressGate({}).guardContentFree(client, 'warmup')
  const totals = { triggers: 0, sent: 0, wouldWarm: 0, landed: 0, failed: 0, inputTokens: 0, turnMisses: 0, skipped: {}, failures: {}, byReason: {} }
  let flight = null, pausedUntil = 0
  const skip = why => { totals.skipped[why] = (totals.skipped[why] ?? 0) + 1; return { action: 'skipped', why } }
  async function run() {
    try {
      const out = await gated.decide({ input: CONTENT_FREE_REQUESTS.warmup.input, questions: CONTENT_FREE_REQUESTS.warmup.questions, timeoutMs })
      totals.landed++
      if (Number.isFinite(out?.usage?.inputTokens)) totals.inputTokens += out.usage.inputTokens
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'unreachable'
      totals.failed++; totals.failures[code] = (totals.failures[code] ?? 0) + 1
      pausedUntil = now() + idleMs
    } finally { flight = null }
  }
  /** One decision. Never throws, sends at most one request and never waits for it. -> { action: 'sent' | 'would_warm' | 'skipped', why? } */
  function trigger(reason) {
    try {
      totals.triggers++
      totals.byReason[reason] = (totals.byReason[reason] ?? 0) + 1
      if (!WARMUP_REASONS.includes(reason)) return skip('bad_reason')
      const flag = mode()
      if (flag !== 'advisory' && flag !== 'on') return skip('disabled')
      const dm = decisionsMode()
      if (dm !== 'advisory' && dm !== 'on') return skip('mode_off')
      if (hasKey() !== true) return skip('no_key')
      if (flight) return skip('in_flight')
      const t = now(), last = activity.lastEndedAt()
      if (activity.busy() || (last !== null && t - last < idleMs)) return skip('recent_traffic')
      if (t < pausedUntil) return skip('paused_after_failure')
      if (reason === 'turn') totals.turnMisses++
      if (flag === 'advisory') { totals.wouldWarm++; return { action: 'would_warm' } }
      totals.sent++
      flight = run()
      return { action: 'sent' }
    } catch { return skip('disabled') }
  }
  /**
   * A turn calls this before its first Decisions request. Returns null (the turn goes on at once) unless joinMs > 0 and a warm-up is in
   * flight; then a promise that resolves when the warm-up settles or after joinMs, whichever is first.
   */
  function beforeTurn() {
    try { trigger('turn') } catch { return null }
    const waiting = flight
    if (!(joinMs > 0) || !waiting) return null
    return new Promise(resolve => {
      const timer = setTimeout(resolve, Math.min(joinMs, WARMUP_MAX_JOIN_MS))
      waiting.then(() => { clearTimeout(timer); resolve() })
    })
  }
  function periods() {
    return activity.periods().map(p => {
      const warm = p.requests.filter(r => r.kind === 'warmup'), real = p.requests.filter(r => r.kind === 'real')
      const w = warm[0] ?? null, first = real[0] ?? null
      return { startedAt: p.startedAt, idleBeforeMs: p.idleBeforeMs, warmups: warm.length, warmupMs: w?.ms ?? null, warmupStatus: w?.status ?? null,
        realRequests: real.length, firstRealMs: first?.ms ?? null,
        // end of the warm-up to the start of the first real request (negative: the real request began before the warm-up had landed)
        leadMs: w && first ? first.offsetMs - (w.offsetMs + w.ms) : null,
        wasted: w !== null && real.length === 0 }
    })
  }
  function stats() {
    const rows = periods(), withWarm = rows.filter(r => r.warmups > 0)
    return { mode: mode(), idleMinutes: idleMs / 60_000, joinMs, ...totals, skipped: { ...totals.skipped }, failures: { ...totals.failures }, byReason: { ...totals.byReason },
      periods: rows.length, periodsWithWarmup: withWarm.length, wastedPeriods: rows.filter(r => r.wasted).length, warmupsPerPeriodMax: rows.reduce((m, r) => Math.max(m, r.warmups), 0),
      inputTokensPerWarmup: totals.landed > 0 ? Math.round(totals.inputTokens / totals.landed) : null, recent: rows.slice(-10) }
  }
  return Object.freeze({ trigger, beforeTurn, settled: () => flight ?? Promise.resolve(), stats, periods })
}
