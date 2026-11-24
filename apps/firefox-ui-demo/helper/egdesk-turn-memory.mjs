import { createHash } from 'node:crypto'
import { choiceQuestion, compactText, predicateQuestion, readChoice, sha256Hex } from './egdesk-decision-questions.mjs'
import { speechDesignInterpretations, speechDesignQuestions, speechSegments } from './egdesk-speech-grounding.mjs'
import { MIN_CALL_MS, PROVENANCE_BASES, REAL_CLOCK, YES, NO, allowsPage, clockLine, pageBlock, reconstructMemory, record, settleBefore, stableAlias, ternary } from './egdesk-wiki-reconstruction.mjs'

// PROTOTYPE (not wired into the turn path): what the system does with a turn's memory, by turn position.
//
//   FIRST turn of a session (the answering model holds no live conversation): reconstruct memory from the wiki.
//   MID-SESSION (the conversation is alive in the answering model's context): do NOT reconstruct. Fetch only what the
//     next judgment needs, from the runtime-enumerated candidates minus what the live context already holds (receipts).
//   EVERY turn: a system judgment whether this turn's content should enter the ontology, over runtime options
//     (existing candidate pages, "new page", "do not add"). It produces a PROPOSAL; only the host's write path stores,
//     and only after its flag, permission and revision checks. Never a prompt to the person.
// Speech time/provenance for a recorded utterance come from the ISOLATED axes design (each sentence quoted in its own
// questions, real call 2026-11-24: 3 of 6 labels installed, 0 wrong, predicates not needed).

/**
 * Turn position from real runtime facts, not from the message. Unknown or doubtful means 'first': reconstructing again
 * costs tokens (receipts limit that), assuming a live context that is gone would cost the answer.
 *  - threadId: the existing native thread (absent on a brand-new conversation)
 *  - priorCompletedTurns: completed turns the store has for it
 *  - startsFreshThread: this turn will call thread/start (not thread/resume)
 *  - compacted: the host knows the native context was compacted (no signal is wired today; see markContextCompacted)
 *  - resumed: the thread was restored with its history (thread/resume), which keeps the context
 */
export function deriveTurnPosition({ threadId = null, priorCompletedTurns = 0, startsFreshThread = false, compacted = false, resumed = false } = {}) {
  if (typeof threadId !== 'string' || !threadId) return { kind: 'first', reason: 'no_native_thread' }
  if (startsFreshThread) return { kind: 'first', reason: 'fresh_native_thread' }
  if (!(Number.isSafeInteger(priorCompletedTurns) && priorCompletedTurns > 0)) return { kind: 'first', reason: 'no_prior_turns' }
  if (compacted) return { kind: 'first', reason: 'context_compacted' }
  return { kind: 'mid', reason: resumed ? 'resumed_thread_with_history' : 'live_thread' }
}

/** Receipts count only for the same native thread and only mid-session; anything else is "the model may not hold it". */
export function usableReceipts(delivered, position, threadKey) {
  const ok = position?.kind === 'mid' && record(delivered) && delivered.usable === true && delivered.threadKey === threadKey && typeof threadKey === 'string'
  return ok ? delivered : { usable: false, pages: {}, threadKey: threadKey ?? null }
}

// Held pages by title only, or (heldDigest) with their status and the start of their content, so "does the held material already cover this"
// can actually be judged. With titles alone the judge cannot know what a title leaves out (real run: "그럼 롤백 조건은?" got need 0.02
// although the rollback page was not held).
const heldBlock = (titles, digest) => (Array.isArray(digest) && digest.length
  ? digest.map(h => `- ${compactText(h.title, 120)} | status=${h.status}\n  ${compactText(h.excerpt, 200)}`).join('\n')
  : titles.length ? titles.map(t => `- ${compactText(t, 120)}`).join('\n') : '(nothing)')
// The stored pages that are NOT held, by title only. Without it the judge cannot tell whether anything relevant exists beyond what is held: the
// first end-to-end run answered need 0.02 for "아까 jev hook 흐름 다시 정리해줘" because the held pages looked related, while the page that
// actually holds the flow (not held) was invisible to it. Complete means every readable non-held page is listed.
export const CATALOG_LIMIT = 80
const catalogBlock = list => (list.length ? list.slice(0, CATALOG_LIMIT).map(p => `- ${compactText(p.title, 90)} | time=${p.time} | status=${p.status}`).join('\n') + (list.length > CATALOG_LIMIT ? `\n(${list.length - CATALOG_LIMIT} more stored pages are not listed)` : '') : '(none)')
/**
 * The one rule that decides whether the mid-session fetch is skipped, from a triage result (also applied by the measurement scorer to real answers).
 * A decided courtesy "yes" skips. A decided need "no" skips only when the held content AND the complete list of other stored pages were shown and
 * recall is a decided "no". Anything else fetches.
 */
