import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  browserUserContextId,
  configureBrowser,
  createBrowserIdentityAdapter,
  popupContextOptions,
} from '../overlay/resources/EGDeskBrowserIdentity.sys.mjs';

function fakeBrowser(url, userContextId, connected = true) {
  const attrs = new Map(userContextId ? [['usercontextid', String(userContextId)]] : []);
  const browser = {
    isConnected: connected,
    currentURI: { spec: url },
    browsingContext: connected ? { originAttributes: { userContextId } } : null,
    loads: [],
    getAttribute(name) { return attrs.get(name) ?? null; },
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
    loadURI(uri, options) {
      assert.equal(typeof uri, 'object');
      this.loads.push({ value: uri.spec, options });
      this.currentURI.spec = uri.spec;
    },
  };
  return browser;
}

function nativeFixture() {
  const identities = [
    { userContextId: 1, name: 'Work', icon: 'briefcase', color: 'blue', public: true },
    { userContextId: 2, name: 'Private', icon: 'fingerprint', color: 'green', public: true },
    { userContextId: 99, name: 'internal', icon: '', color: '', public: false },
  ];
  const observerTopics = new Map();
  const systemPrincipal = { isSystemPrincipal: true };
  const services = {
    io: { newURI: (spec) => ({ spec }) },
    prefs: { getBoolPref: () => true },
    obs: {
      addObserver(observer, topic) { observerTopics.set(topic, observer); },
      removeObserver(observer, topic) {
        assert.equal(observerTopics.get(topic), observer);
        observerTopics.delete(topic);
      },
    },
    scriptSecurityManager: {
      createNullPrincipal(originAttributes) {
        return { isNullPrincipal: true, originAttributes };
      },
      getSystemPrincipal() { return systemPrincipal; },
    },
  };
  const identityService = {
    getPublicIdentities() { return identities.filter((item) => item.public); },
    getContainerIconURL(icon) { return ['briefcase', 'fingerprint'].includes(icon) ? `icon:${icon}` : null; },
    getContainerColorCode(color) { return ['blue', 'green'].includes(color) ? `color:${color}` : null; },
    create(name, icon, color) {
      const created = { userContextId: identities.length + 1, name, icon, color, public: true };
      identities.push(created);
      return created;
    },
  };
  return { services, identityService, observerTopics, systemPrincipal };
}

function cardFixture({ url = 'https://example.test/path?q=1#part', userContextId = 1 } = {}) {
  const original = fakeBrowser(url, userContextId);
  const card = { cardId: 'card-1', browser: original,
    frame: { x: 10, y: 20, width: 640, height: 420 }, revision: 3 };
  const record = { candidates: [], mounts: 0, swaps: 0, discarded: 0,
    retired: 0, warnings: 0, formState: 'clean', afterAwait: null };
  const lifecycle = {
    snapshot() { return { ...card, frame: { ...card.frame }, userContextId: browserUserContextId(card.browser) }; },
    inspectForm() { return record.formState; },
    warnEnteredForm({ cardId }) { assert.equal(cardId, card.cardId); record.warnings += 1; },
    createCandidate() {
      const candidate = fakeBrowser('about:blank', 0, false);
      record.candidates.push(candidate);
      return candidate;
    },
    mountCandidate({ browser }) {
      assert.equal(browser.isConnected, false);
      const target = browserUserContextId(browser);
      browser.isConnected = true;
      browser.browsingContext = { originAttributes: { userContextId: target } };
      record.mounts += 1;
    },
    watchCandidate({ browser, url: expectedUrl }) {
      assert.equal(browser.loads.length, 0, 'watch native load before dispatch');
      return {
        ready: Promise.resolve().then(async () => {
          assert.equal(browser.currentURI.spec, expectedUrl);
          if (record.afterAwait) await record.afterAwait();
          return true;
        }),
        dispose() { record.watcherDisposed = true; },
      };
    },
    replaceInner({ cardId, expectedBrowser, candidate, expectedRevision }) {
      assert.equal(cardId, card.cardId);
      assert.equal(card.browser, expectedBrowser);
      assert.equal(card.revision, expectedRevision);
      card.browser = candidate;
      record.swaps += 1;
      return true;
    },
    restoreInner({ original: old }) { card.browser = old; },
    discardCandidate(browser) { browser.isConnected = false; record.discarded += 1; },
    retireOriginal(browser) {
      assert.equal(browser, original);
      browser.isConnected = false;
      record.retired += 1;
      return true;
    },
  };
  return { card, original, record, lifecycle };
}

