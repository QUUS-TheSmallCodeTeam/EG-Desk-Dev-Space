// Cycle 9: the first journey with every Decision feature switched on at once, in one conversation session.
//
// World: scripts/egdesk-all-on.support.mjs (the real runtime, stores, Decision client, wiki adapter, browser entry, presence mirror,
// work placement, briefing engine and the screen reducer; scripted engine, scripted Decision model, virtual clock, no network).
// The wiring in that file follows codex-bridge-server.mjs by hand; it is not the bridge's own start-up code.
//
// What this file pins: what each step asks the Decision model (by feature), how many subjective-model turns it costs, which chat
// messages the person sees and in which order, and what is written. Cross-feature findings that are NOT fixed here are recorded in the
// ledger (EGDESK_ALL_ON_LEDGER=<file> writes it) and listed in the cycle report; they are deliberately not pinned as assertions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'
import * as BriefingHost from '../overlay/resources/EGDeskBriefingHost.sys.mjs'
import { FLOW_COPY } from '../helper/egdesk-conversation-flow.mjs'
import { allOnWorld, screen, DM } from './egdesk-all-on.support.mjs'

const rect = (x, y, width, height) => ({ x, y, width, height })
const BROWSER_DM = 'dm-browser'
const Q = { quote: '지난주 A사 견적 건 어디까지 됐지?', tidy: '방금 그 내용 정리해줘', portal: '거래처 포털에서 이번 달 세금계산서 내려받아줘', second: '두 번째 사업자로', tests: '전체 테스트 돌리고 결과 알려줘', deployed: 'PostgreSQL 마이그레이션 배포 끝났어' }
const A = { quote: 'A사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.', tidy: 'A사 견적은 11월 3일 요청, 11월 6일 v1 발송, v2는 팀장 승인 후 발송 예정입니다.', ask: '사업자가 둘입니다. 어느 쪽으로 받을까요?', got: '세금계산서를 내려받았습니다.', tests: '테스트가 모두 통과했습니다.', noted: '네, 기록해 두겠습니다.' }
const COMMAND = 'npm test -- --suite=payroll-secret'
const PAGE_BODY = 'A사 구매팀이 11월 3일 스피커 모듈 200개 견적을 요청했다'

