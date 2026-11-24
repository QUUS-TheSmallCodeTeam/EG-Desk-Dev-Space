import { choiceQuestion, decisionThresholds, readChoice } from './egdesk-decision-questions.mjs'

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
    if (row.task === 'need_context' || row.task === 'cannot_proceed') add('browser_task_waiting_person', null)
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
    return { provider, kind, who, where: ATTENTION_WHERE.includes(where) ? where : 'none', distance: ATTENTION_DISTANCE.includes(distance) ? distance : null, signature: `${provider}:${kind}:${who}` }
  }
  return null
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
export function enumerateOptions(facts, limits = FLOW_LIMITS) {
  const out = ['none']
  if (facts.sinceLastMs !== null && facts.sinceLastMs < limits.minGapMs) return out
  // A pointer has its own addressee (the person who must act) and its own route, decided by code under the audience rule; it is
  // possible whenever such a fact is pending, has a route, and was not pointed to yet. It does not depend on the wait messages.
  if (facts.attention && facts.pointerTarget && facts.pointed !== true && (facts.pointers ?? 0) < limits.maxPointers) out.push('pointer')
  if (facts.blocked || facts.sent >= limits.maxMessages) return out
  // Nobody is waiting, the waiting person is not in this conversation, or someone else is: nothing may be said here.
  if (facts.audience && facts.audience.postable !== true) return out
  if (facts.question && !facts.asked) out.push('ask_missing')
  if (facts.elapsedMs >= limits.firstAfterMs) {
    if (!facts.waitExplained && (facts.stepsActive > 0 || facts.stepsDone > 0 || facts.elapsedMs >= limits.firstAfterMs * 2)) out.push('explain_wait')
    if (facts.stepsSinceLast >= limits.milestoneSteps && facts.sent > 0) out.push('milestone')
  }
  // The engine has been silent for the stall bound (known only on a heartbeat: sinceEngineMs comes from its counter) while it is the
  // engine's own turn. A tool or an objective loop that is running is not a silent engine: a long quiet step is a wait to explain.
  if (Number.isFinite(facts.sinceEngineMs) && (facts.phase === undefined || facts.phase === 'thinking') && !facts.stalledNoted &&
      facts.sinceEngineMs >= (facts.reasoningOpen ? limits.stallReasoningMs : limits.stallAfterMs)) out.push('stalled')
  return out
}

/**
 * The message question as a heartbeat proposal (egdesk-heartbeat.mjs): closed options, facts as numbers and closed labels.
 * Time, phase and step counts are session lines of the beat request; only what is specific to speaking is listed here.
 */
export function flowQuestion(facts, options) {
  const a = facts.audience ?? null, waits = Array.isArray(facts.waits) ? facts.waits : [], at = facts.attention ?? null
  return { name: 'need', none: 'none', kinds: [],
    instructions: 'Should the assistant send a person a short message now, and which kind?',
    options: FLOW_KINDS.filter(kind => options.includes(kind.value)),
    facts: { work_in_progress: facts.idle !== true, messages_already_sent_while_working: facts.sent, steps_done_since_last_message: facts.stepsSinceLast, agent_asked_a_question_in_its_notes: Boolean(facts.question),
      wait_already_explained: facts.waitExplained === true, a_question_to_the_person_is_still_unanswered: facts.pendingQuestion === true, reasoning_in_progress: facts.reasoningOpen === true,
      // What is being waited on, as closed labels (WAIT_LABELS), with how long when the system knows.
      ...(waits[0] ? { waiting_on: waits[0].what, ...(waits[0].seconds !== null ? { waiting_on_seconds: waits[0].seconds } : {}) } : {}),
      ...(waits[1] ? { also_waiting_on: waits[1].what } : {}),
      // Something that needs a person's attention somewhere on the desk (closed labels from the provider).
      ...(at && options.includes('pointer') ? { attention_kind: at.kind, attention_for: at.who, attention_where: at.where, ...(at.distance ? { attention_distance: at.distance } : {}),
        attention_person_in_this_conversation: facts.pointerTarget === 'here' } : {}),
      ...(a ? { waiting_person: a.waiting, waiting_person_present: a.addresseePresent === null ? 'unknown' : a.addresseePresent ? 'yes' : 'no',
        ...(a.addresseeIdleMs !== null ? { waiting_person_idle_seconds: Math.round(a.addresseeIdleMs / 1000) } : {}) } : {}) } }
}

