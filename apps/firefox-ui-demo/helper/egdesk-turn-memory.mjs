import { createHash } from 'node:crypto'
import { choiceQuestion, compactText, predicateQuestion, readChoice, sha256Hex } from './egdesk-decision-questions.mjs'
import { speechDesignInterpretations, speechDesignQuestions, speechSegments } from './egdesk-speech-grounding.mjs'
import { PROVENANCE_BASES, YES, NO, allowsPage, clockLine, pageBlock, reconstructMemory, record, stableAlias, ternary } from './egdesk-wiki-reconstruction.mjs'

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
const TRIAGE_RULES = 'You are a system judge deciding what stored memory a turn needs. Judge only from the message, the list of what the answering model already holds, and any live conversation shown. Never invent anything.'
/**
 * One small call, no page content, three independent yes/no questions:
 *  - tn_courtesy: is the message only thanks, a greeting, an acknowledgement or other small talk? (a plain social-act question;
 *    the first real run answered "does it need stored material?" with 1.0 for "고마워", so the skip no longer rests on that question)
 *  - tn_need: does it ask for or report something the held pages do not already cover?
 *  - tn_record: is it worth keeping as a record?
 * The fetch is skipped only on a decided courtesy "yes" (or, when the host opts in with skipOnNeed, a decided need "no"). Undecided or failed answers still fetch.
 */
export async function triageTurn({ message, heldTitles = [], heldDigest = null, live = null, client, askedAt = null, signal, timeoutMs = 2000 } = {}) {
  const questions = [
    predicateQuestion('tn_courtesy', 'Is the message only a courtesy: thanks, a greeting, an acknowledgement or other social small talk, with no question, request, report or decision in it?'),
    predicateQuestion('tn_need', 'Does the message ask for, or report, something that the held pages and the conversation do not already cover, so that stored notes or documents beyond the held ones would improve the answer?'),
    predicateQuestion('tn_record', 'Does this message state something worth keeping as a record: a new fact, a decision, a plan, or a change in the status of something already recorded? Greetings, thanks, small talk and pure questions are not.'),
  ]
  const input = [{ role: 'developer', content: TRIAGE_RULES },
    { role: 'user', content: `Held in the answering model's context:\n${heldBlock(heldTitles, heldDigest)}` },
    ...(typeof live === 'string' && live.trim() ? [{ role: 'user', content: `Live conversation (recent turns, bounded):\n${live.slice(-3000)}` }] : []),
    { role: 'user', content: `${clockLine(askedAt)}\nMessage:\n${message}` }]
  try {
    const result = await client.decide({ input, questions, timeoutMs, signal })
    return { status: 'ready', courtesy: ternary(result.answers?.tn_courtesy), need: ternary(result.answers?.tn_need), record: ternary(result.answers?.tn_record), usage: result.usage ?? null }
  } catch (error) { return { status: 'fallback', reason: error?.code ?? 'unreachable', courtesy: { state: 'unknown', p: null }, need: { state: 'unknown', p: null }, record: { state: 'unknown', p: null }, usage: null } }
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
  const labels = mergedLabels(speechDesignInterpretations('axes-isolated', result.answers, spans))
  const rec = recordFromLabels(labels)
  const said = readChoice(result.answers, 'tw_status', { minConfidence: 0.75, minMargin: 0.2 })
  if (said.state === 'accepted' && (said.value === 'done' || said.value === 'plan')) rec.status = said.value // a three-way state question; the axes decide time and provenance
  // Numbers only (never the option labels): the winner and runner-up probabilities and how many options there were.
  const rows = (Array.isArray(result.answers?.tw_target?.probabilities) ? result.answers.tw_target.probabilities : []).map(r => r?.probability).filter(Number.isFinite).sort((x, y) => y - x)
  const receipt = { target: { value: target.state === 'accepted' ? target.value : null, confidence: target.confidence, margin: target.margin, top: rows[0] ?? null, second: rows[1] ?? null, options: options.length }, labels, status: said.state === 'accepted' ? said.value : null, usage: result.usage ?? null, questions: questions.length }
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
 * saw, idempotency by operationId. A status change is stored as a PENDING reading on the page, apart from its status;
 * it becomes the status only if the host's acceptStatus policy says so. The body of a new page is the person's own
 * message text, supplied by the host; the judge never writes text.
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
          const promote = acceptStatus({ page, reading: { ...reading }, scope }) === true
          const stored = promote ? { ...reading, state: 'accepted' } : reading
          // Persist first: a store that cannot keep the reading means nothing changed.
          if (typeof persist === 'function') persist({ kind: 'reading', pageId: page.id, sourceRevision: page.revision.replace(/\.r\d+$/, ''), reading: stored, revision })
          const patched = wiki.patch(page.id, { statusReadings: [...page.statusReadings, stored], revision, ...(promote ? { status: reading.status } : {}) })
          if (!patched) return { status: 'invalid', reason: 'write_failed' }
          return finish({ status: promote ? 'status_updated' : 'recorded_pending', pageId: page.id, revision })
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
  }
}

