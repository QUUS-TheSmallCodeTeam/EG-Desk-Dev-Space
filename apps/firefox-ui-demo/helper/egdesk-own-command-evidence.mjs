// c29: what the draft check of a run's ANSWER may know about the commands EG-Desk ran itself (egdesk_run_command). Until now the check saw an own command as a content-free
// reference (the run's activity is a dynamic tool call, not a commandExecution), so "테스트가 모두 통과했습니다" had nothing to be supported by, and a false one had nothing
// to be caught by. The facts are the arbiter's (egdesk-run-conditions.mjs): the exit code, how it ended, the test runner's own summary line and its counts. The same words
// as the heartbeat's evidence (egdesk-conversation-flow.mjs): the quoted line only where the run may send command output.
export const OWN_COMMAND_LIMITS = Object.freeze({ commands: 8, commandChars: 300, lineChars: 300 })
const oneLine = (text, n) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** The run's record of one command it ran (kept by CodexChatRuntime.noteOwnCommand): plain facts, frozen. */
export function ownCommandEntry(record) {
  const summary = record?.health?.summary ?? null
  return Object.freeze({
    command: typeof record?.command === 'string' ? oneLine(record.command, OWN_COMMAND_LIMITS.commandChars) : null,
    stopped: record?.stopped === true, exitCode: Number.isSafeInteger(record?.exitCode) ? record.exitCode : null, durationMs: Number.isFinite(record?.durationMs) ? record.durationMs : null,
    health: record?.health?.health ?? null, healthReasons: Array.isArray(record?.health?.reasons) ? record.health.reasons.slice(0, 6) : [],
    summary: summary ? Object.freeze({ runner: summary.runner ?? null, passed: summary.passed, failed: summary.failed, total: Number.isSafeInteger(summary.total) ? summary.total : null, line: oneLine(summary.line, OWN_COMMAND_LIMITS.lineChars) }) : null,
    worktree: record?.worktree ? Object.freeze({ state: record.worktree.state }) : null,
  })
}

/** One evidence item for the check: kind terminal, as the run's own facts. `quoteLine`: the run may send command output (egress command_output). */
export function ownCommandEvidence(entry, index, { quoteLine = false } = {}) {
  const took = Number.isFinite(entry.durationMs) && entry.durationMs >= 1000 ? ` after about ${Math.round(entry.durationMs / 1000)} seconds` : ''
  const ended = entry.stopped ? 'was stopped before it finished (the person stopped the run); it did not complete'
    : entry.exitCode === 0 ? `finished${took} with exit code 0, which means the command itself reported success`
    : entry.exitCode !== null ? `finished${took} with exit code ${entry.exitCode}, which means the command itself reported a failure` : `ended${took} without an exit code (it did not finish normally)`
  const parts = [`In this turn the assistant ran${entry.command ? ` \`${entry.command}\`` : ' a command'} with EG-Desk's own command tool; it ${ended}.`]
  if (entry.summary && !entry.stopped) {
    const s = entry.summary, counts = `${s.passed} passed, ${s.failed} failed${Number.isSafeInteger(s.total) ? `, ${s.total} in total` : ''}`
    parts.push(quoteLine ? `Its test runner's own summary line reads "${s.line}" (${counts}).` : `Its test runner counted ${counts}.`)
  } else if (entry.health === 'healthy' && !entry.stopped) parts.push('No test summary was printed.')
  if (entry.health === 'unknown' && !entry.stopped) parts.push('Whether it fully worked is not confirmed.')
  if (entry.worktree?.state === 'conflict') parts.push('Git reports files in conflict.')
  // facts: the same reading as numbers, for the draft check's rule on completion claims (helper/egdesk-draft-run-facts.mjs)
  const facts = { kind: 'own_command', passed: entry.summary ? entry.summary.passed : null, failed: entry.summary ? entry.summary.failed : null, exitCode: entry.exitCode, stopped: entry.stopped === true, hasSummary: Boolean(entry.summary) }
  return { id: `own${index + 1}`, kind: 'terminal', time: 'present', source: 'run', pinned: true, facts, text: parts.join(' ') }
}