function switchRequest(fixture, extra = {}) {
  return { cardId: fixture.card.cardId, expectedBrowser: fixture.original,
    expectedRevision: fixture.card.revision, targetUserContextId: 2,
    explicitUserRequest: true, ...extra };
}

test('native container list/create uses public IDs and cleans observers', () => {
  const native = nativeFixture();
  const updates = [];
  const adapter = createBrowserIdentityAdapter(native);
  const started = adapter.start((event) => updates.push(event));
  assert.equal(started.supported, true);
  assert.equal(started.mode, 'injected');
  assert.equal(started.observing, true);
  assert.deepEqual(started.containers.map((item) => item.userContextId), [0, 1, 2]);
  assert.equal(native.observerTopics.size, 5);
  assert(native.observerTopics.has('contextual-identity-deleted'));
  assert.equal(adapter.createContainer({ name: 'New', icon: 'briefcase', color: 'blue' }).status, 'denied');
  assert.equal(adapter.createContainer({ name: 'New', icon: 'bad', color: 'blue',
    explicitUserRequest: true }).status, 'invalid-container');
  const created = adapter.createContainer({ name: 'New', icon: 'briefcase', color: 'blue',
    explicitUserRequest: true });
  assert.equal(created.status, 'created');
  native.observerTopics.get('contextual-identity-created').observe(null, 'contextual-identity-created');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].containers.at(-1).userContextId, created.container.userContextId);
  adapter.stop();
  assert.equal(native.observerTopics.size, 0);
  assert.equal(updates.length, 1);
});

test('switch keeps outer Card frame and loads exact URL in a different null-principal container', async () => {
  const native = nativeFixture();
  const fixture = cardFixture();
  const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: fixture.lifecycle });
  const beforeFrame = { ...fixture.card.frame };
  const result = await adapter.switchCardContext(switchRequest(fixture));
  assert.deepEqual(result, { status: 'switched', cardId: 'card-1', fromUserContextId: 1,
    toUserContextId: 2, siteAccount: 'unverified' });
  assert.deepEqual(fixture.card.frame, beforeFrame);
  assert.equal(fixture.card.cardId, 'card-1');
  assert.notEqual(fixture.card.browser, fixture.original);
  assert.equal(fixture.record.swaps, 1);
  assert.equal(fixture.record.retired, 1);
  const load = fixture.card.browser.loads[0];
  assert.equal(load.value, 'https://example.test/path?q=1#part');
  assert.equal(load.options.triggeringPrincipal.isNullPrincipal, true);
  assert.deepEqual(load.options.triggeringPrincipal.originAttributes, { userContextId: 2, privateBrowsingId: 0 });
  assert.equal(fixture.record.watcherDisposed, true);
  assert.deepEqual(popupContextOptions(fixture.card.browser), { userContextId: 2 });
});

test('entered or uninspectable forms, unsafe URLs, and absent feature preserve original', async () => {
  const native = nativeFixture();
  const fixture = cardFixture();
  const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: fixture.lifecycle });
  fixture.record.formState = 'entered';
  assert.deepEqual(await adapter.switchCardContext(switchRequest(fixture)),
    { status: 'blocked', reason: 'entered-form' });
  assert.equal(fixture.record.warnings, 1);
  assert.equal(fixture.record.candidates.length, 0);
  fixture.record.formState = 'unknown';
  assert.equal((await adapter.switchCardContext(switchRequest(fixture))).reason, 'form-inspection-unavailable');
  assert.equal(fixture.card.browser, fixture.original);

  const unsafe = cardFixture({ url: 'about:config' });
  const unsafeAdapter = createBrowserIdentityAdapter({ ...native, lifecycle: unsafe.lifecycle });
  assert.equal((await unsafeAdapter.switchCardContext(switchRequest(unsafe))).status, 'unsupported');
  assert.equal(unsafe.record.candidates.length, 0);
  native.services.prefs.getBoolPref = () => false;
  assert.equal((await adapter.switchCardContext(switchRequest(fixture))).status, 'unsupported');
  assert.equal(fixture.card.browser, fixture.original);
});

