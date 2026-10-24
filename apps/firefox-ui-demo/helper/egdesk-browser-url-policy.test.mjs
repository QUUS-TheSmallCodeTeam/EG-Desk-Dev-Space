import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NAVIGATION_POLICY, NAVIGATION_LAYER_ACTIONS, NAVIGATION_REASON_TEXT, SAFE_URL,
  addAllowedSite, defaultSiteForHost, evaluateNavigation, evaluateNavigationChain,
  normalizeNavigationPolicy, sitePatternsFromInput,
} from './egdesk-browser-url-policy.mjs'
import { sameSiteNavigation } from './egdesk-browser-tool-runtime.mjs'

// egdesk-browser-tool-runtime.mjs safeUrl (not exported), restated: the navigate tool's
// argument check that runs before sameSiteNavigation.
function runtimeSafeUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000- \u007f]/.test(value)) return false
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }
  catch { return false }
}

const allowed = (url, policy, context) => evaluateNavigation(url, policy, context).allowed

test('no policy is today\'s guarded navigate rule (safeUrl + sameSiteNavigation), case by case', () => {
  const froms = ['https://a.example.co.kr/x', 'https://alpha.co.kr/', 'https://alice.github.io/', 'http://example.test/a',
    'https://example.test/a', 'http://127.0.0.1:18181/a', 'http://localhost:3000/', 'about:blank', 'https://www.naver.com/',
    'https://shop.example.com:8443/cart', 'http://[::1]:8080/', 'https://example.com./x', 'not a url']
  const tos = ['https://b.example.co.kr/y', 'https://beta.co.kr/', 'https://bob.github.io/', 'https://www.example.test/b',
    'http://example.test/b', 'http://127.0.0.1:18181/b', 'http://127.0.0.1:18182/a', 'http://localhost:3000/next',
    'javascript:alert(1)', 'https://example.test/', 'https://m.naver.com/path?q=1', 'https://naver.com.evil.test/',
    'https://shop.example.com/other', 'http://[::1]:8080/x', 'https://example.com/y', 'https://user:pw@example.test/',
    'data:text/html,x', 'file:///etc/passwd', `https://example.test/${'a'.repeat(2100)}`, 'https://example.test/ a',
    'https://alice.github.io/repo', 'blob:https://example.test/uuid', 'about:blank']
  let compared = 0
  for (const from of froms) {
    for (const to of tos) {
      const expected = runtimeSafeUrl(to) && sameSiteNavigation(from, to)
      assert.equal(allowed(to, undefined, { fromUrl: from }), expected, `${from} -> ${to}`)
      assert.equal(allowed(to, null, { fromUrl: from }), expected, `null policy: ${from} -> ${to}`)
      compared++
    }
  }
  assert.equal(compared, froms.length * tos.length)
  assert.equal(normalizeNavigationPolicy(undefined).policy, DEFAULT_NAVIGATION_POLICY)
  assert.deepEqual(normalizeNavigationPolicy({}).policy, DEFAULT_NAVIGATION_POLICY)
})

test('the runtime\'s own same-site cases keep their answers', () => {
  for (const [from, to, expected] of [
    ['https://a.example.co.kr/x', 'https://b.example.co.kr/y', true],
    ['https://alpha.co.kr/', 'https://beta.co.kr/', false],
    ['https://alice.github.io/', 'https://bob.github.io/', false],
    ['http://example.test/a', 'https://www.example.test/b', true],
    ['https://example.test/a', 'http://example.test/b', false],
    ['http://127.0.0.1:18181/a', 'http://127.0.0.1:18181/b', true],
    ['http://127.0.0.1:18181/a', 'http://127.0.0.1:18182/a', false],
    ['http://localhost:3000/', 'http://localhost:3000/next', true],
    ['https://example.test/', 'javascript:alert(1)', false],
    ['about:blank', 'https://example.test/', false],
  ]) assert.equal(allowed(to, undefined, { fromUrl: from }), expected, `${from} -> ${to}`)
})

