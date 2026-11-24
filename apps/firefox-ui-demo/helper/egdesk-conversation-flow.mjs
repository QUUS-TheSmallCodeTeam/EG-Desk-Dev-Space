
// Human-like intermediate messages while a run is still working. The system decides, from runtime facts only, whether to say
// something now; the subjective model writes the short message; the message is posted as a completed chat message and the run
// continues. Reasoning is never exposed: the Decision request carries numbers and closed labels, never work-note text.
//
// Options exist at runtime: enumerateOptions(facts) lists only what is possible right now, and with nothing but 'none' possible
// there is no Decision request at all.
//
// Time comes from the session heartbeat (egdesk-heartbeat.mjs): at each beat the runtime builds the facts below from the
// heartbeat's internal counter (time since the person wrote, since the last posted message, since the last engine event,
// the current phase) and the run's own state, and this module answers "is an intermediate message needed NOW?".

export const FLOW_LIMITS = Object.freeze({
  // Nielsen: about 10 s is how long a person stays focused on a wait without feedback; a first message earlier would interrupt
  // answers that are about to arrive, later leaves the person waiting in silence.
  firstAfterMs: 10_000,
  // At most one intermediate message every 30 s: a chat partner who talks more often than twice a minute while working is noise,
  // and each message costs a Decision request and a short fork turn.
  minGapMs: 30_000,
  // Three per run: a wait explanation, an early question and one milestone. More than that is a report, not a conversation.
  maxMessages: 3,
  // Pointer messages (a finished result or a pending decision waits somewhere for a person): one per attention fact, two per window.
  maxPointers: 2,
  // A pointer that had nowhere to go (the person has no live conversation of their own, or is away) is held for that person and
  // offered in the next run of a conversation that is theirs alone. Kept for 15 minutes, the same bound after which a session
  // without its person is given up (HEARTBEAT_LIMITS.idleStopMs); at most 8 at a time, one per source fact. The held fact keeps who
  // and what, never where: a direction is relative to what the person was looking at then.
  heldAttentionMs: 900_000, maxHeldAttention: 8,
  // Decision requests: at most one per 10 s (two beats) unless a kind became possible that was never offered in this run, and six
  // per run. A request is one small choice: 0.25-0.6 s warm, about 1.3-1.6 s after a long idle, so six cost at most a few seconds.
  evalGapMs: 10_000, maxEvals: 6,
  // The request's own deadline: above the cold case (1.6 s) and well under one beat (5 s), so judgments never pile up.
  decisionMs: 2_000,
  writerMs: 20_000, maxChars: 280,
  milestoneSteps: 2,
  // No engine or tool event for 20 s: two attention limits (2 x 10 s) and four beats. It is a judgement, not a measurement of real
  // engine gaps; each asked beat records the silence in the calibration log so the bound can be corrected from real runs.
  stallAfterMs: 20_000,
  // While a reasoning item is open the engine is known to be thinking, and a model that does not stream its reasoning sends nothing
  // until it is done: silence then needs three times as long before it counts (a judgement; see the c12 report for what the
  // protocol documents and what could not be confirmed).
  stallReasoningMs: 60_000,
  // A run with no tool step whose engine is visibly active (something within the stall bound): no progress note before 30 s.
  // Measured 2026-11-24 on the same thinking-only material at 3 / 12 / 20 s: yes 0.35 / 0.45 / 0.62. Nothing in the material but
  // the number changed, so the answer was reading the clock: when to start is arithmetic and belongs here (R3). The first such ask
  // now comes at 30 s; a silent engine still gets the earlier stall path, and a run with a tool step still starts at 10 s.
  thinkingNoteMs: 30_000,
  // A stalled engine probably cannot write either: the writer gets 6 s (three times a cold Decision call), then the fixed line is used.
  stalledWriterMs: 6_000,
})

// Fixed line used only when the engine looks stalled and the subjective model could not write the message (copy pending approval).
export const FLOW_COPY = Object.freeze({
  stalled: '응답이 평소보다 오래 걸리고 있습니다. 더 기다리거나, 중지하고 다시 요청할 수 있습니다.',
})

export const FLOW_KINDS = Object.freeze([
  { value: 'none', description: 'Say nothing now; keep working.' },
  { value: 'explain_wait', description: 'Tell the person this takes a while and why, in one or two sentences.' },
  { value: 'ask_missing', description: 'Ask the person for information the work needs, then keep working on the rest.' },
  { value: 'milestone', description: 'Say what part is done so far, briefly, without giving results.' },
  { value: 'stalled', description: 'Nothing has come from the work for a while: tell the person the response is taking unusually long.' },
  { value: 'pointer', description: 'A finished result or a pending decision is waiting somewhere on the desk for a person: tell that person where it is. Nothing is moved.' },
])

// ---- What is being waited on, and what needs someone's attention: closed labels read from the heartbeat's provider facts ----
// The message judgment and the writer are told WHAT, never any text of a page, a terminal or a file. A provider can say it
// directly (facts { waitingOn: <label of WAIT_LABELS>, waitingOnMs? }) or be read from the fields it already reports.
export const WAIT_LABELS = Object.freeze({
  command_waiting_input: 'a command is waiting for input',
  browser_task_waiting_person: 'the task in the browser is waiting for the person',
  browser_task_preparing_question: 'a question to the person about the task in the browser is being prepared',
  command_running: 'a command is still running',
  browser_task_running: 'a task in the browser is still going',
  objective_step: 'an automatic step is still going',
  placement_pending: 'a work surface is being placed',
  tool_running: 'a tool step is still running',
})