test('late form entry, stale Card revision, and cancellation do not replace original browser', async () => {
  const native = nativeFixture();
  const entered = cardFixture();
  entered.record.afterAwait = () => { entered.record.formState = 'entered'; };
  const enteredAdapter = createBrowserIdentityAdapter({ ...native, lifecycle: entered.lifecycle });
  assert.equal((await enteredAdapter.switchCardContext(switchRequest(entered))).reason, 'entered-form');
  assert.equal(entered.card.browser, entered.original);
  assert.equal(entered.record.discarded, 1);

  const stale = cardFixture();
  stale.record.afterAwait = () => { stale.card.revision += 1; };
  const staleAdapter = createBrowserIdentityAdapter({ ...native, lifecycle: stale.lifecycle });
  assert.equal((await staleAdapter.switchCardContext(switchRequest(stale))).status, 'stale-original');
  assert.equal(stale.card.browser, stale.original);

  const aborted = cardFixture();
  const controller = new AbortController();
  aborted.record.afterAwait = () => controller.abort();
  const abortAdapter = createBrowserIdentityAdapter({ ...native, lifecycle: aborted.lifecycle });
  assert.equal((await abortAdapter.switchCardContext(switchRequest(aborted,
    { signal: controller.signal }))).status, 'cancelled');
  assert.equal(aborted.card.browser, aborted.original);
  assert.equal(aborted.record.discarded, 1);
});

test('configureBrowser rejects connected browsers and mismatched live origin attributes', () => {
  const detached = fakeBrowser('about:blank', 0, false);
  configureBrowser(detached, 2);
  assert.equal(browserUserContextId(detached), 2);
  assert.throws(() => configureBrowser(fakeBrowser('https://example.test', 1), 2));
  detached.browsingContext = { originAttributes: { userContextId: 1 } };
  assert.equal(browserUserContextId(detached), null);
  assert.throws(() => popupContextOptions(detached));
});

test('exact browser/revision binding and restricted principal fail before candidate creation', async () => {
  const native = nativeFixture();
  const fixture = cardFixture();
  const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: fixture.lifecycle });
  assert.equal((await adapter.switchCardContext(switchRequest(fixture,
    { expectedBrowser: fakeBrowser('https://example.test', 1) }))).status, 'stale-original');
  assert.equal((await adapter.switchCardContext(switchRequest(fixture,
    { expectedRevision: 1 }))).status, 'stale-original');
  native.services.scriptSecurityManager.createNullPrincipal = () => native.systemPrincipal;
  assert.equal((await adapter.switchCardContext(switchRequest(fixture))).status, 'unsupported');
  assert.equal(fixture.record.candidates.length, 0);
  const credentials = cardFixture({ url: 'https://user:password@example.test/' });
  const credentialAdapter = createBrowserIdentityAdapter({ ...native, lifecycle: credentials.lifecycle });
  assert.equal((await credentialAdapter.switchCardContext(switchRequest(credentials))).status, 'unsupported');
  assert.equal(credentials.record.candidates.length, 0);
});

test('shutdown during candidate creation prevents its navigation and preserves original', async () => {
  const native = nativeFixture();
  const fixture = cardFixture();
  let created;
  let release;
  const creationStarted = new Promise((resolve) => { created = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const candidate = fakeBrowser('about:blank', 0, false);
  fixture.lifecycle.createCandidate = async () => { created(); await gate; return candidate; };
  const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: fixture.lifecycle });
  const switching = adapter.switchCardContext(switchRequest(fixture));
  await creationStarted;
  adapter.stop();
  release();
  assert.equal((await switching).status, 'cancelled');
  assert.equal(candidate.loads.length, 0);
  assert.equal(fixture.record.mounts, 0);
  assert.equal(fixture.card.browser, fixture.original);
});

test('live frame alias changes and failed native load cannot pass the rebind gate', async () => {
  const native = nativeFixture();
  const moved = cardFixture();
  moved.lifecycle.snapshot = () => ({ ...moved.card, frame: moved.card.frame,
    userContextId: browserUserContextId(moved.card.browser) });
  moved.record.afterAwait = () => { moved.card.frame.width += 10; };
  const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: moved.lifecycle });
  assert.equal((await adapter.switchCardContext(switchRequest(moved))).status, 'stale-original');
  assert.equal(moved.card.browser, moved.original);
  const failed = cardFixture();
  let disposed = false;
  failed.lifecycle.watchCandidate = () => ({ ready: Promise.resolve(false), dispose() { disposed = true; } });
  const failedAdapter = createBrowserIdentityAdapter({ ...native, lifecycle: failed.lifecycle });
  assert.equal((await failedAdapter.switchCardContext(switchRequest(failed))).status, 'unavailable');
  assert.equal(failed.card.browser, failed.original);
  assert.equal(disposed, true);
  assert.equal(failed.record.discarded, 1);
});

