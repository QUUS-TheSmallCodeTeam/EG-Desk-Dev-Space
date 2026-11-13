import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as SurfaceState from '../overlay/resources/EGDeskSurfaceState.sys.mjs';

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing source section: ${start}`);
  return source.slice(first, last);
};

function fixture() {
  const events = [], notices = [], listeners = new Map();
  const commands = Object.fromEntries(['Browser:OpenFile', 'OrganizerCommand_import', 'OrganizerCommand_export'].map(id => {
    const guards = new Set();
    const command = {
      id, guards,
      addEventListener(name, listener, capture) {
        assert.equal(name, 'command'); assert.equal(capture, true); guards.add(listener);
      },
      removeEventListener(name, listener, capture) {
        assert.equal(name, 'command'); assert.equal(capture, true); guards.delete(listener);
      },
      dispatch() {
        let prevented = false, stopped = false;
        const event = { target: command, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } };
        for (const guard of guards) { guard(event); if (stopped) break; }
        if (!stopped) events.push(['native-command', id]);
        return { prevented, stopped };
      },
    };
    return [id, command];
  }));
  const originalOpen = (...args) => { events.push(['native-open', ...args]); return 'native'; };
  const originalPrefs = (...args) => { events.push(['native-prefs', ...args]); return 'native-prefs'; };
  const places = {
    loadBookmarksInTabs: true,
    openTabset(items, event, owner) { events.push(['native-tabset', items, event, owner]); },
    openMultipleLinksInTabs(items, event, view) { return this.openTabset(items, event, view.ownerWindow); },
    openNodeWithEvent() { events.push(['native-node']); },
    checkURLSecurity(node) { events.push(['native-security', node.uri]); return node.safe !== false; },
    _openNodeIn(node, where, owner) {
      if (!this.checkURLSecurity(node, owner)) return;
      events.push(['native-node-in', where]);
      return owner.openTrustedLinkIn(node.uri, where, node.params || {});
    },
    markPageAsFollowedBookmark(uri) { events.push(['bookmark-mark', uri]); },
    markPageAsTyped(uri) { events.push(['history-mark', uri]); },
  };
  const library = {
    openTrustedLinkIn: originalOpen, openPreferences: originalPrefs, PlacesUIUtils: places,
    BrowserUtils: {
      whereToOpenLink(event) { return event?.where || 'current'; },
      willLoadInBackground(where, params = {}) {
        if (!['tab', 'tabshifted'].includes(where)) return false;
        const background = params.inBackground ?? (params.forceForeground ? false : backgroundPref);
        return where === 'tabshifted' ? !background : background;
      },
    },
    PlacesUtils: { nodeIsBookmark: node => node?.isBookmark === true },
    document: { documentURI: 'chrome://browser/content/places/places.xhtml', readyState: 'complete',
      getElementById: id => commands[id] || null },
    PlacesOrganizer: { selectLeftPaneContainerByHierarchy(section) { events.push(['select', section]); } },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    focus() { events.push(['library-focus']); },
    close() { this.closed = true; events.push(['library-close']); },
    closed: false,
  };
  const sourceCard = { id: 'source', isConnected: true, dataset: {}, _browserState: { uri: 'https://example.test/current' }, _xulBrowser: {
    browsingContext: { originAttributes: { userContextId: 0, privateBrowsingId: 0 } },
    currentURI: { spec: 'https://example.test/current' }, getAttribute: () => 'https://example.test/current',
  } };
  let policy = true, privateWindow = false, backgroundPref = false, currentLibrary = null, nextLibrary = library;
  const migration = {
    MIGRATION_ENTRYPOINTS: { PLACES: 'places' },
    showMigrationWizard(...args) { events.push(['migration', ...args]); return Promise.resolve(); },
  };
  const window = {
    openDialog(...args) { events.push(['dialog', ...args]); currentLibrary = nextLibrary; return nextLibrary; },
    focus() { events.push(['main-focus']); },
    addEventListener(name, fn) { listeners.set(`main-${name}`, fn); },
  };
  const services = {
    policies: { isAllowed(name) { events.push(['policy', name]); return policy; } },
    wm: { getMostRecentWindow(name) { events.push(['window-lookup', name]); return currentLibrary; } },
  };
  const context = {
    URL, console: { warn() {} }, TAG: '[fixture]', window,
    servicesRef: () => services,
    boardNotice: message => notices.push(message),
    ChromeUtils: { importESModule(uri) {
      if (uri === 'resource://gre/modules/PrivateBrowsingUtils.sys.mjs') {
        return { PrivateBrowsingUtils: { isWindowPrivate: () => privateWindow } };
      }
      if (uri === 'resource:///modules/MigrationUtils.sys.mjs') return { MigrationUtils: migration };
      throw new Error(`unexpected import: ${uri}`);
    } },
    state: { cardFullscreen: null },
    exitCardFullscreen: (...args) => events.push(['exit-fullscreen', ...args]),
    focusCanvasCard: card => events.push(['focus-card', card.id]),
    revealOpenCanvasCard: (card, options) => events.push(['camera-reveal', card.id, options.kind]),
    browserCardControl(card, action, url) { events.push(['navigate', card.id, action, url]); return { uri: url }; },
    spawnBrowserCard(url, options) {
      const card = { id: `new-${events.length}`, isConnected: true, _xulBrowser: {} };
      events.push(['spawn', url, options.background, card]);
      return card;
    },
  };
  const code = section('  function browserLibraryCanRoute(', '\n  function spawnBrowserCard(');
  const api = runInNewContext(`${code}\n({ browserLibraryCanRoute, createBrowserLibraryRouting, browserLibraryContextAllowed, browserLibraryCardIsEmpty,
    browserImportAllowed, openFirefoxBrowserImport, openFirefoxBrowserLibrary })`, context);
  return { api, context, events, notices, listeners, commands, library, places, originalOpen, originalPrefs, sourceCard,
    setPolicy(value) { policy = value; }, setPrivate(value) { privateWindow = value; },
    setBackgroundPref(value) { backgroundPref = value; },
    setCurrentLibrary(value) { currentLibrary = value; }, setNextLibrary(value) { nextLibrary = value; } };
}

function attach(f, overrides = {}) {
  return f.api.createBrowserLibraryRouting({
    library: f.library, opener: f.sourceCard,
    contextAllowed: card => card?.isConnected === true,
    cardIsEmpty: () => false,
    navigateCard(card, url) { f.events.push(['navigate', card.id, url]); return card; },
    openCard(url, options) {
      const card = { id: `new-${f.events.length}`, _xulBrowser: { id: 'browser' } };
      f.events.push(['open-card', url, options.background, card]); return card;
    },
    revealCard(card) { f.events.push(['reveal', card.id]); },
    showImport() { f.events.push(['show-import']); return true; },
    showIssue(message) { f.notices.push(message); },
    ...overrides,
  });
}

test('navigable URLs retain fragments while source identity remains fragment-free', () => {
  const code = section('  function normalizeBrowserUri(', '\n  function browserDisplayHost(');
  const { normalizeBrowserUri, normalizeBrowserNavigationUri } = runInNewContext(
    `${code}\n({ normalizeBrowserUri, normalizeBrowserNavigationUri })`, { URL });
  assert.equal(normalizeBrowserNavigationUri('https://Example.test:443/path?q=1#section'), 'https://example.test/path?q=1#section');
  assert.equal(normalizeBrowserUri('https://Example.test:443/path?q=1#section'), 'https://example.test/path?q=1');
  assert.equal(normalizeBrowserNavigationUri('about:blank#one'), 'about:blank#one');
  assert.equal(normalizeBrowserNavigationUri('example.test/#fragment'), 'https://example.test/#fragment');
});

test('Library routing fails closed for unsupported URLs, principals, contexts, and new windows', () => {
  const { api } = fixture();
  assert.equal(api.browserLibraryCanRoute('https://example.test/p#section', 'current', {}), true);
  assert.equal(api.browserLibraryCanRoute('http://127.0.0.1:1234/p', 'tab', { userContextId: 0 }), true);
  for (const [url, where, params] of [
    ['javascript:alert(1)', 'current', {}], ['file:///tmp/a', 'current', {}],
    ['about:config', 'current', {}], ['data:text/html,x', 'current', {}],
    ['https://example.test/line\nbreak', 'current', {}], [`https://example.test/${'x'.repeat(2048)}`, 'current', {}],
    ['https://user:pass@example.test/', 'current', {}], ['https://example.test/', 'window', {}],
    ['https://example.test/', 'tab', { private: true }], ['https://example.test/', 'tab', { userContextId: 4 }],
    ['https://example.test/', 'tab', { triggeringPrincipal: { isSystemPrincipal: true } }],
    ['https://example.test/', 'tab', { referrerInfo: {} }], ['https://example.test/', 'tab', { postData: {} }],
    ['https://example.test/', 'tab', { allowInheritPrincipal: true }], ['https://example.test/', 'tab', null],
  ]) assert.equal(api.browserLibraryCanRoute(url, where, params), false, `${url} ${where}`);
});