/** Up to three things the session is waiting on right now: [{ what, seconds }] with `what` a WAIT_LABELS key. */
export function waitSummary(heartbeatFacts) {
  const found = new Map()
  const add = (what, ms) => { if (Object.hasOwn(WAIT_LABELS, what) && !found.has(what)) found.set(what, Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null) }
  for (const row of Object.values(heartbeatFacts?.sources ?? {})) {
    if (typeof row.waitingOn === 'string') add(row.waitingOn, row.waitingOnMs)
    if (row.terminal === 'waiting') add('command_waiting_input', row.quietMs)
    else if (row.terminal === 'running' || (row.phase === 'tool_running' && Number.isFinite(row.runningMs))) add('command_running', row.runningMs)
    // The browser task's row (egdesk-heartbeat-providers.mjs browserTaskRow): waiting_user | handing_off | running.
    if (row.task === 'waiting_user' || row.task === 'need_context' || row.task === 'cannot_proceed') add('browser_task_waiting_person', null)
    else if (row.task === 'handing_off') add('browser_task_preparing_question', null)
    else if (row.task === 'running') add('browser_task_running', null)
    if (Number.isSafeInteger(row.placementsPending) && row.placementsPending > 0) add('placement_pending', null)
  }
  if (!found.size && heartbeatFacts?.phase === 'objective_step') add('objective_step', null)
  if (!found.size && heartbeatFacts?.stepsRunning > 0) add('tool_running', null)
  return Object.keys(WAIT_LABELS).filter(what => found.has(what)).slice(0, 3).map(what => ({ what, seconds: found.get(what) }))
}

const ATTENTION_KINDS = ['result', 'approval', 'question'], ATTENTION_FOR = ['owner', 'requester']
const ATTENTION_WHERE = ['in_view', 'left', 'right', 'above', 'below', 'none'], ATTENTION_DISTANCE = ['in_view', 'near', 'far', 'very_far']
/**
 * A provider's "attention" fact: something finished or pending that a person must act on, somewhere on the desk.
 *   facts { attention: 'result'|'approval'|'question', attentionFor: 'owner'|'requester', attentionWhere?: region label, attentionDistance? }
 * The placement runtime's present field names are read as the same fact (pointerPending / pointerFor / pointerWhere /
 * pointerDistance / pointerNeeds). Returns the first pending one as closed labels, or null.
 */
export function attentionOf(heartbeatFacts) {
  for (const [provider, row] of Object.entries(heartbeatFacts?.sources ?? {})) {
    let kind = row.attention, who = row.attentionFor, where = row.attentionWhere, distance = row.attentionDistance
    if (kind === undefined && row.pointerPending === true) { kind = row.pointerNeeds === 'owner_action' ? 'approval' : 'result'; who = row.pointerFor; where = row.pointerWhere; distance = row.pointerDistance }
    if (!ATTENTION_KINDS.includes(kind) || !ATTENTION_FOR.includes(who)) continue
    // The placement runtime says 'none' for the direction of something already in view and puts 'in_view' in the distance: one meaning here.
    if (distance === 'in_view') where = 'in_view'
    const place = ATTENTION_WHERE.includes(where) ? where : 'none'
    // located: the provider reports a real surface off the person's view (a direction), not just that something exists.
    return { provider, kind, who, where: place, distance: ATTENTION_DISTANCE.includes(distance) ? distance : null, located: ['left', 'right', 'above', 'below'].includes(place), signature: `${provider}:${kind}:${who}` }
  }
  return null
}

/**
 * The message question's facts for a session whose run has ended (idle tempo): nothing of a run is offered, only a pointer.
 * heartbeatFacts: the beat's facts; audience: audienceFacts(...) of the conversation; pointer: { attention, pointed, pointers, pointerTarget }.
 */
export function idleFlowFacts({ heartbeatFacts, audience = null, pointer = {} }) {
  return { idle: true, sent: 0, stepsSinceLast: 0, question: null, waitExplained: false, pendingQuestion: heartbeatFacts.pendingQuestion === true, reasoningOpen: false, blocked: true,
    elapsedMs: heartbeatFacts.sinceUserMs, sinceLastMs: heartbeatFacts.sincePostedMs, audience, waits: [], ...pointer }
}

/**
 * Where a pointer message for `person` ('owner' | 'requester' of the task) may go, under the audience rule. Member ids stay inside.
 *   'here'  the task's own conversation, when that person takes part in it and nobody but the requester and the owner does
 *   a key   another live conversation whose only participant is that person (their own conversation)
 *   null    nowhere (the person is away, or no such conversation): nothing is posted
 */
export function pointerRoute({ person, audience = null, presence = null, others = [] } = {}) {
  const ids = a => { const requester = String(a?.requester ?? 'self'), owner = String(a?.owner ?? requester); return { requester, owner, participants: Array.isArray(a?.participants) ? a.participants.map(String) : [requester] } }
  const here = ids(audience)
  const who = person === 'owner' ? here.owner : person === 'requester' ? here.requester : null
  if (who === null) return { target: null, reason: 'no_person' }
  const rows = Array.isArray(presence) ? presence : null
  const present = rows ? rows.some(row => row !== null && typeof row === 'object' && (String(row.member) === who || (who === 'self' && row.self === true)) && row.active === true) : null
  if (present === false) return { target: null, reason: 'away' }
  if (here.participants.includes(who) && here.participants.every(member => member === here.requester || member === here.owner)) return { target: 'here', present }
  for (const other of Array.isArray(others) ? others : []) {
    const there = ids(other?.audience)
    if (typeof other?.key === 'string' && there.participants.length && there.participants.every(member => member === who)) return { target: other.key, present }
  }
  return { target: null, reason: 'no_conversation' }
}

