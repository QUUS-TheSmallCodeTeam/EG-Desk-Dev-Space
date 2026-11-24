import { createHash } from 'node:crypto'
import { createDecisionClient, estimateInputTokens } from './egdesk-decision-client.mjs'
import { createHeartbeat } from './egdesk-heartbeat.mjs'
import { BEAT_PREDICATE_YES, createBeatJudge } from './egdesk-heartbeat-judge.mjs'
import { browserTaskRow } from './egdesk-heartbeat-providers.mjs'
import { audienceFacts, beatFlowFacts, flowPredicates, runContext } from './egdesk-conversation-flow.mjs'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'

// The real-measurement plan for the heartbeat's judgments, fifth registration (set heartbeat-c18): the early question for notes without "?"
// (they ride along on a request that goes out anyway), on the two cases that show it in both directions. The all-on journey's answer checks
// with the run's own facts are added by evidence/l3-c18/build-plan-c18.mjs.
//
//   heartbeat-c17 (sent 2026-11-24): 7/8. The choice design's present question said .99 on present-tense facts (the default is now the
//     predicate design); predicates: wait message .81/.01, invented result sup 0, s1 .99/.04, s6 sup .01 (checked against pages only).
//
// Fourth registration (set heartbeat-c17): the pointer cases whose request changed
// after heartbeat-c16, a new background-result case, and the draft check of a heartbeat message (product-built here). The all-on journey's
// answer checks under the predicate design are built by evidence/l3-c17/build-plan-c17.mjs (they need Main's journey results) and are
// added to the same plan file there.
//
//   heartbeat-c16 (sent 2026-11-24): 7/9. note .84/.85/.88 (speak, ok); ask .97 on a note without "?", 0 on a plain note; told_1 1.0 when the
//     answer said where, 0 when not; the work question .74 and .42 on two requested results (hard fails), .05 on "nothing to look at".
//   c17 product changes: a result the person requested is needed by its requester by definition (code); only a result they did not request
//     is judged ("does it contain something they must act on or decide"); a heartbeat message is checked against the facts it was
//     composed from, and only its sentences with a concrete detail are sent.
//
//   heartbeat-c14 (sent 2026-11-24): one choice with "none", numbers and closed labels only -> "none" in 15/15.
//   heartbeat-c15 (sent 2026-11-24): the run's own material and yes/no questions -> 14/15. The progress note and the early question
//     discriminated (silent .16-.45, speak .82-.94, ask .94); the pointer question said yes whatever the audience (1.0 with nobody at
//     the desk, .92 after the answer had said where the document is); the stall question followed the seconds (24 s .28, 60 s .78).
//   c16 product changes: whether anyone is there, where it is and whether a pointer was posted are code (pointerBlocked); the pointer
//     asks only "does the finished work need them" and "does this posted message already say where", each item quoted on its own;
//     the stall is code (the note question decides whether to speak); a run without a tool step gets no note before 30 s while its
//     engine is active.
//
// This file SENDS NOTHING. It scripts sessions in public synthetic Korean (engine events, provider rows, presence, a virtual clock),
// lets the product build each request, and records the exact bytes the product's decision client would POST (its fetch is replaced
// by a recorder that refuses). The generic runner (scripts/egdesk-decision-real-measure.mjs) consumes the plan written by
// scripts/egdesk-heartbeat-real-plan.mjs: { set, tokenCeiling, passRule, requests: [{ id, file, sha256, estInputTokens, expect }] }.
//
// HEARTBEAT_PATTERNS is every case as the product builds it now; HEARTBEAT_REMEASURE names the ones sent in this set. The test
// proves that every other case still has the exact bytes that were measured in heartbeat-c15 (so its result still holds).
//
// Two ways a request is built, named in each pattern's `path`:
//   'runtime'         the whole product path: CodexChatRuntime + its session heartbeat + providers + egress gate + beat judge + client.
//   'counterfactual'  the product never asks at this moment (a code rule decides first, or the "?" pre-filter of the early question
//                     is set aside to learn whether removing it would be safe). The same product functions build the material and
//                     the questions (heartbeat, beatFlowFacts, runContext, flowPredicates, beat judge, client).
//
// Expectations are registered here, before any real answer exists. A yes must reach the product's own bar (0.8). A no must be 0.5 or
// less. 'hard': the shipped design depends on it. 'soft': a direction, or a study of a change not made yet; never fails the set.

export const HEARTBEAT_PLAN_SET = 'heartbeat-c18'
export const HEARTBEAT_PLAN_PASS_RULE = `Pass: every hard expectation holds. A yes must reach ${BEAT_PREDICATE_YES} (the heartbeat's bar; the draft check acts at 0.7 and is registered at 0.8 here too), a no 0.5 or less. Soft expectations are findings. No retries; one request per pattern.`
const SYNTHETIC_KEY = 'egd-synthetic-not-a-key-heartbeat-plan'
const sha = text => createHash('sha256').update(text).digest('hex')
const named = (name, family) => (family === 'draft' ? name : `message__${name}`)
const yes = (name, severity, note, family) => ({ name: named(name, family), kind: 'predicate', min: BEAT_PREDICATE_YES, severity, note })
const no = (name, severity, note, family) => ({ name: named(name, family), kind: 'predicate', max: 0.5, severity, note })

