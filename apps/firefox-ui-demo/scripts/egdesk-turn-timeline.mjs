#!/usr/bin/env node
// L2 a1 ('교대' round): the real-window turn timeline. For every turn of a conversation: the person's message, then each step in time
// order with WHO did it (the Decision model, the conversation model, EG-Desk), how long it took, and the final answer. It is the
// measurement Main runs after a scenario in the real EG-Desk window, to show "how much faster than the conversation model alone".
//
// What it reads (nothing new is recorded for it; all of it already exists):
//   - the bridge's local history   GET /chat/history/threads, GET /chat/history?clientThreadId=..   (events with ts: message.accepted,
//     run.started, activity.started/updated/completed, browser.tool.*, message.started/delta/completed, run.completed)
//   - the decision-call log        GET /chat/decision-calls?limit=64   (flag EGDESK_DECISION_CALL_LOG=on; in memory, lost on a bridge
//     restart). The same rows are persisted in the turn's decision-context activity, but ONLY when the turn has one (see the report).
// What it prints: closed fields only. Event kinds, tool names (egdesk_*), closed status words and codes, times, counts and token
// numbers. Never a message text, a typed value, a page text, a command line, a URL, a card or source title.
//
// Usage (the bridge on 127.0.0.1:39218 is read with GET only):
//   node scripts/egdesk-turn-timeline.mjs --since 16:30 [--browser] [--thread thread-dm-...] [--engine claude|codex] [--last N]
//        [--until 21:00] [--json out.json] [--save closed.json] [--from closed.json] [--bridge http://127.0.0.1:39218] [--rows]
//   --since/--until: KST "HH:MM" today, or an ISO time (no zone = KST). --browser: only turns that touched a Browser card.
//   --save writes the CLOSED data (no text) so the same report can be made later with --from (the call log does not survive a restart).
//   --rows: the per-step rows of every turn (default: rows for at most 6 turns, then the summary table). --idle: also requests that
//   never started a turn (only the message was recorded).
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const TIMELINE_FORMAT = 'egdesk-turn-timeline-v1'
export const DEFAULT_BRIDGE = 'http://127.0.0.1:39218'
const CALLS_PER_TURN_LIMIT = 48 // egdesk-decision-call-log.mjs DECISION_CALL_LIMITS.callsPerTurn: a turn at the limit may have lost rows
export const SITE_WAIT_MS = 1500 // a request_site longer than this waited for the person's click on the card (an allowed site answers in tens of ms)

const WORD = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
const word = value => (typeof value === 'string' && WORD.test(value) ? value : null)
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const id = value => (typeof value === 'string' && value && value.length <= 200 ? value : null)
const obj = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
// Activities that are a tool or command running (the conversation model waits while they run). Everything else is not subtracted.
export const TOOL_KINDS = Object.freeze(['dynamicToolCall', 'commandExecution', 'mcpToolCall', 'fileChange', 'webSearch', 'imageView'])
const TOOL_KIND = new Set(TOOL_KINDS)
const BROWSER_EVENT = /^browser\.(tool\.(completed|failed|unverified)|card\.(opened|closed))$/
const REFLEX = /^(.*?)\.reflex-(\d+)-/

// ---------------------------------------------------------------- reduction: raw history -> closed data (the only place raw input is read)

/** A decision-call row (egdesk-decision-call-log.mjs): closed already; copied field by field. */
export function reduceCall(call) {
  const c = obj(call)
  const startMs = num(c.startMs), endMs = num(c.endMs)
  if (startMs === null || endMs === null) return null
  return { kind: word(c.kind) ?? 'other', startMs, endMs, inputTokens: num(c.inputTokens), cachedTokens: num(c.cachedTokens), outcome: word(c.outcome) ?? 'error' }
}

/** An activity row: kind, the tool's NAME (never its arguments or output), who executed and who decided, the decision-context numbers. */
export function reduceActivity(activity) {
  const a = obj(activity), d = obj(a.detail)
  if (!id(a.id)) return null
  const out = { id: a.id, kind: word(a.kind) ?? 'other', status: word(a.status) }
  if (a.kind === 'dynamicToolCall' || a.kind === 'mcpToolCall') out.tool = word(d.tool) ?? word(a.title) ?? 'tool'
  else if (a.kind === 'commandExecution') {
    const first = typeof a.title === 'string' ? a.title.trim().split(/\s+/)[0] : '' // the program's name only (npm, git), never the line
    out.tool = /^[a-z][a-z0-9._-]{0,31}$/.test(first) ? first : 'command'
    out.exitCode = num(d.exitCode); out.durationMs = num(d.durationMs)
  } else if (TOOL_KIND.has(a.kind)) out.tool = a.kind
  if (d.executedBy !== undefined) out.executedBy = word(d.executedBy)
  if (d.decidedBy && typeof d.decidedBy === 'object') {
    const b = obj(d.decidedBy)
    out.decidedBy = { path: word(b.path), reason: word(b.reason), option: word(b.option), confidence: num(b.confidence) }
  }
  if (d.outcome !== undefined) out.outcome = word(d.outcome)
  if (a.kind === 'decisionContext') {
    out.mode = word(d.mode); out.model = word(d.model); out.latencyMs = num(d.latencyMs)
    out.attached = Array.isArray(d.attached) ? d.attached.length : num(d.attached)
    out.calls = Array.isArray(d.calls) ? d.calls.map(reduceCall).filter(Boolean) : null
  }
  return out
}

