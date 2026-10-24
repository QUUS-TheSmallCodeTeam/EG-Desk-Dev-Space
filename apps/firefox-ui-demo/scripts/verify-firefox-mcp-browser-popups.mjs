#!/usr/bin/env node
// BRW-03 popup regression: attach-only, model-free QA for Main's already-running
// Firefox (QA profile, Marionette 2829 or 2828). It never starts Firefox.
//
// Two local fixture servers stand in for a web site and its sign-in provider:
//   site     http://127.0.0.1:<port>  the page in the Browser card (the opener)
//   provider http://localhost:<port>  a fake sign-in page on another origin
// Five scenarios, each opened from a fresh site card whose page calls
// window.open on load: unsized, sized, opener-message, self-close, noopener.
// Popups are allowed for the fixture site origin only (session permission,
// removed at the end). Chrome evaluation only reads cards and windows, opens
// the fixture card, and closes the cards and windows the scenario created.
// Evidence keeps origin + path of fixture pages only; query strings, other
// pages' addresses and titles are never recorded.
//
// Patterns followed (no code copied):
// - Playwright MCP context.ts:364-381 (Apache-2.0): keep a list of pages as they
//   are created and closed. Here: Browser cards and top-level windows are diffed
//   against a baseline and every one seen during the scenario is remembered.
// - Firefox BrowserElementChild.sys.mjs:5-13 / BrowserElementParent.sys.mjs:10-30
//   (MPL-2.0): only a script's own window.close() becomes DOMWindowClose; the
//   self-close scenario uses exactly that.
// - Firefox BrowserDOMWindow.sys.mjs:108-111 and firefox.js:1093-1096 (MPL-2.0):
//   a window.open with features opens a new window; popup windows hide the toolbar.
// - deta/surf mainWindow.ts:469-476 (Apache-2.0): a named or featured window.open
//   is treated as a sign-in popup.
// - scripts/verify-firefox-mcp-browser-agent-observation.mjs:48-69 (our own):
//   a loopback fixture server on an ephemeral port.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { FirefoxMcpChatHarness } from './firefox-mcp-chat-harness.mjs';
import { chrome, loopbackJson } from './egdesk-qa-ui-flow.mjs';

export const PAGE_STATE_PREFIX = 'EGDESK-POPUP-QA ';
export const CALLBACK_PATH = '/oauth/callback';
const FAKE_CALLBACK_QUERY = '?code=QA-FAKE-CODE-NOT-A-SECRET&state=qa';
const RESERVED_PORTS = new Set([2828, 2829, 6000, 39218, 39219]);
const PAGE_ROLES = Object.freeze(['site', 'provider', 'callback']);
const OPENED_VALUES = Object.freeze(['pending', 'window', 'null', 'error']);
const SITE_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{2,5})$/;
const PROVIDER_ORIGIN = /^http:\/\/localhost:(\d{2,5})$/;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const scenario = (id, gap, title, target, features) => Object.freeze({ id, gap, title, open: Object.freeze({ target, features }) });
export const POPUP_SCENARIOS = Object.freeze([
  scenario('unsized', 'BRW-03', '크기 지정 없는 팝업이 Browser 카드로 열리고 window.open이 창을 돌려준다', '_blank', ''),
  scenario('sized', 'BRW-03', '크기 지정 로그인 팝업이 EG-Desk 화면을 하나 더 띄우지 않는다', 'egdesk-qa-login', 'popup,width=480,height=640'),
  scenario('opener-message', 'BRW-03', '팝업 로그인 페이지가 원래 페이지에 메시지를 보내고 같은 계정(컨테이너)을 쓴다', 'egdesk-qa-login', ''),
  scenario('self-close', 'BRW-03·BRW-04', '로그인을 마친 팝업이 스스로 닫으면 팝업 카드도 닫히고 원래 카드는 남는다', 'egdesk-qa-login-close', ''),
  scenario('noopener', 'BRW-03', 'noopener 팝업은 원래 페이지와 끊긴 새 카드로 열린다', '_blank', 'noopener'),
]);
const SCENARIO_IDS = new Set(POPUP_SCENARIOS.map(item => item.id));
// Sign-in flows whose popup card locations should reach the bridge with openerCardId (BRW-04).
export const BRIDGE_SCENARIOS = Object.freeze(new Set(['opener-message', 'self-close']));

const USAGE = 'usage: --profile CANONICAL_TEMP_QA_PROFILE --deadline-utc UTC_TIMESTAMP '
  + '[--marionette-port 2829|2828] [--scenario ID]... [--expect-opener-link] [--bridge-events]';

export function parseDeadlineUtc(value, now = Date.now()) {
  assert.match(value || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    '--deadline-utc must be an explicit whole-second UTC timestamp');
  const deadline = Date.parse(value);
  assert.equal(new Date(deadline).toISOString(), value.replace('Z', '.000Z'), 'invalid UTC deadline');
  assert.ok(now < deadline, 'deadline must be in the future');
  return deadline;
}

