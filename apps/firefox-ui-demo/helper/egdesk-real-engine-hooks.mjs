// The registration point of the real-engine check (helper/egdesk-real-engine-check.mjs) for features that need more than the check's own composition. Each entry lives in its
// own module and is listed HERE, one line each; the check calls the entries and knows nothing else about them:
//   { name, flags: [EGDESK_…], decisionDependent: [EGDESK_…], active(FLAG) → boolean, conversationFlow?(FLAG, conversation) → keys added to the flow,  attach(deps) → { name, sendExtra?() → chat.send fields, beforeTurn?({ turn, index, clientThreadId, conversationId }), afterTurn?(ctx) → record, dispose?() } }
// The script's `expect.<name>` entry of a turn is validated and checked by the entry's own module (see helper/egdesk-real-engine-script.mjs).
//   deps  { chat, contexts, FLAG, conversation, fetchImpl, key, calibrationLog, requestLog (the check's rec.requests: { method, ms, error? }), client (the Decision client or null), store }   ctx  { run, say, answer, turnIndex, expect (the turn's own `expect.<name>` entry) }
// Lane L4 (briefing): ./egdesk-real-engine-briefing-hook.mjs. Other lanes add their entry to this array.
import { briefingHook } from './egdesk-real-engine-briefing-hook.mjs'
// Lane L1 (collaboration): ./egdesk-real-engine-collab-hook.mjs (two synthetic requesters in one room through the bridge's own requester and presence path).
import { collabHook } from './egdesk-real-engine-collab-hook.mjs'

export const CHECK_HOOKS = Object.freeze([briefingHook, collabHook])
export const hookFlags = () => CHECK_HOOKS.flatMap(h => h.flags ?? [])
export const hookDecisionFlags = () => CHECK_HOOKS.flatMap(h => h.decisionDependent ?? [])
