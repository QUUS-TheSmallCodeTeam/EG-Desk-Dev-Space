import test from 'node:test'
import assert from 'node:assert/strict'
import { accessCause, accountAccessState, normalizeNativeAuth, PLAN_TYPES, publicAccessFailure, publicAuthIdentityKey, publicPlanType, usageRefreshDue } from './codex-auth-state.mjs'
import { usageDisplay } from './codex-account-usage.mjs'

const managedAuth = { authMethod: 'chatgpt', requiresOpenaiAuth: true }
const nativeAccount = email => ({ account: { type: 'chatgpt', email, planType: 'plus' } })

test('normal native ChatGPT accounts A and B use distinct public email identities, never provider IDs', () => {
  const a = normalizeNativeAuth(managedAuth, nativeAccount('a@example.com'))
  const b = normalizeNativeAuth(managedAuth, nativeAccount('b@example.com'))
  assert.equal(a.accountId, null)
  assert.equal(b.accountId, null)
  assert.equal(a.accountEmail, 'a@example.com')
  assert.equal(b.accountEmail, 'b@example.com')
  assert.notEqual(a.accountId || a.accountEmail, b.accountId || b.accountEmail)
  assert.notEqual(publicAuthIdentityKey(a), publicAuthIdentityKey(b))
  assert.equal(a.identityBasis, 'email')
  assert.equal(a.identityStatus, 'known')
})

test('an explicit public native account identifier is preserved and preferred over email', () => {
  const a = normalizeNativeAuth(managedAuth, { account: { type: 'chatgpt', id: 'public-account-A', email: 'same@example.com' } })
  const b = normalizeNativeAuth(managedAuth, { account: { type: 'chatgpt', accountId: 'public-account-B', email: 'same@example.com' } })
  assert.equal(a.accountId, 'public-account-A')
  assert.equal(b.accountId, 'public-account-B')
  assert.equal(a.identityBasis, 'accountId')
  assert.notEqual(publicAuthIdentityKey(a), publicAuthIdentityKey(b))
})

test('authenticated mode without a public identifier or email is explicitly unknown identity', () => {
  for (const accountResult of [nativeAccount(null), { account: null }, nativeAccount('')]) {
    const result = normalizeNativeAuth(managedAuth, accountResult)
    assert.equal(result.isLoggedIn, true)
    assert.equal(result.authMode, 'chatgpt')
    assert.equal(result.accountId, null)
    assert.equal(result.accountEmail, null)
    assert.equal(result.identityStatus, 'unknown')
    assert.equal(result.identityBasis, null)
    assert.equal(publicAuthIdentityKey(result), null)
  }
})

test('provider/type labels cannot become public account identifiers even in an explicit ID field', () => {
  for (const label of ['chatgpt', 'Codex', 'openai', 'apiKey', 'amazonBedrock']) {
    const result = normalizeNativeAuth(managedAuth, { account: { type: 'chatgpt', id: label, email: 'a@example.com' } })
    assert.equal(result.accountId, null)
    assert.equal(result.identityBasis, 'email')
  }
  assert.equal(publicAuthIdentityKey({ accountId: 'chatgpt', accountEmail: null }), null)
})

test('normalization only returns public auth fields and does not copy opaque auth payloads', () => {
  const result = normalizeNativeAuth({ ...managedAuth, opaquePrivatePayload: 'DO_NOT_COPY' }, {
    ...nativeAccount('a@example.com'), opaquePrivatePayload: 'DO_NOT_COPY',
  })
  assert.ok(!JSON.stringify(result).includes('DO_NOT_COPY'))
  assert.deepEqual(Object.keys(result).sort(), ['isLoggedIn', 'authMode', 'accountId', 'accountEmail', 'planType', 'identityStatus', 'identityBasis', 'source', 'requiresOpenaiAuth'].sort())
})