/** A product decision client whose fetch records the body and refuses: the bytes are the product's, and nothing leaves. */
function recorder({ key = 'heartbeat-beat' } = {}) {
  const wires = []
  const client = createDecisionClient({ getApiKey: () => SYNTHETIC_KEY, fetchImpl: async (endpoint, init) => { wires.push(String(init.body)); throw new Error('plan builder: nothing is sent') } })
  return { wires, client, tap: async request => { if (request.promptCacheKey === key) await client.decide(request).catch(() => {}) } }
}
const sessionOf = wire => JSON.parse(wire).input[1].content
function pick(wires, seconds) {
  const hit = wires.filter(wire => new RegExp(`^seconds_since_the_person_wrote: ${seconds}$`, 'm').test(sessionOf(wire)))
  if (hit.length !== 1) throw new Error(`expected exactly one request at ${seconds} s, found ${hit.length} (asked at: ${wires.map(wire => /wrote: (\d+)/.exec(sessionOf(wire))?.[1]).join(', ')})`)
  return hit[0]
}

// ---- the whole product path ----
async function inRuntime(options, script, { key = 'heartbeat-beat' } = {}) {
  const cleanups = [], rec = recorder({ key })
  const t = { after: fn => cleanups.push(fn), diagnostic() {} }
  const w = world(t, { policy: { message: () => 'none' }, ...options, tap: rec.tap })
  try { return await script(w, rec.wires) } finally { w.chat.heartbeats.stopAll('restart'); for (const fn of cleanups.reverse()) try { fn() } catch { /* temp files */ } }
}
const reasoning = { start: (d, id = 'r1') => d.raw('item/started', { item: { id, type: 'reasoning', summary: [], content: [] } }), delta: (d, id = 'r1') => d.raw('item/reasoning/summaryTextDelta', { itemId: id, delta: 'x' }),
  end: (d, id = 'r1') => d.raw('item/completed', { item: { id, type: 'reasoning', summary: [], content: [] } }) }
const command = (d, id, line, status, extra = {}) => d.raw(status === 'inProgress' ? 'item/started' : 'item/completed', { item: { id, type: 'commandExecution', command: line, cwd: '/work', status, commandActions: [], ...extra } })
// The placement runtime's provider, as it registers on the conversation's heartbeat (its present field names).
function placement(hb) {
  const state = { pointer: null }
  hb.register('work_placement', () => ({ placementsPending: 0, placementsDecided: state.pointer ? 1 : 0, pointerPending: Boolean(state.pointer), ...(state.pointer ?? {}) }))
  return state
}
const quiet = { message: () => 'none' } // the mock answers no to everything: nothing is posted while the requests are recorded
const SELF = { member: 'self', self: true, active: true, lastInputAgeMs: 2000 }
const AUDIENCE = { 'dm-task': { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, 'dm-owner': { requester: 'self', owner: 'self', participants: ['self'] } }
const audienceOf = ({ run }) => AUDIENCE[run.clientThreadId] ?? null

// ---- the same builders, at a moment the product's own rules never ask ----
function clockwork() {
  let clock = 1_000_000
  const timers = []
  return { monotonicNow: () => clock, setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    async advance(ms) { const end = clock + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const next = timers[0]; if (!next || next.at > end) break; timers.shift(); clock = next.at; next.fn(); await new Promise(resolve => setImmediate(resolve)) } clock = end } }
}
async function counterfactual({ atMs, proposal, script }) {
  const c = clockwork(), rec = recorder(), hb = createHeartbeat({ key: 'plan', ...c })
  hb.setJudge(createBeatJudge({ client: rec.client }))
  hb.register('message', { propose: beat => (beat.facts.sinceUserMs === atMs ? proposal(beat, hb) : null), onVerdict: () => 'none' })
  hb.activate()
  await script({ hb, c, at: async ms => { await c.advance(ms - hb.internalMs()) } })
  await c.advance(atMs - 500 - hb.internalMs()); hb.nudge(); await c.advance(500)
  for (let i = 0; i < 20 && !rec.wires.length; i++) await new Promise(resolve => setImmediate(resolve))
  hb.stop('restart')
  return pick(rec.wires, Math.round(atMs / 1000))
}
const OWN = new Set(['workNote'])
const tool = (id, line, status) => ({ id, kind: 'commandExecution', status, detail: { command: line } })
// A working run's material and questions with the code rule set aside: `options` are the kinds whose questions are asked anyway.
const runProposal = ({ userText, activities = [], sent = [], kinds = [], stepsAtLast = 0, presence = null, reasoningOpen = false, options, note = null }) => beat => {
  const run = { activities, pendingApprovals: [] }
  const flow = { sent, kinds: new Set(kinds), askedNotes: new Set(), stepsAtLast, question: null, audience: () => audienceFacts({ audience: null, presence }), reasoningOpen: () => reasoningOpen }
  const facts = beatFlowFacts({ heartbeatFacts: beat.facts, run, flow, own: OWN })
  return { context: runContext({ run, heartbeatFacts: beat.facts, flow, facts, userText, own: OWN }), questions: flowPredicates(options, note ? { note: { text: note } } : {}) }
}