export function assertBeforeDeadline(deadlineMs, now = Date.now()) {
  assert.ok(Number.isSafeInteger(deadlineMs) && now < deadlineMs, 'deadline reached; no further QA action');
}

export function parseCli(argv, now = Date.now()) {
  const values = new Map();
  const scenarios = [];
  const expectations = { openerLink: false };
  let bridgeEvents = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--expect-opener-link' || key === '--bridge-events') {
      assert.ok(!values.has(key), `${key} is given twice`);
      values.set(key, true);
      if (key === '--expect-opener-link') expectations.openerLink = true;
      else bridgeEvents = true;
      continue;
    }
    const value = argv[index + 1];
    assert.ok(['--profile', '--deadline-utc', '--marionette-port', '--scenario'].includes(key)
      && typeof value === 'string' && value && !value.startsWith('--'), USAGE);
    index += 1;
    if (key === '--scenario') {
      assert.ok(SCENARIO_IDS.has(value), `unknown scenario: ${value}`);
      assert.ok(!scenarios.includes(value), `scenario ${value} is given twice`);
      scenarios.push(value);
      continue;
    }
    assert.ok(!values.has(key), `${key} is given twice`);
    values.set(key, value);
  }
  assert.ok(values.has('--profile') && values.has('--deadline-utc'), `--profile and --deadline-utc are both required; ${USAGE}`);
  const port = values.get('--marionette-port') ?? '2829';
  assert.ok(port === '2828' || port === '2829', '--marionette-port must be 2829 (QA default) or 2828');
  return {
    profile: values.get('--profile'),
    deadlineMs: parseDeadlineUtc(values.get('--deadline-utc'), now),
    marionettePort: Number(port),
    scenarios: scenarios.length ? POPUP_SCENARIOS.filter(item => scenarios.includes(item.id)) : [...POPUP_SCENARIOS],
    expectations,
    bridgeEvents,
  };
}

// ---------------------------------------------------------------- fixture pages

export function assertFixtureOrigins(siteOrigin, providerOrigin) {
  const site = SITE_ORIGIN.exec(siteOrigin || '');
  const provider = PROVIDER_ORIGIN.exec(providerOrigin || '');
  assert.ok(site && provider, 'fixture site must be http://127.0.0.1:PORT and provider http://localhost:PORT');
  for (const port of [Number(site[1]), Number(provider[1])]) {
    assert.ok(port >= 1024 && port <= 65535 && !RESERVED_PORTS.has(port), `fixture port ${port} is reserved or out of range`);
  }
  assert.notEqual(site[1], provider[1], 'site and provider need different ports');
  return { site: siteOrigin, provider: providerOrigin };
}

// JSON that is safe inside an inline <script>.
const scriptJson = value => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/[\u2028]/g, '\\u2028').replace(/[\u2029]/g, '\\u2029');

const SHOW_STATE = `const state = { role: CONFIG.role, scenario: CONFIG.scenario };
function show(patch) {
  Object.assign(state, patch || {});
  document.title = CONFIG.prefix + JSON.stringify(state);
  document.getElementById('state').textContent = JSON.stringify(state, null, 2);
}`;