function reduceBrowser(event) {
  const d = obj(event.details)
  return {
    callId: id(d.callId), status: word(d.status) ?? word(d.code), action: word(d.action), observed: typeof d.observationId === 'string' && d.observationId !== '',
    ...(typeof d.postconditionMatched === 'boolean' ? { postconditionMatched: d.postconditionMatched } : {}), ...(word(d.inputRoute) ? { inputRoute: d.inputRoute } : {}),
  }
}

/** One history event as closed fields, or null for events the timeline does not use (deltas keep only their message id: the text is dropped). */
export function reduceEvent(event) {
  const e = obj(event), d = obj(e.details)
  const name = word(e.event)
  if (!name || !Number.isFinite(e.ts)) return null
  if (name === 'message.checkpoint') return null
  const out = { seq: num(e.seq), ts: e.ts, event: name, requestId: id(e.requestId) }
  if (name === 'message.accepted') out.role = word(obj(d.message).role)
  else if (name === 'message.started' || name === 'message.completed') {
    const m = d.role !== undefined ? d : obj(d.message)
    out.role = word(m.role); out.phase = word(m.phase); out.messageId = id(m.id) ?? id(m.messageId)
    if (name === 'message.completed' && typeof m.text === 'string') out.chars = m.text.length // a count, never the text
  } else if (name === 'message.delta') out.messageId = id(d.messageId)
  else if (name.startsWith('activity.')) { const a = reduceActivity(d.activity ?? d); if (!a) return null; out.activity = a }
  else if (BROWSER_EVENT.test(name)) out.browser = reduceBrowser(e)
  else if (name === 'run.started' || name === 'run.completed' || name === 'run.dispatching') out.status = word(d.status)
  else if (name === 'run.executionPolicy') out.policy = word(obj(d.executionPolicy).mode)
  else if (/^(approval|userInput)\.(required|resolved)$/.test(name)) { out.waitId = id(d.approvalId) ?? id(d.userInputId); out.waitKind = word(d.kind) }
  return out
}

export function reduceRun(run) {
  const r = obj(run)
  if (!id(r.requestId)) return null
  return {
    requestId: r.requestId, runId: id(r.runId), status: word(r.status), engineId: word(obj(r.engine).id), engineProfileId: word(obj(r.engine).engineProfileId),
    policy: word(obj(r.executionPolicy).mode), createdAt: num(r.createdAt),
    activities: (Array.isArray(r.activities) ? r.activities : []).map(reduceActivity).filter(Boolean),
  }
}

/** The history pages of ONE conversation (GET /chat/history, possibly several pages) -> { thread, events, runs }, closed. */
export function reduceHistory(pages, threadInfo = null) {
  const list = Array.isArray(pages) ? pages : [pages]
  const events = new Map(), runs = new Map()
  let clientThreadId = id(obj(threadInfo).clientThreadId), engineId = word(obj(threadInfo).engineId)
  for (const page of list) {
    const p = obj(page)
    clientThreadId ??= id(obj(p.thread).clientThreadId)
    engineId ??= word(obj(p.thread).engineId)
    for (const raw of Array.isArray(p.events) ? p.events : []) {
      const e = reduceEvent(raw)
      if (e) events.set(e.seq ?? `${e.ts}:${events.size}`, e)
    }
    for (const raw of Array.isArray(p.runs) ? p.runs : []) { const r = reduceRun(raw); if (r) runs.set(r.requestId, r) } // the last page's projection wins
  }
  const sorted = [...events.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.ts - b.ts)
  return { thread: { clientThreadId, engineId }, events: sorted, runs: [...runs.values()] }
}

/** GET /chat/decision-calls -> its turns, closed. */
export function reduceLiveCalls(body) {
  return (Array.isArray(obj(body).turns) ? body.turns : []).map(t => {
    const turn = obj(t)
    if (!id(turn.requestId)) return null
    return { requestId: turn.requestId, startedAt: num(turn.startedAt), calls: (Array.isArray(turn.calls) ? turn.calls : []).map(reduceCall).filter(Boolean) }
  }).filter(Boolean)
}

