import { createHash } from 'node:crypto'
import { NUNCHI_KEY, NUNCHI_LIMITS, directiveFor, judgeNunchi, nunchiContextText } from './egdesk-nunchi.mjs'
import { REAL_CLOCK, settleBefore } from './egdesk-wiki-reconstruction.mjs'
import { createUserGuidanceStore } from './egdesk-user-guidance.mjs'

// L7 u1 (U17): the runtime side of the nunchi (egdesk-nunchi.mjs), kept out of codex-chat-runtime.mjs: three small calls there (begin, settle, note). Everything here is off unless the bridge
// composes decisionContext.nunchi (flag EGDESK_NUNCHI=on), and nothing here can fail a turn.
//   beginNunchi(rt, body, context)      at the start of the turn, beside the memory loop: the judgment of the person's reaction (one request)
//   settleNunchi(rt, job, context)      before the engine starts, within the turn-memory cap: the entry text for the engine (the person's applied guidance + this conversation's lines), or null
//   nunchiReceiptFor(rt, key)           the closed receipt of a turn (a context or a run)
// A reading that arrives after the cap does not hold the turn: it applies from the next turn of the conversation ("다음 답부터").
export { NUNCHI_KEY }
export const NUNCHI_CAPS = Object.freeze({ firstMs: 4000, midMs: 2500 }) // the turn-memory caps (TURN_MEMORY_CAPS); a test keeps them equal
const MAX_THREADS = 50

export function nunchiOn(rt) {
  try {
    const cfg = rt.decisionContext?.nunchi
    if (!cfg || (typeof cfg.enabled === 'function' ? cfg.enabled() : cfg.enabled) !== true) return false
    return rt.decisionContext.mode?.() === 'on' && rt.decisionContext.configured?.() === true && Boolean(rt.decisionContext.client)
  } catch { return false }
}

const stateOf = rt => (rt.nunchiState ??= new Map())
const receiptsOf = rt => (rt.nunchiReceipts ??= new WeakMap())
const linesOf = (rt, thread) => (stateOf(rt).get(thread) ?? []).map(e => e.line)
// What the guidance record holds of this conversation's instructions now: 'candidate' while one of them awaits the person, else 'applied' where the person applied one, else null
const recordStateOf = (rt, thread) => {
  try {
    const store = rt.decisionContext?.nunchi?.store
    const states = (stateOf(rt).get(thread) ?? []).map(e => (e.candidateId ? store?.get?.(e.candidateId)?.status : null)).filter(Boolean)
    return states.includes('candidate') ? 'candidate' : states.includes('applied') ? 'applied' : null
  } catch { return null }
}

/** The reading's effect: this conversation's line, and a durable candidate. Once per job. */
function applyReading(rt, job) {
  if (job.applied || !job.result || job.result.status !== 'ready') return
  job.applied = true
  const directive = directiveFor(job.result.reading)
  job.receipt.directive = directive ? { guidance: directive.guidance, value: directive.value } : null
  if (!directive) return
  const cfg = rt.decisionContext?.nunchi, map = stateOf(rt)
  const list = (map.get(job.thread) ?? []).filter(e => e.guidance !== directive.guidance)
  const item = { guidance: directive.guidance, line: directive.line, at: job.clock.now(), ref: job.ref, candidateId: null }
  list.push(item)
  map.delete(job.thread); map.set(job.thread, list.slice(-NUNCHI_LIMITS.conversationLines))
  while (map.size > MAX_THREADS) map.delete(map.keys().next().value)
  if (directive.durable && cfg?.store) {
    try {
      // the kind and strength of the record are the closed words of the strongest single readings (the merged reading decided that a change is asked)
      const reading = job.result.reading, strength = reading.strength ?? (reading.forceMass >= 0.95 ? 'strong' : 'clear')
      const entry = cfg.store.propose({ ...directive.durable, kind: reading.kind ?? 'change', strength: ['clear', 'strong'].includes(strength) ? strength : 'clear', sourceRef: job.ref, thread: String(job.thread ?? '') })
      job.receipt.candidate = entry ? { id: entry.id, status: entry.status, seen: entry.seen } : null
      item.candidateId = entry?.id ?? null
    } catch { job.receipt.candidate = null }
  }
}