function fixturePage(heading, note, config, script) {
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>${PAGE_STATE_PREFIX}{}</title>
<style>body{font:15px system-ui,sans-serif;margin:32px;color:#1a1a1a;background:#f5f3ef}h1{font-size:20px;margin:0 0 8px}pre{background:#fff;padding:12px;border-radius:8px}</style>
</head>
<body>
<h1>${heading}</h1>
<p>${note}</p>
<pre id="state"></pre>
<script>
const CONFIG = ${scriptJson({ prefix: PAGE_STATE_PREFIX, ...config })};
${SHOW_STATE}
${script}
</script>
</body>
</html>`;
}

export function popupSiteHtml(item, origins) {
  const popupUrl = `${origins.provider}/login/${item.id}`;
  return fixturePage('EG-Desk 팝업 시험 사이트', `시나리오 <code>${item.id}</code>: 페이지가 열리면 로그인 팝업을 엽니다.`,
    { role: 'site', scenario: item.id, popupUrl, target: item.open.target, features: item.open.features,
      siteOrigin: origins.site, providerOrigin: origins.provider },
    `show({ opened: 'pending', message: false, popupClosed: false });
addEventListener('message', (event) => {
  if (event.origin !== CONFIG.siteOrigin && event.origin !== CONFIG.providerOrigin) return;
  if (!event.data || event.data.egdeskPopupQa !== 'login-finished') return;
  show({ message: true });
});
addEventListener('load', () => {
  let popup = null;
  try {
    popup = window.open(CONFIG.popupUrl, CONFIG.target, CONFIG.features);
    show({ opened: popup ? 'window' : 'null' });
  } catch (error) {
    show({ opened: 'error' });
    return;
  }
  if (!popup) return;
  const started = Date.now();
  const timer = setInterval(() => {
    let closed = false;
    try { closed = popup.closed === true; } catch (error) {}
    if (closed) { clearInterval(timer); show({ popupClosed: true }); }
    else if (Date.now() - started > 20000) clearInterval(timer);
  }, 200);
});`);
}

export function popupProviderHtml(item, origins) {
  return fixturePage('가짜 로그인 제공자', '실제 계정이 아닌 시험용 로그인 페이지입니다.',
    { role: 'provider', scenario: item.id, siteOrigin: origins.site, callbackUrl: `${origins.site}${CALLBACK_PATH}${FAKE_CALLBACK_QUERY}` },
    `show({ hasOpener: !!window.opener, inPopupWindow: window.toolbar ? window.toolbar.visible === false : null, posted: false });
if (CONFIG.scenario === 'opener-message' && window.opener) {
  try { window.opener.postMessage({ egdeskPopupQa: 'login-finished' }, CONFIG.siteOrigin); show({ posted: true }); } catch (error) {}
}
if (CONFIG.scenario === 'self-close') setTimeout(() => location.replace(CONFIG.callbackUrl), 300);`);
}

export function popupCallbackHtml(origins) {
  return fixturePage('로그인 콜백', '로그인이 끝났다고 원래 페이지에 알리고 이 창을 닫습니다.',
    { role: 'callback', scenario: null, siteOrigin: origins.site },
    `let posted = false;
if (window.opener) {
  try { window.opener.postMessage({ egdeskPopupQa: 'login-finished' }, CONFIG.siteOrigin); posted = true; } catch (error) {}
}
show({ hasOpener: !!window.opener, posted, closing: true });
setTimeout(() => window.close(), 300);`);
}

function fixtureRoute(role, pathname, origins) {
  if (role === 'site') {
    if (pathname === CALLBACK_PATH) return popupCallbackHtml(origins);
    const match = /^\/popup\/([a-z][a-z-]{0,31})$/.exec(pathname);
    const item = match && POPUP_SCENARIOS.find(entry => entry.id === match[1]);
    return item ? popupSiteHtml(item, origins) : null;
  }
  const match = /^\/login\/([a-z][a-z-]{0,31})$/.exec(pathname);
  const item = match && POPUP_SCENARIOS.find(entry => entry.id === match[1]);
  return item ? popupProviderHtml(item, origins) : null;
}

/** (request, response) handler for one fixture origin; any other Host, path or method is refused. */
export function createPopupFixtureHandler({ role, siteOrigin, providerOrigin }) {
  assert.ok(role === 'site' || role === 'provider', 'fixture role must be site or provider');
  const origins = assertFixtureOrigins(siteOrigin, providerOrigin);
  const host = new URL(role === 'site' ? siteOrigin : providerOrigin).host;
  return (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', ...headers });
      response.end(body);
    };
    if (request.headers?.host !== host || typeof request.url !== 'string' || !request.url.startsWith('/')) return send(404, 'Not found');
    let pathname = '';
    try { pathname = new URL(request.url, `http://${host}`).pathname; } catch { return send(404, 'Not found'); }
    const page = fixtureRoute(role, pathname, origins);
    if (!page) return send(404, 'Not found');
    if (request.method !== 'GET') return send(405, 'Method not allowed', { Allow: 'GET' });
    return send(200, page, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' });
  };
}

const listenOn = (server, port, address) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, address, () => { server.off('error', reject); resolve(server.address().port); });
});
const closeServer = server => new Promise(resolve => {
  server.closeAllConnections?.();
  server.close(() => resolve());
});

/**
 * Starts the site (127.0.0.1) and provider (localhost) servers on ephemeral
 * loopback ports. localhost may resolve to ::1 first, so the provider also
 * listens on the IPv6 loopback when that port is free there.
 */
export async function startPopupFixture() {
  const servers = [];
  try {
    const siteServer = createServer();
    servers.push(siteServer);
    const sitePort = await listenOn(siteServer, 0, '127.0.0.1');
    const providerServer = createServer();
    servers.push(providerServer);
    const providerPort = await listenOn(providerServer, 0, '127.0.0.1');
    const origins = assertFixtureOrigins(`http://127.0.0.1:${sitePort}`, `http://localhost:${providerPort}`);
    const siteHandler = createPopupFixtureHandler({ role: 'site', siteOrigin: origins.site, providerOrigin: origins.provider });
    const providerHandler = createPopupFixtureHandler({ role: 'provider', siteOrigin: origins.site, providerOrigin: origins.provider });
    siteServer.on('request', siteHandler);
    providerServer.on('request', providerHandler);
    let providerIpv6 = false;
    const providerServer6 = createServer(providerHandler);
    try { await listenOn(providerServer6, providerPort, '::1'); servers.push(providerServer6); providerIpv6 = true; } catch { /* no IPv6 loopback or port taken */ }
    return {
      origins,
      providerIpv6,
      siteUrl: id => `${origins.site}/popup/${id}`,
      close: () => Promise.all(servers.map(closeServer)),
    };
  } catch (error) {
    await Promise.all(servers.map(closeServer));
    throw error;
  }
}