test('missing auth/account data has neither a known identity nor a login claim', () => {
  const result = normalizeNativeAuth(null, null)
  assert.equal(result.isLoggedIn, false)
  assert.equal(result.identityStatus, 'unknown')
  assert.equal(result.accountId, null)
  assert.equal(result.accountEmail, null)
  assert.equal(publicAuthIdentityKey(result), null)
})

test('planType passes only as a codex 0.162.1 schema enum value', () => {
  // Same 18 values as GetAccountResponse/AccountUpdatedNotification PlanType.
  assert.deepEqual([...PLAN_TYPES].sort(), ['business', 'edu', 'edu_plus', 'edu_pro', 'ent26', 'enterprise', 'enterprise_cbp_automation',
    'enterprise_cbp_usage_based', 'free', 'go', 'plus', 'pro', 'prolite', 'promax', 'self_serve_business_prolite',
    'self_serve_business_usage_based', 'team', 'unknown'])
  for (const planType of PLAN_TYPES) {
    assert.equal(normalizeNativeAuth(managedAuth, { account: { type: 'chatgpt', email: 'a@example.com', planType } }).planType, planType)
  }
  assert.equal(normalizeNativeAuth(managedAuth, nativeAccount('a@example.com')).planType, 'plus')
  for (const planType of ['Pro', 'PLUS', ' pro', 'enterprise-ultra', 'pro<script>', '', null, undefined, 3, { pro: true }, ['pro']]) {
    assert.equal(normalizeNativeAuth(managedAuth, { account: { type: 'chatgpt', email: 'a@example.com', planType } }).planType, null)
    assert.equal(publicPlanType(planType), null)
  }
})

test('planType is not read from non-ChatGPT accounts or missing account data', () => {
  assert.equal(normalizeNativeAuth({ authMethod: 'apikey' }, { account: { type: 'apiKey', planType: 'pro' } }).planType, null)
  assert.equal(normalizeNativeAuth(managedAuth, { account: { type: 'amazonBedrock', planType: 'pro' } }).planType, null)
  assert.equal(normalizeNativeAuth(managedAuth, { account: null }).planType, null)
  assert.equal(normalizeNativeAuth(null, null).planType, null)
})

