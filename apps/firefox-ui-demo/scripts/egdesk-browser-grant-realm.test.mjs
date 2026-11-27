import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { cardSiteRule } from '../helper/egdesk-card-site-rule.fixture.mjs'

// L6 a1 (D25): in Firefox the Card's code runs in the browser window and EGDeskBrowserGrant.sys.mjs runs in the global
// ChromeUtils.importESModule gives it, so a Set the window makes is NOT `instanceof Set` inside the module (the same note
// is in EGDeskViewportExtras.sys.mjs for a Map). Node runs everything in one global, which is why the replays never saw it.
// Here the "window" is a vm context: its Set and Array are another global's, exactly as in Firefox.
const Grant = await import('../overlay/resources/EGDeskBrowserGrant.sys.mjs')
const { evaluateNavigation } = await import('../helper/egdesk-browser-url-policy.mjs')
const { browserGrantNavigation, browserNavigationPolicy, browserGrantState } = Grant

// Services.eTLD.getBaseDomainFromHost for the hosts used here ('google' is a public suffix, so about.google is its own site).
const eTLD = host => host.split('.').slice(-2).join('.')
const FROM = 'https://www.google.com/'
const ABOUT = 'https://about.google/?fg=1&utm_source=google-KR&utm_medium=referral&utm_campaign=hp-header'
const windowSet = values => runInNewContext('new Set(values)', { values })
const windowArray = values => runInNewContext('Array.from(values)', { values })

test('D25: a Set or an array made in another global (the browser window) is read like one made here', () => {
  for (const sites of [windowSet(['about.google']), windowArray(['about.google'])]) {
    assert.equal(sites instanceof Set || sites instanceof Array, false, 'the stand-in really is another global\'s object')
    assert.deepEqual(browserGrantNavigation(ABOUT, FROM, sites, eTLD), { allowed: true, reason: 'allowed-site', host: 'about.google' },
      'an allowed site is allowed whatever global its set was made in')
    assert.deepEqual(browserNavigationPolicy(sites).allow, ['about.google', '*.about.google'], 'the policy the Card sends the helper lists it')
  }
  // still closed: another site, nothing allowed, and anything that is not a set or an array
  assert.equal(browserGrantNavigation('https://evil.test/', FROM, windowSet(['about.google']), eTLD).reason, 'outside-site')
  assert.equal(browserGrantNavigation(ABOUT, FROM, windowSet([]), eTLD).reason, 'outside-site')
  for (const notSites of [null, undefined, 'about.google', { 'about.google': true }, runInNewContext('new Map([["about.google", 1]])')]) {
    assert.equal(browserGrantNavigation(ABOUT, FROM, notSites, eTLD).reason, 'outside-site', `not a site list: ${Object.prototype.toString.call(notSites)}`)
    assert.deepEqual(browserNavigationPolicy(notSites).allow, [])
  }
})

test('D25: a Card on a site the conversation allowed keeps its grant when that set comes from the window', () => {
  const current = { cardEpoch: 'e1', profileId: 'p', userContextId: 0, accountId: 'a', engineAccountKey: 'k', authorityEpoch: 1, url: ABOUT }
  const grant = { ...current, site: 'google.com', grantedAt: Date.now(), lastUsedAt: Date.now(), revoked: false }
  assert.deepEqual(browserGrantState(grant, current, { sites: windowSet(['about.google']), siteForHost: eTLD }), { valid: true, reason: 'valid' })
  assert.deepEqual(browserGrantState(grant, current, { sites: windowSet([]), siteForHost: eTLD }), { valid: false, reason: 'site-changed' })
})

// The Card's own code for a conversation's sites (eg-desk-surface.uc.js), run in a window-like global with the module from this one.
const cardSites = () => cardSiteRule({ siteForHost: eTLD })

test('D25 reproduction: after the person allows about.google, the Card\'s own rule lets the move through and tells the helper', () => {
  const card = cardSites()
  const thread = 'thread-1'
  assert.equal(card.browserToolNavigationAllowed(thread, ABOUT, FROM).reason, 'outside-site', 'before the answer it is outside')
  card.browserToolThreadSiteSet(thread).add('about.google') // what browserToolCardRequest does on 'allowed'
  // the chrome move (browserToolNavigateChrome) and the commit guard (enforceAgentNavigationGuard) both ask this
  assert.deepEqual(card.browserToolNavigationAllowed(thread, ABOUT, FROM), { allowed: true, reason: 'allowed-site', host: 'about.google' })
  // the answer's navigationPolicy: the helper's own copy now holds the site, so it sends the move by the allowed-site route
  const policy = card.browserToolNavigationPolicy(thread)
  assert.deepEqual(policy.allow, ['about.google', '*.about.google'])
  assert.equal(evaluateNavigation(ABOUT, policy, { fromUrl: FROM, layer: 'tool' }).reason, 'allow-list')
  // another conversation did not allow it; a site nobody allowed stays outside
  assert.equal(card.browserToolNavigationAllowed('thread-2', ABOUT, FROM).reason, 'outside-site')
  assert.equal(card.browserToolNavigationAllowed(thread, 'https://evil.test/', FROM).reason, 'outside-site')
  assert.equal(card.browserToolNavigationAllowed(thread, 'https://www.google.com/search?q=x', FROM).reason, 'same-site')
})
