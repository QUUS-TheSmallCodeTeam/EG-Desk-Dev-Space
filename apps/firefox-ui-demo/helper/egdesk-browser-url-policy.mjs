// Browser navigation policy for Agent-driven Browser Cards (BRW-05 groundwork, batch 1-X).
// Pure: no I/O and no node: imports, so the Firefox actor can mirror it with an
// injected siteForHost (Services.eTLD) instead of the short suffix list below.
//
// Patterns followed (rules re-written here; short rule lists adapted):
//   nanobrowser src/browser-control/core/url-policy.ts:33-80, :104-112
//     Copyright Nanobrowser authors, Apache License 2.0 — always-blocked schemes,
//     block before allow, a parse failure blocks (fail closed).
//   nanobrowser src/browser-control/core/navigation-guard.ts:1-118 (Apache-2.0) —
//     one rule for every layer: the tool argument, a card the page opened, each
//     request including redirect hops, and the committed document.
//   Stagehand packages/extension/understudy/domainPolicy.ts:163-233
//     Copyright (c) 2024 Browserbase Inc., MIT License — patterns are domain-only,
//     an exact host or a leading '*.', the block list wins.
//   agent-browser cli/src/native/network.rs:79-125 (Apache-2.0) — host-only rules.
//
// No policy (undefined or null) is today's guarded navigate rule:
// egdesk-browser-tool-runtime.mjs safeUrl + sameSiteNavigation (an http(s) URL of at
// most 2048 characters with no credentials, on the current document's site, never
// https -> http). A decision names the target host only, never its path or query.

export const SAFE_URL = 'about:blank'
export const NAVIGATION_SCOPES = Object.freeze(['same-site', 'allow-list', 'any-web'])
// What the caller does with a blocked decision at each layer (nanobrowser layers 1-4).
export const NAVIGATION_LAYER_ACTIONS = Object.freeze({
  tool: 'reject', // the navigate tool argument: refuse the call
  activation: 'reject', // a click or Enter whose link or form destination is known: refuse before dispatch
  popup: 'close', // a card the page opened: close it, never adopt it
  request: 'abort', // a main-frame document request or redirect hop: fail it before it is sent
  commit: 'replace-with-blank', // a committed document (bfcache restore sends no request): load SAFE_URL
})
export const DEFAULT_NAVIGATION_POLICY = Object.freeze({
  scope: 'same-site', allow: Object.freeze([]), block: Object.freeze([]), allowDowngrade: false,
})
export const NAVIGATION_POLICY_LIMITS = Object.freeze({ url: 2048, rules: 200, pattern: 253, hops: 20 })

// Fixed reasons. The block texts carry no URL, host or page text; a screen shows the host separately.
export const NAVIGATION_REASON_TEXT = Object.freeze({
  'same-site': Object.freeze({ ko: '지금 사이트 안의 주소입니다', en: 'The target is on the current site.' }),
  'allow-list': Object.freeze({ ko: '허용한 사이트입니다', en: 'The target matches an allowed site.' }),
  'any-web': Object.freeze({ ko: '차단 목록에 없는 웹 주소입니다', en: 'The target is a web address that is not blocked.' }),
  'blocked-host': Object.freeze({ ko: '차단한 사이트라 열지 않았습니다', en: 'Navigation blocked: the target site is on the block list.' }),
  'outside-site': Object.freeze({ ko: '지금 사이트 밖이라 열지 않았습니다', en: 'Navigation blocked: the target is outside the current site.' }),
  'not-allowed': Object.freeze({ ko: '허용한 사이트 목록에 없어 열지 않았습니다', en: 'Navigation blocked: the target is not on the allowed site list.' }),
  'insecure-downgrade': Object.freeze({ ko: '보안 연결(https)에서 보안 없는 연결(http)로 바뀌어 열지 않았습니다', en: 'Navigation blocked: https to http downgrade.' }),
  'dangerous-scheme': Object.freeze({ ko: '웹 주소(http·https)가 아니라 열지 않았습니다', en: 'Navigation blocked: only http(s) addresses can be opened.' }),
  'scheme-not-web': Object.freeze({ ko: '웹 주소(http·https)가 아니라 열지 않았습니다', en: 'Navigation blocked: only http(s) addresses can be opened.' }),
  'credentials-in-url': Object.freeze({ ko: '주소에 로그인 정보가 들어 있어 열지 않았습니다', en: 'Navigation blocked: the address carries credentials.' }),
  'invalid-url': Object.freeze({ ko: '주소를 읽을 수 없어 열지 않았습니다', en: 'Navigation blocked: the address could not be read.' }),
  'no-base': Object.freeze({ ko: '기준이 되는 사이트를 알 수 없어 열지 않았습니다', en: 'Navigation blocked: the current page is not an http(s) site to compare with.' }),
  'too-many-hops': Object.freeze({ ko: '이동이 너무 여러 번 이어져 열지 않았습니다', en: 'Navigation blocked: too many redirects.' }),
  'policy-invalid': Object.freeze({ ko: '이동 규칙을 읽을 수 없어 열지 않았습니다', en: 'Navigation blocked: the navigation policy could not be read.' }),
})

