// BRW-11 (D-B3), BRW-05 (D-B1) and BRW-07 (D-B2): the standing interaction grant
// one Browser Card holds for one conversation, the sites that conversation may
// open, and the rule every Agent navigation (tool argument, link, redirect,
// history move, new Card) is judged by. Pure: no Services and no DOM. The
// caller passes siteForHost (Services.eTLD.getBaseDomainFromHost) and a clock.
// Mirrors helper/egdesk-browser-url-policy.mjs for the helper's copy of the
// rule; the helper's policy object is produced here by browserNavigationPolicy.

// D-B3 says "idle" without a number; 30 minutes without a run using the grant.
export const BROWSER_GRANT_IDLE_MS = 30 * 60 * 1000;
export const BROWSER_GRANT_REASONS = Object.freeze(['valid', 'card-changed', 'account-changed', 'site-changed',
  'idle', 'revoked', 'card-closed', 'held']);
export const BROWSER_GRANT_NAVIGATION_REASONS = Object.freeze(['same-site', 'allowed-site', 'outside-site',
  'insecure-downgrade', 'scheme-not-web', 'credentials-in-url', 'invalid-url', 'no-base']);
const CARD_FIELDS = Object.freeze(['cardEpoch', 'profileId', 'userContextId']);
const ACCOUNT_FIELDS = Object.freeze(['accountId', 'engineAccountKey', 'authorityEpoch']);
const WEB = new Set(['http:', 'https:']);

function webUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000- \u007f]/.test(value)) return null;
  try { const url = new URL(value); return WEB.has(url.protocol) ? url : null; } catch { return null; }
}
function canonicalHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '');
}
// L6 a1 (D25): the Card's set of a conversation's allowed sites is made in the browser window, another
// global than this module (ChromeUtils.importESModule gives it its own), where `instanceof Set` is false
// (EGDeskViewportExtras.sys.mjs has the same note for a Map): every allowed site used to read as none.
// A Set from any global, or an array, is read by its entries; anything else is no sites.
function siteSet(sites) {
  if (Array.isArray(sites) || Object.prototype.toString.call(sites) === '[object Set]') return new Set(sites);
  return new Set();
}
// Registrable domain of a host, or null for an IP, single-label or unknown
// host (then the exact origin is the site). A failing lookup means null.
function siteWith(siteForHost, hostname) {
  const host = canonicalHost(hostname);
  if (!host || host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host) || !host.includes('.')) return null;
  if (typeof siteForHost !== 'function') return null;
  try {
    const site = siteForHost(host);
    if (typeof site !== 'string' || !site) return null;
    const lower = site.toLowerCase();
    return host === lower || host.endsWith(`.${lower}`) ? lower : null;
  } catch { return null; }
}

// The "site" of a page for grant and allow-list purposes: its registrable
// domain, else its exact origin. null when the address is not http(s).
export function browserGrantSite(url, siteForHost) {
  const parsed = webUrl(url);
  if (!parsed) return null;
  return siteWith(siteForHost, parsed.hostname) || parsed.origin;
}

