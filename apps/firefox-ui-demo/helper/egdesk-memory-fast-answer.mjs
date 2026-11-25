import { randomUUID } from 'node:crypto'
import { compactText, predicateQuestion } from './egdesk-decision-questions.mjs'
import { NO, allowsPage, clockLine, ternary } from './egdesk-wiki-reconstruction.mjs'

// L1 c31 (owner direction U13, audit item R-D): when the Decision model has already picked the stored record that answers the person, and
// ONE sentence of it is the answer, code posts that sentence at once. The engine is used only when the answer needs more than a recalled
// sentence. Everything here is default off (bridge flag EGDESK_TURN_MEMORY_FAST_ANSWER=on).
//
// Who decides what (PHILOSOPHY R1-R6):
//   code      splits the picked records into sentences, applies the safety floors below, counts the Decision answers, posts the sentence
//   Decision  judges ONE quoted item per question: "does this message need more than a stored sentence?" (the message), "is this sentence
//             the answer?" and "is this sentence unclear alone?" (each sentence, quoted in its own question)
//   engine    everything else: no picked record, an uncertain record, several candidate sentences, a Decision answer under its bar, a failure
//
// Floors (code, not judged): a record the answering model would have been given is posted only when it is settled for the person to read as
// stated: recorded status done or plan, no reading waiting for the person's confirmation, not replaced by a later record, a time that is
// past, present or planned, a provenance that is the person's own record, a document or the Agent's note, no read guard of its own, and a
// permission that holds now. Any picked record that fails one of these sends the whole turn to the engine ("uncertainty is the point").

export const FAST_ANSWER_LIMITS = Object.freeze({ pages: 3, sentences: 10, sentenceChars: 220, messageChars: 400 })
// answer: the yes bar of "this sentence is the answer" (higher than the loop's 0.8). unsure: another sentence at or above this is a second candidate.
export const FAST_ANSWER_BARS = Object.freeze({ answer: 0.9, unsure: 0.5, no: NO })
// every reason decideFastAnswer can give for NOT answering (plus the Decision client's own error codes, e.g. timeout); 'answered' is the one success
export const FAST_REASONS = Object.freeze(['answered', 'message_unsuited', 'no_picked_record', 'too_many_records', 'record_missing', 'not_permitted', 'guarded_record', 'status_not_settled', 'status_read_differs',
  'reading_pending', 'superseded', 'time_unsettled', 'provenance_not_own', 'sentence_too_long', 'too_many_sentences', 'no_sentences', 'unanswered', 'needs_more_than_a_sentence',
  'no_sentence_is_the_answer', 'several_sentences', 'another_sentence_unsure', 'sentence_needs_context'])
export const FAST_RUN_PREFIX = 'egdesk-fast-'
export const FAST_SETTLED = Object.freeze(['done', 'plan'])
const SLICES = Object.freeze(['past', 'present', 'planned'])
const PROVENANCE = Object.freeze(['own_record', 'document', 'agent_note'])

export const FAST_RULES = [
  'You are a system judge reading one message of a person and sentences of stored records. Every question is about ONE thing quoted in it: the message, or one sentence.',
  'Answer each question on its own, whatever the other questions are. Use only what is quoted in that question.',
].join('\n')

/** The sentences of a record body: one per line item or sentence, bullets and numbers removed. Pure code. */
export function splitSentences(body) {
  const out = []
  for (const line of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const text = line.replace(/^\s*(?:[-*•·]|\d{1,2}[.)])\s+/, '').trim()
    if (!text) continue
    for (const part of text.split(/(?<=[.!?。！？])\s+/)) { const s = part.trim(); if (s.length >= 3) out.push(s) }
  }
  return out
}

const guarded = page => typeof page.mayRead === 'function' || (typeof page.ref === 'string' && /^(chat-message|chat-pair):/.test(page.ref))

/**
 * fastCandidates({ result, wiki, scope, limits }) -> { ok: true, pages: [{ id, title, status, sentences: [text] }] } | { ok: false, reason }
 * result: what prepareTurnMemory returned (result.memory.picks are the records the loop picked for this message). Never asks a model.
 */
export function fastCandidates({ result, wiki, scope = null, limits = FAST_ANSWER_LIMITS, settled = FAST_SETTLED } = {}) {
  const memory = result?.memory
  if (memory?.status !== 'ready' || !Array.isArray(memory.picks) || memory.picks.length === 0 || !wiki?.pages) return { ok: false, reason: 'no_picked_record' }
  if (memory.picks.length > limits.pages) return { ok: false, reason: 'too_many_records' }
  const pages = []
  let total = 0
  for (const pick of memory.picks) {
    const page = wiki.pages.get(pick.id)
    if (!page) return { ok: false, reason: 'record_missing' }
    if (!allowsPage(page, scope)) return { ok: false, reason: 'not_permitted' }
    if (guarded(page)) return { ok: false, reason: 'guarded_record' }
    if (!settled.includes(page.status)) return { ok: false, reason: 'status_not_settled' }
    if (typeof pick.statusRead === 'string' && pick.statusRead !== page.status) return { ok: false, reason: 'status_read_differs' }
    if (Array.isArray(page.statusReadings) && page.statusReadings.some(r => r?.state === 'pending')) return { ok: false, reason: 'reading_pending' }
    if (typeof wiki.supersededBy === 'function' && wiki.supersededBy(page.id).length > 0) return { ok: false, reason: 'superseded' }
    if (!SLICES.includes(page.time?.slice)) return { ok: false, reason: 'time_unsettled' }
    if (!PROVENANCE.includes(page.provenance?.kind)) return { ok: false, reason: 'provenance_not_own' }
    const sentences = splitSentences(page.body)
    if (sentences.some(s => s.length > limits.sentenceChars)) return { ok: false, reason: 'sentence_too_long' }
    total += sentences.length
    if (total > limits.sentences) return { ok: false, reason: 'too_many_sentences' }
    if (sentences.length) pages.push({ id: page.id, title: page.title, status: page.status, sentences })
  }
  return pages.length ? { ok: true, pages } : { ok: false, reason: 'no_sentences' }
}