export function triageSkipsFetch(triage, { skipOnNeed = true, heldExcerpts = true } = {}) {
  if (triage?.courtesy?.state === 'yes') return true
  return skipOnNeed !== false && heldExcerpts !== false && triage?.catalog?.complete === true && triage?.recall?.state === 'no' && triage?.need?.state === 'no'
}
const TRIAGE_RULES = ['You are a system judge deciding what stored memory a turn needs. Judge only from the message, the list of what the answering model already holds, the titles of the stored pages that are not held, and any live conversation shown. Never invent anything.',
  'A title tells you the topic of a stored page, not everything in it. The held list shows the start of each held page.'].join('\n')
/**
 * One small call, independent yes/no questions (held pages with their start; the other stored pages by title only):
 *  - tn_courtesy: is the message only thanks, a greeting, an acknowledgement or other small talk? (a plain social-act question;
 *    the first real run answered "does it need stored material?" with 1.0 for "고마워", so the skip no longer rests on that question)
 *  - tn_need: does it ask for or report something the held pages do not already cover?
 *  - tn_recall: does the message point back to earlier material and ask for it to be recalled, summarized or re-organized? (a request like that
 *    cannot be judged covered from the start of a few held pages; real run: need 0.02 although the page holding the flow was not held)
 *  - tn_record: is it worth keeping as a record?
 * The fetch is skipped on a decided courtesy "yes", or on a decided need "no" only when the held content AND the complete list of the other stored
 * pages were shown and recall is a decided "no". Undecided or failed answers, a truncated list or a recall request always fetch.
 */
export async function triageTurn({ message, heldTitles = [], heldDigest = null, stored = null, live = null, client, askedAt = null, signal, timeoutMs = 2000 } = {}) {
  const questions = [
    predicateQuestion('tn_courtesy', 'Is the message only a courtesy: thanks, a greeting, an acknowledgement or other social small talk, with no question, request, report or decision in it?'),
    predicateQuestion('tn_need', Array.isArray(stored)
      ? 'Does the message ask for, or report, something that the held pages and the conversation do not already cover, so that stored pages that are not held (listed below, titles only) would help the answering model decide, verify or do what the message calls for?'
      : 'Does the message ask for, or report, something that the held pages and the conversation do not already cover, so that stored notes or documents beyond the held ones would improve the answer?'),
    ...(Array.isArray(stored) ? [predicateQuestion('tn_recall', 'Does the message point back to something discussed or worked on earlier (for example by saying "earlier", "last time" or "again") and ask for it to be recalled, summarized or re-organized, rather than ask for one new fact or one narrow detail?')] : []),
    predicateQuestion('tn_record', 'Does this message state something worth keeping as a record: a new fact, a decision, a plan, or a change in the status of something already recorded? Greetings, thanks, small talk and pure questions are not.'),
  ]
  const input = [{ role: 'developer', content: TRIAGE_RULES },
    { role: 'user', content: `Held in the answering model's context:\n${heldBlock(heldTitles, heldDigest)}` },
    ...(Array.isArray(stored) ? [{ role: 'user', content: `Stored pages that are not held (titles only):\n${catalogBlock(stored)}` }] : []),
    ...(typeof live === 'string' && live.trim() ? [{ role: 'user', content: `Live conversation (recent turns, bounded):\n${live.slice(-3000)}` }] : []),
    { role: 'user', content: `${clockLine(askedAt)}\nMessage:\n${message}` }]
  try {
    const result = await client.decide({ input, questions, timeoutMs, signal })
    return { status: 'ready', courtesy: ternary(result.answers?.tn_courtesy), need: ternary(result.answers?.tn_need), recall: ternary(result.answers?.tn_recall), record: ternary(result.answers?.tn_record),
      catalog: Array.isArray(stored) ? { listed: Math.min(stored.length, CATALOG_LIMIT), complete: stored.length <= CATALOG_LIMIT } : null, usage: result.usage ?? null }
  } catch (error) { return { status: 'fallback', reason: error?.code ?? 'unreachable', courtesy: { state: 'unknown', p: null }, need: { state: 'unknown', p: null }, recall: { state: 'unknown', p: null }, record: { state: 'unknown', p: null }, catalog: null, usage: null } }
}

const WRITE_RULES = [
  'You are a system judge deciding whether a message should be added to the stored ontology. You choose among the listed options only.',
  'Options are existing pages, a new page, or no addition. Thanks, greetings, small talk and questions are not recorded.',
  'A message that reports a plan as done is a status change of that plan page, not a new fact. A relayed statement stays attributed. Never invent a page.',
].join('\n')

const SLICE_OF = Object.freeze({ past_anchored: 'past', past_unspecified: 'past', at_utterance: 'present', ongoing_no_end: 'present', future_anchored: 'planned', future_unspecified: 'planned' })
/**
 * Labels (isolated axes, installed only above their bars) -> the page attributes of a recorded utterance.
 * Nothing is forced: an axis that was not installed stays unknown. No calendar value is computed here.
 */