// ---------------------------------------------------- privileged chrome reads
// Each function below runs inside the Firefox chrome window through
// chrome(harness, fn, arg); it must not use anything from this module's scope.

export function chromeGuard() {
  const api = window.__egdesk;
  let headless = null;
  try { headless = Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).isHeadless === true; } catch (error) { headless = null; }
  return {
    documentURI: document.documentURI,
    mounted: typeof api?.cardRuntime?.openBrowserCard === 'function' && typeof api?.cardRuntime?.closeCard === 'function',
    headless,
  };
}

export function chromeSetPopupPermission({ origin, allow }) {
  if (typeof origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(origin)) {
    throw new Error('Popup permission is only for the loopback fixture site');
  }
  const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
  const principal = services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
  if (allow === true) services.perms.addFromPrincipal(principal, 'popup', services.perms.ALLOW_ACTION, services.perms.EXPIRE_SESSION);
  else services.perms.removeFromPrincipal(principal, 'popup');
  return { origin, allowed: services.perms.testPermissionFromPrincipal(principal, 'popup') === services.perms.ALLOW_ACTION };
}

export function chromeReadPopupSurface({ prefix, origins }) {
  const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
  if (!window.__egdesk?.cardRuntime) throw new Error('EG-Desk surface is not mounted in this window');
  const allowed = new Set([origins?.site, origins?.provider].filter(value => typeof value === 'string'));
  const place = (spec) => {
    if (spec === 'about:blank') return 'about:blank';
    let url = null;
    try { url = new URL(String(spec || '')); } catch (error) { return null; }
    return allowed.has(url.origin) ? `${url.origin}${url.pathname || '/'}` : 'other';
  };
  const pageState = (browser, location) => {
    const title = browser?.contentTitle;
    if (!location || location === 'other' || location === 'about:blank') return null;
    if (typeof title !== 'string' || title.length > 600 || !title.startsWith(prefix)) return null;
    try { return JSON.parse(title.slice(prefix.length)); } catch (error) { return null; }
  };
  const container = (browser) => {
    const fromContext = browser?.browsingContext?.originAttributes?.userContextId;
    if (Number.isSafeInteger(fromContext)) return fromContext;
    const raw = browser?.getAttribute?.('usercontextid');
    return typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0;
  };
  const describe = (browser) => {
    let spec = null;
    try { spec = browser?.currentURI?.spec ?? null; } catch (error) { spec = null; }
    const location = place(spec);
    return { location, page: pageState(browser, location), userContextId: container(browser) };
  };
  const windowIdOf = (win) => {
    try { return String(win.docShell?.outerWindowID ?? win.windowUtils?.outerWindowID ?? ''); } catch (error) { return ''; }
  };
  const cards = [...document.querySelectorAll('.egd-browser-card')]
    .filter(card => typeof card.id === 'string' && card.id)
    .map(card => ({ cardId: card.id, ...describe(card._xulBrowser), openerCardId: card.dataset?.openerCardId || null }));
  const windows = [];
  for (const win of services.wm.getEnumerator('navigator:browser')) {
    if (win === window) continue;
    let overlay = false;
    let popup = null;
    let browser = null;
    try { overlay = !!(win.document?.getElementById('egd-canvas-viewport') || win.__egdesk); } catch (error) { overlay = false; }
    try { popup = win.toolbar ? win.toolbar.visible === false : null; } catch (error) { popup = null; }
    try { browser = win.gBrowser?.selectedBrowser || null; } catch (error) { browser = null; }
    windows.push({ windowId: windowIdOf(win), closed: win.closed === true, popup, overlay, ...describe(browser) });
  }
  return { cards, windows };
}

export function chromeOpenSiteCard({ url, siteOrigin }) {
  if (typeof siteOrigin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(siteOrigin)
    || typeof url !== 'string' || !url.startsWith(siteOrigin) || !/^\/popup\/[a-z][a-z-]{0,31}$/.test(url.slice(siteOrigin.length))) {
    throw new Error('Only the loopback popup fixture page may be opened');
  }
  const card = window.__egdesk?.cardRuntime?.openBrowserCard(url, { openMode: 'new' });
  return { cardId: typeof card?.id === 'string' && card.id ? card.id : null };
}

