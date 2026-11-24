import { createHash } from 'node:crypto'
import { createDecisionClient, estimateInputTokens } from './egdesk-decision-client.mjs'
import { createHeartbeat } from './egdesk-heartbeat.mjs'
import { BEAT_PREDICATE_YES, createBeatJudge } from './egdesk-heartbeat-judge.mjs'
import { browserTaskRow } from './egdesk-heartbeat-providers.mjs'
import { attentionOf, audienceFacts, beatFlowFacts, flowPredicates, idleContext, idleFlowFacts, runContext } from './egdesk-conversation-flow.mjs'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'

// The real-measurement plan for the heartbeat's message judgment, second registration (set heartbeat-c15).
//
// The first plan (heartbeat-c14, 15 requests, sent 2026-11-24) asked ONE choice with a "none" option from numbers and closed labels
// only. The real model answered "none" in all 15 patterns (7 hard expectations failed): with that request the heartbeat would never
// speak. The product now shows the judge what the run's own models receive (the person's request, what the Agent is doing, what was
// said) and asks yes/no questions; code derives the kind. This plan measures those new requests on the same 15 situations.
//
// This file SENDS NOTHING. It scripts sessions in public synthetic Korean (engine events, provider rows, presence, a virtual clock),
// lets the product build each request, and records the exact bytes the product's decision client would POST (its fetch is replaced
// by a recorder that refuses). The generic runner (scripts/egdesk-decision-real-measure.mjs) consumes the plan written by
// scripts/egdesk-heartbeat-real-plan.mjs: { set, tokenCeiling, passRule, requests: [{ id, file, sha256, estInputTokens, expect }] }.
//
// Two ways a request is built, named in each pattern's `path`:
//   'runtime'         the whole product path: CodexChatRuntime + its session heartbeat + providers + egress gate + beat judge + client.
//                     The request is the one the product really makes at that moment of that scripted session.
//   'counterfactual'  the product never asks at this moment: a rule in code decides first (no message before 10 s, none for 30 s after
//                     one, no pointer without a route). The same product functions build the material and the question
//                     (heartbeat, beatFlowFacts / idleFlowFacts, runContext / idleContext, flowPredicates, beat judge, client), with
//                     the code rule set aside, to learn whether the model would hold back by itself.
//
// Expectations are registered here, before any real answer exists. A yes must reach the product's own bar (0.8: below it the product
// stays silent). A no must be 0.5 or less: the product would stay silent up to 0.79, but an answer that leans yes where silence is
// plainly right means the question does not discriminate. 'hard': the design depends on it. 'soft': a direction; a miss is a finding.

export const HEARTBEAT_PLAN_SET = 'heartbeat-c15'
export const HEARTBEAT_PLAN_PASS_RULE = `Pass: every hard expectation holds. Speak cases: the named yes/no question must reach ${BEAT_PREDICATE_YES} (the product's bar for acting). Silent cases: it must be 0.5 or less. In need-silence-25s and need-reasoning-70s the product speaks when EITHER message__note or message__stalled is yes; the hard check is on message__note, so read message__stalled as well before calling those two a failure. Soft expectations are findings and never fail the set. No retries; one request per pattern.`
const SYNTHETIC_KEY = 'egd-synthetic-not-a-key-heartbeat-plan'
const sha = text => createHash('sha256').update(text).digest('hex')
const yes = (name, severity, note) => ({ name: `message__${name}`, kind: 'predicate', min: BEAT_PREDICATE_YES, severity, note })
const no = (name, severity, note) => ({ name: `message__${name}`, kind: 'predicate', max: 0.5, severity, note })