test('only the owning Library routes single opens; background and Firefox callbacks are preserved', () => {
  const f = fixture(), originalTabset = f.places.openTabset, session = attach(f);
  const foreign = { openTrustedLinkIn: f.originalOpen, PlacesUIUtils: f.places };
  assert.notEqual(f.places.openTabset, originalTabset, 'the shared function has a scoped Library guard');
  f.library.openTrustedLinkIn('https://example.test/one#frag', 'current', {});
  assert.deepEqual(f.events.slice(0, 2), [['navigate', 'source', 'https://example.test/one#frag'], ['reveal', 'source']]);
  let callbackBrowser;
  f.library.openTrustedLinkIn('https://example.test/two', 'tab', {
    inBackground: true, resolveOnContentBrowserCreated(browser) { callbackBrowser = browser; },
  });
  assert.equal(f.events[2][0], 'open-card');
  assert.equal(f.events[2][2], true);
  assert.equal(callbackBrowser, f.events[2][3]._xulBrowser);
  assert.equal(f.events.filter(event => event[0] === 'reveal').length, 1);
  foreign.openTrustedLinkIn('https://example.test/elsewhere', 'tab', {});
  assert.equal(f.events.at(-1)[0], 'native-open');
  const replacement = { id: 'next', isConnected: true, _xulBrowser: {} };
  session.setOpener(replacement);
  f.library.openTrustedLinkIn('https://example.test/next', 'current', {});
  assert.equal(f.events.at(-2)[1], 'next');
  session.dispose();
  assert.equal(f.library.openTrustedLinkIn, f.originalOpen);
  assert.equal(f.library.openPreferences, f.originalPrefs);
  assert.equal(f.library.PlacesUIUtils, f.places);
  assert.equal(f.places.openTabset, originalTabset);
  assert.equal(f.listeners.has('unload'), false);
});