/**
 * Who is waiting for this task, and may a message go into this conversation. Pure: from the task's audience and a presence snapshot.
 *   audience: { requester, owner, participants } member ids (default: the local person asked in their own DM, all 'self')
 *   presence: the presence feed's snapshot() rows [{ member, self, active, viewport, focusCard, lastInputAgeMs }], or null when
 *     there is no feed (then, as before, the requester is taken to be waiting and presence is unknown)
 * waiting: 'requester' (present) | 'owner' (the requester is away, the owner of the task is present) | 'nobody'.
 * postable: only when the waiting person takes part in this conversation and every participant is the requester or the owner.
 * Member ids never leave this function: the facts are closed labels and numbers.
 */
export function audienceFacts({ audience = null, presence = null } = {}) {
  const a = audience !== null && typeof audience === 'object' ? audience : {}
  const requester = String(a.requester ?? 'self'), owner = String(a.owner ?? requester)
  const participants = Array.isArray(a.participants) ? a.participants.map(String) : [requester]
  const rows = Array.isArray(presence) ? presence : null
  const find = id => rows?.find(row => row !== null && typeof row === 'object' && (String(row.member) === id || (id === 'self' && row.self === true))) ?? null
  const present = id => find(id)?.active === true
  let waiting = 'nobody', who = null
  if (!rows || present(requester)) { waiting = 'requester'; who = requester }
  else if (owner !== requester && present(owner)) { waiting = 'owner'; who = owner }
  const outsiders = participants.filter(member => member !== requester && member !== owner).length
  const inConversation = who !== null && participants.includes(who)
  const idle = who === null ? null : find(who)?.lastInputAgeMs
  return { waiting, addressee: who === null ? 'none' : waiting, addresseePresent: rows ? who !== null : null, addresseeIdleMs: Number.isFinite(idle) && idle >= 0 ? idle : null,
    addresseeInConversation: inConversation, outsiders, postable: outsiders === 0 && inConversation }
}

/**
 * Facts at one heartbeat: time and phase from the heartbeat's internal counter, the rest from the run and the flow state.
 * heartbeatFacts: the frozen object of heartbeat.facts() ({ sinceUserMs, sincePostedMs, sinceEngineMs, phase, stepsRemaining, ... }).
 */
export function beatFlowFacts({ heartbeatFacts, run, flow, own }) {
  const base = flowFacts({ run, now: 0, flow: { ...flow, startedAt: 0, lastSentAt: null }, own })
  const hb = heartbeatFacts
  // Steps include what registered objective loops report, not only the run's own tool activities.
  return { ...base, stepsDone: hb.stepsDone, stepsActive: hb.stepsRunning, stepsSinceLast: hb.stepsDone - flow.stepsAtLast,
    elapsedMs: hb.sinceUserMs, sinceLastMs: hb.sincePostedMs, sinceEngineMs: hb.sinceEngineMs, phase: hb.phase,
    stepsRemaining: hb.stepsRemaining ?? null, pendingQuestion: hb.pendingQuestion === true || flow.question?.pending === true,
    reasoningOpen: flow.reasoningOpen?.() === true, audience: flow.audience?.() ?? null,
    waits: waitSummary(hb), attention: attentionOf(hb),
    stalledNoted: flow.kinds.has('stalled'), blocked: base.blocked || hb.phase === 'waiting_user' }
}

/** Facts from the run's real state. No text of any work note or message. */
export function flowFacts({ run, now, flow, own }) {
  const tools = (run.activities || []).filter(a => !own.has(a.kind))
  const stepsDone = tools.filter(a => a.status === 'completed').length
  const stepsActive = tools.filter(a => a.status === 'inProgress').length
  const notes = (run.activities || []).filter(a => a.kind === 'workNote' && a.status === 'completed')
  const lastNote = notes.at(-1)
  const question = lastNote && /[?？]\s*$/.test(String(lastNote.detail?.text ?? '').trim()) && !flow.askedNotes.has(lastNote.id) ? lastNote : null
  return {
    elapsedMs: Math.max(0, now - flow.startedAt), sinceLastMs: flow.lastSentAt === null ? null : Math.max(0, now - flow.lastSentAt),
    stepsDone, stepsActive, stepsSinceLast: stepsDone - flow.stepsAtLast, sent: flow.sent.length,
    waitExplained: flow.kinds.has('explain_wait'), asked: flow.kinds.has('ask_missing'),
    blocked: Boolean(run.pendingApprovals?.length) || Boolean(flow.blockedProbe?.()),
    question: question ? { id: question.id } : null,
  }
}

/** The kinds that are possible right now. 'none' is always among them. */
/**
 * Why no pointer may be posted now, or null. Everything here is a fact code holds; the Decision model is never asked about it
 * (measured 2026-11-24: asked "do they still need to be told", the model said yes 1.0 with nobody at the desk and 0.92 when the
 * answer had already said where the document is).
 *   no_fact     no provider reports something waiting for a person
 *   in_view     it is already inside what that person is looking at (the placement runtime's own geometry)
 *   no_surface  a finished result with no surface the provider places off the person's view (a pointer says where something is:
 *               with nothing located elsewhere there is nothing to point to; Main, 2026-11-24, for requested results)
 *   no_route    that person is away, has no conversation of their own, or the only place has someone else in it (pointerRoute:
 *               presence and participants); the fact is then held for them (holdAttention)
 *   pointed     a pointer for this fact was already posted (the posted-pointer record)
 *   declined    the judge already answered for this fact that no pointer is needed (told where, or nothing to look at)
 *   bound       the window's pointer bound is used up
 */
export function pointerBlocked(facts, limits = FLOW_LIMITS) {
  if (!facts?.attention) return 'no_fact'
  if (facts.attention.where === 'in_view') return 'in_view'
  if (facts.attention.kind === 'result' && facts.attention.located !== true) return 'no_surface'
  if (!facts.pointerTarget) return 'no_route'
  if (facts.pointed === true) return 'pointed'
  if (facts.declined === true) return 'declined'
  if ((facts.pointers ?? 0) >= limits.maxPointers) return 'bound'
  return null
}

