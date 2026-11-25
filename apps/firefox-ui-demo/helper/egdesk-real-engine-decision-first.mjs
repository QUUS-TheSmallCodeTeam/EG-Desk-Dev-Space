// c32 (U13): the real-engine check of the decision-first command path (registered in helper/egdesk-real-engine-registrations.mjs, slot L5). A conversation with
// flags { EGDESK_DECISION_FIRST: 'on' } and a request to run something; the record says which way the turn went and what it cost, by code:
// turn.expect.decisionFirst { path: 'fast' | 'engine', reason?: closed word, engineTurns: integer, maxDecisionMs?: integer }
//   path fast: the Decision model picked, EG-Desk's runner ran it, the arbiter read it healthy, the turn ended locally; engineTurns counts the turn/start requests the engine received in the turn's window.
//   path engine: the engine runs as today; reason says why (none, below_threshold, unreachable, no_options, approval_floor, needs_person, result_for_engine, ...).
export const DF_PATHS = Object.freeze(['fast', 'engine'])
export const DF_REASONS = Object.freeze(['healthy', 'none', 'below_threshold', 'unreachable', 'no_options', 'approval_floor', 'no_executor', 'needs_person', 'result_for_engine', 'result_unreadable', 'decisions_off', 'egress_closed', 'error', 'approval_ran', 'approval_declined', 'approval_expired', 'approval_unclear', 'approval_unread'])
export const DF_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: { path: { enum: [...DF_PATHS] }, reason: { enum: [...DF_REASONS] }, engineTurns: { type: 'integer', minimum: 0, maximum: 5 }, maxDecisionMs: { type: 'integer', minimum: 1, maximum: 60000 } } })

export function validateDecisionFirstExpect(value, conv, turn, where = '$.expect.decisionFirst') {
  const errors = []
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return [`${where}: an object with at least one of path, reason, engineTurns, maxDecisionMs`]
  for (const key of Object.keys(value)) if (!['path', 'reason', 'engineTurns', 'maxDecisionMs'].includes(key)) errors.push(`${where}.${key}: unknown key`)
  if (value.path !== undefined && !DF_PATHS.includes(value.path)) errors.push(`${where}.path: ${DF_PATHS.join(' / ')}`)
  if (value.reason !== undefined && !DF_REASONS.includes(value.reason)) errors.push(`${where}.reason: ${DF_REASONS.join(' / ')}`)
  if (conv.flags?.EGDESK_DECISION_FIRST !== 'on') errors.push(`${where}: needs flags.EGDESK_DECISION_FIRST = "on" in this conversation`)
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
