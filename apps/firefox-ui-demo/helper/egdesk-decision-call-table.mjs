// u4: the turn stage table from the decision-call log (flag EGDESK_DECISION_CALL_LOG, helper/egdesk-decision-call-log.mjs). Pure: rows in, rows and text out; the script (scripts/egdesk-decision-call-table.mjs)
// reads a COPY of the bridge's chat store (read-only) or the JSON of GET /chat/decision-calls. Never reads a message text: the table is made of event times, closed call rows and numbers.
//
// Stages of a turn (ms from the send, which is the message.accepted event):
//   context     send -> run.dispatching        the context call(s) the runtime waited for before it dispatched
//   dispatch    run.dispatching -> run.started the pick, the pre-run command, the engine's start (the calls inside it are listed, so the stage can now be split by them)
//   engine      run.started -> first text, minus EG-Desk tool time (model rounds and the waits between them)
//   tools       the dynamic tool rows' start -> end
//   stream      first text -> message.completed (posted)
// and the decision calls of the turn: kind, start-end (ms from the send), input tokens, cached tokens, outcome; per turn the wall time at least one call was in flight (overlaps count once), the calls' number and
// the tokens; across turns the share of the decision wall time in the posted time and the cache hit.

const parse = text => { try { return JSON.parse(text) } catch { return {} } }
const sum = list => list.reduce((n, x) => n + (Number.isFinite(x) ? x : 0), 0)

/** Wall time covered by the calls' intervals (overlaps counted once). */
export function wallMs(calls) {
  const spans = (Array.isArray(calls) ? calls : []).filter(c => Number.isFinite(c?.startMs) && Number.isFinite(c?.endMs)).map(c => [c.startMs, c.endMs]).sort((a, b) => a[0] - b[0])
  let total = 0, end = -Infinity, start = 0
  for (const [s, e] of spans) { if (s > end) { if (end > -Infinity) total += end - start; start = s; end = e } else if (e > end) end = e }
  return end > -Infinity ? total + (end - start) : 0
}

/** Per kind: { count, ms (sum of durations), inputTokens, cachedTokens } and the turn's totals. */
export function summarizeCalls(calls) {
  const list = Array.isArray(calls) ? calls : [], kinds = {}
  for (const c of list) { const k = kinds[c.kind] ??= { count: 0, ms: 0, inputTokens: 0, cachedTokens: 0 }; k.count++; k.ms += Math.max(0, (c.endMs ?? 0) - (c.startMs ?? 0)); k.inputTokens += c.inputTokens ?? 0; k.cachedTokens += c.cachedTokens ?? 0 }
  return { count: list.length, wallMs: wallMs(list), sumMs: sum(Object.values(kinds).map(k => k.ms)), inputTokens: sum(list.map(c => c.inputTokens)), cachedTokens: sum(list.map(c => c.cachedTokens)), kinds }
}

/**
 * Turns from a chat store opened read-only (node:sqlite DatabaseSync of a COPY): one row per Claude or Codex run whose send fell in [since, until] (epoch ms).
 * { requestId, runId, sentAt, stages: { contextMs, dispatchMs, engineMs, toolsMs, streamMs, postedMs, tailMs }, calls }.
 */