export function recordFromLabels(label) {
  const form = label?.form ?? 'unknown', time = label?.time ?? 'unknown', source = label?.source ?? 'unknown'
  const slice = form === 'plan' ? 'planned' : form === 'conditional' ? 'hypothetical' : form === 'assertion' ? (SLICE_OF[time] ?? 'unknown') : 'unknown'
  const status = form === 'plan' ? 'plan' : form === 'assertion' && slice === 'past' ? 'done' : 'unknown'
  const kind = source === 'attributed_report' ? 'reported_by_other' : 'utterance'
  const basis = PROVENANCE_BASES.includes(source) ? source : null
  return { slice, status, provenance: { kind, by: 'user', ...(basis ? { basis } : {}) }, form, recordable: form !== 'question' }
}

/** Labels of one utterance (one entry per sentence) merged the same way the write judgment merges them, and the page attributes they give. */
export function mergeSpeechLabels(interpretations) {
  const labels = mergedLabels(interpretations)
  return { labels, record: recordFromLabels(labels) }
}

function mergedLabels(interpretations) {
  const usable = interpretations.filter(k => k.form !== 'question')
  if (!usable.length) return { source: 'unknown', form: interpretations.some(k => k.form === 'question') ? 'question' : 'unknown', time: 'unknown' }
  const same = axis => usable.every(k => k[axis] === usable[0][axis]) ? usable[0][axis] : 'unknown'
  return { source: same('source'), form: same('form'), time: same('time') }
}

/**
 * judgeTurnWrite({ message, candidates, client, askedAt, signal, timeoutMs, maxCandidates }) -> { proposal, receipt }
 * candidates: pages (already permission-filtered by the caller). One stateless call: which page/new/none, which candidates
 * the new page relates to, and the isolated speech axes for each sentence. The proposal carries no text and is not applied.
 */
export async function judgeTurnWrite({ message, candidates = [], client, askedAt = null, signal, timeoutMs = 3000, maxCandidates = 8 } = {}) {
  const pages = candidates.slice(0, maxCandidates)
  const spans = speechSegments(message)
  const none = (reason, extra = {}) => ({ proposal: { op: 'none', reason }, receipt: { reason, ...extra } })
  if (!client || typeof message !== 'string' || !message.trim()) return none('not_configured')
  const options = [...pages.map((p, i) => ({ value: stableAlias(i), description: `Record this as a status change of page ${stableAlias(i)}.` })),
    { value: 'new', description: 'Add a new page for this message.' }, { value: 'none', description: 'Do not add anything.' },
    { value: 'unsure', description: 'The options do not fit, or it cannot be told.' }]
  const questions = [choiceQuestion('tw_target', 'Where should this message be recorded?', options),
    choiceQuestion('tw_status', 'If the message says anything about the state of a plan or task, what state does it give?', [
      { value: 'done', description: 'It was carried out, finished or settled.' }, { value: 'plan', description: 'It is intended or scheduled, not done.' },
      { value: 'unknown', description: 'The message gives no state, or it cannot be told.' }]),
    ...pages.map((_, i) => predicateQuestion(`tw_link_${i}`, `If a new page is added, is it about the same task or case as page ${stableAlias(i)}?`)),
    ...speechDesignQuestions('axes-isolated', spans, message)]
  const input = [{ role: 'developer', content: WRITE_RULES },
    { role: 'user', content: `Candidate pages:\n${pages.length ? pages.map((p, i) => pageBlock(stableAlias(i), p, 500)).join('\n\n') : '(none)'}` },
    { role: 'user', content: `${clockLine(askedAt)}\nMessage:\n${message}` }]
  let result
  try { result = await client.decide({ input, questions, timeoutMs, signal }) } catch (error) { return none('judge_failed', { code: error?.code ?? 'unreachable' }) }
  const target = readChoice(result.answers, 'tw_target', { minConfidence: 0.75, minMargin: 0.2 })
  // One entry per sentence that got at least one label above its bar: offsets and label words only, never text, scores or runner-ups.
  const installed = speechDesignInterpretations('axes-isolated', result.answers, spans)
  const labels = mergedLabels(installed)
  const rec = recordFromLabels(labels)
  const said = readChoice(result.answers, 'tw_status', { minConfidence: 0.75, minMargin: 0.2 })
  if (said.state === 'accepted' && (said.value === 'done' || said.value === 'plan')) rec.status = said.value // a three-way state question; the axes decide time and provenance
  // Numbers only (never the option labels): the winner and runner-up probabilities and how many options there were.
  const rows = (Array.isArray(result.answers?.tw_target?.probabilities) ? result.answers.tw_target.probabilities : []).map(r => r?.probability).filter(Number.isFinite).sort((x, y) => y - x)
  const receipt = { target: { value: target.state === 'accepted' ? target.value : null, confidence: target.confidence, margin: target.margin, top: rows[0] ?? null, second: rows[1] ?? null, options: options.length }, labels, spans: installed, sentences: spans.length, status: said.state === 'accepted' ? said.value : null, usage: result.usage ?? null, questions: questions.length }
  if (target.state !== 'accepted' || target.value === 'none' || target.value === 'unsure') return { proposal: { op: 'none', reason: target.state !== 'accepted' ? 'target_undecided' : target.value === 'none' ? 'not_recorded' : 'unsure' }, receipt }
  if (!rec.recordable) return { proposal: { op: 'none', reason: 'question' }, receipt }
  const spokenAt = Number.isSafeInteger(askedAt) ? new Date(askedAt).toISOString() : null
  if (target.value === 'new') {
    if (rec.slice === 'unknown') return { proposal: { op: 'none', reason: 'time_slice_unclear' }, receipt }
    const links = pages.map((p, i) => ({ p, i })).filter(({ i }) => ternary(result.answers?.[`tw_link_${i}`]).state === 'yes').map(({ p }) => ({ type: 'same_task', to: p.id }))
    return { proposal: { op: 'new_page', time: { slice: rec.slice }, status: rec.status, provenance: rec.provenance, links, spokenAt }, receipt }
  }
  const index = pages.findIndex((_, i) => stableAlias(i) === target.value)
  const page = pages[index]
  if (!page) return { proposal: { op: 'none', reason: 'target_unknown' }, receipt }
  if (rec.status !== 'plan' && rec.status !== 'done') return { proposal: { op: 'none', reason: 'status_unclear' }, receipt }
  return { proposal: { op: 'update_status', pageId: page.id, baseRevision: page.revision, proposedStatus: rec.status, time: { slice: rec.slice }, provenance: rec.provenance, spokenAt }, receipt }
}

