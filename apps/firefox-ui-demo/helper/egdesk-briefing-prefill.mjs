// Cycle 45 (owner direction U13): the briefing's fill runs CONCURRENTLY with the answer turn. Behind EGDESK_BRIEFING_PREFILL=on (default off).
//
// Why: check-29br/29bh measured the briefing after the answer at 28 to 97 s (one fill turn 25 to 39 s) on top of an answer turn of 34 to 63 s, and the fill does not read the answer: its
// request is the design guide and the materials, nothing else (fillRequest). The guide is settled by the Decision model from the request and the turn's memory materials (about / fit /
// order), none of which needs the answer's body. So when the turn is accepted the runtime hands { run, request } to the board handler (runtime hook decisionContext.briefingPrefill),
// which runs the SAME flow up to the first fill with no answer text (the earlier placement path: several / one_sentence) and sends that fill turn at once.
//
// What stays as it was: nothing is published, proposed or drawn by a prefill. After the answer is posted the route runs the whole flow exactly as before (placement with the answer quoted,
// fit, order, fill check, coverage, the publish) and only ONE thing differs: when it asks the engine for a fill whose request is byte-identical (same hash) to the one already sent or
// received, the earlier reply is used instead of a new turn. A different request (the answer cited another material, a card appeared on the board, another viewport) is simply a miss: the
// engine is asked as before. A reply that was null (timeout, refusal) is never served. One reply is served once; an entry nobody claims is dropped (bounded count and age).
import { createHash } from 'node:crypto'

export const PREFILL_LIMITS = Object.freeze({ entries: 16, ttlMs: 10 * 60_000, replyMax: 16_000 })
/** The identity of a fill request: the hash of its JSON (fillRequest builds the same keys in the same order every time). */
export const requestKey = want => createHash('sha256').update(JSON.stringify(want ?? null)).digest('hex')

/** createPrefillStore({ now, limits }) -> { begin(key), claim(key), has(key), size } ; an entry: { speculate(engine, want), serve(want), stats() } */
export function createPrefillStore({ now = Date.now, limits = {} } = {}) {
  const L = { ...PREFILL_LIMITS, ...limits }, entries = new Map()
  const drop = () => { for (const [k, e] of entries) if (now() - e.at > L.ttlMs) entries.delete(k); while (entries.size > L.entries) entries.delete(entries.keys().next().value) }
  return {
    get size() { return entries.size },
    has: key => entries.has(key),
    begin(key) {
      drop()
      if (entries.has(key)) return null
      const replies = new Map(), counts = { sent: 0, served: 0, missed: 0, nullReplies: 0 }
      // The board handler runs one Decision request at a time (a second one is answered 'manual'): the prefill's own judge requests are counted here so the flow after the answer can wait for them
      // (idle()) instead of colliding with one still in flight. judgesDone is set when the prefill reaches its fill (no judge request follows it) or ends.
      let judging = 0, judgesDone = false, waiters = []
      const wake = () => { if (judging === 0 && judgesDone) { const w = waiters; waiters = []; for (const r of w) r() } }
      const entry = { at: now(), claimed: false, counts,
        judging: delta => { judging += delta; wake() }, judgesFinished: () => { judgesDone = true; wake() },
        idle: (maxMs = 15_000) => (judging === 0 && judgesDone ? Promise.resolve() : new Promise(resolve => { const t = setTimeout(resolve, maxMs); t.unref?.(); waiters.push(() => { clearTimeout(t); resolve() }) })),
        /** send the engine request now (the engine is a private-turn function; it never throws, it answers null) and remember its reply by the request's hash */
        speculate(engine, want) {
          const k = requestKey(want)
          entry.judgesFinished()
          if (replies.has(k)) return replies.get(k).promise
          counts.sent++
          const slot = { failure: null, promise: null }
          slot.promise = Promise.resolve().then(() => engine(want)).then(reply => { if (reply === null || reply === undefined) { counts.nullReplies++; slot.failure = typeof engine.lastFailure === 'function' ? engine.lastFailure() : null } return reply ?? null }, () => null)
          replies.set(k, slot)
          return slot.promise
        },
        /** the reply of an identical earlier request (waiting for it when it is still in flight), or undefined (a miss: nothing was asked, or it gave nothing) */
        async serve(want) {
          const k = requestKey(want), slot = replies.get(k)
          if (!slot) { counts.missed++; return undefined }
          replies.delete(k)
          const reply = await slot.promise
          if (reply === null) { counts.missed++; return undefined }
          counts.served++
          return structuredClone(reply)
        } }
      entries.set(key, entry); drop()
      return entry
    },
    /** the entry of this answer, once: the route that claims it owns its replies */
    claim(key) { const e = entries.get(key); if (!e || e.claimed) return null; e.claimed = true; return e },
  }
}

/** cachingFill(engine, entry) -> a fill function for the post-answer flow: an identical request already asked is served from the entry, any other goes to the engine. */
export function cachingFill(engine, entry) {
  if (!entry) return engine
  let last = null
  const fill = async want => {
    last = null
    if (want?.kind === 'briefing_fill') { const hit = await entry.serve(want); if (hit !== undefined) { last = 'prefilled'; return hit } }
    return engine(want)
  }
  fill.lastFailure = () => (last === 'prefilled' ? null : typeof engine.lastFailure === 'function' ? engine.lastFailure() : null)
  fill.stats = () => (typeof engine.stats === 'function' ? engine.stats() : null)
  fill.prefill = () => ({ ...entry.counts })
  return fill
}