// Allow patterns the helper's url policy understands for one allowed site.
export function browserSitePatterns(site) {
  if (typeof site !== 'string' || !site) return [];
  if (/^https?:\/\//.test(site)) { const parsed = webUrl(site); return parsed ? [canonicalHost(parsed.hostname)] : []; }
  const host = canonicalHost(site);
  if (!host) return [];
  // An IP or single-label host is one exact host; a domain covers its subdomains.
  return /^\d+(?:\.\d+){3}$/.test(host) || !host.includes('.') ? [host] : [host, `*.${host}`];
}

// The helper's navigation policy for one conversation (D-B1: same site plus
// the sites the person allowed in this conversation).
export function browserNavigationPolicy(sites) {
  const allow = [];
  for (const site of siteSet(sites)) {
    for (const pattern of browserSitePatterns(site)) if (!allow.includes(pattern)) allow.push(pattern);
  }
  return { scope: 'same-site', allow, block: [], allowDowngrade: false };
}

// One rule for every layer: is toUrl reachable from fromUrl in a conversation
// that allowed `sites`? Fail closed: anything unreadable is blocked.
// -> { allowed, reason, host }
export function browserGrantNavigation(toUrl, fromUrl, sites, siteForHost) {
  const decide = (allowed, reason, host = null) => ({ allowed, reason, host });
  if (typeof toUrl !== 'string' || !toUrl) return decide(false, 'invalid-url');
  let scheme = null;
  try { scheme = new URL(toUrl).protocol; } catch { return decide(false, 'invalid-url'); }
  if (!WEB.has(scheme)) return decide(false, 'scheme-not-web');
  const to = webUrl(toUrl);
  if (!to) return decide(false, 'invalid-url');
  const host = canonicalHost(to.hostname);
  if (to.username || to.password) return decide(false, 'credentials-in-url', host);
  const from = webUrl(fromUrl);
  if (from && from.protocol === 'https:' && to.protocol === 'http:') return decide(false, 'insecure-downgrade', host);
  const toSite = siteWith(siteForHost, to.hostname);
  if (from) {
    const fromSite = siteWith(siteForHost, from.hostname);
    const same = fromSite && toSite ? fromSite === toSite : from.origin === to.origin;
    if (same) return decide(true, 'same-site', host);
  }
  const allowed = siteSet(sites);
  if (allowed.has(toSite || to.origin) || allowed.has(host)) return decide(true, 'allowed-site', host);
  return decide(false, from ? 'outside-site' : 'no-base', host);
}

// Whether a Card's standing grant still holds against the Card's live binding
// (D-B3: Card, account or site change, pause/hold, revocation, idle end it).
// `current` is the Card's toolBinding() with its live url; null means closed.
// -> { valid, reason }
export function browserGrantState(grant, current, { now = Date.now(), idleMs = BROWSER_GRANT_IDLE_MS,
  sites = null, siteForHost = null, held = false } = {}) {
  if (!grant || typeof grant !== 'object') return { valid: false, reason: 'revoked' };
  if (grant.revoked === true) return { valid: false, reason: 'revoked' };
  if (!current || typeof current !== 'object') return { valid: false, reason: 'card-closed' };
  if (held === true) return { valid: false, reason: 'held' };
  if (CARD_FIELDS.some(field => grant[field] !== current[field])) return { valid: false, reason: 'card-changed' };
  if (ACCOUNT_FIELDS.some(field => grant[field] !== current[field])) return { valid: false, reason: 'account-changed' };
  const lastUsedAt = Number.isFinite(grant.lastUsedAt) ? grant.lastUsedAt : grant.grantedAt;
  if (!Number.isFinite(lastUsedAt) || now - lastUsedAt > idleMs) return { valid: false, reason: 'idle' };
  // The Card may sit on its granted site or on a site this conversation allowed;
  // a person steering it elsewhere ends the grant (D-B3 site change).
  const site = browserGrantSite(current.url, siteForHost);
  const allowed = siteSet(sites);
  if (!site || (site !== grant.site && !allowed.has(site))) return { valid: false, reason: 'site-changed' };
  return { valid: true, reason: 'valid' };
}

// The record kept per (conversation, Card) when a person grants interaction, or
// when the Agent opens a Card inside the grant (D-B2 inheritance, same run).
export function browserGrantRecord({ clientThreadId, localThreadId, cardId, current, permission = 'interact',
  now = Date.now(), siteForHost = null, openedByAgent = false, openedFrom = null, sourceId = null } = {}) {
  if (typeof clientThreadId !== 'string' || !clientThreadId || typeof cardId !== 'string' || !cardId ||
      !current || typeof current !== 'object' || !['observe', 'interact'].includes(permission)) return null;
  const site = browserGrantSite(current.url, siteForHost);
  if (!site) return null;
  return {
    clientThreadId, localThreadId: localThreadId ?? null, cardId, permission, site,
    cardEpoch: current.cardEpoch, profileId: current.profileId, userContextId: current.userContextId,
    accountId: current.accountId, engineAccountKey: current.engineAccountKey, authorityEpoch: current.authorityEpoch,
    grantedAt: now, lastUsedAt: now, revoked: false,
    openedByAgent: openedByAgent === true, openedFrom: typeof openedFrom === 'string' ? openedFrom : null,
    sourceId: typeof sourceId === 'string' ? sourceId : null,
  };
}
