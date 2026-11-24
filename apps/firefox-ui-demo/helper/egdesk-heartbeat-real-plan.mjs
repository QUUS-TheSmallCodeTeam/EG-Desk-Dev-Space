import { createHash } from 'node:crypto'
import { createDecisionClient, estimateInputTokens } from './egdesk-decision-client.mjs'
import { createHeartbeat } from './egdesk-heartbeat.mjs'
import { createBeatJudge } from './egdesk-heartbeat-judge.mjs'
import { browserTaskRow } from './egdesk-heartbeat-providers.mjs'
import { attentionOf, audienceFacts, beatFlowFacts, enumerateOptions, flowQuestion, idleFlowFacts } from './egdesk-conversation-flow.mjs'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'

// The real-measurement plan for the heartbeat's judgments: the message question ("is a message needed now, and which kind") and its
// pointer option ("tell a person where something waits for them"). No real Decision call has judged these yet.
//
// This file SENDS NOTHING. It scripts fact patterns (engine events, provider rows, presence, a virtual clock), lets the product build
// each request, and records the exact bytes the product's decision client would POST (its fetch is replaced by a recorder that
// refuses). The generic runner (scripts/egdesk-decision-real-measure.mjs) consumes the plan written by
// scripts/egdesk-heartbeat-real-plan.mjs: { set, tokenCeiling, passRule, requests: [{ id, file, sha256, estInputTokens, expect }] }.
//
// Two ways a request is built, named in each pattern's `path`:
//   'runtime'         the whole product path: CodexChatRuntime + its session heartbeat + providers + egress gate + beat judge + client.
//                     The request is the one the product really makes at that moment of that scripted session.
//   'counterfactual'  the product never asks at this moment: a rule in code decides first (no message before 10 s, none for 30 s after
//                     one, no pointer without a route). The same product functions build the question (heartbeat, beatFlowFacts /
//                     idleFlowFacts, flowQuestion, beat judge, client) with the offered options or the route forced, to learn
//                     whether the model would hold back by itself. A miss there keeps the code rule; it changes nothing else.
//
// Expectations are registered here, before any real answer exists. 'hard': the design depends on it. 'soft': a direction we expect;
// a miss is a finding, not a failure. The product acts on a choice only at confidence >= 0.75 with a margin >= 0.2 over the second
// option (decisionThresholds), so an expected action carries minConfidence 0.75; below it the product would stay silent.

export const HEARTBEAT_PLAN_SET = 'heartbeat-c14'
export const HEARTBEAT_PLAN_PASS_RULE = 'Pass: every hard expectation holds (an expected action also needs confidence >= 0.75, the product\'s own acceptance bar). Soft expectations are reported as findings and never fail the set. No retries; one request per pattern.'
const QUESTION = 'message__need'
const SYNTHETIC_KEY = 'egd-synthetic-not-a-key-heartbeat-plan'
const sha = text => createHash('sha256').update(text).digest('hex')
const act = (value, severity, note) => ({ name: QUESTION, kind: 'choice', equals: value, minConfidence: 0.75, severity, note })
const hold = (severity, note) => ({ name: QUESTION, kind: 'choice', equals: 'none', severity, note })
const anyOf = (values, severity, note) => ({ name: QUESTION, kind: 'choice', oneOf: values, severity, note })

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
const command = (d, id, status, extra = {}) => d.raw(status === 'inProgress' ? 'item/started' : 'item/completed', { item: { id, type: 'commandExecution', command: 'npm test', cwd: '/work', status, commandActions: [], ...extra } })
// The placement runtime's provider, as it registers on the conversation's heartbeat (its present field names).
function placement(hb) {
  const state = { pointer: null }
  hb.register('work_placement', () => ({ placementsPending: 0, placementsDecided: state.pointer ? 1 : 0, pointerPending: Boolean(state.pointer), ...(state.pointer ?? {}) }))
  return state
}
const pointerPolicy = { message: values => (values.includes('pointer') ? 'pointer' : 'none') }
const SELF = { member: 'self', self: true, active: true, lastInputAgeMs: 2000 }
const AUDIENCE = { 'dm-task': { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, 'dm-owner': { requester: 'self', owner: 'self', participants: ['self'] } }
const audienceOf = ({ run }) => AUDIENCE[run.clientThreadId] ?? null

// ---- the same question builders, at a moment the product's own rules never ask ----
function clockwork() {
  let clock = 1_000_000
  const timers = []
  return { monotonicNow: () => clock, setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    async advance(ms) { const end = clock + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const next = timers[0]; if (!next || next.at > end) break; timers.shift(); clock = next.at; next.fn(); await new Promise(resolve => setImmediate(resolve)) } clock = end } }
}
async function counterfactual({ atMs, question, script }) {
  const c = clockwork(), rec = recorder(), hb = createHeartbeat({ key: 'plan', ...c })
  hb.setJudge(createBeatJudge({ client: rec.client }))
  hb.register('message', { propose: beat => (beat.facts.sinceUserMs === atMs ? question(beat) : null), onVerdict: () => 'none' })
  hb.activate()
  await script({ hb, c, at: async ms => { await c.advance(ms - hb.internalMs()) } })
  await c.advance(atMs - 500 - hb.internalMs()); hb.nudge(); await c.advance(500)
  for (let i = 0; i < 20 && !rec.wires.length; i++) await new Promise(resolve => setImmediate(resolve))
  hb.stop('restart')
  return pick(rec.wires, Math.round(atMs / 1000))
}
const runFlow = ({ sent = 0, kinds = [], stepsAtLast = 0, presence = null, reasoningOpen = false } = {}) => ({ sent: Array.from({ length: sent }, () => ({})), kinds: new Set(kinds), askedNotes: new Set(), stepsAtLast, question: null,
  audience: () => audienceFacts({ audience: null, presence }), reasoningOpen: () => reasoningOpen })
