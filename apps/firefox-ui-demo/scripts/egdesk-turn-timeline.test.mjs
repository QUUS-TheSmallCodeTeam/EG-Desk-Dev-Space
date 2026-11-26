import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CALLS_FORMAT, collectFromBridge, displayWidth, mergeLiveTurns, parseWhen, reduceHistory, reduceLiveCalls, renderTable, renderTurn, selectTurns, timelinesOf, turnTimelines, watchCalls } from './egdesk-turn-timeline.mjs'

// Synthetic history pages shaped like GET /chat/history (only the fields the bridge really writes). Every text below must never reach the output.
const SECRET = ['검색창에 우산 입력해줘', '우산 3,900원 비밀 본문', 'npm test --token=abc', 'https://shop.example.test/q?u=1', '장화 신은 고양이']
const T = 1_795_700_000_000
let seq = 0
const ev = (dt, event, details = {}, requestId = 'req-1') => ({ seq: ++seq, eventId: `e${seq}`, ts: T + dt, event, requestId, localRunId: 'run-l1', details })
const act = (id, kind, title, detail = {}) => ({ id, kind, title, status: 'completed', detail })

function pagesOne() {
  seq = 0
  const dc = act('dc-1', 'decisionContext', '컨텍스트 세팅 · 자료 2개', { mode: 'on', model: 'gpt-6-luna', latencyMs: 300, attached: [{ title: SECRET[1] }, { title: 'x' }], items: [{ text: SECRET[1] }],
    calls: [{ kind: 'context', startMs: 10, endMs: 310, inputTokens: 2000, cachedTokens: 0, outcome: 'ok' }, { kind: 'browser', startMs: 3100, endMs: 3350, inputTokens: 500, cachedTokens: 0, outcome: 'ok' },
      { kind: 'browser', startMs: 3420, endMs: 3600, inputTokens: 480, cachedTokens: 0, outcome: 'ok' }, { kind: 'other', startMs: 9000, endMs: 9200, inputTokens: 300, cachedTokens: 0, outcome: 'ok' }] })
  const read = act('toolu_A', 'dynamicToolCall', 'egdesk_card_read', { tool: 'egdesk_card_read', executedBy: 'egdesk' })
  const task = act('toolu_B', 'dynamicToolCall', 'egdesk_browser_task', { tool: 'egdesk_browser_task', executedBy: 'egdesk' })
  const cmd = act('cmd-1', 'commandExecution', SECRET[2], { command: SECRET[2], cwd: '/Users/x/secret', exitCode: 0, durationMs: 150, executedBy: 'egdesk', decidedBy: { path: 'action', reason: 'healthy', option: 'script', confidence: 0.97 } })
  const events = [
    ev(0, 'message.accepted', { message: { role: 'user', text: SECRET[0], status: 'accepted' } }),
    ev(2, 'run.dispatching', { status: 'dispatching' }),
    ev(400, 'run.started', { status: 'inProgress' }),
    ev(401, 'run.executionPolicy', { executionPolicy: { mode: 'browserBounded' } }),
    ev(405, 'activity.completed', dc),
    ev(1400, 'activity.started', { ...read, status: 'inProgress' }),
    ev(1420, 'browser.tool.completed', { callId: 'toolu_A.obs', status: 'observed', observationId: 'obs-1', cardId: 'card-1' }),
    ev(1440, 'activity.completed', read),
    ev(3000, 'activity.started', { ...task, status: 'inProgress' }),
    ev(3400, 'browser.tool.completed', { callId: 'toolu_B.reflex-1-1111-2222', status: 'postcondition-observed', action: 'fill', cardId: 'card-1', url: SECRET[3] }),
    ev(3700, 'browser.tool.completed', { callId: 'toolu_B.reflex-2-3333-4444', status: 'postcondition-observed', action: 'click', cardId: 'card-1' }),
    ev(3720, 'activity.completed', task),
    ev(3800, 'activity.started', { ...cmd, status: 'inProgress' }),
    ev(3950, 'activity.completed', cmd),
    ev(6000, 'message.started', { id: 'm1', role: 'assistant', text: '', phase: null, status: 'inProgress' }),
    ev(6010, 'message.delta', { messageId: 'm1', delta: SECRET[4] }),
    ev(6500, 'message.completed', { id: 'm1', role: 'assistant', text: `${SECRET[4]} 결과입니다`, phase: 'final_answer', status: 'complete' }),
    ev(6505, 'run.completed', { status: 'completed' }),
  ]
  return [{ protocolVersion: 1, thread: { clientThreadId: 'thread-dm-test' }, events, runs: [{ requestId: 'req-1', runId: 'run-1', status: 'completed', engine: { id: 'claude', engineProfileId: 'claude-default' },
    executionPolicy: { mode: 'browserBounded' }, createdAt: T, messages: [{ text: SECRET[4] }], activities: [dc, read, task, cmd] }], hasMore: false }]
}

