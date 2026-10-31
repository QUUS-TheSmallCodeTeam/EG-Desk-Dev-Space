import assert from 'node:assert/strict'
import { test } from 'node:test'

const Grant = await import('../overlay/resources/EGDeskBrowserGrant.sys.mjs')
const { browserGrantSite, browserGrantNavigation, browserGrantState, browserGrantRecord, browserNavigationPolicy,
  BROWSER_GRANT_IDLE_MS } = Grant
const { evaluateNavigation } = await import('../helper/egdesk-browser-url-policy.mjs')

// A stand-in for Services.eTLD.getBaseDomainFromHost: the last two labels,
// three for co.kr.
const eTLD = host => { const labels = host.split('.'); const keep = labels.slice(-2).join('.') === 'co.kr' ? 3 : 2; return labels.slice(-keep).join('.') }
const binding = (url = 'https://shop.example.test/cart', extra = {}) => ({ cardId: 'card-1', cardEpoch: 'epoch-1', profileId: 'firefox-default',
  userContextId: 0, accountId: 'acct', engineAccountKey: 'codex:owner', authorityEpoch: 1, url, ...extra })

test('a site is the registrable domain, else the exact origin; non-web addresses have none', () => {
  assert.equal(browserGrantSite('https://shop.example.test/cart', eTLD), 'example.test')
  assert.equal(browserGrantSite('https://a.b.example.co.kr/', eTLD), 'example.co.kr')
  assert.equal(browserGrantSite('http://127.0.0.1:18181/a', eTLD), 'http://127.0.0.1:18181')
  assert.equal(browserGrantSite('http://localhost:3000/', eTLD), 'http://localhost:3000')
  assert.equal(browserGrantSite('about:blank', eTLD), null)
  assert.equal(browserGrantSite('javascript:alert(1)', eTLD), null)
  assert.equal(browserGrantSite('https://x.test/', null), 'https://x.test', 'without a suffix list the exact origin is the site')
})

test('D-B1: same site by default, allowed sites per conversation, redirects and links judged by the same rule', () => {
  const from = 'https://shop.example.test/cart'
  const sites = new Set(['pay.test'])
  assert.deepEqual(browserGrantNavigation('https://www.example.test/next', from, sites, eTLD), { allowed: true, reason: 'same-site', host: 'www.example.test' })
  assert.deepEqual(browserGrantNavigation('https://checkout.pay.test/x', from, sites, eTLD), { allowed: true, reason: 'allowed-site', host: 'checkout.pay.test' })
  assert.deepEqual(browserGrantNavigation('https://evil.test/', from, sites, eTLD), { allowed: false, reason: 'outside-site', host: 'evil.test' })
  assert.deepEqual(browserGrantNavigation('http://example.test/down', from, sites, eTLD), { allowed: false, reason: 'insecure-downgrade', host: 'example.test' })
  assert.deepEqual(browserGrantNavigation('http://pay.test/down', from, sites, eTLD), { allowed: false, reason: 'insecure-downgrade', host: 'pay.test' },
    'an allowed site does not allow an https to http downgrade')
  assert.equal(browserGrantNavigation('javascript:alert(1)', from, sites, eTLD).reason, 'scheme-not-web')
  assert.equal(browserGrantNavigation('https://user:pw@example.test/', from, sites, eTLD).reason, 'credentials-in-url')
  assert.equal(browserGrantNavigation('not a url', from, sites, eTLD).reason, 'invalid-url')
  assert.equal(browserGrantNavigation('https://example.test/', 'about:blank', new Set(), eTLD).reason, 'no-base')
  assert.equal(browserGrantNavigation('https://example.test/', 'about:blank', new Set(['example.test']), eTLD).allowed, true,
    'an allowed site is reachable even from a page without a site (a new blank Card)')
  assert.equal(browserGrantNavigation('http://127.0.0.1:18182/', 'http://127.0.0.1:18181/', new Set(), eTLD).allowed, false, 'IP origins differ by port')
})