test('all features on, one session: memory, briefing, a browser task, a long command with a pointer, a status remark', async t => {
  const w = allOnWorld(t), ui = screen(w)
  await w.settings.turnMemory.save('on')
  const ledger = { flags: w.ENV, settings: { decisionContext: 'on', turnMemory: 'on' }, steps: {}, findings: {} }
  const close = name => { ledger.steps[name] = { decisions: w.decisionsIn(name).map(d => `${d.feature}(${d.names.length}q)`), byFeature: w.byFeature(name), subjectiveTurns: w.subjectiveTurnsIn(name), activityRows: w.activityRowsIn(name), events: w.eventsIn(name), chat: w.history().map(([role, text]) => `${role}: ${text}`) } }
  const say = async (text, extra) => { const n = w.state.sends + 1, out = await w.send(text, extra); if (!out.inRun) ui.sent(text, `req-${n}`, out); await w.idle(); ui.pump(); return out }
  const lastStart = () => w.turnStarts().at(-1).params
  const writesFile = path.join(w.dir, 'settings', 'egdesk-wiki-writes.json'), writes = () => (existsSync(writesFile) ? JSON.parse(readFileSync(writesFile, 'utf8')) : null)

  // ---- a1. first message: turn-context selection and turn memory both run, the answer is checked before it is posted ----
  w.step('a1')
  await say(Q.quote)
  assert.deepEqual(w.byFeature('a1'), { turn_context: 1, memory_triage: 1, memory_fetch: 3 })
  assert.deepEqual(Object.keys(lastStart().additionalContext), ['egdesk_context', 'egdesk_decision_context', 'egdesk_channel', 'egdesk_turn_memory'])
  ledger.findings.A3_sameBodyDeliveredTimes = JSON.stringify(lastStart()).split(PAGE_BODY).length - 1
  await w.advance(3000); await w.answer(A.quote); await w.idle(); ui.pump(); close('a1')
  assert.deepEqual(w.byFeature('a1'), { turn_context: 1, memory_triage: 1, memory_fetch: 3, draft_check: 1 })
  assert.deepEqual(w.subjectiveTurnsIn('a1'), { main: 1, fork: 0, steer: 0 })
  assert.deepEqual(w.activityRowsIn('a1'), ['decisionContext:컨텍스트 세팅 · 자료 5개', 'decisionContext:기억 자료 5개'])
  assert.deepEqual(w.history(), [['user', Q.quote], ['assistant', A.quote]])

  // ---- a2. follow-up in the same session: nothing new to attach, the Agent already holds the five pages ----
  w.step('a2')
  const a2 = await say(Q.tidy)
  assert.deepEqual(w.byFeature('a2'), { turn_context: 1, memory_triage: 1, memory_fetch: 1 })
  assert.deepEqual(Object.keys(lastStart().additionalContext), ['egdesk_context', 'egdesk_channel'], 'no page is sent twice to a model that holds it')
  assert.deepEqual(w.chat.memoryMaterialsFor(w.chat.runFor(a2)).map(m => [m.alias, m.held]), ['M1', 'M2', 'M3', 'M4', 'M5'].map(alias => [alias, true]))
  await w.advance(3000); await w.answer(A.tidy); await w.idle(); ui.pump(); close('a2')
  assert.equal(w.subjectiveTurnsIn('a2').main, 1)
  assert.equal(w.history().length, 4, 'one answer bubble for the turn')
  // Finding A1 (reported, not pinned): with no newly attached material the draft check has nothing to compare with and sends the answer back for a rewrite.
  ledger.findings.A1 = { draftCheckRequests: w.byFeature('a2').draft_check ?? 0, rewriteTurns: w.subjectiveTurnsIn('a2').fork, postedAnswerIsTheAgentsDraft: w.history().at(-1)[1] === A.tidy, posted: w.history().at(-1)[1] }

  // ---- a3. the briefing for that answer: design guide from the held materials, one fill turn, published in order ----
  w.step('a3')
  const answered = w.runs().at(-1)
  const observe = BriefingHost.observeRequest({ mode: 'on', report: w.history().at(-1)[1], answerId: answered.answerId, conversationId: answered.conversationId, runId: answered.runId, candidates: [], request: Q.tidy, viewport: rect(0, 0, 1200, 800) })
  const observed = (await w.http('POST', '/decision/briefing-observe', observe)).body
  await w.idle(); ui.pump(); close('a3')
  assert.equal(observed.status, 'observed'); assert.equal(observed.outcome, 'presented')
  assert.deepEqual(observed.stages, ['place', 'parts', 'order', 'fill_check'])
  assert.deepEqual(w.byFeature('a3'), { briefing: observed.judgeRequests })
  assert.deepEqual(w.subjectiveTurnsIn('a3'), { main: 0, fork: observed.fillTurns, steer: 0 })
  assert.equal(w.eventsIn('a3').at(-1), 'briefing.published')
  assert.equal(w.eventsIn('a3').filter(e => e === 'output.published').length, observed.newComponents)
  assert.equal(w.history().length, 4, 'the briefing adds no chat message')
  ledger.steps.a3.briefing = observed

  // ---- b0. a browser task in THIS conversation is refused: its native thread was started without Browser tools ----
  w.step('b0')
  await assert.rejects(w.send(Q.portal, w.browserExtra()), error => error.code === 'BROWSER_TOOLS_UNAVAILABLE' && (error.status ?? error.httpStatus ?? error.statusCode) === 409)
  await w.idle(); ui.pump(); close('b0')
  assert.deepEqual(w.byFeature('b0'), {}); assert.deepEqual(w.subjectiveTurnsIn('b0'), { main: 0, fork: 0, steer: 0 })
  // Finding A2 (reported): the refusal comes after the person's message was already saved.
  ledger.findings.A2 = { code: 'BROWSER_TOOLS_UNAVAILABLE', refusedMessageSaved: w.history().some(([role, text]) => role === 'user' && text === Q.portal),
    savedRow: w.store.listMessages(DM).messages.filter(m => m.text === Q.portal).map(m => ({ role: m.role, status: m.status ?? null }))[0] ?? null }

  // ---- c1. a long command: the wait message may name what is being waited on, never the command itself ----
  w.step('c1')
  const people = [{ member: 'self', self: true, active: true, viewport: rect(0, 0, 1200, 800), focusCard: null, lastInputAgeMs: 500 }, { member: 'm-jin', self: false, active: true, viewport: rect(4000, 0, 1200, 800), focusCard: null, lastInputAgeMs: 900 }]
  assert.equal(w.presenceMirror.accept(people), true)
  await say(Q.tests)
  const timing = w.timing()
  await w.advance(1000)
  await w.notify('item/started', { ...timing, item: { id: 'cmd-1', type: 'commandExecution', command: COMMAND, cwd: '/work', status: 'inProgress', commandActions: [] } })
  await w.notify('item/commandExecution/outputDelta', { ...timing, itemId: 'cmd-1', delta: 'running 40 tests\n' })
  await w.advance(9000); await w.idle(); ui.pump(); close('c1')
  assert.deepEqual(w.byFeature('c1'), { turn_context: 1, memory_triage: 1, memory_fetch: 1, command_judge: 1, heartbeat: 1 })
  assert.deepEqual(w.subjectiveTurnsIn('c1'), { main: 1, fork: 1, steer: 0 })
  const waitPrompt = w.forkPrompts.filter(p => p.step === 'c1').at(-1).prompt
  assert.match(waitPrompt, /a command is still running \(about 9 seconds so far\)/)
  assert.ok(!waitPrompt.includes('payroll-secret'), 'the command text is not handed to the writer')
  assert.ok(!w.decisionsIn('c1').find(d => d.feature === 'heartbeat').raw.includes('payroll-secret'), 'nor to the heartbeat question')
  ledger.findings.commandTextInDecisionRequests = w.decisionsIn('c1').filter(d => d.raw.includes('payroll-secret')).map(d => d.feature)
  assert.equal(w.history().at(-1)[0], 'assistant'); assert.equal(ui.working()?.state, 'working')

  // ---- c2. the command ends, the engine stays silent: the system's own stalled line (not a model text) ----
  w.step('c2')
  await w.notify('item/completed', { ...timing, item: { id: 'cmd-1', type: 'commandExecution', command: COMMAND, cwd: '/work', status: 'completed', exitCode: 0, commandActions: [], aggregatedOutput: 'all passed\n' } })
  await w.advance(40000); await w.idle(); ui.pump(); close('c2')
  assert.deepEqual(w.byFeature('c2'), { heartbeat: 1 })
  assert.equal(w.history().at(-1)[1], FLOW_COPY.stalled)
  assert.deepEqual(w.activityRowsIn('c2'), [`commandExecution:${COMMAND}`])

  // ---- c3. the answer ----
  w.step('c3')
  await w.answer(A.tests); await w.idle(); ui.pump(); close('c3')
  assert.equal(w.eventsIn('c3').at(-1), 'run.completed'); assert.equal(w.history().at(-1)[1], A.tests)
  assert.equal(ui.busy(), false); assert.equal(ui.working(), null)

  // ---- c4. after the run: the result card needs the owner, who is looking elsewhere (a second member is on the desk) ----
  // Work placement is 'on' here: only then does a decided "point" become a pointer fact (see the advisory test below).
  w.step('c4')
  w.presenceMirror.accept(people)
  const cards = [{ id: 'own-doc', rect: rect(100, 100, 500, 400), kind: 'file', creator: 'user' }, { id: 'agent-result', rect: rect(-2600, 100, 720, 520), kind: 'result', creator: 'agent', taskId: 'run-1' }]
  const scene = WP.enumerateWorkScene({ presence: w.presenceMirror.snapshot(), cards, tasks: [{ id: 'run-1', state: 'waiting_owner', requester: 'self', waiting: ['self'], ownerMustAct: true, surfaces: [{ kind: 'result', cardId: 'agent-result' }] }] })
  const attention = WP.attentionRequest(scene, { taskId: 'run-1', cardId: 'agent-result' })
  assert.deepEqual(attention.dto.members.map(m => m.alias), ['M1', 'M2'], 'both members are in the request, by alias only')
  assert.deepEqual((await w.http('POST', '/decision/work-placement/request', { clientThreadId: DM, dto: attention.dto })).body, { status: 'queued', id: 'wp-1' })
  const before = ui.bubbles().length, framesBefore = ui.frames.length
  await w.advance(25000); w.presenceMirror.accept(people); await w.advance(40000); await w.idle(); ui.pump(); close('c4')
  assert.deepEqual(w.byFeature('c4'), { work_placement: 1, heartbeat: 1 })
  assert.deepEqual(w.subjectiveTurnsIn('c4'), { main: 0, fork: 1, steer: 0 })
  const pointerEvents = w.events.filter(e => e.step === 'c4')
  assert.deepEqual(pointerEvents.map(e => e.event), ['message.started', 'message.delta', 'message.completed'])
  assert.ok(pointerEvents.every(e => e.runId === answered.runId.replace('turn-2', 'turn-3')), 'carried by the conversation\'s last (completed) run')
  const pointer = w.history().at(-1)[1]
  assert.deepEqual(w.workPlacement.facts(DM), { placementsPending: 0, placementsDecided: 1, pointerPending: false })
  // D-check: a message.* after run.completed is one more completed bubble, at the end, never a half-drawn one; the room stays free.
  const pointerFrames = ui.frames.slice(framesBefore)
  assert.equal(pointerFrames.length, 3)
  for (const frame of pointerFrames) {
    assert.ok(frame.bubbles.every(([, status, text]) => status !== 'streaming' || !text), `${frame.event}: no partial text on screen`)
    assert.equal(frame.busy, false, `${frame.event}: the room is not busy again`); assert.equal(frame.working, null)
  }
  assert.equal(ui.bubbles().length, before + 1)
  assert.deepEqual(ui.bubbles().slice(-2), [['assistant', 'complete', A.tests], ['assistant', 'complete', pointer]])

  // ---- d1. a status remark: turn memory proposes a status reading and keeps it pending; no page is changed ----
  w.step('d1')
  await say(Q.deployed)
  assert.deepEqual(Object.keys(lastStart().additionalContext), ['egdesk_context', 'egdesk_decision_context', 'egdesk_channel', 'egdesk_turn_memory'])
  await w.advance(2000); await w.answer(A.noted); await new Promise(resolve => setTimeout(resolve, 60)); await w.idle(); ui.pump(); close('d1')
  assert.deepEqual(w.byFeature('d1'), { turn_context: 1, memory_triage: 1, memory_fetch: 3, draft_check: 1, memory_write: 1 })
  assert.deepEqual(w.subjectiveTurnsIn('d1'), { main: 1, fork: 0, steer: 0 })
  assert.deepEqual(writes(), { version: 1, pages: [], readings: [{ pageId: 'ontology:db/pg-plan', sourceRevision: writes().readings[0].sourceRevision, reading: { status: 'done', state: 'pending', basis: null, spokenAt: new Date(w.clock() - 2000).toISOString() } }] })
  assert.equal(w.history().at(-1)[1], A.noted)

  // ---- b1/b2. the browser task, in a conversation of its own (see b0): entry, a question to the person, the reply inside the same run ----
  w.step('b1'); w.use(BROWSER_DM)
  await w.send(Q.portal, w.browserExtra()); await w.idle(); await w.answer(A.ask); await w.idle(); close('b1')
  assert.deepEqual(w.byFeature('b1'), { memory_fetch: 1, browser_entry: 1, browser_step: 1 })
  assert.equal(w.note().status, 'need_context'); assert.equal(w.note().next, 'ask_user_in_chat')
  assert.equal(w.eventsIn('b1').at(-1), 'reply.opened')
  w.step('b2')
  const reply = await w.send(Q.second, w.browserExtra())
  assert.deepEqual([reply.inRun, reply.accepted, reply.runId], [true, true, w.runs().at(-1).runId], 'the reply goes into the run that asked')
  await w.idle(); await w.answer(A.got); await new Promise(resolve => setTimeout(resolve, 60)); await w.idle(); close('b2')
  assert.deepEqual(w.byFeature('b2'), { browser_resume: 1, browser_step: 3, memory_write: 1 })
  assert.deepEqual(w.subjectiveTurnsIn('b1').main + w.subjectiveTurnsIn('b2').main, 2, 'the task start and its continuation after the reply')
  assert.equal(w.note().status, 'done')
  assert.deepEqual(w.acts.map(a => [a.type, a.url]), [['navigate', 'https://portal.example.test/biz/2'], ['navigate', 'https://portal.example.test/download/2.pdf']])
  assert.deepEqual(w.history(), [['user', Q.portal], ['assistant', A.ask], ['user', Q.second], ['assistant', A.got]])
  assert.deepEqual(writes().pages.map(p => [p.scope, p.provenance.by, p.status]), [[`dm:${BROWSER_DM}`, 'browser_task', 'done']])
  assert.equal(writes().readings.length, 1, 'the pending reading from d1 is untouched')
  w.use(DM)

  // ---- the whole session on the screen: live and after a restart ----
  const live = ui.bubbles(), fresh = screen(w)
  await fresh.restore()
  const sequence = rows => rows.map(([role, , text]) => [role, text])
  // The refused browser message of b0 was saved (finding A2), so a restored room shows it; the live room in this rig never drew it.
  assert.deepEqual(sequence(fresh.bubbles()).filter(([role, text]) => !(role === 'user' && text === Q.portal)), sequence(live), 'same bubbles in the same order after restore')
  assert.ok(live.every(([, status]) => status === 'complete')); assert.ok(fresh.bubbles().every(([, status]) => status !== 'streaming'))
  assert.equal(fresh.busy(), false); assert.equal(fresh.working(), null)
  assert.deepEqual(sequence(live).filter(([role]) => role === 'assistant').map(([, text]) => text).slice(-5), [w.forkPrompts.find(p => p.step === 'c1') && '확인하는 데 시간이 조금 걸리고 있어요. 곧 이어서 말씀드릴게요.', FLOW_COPY.stalled, A.tests, pointer, A.noted])

  // ---- one budget, one calibration log ----
  ledger.totals = { decisionRequests: w.decisions.length, byFeature: w.decisions.reduce((m, d) => (m[d.feature] = (m[d.feature] || 0) + 1, m), {}), subjectiveMainTurns: w.turnStarts().length, forkTurns: w.forkPrompts.length,
    calibration: w.calibrationLog.entries().map(e => `${e.feature}/${e.mode}`), writes: writes() }
  ledger.screen = { live: sequence(live), restored: sequence(fresh.bubbles()) }
  // Flags that are on but never asked anything in these four scenarios (no approval card, no EG-Desk tool result, no chooser).
  assert.ok(!w.decisions.some(d => /terminal_gate|working_memory|chat_choice/.test(d.feature)))
  if (process.env.EGDESK_ALL_ON_LEDGER) writeFileSync(process.env.EGDESK_ALL_ON_LEDGER, JSON.stringify(ledger, (key, value) => (key === 'raw' ? undefined : value), 1))
})