test('planType does not change the public identity key', () => {
  const plus = normalizeNativeAuth(managedAuth, { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' } })
  const pro = normalizeNativeAuth(managedAuth, { account: { type: 'chatgpt', email: 'a@example.com', planType: 'pro' } })
  assert.equal(publicAuthIdentityKey(plus), publicAuthIdentityKey(pro))
})

// ── SUB-14 account access state ──
// Local-clock fixtures keep the Korean reset label independent of the host TZ.
const t0 = new Date(2026, 9, 31, 2, 0, 0).getTime()
const signedIn = (extra = {}) => ({ isLoggedIn: true, accountEmail: 'owner@example.test', accountId: null, rateLimits: null, loginInProgress: false, accessFailure: null, ...extra })
const reached = (resetsAt, extra = {}) => ({ primary: { usedPercent: 100, windowMinutes: 300, resetsAt }, secondary: null, reachedType: 'rate_limit_reached', usageAllowed: false, observedAt: t0, ...extra })
const failure = (kind, cause, identity = 'email:owner@example.test') => ({ kind, cause, at: t0, identity })

test('access: signed out is 로그인 필요 with login, 로그인 중 while a sign-in runs, ok once signed in without a limit or failure', () => {
  assert.deepEqual(accountAccessState({ isLoggedIn: false }, null, t0), { state: 'loginRequired', label: '로그인 필요', detail: 'ChatGPT 계정으로 로그인하면 대화를 시작할 수 있습니다.', recovery: ['login'], cause: null, failedAt: null, resetsAt: null, resetPassed: false })
  assert.equal(accountAccessState({ isLoggedIn: false, loginInProgress: true }, null, t0).state, 'loginInProgress')
  assert.deepEqual(accountAccessState(signedIn(), usageDisplay(null, t0), t0), { state: 'ok', label: '로그인됨', detail: null, recovery: [], cause: null, failedAt: null, resetsAt: null, resetPassed: false })
  assert.equal(accountAccessState(null, null, t0).state, 'loginRequired')
})

test('access: a reached limit shows the reset clock and offers waiting or another account, never an automatic continuation', () => {
  const auth = signedIn({ rateLimits: reached(t0 + 70 * 60 * 1000) })
  const row = accountAccessState(auth, usageDisplay(auth.rateLimits, t0), t0)
  assert.equal(row.state, 'quotaExhausted')
  assert.equal(row.label, '한도 도달 · 오전 3:10에 초기화')
  assert.deepEqual(row.recovery, ['wait', 'switchAccount'])
  assert.equal(row.resetsAt, t0 + 70 * 60 * 1000)
  assert.equal(row.resetPassed, false)
  assert.match(row.detail, /자동으로 이어가지 않습니다/)
  assert.equal(usageRefreshDue(auth, usageDisplay(auth.rateLimits, t0), t0), false, 'a fresh limit with a future reset needs no re-read')
})

test('access: credit or workspace limits have no window reset and offer only another account', () => {
  const auth = signedIn({ rateLimits: reached(t0 + 3_600_000, { reachedType: 'workspace_owner_credits_depleted' }) })
  const row = accountAccessState(auth, usageDisplay(auth.rateLimits, t0), t0)
  assert.deepEqual([row.state, row.label, row.recovery, row.resetsAt], ['quotaExhausted', '한도 도달 · 크레딧 소진', ['switchAccount'], null])
  const workspace = signedIn({ rateLimits: reached(null, { reachedType: 'workspace_member_usage_limit_reached' }) })
  assert.equal(accountAccessState(workspace, usageDisplay(workspace.rateLimits, t0), t0).label, '한도 도달 · 워크스페이스 한도')
})

test('access: a reset time that has passed is 확인 필요 with a re-read, not recovery (D-S5)', () => {
  const auth = signedIn({ rateLimits: reached(t0 - 60_000, { observedAt: t0 - 120_000 }) })
  const usage = usageDisplay(auth.rateLimits, t0)
  const row = accountAccessState(auth, usage, t0)
  assert.deepEqual([row.state, row.label, row.recovery, row.resetsAt, row.resetPassed], ['quotaExhausted', '한도 초기화 시각 지남 · 확인 필요', ['refresh'], null, true])
  assert.equal(usageRefreshDue(auth, usage, t0), true)
  const fresh = signedIn({ rateLimits: { primary: { usedPercent: 20, windowMinutes: 300, resetsAt: t0 + 3_600_000 }, secondary: null, reachedType: null, usageAllowed: true, observedAt: t0 } })
  assert.equal(usageRefreshDue(fresh, usageDisplay(fresh.rateLimits, t0), t0), false)
})

test('access: a recorded auth failure of the signed-in identity is 인증 만료 with 다시 로그인/다른 계정; another identity or a signed-out state ignores it', () => {
  const row = accountAccessState(signedIn({ accessFailure: failure('auth', 'unauthorized') }), usageDisplay(null, t0), t0)
  assert.deepEqual([row.state, row.label, row.recovery, row.cause, row.failedAt], ['authFailed', '인증 만료 · 다시 로그인 필요', ['reauth', 'switchAccount'], 'unauthorized', t0])
  assert.equal('identity' in row, false)
  assert.equal(accountAccessState(signedIn({ accessFailure: failure('auth', 'http401') }), null, t0).label, '인증 거부 · 다시 로그인 필요')
  assert.equal(accountAccessState(signedIn({ accessFailure: failure('auth', null) }), null, t0).label, '인증 실패 · 다시 로그인 필요')
  assert.equal(accountAccessState(signedIn({ accountEmail: 'other@example.test', accessFailure: failure('auth', 'unauthorized') }), null, t0).state, 'ok')
  assert.equal(accountAccessState({ isLoggedIn: false, accessFailure: failure('auth', 'unauthorized') }, null, t0).state, 'loginRequired')
  // The auth failure outranks a usage limit; a quota failure without usage data names no reset time.
  const both = signedIn({ accessFailure: failure('auth', 'unauthorized'), rateLimits: reached(t0 + 3_600_000) })
  assert.equal(accountAccessState(both, usageDisplay(both.rateLimits, t0), t0).state, 'authFailed')
  const quota = accountAccessState(signedIn({ accessFailure: failure('quota', 'usageLimitExceeded') }), usageDisplay(null, t0), t0)
  assert.deepEqual([quota.state, quota.label, quota.recovery], ['quotaExhausted', '한도 도달 · 초기화 시각 미확인', ['wait', 'switchAccount']])
  assert.equal(usageRefreshDue(signedIn({ accessFailure: failure('quota', 'usageLimitExceeded') }), usageDisplay(null, t0), t0), true)
})

test('access: permission causes name what was denied; an account-level 403 offers another account, a turn-level policy offers nothing', () => {
  const account = accountAccessState(signedIn({ accessFailure: failure('permission', 'http403') }), null, t0)
  assert.deepEqual([account.state, account.label, account.recovery], ['permissionDenied', '권한 부족 · 접근 거부', ['switchAccount', 'refresh']])
  const sandbox = accountAccessState(signedIn({ accessFailure: failure('permission', 'sandboxError') }), null, t0)
  assert.deepEqual([sandbox.label, sandbox.recovery], ['권한 부족 · 샌드박스 거부', []])
  assert.equal(accountAccessState(signedIn({ accessFailure: failure('permission', 'tooManyDenials') }), null, t0).label, '권한 부족 · 승인 거절 누적')
  assert.equal(accountAccessState(signedIn({ accessFailure: failure('permission', 'cyberPolicy') }), null, t0).label, '권한 부족 · 정책 차단')
  assert.deepEqual(accountAccessState(signedIn({ accessFailure: failure('permission', null) }), null, t0).recovery, ['switchAccount', 'refresh'])
  assert.equal(accountAccessState(signedIn({ accessFailure: failure('permission', null) }), null, t0).label, '권한 부족 · 원인 미확인')
})

test('publicAccessFailure and accessCause keep only allowlisted values; a cause decides the kind', () => {
  assert.equal(accessCause('unauthorized'), 'unauthorized')
  assert.equal(accessCause('contextWindowExceeded'), null)
  assert.equal(accessCause({ responseStreamDisconnected: { httpStatusCode: 401 } }), 'http401')
  assert.equal(accessCause({ responseTooManyFailedAttempts: { httpStatusCode: 429 } }), 'http429')
  assert.equal(accessCause({ httpConnectionFailed: { httpStatusCode: 500 } }), null)
  assert.equal(accessCause({ activeTurnNotSteerable: {} }), null)
  assert.equal(accessCause(['unauthorized']), null)
  assert.deepEqual(publicAccessFailure({ kind: 'auth', cause: 'bogus', at: t0, identity: 'email:x@y', extra: 1 }), { kind: 'auth', cause: null, at: t0, identity: 'email:x@y' })
  assert.deepEqual(publicAccessFailure({ kind: 'quota', cause: 'unauthorized', at: t0 }), { kind: 'auth', cause: 'unauthorized', at: t0, identity: null })
  assert.equal(publicAccessFailure({ kind: 'network', cause: null, at: t0 }), null)
  assert.equal(publicAccessFailure({ kind: 'auth', at: 0 }), null)
  assert.equal(publicAccessFailure('auth'), null)
  assert.equal(publicAccessFailure({ kind: 'auth', at: t0, identity: 'x'.repeat(601) }).identity, null)
})