const INVALID_TARGET_REASONS = new Set(['dangerous-scheme', 'scheme-not-web', 'credentials-in-url', 'invalid-url'])
// Blocked whatever the policy says (nanobrowser DANGEROUS_PREFIXES, Firefox schemes added).
const DANGEROUS_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'ws:', 'wss:',
  'view-source:', 'jar:', 'filesystem:', 'chrome:', 'resource:', 'moz-extension:', 'chrome-extension:'])
// Mirrors egdesk-browser-tool-runtime.mjs MULTI_LABEL_SUFFIXES: listed multi-label
// suffixes (shared hosting included) never form a site, and never take an allow '*.'.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr', 'pe.kr', 'ms.kr', 'hs.kr', 'es.kr', 'sc.kr', 'kg.kr', 'mil.kr',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.tw', 'com.hk', 'com.sg',
  'com.br', 'co.nz', 'co.in', 'co.za', 'com.mx', 'com.tr',
  'github.io', 'gitlab.io', 'githubusercontent.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'appspot.com', 'herokuapp.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net',
  'amazonaws.com', 'onrender.com', 'fly.dev', 'glitch.me', 'ngrok.io', 'ngrok-free.app', 'surge.sh', 'wordpress.com',
])
// Stagehand DOMAIN_LABEL_RE, applied after the URL parser has made the host ASCII (punycode).
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4 = /^\d+(?:\.\d+){3}$/
const IPV6 = /^\[[0-9a-f:.]+\]$/

function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }

// Same rule as egdesk-browser-tool-runtime.mjs hostSite: the registrable domain from a
// short suffix list; null for IP, single-label or listed-suffix hosts (exact origin then).
export function defaultSiteForHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!host || host.includes(':') || host.startsWith('[') || IPV4.test(host) || !host.includes('.')) return null
  const labels = host.split('.')
  const keep = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2
  return labels.length >= keep ? labels.slice(-keep).join('.') : null
}

function siteWith(siteForHost, hostname) {
  try {
    const site = siteForHost(hostname)
    return typeof site === 'string' && site ? site.toLowerCase() : null
  } catch { return null }
}

// An http(s) URL the navigate tool accepts today (runtime safeUrl), or the reason it is not one.
function parseWebUrl(value) {
  if (typeof value !== 'string' || !value || value.length > NAVIGATION_POLICY_LIMITS.url ||
      /[\u0000- \u007f]/.test(value)) return { error: 'invalid-url' }
  let url
  try { url = new URL(value) } catch { return { error: 'invalid-url' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: DANGEROUS_SCHEMES.has(url.protocol) ? 'dangerous-scheme' : 'scheme-not-web' }
  }
  if (url.username || url.password) return { error: 'credentials-in-url' }
  return { url }
}

function webUrlOrNull(value) {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch { return null }
}

function canonicalHost(hostname) { return String(hostname || '').toLowerCase().replace(/\.+$/, '') }

// Domain-only pattern: an exact host, or '*.' and a base of two or more labels.
// IP and single-label hosts (localhost) are exact only. An allow '*.' may not sit on a
// listed public or shared-hosting suffix ('*.co.kr', '*.github.io'); a block one may.
function normalizeHostPattern(raw, kind) {
  if (typeof raw !== 'string') return null
  let text = raw.trim().toLowerCase().replace(/\.+$/, '')
  if (!text || text.length > NAVIGATION_POLICY_LIMITS.pattern) return null
  let wildcard = false
  if (text.startsWith('*.')) { wildcard = true; text = text.slice(2) }
  if (!text || text.includes('*')) return null
  if (IPV6.test(text)) {
    if (wildcard) return null
    try { return new URL(`http://${text}/`).hostname } catch { return null }
  }
  // Letters (any script, for IDN), digits, dots and hyphens only: no scheme, path, port, query or escapes.
  if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(text)) return null
  let host
  try { host = canonicalHost(new URL(`http://${text}/`).hostname) } catch { return null }
  if (!host || host.length > NAVIGATION_POLICY_LIMITS.pattern) return null
  const labels = host.split('.')
  if (IPV4.test(host)) return wildcard ? null : host
  if (labels.some(label => !DOMAIN_LABEL.test(label))) return null
  if (!wildcard) return host
  if (labels.length < 2) return null
  if (kind === 'allow' && MULTI_LABEL_SUFFIXES.has(host)) return null
  return `*.${host}`
}