test('a decision names a fixed reason, the host only and what to do at its layer', () => {
  const secret = 'TOKEN_SENTINEL_7f31'
  const blocked = evaluateNavigation(`https://other.test/reset/${secret}?code=${secret}#${secret}`, undefined,
    { fromUrl: 'https://example.test/' })
  assert.deepEqual({ ...blocked }, { allowed: false, reason: 'outside-site', layer: 'tool', action: 'reject',
    host: 'other.test', scope: 'same-site', code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' })
  assert.equal(JSON.stringify(blocked).includes(secret), false, 'no path, query or fragment')
  assert.ok(Object.isFrozen(blocked))
  const ok = evaluateNavigation('https://www.example.test/a', undefined, { fromUrl: 'https://example.test/' })
  assert.deepEqual({ ...ok }, { allowed: true, reason: 'same-site', layer: 'tool', action: 'continue',
    host: 'www.example.test', scope: 'same-site' })
  for (const [layer, action] of Object.entries(NAVIGATION_LAYER_ACTIONS)) {
    assert.equal(evaluateNavigation('https://other.test/', undefined, { fromUrl: 'https://example.test/', layer }).action, action)
  }
  assert.equal(evaluateNavigation('https://other.test/', undefined, { fromUrl: 'https://example.test/', layer: 'nope' }).layer, 'tool')
  assert.equal(evaluateNavigation('javascript:alert(1)', undefined, { fromUrl: 'https://example.test/' }).code, 'INVALID_BROWSER_TOOL')
  for (const decision of [blocked, ok]) assert.ok(NAVIGATION_REASON_TEXT[decision.reason].ko)
})

test('target checks: dangerous and non-web schemes, credentials, bad addresses', () => {
  const from = { fromUrl: 'https://example.test/' }
  const reason = (url, policy = { scope: 'any-web' }) => evaluateNavigation(url, policy, from).reason
  for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'file:///etc/passwd',
    'vbscript:x', 'blob:https://example.test/uuid', 'wss://example.test/', 'view-source:https://example.test/',
    'moz-extension://abc/page.html', 'chrome://browser/content/browser.xhtml']) {
    assert.equal(reason(url), 'dangerous-scheme', url)
  }
  assert.equal(reason('about:blank'), 'scheme-not-web', 'SAFE_URL is not a navigation target')
  assert.equal(SAFE_URL, 'about:blank')
  assert.equal(reason('mailto:a@example.test'), 'scheme-not-web')
  assert.equal(reason('https://user:pw@example.test/'), 'credentials-in-url')
  assert.equal(reason('https://user@example.test/'), 'credentials-in-url')
  for (const url of ['', ' https://example.test/', 'https://exa mple.test/', 'https://example.test/\u0007',
    `https://example.test/${'a'.repeat(2049)}`, 'not a url', null, 42, {}]) {
    assert.equal(reason(url), 'invalid-url', String(url).slice(0, 40))
  }
})

test('block wins over same site, allow list and any-web; exact host or leading *. only', () => {
  const from = { fromUrl: 'https://example.test/' }
  const policy = { block: ['ads.example.test', '*.evil.test'], allow: ['ads.example.test', 'partner.test'] }
  assert.equal(evaluateNavigation('https://ads.example.test/', policy, from).reason, 'blocked-host')
  assert.equal(evaluateNavigation('https://ads.example.test/', policy, from).rule, 'ads.example.test')
  assert.equal(allowed('https://www.example.test/', policy, from), true, 'same site still allowed')
  assert.equal(allowed('https://evil.test/', { scope: 'any-web', block: ['*.evil.test'] }, from), true,
    "'*.' is subdomains only (Stagehand); list the apex too to block it")
  assert.equal(evaluateNavigation('https://a.b.evil.test/', { scope: 'any-web', block: ['*.evil.test'] }, from).reason,
    'blocked-host')
  assert.equal(allowed('https://notevil.test/', { scope: 'any-web', block: ['*.evil.test', 'evil.test'] }, from), true)
  // Trailing dots and case are the same host.
  assert.equal(evaluateNavigation('https://EVIL.test./x', { scope: 'any-web', block: ['evil.test'] }, from).reason, 'blocked-host')
  assert.equal(evaluateNavigation('https://evil.test/x', { scope: 'any-web', block: ['Evil.Test.'] }, from).reason, 'blocked-host')
  // Ports never matter to a host rule; IPs and localhost are exact hosts.
  assert.equal(evaluateNavigation('http://127.0.0.1:8787/x', { scope: 'any-web', block: ['127.0.0.1'] }, { fromUrl: 'http://localhost/' }).reason, 'blocked-host')
  assert.equal(allowed('http://localhost:8787/x', { scope: 'any-web', block: ['127.0.0.1'] }, { fromUrl: 'http://localhost/' }), true)
})