const OPS = new Set(['none', 'new_page', 'update_status'])
const STATUS = new Set(['plan', 'done'])
const SLICES = new Set(['past', 'present', 'planned', 'hypothetical'])
// agent_note: the host's own record (a finished browser task), not something the person said; stored with by: 'browser_task'.
const KINDS = new Set(['utterance', 'reported_by_other', 'agent_note'])
// Numeric revisions count up; any other revision (a store's own hash) gets a ".rN" counter, which stays inside the wiki's revision alphabet.
const nextRevision = revision => (/^\d+$/.test(revision) ? String(Number(revision) + 1) : /\.r\d+$/.test(revision) ? revision.replace(/\.r(\d+)$/, (_, n) => `.r${Number(n) + 1}`) : `${revision}.r1`)
const fingerprint = (proposal, message) => sha256Hex(JSON.stringify([proposal, createHash('sha256').update(String(message ?? '')).digest('hex')]))

/**
 * createWikiWriter(wiki, { enabled = false, canWrite, acceptStatus, idFor })
 * The only place a proposal becomes a stored page. Off by default. Checks, in order: flag, strict re-validation of the
 * proposal (the judge's shape is never trusted), the host's write permission for that page/scope, the revision the judge
 * saw, idempotency by operationId. A status change is stored as a PENDING reading on the page, apart from its status, and
 * NEVER promotes by itself. The only way to a status is promote(): the host rule "the person's own later explicit confirmation"
 * (documented below). `acceptStatus` is accepted for backward compatibility and deliberately ignored: no policy callback can
 * auto-promote a model's reading. The body of a new page is the person's own message text, supplied by the host; the judge never writes text.
 */
