import { PAGE_TOOLS_FLAG, createPageToolsProvider, pageToolsEnabled } from './egdesk-page-tools.mjs'

// L8 u1: the bridge's wiring of the page tools (helper/egdesk-page-tools.mjs). Developer flag EGDESK_PAGE_TOOLS=on, default off: without it this returns null and the bridge
// passes nothing new. With it one more tool provider is registered; the catalog (collectToolSpecs) offers its tools to Claude (EG-Desk MCP) and to Codex (dynamicTools, the own-tools path)
// only in a run bound to a Browser Card the person granted. Every action goes through the EXISTING Browser provider's dispatch for the same run, so the run binding, the Card grant, the
// Agent ceiling, the action gate, the AI-service sign-in opacity (flag EGDESK_TERMINAL_OPEN_URL) and the activity record all stay as they are. What needs the person's approval goes through the
// approval ledger of the own command and file tools when that is on (EGDESK_OWN_TOOLS=on); without it nothing that needs approval is done.
export { PAGE_TOOLS_FLAG }

/**
 * createPageToolsWiring({ env, getChat, ledger? }) -> null | { toolProviders }
 *   getChat() -> the CodexChatRuntime (read lazily: the runtime is made after this wiring); its browserToolProvider() is the Browser provider
 */
export function createPageToolsWiring({ env = process.env, getChat, ledger = null } = {}) {
  if (!pageToolsEnabled(env)) return null
  if (typeof getChat !== 'function') throw new TypeError('page tools need getChat')
  const browser = { dispatch: (run, event) => {
    const provider = getChat()?.browserToolProvider?.()
    if (!provider?.dispatch) throw new Error('no Browser provider')
    return provider.dispatch(run, event)
  } }
  return { toolProviders: [createPageToolsProvider({ mode: () => 'on', browser, ledger, env })] }
}
