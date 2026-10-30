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

// ── SUB-14: account access state ─────────────────────────────────────────
// Sign-in, a rejected turn and the usage read answer different questions, so
// the bridge reports one `access` row beside isLoggedIn/usage instead of
// folding every failure into '로그인 필요'. `recovery` names what the user may
// choose; nothing is retried or switched for them (Contract: a Run is never
// moved to another account quietly; D-S5: no automatic continuation after a
// usage reset — the reset time is shown, the next send is the user's).
export const ACCESS_STATES = Object.freeze(['ok', 'loginRequired', 'loginInProgress', 'authFailed', 'quotaExhausted', 'permissionDenied'])
export const ACCESS_RECOVERIES = Object.freeze(['login', 'reauth', 'switchAccount', 'wait', 'refresh'])
export const ACCESS_FAILURE_KINDS = Object.freeze(['auth', 'quota', 'permission'])

// CodexErrorInfo string variants of the codex 0.162.1 app-server schema and
// upstream HTTP statuses of its transport variants that name a cause. A
// `scope: 'turn'` cause (policy, sandbox, denials) ends with that turn; an
// account cause stays until a turn completes or the identity changes.
const ACCESS_CAUSES = new Map([
  ['unauthorized', { kind: 'auth', scope: 'account', label: '인증 만료' }],
  ['http401', { kind: 'auth', scope: 'account', label: '인증 거부' }],
  ['usageLimitExceeded', { kind: 'quota', scope: 'account', label: '사용 한도' }],
  ['rateLimitExceeded', { kind: 'quota', scope: 'account', label: '요청 빈도 한도' }],
  ['http429', { kind: 'quota', scope: 'account', label: '요청 빈도 한도' }],
  ['http403', { kind: 'permission', scope: 'account', label: '접근 거부' }],
  ['cyberPolicy', { kind: 'permission', scope: 'turn', label: '정책 차단' }],
  ['misalignmentPolicyViolation', { kind: 'permission', scope: 'turn', label: '정책 차단' }],
  ['tooManyDenials', { kind: 'permission', scope: 'turn', label: '승인 거절 누적' }],
  ['sandboxError', { kind: 'permission', scope: 'turn', label: '샌드박스 거부' }],
])
// Object variants carrying an optional upstream httpStatusCode (same list as
// codex-chat-values CODEX_TRANSPORT_ERRORS; kept here to avoid a cycle).
const TRANSPORT_VARIANTS = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']
const CAUSE_STATUSES = new Set([401, 403, 429])

// codexErrorInfo → allowlisted cause name, or null (never the raw value).
export function accessCause(info) {
  if (typeof info === 'string') return ACCESS_CAUSES.has(info) ? info : null
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null
  const variant = TRANSPORT_VARIANTS.find(name => Object.hasOwn(info, name))
  const status = variant ? info[variant]?.httpStatusCode : null
  return CAUSE_STATUSES.has(status) ? `http${status}` : null
}

// Stored on the auth state as `accessFailure`: {kind, cause, at, identity}.
// Only public, allowlisted fields survive; anything else reads as no failure.
export function publicAccessFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const cause = accessCause(value.cause)
  const kind = cause ? ACCESS_CAUSES.get(cause).kind : value.kind
  if (!ACCESS_FAILURE_KINDS.includes(kind)) return null
  if (!Number.isFinite(value.at) || value.at <= 0) return null
  const identity = typeof value.identity === 'string' && value.identity.length <= 600 ? value.identity : null
  return { kind, cause, at: Math.round(value.at), identity }
}

export function accessFailureScope(failure) {
  const cause = failure?.cause ? ACCESS_CAUSES.get(failure.cause) : null
  return cause?.scope ?? (failure ? 'account' : null)
}

// The recorded failure, when it belongs to the signed-in identity.
function currentAccessFailure(authState) {
  const failure = publicAccessFailure(authState?.accessFailure)
  if (!failure || !authState?.isLoggedIn) return null
  return failure.identity === publicAuthIdentityKey(authState) ? failure : null
}

function accessRow(state, label, detail, recovery, failure = null, extra = {}) {
  return { state, label, detail, recovery, cause: failure?.cause ?? null, failedAt: failure?.at ?? null, resetsAt: null, resetPassed: false, ...extra }
}