export function enumerateOptions(facts, limits = FLOW_LIMITS) {
  const out = ['none']
  if (facts.sinceLastMs !== null && facts.sinceLastMs < limits.minGapMs) return out
  // A pointer has its own addressee (the person who must act) and its own route; whether one may be posted is code (pointerBlocked).
  // It does not depend on the wait messages.
  if (pointerBlocked(facts, limits) === null) out.push('pointer')
  if (facts.blocked || facts.sent >= limits.maxMessages) return out
  // Nobody is waiting, the waiting person is not in this conversation, or someone else is: nothing may be said here.
  if (facts.audience && facts.audience.postable !== true) return out
  if (facts.question && !facts.asked) out.push('ask_missing')
  if (facts.elapsedMs >= limits.firstAfterMs) {
    // Without any tool step: from thinkingNoteMs while the engine is visibly active, from 20 s once it has been silent for the stall bound.
    const stepped = facts.stepsActive > 0 || facts.stepsDone > 0
    const silent = Number.isFinite(facts.sinceEngineMs) && facts.sinceEngineMs >= limits.stallAfterMs
    if (!facts.waitExplained && (stepped || facts.elapsedMs >= limits.thinkingNoteMs || (silent && facts.elapsedMs >= limits.firstAfterMs * 2))) out.push('explain_wait')
    if (facts.stepsSinceLast >= limits.milestoneSteps && facts.sent > 0) out.push('milestone')
  }
  // The engine has been silent for the stall bound (known only on a heartbeat: sinceEngineMs comes from its counter) while it is the
  // engine's own turn. A tool or an objective loop that is running is not a silent engine: a long quiet step is a wait to explain.
  if (Number.isFinite(facts.sinceEngineMs) && (facts.phase === undefined || facts.phase === 'thinking') && !facts.stalledNoted &&
      facts.sinceEngineMs >= (facts.reasoningOpen ? limits.stallReasoningMs : limits.stallAfterMs)) out.push('stalled')
  return out
}


// ---- What the judge is shown, and what it is asked (measured on real answers, 2026-11-24) ----
// From numbers and closed labels alone the Decision model answered "say nothing" to every pattern, and a choice that contains a
// do-nothing option collapsed onto it. So: the judge reads what the run's own models already receive (the person's request, what the
// Agent is doing now, what was already said), each part only when the run's egress gate allows that kind of data; it answers yes/no
// questions, one per kind of message; and CODE turns the answers into a kind. Everything that is arithmetic (how long, how often,
// how many, who is present, is there a route) is decided by enumerateOptions before anything is asked.
export const FLOW_CONTEXT_LIMITS = Object.freeze({ request: 600, note: 400, said: 280, command: 160, answer: 500, tools: 2 })
// kind → the predicate that stands for it. 'explain_wait' and 'milestone' are the same question; code picks the wording.
const PREDICATE_OF = Object.freeze({ ask_missing: 'ask', pointer: 'pointer', stalled: 'note', explain_wait: 'note', milestone: 'note' })
export const FLOW_PREDICATES = Object.freeze({
  note: Object.freeze({ name: 'note', type: 'predicate', instructions: 'Would a considerate collaborator send the waiting person a short progress note right now (one or two sentences on what is taking time), given what they asked, what is happening and what was already said?' }),
  ask: Object.freeze({ name: 'ask', type: 'predicate', instructions: 'Does the quoted note show that the assistant needs a piece of information that only the person can give before it can finish, so that asking the person now would help?' }),
  // The pointer: only what code cannot know, each quoted on its own (R4). Whether anyone is there, where it is and whether a pointer
  // was posted are code (pointerBlocked).
  // Asked only about a result the person did NOT request (a requested result is needed by its requester by definition: code).
  // Measured 2026-11-24 on the c16 wording ("does the person need to look at it"): .74 and .42 on two requested results, i.e. ambiguous.
  pointer: Object.freeze({ name: 'pointer', type: 'predicate', instructions: 'The quoted message announces a finished result that this person did not ask for. Does it contain something they must act on or decide?' }),
  told: Object.freeze({ type: 'predicate', instructions: 'Does the quoted message tell the reader where on their screen or desk the finished work is open (a direction or a place)?' }),
})
// Stalled is not a question (measured 2026-11-24: "has the work stalled" came back 0.28 after 24 s of silence and 0.78 after 60 s with
// a reasoning step open, i.e. it followed the seconds, and the one fact that was not a number pointed the other way). Code knows the
// silence (enumerateOptions offers 'stalled' at the bound); the note question decides whether to speak; code picks the wording.
const SAID = Object.freeze({ explain_wait: 'a note that this takes a while', ask_missing: 'a question to the person', milestone: 'a progress note', stalled: 'a note that the response is taking unusually long', pointer: 'a note about where a result is' })
// The engine-command judge's own reading of the command's real output (egdesk-terminal-judge.mjs), in plain words.
const COMMAND_STATE = Object.freeze({ running_output: 'its output shows it is still running', waiting_yn_input: 'it is waiting for a yes or no answer', waiting_password: 'it is waiting for a secret to be typed',
  stuck_in_pager: 'a pager is holding the terminal', need_user_context: 'its output asks for information only the person can give', cannot_proceed: 'its output shows it cannot continue' })
const oneLine = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text }
const quoted = (label, text) => `${label}:\n"""\n${text}\n"""`
const secondsOf = ms => Math.max(0, Math.round(ms / 1000))
const span = ms => { const n = secondsOf(ms); return `${n} second${n === 1 ? '' : 's'}` }
const WHERE_WORDS = Object.freeze({ in_view: 'inside what they are looking at on the desk', left: 'to the left of what they are looking at on the desk', right: 'to the right of what they are looking at on the desk',
  above: 'above what they are looking at on the desk', below: 'below what they are looking at on the desk', none: 'elsewhere on the desk' })
