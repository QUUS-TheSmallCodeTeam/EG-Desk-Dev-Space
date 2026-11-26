// L8 u4 (owner direction U19: a conversation on Claude runs under EG-Desk's harness, browser control included). What a SEND of a Claude conversation does with Browser Cards the person granted.
// Until now the screen refused it for Claude ("Claude reads immutable captures only"). With the bridge capability 'claude-browser' (listed only when EGDESK_CLAUDE_HARNESS=on and EGDESK_PAGE_TOOLS=on) a Claude
// conversation may carry Browser Cards as LIVE selected sources, exactly as a Codex one does: the run is browserBounded, Claude gets EG-Desk's card tools through the MCP server (no built-in tools), the
// Card grant (⋯ menu "Chat 조작 허용"), the AI-service sign-in opacity, the action gate and the approval ledger are the runtime's own, unchanged.
//
// Why captures are left out of a live send: a bounded Claude process is launched without a Reader (egdesk-claude-bounded.mjs), and the immutable capture of a Card is what turns on the Reader for Claude.
// So a live Browser send carries ONLY Browser Cards; anything else that needs the Reader (a file, a canvas element, a briefing input, a picked context source) is refused with the screen's existing sentence,
// exactly as an interaction grant was refused before. Without the capability nothing changes: observe-only Cards stay immutable captures, an interaction grant is refused.
export const CLAUDE_BROWSER_CAPABILITY = 'claude-browser'
export const claudeBrowserCapable = capabilities => Array.isArray(capabilities) && capabilities.includes(CLAUDE_BROWSER_CAPABILITY)
const isBrowser = input => input?.kind === 'browser'
const operates = input => isBrowser(input) && input.browserToolPermission === 'interact'

/**
 * claudeBrowserSendPlan({ engineId, capable, selectedInputs, threadInputs, contextPicked, briefingInputs })
 *   -> { refuse: boolean, live: boolean, captureInputs: [...] }
 * refuse: the send is refused with the existing CLAUDE_CONTEXT_UNSUPPORTED sentence. live: Browser Cards go as live selected sources (and not as captures).
 * captureInputs: what is captured as immutable context (the Reader's input). Codex also sends explicit operate selections only through its live binding.
 */
export function claudeBrowserSendPlan({ engineId, capable = false, selectedInputs = [], threadInputs = [], contextPicked = 0, briefingInputs = 0 } = {}) {
  const inputs = Array.isArray(selectedInputs) ? selectedInputs : []
  // An operate chip targets a live Card, not the page at the URL where the person granted it.
  // The send validates and refreshes selectedSources separately; never turn an expired grant into a capture.
  if (engineId === 'codex') return Object.freeze({ refuse: false, live: false,
    captureInputs: inputs.filter(input => !(operates(input) && input.selectedByUser === true)) })
  if (engineId !== 'claude') return Object.freeze({ refuse: false, live: false, captureInputs: inputs })
  const operating = (Array.isArray(threadInputs) ? threadInputs : []).some(input => input?.browserToolPermission === 'interact') || inputs.some(operates)
  // today's refusal, unchanged: a picked context source, or a Browser Card granted to operate (as the screen read thread.inputSources)
  if (contextPicked > 0) return Object.freeze({ refuse: true, live: false, captureInputs: inputs })
  if (!operating) return Object.freeze({ refuse: false, live: false, captureInputs: inputs })
  if (capable !== true) return Object.freeze({ refuse: true, live: false, captureInputs: inputs })
  // live: only Browser Cards, no briefing input (those need the Reader a bounded Claude process does not have)
  if (briefingInputs > 0 || inputs.some(input => !isBrowser(input)) || !inputs.some(operates)) return Object.freeze({ refuse: true, live: false, captureInputs: inputs })
  return Object.freeze({ refuse: false, live: true, captureInputs: Object.freeze([]) })
}

/**
 * u7 (D20): what a Claude conversation keeps in its input row after a LIVE send was accepted. A Claude send spends everything it carried (captures are one-shot) EXCEPT the Browser Cards the person
 * granted to operate: that grant lasts for the conversation until the card menu's 조작 허용 해제 ends it (as it does for a Codex conversation, which never cleared them), so the next turn carries the
 * same Card again with a fresh token from the standing grant. Not live (no capability, or no operate grant): nothing is kept, exactly as before.
 */
export const claudeKeptInputs = (live, inputs) => (live === true && Array.isArray(inputs) ? inputs.filter(input => input?.kind === 'browser' && input.selectedByUser === true && operates(input)) : [])
