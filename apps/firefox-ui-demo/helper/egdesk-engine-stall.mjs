// c33 (U13: a silent engine must not cost 180 s): the first-event watchdog of an engine turn. L3 found the 180 s hangs are engine-side "accepted, then silent": turn/start answers in under
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

/** The turn id an engine message belongs to (null: a thread-level message). */
export function eventTurnId(message) {
  const p = message?.params ?? {}
  for (const v of [p.turnId, p.turn?.id, p.item?.turnId]) if (typeof v === 'string' && v) return v
  return null
}

/** The closed fact kept for the heartbeat and the run: numbers and words only. */
export function stallFact({ afterMs, stalls, recovered }) {
  return Object.freeze({ stalled: true, afterMs, count: stalls, retried: stalls >= 1 && recovered !== null, recovered: recovered === true, outcome: recovered === true ? 'recovered' : 'failed' })
}
