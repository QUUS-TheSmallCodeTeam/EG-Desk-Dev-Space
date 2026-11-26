import { prepareTurnMemory } from './egdesk-turn-memory.mjs'
import { createOutcomeToOntology } from './egdesk-browser-task-memory.mjs'
import { ALTERNATE_VALUE } from './egdesk-browser-task-turn.mjs'

// The bridge's direct-browser-entry configuration (decisionContext.browserEntry). Developer flag, default off, like the draft check:
// the bridge passes mode() reading EGDESK_BROWSER_ENTRY ('advisory' | 'on'; anything else is off). While it is off the runtime never calls
// memory() or outcomeSink, so nothing is read, built, sent or opened.
//
// a1 (교대): the value 'alternate' is 'on' plus alternate() === true: the rule rides with the note and the loop's steps are shown (egdesk-browser-task-turn.mjs).
// With 'on' alternate() is false and everything is as before.
//
// createBrowserEntryConfig({ flag, getAdapter, wiki, now? }) -> { mode(), alternate(), memory(args), outcomeSink(candidate, args) }
//   wiki({ body, context }) -> the turn's wiki snapshot (the same builder the advisory turn memory uses; written pages included).
//   memory: the packet for the browser consumer. The browser loop is the consumer and holds nothing, so this is always a FIRST-style
//     reconstruction with no delivered receipts, whatever the subjective model's turn position is: mid-session receipts and the
//     skip-on-need option describe what the ANSWERING model holds, and the browser loop receives none of it. The subjective model
//     only gets the closed note, so nothing here is committed as delivered.
//   outcomeSink: the task outcome goes through the general write judgment and the persistent write path (adapter.writerFor ->
//     openWikiWrites, 0600, bounded). The page body stays the outcome text (an agent_note); there is no message reference.
//     Allowed: a new page in this DM's own write scope. Never a status change of another page.
export function createBrowserEntryConfig({ flag = () => 'off', openItemsFlag = () => 'off', getAdapter, wiki, now = Date.now } = {}) {
  const mode = () => { try { const value = flag(); return value === 'advisory' || value === 'on' ? value : value === ALTERNATE_VALUE ? 'on' : 'off' } catch { return 'off' } }
  const alternate = () => { try { return flag() === ALTERNATE_VALUE } catch { return false } }
  // c37: the open task's options as Decision predicates (EGDESK_BROWSER_OPEN_ITEMS=on, default off)
  const openItems = () => { try { return openItemsFlag() === 'on' } catch { return false } }
  return {
    mode,
    alternate,
    openItems,
    async memory({ body, context, client, egress = null, askedAt = null } = {}) {
      if (!client || typeof body?.message !== 'string' || typeof wiki !== 'function') return null
      const adapter = getAdapter(), snapshot = await wiki({ body, context })
      if (!snapshot?.pages) return null
      const scope = adapter.scopeFor(context)
      const result = await prepareTurnMemory({ message: body.message, wiki: snapshot, client, scope, askedAt: askedAt ?? now(), position: { kind: 'first', reason: 'browser_consumer' },
        delivered: null, threadKey: null, ontologyWrite: false })
      return { packet: result.packet, pages: result.memory.picks.map(pick => snapshot.pages.get(pick.id)).filter(Boolean), scope, wiki: snapshot, client, egress }
    },
    async outcomeSink(candidate, { memoryPages = [], memory = null } = {}) {
      if (!memory?.wiki || !memory.client) return { status: 'unavailable' }
      const adapter = getAdapter()
      const writer = adapter.writerFor(memory.wiki, { enabled: true, canWrite: ({ op, scope }) => op === 'new_page' && typeof scope?.writeScope === 'string' && scope.writeScope.startsWith('dm:') })
      return createOutcomeToOntology({ wiki: memory.wiki, client: memory.client, writer, scope: memory.scope, enabled: true, now, egress: memory.egress ?? null }).write(candidate, { memoryPages })
    },
  }
}
