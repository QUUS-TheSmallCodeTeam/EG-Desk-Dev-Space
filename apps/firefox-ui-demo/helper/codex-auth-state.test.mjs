import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeNativeAuth, publicAuthIdentityKey } from './codex-auth-state.mjs'

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
  assert.deepEqual(Object.keys(result).sort(), ['isLoggedIn', 'authMode', 'accountId', 'accountEmail', 'identityStatus', 'identityBasis', 'source', 'requiresOpenaiAuth'].sort())
})

test('missing auth/account data has neither a known identity nor a login claim', () => {
  const result = normalizeNativeAuth(null, null)
  assert.equal(result.isLoggedIn, false)
  assert.equal(result.identityStatus, 'unknown')
  assert.equal(result.accountId, null)
  assert.equal(result.accountEmail, null)
  assert.equal(publicAuthIdentityKey(result), null)
})
