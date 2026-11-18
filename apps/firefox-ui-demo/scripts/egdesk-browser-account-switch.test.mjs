import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as AccountContext from '../overlay/resources/EGDeskBrowserAccountContext.sys.mjs';
import * as Identity from '../overlay/resources/EGDeskBrowserIdentity.sys.mjs';

// Synthetic services and cards only: no Firefox, container, login or network.
const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing section: ${start}`);
  return source.slice(a, b);
};
const BRW02 = section('  // BRW-02: per-card account context and the remembered', '  function browserCookieImportSourceAllowed(');
const SCOPE = '11111111-2222-4333-8444-555555555555';
const KEY7 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function harness({ windowGlobal = { hasBeforeUnload: false, hasUserInteraction: false }, confirm = true,
  spawnThrows = false, remapOk = true, containers = null, registryEntries = { 7: KEY7 }, sitePref = '' } = {}) {
  const log = { spawned: [], closed: [], notices: [], confirms: [], revoked: [], dirty: [], registered: [], bound: [], prefWrites: [] };
  const prefs = new Map([[AccountContext.SITE_DEFAULTS_PREF, sitePref]]);
  const services = {
    prefs: {
      getStringPref: (name, fallback) => prefs.get(name) ?? fallback,
      setStringPref: (name, value) => { log.prefWrites.push(name); prefs.set(name, value); },
      getBoolPref: () => true,
    },
    eTLD: { getBaseDomainFromHost: host => host.split('.').slice(-2).join('.') },
  };
  const identityService = {
    getPublicIdentities: () => (containers ?? [{ userContextId: 7, public: true, name: 'Chrome · 업무' },
      { userContextId: 9, public: true, name: '개인' }]),
    create() {},
  };
  const browserFor = id => ({
    getAttribute: name => (name === 'usercontextid' && id ? String(id) : null),
    browsingContext: { originAttributes: { userContextId: id }, currentWindowGlobal: windowGlobal },
  });
  const card = { id: 'egd-browser-card-1', style: {}, dataset: {}, _xulBrowser: browserFor(0),
    _browserState: { uri: 'https://mail.example.com/inbox' } };
  const member = { sourceId: 'm1', viewId: card.id };
  const projection = { id: 'p1', boardId: 'b1', members: [member] };
  const ctx = {
    console, Object, Array, Map, Set, JSON, String, Math, Error, Number,
    ChromeUtils: { importESModule: uri => {
      if (uri.endsWith('EGDeskBrowserAccountContext.sys.mjs')) return AccountContext;
      if (uri.endsWith('EGDeskBrowserIdentity.sys.mjs')) return Identity;
      throw new Error(uri);
    } },
    servicesRef: () => services,
    browserIdentityModule: () => ({ ...Identity, resolveContextualIdentityService: () => identityService,
      createBrowserIdentityAdapter: () => Identity.createBrowserIdentityAdapter({ identityService, services }) }),
    browserIdentityRegistry: () => ({ version: 1, profileScopeId: SCOPE, entries: { ...registryEntries } }),
    browserIdentityUsable: identity => identity.profileScopeId === SCOPE && registryEntries[identity.userContextId] === identity.browserIdentityKey,
    registerImportedBrowserIdentity: (userContextId, name) => {
      log.registered.push(userContextId);
      const key = 'cccccccc-dddd-4eee-8fff-000000000000';
      registryEntries[userContextId] = key;
      return { version: 1, userContextId, profileScopeId: SCOPE, browserIdentityKey: key, containerName: name };
    },
    boardNotice: message => log.notices.push(message),
    window: { confirm: message => { log.confirms.push(message); return confirm; }, setTimeout() {}, addEventListener() {}, removeEventListener() {} },
    state: { boards: { projections: { p1: projection } } },
    isCardFullscreen: () => false,
    exitCardFullscreen() {},
    persistentEntityGeometry: () => ({ x: 120, y: -40, width: 900, height: 600, zIndex: 14 }),
    spawnBrowserCard: (url, options) => {
      if (spawnThrows) throw new Error('no');
      log.spawned.push({ url, options });
      return { id: 'egd-browser-card-2', style: {}, dataset: {} };
    },
    remapRestoredBoardMember: (proj, item, nextId) => { if (!remapOk) return false; item.viewId = nextId; return true; },
    bindViewToBoard: (view, proj, item) => log.bound.push([view.id, proj.id, item.sourceId]),
    syncDeskWindowBoardMetadata() {},
    revokeBrowserToolGrants: query => log.revoked.push(query),
    closeCanvasCard: view => { log.closed.push(view.id); return true; },
    markAgendaDirty: reason => log.dirty.push(reason),
    setActiveEntity() {},
  };
  runInNewContext(`${BRW02}\nglobalThis.api = { switchBrowserCardAccount, browserSiteDefaultIdentity,
    setBrowserSiteDefaultForCard, browserAccountPicker };`, ctx);
  return { api: ctx.api, log, card, member, prefs };
}

test('switching account reopens the same URL at the same frame and moves the Board link', () => {
  const { api, log, card, member } = harness();
  const next = api.switchBrowserCardAccount(card, { userContextId: 7, label: 'Chrome · 업무' });
  assert.equal(next.id, 'egd-browser-card-2');
  assert.equal(log.spawned.length, 1);
  assert.equal(log.spawned[0].url, 'https://mail.example.com/inbox');
  assert.deepEqual({ ...log.spawned[0].options.placement }, { x: 120, y: -40, width: 900, height: 600 });
  assert.equal(log.spawned[0].options.browserIdentity.browserIdentityKey, KEY7);
  assert.equal(next.style.zIndex, '14');
  assert.equal(member.viewId, 'egd-browser-card-2');
  assert.deepEqual(log.bound, [['egd-browser-card-2', 'p1', 'm1']]);
  assert.deepEqual(log.revoked.map(query => ({ ...query })), [{ cardId: card.id }]);
  assert.deepEqual(log.closed, [card.id]);
  assert.equal(log.confirms.length, 1);
  assert.match(log.confirms[0], /입력한 내용이 있다면/);
  assert.deepEqual(log.dirty, ['switch-browser-account']);
});

test('switching back to the default context passes no identity', () => {
  const { api, log, card } = harness();
  card._xulBrowser.getAttribute = name => (name === 'usercontextid' ? '7' : null);
  card._xulBrowser.browsingContext.originAttributes.userContextId = 7;
  api.switchBrowserCardAccount(card, { userContextId: 0, label: '기본 환경' });
  assert.equal(Object.hasOwn(log.spawned[0].options, 'browserIdentity'), false);
});

test('declining preserves the original account and prefs even with uncommitted composition and no interaction flag', () => {
  const sitePref = JSON.stringify({ version: 1, profileScopeId: SCOPE,
    sites: { 'example.com': { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY7 } } } });
  const { api, log, card, member, prefs } = harness({ confirm: false, sitePref });
  card._xulBrowser.getAttribute = name => (name === 'usercontextid' ? '7' : null);
  card._xulBrowser.browsingContext.originAttributes.userContextId = 7;
  const identity = card._browserIdentity = { userContextId: 7, browserIdentityKey: KEY7 };
  const browser = card._xulBrowser;

  // The mock page receives compositionstart without a matching compositionend.
  // Its parent WindowGlobal metadata is still false; the guard must not read content.
  const pageInput = new EventTarget();
  let composing = false;
  let contentReads = 0;
  pageInput.addEventListener('compositionstart', () => { composing = true; });
  pageInput.addEventListener('compositionend', () => { composing = false; });
  pageInput.dispatchEvent(new Event('compositionstart'));
  Object.defineProperty(browser, 'contentDocument', { get: () => { contentReads++; throw new Error('remote content'); } });

  assert.equal(api.switchBrowserCardAccount(card, { userContextId: 9, label: '개인' }), null);
  assert.equal(log.confirms.length, 1);
  assert.match(log.confirms[0], /입력한 내용이 있다면/);
  for (const action of ['spawned', 'closed', 'registered', 'revoked', 'dirty', 'bound', 'prefWrites']) {
    assert.deepEqual(log[action], [], `unexpected ${action}`);
  }
  assert.equal(contentReads, 0);
  assert.equal(composing, true);
  assert.equal(card._xulBrowser, browser);
  assert.equal(Identity.browserUserContextId(browser), 7);
  assert.equal(card._browserIdentity, identity);
  assert.equal(card._closeApproved, undefined);
  assert.equal(member.viewId, card.id);
  assert.equal(prefs.get(AccountContext.SITE_DEFAULTS_PREF), sitePref);
});

test('missing, ambiguous, or unreadable Gecko signals still require confirmation', () => {
  for (const windowGlobal of [null, {}, { hasBeforeUnload: true, hasUserInteraction: true },
    { get hasUserInteraction() { throw new Error('unavailable'); } }]) {
    const { api, log, card } = harness({ windowGlobal, confirm: false });
    assert.equal(api.switchBrowserCardAccount(card, { userContextId: 7, label: 'x' }), null);
    assert.equal(log.confirms.length, 1);
    assert.deepEqual(log.spawned, []);
    assert.deepEqual(log.closed, []);
  }
});

test('failures keep the original card: spawn error, Board remap failure, Engine sign-in', () => {
  let h = harness({ spawnThrows: true });
  assert.equal(h.api.switchBrowserCardAccount(h.card, { userContextId: 7, label: 'x' }), null);
  assert.deepEqual(h.log.closed, []);
  assert.match(h.log.notices[0], /원래 Browser를 유지/);
  h = harness({ remapOk: false });
  assert.equal(h.api.switchBrowserCardAccount(h.card, { userContextId: 7, label: 'x' }), null);
  assert.deepEqual(h.log.closed, ['egd-browser-card-2']);
  assert.match(h.log.notices[0], /Board 연결/);
  h = harness();
  h.card.dataset.codexRole = 'auth';
  assert.equal(h.api.switchBrowserCardAccount(h.card, { userContextId: 7, label: 'x' }), null);
  assert.equal(h.log.spawned.length, 0);
  assert.deepEqual(h.log.confirms, []);
});

test('picking the current context does not prompt, reopen, or write preferences', () => {
  const { api, log, card } = harness({ windowGlobal: null, confirm: false });
  assert.equal(api.switchBrowserCardAccount(card, { userContextId: 0, label: '기본 환경' }), card);
  for (const effects of Object.values(log)) assert.deepEqual(effects, []);
});

test('an unregistered container is registered only on an explicit pick', () => {
  const { api, log, card } = harness();
  const model = api.browserAccountPicker(card);
  assert.equal(model.summary, '계정: 기본 환경');
  assert.deepEqual(model.items.map(item => item.label), ['기본 환경', 'Chrome · 업무', '개인']);
  assert.deepEqual(log.registered, []);
  api.switchBrowserCardAccount(card, model.items[2]);
  assert.deepEqual(log.registered, [9]);
});

test('remembered site default: stored as domain and opaque key only, applied on open, cleared to ask', () => {
  const { api, log, card, prefs } = harness();
  card._xulBrowser.getAttribute = name => (name === 'usercontextid' ? '7' : null);
  card._xulBrowser.browsingContext.originAttributes.userContextId = 7;
  card._browserIdentity = { userContextId: 7, browserIdentityKey: KEY7 };
  assert.equal(api.setBrowserSiteDefaultForCard(card, true), true);
  const stored = JSON.parse(prefs.get(AccountContext.SITE_DEFAULTS_PREF));
  assert.deepEqual(stored, { version: 1, profileScopeId: SCOPE,
    sites: { 'example.com': { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY7 } } } });
  assert.doesNotMatch(prefs.get(AccountContext.SITE_DEFAULTS_PREF), /cookie|password|token/i);
  assert.equal(api.browserAccountPicker(card).remember.checked, true);
  const identity = api.browserSiteDefaultIdentity('https://docs.example.com/x');
  assert.equal(identity.userContextId, 7);
  assert.equal(identity.browserIdentityKey, KEY7);
  assert.equal(api.browserSiteDefaultIdentity('https://other.org/'), null);
  assert.equal(api.setBrowserSiteDefaultForCard(card, false), true);
  assert.deepEqual(JSON.parse(prefs.get(AccountContext.SITE_DEFAULTS_PREF)).sites, {});
  assert.equal(api.browserSiteDefaultIdentity('https://docs.example.com/x'), null);
  assert.equal(log.notices.length, 2);
});

test('a remembered container that is gone opens in the default context with a notice', () => {
  const sitePref = JSON.stringify({ version: 1, profileScopeId: SCOPE,
    sites: { 'example.com': { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY7 } } } });
  const { api, log } = harness({ sitePref, containers: [{ userContextId: 9, public: true, name: '개인' }] });
  assert.equal(api.browserSiteDefaultIdentity('https://example.com/'), null);
  assert.match(log.notices[0], /기억한 계정 환경을 찾지 못해 기본 환경/);
});

test('site defaults apply only to user-initiated opens; popups and restores keep their context', () => {
  const spawn = section('  function spawnBrowserCard(', '    const sourceForBrowser =');
  assert.match(spawn, /options\.applySiteDefault === true \? browserSiteDefaultIdentity\(normalizedUrl\) : null/);
  assert.match(source, /options\.placement \? \{ \.\.\.options\.placement, inView: true \}/);
  const callers = source.match(/spawnBrowserCard\([^;]*applySiteDefault: true/g) || [];
  assert.equal(callers.length, 4);
  assert.doesNotMatch(section('    const opened = spawnBrowserCard(request.url', ';'), /applySiteDefault/);
  assert.match(source, /testid: 'browser-account' \}\)\] : \[\]\)/);
});