test('scopes: same site plus allowed sites, allow list only, any web', () => {
  const from = { fromUrl: 'https://shop.example.test/cart' }
  const widened = { allow: ['pay.partner.test', '*.cdn.test'] }
  assert.equal(evaluateNavigation('https://pay.partner.test/checkout', widened, from).reason, 'allow-list')
  assert.equal(evaluateNavigation('https://pay.partner.test/checkout', widened, from).rule, 'pay.partner.test')
  assert.equal(evaluateNavigation('https://login.partner.test/', widened, from).reason, 'outside-site', 'exact host only')
  assert.equal(allowed('https://img.cdn.test/a.png', widened, from), true)
  assert.equal(allowed('https://cdn.test/a.png', widened, from), false)
  assert.equal(allowed('https://www.example.test/', widened, from), true, 'same site stays allowed')

  const only = { scope: 'allow-list', allow: ['docs.test'] }
  assert.equal(allowed('https://docs.test/a', only, from), true)
  assert.equal(evaluateNavigation('https://www.example.test/', only, from).reason, 'not-allowed', 'no implicit same site')
  assert.equal(allowed('https://docs.test/a', only), true, 'allow-list needs no base page')
  assert.equal(evaluateNavigation('https://docs.test/a', { scope: 'allow-list' }, from).reason, 'not-allowed')

  const open = { scope: 'any-web', block: ['bank.test'] }
  assert.equal(evaluateNavigation('https://anything.test/', open, from).reason, 'any-web')
  assert.equal(allowed('https://anything.test/', open), true)
  assert.equal(allowed('https://bank.test/', open, from), false)
})

test('https to http is refused in every scope unless the policy allows downgrades', () => {
  const from = { fromUrl: 'https://example.test/' }
  for (const policy of [undefined, { allow: ['plain.test'] }, { scope: 'allow-list', allow: ['plain.test'] }, { scope: 'any-web' }]) {
    assert.equal(evaluateNavigation('http://plain.test/', policy, from).reason, 'insecure-downgrade')
  }
  assert.equal(allowed('http://plain.test/', { scope: 'any-web', allowDowngrade: true }, from), true)
  assert.equal(allowed('http://www.example.test/', { allowDowngrade: true }, from), true)
  assert.equal(allowed('http://plain.test/', { scope: 'any-web' }, { fromUrl: 'http://example.test/' }), true)
  assert.equal(allowed('http://plain.test/', { scope: 'any-web' }), true, 'no page to downgrade from')
})

test('same site needs an http(s) base; an anchor pins the site so allowed hops cannot drift', () => {
  assert.equal(evaluateNavigation('https://example.test/', undefined, {}).reason, 'no-base')
  assert.equal(evaluateNavigation('https://example.test/', undefined, { fromUrl: 'about:blank' }).reason, 'no-base')
  const pinned = { allow: ['login.partner.test'] }
  // Without an anchor the base is the current page: from the partner page its whole site is "same site".
  assert.equal(allowed('https://evil.partner.test/', pinned, { fromUrl: 'https://login.partner.test/' }), true)
  // With the Run's site as anchor, only the exact allowed host is reachable there.
  const anchored = { fromUrl: 'https://login.partner.test/', anchorUrl: 'https://www.example.test/start' }
  assert.equal(evaluateNavigation('https://evil.partner.test/', pinned, anchored).reason, 'outside-site')
  assert.equal(allowed('https://login.partner.test/next', pinned, anchored), true)
  assert.equal(allowed('https://example.test/back', pinned, anchored), true)
  assert.equal(evaluateNavigation('https://example.test/', undefined, { fromUrl: 'https://example.test/', anchorUrl: 'about:blank' }).reason,
    'no-base', 'a given anchor that is not a site never falls back to the page')
  assert.equal(allowed('https://example.test/', undefined, { fromUrl: 'https://example.test/', anchorUrl: null }), true)
})