export function createWikiWriter(wiki, { enabled = false, canWrite = () => false, acceptStatus = () => false, idFor = null, persist = null } = {}) {
  const done = new Map()
  return {
    apply(proposal, { message = null, messageRef = null, scope = null, operationId = null } = {}) {
      if (enabled !== true) return { status: 'disabled' }
      if (!record(proposal) || !OPS.has(proposal.op)) return { status: 'invalid' }
      if (proposal.op === 'none') return { status: 'noop' }
      if (typeof operationId !== 'string' || !operationId) return { status: 'invalid', reason: 'operation_id_required' }
      const print = fingerprint(proposal, message)
      const key = `${scope?.writeScope ?? ''}\u0000${operationId}`
      const earlier = done.get(key)
      if (earlier) return earlier.print === print ? { ...earlier.receipt, replay: true } : { status: 'conflict', reason: 'operation_reused' }
      const finish = receipt => { if (receipt.status === 'stored' || receipt.status === 'recorded_pending' || receipt.status === 'status_updated') done.set(key, { print, receipt }); return receipt }
      const provenance = proposal.provenance
      if (!KINDS.has(provenance?.kind) || (provenance.basis !== undefined && !PROVENANCE_BASES.includes(provenance.basis)) || !SLICES.has(proposal.time?.slice)) return { status: 'invalid' }
      try {
        if (proposal.op === 'update_status') {
          const page = wiki.pages.get(proposal.pageId)
          if (!page || !STATUS.has(proposal.proposedStatus) || typeof proposal.baseRevision !== 'string') return { status: 'invalid' }
          if (canWrite({ op: 'update_status', page, scope }) !== true) return { status: 'denied' }
          if (page.revision !== proposal.baseRevision) return { status: 'conflict', reason: 'revision_changed', currentRevision: page.revision }
          const reading = { status: proposal.proposedStatus, state: 'pending', basis: provenance.basis ?? null, ...(typeof proposal.spokenAt === 'string' ? { spokenAt: proposal.spokenAt } : {}) }
          const revision = nextRevision(page.revision)
          const stored = reading
          // Persist first: a store that cannot keep the reading means nothing changed.
          if (typeof persist === 'function') persist({ kind: 'reading', pageId: page.id, sourceRevision: page.revision.replace(/\.r\d+$/, ''), reading: stored, revision })
          const patched = wiki.patch(page.id, { statusReadings: [...page.statusReadings, stored], revision })
          if (!patched) return { status: 'invalid', reason: 'write_failed' }
          return finish({ status: 'recorded_pending', pageId: page.id, revision })
        }
        // new_page
        if (typeof message !== 'string' || !message.trim() || message.length > 2000) return { status: 'invalid', reason: 'message_required' }
        if (canWrite({ op: 'new_page', page: null, scope }) !== true) return { status: 'denied' }
        const id = typeof idFor === 'function' ? idFor({ operationId, scope })
          : provenance.kind === 'agent_note' && operationId.startsWith('browser-task:') ? `browser-task/${operationId.slice(13).replace(/[^A-Za-z0-9._-]/g, '-')}` : `memo/${sha256Hex(key).slice(0, 16)}`
        const links = (Array.isArray(proposal.links) ? proposal.links : []).filter(l => record(l) && wiki.pages.has(l.to) && allowsPage(wiki.pages.get(l.to), scope))
        if (wiki.pages.has(id)) return { status: 'conflict', reason: 'page_exists' }
        // messageRef: the person's words already live in the chat store under this reference, so the page keeps the reference, not another copy.
        const viaRef = typeof messageRef === 'string' && messageRef.trim() !== ''
        const raw = { id, title: compactText(message, 40), body: message, revision: '1', ...(viaRef ? { ref: messageRef } : {}), time: { slice: proposal.time.slice },
          provenance: { kind: provenance.kind, by: provenance.kind === 'agent_note' ? 'browser_task' : 'user', ...(provenance.basis ? { basis: provenance.basis } : {}) }, status: STATUS.has(proposal.status) ? proposal.status : 'unknown',
          scope: scope?.writeScope ?? null, ...(typeof proposal.spokenAt === 'string' ? { spokenAt: proposal.spokenAt } : {}), links }
        if (typeof persist === 'function') persist({ kind: 'page', page: raw, viaRef })
        const page = wiki.add(raw)
        if (!page) return { status: 'invalid', reason: 'write_failed' }
        return finish({ status: 'stored', pageId: page.id, revision: page.revision })
      } catch { return { status: 'invalid', reason: 'write_failed' } }
    },
    /**
     * promote(pageId, { scope, confirmation, operationId }) — the ONE host rule that turns a pending reading into the page's status:
     * the person's own later, explicit confirmation. `confirmation` must be { by: 'user', at: ISO } where `at` is after the reading was
     * made (the person confirms something they have seen, not something said in the same breath), and the host must have captured it from
     * a real user action (this function cannot check that; it only refuses anything that is not literally by: 'user'). The model's score,
     * the judge, another agent or a policy callback cannot promote. The latest pending reading is the one promoted; the status is the
     * reading's own (plan or done), the revision moves, the accepted reading replaces the pending one.
     */
    promote(pageId, { scope = null, confirmation = null, operationId = null } = {}) {
      if (enabled !== true) return { status: 'disabled' }
      if (typeof operationId !== 'string' || !operationId) return { status: 'invalid', reason: 'operation_id_required' }
      const key = `${scope?.writeScope ?? ''}\u0000promote\u0000${operationId}`
      const earlier = done.get(key)
      const print = sha256Hex(JSON.stringify([pageId, confirmation?.by ?? null, confirmation?.at ?? null]))
      if (earlier) return earlier.print === print ? { ...earlier.receipt, replay: true } : { status: 'conflict', reason: 'operation_reused' }
      try {
        const page = wiki.pages.get(pageId)
        if (!page) return { status: 'invalid' }
        if (!record(confirmation) || confirmation.by !== 'user' || typeof confirmation.at !== 'string' || Number.isNaN(Date.parse(confirmation.at))) return { status: 'invalid', reason: 'user_confirmation_required' }
        if (canWrite({ op: 'promote', page, scope }) !== true) return { status: 'denied' }
        const index = page.statusReadings.map(r => r.state).lastIndexOf('pending')
        if (index < 0) return { status: 'invalid', reason: 'no_pending_reading' }
        const reading = page.statusReadings[index]
        if (typeof reading.spokenAt === 'string' && !(Date.parse(confirmation.at) > Date.parse(reading.spokenAt))) return { status: 'invalid', reason: 'confirmation_not_later' }
        const accepted = { ...reading, state: 'accepted', confirmedAt: confirmation.at }
        const revision = nextRevision(page.revision)
        if (typeof persist === 'function') persist({ kind: 'reading', pageId: page.id, sourceRevision: page.revision.replace(/\.r\d+$/, ''), reading: accepted, revision })
        const readings = page.statusReadings.map((r, i) => (i === index ? accepted : r))
        if (!wiki.patch(page.id, { statusReadings: readings, revision, status: accepted.status })) return { status: 'invalid', reason: 'write_failed' }
        const receipt = { status: 'status_updated', pageId: page.id, revision }
        done.set(key, { print, receipt })
        return receipt
      } catch { return { status: 'invalid', reason: 'write_failed' } }
    },
  }
}