// ---- every flag off: an ordinary turn is the same, byte for byte, as on a bridge that has none of these features ----
test('all flags off: an ordinary turn sends the engine the same bytes, emits the same events and stores the same rows as a runtime without the Decision features', async t => {
  const trace = async on => {
    const w = allOnWorld(t, { on })
    w.step('turn')
    const out = await w.send(Q.quote); await w.idle()
    await w.advance(3000); await w.answer(A.quote); await w.idle()
    await w.advance(60000); await w.idle() // long after the turn: no heartbeat, no late message
    return { w, out, native: JSON.stringify(w.native.map(({ step, ...call }) => call)), events: JSON.stringify(w.events.map(({ step, ...event }) => event)),
      rows: JSON.stringify(w.store.listMessages(DM).messages), runs: JSON.stringify(w.runs()) }
  }
  const off = await trace(false), none = await trace(null)
  // Each world has its own temp directory and ids minted from randomness; everything else must be identical.
  const ids = text => text.split(off.w.dir).join('<dir>').split(none.w.dir).join('<dir>').replace(/msg-[0-9a-f]{32}/g, 'msg-#').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'uuid-#')
  for (const part of ['native', 'events', 'rows', 'runs']) assert.equal(ids(off[part]), ids(none[part]), part)
  assert.equal(off.w.decisions.length, 0, 'no Decision request'); assert.equal(off.w.forkPrompts.length, 0, 'no extra subjective turn')
  assert.deepEqual(Object.keys(off.w.turnStarts()[0].params.additionalContext), Object.keys(none.w.turnStarts()[0].params.additionalContext))
  assert.equal(off.w.calibrationLog.entries().length, 0); assert.ok(off.w.chat.heartbeatFor(DM) == null, 'no heartbeat')
  assert.equal(existsSync(path.join(off.w.dir, 'settings', 'egdesk-wiki-writes.json')), false, 'no write store is opened')
  assert.deepEqual((await off.w.http('POST', '/decision/work-placement/request', { clientThreadId: DM, dto: {} })).body, { status: 'off' })
  const briefingOff = (await off.w.http('POST', '/decision/briefing-observe', { flow: 'on', report: A.quote, candidates: [] })).body
  if (process.env.DBG) console.log('BRIEFING_OFF', JSON.stringify(briefingOff))
  assert.equal(briefingOff.status, 'skipped'); assert.equal(off.w.decisions.length, 0); assert.equal(off.w.forkPrompts.length, 0)
  if (process.env.EGDESK_ALL_ON_LEDGER) writeFileSync(process.env.EGDESK_ALL_ON_LEDGER.replace(/\.json$/, '') + '-off.json', JSON.stringify({ native: JSON.parse(ids(off.native)), events: JSON.parse(ids(off.events)) }, null, 1))
})

