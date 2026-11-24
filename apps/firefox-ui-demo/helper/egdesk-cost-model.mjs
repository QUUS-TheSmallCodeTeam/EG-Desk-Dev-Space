// Per-feature cost model (lane L6 c20; analysis only, nothing here is read by the product). For each flag that makes Decisions requests: which
// requests it causes, what they cost (input tokens, request time) per occurrence and per turn on a recorded journey and on the family plans, and
// how long the code lets it make something wait. The wait bounds are IMPORTED from the modules that enforce them, so a changed bound changes
// this table (and the test that pins the table to the code).
// What is measured and what is not: tokens and request times are the recorded ones. "Added latency" is not a wall-clock difference between the
// same turn with and without the flag (no run measured that); it is the bound the code puts on the wait, next to the measured request times.
import { TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS } from './codex-chat-runtime.mjs'
import { FOREGROUND_DECISION_TIMEOUT_MS } from './egdesk-decision-client.mjs'
import { CONTENT_FREE_REQUESTS } from './egdesk-decision-egress.mjs'
import { FLOW_LIMITS } from './egdesk-conversation-flow.mjs'
import { DRAFT_CHECK_LIMITS } from './egdesk-draft-check.mjs'
import { HEARTBEAT_LIMITS } from './egdesk-heartbeat.mjs'
import { CONFIRM_LIMITS } from './egdesk-record-confirmation.mjs'
import { COMMAND_GATE_TIMEOUT_MS } from './egdesk-terminal-command-gate.mjs'
import { TERMINAL_JUDGE_TIMEOUT_MS } from './egdesk-terminal-judge.mjs'
import { WARMUP_IDLE_MS } from './egdesk-decision-warmup.mjs'
import { WORK_PLACEMENT_LIMITS } from './egdesk-work-placement.mjs'
import { WM_JUDGE_MIN_TOKENS } from './egdesk-working-memory-wiring.mjs'
import { HUD_ROUTING_LIMITS } from '../overlay/resources/EGDeskHudRouting.sys.mjs'
import { WORK_PLACEMENT_WAIT_MS } from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'