// ---------------------------------------------------------------- the timeline of one turn

const union = intervals => {
  const sorted = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).sort((a, b) => a[0] - b[0])
  const out = []
  for (const [s, e] of sorted) { const last = out.at(-1); if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]) }
  return out
}
const total = intervals => intervals.reduce((sum, [s, e]) => sum + (e - s), 0)
const clip = (intervals, lo, hi) => intervals.map(([s, e]) => [Math.max(s, lo), Math.min(e, hi)]).filter(([s, e]) => e > s)
/** [lo, hi] minus the busy intervals. */
const gaps = (lo, hi, busy) => {
  const out = []; let at = lo
  for (const [s, e] of union(clip(busy, lo, hi))) { if (s > at) out.push([at, s]); at = Math.max(at, e) }
  if (hi > at) out.push([at, hi])
  return out
}
const overlap = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]))

const browserTool = tool => typeof tool === 'string' && /^egdesk_(card|browser)_/.test(tool)
function browserLabel(b) {
  if (b.event === 'browser.card.opened') return '카드 열림'
  if (b.event === 'browser.card.closed') return '카드 닫힘'
  const what = b.action ?? (b.observed ? 'observe' : 'tool')
  const state = b.event === 'browser.tool.failed' ? `실패 ${b.status ?? ''}`.trim() : b.event === 'browser.tool.unverified' ? `미확인 ${b.status ?? ''}`.trim() : b.status ?? 'ok'
  return `${what} · ${state}`
}

/**
 * The turns of a reduced conversation. liveTurns: GET /chat/decision-calls turns (exact zero time); without them the persisted rows of
 * the decision-context activity are placed from the person's message (accepted) time, which is a few ms after the log's zero.
 */
export function turnTimelines(reduced, { liveTurns = [] } = {}) {
  const live = new Map((liveTurns ?? []).filter(t => t?.requestId).map(t => [t.requestId, t]))
  const runs = new Map((reduced?.runs ?? []).map(r => [r.requestId, r]))
  const byRequest = new Map()
  for (const e of reduced?.events ?? []) { if (!e.requestId) continue; if (!byRequest.has(e.requestId)) byRequest.set(e.requestId, []); byRequest.get(e.requestId).push(e) }
  const turns = []
  let index = 0
  for (const [requestId, events] of byRequest) {
    if (!events.some(e => e.event === 'message.accepted' || e.event === 'run.started')) continue // a bookkeeping-only request
    index++
    turns.push(buildTurn({ requestId, events, run: runs.get(requestId) ?? null, live: live.get(requestId) ?? null, index, thread: reduced?.thread ?? {} }))
  }
  return turns
}

