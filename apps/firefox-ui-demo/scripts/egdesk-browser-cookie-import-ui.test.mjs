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

function uiFixture({ supported = true, availabilityReason = 'platform-unsupported', scopeModes = ['preserve', 'standard-web'], spawnFailures = 0 } = {}) {
  const document = fakeDocument(), prefs = new Map(), events = [], cards = [], notices = [];
  let policy = true, privateWindow = false, containersEnabled = true, failPrefs = false, profilePath = '/synthetic/profile-a', uuid = 0;
  let spawnAttempts = 0;
  const containers = new Set([3]);
  const observerTopics = new Map(), prefObservers = new Set();
  const services = {
    policies: { isAllowed: () => policy },
    prefs: { getStringPref: (key, fallback) => prefs.get(key) ?? fallback, setStringPref: (key, value) => {
      if (failPrefs) throw new Error('synthetic preference failure'); prefs.set(key, value);
    },
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
    availability: () => supported ? { supported: true, ...(scopeModes ? { scopeModes } : {}) } : { supported: false, reason: availabilityReason },
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
      spawnAttempts++;
      if (spawnAttempts <= spawnFailures) throw new Error('synthetic browser failure');
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
    browserCookieImportReasonMessage, browserCookieImportSupport, openBrowserCookieImport, closeBrowserCookieImportForCard })`, context);
  const part = id => document.documentElement.querySelector(`[data-testid="${id}"]`);
  return { api, context, document, card, browser, opener, events, cards, notices, prefs, containers, listed, imported, part,
    setPolicy: value => { policy = value; }, setPrivate: value => { privateWindow = value; },
    setFailPrefs: value => { failPrefs = value; }, getSpawnAttempts: () => spawnAttempts,
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
  const unsupported = uiFixture({ supported: false });
  const support = unsupported.api.browserCookieImportSupport(unsupported.card);
  assert.equal(support.supported, false);
  assert.equal(support.reason, 'platform-unsupported');
  assert.equal(unsupported.api.openBrowserCookieImport(unsupported.card, unsupported.opener, { isTrusted: true }), null);
  assert.match(unsupported.notices[0], /macOS에서만/);
});

test('only reviewed reason codes map to actionable fixed messages; unknown values are never echoed', () => {
  const f = uiFixture();
  for (const [reason, expected] of [
    ['source-busy', /Chrome을 완전히 종료한 뒤 다시 시도/],
    ['keychain-permission-denied', /키체인 접근이 거부.*권한/],
    ['keychain-unavailable-or-denied', /키체인.*읽지 못했습니다.*권한/],
    ['unsupported-schema', /Chrome 데이터 형식.*지원되지 않습니다/],
    ['platform-unsupported', /macOS에서만/],
    ['gecko-version-unsupported', /Firefox 버전.*업데이트/],
    ['native-contextual-identity-unavailable', /분리 환경 기능/],
    ['source-wal-unsupported', /데이터 저장 방식.*지원되지 않습니다/],
    ['cookie-capacity-unverified', /쿠키 저장 한도를 확인할 수 없어/],
    ['cookie-capacity-exceeded', /쿠키 저장 한도를 넘어/],
    ['containers-disabled', /설정 또는 조직 정책/],
    ['policy-denied', /정책/],
  ]) assert.match(f.api.browserCookieImportReasonMessage(reason), expected, reason);
  for (const reason of ['COOKIE_SECRET_DO_NOT_SHOW', '__proto__', { message: 'COOKIE_SECRET_DO_NOT_SHOW' }, null]) {
    const text = f.api.browserCookieImportReasonMessage(reason);
    assert.doesNotMatch(text, /COOKIE_SECRET_DO_NOT_SHOW|__proto__/);
    assert.match(text, /사용할 수 없습니다/);
  }
});

test('the unavailable platform reason appears on the disabled Browser menu entry', () => {
  const f = uiFixture(), document = f.document;
  const anchor = f.opener; anchor.getBoundingClientRect = () => ({ right: 100, bottom: 100, top: 80 });
  f.card._sourceRef = {};
  document.activeElement = anchor;
  const context = { document, menuButton: anchor, card: f.card, browserState: { uri: 'https://example.test/', homeUrl: 'https://example.test/' },
    window: { innerHeight: 800, setTimeout() {}, addEventListener() {}, removeEventListener() {} },
    resolveFloatingMenuPlacement: () => ({ left: 0, top: 0 }),
    browserCookieImportSupport: () => ({ supported: false, reason: 'platform-unsupported' }),
    browserCookieImportReasonMessage: f.api.browserCookieImportReasonMessage,
    spawnBrowserCard() {}, copyTextToClipboard() {}, navigateBrowser() {}, stopBrowser() {}, reloadBrowser() {},
    isCardFullscreen: () => false, toggleCardFullscreen() {}, endAgentHold() {}, openFirefoxBrowserLibrary() {}, openFirefoxBrowserImport() {} };
  const code = section('  function el(', '\n  function svgEl(') +
    section('    const duplicateBrowser = () => spawnBrowserCard(', '    const selectBrowserForChat =') +
    '\n    const selectBrowserForChat = () => {};\n' + section('    const showBrowserMenu =', '\n    card._browserState =');
  const api = runInNewContext(`let browserMenuPanel = null;\n${code}\n({ showBrowserMenu })`, context);
  const panel = api.showBrowserMenu(anchor);
  const entry = panel.querySelector('[data-testid="browser-cookie-import"]');
  assert.equal(entry.disabled, true);
  assert.match(entry.textContent, /macOS 전용/);
  assert.match(entry.getAttribute('title'), /macOS에서만/);
  assert.ok(panel.querySelector('[data-testid="browser-library-import"]'), 'native Firefox import remains available');
});

test('profile listing failures use a fixed actionable message and do not display raw reasons', async () => {
  for (const [reason, expected] of [['source-busy', /Chrome을 완전히 종료/],
    ['unsupported-schema', /Chrome 데이터 형식/], ['COOKIE_SECRET_DO_NOT_SHOW', /사용할 수 없습니다/]]) {
    const f = uiFixture();
    f.api.openBrowserCookieImport(f.card, f.opener, { isTrusted: true });
    f.part('browser-cookie-find').fire('click', { isTrusted: true });
    f.listed.resolve({ supported: false, profiles: [], reason });
    await tick();
    assert.match(f.part('browser-cookie-result').textContent, expected);
    assert.doesNotMatch(f.document.documentElement.textContent, /COOKIE_SECRET_DO_NOT_SHOW/);
    assert.equal(f.document.activeElement, f.part('browser-cookie-close'));
    assert.equal(f.events.filter(item => item[0] === 'import').length, 0);
  }
});

test('import failures surface actionable allowlisted causes without leaking raw details or suggesting login success', async () => {
  for (const [reason, expected] of [['source-busy', /Chrome을 완전히 종료/],
    ['keychain-permission-denied', /키체인 접근이 거부/],
    ['keychain-unavailable-or-denied', /키체인.*읽지 못했습니다/],
    ['unsupported-schema', /Chrome 데이터 형식/],
    ['COOKIE_SECRET_DO_NOT_SHOW', /사용할 수 없습니다/]]) {
    const f = uiFixture(); await choose(f);
    const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
    select.value = 'source-a'; select.fire('change', { isTrusted: true });
    consent.checked = true; consent.fire('change', { isTrusted: true });
    f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
    f.imported.resolve({ status: 'failed', reason, counts: { imported: 0, skipped: 0, unsupported: 0, failed: 1 },
      cookie: 'COOKIE_SECRET_DO_NOT_SHOW' });
    await tick();
    assert.match(f.part('browser-cookie-result').textContent, expected);
    assert.doesNotMatch(f.document.documentElement.textContent, /COOKIE_SECRET_DO_NOT_SHOW|로그인 상태를 확인하세요/);
    assert.equal(f.cards.length, 0);
    assert.equal(f.document.activeElement, f.part('browser-cookie-close'));
  }
});

test('only a cleanup-incomplete receipt adds the residual-environment warning', async () => {
  const f = uiFixture(); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  f.imported.resolve({ status: 'failed', reason: 'cleanup-incomplete', counts: { imported: 0, skipped: 0, unsupported: 0, failed: 1 } });
  await tick();
  assert.match(f.part('browser-cookie-result').textContent, /완료하지 못했습니다/);
  assert.match(f.document.documentElement.textContent, /정리되지 않은 분리 환경이 남았을 수 있습니다/);
  assert.doesNotMatch(f.document.documentElement.textContent, /cleanup-incomplete/);
});

test('the UI never overrides the Firefox container preference or policy', () => {
  const identityAndImport = section('  const BROWSER_IDENTITY_REGISTRY_PREF', '\n  // Firefox Library is a separate native window.');
  const dialog = section('  let browserCookieImportSession = null;', '\n  let browserLibrarySession = null;');
  assert.doesNotMatch(identityAndImport + dialog, /setBoolPref\s*\(/);
  assert.doesNotMatch(identityAndImport + dialog, /setStringPref\s*\(\s*['"]privacy\.userContext\.enabled/);
  assert.doesNotMatch(identityAndImport + dialog, /policies\s*\.[\w]+\s*=/);
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
  assert.equal(calls[0][1].scopeMode, 'preserve');
  assert.equal(Object.hasOwn(calls[0][1], 'explicitScopeCompatibilityConsent'), false);
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

test('standard-web compatibility is separately opted in and warns of port/scheme scope changes', async () => {
  const f = uiFixture(); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  const compatibility = f.part('browser-cookie-standard-web');
  assert.equal(compatibility.checked, false);
  assert.equal(compatibility.disabled, false);
  assert.match(f.document.documentElement.textContent, /실험적 포트·스킴 제한이 유지되지 않을 수 있습니다/);
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  compatibility.checked = true; compatibility.fire('change');
  assert.equal(compatibility.checked, false, 'a synthetic change cannot select the compatibility mode');
  compatibility.checked = true; compatibility.fire('change', { isTrusted: true });
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  const call = f.events.find(item => item[0] === 'import')[1];
  assert.equal(call.scopeMode, 'standard-web');
  assert.equal(call.explicitScopeCompatibilityConsent, true);
  f.imported.resolve({ status: 'cancelled', counts: { imported: 0, skipped: 0, unsupported: 0, failed: 0 } });
  await tick();
});

test('an older core without the scope capability keeps compatibility unavailable and uses preserve', async () => {
  const f = uiFixture({ scopeModes: null }); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  const compatibility = f.part('browser-cookie-standard-web');
  assert.equal(compatibility.disabled, true);
  assert.equal(compatibility.checked, false);
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  compatibility.checked = true; compatibility.fire('change', { isTrusted: true });
  assert.equal(compatibility.checked, false);
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  const call = f.events.find(item => item[0] === 'import')[1];
  assert.equal(call.scopeMode, 'preserve');
  assert.equal(Object.hasOwn(call, 'explicitScopeCompatibilityConsent'), false);
  f.imported.resolve({ status: 'cancelled', counts: { imported: 0, skipped: 0, unsupported: 0, failed: 0 } });
  await tick();
});

test('a compatibility capability revoked before confirmation prevents the import', async () => {
  const modes = ['preserve', 'standard-web'], f = uiFixture({ scopeModes: modes }); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  const compatibility = f.part('browser-cookie-standard-web');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  compatibility.checked = true; compatibility.fire('change', { isTrusted: true });
  modes.splice(1, 1);
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  assert.equal(f.events.filter(event => event[0] === 'import').length, 0);
  assert.match(f.part('browser-cookie-result').textContent, /호환성 모드를 사용할 수 없습니다/);
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
  assert.equal(f.notices.length, 1, 'the pending-import gate is the only transient notice');
  const receipt = f.part('browser-cookie-receipt');
  assert.ok(receipt);
  assert.match(receipt.textContent, /정리도 확인하지 못했습니다/);
  assert.doesNotMatch(receipt.textContent, /PRIVATE-COOKIE-DO-NOT-SHOW/);
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

test('a successfully registered environment can be retried without reimporting or changing its binding', async () => {
  const f = uiFixture({ spawnFailures: 1 }); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  f.containers.add(19);
  f.imported.resolve({ status: 'imported', userContextId: 19, containerName: 'Chrome - A',
    counts: { imported: 2, skipped: 0, unsupported: 0, failed: 0 } });
  await tick();
  assert.equal(f.getSpawnAttempts(), 1);
  assert.equal(f.cards.length, 0);
  assert.match(f.document.documentElement.textContent, /컨테이너 설정에서 해당 환경을 확인/);
  const registry = [...f.prefs.values()][0];
  f.part('browser-cookie-retry-open').fire('click');
  assert.equal(f.getSpawnAttempts(), 1, 'a synthetic retry is ignored');
  f.part('browser-cookie-retry-open').fire('click', { isTrusted: true });
  assert.equal(f.getSpawnAttempts(), 2);
  assert.equal(f.cards.length, 1);
  assert.equal(f.events.filter(event => event[0] === 'import').length, 1);
  assert.equal([...f.prefs.values()][0], registry, 'retry uses the same identity token');
  assert.equal(f.part('browser-cookie-receipt'), null);
});

test('a failed identity registration produces an explicit receipt instead of an unsafe retry or deletion', async () => {
  const f = uiFixture(); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  f.containers.add(19); f.setFailPrefs(true);
  f.imported.resolve({ status: 'imported', userContextId: 19, containerName: 'Chrome - A',
    counts: { imported: 2, skipped: 0, unsupported: 0, failed: 0 }, cookie: 'PRIVATE-COOKIE-DO-NOT-SHOW' });
  await tick();
  assert.equal(f.cards.length, 0);
  assert.equal(f.part('browser-cookie-retry-open'), null);
  f.part('browser-cookie-close').fire('click', { isTrusted: true });
  const receipt = f.part('browser-cookie-receipt');
  assert.ok(receipt);
  assert.match(receipt.textContent, /Chrome - A.*ID 19/);
  assert.match(receipt.textContent, /자동으로 삭제하지 않았습니다/);
  assert.doesNotMatch(receipt.textContent, /PRIVATE-COOKIE-DO-NOT-SHOW/);
  assert.ok(f.containers.has(19), 'an unverified context is never automatically removed');
  f.part('browser-cookie-receipt-close').fire('click', { isTrusted: true });
  assert.equal(f.part('browser-cookie-receipt'), null);
});

test('success arriving after its dialog and source close leaves a visible, nonsensitive receipt', async () => {
  const f = uiFixture(); await choose(f);
  const select = f.part('browser-cookie-profile'), consent = f.part('browser-cookie-consent');
  select.value = 'source-a'; select.fire('change', { isTrusted: true });
  consent.checked = true; consent.fire('change', { isTrusted: true });
  f.part('browser-cookie-confirm').fire('click', { isTrusted: true });
  f.card.remove(); f.api.closeBrowserCookieImportForCard(f.card);
  f.containers.add(20);
  f.imported.resolve({ status: 'partial', userContextId: 20, containerName: 'Chrome - A',
    counts: { imported: 3 }, cookie: 'PRIVATE-COOKIE-DO-NOT-SHOW' });
  await tick();
  const receipt = f.part('browser-cookie-receipt');
  assert.ok(receipt);
  assert.match(receipt.textContent, /Chrome - A.*ID 20/);
  assert.match(receipt.textContent, /가져온 쿠키: 3/);
  assert.doesNotMatch(receipt.textContent, /PRIVATE-COOKIE-DO-NOT-SHOW/);
  assert.equal(f.cards.length, 0);
  assert.notEqual(f.document.activeElement, f.opener);
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

test('native XUL is configured before append, create-only defers src, and an isolated failure never falls back to an iframe', () => {
  const code = section("    try {\n      xulBrowser = document.createXULElement('browser');", '\n    const agentTargetMarker');
  const run = ({ mismatch = false, fail = false, identity = { userContextId: 7 }, deferInitialLoad = false, requireDefaultContext = false,
    expectedOriginAttributes = null } = {}) => {
    const order = [], frame = { isConnected: false, browsingContext: null, attrs: {}, style: {},
      setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'src') order.push('src'); },
      getAttribute(key) { return this.attrs[key] ?? null; }, removeAttribute(key) { delete this.attrs[key]; }, remove() { this.isConnected = false; } };
    const context = { browserIdentity: identity, options: { deferInitialLoad, requireDefaultContext, expectedOriginAttributes }, normalizedUrl: 'about:blank',
      document: { createXULElement: () => frame }, browserIdentityModule: () => ({
        configureBrowser(browser, id) { order.push('configure'); return Identity.configureBrowser(browser, id); },
        browserUserContextId: Identity.browserUserContextId,
      }), ensureBrowserAgentActor() {}, wrap: { appendChild(browser) {
        order.push('append'); if (fail) throw new Error('synthetic failure');
        browser.isConnected = true; browser.browsingContext = { originAttributes: { userContextId: mismatch ? 0 : 7, privateBrowsingId: 0 } };
      } }, deskWindow: { requestClose: () => order.push('close') }, el: () => { order.push('iframe'); return {}; },
      console, TAG: '[test]' };
    const invoke = () => runInNewContext(`(() => { let xulBrowser = null; ${code}; return xulBrowser; })()`, context);
    return { order, frame, invoke };
  };
  const ok = run(); assert.equal(ok.invoke(), ok.frame);
  assert.deepEqual(ok.order, ['configure', 'append', 'src']);
  const createOnly = run({ deferInitialLoad: true }); assert.equal(createOnly.invoke(), createOnly.frame);
  assert.deepEqual(createOnly.order, ['configure', 'append'], 'create-only never initiates a navigation');
  for (const option of [{ mismatch: true }, { fail: true }]) {
    const broken = run(option);
    assert.throws(broken.invoke, /기본 환경으로 전환하지 않았습니다/);
    assert.equal(broken.order.includes('iframe'), false);
    assert.equal(broken.order.includes('close'), true);
  }
  const wrongDefault = run({ identity: null, requireDefaultContext: true });
  wrongDefault.frame.browsingContext = null;
  assert.throws(wrongDefault.invoke, /기본 환경으로 전환하지 않았습니다/);
  assert.equal(wrongDefault.order.includes('src'), false, 'the default context is verified before a load');
  assert.equal(wrongDefault.order.includes('iframe'), false);
  const wrongPopup = run({ identity: null, expectedOriginAttributes: { userContextId: 0, privateBrowsingId: 0 } });
  assert.throws(wrongPopup.invoke, /기본 환경으로 전환하지 않았습니다/);
  assert.equal(wrongPopup.order.includes('src'), false, 'the popup context is verified before a load');
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
  assert.equal(calls[0].options.expectedOriginAttributes.userContextId, 7);
  assert.equal(calls[0].options.expectedOriginAttributes.privateBrowsingId, 0);
  assert.equal(api.spawnBrowserPopup(null, null), null);
  assert.equal(api.spawnBrowserPopup(null, { ...openWindowInfo, originAttributes: { userContextId: 0, privateBrowsingId: 0 } }), null);
  assert.equal(api.spawnBrowserPopup(null, openWindowInfo, { openerBrowser: {}, isPrivate: false }), null);
  f.card.remove();
  assert.equal(api.spawnBrowserPopup(null, openWindowInfo), null);
  assert.equal(calls.length, 1);
  assert.equal(notices.length, 4);
});

test('create-only popup calls never load src and openURI uses the verified opener context', () => {
  const f = uiFixture(); f.containers.add(7);
  const identity = f.api.registerImportedBrowserIdentity(7, 'Chrome · 원본');
  f.card._browserIdentity = identity; f.browser.setAttribute('usercontextid', '7');
  f.browser.browsingContext.originAttributes.userContextId = 7;
  const calls = [], info = { parent: { top: f.browser.browsingContext }, originAttributes: { userContextId: 7, privateBrowsingId: 0 } };
  const window = {}, createdContext = { id: 'new-context' };
  const context = { window, document: { querySelectorAll: () => [f.card] }, console: { warn() {}, error() {} }, TAG: 'test',
    ChromeUtils: { generateQI: () => () => {} }, browserIdentityModule: () => Identity, browserIdentityUsable: f.api.browserIdentityUsable,
    boardNotice() {}, spawnBrowserCard(url, options) { calls.push({ url, options }); return { _xulBrowser: { browsingContext: createdContext } }; } };
  const code = section('  function browserPopupSource(', '\n  // ============ Firefox chrome 정리');
  runInNewContext(`${code}\ninstallPopupCapture();`, context);
  const uri = { spec: 'https://example.test/popup' };
  assert.equal(window.browserDOMWindow.createContentWindow(uri, info, 0, 0, null, null), createdContext);
  assert.equal(calls[0].url, 'about:blank'); assert.equal(calls[0].options.deferInitialLoad, true);
  assert.equal(calls[0].options.browserIdentity, identity);
  const params = { openWindowInfo: info, openerBrowser: f.browser, isPrivate: false };
  assert.equal(window.browserDOMWindow.createContentWindowInFrame(uri, params, 0, 0, '').browsingContext, createdContext);
  assert.equal(calls[1].url, 'about:blank'); assert.equal(calls[1].options.deferInitialLoad, true);
  assert.equal(window.browserDOMWindow.openURI(uri, info, 0, 0, null, null), createdContext);
  assert.equal(calls[2].url, uri.spec); assert.equal(calls[2].options.deferInitialLoad, undefined);
  assert.equal(window.browserDOMWindow.openURIInFrame(uri, params, 0, 0, '').browsingContext, createdContext);
  assert.equal(calls[3].url, uri.spec); assert.equal(calls[3].options.deferInitialLoad, undefined);
});

test('only an explicit external default-context HTTP request may open without an opener', () => {
  const calls = [], notices = [];
  let isPrivate = false;
  const attrs = { userContextId: 0, privateBrowsingId: 0 };
  const principal = { isSystemPrincipal: true, originAttributes: attrs };
  const constants = { OPEN_DEFAULTWINDOW: 0, OPEN_EXTERNAL: 1, OPEN_NO_OPENER: 4, OPEN_NO_REFERRER: 8 };
  const context = { document: { querySelectorAll: () => [] }, window: {}, Ci: { nsIBrowserDOMWindow: constants }, URL,
    ChromeUtils: { importESModule: () => ({ PrivateBrowsingUtils: { isWindowPrivate: () => isPrivate } }) },
    boardNotice: message => notices.push(message), spawnBrowserCard: (url, options) => { calls.push({ url, options }); return {}; } };
  const api = runInNewContext(`${section('  function browserPopupSource(', '\n  function installPopupCapture()')}\n({ spawnBrowserPopup })`, context);
  const uri = { spec: 'https://example.test/' }, externalRequest = { where: 0, flags: 1, principal, csp: null };
  assert.ok(api.spawnBrowserPopup(uri, null, null, { externalRequest }));
  assert.equal(calls[0].options.requireDefaultContext, true);
  assert.equal(calls[0].options.requireNativeBrowser, true);
  const denied = [
    [uri, null, { ...externalRequest, flags: 0 }],
    [uri, null, { ...externalRequest, where: 3 }],
    [uri, null, { ...externalRequest, flags: 17 }],
    [uri, null, { ...externalRequest, principal: { ...principal, originAttributes: { ...attrs, userContextId: 7 } } }],
    [uri, null, { ...externalRequest, principal: { ...principal, originAttributes: { ...attrs, partitionKey: '(https,example.test)' } } }],
    [uri, { originAttributes: { userContextId: 7, privateBrowsingId: 0 } }, externalRequest],
    [{ spec: 'javascript:alert(1)' }, null, externalRequest],
    [{ spec: 'https://user:pass@example.test/' }, null, externalRequest],
  ];
  for (const [url, info, request] of denied) assert.equal(api.spawnBrowserPopup(url, info, null, { externalRequest: request }), null);
  isPrivate = true;
  assert.equal(api.spawnBrowserPopup(uri, null, null, { externalRequest }), null);
  assert.equal(calls.length, 1);
  assert.equal(notices.length, denied.length + 1);
});

test('source keys retain the old format and separate only valid Browser environments', () => {
  const code = section('  function sourceRefKey(', '\n  function singletonSourceRef(');
  const context = { state: { agenda: { activeAgendaId: 'agenda' }, sourceRefs: { defaultProfileId: 'default' } },
    normalizeSourcePart: value => encodeURIComponent(String(value ?? '').trim()), normalizeBrowserUri: url => url.split('#')[0] };
  const api = runInNewContext(`${code}\n({ sourceRefKey, browserSourceRef })`, context);
  const url = 'https://example.test/page#one';
  const ordinary = api.browserSourceRef(url);
  const keyA = '00000000-0000-4000-8000-000000000001';
  const keyB = '00000000-0000-4000-8000-000000000002';
  const a = api.browserSourceRef(url, { browserIdentityRequired: true, browserIdentityKey: keyA });
  const b = api.browserSourceRef(url, { browserIdentityRequired: true, browserIdentityKey: keyB });
  assert.equal(api.sourceRefKey(ordinary), 'browser-url|browser-content|default||https%3A%2F%2Fexample.test%2Fpage');
  assert.equal(api.sourceRefKey({ kind: 'file', scope: 'work', path: '/tmp/a.txt' }), 'file|work|||%2Ftmp%2Fa.txt');
  assert.equal(api.sourceRefKey({ kind: 'chat', scope: 'codex', id: 'thread-a' }), 'chat|codex|||thread-a');
  assert.equal(api.sourceRefKey({ kind: 'file', scope: 'work', path: '/tmp/a.txt', browserIdentityKey: keyA }), 'file|work|||%2Ftmp%2Fa.txt');
  assert.notEqual(api.sourceRefKey(ordinary), api.sourceRefKey(a));
  assert.notEqual(api.sourceRefKey(a), api.sourceRefKey(b));
  assert.equal(api.sourceRefKey(a), api.sourceRefKey(api.browserSourceRef('https://example.test/page#two',
    { browserIdentityRequired: true, browserIdentityKey: keyA })));
  assert.equal(api.sourceRefKey(api.browserSourceRef(url, { browserIdentityRequired: true, browserIdentityKey: 'invalid' })), '',
    'an invalid required identity cannot deduplicate to the default Browser');
  assert.equal(api.sourceRefKey(api.browserSourceRef(url, { browserIdentityKey: 'invalid' })), '',
    'an invalid explicit identity cannot deduplicate to the default Browser even without the marker');
  assert.equal(api.sourceRefKey(api.browserSourceRef(url, { browserIdentityRequired: true })), '',
    'a portable rebind marker cannot deduplicate to the default Browser');
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