/**
 * prepareTurnMemory({ message, wiki, client, scope, askedAt, position, delivered, threadKey, live, budget, ontologyWrite })
 * Flag `ontologyWrite` (default false): whether the per-turn write judgment runs at all.
 * -> { position, triage, memory, packet, nextDelivered(), judgeWrite() -> Promise<{ proposal, receipt }> | null }
 * judgeWrite is a thunk so the host can run it after the answer started: the packet does not depend on it.
 */
export async function prepareTurnMemory({ message, wiki, client, scope = null, askedAt = null, position, delivered = null, threadKey = null, live = null, budget = {}, ontologyWrite = false, skipOnNeed = false, heldExcerpts = false, signal } = {}) {
  const pos = position?.kind === 'mid' ? position : { kind: 'first', reason: position?.reason ?? 'unspecified' }
  const receipts = usableReceipts(delivered, pos, threadKey)
  const heldPages = Object.keys(receipts.pages ?? {}).map(id => wiki.pages.get(id)).filter(p => p && allowsPage(p, scope))
  const heldDigest = heldExcerpts === true ? heldPages.map(p => ({ title: p.title, status: p.status, excerpt: p.body })) : null
  const triageCall = () => triageTurn({ message, heldTitles: heldPages.map(p => p.title), heldDigest, live: pos.kind === 'mid' ? live : null, client, askedAt, signal })
  let triage, memory
  if (pos.kind === 'mid') {
    triage = await triageCall()
    // Only a decided courtesy "yes" skips the fetch. A decided need "no" skips it only when the host opted in (skipOnNeed): a wrong skip
    // loses material, a needless fetch only costs tokens, and the first real T4 run showed a wrong need "no" from titles alone.
    memory = triage.courtesy.state === 'yes' || (skipOnNeed === true && triage.need.state === 'no') ? { status: 'skipped', reason: 'nothing_needed', packet: null, picks: [], calls: 0, receipts: { mode: 'next', calls: 0, skippedDelivered: [] }, nextDelivered: () => receipts }
      : await reconstructMemory({ message, wiki, client, scope, askedAt, delivered: receipts, budget, signal, mode: 'next', live })
  } else {
    ;[triage, memory] = await Promise.all([ontologyWrite ? triageCall() : Promise.resolve(null),
      reconstructMemory({ message, wiki, client, scope, askedAt, delivered: receipts, budget, signal, mode: 'first' })])
  }
  // What the model holds is known from the receipts, whether or not the fetch ran (a skipped fetch has no skippedDelivered list).
  const heldNow = [...new Set([...heldPages.map(p => p.id), ...(memory.receipts?.skippedDelivered ?? [])])]
  const nextDelivered = () => ({ ...memory.nextDelivered(), threadKey })
  let judgeWrite = null
  if (ontologyWrite === true && triage?.record?.state === 'yes') {
    const ids = [...new Set([...memory.picks.map(p => p.id), ...heldNow])]
    const candidates = ids.map(id => wiki.pages.get(id)).filter(p => p && allowsPage(p, scope))
    judgeWrite = () => judgeTurnWrite({ message, candidates, client, askedAt, signal })
  }
  return { position: pos, triage, memory, packet: memory.packet ?? null, nextDelivered, judgeWrite,
    writeSkipped: ontologyWrite !== true ? 'flag_off' : triage?.record?.state !== 'yes' ? 'not_worth_recording' : null }
}