// A reached limit whose reset time (usage.resetsAt) has already passed: the
// last observation is old, not proof of recovery; nothing is resumed (D-S5).
function limitResetPassed(rateLimits, at) {
  return [rateLimits?.primary, rateLimits?.secondary].some(window => Number.isFinite(window?.resetsAt) && window.resetsAt <= at)
}

/**
 * One account access state from the public auth snapshot and its usage
 * display (codex-account-usage usageDisplay). Order: sign-in → auth failure →
 * usage limit → permission → ok. Labels are the Chat header chip text.
 */
export function accountAccessState(authState, usage = null, now = Date.now()) {
  const at = Number.isFinite(now) && now > 0 ? now : Date.now()
  if (!authState?.isLoggedIn) {
    if (authState?.loginInProgress) return accessRow('loginInProgress', '로그인 중…', 'ChatGPT 로그인을 진행하고 있습니다.', [])
    return accessRow('loginRequired', '로그인 필요', 'ChatGPT 계정으로 로그인하면 대화를 시작할 수 있습니다.', ['login'])
  }
  const failure = currentAccessFailure(authState)
  const cause = failure?.cause ? ACCESS_CAUSES.get(failure.cause) : null
  if (failure?.kind === 'auth') {
    return accessRow('authFailed', `${cause?.label ?? '인증 실패'} · 다시 로그인 필요`,
      'Codex가 이 계정의 ChatGPT 인증을 받아들이지 않았습니다. 같은 계정으로 다시 로그인하거나 다른 계정으로 로그인해 주세요.',
      ['reauth', 'switchAccount'], failure)
  }
  const limit = usage?.level === 'limit'
  if (failure?.kind === 'quota' || limit) {
    const resetsAt = Number.isFinite(usage?.resetsAt) && usage.resetsAt > at ? usage.resetsAt : null
    const resetLabel = resetsAt !== null && typeof usage.resetLabel === 'string' && usage.resetLabel ? usage.resetLabel : null
    const reached = typeof authState.rateLimits?.reachedType === 'string' ? authState.rateLimits.reachedType : null
    const noWindowReset = reached !== null && reached !== 'rate_limit_reached'
    if (resetsAt === null && !noWindowReset && limit && limitResetPassed(authState.rateLimits, at)) {
      return accessRow('quotaExhausted', '한도 초기화 시각 지남 · 확인 필요',
        '마지막으로 확인한 사용 한도의 초기화 시각이 지났습니다. 다시 확인하기 전까지는 사용 가능 여부를 알 수 없습니다.',
        ['refresh'], failure, { resetPassed: true })
    }
    const what = resetLabel ?? (noWindowReset ? (reached.includes('credits') ? '크레딧 소진' : '워크스페이스 한도') : '초기화 시각 미확인')
    return accessRow('quotaExhausted', `한도 도달 · ${what}`,
      noWindowReset ? '이 계정의 크레딧 또는 워크스페이스 한도가 끝났습니다. 다른 계정으로 로그인할 수 있습니다.'
        : '이 계정의 사용 한도에 도달했습니다. 초기화까지 기다리거나 다른 계정으로 로그인할 수 있습니다. 초기화 뒤에도 자동으로 이어가지 않습니다.',
      noWindowReset ? ['switchAccount'] : ['wait', 'switchAccount'], failure, { resetsAt })
  }
  if (failure?.kind === 'permission') {
    const scope = accessFailureScope(failure)
    return accessRow('permissionDenied', `권한 부족 · ${cause?.label ?? '원인 미확인'}`,
      scope === 'account' ? '이 계정의 권한으로는 요청을 처리할 수 없습니다. 다른 계정으로 로그인하거나 상태를 다시 확인해 주세요.'
        : '마지막 요청이 권한 문제로 거절되었습니다. 다음 요청을 보내면 이 표시는 사라집니다.',
      scope === 'account' ? ['switchAccount', 'refresh'] : [], failure)
  }
  return accessRow('ok', '로그인됨', null, [])
}

// A status refresh should re-read usage (throttled by createRateLimitSync)
// while a quota failure is recorded or a reached limit's observation is old.
export function usageRefreshDue(authState, usage = null, now = Date.now()) {
  if (!authState?.isLoggedIn) return false
  if (currentAccessFailure(authState)?.kind === 'quota') return true
  return usage?.level === 'limit' && (usage.stale === true || limitResetPassed(authState.rateLimits, Number.isFinite(now) ? now : Date.now()))
}
