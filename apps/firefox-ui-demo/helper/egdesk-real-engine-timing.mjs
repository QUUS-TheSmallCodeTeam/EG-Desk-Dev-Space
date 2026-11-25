// L2 c31: the shared U13 timing measure ("끼릭끼릭 탁탁": decision-first, PHILOSOPHY.md U13). Pure: real-engine check records in, per-turn timing and a compare out.
// Lanes that build a default-off fast path (commands, prefetch, browser fast answer, approvals, memory notes) run the SAME script with the flag off and on and compare:
//   node scripts/egdesk-real-engine-timing.mjs compare <records off> <records on>
// Nothing here calls a model or reads a key. The times are the ones the check recorded (c31 onward: offsets from the start of the scripted turn); an older record has fewer fields
// and the measure says which numbers it derived and which it could not (null), never a guess.
//
// Per scripted turn (turnTiming):
//   turnMs            the whole turn: the engine's turn plus the hold of the draft check (what the person waits for the run to be over)
//   firstVisibleMs    the first change the person can see: a posted message (message.completed) or a visible activity row, from the runtime's own events (null for an older record)
//   finalAnswerMs     the last posted message (the answer; with the held answer it includes the draft check); null when nothing was posted
//   decisions         { count, sumMs (the calls added), wallMs (the time at least one call was in flight, overlaps once), list }  (wallMs needs the call starts: c31 onward)
//   engine            { rounds, ms, roundMs[] } a round is one model call: it ends when the model produced a tool call or its final text; its ms runs from the previous round's end
//                     (the tool result delivered, or the turn start) to that point. Older records: rounds from the tool-call count, ms null.
//   tools             { count, ms } EG-Desk's own tool calls (request to result), and the native tool items; a command that sleeps is mostly this
//   outcome           the posting outcome word (as_written | revised | certain_part | withheld) when the draft check ran in an Agent room, else posted | none
import { numbersIn } from './egdesk-real-engine-rewrite.mjs'

// What the person can see: a posted message, an approval question, or an activity row of the run's work. The runtime's own bookkeeping rows (the context it attached, the plan, a summary, the tool ceiling...) are not shown as work.
const VISIBLE = new Set(['message.completed', 'activity.updated', 'activity.completed', 'approval.required'])
const INTERNAL_ACTIVITY = new Set(['decisionContext', 'plan', 'summary', 'hostNotice', 'toolCeiling', 'computerControl', 'quota', 'reasoning'])
const isVisible = e => VISIBLE.has(e.event) && Number.isFinite(e.atMs) && !(/^activity\./.test(e.event) && INTERNAL_ACTIVITY.has(e.kind))
// native tool items only: EG-Desk's own tools arrive as item/tool/call requests (their item is a dynamicToolCall: counting both would count each call twice)
const NATIVE_TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'])
const num = v => (Number.isFinite(v) ? v : null)
const sum = list => list.reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0)
const median = list => { const v = list.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2)) : null }
const percentile = (list, p) => { const v = list.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)] : null }

/** The union length of intervals [start, start + ms]: the time at least one was in flight. */
export function unionMs(intervals) {
  const rows = intervals.filter(i => Number.isFinite(i.start) && Number.isFinite(i.ms)).map(i => [i.start, i.start + i.ms]).sort((a, b) => a[0] - b[0])
  let total = 0, end = -Infinity, begin = 0
  for (const [s, e] of rows) { if (s > end) { if (end > -Infinity) total += end - begin; begin = s; end = e } else if (e > end) end = e }
  return end > -Infinity ? total + (end - begin) : 0
}

/** enginePhases(timing, turnMs) → { rounds, ms, roundMs, tools: { count, ms } } from the recorded offsets (see the header). */
export function enginePhases(timing, turnMs) {
  const tools = (timing?.tools ?? []).filter(t => Number.isFinite(t.startMs)).map(t => ({ start: t.startMs, end: Number.isFinite(t.endMs) ? t.endMs : t.startMs }))
  const items = timing?.items ?? []
  for (const it of items) {
    if (!NATIVE_TOOL_ITEMS.has(it.type) || !Number.isFinite(it.startMs)) continue
    const end = Number.isFinite(it.endMs) ? it.endMs : it.startMs
    if (!tools.some(t => t.start <= end && it.startMs <= t.end)) tools.push({ start: it.startMs, end })
  }
  tools.sort((a, b) => a.start - b.start)
  const finalText = [...items].reverse().find(it => it.type === 'agentMessage' && Number.isFinite(it.endMs))
  const roundMs = []
  let previousEnd = 0
  for (const t of tools) { roundMs.push(Math.max(0, t.start - previousEnd)); previousEnd = Math.max(previousEnd, t.end) }
  const finalEnd = finalText ? finalText.endMs : null
  if (finalEnd !== null) roundMs.push(Math.max(0, finalEnd - previousEnd))
  return { rounds: roundMs.length, ms: sum(roundMs), roundMs, tools: { count: tools.length, ms: sum(tools.map(t => t.end - t.start)) }, finalTextMs: finalEnd, turnMs: num(turnMs) }
}