test('one native Library transfers A to B to A without nested wrappers or stale restoration', () => {
  const f = fixture();
  const aCard = { id: 'A', isConnected: true, _xulBrowser: {} };
  const bCard = { id: 'B', isConnected: true, _xulBrowser: {} };
  const firstA = attach(f, { opener: aCard });
  const secondB = attach(f, { opener: bCard });
  assert.equal(firstA.isActive(), false);
  f.library.openTrustedLinkIn('https://example.test/b', 'current', {});
  assert.equal(f.events.find(event => event[0] === 'navigate')[1], 'B');
  const lastA = attach(f, { opener: aCard });
  assert.equal(secondB.isActive(), false);
  f.library.openTrustedLinkIn('https://example.test/a', 'current', {});
  assert.equal(f.events.filter(event => event[0] === 'navigate').at(-1)[1], 'A');
  secondB.dispose();
  firstA.dispose();
  assert.equal(lastA.isInstalled(), true, 'disposing superseded owners cannot restore their wrappers');
  lastA.dispose();
  assert.equal(f.library.openTrustedLinkIn, f.originalOpen);
  assert.equal(f.library.openPreferences, f.originalPrefs);
  assert.equal(f.library.PlacesUIUtils, f.places);

  const againA = attach(f, { opener: aCard });
  const againB = attach(f, { opener: bCard });
  againB.dispose();
  againA.dispose();
  assert.equal(f.library.openTrustedLinkIn, f.originalOpen, 'reverse disposal order also restores the genuine native original');
});

test('independent Desk globals re-own one Library and their unloads cannot resurrect stale routing', () => {
  const a = fixture(), b = fixture(), library = a.library;
  a.sourceCard.id = 'desk-A';
  b.sourceCard.id = 'desk-B';
  a.setCurrentLibrary(library);
  b.setCurrentLibrary(library);
  assert.equal(a.api.openFirefoxBrowserLibrary('AllBookmarks', a.sourceCard), true);
  assert.equal(b.api.openFirefoxBrowserLibrary('History', b.sourceCard), true);
  library.openTrustedLinkIn('https://example.test/b', 'current', {});
  assert.equal(b.events.find(event => event[0] === 'navigate')[1], 'desk-B');
  assert.equal(a.api.openFirefoxBrowserLibrary('AllBookmarks', a.sourceCard), true);
  library.openTrustedLinkIn('https://example.test/a', 'current', {});
  assert.equal(a.events.filter(event => event[0] === 'navigate').at(-1)[1], 'desk-A');
  b.listeners.get('main-unload')();
  library.openTrustedLinkIn('https://example.test/still-a', 'current', {});
  assert.equal(a.events.filter(event => event[0] === 'navigate').at(-1)[1], 'desk-A');
  a.listeners.get('main-unload')();
  assert.equal(library.openTrustedLinkIn, a.originalOpen);
  assert.equal(library.openPreferences, a.originalPrefs);
  assert.equal(library.PlacesUIUtils, a.places);
});

test('distinct Library windows sharing Places cannot nest wrappers or lose native restoration', () => {
  const a = fixture(), b = fixture();
  b.library.PlacesUIUtils = a.places;
  const originalNode = a.places.openNodeWithEvent, originalTabset = a.places.openTabset;
  const first = attach(a);
  const installedNode = a.places.openNodeWithEvent, installedTabset = a.places.openTabset;

  assert.throws(() => attach(b), /already owned by another Library/);
  assert.equal(first.isInstalled(), true, 'the first Library keeps its working controller');
  assert.equal(a.places.openNodeWithEvent, installedNode);
  assert.equal(a.places.openTabset, installedTabset);
  assert.equal(b.library.openTrustedLinkIn, b.originalOpen);
  assert.equal(b.commands['Browser:OpenFile'].guards.size, 0);
  a.places.openNodeWithEvent({ uri: 'https://example.test/a', isBookmark: false },
    { target: { documentGlobal: a.library }, where: 'current' });
  assert.ok(a.events.some(event => event[0] === 'navigate' && event[1] === 'source'));
  a.places.openNodeWithEvent({ uri: 'https://example.test/other' }, { target: { documentGlobal: b.library } });
  assert.equal(a.events.at(-1)[0], 'native-node', 'unowned windows still reach native Places');

  first.dispose();
  assert.equal(a.places.openNodeWithEvent, originalNode);
  assert.equal(a.places.openTabset, originalTabset);
  const second = attach(b);
  assert.equal(second.isInstalled(), true, 'the second Library may install after clean release');
  second.dispose();
  assert.equal(a.places.openNodeWithEvent, originalNode);
  assert.equal(a.places.openTabset, originalTabset);
  assert.equal(a.library.openTrustedLinkIn, a.originalOpen);
  assert.equal(b.library.openTrustedLinkIn, b.originalOpen);
});

test('a Desk opening a distinct Library preserves its existing shared-Places owner on failure', () => {
  const a = fixture(), b = fixture();
  b.library.PlacesUIUtils = a.places;
  a.setCurrentLibrary(a.library);
  assert.equal(a.api.openFirefoxBrowserLibrary('AllBookmarks', a.sourceCard), true);
  const installedNode = a.places.openNodeWithEvent;
  a.setCurrentLibrary(b.library);
  assert.equal(a.api.openFirefoxBrowserLibrary('History', a.sourceCard), true);
  assert.equal(a.places.openNodeWithEvent, installedNode);
  assert.notEqual(a.library.openTrustedLinkIn, a.originalOpen);
  assert.equal(b.library.openTrustedLinkIn, b.originalOpen);
  assert.ok(a.notices.some(message => message.includes('연결하지 못했습니다')));
  a.library.openTrustedLinkIn('https://example.test/still-a', 'current', {});
  assert.ok(a.events.some(event => event[0] === 'navigate' && event[3] === 'https://example.test/still-a'));
  a.listeners.get('main-unload')();
  assert.equal(a.library.openTrustedLinkIn, a.originalOpen);
});