const FAR_WORDS = Object.freeze({ near: ', close by', far: ', some way off', very_far: ', far away' })
/** Where something is, relative to what the person is looking at: fixed words chosen by closed labels. */
export const wherePhrase = attention => `${WHERE_WORDS[attention?.where] ?? WHERE_WORDS.none}${FAR_WORDS[attention?.distance] ?? ''}`
function personLine(audience) {
  if (!audience || audience.waiting === 'nobody') return 'Nobody is at the desk waiting for this.'
  const who = audience.waiting === 'owner' ? 'the owner of this task (the person who asked is away)' : 'the person who asked'
  const there = audience.addresseePresent === null ? 'whether they are at the desk is not known' : `they are at the desk${Number.isFinite(audience.addresseeIdleMs) ? ` (last input ${span(audience.addresseeIdleMs)} ago)` : ''}`
  return `Waiting for this: ${who}; ${there}.`
}
/**
 * What the Agent is doing right now, as sentences. Real command lines and tool names are included only when `allows` says the
 * run's models may receive that kind; otherwise the sentence stays general. Returns { lines, kinds }.
 */
function workLines({ run, heartbeatFacts, flow, own, allows, browserTask = null }) {
  const hb = heartbeatFacts, lines = [], kinds = new Set()
  const tools = (run?.activities || []).filter(a => !own.has(a.kind))
  const describe = a => {
    if (a.kind === 'commandExecution') {
      if (a.detail?.command && allows('terminal_command')) { kinds.add('terminal_command'); return `a command: \`${oneLine(a.detail.command, FLOW_CONTEXT_LIMITS.command)}\`` }
      return 'a command'
    }
    if (a.kind === 'fileChange') return `file changes (${Number.isSafeInteger(a.detail?.changeCount) ? a.detail.changeCount : 'some'} files)`
    if (a.kind === 'mcpToolCall') return a.detail?.controlKind === 'computer' ? 'a step that operates the computer' : `the tool ${oneLine(`${a.detail?.server ?? ''} / ${a.detail?.tool ?? ''}`, 80)}`
    if (a.kind === 'dynamicToolCall') return `the tool ${oneLine(a.detail?.tool ?? 'unknown', 80)}`
    if (a.kind === 'collabAgentToolCall') return 'a hand-off to a helper agent'
    return 'a tool step'
  }
  const running = tools.filter(a => a.status === 'inProgress').slice(-FLOW_CONTEXT_LIMITS.tools)
  const command = hb.sources?.engine_commands
  for (const a of running) {
    const timing = a.kind === 'commandExecution' && command?.terminal && Number.isFinite(command.runningMs)
      ? ` (running for about ${span(command.runningMs)}${COMMAND_STATE[command.terminalState] ? `; ${COMMAND_STATE[command.terminalState]}` : ''})` : ''
    lines.push(`The assistant is running ${describe(a)}${timing}.`)
  }
  const waits = waitSummary(hb).filter(w => !(running.length && (w.what === 'command_running' || w.what === 'tool_running')))
  for (const w of waits) lines.push(`As far as the system knows: ${WAIT_LABELS[w.what]}${w.seconds !== null && w.seconds >= 5 ? ` (about ${w.seconds} seconds so far)` : ''}.`)
  if (!running.length && !waits.length) lines.push(flow?.reasoningOpen?.() === true ? 'The assistant is thinking (a reasoning step is open); no tool step is running.' : 'No tool step is running.')
  const done = tools.filter(a => a.status === 'completed')
  lines.push(hb.stepsDone > 0 ? `Tool steps finished so far: ${hb.stepsDone}${done.length ? ` (the last one: ${describe(done.at(-1))})` : ''}.` : 'No tool step has finished yet.')
  if (Number.isSafeInteger(hb.stepsRemaining)) lines.push(`The task may take up to ${hb.stepsRemaining} more steps (an upper limit, not a plan).`)
  // While a step-by-step task runs outside the engine, the engine's own silence says nothing: the task's last step does.
  const task = hb.sources?.browser_task
  if (task && browserTask) { const brief = browserTaskLines(browserTask, allows); lines.push(...brief.lines); for (const kind of brief.kinds) kinds.add(kind) }
  if (hb.phase === 'objective_step') { if (Number.isFinite(task?.lastActionAgeMs)) lines.push(`The task's last step finished ${span(task.lastActionAgeMs)} ago.`) }
  else lines.push(`The last sign of activity from the work was ${span(hb.sinceEngineMs)} ago.`)
  return { lines, kinds }
}