function buildTurn({ requestId, events, run, live, index, thread }) {
  const notes = []
  const accepted = events.find(e => e.event === 'message.accepted')
  const T0 = accepted?.ts ?? events[0].ts
  if (!accepted) notes.push('사용자 메시지 접수 기록 없음(첫 기록부터 셈)')
  const runStarted = events.find(e => e.event === 'run.started')?.ts ?? null
  const runCompleted = events.find(e => e.event === 'run.completed') ?? null
  const answers = events.filter(e => e.event === 'message.completed' && e.role !== 'user')
  const finalAnswer = answers.at(-1) ?? null
  const end = finalAnswer?.ts ?? runCompleted?.ts ?? events.at(-1).ts
  if (finalAnswer && runCompleted && finalAnswer.ts > runCompleted.ts + 1000) notes.push('최종 답이 턴 완료보다 1초 넘게 뒤에 올라옴(보류 답)')
  const firstText = events.find(e => (e.event === 'message.delta' || e.event === 'message.started') && e.role !== 'user')?.ts ?? null

  // activities: first and last event time per id; the run projection gives the final detail (decidedBy, calls)
  const acts = new Map()
  for (const e of events) {
    if (!e.activity) continue
    const a = acts.get(e.activity.id) ?? { first: e.ts, startedAt: null, completedAt: null, last: e.ts, activity: e.activity }
    if (e.event === 'activity.started' && a.startedAt === null) a.startedAt = e.ts
    if (e.event === 'activity.completed') a.completedAt = e.ts
    a.last = e.ts; a.activity = { ...a.activity, ...e.activity }
    acts.set(e.activity.id, a)
  }
  for (const a of run?.activities ?? []) { const known = acts.get(a.id); if (known) known.activity = { ...known.activity, ...a } }
  const tools = []
  for (const a of acts.values()) {
    if (!TOOL_KIND.has(a.activity.kind)) continue
    const endTs = a.completedAt ?? a.last
    let startTs = a.startedAt ?? a.first
    if (a.startedAt === null && num(a.activity.durationMs) !== null) startTs = endTs - a.activity.durationMs
    tools.push({ ...a.activity, start: startTs, end: Math.max(endTs, startTs), browser: [] })
  }
  tools.sort((a, b) => a.start - b.start)

  // browser events: under the tool whose call they belong to (callId = the tool call id, or that id + '.' + a sub-step)
  const browserEvents = events.filter(e => e.browser).map(e => {
    const m = REFLEX.exec(e.browser.callId ?? '')
    return { ts: e.ts, event: e.event, ...e.browser, reflexStep: m ? Number(m[2]) : null, reflexParent: m ? m[1] : null }
  })
  const loose = []
  for (const b of browserEvents) {
    const owner = b.callId ? tools.find(t => b.callId === t.id || b.callId.startsWith(`${t.id}.`)) : null
    if (owner) owner.browser.push(b); else loose.push(b)
  }

  // decision calls, placed in absolute time
  const contextActivity = [...acts.values()].map(a => a.activity).find(a => a.kind === 'decisionContext') ?? (run?.activities ?? []).find(a => a.kind === 'decisionContext') ?? null
  let calls = [], callsExact = false
  if (live?.calls?.length && Number.isFinite(live.startedAt)) { calls = live.calls.map(c => ({ ...c, start: live.startedAt + c.startMs, end: live.startedAt + c.endMs })); callsExact = true }
  else if (contextActivity?.calls?.length) calls = contextActivity.calls.map(c => ({ ...c, start: T0 + c.startMs, end: T0 + c.endMs }))
  if (calls.length && !callsExact) notes.push('결정 호출 시각은 기록된 행을 사용자 메시지 시각에 맞춘 값(오차 수십 ms)')
  if (calls.length >= CALLS_PER_TURN_LIMIT) notes.push(`결정 호출 ${CALLS_PER_TURN_LIMIT}개 상한에 닿음: 뒤의 호출은 빠졌을 수 있음`)
  const reflexSeen = browserEvents.some(b => b.reflexStep !== null)
  if (reflexSeen && !calls.some(c => c.kind === 'browser')) notes.push('결정 모델 단계는 있는데 그 결정 호출 행이 없음: 단계 시간은 호출과 동작 합계만')

  // reflex steps: the window from the previous step (or the tool's start) to this step's browser event; the decision calls in that
  // window are the call time, the rest is the action (dispatch, page reaction, EG-Desk checks)
  const steps = []
  const stepGroups = new Map()
  for (const b of browserEvents.filter(x => x.reflexStep !== null)) { const k = b.reflexParent ?? ''; if (!stepGroups.has(k)) stepGroups.set(k, []); stepGroups.get(k).push(b) }
  for (const [parent, group] of stepGroups) {
    group.sort((a, b) => a.ts - b.ts)
    const owner = tools.find(t => t.id === parent) ?? null
    let from = owner ? owner.start : Math.min(...calls.filter(c => c.kind === 'browser').map(c => c.start), group[0].ts)
    for (const b of group) {
      const windowMs = [from, b.ts]
      const callMs = total(union(calls.filter(c => c.kind === 'browser').map(c => [c.start, c.end])).map(iv => [Math.max(iv[0], windowMs[0]), Math.min(iv[1], windowMs[1])]).filter(([s, e]) => e > s))
      steps.push({ parent, owner: owner?.id ?? null, step: b.reflexStep, start: from, end: b.ts, ms: b.ts - from, callMs, actionMs: Math.max(0, b.ts - from - callMs), label: browserLabel(b) })
      from = b.ts
    }
  }

  // the person: an approval or question card from required to resolved, and a site-permission request that waited on the card
  // (request_site pending or allowed after more than SITE_WAIT_MS) are waiting for the person, not processing
  const waits = []
  for (const e of events.filter(x => /\.required$/.test(x.event) && x.waitId)) {
    const done = events.find(x => /\.resolved$/.test(x.event) && x.waitId === e.waitId && x.ts >= e.ts)
    waits.push({ start: e.ts, end: done?.ts ?? end, what: e.event.startsWith('approval') ? `허용 카드${e.waitKind ? ` ${e.waitKind}` : ''}` : '질문 카드' })
  }
  for (const t of tools) if (t.browser.some(b => b.action === 'request_site') && t.end - t.start > SITE_WAIT_MS) waits.push({ start: t.start, end: t.end, what: '사이트 허용 기다림' })
  const waitUnion = union(waits.map(w => [w.start, Math.min(w.end, end)]))

  // the conversation model: inside the native turn, every moment no tool runs
  const toolBusy = tools.map(t => [t.start, t.end])
  const engineWindow = runStarted !== null ? [runStarted, end] : null
  const engine = engineWindow ? gaps(engineWindow[0], engineWindow[1], [...toolBusy, ...waits.map(w => [w.start, w.end])]).map(([s, e]) => {
    const next = tools.find(t => t.start >= e - 1)
    const answerInside = answers.some(m => m.ts > s && m.ts <= e + 1)
    return { start: s, end: e, ms: e - s, next: next ? next.tool : answerInside || e >= end ? '답' : null }
  }) : []

  const preTurn = runStarted !== null ? [T0, Math.max(T0, runStarted)] : [T0, end]
  const callsBefore = calls.filter(c => c.start < end)
  const callsAfter = calls.filter(c => c.start >= end)
  const decisionUnion = union(callsBefore.map(c => [c.start, Math.min(c.end, end)]))
  const whoDecided = t => t.decidedBy?.path === 'action' ? '결정 모델' : t.browser.some(b => b.reflexStep !== null) ? '결정 모델(맡김)' : t.decidedBy?.path === 'engine' ? '대화 모델' : '대화 모델'
  const browserCount = browserEvents.filter(b => b.event.startsWith('browser.tool.'))
  const firstPageAction = browserEvents.filter(b => b.event.startsWith('browser.tool.') && b.action && b.action !== 'wait' && b.action !== 'request_site' && b.event !== 'browser.tool.failed').map(b => b.ts)[0] ?? null
  const touchedBrowser = browserEvents.length > 0 || tools.some(t => browserTool(t.tool)) || events.some(e => e.event === 'browser.bound')

  const rows = []
  const rel = ts => Math.round(ts - T0)
  rows.push({ start: 0, end: null, who: '사용자', what: '메시지', depth: 0 })
  if (runStarted !== null) rows.push({ start: rel(preTurn[0]), end: rel(preTurn[1]), who: 'EG-Desk', what: '턴 시작 전(결정 호출·준비 포함)', depth: 0 })
  for (const c of callsBefore) rows.push({ start: rel(c.start), end: rel(c.end), who: '결정 모델', what: `호출 ${c.kind}${c.inputTokens !== null ? ` · ${c.inputTokens}토큰` : ''}${c.outcome !== 'ok' ? ` · ${c.outcome}` : ''}`, depth: c.start < preTurn[1] ? 1 : 0, overlap: c.start >= preTurn[1] })
  for (const seg of engine) rows.push({ start: rel(seg.start), end: rel(seg.end), who: '대화 모델', what: seg.next === '답' ? '생각 → 답' : seg.next ? `생각 → ${seg.next}` : '생각', depth: 0 })
  for (const t of tools) {
    const who = whoDecided(t)
    const by = t.decidedBy?.path === 'action' ? `결정 모델이 고름(${t.decidedBy.option ?? '-'}${t.decidedBy.confidence !== null ? ` ${t.decidedBy.confidence}` : ''})` : who === '결정 모델(맡김)' ? '대화 모델이 결정 모델에 맡김' : '대화 모델이 고름'
    rows.push({ start: rel(t.start), end: rel(t.end), who: 'EG-Desk', decidedBy: who, what: `${t.tool} 실행 · ${by}${t.outcome ? ` · ${t.outcome}` : ''}${t.exitCode !== undefined && t.exitCode !== null ? ` · exit ${t.exitCode}` : ''}`, depth: 0 })
    for (const b of t.browser.filter(x => x.reflexStep === null)) rows.push({ start: rel(b.ts), end: null, who: 'EG-Desk', what: browserLabel(b), depth: 1 })
  }
  for (const s of steps) rows.push({ start: rel(s.start), end: rel(s.end), who: '결정 모델', what: `단계 ${s.step}: ${s.label} · 결정 호출 ${Math.round(s.callMs)}ms + 동작 ${Math.round(s.actionMs)}ms`, depth: s.owner ? 1 : 0 })
  for (const b of loose.filter(x => x.reflexStep === null)) rows.push({ start: rel(b.ts), end: null, who: 'EG-Desk', what: browserLabel(b), depth: 0 })
  for (const w of waits) rows.push({ start: rel(w.start), end: rel(Math.min(w.end, end)), who: '사용자', what: `${w.what}(기다림)`, depth: 1 })
  rows.push({ start: rel(end), end: null, who: '최종 답', what: finalAnswer ? `답 올라옴${finalAnswer.chars !== undefined ? ` · ${finalAnswer.chars}자` : ''}` : '답 없음', depth: 0 })
  for (const c of callsAfter) rows.push({ start: rel(c.start), end: rel(c.end), who: '결정 모델', what: `답 이후 호출 ${c.kind}(기다림 밖)`, depth: 0 })
  rows.sort((a, b) => a.start - b.start || a.depth - b.depth || (a.end ?? a.start) - (b.end ?? b.start))
  for (const r of rows) r.ms = r.end === null ? null : r.end - r.start

  const engineMs = total(engine.map(s => [s.start, s.end]))
  // one browser step as the person waits for it: a step the conversation model chose = its thinking right before + the tool;
  // a step of the Decision model = its window (decision call + action). The headline comparison of the round.
  const engineSteps = tools.filter(t => browserTool(t.tool) && whoDecided(t) === '대화 모델' && !waits.some(w => w.start <= t.start && w.end >= t.end))
    .map(t => (engine.find(seg => Math.abs(seg.end - t.start) <= 1)?.ms ?? 0) + (t.end - t.start))
  const toolMs = total(union(clip(toolBusy, T0, end)))
  return {
    clientThreadId: thread.clientThreadId ?? null, engineId: run?.engineId ?? thread.engineId ?? null, index, requestId,
    status: run?.status ?? runCompleted?.status ?? null, policy: run?.policy ?? events.find(e => e.event === 'run.executionPolicy')?.policy ?? null,
    at: T0, answeredAt: end, browser: touchedBrowser, started: runStarted !== null || answers.length > 0 || tools.length > 0 || steps.length > 0,
    summary: {
      totalMs: Math.round(end - T0),
      waitMs: Math.round(total(waitUnion)),
      workMs: Math.round(end - T0 - total(waitUnion)),
      firstTextMs: firstText !== null ? Math.round(firstText - T0) : null,
      firstPageActionMs: firstPageAction !== null ? Math.round(firstPageAction - T0) : null,
      preTurnMs: Math.round(preTurn[1] - preTurn[0]),
      engine: { segments: engine.length, ms: Math.round(engineMs) },
      decision: { calls: callsBefore.length, serialMs: Math.round(total(decisionUnion)), inputTokens: callsBefore.reduce((n, c) => n + (c.inputTokens ?? 0), 0), afterAnswer: callsAfter.length, exact: callsExact },
      decisionSteps: { steps: steps.length, ms: Math.round(steps.reduce((n, s) => n + s.ms, 0)), callMs: Math.round(steps.reduce((n, s) => n + s.callMs, 0)), actionMs: Math.round(steps.reduce((n, s) => n + s.actionMs, 0)) },
      tools: { count: tools.length, ms: Math.round(toolMs), byDecision: tools.filter(t => whoDecided(t) !== '대화 모델').length },
      browserStep: {
        byEngine: { steps: engineSteps.length, avgMs: engineSteps.length ? Math.round(engineSteps.reduce((n, x) => n + x, 0) / engineSteps.length) : null },
        byDecision: { steps: steps.length, avgMs: steps.length ? Math.round(steps.reduce((n, x) => n + x.ms, 0) / steps.length) : null },
      },
      browserEvents: { count: browserCount.length, failed: browserCount.filter(b => b.event === 'browser.tool.failed').length, unverified: browserCount.filter(b => b.event === 'browser.tool.unverified').length },
    },
    rows, notes,
  }
}