const s = ms => (ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms.toLocaleString('en-US')} ms`)
const ms = n => `${n.toLocaleString('en-US')} ms`
const TRIAGE_REQUEST_MS = 2000 // helper/egdesk-turn-memory.mjs triageTurn default timeoutMs (a default argument, not exported)

/** Classes of added wait: blocks (a person waits), path (on a task or command path), card (a surface waits), after (after the answer), none. */
export const COST_FEATURES = Object.freeze([
  { id: 'decisionContext', flag: 'decisionContext (Decisions mode advisory|on): turn_context', families: ['turn_context'], sets: [], unit: 'turn',
    latency: { cls: 'blocks', text: `blocks the turn start, bounded: ${ms(TURN_CONTEXT_BUDGET_MS)} warm / ${ms(TURN_CONTEXT_COLD_BUDGET_MS)} cold (the first turn of a conversation, or no warm socket); the turn goes on without the context at the bound`,
      boundsMs: { warm: TURN_CONTEXT_BUDGET_MS, cold: TURN_CONTEXT_COLD_BUDGET_MS }, at: 'helper/codex-chat-runtime.mjs TURN_CONTEXT_BUDGET_MS, prepareDecisionContext' } },
  { id: 'turnMemory', flag: 'turnMemory (triage and page scan; PRUNE_HELD, KEEP_LATE, SPLIT_WORDING, PREVIOUS_REPLY and CONTEXT_RELEVANCE=action change what is asked, not whether)', families: ['memory_triage', 'memory_fetch'],
    sets: ['memory-action-v2', 'previous-reply-v1', 'terse-record-v1', 'split-wording-v2', 'write-target-about-v1', 'mid-scan-previous-reply-v1'], unit: 'turn',
    latency: { cls: 'blocks', text: `inside the same budgeted window as turn_context (collect runs inside the raced work): the same ${ms(TURN_CONTEXT_BUDGET_MS)} / ${ms(TURN_CONTEXT_COLD_BUDGET_MS)} bound; triage has its own ${ms(TRIAGE_REQUEST_MS)} request limit`,
      boundsMs: { warm: TURN_CONTEXT_BUDGET_MS, cold: TURN_CONTEXT_COLD_BUDGET_MS, triage: TRIAGE_REQUEST_MS }, at: 'helper/codex-chat-runtime.mjs prepareDecisionContext (setup.collect inside work); helper/egdesk-turn-memory.mjs triageTurn' } },
  { id: 'turnMemoryWrite', flag: 'turnMemory write (judged after the answer completed)', families: ['memory_write'], sets: [], unit: 'turn that writes',
    latency: { cls: 'after', text: 'after the answer, off the turn path (run once its answer completed)', boundsMs: {}, at: 'helper/codex-chat-runtime.mjs turnMemoryWrites' } },
  { id: 'confirm', flag: 'EGDESK_TURN_MEMORY_CONFIRM', families: [], sets: ['record-confirmation-predicates-v1'], unit: 'turn after an answer that offered a record',
    latency: { cls: 'blocks', text: `on the turn path, bounded: ${ms(CONFIRM_LIMITS.timeoutMs)} (and the turn memory deadline)`, boundsMs: { request: CONFIRM_LIMITS.timeoutMs }, at: 'helper/egdesk-record-confirmation.mjs CONFIRM_LIMITS; helper/codex-chat-runtime.mjs memorySettleBefore' } },
  { id: 'draftCheck', flag: 'EGDESK_DRAFT_CHECK', families: ['draft_check'], sets: ['draft-overcorrection-v1'], unit: 'answer',
    latency: { cls: 'blocks', text: `advisory: after posting, no wait. on: holds the answer before posting: first check up to ${ms(DRAFT_CHECK_LIMITS.firstCheckMs)}, a re-check up to ${ms(DRAFT_CHECK_LIMITS.recheckMs)}, and a revision by the subjective model within a ${s(DRAFT_CHECK_LIMITS.holdMs)} hold`,
      boundsMs: { first: DRAFT_CHECK_LIMITS.firstCheckMs, recheck: DRAFT_CHECK_LIMITS.recheckMs, hold: DRAFT_CHECK_LIMITS.holdMs }, at: 'helper/egdesk-draft-check.mjs DRAFT_CHECK_LIMITS' } },
  { id: 'conversationFlow', flag: 'EGDESK_CONVERSATION_FLOW (+ EGDESK_INRUN_MESSAGES)', families: ['heartbeat'], sets: ['heartbeat-c18', 'heartbeat-c19', 'conversation-scenarios-001', 'conversation-scenarios-002'], unit: 'beat the judge is asked about / in-run message',
    latency: { cls: 'none', text: `concurrent with the run; none on the run. A beat every ${s(HEARTBEAT_LIMITS.beatMs)} while a run works; a first message not before ${s(FLOW_LIMITS.firstAfterMs)}, at least ${s(FLOW_LIMITS.minGapMs)} apart, at most ${FLOW_LIMITS.maxMessages} per run; each message also costs a short fork turn of the subjective model (not a Decisions request)`,
      boundsMs: { beat: HEARTBEAT_LIMITS.beatMs, first: FLOW_LIMITS.firstAfterMs, gap: FLOW_LIMITS.minGapMs }, at: 'helper/egdesk-heartbeat.mjs HEARTBEAT_LIMITS; helper/egdesk-conversation-flow.mjs FLOW_LIMITS' } },
  { id: 'workPlacement', flag: 'EGDESK_WORK_PLACEMENT', families: ['work_placement'], sets: ['work-placement-predicates-v2', 'l1-remeasure-c13'], unit: 'finished result',
    latency: { cls: 'card', text: `a result card waits for the placement, bounded: ${ms(WORK_PLACEMENT_WAIT_MS)} in the window; ${ms(WORK_PLACEMENT_LIMITS.decisionMs)} per request; at most ${WORK_PLACEMENT_LIMITS.maxEvals} requests per conversation heartbeat`,
      boundsMs: { wait: WORK_PLACEMENT_WAIT_MS, request: WORK_PLACEMENT_LIMITS.decisionMs }, at: 'overlay/resources/EGDeskWorkPlacement.sys.mjs WORK_PLACEMENT_WAIT_MS; helper/egdesk-work-placement.mjs WORK_PLACEMENT_LIMITS' } },
  { id: 'briefing', flag: 'EGDESK_BRIEFING_FLOW', families: ['briefing'], sets: ['l4-briefing-real-requests-replay', 'l4-briefing-same-window', 'l4-briefing-real-material-stability'], unit: 'briefing (one answer)',
    latency: { cls: 'after', text: `after the answer, off the answer path (the briefing card appears later); each stage request up to ${ms(FOREGROUND_DECISION_TIMEOUT_MS)}, five stages in sequence on the journey`,
      boundsMs: { request: FOREGROUND_DECISION_TIMEOUT_MS }, at: 'helper/egdesk-board-presentation-http.mjs; helper/egdesk-decision-client.mjs FOREGROUND_DECISION_TIMEOUT_MS' } },
  { id: 'browserEntry', flag: 'EGDESK_BROWSER_ENTRY (entry, step, resume)', families: ['browser_entry', 'browser_step', 'browser_resume'], sets: ['browser-task-v1'], unit: 'browser task (entry + each step)',
    latency: { cls: 'path', text: `on the task path: every step waits for its decision, up to ${ms(FOREGROUND_DECISION_TIMEOUT_MS)} per request`, boundsMs: { request: FOREGROUND_DECISION_TIMEOUT_MS }, at: 'helper/egdesk-browser-task.mjs; helper/egdesk-decision-client.mjs FOREGROUND_DECISION_TIMEOUT_MS' } },
  { id: 'commandJudge', flag: 'EGDESK_COMMAND_JUDGE / EGDESK_TERMINAL_JUDGE', families: ['command_judge'], sets: ['command-judgments-v1'], unit: 'judged terminal state',
    latency: { cls: 'none', text: `observes a running command; advisory records only; ${ms(TERMINAL_JUDGE_TIMEOUT_MS)} per request`, boundsMs: { request: TERMINAL_JUDGE_TIMEOUT_MS }, at: 'helper/egdesk-terminal-judge.mjs TERMINAL_JUDGE_TIMEOUT_MS' } },
  { id: 'terminalGate', flag: 'EGDESK_TERMINAL_GATE', families: [], sets: ['command-risk-v2'], unit: 'command',
    latency: { cls: 'path', text: `on the command path (assessCommand awaits its request in advisory and in on): up to ${ms(COMMAND_GATE_TIMEOUT_MS)}, then the fallback (ask the person)`, boundsMs: { request: COMMAND_GATE_TIMEOUT_MS }, at: 'helper/egdesk-terminal-command-gate.mjs COMMAND_GATE_TIMEOUT_MS, assessCommand' } },
  { id: 'workingMemory', flag: 'EGDESK_WORKING_MEMORY (advisory judge)', families: [], sets: ['working-memory-judge-v1'], unit: `tool output of ${WM_JUDGE_MIN_TOKENS.toLocaleString('en-US')} tokens or more`,
    latency: { cls: 'none', text: 'never awaited by the tool result; it only writes a calibration record', boundsMs: {}, at: 'helper/egdesk-working-memory-wiring.mjs (advisory judge, never awaited)' } },
  { id: 'hudRouting', flag: 'EGDESK_HUD_ROUTING (pref egdesk.hudRouting)', families: [], sets: ['hud-routing-v1'], unit: `typed query after a ${HUD_ROUTING_LIMITS.debounceMs} ms pause`,
    latency: { cls: 'none', text: `moves a highlight only; nothing waits: an answer later than ${ms(HUD_ROUTING_LIMITS.waitMs)} is dropped, Enter guard ${ms(HUD_ROUTING_LIMITS.enterGuardMs)}`, boundsMs: { wait: HUD_ROUTING_LIMITS.waitMs }, at: 'overlay/resources/EGDeskHudRouting.sys.mjs HUD_ROUTING_LIMITS' } },
  { id: 'runConditions', flag: 'run conditions (command executor, no flag)', families: [], sets: ['run-conditions-v1'], unit: 'command output tail with no test-runner summary',
    latency: { cls: 'after', text: 'after a command ends; a model can only lower health to unknown', boundsMs: {}, at: 'helper/egdesk-run-conditions.mjs' } },
])

const median = a => { const x = a.filter(Number.isFinite).sort((p, q) => p - q); return x.length ? x[Math.floor((x.length - 1) / 2)] : null }
const range = a => { const x = a.filter(Number.isFinite); return x.length ? [Math.min(...x), Math.max(...x)] : null }
const round2 = n => Math.round(n * 100) / 100

/** Where in a turn a request family sits (the classes follow the latency facts above). */
export const TURN_CLASSES = Object.freeze({ pre: ['turn_context', 'memory_triage', 'memory_fetch'], post: ['draft_check', 'memory_write', 'briefing', 'work_placement'], run: ['heartbeat', 'command_judge'], browser: ['browser_entry', 'browser_step', 'browser_resume'] })
export const classOf = family => Object.entries(TURN_CLASSES).find(([, list]) => list.includes(family))?.[0] ?? 'other'
/** The order a person would turn flags on, for the cumulative per-turn cost (journey figures). */
export const CUMULATIVE_ORDER = Object.freeze([['decisionContext', ['turn_context']], ['+ turnMemory', ['memory_triage', 'memory_fetch']], ['+ memory write', ['memory_write']], ['+ DRAFT_CHECK', ['draft_check']],
  ['+ CONVERSATION_FLOW', ['heartbeat']], ['+ WORK_PLACEMENT', ['work_placement']], ['+ BRIEFING_FLOW', ['briefing']], ['+ BROWSER_ENTRY', ['browser_entry', 'browser_step', 'browser_resume']], ['+ COMMAND_JUDGE', ['command_judge']]])

/**
 * buildCostModel({ journey, requests }) -> { turns, inRun, journeyTotal, flags, cumulative, steps, warmup }
 *   journey: a journey result file ({ steps: [{ id, title, sends, requests: [{ family, usage, elapsedMs, questions }] }] }), one run
 *   requests: evidence rows' requests ([{ src: 'runner', set, tokens, elapsedMs, questions, first, repeat }]), the family plans
 * Pure; reads no file and sends nothing.
 */
export function buildCostModel({ journey, requests = [] }) {
  const sends = journey.steps.flatMap(step => step.sends || [])
  const turns = sends.filter(x => x.inRun === false).length, inRun = sends.filter(x => x.inRun === true).length
  if (!(turns > 0)) throw new RangeError('the journey has no turn')
  const jreq = journey.steps.flatMap(step => (step.requests || []).map(r => ({ step: step.id, family: r.family, tokens: r.usage?.input_tokens ?? null, ms: r.elapsedMs, q: Array.isArray(r.questions) ? r.questions.length : r.questions })))
  const plans = requests.filter(r => r.src === 'runner' && !r.repeat)
  const tokensOf = list => list.reduce((t, r) => t + (r.tokens ?? 0), 0)
  const flags = COST_FEATURES.map(feature => {
    const jr = jreq.filter(r => feature.families.includes(r.family)), pl = plans.filter(r => feature.sets.includes(r.set))
    return { id: feature.id, flag: feature.flag, unit: feature.unit, latency: feature.latency,
      journey: jr.length ? { requests: jr.length, perTurn: round2(jr.length / turns), tokens: tokensOf(jr), tokensPerTurn: Math.round(tokensOf(jr) / turns),
        perRequest: { tokensMedian: median(jr.map(r => r.tokens)), tokensRange: range(jr.map(r => r.tokens)), msMedian: median(jr.map(r => r.ms)), msRange: range(jr.map(r => r.ms)), questionsMedian: median(jr.map(r => r.q)) }, steps: [...new Set(jr.map(r => r.step))] } : null,
      plans: pl.length ? { sets: [...new Set(pl.map(r => r.set))], requests: pl.length, perRequest: { tokensMedian: median(pl.map(r => r.tokens)), tokensRange: range(pl.map(r => r.tokens)),
        msWarmMedian: median(pl.filter(r => !r.first).map(r => r.elapsedMs)), msFirstMedian: median(pl.filter(r => r.first).map(r => r.elapsedMs)), questionsMedian: median(pl.map(r => r.questions)) } } : null }
  })
  let families = []
  const cumulative = CUMULATIVE_ORDER.map(([label, add]) => {
    families = families.concat(add)
    const jr = jreq.filter(r => families.includes(r.family))
    return { label, requests: jr.length, requestsPerTurn: round2(jr.length / turns), tokens: tokensOf(jr), tokensPerTurn: Math.round(tokensOf(jr) / turns) }
  })
  const steps = journey.steps.filter(step => (step.requests || []).length).map(step => {
    const row = { step: step.id, title: step.title, userSend: (step.sends || []).map(x => (x.inRun ? 'in-run' : 'turn')).join('+') || '-' }
    for (const c of Object.keys(TURN_CLASSES)) {
      const list = (step.requests || []).filter(r => classOf(r.family) === c)
      row[c] = { requests: list.length, tokens: list.reduce((t, r) => t + (r.usage?.input_tokens ?? 0), 0), msMax: list.length ? Math.max(...list.map(r => r.elapsedMs)) : null, msSum: list.length ? list.reduce((t, r) => t + r.elapsedMs, 0) : null }
    }
    return row
  })
  const total = { requests: jreq.length, tokens: tokensOf(jreq) }
  return { turns, inRun, journeyTotal: { ...total, perTurnRequests: round2(total.requests / turns), perTurnTokens: Math.round(total.tokens / turns) }, flags, cumulative, steps,
    warmup: { idleMinutes: WARMUP_IDLE_MS / 60_000, perIdlePeriod: { requests: 1, bodyBytes: Buffer.byteLength(JSON.stringify({ input: CONTENT_FREE_REQUESTS.warmup.input, questions: CONTENT_FREE_REQUESTS.warmup.questions })) } } }
}
