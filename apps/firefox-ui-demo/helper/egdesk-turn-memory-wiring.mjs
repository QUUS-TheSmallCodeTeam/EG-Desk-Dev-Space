import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'

// The bridge's turn-memory configuration (decisionContext.turnMemory). Built from the bridge setting, which defaults to 'off':
// while it is off the runtime never calls wiki(), so nothing is read, built or sent. The adapter (and its write store) is created
// lazily on the first advisory or on turn, so a default bridge does not even open its file.
// 'advisory' records only. 'on' attaches the packet and lets the write judgment store what the write path accepts.
//
// createTurnMemoryConfig({ settings, getAdapter, ontologyStore, deskStore, budget?, deadlineMs? }) -> the object the runtime reads:
//   { mode(), wiki({ body, context, sources }), scope({ context }), writer(wiki, options), budget, caps, deadlineMs, ontologyWrite }
export function createTurnMemoryConfig({ settings, getAdapter, ontologyStore = null, deskStore = null, budget = { linksFirst: true }, deadlineMs = 15000, caps = null, onePacket = false } = {}) {
  const mode = () => (['advisory', 'on'].includes(settings?.turnMemory?.mode) ? settings.turnMemory.mode : 'off')
  return {
    // The same lazy adapter, for other consumers of the wiki write path (the direct browser entry); it opens nothing by itself.
    getAdapter: () => getAdapter(),
    mode,
    // Advisory records only, so its write judgment (an extra call whose proposal nothing would apply) stays off. 'on' judges and stores.
    get ontologyWrite() { return mode() === 'on' },
    // The write path of a snapshot (persists what it accepts). Pending readings never promote here; see createWikiWriter.promote.
    writer: (wiki, options) => getAdapter().writerFor(wiki, options),
    budget, deadlineMs, ...(caps ? { caps } : {}),
    scope: ({ context, body }) => getAdapter().scopeFor(context, body),
    async wiki({ body, context, sources }) {
      const adapter = getAdapter()
      let graph = null
      try { const store = typeof ontologyStore === 'function' ? ontologyStore() : ontologyStore; graph = store && typeof store.readGraph === 'function' ? await store.readGraph() : null } catch { graph = null }
      let candidates = []
      // Board and explicitly selected sources only (no ontology, no transcript): those come from their own, consent-guarded mappers.
      try { candidates = (await collectDecisionCandidates({ body, clientThreadId: context?.clientThreadId ?? null, deskStore, ontologyStore: null, chatStore: null })).candidates } catch { candidates = [] }
      const speech = sources?.speech, topic = sources?.topic
      return adapter.snapshot({ context, body, graph, candidates,
        speechRecords: typeof speech?.records === 'function' ? () => speech.records() : null, speechGuard: typeof speech?.allowed === 'function' ? () => speech.allowed() === true : null,
        topicTurns: typeof topic?.turns === 'function' ? () => topic.turns() ?? [] : null, topicGuard: typeof topic?.current === 'function' ? () => topic.current() === true : null })
    },
  }
}
