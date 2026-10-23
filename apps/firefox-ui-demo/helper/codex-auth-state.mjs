const nonIdentityLabels = new Set(['chatgpt', 'codex', 'openai', 'apikey', 'api-key', 'amazonbedrock'])

function publicAccountId(value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= 512 && !nonIdentityLabels.has(id.toLowerCase()) ? id : null
}

// PlanType enum of the codex 0.162.1 app-server schema (GetAccountResponse,
// AccountUpdatedNotification). Anything else is dropped, never echoed.
export const PLAN_TYPES = new Set([
  'free', 'go', 'plus', 'pro', 'prolite', 'promax', 'team',
  'self_serve_business_prolite', 'self_serve_business_usage_based', 'business',
  'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based', 'enterprise',
  'edu', 'edu_plus', 'edu_pro', 'unknown',
])

export function publicPlanType(value) {
  return typeof value === 'string' && PLAN_TYPES.has(value) ? value : null
}

function publicEmail(value) {
  if (typeof value !== 'string') return null
  const email = value.trim()
  return email.length <= 512 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null
}

// CLI 0.156.1 account/read normally exposes {type, email, planType} for
// ChatGPT, not an account ID. Only explicit public ID fields, when provided,
// may populate accountId; planType passes only as a schema enum value.
// No credentials, token claims or config are inspected.
export function normalizeNativeAuth(authResult, accountResult) {
  const account = accountResult?.account
  const isChatgpt = account?.type === 'chatgpt'
  const accountId = isChatgpt ? publicAccountId(account.accountId) || publicAccountId(account.id) : null
  const accountEmail = isChatgpt ? publicEmail(account.email) : null
  const planType = isChatgpt ? publicPlanType(account.planType) : null
  return {
    isLoggedIn: authResult?.authMethod === 'chatgpt' || isChatgpt,
    authMode: typeof authResult?.authMethod === 'string' ? authResult.authMethod : (isChatgpt ? 'chatgpt' : null),
    accountId,
    accountEmail,
    planType,
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
