// The registration point of the real-engine check (helper/egdesk-real-engine-check.mjs) for features that need more than the check's own composition. Each entry lives in its
// own module and is listed HERE, one line each; the check calls the entries and knows nothing else about them:
//   { name, flags: [EGDESK_…], decisionDependent: [EGDESK_…], active(FLAG) → boolean, attach(deps) → { name, sendExtra?() → chat.send fields, afterTurn?(ctx) → record } }
// The script's `expect.<name>` entry of a turn is validated and checked by the entry's own module (see helper/egdesk-real-engine-script.mjs).
//   deps  { chat, contexts, FLAG, conversation, fetchImpl, key, calibrationLog, requestLog (the check's rec.requests: { method, ms, error? }), limits (a test's own limits for this entry: deps.hookLimits[name]) }   ctx  { run, say, answer, turnIndex }
// Lane L4 (briefing): ./egdesk-real-engine-briefing-hook.mjs. Other lanes add their entry to this array.
import { briefingHook } from './egdesk-real-engine-briefing-hook.mjs'

export const CHECK_HOOKS = Object.freeze([briefingHook])
export const hookFlags = () => CHECK_HOOKS.flatMap(h => h.flags ?? [])
export const hookDecisionFlags = () => CHECK_HOOKS.flatMap(h => h.decisionDependent ?? [])
