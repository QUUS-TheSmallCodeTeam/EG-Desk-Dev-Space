// c33 + c34 fix (U13: a silent engine must not cost 180 s): the first-PROGRESS watchdog of an engine turn. (c34: check-29st showed the real shape: turn/started and the user message item came within 2 ms, then
// nothing for 180 s, so a plain "first event" rule was satisfied by the preamble and never fired. Progress = any event of the turn beyond that preamble: an assistant item or delta, reasoning, a tool call, an approval.)
// c33: the first-event watchdog of an engine turn. L3 found the 180 s hangs are engine-side "accepted, then silent": turn/start answers in under
// 60 ms and then no event ever comes for that turn (product state clean). A healthy turn sends events for its turn id (turn started, the user message item, reasoning, ...); this module only
// decides: how long to wait for the first one, and whether a retry is allowed. Behind EGDESK_ENGINE_STALL_FIRST_EVENT_MS (developer flag, default off).
// Retry rule (code): one retry only, and only when nothing ran: the wait is BEFORE the run exists, so no tool call, no approval and no item beyond the user message was seen for the turn.
export const ENGINE_STALL_LIMITS = Object.freeze({ minMs: 5_000, maxMs: 120_000, interruptMs: 3_000 })
export const ENGINE_STALL_FLAG = 'EGDESK_ENGINE_STALL_FIRST_EVENT_MS'

/** The milliseconds from the flag value, or null (off): an integer within the limits; anything else is off, never a guess. */
export function stallConfigFromEnv(env = {}) {
  const raw = env?.[ENGINE_STALL_FLAG]
  if (typeof raw !== 'string' || !/^\d{4,6}$/.test(raw)) return null
  const ms = Number(raw)
  return ms >= ENGINE_STALL_LIMITS.minMs && ms <= ENGINE_STALL_LIMITS.maxMs ? { firstEventMs: ms } : null
}

/**
 * Is this engine message PROGRESS of its turn? The preamble the engine sends the moment it accepts a turn is not: turn/started and the item events of the user's own message. Every other
 * message that carries the turn id is (an assistant or reasoning item, a delta, a tool call, an approval request, the turn's completion). Thread-level messages carry no turn id and are not.
 */
export function isProgressEvent(message) {
  if (!eventTurnId(message)) return false
  const method = String(message?.method ?? '')
  if (method === 'turn/started') return false
  if ((method === 'item/started' || method === 'item/completed') && message?.params?.item?.type === 'userMessage') return false
  return true
}

/** The turn id an engine message belongs to (null: a thread-level message). */
export function eventTurnId(message) {
  const p = message?.params ?? {}
  for (const v of [p.turnId, p.turn?.id, p.item?.turnId]) if (typeof v === 'string' && v) return v
  return null
}

/**
 * c36: what a conversation's record says about the watchdog. `log` is the runtime's list of stall facts (one per turn that stalled: stalls = interrupts of that turn, recovered true = the retry spoke).
 * { armed: ms | null, source: 'option' | 'script' | null, stalls, rescued, failed, interrupts, retries }
 */
export function stallRecord({ armed = null, source = null, log = [] } = {}) {
  const facts = Array.isArray(log) ? log.filter(f => f && typeof f === 'object') : []
  const rescued = facts.filter(f => f.recovered === true).length, failed = facts.length - rescued
  return { armed: Number.isFinite(armed) ? armed : null, source: Number.isFinite(armed) ? source : null, stalls: facts.length, rescued, failed, interrupts: facts.reduce((n, f) => n + (Number.isSafeInteger(f.count) ? f.count : 1), 0), retries: facts.filter(f => f.retried === true).length }
}

/** Two records of one conversation (the segments around a restart) as one. */
export function mergeStallRecords(a, b) {
  if (!a) return b ?? null
  if (!b) return a
  return { armed: a.armed ?? b.armed, source: a.source ?? b.source, stalls: a.stalls + b.stalls, rescued: a.rescued + b.rescued, failed: a.failed + b.failed, interrupts: a.interrupts + b.interrupts, retries: a.retries + b.retries }
}

/** The run summary: { armed (conversations), stalls, rescued, failed, interrupts, retries } and its one line. */
export function stallTotals(records) {
  const list = (Array.isArray(records) ? records : []).map(r => r?.stallWatchdog).filter(Boolean)
  return list.reduce((t, s) => ({ armed: t.armed + (s.armed !== null ? 1 : 0), stalls: t.stalls + s.stalls, rescued: t.rescued + s.rescued, failed: t.failed + s.failed, interrupts: t.interrupts + s.interrupts, retries: t.retries + s.retries }), { armed: 0, stalls: 0, rescued: 0, failed: 0, interrupts: 0, retries: 0 })
}
export const stallLine = totals => `stalls: ${totals.stalls}, rescued: ${totals.rescued}, failed: ${totals.failed}`

/** The closed fact kept for the heartbeat and the run: numbers and words only. */
export function stallFact({ afterMs, stalls, recovered }) {
  return Object.freeze({ stalled: true, afterMs, count: stalls, retried: stalls >= 1 && recovered !== null, recovered: recovered === true, outcome: recovered === true ? 'recovered' : 'failed' })
}
