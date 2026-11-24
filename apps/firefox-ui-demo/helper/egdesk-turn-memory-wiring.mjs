import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'

// The bridge's turn-memory configuration (decisionContext.turnMemory). Built from the bridge setting, which defaults to 'off':
// while it is off the runtime never calls wiki(), so nothing is read, built or sent. The adapter (and its write store) is created
// lazily on the first advisory or on turn, so a default bridge does not even open its file.
// 'advisory' records only. 'on' attaches the packet and lets the write judgment store what the write path accepts.
//
// Developer flags of the bridge for the turn-memory options (environment, read once at start; no settings screen entry, nothing user-facing).
// Unset or any other value means the default: one packet off, write target 'about', confirmation in conversation off.
//   EGDESK_TURN_MEMORY_ONE_PACKET=on        the memory pages ride under the context selection's packet
//   EGDESK_TURN_MEMORY_WRITE_TARGET=choice  the old N-way write target, for comparison ('about' is the default)
//   EGDESK_TURN_MEMORY_CONFIRM=on           pending readings may be confirmed or refused through the conversation
export const TURN_MEMORY_FLAGS = Object.freeze({ onePacket: 'EGDESK_TURN_MEMORY_ONE_PACKET', writeTarget: 'EGDESK_TURN_MEMORY_WRITE_TARGET', confirmInConversation: 'EGDESK_TURN_MEMORY_CONFIRM', pruneHeld: 'EGDESK_TURN_MEMORY_PRUNE_HELD', keepLate: 'EGDESK_TURN_MEMORY_KEEP_LATE', speechDesign: 'EGDESK_TURN_MEMORY_SPEECH_DESIGN' })
export function turnMemoryFlagsFromEnv(env = {}) {
  const get = name => (env && typeof env === 'object' && typeof env[name] === 'string' ? env[name] : null)
  return { ...(get(TURN_MEMORY_FLAGS.onePacket) === 'on' ? { onePacket: true } : {}), ...(get(TURN_MEMORY_FLAGS.writeTarget) === 'choice' ? { writeTarget: 'choice' } : {}),
    ...(get(TURN_MEMORY_FLAGS.confirmInConversation) === 'on' ? { confirmInConversation: true } : {}), ...(get(TURN_MEMORY_FLAGS.pruneHeld) === 'on' ? { pruneHeld: true } : {}),
    ...(get(TURN_MEMORY_FLAGS.keepLate) === 'on' ? { keepLate: true } : {}), ...(get(TURN_MEMORY_FLAGS.speechDesign) === 'split' ? { speechDesign: 'split-isolated' } : {}) }
}

// createTurnMemoryConfig({ settings, getAdapter, ontologyStore, deskStore, budget?, deadlineMs? }) -> the object the runtime reads:
//   { mode(), wiki({ body, context, sources }), scope({ context }), writer(wiki, options), budget, caps, deadlineMs, ontologyWrite }
export function createTurnMemoryConfig({ settings, getAdapter, ontologyStore = null, deskStore = null, budget = { linksFirst: true }, deadlineMs = 15000, caps = null, onePacket = false, writeTarget = 'about', confirmInConversation = false, pruneHeld = false, keepLate = false, speechDesign = null } = {}) {
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
    // Internal flags, absent unless the bridge passes them: one packet with the context selection (off by default), the write-target design
    // ('about' by default; 'choice' is passed only to compare), and confirmation of pending readings through the conversation (off by default).
    ...(onePacket === true ? { onePacket: true } : {}), ...(writeTarget === 'choice' ? { writeTarget: 'choice' } : {}), ...(confirmInConversation === true ? { confirmInConversation: true } : {}),
    // Held records are not asked about again by the context selection (egdesk-context-pruning.mjs; off by default).
    ...(pruneHeld === true ? { pruneHeld: true } : {}),
    // A turn_context answer that missed its budget is kept for the later steps of the same turn (never for the native turn; off by default).
    ...(keepLate === true ? { keepLate: true } : {}),
    // How the write judgment asks the sentence labels: 'split-isolated' (source and time as yes/no predicates) only when passed; default axes.
    ...(speechDesign === 'split-isolated' ? { speechDesign: 'split-isolated' } : {}),
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