function matchingRule(host, rules) {
  for (const rule of rules) {
    if (rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule) return rule
  }
  return null
}

function invalid(field, index) {
  const failure = { ok: false, code: 'BROWSER_NAVIGATION_POLICY_INVALID', field }
  if (Number.isInteger(index)) failure.index = index
  return Object.freeze(failure)
}

// { ok: true, policy } with a frozen, deduplicated policy, or { ok: false, code, field, index? }.
// Unknown keys are refused, so a misspelt block list never silently means "no block list".
export function normalizeNavigationPolicy(input) {
  if (input === undefined || input === null) return Object.freeze({ ok: true, policy: DEFAULT_NAVIGATION_POLICY })
  if (!record(input)) return invalid('policy')
  for (const key of Object.keys(input)) {
    if (!['scope', 'allow', 'block', 'allowDowngrade'].includes(key)) return invalid('unknown')
  }
  const scope = input.scope ?? 'same-site'
  if (!NAVIGATION_SCOPES.includes(scope)) return invalid('scope')
  if (input.allowDowngrade !== undefined && typeof input.allowDowngrade !== 'boolean') return invalid('allowDowngrade')
  const lists = {}
  for (const kind of ['allow', 'block']) {
    const raw = input[kind] ?? []
    if (!Array.isArray(raw) || raw.length > NAVIGATION_POLICY_LIMITS.rules) return invalid(kind)
    const rules = []
    for (let index = 0; index < raw.length; index++) {
      const rule = normalizeHostPattern(raw[index], kind)
      if (!rule) return invalid(kind, index)
      if (!rules.includes(rule)) rules.push(rule)
    }
    lists[kind] = Object.freeze(rules)
  }
  return Object.freeze({ ok: true, policy: Object.freeze({
    scope, allow: lists.allow, block: lists.block, allowDowngrade: input.allowDowngrade === true,
  }) })
}

function decide(allowed, reason, layer, extra = {}) {
  const decision = { allowed, reason, layer, action: allowed ? 'continue' : NAVIGATION_LAYER_ACTIONS[layer],
    host: extra.host ?? null, scope: extra.scope ?? null }
  if (extra.rule) decision.rule = extra.rule
  if (!allowed) decision.code = INVALID_TARGET_REASONS.has(reason) ? 'INVALID_BROWSER_TOOL' : 'BROWSER_NAVIGATE_OUT_OF_SCOPE'
  return Object.freeze(decision)
}

// evaluateNavigation(url, policy?, { fromUrl, anchorUrl, layer, siteForHost })
//   fromUrl     the document the navigation starts from (the observed page today)
//   anchorUrl   optional site the policy is pinned to (for example where the Run began);
//               'same-site' compares with it instead of fromUrl, so allowed hops cannot drift
//   layer       'tool' (default) | 'activation' | 'popup' | 'request' | 'commit'
//   siteForHost optional registrable-domain function; the Firefox actor passes
//               Services.eTLD.getBaseDomainFromHost (a throw or empty answer means exact origin)
// -> frozen { allowed, reason, layer, action, host, scope, rule?, code? }
// Order: policy readable -> target is a safe http(s) URL -> block list -> no https->http
// downgrade (unless allowDowngrade) -> scope ('any-web' | allow list | 'same-site').
export function evaluateNavigation(url, policy, context = {}) {
  const ctx = record(context) ? context : {}
  const layer = Object.hasOwn(NAVIGATION_LAYER_ACTIONS, ctx.layer) ? ctx.layer : 'tool'
  const normalized = normalizeNavigationPolicy(policy)
  if (!normalized.ok) return decide(false, 'policy-invalid', layer)
  const rules = normalized.policy
  const target = parseWebUrl(url)
  if (target.error) return decide(false, target.error, layer, { scope: rules.scope })
  const host = canonicalHost(target.url.hostname)
  const facts = { host, scope: rules.scope }
  const blockedBy = matchingRule(host, rules.block)
  if (blockedBy) return decide(false, 'blocked-host', layer, { ...facts, rule: blockedBy })
  const from = webUrlOrNull(ctx.fromUrl)
  if (from?.protocol === 'https:' && target.url.protocol === 'http:' && !rules.allowDowngrade) {
    return decide(false, 'insecure-downgrade', layer, facts)
  }
  if (rules.scope === 'any-web') return decide(true, 'any-web', layer, facts)
  const allowedBy = matchingRule(host, rules.allow)
  if (allowedBy) return decide(true, 'allow-list', layer, { ...facts, rule: allowedBy })
  if (rules.scope === 'allow-list') return decide(false, 'not-allowed', layer, facts)
  // A given anchor that is not an http(s) URL blocks; it never falls back to fromUrl.
  const base = ctx.anchorUrl === undefined || ctx.anchorUrl === null ? from : webUrlOrNull(ctx.anchorUrl)
  if (!base) return decide(false, 'no-base', layer, facts)
  // https -> http is refused above for fromUrl; an http(s) anchor is compared by site only.
  const siteForHost = typeof ctx.siteForHost === 'function' ? ctx.siteForHost : defaultSiteForHost
  const baseSite = siteWith(siteForHost, base.hostname)
  const targetSite = siteWith(siteForHost, target.url.hostname)
  // IP, single-label and public-suffix hosts are scoped to their exact origin (runtime rule).
  const same = baseSite && targetSite ? baseSite === targetSite : base.origin === target.url.origin
  return same ? decide(true, 'same-site', layer, facts) : decide(false, 'outside-site', layer, facts)
}