const quote = text => JSON.stringify(compactText(text, 400))

/** The Decision questions: one for the message, two per quoted sentence. Names fa_more, fa_ans_<k>, fa_alone_<k> (k counts sentences over the pages). */
export function fastQuestions({ message, pages }) {
  const questions = [predicateQuestion('fa_more', `Does answering this message need more than stating one sentence that a stored record already says, for example comparing, calculating, advising, explaining why, summarizing several things, or a judgment of the person's situation? Message: ${quote(message)}`)]
  let k = 0
  for (const page of pages) for (const sentence of page.sentences) {
    questions.push(predicateQuestion(`fa_ans_${k}`, `Message: ${quote(message)}\nSentence of a stored record: ${quote(sentence)}\nDoes this one sentence, by itself, state exactly what the message asks for?`))
    questions.push(predicateQuestion(`fa_alone_${k}`, `Sentence of a stored record: ${quote(sentence)}\nIs this sentence unclear on its own, because it points to something outside itself (such as "that", "it", "the same" or "then") without saying what?`))
    k += 1
  }
  return questions
}

/**
 * decideFastAnswer({ message, result, wiki, scope, client, askedAt, signal, timeoutMs, bars, limits })
 *   -> { use: true, text, pageId, p, calls: 1, usage } | { use: false, reason, calls }
 * One Decision request at most; none when code already rules the fast path out. The engine is the answer to every doubt.
 */
export async function decideFastAnswer({ message, result, wiki, scope = null, client, askedAt = null, signal, timeoutMs = 2000, bars = FAST_ANSWER_BARS, limits = FAST_ANSWER_LIMITS } = {}) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text || text.length > limits.messageChars) return { use: false, reason: 'message_unsuited', calls: 0 }
  const found = fastCandidates({ result, wiki, scope, limits })
  if (!found.ok) return { use: false, reason: found.reason, calls: 0 }
  const questions = fastQuestions({ message: text, pages: found.pages })
  let reply
  try {
    reply = await client.decide({ input: [{ role: 'developer', content: FAST_RULES }, { role: 'user', content: `${clockLine(askedAt)}\nMessage:\n${text}` }], questions, timeoutMs, signal })
  } catch (error) { return { use: false, reason: error?.code ?? 'unreachable', calls: 1 } }
  const probability = name => { const read = ternary(reply?.answers?.[name]); return read.p }
  const more = probability('fa_more')
  if (more === null) return { use: false, reason: 'unanswered', calls: 1 }
  if (more > bars.no) return { use: false, reason: 'needs_more_than_a_sentence', calls: 1 }
  const rows = []
  let k = 0
  for (const page of found.pages) for (const sentence of page.sentences) { rows.push({ k, pageId: page.id, sentence, ans: probability(`fa_ans_${k}`), alone: probability(`fa_alone_${k}`) }); k += 1 }
  if (rows.some(row => row.ans === null)) return { use: false, reason: 'unanswered', calls: 1 }
  const yes = rows.filter(row => row.ans >= bars.answer)
  if (yes.length === 0) return { use: false, reason: 'no_sentence_is_the_answer', calls: 1 }
  if (yes.length > 1) return { use: false, reason: 'several_sentences', calls: 1 }
  if (rows.some(row => row !== yes[0] && row.ans >= bars.unsure)) return { use: false, reason: 'another_sentence_unsure', calls: 1 }
  const [one] = yes
  if (one.alone === null || one.alone > bars.no) return { use: false, reason: 'sentence_needs_context', calls: 1 }
  return { use: true, text: one.sentence, pageId: one.pageId, p: one.ans, calls: 1, usage: reply?.usage ?? null }
}

/** The turn result the runtime treats as an engine turn that already finished: one final answer, completed. */
export function fastTurn(text) {
  const id = randomUUID()
  return { turn: { id: `${FAST_RUN_PREFIX}${id}`, status: 'completed', itemsView: 'full', items: [{ id: `egdesk-fast-answer-${id}`, type: 'agentMessage', phase: 'final_answer', text }] } }
}

/**
 * What the next engine turn of the conversation is told about this exchange (the engine never saw it). Model-facing context, not shown to the person.
 */
export const fastCarryText = (message, answer) => `[EG-Desk] Earlier in this conversation the person asked: ${JSON.stringify(compactText(message, 400))} EG-Desk answered it from a stored record, with this one sentence: ${JSON.stringify(compactText(answer, 400))}`