// What the scripted writer returns for a wait message (public synthetic).
export const WAIT = Object.freeze({ concrete: '결제 모듈 테스트(`npm test`)를 10초째 실행하고 있어요. 끝나는 대로 결과를 알려 드릴게요.', invented: '결제 모듈 테스트 128개 중 3개가 실패했어요. 나머지를 확인하고 있어요.' })
// The draft check of the wait message at the 10 s beat of a running test command, as the product builds it.
async function waitCheck({ design, text }) {
  return inRuntime({ flags: { held: true, flow: true, commands: true, design }, policy: { message: values => (values.includes('explain_wait') ? 'explain_wait' : 'none') }, writer: () => text }, async (w, wires) => {
    const d = await w.dm('dm', REQUEST.tests)
    await command(d, 'cmd-1', 'npm test -- --suite=payments', 'inProgress'); await w.advance(8000); await d.raw('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'ok\n' })
    await w.advance(2000)
    if (wires.length !== 1) throw new Error(`expected one draft check, got ${wires.length}`)
    return wires[0] }, { key: 'draft-check' })
}
export const NOTE = Object.freeze({ plain: '결제 모듈 테스트 파일 목록을 확인했다. 이제 전체 테스트를 실행한다.', needs: '배포 대상 환경이 운영인지 스테이징인지 요청에 없다. 사용자가 정해 주어야 진행할 수 있다.' })
export const REQUEST = Object.freeze({ quote: '거래처에 보낼 견적서 수정본 초안을 만들어 주세요.', tests: '결제 모듈 테스트를 돌리고 실패한 항목이 있으면 정리해 주세요.', logs: '지난주 배포 로그에서 오류가 난 구간을 찾아서 원인을 알려 주세요.', plan: '다음 분기 서버 증설 계획을 표로 정리해 주세요.',
  portal: '거래처 포털에서 10월 세금계산서 목록을 내려받아 주세요.', deploy: '주문 서비스를 배포해 주세요.', review: '어제 올라온 풀 리퀘스트를 검토하고 문제를 알려 주세요.',
  report: '3분기 매출 보고서 초안을 만들어 주세요.', survey: '경쟁 제품 세 곳의 요금제를 조사해서 문서로 정리해 주세요.', budget: '내년 예산표를 부서별로 정리해 주세요.', summary: '조사한 내용을 세 줄로 요약해 주세요.' })
// The answers the scripted runs post (checked by the test to arrive in the request unchanged).
export const ANSWER = Object.freeze({ quote: '견적서 수정본 초안을 만들었습니다. 단가 적용 여부를 정해 주셔야 발송할 수 있습니다.', tests: '결제 모듈 테스트가 모두 통과했습니다. 실패한 항목이 없어 따로 정리할 내용은 없습니다.', report: '매출 보고서 초안을 만들었습니다. 요약과 표가 들어 있습니다.', survey: '세 곳의 요금제를 조사해서 문서로 정리했습니다.',
  surveyTold: '세 곳의 요금제를 조사해서 문서로 정리했습니다. 문서는 지금 보고 계신 화면 바로 오른쪽에 열어 두었습니다.', budget: '부서별 예산표를 정리했습니다.' })

/**
 * The patterns, in order. build() → the exact request body (string). expect: registered before any real answer.
 * before: what the first measurement (heartbeat-c14) returned for this situation. ifMissed: what a miss would change now.
 */
export const HEARTBEAT_PATTERNS = Object.freeze([
  { id: 'need-quick-3s', path: 'counterfactual', pattern: '3 s after the request, the engine is reasoning, nothing else has happened',
    codeRule: 'no message before 10 s (FLOW_LIMITS.firstAfterMs): the product never asks here', before: 'none 0.96 (correct)',
    expect: [no('note', 'hard', 'Control: three seconds in, a progress note is noise. A question that says yes here says yes to everything.')],
    ifMissed: 'The wording of the progress-note question (it reads as "is a note ever nice" instead of "now"). The 10 s code rule stays either way.',
    build: () => counterfactual({ atMs: 3000, proposal: runProposal({ userText: REQUEST.tests, reasoningOpen: true, options: ['explain_wait'] }), script: async ({ hb, at }) => { await at(2000); hb.mark('engine', 'reasoning') } }) },
  { id: 'need-thinking-12s', path: 'counterfactual', pattern: '12 s, the engine has been reasoning the whole time (activity 1 s ago), no tool step',
    codeRule: 'with no tool step a progress note is first possible at 20 s: the product never asks here', before: 'none 0.96',
    expect: [no('note', 'soft', 'Reasoning is visibly going on and no step has run: the design waits until 20 s.')],
    ifMissed: 'Nothing in the product (the 20 s rule decides). It would say the model speaks sooner than the rule, which argues for keeping the rule.',
    build: () => counterfactual({ atMs: 12_000, proposal: runProposal({ userText: REQUEST.logs, reasoningOpen: true, options: ['explain_wait'] }), script: async ({ hb, at }) => { for (const ms of [3000, 6000, 9000, 11_000]) { await at(ms); hb.mark('engine', 'reasoning') } } }) },
  { id: 'need-thinking-30s', path: 'runtime', pattern: '30 s, reasoning deltas keep arriving (1 s ago), no tool step: under the new floor the first moment the product asks in a thinking-only run',
    before: 'heartbeat-c15 asked at 20 s on the same material: .62 (and .35 at 3 s, .45 at 12 s)',
    expect: [yes('note', 'hard', 'Thirty seconds without a word: with the 20 s ask gone, this is the first chance to tell the person anything.')],
    ifMissed: 'If between 0.5 and 0.8: the model still reads mostly the clock; the next ask comes at 50 s (backoff), so the floor alone does not fix the case and the note question needs to say how long the person has heard nothing. Below 0.5: the wording.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm', REQUEST.plan); await w.advance(1000); await reasoning.start(d)
      for (const ms of [4000, 7000, 10_000, 13_000, 16_000, 19_000, 22_000, 25_000, 28_000, 29_000]) { await w.advance(ms - w.at()); await reasoning.delta(d) }
      await w.advance(30_000 - w.at()); return pick(wires, 30) }) },
  { id: 'need-command-45s', path: 'runtime', pattern: '45 s, the test command has been running for 23 s (output 2 s ago), nothing said yet; the product asked at 25 s (declined) and asks again now', before: 'heartbeat-c15 at 40 s on the same session (command 18 s): .82. With the no-step floor the first ask moved from 20 s to 25 s, so the second from 40 s to 45 s',
    expect: [yes('note', 'hard', 'The case the progress note exists for: a long command, and the person has heard nothing for 40 s.')],
    ifMissed: 'The material is then not the problem (the request and the command line are there): the wording of the question, or the bar (if the answer is between 0.5 and 0.8).',
    build: () => inRuntime({ flags: { held: true, flow: true, commands: true } }, async (w, wires) => { const d = await w.dm('dm', REQUEST.tests); await w.advance(1000); await reasoning.start(d)
      for (const ms of [5000, 9000, 13_000, 17_000, 19_000]) { await w.advance(ms - w.at()); await reasoning.delta(d) }
      await w.advance(20_500 - w.at()); await reasoning.end(d); await d.note('n1', '결제 모듈 테스트를 실행한다.')
      await w.advance(22_000 - w.at()); await command(d, 'cmd-1', 'npm test -- --suite=payments', 'inProgress')
      for (const ms of [24_000, 31_000, 38_000, 43_000]) { await w.advance(ms - w.at()); await d.raw('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'ok\n' }) }
      await w.advance(45_000 - w.at()); return pick(wires, 45) }) },
  { id: 'need-objective-40s', path: 'runtime', pattern: '40 s into a multi-step browser task: 3 steps done, up to 21 more, nothing said yet, the engine itself silent since the start', before: 'none 0.96 (hard failure)',
    expect: [yes('note', 'hard', 'A multi-step task that will clearly go on: the person should hear that it is under way.')],
    ifMissed: 'The wording of the task lines (steps done, upper limit of steps) or of the question; if between 0.5 and 0.8, the bar.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm', REQUEST.portal); const task = { steps: 0, last: 0 }
      await w.advance(1000); d.hb.register('browser_task', () => browserTaskRow({ active: true, status: 'running', stepsDone: task.steps, stepsRemaining: 24 - task.steps, lastActionAgeMs: w.at() - task.last, idleMs: 0 }))
      for (const ms of [21_000, 29_000, 37_000]) { await w.advance(ms - w.at()); task.steps++; task.last = w.at() }
      await w.advance(40_000 - w.at()); return pick(wires, 40) }) },
  { id: 'need-missing-10s', path: 'runtime', pattern: '10 s, one step done, and the Agent\'s latest note asks which environment to deploy to (the note is quoted to the judge)', before: 'none 0.99, ask_missing 0.00 (hard failure)',
    expect: [yes('ask', 'hard', 'The early question exists for this: only the person knows the environment, and asking now saves a wasted wait.')],
    ifMissed: 'The wording of the ask question (the note is now quoted, so the material is there); if between 0.5 and 0.8, the bar.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm', REQUEST.deploy); await w.advance(4000); await command(d, 's1', 'git status --short', 'inProgress'); await w.advance(2000); await command(d, 's1', 'git status --short', 'completed', { exitCode: 0 })
      await w.advance(1000); await d.note('n1', '배포 대상이 운영인지 스테이징인지 요청에 없다. 어느 환경에 배포해야 하나?'); await w.advance(3000); return pick(wires, 10) }) },
  { id: 'need-silence-25s', path: 'runtime', pattern: '25 s, nothing at all from the engine for 24 s, no step running; the Agent\'s plain note ("변경 파일을 확인하는 중이다", no "?") now rides along as an early-question judgment', before: 'heartbeat-c16: note .88 (alone)',
    expect: [yes('note', 'hard', 'True silence: the person must be told something; code words it as the stall line.'), no('ask_1', 'hard', 'A plain plan step needs nothing from the person: a ride-along note must not turn into a question.')],
    ifMissed: 'note: a ride-along question next to it changed the answer (then ride-along must not share a request with the note question). ask_1 above 0.5: ride-along asks about plain notes; revert to the "?" filter.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm', REQUEST.review); await w.advance(1000); await d.note('n1', '풀 리퀘스트의 변경 파일을 확인하는 중이다.'); await w.advance(24_000); return pick(wires, 25) }) },
  { id: 'need-reasoning-70s', path: 'runtime', pattern: '70 s, a reasoning item has been open for 60 s and nothing has come since, nothing said yet; the note question alone decides', before: 'heartbeat-c15: note .94, stalled .78',
    expect: [yes('note', 'hard', 'Seventy seconds without a word: the person must be told something; code words it as the stall line.')],
    ifMissed: 'As need-silence-25s: the note question carries the case alone; a miss means its wording.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm', REQUEST.logs); await w.advance(1000); await d.note('n1', '배포 로그를 시간순으로 훑어본다.'); await w.advance(9000); await reasoning.start(d); await w.advance(60_000); return pick(wires, 70) }) },
  { id: 'need-just-posted-8s', path: 'counterfactual', pattern: '28 s, a progress note was posted 8 s ago, two more steps finished since',
    codeRule: 'no message within 30 s of the last one (FLOW_LIMITS.minGapMs): the product never asks here', before: 'none (soft, held)',
    expect: [no('note', 'hard', 'Eight seconds after speaking, another note is noise.')],
    ifMissed: 'The wording of the progress-note question (what was already said is in the material; the question must weigh it). The 30 s code rule stays either way.',
    build: () => counterfactual({ atMs: 28_000, script: async ({ hb, at }) => { let done = 1; hb.setSource(() => ({ stepsDone: done, stepsRunning: 1 })); await at(20_000); hb.mark('engine', 'tool'); hb.mark('posted'); await at(23_000); done = 2; hb.mark('engine', 'tool'); await at(26_000); done = 3; hb.mark('engine', 'tool') },
      proposal: (beat, hb) => runProposal({ userText: REQUEST.tests, stepsAtLast: 1, kinds: ['explain_wait'], options: ['milestone'],
        activities: [tool('s1', 'npm ci', 'completed'), tool('s2', 'npm run lint', 'completed'), tool('s3', 'npm run build', 'completed'), tool('s4', 'npm test -- --suite=payments', 'inProgress')],
        sent: [{ kind: 'explain_wait', text: '테스트를 돌리는 중이라 조금 걸립니다. 끝나면 바로 정리해 드릴게요.', at: hb.internalMs() - 8000 }] })(beat) }) },
  { id: 'ask-plain-note-10s', path: 'counterfactual', pattern: '10 s, one step done; the Agent\'s latest note is a plain plan step (no question, nothing needed from the person), quoted to the ask question as it would be without the "?" pre-filter',
    codeRule: 'the product asks the early question only about a note that ends in "?"; this case sets that pre-filter aside', before: 'new (the only real ask answer so far: .94 on a note that ended in "?")',
    expect: [no('ask', 'soft', 'A plain plan step needs nothing from the person: removing the pre-filter is safe only if this stays no.')],
    ifMissed: 'Keep the "?" pre-filter: without it every note would risk an early question.',
    build: () => counterfactual({ atMs: 10_000, script: async ({ hb, at }) => { hb.setSource(() => ({ stepsDone: 1, stepsRunning: 0 })); await at(6000); hb.mark('engine', 'tool'); await at(7000); hb.mark('engine', 'output') },
      proposal: runProposal({ userText: REQUEST.tests, options: ['ask_missing', 'explain_wait'], note: NOTE.plain, activities: [tool('s1', 'ls test', 'completed'), { id: 'n1', kind: 'workNote', status: 'completed', detail: { text: NOTE.plain } }] }) }) },
  { id: 'ask-no-question-mark-10s', path: 'counterfactual', pattern: '10 s, one step done; the Agent\'s latest note says it cannot go on without the person choosing the environment, but does not end in "?"',
    codeRule: 'the product asks the early question only about a note that ends in "?"; this case sets that pre-filter aside', before: 'new',
    expect: [yes('ask', 'soft', 'The information only the person has is named plainly: removing the pre-filter is worth it only if this is a yes.')],
    ifMissed: 'Keep the "?" pre-filter: without a yes here, removing it costs requests and gains nothing.',
    build: () => counterfactual({ atMs: 10_000, script: async ({ hb, at }) => { hb.setSource(() => ({ stepsDone: 1, stepsRunning: 0 })); await at(6000); hb.mark('engine', 'tool'); await at(7000); hb.mark('engine', 'output') },
      proposal: runProposal({ userText: REQUEST.deploy, options: ['ask_missing', 'explain_wait'], note: NOTE.needs, activities: [tool('s1', 'git status --short', 'completed'), { id: 'n1', kind: 'workNote', status: 'completed', detail: { text: NOTE.needs } }] }) }) },

  { id: 'ride-along-needs-10s', path: 'runtime', pattern: '10 s, a tool step running; the Agent\'s note says it cannot go on without the person choosing the environment, without "?"; it rides along on the progress-note request', before: 'heartbeat-c16 counterfactual ask-no-question-mark-10s: ask .97 (alone, quoted as the latest note)',
    expect: [yes('ask_1', 'hard', 'The information only the person has is named plainly: the early question must come from the ride-along judgment.')],
    ifMissed: 'The ride-along judgment misses what the same note got alone (.97): its label ("A note the assistant wrote to itself") or its company in the request matters; the "?" filter then stays the only early-question path.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm', REQUEST.deploy); await w.advance(1000); await d.note('n1', NOTE.needs)
      await w.advance(1000); await command(d, 's1', 'git status --short', 'inProgress'); await w.advance(8000); return pick(wires, 10) }) },
  { id: 'pointer-owner-elsewhere', path: 'runtime', pattern: 'a member\'s task has ended; its result (a report draft) waits for the owner, who did not request it; the owner is at the desk with a conversation of their own; the background question is asked', before: 'heartbeat-c16: .74 on "does the person need to look at it" (hard fail)',
    expect: [no('pointer', 'soft', 'A plain report draft holds nothing the owner must act on or decide: no pointer for background work.')],
    ifMissed: 'A yes: the background question reads "a draft" as something to review = act on; then every background result points the owner, which is the c16 behaviour.',
    build: () => inRuntime({ policy: quiet, audience: audienceOf, presence: { snapshot: () => [SELF, { member: 'm-jin', active: false, lastInputAgeMs: 400_000 }] } }, async (w, wires) => {
      const o = await w.dm('dm-owner', REQUEST.budget); await w.advance(3000); await o.final(ANSWER.budget)
      const m = await w.dm('dm-task', REQUEST.report); await w.advance(4000); await m.final(ANSWER.report)
      await w.advance(2000); placement(m.hb).pointer = { pointerWhere: 'left', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'review' }
      m.hb.nudge(); await w.advance(500); return pick(wires, 7) }) },
  { id: 'pointer-requester-present', path: 'runtime', pattern: 'the run has ended; its result waits for the requester outside their view; they requested it, so only the already-told question is asked', before: 'heartbeat-c16: pointer .42 (hard fail), told_1 0',
    expect: [no('told_1', 'hard', 'The answer says what was done, not where the document is: code then points.')],
    ifMissed: 'told_1 above 0.5: the told question reads "I made a document" as a location; its wording.',
    build: () => inRuntime({ policy: quiet, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const d = await w.dm('dm', REQUEST.survey); await w.advance(4000); await d.final(ANSWER.survey)
      await w.advance(6000); placement(d.hb).pointer = { pointerWhere: 'right', pointerDistance: 'near', pointerFor: 'requester', pointerNeeds: 'review' }
      d.hb.nudge(); await w.advance(500); return pick(wires, 11) }) },
  { id: 'pointer-owner-decision', path: 'runtime', pattern: 'a member\'s task has ended; its result waits for the owner, who did not request it; the announcement says the owner must decide the price before it can be sent', before: 'new',
    expect: [yes('pointer', 'hard', 'Background work that waits for the owner\'s decision: the owner must be told where it is.')],
    ifMissed: 'The background question misses decisions written in plain words; it would then never point the owner to background work.',
    build: () => inRuntime({ policy: quiet, audience: audienceOf, presence: { snapshot: () => [SELF, { member: 'm-jin', active: false, lastInputAgeMs: 400_000 }] } }, async (w, wires) => {
      const o = await w.dm('dm-owner', REQUEST.budget); await w.advance(3000); await o.final(ANSWER.budget)
      const m = await w.dm('dm-task', REQUEST.quote); await w.advance(4000); await m.final(ANSWER.quote)
      await w.advance(2000); placement(m.hb).pointer = { pointerWhere: 'left', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'review' }
      m.hb.nudge(); await w.advance(500); return pick(wires, 7) }) },
  { id: 'pointer-already-told', path: 'runtime', pattern: 'as above, but the posted answer says the document is open just to the right of the screen they are looking at', before: 'heartbeat-c15: pointer .92 (soft miss: they had been told)',
    expect: [yes('told_1', 'hard', 'The answer names the place: code then posts no pointer. Code cannot read that sentence; this question carries the case.')],
    ifMissed: 'The told question wording; until it holds, a second note about the same place can follow the answer.',
    build: () => inRuntime({ policy: quiet, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const d = await w.dm('dm', REQUEST.survey); await w.advance(4000); await d.final(ANSWER.surveyTold)
      await w.advance(6000); placement(d.hb).pointer = { pointerWhere: 'right', pointerDistance: 'near', pointerFor: 'requester', pointerNeeds: 'review' }
      d.hb.nudge(); await w.advance(500); return pick(wires, 11) }) },
  { id: 'pointer-nothing-to-look-at', path: 'runtime', pattern: 'the run has ended; the test report waits for the requester outside their view; the answer already says every test passed and there is nothing to follow up', before: 'new',
    expect: [no('pointer', 'soft', 'The message already gives them all they need; pointing to the report adds nothing.'), no('told_1', 'soft', 'The answer does not say where the report is.')],
    ifMissed: 'pointer yes: the work question cannot tell "done, nothing to see" from "done, go and look"; the pointer then always goes out for a result (harmless, one line).',
    build: () => inRuntime({ policy: quiet, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const d = await w.dm('dm', REQUEST.tests); await w.advance(4000); await d.final(ANSWER.tests)
      await w.advance(6000); placement(d.hb).pointer = { pointerWhere: 'right', pointerDistance: 'near', pointerFor: 'requester', pointerNeeds: 'review' }
      d.hb.nudge(); await w.advance(500); return pick(wires, 11) }) },
  { id: 'pointer-new-run', path: 'runtime', pattern: 'a result of the previous run waits for the owner; the owner has just started a new run in the same conversation (5 s in); the previous answer did not say where', before: 'heartbeat-c15: pointer .95',
    expect: [yes('pointer', 'soft', 'The survey document they asked for: they need to look at it.'), no('told_1', 'soft', 'The previous answer does not say where it is.')],
    ifMissed: 'Nothing breaks: the fact stays pending and is asked again at later beats and after the run.',
    build: () => inRuntime({ policy: quiet, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const first = await w.dm('dm', REQUEST.survey); await w.advance(4000); await first.final(ANSWER.survey)
      placement(first.hb).pointer = { pointerWhere: 'below', pointerDistance: 'near', pointerFor: 'owner', pointerNeeds: 'review' }
      await w.advance(2000); await w.dm('dm', REQUEST.summary, { requestId: 'req-2', conversationId: first.r.conversationId })
      await w.advance(5000); return pick(wires, 5) }) },
  { id: 'pointer-held-3min', path: 'runtime', pattern: 'a result has waited 3 minutes for the owner, who had no conversation open; they have just started a run in their own conversation (5 s in); only the work question is asked', before: 'heartbeat-c15: pointer .95',
    expect: [yes('pointer', 'soft', 'A report draft made for the owner: they need to look at it.')],
    ifMissed: 'The held fallback then rarely delivers; the work question wording.',
    build: () => inRuntime({ policy: quiet, audience: audienceOf, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const m = await w.dm('dm-task', REQUEST.report); await w.advance(4000); await m.final(ANSWER.report)
      placement(m.hb).pointer = { pointerWhere: 'left', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'review' }
      m.hb.nudge(); await w.advance(500); await w.advance(179_500)
      await w.dm('dm-owner', REQUEST.budget); await w.advance(5000); return pick(wires, 5) }) },
  { id: 'wait-check-choice', path: 'runtime', kind: 'draft_check', pattern: 'the draft check of a wait message at 10 s of a test command, default (choice) design, against the facts it was composed from; only its sentence with a concrete detail is sent', before: 'all-on journey s4 (2026-11-24): a wait message checked against the turn\'s memory pages: present .90/.91 -> blocked',
    expect: [no('present_0', 'hard', 'The sentence states what the run is doing now, and the evidence says so (time=present).', 'draft'), { name: 'claim_0', kind: 'choice', equals: 'supported', severity: 'soft', note: 'The facts hold the command and the seconds.' }],
    ifMissed: 'present_0 above 0.5 with facts of the present: the present question itself is misread (as on s1 and s6); then the predicate design is the fix, not the evidence.',
    build: () => waitCheck({ design: 'choice', text: WAIT.concrete }) },
  { id: 'wait-check-predicates', path: 'runtime', kind: 'draft_check', pattern: 'the same wait message under the predicate design', before: 'new',
    expect: [yes('sup_0', 'hard', 'The facts say a payment test command has been running about 10 seconds.', 'draft'), no('tense_0', 'hard', 'Nothing in it is only planned or past.', 'draft')],
    ifMissed: 'sup_0 below 0.8: the support question wants the Korean sentence to match English facts word for word; tense_0 above 0.5: the tense question is misread too.',
    build: () => waitCheck({ design: 'predicates', text: WAIT.concrete }) },
  { id: 'wait-check-invented-result', path: 'runtime', kind: 'draft_check', pattern: 'a wait message that invents a result (3 of 128 tests failed) while the command still runs, predicate design', before: 'new',
    expect: [no('sup_0', 'hard', 'Nothing in the facts says any test failed: the check exists to stop exactly this.', 'draft')],
    ifMissed: 'The check would let an invented result through; heartbeat messages could not be posted unchecked-in-effect.',
    build: () => waitCheck({ design: 'predicates', text: WAIT.invented }) },
])