test('a damaged owner cannot be captured as native by a different Library after dispose', () => {
  const a = fixture(), b = fixture();
  b.library.PlacesUIUtils = a.places;
  const owner = attach(a), thirdParty = () => {};
  a.library.openTrustedLinkIn = thirdParty;
  owner.dispose();
  assert.equal(a.library.openTrustedLinkIn, thirdParty);
  assert.throws(() => attach(b), /already owned by another Library/);
  assert.equal(b.library.openTrustedLinkIn, b.originalOpen);
});

test('changed installed wrappers are detected instead of being mistaken for Firefox originals', () => {
  const f = fixture(), owner = attach(f);
  const thirdParty = () => {};
  f.library.openTrustedLinkIn = thirdParty;
  assert.equal(owner.isActive(), false);
  assert.throws(() => attach(f), /changed outside its owner/);
  owner.dispose();
  assert.equal(f.library.openTrustedLinkIn, thirdParty);
  assert.throws(() => attach(f), /changed outside its owner/);
});

test('changed Places node or folder methods invalidate the installed owner', () => {
  for (const method of ['openNodeWithEvent', 'openTabset']) {
    const f = fixture(), owner = attach(f);
    assert.ok(Object.values(owner.installationChecks()).every(value => value === true));
    f.library.PlacesUIUtils[method] = () => {};
    assert.equal(owner.isActive(), false, `${method} identity must be checked`);
    assert.equal(owner.installationChecks()[method === 'openTabset' ? 'tabset' : 'node'], false);
    assert.throws(() => attach(f), /changed outside its owner/);
  }
});

test('bookmarks choose the actual Browser card, never hidden selectedTab, and keep native security checks', () => {
  const f = fixture();
  Object.defineProperty(f.library, 'gBrowser', { get() { throw new Error('hidden gBrowser must not be read'); } });
  attach(f, { cardIsEmpty: card => card._browserState.uri === 'about:blank' });
  const event = { target: { documentGlobal: f.library }, where: 'current' };
  const node = { uri: 'https://example.test/bookmark#section', isBookmark: true };
  f.library.PlacesUIUtils.openNodeWithEvent(node, event);
  assert.ok(f.events.some(event => event[0] === 'native-security'));
  assert.ok(f.events.some(event => event[0] === 'native-node-in' && event[1] === 'tab'));
  assert.ok(f.events.some(event => event[0] === 'open-card' && event[1] === node.uri));
  assert.equal(f.events.some(event => event[0] === 'navigate'), false, 'nonempty source is never overwritten');
  f.sourceCard._browserState.uri = 'about:blank';
  f.library.PlacesUIUtils.openNodeWithEvent(node, event);
  assert.ok(f.events.some(event => event[0] === 'navigate' && event[1] === 'source'), 'a genuinely empty source may be reused');
  const count = f.events.filter(event => event[0] === 'open-card' || event[0] === 'navigate').length;
  f.library.PlacesUIUtils.openNodeWithEvent({ ...node, safe: false }, event);
  assert.equal(f.events.filter(event => event[0] === 'open-card' || event[0] === 'navigate').length, count);
});

test('only a fully confirmed blank Browser card is empty', () => {
  const f = fixture(), card = f.sourceCard;
  card._browserState.uri = 'about:blank';
  card._xulBrowser.currentURI.spec = 'about:blank';
  card._xulBrowser.getAttribute = () => 'about:blank';
  assert.equal(f.api.browserLibraryCardIsEmpty(card), true);
  card._xulBrowser.getAttribute = () => 'https://example.test/pending';
  assert.equal(f.api.browserLibraryCardIsEmpty(card), false, 'a pending navigation cannot be overwritten as empty');
  card._xulBrowser.getAttribute = () => 'about:blank';
  card._browserState.uri = 'https://example.test/requested';
  assert.equal(f.api.browserLibraryCardIsEmpty(card), false);
});

test('tabshifted applies Firefox background inversion including explicit preferences', () => {
  const f = fixture();
  attach(f);
  f.library.openTrustedLinkIn('https://example.test/a', 'tabshifted', { inBackground: true });
  f.library.openTrustedLinkIn('https://example.test/b', 'tabshifted', { inBackground: false });
  f.setBackgroundPref(true);
  f.library.openTrustedLinkIn('https://example.test/c', 'tabshifted', {});
  f.library.openTrustedLinkIn('https://example.test/d', 'tab', { inBackground: true, forceForeground: true });
  assert.deepEqual(f.events.filter(event => event[0] === 'open-card').map(event => event[2]), [false, true, true, true]);
  assert.equal(f.events.filter(event => event[0] === 'reveal').length, 1);
});

test('trusted UI opens default to foreground even with loadInBackground, without masking explicit options', () => {
  const f = fixture();
  f.setBackgroundPref(true);
  attach(f);
  const cases = [
    [undefined, false], [{}, false], [{ forceForeground: null }, false],
    [{ forceForeground: false }, true], [{ inBackground: true }, true],
    [{ inBackground: false, forceForeground: false }, false],
  ];
  for (const [params, background] of cases) {
    f.library.openTrustedLinkIn('https://example.test/help', 'tab', params);
    assert.equal(f.events.filter(event => event[0] === 'open-card').at(-1)[2], background);
  }
  assert.equal(f.events.filter(event => event[0] === 'reveal').length, 4);
  assert.equal(cases[1][0].forceForeground, true, 'same nullish default as Firefox URILoadingHelper');
  assert.equal(cases[3][0].forceForeground, false, 'an explicit false is not replaced');
});