/**
 * prepareTurnMemory({ message, wiki, client, scope, askedAt, position, delivered, threadKey, live, budget, ontologyWrite, deadlineMs, packetFirst })
 * Flag `ontologyWrite` (default false): whether the per-turn write judgment runs at all.
 * -> { position, triage, memory, packet, nextDelivered(), judgeWrite() -> Promise<{ proposal, receipt }> | null }
 * judgeWrite is a thunk so the host can run it after the answer started: the packet does not depend on it.
 * deadlineMs (optional, from this call): the time the packet may take. The loop stops itself and returns what it has (memory.partial).
 * packetFirst (optional, first turn only): return as soon as the packet is ready; the triage that only decides recording keeps running and is
 *   awaited inside judgeWrite (triage is then null in the result and `triageLater` is its promise). It is not bound by the packet deadline.
 */
export async function prepareTurnMemory({ message, wiki, client, scope = null, askedAt = null, position, delivered = null, threadKey = null, live = null, budget = {}, ontologyWrite = false, skipOnNeed = true, heldExcerpts = true, signal, deadlineMs = null, packetFirst = false, clock = REAL_CLOCK } = {}) {
  // The deadline is ONE point on ONE clock, fixed here. Everything below asks that clock; a timer only wakes the wait up.
  const deadlineAt = Number.isFinite(deadlineMs) ? clock.now() + Math.max(0, deadlineMs) : null
  const remaining = () => (deadlineAt === null ? null : Math.max(0, deadlineAt - clock.now()))
  const loopBudget = () => (deadlineAt === null ? budget : { ...budget, deadlineAt })
  const minCallMs = Number.isFinite(budget?.minCallMs) ? budget.minCallMs : MIN_CALL_MS
  const pos = position?.kind === 'mid' ? position : { kind: 'first', reason: position?.reason ?? 'unspecified' }
  const receipts = usableReceipts(delivered, pos, threadKey)
  const heldPages = Object.keys(receipts.pages ?? {}).map(id => wiki.pages.get(id)).filter(p => p && allowsPage(p, scope))
  // Held AND unchanged: the receipt's revision and content key still match the page as it is now (the loop's own test of "already delivered").
  const heldSame = heldPages.filter(p => receipts.pages[p.id]?.revision === p.revision && receipts.pages[p.id]?.hash === (p.contentKey ?? sha256Hex(p.body))).map(p => p.id)
  const heldDigest = heldExcerpts !== false ? heldPages.map(p => ({ title: p.title, status: p.status, excerpt: p.body })) : null
  // Mid-session triage also sees what else is stored (titles only). The first-turn triage only decides recording, so it does not carry the list.
  const heldIds = new Set(heldPages.map(p => p.id))
  const stored = pos.kind === 'mid' ? [...wiki.pages.values()].filter(p => !heldIds.has(p.id) && allowsPage(p, scope)).map(p => ({ title: p.title, time: p.time.slice, status: p.status })) : null
  // A triage that gates the fetch (mid-session) is bound by the packet deadline; one that only decides recording (first turn) is not.
  // Without a deadline the old 2 s limit stays. A cold first request took 1.6-2.2 s in the real runs, so a deadline run allows up to 4 s.
  const triageTimeout = () => (remaining() === null ? 2000 : pos.kind === 'mid' ? Math.max(1, Math.min(4000, Math.ceil(remaining()))) : 4000)
  const triageCall = () => triageTurn({ message, heldTitles: heldPages.map(p => p.title), heldDigest, stored, live: pos.kind === 'mid' ? live : null, client, askedAt, signal, timeoutMs: triageTimeout() })
  let triage, memory, triageLater = null
  if (pos.kind === 'mid') {
    // Under a deadline: a triage that cannot be asked in what is left, or has not answered when the clock reaches the deadline, is cut. The
    // deadline is then authoritative: NO fetch is started after it (not even when a clock or timer reading says a moment is left). The old
    // code cut with a timer and asked the clock what was left; a timer can fire up to a millisecond early, and that leftover started a fetch.
    let cutByDeadline = false
    const cut = () => { cutByDeadline = true; return { status: 'fallback', reason: 'timeout', courtesy: { state: 'unknown', p: null }, need: { state: 'unknown', p: null }, recall: { state: 'unknown', p: null }, record: { state: 'unknown', p: null }, catalog: null, usage: null } }
    triage = deadlineAt === null ? await triageCall() : remaining() < minCallMs ? cut() : await settleBefore(triageCall(), deadlineAt, clock).catch(cut)
    // A decided courtesy "yes" skips the fetch. A decided need "no" skips it too, but only when ALL of these hold: the held pages' content was shown
    // (titles alone gave a wrong need 0.02 for T4), the complete list of the other stored pages was shown, and recall is a decided "no" (a request to
    // go over earlier material cannot be judged covered from a few held pages: the j-mid wrong skip). Anything else fetches: a wrong skip loses
    // material, a needless fetch only costs tokens.
    memory = cutByDeadline ? { status: 'empty', partial: true, reason: 'deadline', packet: null, picks: [], calls: 0, receipts: { mode: 'next', calls: 0, skippedDelivered: [], deadlineHit: true }, nextDelivered: () => receipts }
      : triageSkipsFetch(triage, { skipOnNeed, heldExcerpts }) ? { status: 'skipped', reason: 'nothing_needed', packet: null, picks: [], calls: 0, receipts: { mode: 'next', calls: 0, skippedDelivered: [] }, nextDelivered: () => receipts }
      : await reconstructMemory({ message, wiki, client, scope, askedAt, delivered: receipts, budget: loopBudget(), signal, clock, mode: 'next', live })
  } else if (packetFirst === true) {
    triageLater = ontologyWrite ? triageCall() : null
    triage = null
    memory = await reconstructMemory({ message, wiki, client, scope, askedAt, delivered: receipts, budget: loopBudget(), signal, clock, mode: 'first' })
  } else {
    ;[triage, memory] = await Promise.all([ontologyWrite ? triageCall() : Promise.resolve(null),
      reconstructMemory({ message, wiki, client, scope, askedAt, delivered: receipts, budget: loopBudget(), signal, clock, mode: 'first' })])
  }
  // What the model holds is known from the receipts, whether or not the fetch ran (a skipped fetch has no skippedDelivered list).
  const heldNow = [...new Set([...heldPages.map(p => p.id), ...(memory.receipts?.skippedDelivered ?? [])])]
  const nextDelivered = () => ({ ...memory.nextDelivered(), threadKey })
  let judgeWrite = null
  const writeCandidates = () => [...new Set([...memory.picks.map(p => p.id), ...heldNow])].map(id => wiki.pages.get(id)).filter(p => p && allowsPage(p, scope))
  if (ontologyWrite === true && triageLater) {
    // The recording triage is still running: the thunk waits for it, and judges only when it says the turn is worth recording.
    judgeWrite = async () => {
      const late = await triageLater
      if (late?.record?.state !== 'yes') return { proposal: { op: 'none', reason: 'not_worth_recording' }, receipt: { triage: late } }
      const judged = await judgeTurnWrite({ message, candidates: writeCandidates(), client, askedAt, signal })
      return { ...judged, receipt: { ...judged.receipt, triage: late } }
    }
  } else if (ontologyWrite === true && triage?.record?.state === 'yes') {
    judgeWrite = () => judgeTurnWrite({ message, candidates: writeCandidates(), client, askedAt, signal })
  }
  return { position: pos, triage, ...(triageLater ? { triageLater } : {}), memory, packet: memory.packet ?? null, held: heldSame, nextDelivered, judgeWrite,
    writeSkipped: ontologyWrite !== true ? 'flag_off' : triageLater ? null : triage?.record?.state !== 'yes' ? 'not_worth_recording' : null }
}

