import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { runInNewContext } from 'node:vm';
import {
  BRIDGE_SCENARIOS, CALLBACK_PATH, PAGE_STATE_PREFIX, POPUP_SCENARIOS,
  assertFixtureOrigins, bridgeOpenerCheck, chromeCloseCreated, chromeOpenSiteCard, chromeReadPopupSurface,
  chromeSetPopupPermission, createBridgeEventReader, createChromePopupDriver, createPopupFixtureHandler, createdArtifacts,
  emptySeen, mergeSeen, parseCli, popupCallbackHtml, popupProviderHtml, popupSiteHtml, runCli, runPopupRegression, runPopupScenario, sanitizePageState,
  scenarioChecks, scenarioFacts, startPopupFixture,
} from './verify-firefox-mcp-browser-popups.mjs';

const DEADLINE_UTC = '2026-10-24T18:00:00Z';
const DEADLINE = Date.parse(DEADLINE_UTC);
const BEFORE = DEADLINE - 3_600_000;
const ORIGINS = Object.freeze({ site: 'http://127.0.0.1:41001', provider: 'http://localhost:41002' });
const byId = id => POPUP_SCENARIOS.find(item => item.id === id);

test('five scenarios in a fixed order: plain, sized, opener message, self-close and noopener popups', () => {
  assert.deepEqual(POPUP_SCENARIOS.map(item => item.id), ['unsized', 'sized', 'opener-message', 'self-close', 'noopener']);
  assert.ok(Object.isFrozen(POPUP_SCENARIOS) && POPUP_SCENARIOS.every(item => Object.isFrozen(item) && Object.isFrozen(item.open)));
  assert.match(byId('sized').open.features, /width=\d+,height=\d+/, 'the sized popup is the one Firefox sends to a new window');
  assert.equal(byId('unsized').open.features, '');
  assert.equal(byId('opener-message').open.features, '', 'the opener scenario goes through the card path');
  assert.equal(byId('noopener').open.features, 'noopener');
  assert.deepEqual([...BRIDGE_SCENARIOS], ['opener-message', 'self-close']);
  for (const item of POPUP_SCENARIOS) assert.ok(item.title && /^BRW-0[34]/.test(item.gap), item.id);
});

test('CLI needs an explicit QA profile and UTC deadline; only ports 2829/2828; scenarios and next-step expectations are opt-in', () => {
  const parsed = parseCli(['--profile', '/tmp/qa-profile', '--deadline-utc', DEADLINE_UTC], BEFORE);
  assert.equal(parsed.profile, '/tmp/qa-profile');
  assert.equal(parsed.deadlineMs, DEADLINE);
  assert.equal(parsed.marionettePort, 2829);
  assert.deepEqual(parsed.scenarios.map(item => item.id), POPUP_SCENARIOS.map(item => item.id));
  assert.deepEqual(parsed.expectations, { openerLink: false });
  assert.equal(parsed.bridgeEvents, false);
  const narrowed = parseCli(['--scenario', 'self-close', '--profile', '/p', '--scenario', 'unsized', '--deadline-utc', DEADLINE_UTC,
    '--marionette-port', '2828', '--expect-opener-link', '--bridge-events'], BEFORE);
  assert.deepEqual(narrowed.scenarios.map(item => item.id), ['unsized', 'self-close'], 'canonical order');
  assert.equal(narrowed.marionettePort, 2828);
  assert.deepEqual(narrowed.expectations, { openerLink: true });
  assert.equal(narrowed.bridgeEvents, true);
  for (const bad of [
    [],
    ['--profile', '/p'],
    ['--deadline-utc', DEADLINE_UTC],
    ['--profile', '/p', '--deadline-utc', '2026-10-24 18:00'],
    ['--profile', '/p', '--deadline-utc', '2026-10-24T09:00:00Z'],
    ['--profile', '/p', '--deadline-utc', DEADLINE_UTC, '--marionette-port', '6000'],
    ['--profile', '/p', '--deadline-utc', DEADLINE_UTC, '--scenario', 'everything'],
    ['--profile', '/p', '--deadline-utc', DEADLINE_UTC, '--scenario', 'sized', '--scenario', 'sized'],
    ['--profile', '/p', '--profile', '/q', '--deadline-utc', DEADLINE_UTC],
    ['--profile', '--deadline-utc', DEADLINE_UTC],
    ['--profile', '/p', '--deadline-utc', DEADLINE_UTC, '--headless'],
    ['--profile', '/p', '--deadline-utc', DEADLINE_UTC, '--bridge-events', '--bridge-events'],
  ]) assert.throws(() => parseCli(bad, BEFORE), undefined, bad.join(' '));
});

function fakeRequest(method, url, host) { return { method, url, headers: { host } }; }
function fakeResponse() {
  return { status: 0, headers: {}, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = String(body ?? ''); } };
}