export function turnsFromChatDb(db, { since = 0, until = Number.MAX_SAFE_INTEGER, engine = null } = {}) {
  const runs = db.prepare('select local_conversation_id c, local_run_id r, request_id q, engine_id e from runs').all().filter(r => !engine || r.e === engine)
  const out = []
  for (const run of runs) {
    const events = db.prepare('select ts, event, details_json from events where local_conversation_id = ? and local_run_id = ? and event not in (\'message.delta\', \'message.checkpoint\') order by seq').all(run.c, run.r)
    if (!events.length) continue
    const accepted = db.prepare('select ts from events where local_conversation_id = ? and request_id = ? and event = \'message.accepted\' order by seq limit 1').get(run.c, run.q)
    const t0 = accepted?.ts ?? events[0].ts
    if (t0 < since || t0 > until) continue
    const at = name => events.find(e => e.event === name)?.ts
    const dispatching = at('run.dispatching'), started = at('run.started'), firstText = at('message.started'), posted = at('message.completed'), completed = at('run.completed')
    const activities = events.filter(e => e.event.startsWith('activity.')).map(e => ({ event: e.event, ts: e.ts, ...parse(e.details_json) }))
    const tools = []
    for (const a of activities) {
      if (a.kind !== 'dynamicToolCall') continue
      if (a.event === 'activity.started') tools.push({ start: a.ts })
      if (a.event === 'activity.completed') { const open = [...tools].reverse().find(t => t.end === undefined); if (open) open.end = a.ts }
    }
    const toolsMs = sum(tools.map(t => (t.end !== undefined ? t.end - t.start : 0)))
    const calls = [...activities].reverse().find(a => a.kind === 'decisionContext' && Array.isArray(a.detail?.calls))?.detail.calls ?? []
    const rel = ts => (Number.isFinite(ts) ? ts - t0 : null)
    const first = firstText ?? posted
    out.push({ requestId: String(run.q ?? '').slice(0, 40), runId: String(run.r).slice(0, 24), sentAt: t0, engine: run.e,
      stages: { contextMs: rel(dispatching), dispatchMs: dispatching !== undefined && started !== undefined ? started - dispatching : null, engineMs: started !== undefined && first !== undefined ? first - started - toolsMs : null, toolsMs, streamMs: firstText !== undefined && posted !== undefined ? posted - firstText : 0, postedMs: rel(posted), tailMs: posted !== undefined && completed !== undefined ? completed - posted : null },
      calls })
  }
  return out.sort((a, b) => a.sentAt - b.sentAt)
}

/** Turns from the route's JSON ({ turns: [{ requestId, runId?, startedAt, calls }] }): calls only, no stage times. */
export function turnsFromRouteJson(json) {
  return (Array.isArray(json?.turns) ? json.turns : []).map(turn => ({ requestId: String(turn.requestId ?? '').slice(0, 40), runId: String(turn.runId ?? '').slice(0, 24), sentAt: turn.startedAt ?? null, engine: null, stages: null, calls: Array.isArray(turn.calls) ? turn.calls : [] }))
}

const s = ms => (Number.isFinite(ms) ? (ms / 1000).toFixed(2) : '-')
const p = (n, d) => (Number.isFinite(n) && d > 0 ? `${Math.round(100 * n / d)}%` : '-')

/** The table, as lines: one row per turn with the stage times and the decision calls; then the totals. */
export function formatCallTable(turns, { timeZoneOffsetHours = 9 } = {}) {
  const lines = ['| 보낸 시각 | 총(게시) | ① 맥락 | ② 디스패치→엔진 | ③ 엔진 | ④ 도구 | ⑤ 첫글자→게시 | 결정 호출 수 | 결정 wall | 입력 토큰 (캐시) | 호출 (종류 시작-끝 ms 토큰/캐시 결과) |', '|---|---|---|---|---|---|---|---|---|---|---|']
  let wall = 0, posted = 0, input = 0, cached = 0, calls = 0
  for (const t of turns) {
    const sm = summarizeCalls(t.calls), st = t.stages
    const clock = Number.isFinite(t.sentAt) ? new Date(t.sentAt + timeZoneOffsetHours * 3600e3).toISOString().slice(11, 19) : '-'
    wall += sm.wallMs; input += sm.inputTokens; cached += sm.cachedTokens; calls += sm.count; if (st?.postedMs) posted += st.postedMs
    const list = t.calls.map(c => `${c.kind} ${c.startMs}-${c.endMs} ${c.inputTokens ?? '-'}/${c.cachedTokens ?? '-'} ${c.outcome}`).join('; ')
    lines.push(`| ${clock} | ${s(st?.postedMs)} | ${s(st?.contextMs)} | ${s(st?.dispatchMs)} | ${s(st?.engineMs)} | ${s(st?.toolsMs)} | ${s(st?.streamMs)} | ${sm.count} | ${s(sm.wallMs)} (${p(sm.wallMs, st?.postedMs)}) | ${sm.inputTokens} (${sm.cachedTokens}) | ${list} |`)
  }
  lines.push('', `turns ${turns.length}, decision calls ${calls}, decision wall ${s(wall)}s${posted ? ` = ${p(wall, posted)} of the posted time ${s(posted)}s` : ''}, input tokens ${input}, cached ${cached} (${p(cached, input)})`)
  return lines
}