test('only Library Open File is blocked with a File card notice; native HTML commands and dispose are untouched', () => {
  const f = fixture(), session = attach(f);
  assert.deepEqual(f.commands['Browser:OpenFile'].dispatch(), { prevented: true, stopped: true });
  assert.match(f.notices[0], /File 카드/);
  assert.equal(f.events.length, 0, 'no file picker, Browser navigation or native redirect');
  for (const id of ['OrganizerCommand_import', 'OrganizerCommand_export']) {
    assert.deepEqual(f.commands[id].dispatch(), { prevented: false, stopped: false });
    assert.deepEqual(f.events.at(-1), ['native-command', id]);
  }
  session.dispose();
  assert.equal(f.commands['Browser:OpenFile'].guards.size, 0);
  assert.deepEqual(f.commands['Browser:OpenFile'].dispatch(), { prevented: false, stopped: false });
  assert.deepEqual(f.events.at(-1), ['native-command', 'Browser:OpenFile']);
});

test('Open File guard transfers with the Library owner and restores in either disposal order', () => {
  for (const reverse of [false, true]) {
    const f = fixture(), a = attach(f), b = attach(f), lastA = attach(f);
    const command = f.commands['Browser:OpenFile'];
    assert.equal(command.guards.size, 1, 'one active guard, no nested owners');
    for (const owner of reverse ? [lastA, b, a] : [a, b, lastA]) owner.dispose();
    assert.equal(command.guards.size, 0);
    assert.deepEqual(command.dispatch(), { prevented: false, stopped: false });
    assert.equal(f.notices.length, 0);
  }
});

test('Library fails closed when its Open File command cannot be guarded, and setup failure removes the guard', () => {
  const absent = fixture();
  delete absent.commands['Browser:OpenFile'];
  assert.throws(() => attach(absent), /routing unavailable/);
  assert.equal(absent.library.openTrustedLinkIn, absent.originalOpen);
  const failure = fixture();
  Object.defineProperty(failure.places, 'openTabset', { value: failure.places.openTabset, writable: false });
  assert.throws(() => attach(failure), /could not be installed|read only/);
  assert.equal(failure.commands['Browser:OpenFile'].guards.size, 0);
  assert.equal(failure.library.openTrustedLinkIn, failure.originalOpen);
  assert.equal(failure.places[Symbol.for('egdesk.firefox.library.places-owner.v1')], undefined,
    'partial installation must release its shared-Places owner');
});

test('a non-extensible shared Places object fails closed without partial installation', () => {
  const f = fixture(), originalNode = f.places.openNodeWithEvent, originalTabset = f.places.openTabset;
  Object.preventExtensions(f.places);
  assert.throws(() => attach(f), /not extensible|Cannot define property/);
  assert.equal(f.library.openTrustedLinkIn, f.originalOpen);
  assert.equal(f.library.openPreferences, f.originalPrefs);
  assert.equal(f.places.openNodeWithEvent, originalNode);
  assert.equal(f.places.openTabset, originalTabset);
  assert.equal(f.commands['Browser:OpenFile'].guards.size, 0);
  assert.equal(f.library[Symbol.for('egdesk.firefox.library.routing.v1')], undefined);
});

test('foreground Library history reveals an offscreen existing card using the real camera helper; background never does', () => {
  const f = fixture(), timers = [];
  const camera = { panTarget: { x: 0, y: 0 }, zoomTarget: 1, agenda: {}, surface: {} };
  camera.setCanvasPanTarget = pan => { camera.panTarget = pan; };
  const safe = { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 };
  const helperCode = section('  function revealOpenCanvasCard(', '\n  // \'채팅에서 보기\'') +
    section('  function revealPlacedCanvasCard(', '\n  // The opening Chat card');
  const helper = runInNewContext(`${helperCode}\n({ revealOpenCanvasCard })`, {
    SurfaceState, state: camera, window: { setTimeout: fn => timers.push(fn) },
    persistentEntityGeometry: card => card.geometry,
    safeViewportRect: () => safe,
    safeViewportWorldRect: () => ({ left: -camera.panTarget.x, top: -camera.panTarget.y,
      right: 1000 - camera.panTarget.x, bottom: 700 - camera.panTarget.y }),
  });
  f.context.revealOpenCanvasCard = helper.revealOpenCanvasCard;
  f.sourceCard.geometry = { x: 2000, y: 100, width: 640, height: 480 };
  f.api.openFirefoxBrowserLibrary('History', f.sourceCard);
  f.library.openTrustedLinkIn('https://example.test/history', 'current');
  assert.equal(timers.length, 1, 'foreground Library path schedules the existing reveal helper');
  timers.shift()();
  const screenLeft = f.sourceCard.geometry.x + camera.panTarget.x;
  assert.ok(screenLeft >= safe.left && screenLeft + 640 <= safe.right, 'the old card is now in the viewport');
  assert.ok(f.events.some(event => event[0] === 'focus-card' && event[1] === 'source'));
  const panBeforeBackground = { ...camera.panTarget };
  const focusCount = f.events.filter(event => event[0] === 'main-focus' || event[0] === 'focus-card').length;
  f.library.openTrustedLinkIn('https://example.test/background', 'tab', { inBackground: true });
  assert.equal(timers.length, 0);
  assert.deepEqual({ ...camera.panTarget }, panBeforeBackground);
  assert.equal(f.events.filter(event => event[0] === 'main-focus' || event[0] === 'focus-card').length, focusCount);
  camera.panTarget = { x: 0, y: 0 };
  f.library.openTrustedLinkIn('https://example.test/history-again', 'current');
  camera.panTarget = { x: 31, y: 47 };
  timers.shift()();
  assert.deepEqual(camera.panTarget, { x: 31, y: 47 }, 'a camera change made meanwhile still wins');
});