export async function chromeCloseCreated({ cardIds, windowIds }) {
  const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
  const api = window.__egdesk;
  const result = { cardsClosed: 0, cardsLeft: 0, windowsClosed: 0, windowsLeft: 0 };
  for (const id of Array.isArray(cardIds) ? cardIds : []) {
    const card = typeof id === 'string' ? document.getElementById(id) : null;
    if (!card || !card.classList?.contains('egd-browser-card')) continue;
    try { await api.cardRuntime.closeCard(card); } catch (error) { /* counted below */ }
    if (card.isConnected) result.cardsLeft += 1;
    else result.cardsClosed += 1;
  }
  const wanted = new Set(Array.isArray(windowIds) ? windowIds : []);
  const windowIdOf = (win) => {
    try { return String(win.docShell?.outerWindowID ?? win.windowUtils?.outerWindowID ?? ''); } catch (error) { return ''; }
  };
  const targets = [];
  for (const win of services.wm.getEnumerator('navigator:browser')) {
    if (win !== window && wanted.has(windowIdOf(win))) targets.push(win);
  }
  for (const win of targets) { try { win.close(); } catch (error) { /* counted below */ } }
  if (targets.length) await new Promise(resolve => setTimeout(resolve, 300));
  for (const win of targets) {
    if (win.closed === true) result.windowsClosed += 1;
    else result.windowsLeft += 1;
  }
  return result;
}

/** The privileged-window side of the run; tests replace it with a fake. */
export function createChromePopupDriver(harness, origins) {
  return {
    guard: () => chrome(harness, chromeGuard),
    setPopupPermission: (origin, allow) => chrome(harness, chromeSetPopupPermission, { origin, allow }),
    observe: () => chrome(harness, chromeReadPopupSurface, { prefix: PAGE_STATE_PREFIX, origins }),
    openSite: url => chrome(harness, chromeOpenSiteCard, { url, siteOrigin: origins.site }),
    closeCreated: created => chrome(harness, chromeCloseCreated, created),
  };
}

/** Reads GET /events/recent from the running bridge (BRW-04 opener reports). */
export function createBridgeEventReader(fetchJson = loopbackJson) {
  return {
    async seq() {
      const value = await fetchJson('/events/recent?since=0');
      return Number.isSafeInteger(value?.seq) ? value.seq : 0;
    },
    async since(seq) {
      const value = await fetchJson(`/events/recent?since=${Number.isSafeInteger(seq) && seq >= 0 ? seq : 0}`);
      return Array.isArray(value?.events) ? value.events : [];
    },
  };
}

// ------------------------------------------------------------------- judging

const bool = value => (typeof value === 'boolean' ? value : null);
/** Keeps only the fixture's own fields, with their known types. */
export function sanitizePageState(page) {
  if (!page || typeof page !== 'object' || !PAGE_ROLES.includes(page.role)) return null;
  const clean = { role: page.role, scenario: SCENARIO_IDS.has(page.scenario) ? page.scenario : null };
  if (page.role === 'site') {
    clean.opened = OPENED_VALUES.includes(page.opened) ? page.opened : null;
    clean.message = page.message === true;
    clean.popupClosed = page.popupClosed === true;
  } else {
    clean.hasOpener = bool(page.hasOpener);
    clean.posted = page.posted === true;
    if (page.role === 'provider') clean.inPopupWindow = bool(page.inPopupWindow);
    else clean.closing = page.closing === true;
  }
  return clean;
}

const LOCATION = /^(?:about:blank|other|http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/[A-Za-z0-9/_-]{0,128})$/;
export function emptySeen() { return { cards: [], windows: [] }; }

/** Remembers every card and window seen so far, with the fixture pages each showed. */
export function mergeSeen(seen, observation) {
  const merge = (list, items, key) => {
    const byId = new Map(list.map(entry => [entry[key], entry]));
    for (const item of Array.isArray(items) ? items : []) {
      const id = item?.[key];
      if (typeof id !== 'string' || !id || id.length > 64) continue;
      const prior = byId.get(id) || { [key]: id, locations: [], pages: {}, userContextId: null };
      const location = typeof item.location === 'string' && LOCATION.test(item.location) ? item.location : null;
      const page = sanitizePageState(item.page);
      const next = {
        ...prior,
        locations: location && !prior.locations.includes(location) ? [...prior.locations, location].slice(-8) : prior.locations,
        pages: page ? { ...prior.pages, [page.role]: page } : prior.pages,
        userContextId: Number.isSafeInteger(item.userContextId) ? item.userContextId : prior.userContextId,
      };
      if (key === 'cardId') next.openerCardId = typeof item.openerCardId === 'string' && item.openerCardId ? item.openerCardId : (prior.openerCardId ?? null);
      else Object.assign(next, { overlay: prior.overlay === true || item.overlay === true, popup: bool(item.popup), closed: item.closed === true });
      byId.set(id, next);
    }
    return [...byId.values()];
  };
  return { cards: merge(seen.cards, observation?.cards, 'cardId'), windows: merge(seen.windows, observation?.windows, 'windowId') };
}