// ---------------------------------------------------------------- text output

const sec = ms => (ms === null || ms === undefined ? '-' : (ms / 1000).toFixed(1))
const kst = ts => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ts)) + `.${String(Math.floor(ts % 1000)).padStart(3, '0')}`
const pad = (v, n) => String(v).padStart(n)
// display width: Hangul and other wide characters take two columns, so the 누가 column lines up in a terminal
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
export const displayWidth = text => [...String(text)].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)
const padEndWide = (text, n, min = 1) => String(text) + ' '.repeat(Math.max(min, n - displayWidth(text)))
const padStartWide = (text, n) => ' '.repeat(Math.max(0, n - displayWidth(text))) + String(text)
const engineName = id => (id === 'claude' ? 'Claude' : id === 'codex' ? 'Codex' : id ?? '?')

export function renderTurn(turn) {
  const s = turn.summary
  const lines = [`■ ${turn.clientThreadId ?? '?'} · ${engineName(turn.engineId)} · 턴 ${turn.index} · ${kst(turn.at)} KST · ${turn.status ?? '-'}${turn.policy ? ` · ${turn.policy}` : ''}`]
  lines.push(`  ${padStartWide('시작ms', 7)} ${padStartWide('끝ms', 7)} ${padStartWide('걸림ms', 7)}  ${padEndWide('누가', 13)}무엇`)
  for (const r of turn.rows) lines.push(`  ${pad(r.start, 7)} ${pad(r.end ?? '', 7)} ${pad(r.ms ?? '', 7)}  ${padEndWide((r.depth ? '  ' : '') + r.who, 13)}${r.depth ? '· ' : ''}${r.what}${r.overlap ? ' (진행 중 겹침)' : ''}`)
  lines.push(`  요약: 전체 ${sec(s.totalMs)}초${s.waitMs ? `(사람 기다림 ${sec(s.waitMs)}초 빼면 ${sec(s.workMs)}초)` : ''} | 첫 글자 ${sec(s.firstTextMs)}초 | 첫 화면 동작 ${sec(s.firstPageActionMs)}초 | 턴 시작 전 ${sec(s.preTurnMs)}초`)
  lines.push(`        대화 모델 ${s.engine.segments}구간 ${sec(s.engine.ms)}초 | 결정 모델 호출 ${s.decision.calls}회 ${sec(s.decision.serialMs)}초(${s.decision.inputTokens}토큰${s.decision.afterAnswer ? `, 답 이후 ${s.decision.afterAnswer}회 별도` : ''}) | 결정 모델 단계 ${s.decisionSteps.steps}개 ${sec(s.decisionSteps.ms)}초(호출 ${sec(s.decisionSteps.callMs)} + 동작 ${sec(s.decisionSteps.actionMs)})`)
  lines.push(`        EG-Desk 도구 ${s.tools.count}회 ${sec(s.tools.ms)}초(결정 모델이 고른 것 ${s.tools.byDecision}) | 브라우저 기록 ${s.browserEvents.count}개(실패 ${s.browserEvents.failed}, 미확인 ${s.browserEvents.unverified})`)
  lines.push(`        브라우저 한 단계: 대화 모델이 고른 단계 ${s.browserStep.byEngine.steps}개 평균 ${sec(s.browserStep.byEngine.avgMs)}초 | 결정 모델 단계 ${s.browserStep.byDecision.steps}개 평균 ${sec(s.browserStep.byDecision.avgMs)}초`)
  for (const n of turn.notes) lines.push(`  참고: ${n}`)
  return lines.join('\n')
}