// ---- receipts the person can look at (u3): closed words, numbers and ids only, never what anybody wrote ----
// A bounded ring of what the nunchi did on the latest turns, including the turns it did NOT start and why (real window 11-26 03:30: nothing happened and nothing said why). Memory only.
export const NUNCHI_RECENT = Object.freeze({ max: 20 })
const recentOf = rt => (rt.nunchiRing ??= [])
const tagOf = thread => createHash('sha256').update(String(thread ?? '')).digest('hex').slice(0, 8)
const remember = (rt, entry) => { const list = recentOf(rt); list.push(entry); while (list.length > NUNCHI_RECENT.max) list.shift() }
/** The closed form of a receipt (what the route returns). */
const closed = r => ({ at: r.at, conversation: r.conversation, engine: r.engine, position: r.position, started: r.started, reason: r.reason ?? null, status: r.status ?? null, inTime: r.inTime ?? null, late: r.late ?? null, withPrevious: r.withPrevious ?? null, ms: r.ms ?? null,
  reading: r.reading ? Object.fromEntries(['kind', 'change', 'changeMass', 'forceful', 'forceMass', 'about', 'strength', 'direction', 'language'].map(k => [k, r.reading[k] ?? null])) : null,
  directive: r.directive ?? null, candidate: r.candidate ?? null, lineSent: r.lineSent ?? null })
export const nunchiRecent = (rt, n = 5) => Object.freeze(recentOf(rt).slice(-Math.max(1, Math.min(NUNCHI_RECENT.max, Number.isSafeInteger(n) ? n : 5))).map(r => Object.freeze(closed(r))))

/**
 * Who the nunchi reads (u3). The person's reaction to what the assistant just did is the person's own message in a conversation with an engine: any conversation of the person's, an Agent DM or a plain
 * room chat (a project room with Claude), not a Board (several voices), not a stateless request. u1 and u2 copied the memory loop's rule (context.channelKind === 'direct'), which is true only for
 * an Agent DM: in a plain room chat the channel is null, so the judgment never started (real window 11-26 03:30, Claude, EGDESK_UPPER=on EGDESK_NUNCHI=on, mode 사용: no request, no candidate).
 */
export function nunchiEligible(body, context) {
  return !context.stateless && !context.board && body?.boardId == null && context.channelKind !== 'board'
}

export function beginNunchi(rt, body, context, { bounded = false } = {}) {
  try {
    if (!nunchiOn(rt)) return null
    const cfg = rt.decisionContext.nunchi, setup = rt.decisionContext
    const thread = typeof context.clientThreadId === 'string' && context.clientThreadId ? context.clientThreadId : typeof context.conversationId === 'string' && context.conversationId ? context.conversationId : null
    const clock = cfg.clock && typeof cfg.clock.now === 'function' ? cfg.clock : REAL_CLOCK
    const base = { at: Date.now(), conversation: tagOf(thread), engine: context.engine?.id ?? null, position: null }
    const skip = reason => { remember(rt, { ...base, started: false, reason }); return null }
    const message = typeof body?.message === 'string' ? body.message : ''
    if (bounded) return skip('bounded')
    const eligible = typeof cfg.eligible === 'function' ? cfg.eligible({ body, context }) === true : nunchiEligible(body, context)
    if (!eligible) return skip('not_eligible')
    if (!message.trim()) return skip('no_message')
    if (!thread) return skip('no_thread')
    const controller = new AbortController()
    let previousReply = null
    // the assistant message right before this turn, only where the egress gate allows the conversation's own messages (the answering model holds it too); else judged without it
    try { previousReply = rt.previousReplyFor(context, null, { ignoreFlag: true }) } catch { previousReply = null }
    const position = rt.turnPosition(context), capMs = position.kind === 'first' ? NUNCHI_CAPS.firstMs : NUNCHI_CAPS.midMs
    const job = { startedAt: clock.now(), clock, capMs, controller, thread, ref: typeof context.localMessageId === 'string' && context.localMessageId ? `chat-message:${context.localMessageId}` : null,
      result: null, applied: false, receipt: { ...base, position: position.kind, started: true, status: 'pending', inTime: false, late: false, withPrevious: previousReply !== null, ms: null, reading: null, directive: null, candidate: null, lineSent: null } }
    remember(rt, job.receipt)
    job.promise = judgeNunchi({ message, previousReply, client: setup.client, signal: controller.signal, timeoutMs: Math.min(NUNCHI_LIMITS.timeoutMs, capMs) })
      .then(result => { job.result = result; job.receipt.status = result.status; job.receipt.reason = result.reason ?? null; job.receipt.ms = Math.round(clock.now() - job.startedAt); job.receipt.reading = result.reading ?? null; return result }, () => null)
    return job
  } catch { return null }
}

