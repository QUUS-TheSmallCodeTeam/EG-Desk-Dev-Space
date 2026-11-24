// c28: the per-conversation state that other modules drop when the person deletes a conversation (POST /chat/conversation/forget → chat.forgetConversation → these). The bridge
// (codex-bridge-server.mjs) and the real-engine check register the SAME functions from here, so the check proves the product's own deletion, not a copy of it.
// Each part is optional: a composition that has no briefing bindings (the check) registers the rest. Owner decisions: L2 c17 (a pending reading heard in the deleted
// conversation is withdrawn, it is not memory yet) and L2 c18 (memory in the conversation-temporary scope goes with the conversation; other scopes stay).
export const FORGETTER_NAMES = Object.freeze(['briefing_bindings', 'run_requesters', 'work_placement', 'pending_readings', 'conversation_memory'])

export function registerConversationForgetters(chat, { briefingBindings = null, runRequesters = null, workPlacement = null, turnMemoryConfig = null } = {}) {
  if (briefingBindings) chat.onForgetConversation('briefing_bindings', ({ conversationIds }) => conversationIds.reduce((n, id) => n + briefingBindings.forgetConversation(id), 0))
  if (runRequesters) chat.onForgetConversation('run_requesters', ({ clientThreadId, conversationIds }) => (runRequesters.set([clientThreadId, ...conversationIds], null) === 'cleared' ? 1 : 0))
  if (workPlacement) chat.onForgetConversation('work_placement', ({ clientThreadId, conversationIds }) => workPlacement.forget([clientThreadId, ...conversationIds]))
  if (turnMemoryConfig) {
    // Owner decision (L2 c17): a reading heard in the deleted conversation and still pending is withdrawn (it is not memory yet).
    chat.onForgetConversation('pending_readings', ({ clientThreadId }) => turnMemoryConfig.getAdapter().withdrawPendingFrom([clientThreadId]))
    // Owner decision (L2 c18): memory in the conversation-temporary scope goes with the conversation; other scopes stay (deleted under [기억]).
    chat.onForgetConversation('conversation_memory', ({ clientThreadId, messageRefs }) => { const n = turnMemoryConfig.getAdapter().forgetConversation({ clientThreadId, messageRefs }); return n.pages + n.readings + n.pointers })
  }
}
