// BRW-02: which account context a Browser card runs in, and the remembered
// per-site default ("이 사이트는 항상 이 계정으로"). Pure view model and store
// rules only. A context is a Firefox container; its name never proves a site
// login, and nothing here copies cookies, secrets or credentials.

export const SITE_DEFAULTS_PREF = 'egdesk.browser.site-account-defaults.v1';
export const SITE_DEFAULT_MODES = Object.freeze(['ask', 'always']);
export const MAX_SITE_DEFAULTS = 500;
export const DEFAULT_CONTEXT_LABEL = '기본 환경';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_KEY = /^(?=.{1,253}$)[a-z0-9.\-[\]:]+$/;

function validUserContextId(value) {
  return Number.isSafeInteger(value) && value >= 0 && value < 0xffffffff;
}

function cleanName(value, fallback) {
  const name = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim().slice(0, 100) : '';
  return name || fallback;
}

/**
 * The site a default applies to: the registrable domain (eTLD+1) of an
 * http(s) URL. `baseDomain(host)` is Services.eTLD.getBaseDomainFromHost in
 * Firefox; when it throws (IP address, single label) the host itself is used.
 */
export function siteKeyForUrl(url, baseDomain = null) {
  if (typeof url !== 'string' || url.length > 4096 || /[\u0000-\u0020\u007f]/.test(url)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  let site = host;
  if (typeof baseDomain === 'function') {
    try {
      const base = baseDomain(host);
      if (typeof base === 'string' && base && (host === base || host.endsWith(`.${base}`))) site = base.toLowerCase();
    } catch { /* IP address or a host without a public suffix keeps its host */ }
  }
  return SITE_KEY.test(site) ? site : null;
}

function validContextRef(value) {
  if (value?.kind === 'default') return { kind: 'default' };
  if (value?.kind === 'container' && UUID.test(value.browserIdentityKey || '')) {
    return { kind: 'container', browserIdentityKey: value.browserIdentityKey.toLowerCase() };
  }
  return null;
}

/**
 * Validate a stored map. Only 'always' entries are kept: a missing site means
 * 'ask'. A map from another profile scope is dropped as a whole, because a
 * browserIdentityKey only means something in the profile that minted it.
 */
export function normalizeSiteDefaults(raw, { profileScopeId } = {}) {
  const scope = UUID.test(profileScopeId || '') ? profileScopeId.toLowerCase() : null;
  const empty = { version: 1, profileScopeId: scope, sites: {} };
  let value = raw;
  if (typeof value === 'string') {
    if (!value || value.length > 256 * 1024) return empty;
    try { value = JSON.parse(value); } catch { return empty; }
  }
  if (!scope || !value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      String(value.profileScopeId || '').toLowerCase() !== scope ||
      !value.sites || typeof value.sites !== 'object' || Array.isArray(value.sites)) return empty;
  const sites = {};
  for (const [site, entry] of Object.entries(value.sites)) {
    if (Object.keys(sites).length >= MAX_SITE_DEFAULTS) break;
    if (!SITE_KEY.test(site) || entry?.mode !== 'always') continue;
    const context = validContextRef(entry.context);
    if (context) sites[site] = { mode: 'always', context };
  }
  return { version: 1, profileScopeId: scope, sites };
}

/** Return a new store with the choice for one site; 'ask' removes the entry. */
export function setSiteDefault(store, siteKey, choice) {
  if (!store?.profileScopeId || !SITE_KEY.test(siteKey || '')) throw new TypeError('A valid site and store are required');
  const sites = { ...store.sites };
  if (choice?.mode === 'ask') delete sites[siteKey];
  else if (choice?.mode === 'always') {
    const context = validContextRef(choice.context);
    if (!context) throw new TypeError('A valid account context is required');
    if (!Object.hasOwn(sites, siteKey) && Object.keys(sites).length >= MAX_SITE_DEFAULTS) {
      throw new RangeError('Too many remembered sites');
    }
    sites[siteKey] = { mode: 'always', context };
  } else throw new TypeError('Unknown site default mode');
  return { version: 1, profileScopeId: store.profileScopeId, sites };
}

/** Drop entries that point to a context which no longer exists. */
export function pruneSiteDefaults(store, usableKeys) {
  const keys = usableKeys instanceof Set ? usableKeys : new Set();
  const sites = {};
  for (const [site, entry] of Object.entries(store?.sites || {})) {
    if (entry.context.kind === 'default' || keys.has(entry.context.browserIdentityKey)) sites[site] = entry;
  }
  return { version: 1, profileScopeId: store?.profileScopeId ?? null, sites };
}

/**
 * What to open a site with. {mode:'ask'} keeps today's behavior (the default
 * context, switchable on the card). A remembered container that is gone is
 * reported, never silently swapped for a different container.
 */
export function resolveSiteDefault(store, url, { baseDomain = null, usableKeys = new Set() } = {}) {
  const site = siteKeyForUrl(url, baseDomain);
  const entry = site ? store?.sites?.[site] : null;
  if (!entry) return { mode: 'ask', site };
  if (entry.context.kind === 'default') return { mode: 'always', site, context: { kind: 'default' } };
  if (!usableKeys.has(entry.context.browserIdentityKey)) {
    return { mode: 'ask', site, reason: 'context-unavailable' };
  }
  return { mode: 'always', site, context: { ...entry.context } };
}

/**
 * Picker rows for one card. `contexts` are what the card may switch to:
 * [{kind:'default'} | {kind:'container', userContextId, browserIdentityKey?, name}].
 */
export function accountPickerModel({ currentUserContextId = 0, contexts = [], url = '', baseDomain = null,
  store = null } = {}) {
  const rows = [{ id: 'context:0', kind: 'default', userContextId: 0, label: DEFAULT_CONTEXT_LABEL,
    browserIdentityKey: null }];
  const seen = new Set([0]);
  for (const item of Array.isArray(contexts) ? contexts : []) {
    if (item?.kind !== 'container' || !validUserContextId(item.userContextId) || item.userContextId === 0 ||
        seen.has(item.userContextId)) continue;
    seen.add(item.userContextId);
    rows.push({ id: `context:${item.userContextId}`, kind: 'container', userContextId: item.userContextId,
      label: cleanName(item.name, `분리 환경 ${item.userContextId}`),
      browserIdentityKey: UUID.test(item.browserIdentityKey || '') ? item.browserIdentityKey.toLowerCase() : null });
  }
  const current = rows.find(row => row.userContextId === currentUserContextId) || null;
  const site = siteKeyForUrl(url, baseDomain);
  const entry = site ? store?.sites?.[site] : null;
  const remembered = entry
    ? rows.find(row => entry.context.kind === 'default' ? row.kind === 'default'
      : row.browserIdentityKey === entry.context.browserIdentityKey) || null
    : null;
  const items = rows.map(row => ({ ...row, checked: row === current, remembered: row === remembered }));
  const currentLabel = current ? current.label : '확인할 수 없는 환경';
  const rememberable = !!site && !!current && (current.kind === 'default' || !!current.browserIdentityKey);
  return {
    currentLabel,
    summary: `계정: ${currentLabel}`,
    note: '분리 환경 이름입니다. 사이트 로그인 여부는 별도로 확인해야 합니다.',
    site,
    items,
    siteDefault: entry ? 'always' : 'ask',
    rememberedLabel: remembered?.label || null,
    remember: rememberable ? {
      checked: !!entry && remembered === current,
      label: `${site}은(는) 항상 '${currentLabel}'로 열기`,
    } : null,
  };
}

/**
 * Decide how a switch proceeds. The card is reopened in place (same frame,
 * same Board membership, current URL). An unknown or entered form asks first.
 */
export function planAccountSwitch({ currentUserContextId, targetUserContextId, url, formState } = {}) {
  if (!validUserContextId(targetUserContextId) || !validUserContextId(currentUserContextId)) {
    return { action: 'blocked', reason: 'invalid-context' };
  }
  if (currentUserContextId === targetUserContextId) return { action: 'unchanged' };
  if (siteKeyForUrl(url) === null) return { action: 'blocked', reason: 'unsupported-url',
    message: '웹 페이지(http/https)에서만 계정 환경을 바꿀 수 있습니다.' };
  if (formState === 'clean') return { action: 'reopen' };
  return {
    action: 'confirm',
    reason: formState === 'entered' ? 'entered-form' : 'form-unknown',
    message: formState === 'entered'
      ? '이 페이지에 저장하지 않은 입력이 있습니다. 다른 계정 환경으로 다시 열면 입력한 내용이 사라집니다. 계속할까요?'
      : '이 페이지에 입력한 내용이 있다면 다른 계정 환경으로 다시 열 때 사라집니다. 계속할까요?',
  };
}