/** The entry text without a judgment of this turn (flag off: null, synchronously: the turn pays nothing, not even an await): the person's applied guidance and this conversation's lines. */
export function standingNunchi(rt, context) {
  try {
    if (!nunchiOn(rt)) return null
    let standing = []
    try { standing = rt.decisionContext.nunchi.store?.appliedLines?.() ?? [] } catch { standing = [] }
    return nunchiContextText({ standing, conversation: linesOf(rt, context.clientThreadId), record: recordStateOf(rt, context.clientThreadId) })
  } catch { return null }
}

/** The entry text for this turn's engine context, or null. Waits for the judgment only until the turn-memory cap (measured from its start), never longer. Only called with a job. */
export async function settleNunchi(rt, job, context) {
  try {
    try { await settleBefore(job.promise, job.startedAt + job.capMs, job.clock) } catch { /* the cap */ }
    const inTime = job.result !== null && job.receipt.ms !== null && job.startedAt + job.receipt.ms < job.startedAt + job.capMs
    job.receipt.inTime = inTime
    if (inTime) applyReading(rt, job)
    else { job.receipt.late = true; void job.promise.then(() => applyReading(rt, job)) } // the next turn gets it
    receiptsOf(rt).set(context, job.receipt)
    context.nunchi = job.receipt
    const text = standingNunchi(rt, context)
    job.receipt.lineSent = text !== null
    return text
  } catch { return standingNunchi(rt, context) }
}

/** Links the receipt of a turn's context to its run once the run exists. */
export function noteNunchi(rt, run, context) {
  try { const r = receiptsOf(rt).get(context); if (r) receiptsOf(rt).set(run, r) } catch { /* never affects the turn */ }
}
export const nunchiReceiptFor = (rt, key) => { try { const r = key && typeof key === 'object' ? receiptsOf(rt).get(key) : null; return r ? Object.freeze({ ...r }) : null } catch { return null } }
/** The lines this conversation has now (closed text), for inspection and for dropping one. */
export const conversationGuidance = (rt, thread) => Object.freeze([...(stateOf(rt).get(thread) ?? [])].map(e => Object.freeze({ guidance: e.guidance, line: e.line, ref: e.ref })))
export function dropConversationGuidance(rt, thread, guidance) {
  const map = stateOf(rt), list = map.get(thread) ?? [], rest = list.filter(e => e.guidance !== guidance)
  if (rest.length === list.length) return false
  if (rest.length) map.set(thread, rest); else map.delete(thread)
  return true
}

/**
 * createNunchiConfig({ dataDir, flag, now, log }) -> { enabled(), store } (decisionContext.nunchi). flag: () => value of EGDESK_NUNCHI; on only when it is exactly 'on'.
 * The user guidance record opens lazily (nothing is created while the flag is off).
 */
export function createNunchiConfig({ dataDir, flag = () => process.env.EGDESK_NUNCHI, now = Date.now, log = () => {}, open } = {}) {
  let opened = null
  return Object.freeze({ enabled: () => { try { return flag() === 'on' } catch { return false } },
    get store() { return opened ??= (open ?? (() => createUserGuidanceStore({ dataDir, now, log })))() } })
}

export { nunchiRecent as recentNunchi }