/** turnTiming(turn) → the closed timing of one scripted turn of a check record, or null for a turn without a sub-turn (a message typed into the run has its own window). */
export function turnTiming(turn) {
  const subs = (turn?.subTurns ?? []).filter(s => !s.whileRunning && !s.action)
  if (!subs.length) return null
  const main = subs[0], timing = main.timing ?? null, turnMs = num(subs.reduce((n, s) => n + (Number.isFinite(s.latencyMs) ? s.latencyMs : 0), 0)) || null
  const events = timing?.events ?? []
  const visible = events.filter(isVisible), messages = events.filter(e => e.event === 'message.completed' && Number.isFinite(e.atMs))
  const posted = Array.isArray(turn.posted) ? turn.posted : []
  const decisions = subs.flatMap(s => s.decisions ?? []).map(d => ({ name: String(d.names?.[0] ?? '?'), atMs: num(d.atMs), ms: num(d.ms), inputTokens: num(d.inputTokens), status: d.status ?? null }))
  const phases = timing ? enginePhases(timing, turnMs) : null
  const toolCalls = subs.flatMap(s => s.toolCalls ?? [])
  const rewrite = turn.rewrite ?? null
  const outcome = typeof rewrite?.posted === 'string' ? rewrite.posted : (turn.draftCheck?.rows?.length && !posted.length ? 'withheld' : posted.length ? 'posted' : 'none')
  return {
    index: turn.index ?? null, say: String(turn.say ?? '').slice(0, 60), status: main.status ?? null, hasTiming: Boolean(timing), turnMs,
    firstVisibleMs: visible.length ? Math.min(...visible.map(e => e.atMs)) : null, firstMessageMs: messages.length ? Math.min(...messages.map(e => e.atMs)) : null,
    finalAnswerMs: messages.length ? Math.max(...messages.map(e => e.atMs)) : (!timing && posted.length ? turnMs : null),
    posted: posted.length,
    decisions: { count: decisions.length, sumMs: sum(decisions.map(d => d.ms)), wallMs: decisions.length && decisions.every(d => d.atMs !== null && d.ms !== null) ? unionMs(decisions.map(d => ({ start: d.atMs, ms: d.ms }))) : null, inputTokens: sum(decisions.map(d => d.inputTokens)), list: decisions.map(d => ({ name: d.name, atMs: d.atMs, ms: d.ms })) },
    engine: phases ? { rounds: phases.rounds, ms: phases.ms, roundMs: phases.roundMs, finalTextMs: phases.finalTextMs, derived: false } : { rounds: toolCalls.length + (posted.length ? 1 : 0), ms: null, roundMs: [], finalTextMs: null, derived: true },
    tools: phases ? { count: phases.tools.count, ms: phases.tools.ms } : { count: toolCalls.length, ms: null },
    outcome, answerNumbers: numbersIn(posted.at(-1) ?? '').map(n => `${n.value}${n.unit}`),
    expectations: Object.fromEntries((turn.expectations ?? []).map(e => [e.check, e.ok === true])), ok: turn.ok === true,
  }
}

/** recordTimings(records) → rows [{ key, set, id, ...turnTiming }] for every scripted turn of every conversation record. */
export function recordTimings(records) {
  const rows = []
  for (const rec of records) {
    if (!rec?.set || !rec?.id || !Array.isArray(rec.turns)) continue
    for (const turn of rec.turns) { const t = turnTiming(turn); if (t) rows.push({ key: `${rec.set}/${rec.id}#${t.index}`, set: rec.set, id: rec.id, ...t }) }
  }
  return rows
}

