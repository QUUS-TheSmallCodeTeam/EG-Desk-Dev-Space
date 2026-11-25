// u4: the decision-call log. Flag EGDESK_DECISION_CALL_LOG=on (developer flag, default off; not part of the EGDESK_UPPER bundle: that is the Approvals lane's file, the report proposes it).
//
// For every turn, each call to the decision model is noted as ONE closed row: what kind of call it was, when it started and ended (ms from the start of the turn), how many input tokens it sent and how many of them
// were read from the cache, and how it ended. Nothing the person wrote, no question text, no candidate sentence, no answer: only these numbers and closed words. The rows are kept in memory (a bounded ring, read by the
// internal route GET /chat/decision-calls) and written into the turn's own record: the \`calls\` list of the decision-context activity's detail, which the existing store persists with the run.
//
// The log sits at ONE place: around the real Decision client (recordDecisionCalls). Every feature that asks the decision model already goes through that client, so none of them changed. The turn a call belongs to is the
// request that was being handled when the call started (AsyncLocalStorage: the runtime opens a scope in send() and, for work that follows the answer, in the event queue, keyed by the run's request id).
//
// Pure apart from the clock and AsyncLocalStorage: no I/O, no logging.
import { AsyncLocalStorage } from 'node:async_hooks'

export const DECISION_CALL_LOG_FLAG = 'EGDESK_DECISION_CALL_LOG'
export const DECISION_CALL_KINDS = Object.freeze(['context', 'pick', 'approval_reply', 'open_items', 'nunchi', 'check', 'command_gate', 'run_conditions', 'terminal_state', 'memory', 'working_memory', 'record', 'browser', 'placement', 'hud_routing', 'heartbeat', 'warmup', 'other'])
export const DECISION_CALL_OUTCOMES = Object.freeze(['ok', 'refused', 'timeout', 'budget', 'unreachable', 'bad_response', 'aborted', 'error'])
export const DECISION_CALL_LIMITS = Object.freeze({ turns: 64, callsPerTurn: 48 })

const CACHE_KEYS = new Map([['decision-first-commands', 'pick'], ['draft-check', 'check'], ['heartbeat-beat', 'heartbeat'], ['hud-routing', 'hud_routing'], ['work-placement', 'placement']])
// question-name prefixes (names only: the table never reads a question's text); the first match wins, so a prefix that two features share (same_) stays with the narrower feature
const NAME_KINDS = Object.freeze([
  [/^df_pick$/, 'pick'], [/^reply_(runs|declines)_command$/, 'approval_reply'], [/^oi_ref_/, 'open_items'], [/^nk_/, 'nunchi'],
  [/^(answer_type|time_intent|rel_|branch_base$|plan$|transition_kind$|keep_branch$|fact_)/, 'context'],
  [/^(sup_|tense_|claim_|present_)/, 'check'], [/^risk_/, 'command_gate'], [/^output_reports_/, 'run_conditions'], [/^(terminal_state$|log_)/, 'terminal_state'],
  [/^(tn_|tw_)/, 'memory'], [/^(wm_|role_|topic_need_)/, 'working_memory'], [/^(rc_|cf_|ct_)/, 'record'],
  [/^(owner_action$|same_matter_)/, 'placement'], [/^(assistant_request$|web_search$|goes_to_)/, 'hud_routing'],
  [/^(ps_|next_step$|goal_met$|same_|field_|task_resume$)/, 'browser'], [/^warmup$/, 'warmup'],
])

/** The closed kind of a decision request, from its prompt cache key and the NAMES of its questions. */
export function callKindOf(request) {
  const key = typeof request?.promptCacheKey === 'string' ? CACHE_KEYS.get(request.promptCacheKey) : null
  if (key) return key
  const names = (Array.isArray(request?.questions) ? request.questions : []).map(q => (typeof q?.name === 'string' ? q.name : ''))
  for (const [pattern, kind] of NAME_KINDS) if (names.some(name => pattern.test(name))) return kind
  return 'other'
}