// ---- the turn's memory materials as DATA (for system judges and other consumers; the packet text is for the answering model) ----
export const MATERIAL_KINDS = Object.freeze(['board', 'source', 'ontology', 'timeline', 'utterance', 'conversation', 'page'])
export const MATERIAL_LINK_TYPES = Object.freeze(['same_task', 'follows_from', 'decided_in', 'supersedes', 'refers_to', 'superseded_by'])
export const MATERIAL_LIMITS = Object.freeze({ max: 12, hardMax: 24, excerptChars: 400, maxExcerptChars: 2400, titleChars: 160, links: 8 })
const materialKind = page => (typeof page.ref === 'string' && page.ref.startsWith('chat-message:') ? 'utterance' : typeof page.ref === 'string' && page.ref.startsWith('chat-pair:') ? 'conversation'
  : page.id.startsWith('board:') ? 'board' : page.id.startsWith('selected:') ? 'source' : page.id.startsWith('ontology-snapshot:') ? 'timeline' : page.id.startsWith('ontology:') ? 'ontology' : 'page')
const bounded = (value, fallback, low, high) => (Number.isSafeInteger(value) ? Math.min(high, Math.max(low, value)) : fallback)

/**
 * memoryMaterials(result, wiki, { scope, attached = true, excerptChars = 400, max = 12 }) -> frozen array, plain data only:
 *   [{ alias, kind, time: { slice, at }, provenance: { kind, by, basis }, status, statusReading?, statusPending?, title, excerpt, links: [{ type, toAlias }], held }]
 *
 * result: what prepareTurnMemory returned for this turn. wiki: the snapshot it ran on. scope: the same read scope.
 *   held false: the page is in this turn's packet (attached now). Listed first, in packet order. Left out when attached === false
 *               (the host did not send the packet), because the answering model then does not have them.
 *   held true:  the answering model already holds the page from an earlier turn of this thread (a real delivery receipt whose revision and
 *               content still match). It says NOTHING about whether the page matters for this message: nobody judged that.
 *   alias:      M1..Mn, valid inside this array only. No page id, reference, revision, score or probability leaves through here.
 *   status:     the recorded status. statusReading: the judge's fallible reading of the record (present only when one was accepted).
 *               statusPending: a reported status waiting for the person's confirmation. Neither is verification nor write permission.
 *   links:      between two listed materials only (toAlias always resolves). Recorded, outgoing: same_task | follows_from | decided_in |
 *               supersedes | refers_to. Derived: superseded_by (a listed, SETTLED record replaces this one now).
 * Permission is checked again here, page by page (allowsPage); a page that may not be read now is absent, and so are links to it.
 */