// ---- L8 c18: what the browser task is doing (egdesk-browser-task.mjs store.brief), for the note judgment, its check and its writer ----
// While a browser task runs the engine is silent, so the note question comes at 20 s. From "a task in the browser is still going" alone
// the judge cannot tell a true wait message from a vague one (R1), and the check cannot support a sentence that names the site. So the
// task's own facts go along: the step count and its last closed outcome (always: closed words), the goal as the person asked it (only
// where the run may send browser_task_record) and the host of the card (only where the run may send page_text). Never a label, a path,
// an address or text read from the page.
export const TASK_LAST = Object.freeze({
  started: 'it has not acted on the page yet',
  opened_link: 'its last step opened a link on the site',
  scrolled: 'its last step scrolled the page',
  filled_field: 'its last step filled in a field',
  acted: 'its last step acted on the page',
  choice_needed: 'it stopped to ask the person which of several options they mean',
  confirm_needed: 'it stopped to ask the person to confirm one option',
  detail_needed: 'it stopped to ask the person for a detail it needs',
  card_choice_needed: 'it stopped to ask the person which browser card they mean',
  page_unclear: 'it stopped to ask the person to look at the page',
  login_required: 'the page asks the person to sign in',
  two_factor_required: 'the page asks the person for a verification code',
  bot_check: 'the page shows a check only the person can pass',
  sensitive_flow: 'the page is at a step only the person may take',
  human_step: 'what is left on the page is for the person to press',
})
export const BRIEF_GOAL_LIMIT = 160
/** The brief as lines, each part under its egress kind: { lines, kinds }. null brief or a malformed one gives no lines. */
export function browserTaskLines(brief, allows = () => false) {
  const lines = [], kinds = new Set()
  if (!brief || typeof brief !== 'object') return { lines, kinds }
  const steps = Number.isSafeInteger(brief.stepsDone) && brief.stepsDone >= 0 ? brief.stepsDone : null
  const last = Object.hasOwn(TASK_LAST, brief.last) ? TASK_LAST[brief.last] : null
  if (steps !== null || last) lines.push(`The task in the browser: ${steps !== null ? `${steps} page ${steps === 1 ? 'step' : 'steps'} so far` : 'steps unknown'}${last ? `; ${last}` : ''}.`)
  const goal = oneLine(brief.goal, BRIEF_GOAL_LIMIT)
  if (goal && allows('browser_task_record') === true) { lines.push(`The browser task's goal, as the person asked it: "${goal}"`); kinds.add('browser_task_record') }
  if (typeof brief.host === 'string' && /^[a-z0-9.-]{1,120}$/.test(brief.host) && allows('page_text') === true) { lines.push(`It works on the site ${brief.host}.`); kinds.add('page_text') }
  return { lines, kinds }
}

/**
 * The evidence a heartbeat message is checked against before it is posted: the facts it was composed from, as the runtime holds them.
 * Measured 2026-11-24 (all-on journey, step s4): a wait message checked against the turn's memory pages was blocked (present .90/.91:
 * "it states something as a present fact"), because nothing given to the check said what the run was doing. These items say it.
 *   kind: the message kind; attention: for a pointer; note: the Agent's note an early question was asked about.
 *   allows(kind): the run's egress gate (the command line only where terminal_command is allowed, exactly as in runContext).
 * Returns [{ id, kind, time, source, text }] for checkDraft (kinds conversation / run_state, both of the run's own data class).
 */
export function messageEvidence({ kind, run = null, heartbeatFacts = null, flow = null, userText = '', allows = () => true, own = new Set(), note = null, attention = null, browserTask = null }) {
  if (kind === 'pointer') {
    if (!attention) return []
    const what = { result: 'A finished result', approval: 'Something that needs the person\'s decision', question: 'A question for the person' }[attention.kind] ?? 'Something for the person'
    return [{ id: 'now', kind: 'run_state', time: 'present', source: 'runtime', text: `${what} is waiting ${wherePhrase(attention)}. Nothing was moved into the person's view.` }]
  }
  const items = []
  const request = oneLine(userText, FLOW_CONTEXT_LIMITS.request)
  if (request) items.push({ id: 'request', kind: 'conversation', time: 'present', source: 'person', text: `The person asked: ${request}` })
  if (heartbeatFacts) {
    const work = workLines({ run: run ?? { activities: [] }, heartbeatFacts, flow, own, allows, browserTask })
    items.push({ id: 'now', kind: 'run_state', time: 'present', source: 'runtime', text: [`${span(heartbeatFacts.sinceUserMs)} have passed since the person wrote.`, ...work.lines].join('\n') })
  }
  const noted = oneLine(note, FLOW_CONTEXT_LIMITS.note)
  if (kind === 'ask_missing' && noted) items.push({ id: 'note', kind: 'run_state', time: 'present', source: 'agent', text: `The assistant's note to itself: ${noted}` })
  return items
}

/**
 * The material for the message questions of a working run: { text, kinds } or null when the run's models may not receive the
 * run's own text (then nothing is asked: the judge is never sent bare numbers).
 *   userText: what the person wrote; allows(kind): the run's egress gate; facts: beatFlowFacts(...) (+ pointer facts).
 */
export function runContext({ run, heartbeatFacts, flow, facts, userText, allows = () => true, own = new Set(), browserTask = null }) {
  if (allows('run_text') !== true) return null
  const hb = heartbeatFacts, L = FLOW_CONTEXT_LIMITS, kinds = new Set(['run_text'])
  const parts = []
  const request = oneLine(userText, L.request)
  if (request) parts.push(quoted('The person\'s request', request))
  const now = [`${span(hb.sinceUserMs)} ${secondsOf(hb.sinceUserMs) === 1 ? 'has' : 'have'} passed since the person wrote.`]
  const work = workLines({ run, heartbeatFacts: hb, flow, own, allows, browserTask })
  for (const kind of work.kinds) kinds.add(kind)
  now.push(...work.lines)
  const notes = (run?.activities || []).filter(a => a.kind === 'workNote' && a.status === 'completed')
  const note = oneLine(notes.at(-1)?.detail?.text, L.note)
  if (note) now.push(`The assistant's latest note to itself: "${note}"`)
  now.push(personLine(facts?.audience ?? null))
  parts.push(`Now:\n${now.map(line => `- ${line}`).join('\n')}`)
  const sent = (flow?.sent || []).slice(-3)
  parts.push(sent.length ? `Already said to the person while working:\n${sent.map(row => `- ${Number.isFinite(row.at) ? `${span(hb.internalMs - row.at)} ago` : 'earlier'} (${SAID[row.kind] ?? 'a note'}): "${oneLine(row.text, L.said)}"`).join('\n')}`
    : 'Nothing has been said to the person since they wrote.')
  return { text: parts.join('\n\n'), kinds: [...kinds] }
}