const runQuestion = (flow, options) => beat => flowQuestion(beatFlowFacts({ heartbeatFacts: beat.facts, run: { activities: [], pendingApprovals: [] }, flow, own: new Set() }), options)

/**
 * The patterns, in order. build() → the exact request body (string). expect: registered before any real answer.
 * ifMissed: what a miss would change (wording of the rule or of an option / which options the code offers / the acceptance thresholds).
 */
export const HEARTBEAT_PATTERNS = Object.freeze([
  { id: 'need-quick-3s', path: 'counterfactual', pattern: '3 s after the message, the engine is reasoning, nothing else is known',
    codeRule: 'no message before 10 s (FLOW_LIMITS.firstAfterMs): the product never asks here',
    expect: [hold('hard', 'Control: three seconds in, a judge that does not stay silent cannot be trusted at any later moment.')],
    ifMissed: 'Wording of the judge rule (the do-nothing default is not read as intended); every other result is then read with that in mind. The 10 s code rule stays.',
    build: () => counterfactual({ atMs: 3000, question: runQuestion(runFlow({ reasoningOpen: true }), ['none', 'explain_wait']), script: async ({ hb, at }) => { await at(2000); hb.mark('engine', 'reasoning') } }) },
  { id: 'need-thinking-12s', path: 'counterfactual', pattern: '12 s, the engine has been reasoning the whole time (activity 1 s ago), no tool step',
    codeRule: 'with no tool step a wait message is first possible at 20 s: the product never asks here',
    expect: [hold('soft', 'Reasoning is visibly going on and no step has run: the design waits until 20 s.')],
    ifMissed: 'Nothing in the product (the 20 s rule decides). It would say the model is quicker to speak than the rule, which argues for keeping the rule.',
    build: () => counterfactual({ atMs: 12_000, question: runQuestion(runFlow({ reasoningOpen: true }), ['none', 'explain_wait']), script: async ({ hb, at }) => { for (const ms of [3000, 6000, 9000, 11_000]) { await at(ms); hb.mark('engine', 'reasoning') } } }) },
  { id: 'need-thinking-20s', path: 'runtime', pattern: '20 s, reasoning deltas keep arriving (1 s ago), no tool step: the first moment the product asks in a pure-thinking run',
    expect: [act('explain_wait', 'soft', 'Twenty seconds without a word to the person is twice the attention limit the design rests on.')],
    ifMissed: 'If "none": the first wait message in a thinking-only run comes at the next ask (40 s). Then either the option wording says more plainly that the person has seen nothing yet, or 40 s is accepted. If the kind is right but under 0.75: the threshold for this question.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm'); await w.advance(1000); await reasoning.start(d)
      for (const ms of [4000, 7000, 10_000, 13_000, 16_000, 19_000]) { await w.advance(ms - w.at()); await reasoning.delta(d) }
      await w.advance(20_000 - w.at()); return pick(wires, 20) }) },
  { id: 'need-command-40s', path: 'runtime', pattern: '40 s, a command has been running for 18 s (output 2 s ago), nothing said yet',
    expect: [act('explain_wait', 'hard', 'The case the wait message exists for: a long command, and the person has heard nothing for 40 s.')],
    ifMissed: 'If "none": wording (the rule\'s do-nothing default outweighs a 40 s silence; say what the person has seen so far). If right but under 0.75: thresholds. Options are not at fault here (two offered).',
    build: () => inRuntime({ flags: { held: true, flow: true, commands: true } }, async (w, wires) => { const d = await w.dm('dm'); await w.advance(1000); await reasoning.start(d)
      for (const ms of [5000, 9000, 13_000, 17_000, 19_000]) { await w.advance(ms - w.at()); await reasoning.delta(d) }
      await w.advance(21_000 - w.at()); await reasoning.end(d)
      await w.advance(22_000 - w.at()); await command(d, 'cmd-1', 'inProgress')
      for (const ms of [24_000, 31_000, 38_000]) { await w.advance(ms - w.at()); await d.raw('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'ok\n' }) }
      await w.advance(40_000 - w.at()); return pick(wires, 40) }) },
  { id: 'need-objective-40s', path: 'runtime', pattern: '40 s into a multi-step browser task: 3 steps done, 21 known to remain, nothing said yet, the engine itself silent since the start',
    expect: [act('explain_wait', 'hard', 'A multi-step task that will clearly go on: the person should hear that it is under way.')],
    ifMissed: 'If "none": wording (steps_known_to_remain is a budget, not a plan; the fact name may need to say so, or the option must name long multi-step work). If right but under 0.75: thresholds.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm'); const task = { steps: 0, last: 0 }
      await w.advance(1000); d.hb.register('browser_task', () => browserTaskRow({ active: true, status: 'running', stepsDone: task.steps, stepsRemaining: 24 - task.steps, lastActionAgeMs: w.at() - task.last, idleMs: 0 }))
      for (const ms of [21_000, 29_000, 37_000]) { await w.advance(ms - w.at()); task.steps++; task.last = w.at() }
      await w.advance(40_000 - w.at()); return pick(wires, 40) }) },
  { id: 'need-missing-10s', path: 'runtime', pattern: '10 s, one step done, and the agent\'s last note to itself ends in a question (the note text is not sent)',
    expect: [act('ask_missing', 'hard', 'The early question exists for this: asking now saves the person a wasted wait.')],
    ifMissed: 'If "explain_wait": options (do not offer the wait message while an unasked question is open). If "none": wording of the ask_missing option. If right but under 0.75: thresholds.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm'); await w.advance(4000); await d.tool('s1', 'started'); await w.advance(2000); await d.tool('s1', 'completed')
      await w.advance(1000); await d.note('n1', '어느 환경에 배포할까요?'); await w.advance(3000); return pick(wires, 10) }) },
  { id: 'need-silence-25s', path: 'runtime', pattern: '25 s, nothing at all from the engine for 24 s, no step running, no reasoning item open',
    expect: [anyOf(['stalled', 'explain_wait'], 'hard', 'True silence: the person must be told something (either kind posts the same line when the engine cannot write).'),
      act('stalled', 'soft', 'The kind that names the situation.')],
    ifMissed: 'If "none": wording (the silence line is not read as a problem). If "explain_wait" instead of "stalled": options (offer only the stall kind once the silence bound is passed) — the posted result is the same today. Under 0.75: thresholds.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm'); await w.advance(1000); await d.note('n1', '자료를 확인하는 중입니다.'); await w.advance(24_000); return pick(wires, 25) }) },
  { id: 'need-reasoning-70s', path: 'runtime', pattern: '70 s, a reasoning item has been open for 60 s and nothing has come since, nothing said yet',
    expect: [anyOf(['explain_wait', 'stalled'], 'hard', 'Seventy seconds without a word: the person must be told something, whichever kind.'),
      act('explain_wait', 'soft', 'Reasoning is known to be in progress, so this is a long wait rather than a stall.')],
    ifMissed: 'If "none": wording. If "stalled" where "explain_wait" was expected: options or the 60 s reasoning bound (the fact reasoning_in_progress does not outweigh the silence line). Under 0.75: thresholds.',
    build: () => inRuntime({}, async (w, wires) => { const d = await w.dm('dm'); await w.advance(1000); await d.note('n1', '자료를 확인하는 중입니다.'); await w.advance(9000); await reasoning.start(d); await w.advance(60_000); return pick(wires, 70) }) },
  { id: 'need-just-posted-8s', path: 'counterfactual', pattern: '28 s, a wait message was posted 8 s ago, two more steps finished since',
    codeRule: 'no message within 30 s of the last one (FLOW_LIMITS.minGapMs): the product never asks here',
    expect: [hold('soft', 'Eight seconds after speaking, a progress note is noise.')],
    ifMissed: 'Nothing in the product (the 30 s rule decides). It would say the model alone would speak too often, so the rule stays.',
    build: () => counterfactual({ atMs: 28_000, question: runQuestion(runFlow({ sent: 1, kinds: ['explain_wait'], stepsAtLast: 1 }), ['none', 'milestone']),
      script: async ({ hb, at }) => { let done = 1; hb.setSource(() => ({ stepsDone: done, stepsRunning: 1 })); await at(20_000); hb.mark('engine', 'tool'); hb.mark('posted'); await at(23_000); done = 2; hb.mark('engine', 'tool'); await at(26_000); done = 3; hb.mark('engine', 'tool') } }) },

  { id: 'pointer-owner-elsewhere', path: 'runtime', pattern: 'a member\'s task has ended; its result waits for the owner, some way to the left; the owner is present and has a conversation of their own (the message would go there)',
    expect: [act('pointer', 'hard', 'The pointer exists for this: nothing is moved, so the message is the only way the owner learns of it.')],
    ifMissed: 'If "none": wording of the pointer option or of the rule (the placement runtime has already decided that pointing is right; the question may need to say that only the moment is asked). Under 0.75: thresholds.',
    build: () => inRuntime({ policy: pointerPolicy, audience: audienceOf, presence: { snapshot: () => [SELF, { member: 'm-jin', active: false, lastInputAgeMs: 400_000 }] } }, async (w, wires) => {
      const o = await w.dm('dm-owner', '예산표 정리해 주세요'); await w.advance(3000); await o.final('예산표를 정리했습니다.')
      const m = await w.dm('dm-task', '분기 보고서 초안을 만들어 주세요'); await w.advance(4000); await m.final('보고서 초안을 만들었습니다.')
      await w.advance(2000); placement(m.hb).pointer = { pointerWhere: 'left', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'review' }
      m.hb.nudge(); await w.advance(500); return pick(wires, 7) }) },
  { id: 'pointer-requester-present', path: 'runtime', pattern: 'the run has ended; its result waits for the requester, close by to the right; the requester is present in this conversation',
    expect: [act('pointer', 'hard', 'The requester is waiting right here and nothing was moved into their view.')],
    ifMissed: 'If "none": wording (close by may read as "they will see it anyway"; the option must say the result is outside their view) or the placement side should not raise a pointer for a near result. Under 0.75: thresholds.',
    build: () => inRuntime({ policy: pointerPolicy, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const d = await w.dm('dm'); await w.advance(4000); await d.final('조사를 마쳤습니다.')
      await w.advance(6000); placement(d.hb).pointer = { pointerWhere: 'right', pointerDistance: 'near', pointerFor: 'requester', pointerNeeds: 'review' }
      d.hb.nudge(); await w.advance(500); return pick(wires, 11) }) },
  { id: 'pointer-in-view', path: 'runtime', pattern: 'the run has ended; its result waits for the requester and is already inside what they are looking at',
    expect: [hold('soft', 'It is in front of them: a message telling them where it is adds nothing.')],
    ifMissed: 'Options or the placement side: a fact for something in view should not be offered as a pointer at all (a code rule), rather than left to the judge.',
    build: () => inRuntime({ policy: pointerPolicy, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const d = await w.dm('dm'); await w.advance(4000); await d.final('조사를 마쳤습니다.')
      await w.advance(6000); placement(d.hb).pointer = { pointerWhere: 'none', pointerDistance: 'in_view', pointerFor: 'requester', pointerNeeds: 'review' }
      d.hb.nudge(); await w.advance(500); return pick(wires, 11) }) },
  { id: 'pointer-nobody-waiting', path: 'counterfactual', pattern: 'the run has ended; a result waits for the owner, far to the right; nobody is present',
    codeRule: 'no route for a person who is away (pointerRoute): the product never asks here, it holds the fact for later',
    expect: [hold('soft', 'Nobody is there to read it.')],
    ifMissed: 'Nothing in the product (the route rule decides). It would say presence must stay a code rule and not be left to the judge.',
    build: () => counterfactual({ atMs: 27_000, script: async ({ hb, at }) => { await at(6000); hb.settle(); hb.register('work_placement', () => ({ placementsPending: 0, placementsDecided: 1, pointerPending: true, pointerWhere: 'right', pointerDistance: 'very_far', pointerFor: 'owner', pointerNeeds: 'review' })) },
      question: beat => { const facts = idleFlowFacts({ heartbeatFacts: beat.facts, audience: audienceFacts({ audience: null, presence: [{ member: 'self', self: true, active: false, lastInputAgeMs: 900_000 }] }),
        pointer: { attention: attentionOf(beat.facts), pointed: false, pointers: 0, pointerTarget: 'here' } }); return flowQuestion(facts, enumerateOptions(facts)) } }) },
  { id: 'pointer-new-run', path: 'runtime', pattern: 'a result of the previous run waits for the owner below, close by; the owner has just started a new run in the same conversation (5 s in)',
    expect: [act('pointer', 'soft', 'They are here and writing; telling them now costs one line.')],
    ifMissed: 'Nothing breaks: the fact stays pending and is asked again at later beats and after the run. If the model consistently waits, the pointer could be offered only once the run has gone on for a while (options).',
    build: () => inRuntime({ policy: pointerPolicy, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const first = await w.dm('dm', '자료 조사해 주세요'); await w.advance(4000); await first.final('조사를 마쳤습니다.')
      placement(first.hb).pointer = { pointerWhere: 'below', pointerDistance: 'near', pointerFor: 'owner', pointerNeeds: 'review' }
      await w.advance(2000); await w.dm('dm', '이어서 요약해 주세요', { requestId: 'req-2', conversationId: first.r.conversationId })
      await w.advance(5000); return pick(wires, 5) }) },
  { id: 'pointer-held-3min', path: 'runtime', pattern: 'a result has waited 3 minutes for the owner, who had no conversation open; they have just started a run in their own conversation (5 s in); the direction is no longer known',
    expect: [act('pointer', 'soft', 'It is the first chance to tell them, and three minutes is recent.')],
    ifMissed: 'The fallback then rarely delivers: either the question says that this is the first chance to tell the person, or the held fact is offered after the run instead of during it (options). The 15 minute bound is not at issue at 3 minutes.',
    build: () => inRuntime({ policy: { message: () => 'none' }, audience: audienceOf, presence: { snapshot: () => [SELF] } }, async (w, wires) => {
      const m = await w.dm('dm-task', '분기 보고서 초안을 만들어 주세요'); await w.advance(4000); await m.final('보고서 초안을 만들었습니다.')
      placement(m.hb).pointer = { pointerWhere: 'left', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'review' }
      m.hb.nudge(); await w.advance(500); await w.advance(179_500)
      await w.dm('dm-owner', '예산표 정리해 주세요'); await w.advance(5000); return pick(wires, 5) }) },
])