// ---- the other direction of b0: an ordinary message inside a conversation that began as a browser task ----
test('all features on: an ordinary message in a conversation that began as a browser task is answered; what the Decision features do there is recorded', async t => {
  const w = allOnWorld(t), ui = screen(w, BROWSER_DM)
  await w.settings.turnMemory.save('on')
  w.use(BROWSER_DM)
  w.step('task')
  const first = await w.send(Q.portal, w.browserExtra()); ui.sent(Q.portal, 'req-1', first); await w.idle(); await w.answer(A.ask); await w.idle()
  await w.send(Q.second, w.browserExtra()); await w.idle(); await w.answer(A.got); await new Promise(resolve => setTimeout(resolve, 60)); await w.idle(); ui.pump()
  w.step('ordinary')
  const out = await w.send(Q.quote); ui.sent(Q.quote, 'req-3', out); await w.idle(); ui.pump()
  const timing = w.timing(), before = ui.frames.length
  await w.notify('item/started', { ...timing, item: { id: 'ans-o', type: 'agentMessage', phase: 'final_answer', text: '' } })
  await w.notify('item/agentMessage/delta', { ...timing, itemId: 'ans-o', delta: A.quote.slice(0, 9) }); await w.idle(); ui.pump()
  const half = ui.frames.slice(before).map(frame => [frame.event, frame.bubbles.at(-1)])
  await w.notify('item/completed', { ...timing, item: { id: 'ans-o', type: 'agentMessage', phase: 'final_answer', text: A.quote } }); await w.endTurn(); await w.idle(); ui.pump()
  assert.deepEqual(w.history().slice(-2), [['user', Q.quote], ['assistant', A.quote]])
  assert.deepEqual(ui.bubbles().at(-1), ['assistant', 'complete', A.quote])
  assert.equal(w.runs().at(-1).status, 'completed'); assert.equal(ui.busy(), false)
  // Finding A6 (reported, not pinned): the conversation keeps the browser task's bounded policy, so the turn-context selection, turn memory and
  // the draft check do not run for this ordinary message, and without the draft check's hold the answer is drawn while it is still arriving.
  const finding = { executionPolicy: w.runs().at(-1).executionPolicy?.mode ?? null, decisionRequests: w.byFeature('ordinary'), contextKeys: Object.keys(w.turnStarts().at(-1).params.additionalContext ?? {}),
    partialTextOnScreen: half.filter(([, bubble]) => bubble?.[0] === 'assistant' && bubble[1] === 'streaming' && bubble[2]).map(([event, bubble]) => [event, bubble[2]]) }
  if (process.env.EGDESK_ALL_ON_LEDGER) writeFileSync(process.env.EGDESK_ALL_ON_LEDGER.replace(/\.json$/, '') + '-browser-room.json', JSON.stringify(finding, null, 1))
})

