// c32 (owner direction U13, "끼릭끼릭 탁탁"; audit l6-c29-u13-audit.md R-A, corrected by the owner: the approval STATE is the action layer, the words are the conversation layer):
// approvals decision-first, behind EGDESK_DECISION_FIRST_APPROVALS=on (needs EGDESK_DECISION_FIRST=on; default off).
//
// Today: the gate denies a command that needs the person (needs_person), the ENGINE words the question, the person answers, and only then does a new engine turn start in which the
// engine calls the tool again (8.1 s measured) to run it; a decline stalled to a 180 s timeout twice in real runs. With the flag, the question stays the engine's (conversation layer:
// nothing is posted by code, no new copy). What changes is the reply: the Decision settles which pending approval it refers to and whether it approves or declines (the existing approval
// judgement, reply_runs_command / reply_declines_command, against the one command the ledger waits on), and CODE acts at once: it runs the approved command once through the executor, or
// cancels the declined one. Then the engine continues ONCE, with what became of the command as context (no tool call needed), and words the answer.
// Expected (audit): the command runs 0.9 s after the reply instead of 8.1 s, a decline is settled in 0.4 s instead of waiting on the engine.
export const APPROVALS_FAST_LIMITS = Object.freeze({ commandChars: 300, tailChars: 600, timeoutMs: 2500 })
export const APPROVAL_RESULT_KEY = 'egdesk_approval_outcome'

/** What the engine's continuing turn is told (EG-Desk context, facts only; never shown in the chat). */
export function approvalOutcomeBlock({ outcome, command, exitCode = null, durationMs = null, tail = '' } = {}) {
  const head = 'EG-Desk fact about the command the person was asked to approve in this conversation:'
  const c = `\`${String(command ?? '').slice(0, APPROVALS_FAST_LIMITS.commandChars)}\``
  if (outcome === 'declined') return `${head}\nThe person declined ${c}. EG-Desk did not run it, and it is not pending any more. Do not call the tool for it.`
  if (outcome === 'ran') return `${head}\nThe person approved ${c}; EG-Desk ran it once${Number.isFinite(durationMs) ? ` (${(Math.round(durationMs / 100) / 10).toFixed(1)} s)` : ''}${exitCode === null ? ' (no exit code)' : ` with exit code ${exitCode}`}. Do not call the tool for it again.${tail ? `\nLast lines of its output:\n${String(tail).slice(-APPROVALS_FAST_LIMITS.tailChars)}` : ''}`
  return `${head}\nThe person's reply did not approve ${c}; EG-Desk did not run it.`
}