/**
 * The cases sent in this set (estimated under 5,000 input tokens): the new or changed cases a design decision rests on.
 * Changed but not sent, with the reason (HEARTBEAT_NOT_SENT): their question and quoted item are the same as a sent case.
 */
export const HEARTBEAT_REMEASURE = Object.freeze(['need-silence-25s', 'ride-along-needs-10s'])
export const HEARTBEAT_NOT_SENT = Object.freeze({
  // need-silence-25s is sent (it now carries a ride-along note).
  'need-reasoning-70s': 'the c15 body (note .94) minus the stall question; need-silence-25s measured the note question alone in a silence (.88) and is re-measured with its ride-along note',
  'pointer-already-told': 'requested: only told_1 is asked now, on the same quoted message measured at 1.0 in heartbeat-c16',
  'pointer-nothing-to-look-at': 'requested: only told_1 is asked now, on the same quoted message measured at 0 in heartbeat-c16',
  'pointer-new-run': 'requested (the owner\'s own conversation): only told_1 on the same quoted message as pointer-requester-present',
  'pointer-held-3min': 'background: the same question on the same quoted message as pointer-owner-elsewhere (only the session lines differ)',
  // L3 c24: the draft check's tense question was reworded (decisions and plans are not "done"); the wait message is a present-tense sentence with no
  // plan or decision in it, measured tense .01 (predicates) and .95 for the invented result; the reworded question is measured on correct sentences and
  // on two wrong ones in plan draft-check-tense-c24 (w-disk-now, w-vendor-fact stay caught).
  'wait-check-predicates': 'the draft check\'s tense question was reworded in c24; the sentence and evidence are as measured in heartbeat-c17 (sup .81 / tense .01)',
  'wait-check-invented-result': 'the draft check\'s tense question was reworded in c24; the sentence and evidence are as measured in heartbeat-c17 (sup 0 / tense .95)',
})
// The runner stops when the provider's reported input tokens pass the ceiling.
export const HEARTBEAT_PLAN_TOKEN_CAP = 5000