/** summarize(rows) → the top-line numbers over a set of turn rows (median and 90th percentile; null where no row has the number). */
export function summarize(rows) {
  const col = pick => rows.map(pick).filter(Number.isFinite)
  const stat = list => ({ n: list.length, median: median(list), p90: percentile(list, 0.9), total: list.length ? sum(list) : null })
  return {
    turns: rows.length, withTiming: rows.filter(r => r.hasTiming).length, withAnswer: rows.filter(r => r.posted > 0).length,
    turnMs: stat(col(r => r.turnMs)), firstVisibleMs: stat(col(r => r.firstVisibleMs)), finalAnswerMs: stat(col(r => r.finalAnswerMs)),
    decisionCalls: stat(col(r => r.decisions.count)), decisionSumMs: stat(col(r => r.decisions.sumMs)), decisionWallMs: stat(col(r => r.decisions.wallMs)),
    engineRounds: stat(col(r => r.engine.rounds)), engineMs: stat(col(r => r.engine.ms)), toolMs: stat(col(r => r.tools.ms)),
    outcomes: rows.reduce((m, r) => { m[r.outcome] = (m[r.outcome] ?? 0) + 1; return m }, {}),
  }
}

const ROUND = v => (Number.isFinite(v) ? Math.round(v) : null)
const delta = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? ROUND(a - b) : null) // positive: the flag-on run is faster by this many ms

/** The facts of an answer that a faster path must not change: its numbers (with units), its posted outcome, and every expectation verdict. */
function factChanges(off, on) {
  const out = []
  const added = on.answerNumbers.filter(n => !off.answerNumbers.includes(n)), removed = off.answerNumbers.filter(n => !on.answerNumbers.includes(n))
  if (added.length) out.push(`numbers only with the flag on: ${added.join(', ')}`)
  if (removed.length) out.push(`numbers only with the flag off: ${removed.join(', ')}`)
  if (off.outcome !== on.outcome) out.push(`posting outcome ${off.outcome} -> ${on.outcome}`)
  for (const check of new Set([...Object.keys(off.expectations), ...Object.keys(on.expectations)])) if (off.expectations[check] !== on.expectations[check]) out.push(`expectation ${check}: ${off.expectations[check] ?? 'absent'} -> ${on.expectations[check] ?? 'absent'}`)
  if (off.posted !== on.posted) out.push(`messages posted ${off.posted} -> ${on.posted}`)
  return out
}

/**
 * compareRuns(offRecords, onRecords) → { turns: [{ key, savedMs: { turn, firstVisible, finalAnswer, decisionsWall, engine, tools }, decisions, rounds, factChanges }], unmatched, summary }
 * Turns are matched by script set, conversation id and turn index (the SAME script run twice). savedMs is off minus on (positive = faster with the flag on). A run that failed to complete a turn on
 * one side keeps the turn in the table with its numbers; the summary counts only turns that were answered on both sides.
 */
export function compareRuns(offRecords, onRecords, { normalize = null } = {}) {
  // normalize: a RegExp removed from the set and the conversation id before matching, for two scripts that differ only by a suffix such as -off / -on
  const keyed = records => new Map(recordTimings(records).map(r => { const k = normalize ? `${r.set.replace(normalize, '')}/${r.id.replace(normalize, '')}#${r.index}` : r.key; return [k, { ...r, key: k }] }))
  const off = keyed(offRecords), on = keyed(onRecords)
  const turns = [], unmatched = []
  for (const [key, a] of off) {
    const b = on.get(key)
    if (!b) { unmatched.push({ key, side: 'off only' }); continue }
    turns.push({ key, say: a.say, savedMs: { turn: delta(a.turnMs, b.turnMs), firstVisible: delta(a.firstVisibleMs, b.firstVisibleMs), finalAnswer: delta(a.finalAnswerMs, b.finalAnswerMs), decisionsWall: delta(a.decisions.wallMs, b.decisions.wallMs), engine: delta(a.engine.ms, b.engine.ms), tools: delta(a.tools.ms, b.tools.ms) },
      decisions: { off: a.decisions.count, on: b.decisions.count }, rounds: { off: a.engine.rounds, on: b.engine.rounds }, outcome: { off: a.outcome, on: b.outcome }, factChanges: factChanges(a, b), answeredBoth: a.posted > 0 && b.posted > 0 })
  }
  for (const key of on.keys()) if (!off.has(key)) unmatched.push({ key, side: 'on only' })
  const both = turns.filter(t => t.answeredBoth), saved = pick => both.map(t => t.savedMs[pick]).filter(Number.isFinite)
  const summary = {
    matched: turns.length, answeredBoth: both.length, unmatched: unmatched.length,
    savedSeconds: { turn: ROUND(sum(saved('turn')) / 10) / 100, finalAnswer: ROUND(sum(saved('finalAnswer')) / 10) / 100, firstVisible: ROUND(sum(saved('firstVisible')) / 10) / 100 },
    medianSavedMs: { turn: median(saved('turn')), finalAnswer: median(saved('finalAnswer')), firstVisible: median(saved('firstVisible')) },
    faster: both.filter(t => Number.isFinite(t.savedMs.turn) && t.savedMs.turn > 0).length, slower: both.filter(t => Number.isFinite(t.savedMs.turn) && t.savedMs.turn < 0).length,
    decisionCalls: { off: sum(turns.map(t => t.decisions.off)), on: sum(turns.map(t => t.decisions.on)) }, engineRounds: { off: sum(turns.map(t => t.rounds.off)), on: sum(turns.map(t => t.rounds.on)) },
    turnsWithChangedFacts: turns.filter(t => t.factChanges.length).length,
  }
  return { turns, unmatched, summary }
}