export function renderTable(turns) {
  const head = ['대화·턴', '엔진', '전체초', '기다림빼고', '첫글자', '첫동작', '대화모델(구간/초)', '결정호출(회/초)', '결정단계(개/초)', '도구(회/초)', '단계당초(대화/결정)', '실패']
  const body = turns.map(t => {
    const s = t.summary
    return [`${t.clientThreadId ?? '?'}#${t.index}`, engineName(t.engineId), sec(s.totalMs), sec(s.workMs), sec(s.firstTextMs), sec(s.firstPageActionMs), `${s.engine.segments}/${sec(s.engine.ms)}`,
      `${s.decision.calls}/${sec(s.decision.serialMs)}`, `${s.decisionSteps.steps}/${sec(s.decisionSteps.ms)}`, `${s.tools.count}/${sec(s.tools.ms)}`,
      `${sec(s.browserStep.byEngine.avgMs)}/${sec(s.browserStep.byDecision.avgMs)}`, String(s.browserEvents.failed)]
  })
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...body.map(r => displayWidth(r[i]))))
  const table = [head, ...body].map(r => r.map((c, i) => (i === 0 ? padEndWide(c, widths[i], 0) : padStartWide(c, widths[i]))).join('  ')).join('\n')
  const agg = side => { const xs = turns.map(t => t.summary.browserStep[side]).filter(x => x.steps); const n = xs.reduce((k, x) => k + x.steps, 0); return { n, avg: n ? xs.reduce((k, x) => k + x.avgMs * x.steps, 0) / n : null } }
  const e = agg('byEngine'), d = agg('byDecision')
  return `${table}\n전체: 대화 모델이 고른 브라우저 단계 ${e.n}개 평균 ${sec(e.avg)}초 · 결정 모델 단계 ${d.n}개 평균 ${sec(d.avg)}초`
}

