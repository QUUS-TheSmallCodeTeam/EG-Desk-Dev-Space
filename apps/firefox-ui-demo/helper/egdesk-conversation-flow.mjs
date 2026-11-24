import { choiceQuestion, decisionThresholds, readChoice } from './egdesk-decision-questions.mjs'

// Human-like intermediate messages while a run is still working. The system decides, from runtime facts only, whether to say
// something now; the subjective model writes the short message; the message is posted as a completed chat message and the run
// continues. Reasoning is never exposed: the Decision request carries numbers and closed labels, never work-note text.
//
// Options exist at runtime: enumerateOptions(facts) lists only what is possible right now, and with nothing but 'none' possible
// there is no Decision request at all.

export const FLOW_LIMITS = Object.freeze({
  // Nielsen: about 10 s is how long a person stays focused on a wait without feedback; a first message earlier would interrupt
  // answers that are about to arrive, later leaves the person waiting in silence.
  firstAfterMs: 10_000,
  // At most one intermediate message every 30 s: a chat partner who talks more often than twice a minute while working is noise,
  // and each message costs a Decision request and a short fork turn.
  minGapMs: 30_000,
  // Three per run: a wait explanation, an early question and one milestone. More than that is a report, not a conversation.
  maxMessages: 3,
  // Decision requests: at most one per 10 s tick and six per run, so the cost of a long run is bounded.
  evalGapMs: 10_000, maxEvals: 6,
  tickMs: 5_000, writerMs: 20_000, maxChars: 280,
  milestoneSteps: 2,
})

export const FLOW_KINDS = Object.freeze([
  { value: 'none', description: 'Say nothing now; keep working.' },
  { value: 'explain_wait', description: 'Tell the person this takes a while and why, in one or two sentences.' },
  { value: 'ask_missing', description: 'Ask the person for information the work needs, then keep working on the rest.' },
  { value: 'milestone', description: 'Say what part is done so far, briefly, without giving results.' },
])

/** Facts from the run's real state. No text of any work note or message. */
export function flowFacts({ run, now, flow, own }) {
  const tools = (run.activities || []).filter(a => !own.has(a.kind))
  const stepsDone = tools.filter(a => a.status === 'completed').length
  const stepsActive = tools.filter(a => a.status !== 'completed').length
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
  if (facts.blocked || facts.sent >= limits.maxMessages) return out
  if (facts.sinceLastMs !== null && facts.sinceLastMs < limits.minGapMs) return out
  if (facts.question && !facts.asked) out.push('ask_missing')
  if (facts.elapsedMs >= limits.firstAfterMs) {
    if (!facts.waitExplained && (facts.stepsActive > 0 || facts.stepsDone > 0 || facts.elapsedMs >= limits.firstAfterMs * 2)) out.push('explain_wait')
    if (facts.stepsSinceLast >= limits.milestoneSteps && facts.sent > 0) out.push('milestone')
  }
  return out
}

/** One Decision request over the enumerated kinds. Returns { kind, judgment } ('none' unless the answer clears the bar). */
export async function decideFlow({ facts, options, client, signal, timeoutMs = 1500, thresholds: overrides }) {
  const thresholds = decisionThresholds(overrides)
  const lines = [`seconds_since_the_person_wrote: ${Math.round(facts.elapsedMs / 1000)}`, `tool_steps_done: ${facts.stepsDone}`, `tool_steps_running: ${facts.stepsActive}`,
    `seconds_since_last_message_from_you: ${facts.sinceLastMs === null ? 'none_yet' : Math.round(facts.sinceLastMs / 1000)}`,
    `messages_already_sent_while_working: ${facts.sent}`, `agent_asked_a_question_in_its_notes: ${facts.question ? 'yes' : 'no'}`,
    `wait_already_explained: ${facts.waitExplained ? 'yes' : 'no'}`].join('\n')
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
  if (kind === 'explain_wait') return [...base, `The work is still going and has taken about ${seconds} seconds so far. Say plainly that this part takes a little longer and that you are still on it.`].join('\n')
  if (kind === 'ask_missing') return [...base, 'You need one piece of information from the person to finish part of the work, and you will keep working on the rest meanwhile.',
    question ? `You noted this question to yourself: ${JSON.stringify(question)}` : '', 'Ask for it directly in one question.'].filter(Boolean).join('\n')
  return [...base, `${facts.stepsDone} steps are done so far. Say briefly that the work is progressing and how far along it is, without giving results.`].join('\n')
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
