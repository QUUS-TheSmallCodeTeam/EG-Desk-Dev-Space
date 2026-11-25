// c37: the plan of a --engine claude run (dry by default: nothing is started, the CLI is not run). Pure: the check passes in what it owns (flags, clip, the key name).
import path from 'node:path'
import { claudeApplicability, claudeInventory } from './egdesk-real-engine-claude.mjs'

/** planClaudeRun(options, scripts, { env, resolveClaude, defaultDecisionFlags, stallFlag, clip, decisionKeyEnv }) → plan data */
export function planClaudeRun(options, scripts, { env, resolveClaude, defaultDecisionFlags, stallFlag, clip, decisionKeyEnv }) {
  const override = typeof env.EGDESK_CLAUDE_BIN === 'string' && env.EGDESK_CLAUDE_BIN.trim() ? env.EGDESK_CLAUDE_BIN : null
  const probeEnv = { PATH: env.PATH ?? '', HOME: env.HOME ?? '', ...(options.claudeBin ? { EGDESK_CLAUDE_BIN: options.claudeBin } : override ? { EGDESK_CLAUDE_BIN: override } : {}) }
  let resolved = null
  try { resolved = resolveClaude(probeEnv) } catch { resolved = null }
  let counted = 0
  const conversations = scripts.flatMap(({ file, script }) => script.conversations.map(c => {
    const verdict = claudeApplicability(c)
    const within = verdict.applicable && (options.maxConversations === null || counted < options.maxConversations)
    if (within) counted++
    return {
      set: script.set, file, id: c.id, scratch: path.join(options.out, 'scratch', c.id), files: Object.keys(c.folder ?? {}).length,
      flags: { ...(options.decisions ? defaultDecisionFlags : {}), ...stallFlag(options, c), ...(c.flags ?? {}), EGDESK_OWN_TOOLS: 'on' },
      turns: c.turns.map(t => ({ say: t.action === 'restart' ? '(restart)' : clip(t.say, 80), approve: t.approve ?? [], expects: Object.keys(t.expect ?? {}) })),
      claude: { runs: within, notApplicable: verdict.notApplicable, untested: verdict.untested, ...(verdict.applicable && !within ? { skippedBy: '--max-conversations' } : {}) },
    }
  }))
  return {
    mode: options.mode, engine: 'claude',
    claudeBin: resolved
      ? { path: resolved, via: options.claudeBin ? '--claude-bin' : override ? 'EGDESK_CLAUDE_BIN' : 'PATH or the well-known install folders' }
      : { path: null, via: 'not found: --claude-bin, EGDESK_CLAUDE_BIN, PATH and ~/.local/bin/claude were searched' },
    login: `API-KEY login only (claude auth login --console, or the key the CLI itself is configured with): the product's static check (claude --version, claude auth status --json) runs at start and the run REFUSES a claude.ai subscription login${options.allowSubscriptionSmoke ? ' (--allow-subscription-smoke is given: a subscription is accepted, chosen explicitly by the person, not for batches)' : ' unless --allow-subscription-smoke is given'}; EG-Desk never reads the credential and passes no key`,
    out: options.out, decisions: options.decisions, model: options.model, effort: options.effort, turnTimeoutMs: options.turnTimeoutMs,
    guard: { stopAtPercent: options.usageStopPercent, maxConversations: options.maxConversations, usageState: options.usageState, requireUsageSignal: options.requireUsageSignal,
      signal: "rate_limit_event of the CLI's stream-json (sent on a state change, not on every turn); no credential is read" },
    inventory: claudeInventory(),
    rules: ["one Claude process per conversation (the adapter's own limit), own tools ON through the adapter's in-process MCP server, the engine runs in EG-Desk's empty folder",
      'the CLI writes its own session files (ephemeral threads are not offered): the record lists the session ids; the check deletes nothing', 'no retries',
      `Decision calls only with --decisions (key from ${decisionKeyEnv}), through the run's egress gate`],
    conversations,
  }
}

export function formatClaudePlan(plan, warnings = [], { decisionKeyEnv }) {
  const guard = plan.guard
  const lines = [`real-engine check, engine claude (${plan.mode === 'dry' ? 'DRY: nothing is started, the CLI is not run' : 'RUN'})`,
    `  claude: ${plan.claudeBin.path ?? 'NOT FOUND'}   (${plan.claudeBin.via})`, `  login: ${plan.login}`, `  out: ${plan.out}`,
    `  decisions: ${plan.decisions ? `on (key from ${decisionKeyEnv})` : 'off'}`,
    `  usage guard: stop at >= ${guard.stopAtPercent}% of any window, or on any warning or rejection; at most ${guard.maxConversations} conversations; signal: ${guard.signal}${guard.usageState ? `; state file ${guard.usageState}` : '; no state file (a first run knows nothing before its first conversation)'}${guard.requireUsageSignal ? '; stops when there is still no signal after the first conversation' : ''}`]
  for (const c of plan.conversations) {
    const state = c.claude.runs ? 'RUNS' : c.claude.notApplicable.length ? 'NOT APPLICABLE (skipped, not failed)' : `skipped by ${c.claude.skippedBy}`
    lines.push(`  conversation ${c.set}/${c.id}: ${state}, scratch ${c.scratch}, ${c.files} files, flags ${Object.entries(c.flags).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    for (const n of c.claude.notApplicable) lines.push(`    not applicable: ${n.feature}: ${n.why}`)
    for (const n of c.claude.untested) lines.push(`    untested on Claude: ${n.feature}: ${n.why}`)
    if (c.claude.runs) c.turns.forEach((t, i) => lines.push(`    turn ${i + 1}: "${t.say}"${t.approve.length ? ` approve=${t.approve.join(',')}` : ''} expects ${t.expects.join(',') || '-'}`))
  }
  lines.push('  inventory (what works on Claude):')
  for (const row of plan.inventory) lines.push(`    [${row.status}] ${row.feature}`)
  for (const rule of plan.rules) lines.push(`  rule: ${rule}`)
  for (const w of warnings) lines.push(`  WARNING: ${w}`)
  return lines.join('\n')
}