export function scenarioFacts({ baseline, after, seen, siteCardId, origins }) {
  const baseCards = new Set((baseline?.cards || []).map(card => card.cardId));
  const baseWindows = new Set((baseline?.windows || []).map(win => win.windowId));
  const callback = `${origins.site}${CALLBACK_PATH}`;
  const fixtureLocation = location => location.startsWith(`${origins.provider}/login/`) || location === callback;
  const isPopup = entry => entry.locations.some(fixtureLocation) || !!entry.pages.provider || !!entry.pages.callback;
  const siteSeen = seen.cards.find(card => card.cardId === siteCardId) || null;
  const nowCards = new Set((after?.cards || []).map(card => card.cardId));
  const nowWindows = new Map((after?.windows || []).map(win => [win.windowId, win]));
  const newCards = seen.cards.filter(card => card.cardId !== siteCardId && !baseCards.has(card.cardId));
  const newWindows = seen.windows.filter(win => !baseWindows.has(win.windowId));
  const popupCards = newCards.filter(isPopup);
  const popupWindows = newWindows.filter(isPopup);
  const popupEntries = [...popupCards, ...popupWindows];
  const route = popupCards.length && popupWindows.length ? 'card+window' : popupCards.length ? 'card' : popupWindows.length ? 'window' : 'none';
  return {
    siteCardId,
    sitePage: siteSeen?.pages.site || null,
    siteCardOpen: !!siteCardId && nowCards.has(siteCardId),
    siteUserContextId: siteSeen?.userContextId ?? null,
    route,
    popupCards,
    popupWindows,
    newCards,
    newWindows,
    openCreatedCards: newCards.filter(card => nowCards.has(card.cardId)),
    openCreatedWindows: newWindows.filter(win => nowWindows.has(win.windowId) && nowWindows.get(win.windowId).closed !== true),
    overlayWindows: newWindows.filter(win => win.overlay === true).length,
    provider: popupEntries.map(entry => entry.pages.provider).find(Boolean) || null,
    callback: popupEntries.map(entry => entry.pages.callback).find(Boolean) || null,
    callbackReached: popupEntries.some(entry => entry.locations.includes(callback) || !!entry.pages.callback),
  };
}

const check = (id, label, required, passed, detail) => ({ id, label, required: required === true, passed: passed === true,
  ...(detail === undefined ? {} : { detail }) });

/** The checks of one scenario; required ones decide pass/fail, the rest are reported for the next step. */
export function scenarioChecks(item, facts, expectations = {}) {
  const checks = [
    check('site-card', '원래 Browser 카드가 열리고 시험 페이지가 떴다', true, facts.siteCardOpen && facts.sitePage?.role === 'site'),
    check('single-surface', 'EG-Desk 화면이 다른 창에 하나 더 뜨지 않았다', true, facts.overlayWindows === 0,
      { overlayWindows: facts.overlayWindows }),
  ];
  const cardRoute = required => check('card-route', '팝업이 새 창이 아니라 Browser 카드 하나로 열렸다', required,
    facts.route === 'card' && facts.popupCards.length === 1, { route: facts.route, popupCards: facts.popupCards.length });
  const openerLink = () => check('opener-link', '팝업 카드가 원래 카드를 opener로 기억한다(data-opener-card-id)',
    expectations.openerLink === true,
    facts.popupCards.length > 0 && facts.popupCards.every(card => card.openerCardId === facts.siteCardId));
  switch (item.id) {
    case 'unsized':
      checks.push(cardRoute(true),
        check('opened-window', 'window.open이 팝업 창 객체를 돌려줬다', true, facts.sitePage?.opened === 'window',
          { opened: facts.sitePage?.opened ?? null }),
        openerLink());
      break;
    case 'sized':
      checks.push(check('popup-loaded', '로그인 팝업 페이지가 카드나 팝업 창에 떴다', true, !!facts.provider, { route: facts.route }),
        // Popup card for sized popups waits on decision D-B7; until then it is reported only.
        cardRoute(false));
      break;
    case 'opener-message':
      checks.push(cardRoute(true),
        check('provider-has-opener', '팝업 페이지에서 window.opener가 살아 있다', true, facts.provider?.hasOpener === true),
        check('opener-received-message', '원래 페이지가 팝업의 로그인 완료 메시지를 받았다', true, facts.sitePage?.message === true),
        check('same-container', '팝업 카드가 원래 카드와 같은 계정(컨테이너)을 쓴다', true,
          facts.popupCards.length > 0 && facts.popupCards.every(card => card.userContextId === facts.siteUserContextId),
          { site: facts.siteUserContextId, popup: facts.popupCards.map(card => card.userContextId) }),
        openerLink());
      break;
    case 'self-close':
      checks.push(cardRoute(true),
        check('callback-reached', '팝업이 원래 사이트의 로그인 콜백 주소에 도착했다', true, facts.callbackReached),
        check('popup-closed-itself', '팝업이 스스로 닫자 팝업 카드도 닫혔다', true,
          facts.popupCards.length > 0 && facts.openCreatedCards.length === 0 && facts.openCreatedWindows.length === 0,
          { cardsStillOpen: facts.openCreatedCards.length, windowsStillOpen: facts.openCreatedWindows.length }),
        check('site-card-kept', '원래 카드는 그대로 남았다', true, facts.siteCardOpen),
        openerLink());
      break;
    case 'noopener':
      checks.push(cardRoute(true),
        check('returned-null', 'noopener window.open은 null을 돌려줬다', true, facts.sitePage?.opened === 'null',
          { opened: facts.sitePage?.opened ?? null }),
        check('provider-no-opener', '팝업 페이지에 window.opener가 없다', true, facts.provider?.hasOpener === false));
      break;
    default:
      throw new Error(`unknown scenario: ${item.id}`);
  }
  return checks;
}