test('same-card fullscreen Library navigation does not move the real reveal helper camera', () => {
  const f = fixture(), timers = [];
  const camera = { panTarget: { x: 0, y: 0 }, zoomTarget: 1, agenda: {}, surface: {} };
  camera.setCanvasPanTarget = pan => { camera.panTarget = pan; };
  const safe = { left: 24, top: 24, right: 976, bottom: 676, width: 952, height: 652 };
  const helperCode = section('  function revealOpenCanvasCard(', '\n  // \'채팅에서 보기\'') +
    section('  function revealPlacedCanvasCard(', '\n  // The opening Chat card');
  const helper = runInNewContext(`${helperCode}\n({ revealOpenCanvasCard })`, {
    SurfaceState, state: camera, window: { setTimeout: fn => timers.push(fn) },
    persistentEntityGeometry: card => card.geometry,
    safeViewportRect: () => safe,
    safeViewportWorldRect: () => ({ left: safe.left - camera.panTarget.x, top: safe.top - camera.panTarget.y,
      right: safe.right - camera.panTarget.x, bottom: safe.bottom - camera.panTarget.y }),
  });
  f.context.revealOpenCanvasCard = helper.revealOpenCanvasCard;
  f.sourceCard.geometry = { x: 0, y: 0, width: 1000, height: 700 };
  f.context.state.cardFullscreen = { cardId: f.sourceCard.id };
  f.api.openFirefoxBrowserLibrary('History', f.sourceCard);

  // Prove the actual helper would shift this fullscreen geometry if called.
  helper.revealOpenCanvasCard(f.sourceCard, { kind: 'browser' });
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.deepEqual({ ...camera.panTarget }, { x: 24, y: 24 });
  camera.panTarget = { x: 0, y: 0 };

  f.library.openTrustedLinkIn('https://example.test/fullscreen-history', 'current');
  assert.equal(timers.length, 0, 'the Library callback must not invoke reveal for the fullscreen target');
  assert.deepEqual({ ...camera.panTarget }, { x: 0, y: 0 });
  assert.equal(f.context.state.cardFullscreen.cardId, f.sourceCard.id);
  assert.ok(f.events.some(event => event[0] === 'focus-card' && event[1] === 'source'));
  assert.ok(f.events.some(event => event[0] === 'navigate' && event[3] === 'https://example.test/fullscreen-history'));
});

test('foreground Library navigation leaves another card fullscreen only when it must reveal the selected card', () => {
  const f = fixture();
  f.context.exitCardFullscreen = (card, options) => {
    f.events.push(['exit-fullscreen', card, options.preserveCamera]);
    f.context.state.cardFullscreen = null;
  };
  f.api.openFirefoxBrowserLibrary('History', f.sourceCard);

  f.context.state.cardFullscreen = { cardId: 'another-card' };
  f.library.openTrustedLinkIn('https://example.test/background', 'tab', { inBackground: true });
  assert.equal(f.context.state.cardFullscreen.cardId, 'another-card');
  assert.equal(f.events.some(event => event[0] === 'exit-fullscreen' || event[0] === 'camera-reveal'), false);

  f.library.openTrustedLinkIn('https://example.test/history', 'current');
  const exit = f.events.findIndex(event => event[0] === 'exit-fullscreen');
  const focus = f.events.findIndex(event => event[0] === 'focus-card');
  const reveal = f.events.findIndex(event => event[0] === 'camera-reveal');
  assert.deepEqual(f.events[exit], ['exit-fullscreen', null, true]);
  assert.ok(exit < focus && focus < reveal, 'restore the other card before focusing and revealing the selected card');

  f.context.state.cardFullscreen = { cardId: f.sourceCard.id };
  f.library.openTrustedLinkIn('https://example.test/same-card', 'current');
  assert.equal(f.context.state.cardFullscreen.cardId, f.sourceCard.id, 'the selected fullscreen card stays fullscreen');
  assert.equal(f.events.filter(event => event[0] === 'exit-fullscreen').length, 1);
});

test('folder new-window requests do not silently become cards; shift-background is preserved', () => {
  const f = fixture();
  attach(f);
  const rows = [{ uri: 'https://example.test/a', isBookmark: true }, { uri: 'https://example.test/b', isBookmark: true }];
  f.library.PlacesUIUtils.openTabset(rows, { where: 'window' }, f.library);
  assert.equal(f.events.length, 0);
  assert.equal(f.notices.length, 1);
  f.library.PlacesUIUtils.openTabset(rows, { where: 'tabshifted' }, f.library);
  assert.deepEqual(f.events.filter(event => event[0] === 'open-card').map(event => event[2]), [true, true]);
  assert.equal(f.events.filter(event => event[0] === 'reveal').length, 0);
});

test('a Firefox bookkeeping callback failure cannot erase an already-started navigation', () => {
  const f = fixture();
  attach(f);
  const card = f.library.openTrustedLinkIn('https://example.test/path', 'current', {
    resolveOnContentBrowserCreated() { throw new Error('bookkeeping unavailable'); },
  });
  assert.equal(card, f.sourceCard);
  assert.equal(f.events[0][0], 'navigate');
  assert.equal(f.events[1][0], 'reveal');
  assert.equal(f.notices.length, 0);
});