test('the Firefox actor can pass its Public Suffix List; a failing lookup means exact origin', () => {
  const psl = host => {
    const known = { 'a.example.co.uk': 'example.co.uk', 'b.example.co.uk': 'example.co.uk', 'x.myshop.test': 'myshop.test',
      'y.myshop.test': 'myshop.test' }
    if (!(host in known)) throw new Error('NS_ERROR_HOST_IS_IP_ADDRESS')
    return known[host]
  }
  const context = { fromUrl: 'https://a.example.co.uk/', siteForHost: psl }
  assert.equal(allowed('https://b.example.co.uk/', undefined, context), true)
  assert.equal(allowed('https://y.myshop.test/', undefined, { fromUrl: 'https://x.myshop.test/', siteForHost: psl }), true)
  assert.equal(allowed('https://other.test/', undefined, context), false)
  // Throws for both: exact origin decides.
  assert.equal(allowed('https://q.unknown.test/a', undefined, { fromUrl: 'https://q.unknown.test/b', siteForHost: psl }), true)
  assert.equal(allowed('https://r.unknown.test/a', undefined, { fromUrl: 'https://q.unknown.test/b', siteForHost: psl }), false)
  assert.equal(defaultSiteForHost('www.example.co.kr'), 'example.co.kr')
  assert.equal(defaultSiteForHost('alice.github.io'), 'alice.github.io')
  assert.equal(defaultSiteForHost('127.0.0.1'), null)
  assert.equal(defaultSiteForHost('localhost'), null)
})

test('a policy that cannot be read blocks everything; normalize names the field, never the value', () => {
  const from = { fromUrl: 'https://example.test/' }
  const secret = 'PATTERN_SENTINEL_19ab'
  for (const [policy, field, index] of [
    ['same-site', 'policy'], [[], 'policy'], [{ scope: 'everything' }, 'scope'], [{ blocked: ['x.test'] }, 'unknown'],
    [{ allow: 'x.test' }, 'allow'], [{ block: [42] }, 'block', 0], [{ allow: ['ok.test', `https://${secret}.test/`] }, 'allow', 1],
    [{ allow: ['x.test:443'] }, 'allow', 0], [{ allow: ['x.test/path'] }, 'allow', 0], [{ allow: ['*'] }, 'allow', 0],
    [{ allow: ['a.*.test'] }, 'allow', 0], [{ allow: ['*.com'] }, 'allow', 0], [{ allow: ['*.co.kr'] }, 'allow', 0],
    [{ allow: ['*.github.io'] }, 'allow', 0], [{ allow: ['*.127.0.0.1'] }, 'allow', 0], [{ allow: ['*.localhost'] }, 'allow', 0],
    [{ allow: ['ex%41mple.test'] }, 'allow', 0], [{ allow: ['under_score.test'] }, 'allow', 0], [{ allow: [''] }, 'allow', 0],
    [{ allowDowngrade: 'yes' }, 'allowDowngrade'], [{ allow: Array(201).fill('a.test') }, 'allow'],
  ]) {
    const result = normalizeNavigationPolicy(policy)
    assert.equal(result.ok, false, JSON.stringify(policy).slice(0, 60))
    assert.equal(result.code, 'BROWSER_NAVIGATION_POLICY_INVALID')
    assert.equal(result.field, field)
    assert.equal(result.index, index)
    assert.equal(JSON.stringify(result).includes(secret), false)
    const decision = evaluateNavigation('https://www.example.test/', policy, from)
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'policy-invalid')
    assert.equal(decision.code, 'BROWSER_NAVIGATE_OUT_OF_SCOPE')
  }
  // A block list may be broad where an allow list may not.
  assert.equal(normalizeNavigationPolicy({ block: ['*.co.kr', '*.github.io'] }).ok, true)
})

test('normalize lowercases, drops trailing dots, deduplicates and turns IDN into the URL host', () => {
  const { policy } = normalizeNavigationPolicy({ scope: 'same-site',
    allow: [' Partner.TEST. ', 'partner.test', '*.CDN.test', '네이버.com', '127.0.0.1', 'localhost', '[::1]'], block: [] })
  assert.deepEqual([...policy.allow], ['partner.test', '*.cdn.test', 'xn--950bt9s8xi.com', '127.0.0.1', 'localhost', '[::1]'])
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.allow))
  assert.equal(allowed('https://네이버.com/', { scope: 'allow-list', allow: ['네이버.com'] }), true)
  assert.equal(allowed('http://[::1]:9000/', { scope: 'allow-list', allow: ['[::1]'] }), true)
})