test('fixture handlers serve only their own Host, paths and GET; pages carry no secret and no query reaches the page config', () => {
  assert.deepEqual(assertFixtureOrigins(ORIGINS.site, ORIGINS.provider), ORIGINS);
  for (const [site, provider] of [
    ['http://localhost:41001', 'http://localhost:41002'], ['http://127.0.0.1:41001', 'http://127.0.0.1:41002'],
    ['http://127.0.0.1:39218', ORIGINS.provider], ['http://127.0.0.1:41002', ORIGINS.provider], ['https://127.0.0.1:41001', ORIGINS.provider],
    ['http://127.0.0.1:80', ORIGINS.provider],
  ]) assert.throws(() => assertFixtureOrigins(site, provider), undefined, `${site} ${provider}`);
  const site = createPopupFixtureHandler({ role: 'site', siteOrigin: ORIGINS.site, providerOrigin: ORIGINS.provider });
  const provider = createPopupFixtureHandler({ role: 'provider', siteOrigin: ORIGINS.site, providerOrigin: ORIGINS.provider });
  const call = (handler, method, url, host) => { const response = fakeResponse(); handler(fakeRequest(method, url, host), response); return response; };

  const page = call(site, 'GET', '/popup/sized', '127.0.0.1:41001');
  assert.equal(page.status, 200);
  assert.match(page.headers['Content-Type'], /^text\/html/);
  assert.match(page.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.equal(page.headers['Cache-Control'], 'no-store');
  assert.match(page.body, /"target":"egdesk-qa-login"/);
  assert.match(page.body, /"features":"popup,width=480,height=640"/);
  assert.match(page.body, /"popupUrl":"http:\/\/localhost:41002\/login\/sized"/);
  assert.ok(page.body.includes(PAGE_STATE_PREFIX));
  const providerPage = call(provider, 'GET', '/login/self-close', 'localhost:41002');
  assert.equal(providerPage.status, 200);
  assert.match(providerPage.body, /"callbackUrl":"http:\/\/127\.0\.0\.1:41001\/oauth\/callback\?code=QA-FAKE-CODE-NOT-A-SECRET/);
  const callback = call(site, 'GET', `${CALLBACK_PATH}?code=SHOULD-NOT-ECHO&state=x`, '127.0.0.1:41001');
  assert.equal(callback.status, 200);
  assert.equal(callback.body.includes('SHOULD-NOT-ECHO'), false, 'the callback page never echoes its query');
  assert.match(callback.body, /window\.close\(\)/);

  assert.equal(call(site, 'GET', '/popup/sized', 'localhost:41001').status, 404, 'wrong Host');
  assert.equal(call(site, 'GET', '/popup/sized', 'evil.example').status, 404);
  assert.equal(call(provider, 'GET', '/login/sized', '127.0.0.1:41002').status, 404, 'the provider answers only as localhost');
  assert.equal(call(site, 'GET', '/login/sized', '127.0.0.1:41001').status, 404, 'each origin has its own pages');
  assert.equal(call(provider, 'GET', '/popup/sized', 'localhost:41002').status, 404);
  assert.equal(call(site, 'GET', '/popup/everything', '127.0.0.1:41001').status, 404);
  assert.equal(call(site, 'GET', '/popup/../oauth/callback', '127.0.0.1:41001').status, 200, 'URL parsing normalizes dot segments first');
  assert.equal(call(site, 'GET', 'http://evil.example/popup/sized', '127.0.0.1:41001').status, 404, 'absolute-form request targets are refused');
  const post = call(site, 'POST', '/popup/sized', '127.0.0.1:41001');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.throws(() => createPopupFixtureHandler({ role: 'other', siteOrigin: ORIGINS.site, providerOrigin: ORIGINS.provider }));
  const injected = popupSiteHtml({ id: 'unsized', open: { target: '</script><script>alert(1)</script>', features: '' } }, ORIGINS);
  assert.equal(injected.includes('</script><script>alert(1)'), false, 'config is escaped inside the inline script');
});

// Runs a fixture page's inline script against a fake page and reports what it did.
function runPage(html, { opener = null, openResult = {}, toolbarVisible = true } = {}) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const listeners = {};
  const timers = [];
  const calls = { opened: [], posted: [], replaced: [], closed: 0 };
  const stateNode = { textContent: '' };
  const page = {
    document: { title: '', getElementById: id => (id === 'state' ? stateNode : null) },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    setInterval: () => 1, clearInterval: () => {}, Date, JSON, Object,
    location: { replace: url => calls.replaced.push(url) },
    toolbar: { visible: toolbarVisible },
    opener: opener && { postMessage: (data, origin) => calls.posted.push([data, origin]) },
    open: (...args) => { calls.opened.push(args); return openResult; },
    close: () => { calls.closed += 1; },
  };
  page.window = page;
  runInNewContext(script, page);
  const state = () => JSON.parse(page.document.title.slice(PAGE_STATE_PREFIX.length));
  return { page, listeners, timers, calls, state, fire: (type, event = {}) => (listeners[type] || []).forEach(fn => fn(event)),
    runTimers: () => { while (timers.length) timers.shift().fn(); } };
}

test('fixture page scripts: the site opens its popup on load and hears only fixture messages; provider and callback act per scenario', () => {
  const sized = runPage(popupSiteHtml(byId('sized'), ORIGINS));
  assert.deepEqual(sized.state(), { role: 'site', scenario: 'sized', opened: 'pending', message: false, popupClosed: false });
  sized.fire('load');
  assert.deepEqual(JSON.parse(JSON.stringify(sized.calls.opened)), [[`${ORIGINS.provider}/login/sized`, 'egdesk-qa-login', 'popup,width=480,height=640']]);
  assert.equal(sized.state().opened, 'window');
  sized.fire('message', { origin: 'https://evil.example', data: { egdeskPopupQa: 'login-finished' } });
  sized.fire('message', { origin: ORIGINS.provider, data: { other: true } });
  assert.equal(sized.state().message, false, 'foreign origins and other messages are ignored');
  sized.fire('message', { origin: ORIGINS.provider, data: { egdeskPopupQa: 'login-finished' } });
  assert.equal(sized.state().message, true);
  const blocked = runPage(popupSiteHtml(byId('noopener'), ORIGINS), { openResult: null });
  blocked.fire('load');
  assert.equal(blocked.state().opened, 'null');

  const message = runPage(popupProviderHtml(byId('opener-message'), ORIGINS), { opener: true });
  assert.deepEqual(message.state(), { role: 'provider', scenario: 'opener-message', hasOpener: true, inPopupWindow: false, posted: true });
  assert.deepEqual(JSON.parse(JSON.stringify(message.calls.posted)), [[{ egdeskPopupQa: 'login-finished' }, ORIGINS.site]], 'posted only to the site origin');
  const lost = runPage(popupProviderHtml(byId('opener-message'), ORIGINS), { toolbarVisible: false });
  assert.deepEqual(lost.state(), { role: 'provider', scenario: 'opener-message', hasOpener: false, inPopupWindow: true, posted: false });
  const closing = runPage(popupProviderHtml(byId('self-close'), ORIGINS), { opener: true });
  assert.deepEqual(closing.calls.posted, [], 'the self-close provider leaves the message to the callback');
  closing.runTimers();
  assert.deepEqual(closing.calls.replaced, [`${ORIGINS.site}${CALLBACK_PATH}?code=QA-FAKE-CODE-NOT-A-SECRET&state=qa`]);

  const callback = runPage(popupCallbackHtml(ORIGINS), { opener: true });
  assert.deepEqual(callback.state(), { role: 'callback', scenario: null, hasOpener: true, posted: true, closing: true });
  assert.equal(callback.calls.closed, 0, 'it closes a moment later');
  callback.runTimers();
  assert.equal(callback.calls.closed, 1);
});

function get(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { host, connection: 'close' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the fixture servers listen on loopback ephemeral ports (site on 127.0.0.1, provider answering as localhost) and close cleanly', async () => {
  const fixture = await startPopupFixture();
  try {
    const sitePort = Number(new URL(fixture.origins.site).port);
    const providerPort = Number(new URL(fixture.origins.provider).port);
    assert.match(fixture.origins.site, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(fixture.origins.provider, /^http:\/\/localhost:\d+$/);
    assert.equal(fixture.siteUrl('noopener'), `${fixture.origins.site}/popup/noopener`);
    assert.equal(typeof fixture.providerIpv6, 'boolean');
    const page = await get(sitePort, '/popup/opener-message', `127.0.0.1:${sitePort}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(`"providerOrigin":"${fixture.origins.provider}"`));
    assert.equal((await get(providerPort, '/login/opener-message', `localhost:${providerPort}`)).status, 200);
    assert.equal((await get(providerPort, '/login/opener-message', `127.0.0.1:${providerPort}`)).status, 404);
  } finally {
    await fixture.close();
  }
});

// A tiny privileged-window stand-in for the chrome functions (they run from their source text, as in Firefox).
function chromeSandbox({ cards = [], windows = [], perms = null } = {}) {
  const main = { closed: false };
  const cardNodes = cards.map(card => ({
    id: card.id, isConnected: true, dataset: card.opener ? { openerCardId: card.opener } : {},
    classList: { contains: name => name === 'egd-browser-card' },
    _xulBrowser: card.spec === undefined ? null : {
      currentURI: { spec: card.spec }, contentTitle: card.title ?? '',
      browsingContext: card.context === undefined ? null : { originAttributes: { userContextId: card.context } },
      getAttribute: name => (name === 'usercontextid' ? card.attr ?? null : null),
    },
  }));
  const closedCards = [];
  const windowObjects = windows.map(win => ({
    closed: false, docShell: { outerWindowID: win.id }, toolbar: { visible: !win.popup }, __egdesk: win.overlay ? {} : undefined,
    document: { getElementById: () => null },
    gBrowser: { selectedBrowser: { currentURI: { spec: win.spec }, contentTitle: win.title ?? '', getAttribute: () => null } },
    close() { if (!win.sticky) this.closed = true; },
  }));
  const permissionLog = [];
  const sandbox = {
    window: main, URL, JSON, Number, String, Set, Map, Array, Promise, Error,
    setTimeout: (fn) => { fn(); return 0; },
    document: {
      documentURI: 'chrome://browser/content/browser.xhtml',
      querySelectorAll: selector => (selector === '.egd-browser-card' ? cardNodes.filter(node => node.isConnected) : []),
      getElementById: id => cardNodes.find(node => node.id === id && node.isConnected) || null,
    },
    Services: {
      wm: { getEnumerator: type => (type === 'navigator:browser' ? [main, ...windowObjects] : []) },
      scriptSecurityManager: { createContentPrincipalFromOrigin: origin => ({ origin }) },
      perms: perms || {
        ALLOW_ACTION: 1, EXPIRE_SESSION: 1, state: new Map(),
        addFromPrincipal(principal, type, action, expire) { permissionLog.push(['add', principal.origin, type, action, expire]); this.state.set(principal.origin + type, action); },
        removeFromPrincipal(principal, type) { permissionLog.push(['remove', principal.origin, type]); this.state.delete(principal.origin + type); },
        testPermissionFromPrincipal(principal, type) { return this.state.get(principal.origin + type) ?? 0; },
      },
    },
  };
  main.__egdesk = {
    cardRuntime: {
      openBrowserCard(url, options) { sandbox.opened = { url, options }; return { id: 'egd-browser-card-77' }; },
      closeCard(node) { closedCards.push(node.id); if (node.id !== 'egd-browser-card-stuck') node.isConnected = false; return true; },
    },
  };
  sandbox.globalThis = sandbox;
  return { sandbox, closedCards, permissionLog, windowObjects };
}
// Results cross back as JSON, as they do through the harness (one JSON string over BiDi).
const runChrome = (sandbox, fn, arg) => {
  const value = runInNewContext(`(${fn.toString()})(${JSON.stringify(arg)})`, sandbox);
  return typeof value?.then === 'function' ? value.then(result => JSON.parse(JSON.stringify(result))) : JSON.parse(JSON.stringify(value));
};

test('the chrome reader keeps fixture locations as origin + path only, parses only fixture titles, and reads containers and popup windows', () => {
  const state = JSON.stringify({ role: 'site', scenario: 'opener-message', opened: 'window', message: true });
  const { sandbox } = chromeSandbox({
    cards: [
      { id: 'egd-browser-card-1', spec: 'https://mail.example.com/u/0/inbox?token=SECRET', title: `${PAGE_STATE_PREFIX}{"role":"site"}`, context: 0 },
      { id: 'egd-browser-card-2', spec: `${ORIGINS.site}/popup/opener-message`, title: PAGE_STATE_PREFIX + state, context: 2 },
      { id: 'egd-browser-card-3', spec: `${ORIGINS.site}/oauth/callback?code=QA-FAKE-CODE-NOT-A-SECRET&state=qa`, title: 'Callback', attr: '2', opener: 'egd-browser-card-2' },
      { id: 'egd-browser-card-4', spec: 'about:blank', title: `${PAGE_STATE_PREFIX}{"role":"site"}` },
      { id: 'egd-browser-card-5' },
    ],
    windows: [{ id: 91, spec: `${ORIGINS.provider}/login/sized`, title: `${PAGE_STATE_PREFIX}{"role":"provider","hasOpener":true}`, popup: true, overlay: true }],
  });
  const read = runChrome(sandbox, chromeReadPopupSurface, { prefix: PAGE_STATE_PREFIX, origins: ORIGINS });
  assert.deepEqual(read.cards.map(card => [card.cardId, card.location, card.userContextId, card.openerCardId]), [
    ['egd-browser-card-1', 'other', 0, null],
    ['egd-browser-card-2', `${ORIGINS.site}/popup/opener-message`, 2, null],
    ['egd-browser-card-3', `${ORIGINS.site}/oauth/callback`, 2, 'egd-browser-card-2'],
    ['egd-browser-card-4', 'about:blank', 0, null],
    ['egd-browser-card-5', null, 0, null],
  ]);
  assert.equal(read.cards[0].page, null, 'a foreign page title is never parsed, even with the prefix');
  assert.deepEqual(read.cards[1].page, JSON.parse(state));
  assert.equal(read.cards[3].page, null);
  assert.deepEqual(read.windows, [{ windowId: '91', closed: false, popup: true, overlay: true, location: `${ORIGINS.provider}/login/sized`,
    page: { role: 'provider', hasOpener: true }, userContextId: 0 }]);
  const text = JSON.stringify(read);
  for (const leaked of ['SECRET', 'mail.example.com', 'QA-FAKE-CODE', '?']) assert.equal(text.includes(leaked), false, leaked);
  const unmounted = chromeSandbox();
  delete unmounted.sandbox.window.__egdesk;
  assert.throws(() => runChrome(unmounted.sandbox, chromeReadPopupSurface, { prefix: PAGE_STATE_PREFIX, origins: ORIGINS }), /not mounted/);
});

test('chrome actions are fenced: popup permission only for the loopback site, only the fixture page opens, only created cards and windows close', async () => {
  const { sandbox, permissionLog, closedCards, windowObjects } = chromeSandbox({
    cards: [{ id: 'egd-browser-card-1', spec: 'https://a.example/' }, { id: 'egd-browser-card-2', spec: `${ORIGINS.site}/popup/sized` },
      { id: 'egd-browser-card-stuck', spec: `${ORIGINS.site}/popup/sized` }],
    windows: [{ id: 5, spec: 'https://user.example/' }, { id: 6, spec: `${ORIGINS.provider}/login/sized` }, { id: 7, spec: 'about:blank', sticky: true }],
  });
  assert.deepEqual(runChrome(sandbox, chromeSetPopupPermission, { origin: ORIGINS.site, allow: true }), { origin: ORIGINS.site, allowed: true });
  assert.deepEqual(runChrome(sandbox, chromeSetPopupPermission, { origin: ORIGINS.site, allow: false }), { origin: ORIGINS.site, allowed: false });
  assert.deepEqual(permissionLog, [['add', ORIGINS.site, 'popup', 1, 1], ['remove', ORIGINS.site, 'popup']]);
  for (const origin of ['https://a.example', 'http://localhost:41002', 'http://127.0.0.1', 'http://127.0.0.1:41001/x']) {
    assert.throws(() => runChrome(sandbox, chromeSetPopupPermission, { origin, allow: true }), /only for the loopback fixture site/, origin);
  }
  assert.deepEqual(runChrome(sandbox, chromeOpenSiteCard, { url: `${ORIGINS.site}/popup/self-close`, siteOrigin: ORIGINS.site }), { cardId: 'egd-browser-card-77' });
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.opened)), { url: `${ORIGINS.site}/popup/self-close`, options: { openMode: 'new' } });
  for (const url of [`${ORIGINS.provider}/login/sized`, `${ORIGINS.site}/oauth/callback`, `${ORIGINS.site}/popup/sized?x=1`, 'https://a.example/popup/sized']) {
    assert.throws(() => runChrome(sandbox, chromeOpenSiteCard, { url, siteOrigin: ORIGINS.site }), /Only the loopback popup fixture page/, url);
  }
  const closed = await runChrome(sandbox, chromeCloseCreated, { cardIds: ['egd-browser-card-2', 'egd-browser-card-stuck', 'egd-browser-card-404'], windowIds: ['6', '7'] });
  assert.deepEqual(closed, { cardsClosed: 1, cardsLeft: 1, windowsClosed: 1, windowsLeft: 1 });
  assert.deepEqual(closedCards, ['egd-browser-card-2', 'egd-browser-card-stuck'], 'the pre-existing card is never touched');
  assert.deepEqual(windowObjects.map(win => win.closed), [false, true, false], 'the pre-existing window stays open');
});

test('page states keep only the fixture fields with their known types', () => {
  assert.deepEqual(sanitizePageState({ role: 'site', scenario: 'sized', opened: 'window', message: true, popupClosed: 'yes', extra: 'x' }),
    { role: 'site', scenario: 'sized', opened: 'window', message: true, popupClosed: false });
  assert.deepEqual(sanitizePageState({ role: 'provider', scenario: 'noopener', hasOpener: false, inPopupWindow: true, posted: 1 }),
    { role: 'provider', scenario: 'noopener', hasOpener: false, posted: false, inPopupWindow: true });
  assert.deepEqual(sanitizePageState({ role: 'callback', scenario: 'nope', hasOpener: 'true', posted: true, closing: true }),
    { role: 'callback', scenario: null, hasOpener: null, posted: true, closing: true });
  assert.equal(sanitizePageState({ role: 'admin' }), null);
  assert.equal(sanitizePageState('site'), null);
  assert.equal(sanitizePageState({ role: 'site', opened: 'maybe' }).opened, null);
});

// Observations as the chrome reader returns them.
const SITE = 'egd-browser-card-10';
const POPUP = 'egd-browser-card-11';
const baseline = { cards: [{ cardId: 'egd-browser-card-1', location: 'other', page: null, userContextId: 0, openerCardId: null }], windows: [] };
const siteCard = (id, page, extra = {}) => ({ cardId: SITE, location: `${ORIGINS.site}/popup/${id}`,
  page: { role: 'site', scenario: id, opened: 'window', message: false, popupClosed: false, ...page }, userContextId: 0, openerCardId: null, ...extra });
const popupCard = (location, page, extra = {}) => ({ cardId: POPUP, location, page, userContextId: 0, openerCardId: null, ...extra });
const provider = (id, page = {}) => ({ role: 'provider', scenario: id, hasOpener: true, inPopupWindow: false, posted: false, ...page });

function judge(id, observations, expectations = {}) {
  let seen = mergeSeen(emptySeen(), baseline);
  for (const observation of observations) seen = mergeSeen(seen, observation);
  const facts = scenarioFacts({ baseline, after: observations.at(-1), seen, siteCardId: SITE, origins: ORIGINS });
  const checks = scenarioChecks(byId(id), facts, expectations);
  return { facts, checks, failed: checks.filter(item => item.required && !item.passed).map(item => item.id),
    info: Object.fromEntries(checks.filter(item => !item.required).map(item => [item.id, item.passed])) };
}

test('judging today\'s card path: lost opener, null return, overlay in a sized popup window and a card that will not close are each named', () => {
  const unsized = judge('unsized', [{ cards: [...baseline.cards, siteCard('unsized', { opened: 'null' }),
    popupCard(`${ORIGINS.provider}/login/unsized`, provider('unsized', { hasOpener: false }))], windows: [] }]);
  assert.deepEqual(unsized.failed, ['opened-window']);
  assert.equal(unsized.facts.route, 'card');
  assert.deepEqual(unsized.info, { 'opener-link': false });

  const sized = judge('sized', [{ cards: [...baseline.cards, siteCard('sized')],
    windows: [{ windowId: '44', closed: false, popup: true, overlay: true, location: 'about:blank', page: null, userContextId: 0 }] }]);
  assert.deepEqual(sized.failed, ['single-surface', 'popup-loaded'], 'the second EG-Desk surface replaced the sign-in page');
  assert.deepEqual(sized.info, { 'card-route': false });

  const message = judge('opener-message', [{ cards: [...baseline.cards, siteCard('opener-message', { opened: 'null' }),
    popupCard(`${ORIGINS.provider}/login/opener-message`, provider('opener-message', { hasOpener: false }), { userContextId: 0 })], windows: [] }]);
  assert.deepEqual(message.failed, ['provider-has-opener', 'opener-received-message']);

  const selfClose = judge('self-close', [
    { cards: [...baseline.cards, siteCard('self-close', { opened: 'null' }), popupCard(`${ORIGINS.provider}/login/self-close`, provider('self-close', { hasOpener: false }))], windows: [] },
    { cards: [...baseline.cards, siteCard('self-close', { opened: 'null' }), popupCard(`${ORIGINS.site}/oauth/callback`, { role: 'callback', hasOpener: false, posted: false, closing: true })], windows: [] },
  ]);
  assert.deepEqual(selfClose.failed, ['popup-closed-itself']);
  assert.deepEqual(selfClose.checks.find(item => item.id === 'popup-closed-itself').detail, { cardsStillOpen: 1, windowsStillOpen: 0 });

  const noopener = judge('noopener', [{ cards: [...baseline.cards, siteCard('noopener', { opened: 'null' }),
    popupCard(`${ORIGINS.provider}/login/noopener`, provider('noopener', { hasOpener: false }))], windows: [] }]);
  assert.deepEqual(noopener.failed, []);
});

test('judging the fixed behavior: every required check passes, and a container mismatch or a second popup still fails', () => {
  const opener = { openerCardId: SITE };
  assert.deepEqual(judge('unsized', [{ cards: [...baseline.cards, siteCard('unsized'), popupCard(`${ORIGINS.provider}/login/unsized`, provider('unsized'), opener)], windows: [] }],
    { openerLink: true }).failed, []);
  assert.deepEqual(judge('sized', [{ cards: [...baseline.cards, siteCard('sized')],
    windows: [{ windowId: '44', closed: false, popup: true, overlay: false, location: `${ORIGINS.provider}/login/sized`, page: provider('sized', { inPopupWindow: true }), userContextId: 0 }] }]).failed, [],
  'a plain popup window without EG-Desk passes the safety net before D-B7');
  const message = judge('opener-message', [{ cards: [...baseline.cards, siteCard('opener-message', { message: true }, { userContextId: 3 }),
    popupCard(`${ORIGINS.provider}/login/opener-message`, provider('opener-message', { posted: true }), { userContextId: 3, ...opener })], windows: [] }], { openerLink: true });
  assert.deepEqual(message.failed, []);
  const otherContainer = judge('opener-message', [{ cards: [...baseline.cards, siteCard('opener-message', { message: true }, { userContextId: 3 }),
    popupCard(`${ORIGINS.provider}/login/opener-message`, provider('opener-message', { posted: true }), { userContextId: 0 })], windows: [] }]);
  assert.deepEqual(otherContainer.failed, ['same-container']);
  const twoPopups = judge('unsized', [{ cards: [...baseline.cards, siteCard('unsized'), popupCard(`${ORIGINS.provider}/login/unsized`, provider('unsized')),
    { ...popupCard(`${ORIGINS.provider}/login/unsized`, provider('unsized')), cardId: 'egd-browser-card-12' }], windows: [] }]);
  assert.deepEqual(twoPopups.failed, ['card-route']);
  const closed = judge('self-close', [
    { cards: [...baseline.cards, siteCard('self-close'), popupCard(`${ORIGINS.site}/oauth/callback`, { role: 'callback', hasOpener: true, posted: true, closing: true }, opener)], windows: [] },
    { cards: [...baseline.cards, siteCard('self-close', { message: true, popupClosed: true })], windows: [] },
  ], { openerLink: true });
  assert.deepEqual(closed.failed, []);
  const siteGone = judge('self-close', [
    { cards: [...baseline.cards, siteCard('self-close'), popupCard(`${ORIGINS.site}/oauth/callback`, { role: 'callback', hasOpener: true, posted: true, closing: true })], windows: [] },
    { cards: [...baseline.cards], windows: [] },
  ]);
  assert.deepEqual(siteGone.failed, ['site-card', 'site-card-kept'], 'closing the opener card along with the popup is a failure');
});

test('the bridge check wants every popup-card location report to name the opener card', () => {
  const facts = { siteCardId: SITE, popupCards: [{ cardId: POPUP }] };
  const report = (payload, topic = 'browser.navigated') => ({ topic, payload: { cardId: POPUP, origin: ORIGINS.site, path: '/oauth/callback', ...payload } });
  assert.equal(bridgeOpenerCheck([report({ openerCardId: SITE }), report({ cardId: SITE })], facts).passed, true);
  assert.deepEqual(bridgeOpenerCheck([report({ openerCardId: SITE }), report({})], facts).detail, { reports: 2, withOpener: 1 });
  assert.equal(bridgeOpenerCheck([report({ openerCardId: SITE }), report({})], facts).passed, false);
  assert.equal(bridgeOpenerCheck([], facts).passed, false, 'no report at all is a failure');
  assert.equal(bridgeOpenerCheck([report({ openerCardId: SITE }, 'browser.oauthCompleted')], facts).passed, false, 'only navigation reports are counted');
});

test('the bridge reader asks only GET /events/recent', async () => {
  const routes = [];
  const reader = createBridgeEventReader(async route => { routes.push(route); return route.endsWith('since=0') ? { seq: 12, events: [] } : { seq: 14, events: [{ seq: 13 }] }; });
  assert.equal(await reader.seq(), 12);
  assert.deepEqual(await reader.since(12), [{ seq: 13 }]);
  assert.deepEqual(await reader.since(-1), [], 'a bad sequence asks from the start');
  assert.deepEqual(routes, ['/events/recent?since=0', '/events/recent?since=12', '/events/recent?since=0']);
});

// A simulated Firefox: cards, popup windows and page states change on a fake clock.
function simulatedFirefox({ behavior }) {
  let clock = BEFORE;
  let nextCard = 20;
  let nextWindow = 300;
  const cards = [{ cardId: 'egd-browser-card-1', location: 'other', page: null, userContextId: 0, openerCardId: null }];
  const windows = [];
  const scheduled = [];
  const calls = [];
  const at = (delay, apply) => scheduled.push({ time: clock + delay, apply });
  const fixed = behavior === 'fixed';
  const driver = {
    async guard() { calls.push('guard'); return { documentURI: 'chrome://browser/content/browser.xhtml', mounted: true, headless: true }; },
    async setPopupPermission(origin, allow) { calls.push(`permission:${allow}`); return { origin, allowed: allow }; },
    async observe() {
      for (const item of scheduled.filter(entry => entry.time <= clock)) { item.apply(); scheduled.splice(scheduled.indexOf(item), 1); }
      return structuredClone({ cards, windows });
    },
    async openSite(url) {
      calls.push(`open:${url}`);
      const id = url.split('/popup/')[1];
      const site = { cardId: `egd-browser-card-${nextCard++}`, location: url, page: { role: 'site', scenario: id, opened: 'pending', message: false, popupClosed: false }, userContextId: 2, openerCardId: null };
      cards.push(site);
      const popupId = `egd-browser-card-${nextCard++}`;
      const login = `${ORIGINS.provider}/login/${id}`;
      const cardPopup = (page, extra = {}) => ({ cardId: popupId, location: login, page, userContextId: fixed ? 2 : 0, openerCardId: fixed ? site.cardId : null, ...extra });
      at(200, () => {
        if (id === 'sized') {
          windows.push({ windowId: String(nextWindow++), closed: false, popup: true, overlay: !fixed,
            location: fixed ? login : 'about:blank', page: fixed ? provider(id, { inPopupWindow: true }) : null, userContextId: 0 });
          site.page.opened = 'window';
          return;
        }
        const linked = fixed && id !== 'noopener';
        site.page.opened = linked ? 'window' : 'null';
        cards.push(cardPopup(provider(id, { hasOpener: linked, posted: linked && id === 'opener-message' })));
        if (linked && id === 'opener-message') site.page.message = true;
      });
      if (id === 'self-close') {
        at(600, () => {
          const popup = cards.find(card => card.cardId === popupId);
          Object.assign(popup, { location: `${ORIGINS.site}${CALLBACK_PATH}`, page: { role: 'callback', hasOpener: fixed, posted: fixed, closing: true } });
        });
        if (fixed) at(1000, () => { cards.splice(cards.findIndex(card => card.cardId === popupId), 1); site.page.message = true; site.page.popupClosed = true; });
      }
      return { cardId: site.cardId };
    },
    async closeCreated(created) {
      calls.push(`close:${created.cardIds.join(',')}|${created.windowIds.join(',')}`);
      for (const id of created.cardIds) { const index = cards.findIndex(card => card.cardId === id); if (index >= 0) cards.splice(index, 1); }
      for (const id of created.windowIds) { const index = windows.findIndex(win => win.windowId === id); if (index >= 0) windows.splice(index, 1); }
      return { cardsClosed: created.cardIds.length, cardsLeft: 0, windowsClosed: created.windowIds.length, windowsLeft: 0 };
    },
  };
  return { driver, calls, cards, windows, now: () => clock, pause: async ms => { clock += ms; }, advance: ms => { clock += ms; } };
}

const fixture = { origins: ORIGINS, providerIpv6: true, siteUrl: id => `${ORIGINS.site}/popup/${id}` };
const freshResult = () => ({ kind: 'firefox-mcp-browser-popups', ok: false, checks: [], actions: [], scenarios: [], skipped: [] });

test('a run against today\'s behavior fails with named checks, closes what it opened and removes the popup permission', async () => {
  const sim = simulatedFirefox({ behavior: 'today' });
  const result = await runPopupRegression({ driver: sim.driver, fixture, deadlineMs: DEADLINE, now: sim.now, pause: sim.pause, result: freshResult() });
  assert.equal(result.ok, false);
  const failed = Object.fromEntries(result.scenarios.map(item => [item.id, item.checks.filter(c => c.required && !c.passed).map(c => c.id)]));
  assert.deepEqual(failed, {
    unsized: ['opened-window'],
    sized: ['single-surface', 'popup-loaded'],
    'opener-message': ['provider-has-opener', 'opener-received-message', 'same-container'],
    'self-close': ['popup-closed-itself'],
    noopener: [],
  }, 'the simulated site card uses container 2; today\'s popup card falls back to the default container');
  assert.deepEqual(result.scenarios.map(item => item.passed), [false, false, false, false, true]);
  assert.deepEqual(sim.cards.map(card => card.cardId), ['egd-browser-card-1'], 'every card the run opened is closed again');
  assert.deepEqual(sim.windows, [], 'the popup window is closed again');
  assert.equal(sim.calls[0], 'guard');
  assert.equal(sim.calls[1], 'permission:true');
  assert.equal(sim.calls.at(-1), 'permission:false');
  assert.equal(result.permissionRemoved, true);
  assert.deepEqual(result.fixture, { site: ORIGINS.site, provider: ORIGINS.provider, providerIpv6: true });
  const sized = result.scenarios.find(item => item.id === 'sized');
  assert.deepEqual(sized.created, { cards: 1, windows: 1 });
  assert.deepEqual(sized.observed.windows, [{ locations: ['about:blank'], userContextId: 0, popup: true, overlay: true, closed: false, showedSignIn: false }],
    'the window that booted EG-Desk is reported even though it lost the sign-in page');
  assert.equal(result.scenarios.some(item => item.observed.hint), false, 'every popup appeared somewhere');
  const blocked = await runPopupScenario({ driver: { ...simulatedFirefox({ behavior: 'today' }).driver, openSite: async () => ({ cardId: SITE }),
    observe: async () => ({ cards: [...baseline.cards, siteCard('unsized', { opened: 'null' })], windows: [] }), closeCreated: async () => ({}) },
  scenario: byId('unsized'), fixture, deadlineMs: DEADLINE, now: sim.now, pause: sim.pause });
  assert.match(blocked.observed.hint, /팝업 차단/, 'a popup that appeared nowhere points at the popup blocker first');
  const evidence = JSON.stringify(result);
  for (const leaked of ['QA-FAKE-CODE', 'code=', '?']) assert.equal(evidence.includes(leaked), false, leaked);
});

test('a run against the fixed behavior passes every scenario, including the next-step opener link and bridge reports', async () => {
  const sim = simulatedFirefox({ behavior: 'fixed' });
  const bridgeEvents = [];
  const bridge = {
    async seq() { return 40; },
    async since(seq) {
      assert.equal(seq, 40);
      return sim.cards.filter(card => card.openerCardId).map(card => ({ topic: 'browser.navigated', payload: { cardId: card.cardId, origin: ORIGINS.site, path: '/x', openerCardId: card.openerCardId } }))
        .concat(bridgeEvents);
    },
  };
  // In the self-close run the popup card is gone before the bridge is read; report it as the screen would have.
  const originalOpen = sim.driver.openSite;
  sim.driver.openSite = async url => {
    const opened = await originalOpen(url);
    if (url.endsWith('/self-close')) bridgeEvents.push({ topic: 'browser.navigated', payload: { cardId: `egd-browser-card-${Number(opened.cardId.split('-').pop()) + 1}`, origin: ORIGINS.site, path: CALLBACK_PATH, openerCardId: opened.cardId } });
    return opened;
  };
  const result = await runPopupRegression({ driver: sim.driver, fixture, deadlineMs: DEADLINE, expectations: { openerLink: true }, bridge,
    now: sim.now, pause: sim.pause, result: freshResult() });
  assert.deepEqual(result.scenarios.filter(item => !item.passed).map(item => [item.id, item.checks.filter(c => c.required && !c.passed)]), []);
  assert.equal(result.ok, true);
  for (const id of BRIDGE_SCENARIOS) assert.equal(result.scenarios.find(item => item.id === id).checks.at(-1).id, 'bridge-opener');
  assert.equal(result.scenarios.find(item => item.id === 'unsized').checks.some(item => item.id === 'bridge-opener'), false);
  assert.deepEqual(result.scenarios.map(item => item.route), ['card', 'window', 'card', 'card', 'card']);
});

test('the run waits for late changes, stops at the deadline, and records the open cards instead of touching Firefox after it', async () => {
  const sim = simulatedFirefox({ behavior: 'fixed' });
  const entry = await runPopupScenario({ driver: sim.driver, scenario: byId('self-close'), fixture, deadlineMs: DEADLINE, now: sim.now, pause: sim.pause });
  assert.equal(entry.passed, true, 'the self-closing popup is judged after it closes, not when it first appears');

  const late = simulatedFirefox({ behavior: 'today' });
  const deadlineMs = late.now() + 500;
  const cut = await runPopupScenario({ driver: late.driver, scenario: byId('self-close'), fixture, deadlineMs, now: late.now, pause: late.pause });
  assert.equal(cut.passed, false);
  assert.match(cut.error, /deadline reached/);
  assert.equal(cut.cleanup.skipped, 'deadline');
  assert.deepEqual(cut.cleanup.cardIds.length, 2, 'the site card and its popup card are listed for Main');
  assert.equal(late.calls.some(call => call.startsWith('close:')), false);

  const throwing = simulatedFirefox({ behavior: 'fixed' });
  throwing.driver.openSite = async () => { throw new Error('openBrowserCard failed'); };
  const failed = await runPopupScenario({ driver: throwing.driver, scenario: byId('unsized'), fixture, deadlineMs: DEADLINE, now: throwing.now, pause: throwing.pause });
  assert.equal(failed.passed, false);
  assert.equal(failed.error, 'openBrowserCard failed');
  assert.deepEqual(failed.created, { cards: 0, windows: 0 });

  const unmounted = simulatedFirefox({ behavior: 'fixed' });
  unmounted.driver.guard = async () => { unmounted.calls.push('guard'); return { documentURI: 'chrome://browser/content/browser.xhtml', mounted: false }; };
  const refused = await runPopupRegression({ driver: unmounted.driver, fixture, deadlineMs: DEADLINE, now: unmounted.now, pause: unmounted.pause, result: freshResult() });
  assert.equal(refused.ok, false);
  assert.deepEqual(unmounted.calls, ['guard'], 'no permission and no card without a mounted EG-Desk surface');
});

test('created artifacts are only what appeared after the baseline', () => {
  const seen = mergeSeen(mergeSeen(emptySeen(), baseline), { cards: [siteCard('unsized'), popupCard(`${ORIGINS.provider}/login/unsized`, null)],
    windows: [{ windowId: '9', location: 'about:blank' }] });
  assert.deepEqual(createdArtifacts(baseline, seen), { cardIds: [SITE, POPUP], windowIds: ['9'] });
  const merged = mergeSeen(seen, { cards: [{ cardId: POPUP, location: 'javascript:alert(1)', page: { role: 'root' } }],
    windows: [{ windowId: '9', overlay: true }, { windowId: '9', overlay: false }] });
  assert.deepEqual(merged.cards.find(card => card.cardId === POPUP).locations, [`${ORIGINS.provider}/login/unsized`], 'unknown location shapes are dropped');
  assert.equal(merged.windows[0].overlay, true, 'an overlay once seen stays recorded');
});

test('runCli refuses bad arguments before starting a fixture or a harness, and drives the run through injected parts', async () => {
  const written = [];
  const exitCodes = [];
  let started = 0;
  const refused = await runCli(['--profile', '/p'], { write: text => written.push(text), setExitCode: code => exitCodes.push(code),
    startFixture: async () => { started += 1; return fixture; }, createHarness: () => { throw new Error('must not be created'); }, now: () => BEFORE });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /--profile and --deadline-utc are both required/);
  assert.equal(started, 0);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(JSON.parse(written[0]).kind, 'firefox-mcp-browser-popups');

  const sim = simulatedFirefox({ behavior: 'fixed' });
  const events = [];
  const result = await runCli(['--profile', '/qa', '--deadline-utc', DEADLINE_UTC, '--scenario', 'noopener'], {
    write: text => written.push(text), setExitCode: code => exitCodes.push(code), now: sim.now, pause: sim.pause,
    startFixture: async () => ({ ...fixture, close: async () => events.push('fixture-closed') }),
    createHarness: options => { events.push(`harness:${options.profile}:${options.marionettePort}`); return { connect: async () => events.push('connected'), close: async () => events.push('harness-closed') }; },
    createDriver: (harness, origins) => { assert.deepEqual(origins, ORIGINS); return sim.driver; },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.scenarios.map(item => item.id), ['noopener']);
  assert.deepEqual(events, ['harness:/qa:2829', 'connected', 'harness-closed', 'fixture-closed']);
  assert.deepEqual(exitCodes, [1], 'a passing run does not set an exit code');
});

test('the chrome driver sends each privileged function as one callable string under the MCP size limit', async () => {
  const sources = [];
  const harness = { evaluateChrome: async source => { sources.push(source); return { ok: true }; } };
  const driver = createChromePopupDriver(harness, ORIGINS);
  await driver.guard();
  await driver.setPopupPermission(ORIGINS.site, true);
  await driver.observe();
  await driver.openSite(`${ORIGINS.site}/popup/unsized`);
  await driver.closeCreated({ cardIds: ['a'], windowIds: [] });
  assert.equal(sources.length, 5);
  for (const source of sources) {
    assert.match(source, /^async \(\) => await \(/);
    assert.ok(Buffer.byteLength(source) < 14 * 1024, `${Buffer.byteLength(source)} bytes`);
  }
  assert.ok(sources[2].includes(JSON.stringify({ prefix: PAGE_STATE_PREFIX, origins: ORIGINS })));
  assert.ok(sources[3].includes(JSON.stringify({ url: `${ORIGINS.site}/popup/unsized`, siteOrigin: ORIGINS.site })));
});
