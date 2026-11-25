import { compactText, predicateQuestion } from './egdesk-decision-questions.mjs'
import { NO, clockLine, ternary } from './egdesk-wiki-reconstruction.mjs'

// L1 c32 (owner direction U13, layer audit item 1): the OPEN-ITEM RESOLVER. One registry, built by code, of what the conversation is waiting on
// (a command waiting for the person's yes or no, a question the run asked, a run in progress, a stuck or handed-over browser task, a memory reading
// waiting for the person's confirmation). At the start of a turn the Decision model says which ONE item (if any) the person's message settles, BEFORE
// the engine turn. Code then calls the item's own existing judgment (approval words, record confirmation, browser task resume) for that item only and
// applies it; every other item stays open and untouched. The engine is told the settled state as context and only talks.
// Default off (bridge flag EGDESK_OPEN_ITEMS=on). No new user-visible copy: the registry is internal state, the engine context is model-facing.
//
// Who decides what (PHILOSOPHY R1-R6): code builds the items and their ids and applies; the Decision model answers one question per item, quoting the
// message and that one item; anything unclear, two items at once, or no answer settles NOTHING and the message is an ordinary turn.
export const OPEN_ITEM_KINDS = Object.freeze(['approval', 'question', 'browser_task', 'run', 'memory', 'proposal'])
export const OPEN_ITEM_LIMITS = Object.freeze({ items: 5, summaryChars: 300, messageChars: 600, timeoutMs: 2500 })
// ref: the yes bar of "this message settles this item" (above the loop's 0.8). no: an item at or below this is not referred to. Between them: unsure -> settle nothing.
export const OPEN_ITEM_BARS = Object.freeze({ ref: 0.85, unsure: 0.5, no: NO })
export const OPEN_ITEM_RULES = [
  'You are a system judge. A person is in a conversation that has some open items: things that wait for the person. Every question is about ONE open item and the person\'s message.',
  'Answer each question on its own, using only what is quoted in it. An open item is settled by a message that answers it, accepts it, refuses it, tells it to go on or stop, or confirms it. A message about something else, a new request, small talk, or an answer that could be meant for another thing does not settle it.',
].join('\n')
export const OPEN_ITEM_REASONS = Object.freeze(['no_items', 'message_unsuited', 'no_item_referred', 'several_items', 'unanswered', 'not_settled_by_provider'])

const providers = new Map()
/** A provider contributes items and (optionally) applies a settled one: { id, items(key) -> [{ id, kind, state?, summary, options? }], questions?(key, message), read?(answers), apply?(ctx) }. Items are synchronous and code-built. */
export function registerOpenItemProvider(provider) {
  if (!provider || typeof provider.id !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(provider.id) || typeof provider.items !== 'function') throw new TypeError('registerOpenItemProvider: { id, items(key) } needed')
  providers.set(provider.id, provider)
  return () => { if (providers.get(provider.id) === provider) providers.delete(provider.id) }
}
export const registeredOpenItemProviders = () => [...providers.values()]

/** buildRegistry(sources, key) -> [{ id: 'oi1'.., provider, itemId, kind, state, summary, options }]. Code only. sources: provider objects (the built-ins first, then the registered ones). */
export function buildRegistry(sources, key) {
  const out = []
  for (const source of sources) {
    let rows = []
    try { rows = source.items(source.builtin === true ? key : (key?.clientThreadId ?? key?.cid ?? key)) } catch { rows = [] } // a registered provider (L8's browser) takes the conversation key as a string; the built-ins take { cid, clientThreadId }
    for (const row of Array.isArray(rows) ? rows : []) {
      if (out.length >= OPEN_ITEM_LIMITS.items) return out
      const kind = OPEN_ITEM_KINDS.includes(row?.kind) ? row.kind : null
      const summary = compactText(row?.summary, OPEN_ITEM_LIMITS.summaryChars)
      if (!kind || !summary || typeof row.id !== 'string') continue
      out.push({ id: `oi${out.length + 1}`, provider: source.id, itemId: row.id, kind, state: typeof row.state === 'string' ? row.state : 'open', summary, options: Array.isArray(row.options) ? row.options : [], source })
    }
  }
  return out
}

