import { chatError } from './codex-chat-values.mjs'

// Shared by the real bridge and its in-process HTTP tests. Existing chats
// authenticate their durable engine, never the default or an untrusted hint.
export function createChatEngineAuth({ chat, refreshCodexAccount, getCodexAuth }) {
  return async (body = {}) => {
    const engineId = chat.requestEngine(body, { verifyAccount: false })
    chat.assertEngineContext(body, engineId)
    chat.assertReady(engineId)
    if (engineId === 'codex') {
      await refreshCodexAccount()
      if (!getCodexAuth()?.isLoggedIn) throw chatError('LOGIN_REQUIRED', 'Codex ChatGPT login is required', 401)
    } else chat.engines.assertReady(engineId)
    // Account refresh can invalidate a binding. Re-read and verify before
    // dispatch; do not retry against another engine on any failure.
    if (chat.requestEngine(body) !== engineId) throw chatError('ENGINE_MISMATCH', 'Conversation engine changed during authentication', 409)
    return engineId
  }
}