export function bridgeOpenerCheck(events, facts) {
  const popupIds = new Set(facts.popupCards.map(card => card.cardId));
  const reports = (Array.isArray(events) ? events : [])
    .filter(event => event?.topic === 'browser.navigated' && popupIds.has(event.payload?.cardId));
  const withOpener = reports.filter(event => event.payload.openerCardId === facts.siteCardId).length;
  return check('bridge-opener', '헬퍼가 받은 팝업 카드 위치 보고에 원래 카드(openerCardId)가 붙어 있다', true,
    reports.length > 0 && withOpener === reports.length, { reports: reports.length, withOpener });
}

export const requiredPassed = checks => checks.filter(item => item.required).every(item => item.passed);

/** Cards and windows that appeared during the scenario (the site card included): only these are closed. */
export function createdArtifacts(baseline, seen) {
  const baseCards = new Set((baseline?.cards || []).map(card => card.cardId));
  const baseWindows = new Set((baseline?.windows || []).map(win => win.windowId));
  return {
    cardIds: seen.cards.map(card => card.cardId).filter(id => !baseCards.has(id)),
    windowIds: seen.windows.map(win => win.windowId).filter(id => !baseWindows.has(id)),
  };
}

function observedSummary(facts) {
  const entry = item => ({ locations: item.locations, userContextId: item.userContextId });
  return {
    route: facts.route,
    siteCardId: facts.siteCardId,
    sitePage: facts.sitePage,
    siteUserContextId: facts.siteUserContextId,
    provider: facts.provider,
    callback: facts.callback,
    popupCards: facts.popupCards.map(card => ({ ...entry(card), openerLinked: card.openerCardId === facts.siteCardId })),
    // Every new window, the sign-in one or not: a window that booted EG-Desk may have dropped the sign-in page.
    windows: facts.newWindows.map(win => ({ ...entry(win), popup: win.popup, overlay: win.overlay, closed: win.closed,
      showedSignIn: facts.popupWindows.includes(win) })),
    otherNewCards: facts.newCards.length - facts.popupCards.length,
    ...(facts.route === 'none' && facts.newWindows.length === 0 && facts.sitePage?.opened !== 'window'
      ? { hint: '팝업이 카드에도 창에도 뜨지 않았습니다. 팝업 차단(시험 사이트 권한)부터 확인하세요.' } : {}),
  };
}

const briefError = error => String(error?.message || error).slice(0, 500);

// --------------------------------------------------------------------- run

export async function runPopupScenario({ driver, scenario: item, fixture, deadlineMs, expectations = {}, bridge = null,
  timeoutMs = 12000, quietMs = 600, intervalMs = 150, now = Date.now, pause = sleep }) {
  const entry = { id: item.id, gap: item.gap, title: item.title, passed: false, route: 'none', checks: [] };
  let baseline = null;
  let seen = emptySeen();
  try {
    assertBeforeDeadline(deadlineMs, now());
    baseline = await driver.observe();
    let bridgeSeq = null;
    if (bridge && BRIDGE_SCENARIOS.has(item.id)) {
      try { bridgeSeq = await bridge.seq(); } catch (error) { entry.bridgeError = briefError(error); }
    }
    assertBeforeDeadline(deadlineMs, now());
    const opened = await driver.openSite(fixture.siteUrl(item.id));
    const siteCardId = typeof opened?.cardId === 'string' && opened.cardId ? opened.cardId : null;
    const end = Math.min(now() + timeoutMs, deadlineMs);
    let facts = null;
    let checks = [];
    let passingSince = null;
    for (;;) {
      assertBeforeDeadline(deadlineMs, now());
      const after = await driver.observe();
      seen = mergeSeen(seen, after);
      facts = scenarioFacts({ baseline, after, seen, siteCardId, origins: fixture.origins });
      checks = scenarioChecks(item, facts, expectations);
      if (requiredPassed(checks)) {
        passingSince ??= now();
        // Hold the passing state a moment so a late popup window still counts.
        if (now() - passingSince >= quietMs) break;
      } else passingSince = null;
      if (now() >= end) break;
      await pause(intervalMs);
    }
    if (bridge && BRIDGE_SCENARIOS.has(item.id)) {
      let events = [];
      if (bridgeSeq !== null) {
        try { events = await bridge.since(bridgeSeq); } catch (error) { entry.bridgeError = briefError(error); }
      }
      checks.push(bridgeOpenerCheck(events, facts));
    }
    Object.assign(entry, { checks, route: facts.route, passed: requiredPassed(checks), observed: observedSummary(facts) });
  } catch (error) {
    entry.passed = false;
    entry.error = briefError(error);
  }
  if (baseline) {
    const created = createdArtifacts(baseline, seen);
    entry.created = { cards: created.cardIds.length, windows: created.windowIds.length };
    if (now() < deadlineMs) {
      try { entry.cleanup = await driver.closeCreated(created); } catch (error) { entry.cleanup = { error: briefError(error) }; }
    } else entry.cleanup = { skipped: 'deadline', ...created };
  }
  return entry;
}

