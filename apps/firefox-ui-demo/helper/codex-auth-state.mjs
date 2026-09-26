const nonIdentityLabels = new Set(['chatgpt', 'codex', 'openai', 'apikey', 'api-key', 'amazonbedrock'])

function publicAccountId(value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= 512 && !nonIdentityLabels.has(id.toLowerCase()) ? id : null
}

function publicEmail(value) {
  if (typeof value !== 'string') return null
  const email = value.trim()
  return email.length <= 512 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null
}

// CLI 0.156.1 account/read normally exposes {type, email, planType} for
// ChatGPT, not an account ID. Only explicit public ID fields, when provided,
// may populate accountId. No credentials, token claims or config are inspected.
export function normalizeNativeAuth(authResult, accountResult) {
  const account = accountResult?.account
  const isChatgpt = account?.type === 'chatgpt'
  const accountId = isChatgpt ? publicAccountId(account.accountId) || publicAccountId(account.id) : null
  const accountEmail = isChatgpt ? publicEmail(account.email) : null
  return {
    isLoggedIn: authResult?.authMethod === 'chatgpt' || isChatgpt,
    authMode: typeof authResult?.authMethod === 'string' ? authResult.authMethod : (isChatgpt ? 'chatgpt' : null),
    accountId,
    accountEmail,
    identityStatus: accountId || accountEmail ? 'known' : 'unknown',
    identityBasis: accountId ? 'accountId' : accountEmail ? 'email' : null,
    source: 'app-server',
    requiresOpenaiAuth: authResult?.requiresOpenaiAuth ?? true,
  }
}

export function publicAuthIdentityKey(status) {
  const id = publicAccountId(status?.accountId)
  if (id) return `id:${id}`
  const email = publicEmail(status?.accountEmail)
  return email ? `email:${email.toLowerCase()}` : null
}