// ---------------------------------------------------------------- selection and the bridge (GET only)

/** "HH:MM" today in KST, an ISO time (no zone = KST), or epoch ms -> epoch ms; null for nothing. */
export function parseWhen(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null
  if (/^\d{10,13}$/.test(value)) return Number(value)
  const kstDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  const hm = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (hm) return Date.parse(`${kstDay}T${hm[1].padStart(2, '0')}:${hm[2]}:00+09:00`)
  const parsed = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}+09:00`)
  if (!Number.isFinite(parsed)) throw new Error(`cannot read the time ${JSON.stringify(value)} (HH:MM KST or ISO)`)
  return parsed
}

/** idle: also the requests that never started a turn (a refused or abandoned send: only the message was recorded). */
export function selectTurns(turns, { since = null, until = null, browser = false, engine = null, last = null, idle = false } = {}) {
  let out = turns.filter(t => (since === null || t.at >= since) && (until === null || t.at <= until) && (!browser || t.browser) && (!engine || t.engineId === engine) && (idle || t.started !== false))
  out.sort((a, b) => a.at - b.at)
  if (Number.isSafeInteger(last) && last > 0) out = out.slice(-last)
  return out
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, { method: 'GET' })
  if (!response.ok) { const error = new Error(`GET ${new URL(url).pathname} -> ${response.status}`); error.status = response.status; throw error }
  return response.json()
}

/** The closed data of the bridge's conversations (updated since `since` when given, or the named ones) and its decision-call log. */
export async function collectFromBridge({ bridge = DEFAULT_BRIDGE, threads = [], since = null, fetchImpl = globalThis.fetch } = {}) {
  const base = bridge.replace(/\/+$/, '')
  const listed = []
  let cursor = null
  for (let page = 0; page < 20; page++) {
    const body = await getJson(fetchImpl, `${base}/chat/history/threads?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    listed.push(...(Array.isArray(body.threads) ? body.threads : []))
    cursor = body.nextCursor ?? null
    if (!cursor) break
  }
  const wanted = listed.filter(t => (threads.length ? threads.includes(t.clientThreadId) : since === null || (Number.isFinite(t.updatedAt) && t.updatedAt >= since)))
  const conversations = []
  for (const info of wanted) {
    const pages = []
    let afterSeq = 0
    for (let i = 0; i < 200; i++) {
      const page = await getJson(fetchImpl, `${base}/chat/history?clientThreadId=${encodeURIComponent(info.clientThreadId)}&afterSeq=${afterSeq}&limit=500`)
      pages.push(page)
      const lastSeq = Array.isArray(page.events) && page.events.length ? page.events.at(-1).seq : null
      if (!page.hasMore || !Number.isFinite(lastSeq) || lastSeq <= afterSeq) break
      afterSeq = lastSeq
    }
    conversations.push(reduceHistory(pages, { clientThreadId: info.clientThreadId, engineId: info.engineId }))
  }
  let liveTurns = [], liveNote = null
  try { liveTurns = reduceLiveCalls(await getJson(fetchImpl, `${base}/chat/decision-calls?limit=64`)) }
  catch (error) { liveNote = error.status === 404 ? '결정 호출 기록 경로 없음(EGDESK_DECISION_CALL_LOG 꺼짐)' : `결정 호출 기록을 읽지 못함(${error.status ?? 'network'})` }
  return { format: TIMELINE_FORMAT, collectedAt: Date.now(), conversations, liveTurns, liveNote }
}