function record(result, id, label, passed, detail) {
  result.checks.push(check(id, label, true, passed, detail));
  return passed === true;
}

export async function runPopupRegression({ driver, fixture, deadlineMs, scenarios = POPUP_SCENARIOS, expectations = {},
  bridge = null, now = Date.now, pause = sleep, timing = {}, result }) {
  result.fixture = { site: fixture.origins.site, provider: fixture.origins.provider, providerIpv6: fixture.providerIpv6 === true };
  assertBeforeDeadline(deadlineMs, now());
  const guard = await driver.guard();
  if (!record(result, 'surface', 'EG-Desk 화면이 붙은 Firefox 창에 연결됐다',
    guard?.documentURI === 'chrome://browser/content/browser.xhtml' && guard?.mounted === true, { headless: guard?.headless ?? null })) {
    result.ok = false;
    return result;
  }
  assertBeforeDeadline(deadlineMs, now());
  const granted = await driver.setPopupPermission(fixture.origins.site, true);
  result.actions.push(`팝업 허용을 시험 사이트(${fixture.origins.site})에만 이번 세션 동안 켬`);
  try {
    if (record(result, 'popup-permission', '시험 사이트에 팝업이 허용됐다', granted?.allowed === true)) {
      for (const item of scenarios) {
        if (now() >= deadlineMs) { result.skipped.push(item.id); continue; }
        result.scenarios.push(await runPopupScenario({ driver, scenario: item, fixture, deadlineMs, expectations, bridge, now, pause, ...timing }));
      }
    }
  } finally {
    if (now() < deadlineMs) {
      try {
        const revoked = await driver.setPopupPermission(fixture.origins.site, false);
        result.permissionRemoved = revoked?.allowed === false;
        result.actions.push('시험 사이트의 팝업 허용을 끔');
      } catch (error) {
        result.permissionRemoved = false;
        result.permissionError = briefError(error);
      }
    } else result.permissionRemoved = 'skipped-deadline: the session permission ends with this Firefox session';
  }
  result.ok = result.checks.every(item => item.passed) && result.skipped.length === 0
    && result.scenarios.length === scenarios.length && result.scenarios.every(item => item.passed);
  return result;
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const {
    createHarness = options => new FirefoxMcpChatHarness(options),
    createDriver = createChromePopupDriver,
    startFixture = startPopupFixture,
    createBridge = () => createBridgeEventReader(),
    write = text => process.stdout.write(text),
    setExitCode = code => { process.exitCode = code; },
    now = Date.now,
    pause = sleep,
  } = deps;
  const result = { kind: 'firefox-mcp-browser-popups', ok: false, providerTurn: 'not-run',
    checks: [], actions: [], scenarios: [], skipped: [] };
  let harness = null;
  let fixture = null;
  try {
    const options = parseCli(argv, now());
    Object.assign(result, { profile: options.profile, marionettePort: options.marionettePort,
      expectations: options.expectations, bridgeEvents: options.bridgeEvents });
    fixture = await startFixture();
    assertBeforeDeadline(options.deadlineMs, now());
    harness = createHarness({ profile: options.profile, marionettePort: options.marionettePort });
    await harness.connect();
    await runPopupRegression({ driver: createDriver(harness, fixture.origins), fixture, deadlineMs: options.deadlineMs,
      scenarios: options.scenarios, expectations: options.expectations,
      bridge: options.bridgeEvents ? createBridge() : null, now, pause, result });
  } catch (error) {
    result.ok = false;
    result.error = briefError(error);
  } finally {
    try { await harness?.close(); } catch (error) { result.ok = false; result.closeError = briefError(error); }
    try { await fixture?.close(); } catch (error) { result.fixtureCloseError = briefError(error); }
  }
  write(`${JSON.stringify(result)}\n`);
  if (!result.ok) setExitCode(1);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runCli();
