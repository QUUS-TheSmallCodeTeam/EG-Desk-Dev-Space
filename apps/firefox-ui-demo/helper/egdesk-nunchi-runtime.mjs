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

/** The reading's effect: this conversation's line, and a durable candidate. Once per job. */
function applyReading(rt, job) {
  if (job.applied || !job.result || job.result.status !== 'ready') return
  job.applied = true
  const directive = directiveFor(job.result.reading)
  job.receipt.directive = directive ? { guidance: directive.guidance, value: directive.value } : null
  if (!directive) return
  const cfg = rt.decisionContext?.nunchi, map = stateOf(rt)
  const list = (map.get(job.thread) ?? []).filter(e => e.guidance !== directive.guidance)
  list.push({ guidance: directive.guidance, line: directive.line, at: job.clock.now(), ref: job.ref })
  map.delete(job.thread); map.set(job.thread, list.slice(-NUNCHI_LIMITS.conversationLines))
  while (map.size > MAX_THREADS) map.delete(map.keys().next().value)
  if (directive.durable && cfg?.store) {
    try {
      const entry = cfg.store.propose({ ...directive.durable, kind: job.result.reading.kind, strength: job.result.reading.strength, sourceRef: job.ref, thread: String(job.thread ?? '') })
      job.receipt.candidate = entry ? { id: entry.id, status: entry.status, seen: entry.seen } : null
    } catch { job.receipt.candidate = null }
  }
}

export function beginNunchi(rt, body, context) {
  try {
    if (!nunchiOn(rt)) return null
    const cfg = rt.decisionContext.nunchi, setup = rt.decisionContext
    const eligible = typeof cfg.eligible === 'function' ? cfg.eligible({ body, context }) === true : context.channelKind === 'direct' && !context.stateless && !context.board
    const message = typeof body?.message === 'string' ? body.message : ''
    if (!eligible || !message.trim() || typeof context.clientThreadId !== 'string' || !context.clientThreadId) return null
    const clock = cfg.clock && typeof cfg.clock.now === 'function' ? cfg.clock : REAL_CLOCK, controller = new AbortController()
    let previousReply = null
    // the assistant message right before this turn, only where the egress gate allows the conversation's own messages (the answering model holds it too); else judged without it
    try { previousReply = rt.previousReplyFor(context, null, { ignoreFlag: true }) } catch { previousReply = null }
    const position = rt.turnPosition(context), capMs = position.kind === 'first' ? NUNCHI_CAPS.firstMs : NUNCHI_CAPS.midMs
    const job = { startedAt: clock.now(), clock, capMs, controller, thread: context.clientThreadId, ref: typeof context.localMessageId === 'string' && context.localMessageId ? `chat-message:${context.localMessageId}` : null,
      result: null, applied: false, receipt: { status: 'pending', inTime: false, late: false, withPrevious: previousReply !== null, ms: null, reading: null, directive: null, candidate: null } }
    job.promise = judgeNunchi({ message, previousReply, client: setup.client, signal: controller.signal, timeoutMs: Math.min(NUNCHI_LIMITS.timeoutMs, capMs) })
      .then(result => { job.result = result; job.receipt.status = result.status; job.receipt.ms = Math.round(clock.now() - job.startedAt); job.receipt.reading = result.reading ?? null; return result }, () => null)
    return job
  } catch { return null }
}

/** The entry text for this turn's engine context, or null. Waits for the judgment only until the turn-memory cap (measured from its start), never longer. */
export async function settleNunchi(rt, job, context) {
  try {
    if (!nunchiOn(rt)) return null
    const cfg = rt.decisionContext.nunchi
    if (job) {
      try { await settleBefore(job.promise, job.startedAt + job.capMs, job.clock) } catch { /* the cap */ }
      const inTime = job.result !== null && job.receipt.ms !== null && job.startedAt + job.receipt.ms < job.startedAt + job.capMs
      job.receipt.inTime = inTime
      if (inTime) applyReading(rt, job)
      else { job.receipt.late = true; void job.promise.then(() => applyReading(rt, job)) } // the next turn gets it
      receiptsOf(rt).set(context, job.receipt)
      context.nunchi = job.receipt
    }
    let standing = []
    try { standing = cfg.store?.appliedLines?.() ?? [] } catch { standing = [] }
    return nunchiContextText({ standing, conversation: linesOf(rt, context.clientThreadId) })
  } catch { return null }
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