export function timelinesOf(collected) {
  return (collected?.conversations ?? []).flatMap(c => turnTimelines(c, { liveTurns: collected.liveTurns ?? [] }))
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { threads: [], bridge: DEFAULT_BRIDGE, since: null, until: null, browser: false, engine: null, last: null, json: null, save: null, from: null, rows: false, idle: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v }
    if (a === '--thread') out.threads.push(next())
    else if (a === '--bridge') out.bridge = next()
    else if (a === '--since') out.since = next()
    else if (a === '--until') out.until = next()
    else if (a === '--browser') out.browser = true
    else if (a === '--engine') out.engine = next()
    else if (a === '--last') out.last = Number(next())
    else if (a === '--json') out.json = next()
    else if (a === '--save') out.save = next()
    else if (a === '--from') out.from = next()
    else if (a === '--rows') out.rows = true
    else if (a === '--idle') out.idle = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 22).join('\n')); return 0 }
  const since = parseWhen(opts.since), until = parseWhen(opts.until)
  const collected = opts.from ? JSON.parse(fs.readFileSync(opts.from, 'utf8')) : await collectFromBridge({ bridge: opts.bridge, threads: opts.threads, since })
  if (collected?.format !== TIMELINE_FORMAT) throw new Error('not a timeline file (saved with --save)')
  if (opts.save) fs.writeFileSync(opts.save, JSON.stringify(collected), { mode: 0o600 })
  const all = timelinesOf(collected).filter(t => !opts.threads.length || opts.threads.includes(t.clientThreadId))
  const turns = selectTurns(all, { since, until, browser: opts.browser, engine: opts.engine, last: opts.last, idle: opts.idle })
  if (collected.liveNote) console.log(`참고: ${collected.liveNote}`)
  const idle = opts.idle ? 0 : selectTurns(all, { since, until, browser: opts.browser, engine: opts.engine, idle: true }).filter(t => t.started === false).length
  if (idle) console.log(`참고: 턴이 시작되지 않은 요청 ${idle}개는 뺌습니다(--idle로 포함)`)
  if (!turns.length) { console.log('고른 조건에 맞는 턴이 없습니다.'); return 1 }
  const detailed = opts.rows ? turns : turns.slice(-6)
  for (const t of detailed) console.log(renderTurn(t) + '\n')
  if (detailed.length < turns.length) console.log(`(단계 표는 마지막 ${detailed.length}턴만. 전부 보려면 --rows)\n`)
  console.log(renderTable(turns))
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify({ format: TIMELINE_FORMAT, turns }, null, 1), { mode: 0o600 })
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { console.error(error.message); process.exitCode = 2 })
}