// ---- work placement 'advisory' records the judgment and posts nothing (the pointer of step c4 needs 'on') ----
test('work placement advisory: the same pointer judgment is recorded, no pointer fact is raised and nothing is posted', async t => {
  const w = allOnWorld(t, { env: { EGDESK_WORK_PLACEMENT: 'advisory' } })
  w.step('turn')
  await w.send(Q.tests); await w.idle(); await w.advance(2000); await w.answer(A.tests); await w.idle()
  const before = w.history()
  w.step('pointer')
  const people = [{ member: 'self', self: true, active: true, viewport: rect(0, 0, 1200, 800), focusCard: null, lastInputAgeMs: 500 }]
  w.presenceMirror.accept(people)
  const cards = [{ id: 'agent-result', rect: rect(-2600, 100, 720, 520), kind: 'result', creator: 'agent', taskId: 'run-1' }]
  const scene = WP.enumerateWorkScene({ presence: w.presenceMirror.snapshot(), cards, tasks: [{ id: 'run-1', state: 'waiting_owner', requester: 'self', waiting: ['self'], ownerMustAct: true, surfaces: [{ kind: 'result', cardId: 'agent-result' }] }] })
  const attention = WP.attentionRequest(scene, { taskId: 'run-1', cardId: 'agent-result' })
  assert.equal((await w.http('POST', '/decision/work-placement/request', { clientThreadId: DM, dto: attention.dto })).body.status, 'queued')
  await w.advance(25000); w.presenceMirror.accept(people); await w.advance(40000); await w.idle()
  assert.deepEqual(w.byFeature('pointer'), { work_placement: 1 }, 'the placement judgment only: no heartbeat question follows')
  assert.deepEqual(w.subjectiveTurnsIn('pointer'), { main: 0, fork: 0, steer: 0 })
  assert.deepEqual(w.eventsIn('pointer'), [])
  assert.deepEqual(w.history(), before)
  assert.equal(w.workPlacement.facts(DM).pointerPending, false)
  assert.deepEqual(w.workPlacement.records().map(r => [r.kind, r.source, r.would.kind]), [['attention', 'decision', 'point']], 'what it would have done is on record')
})