test('the reduced data and every rendering carry closed fields only: no message, value, page, command or URL text', () => {
  const reduced = reduceHistory(pagesOne(), { clientThreadId: 'thread-dm-test', engineId: 'claude' })
  const turns = turnTimelines(reduced)
  const out = JSON.stringify(reduced) + JSON.stringify(turns) + turns.map(renderTurn).join('\n') + renderTable(turns)
  for (const secret of SECRET) assert.ok(!out.includes(secret), `leaked: ${secret}`)
  assert.ok(!out.includes('/Users/x/secret')); assert.ok(!out.includes('shop.example'))
  assert.equal(reduced.events.find(e => e.event === 'message.completed').chars, `${SECRET[4]} 결과입니다`.length, 'a length, not the text')
  assert.equal(reduced.runs[0].activities.find(a => a.kind === 'commandExecution').tool, 'npm', 'the program name only')
})

test('one turn: who did each step, the conversation model between tools, Decision-model steps split into call and action time', () => {
  const [turn] = turnTimelines(reduceHistory(pagesOne(), { clientThreadId: 'thread-dm-test', engineId: 'claude' }))
  assert.equal(turn.engineId, 'claude'); assert.equal(turn.policy, 'browserBounded'); assert.equal(turn.index, 1)
  const s = turn.summary
  assert.equal(s.totalMs, 6500); assert.equal(s.preTurnMs, 400); assert.equal(s.firstTextMs, 6000); assert.equal(s.firstPageActionMs, 3400)
  // the conversation model: 400-1400, 1440-3000, 3720-3800, 3950-6500 (the tools 1400-1440, 3000-3720, 3800-3950 are subtracted)
  assert.deepEqual({ segments: s.engine.segments, ms: s.engine.ms }, { segments: 4, ms: 1000 + 1560 + 80 + 2550 })
  // decision calls before the answer: context (0.3 s), two browser calls; 'other' at 9 s comes after the answer
  assert.equal(s.decision.calls, 3); assert.equal(s.decision.afterAnswer, 1); assert.equal(s.decision.serialMs, 300 + 250 + 180); assert.equal(s.decision.exact, false)
  // the steps of the handed-over task: step 1 = 3000..3400 (call 3100-3350 = 250 ms, action 150 ms), step 2 = 3400..3700 (call 3420-3600 = 180, action 120)
  assert.deepEqual({ steps: s.decisionSteps.steps, ms: s.decisionSteps.ms, callMs: s.decisionSteps.callMs, actionMs: s.decisionSteps.actionMs }, { steps: 2, ms: 700, callMs: 430, actionMs: 270 })
  assert.equal(s.tools.count, 3); assert.equal(s.tools.byDecision, 2, 'the command the Decision model picked and the task it was handed')
  // one browser step: the card read the conversation model chose = its thinking 400-1400 + the tool 1400-1440; the Decision model's steps 400 and 300 ms
  assert.deepEqual(s.browserStep, { byEngine: { steps: 1, avgMs: 1040 }, byDecision: { steps: 2, avgMs: 350 } })
  assert.equal(turn.started, true)
  const who = turn.rows.map(r => `${r.who}|${r.decidedBy ?? ''}|${r.what.split(' · ')[0]}`)
  assert.ok(who.includes('EG-Desk|대화 모델|egdesk_card_read 실행'))
  assert.ok(who.includes('EG-Desk|결정 모델(맡김)|egdesk_browser_task 실행'))
  assert.ok(who.includes('EG-Desk|결정 모델|npm 실행'))
  assert.ok(who.includes('대화 모델||생각 → egdesk_card_read')); assert.ok(who.includes('대화 모델||생각 → 답'))
  assert.ok(turn.rows.some(r => r.who === '결정 모델' && r.what.startsWith('단계 1: fill · postcondition-observed · 결정 호출 250ms + 동작 150ms')))
  assert.ok(turn.rows.some(r => r.who === '결정 모델' && r.what.startsWith('답 이후 호출 other')))
  for (let i = 1; i < turn.rows.length; i++) assert.ok(turn.rows[i].start >= turn.rows[i - 1].start, 'rows in time order')
  assert.ok(turn.notes.some(n => n.includes('사용자 메시지 시각에 맞춘')), 'persisted rows are placed approximately')
})