test('scoped Places guards route Library folders and delegate other windows unchanged', () => {
  const f = fixture(), originalTabset = f.places.openTabset, originalNode = f.places.openNodeWithEvent;
  const session = attach(f);
  const rows = [
    { uri: 'https://example.test/a#one', isBookmark: true },
    { uri: 'https://example.test/b', isBookmark: false },
    { uri: 'javascript:alert(1)', isBookmark: true },
  ];
  f.library.PlacesUIUtils.openMultipleLinksInTabs(rows, {}, { ownerWindow: f.library });
  const opened = f.events.filter(event => event[0] === 'open-card');
  assert.equal(opened.length, 2);
  assert.equal(opened[0][2], true);
  assert.equal(opened[1][2], false);
  assert.equal(f.events.filter(event => event[0] === 'reveal').length, 1);
  assert.equal(f.events.filter(event => event[0] === 'bookmark-mark').length, 1);
  assert.equal(f.events.filter(event => event[0] === 'history-mark').length, 1);
  assert.equal(f.notices.length, 1);
  f.library.PlacesUIUtils.openTabset(rows, {}, { id: 'other-window' });
  assert.equal(f.events.at(-1)[0], 'native-tabset');
  f.library.PlacesUIUtils.openNodeWithEvent({ uri: 'https://example.test/foreign' }, { target: { documentGlobal: {} } });
  assert.equal(f.events.at(-1)[0], 'native-node');
  session.dispose();
  assert.equal(f.places.openTabset, originalTabset);
  assert.equal(f.places.openNodeWithEvent, originalNode);
});

test('unsupported or stale Library opens never fall through to hidden tabs', () => {
  const f = fixture();
  attach(f);
  f.library.openTrustedLinkIn('https://example.test/', 'window', {});
  f.library.openTrustedLinkIn('file:///tmp/a', 'current', {});
  f.library.openTrustedLinkIn('https://example.test/', 'tab', { private: true });
  f.library.openTrustedLinkIn('https://example.test/', 'tab', { triggeringPrincipal: {} });
  f.sourceCard.isConnected = false;
  f.library.openTrustedLinkIn('https://example.test/', 'current', {});
  assert.equal(f.events.length, 0);
  assert.equal(f.notices.length, 5);
  assert.equal(f.library.openTrustedLinkIn('https://example.test/', 'save', {}), 'native');
  assert.equal(f.events.at(-1)[0], 'native-open');
});

test('context checks reject private, container, auth, unknown, and closed cards', () => {
  const f = fixture();
  assert.equal(f.api.browserLibraryContextAllowed(f.sourceCard), true);
  f.sourceCard._xulBrowser.browsingContext.originAttributes.userContextId = 1;
  assert.equal(f.api.browserLibraryContextAllowed(f.sourceCard), false);
  f.sourceCard._xulBrowser.browsingContext.originAttributes.userContextId = 0;
  f.sourceCard._xulBrowser.browsingContext.originAttributes.privateBrowsingId = 1;
  assert.equal(f.api.browserLibraryContextAllowed(f.sourceCard), false);
  f.sourceCard._xulBrowser.browsingContext.originAttributes.privateBrowsingId = 0;
  f.sourceCard._xulBrowser.browsingContext.originAttributes.partitionKey = '(https,example.test)';
  assert.equal(f.api.browserLibraryContextAllowed(f.sourceCard), false, 'partitioned context must not be silently dropped');
  delete f.sourceCard._xulBrowser.browsingContext.originAttributes.partitionKey;
  f.sourceCard._xulBrowser.browsingContext.originAttributes.firstPartyDomain = 'example.test';
  assert.equal(f.api.browserLibraryContextAllowed(f.sourceCard), false, 'first-party context must not be silently dropped');
  delete f.sourceCard._xulBrowser.browsingContext.originAttributes.firstPartyDomain;
  f.setPrivate(true);
  assert.equal(f.api.browserLibraryContextAllowed(f.sourceCard), false);
  f.setPrivate(false);
  f.sourceCard.dataset.codexRole = 'auth';
  assert.equal(f.api.browserLibraryContextAllowed(f.sourceCard), false);
  delete f.sourceCard.dataset.codexRole;
  delete f.sourceCard._xulBrowser.browsingContext.originAttributes;
  assert.equal(f.api.browserLibraryContextAllowed(f.sourceCard), false);
  f.sourceCard.isConnected = false;
  assert.equal(f.api.browserLibraryContextAllowed(f.sourceCard), false);
});

test('import uses the Firefox API with a null opener only after policy permits it', () => {
  const f = fixture();
  f.setPolicy(false);
  assert.equal(f.api.openFirefoxBrowserImport(), false);
  assert.equal(f.events.filter(event => event[0] === 'migration').length, 0);
  f.setPolicy(true);
  assert.equal(f.api.openFirefoxBrowserImport(), true);
  const call = f.events.find(event => event[0] === 'migration');
  assert.equal(call[1], null);
  assert.equal(call[2].entrypoint, 'places');
  assert.deepEqual(Object.keys(call[2]), ['entrypoint']);
  const session = attach(f, { showImport: () => f.api.openFirefoxBrowserImport() });
  f.library.openPreferences('general-migrate');
  assert.equal(f.events.filter(event => event[0] === 'migration').length, 2);
  assert.equal(f.library.openPreferences('privacy'), 'native-prefs');
  session.dispose();
});

