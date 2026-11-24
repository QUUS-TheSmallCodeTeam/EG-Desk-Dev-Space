import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'

// The bridge's turn-memory configuration (decisionContext.turnMemory). Built from the bridge setting, which defaults to 'off':
// while it is off the runtime never calls wiki(), so nothing is read, built or sent. The adapter (and its write store) is created
// lazily on the first advisory turn, so a default bridge does not even open its file.
//
// createTurnMemoryConfig({ settings, getAdapter, ontologyStore, deskStore, budget?, deadlineMs? }) -> the object the runtime reads:
//   { mode(), wiki({ body, context, sources }), scope({ context }), budget, deadlineMs, ontologyWrite }
export function createTurnMemoryConfig({ settings, getAdapter, ontologyStore = null, deskStore = null, budget = { linksFirst: true }, deadlineMs = 15000 } = {}) {
  return {
    mode: () => (settings?.turnMemory?.mode === 'advisory' ? 'advisory' : 'off'),
    // Advisory records only: the write judgment (an extra call whose proposal nothing applies yet) stays off until the host has a write policy.
    ontologyWrite: false,
    budget, deadlineMs,
    scope: ({ context }) => getAdapter().scopeFor(context),
    async wiki({ body, context, sources }) {
      const adapter = getAdapter()
      let graph = null
      try { const store = typeof ontologyStore === 'function' ? ontologyStore() : ontologyStore; graph = store && typeof store.readGraph === 'function' ? await store.readGraph() : null } catch { graph = null }
      let candidates = []
      // Board and explicitly selected sources only (no ontology, no transcript): those come from their own, consent-guarded mappers.
      try { candidates = (await collectDecisionCandidates({ body, clientThreadId: context?.clientThreadId ?? null, deskStore, ontologyStore: null, chatStore: null })).candidates } catch { candidates = [] }
      const speech = sources?.speech, topic = sources?.topic
      return adapter.snapshot({ context, graph, candidates,
        speechRecords: typeof speech?.records === 'function' ? () => speech.records() : null, speechGuard: typeof speech?.allowed === 'function' ? () => speech.allowed() === true : null,
        topicTurns: typeof topic?.turns === 'function' ? () => topic.turns() ?? [] : null, topicGuard: typeof topic?.current === 'function' ? () => topic.current() === true : null })
    },
  }
}