test('the helper policy built from the conversation sites agrees with the chrome-side rule', () => {
  const sites = new Set(['pay.test', 'http://127.0.0.1:18181'])
  const policy = browserNavigationPolicy(sites)
  assert.deepEqual(policy, { scope: 'same-site', allow: ['pay.test', '*.pay.test', '127.0.0.1'], block: [], allowDowngrade: false })
  const from = 'https://shop.example.test/cart'
  for (const [url, expected] of [['https://www.example.test/a', true], ['https://checkout.pay.test/x', true], ['https://evil.test/', false]]) {
    assert.equal(evaluateNavigation(url, policy, { fromUrl: from, layer: 'tool' }).allowed, expected, url)
    assert.equal(browserGrantNavigation(url, from, sites, eTLD).allowed, expected, url)
  }
})

test('D-B3: a grant lives for the conversation and ends on card, account or site change, hold, revocation or idle', () => {
  const now = 1_000_000
  const grant = browserGrantRecord({ clientThreadId: 'thread-1', localThreadId: 'local-1', cardId: 'card-1', current: binding(), now, siteForHost: eTLD })
  assert.equal(grant.site, 'example.test')
  assert.equal(grant.openedByAgent, false)
  const state = (current, options = {}) => browserGrantState(grant, current, { now: now + 1000, siteForHost: eTLD, ...options })
  assert.deepEqual(state(binding()), { valid: true, reason: 'valid' })
  assert.deepEqual(state(binding('https://www.example.test/other')), { valid: true, reason: 'valid' }, 'same site, another page')
  assert.deepEqual(state(binding('https://checkout.pay.test/'), { sites: new Set(['pay.test']) }), { valid: true, reason: 'valid' }, 'an allowed site')
  assert.deepEqual(state(binding('https://elsewhere.test/')), { valid: false, reason: 'site-changed' })
  assert.deepEqual(state(binding('about:blank')), { valid: false, reason: 'site-changed' })
  assert.deepEqual(state(binding('https://shop.example.test/cart', { cardEpoch: 'epoch-2' })), { valid: false, reason: 'card-changed' })
  assert.deepEqual(state(binding('https://shop.example.test/cart', { accountId: 'other' })), { valid: false, reason: 'account-changed' })
  assert.deepEqual(state(binding('https://shop.example.test/cart', { authorityEpoch: 2 })), { valid: false, reason: 'account-changed' })
  assert.deepEqual(state(binding(), { held: true }), { valid: false, reason: 'held' })
  assert.deepEqual(state(null), { valid: false, reason: 'card-closed' })
  assert.deepEqual(browserGrantState({ ...grant, revoked: true }, binding(), { now, siteForHost: eTLD }), { valid: false, reason: 'revoked' })
  assert.deepEqual(browserGrantState(grant, binding(), { now: now + BROWSER_GRANT_IDLE_MS + 1, siteForHost: eTLD }), { valid: false, reason: 'idle' })
  assert.deepEqual(browserGrantState({ ...grant, lastUsedAt: now + BROWSER_GRANT_IDLE_MS }, binding(), { now: now + BROWSER_GRANT_IDLE_MS + 1, siteForHost: eTLD }),
    { valid: true, reason: 'valid' }, 'a run that used the grant keeps it alive')
})

test('D-B2: a Card the Agent opened records its origin and inherits the permission; nothing is recorded without a site', () => {
  const grant = browserGrantRecord({ clientThreadId: 'thread-1', cardId: 'card-2', current: binding('https://www.example.test/compare'),
    siteForHost: eTLD, openedByAgent: true, openedFrom: 'card-1' })
  assert.equal(grant.openedByAgent, true)
  assert.equal(grant.openedFrom, 'card-1')
  assert.equal(grant.permission, 'interact')
  assert.equal(browserGrantRecord({ clientThreadId: 'thread-1', cardId: 'card-3', current: binding('about:blank'), siteForHost: eTLD }), null)
  assert.equal(browserGrantRecord({ clientThreadId: '', cardId: 'card-3', current: binding(), siteForHost: eTLD }), null)
})