// Every hop of a redirect chain is judged against the same fromUrl/anchorUrl, never
// against the previous hop, so a chain cannot walk off the site one allowed step at a time.
// -> frozen { allowed, blockedAt, decision } (decision: the first blocked hop, else the last hop)
export function evaluateNavigationChain(urls, policy, context = {}) {
  const ctx = { ...(record(context) ? context : {}) }
  if (!Object.hasOwn(NAVIGATION_LAYER_ACTIONS, ctx.layer)) ctx.layer = 'request'
  if (!Array.isArray(urls) || urls.length === 0) {
    return Object.freeze({ allowed: false, blockedAt: 0, decision: decide(false, 'invalid-url', ctx.layer) })
  }
  if (urls.length > NAVIGATION_POLICY_LIMITS.hops + 1) {
    return Object.freeze({ allowed: false, blockedAt: NAVIGATION_POLICY_LIMITS.hops + 1,
      decision: decide(false, 'too-many-hops', ctx.layer) })
  }
  let decision = null
  for (let index = 0; index < urls.length; index++) {
    decision = evaluateNavigation(urls[index], policy, ctx)
    if (!decision.allowed) return Object.freeze({ allowed: false, blockedAt: index, decision })
  }
  return Object.freeze({ allowed: true, blockedAt: null, decision })
}

// For "allow this site" in a conversation (D-B1 option 2): what a person types or a
// page address -> the allow patterns for its whole site ('example.com' and '*.example.com'),
// or the exact host for an IP or single-label host. Never returns the path or query.
export function sitePatternsFromInput(entry, options = {}) {
  if (typeof entry !== 'string' || !entry.trim() || entry.length > NAVIGATION_POLICY_LIMITS.url) {
    return Object.freeze({ ok: false, reason: 'invalid-url' })
  }
  const text = entry.trim()
  const parsed = parseWebUrl(/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(text)
    ? text : `https://${text}`)
  if (parsed.error) return Object.freeze({ ok: false, reason: parsed.error })
  const host = canonicalHost(parsed.url.hostname)
  const siteForHost = typeof options.siteForHost === 'function' ? options.siteForHost : defaultSiteForHost
  const site = siteWith(siteForHost, parsed.url.hostname)
  const patterns = site ? [site, `*.${site}`] : [host]
  for (const pattern of patterns) {
    if (!normalizeHostPattern(pattern, 'allow')) return Object.freeze({ ok: false, reason: 'invalid-url' })
  }
  return Object.freeze({ ok: true, site: site ?? host, patterns: Object.freeze(patterns) })
}

// A new normalized policy with the entry's site added to the allow list (scope unchanged).
// -> { ok: true, policy } | { ok: false, reason } | the normalize failure
export function addAllowedSite(policy, entry, options = {}) {
  const current = normalizeNavigationPolicy(policy)
  if (!current.ok) return current
  const site = sitePatternsFromInput(entry, options)
  if (!site.ok) return site
  return normalizeNavigationPolicy({ ...current.policy, allow: [...current.policy.allow, ...site.patterns],
    block: [...current.policy.block] })
}

// GET form landing: preserve submitted parameters; the site may add others.
export function formResultLanded(actual, expected) {
  let a, e
  try { a = new URL(actual); e = new URL(expected) } catch { return false }
  const path = url => url.pathname.replace(/\/+$/, '') || '/'
  if (a.origin !== e.origin || path(a) !== path(e)) return false
  const submitted = [...e.searchParams].filter(([, value]) => value !== '')
  return submitted.length > 0 && submitted.every(([name, value]) => a.searchParams.getAll(name).includes(value))
}
