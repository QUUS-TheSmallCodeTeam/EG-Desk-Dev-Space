// Durable entry telemetry is deliberately NOT the UI frame. Unknown strings never pass this boundary.
export const ENTRY_STEP_EVENT = 'browser.entry.step'
const ops = new Set(['open', 'submit', 'press', 'fill', 'scroll', 'end'])
const statuses = new Set(['done', 'paused', 'cancelled', 'need_context', 'needs_guidance', 'needs_value', 'cannot_proceed', 'cannot', 'human_step', 'ok', 'failed', 'handoff'])
const codes = new Set(['POSTCONDITION_UNVERIFIED', 'BROWSER_OBSERVATION_STALE', 'BROWSER_ACTION_REJECTED', 'BROWSER_TOOL_TIMEOUT', 'tool_failed', 'observe_failed', 'step_limit', 'step_rejected', 'site_not_allowed', 'site_pending', 'blocked', 'access_denied', 'error_page', 'modal_blocking', 'uncertain', 'needs_value', 'detail_needed', 'choice_needed', 'confirm_needed', 'page_unclear', 'card_choice_needed', 'login_required', 'two_factor_required', 'bot_check'])
export function closedEntryStep(event, { callId, seq, completedAt, durationMs } = {}) {
  if (typeof callId !== 'string' || !/^entry-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(callId) || !Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(completedAt) || completedAt < 0) return null
  if (!ops.has(event?.op) || !['decision', 'model'].includes(event.by) || typeof event.ok !== 'boolean') return null
  return { callId, seq, by: event.by, op: event.op, status: statuses.has(event.status) ? event.status : event.op === 'end' && !event.ok ? 'handoff' : event.ok ? 'ok' : 'failed', completedAt,
    durationMs: Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : null, ok: event.ok,
    ...(!event.ok && event.code ? { code: codes.has(event.code) ? event.code : 'other' } : {}) }
}