/** A product decision client whose fetch records the body and refuses: the bytes are the product's, and nothing leaves. */
function recorder() {
  const wires = []
  const client = createDecisionClient({ getApiKey: () => SYNTHETIC_KEY, fetchImpl: async (endpoint, init) => { wires.push(String(init.body)); throw new Error('plan builder: nothing is sent') } })
  return { wires, client, tap: async request => { if (request.promptCacheKey === 'heartbeat-beat') await client.decide(request).catch(() => {}) } }
}
const sessionOf = wire => JSON.parse(wire).input[1].content
function pick(wires, seconds) {
  const hit = wires.filter(wire => new RegExp(`^seconds_since_the_person_wrote: ${seconds}$`, 'm').test(sessionOf(wire)))
  if (hit.length !== 1) throw new Error(`expected exactly one request at ${seconds} s, found ${hit.length} (asked at: ${wires.map(wire => /wrote: (\d+)/.exec(sessionOf(wire))?.[1]).join(', ')})`)
  return hit[0]
}

// ---- the whole product path ----
async function inRuntime(options, script) {
  const cleanups = [], rec = recorder()
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
const runProposal = ({ userText, activities = [], sent = [], kinds = [], stepsAtLast = 0, presence = null, reasoningOpen = false, options }) => beat => {
  const run = { activities, pendingApprovals: [] }
  const flow = { sent, kinds: new Set(kinds), askedNotes: new Set(), stepsAtLast, question: null, audience: () => audienceFacts({ audience: null, presence }), reasoningOpen: () => reasoningOpen }
  const facts = beatFlowFacts({ heartbeatFacts: beat.facts, run, flow, own: OWN })
  return { context: runContext({ run, heartbeatFacts: beat.facts, flow, facts, userText, own: OWN }), questions: flowPredicates(options) }
}

export const REQUEST = Object.freeze({ tests: '결제 모듈 테스트를 돌리고 실패한 항목이 있으면 정리해 주세요.', logs: '지난주 배포 로그에서 오류가 난 구간을 찾아서 원인을 알려 주세요.', plan: '다음 분기 서버 증설 계획을 표로 정리해 주세요.',
  portal: '거래처 포털에서 10월 세금계산서 목록을 내려받아 주세요.', deploy: '주문 서비스를 배포해 주세요.', review: '어제 올라온 풀 리퀘스트를 검토하고 문제를 알려 주세요.',
  report: '3분기 매출 보고서 초안을 만들어 주세요.', survey: '경쟁 제품 세 곳의 요금제를 조사해서 문서로 정리해 주세요.', budget: '내년 예산표를 부서별로 정리해 주세요.', summary: '조사한 내용을 세 줄로 요약해 주세요.' })
// The answers the scripted runs post (checked by the test to arrive in the request unchanged).
export const ANSWER = Object.freeze({ report: '매출 보고서 초안을 만들었습니다. 요약과 표가 들어 있습니다.', survey: '세 곳의 요금제를 조사해서 문서로 정리했습니다.',
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
  { id: 'need-thinking-20s', path: 'runtime', pattern: '20 s, reasoning deltas keep arriving (1 s ago), no tool step: the first moment the product asks in a thinking-only run', before: 'none 0.94',
    expect: [yes('note', 'soft', 'Twenty seconds without a word to the person is twice the attention limit the design rests on.')],
    ifMissed: 'The first note in a thinking-only run then comes at the next ask (40 s). Either the question says more plainly that the person has seen nothing yet, or 40 s is accepted.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm', REQUEST.plan); await w.advance(1000); await reasoning.start(d)
      for (const ms of [4000, 7000, 10_000, 13_000, 16_000, 19_000]) { await w.advance(ms - w.at()); await reasoning.delta(d) }
      await w.advance(20_000 - w.at()); return pick(wires, 20) }) },
  { id: 'need-command-40s', path: 'runtime', pattern: '40 s, the test command has been running for 18 s (output 2 s ago), nothing said yet', before: 'none 0.94 (hard failure)',
    expect: [yes('note', 'hard', 'The case the progress note exists for: a long command, and the person has heard nothing for 40 s.')],
    ifMissed: 'The material is then not the problem (the request and the command line are there): the wording of the question, or the bar (if the answer is between 0.5 and 0.8).',
    build: () => inRuntime({ flags: { held: true, flow: true, commands: true } }, async (w, wires) => { const d = await w.dm('dm', REQUEST.tests); await w.advance(1000); await reasoning.start(d)
      for (const ms of [5000, 9000, 13_000, 17_000, 19_000]) { await w.advance(ms - w.at()); await reasoning.delta(d) }
      await w.advance(20_500 - w.at()); await reasoning.end(d); await d.note('n1', '결제 모듈 테스트를 실행한다.')
      await w.advance(22_000 - w.at()); await command(d, 'cmd-1', 'npm test -- --suite=payments', 'inProgress')
      for (const ms of [24_000, 31_000, 38_000]) { await w.advance(ms - w.at()); await d.raw('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'ok\n' }) }
      await w.advance(40_000 - w.at()); return pick(wires, 40) }) },
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
  { id: 'need-silence-25s', path: 'runtime', pattern: '25 s, nothing at all from the engine for 24 s, no step running, no reasoning item open', before: 'none 0.79 (hard failure)',
    expect: [yes('note', 'hard', 'True silence: the person must be told something. (The product also speaks when message__stalled is yes.)'),
      { name: 'message__stalled', kind: 'predicate', min: 0.5, severity: 'soft', note: 'Nothing for 24 s after "checking the material" leans towards a stall.' }],
    ifMissed: 'If both questions are no: the wording (silence is not read as something to tell the person). If only message__stalled is yes the product still speaks; the wording kind is then "stalled".',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm', REQUEST.review); await w.advance(1000); await d.note('n1', '풀 리퀘스트의 변경 파일을 확인하는 중이다.'); await w.advance(24_000); return pick(wires, 25) }) },
  { id: 'need-reasoning-70s', path: 'runtime', pattern: '70 s, a reasoning item has been open for 60 s and nothing has come since, nothing said yet', before: 'none 0.72 (hard failure)',
    expect: [yes('note', 'hard', 'Seventy seconds without a word: the person must be told something. (The product also speaks when message__stalled is yes.)'),
      no('stalled', 'soft', 'Reasoning is known to be in progress, so this is a long wait rather than a stall.')],
    ifMissed: 'If both are no: the wording. If message__stalled is yes instead of message__note: the person is told the response is unusually slow, which is acceptable; the 60 s reasoning bound is then worth a second look.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm', REQUEST.logs); await w.advance(1000); await d.note('n1', '배포 로그를 시간순으로 훑어본다.'); await w.advance(9000); await reasoning.start(d); await w.advance(60_000); return pick(wires, 70) }) },
  { id: 'need-just-posted-8s', path: 'counterfactual', pattern: '28 s, a progress note was posted 8 s ago, two more steps finished since',
    codeRule: 'no message within 30 s of the last one (FLOW_LIMITS.minGapMs): the product never asks here', before: 'none (soft, held)',
    expect: [no('note', 'hard', 'Eight seconds after speaking, another note is noise.')],
    ifMissed: 'The wording of the progress-note question (what was already said is in the material; the question must weigh it). The 30 s code rule stays either way.',
    build: () => counterfactual({ atMs: 28_000, script: async ({ hb, at }) => { let done = 1; hb.setSource(() => ({ stepsDone: done, stepsRunning: 1 })); await at(20_000); hb.mark('engine', 'tool'); hb.mark('posted'); await at(23_000); done = 2; hb.mark('engine', 'tool'); await at(26_000); done = 3; hb.mark('engine', 'tool') },
      proposal: (beat, hb) => runProposal({ userText: REQUEST.tests, stepsAtLast: 1, kinds: ['explain_wait'], options: ['milestone'],
        activities: [tool('s1', 'npm ci', 'completed'), tool('s2', 'npm run lint', 'completed'), tool('s3', 'npm run build', 'completed'), tool('s4', 'npm test -- --suite=payments', 'inProgress')],
        sent: [{ kind: 'explain_wait', text: '테스트를 돌리는 중이라 조금 걸립니다. 끝나면 바로 정리해 드릴게요.', at: hb.internalMs() - 8000 }] })(beat) }) },

  { id: 'pointer-owner-elsewhere', path: 'runtime', pattern: 'a member\'s task has ended; its result waits for the owner, some way to the left; the owner is at the desk and has a conversation of their own (the note would go there)', before: 'none 0.90, pointer 0.05 (hard failure)',
    expect: [yes('pointer', 'hard', 'The pointer exists for this: nothing is moved, so the note is the only way the owner learns where the result is.')],
    ifMissed: 'The wording of the pointer question or of the "where" sentence; if between 0.5 and 0.8, the bar.',
    build: () => inRuntime({ policy: quiet, audience: audienceOf, presence: { snapshot: () => [SELF, { member: 'm-jin', active: false, lastInputAgeMs: 400_000 }] } }, async (w, wires) => {
      const o = await w.dm('dm-owner', REQUEST.budget); await w.advance(3000); await o.final(ANSWER.budget)
      const m = await w.dm('dm-task', REQUEST.report); await w.advance(4000); await m.final(ANSWER.report)
      await w.advance(2000); placement(m.hb).pointer = { pointerWhere: 'left', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'review' }
      m.hb.nudge(); await w.advance(500); return pick(wires, 7) }) },
  { id: 'pointer-requester-present', path: 'runtime', pattern: 'the run has ended; its result waits for the requester, close by to the right, outside their view; the requester is at the desk in this conversation; the answer did not say where it is', before: 'none 0.92 (hard failure)',
    expect: [yes('pointer', 'hard', 'The requester is waiting right here, the answer did not say where the result is, and nothing was moved into their view.')],
    ifMissed: 'The wording of the pointer question (close by may read as "they will see it anyway"); if between 0.5 and 0.8, the bar.',
    build: () => inRuntime({ policy: quiet, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const d = await w.dm('dm', REQUEST.survey); await w.advance(4000); await d.final(ANSWER.survey)
      await w.advance(6000); placement(d.hb).pointer = { pointerWhere: 'right', pointerDistance: 'near', pointerFor: 'requester', pointerNeeds: 'review' }
      d.hb.nudge(); await w.advance(500); return pick(wires, 11) }) },
  { id: 'pointer-already-told', path: 'runtime', pattern: 'as above, but the answer already told the person that the document is to the right of their screen', before: 'new pattern (the former pointer-in-view is now a code rule: something in view is never asked about)',
    expect: [no('pointer', 'soft', 'They were just told where it is: a second note adds nothing.')],
    ifMissed: 'The wording of the pointer question ("given what was already said"), or the product should drop a pointer when its own answer names the place (a code rule is not possible there, so the judge has to carry it).',
    build: () => inRuntime({ policy: quiet, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const d = await w.dm('dm', REQUEST.survey); await w.advance(4000); await d.final(ANSWER.surveyTold)
      await w.advance(6000); placement(d.hb).pointer = { pointerWhere: 'right', pointerDistance: 'near', pointerFor: 'requester', pointerNeeds: 'review' }
      d.hb.nudge(); await w.advance(500); return pick(wires, 11) }) },
  { id: 'pointer-nobody-waiting', path: 'counterfactual', pattern: 'the run has ended; a result waits for the owner, far to the right; nobody is at the desk',
    codeRule: 'no route for a person who is away (pointerRoute): the product never asks here, it holds the fact for later', before: 'none (soft, held)',
    expect: [no('pointer', 'hard', 'Nobody is there to read it.')],
    ifMissed: 'Nothing in the product (the route rule decides). It would say presence must stay a code rule; the question could also name the reader\'s absence more plainly.',
    build: () => counterfactual({ atMs: 27_000, script: async ({ hb, at }) => { await at(6000); hb.settle(); hb.register('work_placement', () => ({ placementsPending: 0, placementsDecided: 1, pointerPending: true, pointerWhere: 'right', pointerDistance: 'very_far', pointerFor: 'owner', pointerNeeds: 'review' })) },
      proposal: beat => { const facts = idleFlowFacts({ heartbeatFacts: beat.facts, audience: audienceFacts({ audience: null, presence: [{ member: 'self', self: true, active: false, lastInputAgeMs: 900_000 }] }),
        pointer: { attention: attentionOf(beat.facts), pointed: false, pointers: 0, pointerTarget: 'here' } })
        return { context: idleContext({ heartbeatFacts: beat.facts, facts, userText: REQUEST.report, answerText: ANSWER.report }), questions: flowPredicates(['pointer']) } } }) },
  { id: 'pointer-new-run', path: 'runtime', pattern: 'a result of the previous run waits for the owner below, close by; the owner has just started a new run in the same conversation (5 s in)', before: 'none 0.98 (soft)',
    expect: [yes('pointer', 'soft', 'They are here and writing; telling them now costs one line.')],
    ifMissed: 'Nothing breaks: the fact stays pending and is asked again at later beats and after the run. If the model consistently waits, the pointer could be offered only once the run has gone on for a while.',
    build: () => inRuntime({ policy: quiet, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const first = await w.dm('dm', REQUEST.survey); await w.advance(4000); await first.final(ANSWER.survey)
      placement(first.hb).pointer = { pointerWhere: 'below', pointerDistance: 'near', pointerFor: 'owner', pointerNeeds: 'review' }
      await w.advance(2000); await w.dm('dm', REQUEST.summary, { requestId: 'req-2', conversationId: first.r.conversationId })
      await w.advance(5000); return pick(wires, 5) }) },
  { id: 'pointer-held-3min', path: 'runtime', pattern: 'a result has waited 3 minutes for the owner, who had no conversation open; they have just started a run in their own conversation (5 s in); the direction is no longer known', before: 'none 0.96 (soft)',
    expect: [yes('pointer', 'soft', 'It is the first chance to tell them, and three minutes is recent.')],
    ifMissed: 'The fallback then rarely delivers: either the sentence says that this is the first chance to tell the person, or the held fact is offered after the run instead of during it.',
    build: () => inRuntime({ policy: quiet, audience: audienceOf, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const m = await w.dm('dm-task', REQUEST.report); await w.advance(4000); await m.final(ANSWER.report)
      placement(m.hb).pointer = { pointerWhere: 'left', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'review' }
      m.hb.nudge(); await w.advance(500); await w.advance(179_500)
      await w.dm('dm-owner', REQUEST.budget); await w.advance(5000); return pick(wires, 5) }) },
])

