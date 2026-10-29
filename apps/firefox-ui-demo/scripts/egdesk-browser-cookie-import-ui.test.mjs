import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as Identity from '../overlay/resources/EGDeskBrowserIdentity.sys.mjs';

// Synthetic DOM and injected services only: no Firefox or Chrome profile,
// OS keychain, native importer, browser process, or network is accessed.
const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing section: ${start}`);
  return source.slice(a, b);
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fakeDocument() {
  let document;
  class Node {
    constructor(tag, text = '') {
      this.tagName = tag.toUpperCase(); this._text = text; this.children = []; this.parentNode = null;
      this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {};
      this.disabled = false; this.checked = false; this.value = '';
    }
    get isConnected() { return this === document.documentElement || !!this.parentNode?.isConnected; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    setAttribute(key, value) {
      this.attributes[key] = String(value);
      if (key === 'disabled') this.disabled = true;
      if (key === 'value') this.value = String(value);
      if (key === 'id') this.id = String(value);
    }
    getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== handler); }
    appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
    remove() { if (!this.parentNode) return; this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    focus() { document.activeElement = this; }
    querySelector(selector) {
      const id = selector.match(/^\[data-testid="([^"]+)"\]$/)?.[1];
      const visit = node => node.dataset?.testid === id && id ? node : node.children.map(visit).find(Boolean);
      return visit(this) || null;
    }
    fire(type, event = {}) {
      for (const handler of this.listeners[type] || []) handler({ currentTarget: this, target: this, isTrusted: false,
        preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
  document = {
    createElement: tag => new Node(tag), createTextNode: value => new Node('#text', value),
    querySelector: () => document.dock || null,
  };
  document.documentElement = new Node('html');
  document.body = new Node('body'); document.documentElement.appendChild(document.body);
  document.dock = new Node('button'); document.body.appendChild(document.dock);
  return document;
}

function uiFixture({ supported = true } = {}) {
  const document = fakeDocument(), prefs = new Map(), events = [], cards = [], notices = [];
  let policy = true, privateWindow = false, containersEnabled = true, profilePath = '/synthetic/profile-a', uuid = 0;
  const containers = new Set([3]);
  const observerTopics = new Map(), prefObservers = new Set();
  const services = {
    policies: { isAllowed: () => policy },
    prefs: { getStringPref: (key, fallback) => prefs.get(key) ?? fallback, setStringPref: (key, value) => prefs.set(key, value),
      getBoolPref: () => containersEnabled, addObserver: (_, observer) => prefObservers.add(observer),
      removeObserver: (_, observer) => prefObservers.delete(observer) },
    obs: { addObserver: (observer, topic) => { if (!observerTopics.has(topic)) observerTopics.set(topic, new Set()); observerTopics.get(topic).add(observer); },
      removeObserver: (observer, topic) => observerTopics.get(topic)?.delete(observer) },
    dirsvc: { get: () => ({ path: profilePath }) },
  };
  const identity = { ...Identity, createBrowserIdentityAdapter: () => ({ listContainers: () => ({ supported: true,
    containers: [...containers].map(userContextId => ({ userContextId, kind: 'container' })) }) }) };
  const listed = deferred(), imported = deferred();
  const importer = {
    availability: () => ({ supported }),
    listProfiles(args) { events.push(['list', args]); return listed.promise; },
    importProfile(args) { events.push(['import', args]); return imported.promise; },
  };
  const listeners = new Map();
  const window = { AbortController, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    addEventListener: (type, handler) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
    removeEventListener: (type, handler) => listeners.get(type)?.delete(handler) };
  const card = document.createElement('div'), opener = document.createElement('button');
  document.body.appendChild(card); card.appendChild(opener);
  const browser = card._xulBrowser = document.createElement('browser'); card.appendChild(browser);
  browser.browsingContext = { originAttributes: { userContextId: 0, privateBrowsingId: 0 } };
  const context = {
    document, window, Ci: { nsIFile: {} }, servicesRef: () => services,
    browserImportAllowed: () => policy, boardNotice: message => notices.push(message),
    ChromeUtils: { importESModule(uri) {
      if (uri.endsWith('PrivateBrowsingUtils.sys.mjs')) return { PrivateBrowsingUtils: { isWindowPrivate: () => privateWindow } };
      if (uri.endsWith('ContextualIdentityService.sys.mjs')) return { ContextualIdentityService: {} };
      if (uri.endsWith('EGDeskBrowserIdentity.sys.mjs')) return identity;
      if (uri.endsWith('EGDeskBrowserCookieImport.sys.mjs')) return { createBrowserCookieImporter: options => {
        assert.equal(options.browserWindow, window); assert.equal(options.profileImportPolicy, 'allow');
        assert.equal(options.privateBrowsingId, 0); return importer;
      } };
      throw new Error('unexpected module');
    } },
    spawnBrowserCard(url, options) {
      const node = document.createElement('div'), address = document.createElement('input');
      document.body.appendChild(node); node.appendChild(address);
      node.querySelector = selector => selector === '.egd-card-url' ? address : null;
      cards.push({ node, url, options }); return node;
    },
    focusCanvasCard: node => events.push(['focus-card', node]),
    revealOpenCanvasCard: node => events.push(['reveal-card', node]),
  };
  const code = section('  function el(', '\n  function svgEl(') +
    section('  const BROWSER_IDENTITY_REGISTRY_PREF', '\n  // Firefox Library is a separate native window.') +
    section('  let browserCookieImportSession = null;', '\n  let browserLibrarySession = null;');
  const api = runInNewContext(`${code}\n({ browserIdentityUsable, registerImportedBrowserIdentity, browserCookieImportSourceAllowed,
    browserCookieImportSupport, openBrowserCookieImport, closeBrowserCookieImportForCard })`, context);
  const part = id => document.documentElement.querySelector(`[data-testid="${id}"]`);
  return { api, context, document, card, browser, opener, events, cards, notices, prefs, containers, listed, imported, part,
    setPolicy: value => { policy = value; }, setPrivate: value => { privateWindow = value; },
    setProfilePath: value => { profilePath = value; },
    notifyIdentity: (topic, id) => { for (const observer of observerTopics.get(topic) || []) observer.observe({ wrappedJSObject: { userContextId: id } }, topic); },
    disableContainers: () => { containersEnabled = false; for (const observer of prefObservers) observer.observe(null, 'nsPref:changed'); } };
}

async function choose(f) {
  f.api.openBrowserCookieImport(f.card, f.opener, { isTrusted: true });
  f.part('browser-cookie-find').fire('click', { isTrusted: true });
  f.listed.resolve({ supported: true, profiles: [
    { id: 'source-a', name: '원본 A', email: 'a@example.test', cookies: ['PRIVATE-COOKIE-DO-NOT-SHOW'] },
    { id: 'source-b', name: '원본 B' },
  ] });
  await tick();
}

test('profile enumeration requires a real explicit action; private, auth, policy and unsupported sources are gated', async () => {
  const f = uiFixture();
  assert.equal(f.api.openBrowserCookieImport(f.card, f.opener, { isTrusted: false }), null);
  assert.equal(f.events.length, 0);
  const panel = f.api.openBrowserCookieImport(f.card, f.opener, { isTrusted: true });
  assert.ok(panel.textContent.includes('Chrome 프로필을 찾아 선택하세요'));
  assert.equal(f.events.length, 0, 'opening the dialog never enumerates profiles');
  f.part('browser-cookie-find').fire('click');
  assert.equal(f.events.length, 0);
  f.part('browser-cookie-find').fire('click', { isTrusted: true });
  f.part('browser-cookie-find').fire('click', { isTrusted: true });
  assert.equal(f.events.filter(item => item[0] === 'list').length, 1);
  assert.equal(f.events.find(item => item[0] === 'list')[1].explicitUserRequest, true);
  f.listed.resolve({ supported: true, profiles: [{ id: 'one', name: '표시 이름' }] });
  await tick();
  assert.ok(f.part('browser-cookie-profile'));
  f.api.closeBrowserCookieImportForCard(f.card);
  for (const change of [() => f.setPrivate(true), () => { f.setPrivate(false); f.setPolicy(false); },
    () => { f.setPolicy(true); f.card.dataset.codexRole = 'auth'; }]) {
    change();
    assert.equal(f.api.browserCookieImportSupport(f.card).supported, false);
    assert.equal(f.api.openBrowserCookieImport(f.card, f.opener, { isTrusted: true }), null);
  }
  assert.equal(uiFixture({ supported: false }).api.browserCookieImportSupport(uiFixture().card).supported, false);
});

test('explicit source and cookie consent gate exactly one import, and only counts and a bound new target are displayed', async () => {
  const f = uiFixture(); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  let confirm = f.part('browser-cookie-confirm');
  assert.equal(confirm.disabled, true);
  select.value = 'source-b'; select.fire('change');
  consent.checked = true; consent.fire('change');
  confirm.fire('click', { isTrusted: true });
  assert.equal(f.events.filter(item => item[0] === 'import').length, 0, 'synthetic selection/consent do not authorize a real click');
  select.fire('change', { isTrusted: true }); consent.fire('change', { isTrusted: true });
  assert.equal(confirm.disabled, false);
  confirm.fire('click');
  assert.equal(f.events.filter(item => item[0] === 'import').length, 0, 'synthetic confirm does not import');
  confirm.fire('click', { isTrusted: true });
  confirm.fire('click', { isTrusted: true });
  const calls = f.events.filter(item => item[0] === 'import');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].profileId, 'source-b');
  assert.equal(calls[0][1].explicitUserConsent, true);
  assert.equal(calls[0][1].signal.aborted, false);
  assert.ok(f.document.documentElement.textContent.includes('비밀번호·북마크·방문 기록은 가져오지 않습니다'));
  assert.ok(f.document.documentElement.textContent.includes('기존 Browser와 분리된 새 Browser'));
  f.containers.add(17);
  f.imported.resolve({ status: 'partial', counts: { imported: 5, skipped: 2, unsupported: 1, failed: 1 },
    userContextId: 17, containerName: 'Chrome · 원본 B', cookies: ['PRIVATE-COOKIE-DO-NOT-SHOW'], reason: 'PRIVATE-COOKIE-DO-NOT-SHOW' });
  await tick();
  assert.equal(f.cards.length, 1);
  assert.equal(f.cards[0].url, 'about:blank');
  assert.equal(f.cards[0].options.browserIdentity.userContextId, 17);
  assert.equal(f.cards[0].options.browserIdentity.containerName, 'Chrome · 원본 B');
  assert.equal(f.api.browserIdentityUsable(f.cards[0].options.browserIdentity), true);
  assert.match(f.part('browser-cookie-counts').textContent, /가져옴 5.*건너뜀 2.*지원하지 않음 1.*실패 1/);
  assert.match(f.document.documentElement.textContent, /사이트를 열어 로그인 상태를 확인하세요/);
  assert.doesNotMatch(f.document.documentElement.textContent, /PRIVATE-COOKIE-DO-NOT-SHOW/);
  f.part('browser-cookie-open-result').fire('click', { isTrusted: true });
  assert.equal(f.document.activeElement, f.cards[0].node.querySelector('.egd-card-url'));
});

test('cancel aborts work, ignores late results, and never focuses a closed opener', async () => {
  const f = uiFixture(); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  const signal = f.events.find(item => item[0] === 'import')[1].signal;
  f.card.remove();
  f.api.closeBrowserCookieImportForCard(f.card);
  assert.equal(signal.aborted, true);
  f.containers.add(9);
  f.imported.resolve({ status: 'imported', userContextId: 9, counts: { imported: 1 } });
  await tick();
  assert.equal(f.cards.length, 0);
  assert.notEqual(f.document.activeElement, f.opener);
  assert.equal(f.part('browser-cookie-import-dialog'), null);
});

test('cancel while importing aborts but keeps the dialog until the core reports the outcome', async () => {
  const f = uiFixture(); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  const signal = f.events.find(item => item[0] === 'import')[1].signal;
  f.part('browser-cookie-cancel').fire('click', { isTrusted: true });
  assert.equal(signal.aborted, true);
  assert.ok(f.part('browser-cookie-import-dialog'));
  assert.match(f.document.documentElement.textContent, /중단하는 중/);
  assert.equal(f.part('browser-cookie-cancel').disabled, true);
  f.imported.resolve({ status: 'cancelled', counts: { imported: 0, skipped: 0, unsupported: 0, failed: 0 } });
  await tick();
  assert.match(f.part('browser-cookie-result').textContent, /취소했습니다/);
  assert.doesNotMatch(f.document.documentElement.textContent, /정리되지 않은/);
  f.part('browser-cookie-close').fire('click', { isTrusted: true });
  assert.equal(f.document.activeElement, f.opener);
});

test('a late cleanup-incomplete receipt warns without reviving a closed dialog or exposing the receipt', async () => {
  const f = uiFixture(); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  f.part('browser-cookie-cancel').fire('click', { isTrusted: true });
  assert.equal(f.api.openBrowserCookieImport(f.card, f.opener, { isTrusted: true }), null,
    'a new import cannot start while the cancelled one is still cleaning up');
  f.card.remove();
  f.api.closeBrowserCookieImportForCard(f.card);
  f.imported.resolve({ status: 'failed', reason: 'cleanup-incomplete', userContextId: 9,
    counts: { imported: 0, failed: 1 }, cookie: 'PRIVATE-COOKIE-DO-NOT-SHOW' });
  await tick();
  assert.equal(f.cards.length, 0);
  assert.equal(f.notices.length, 2);
  assert.match(f.notices[1], /정리되지 않은 분리 환경/);
  assert.doesNotMatch(f.notices[1], /PRIVATE-COOKIE-DO-NOT-SHOW/);
  assert.notEqual(f.document.activeElement, f.opener);
});

test('changing policy after opening the dialog prevents profile enumeration and import', async () => {
  const first = uiFixture();
  first.api.openBrowserCookieImport(first.card, first.opener, { isTrusted: true });
  first.setPolicy(false);
  first.part('browser-cookie-find').fire('click', { isTrusted: true });
  assert.equal(first.events.length, 0);
  const second = uiFixture(); await choose(second);
  const select = second.part('browser-cookie-profile'), consent = second.part('browser-cookie-consent');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  second.setPrivate(true);
  second.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  assert.equal(second.events.filter(item => item[0] === 'import').length, 0);
});

test('a normal close restores the opener, but an existing native container may not be rebound as a new import', async () => {
  const f = uiFixture(); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  f.imported.resolve({ status: 'imported', userContextId: 3, counts: { imported: 1 } });
  await tick();
  assert.equal(f.cards.length, 0);
  assert.match(f.document.documentElement.textContent, /새 Browser를 열지 않았습니다/);
  f.part('browser-cookie-close').fire('click', { isTrusted: true });
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.prefs.size, 0, 'no existing ID was registered or overwritten');
});

test('profile namespace plus per-container key are required even when a numeric ID or display name matches', () => {
  const f = uiFixture(); f.containers.add(7);
  const first = f.api.registerImportedBrowserIdentity(7, '같은 이름');
  assert.equal(f.api.browserIdentityUsable(first), true);
  assert.equal(f.api.browserIdentityUsable({ ...first, containerName: '이름 변경' }), true, 'display name is not identity');
  assert.equal(f.api.browserIdentityUsable({ ...first, profileScopeId: null }), false);
  assert.equal(f.api.browserIdentityUsable({ ...first, browserIdentityKey: null }), false);
  f.setProfilePath('/synthetic/profile-b');
  assert.equal(f.api.browserIdentityUsable(first), false, 'copied preferences in another Firefox profile fail closed');
  f.setProfilePath('/synthetic/profile-a');
  f.containers.delete(7);
  assert.equal(f.api.browserIdentityUsable(first), false, 'missing native identity fails closed');
  f.containers.add(7);
  const replacement = f.api.registerImportedBrowserIdentity(7, '같은 이름');
  assert.notEqual(replacement.browserIdentityKey, first.browserIdentityKey);
  assert.equal(f.api.browserIdentityUsable(first), false, 'a newly registered reuse invalidates the old token');
  assert.equal(f.api.browserIdentityUsable(replacement), true);
});

test('native deletion, recreation, and container reset revoke stale keys before numeric IDs can be reused', () => {
  const f = uiFixture(); f.containers.add(7);
  const old = f.api.registerImportedBrowserIdentity(7, '원래 환경');
  f.containers.delete(7);
  f.notifyIdentity('contextual-identity-deleted', 7);
  f.containers.add(7);
  f.notifyIdentity('contextual-identity-created', 7);
  assert.equal(f.api.browserIdentityUsable(old), false, 'the same numeric ID cannot resurrect a deleted binding');
  const replacement = f.api.registerImportedBrowserIdentity(7, '새 환경');
  assert.equal(f.api.browserIdentityUsable(replacement), true);
  f.disableContainers();
  assert.equal(f.api.browserIdentityUsable(replacement), false, 'disabling containers clears every binding');
});

test('native XUL is configured before append and an isolated failure never falls back to an iframe', () => {
  const code = section("    try {\n      xulBrowser = document.createXULElement('browser');", '\n    const agentTargetMarker');
  const run = ({ mismatch = false, fail = false, identity = { userContextId: 7 } } = {}) => {
    const order = [], frame = { isConnected: false, browsingContext: null, attrs: {}, style: {},
      setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'src') order.push('src'); },
      getAttribute(key) { return this.attrs[key] ?? null; }, removeAttribute(key) { delete this.attrs[key]; }, remove() { this.isConnected = false; } };
    const context = { browserIdentity: identity, options: {}, normalizedUrl: 'about:blank',
      document: { createXULElement: () => frame }, browserIdentityModule: () => ({
        configureBrowser(browser, id) { order.push('configure'); return Identity.configureBrowser(browser, id); },
        browserUserContextId: Identity.browserUserContextId,
      }), ensureBrowserAgentActor() {}, wrap: { appendChild(browser) {
        order.push('append'); if (fail) throw new Error('synthetic failure');
        browser.isConnected = true; browser.browsingContext = { originAttributes: { userContextId: mismatch ? 0 : 7 } };
      } }, deskWindow: { requestClose: () => order.push('close') }, el: () => { order.push('iframe'); return {}; },
      console, TAG: '[test]' };
    const invoke = () => runInNewContext(`(() => { let xulBrowser = null; ${code}; return xulBrowser; })()`, context);
    return { order, frame, invoke };
  };
  const ok = run(); assert.equal(ok.invoke(), ok.frame);
  assert.deepEqual(ok.order, ['configure', 'append', 'src']);
  for (const option of [{ mismatch: true }, { fail: true }]) {
    const broken = run(option);
    assert.throws(broken.invoke, /기본 환경으로 전환하지 않았습니다/);
    assert.equal(broken.order.includes('iframe'), false);
    assert.equal(broken.order.includes('close'), true);
  }
});

test('popup routes only a live verified opener and preserves identity; unknown or mismatched contexts are blocked', () => {
  const f = uiFixture(); f.containers.add(7);
  const identity = f.api.registerImportedBrowserIdentity(7, 'Chrome · 원본');
  f.card._browserIdentity = identity;
  f.browser.setAttribute('usercontextid', '7');
  f.browser.browsingContext.originAttributes.userContextId = 7;
  const notices = [], calls = [];
  const openWindowInfo = { parent: { top: f.browser.browsingContext }, originAttributes: { userContextId: 7, privateBrowsingId: 0 } };
  const context = { document: { querySelectorAll: () => [f.card] }, browserIdentityModule: () => Identity,
    browserIdentityUsable: f.api.browserIdentityUsable, boardNotice: message => notices.push(message),
    spawnBrowserCard: (url, options) => { calls.push({ url, options }); return { _xulBrowser: {} }; } };
  const api = runInNewContext(`${section('  function browserPopupSource(', '\n  function installPopupCapture()')}\n({ browserPopupSource, spawnBrowserPopup })`, context);
  assert.ok(api.spawnBrowserPopup({ spec: 'https://example.test/' }, openWindowInfo));
  assert.equal(calls[0].options.browserIdentity, identity);
  assert.equal(calls[0].options.openWindowInfo, openWindowInfo);
  assert.equal(calls[0].options.requireNativeBrowser, true);
  assert.equal(api.spawnBrowserPopup(null, null), null);
  assert.equal(api.spawnBrowserPopup(null, { ...openWindowInfo, originAttributes: { userContextId: 0, privateBrowsingId: 0 } }), null);
  assert.equal(api.spawnBrowserPopup(null, openWindowInfo, { openerBrowser: {}, isPrivate: false }), null);
  f.card.remove();
  assert.equal(api.spawnBrowserPopup(null, openWindowInfo), null);
  assert.equal(calls.length, 1);
  assert.equal(notices.length, 4);
});

test('the production source dedupe key separates identical URLs in different environments', () => {
  const code = section('  function sourceRefKey(', '\n  function singletonSourceRef(');
  const context = { state: { agenda: { activeAgendaId: 'agenda' }, sourceRefs: { defaultProfileId: 'default' } },
    normalizeSourcePart: value => String(value), normalizeBrowserUri: url => url.split('#')[0] };
  const api = runInNewContext(`${code}\n({ sourceRefKey, browserSourceRef })`, context);
  const url = 'https://example.test/page#one';
  const ordinary = api.browserSourceRef(url);
  const a = api.browserSourceRef(url, { browserIdentityRequired: true, browserIdentityKey: 'environment-a' });
  const b = api.browserSourceRef(url, { browserIdentityRequired: true, browserIdentityKey: 'environment-b' });
  assert.notEqual(api.sourceRefKey(ordinary), api.sourceRefKey(a));
  assert.notEqual(api.sourceRefKey(a), api.sourceRefKey(b));
  assert.equal(api.sourceRefKey(a), api.sourceRefKey(api.browserSourceRef('https://example.test/page#two',
    { browserIdentityRequired: true, browserIdentityKey: 'environment-a' })));
  assert.equal(a.browserIdentityRequired, true);
});

test('the production restore passes identity through and refuses an absent required binding', () => {
  const f = uiFixture(); f.containers.add(7);
  const binding = f.api.registerImportedBrowserIdentity(7, 'Chrome · A');
  const created = [], context = { normalizeBrowserNavigationUri: value => value, cloneJson: value => structuredClone(value),
    state: { codex: {} }, retargetRestoredEntityId() {}, bindCardSourceRef() {}, applyPersistentEntityGeometry() {},
    spawnBrowserCard: (url, options) => {
      if (Object.hasOwn(options, 'browserIdentity') && !f.api.browserIdentityUsable(options.browserIdentity)) throw new Error('invalid identity');
      created.push({ url, options }); return { _sourceRef: options.sourceRef };
    } };
  const code = section('  function runtimeStateForCard(', '\n  function serializeCardState(') +
    section('  function restoreCardFromState(', '\n  function restoreShapeFromState(');
  const api = runInNewContext(`${code}\n({ runtimeStateForCard, restoreCardFromState })`, context);
  const saved = api.runtimeStateForCard({ _browserState: { uri: 'https://example.test/', title: 'Example' },
    _browserIdentity: binding }, 'browser');
  assert.notEqual(saved.browserIdentity, binding);
  assert.equal(saved.browserIdentity.browserIdentityKey, binding.browserIdentityKey);
  const record = { type: 'browser', id: 'one', runtimeState: saved,
    sourceRef: { browserIdentityRequired: true, browserIdentityKey: binding.browserIdentityKey } };
  api.restoreCardFromState(record);
  assert.equal(created[0].options.browserIdentity.browserIdentityKey, binding.browserIdentityKey);
  assert.throws(() => api.restoreCardFromState({ ...record, runtimeState: { uri: 'https://example.test/' } }), /연결 정보/);
  assert.throws(() => api.restoreCardFromState({ ...record, runtimeState: { ...saved,
    browserIdentity: { ...binding, profileScopeId: null, browserIdentityKey: null } } }), /invalid identity/);
  assert.equal(created.length, 1, 'no default Browser opened for either missing identity');
});

test('persistence, navigation, duplicate and existing native import hooks retain their intended boundaries', () => {
  const runtime = section('  function runtimeStateForCard(', '\n  function serializeCardState(');
  const restore = section('  function restoreCardFromState(', '\n  function restoreShapeFromState(');
  const mount = section('  function mountBoardMember(', '\n  // Most recently activated Board');
  const nav = section('    const syncBrowserStateFromBrowser =', '\n    const selectBrowserForChat =');
  const menu = section('    const showBrowserMenu =', '\n    card._browserState =');
  assert.match(runtime, /browserIdentity: cloneJson\(card\._browserIdentity\)/);
  for (const body of [restore, mount]) {
    assert.match(body, /browserIdentityRequired/);
    assert.match(body, /Object\.hasOwn\(runtime, 'browserIdentity'\)/);
    assert.match(body, /browserIdentity: runtime\.browserIdentity/);
  }
  assert.match(nav, /sourceForBrowser\(browserState\.uri\)/);
  assert.match(nav, /sourceForBrowser\(url/);
  assert.match(nav, /card\._browserIdentity \? \{ browserIdentity: card\._browserIdentity \}/);
  assert.match(menu, /browser-cookie-import/);
  assert.match(menu, /browser-library-bookmarks/);
  assert.match(menu, /browser-library-history/);
  assert.match(menu, /browser-library-import/);
  const exposed = section('      window.__egdesk = {', '\n        sourceRefs: {');
  assert.doesNotMatch(exposed, /openBrowserCookieImport|listProfiles|importProfile|CookieImporter/);
});
