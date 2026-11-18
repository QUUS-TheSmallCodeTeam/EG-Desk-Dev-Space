import { chatError } from './codex-chat-values.mjs'
import { CODEX_ENGINE_PROFILE_ID } from './codex-engine-adapter.mjs'

// Existing chats authenticate their durable route, never the default or an
// untrusted hint. Agent resolution is enabled only for Chat send routes.
export function createChatEngineAuth({ chat, refreshCodexAccount, getCodexAuth }) {
  return async (body = {}, { useAgent = false, allowIsolated = useAgent, requireClientPair = false } = {}) => {
    const route = verifyAccount => chat.requestEngineRoute
      ? chat.requestEngineRoute(body, { verifyAccount, useAgent, requireClientPair })
      : { engineId: chat.requestEngine(body, { verifyAccount }), engineProfileId: null }
    const { engineId, engineProfileId } = route(false)
    chat.assertEngineContext(body, engineId)
    const scopedCodex = engineId === 'codex' && engineProfileId != null && engineProfileId !== CODEX_ENGINE_PROFILE_ID
    if (scopedCodex) {
      if (!allowIsolated) throw chatError('ENGINE_PROFILE_MISMATCH', 'This operation does not support isolated Codex profiles', 409)
      const adapter = chat.engines.get(engineId)
      if (!adapter?.ensureReady) throw chatError('ENGINE_PROFILE_MISMATCH', 'The selected Codex profile is unavailable', 409)
      await adapter.ensureReady(engineProfileId)
    } else {
      chat.assertReady(engineId)
      if (engineId === 'codex') {
        await refreshCodexAccount()
        if (!getCodexAuth()?.isLoggedIn) throw chatError('LOGIN_REQUIRED', 'Codex ChatGPT login is required', 401)
      } else chat.engines.assertReady(engineId)
    }
    // Account refresh can invalidate a binding. Re-read and verify before
    // dispatch; do not retry against another engine/profile on any failure.
    const verified = route(true)
    if (verified.engineId !== engineId) throw chatError('ENGINE_MISMATCH', 'Conversation engine changed during authentication', 409)
    if (verified.engineProfileId !== engineProfileId) throw chatError('ENGINE_PROFILE_MISMATCH', 'Conversation profile changed during authentication', 409)
    return engineId
  }
}