const quote = text => JSON.stringify(compactText(text, OPEN_ITEM_LIMITS.messageChars))
/** One predicate per item: names oi_ref_<n> (n = 1-based item number). The item is quoted by its code-built summary; the message is quoted too. */
export function referentQuestions(items, message) {
  return items.map((item, i) => predicateQuestion(`oi_ref_${i + 1}`, `Message of the person: ${quote(message)}\nOpen item (${item.kind}): ${quote(item.summary)}\nDoes this message settle this open item (answer it, accept it, refuse it, tell it to go on or to stop, or confirm it)?`))
}

/**
 * resolveOpenItem({ message, items, client, askedAt, signal, timeoutMs, bars, extraQuestions })
 *   -> { status: 'settled', item, p, calls, answers, usage } | { status: 'none', reason, calls, p? }
 * One request when there is at least one item, none otherwise. `extraQuestions`: the providers' own questions (their option predicates), sent in the same request;
 * their answers come back in `answers` for provider.read.
 */
export async function resolveOpenItem({ message, items = [], client, askedAt = null, signal, timeoutMs = OPEN_ITEM_LIMITS.timeoutMs, bars = OPEN_ITEM_BARS, extraQuestions = [] } = {}) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!items.length) return { status: 'none', reason: 'no_items', calls: 0 }
  if (!text || text.length > OPEN_ITEM_LIMITS.messageChars) return { status: 'none', reason: 'message_unsuited', calls: 0 }
  const questions = [...referentQuestions(items, text), ...extraQuestions]
  let reply
  try { reply = await client.decide({ input: [{ role: 'developer', content: OPEN_ITEM_RULES }, { role: 'user', content: `${clockLine(askedAt)}\nMessage:\n${text}` }], questions, timeoutMs, signal }) }
  catch (error) { return { status: 'none', reason: error?.code ?? 'unreachable', calls: 1 } }
  const rows = items.map((item, i) => ({ item, p: ternary(reply?.answers?.[`oi_ref_${i + 1}`]).p }))
  if (rows.some(row => row.p === null)) return { status: 'none', reason: 'unanswered', calls: 1 }
  const yes = rows.filter(row => row.p >= bars.ref)
  // c43 (L8): the providers' own answers (their option predicates, asked in this same request) are returned with a none that was decided on a read reply, so a provider can read its options when the
  // referent had nothing to arbitrate (a sole open item); nothing about the decision itself changes
  if (yes.length > 1) return { status: 'none', reason: 'several_items', calls: 1, answers: reply.answers ?? {} }
  if (yes.length === 0) return { status: 'none', reason: 'no_item_referred', calls: 1, p: Math.max(...rows.map(r => r.p)), answers: reply.answers ?? {} }
  if (rows.some(row => row !== yes[0] && row.p >= bars.unsure)) return { status: 'none', reason: 'several_items', calls: 1, answers: reply.answers ?? {} }
  return { status: 'settled', item: yes[0].item, p: yes[0].p, calls: 1, answers: reply.answers ?? {}, usage: reply.usage ?? null }
}

/** The engine's context block: closed words, model-facing only. `states`: id -> word (approved, not_approved, unclear, confirmed, handled, still_open). */
export function openItemsContext(items, verdict, states = {}) {
  if (!items.length) return null
  const lines = items.map(item => `- ${item.id} ${item.kind}: ${verdict?.status === 'settled' && verdict.item.id === item.id ? `settled by this message, state=${states[item.id] ?? 'settled'}` : 'still open'}`)
  return ['[open items] EG-Desk read this message against what the conversation was waiting on, before this turn.', ...lines,
    verdict?.status === 'settled' ? `This message settles ${verdict.item.id} only; talk from that state.` : 'This message settles none of them; they stay open.'].join('\n')
}

export const OPEN_ITEMS_KEY = 'egdesk_open_items'
