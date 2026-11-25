// c32 + c34 (U13): the real-engine check of the decision-first command path (registered in helper/real-engine-registrations/L5.mjs). A conversation sets
// flags { EGDESK_DECISION_FIRST: 'on' | 'card' } and asks to run something; the record says which way the turn went and what it cost, by code:
// turn.expect.decisionFirst { path: 'action' | 'fast' | 'engine', reason?: closed word, engineTurns: integer, maxDecisionMs?: integer }
//   path action (value on, the default): the Decision model picked, EG-Desk's runner ran it, then ONE engine round with the result as context and no tool call; the engine talks (owner correction U13: the decision
//     model's place is the action layer, not the conversation layer); reason healthy | result_for_engine; engineTurns is 1
//   path fast (value card, a PROPOSAL: a code-posted result with no engine words is a conversation-layer shortcut): a healthy result ended the turn locally; engineTurns counts the turn/starts the engine got (0)
//   path engine: the engine runs as today; reason says why (none, below_threshold, unreachable, no_options, approval_floor, needs_person, result_for_engine, ...)
export const DF_PATHS = Object.freeze(['fast', 'action', 'engine'])
export const DF_REASONS = Object.freeze(['healthy', 'none', 'below_threshold', 'unreachable', 'no_options', 'approval_floor', 'no_executor', 'needs_person', 'result_for_engine', 'result_unreadable', 'decisions_off', 'egress_closed', 'error', 'approval_ran', 'approval_declined', 'approval_expired', 'approval_unclear', 'approval_unread'])
export const DF_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: { path: { enum: [...DF_PATHS] }, reason: { enum: [...DF_REASONS] }, engineTurns: { type: 'integer', minimum: 0, maximum: 5 }, maxDecisionMs: { type: 'integer', minimum: 1, maximum: 60000 } } })

export function validateDecisionFirstExpect(value, conv, turn, where = '$.expect.decisionFirst') {
  const errors = []
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return [`${where}: an object with at least one of path, reason, engineTurns, maxDecisionMs`]
  for (const key of Object.keys(value)) if (!['path', 'reason', 'engineTurns', 'maxDecisionMs'].includes(key)) errors.push(`${where}.${key}: unknown key`)
  if (value.path !== undefined && !DF_PATHS.includes(value.path)) errors.push(`${where}.path: ${DF_PATHS.join(' / ')}`)
  if (value.reason !== undefined && !DF_REASONS.includes(value.reason)) errors.push(`${where}.reason: ${DF_REASONS.join(' / ')}`)
  if (!['on', 'card'].includes(conv.flags?.EGDESK_DECISION_FIRST)) errors.push(`${where}: needs flags.EGDESK_DECISION_FIRST = "on" (action first) or "card" (card only, a proposal) in this conversation`)
  if (value.path === 'fast' && conv.flags?.EGDESK_DECISION_FIRST !== 'card') errors.push(`${where}.path: fast (a turn that ends with the card only) is the value "card"`)
  if (value.path === 'action' && conv.flags?.EGDESK_DECISION_FIRST !== 'on') errors.push(`${where}.path: action is the value "on"`)
  if (value.path === 'action' && value.engineTurns !== undefined && value.engineTurns !== 1) errors.push(`${where}.engineTurns: an action turn has exactly one engine round`)
  if (turn.action !== undefined || turn.whileRunning !== undefined) errors.push(`${where}: only on a plain message turn`)
  if (value.path === 'fast' && value.engineTurns !== undefined && value.engineTurns !== 0) errors.push(`${where}.engineTurns: a fast turn has none`)
  return errors
}

export function checkDecisionFirst(expect, record) {
  const out = [], put = (check, ok, detail) => out.push({ check: `decisionFirst.${check}`, ok: ok === true, detail })
  const d = record?.diag ?? null
  if (expect.path !== undefined) put('path', d?.path === expect.path, { wanted: expect.path, path: d?.path ?? null, reason: d?.reason ?? null })
  if (expect.reason !== undefined) put('reason', d?.reason === expect.reason, { wanted: expect.reason, reason: d?.reason ?? null })
  if (expect.engineTurns !== undefined) put('engineTurns', record?.engineTurns === expect.engineTurns, { wanted: expect.engineTurns, engineTurns: record?.engineTurns ?? null })
  if (expect.maxDecisionMs !== undefined) put('maxDecisionMs', Number.isFinite(d?.ms) && d.ms <= expect.maxDecisionMs, { wanted: expect.maxDecisionMs, ms: d?.ms ?? null })
  return out
}

export function createDecisionFirstHook() {
  let deps = null, mark = 0
  return {
    attach(d) { deps = d },
    async beforeSend() { mark = deps?.requestLog?.length ?? 0 },
    async afterTurn(ctx) {
      if (!ctx.expect?.decisionFirst || !deps) return null
      const run = deps.chat.runFor(ctx.run), diag = run?.decisionFirst ? { ...run.decisionFirst } : null
      const engineTurns = (deps.requestLog ?? []).slice(mark).filter(r => r.method === 'turn/start').length
      const record = { diag, engineTurns }
      return { record: { ...(diag ?? { path: null }), engineTurns, runLocal: typeof run?.runId === 'string' && run.runId.startsWith('egdesk-local-') }, expectations: checkDecisionFirst(ctx.expect.decisionFirst, record) }
    },
  }
}
