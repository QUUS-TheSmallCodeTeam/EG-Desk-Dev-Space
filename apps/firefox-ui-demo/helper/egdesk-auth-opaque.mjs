// L1 c34 compliance (Anthropic's Claude Code terms, read 2026-11-25): a sign-in to Claude (or ChatGPT) must be completed by the person themselves through the provider's own flow; an
// app may not automate it, or collect, store or relay credentials or session tokens (the sign-in CODE page shows an authorization code = a credential). So, behind the same flag as the
// terminal opener (EGDESK_TERMINAL_OPEN_URL=on), a Browser Card that shows an AI provider's auth/account domain is OPAQUE to every EG-Desk model and tool: no observation (page text,
// snapshot, screenshot), no click/fill/navigation by an Agent, and no opening of such a page by an Agent. The person uses the card like any browser card.
// The host list is a proposal the owner may edit (suffix match on the host's labels).
export const AUTH_OPAQUE_FLAG = 'EGDESK_TERMINAL_OPEN_URL'
export const AUTH_OPAQUE_HOSTS = Object.freeze(['claude.ai', 'claude.com', 'anthropic.com', 'auth.openai.com', 'auth0.openai.com', 'platform.openai.com', 'chatgpt.com'])

export const authOpaqueOn = (env = process.env) => env?.[AUTH_OPAQUE_FLAG] === 'on'
/** true when the address is on an AI provider's auth/account domain (host or any subdomain). Unparsable or non-http(s) addresses are not. */
export function isAuthOpaqueUrl(value) {
  try {
    const url = new URL(String(value))
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return AUTH_OPAQUE_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
  } catch { return false }
}

/** The request body without the Browser Cards that show an AI provider's sign-in page (flag on): they are never selected for an Agent, so no grant, host, title or page text of them is built. */
export function withoutAuthOpaqueSources(body, env = process.env) {
  if (!authOpaqueOn(env) || !Array.isArray(body?.selectedSources) || !body.selectedSources.some(source => isAuthOpaqueUrl(source?.sourceRef?.uri))) return body
  return { ...body, selectedSources: body.selectedSources.filter(source => !isAuthOpaqueUrl(source?.sourceRef?.uri)) }
}
