import { contextDeliveryKey } from './egdesk-context-setup.mjs'
import { pagesFromCandidates } from './egdesk-wiki-adapter.mjs'
import { sha256Hex } from './egdesk-decision-questions.mjs'

// Which context-setup candidates the Decision model is asked about at all (R3: what code can rule out never reaches the question).
// The relevance question is the biggest part of the per-message Decision cost (about 2,500 of 4,600 estimated tokens in L1's collaboration
// run; each candidate costs its catalog line plus one predicate question). Code removes only what it can know; every candidate whose relevance
// needs a reading of the message stays, and the selection's thresholds and questions are unchanged.
//   held  the answering model already received this record in this conversation and it is unchanged, by the context setup itself (the
//         delivery key of the block it sent, contextDeliveryKey) or by turn memory (its receipt: the page's revision and content key).
//         Asking again costs tokens and attaching it again repeats it in the model's context (the user's rule: nothing already in the
//         conversation is sent again). A record that changed since is asked about again.
// Never pruned: a candidate with a guard of its own (mayRead: evidence bound to a grant, a capture or a consent; the context setup handles
// those all-or-nothing and re-checks them at dispatch), a mandatory item, the memory lookup and the recent-utterances item.
// Not a code rule (measured, see l7-c19): the same record turn memory attaches in this very turn. Turn memory runs beside the selection, so
// which pages it attaches is not known when the selection asks; under one packet the merge already sends each body once.
export const PRUNE_REASONS = Object.freeze(['held'])
const LOCAL = new Set(['memory-lookup:0', 'conversation:recent'])

/**
 * pruneContextCandidates(candidates, { sent, memoryReceipts }) -> { kept, pruned: [{ id, reason }] }
 * sent: Map id -> delivery key of what the context setup attached earlier in this conversation (or null).
 * memoryReceipts: { [pageId]: { revision, hash } } of what turn memory attached earlier in this conversation (or null).
 * Order is kept. Reads only local text (the candidate's loadText), and only for a candidate that has a receipt.
 */
export async function pruneContextCandidates(candidates, { sent = null, memoryReceipts = null } = {}) {
  const kept = [], pruned = []
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const id = typeof c?.id === 'string' ? c.id : null
    if (!id || LOCAL.has(id) || c.mandatory === true || typeof c.mayRead === 'function') { kept.push(c); continue }
    let held = false
    try {
      if (sent instanceof Map && sent.has(id)) held = sent.get(id) === await contextDeliveryKey(c)
      if (!held && memoryReceipts && Object.hasOwn(memoryReceipts, id)) {
        const [page] = await pagesFromCandidates([c]), receipt = memoryReceipts[id]
        held = Boolean(page && page.id === id && receipt && receipt.revision === page.revision && receipt.hash === (page.contentKey ?? sha256Hex(page.body)))
      }
    } catch { held = false } // not provably the same: asked about
    if (held) pruned.push({ id, reason: 'held' }); else kept.push(c)
  }
  return { kept, pruned }
}