/**
 * Cases code decides without any request (R3), run through the product. Returns [{ id, requests, held, posted }].
 *   pointer-nobody-waiting: the result waits for the owner, who is away -> no route, the fact is held, no request (c15 measured 1.0 here).
 *   pointer-in-view: the result is already inside what the requester is looking at -> no option, no request.
 */
export async function codeOnlyCases() {
  const nobody = await inRuntime({ policy: quiet, presence: { snapshot: () => [{ member: 'self', self: true, active: false, lastInputAgeMs: 900_000 }] } }, async (w, wires) => {
    const d = await w.dm('dm', REQUEST.report); await w.advance(4000); await d.final(ANSWER.report)
    placement(d.hb).pointer = { pointerWhere: 'right', pointerDistance: 'very_far', pointerFor: 'owner', pointerNeeds: 'review' }
    d.hb.nudge(); await w.advance(60_000); return { id: 'pointer-nobody-waiting', requests: wires.length, held: w.chat.heldAttention.length, posted: d.assistant().length } })
  const inView = await inRuntime({ policy: quiet, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
    const d = await w.dm('dm', REQUEST.survey); await w.advance(4000); await d.final(ANSWER.survey)
    placement(d.hb).pointer = { pointerWhere: 'none', pointerDistance: 'in_view', pointerFor: 'requester', pointerNeeds: 'review' }
    d.hb.nudge(); await w.advance(60_000); return { id: 'pointer-in-view', requests: wires.length, held: w.chat.heldAttention.length, posted: d.assistant().length } })
  return [nobody, inView]
}