const sec = v => (Number.isFinite(v) ? `${(v / 1000).toFixed(1)}s` : '-')
export function formatTable(rows) {
  const lines = [`${'turn'.padEnd(44)} ${'turn'.padStart(7)} ${'1st vis'.padStart(7)} ${'answer'.padStart(7)} ${'D calls'.padStart(7)} ${'D ms'.padStart(6)} ${'rounds'.padStart(6)} ${'eng ms'.padStart(7)} ${'tool ms'.padStart(7)}  outcome`]
  for (const r of rows) lines.push(`${r.key.slice(-44).padEnd(44)} ${sec(r.turnMs).padStart(7)} ${sec(r.firstVisibleMs).padStart(7)} ${sec(r.finalAnswerMs).padStart(7)} ${String(r.decisions.count).padStart(7)} ${String(r.decisions.sumMs).padStart(6)} ${String(r.engine.rounds).padStart(5)}${r.engine.derived ? '*' : ' '} ${sec(r.engine.ms).padStart(7)} ${sec(r.tools.ms).padStart(7)}  ${r.outcome}`)
  if (rows.some(r => r.engine.derived)) lines.push('(* rounds derived from the tool-call count: the record has no c31 timing)')
  return lines.join('\n')
}
export function formatSummary(s) {
  const f = x => `n=${x.n} median ${sec(x.median)} p90 ${sec(x.p90)}`, c = x => `n=${x.n} median ${x.median ?? '-'} p90 ${x.p90 ?? '-'}`
  return [`turns ${s.turns} (with c31 timing ${s.withTiming}, with an answer ${s.withAnswer})`, `  turn          ${f(s.turnMs)}`, `  first visible ${f(s.firstVisibleMs)}`, `  final answer  ${f(s.finalAnswerMs)}`,
    `  Decision calls ${c(s.decisionCalls)}; ms added ${f(s.decisionSumMs)}; wall ${f(s.decisionWallMs)}`, `  engine rounds ${c(s.engineRounds)}; ms ${f(s.engineMs)}; tool ms ${f(s.toolMs)}`, `  outcomes ${JSON.stringify(s.outcomes)}`].join('\n')
}
export function formatCompare(c) {
  const lines = []
  for (const t of c.turns) {
    const s = t.savedMs, d = v => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v / 1000).toFixed(1)}s` : '-')
    lines.push(`${t.key}: turn ${d(s.turn)}, first visible ${d(s.firstVisible)}, answer ${d(s.finalAnswer)}, Decision wall ${d(s.decisionsWall)}, engine ${d(s.engine)}, tools ${d(s.tools)}; Decision calls ${t.decisions.off}->${t.decisions.on}, rounds ${t.rounds.off}->${t.rounds.on}, outcome ${t.outcome.off}->${t.outcome.on}`)
    for (const why of t.factChanges) lines.push(`    CHANGED: ${why}`)
  }
  for (const u of c.unmatched) lines.push(`${u.key}: ${u.side}`)
  const m = c.summary
  lines.push(`summary: ${m.matched} turns matched (${m.answeredBoth} answered on both sides, ${m.unmatched} unmatched); positive = faster with the flag on`)
  lines.push(`  seconds saved over the answered turns: turn ${m.savedSeconds.turn}, final answer ${m.savedSeconds.finalAnswer}, first visible ${m.savedSeconds.firstVisible}; median per turn: turn ${sec(m.medianSavedMs.turn)}, answer ${sec(m.medianSavedMs.finalAnswer)}`)
  lines.push(`  faster ${m.faster}, slower ${m.slower}; Decision calls ${m.decisionCalls.off} -> ${m.decisionCalls.on}; engine rounds ${m.engineRounds.off} -> ${m.engineRounds.on}; turns whose answer facts changed: ${m.turnsWithChangedFacts}`)
  return lines.join('\n')
}