test('Library waits for its native document and reuses an existing organizer', () => {
  const f = fixture();
  f.library.document = { ...f.library.document, documentURI: 'about:blank', readyState: 'complete' };
  assert.equal(f.api.openFirefoxBrowserLibrary('AllBookmarks', f.sourceCard), true);
  assert.equal(f.events.find(event => event[0] === 'dialog')[1], 'chrome://browser/content/places/places.xhtml');
  assert.equal(f.library.openTrustedLinkIn, f.originalOpen);
  assert.equal(typeof f.listeners.get('load'), 'function');
  f.library.document = { ...f.library.document, documentURI: 'chrome://browser/content/places/places.xhtml', readyState: 'complete' };
  f.listeners.get('load')();
  assert.notEqual(f.library.openTrustedLinkIn, f.originalOpen);
  f.library.openTrustedLinkIn('https://example.test/bookmark#part', 'current', {});
  assert.ok(f.events.some(event => event[0] === 'navigate' && event[3] === 'https://example.test/bookmark#part'));
  assert.equal(f.api.openFirefoxBrowserLibrary('History', f.sourceCard), true);
  assert.ok(f.events.some(event => event[0] === 'select' && event[1] === 'History'));
  f.listeners.get('unload')();
  assert.equal(f.library.openTrustedLinkIn, f.originalOpen);
});

test('a new Library window is closed when safe routing cannot be installed', () => {
  const f = fixture();
  Object.defineProperty(f.places, 'openTabset', { value: f.places.openTabset, configurable: true, writable: false });
  assert.equal(f.api.openFirefoxBrowserLibrary('AllBookmarks', f.sourceCard), true);
  assert.equal(f.library.closed, true);
  assert.equal(f.library.openTrustedLinkIn, f.originalOpen);
  assert.ok(f.events.some(event => event[0] === 'library-close'));
  assert.equal(f.notices.length, 1);
});

test('production Browser menu invokes only its native Library and import entries', () => {
  const duplicate = section('    const duplicateBrowser = () => spawnBrowserCard(', '    const selectBrowserForChat =');
  const menu = section('    const showBrowserMenu =', '    card._browserState =');
  const actions = [], document = { body: { isConnected: true }, documentElement: {} };
  const make = (tag, attrs = {}, ...children) => ({
    tag, ...attrs, children, dataset: attrs.data || {}, isConnected: false, disabled: !!attrs.disabled,
    contains(node) { return node === this || this.children.includes(node); },
    remove() { this.isConnected = false; document.activeElement = document.body; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, focus() { document.activeElement = this; },
  });
  document.documentElement.appendChild = node => { node.isConnected = true; for (const child of node.children) child.isConnected = true; };
  document.querySelector = () => null;
  const anchor = make('button'), card = make('div');
  anchor.isConnected = card.isConnected = true;
  anchor.getBoundingClientRect = () => ({ right: 100, bottom: 100, top: 80 });
  card._sourceRef = {};
  document.activeElement = anchor;
  const context = {
    document, window: { innerHeight: 800, setTimeout() {}, addEventListener() {}, removeEventListener() {} },
    menuButton: anchor, card, browserState: { uri: 'https://example.test/', homeUrl: 'https://example.test/', loading: false },
    el: make, resolveFloatingMenuPlacement: () => ({ left: 0, top: 0 }),
    spawnBrowserCard() {}, copyTextToClipboard() {}, navigateBrowser() {}, stopBrowser() {}, reloadBrowser() {},
    isCardFullscreen: () => false, toggleCardFullscreen() {}, endAgentHold() {},
    // No conversation is bound here, so the menu holds no standing grant (BRW-11).
    browserToolGrantFor: () => null,
    openFirefoxBrowserLibrary(section, opener) { actions.push(['library', section, opener]); },
    openFirefoxBrowserImport() { actions.push(['import']); },
  };
  const api = runInNewContext(`let browserMenuPanel = null;\n${duplicate}\nconst selectBrowserForChat = () => {};\n${menu}
    ({ showBrowserMenu })`, context);
  for (const [id, expected] of [['browser-library-bookmarks', 'AllBookmarks'], ['browser-library-history', 'History'],
    ['browser-library-import', null]]) {
    document.activeElement = anchor;
    const panel = api.showBrowserMenu(anchor);
    const item = panel.children.find(node => node.dataset.testid === id);
    assert.ok(item, id);
    item.onclick({ stopPropagation() {} });
    const action = actions.at(-1);
    assert.equal(action[0], expected ? 'library' : 'import');
    if (expected) { assert.equal(action[1], expected); assert.equal(action[2], card); }
    assert.equal(document.activeElement, document.body, 'opening a native window does not refocus the Browser trigger');
  }
  assert.equal(actions.length, 3);
});

test('menu selectors and Firefox history policy stay within the requested boundary', () => {
  for (const id of ['browser-menu', 'browser-library-bookmarks', 'browser-library-history', 'browser-library-import']) {
    assert.ok(source.includes(`testid: '${id}'`), `missing selector ${id}`);
  }
  assert.ok(source.includes("xulBrowser.setAttribute('disableglobalhistory', 'true')"));
  assert.ok(source.includes("openFirefoxBrowserLibrary('AllBookmarks', card)"));
  assert.ok(source.includes("openFirefoxBrowserLibrary('History', card)"));
  const routingCode = section('  function browserLibraryCanRoute(', '\n  function spawnBrowserCard(')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(!routingCode.includes('gBrowser.'));
});