const POINTER_LIMITS = Object.freeze({ result: 600, posted: 2 })
/**
 * The yes/no questions for the kinds that code found possible at this beat (enumerateOptions), in a fixed order.
 * note: the Agent's note the `ask` question judges, quoted on its own ({ text }); without it 'ask_missing' asks nothing.
 * pointer: { kind, result, posted, requested } when 'pointer' is possible — the announcement of the finished work (its run's posted
 *   answer), the messages already posted to that person since that work began (at most two, newest last), and whether that person is
 *   the one who requested the work (code: the run's requester). Each item is quoted on its own: `pointer` (does it hold something they
 *   must act on or decide) only for a finished result they did not request; `told_N` per posted message.
 */
export function flowPredicates(options, { note = null, pointer = null } = {}) {
  const out = []
  if (options.includes('ask_missing')) {
    const text = oneLine(note?.text, FLOW_CONTEXT_LIMITS.note)
    if (text) out.push({ ...FLOW_PREDICATES.ask, quote: { label: 'The assistant\'s latest note to itself', text }, kinds: ['run_text'] })
  }
  if (options.includes('pointer') && pointer) out.push(...pointerPredicates(pointer))
  // The note question's topic is the kinds it stands for now: when code first allows a stall, that is new and asks at once.
  const noteKinds = ['explain_wait', 'milestone', 'stalled'].filter(kind => options.includes(kind))
  if (noteKinds.length) out.push({ ...FLOW_PREDICATES.note, topic: noteKinds.join('_') })
  return out
}

// The early question for notes that do not end in "?" (c18, replacing the plain pre-filter; measured 2026-11-24: ask .97 on such a note
// that needs the person, 0 on a plain plan step). They never cause a request: they ride on one that goes out anyway, at most two per
// request, the oldest not yet judged first, each quoted on its own, and each note is judged once.
export const RIDE_ALONG_LIMITS = Object.freeze({ perRequest: 2 })
export function rideAlongPredicates(notes) {
  return (Array.isArray(notes) ? notes : []).slice(0, RIDE_ALONG_LIMITS.perRequest).map((note, i) => ({ ...FLOW_PREDICATES.ask, name: `ask_${i + 1}`,
    quote: { label: 'A note the assistant wrote to itself', text: oneLine(note.text, FLOW_CONTEXT_LIMITS.note) }, kinds: ['run_text'] }))
}

export function pointerPredicates({ kind, result = null, posted = [], topic = null, requested = false } = {}) {
  const out = []
  const fresh = typeof topic === 'string' ? { topic } : {}
  const announced = oneLine(result, POINTER_LIMITS.result)
  if (kind === 'result' && requested !== true && announced) out.push({ ...FLOW_PREDICATES.pointer, ...fresh, quote: { label: 'The message about the finished work', text: announced }, kinds: ['run_text'] })
  ;(Array.isArray(posted) ? posted : []).map(text => oneLine(text, POINTER_LIMITS.result)).filter(Boolean).slice(-POINTER_LIMITS.posted)
    .forEach((text, i) => out.push({ ...FLOW_PREDICATES.told, ...fresh, name: `told_${i + 1}`, quote: { label: 'A message already posted to this person', text }, kinds: ['run_text'] }))
  return out
}

/**
 * Whether to point, once code allowed it: never when a posted message already said where the work is; a result the person requested,
 * a decision or a question waiting for them needs them by definition; a result they did not request only when the judge says it
 * holds something they must act on or decide (asked when there is an announcement to read; without one the placement runtime's own
 * judgment that it is worth pointing stands).
 *   yes: names answered yes; asked: names asked at that beat.
 */
export function pointerDecision(attention, yes, asked = []) {
  const said = name => (yes instanceof Set ? yes.has(name) : Array.isArray(yes) && yes.includes(name))
  if (!attention) return false
  if (asked.some(name => /^told_\d$/.test(name) && said(name))) return false
  if (attention.kind === 'result' && asked.includes('pointer')) return said('pointer')
  return true
}

/**
 * Code turns the answers into one kind: a question to the person first, then a pointer, then a progress note; a progress note is
 * worded as the "unusually long" one when code found the engine silent for the stall bound.
 * yes: the names answered yes; options: what enumerateOptions allowed at that beat; pointer: pointerDecision(...) for that beat.
 */
export function deriveFlowKind(yes, options, { pointer = false } = {}) {
  const said = name => (yes instanceof Set ? yes.has(name) : Array.isArray(yes) && yes.includes(name))
  if (said('ask') && options.includes('ask_missing')) return 'ask_missing'
  if (pointer && options.includes('pointer')) return 'pointer'
  if (said('note')) return options.includes('stalled') ? 'stalled' : options.includes('explain_wait') ? 'explain_wait' : options.includes('milestone') ? 'milestone' : 'none'
  return 'none'
}