/** Builds every request offline. Returns { set, tokenCeiling, passRule, requests: [{ id, file, sha256, estInputTokens, expect, body, bytes, path, pattern, codeRule?, before, ifMissed }] }. */
export async function buildHeartbeatPlan({ only = HEARTBEAT_REMEASURE } = {}) {
  const requests = []
  for (const p of HEARTBEAT_PATTERNS) {
    if (only && !only.includes(p.id)) continue
    const body = await p.build()
    requests.push({ id: p.id, file: `requests/${p.id}.json`, sha256: sha(body), estInputTokens: estimateInputTokens(body), expect: p.expect, body, bytes: Buffer.byteLength(body), path: p.path, pattern: p.pattern,
      ...(p.codeRule ? { codeRule: p.codeRule } : {}), before: p.before, ifMissed: p.ifMissed })
  }
  const total = requests.reduce((n, r) => n + r.estInputTokens, 0)
  // The estimate leans high (utf8 bytes / 3; the first plan measured 5,600 real tokens against 7,373 estimated); a quarter on top is the stop line.
  return { set: HEARTBEAT_PLAN_SET, tokenCeiling: only === HEARTBEAT_REMEASURE ? Math.min(Math.ceil(total * 1.25), HEARTBEAT_PLAN_TOKEN_CAP) : Math.ceil(total * 1.25), passRule: HEARTBEAT_PLAN_PASS_RULE, requests }
}

/** The plan file, exactly in the runner's format (no other keys). */
export function planFile(plan) {
  return { set: plan.set, tokenCeiling: plan.tokenCeiling, passRule: plan.passRule,
    requests: plan.requests.map(({ id, file, sha256, estInputTokens, expect }) => ({ id, file, sha256, estInputTokens, expect })) }
}