test('the decision-call log of the live bridge gives the exact zero; without any call rows the steps still show their total', () => {
  const pages = pagesOne()
  const live = reduceLiveCalls({ turns: [{ requestId: 'req-1', startedAt: T - 20, calls: [{ kind: 'browser', startMs: 3120, endMs: 3370, inputTokens: 1, cachedTokens: 0, outcome: 'ok' }, { kind: 'bogus kind!', startMs: 1, endMs: 2 }] }] })
  assert.equal(live[0].calls[1].kind, 'other')
  const [exact] = turnTimelines(reduceHistory(pages), { liveTurns: live })
  assert.equal(exact.summary.decision.exact, true); assert.equal(exact.summary.decisionSteps.callMs, 250)
  const bare = pagesOne(); bare[0].runs[0].activities = bare[0].runs[0].activities.filter(a => a.kind !== 'decisionContext'); bare[0].events = bare[0].events.filter(e => e.details.kind !== 'decisionContext')
  const [noCalls] = turnTimelines(reduceHistory(bare))
  assert.equal(noCalls.summary.decision.calls, 0); assert.equal(noCalls.summary.decisionSteps.steps, 2); assert.equal(noCalls.summary.decisionSteps.callMs, 0)
  assert.ok(noCalls.notes.some(n => n.includes('결정 호출 행이 없음')))
})

test('waiting for the person (an approval card, a site-permission click) is shown and left out of the processing time', () => {
  const pages = pagesOne()
  const events = pages[0].events
  // a site request that waited 20 s on the card inside the read tool, and an approval card answered after 1 s while the engine waits
  const at = events.findIndex(e => e.event === 'activity.completed' && e.details.id === 'toolu_A')
  events.splice(at, 0, { seq: 900, ts: T + 1430, event: 'browser.tool.completed', requestId: 'req-1', details: { callId: 'toolu_A.site', status: 'site-allowed', action: 'request_site' } })
  for (const e of events) if (e.ts >= T + 1440) e.ts += 20_000 // the tool now ends at 21.44 s
  events.find(e => e.event === 'activity.completed' && e.details.id === 'toolu_A').ts = T + 21_440
  events.push({ seq: 901, ts: T + 21_600, event: 'approval.required', requestId: 'req-1', details: { approvalId: 'ap-1', kind: 'computerElicitation', message: SECRET[0] } },
    { seq: 902, ts: T + 22_600, event: 'approval.resolved', requestId: 'req-1', details: { approvalId: 'ap-1', outcome: 'accept' } })
  events.sort((a, b) => a.ts - b.ts || a.seq - b.seq); events.forEach((e, i) => { e.seq = i + 1 })
  const [turn] = turnTimelines(reduceHistory(pages))
  assert.equal(turn.summary.totalMs, 26_500); assert.equal(turn.summary.waitMs, 20_040 + 1000); assert.equal(turn.summary.workMs, 26_500 - 21_040)
  assert.ok(turn.rows.some(r => r.who === '사용자' && r.what.startsWith('사이트 허용 기다림')))
  assert.ok(turn.rows.some(r => r.who === '사용자' && r.what.startsWith('허용 카드 computerElicitation')))
  assert.ok(!JSON.stringify(turn).includes(SECRET[0]))
  // the approval wait is not the conversation model's time
  assert.ok(turn.rows.filter(r => r.who === '대화 모델').every(r => r.end <= 21_600 || r.start >= 22_600))
})