export function memoryMaterials(result, wiki, { scope = null, attached = true, excerptChars = MATERIAL_LIMITS.excerptChars, max = MATERIAL_LIMITS.max } = {}) {
  const none = Object.freeze([])
  try {
    if (!result || !wiki?.pages || typeof wiki.links !== 'function') return none
    const limit = bounded(max, MATERIAL_LIMITS.max, 0, MATERIAL_LIMITS.hardMax), chars = bounded(excerptChars, MATERIAL_LIMITS.excerptChars, 0, MATERIAL_LIMITS.maxExcerptChars)
    const picks = new Map((Array.isArray(result.memory?.picks) ? result.memory.picks : []).map(pick => [pick.id, pick]))
    const fresh = attached === true && result.memory?.status === 'ready' ? Object.keys(result.memory.delivered ?? {}) : []
    const heldIds = (Array.isArray(result.held) ? result.held : []).filter(id => !fresh.includes(id))
    const rows = []
    for (const [id, held] of [...fresh.map(id => [id, false]), ...heldIds.map(id => [id, true])]) {
      if (rows.length >= limit) break
      const page = wiki.pages.get(id)
      if (!page || !allowsPage(page, scope)) continue
      rows.push({ page, held })
    }
    const aliasOf = new Map(rows.map((row, index) => [row.page.id, `M${index + 1}`]))
    return Object.freeze(rows.map(({ page, held }) => {
      const pick = picks.get(page.id)
      const pending = Array.isArray(page.statusReadings) ? page.statusReadings.filter(r => r?.state === 'pending').at(-1)?.status ?? null : null
      const links = []
      for (const link of wiki.links(page.id)) { if (links.length >= MATERIAL_LIMITS.links) break; if (aliasOf.has(link.to)) links.push(Object.freeze({ type: link.type, toAlias: aliasOf.get(link.to) })) }
      // Derived, not recorded: the listed pages that REPLACE this one now (a settled record that supersedes it). A plan that will supersede it
      // is not a replacement yet, so it shows only as that plan's own 'supersedes' link.
      for (const by of typeof wiki.supersededBy === 'function' ? wiki.supersededBy(page.id) : []) { if (links.length >= MATERIAL_LIMITS.links) break; if (aliasOf.has(by)) links.push(Object.freeze({ type: 'superseded_by', toAlias: aliasOf.get(by) })) }
      return Object.freeze({ alias: aliasOf.get(page.id), kind: materialKind(page),
        time: Object.freeze({ slice: page.time.slice, at: typeof page.time.at === 'string' ? page.time.at.slice(0, 10) : null }),
        provenance: Object.freeze({ kind: page.provenance.kind, by: page.provenance.by ?? null, basis: page.provenance.basis ?? null }),
        status: page.status, ...(!held && typeof pick?.statusRead === 'string' ? { statusReading: pick.statusRead } : {}), ...(typeof pending === 'string' ? { statusPending: pending } : {}),
        title: compactText(page.title, MATERIAL_LIMITS.titleChars), excerpt: page.body.length > chars ? `${page.body.slice(0, chars).trimEnd()} […]` : page.body,
        links: Object.freeze(links), held })
    }))
  } catch { return none }
}