test('failed inner swap restores original without retiring it', async () => {
  const native = nativeFixture();
  const fixture = cardFixture();
  fixture.lifecycle.replaceInner = ({ candidate }) => {
    fixture.card.browser = candidate;
    throw new Error('UI swap failed after assignment');
  };
  const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: fixture.lifecycle });
  assert.equal((await adapter.switchCardContext(switchRequest(fixture))).status, 'unavailable');
  assert.equal(fixture.card.browser, fixture.original);
  assert.equal(fixture.record.retired, 0);
  assert.equal(fixture.record.discarded, 1);
});

test('stop cancels a hung native load watcher and disposes the staged browser', async () => {
  const native = nativeFixture();
  const fixture = cardFixture();
  let watched;
  const watching = new Promise((resolve) => { watched = resolve; });
  fixture.lifecycle.watchCandidate = () => {
    watched();
    return { ready: new Promise(() => {}), dispose() { fixture.record.watcherDisposed = true; } };
  };
  const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: fixture.lifecycle });
  const switching = adapter.switchCardContext(switchRequest(fixture));
  await watching;
  adapter.stop();
  assert.equal((await switching).status, 'cancelled');
  assert.equal(fixture.card.browser, fixture.original);
  assert.equal(fixture.record.watcherDisposed, true);
  assert.equal(fixture.record.discarded, 1);
});

test('original target is rechecked after the final asynchronous form inspection', async () => {
  const native = nativeFixture();
  const fixture = cardFixture();
  let inspections = 0;
  fixture.lifecycle.inspectForm = async () => {
    if (++inspections === 2) fixture.card.revision += 1;
    return 'clean';
  };
  const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: fixture.lifecycle });
  assert.equal((await adapter.switchCardContext(switchRequest(fixture))).status, 'stale-original');
  assert.equal(fixture.card.browser, fixture.original);
  assert.equal(fixture.record.swaps, 0);
});

test('Gecko entry point imports the native service through a fake host boundary', async () => {
  const native = nativeFixture();
  const savedChrome = globalThis.ChromeUtils;
  const savedServices = globalThis.Services;
  const imports = [];
  try {
    globalThis.ChromeUtils = { importESModule(uri) {
      imports.push(uri);
      return { ContextualIdentityService: native.identityService };
    } };
    globalThis.Services = native.services;
    const adapter = createBrowserIdentityAdapter();
    assert.equal(adapter.start().mode, 'gecko-native');
    assert.deepEqual(imports, ['resource://gre/modules/ContextualIdentityService.sys.mjs']);
    await adapter.stop();
    assert.equal(native.observerTopics.size, 0);
  } finally {
    if (savedChrome === undefined) delete globalThis.ChromeUtils;
    else globalThis.ChromeUtils = savedChrome;
    if (savedServices === undefined) delete globalThis.Services;
    else globalThis.Services = savedServices;
  }
});

test('private context mismatch cannot load or replace the original', async () => {
  const native = nativeFixture();
  const fixture = cardFixture();
  fixture.original.browsingContext.originAttributes.privateBrowsingId = 1;
  const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: fixture.lifecycle });
  assert.equal((await adapter.switchCardContext(switchRequest(fixture))).status, 'unsupported');
  assert.equal(fixture.record.candidates[0].loads.length, 0);
  assert.equal(fixture.card.browser, fixture.original);
  assert.equal(fixture.record.discarded, 1);
});

test('unsupported candidate returned by UI is never treated as adapter-owned for disposal', async () => {
  for (const useOriginal of [true, false]) {
    const native = nativeFixture();
    const fixture = cardFixture();
    const existing = useOriginal ? fixture.original : fakeBrowser('https://other.test/', 2);
    fixture.lifecycle.createCandidate = () => existing;
    const adapter = createBrowserIdentityAdapter({ ...native, lifecycle: fixture.lifecycle });
    assert.equal((await adapter.switchCardContext(switchRequest(fixture))).status, 'unsupported');
    assert.equal(fixture.card.browser, fixture.original);
    assert.equal(existing.isConnected, true);
    assert.equal(fixture.record.discarded, 0);
    assert.equal(fixture.record.retired, 0);
  }
});