test('redirect chains are judged hop by hop against the same base', () => {
  const ctx = { fromUrl: 'https://example.test/login' }
  const ok = evaluateNavigationChain(['https://example.test/a', 'https://sso.example.test/b', 'https://example.test/done'], undefined, ctx)
  assert.equal(ok.allowed, true)
  assert.equal(ok.blockedAt, null)
  assert.equal(ok.decision.layer, 'request')
  const leak = evaluateNavigationChain(['https://example.test/a', 'https://tracker.test/r?to=x', 'https://example.test/done'], undefined, ctx)
  assert.equal(leak.allowed, false)
  assert.equal(leak.blockedAt, 1)
  assert.equal(leak.decision.reason, 'outside-site')
  assert.equal(leak.decision.action, 'abort')
  const drift = evaluateNavigationChain(['https://login.partner.test/', 'https://evil.partner.test/'],
    { allow: ['login.partner.test'] }, ctx)
  assert.equal(drift.blockedAt, 1, 'each hop compares with the starting page, not the previous hop')
  const down = evaluateNavigationChain(['https://example.test/a', 'http://example.test/b'], undefined, ctx)
  assert.equal(down.decision.reason, 'insecure-downgrade')
  assert.equal(evaluateNavigationChain([], undefined, ctx).allowed, false)
  assert.equal(evaluateNavigationChain('https://example.test/', undefined, ctx).allowed, false)
  const long = evaluateNavigationChain(Array(22).fill('https://example.test/'), undefined, ctx)
  assert.equal(long.decision.reason, 'too-many-hops')
  assert.equal(evaluateNavigationChain(Array(21).fill('https://example.test/'), undefined, ctx).allowed, true)
})

test('allow this site: typed entries become whole-site patterns without path or query', () => {
  const secret = 'QUERY_SENTINEL_2c4d'
  assert.deepEqual({ ...sitePatternsFromInput(`https://www.Example.co.kr/path?x=${secret}`) },
    { ok: true, site: 'example.co.kr', patterns: ['example.co.kr', '*.example.co.kr'] })
  assert.equal(JSON.stringify(sitePatternsFromInput(`https://www.example.co.kr/?x=${secret}`)).includes(secret), false)
  assert.deepEqual([...sitePatternsFromInput('example.com').patterns], ['example.com', '*.example.com'])
  assert.deepEqual([...sitePatternsFromInput('alice.github.io/repo').patterns], ['alice.github.io', '*.alice.github.io'])
  assert.deepEqual([...sitePatternsFromInput('localhost:3000').patterns], ['localhost'])
  assert.deepEqual([...sitePatternsFromInput('http://127.0.0.1:8080/x').patterns], ['127.0.0.1'])
  assert.deepEqual([...sitePatternsFromInput('github.io').patterns], ['github.io'])
  for (const [entry, reason] of [['javascript:alert(1)', 'dangerous-scheme'], ['mailto:a@b.test', 'scheme-not-web'],
    ['https://u:p@example.test/', 'credentials-in-url'], ['', 'invalid-url'], ['   ', 'invalid-url'], [null, 'invalid-url']]) {
    assert.equal(sitePatternsFromInput(entry).reason, reason, String(entry))
  }
  const added = addAllowedSite(undefined, 'https://pay.partner.test/checkout')
  assert.equal(added.ok, true)
  assert.deepEqual([...added.policy.allow], ['partner.test', '*.partner.test'])
  assert.equal(added.policy.scope, 'same-site')
  assert.equal(allowed('https://pay.partner.test/x', added.policy, { fromUrl: 'https://shop.test/' }), true)
  const again = addAllowedSite(added.policy, 'partner.test')
  assert.deepEqual([...again.policy.allow], ['partner.test', '*.partner.test'], 'no duplicates')
  assert.equal(addAllowedSite({ scope: 'bad' }, 'x.test').ok, false)
  assert.equal(addAllowedSite(undefined, 'javascript:x').ok, false)
})