/** Builds every request offline. Returns { set, tokenCeiling, passRule, requests: [{ id, file, sha256, estInputTokens, expect, body, bytes, path, pattern, codeRule?, before, ifMissed }] }. */
export async function buildHeartbeatPlan({ only = null } = {}) {
  const requests = []
  for (const p of HEARTBEAT_PATTERNS) {
    if (only && !only.includes(p.id)) continue
    const body = await p.build()
    requests.push({ id: p.id, file: `requests/${p.id}.json`, sha256: sha(body), estInputTokens: estimateInputTokens(body), expect: p.expect, body, bytes: Buffer.byteLength(body), path: p.path, pattern: p.pattern,
      ...(p.codeRule ? { codeRule: p.codeRule } : {}), before: p.before, ifMissed: p.ifMissed })
  }
  const total = requests.reduce((n, r) => n + r.estInputTokens, 0)
  // The estimate leans high (utf8 bytes / 3; the first plan measured 5,600 real tokens against 7,373 estimated); a quarter on top is the stop line.
  return { set: HEARTBEAT_PLAN_SET, tokenCeiling: Math.ceil(total * 1.25), passRule: HEARTBEAT_PLAN_PASS_RULE, requests }
}

/** The plan file, exactly in the runner's format (no other keys). */
export function planFile(plan) {
  return { set: plan.set, tokenCeiling: plan.tokenCeiling, passRule: plan.passRule,
    requests: plan.requests.map(({ id, file, sha256, estInputTokens, expect }) => ({ id, file, sha256, estInputTokens, expect })) }
}