// ---- one packet: with the turn-memory option on, a page the context selection already carries is not sent a second time ----
test('one packet (turn-memory option, no bridge switch yet): selection and memory share one packet and each page body is sent once', async t => {
  const first = async onePacket => {
    const w = allOnWorld(t, { onePacket })
    await w.settings.turnMemory.save('on')
    w.step('a1'); await w.send(Q.quote); await w.idle()
    const start = w.turnStarts().at(-1).params
    return { keys: Object.keys(start.additionalContext), bodies: JSON.stringify(start).split(PAGE_BODY).length - 1, byFeature: w.byFeature('a1'), rows: w.activityRowsIn('a1') }
  }
  const one = await first(true), two = await first(false)
  assert.deepEqual(one.keys, ['egdesk_context', 'egdesk_decision_context', 'egdesk_channel'])
  assert.equal(one.bodies, 1)
  assert.deepEqual(one.byFeature, two.byFeature, 'the same Decision requests either way')
  assert.deepEqual(one.rows, two.rows, 'and the same activity rows')
  // The bridge's present behaviour (it does not pass the option): two packets, the body twice. Finding A3 stays open until a switch exists.
  assert.deepEqual(two.keys, ['egdesk_context', 'egdesk_decision_context', 'egdesk_channel', 'egdesk_turn_memory'])
  if (process.env.EGDESK_ALL_ON_LEDGER) writeFileSync(process.env.EGDESK_ALL_ON_LEDGER.replace(/\.json$/, '') + '-one-packet.json', JSON.stringify({ onePacket: one, bridgeDefault: two }, null, 1))
})
