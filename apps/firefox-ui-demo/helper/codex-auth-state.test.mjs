import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeNativeAuth, PLAN_TYPES, publicAuthIdentityKey, publicPlanType } from './codex-auth-state.mjs'

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
