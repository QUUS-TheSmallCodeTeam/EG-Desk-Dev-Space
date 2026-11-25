// L8 u5 (U19): which readiness a Browser-tool turn is judged by, per engine route.
// A Codex native thread gets its tools from the app-server at thread start (dynamicTools) and cannot change them later: the Browser provider asks the Codex slot's probe
// (qaReady) and a thread made before the tools existed is refused (browserRegisteredThreads). A CLAUDE turn is different: every Claude process is launched with its own
// --mcp-config and a bounded tool list (egdesk-claude-bounded.mjs), so the tools are whatever THIS process was given. Claude's readiness is therefore Claude's own
// (the adapter is ready and proves bounded execution), never the Codex app-server's. Only when the Claude browser capability is live (EGDESK_CLAUDE_HARNESS=on and EGDESK_PAGE_TOOLS=on: the same condition as the bridge capability 'claude-browser');
// otherwise every function here answers exactly as the code before it did.
import { PAGE_TOOLS_PROVIDER_ID } from './egdesk-page-tools.mjs'

/** the Claude browser capability is live: the harness is on (runtime.claudeHarness() !== null) and the page tools provider is registered */
export const claudeBrowserLive = ({ harness, toolProviders }) => harness != null && (toolProviders ?? []).some(provider => provider?.providerId === PAGE_TOOLS_PROVIDER_ID)

/**
 * browserSchemaReady({ claudeLive, claudeReady, codexReady }) -> route => boolean   (route: { engineId, engineProfileId })
 * claudeLive(): the capability is live. claudeReady(): the Claude adapter is ready and can prove bounded execution. codexReady(route): the Codex slot's own answer.
 */
export const browserSchemaReady = ({ claudeLive = () => false, claudeReady = () => false, codexReady }) =>
  route => (route?.engineId === 'claude' && claudeLive() ? claudeReady() === true : codexReady(route))