test('selection, time parsing and the table', () => {
  const turns = turnTimelines(reduceHistory(pagesOne()))
  assert.equal(selectTurns(turns, { since: T + 1 }).length, 0); assert.equal(selectTurns(turns, { browser: true, engine: 'claude' }).length, 1); assert.equal(selectTurns(turns, { engine: 'codex' }).length, 0)
  const now = Date.parse('2026-11-26T07:30:00Z') // 16:30 KST
  assert.equal(parseWhen('16:05', now), Date.parse('2026-11-26T16:05:00+09:00')); assert.equal(parseWhen('2026-11-26T09:00', now), Date.parse('2026-11-26T09:00:00+09:00'))
  assert.equal(parseWhen('2026-11-26T00:00:00Z', now), Date.parse('2026-11-26T00:00:00Z')); assert.equal(parseWhen(null), null); assert.throws(() => parseWhen('soon'))
  assert.equal(displayWidth('대화 모델'), 9)
  const table = renderTable(turns).split('\n')
  assert.equal(table.length, 3); assert.ok(table[1].startsWith('thread-dm-test#1')); assert.ok(table[1].includes('4/5.2')); assert.ok(table[1].includes('1.0/0.3'))
  assert.equal(table[2], '전체: 대화 모델이 고른 브라우저 단계 1개 평균 1.0초 · 결정 모델 단계 2개 평균 0.3초')
  // a request that never started (only the message) is left out unless asked for
  const idlePages = pagesOne(); idlePages[0].events.push({ seq: 99, ts: T + 50_000, event: 'message.accepted', requestId: 'req-2', details: { message: { role: 'user', text: SECRET[0] } } })
  const both = turnTimelines(reduceHistory(idlePages))
  assert.equal(both.length, 2); assert.equal(both[1].started, false); assert.equal(selectTurns(both).length, 1); assert.equal(selectTurns(both, { idle: true }).length, 2)
})

test('the call-log watcher keeps the rows across a bridge restart (the ring starts empty again) and the analysis merges them', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egd-timeline-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'calls.json')
  const rows = [{ kind: 'browser', startMs: 3120, endMs: 3370, inputTokens: 5, cachedTokens: 0, outcome: 'ok' }]
  const answers = [{ turns: [{ requestId: 'req-1', startedAt: T - 20, calls: rows.slice(0, 0) }] }, { turns: [{ requestId: 'req-1', startedAt: T - 20, calls: rows }] }, { turns: [] }] // grows, then the bridge restarted
  let clock = 0, i = 0
  const fetchImpl = async url => { assert.match(url, /\/chat\/decision-calls\?limit=64$/); return { ok: true, status: 200, json: async () => answers[Math.min(i++, answers.length - 1)] } }
  const printed = []
  const kept = await watchCalls({ file, everyS: 5, forMinutes: 0.2, fetchImpl, print: line => printed.push(line), sleep: async ms => { clock += ms }, now: () => clock })
  assert.equal(kept.length, 1); assert.equal(kept[0].calls.length, 1, 'the restart (an empty ring) does not erase what was kept')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(saved.format, CALLS_FORMAT); assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600')
  assert.ok(printed.every(line => /^결정 호출 기록/.test(line)))
  assert.deepEqual(mergeLiveTurns([{ requestId: 'a', startedAt: 2, calls: [1, 2] }], [{ requestId: 'a', startedAt: 2, calls: [1] }, { requestId: 'b', startedAt: 1, calls: [] }]).map(x => [x.requestId, x.calls.length]), [['b', 0], ['a', 2]])
  const [turn] = turnTimelines(reduceHistory(pagesOne()), { liveTurns: saved.turns })
  assert.equal(turn.summary.decision.exact, true)
})

test('collecting from the bridge uses GET only, pages the history and reads the call log; a missing log route is a note', async () => {
  const pages = pagesOne(), seen = []
  const fetchImpl = async (url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search}`)
    const path = new URL(url).pathname
    const json = body => ({ ok: true, status: 200, json: async () => body })
    if (path === '/chat/history/threads') return json({ threads: [{ clientThreadId: 'thread-dm-test', engineId: 'claude', updatedAt: T + 6500 }, { clientThreadId: 'old', updatedAt: T - 9e9 }], nextCursor: null })
    if (path === '/chat/history') return json({ ...pages[0], hasMore: false })
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const collected = await collectFromBridge({ bridge: 'http://127.0.0.1:39218', since: T, fetchImpl })
  assert.ok(seen.every(s => s.startsWith('GET ')))
  assert.equal(collected.conversations.length, 1, 'only the conversation updated since'); assert.match(collected.liveNote, /꺼짐/)
  assert.equal(timelinesOf(collected).length, 1)
  for (const secret of SECRET) assert.ok(!JSON.stringify(collected).includes(secret), 'the saved data is closed too')
})