/** The closed outcome of a failed call (the client's DecisionError codes and the runtime's own refusals). */
export function callOutcomeOf(error) {
  const code = String(error?.code ?? '')
  if (/^decision_(mode_off|not_configured)$/.test(code) || /egress|refus/i.test(code)) return 'refused'
  if (/timeout/i.test(code)) return 'timeout'
  if (/budget/i.test(code)) return 'budget'
  if (/bad_response|invalid_response|schema/i.test(code)) return 'bad_response'
  if (/unreachable|network|offline|http/i.test(code)) return 'unreachable'
  if (error?.name === 'AbortError' || /abort/i.test(code)) return 'aborted'
  return 'error'
}

const count = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null)

export function createDecisionCallLog({ now = Date.now, limits = {} } = {}) {
  const L = { ...DECISION_CALL_LIMITS, ...limits }
  const als = new AsyncLocalStorage()
  const turns = new Map() // key -> { t0, calls: [...] }
  const listeners = new Set()
  const turnOf = key => {
    let turn = turns.get(key)
    if (!turn) {
      turn = { key, t0: null, calls: [] }; turns.set(key, turn)
      while (turns.size > L.turns) turns.delete(turns.keys().next().value)
    }
    return turn
  }
  const relative = (turn, call) => ({ kind: call.kind, startMs: Math.round(call.startAt - turn.t0), endMs: Math.round(call.endAt - turn.t0), inputTokens: call.inputTokens, cachedTokens: call.cachedTokens, outcome: call.outcome })
  return {
    /** Run fn with calls attributed to this turn's key (the request id). */
    now,
    scope(key, fn) { return typeof key === 'string' && key ? als.run({ key }, fn) : fn() },
    currentKey() { return als.getStore()?.key ?? null },
    /** The start of a turn: the zero of every call's relative times (the first begin of a key wins). */
    beginTurn(key, at = now()) { if (typeof key !== 'string' || !key) return; const turn = turnOf(key); if (turn.t0 === null) turn.t0 = at },
    record({ key, kind, startAt, endAt, usage = null, outcome = 'ok' }) {
      if (typeof key !== 'string' || !key) return null
      const turn = turnOf(key)
      if (turn.t0 === null) turn.t0 = startAt
      const row = { kind: DECISION_CALL_KINDS.includes(kind) ? kind : 'other', startAt, endAt, inputTokens: count(usage?.inputTokens), cachedTokens: count(usage?.cachedTokens), outcome: DECISION_CALL_OUTCOMES.includes(outcome) ? outcome : 'error' }
      if (turn.calls.length < L.callsPerTurn) turn.calls.push(row)
      for (const fn of [...listeners]) { try { fn(key, relative(turn, row)) } catch { /* a listener never affects a call */ } }
      return relative(turn, row)
    },
    /** The turn's calls in the order they began, as closed rows relative to the turn's start. */
    callsFor(key) { const turn = turns.get(key); return turn ? [...turn.calls].sort((a, b) => a.startAt - b.startAt).map(call => relative(turn, call)) : [] },
    /** The most recent turns (newest last): [{ requestId, startedAt, calls }]. */
    recent(limit = 10) {
      const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, L.turns) : 10
      return [...turns.values()].slice(-n).map(turn => ({ requestId: turn.key, startedAt: turn.t0, calls: this.callsFor(turn.key) }))
    },
    onCall(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

/**
 * The real client with every decide() noted. Everything else of the client (model, verifyKey, ...) is the client's own; \`callLog\` is the log, so the runtime finds it on whatever wraps this client.
 * A call outside any turn's scope has no key and is not noted.
 */
export function recordDecisionCalls(client, log) {
  if (!client || !log) return client
  return Object.create(client, {
    callLog: { enumerable: false, value: log },
    decide: { enumerable: true, value: async request => {
      const key = log.currentKey(), startAt = log.now(), kind = callKindOf(request)
      if (!key) return client.decide(request)
      try {
        const out = await client.decide(request)
        log.record({ key, kind, startAt, endAt: log.now(), usage: out?.usage, outcome: 'ok' })
        return out
      } catch (error) {
        log.record({ key, kind, startAt, endAt: log.now(), outcome: callOutcomeOf(error) })
        throw error
      }
    } },
  })
}

/** The log for this environment: null (off) unless EGDESK_DECISION_CALL_LOG is exactly 'on'. */
export const decisionCallLogFromEnv = (env = {}) => (env?.[DECISION_CALL_LOG_FLAG] === 'on' ? createDecisionCallLog() : null)