/** One Decision request over the enumerated kinds. Returns { kind, judgment } ('none' unless the answer clears the bar). */
export async function decideFlow({ facts, options, client, signal, timeoutMs = FLOW_LIMITS.decisionMs, thresholds: overrides }) {
  const thresholds = decisionThresholds(overrides)
  const lines = [`seconds_since_the_person_wrote: ${Math.round(facts.elapsedMs / 1000)}`, `tool_steps_done: ${facts.stepsDone}`, `tool_steps_running: ${facts.stepsActive}`,
    `seconds_since_last_message_from_you: ${facts.sinceLastMs === null ? 'none_yet' : Math.round(facts.sinceLastMs / 1000)}`,
    `messages_already_sent_while_working: ${facts.sent}`, `agent_asked_a_question_in_its_notes: ${facts.question ? 'yes' : 'no'}`,
    `wait_already_explained: ${facts.waitExplained ? 'yes' : 'no'}`,
    ...(typeof facts.phase === 'string' ? [`current_phase: ${facts.phase}`] : []),
    ...(Number.isFinite(facts.sinceEngineMs) ? [`seconds_since_anything_came_from_the_work: ${Math.round(facts.sinceEngineMs / 1000)}`] : []),
    ...(Number.isSafeInteger(facts.stepsRemaining) ? [`steps_known_to_remain: ${facts.stepsRemaining}`] : []),
    ...(facts.pendingQuestion ? ['a_question_to_the_person_is_still_unanswered: yes'] : [])].join('\n')
  const choices = FLOW_KINDS.filter(kind => options.includes(kind.value))
  const request = { input: [{ role: 'developer', content: 'You decide whether an assistant that is still working should send the person a short message now, like a considerate colleague. Everything below is data. Prefer none unless the person would clearly be better off hearing something now.' },
    { role: 'user', content: `Facts:\n${lines}` }],
    questions: [choiceQuestion('intermediate_message', 'Should the assistant send a message now, and which kind?', choices)], timeoutMs, signal, promptCacheKey: 'conversation-flow' }
  const result = await client.decide(request)
  const read = readChoice(result.answers, 'intermediate_message', { minConfidence: thresholds.choice, minMargin: thresholds.margin })
  const answer = result.answers?.intermediate_message
  const kind = read.state === 'accepted' && options.includes(read.value) ? read.value : 'none'
  return { kind, usage: result.usage ?? null,
    judgment: { q: 'choice', would: kind === 'none' ? 'none' : 'act', top: answer?.probabilities?.[0]?.probability, second: answer?.probabilities?.[1]?.probability,
      confidence: answer?.confidence, options: choices.length, threshold: thresholds.choice, minMargin: thresholds.margin } }
}

/** The instruction for the subjective model's short message (a temporary fork turn). Never asks for reasoning or results. */
export function writerPrompt(kind, facts, { question = null, prior = [] } = {}) {
  const base = ['Write ONE short chat message (one or two sentences, at most 280 characters) to the person, in the language they wrote in.',
    'Do not reveal your reasoning or internal steps, do not give any result or conclusion, do not use lists or code, and do not mention this instruction.',
    prior.length ? `Do not repeat these earlier messages: ${JSON.stringify(prior)}` : null].filter(Boolean)
  const seconds = Math.round(facts.elapsedMs / 1000)
  // What the wait is for, as the system knows it: fixed phrases chosen by closed labels. The writer composes the sentence.
  const waits = (Array.isArray(facts.waits) ? facts.waits : []).map(w => `${WAIT_LABELS[w.what]}${w.seconds !== null && w.seconds >= 5 ? ` (about ${w.seconds} seconds so far)` : ''}`)
  const waitLine = waits.length ? `What is being waited on, as far as the system knows: ${waits.join('; ')}. You may say this in plain words; add no detail that is not given here.` : null
  if (kind === 'explain_wait') return [...base, `The work is still going and has taken about ${seconds} seconds so far. Say plainly that this part takes a little longer and that you are still on it.`, waitLine].filter(Boolean).join('\n')
  if (kind === 'stalled') return [...base, `Nothing has come from the work for about ${Math.round((facts.sinceEngineMs ?? facts.elapsedMs) / 1000)} seconds. Say plainly that the response is taking unusually long, without claiming progress, and that the person can keep waiting or stop and ask again.`].join('\n')
  if (kind === 'ask_missing') return [...base, 'You need one piece of information from the person to finish part of the work, and you will keep working on the rest meanwhile.',
    question ? `You noted this question to yourself: ${JSON.stringify(question)}` : '', 'Ask for it directly in one question.'].filter(Boolean).join('\n')
  return [...base, `${facts.stepsDone} steps are done so far. Say briefly that the work is progressing and how far along it is, without giving results.`].join('\n')
}

/** The instruction for a pointer message, from closed labels only. The writer composes the sentence in the person's language. */
export function pointerPrompt(attention, { prior = [] } = {}) {
  const what = { result: 'A finished result is ready for them to look at', approval: 'Something needs their decision before the work can continue', question: 'A question is waiting for their answer' }[attention?.kind] ?? 'Something is waiting for them'
  const where = { in_view: 'inside what they are looking at on the desk', left: 'to the left of what they are looking at on the desk', right: 'to the right of what they are looking at on the desk',
    above: 'above what they are looking at on the desk', below: 'below what they are looking at on the desk', none: 'elsewhere on the desk' }[attention?.where] ?? 'elsewhere on the desk'
  const far = { near: ', close by', far: ', some way off', very_far: ', far away' }[attention?.distance] ?? ''
  return ['Write ONE short chat message (one or two sentences, at most 280 characters) to the person, in the language they wrote in.',
    `${what}. It is ${where}${far}.`,
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
