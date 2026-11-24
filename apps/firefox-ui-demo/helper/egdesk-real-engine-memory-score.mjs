// L7 c27: scoring of the real-engine check's memory records (conversations real-engine-memory-recall-v1 / real-engine-memory-held-v1). Pure: record in, table out.
// A record is what scripts/egdesk-real-engine-check.mjs wrote (<out>/records/<set>/<id>.json). Per scripted turn: which pages had their body in what the product sent
// (and through which key), which were only referenced, re-sends against earlier turns, a page sent twice in one turn, the Decision numbers that decided it
// (selection rel_, triage tn_, scan pg_), whether turn memory ran, the engine's answer, and the check's own expectations. Nothing is judged by a model.
const rounded = value => (Number.isFinite(value) ? Math.round(value * 100) / 100 : value)
const clip = (text, max = 160) => { const s = String(text ?? ''); return s.length > max ? `${s.slice(0, max)}…` : s }

export function decisionNumbers(turn) {
  const rows = (turn.subTurns ?? []).flatMap(s => s.decisions ?? [])
  const pick = prefix => Object.fromEntries(rows.flatMap(r => Object.entries(r.p ?? {}).filter(([name]) => name.startsWith(prefix)).map(([name, p]) => [name, rounded(p)])))
  return {
    requests: rows.map(r => ({ names: r.names, ms: r.ms, status: r.status })),
    selection: { rel: pick('rel_'), answerType: rows.find(r => r.p?.answer_type)?.p.answer_type ?? null },
    triage: pick('tn_'), scan: pick('pg_'), second: { ...pick('st_'), ...pick('op_') },
  }
}

/** scoreMemoryRecord(record) → { set, id, ok, aborted, turns: [...], summary } */
export function scoreMemoryRecord(record) {
  const turns = (record.turns ?? []).map(turn => {
    const memory = turn.memory ?? null
    const checks = (turn.expectations ?? []).map(e => ({ check: e.check, ok: e.ok === true, ...(e.ok ? {} : { detail: e.detail }) }))
    return {
      index: turn.index, say: clip(turn.say, 80),
      memory: memory ? { attached: memory.attached, referenced: memory.referenced, resent: memory.resent, keys: memory.keys, duplicatesInTurn: memory.duplicatesInTurn, turnMemoryRan: memory.keys.includes('egdesk_turn_memory'), selectionRan: memory.keys.includes('egdesk_decision_context') } : null,
      decisions: decisionNumbers(turn), answer: clip(turn.posted?.at(-1) ?? null, 240),
      latencyMs: turn.subTurns?.[0]?.latencyMs ?? null, status: turn.subTurns?.at(-1)?.status ?? null, checks, ok: turn.ok === true,
    }
  })
  const all = turns.flatMap(t => t.checks)
  return { set: record.set, id: record.id, ok: record.ok === true, aborted: record.aborted ?? null, engine: record.engine?.version ?? null, flags: record.flags ?? {}, turns,
    summary: { turns: turns.length, checks: all.length, passed: all.filter(c => c.ok).length, failed: all.filter(c => !c.ok).map(c => c.check),
      resentPages: [...new Set(turns.flatMap(t => t.memory?.resent ?? []))], pagesTwiceInOneTurn: turns.filter(t => (t.memory?.duplicatesInTurn ?? 0) > 0).map(t => t.index),
      turnMemoryRanOn: turns.filter(t => t.memory?.turnMemoryRan).map(t => t.index) } }
}

/** A markdown table of one scored record. */
export function formatScore(score) {
  const lines = [`### ${score.set} / ${score.id}: ${score.ok ? 'PASS' : 'FAIL'}${score.aborted ? ` (aborted: ${score.aborted})` : ''}  engine ${score.engine ?? '?'}  flags ${JSON.stringify(score.flags)}`,
    '| turn | attached (body) | referenced | re-sent | twice | via | selection rel | triage | scan pg | answer | checks |', '|---|---|---|---|---|---|---|---|---|---|---|']
  for (const t of score.turns) {
    const m = t.memory ?? {}
    lines.push(`| ${t.index} | ${(m.attached ?? []).join(', ') || '-'} | ${(m.referenced ?? []).join(', ') || '-'} | ${(m.resent ?? []).join(', ') || '-'} | ${m.duplicatesInTurn ?? 0} | ${[m.selectionRan ? 'selection' : null, m.turnMemoryRan ? 'memory' : null].filter(Boolean).join('+') || '-'} | ${JSON.stringify(t.decisions.selection.rel)} | ${JSON.stringify(t.decisions.triage)} | ${JSON.stringify(t.decisions.scan)} | ${t.answer ?? '-'} | ${t.checks.map(c => `${c.ok ? 'ok' : 'FAIL'} ${c.check}`).join('; ')} |`)
  }
  return lines.join('\n')
}