/** Builds every request offline. Returns { set, tokenCeiling, passRule, requests: [{ id, file, sha256, estInputTokens, expect, body, bytes, path, pattern, codeRule?, ifMissed }] }. */
export async function buildHeartbeatPlan({ only = null } = {}) {
  const requests = []
  for (const p of HEARTBEAT_PATTERNS) {
    if (only && !only.includes(p.id)) continue
    const body = await p.build()
    requests.push({ id: p.id, file: `requests/${p.id}.json`, sha256: sha(body), estInputTokens: estimateInputTokens(body), expect: p.expect, body, bytes: Buffer.byteLength(body), path: p.path, pattern: p.pattern,
      ...(p.codeRule ? { codeRule: p.codeRule } : {}), ifMissed: p.ifMissed })
  }
  const total = requests.reduce((n, r) => n + r.estInputTokens, 0)
  // The estimate leans high (utf8 bytes / 3); a quarter on top is the stop line for the runner.
  return { set: HEARTBEAT_PLAN_SET, tokenCeiling: Math.ceil(total * 1.25), passRule: HEARTBEAT_PLAN_PASS_RULE, requests }
}

/** The plan file, exactly in the runner's format (no other keys). */
export function planFile(plan) {
  return { set: plan.set, tokenCeiling: plan.tokenCeiling, passRule: plan.passRule,
    requests: plan.requests.map(({ id, file, sha256, estInputTokens, expect }) => ({ id, file, sha256, estInputTokens, expect })) }
}