/** The instruction for the subjective model's short message (a temporary fork turn). Never asks for reasoning or results. */
export function writerPrompt(kind, facts, { question = null, prior = [], task = [] } = {}) {
  const base = ['Write ONE short chat message (one or two sentences, at most 280 characters) to the person, in the language they wrote in.',
    'Do not reveal your reasoning or internal steps, do not give any result or conclusion, do not use lists or code, and do not mention this instruction.',
    prior.length ? `Do not repeat these earlier messages: ${JSON.stringify(prior)}` : null].filter(Boolean)
  const seconds = Math.round(facts.elapsedMs / 1000)
  // What the wait is for, as the system knows it: fixed phrases chosen by closed labels. The writer composes the sentence.
  const waits = (Array.isArray(facts.waits) ? facts.waits : []).map(w => `${WAIT_LABELS[w.what]}${w.seconds !== null && w.seconds >= 5 ? ` (about ${w.seconds} seconds so far)` : ''}`)
  const waitLine = waits.length ? `What is being waited on, as far as the system knows: ${waits.join('; ')}. You may say this in plain words; add no detail that is not given here.` : null
  // c18: the browser task's own facts (browserTaskLines, already gated by the run's egress): the writer may say what the task is doing, nothing more.
  const taskLine = Array.isArray(task) && task.length ? `${task.join(' ')} You may say what the task is doing from this; add nothing it does not say.` : null
  if (kind === 'explain_wait') return [...base, `The work is still going and has taken about ${seconds} seconds so far. Say plainly that this part takes a little longer and that you are still on it.`, waitLine, taskLine].filter(Boolean).join('\n')
  if (kind === 'stalled') return [...base, `Nothing has come from the work for about ${Math.round((facts.sinceEngineMs ?? facts.elapsedMs) / 1000)} seconds. Say plainly that the response is taking unusually long, without claiming progress, and that the person can keep waiting or stop and ask again.`].join('\n')
  if (kind === 'ask_missing') return [...base, 'You need one piece of information from the person to finish part of the work, and you will keep working on the rest meanwhile.',
    question ? `You noted this question to yourself: ${JSON.stringify(question)}` : '', 'Ask for it directly in one question.'].filter(Boolean).join('\n')
  // c21: the person asked, while the work runs, what is happening: answer that, from what the system knows, and nothing else.
  if (kind === 'reply_status') return [...base, `The person just wrote, while you work: ${JSON.stringify(oneLine(facts.personMessage ?? '', IN_RUN_LIMITS.quoteChars))}`,
    `Answer that briefly and truthfully: the work is still going (about ${seconds} seconds so far, ${facts.stepsDone} steps done) and what it is doing now, from what is given here only.`, waitLine, taskLine].filter(Boolean).join('\n')
  return [...base, `${facts.stepsDone} steps are done so far. Say briefly that the work is progressing and how far along it is, without giving results.`].join('\n')
}

// ---- A person's message that arrives while the run works (c21; flag decisionContext.conversationFlow.inRunMessages, default off) ----
// The message becomes a heartbeat fact, quoted on its own (bounded). The beat asks three yes/no questions about it (R1/R2); code decides:
//   stop yes                         -> 'stop'  (the run is interrupted; the message stays in the conversation)
//   change yes                       -> 'steer' (the message goes into the working turn, as the person's words)
//   status yes, change and stop not  -> 'reply' (one short true progress reply, worded by the subjective model and checked)
//   anything else, or no answer      -> 'steer' (the safe default: the run gets what the person wrote)
export const IN_RUN_LIMITS = Object.freeze({ quoteChars: 600, pending: 8 })
export const PERSON_PREDICATES = Object.freeze({
  status: Object.freeze({ name: 'person_status', type: 'predicate', instructions: 'Does this message ask what is happening, how far along the work is, or why it stopped?' }),
  change: Object.freeze({ name: 'person_change', type: 'predicate', instructions: 'Does this message change or redirect the task the assistant is doing (a different target, order or way of doing it)?' }),
  stop: Object.freeze({ name: 'person_stop', type: 'predicate', instructions: 'Does this message ask the assistant to stop or cancel the work?' }),
})
/** The questions about one in-run message, each quoting it (R4). */
export function personPredicates(message) {
  const quote = { label: 'The person\'s message, sent while the work is running', text: oneLine(message, IN_RUN_LIMITS.quoteChars) }
  return [PERSON_PREDICATES.status, PERSON_PREDICATES.change, PERSON_PREDICATES.stop].map(q => ({ ...q, quote, kinds: ['run_text'], topic: 'person_message' }))
}
/** What code does with the message, from the yes answers (a Set of names). */
export function personDecision(yes) {
  if (yes.has('person_stop')) return 'stop'
  if (yes.has('person_change')) return 'steer'
  if (yes.has('person_status')) return 'reply'
  return 'steer'
}

/** The instruction for a pointer message, from closed labels only. The writer composes the sentence in the person's language. */
export function pointerPrompt(attention, { prior = [] } = {}) {
  const what = { result: 'A finished result is ready for them to look at', approval: 'Something needs their decision before the work can continue', question: 'A question is waiting for their answer' }[attention?.kind] ?? 'Something is waiting for them'
  return ['Write ONE short chat message (one or two sentences, at most 280 characters) to the person, in the language they wrote in.',
    `${what}. It is ${wherePhrase(attention)}.`,
    'Nothing was moved into their view and you must not say it was. Do not reveal your reasoning, do not give the result itself, do not use lists or code, and do not mention this instruction.',
    prior.length ? `Do not repeat these earlier messages: ${JSON.stringify(prior)}` : null].filter(Boolean).join('\n')
}

/** One clean paragraph of at most maxChars, or null. */
export function cleanIntermediate(text, maxChars = FLOW_LIMITS.maxChars) {
  const t = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim()
  return t && t.length <= maxChars ? t : null
}

const normalize = value => String(value).toLowerCase().replace(/[\s.,!?'"()\[\]·…\-]+/g, '')
/** The final answer without sentences that repeat an intermediate message word for word; unchanged if nothing would remain. */
export function withoutRepeats(finalText, intermediates) {
  const seen = new Set(intermediates.flatMap(text => String(text).split(/(?<=[.!?。！？])\s+/)).map(normalize).filter(s => s.length >= 12))
  if (!seen.size) return finalText
  const kept = String(finalText).split(/(?<=[.!?。！？])\s+|\n/).filter(Boolean).filter(s => !seen.has(normalize(s)))
  return kept.length && kept.length < String(finalText).split(/(?<=[.!?。！？])\s+|\n/).filter(Boolean).length ? kept.join(' ') : finalText
}
