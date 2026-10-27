import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createPortableTransferFixture } from './egdesk-portable-transfer-fixture.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { profileFormFromBody, validateProfileForm } from '../overlay/resources/EGDeskChatState.sys.mjs';
import { assertPortableEnvironment, assertPortableStoreInvariant, assertPortableImportedDraft,
  assertPortableExportFile, assertPortablePinnedExport, assertPortableNoReplay,
  assertPortableMissingHead, assertPortableAttachmentOmission,
  assertPortableDuplicateReady, assertPortableDuplicateUi, assertPortableDuplicatedDraft,
  assertPortableDuplicateNoReplay, assertPortableRejectedDeskAutosaves, runPortableDuplicateCase, PORTABLE_DUPLICATE_NOTICE,
  assertPortableUnknownCreated, assertPortableUnknownUi, assertPortableUnknownNoReplay, runPortableDuplicateUnknownCase,
  probePortableDisabledDuplicate, PORTABLE_DUPLICATE_UNKNOWN_NOTICE,
  assertPortableDraftGet, assertPortableDraftDelta, assertPortableDraftForm, assertPortableDraftFooter, portableDraftExpectedBody, PORTABLE_DRAFT_INPUT,
  editPortableDraftInput, runPortableDraftEditCase, observePortableUi,
  observePortableFirstUse, preparePortableInstructionEdge, observePortableSettingsNavigation, navigatePortableSettings,
  portableObservationSources, PORTABLE_OBSERVATION_BUDGET, portableTextVisible } from './verify-firefox-mcp-portable-transfer-flow.mjs';

const TOKEN = 'portable-verifier-unit-only-token';
const ENV = { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1',
  EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_PORT: '49318', EGDESK_QA_FIXTURE_TOKEN: TOKEN };
const fixtureTest = (name, fn) => test(name,
  { skip: process.platform === 'win32' ? 'portable fixture is not enabled on Windows' : false }, fn);
function setup(t, overrides = {}, { makeFixture = createPortableTransferFixture, onDirectory = () => {} } = {}) {
  const tempRoot = canonicalTempRoot(), directories = [];
  const prefixes = new Set(['egdesk-portable-verifier-loader-', 'egdesk-chat-test-', 'egdesk-portable-transfer-']);
  let fixture;
  const track = (directory, prefix) => {
    if (directories.some(item => item.directory === directory)) return;
    assert.equal(path.dirname(directory), tempRoot);
    assert.ok(path.basename(directory).startsWith(prefix));
    const info = fs.lstatSync(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    directories.push({ directory, prefix, dev: info.dev, ino: info.ino });
    onDirectory(directory, prefix);
  };
  // Register before any allocation, including ones whose constructors throw.
  t.after(() => {
    try { fixture?.dispose(); } finally {
      for (const { directory, prefix, dev, ino } of directories.slice().reverse()) {
        const info = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (!info) continue;
        assert.equal(path.dirname(directory), tempRoot);
        assert.ok(path.basename(directory).startsWith(prefix));
        assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.dev === dev && info.ino === ino);
        assert.equal(fs.realpathSync.native(directory), directory);
        fs.rmSync(directory, { recursive: true });
      }
    }
  });
  // POSIX temp creation can succeed inside a constructor that later throws.
  const mkdtemp = fs.mkdtempSync;
  const capture = t.mock.method(fs, 'mkdtempSync', function(prefix, ...options) {
    const directory = mkdtemp.call(fs, prefix, ...options);
    if (typeof prefix === 'string' && path.dirname(prefix) === tempRoot && prefixes.has(path.basename(prefix))) {
      track(directory, path.basename(prefix));
    }
    return directory;
  });
  try {
    const loader = createPrivateQaTempDirectory('egdesk-portable-verifier-loader-');
    track(loader, 'egdesk-portable-verifier-loader-');
    for (const name of LOADER_FILES) fs.writeFileSync(path.join(loader, name), `unit loader ${name}\n`, { mode: 0o600 });
    const { profile } = bootstrapQaProfile({ loaderSource: loader });
    track(profile, 'egdesk-chat-test-');
    fixture = makeFixture({ profile, token: TOKEN, env: { ...ENV, ...overrides } });
    track(fixture.snapshot().root, 'egdesk-portable-transfer-');
    return fixture;
  } finally { capture.mock.restore(); }
}

fixtureTest('verifier setup cleans only owned temp directories after failures at every allocation stage', t => {
  for (const [stage, expected] of [['loader-write', 1], ['profile-write', 2], ['fixture-validation', 2],
    ['fixture-mkdir', 3], ['snapshot', 3]]) {
    const cleanup = [], directories = [];
    const context = { after: callback => cleanup.push(callback), mock: t.mock };
    const options = { onDirectory: directory => directories.push(directory) };
    let injected, disposed = 0;
    if (stage === 'loader-write' || stage === 'profile-write') {
      const write = fs.writeFileSync;
      injected = t.mock.method(fs, 'writeFileSync', function(file, ...args) {
        if (stage === 'loader-write' && directories[0] && path.dirname(file) === directories[0]
            || stage === 'profile-write' && path.basename(file) === '.egdesk-dedicated-firefox-profile') {
          throw new Error(`injected ${stage}`);
        }
        return write.call(fs, file, ...args);
      });
    } else if (stage === 'fixture-mkdir') {
      const mkdir = fs.mkdirSync;
      injected = t.mock.method(fs, 'mkdirSync', function(directory, ...args) {
        if (path.basename(directory) === 'store' && path.basename(path.dirname(directory)).startsWith('egdesk-portable-transfer-')) {
          throw new Error(`injected ${stage}`);
        }
        return mkdir.call(fs, directory, ...args);
      });
    } else if (stage === 'snapshot') {
      options.makeFixture = args => {
        const real = createPortableTransferFixture(args);
        return { ...real, snapshot() { throw new Error('injected snapshot'); },
          dispose() { disposed++; real.dispose(); } };
      };
    }
    try {
      const env = stage === 'fixture-validation' ? { EGDESK_QA_FIXTURE_PORT: '39218' } : {};
      assert.throws(() => setup(context, env, options), stage === 'fixture-validation' ? /FIXTURE_PORT/ : /injected/);
    } finally {
      injected?.mock.restore();
      assert.equal(cleanup.length, 1);
      for (const callback of cleanup) callback();
    }
    assert.equal(directories.length, expected, stage);
    for (const directory of directories) assert.equal(fs.existsSync(directory), false, stage);
    if (stage === 'snapshot') assert.equal(disposed, 1);
  }
});

fixtureTest('verifier cleanup refuses a replaced directory until its original identity is restored', t => {
  const cleanup = [], directories = [];
  const context = { after: callback => cleanup.push(callback), mock: t.mock };
  setup(context, {}, { onDirectory: directory => directories.push(directory) });
  const root = directories.at(-1), lstat = fs.lstatSync;
  const changed = t.mock.method(fs, 'lstatSync', function(directory, ...args) {
    const info = lstat.call(fs, directory, ...args);
    return directory === root ? { ...info, ino: info.ino + 1,
      isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink() } : info;
  });
  try {
    assert.throws(() => cleanup[0]());
    assert.equal(fs.existsSync(root), true);
  } finally {
    changed.mock.restore();
    cleanup[0]();
  }
  for (const directory of directories) assert.equal(fs.existsSync(directory), false);
});

async function request(fixture, method, route, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: route, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:49318', 'content-type': 'application/json', 'x-egdesk-qa-token': TOKEN } });
  let status, value;
  const res = { setHeader() {}, writeHead(code) { status = code; }, end(text) { value = text ? JSON.parse(text) : null; } };
  assert.equal(await fixture.handle(req, res), true);
  return { status, value };
}

test('verifier requires canonical token and exclusive portable mode, never a real provider turn', () => {
  assert.equal(assertPortableEnvironment(ENV), true);
  for (const delta of [{ EGDESK_QA_FIXTURE_TOKEN: undefined }, { EGDESK_QA_REAL_TURN: '1' },
    { EGDESK_QA_PROJECT_FILE_FIXTURE: '1' }, { EGDESK_QA_TASK_GATE_FIXTURE: '1' },
    { EGDESK_QA_RUN_OUTPUTS_FIXTURE: '1' }, { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '0' }]) {
    assert.throws(() => assertPortableEnvironment({ ...ENV, ...delta }));
  }
});

test('small observation scripts are read-only and cannot install fabricated outcome or native picker IO', () => {
  for (const part of portableObservationSources()) {
    assert.ok(part.bytes < PORTABLE_OBSERVATION_BUDGET);
    assert.equal(part.bytes, Buffer.byteLength(part.source));
    assert.doesNotMatch(part.source, /(?:\.click\(|\.focus\(|scrollIntoView|dispatchEvent|setSelectionRange|\.openProfile\(|\.openProject\(|IOUtils|fetch\()/);
    new Function(`return (${part.source})`); // compile only; no simulated DOM acceptance
  }
});

test('first-use observation is null-safe when portable setup has no Browser and no fullscreen state', async () => {
  // Observer regression only; these inputs never count as native UI evidence.
  for (const [browserCardId, found, fullscreen, expected] of [
    [undefined, null, null, false], [null, null, undefined, false],
    ['browser', null, { cardId: 'browser' }, false],
    ['browser', { id: 'browser' }, null, false],
    ['browser', { id: 'browser' }, { cardId: 'other' }, false],
    ['browser', { id: 'browser' }, { cardId: 'browser' }, true],
  ]) {
    const observed = await observePortableFirstUse({ evaluateChrome: source =>
      new Function('window', 'document', `return (${source})()`)(
        { __egdesk: { surface: { snapshot: () => ({ browserCardId, initialBrowserFocus: false }) }, state: { cardFullscreen: fullscreen } } },
        { getElementById: () => found }) });
    assert.deepEqual(observed, { initialBrowserFocus: false, cardId: found?.id || null, fullscreen: expected });
  }
});

test('paint predicates require actual full text rectangles, clipping and hit evidence, not container whitespace', () => {
  const good = { count: 1, text: 'first\nlast', needle: 'last', matches: 1, missing: 0, visible: true,
    fragments: [{ inside: true, hits: [true, true, true] }] };
  assert.equal(portableTextVisible(good, 'first\nlast', 'last'), true);
  for (const delta of [{ text: 'shortened' }, { matches: 0 }, { matches: 2 }, { missing: 1 }, { visible: false },
    { fragments: [] }, { fragments: [{ inside: false, hits: [true, true, true] }] },
    { fragments: [{ inside: true, hits: [true, false, true] }] }]) {
    assert.equal(portableTextVisible({ ...good, ...delta }, 'first\nlast', 'last'), false);
  }
});

function instructionScrollFixture() {
  const ui = { transferState: 'preview', active: { testid: 'import-instructions' }, contentBox: { scrollTop: 435, clientHeight: 533 },
    instructions: { text: 'ORIGINAL\nlong unchanged instructions\nEND', box: { scrollTop: 0, scrollHeight: 661, clientHeight: 160,
      left: 225, top: 210, width: 1030, height: 160 } } };
  const target = { visible: true, disabled: false, readOnly: false, inViewport: true, hitCount: 9 };
  const calls = [];
  let pauses = 0;
  const options = { expectedText: ui.instructions.text, readUi: async () => structuredClone(ui), readTargets: async () => [target],
    press: async (...args) => {
      calls.push(args);
      ui.instructions.box.scrollTop = args[0] === 'Home' ? 0 : 501;
    }, pause: async () => { pauses++; }, assertDeadline() {} };
  return { ui, target, calls, options, pauses: () => pauses };
}

test('instruction edge at top sends no Home/refocus, preserving the outer scroll before first-marker proof', async () => {
  const h = instructionScrollFixture();
  // R4's unnecessary Home could move the ancestor while its first marker was
  // still briefly painted. Edge preparation must issue no key in this state.
  h.options.press = async () => { h.ui.contentBox.scrollTop = 0; assert.fail('Already at local edge'); };
  const result = await preparePortableInstructionEdge({ ...h.options, edge: 'Home' });
  assert.deepEqual(result, { key: null, before: 0, after: 0, outerScrollTop: 435 });
  assert.ok(h.pauses() >= 3, 'Even a no-op edge waits for stable local and outer layout');
});

test('instruction End is selectorless native input after focus and waits through smooth local scrolling', async () => {
  const h = instructionScrollFixture();
  const stops = [160, 400, 501, 501, 501]; let moving = false, pauses = 0;
  h.options.press = async (...args) => {
    h.calls.push(args);
    if (args[0] === 'End') moving = true;
  };
  h.options.pause = async () => { pauses++; if (moving && stops.length) h.ui.instructions.box.scrollTop = stops.shift(); };
  const result = await preparePortableInstructionEdge({ ...h.options, edge: 'End' });
  assert.deepEqual(h.calls, [['End']], 'Never pass a selector that refocuses the region');
  assert.equal(result.after, 501); assert.ok(pauses >= 5);
  h.calls.length = 0;
  assert.equal((await preparePortableInstructionEdge({ ...h.options, edge: 'End' })).key, null);
  assert.deepEqual(h.calls, []);
});

test('instruction edge never accepts clipped, covered, stale, focus-lost or non-scrolling UI', async () => {
  const variants = [
    h => { h.target.hitCount = 3; }, h => { h.target.inViewport = false; },
    h => { h.options.readTargets = async () => []; },
    h => { h.options.readTargets = async () => [h.target, h.target]; },
    h => { h.ui.transferState = 'cancelled'; },
    h => { h.options.pause = async () => { h.ui.instructions.text = 'substituted'; }; },
    h => { h.options.pause = async () => { h.ui.active.testid = 'another-control'; }; },
    h => { h.options.press = async (...args) => { h.calls.push(args); }; },
    h => { h.options.press = async (...args) => { h.calls.push(args); h.ui.instructions.box.scrollTop = 501;
      h.ui.contentBox.scrollTop = 0; h.target.hitCount = 3; }; },
  ];
  for (const mutate of variants) {
    const h = instructionScrollFixture(); mutate(h);
    await assert.rejects(preparePortableInstructionEdge({ ...h.options, edge: 'End' }));
    assert.ok(h.calls.length <= 1, 'No blind repeat or fallback input after a failed scroll');
  }
});

test('instruction keys refuse wrong focus rather than cycling Tab, and obey the deadline', async () => {
  const h = instructionScrollFixture(); h.ui.active.testid = 'another-control';
  h.options.press = async (...args) => { h.calls.push(args); };
  await assert.rejects(preparePortableInstructionEdge({ ...h.options, edge: 'End' }), /native point focus/);
  assert.deepEqual(h.calls, []);
  const shifted = instructionScrollFixture(); let reads = 0;
  shifted.options.readUi = async () => {
    if (++reads === 2) shifted.ui.active.testid = 'global-search';
    return structuredClone(shifted.ui);
  };
  await assert.rejects(preparePortableInstructionEdge({ ...shifted.options, edge: 'End' }), /Focus changed before/);
  assert.deepEqual(shifted.calls, []);
  const expired = instructionScrollFixture(); expired.options.assertDeadline = () => { throw new Error('deadline'); };
  await assert.rejects(preparePortableInstructionEdge({ ...expired.options, edge: 'End' }), /deadline/);
  assert.deepEqual(expired.calls, []);
});

const INSTRUCTIONS = '[data-testid="import-instructions"]';
function settingsNavigationFixture({ top = 1000, height = 160, selector = INSTRUCTIONS, transferState = 'preview' } = {}) {
  const model = { top, scrollTop: 0, scrollHeight: 1600, focused: false, activeTestid: 'settings-agent-import', reads: 0 };
  const wheels = [], clicks = [], trace = [];
  const read = async () => {
    model.reads++;
    const targetRect = { left: 220, right: 1200, top: model.top - model.scrollTop, bottom: model.top - model.scrollTop + height, width: 980, height };
    const viewport = { left: 100, top: 200, right: 1250, bottom: 730 };
    return { settingsId: 'settings-original', selector, cards: 1, contents: 1, count: 1,
      transferState, owned: true, contentVisible: true, targetVisible: true, disabled: false,
      focused: model.focused, activeTestid: model.activeTestid,
      targetRect, targetClip: viewport, viewport, bounds: { ...viewport, width: 1150, height: 530 },
      targetReady: targetRect.top >= viewport.top && targetRect.bottom <= viewport.bottom,
      point: { x: 710, y: Math.round(targetRect.top + height / 2) }, wheelPoint: { x: 112, y: 465 },
      scrollTop: model.scrollTop, scrollHeight: model.scrollHeight, clientHeight: 530 };
  };
  const options = { read, wheelAt: async input => { wheels.push(input); model.scrollTop += input.deltaY; },
    clickPoint: async point => { clicks.push(point); model.focused = true; model.activeTestid = 'import-instructions'; },
    pause: async () => {}, assertDeadline() {}, focus: true, trace };
  return { model, wheels, clicks, trace, options };
}

test('R6 visible export controls do not prove the lower version/status notice is painted', async () => {
  for (const [selector, transferState] of [
    ['[data-testid="transfer-export-target"]', 'failed'],
    ['[data-testid="transfer-status"]', 'unknown'],
  ]) {
    // R6 had an on-screen button row at 692..720, but the notice text started
    // below the clipped content. Read-only notice navigation must not click
    // controls (which are disabled in the unknown state) or award paint early.
    const h = settingsNavigationFixture({ top: 729, height: 40, selector, transferState });
    const text = '내보낼 Agent: Owned QA portable profile · 초안 버전 2';
    const paint = () => {
      const top = 739 - h.model.scrollTop, bottom = top + 16, inside = top >= 200 && bottom <= 730;
      return { count: 1, text, needle: null, matches: 1, missing: 0, visible: true,
        fragments: [{ top, bottom, inside, hits: [inside, inside, inside] }] };
    };
    assert.equal(portableTextVisible(paint(), text), false, 'The original clipped-text assertion still rejects R6 geometry');
    const value = await navigatePortableSettings({ ...h.options, focus: false });
    assert.equal(value.selector, selector); assert.equal(value.transferState, transferState);
    assert.equal(value.targetReady, true);
    assert.deepEqual(h.wheels, [{ x: 112, y: 465, deltaX: 0, deltaY: 51 }]);
    assert.deepEqual(h.clicks, [], 'Revealing a notice must not trigger export, retry, or focus');
    assert.equal(portableTextVisible(paint(), text), true);
    const covered = paint(); covered.fragments[0].hits[1] = false;
    assert.equal(portableTextVisible(covered, text), false, 'Native navigation does not bypass occlusion proof');
    assert.equal(portableTextVisible(paint(), `${text} changed`), false);
  }
});

test('Settings navigation wheels only the observed outer area, reobserves progress, then clicks and verifies focus', async () => {
  const h = settingsNavigationFixture(), value = await navigatePortableSettings(h.options);
  assert.equal(h.wheels.length, 2); assert.equal(h.clicks.length, 1); assert.equal(value.focused, true);
  assert.deepEqual(h.wheels, [{ x: 112, y: 465, deltaX: 0, deltaY: 240 }, { x: 112, y: 465, deltaX: 0, deltaY: 202 }]);
  assert.deepEqual(h.clicks[0], value.point);
  assert.deepEqual(h.trace.map(row => row.kind), ['native-wheel', 'native-wheel', 'native-focus-point']);
  assert.ok(h.trace.filter(row => row.kind === 'native-wheel').every(row => row.after > row.before));
  assert.ok(h.model.reads >= 15, 'Each input uses fresh settled observations');
  const reveal = settingsNavigationFixture(); reveal.options.focus = false;
  await navigatePortableSettings(reveal.options); assert.deepEqual(reveal.clicks, [], 'Revealing a control never activates it');
});

test('Settings navigation refuses ambiguous, foreign, disabled, covered, clipped or unstable targets before input', async () => {
  const variants = [value => { value.count = 2; }, value => { value.cards = 0; }, value => { value.contents = 2; },
    value => { value.owned = false; }, value => { value.disabled = true; }, value => { value.targetVisible = false; },
    value => { value.wheelPoint = null; }, value => { value.targetRect.left = -10; },
    value => { value.targetRect.height = 900; }, value => { value.scrollHeight = value.clientHeight; },
    value => { value.targetRect.top = 300; value.targetRect.bottom = 460; value.targetReady = false; }];
  for (const alter of variants) {
    const h = settingsNavigationFixture(), read = h.options.read;
    h.options.read = async () => { const value = await read(); alter(value); return value; };
    await assert.rejects(navigatePortableSettings(h.options));
    assert.deepEqual(h.wheels, []); assert.deepEqual(h.clicks, []);
  }
  for (const alter of [value => { value.settingsId = 'other-settings'; }, value => { value.transferState = 'cancelled'; },
    value => { value.wheelPoint.x++; }]) {
    const h = settingsNavigationFixture(), read = h.options.read;
    h.options.read = async () => { const value = await read(); if (h.model.reads === 4) alter(value); return value; };
    await assert.rejects(navigatePortableSettings(h.options)); assert.deepEqual(h.wheels, []); assert.deepEqual(h.clicks, []);
  }
});

test('Settings native input errors, no wheel progress and lost focus fail without repeat or Tab fallback', async () => {
  for (const behavior of ['throw', 'no-progress', 'wrong-direction']) {
    const h = settingsNavigationFixture();
    h.options.wheelAt = async input => { h.wheels.push(input);
      if (behavior === 'throw') throw new Error('native wheel failed');
      if (behavior === 'wrong-direction') h.model.scrollTop -= 10;
    };
    await assert.rejects(navigatePortableSettings(h.options)); assert.equal(h.wheels.length, 1); assert.deepEqual(h.clicks, []);
  }
  for (const behavior of ['throw', 'search-focus']) {
    const h = settingsNavigationFixture({ top: 300 });
    h.options.clickPoint = async point => { h.clicks.push(point);
      if (behavior === 'throw') throw new Error('native click failed');
      h.model.activeTestid = 'global-search';
    };
    await assert.rejects(navigatePortableSettings(h.options)); assert.equal(h.clicks.length, 1); assert.deepEqual(h.wheels, []);
  }
});

test('Settings native navigation has a finite wheel budget and honors the deadline before any action', async () => {
  const h = settingsNavigationFixture({ top: 100000 }); h.model.scrollHeight = 200000;
  await assert.rejects(navigatePortableSettings(h.options), /wheel budget/);
  assert.equal(h.wheels.length, 12); assert.deepEqual(h.clicks, []);
  const expired = settingsNavigationFixture(); expired.options.assertDeadline = () => { throw new Error('deadline'); };
  await assert.rejects(navigatePortableSettings(expired.options), /deadline/);
  assert.deepEqual(expired.wheels, []); assert.deepEqual(expired.clicks, []);
});

function settingsNavigationDomFixture() {
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const node = (bounds, parentElement = null, style = {}) => ({ bounds, parentElement, isConnected: true, hidden: false, inert: false,
    style: { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible', ...style },
    clientLeft: 0, clientTop: 0, offsetWidth: bounds.width, offsetHeight: bounds.height,
    clientWidth: bounds.width, clientHeight: bounds.height, scrollTop: 0, scrollHeight: bounds.height,
    getBoundingClientRect() { return { ...this.bounds }; }, closest() { return null; },
    contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false; } });
  const card = node(box(90, 60, 1180, 670)), content = node(box(100, 200, 1150, 530), card, { overflowY: 'auto' });
  const target = node(box(220, 640, 980, 160), content, { overflowY: 'auto' });
  const nested = node(box(100, 200, 1150, 530), content, { overflowY: 'auto' }); nested.scrollHeight = 2000;
  card.id = 'settings-original'; content.scrollHeight = 1600; target.scrollHeight = 661;
  const config = { coverTarget: false, wheelHit: null, duplicate: false };
  card.querySelectorAll = () => [content]; card.querySelector = () => ({ dataset: { state: 'preview' } });
  const inBox = (b, x, y) => x >= b.left && x < b.right && y >= b.top && y < b.bottom;
  const document = { activeElement: target,
    querySelectorAll: selector => selector === '.egd-settings-card' ? [card] : config.duplicate ? [target, target] : [target],
    elementFromPoint(x, y) {
      if (!inBox(content.bounds, x, y)) return null;
      if (x < 120 || x > 1230) return config.wheelHit === 'nested' ? nested : config.wheelHit === 'overlay' ? {} : content;
      if (inBox(target.bounds, x, y)) return config.coverTarget ? {} : target;
      return content;
    } };
  const harness = { evaluateChrome: source => new Function('document', 'innerWidth', 'innerHeight', 'getComputedStyle', `return (${source})();`)(
    document, 1280, 800, value => value.style) };
  return { card, content, target, config, observe: () => observePortableSettingsNavigation(harness, INSTRUCTIONS, card.id) };
}

test('Settings observer finds an outer-padding wheel point and requires the entire target to clear ancestor clipping', async () => {
  const h = settingsNavigationDomFixture();
  const clipped = await h.observe();
  assert.equal(clipped.owned, true); assert.equal(clipped.focused, true); assert.equal(clipped.targetReady, false);
  assert.deepEqual(clipped.wheelPoint, { x: 112, y: 465 });
  h.target.bounds.top = 300; h.target.bounds.bottom = 460;
  const clear = await h.observe(); assert.equal(clear.targetReady, true); assert.deepEqual(clear.point, { x: 710, y: 380 });
  h.config.coverTarget = true; assert.equal((await h.observe()).targetReady, false);
  h.config.duplicate = true; assert.equal((await h.observe()).owned, false);
});

test('Settings observer refuses wheel points owned by a nested scroller, popup or hidden Settings', async () => {
  const h = settingsNavigationDomFixture();
  for (const hit of ['nested', 'overlay']) {
    h.config.wheelHit = hit; assert.equal((await h.observe()).wheelPoint, null);
  }
  h.card.style.visibility = 'hidden'; assert.equal((await h.observe()).contentVisible, false);
});

test('portable callsite uses point/wheel APIs and contains no UID-click or Tab navigation fallback', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-portable-transfer-flow.mjs', import.meta.url), 'utf8');
  assert.match(source, /await harness\.clickPoint\(point\)/);
  assert.match(source, /wheelAt: input => harness\.wheelAt\(input\)/);
  assert.doesNotMatch(source, /harness\.click\(|press\('Tab'\)|key\(direction\)|Shift\+Tab/);
});

test('Settings notice captures reveal the exact subject rather than its adjacent action row', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-portable-transfer-flow.mjs', import.meta.url), 'utf8');
  const status = source.slice(source.indexOf('const captureStatus ='), source.indexOf('const noReplay ='));
  assert.match(status, /await reach\(testid\('transfer-status'\)\)/);
  assert.doesNotMatch(status, /settings-agent-import/);
  for (const stage of ['profile-visible-draft-version-2', 'visible-version-2-with-stored-head-3']) {
    const before = source.slice(0, source.indexOf(`await capture('${stage}'`));
    assert.ok(before.includes("await reach(testid('transfer-export-target'))"));
    assert.ok(before.lastIndexOf("await reach(testid('transfer-export-target'))") > before.lastIndexOf('await capture('));
  }
  assert.match(source, /assert\.equal\(ui\.detailId, selectedVersion\.detailId/);
  assert.match(source, /assert\.deepEqual\(ui\.target, selectedVersion\.target/);
  assert.match(source, /assert\.deepEqual\(ui\.target, proof\.visibleAfterAdvance\.target/);
  assert.match(source, /await captureStatus\('profile-write-unknown-no-retry'\)/);
});

fixtureTest('store receipt assertions reject changed Board head, unexpected activation, provider or output injection', t => {
  const fixture = setup(t), before = fixture.snapshot();
  assert.equal(assertPortableStoreInvariant(before, before), true);
  const variants = [state => state.persisted.desk.boards[0].head_revision++,
    state => state.persisted.profiles.records[0].active_revision = 2,
    state => state.providerTurns++, state => state.currentImportSha256 = 'changed',
    state => state.requests.push({ method: 'POST', path: '/chat/send', status: 403 }),
    state => state.requests.push({ method: 'PUT', path: '/v1/desk/current', status: 200 })];
  for (const alter of variants) {
    const after = structuredClone(before); alter(after); assert.throws(() => assertPortableStoreInvariant(before, after));
  }
});

async function attachmentExport(t) {
  const fixture = setup(t), before = fixture.snapshot();
  const packet = await request(fixture, 'GET', `/v1/boards/${before.seed.boardId}/export?format=json-canvas`);
  assert.equal(packet.status, 200);
  const state = fixture.snapshot(), converted = state.requests.at(-1);
  assert.equal(assertPortableStoreInvariant(before, state), true);
  // Assertion-only UI input: this is not evidence of a native painted notice.
  const ui = { boardDialog: { state: 'saved', notes: [{ text: '첨부·캡처 1개의 원본은 제외하고 이름만 포함했습니다.' }] } };
  return { state, converted, ui };
}

fixtureTest('real saved-head converter excludes attachment records on the named node with an empty omission report', async t => {
  const { state, converted, ui } = await attachmentExport(t);
  assert.deepEqual(converted.response.report.omitted, []);
  assert.deepEqual(converted.response.canvas.nodes.find(node => node.id === 'qa-file').egdesk,
    { kind: 'card', type: 'file', omitted: 'attachment' });
  assert.equal(assertPortableAttachmentOmission(state, converted, ui), true);
});

fixtureTest('attachment proof rejects wrong or absent original node; unrelated report entries cannot substitute', async t => {
  const { state, converted, ui } = await attachmentExport(t);
  const variants = [row => { row.delegated = false; }, row => { row.method = 'POST'; },
    row => { row.path = '/v1/boards/another-board/export'; }, row => { row.status = 404; },
    row => { row.query = '?format=other'; },
    row => { row.response.canvas.nodes.find(node => node.id === 'qa-file').id = 'other-file'; },
    row => { row.response.canvas.nodes.push(structuredClone(row.response.canvas.nodes.find(node => node.id === 'qa-file'))); row.response.report.nodes++; },
    row => { row.response.canvas.nodes.find(node => node.id === 'qa-file').text = '파일 카드 · another file'; },
    row => { row.response.canvas.nodes.find(node => node.id === 'qa-file').type = 'file'; },
    row => { delete row.response.canvas.nodes.find(node => node.id === 'qa-file').egdesk.omitted; },
    row => { row.response.canvas.nodes.find(node => node.id === 'qa-file').egdesk.type = 'result'; }];
  for (const alter of variants) {
    const changed = structuredClone(converted);
    changed.response.report.omitted.push({ id: 'unrelated-shape', kind: 'shape', reason: 'freehand' });
    alter(changed);
    assert.throws(() => assertPortableAttachmentOmission(state, changed, ui));
  }
});

fixtureTest('attachment proof rejects original path or text leaks and missing or inaccurate exclusion notice', async t => {
  const { state, converted, ui } = await attachmentExport(t);
  const variants = [row => { row.response.canvas.nodes.find(node => node.id === 'qa-file').egdesk.sourceRef = { path: state.seed.importPath }; },
    row => { row.response.canvas.nodes.find(node => node.id === 'qa-file').runtimeState = { text: state.seed.importText }; },
    row => { row.response.canvas.egdesk.leakedPath = state.seed.importPath; },
    row => { row.response.canvas.egdesk.leakedRoot = state.seed.importPath.slice(0, state.seed.importPath.lastIndexOf('/')); },
    row => { row.response.canvas.nodes.find(node => node.id === 'qa-result').text += state.seed.importText; },
    row => { row.response.report.nodes++; }];
  for (const alter of variants) {
    const changed = structuredClone(converted); alter(changed);
    assert.throws(() => assertPortableAttachmentOmission(state, changed, ui));
  }
  for (const text of ['', '첨부·캡처 원본은 기본적으로 제외됩니다.', '첨부·캡처 2개의 원본은 제외하고 이름만 포함했습니다.']) {
    assert.throws(() => assertPortableAttachmentOmission(state, converted, { boardDialog: { state: 'saved', notes: [{ text }] } }));
  }
});

fixtureTest('import proof reads real preview and confirmed SQLite draft with exact original Markdown', async t => {
  const fixture = setup(t), before = fixture.snapshot();
  const body = { text: before.seed.importText, filename: before.seed.importFilename };
  const preview = await request(fixture, 'POST', '/profiles/import', { ...body, dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(assertPortableStoreInvariant(before, fixture.snapshot()), true);
  const commit = await request(fixture, 'POST', '/profiles/import', { ...body, dryRun: false });
  assert.equal(commit.status, 201);
  const after = fixture.snapshot(), id = assertPortableImportedDraft(before, after);
  assert.notEqual(id, before.seed.profileId);
  const changed = structuredClone(after); changed.requests.find(row => row.request?.dryRun === false).request.textSha256 = 'substituted';
  assert.throws(() => assertPortableImportedDraft(before, changed));
  await request(fixture, 'POST', '/profiles/import', { ...body, dryRun: false });
  assert.throws(() => assertPortableImportedDraft(before, fixture.snapshot()), /strictly equal|exactly|profiles/);
});

fixtureTest('pinned-export validator checks actual new head and exact old revision bytes; unit files are not UI proof', async t => {
  const fixture = setup(t), before = fixture.snapshot();
  const target = { profileId: before.seed.profileId, revision: '2', source: 'draft', text: '내보낼 Agent: Owned QA portable profile · 초안 버전 2' };
  assert.equal((await request(fixture, 'POST', '/__qa/portable-transfer/control', { operation: 'advance-profile-head', expectedHeadRevision: 2 })).status, 200);
  const packet = await request(fixture, 'GET', `/profiles/${before.seed.profileId}/export?format=md&revision=2`);
  assert.equal(packet.status, 200);
  // Pure assertion fixture only. The attach-only verifier never writes exports.
  fs.writeFileSync(path.join(before.exportsDir, 'owned-pinned-v2.md'), packet.value.text, { flag: 'wx', mode: 0o600 });
  const after = fixture.snapshot();
  assert.equal(assertPortablePinnedExport(before, after, { target }, { target }, 'owned-pinned-v2.md'), true);
  assert.throws(() => assertPortablePinnedExport(before, after, { target }, { target: { ...target, revision: '3' } }, 'owned-pinned-v2.md'));
  assert.throws(() => assertPortableExportFile(after, 'owned-pinned-v2.md', `${packet.value.text}changed`));
});

fixtureTest('unknown/no-replay receipt validator rejects repeat export, file change and reenabled action', t => {
  const fixture = setup(t), before = fixture.snapshot();
  const sample = () => ({ state: structuredClone(before), ui: { transferState: 'unknown', transferButtons: [{ disabled: true }] } });
  assert.equal(assertPortableNoReplay(before, [sample(), sample(), sample()], 'unknown'), true);
  const variants = [row => row.state.requests.push({ path: `/profiles/${before.seed.profileId}/export`, delegated: true }),
    row => row.state.pickerResults.push({}), row => row.state.exports.push({ name: 'unexpected' }),
    row => row.ui.transferButtons[0].disabled = false, row => row.ui.transferState = 'saved'];
  for (const alter of variants) {
    const samples = [sample(), sample(), sample()]; alter(samples[2]);
    assert.throws(() => assertPortableNoReplay(before, samples, 'unknown'));
  }
});

fixtureTest('missing-head proof requires actual Desk 404 and cannot stand in for a successful UI capture', async t => {
  const fixture = setup(t), before = fixture.snapshot(), boardId = 'owned-native-ui-no-saved-head';
  const read = await request(fixture, 'GET', `/v1/boards/${boardId}`);
  assert.equal(read.status, 404);
  const ui = { boardDialog: { state: 'needs-save', statusText: '먼저 이 Board를 저장한 뒤 다시 내보내세요.' } };
  assert.equal(assertPortableMissingHead(before, fixture.snapshot(), boardId, ui), true);
  assert.throws(() => assertPortableMissingHead(before, before, boardId, ui), /actual Desk handler/);
  assert.throws(() => assertPortableMissingHead(before, fixture.snapshot(), before.seed.boardId, ui));
});

// Assertion/orchestration fixtures only. Their UI values never count as native
// observation or paint evidence; the HTTP/store underneath is the real backend.
async function duplicateFixture(t) {
  const fixture = setup(t), initial = fixture.snapshot(), id = initial.seed.profileId;
  const imported = { text: initial.seed.importText, filename: initial.seed.importFilename };
  assert.equal((await request(fixture, 'POST', '/profiles/import', { ...imported, dryRun: true })).status, 200);
  assert.equal((await request(fixture, 'POST', '/profiles/import', { ...imported, dryRun: false })).status, 201);
  assert.equal((await request(fixture, 'POST', '/__qa/portable-transfer/control',
    { operation: 'advance-profile-head', expectedHeadRevision: 2 })).status, 200);
  for (const format of ['md', 'codex-toml']) {
    assert.equal((await request(fixture, 'GET', `/profiles/${id}/export?format=${format}&revision=2`)).status, 200);
  }
  const before = fixture.snapshot();
  const uiBefore = { detailCount: 1, detailId: id, detailRevision: '2', detailLifecycle: 'draft',
    target: { profileId: id, revision: '2', source: 'draft', text: '내보낼 Agent: Owned QA portable profile · 초안 버전 2' },
    duplicate: { count: 1, profileId: id, revision: '2', state: 'idle', disabled: false },
    transferState: 'unknown', transferButtons: [{ id: 'settings-agent-export-md', disabled: true }],
    agentNotice: '', activeThreadId: 'owned-room', roomAssignments: [
      { id: 'owned-room', agentProfileId: null, profileEnabled: false, conversationId: null },
      { id: 'retained-room', agentProfileId: 'retained-agent', profileEnabled: true, conversationId: 'retained-conversation' },
    ] };
  const commit = async (body = { revision: 2 }) => {
    const packet = await request(fixture, 'POST', `/profiles/${id}/duplicate`, body);
    assert.equal(packet.status, 201);
    const copy = packet.value.profile, uiAfter = structuredClone(uiBefore);
    Object.assign(uiAfter, { detailId: copy.id, detailRevision: '1', detailLifecycle: copy.lifecycle,
      target: { profileId: copy.id, revision: '1', source: 'draft', text: `내보낼 Agent: ${copy.head.body.name} · 초안 버전 1` },
      duplicate: { count: 1, profileId: copy.id, revision: '1', state: 'idle', disabled: false },
      agentNotice: PORTABLE_DUPLICATE_NOTICE, transferState: 'idle', transferButtons: [{ disabled: false }] });
    return { after: fixture.snapshot(), uiAfter, id: copy.id, packet };
  };
  return { fixture, initial, before, uiBefore, commit };
}

fixtureTest('duplicate proof verifies real v2 request, source provenance and new inactive draft v1 while head stays v3', async t => {
  const h = await duplicateFixture(t);
  assert.equal(assertPortableDuplicateReady(h.before, h.uiBefore), true);
  const { after, uiAfter, id } = await h.commit();
  assert.equal(assertPortableDuplicatedDraft(h.before, after, h.uiBefore, uiAfter), id);
  assert.equal(assertPortableStoreInvariant(h.initial, after, { imported: 1, headAdvanced: true, duplicated: 1 }), true);
  assert.throws(() => assertPortableStoreInvariant(h.initial, after, { imported: 1, headAdvanced: true }),
    'Original R7 invariant still refuses a duplicate without the explicit new stage');
  assert.equal(assertPortableDuplicateNoReplay(after, Array.from({ length: 4 }, () => ({ state: after, ui: uiAfter })), h.uiBefore, id), true);
});

fixtureTest('duplicate readiness rejects wrong or ambiguous displayed profile, pending/disabled command and pre-click effects', async t => {
  const h = await duplicateFixture(t);
  const variants = [x => { x.ui.detailCount = 2; }, x => { x.ui.detailId = 'other'; },
    x => { x.ui.detailRevision = '3'; }, x => { x.ui.detailLifecycle = 'active'; },
    x => { x.ui.target.revision = '3'; }, x => { x.ui.target.source = 'active'; },
    x => { x.ui.duplicate.count = 2; }, x => { x.ui.duplicate.profileId = 'other'; },
    x => { x.ui.duplicate.revision = '3'; }, x => { x.ui.duplicate.state = 'pending'; },
    x => { x.ui.duplicate.disabled = true; }, x => { x.ui.transferState = 'saved'; },
    x => { x.ui.transferButtons[0].disabled = false; }, x => { x.ui.transferButtons = []; },
    x => { x.state.requests.push({ method: 'POST', path: `/profiles/${x.state.seed.profileId}/duplicate`, status: 403 }); },
    x => { x.state.duplicateEvents.push({}); }, x => { x.state.headAdvances[0].revision = 2; }];
  for (const alter of variants) {
    const x = { state: structuredClone(h.before), ui: structuredClone(h.uiBefore) }; alter(x);
    assert.throws(() => assertPortableDuplicateReady(x.state, x.ui));
  }
});

fixtureTest('duplicate validator rejects missing pin, head-v3 copy, extra fields, forged receipt and unrelated writes', async t => {
  const h = await duplicateFixture(t), { after, uiAfter, id } = await h.commit();
  const call = state => state.requests.find(row => row.path.endsWith('/duplicate'));
  const variants = [state => { call(state).request = {}; }, state => { call(state).request.revision = 3; },
    state => { call(state).request.name = 'replacement'; }, state => { call(state).requestSha256 = 'wrong'; },
    state => { call(state).query = '?revision=2'; }, state => { call(state).delegated = false; },
    state => { call(state).requestTruncated = true; }, state => { call(state).status = 200; },
    state => { call(state).response.id = state.seed.profileId; },
    state => { call(state).response.profile.activeRevision = 1; },
    state => { call(state).response.profile.headRevision = 2; },
    state => { state.duplicateEvents[0].sourceHash = 'head-3-hash'; },
    state => { state.duplicateEvents[0].sourceRevision = 3; },
    state => { state.persisted.profiles.records.find(row => row.id === id).active_revision = 1; },
    state => { state.persisted.profiles.records.find(row => row.id === state.seed.profileId).updated_at++; },
    state => { state.persisted.profiles.revisions.find(row => row.profile_id === id).body_json =
      JSON.stringify(state.seed.revisions[0].body); },
    state => { state.exports.push({ name: 'unexpected.md' }); },
    state => { state.requests.push({ sequence: 999, method: 'POST', path: `/profiles/${id}/activate`, status: 403 }); }];
  for (const alter of variants) {
    const changed = structuredClone(after); alter(changed);
    assert.throws(() => assertPortableDuplicatedDraft(h.before, changed, h.uiBefore, uiAfter));
  }
  // Actual backend defaults select head v3 when revision is absent: a real
  // successful creation is not enough to satisfy the visible-v2 proof.
  const other = await duplicateFixture(t), latest = await other.commit({});
  assert.equal(latest.after.duplicateEvents[0].sourceRevision, 3);
  assert.throws(() => assertPortableDuplicatedDraft(other.before, latest.after, other.uiBefore, latest.uiAfter));
  await h.commit();
  assert.throws(() => assertPortableDuplicatedDraft(h.before, h.fixture.snapshot(), h.uiBefore, uiAfter));
});

fixtureTest('duplicate UI/no-replay proof refuses original detail, changed room, inaccurate notice and a later second request', async t => {
  const h = await duplicateFixture(t), { after, uiAfter, id } = await h.commit();
  for (const alter of [ui => { ui.detailId = h.before.seed.profileId; }, ui => { ui.detailCount = 2; },
    ui => { ui.detailRevision = '2'; }, ui => { ui.detailLifecycle = 'active'; },
    ui => { ui.target.revision = '2'; }, ui => { ui.target.text = ''; },
    ui => { ui.duplicate.profileId = 'other'; }, ui => { ui.duplicate.state = 'pending'; },
    ui => { ui.agentNotice = '완료'; }, ui => { ui.activeThreadId = 'other-room'; },
    ui => { ui.roomAssignments[0].agentProfileId = id; }, ui => { ui.roomAssignments.pop(); }]) {
    const changed = structuredClone(uiAfter); alter(changed);
    assert.throws(() => assertPortableDuplicateUi(h.uiBefore, changed, id));
  }
  const sample = () => ({ state: structuredClone(after), ui: structuredClone(uiAfter) });
  for (const alter of [x => { x.state.requests.push({ method: 'POST', path: '/profiles/other/duplicate' }); },
    x => { x.state.requests.push({ method: 'POST', path: '/profiles/import' }); },
    x => { x.state.duplicateEvents.push({}); }, x => { x.state.exports.push({}); },
    x => { x.state.persisted.profiles.records[0].active_revision = 1; },
    x => { x.ui.roomAssignments[0].profileEnabled = true; }]) {
    const samples = [sample(), sample(), sample()]; alter(samples[2]);
    assert.throws(() => assertPortableDuplicateNoReplay(after, samples, h.uiBefore, id));
  }
});

async function duplicateStageFixture(t) {
  const h = await duplicateFixture(t), actions = [], checks = [];
  let ui = structuredClone(h.uiBefore), clicks = 0;
  const options = { readState: async () => h.fixture.snapshot(), readUi: async () => structuredClone(ui),
    reach: async selector => { actions.push(['reach', selector]); },
    capture: async (stage, subjects) => { actions.push(['capture', stage, subjects]); },
    check: (name, passed) => { assert.equal(passed, true, name); checks.push(name); },
    click: async selector => {
      assert.equal(h.fixture.snapshot().duplicateEvents.length, 0, 'No backend mutation before injected click');
      clicks++; actions.push(['click', selector]); ui = (await h.commit()).uiAfter;
    },
    waitUi: async predicate => { assert.equal(predicate(ui), true); return structuredClone(ui); },
    pause: async () => {}, assertDeadline() {} };
  return { ...h, actions, checks, options, clicks: () => clicks, ui: () => ui };
}

fixtureTest('duplicate stage preserves all earlier transfer checks, pins the native command once, and captures exact notices', async t => {
  const h = await duplicateStageFixture(t), proof = await runPortableDuplicateCase(h.options);
  assert.equal(h.clicks(), 1); assert.equal(proof.samples.length, 4); assert.equal(h.checks.length, 4);
  const selector = `[data-testid="settings-agent-duplicate"][data-profile-id="${h.before.seed.profileId}"][data-revision="2"][data-state="idle"]`;
  assert.deepEqual(h.actions.slice(0, 3), [['reach', selector],
    ['capture', 'profile-duplicate-v2-command', [{ selector, text: '복제해서 새로 만들기' }]], ['click', selector]]);
  assert.deepEqual(h.actions.slice(3).map(row => row.slice(0, 2)), [
    ['reach', '[data-testid="settings-agent-notice"]'], ['capture', 'profile-duplicate-created-notice'],
    ['reach', '[data-testid="transfer-export-target"]'], ['capture', 'profile-duplicate-draft-version-1'],
  ]);
  assert.equal(h.fixture.snapshot().duplicateEvents.length, 1);
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-portable-transfer-flow.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('proof.duplicate = await runPortableDuplicateCase');
  assert.ok(start > source.indexOf("await noReplay('unknown')"));
  assert.ok(start > source.indexOf("check('actual collision preserves the existing bytes'"));
  const stage = source.slice(source.indexOf('export async function runPortableDuplicateCase'), source.indexOf('export async function runCli'));
  assert.doesNotMatch(stage, /loopbackJson|fetch\(|profileRequest|\.click\(|\.focus\(|scrollIntoView/);
});

fixtureTest('duplicate stage aborts stale bindings or deadline before click; ambiguous input is never replayed', async t => {
  for (const alter of [h => { h.ui().detailRevision = '3'; }, h => { h.ui().duplicate.disabled = true; },
    h => { h.ui().activeThreadId = 'changed-room'; }, h => { h.ui().roomAssignments[0].agentProfileId = 'another'; }]) {
    const h = await duplicateStageFixture(t);
    h.options.capture = async () => { alter(h); };
    await assert.rejects(runPortableDuplicateCase(h.options));
    assert.equal(h.clicks(), 0); assert.deepEqual(h.fixture.snapshot().duplicateEvents, []);
  }
  const expired = await duplicateStageFixture(t);
  expired.options.assertDeadline = () => { throw new Error('deadline'); };
  await assert.rejects(runPortableDuplicateCase(expired.options), /deadline/);
  assert.equal(expired.clicks(), 0);
  const ambiguous = await duplicateStageFixture(t), click = ambiguous.options.click;
  ambiguous.options.click = async (...args) => { await click(...args); throw new Error('input receipt lost'); };
  await assert.rejects(runPortableDuplicateCase(ambiguous.options), /input receipt lost/);
  assert.equal(ambiguous.clicks(), 1); assert.equal(ambiguous.fixture.snapshot().duplicateEvents.length, 1);
});

fixtureTest('R8 exact blocked Desk autosaves can intervene before and after duplication without weakening profile write counts', async t => {
  const h = await duplicateFixture(t);
  const autosave = () => request(h.fixture, 'PUT', '/v1/desk/current', { state: { cards: ['must-not-save'] }, parentGeneration: 1 });
  assert.equal((await autosave()).status, 403);
  const { after, uiAfter, id } = await h.commit();
  assert.equal(assertPortableDuplicatedDraft(h.before, after, h.uiBefore, uiAfter), id);
  const samples = [];
  for (let n = 0; n < 4; n++) {
    assert.equal((await autosave()).status, 403);
    samples.push({ state: h.fixture.snapshot(), ui: uiAfter });
  }
  assert.equal(assertPortableDuplicateNoReplay(after, samples, h.uiBefore, id), true);
  assert.equal(assertPortableRejectedDeskAutosaves(h.before, samples.at(-1).state), true);
  assert.deepEqual(samples.at(-1).state.persisted, after.persisted, 'The real rejected route cannot save anything');
  assert.equal(samples.at(-1).state.duplicateEvents.length, 1);
  assert.equal(samples.at(-1).state.requests.filter(row => row.path.endsWith('/duplicate')).length, 1);
  for (const alter of [state => { state.requests = state.requests.filter(row => row.sequence !== after.requests.find(row => row.method === 'PUT').sequence); },
    state => { state.requests.findLast(row => row.method === 'PUT').sequence = 1; }]) {
    const changed = structuredClone(samples.at(-1).state); alter(changed);
    assert.throws(() => assertPortableDuplicateNoReplay(after,
      Array.from({ length: 3 }, () => ({ state: changed, ui: uiAfter })), h.uiBefore, id));
  }
  // A real denied activation is still an unwanted attempt, not another
  // harmless autosave. This must fail even though SQLite stays unchanged.
  assert.equal((await request(h.fixture, 'POST', `/profiles/${id}/activate`, { revision: 1 })).status, 403);
  const activated = h.fixture.snapshot();
  assert.deepEqual(activated.persisted, after.persisted);
  assert.throws(() => assertPortableDuplicateNoReplay(after, [...samples, { state: activated, ui: uiAfter }], h.uiBefore, id));
  assert.throws(() => assertPortableDuplicatedDraft(h.before, activated, h.uiBefore, uiAfter));
});

fixtureTest('Desk autosave exception refuses successful, delegated, wrong-query, wrong-code or database-mutating requests', async t => {
  const h = await duplicateFixture(t), { after, uiAfter, id } = await h.commit();
  assert.equal((await request(h.fixture, 'PUT', '/v1/desk/current', {})).status, 403);
  const blocked = h.fixture.snapshot();
  const put = state => state.requests.find(row => row.method === 'PUT');
  for (const alter of [state => { put(state).status = 200; }, state => { put(state).status = 500; },
    state => { put(state).delegated = true; }, state => { put(state).query = '?overwrite=1'; },
    state => { put(state).code = 'OTHER_ERROR'; }, state => { delete put(state).code; },
    state => { put(state).response = { saved: true }; }, state => { put(state).sequence = 0; },
    state => { state.persisted.desk.boards[0].head_revision++; },
    state => { state.persisted.desk.generations[0].state_hash = 'changed'; },
    state => { state.profile = 'other-profile'; }, state => { state.root = 'other-root'; }]) {
    const changed = structuredClone(blocked); alter(changed);
    assert.throws(() => assertPortableRejectedDeskAutosaves(after, changed));
    assert.throws(() => assertPortableDuplicateNoReplay(after,
      Array.from({ length: 3 }, () => ({ state: changed, ui: uiAfter })), h.uiBefore, id));
  }
  // Even a denied mutation with no forbiddenPosts receipt cannot disappear
  // through a broad failed-request allowance. Only exact Desk PUT is excluded.
  for (const [method, path] of [['POST', `/profiles/${id}/activate`], ['POST', '/profiles/import'],
    ['POST', `/profiles/${id}/duplicate`], ['PATCH', '/rooms/owned-room'],
    ['PUT', '/v1/desk/other'], ['POST', '/v1/desk/current'], ['PUT', '/v1/boards/other']]) {
    const changed = structuredClone(blocked); Object.assign(put(changed), { method, path });
    assert.throws(() => assertPortableDuplicateNoReplay(after,
      Array.from({ length: 3 }, () => ({ state: changed, ui: uiAfter })), h.uiBefore, id));
  }
});

fixtureTest('duplicate stage tolerates only real rejected Desk PUT during post-click observation, not another click or write', async t => {
  const h = await duplicateStageFixture(t);
  let pauses = 0;
  h.options.pause = async () => {
    pauses++;
    assert.equal((await request(h.fixture, 'PUT', '/v1/desk/current', { state: { cards: [] }, parentGeneration: 1 })).status, 403);
  };
  const proof = await runPortableDuplicateCase(h.options);
  assert.equal(h.clicks(), 1); assert.equal(pauses, 4);
  assert.equal(proof.samples.at(-1).state.requests.filter(row => row.method === 'PUT').length, 4);
  assert.equal(proof.samples.at(-1).state.duplicateEvents.length, 1);
  assert.deepEqual(proof.samples.at(-1).state.persisted, proof.after.persisted);
  assert.match(h.checks.at(-1), /Desk autosave.*rejected.*SQLite unchanged/);
});

async function unknownFixture(t) {
  const h = await duplicateFixture(t), success = await h.commit();
  const source = success.after.persisted.profiles.revisions.find(row => row.profile_id === h.before.seed.profileId && row.revision === 3);
  const target = { profileId: h.before.seed.profileId, revision: 3, hash: source.hash };
  const before = h.fixture.snapshot(), uiBefore = structuredClone(h.uiBefore);
  Object.assign(uiBefore, { settingsId: 'settings-owned', detailRevision: '3', transferState: 'idle',
    target: { ...uiBefore.target, revision: '3', text: '내보낼 Agent: Owned QA portable profile · 초안 버전 3' },
    duplicate: { ...uiBefore.duplicate, revision: '3' } });
  const arm = async value => {
    const packet = await request(h.fixture, 'POST', '/__qa/portable-transfer/control', { operation: 'arm-duplicate-receipt-fault', ...value });
    assert.equal(packet.status, 200); return packet.value;
  };
  const commit = async () => {
    const packet = await request(h.fixture, 'POST', `/profiles/${target.profileId}/duplicate`, { revision: 3 });
    assert.equal(packet.status, 201); assert.equal(packet.value.profile, null);
    const uiAfter = { ...structuredClone(uiBefore), agentNotice: PORTABLE_DUPLICATE_UNKNOWN_NOTICE,
      duplicate: { ...uiBefore.duplicate, state: 'unknown', disabled: true } };
    return { after: h.fixture.snapshot(), uiAfter, id: packet.value.id };
  };
  return { ...h, success, before, target, uiBefore, arm, commit };
}

fixtureTest('unknown receipt proof requires real creation, exact synthetic provenance and original displayed v3 identity', async t => {
  const h = await unknownFixture(t); await h.arm(h.target);
  const { after, uiAfter, id } = await h.commit();
  assert.equal(assertPortableUnknownCreated(h.before, after, h.uiBefore, uiAfter, h.target), id);
  const samples = Array.from({ length: 4 }, () => ({ state: after, ui: uiAfter }));
  assert.equal(assertPortableUnknownNoReplay(after, samples, h.uiBefore, h.target), true);
  for (const alter of [state => { state.receiptFaults[0].synthetic = false; },
    state => { state.receiptFaults[0].sourceRevision = 2; }, state => { state.duplicateReceiptFault.state = 'armed'; },
    state => { state.requests.findLast(row => row.path.endsWith('/duplicate')).deliveredResponse.profile = {}; },
    state => { state.requests.findLast(row => row.path.endsWith('/duplicate')).deliveredResponseBytes++; },
    state => { state.requests.findLast(row => row.path.endsWith('/duplicate')).response.profile.activeRevision = 1; },
    state => { state.persisted.profiles.records.find(row => row.id === id).active_revision = 1; },
    state => { state.duplicateEvents.pop(); }]) {
    const changed = structuredClone(after); alter(changed);
    assert.throws(() => assertPortableUnknownCreated(h.before, changed, h.uiBefore, uiAfter, h.target));
  }
  for (const alter of [ui => { ui.duplicate.disabled = false; }, ui => { ui.duplicate.state = 'idle'; },
    ui => { ui.detailId = id; }, ui => { ui.agentNotice = PORTABLE_DUPLICATE_NOTICE; },
    ui => { ui.target.revision = '2'; }, ui => { ui.settingsId = 'other-settings'; },
    ui => { ui.roomAssignments[0].agentProfileId = id; }]) {
    const changed = structuredClone(uiAfter); alter(changed);
    assert.throws(() => assertPortableUnknownUi(h.uiBefore, changed, h.target));
  }
  assert.equal((await request(h.fixture, 'PUT', '/v1/desk/current', {})).status, 403);
  assert.equal(assertPortableUnknownNoReplay(after,
    Array.from({ length: 3 }, () => ({ state: h.fixture.snapshot(), ui: uiAfter })), h.uiBefore, h.target), true);
  await request(h.fixture, 'POST', `/profiles/${h.target.profileId}/duplicate`, { revision: 3 });
  assert.throws(() => assertPortableUnknownNoReplay(after,
    Array.from({ length: 3 }, () => ({ state: h.fixture.snapshot(), ui: uiAfter })), h.uiBefore, h.target));
});

test('disabled duplicate probe requires exact unknown binding, fresh complete geometry and one unretried native point', async () => {
  const target = { profileId: 'prof-original', revision: 3, hash: 'a'.repeat(64) };
  const uiBefore = { settingsId: 'settings-owned', target: { profileId: target.profileId, revision: '3' }, roomAssignments: [], activeThreadId: null };
  const ui = { ...uiBefore, detailCount: 1, detailId: target.profileId, detailRevision: '3', detailLifecycle: 'draft',
    duplicate: { count: 1, profileId: target.profileId, revision: '3', state: 'unknown', disabled: true }, agentNotice: PORTABLE_DUPLICATE_UNKNOWN_NOTICE };
  const selector = '[data-testid="settings-agent-duplicate"][data-profile-id="prof-original"][data-revision="3"][data-state="unknown"]';
  const value = { selector, settingsId: uiBefore.settingsId, owned: true, cards: 1, contents: 1, count: 1,
    testid: 'settings-agent-duplicate', profileId: target.profileId, revision: '3', duplicateState: 'unknown', disabled: true, readOnly: false,
    contentVisible: true, targetVisible: true, targetPaintReady: true, targetRect: { top: 10 }, targetClip: { top: 0 },
    viewport: { top: 0 }, scrollTop: 2, point: { x: 300, y: 200 } };
  let clicks = 0;
  const options = { selector, target, uiBefore, readUi: async () => structuredClone(ui), readTarget: async () => structuredClone(value),
    clickPoint: async () => { clicks++; }, assertDeadline() {} };
  await probePortableDisabledDuplicate(options); assert.equal(clicks, 1);
  for (const alter of [v => { v.disabled = false; }, v => { v.readOnly = true; }, v => { v.targetPaintReady = false; },
    v => { v.profileId = 'other'; }, v => { v.revision = '2'; }, v => { v.duplicateState = 'pending'; },
    v => { v.count = 2; }, v => { v.owned = false; }, v => { v.settingsId = 'other'; }]) {
    clicks = 0;
    await assert.rejects(probePortableDisabledDuplicate({ ...options, readTarget: async () => { const v = structuredClone(value); alter(v); return v; } }));
    assert.equal(clicks, 0);
  }
  let reads = 0; clicks = 0;
  await assert.rejects(probePortableDisabledDuplicate({ ...options, readTarget: async () => {
    const v = structuredClone(value); if (++reads === 2) v.point.x++; return v;
  } })); assert.equal(clicks, 0);
  await assert.rejects(probePortableDisabledDuplicate({ ...options, clickPoint: async () => { clicks++; throw new Error('ambiguous'); } }), /ambiguous/);
  assert.equal(clicks, 1);
});

test('disabled-only navigation never relaxes ordinary target or wrong-profile safety', async () => {
  const target = { profileId: 'prof-original', revision: 3 };
  const make = () => {
    const h = settingsNavigationFixture({ selector: '[data-testid="settings-agent-duplicate"]', transferState: 'idle' });
    const read = h.options.read;
    h.options.read = async () => { const v = await read(); return { ...v, targetPaintReady: v.targetReady, targetReady: false,
      testid: 'settings-agent-duplicate', profileId: target.profileId, revision: '3', duplicateState: 'unknown', disabled: true, readOnly: false }; };
    h.options.focus = false; return h;
  };
  const normal = make(); await assert.rejects(navigatePortableSettings(normal.options)); assert.deepEqual(normal.wheels, []);
  const allowed = make(); const result = await navigatePortableSettings({ ...allowed.options, disabledDuplicate: target });
  assert.equal(result.targetReady, true); assert.ok(allowed.wheels.length > 0); assert.deepEqual(allowed.clicks, []);
  const wrong = make(); await assert.rejects(navigatePortableSettings({ ...wrong.options, disabledDuplicate: { ...target, profileId: 'other' } }));
  assert.deepEqual(wrong.wheels, []);
});

fixtureTest('unknown stage selects original via clicks, arms exact displayed v3, creates once, and probes disabled without a POST', async t => {
  const h = await unknownFixture(t), actions = [], checks = [];
  let ui = { ...h.success.uiAfter, settingsId: h.uiBefore.settingsId }, posts = 0, probes = 0;
  const options = { readState: async () => h.fixture.snapshot(), readUi: async () => structuredClone(ui),
    armFault: h.arm, reach: async (selector, options) => { actions.push(['reach', selector, options]); },
    capture: async (stage, subjects) => { actions.push(['capture', stage, subjects]); },
    check: (name, passed) => { assert.equal(passed, true); checks.push(name); },
    waitUi: async predicate => { assert.equal(predicate(ui), true); return structuredClone(ui); },
    click: async selector => {
      actions.push(['click', selector]);
      if (selector.includes('> button.egd-settings-link')) ui = { ...ui, rows: [{ id: h.target.profileId }] };
      else if (selector.includes('settings-agent-row')) ui = structuredClone(h.uiBefore);
      else { posts++; ui = (await h.commit()).uiAfter; }
    }, retryDisabled: async (selector, target, before) => {
      probes++; assert.match(selector, /data-state="unknown"/); assert.deepEqual(target, h.target);
      assertPortableUnknownUi(before, ui, target); // orchestration test only, not native proof
    }, pause: async () => {}, assertDeadline() {} };
  const proof = await runPortableDuplicateUnknownCase(options);
  assert.equal(posts, 1); assert.equal(probes, 1); assert.equal(checks.length, 2);
  assert.equal(proof.samples.length, 4); assert.equal(proof.after.receiptFaults.length, 1);
  assert.equal(proof.after.duplicateEvents.length, 2, 'One earlier success plus one unknown-result creation');
  assert.ok(actions.some(row => row[0] === 'reach' && row[2]?.disabledDuplicate?.revision === 3));
  assert.match(proof.faultScope, /no network\/SSE fault/);
});

async function draftBackend(t, active = false) {
  let fixture;
  if (active) fixture = setup(t, { EGDESK_QA_PORTABLE_TRANSFER_PROFILE_VERSION: 'head3-active2' });
  else {
    const h = await unknownFixture(t); await h.arm(h.target); await h.commit(); fixture = h.fixture;
  }
  const id = fixture.snapshot().seed.profileId;
  const readProfile = async () => {
    const response = await request(fixture, 'GET', `/profiles/${id}`); assert.equal(response.status, 200); return response.value;
  };
  const profile = await readProfile(), before = fixture.snapshot();
  return { fixture, id, profile, before, readProfile };
}

for (const active of [false, true]) fixtureTest(`draft receipts bind actual GET/SQLite and distinguish changed PUT from unchanged revision (${active ? 'setup active2/head3' : 'full-flow inactive head3'})`, async t => {
  const h = await draftBackend(t, active), body = portableDraftExpectedBody(h.profile), route = `/profiles/${h.id}/draft`;
  assert.equal(assertPortableDraftGet(h.before, h.profile), true);
  assert.equal(assertPortableDraftDelta(h.before, h.fixture.snapshot()), true);
  assert.equal((await request(h.fixture, 'OPTIONS', route)).status, 204);
  const payload = { body, expectedRevision: 3 }, changed = await request(h.fixture, 'PUT', route, payload);
  assert.equal(changed.status, 200);
  const profile = await h.readProfile(), after = h.fixture.snapshot();
  assert.equal(assertPortableDraftDelta(h.before, after, { puts: 1, changed: true, body, profile, baseRevision: 3 }), true);
  assert.deepEqual(profile.active, h.profile.active); assert.equal(profile.headRevision, 4);
  assert.equal(profile.activeRevision, active ? 2 : null);
  assert.deepEqual(profile.head.body.personality.examples, [
    { user: 'QA draft question one', reply: 'QA draft answer one.\nKeep active unchanged.' },
    { user: 'QA draft question two', reply: 'QA draft answer two.' },
  ]);
  assert.deepEqual(profile.head.body.personality.avoid, ['QA draft avoid one', 'QA draft avoid two']);
  const noChange = await request(h.fixture, 'PUT', route, { body, expectedRevision: 4 });
  assert.equal(noChange.value.unchanged, true);
  const reopened = await h.readProfile(), unchanged = h.fixture.snapshot();
  assert.equal(assertPortableDraftDelta(after, unchanged, { puts: 1, body, profile: reopened, baseRevision: 4 }), true);
  assert.deepEqual(reopened, profile); assert.deepEqual(unchanged.persisted, after.persisted);
  assert.throws(() => assertPortableDraftDelta(after, unchanged), /actual draft PUT/);
  assert.throws(() => assertPortableDraftDelta(after, unchanged, { puts: 1, changed: true, body, profile: reopened, baseRevision: 4 }));
  if (active) assert.throws(() => assertPortableStoreInvariant(h.before, h.before), /No activation/,
    'The old inactive-only invariant is not weakened to admit a different setup seed');
});

fixtureTest('draft delta rejects forged receipts, wrong base/ID/body, changed old/active rows and every unrelated mutation', async t => {
  const h = await draftBackend(t, true), body = portableDraftExpectedBody(h.profile);
  await request(h.fixture, 'PUT', `/profiles/${h.id}/draft`, { body, expectedRevision: 3 });
  const profile = await h.readProfile(), after = h.fixture.snapshot();
  const options = { puts: 1, changed: true, body, profile, baseRevision: 3 };
  const put = state => state.requests.findLast(row => row.method === 'PUT');
  const get = state => state.requests.findLast(row => row.method === 'GET');
  for (const alter of [state => { put(state).request.expectedRevision = 2; }, state => { put(state).request.extra = true; },
    state => { put(state).path = '/profiles/other/draft'; }, state => { put(state).query = '?alias=1'; },
    state => { put(state).request.body.personality.examples.reverse(); }, state => { put(state).requestTruncated = true; },
    state => { put(state).requestBytes++; }, state => { put(state).requestSha256 = 'wrong'; },
    state => { put(state).response.unchanged = true; }, state => { put(state).responseSha256 = 'wrong'; },
    state => { put(state).response.profile = null; }, state => { put(state).response.hash = 'wrong'; },
    state => { put(state).before.profiles.records[0].lifecycle = 'draft'; }, state => { put(state).after.desk.boards = []; },
    state => { get(state).response.head.body.personality.avoid = []; }, state => { get(state).delegated = false; },
    state => { get(state).sequence = put(state).sequence - 1; }, state => { get(state).responseSha256 = 'wrong'; },
    state => { state.persisted.profiles.records[0].active_revision = 4; },
    state => { state.persisted.profiles.revisions[0].body_json = '{}'; },
    state => { state.persisted.profiles.revisions.at(-1).parent_revision = 1; },
    state => { state.exports.push({ name: 'unexpected' }); }, state => { state.providerTurns = 1; },
    state => { state.requests[0].status = 404; }, state => { state.receiptFaults.push({}); }]) {
    const changed = structuredClone(after); alter(changed);
    assert.throws(() => assertPortableDraftDelta(h.before, changed, options));
  }
  for (const [method, path] of [['POST', '/profiles/import'], ['POST', `/profiles/${h.id}/duplicate`],
    ['POST', `/profiles/${h.id}/activate`], ['POST', '/__qa/portable-transfer/control'], ['PATCH', '/rooms/owned-room'],
    ['GET', '/provider/status'], ['PUT', '/v1/boards/other'], ['OPTIONS', '/profiles/other/draft']]) {
    const changed = structuredClone(after);
    changed.requests.push({ sequence: changed.requests.at(-1).sequence + 1, method, path, query: '', delegated: false, status: 403 });
    assert.throws(() => assertPortableDraftDelta(h.before, changed, options), `${method} ${path}`);
  }
  const noRead = structuredClone(after); noRead.requests.pop();
  assert.throws(() => assertPortableDraftDelta(h.before, noRead, options));
});

// A small UI action model only: no DOM/native/paint acceptance is claimed by
// these tests. Form conversion/validation and HTTP/SQLite are the real product.
async function draftStageFixture(t, active = false) {
  const backend = await draftBackend(t, active), actions = [], checks = [];
  const settingsId = 'settings-owned', assignments = [{ id: 'owned-room', agentProfileId: null, profileEnabled: false, conversationId: null }];
  let profile = backend.profile, form = null, pending = {}, exampleKeys = [], avoidKeys = [], serial = 0;
  let height = 800, focusedId = null, start = 0, end = 0;
  const control = (id, testid, value, { index = null, field = null } = {}) => ({ id, testid, index, field, value, length: value.length,
    truncated: false, disabled: false, readOnly: false, focused: focusedId === id, start: focusedId === id ? start : 0, end: focusedId === id ? end : 0 });
  const ui = () => {
    const shown = profile.active || profile.head;
    const value = { width: 1280, height, settingsId, activeThreadId: 'owned-room', roomAssignments: structuredClone(assignments),
      detailCount: form ? 0 : 1, detailId: form ? null : profile.id, detailRevision: form ? null : String(shown.revision),
      detailLifecycle: form ? null : profile.lifecycle, editor: null,
      target: form ? { profileId: null, revision: null, source: null, text: '' } :
        { profileId: profile.id, revision: String(shown.revision), source: profile.active ? 'active' : 'draft', text: 'unit detail' },
      detailPersonality: { examples: shown.body.personality?.examples || [], avoid: shown.body.personality?.avoid || [] },
      active: { id: focusedId, testid: null, index: null, field: null } };
    if (!form) return value;
    value.editor = { count: 1, owned: true, profileId: null, baseRevision: null, busy: false, busySource: 'save.disabled', errors: '', fieldErrors: [],
      examples: (form.personalityExamples || []).map((row, i) => ({ index: String(i),
        user: control(`user-${exampleKeys[i]}`, 'settings-agent-example-user', row.user, { index: String(i) }),
        reply: control(`reply-${exampleKeys[i]}`, 'settings-agent-example-reply', row.reply, { index: String(i) }) })),
      avoid: (form.personalityAvoid || []).map((text, i) => ({ index: String(i), text: control(`avoid-${avoidKeys[i]}`, 'settings-agent-avoid-text', text, { index: String(i) }) })),
      chips: Object.fromEntries(['traits', 'expertise', 'toolPreferences'].map(field => [field, {
        input: control(`chip-${field}`, 'settings-agent-chip-input', pending[field] || '', { field }), values: [...form[field]],
      }])), tone: `${settingsId}-profile-tone-${form.tone}`, actions: { position: 'sticky', box: { bottom: height - 67 },
        contentViewport: { top: 200, bottom: height - 67, clientHeight: height - 267, scrollHeight: 2000, scrollTop: 400 } } };
    value.editor.exampleCount = value.editor.examples.length; value.editor.avoidCount = value.editor.avoid.length;
    const focused = controls(value).find(item => item.id === focusedId);
    if (focused) value.active = { id: focused.id, testid: focused.testid, index: focused.index, field: focused.field };
    return value;
  };
  const controls = value => value.editor ? [...value.editor.examples.flatMap(row => [row.user, row.reply]), ...value.editor.avoid.map(row => row.text),
    ...Object.values(value.editor.chips).map(chip => chip.input)] : [];
  const match = selector => {
    const testid = selector.match(/data-testid="([^"]+)"/)?.[1], index = selector.match(/data-index="(\d+)"/)?.[1], field = selector.match(/data-field="([^"]+)"/)?.[1];
    return controls(ui()).find(item => item.testid === testid && (index === undefined || item.index === index) && (field === undefined || item.field === field));
  };
  const focus = id => { focusedId = id; const current = controls(ui()).find(item => item.id === id); start = end = current?.value.length || 0; };
  const readProfile = async () => backend.readProfile();
  const options = { readState: async () => backend.fixture.snapshot(), readProfile, readUi: async () => structuredClone(ui()),
    resize: async value => { actions.push(['resize', value]); height = value; },
    reach: async (selector, extra) => { assert.equal(extra, undefined, 'No import-only focus path for editing'); actions.push(['reach', selector]); },
    readTarget: async selector => ({ settingsId, count: 1, owned: true, targetReady: true, targetHits: Array(9).fill(true),
      focused: !!match(selector)?.focused, testid: match(selector)?.testid || selector.match(/data-testid="([^"]+)"/)?.[1] }),
    capture: async (phase, subjects) => { actions.push(['capture', phase, subjects]); },
    check: (name, passed) => { assert.equal(passed, true, name); checks.push(name); },
    waitUi: async predicate => { const value = ui(); assert.equal(predicate(value), true, 'unit action must meet the real wait predicate'); return structuredClone(value); },
    pause: async () => {}, assertDeadline() {},
    press: async (...args) => {
      assert.equal(args.length, 1); actions.push(['press', ...args]);
      const current = controls(ui()).find(item => item.focused); assert.ok(current);
      assert.ok(['meta+a', 'Control+a'].includes(args[0])); start = 0; end = current.value.length;
    },
    typeText: async (...args) => {
      assert.equal(args.length, 1); const text = args[0], current = controls(ui()).find(item => item.focused); assert.ok(current);
      actions.push(['type', text]); assert.equal(start, 0); assert.equal(end, current.value.length);
      if (current.field) pending[current.field] = text;
      else if (current.testid === 'settings-agent-avoid-text') form.personalityAvoid[Number(current.index)] = text;
      else form.personalityExamples[Number(current.index)][current.testid.endsWith('-user') ? 'user' : 'reply'] = text;
      start = end = text.length;
    },
    click: async selector => {
      actions.push(['click', selector]);
      if (selector.includes('.egd-settings-detail-actions')) {
        assert.equal(form, null); form = profileFormFromBody(profile.head.body); pending = {};
        exampleKeys = (form.personalityExamples || []).map(() => ++serial); avoidKeys = (form.personalityAvoid || []).map(() => ++serial); focus(null); return;
      }
      if (selector.includes('settings-agent-cancel')) { assert.ok(form); form = null; profile = await readProfile(); focus(null); return; }
      if (selector.includes('settings-agent-save')) {
        for (const [field, text] of Object.entries(pending)) if (text && !form[field].includes(text)) form[field].push(text);
        const checked = validateProfileForm(form); assert.equal(checked.ok, true, JSON.stringify(checked.errors));
        assert.equal((await request(backend.fixture, 'OPTIONS', `/profiles/${profile.id}/draft`)).status, 204);
        const saved = await request(backend.fixture, 'PUT', `/profiles/${profile.id}/draft`, { body: checked.body, expectedRevision: profile.headRevision });
        assert.equal(saved.status, 200); profile = await readProfile(); form = null; focus(null); return;
      }
      for (const kind of ['example', 'avoid']) {
        const key = kind === 'example' ? 'personalityExamples' : 'personalityAvoid', keys = kind === 'example' ? exampleKeys : avoidKeys;
        if (selector.includes(`settings-agent-${kind}-add`)) {
          (form[key] ||= []).push(kind === 'example' ? { user: '', reply: '' } : ''); keys.push(++serial);
          focus(`${kind === 'example' ? 'user' : 'avoid'}-${keys.at(-1)}`); return;
        }
        if (selector.includes(`settings-agent-${kind}-remove`)) {
          const index = Number(selector.match(/data-index="(\d+)"/)[1]); form[key].splice(index, 1); keys.splice(index, 1);
          focus(`${kind === 'example' ? 'user' : 'avoid'}-${keys[Math.min(index, keys.length - 1)]}`); return;
        }
      }
      if (selector.includes('profile-tone-')) { form.tone = PORTABLE_DRAFT_INPUT.tone; focus(`${settingsId}-profile-tone-${form.tone}`); return; }
      const current = match(selector); assert.ok(current, `unexpected unit native selector: ${selector}`); focus(current.id);
    },
  };
  return { ...backend, options, actions, checks, ui, controls, focus, pending: () => pending, form: () => form };
}

for (const active of [false, true]) fixtureTest(`native draft stage contract: cancel600/save800/reopen600/unchanged800, real backend (${active ? 'active2 setup' : 'original flow'})`, async t => {
  const h = await draftStageFixture(t, active), proof = await runPortableDraftEditCase(h.options);
  assert.deepEqual(h.actions.filter(row => row[0] === 'resize').map(row => row[1]), [600, 800, 600, 800]);
  assert.deepEqual(proof.buttons.map(row => row.height), [600, 800, 600, 800]); assert.equal(proof.samples.length, 4);
  assert.equal(proof.toneDiagnostics.length, 4);
  assert.equal(proof.footerDiagnostics.length, 4); assert.ok(proof.footerDiagnostics.every(row => row.bottomGap === 0));
  assert.equal(proof.lastRowReach.length, 4);
  assert.ok(proof.lastRowReach.every(row => row.target.targetReady && row.target.targetHits.length === 9 && row.target.targetHits.every(Boolean)));
  assert.ok(proof.observations.length <= 24); assert.equal(proof.saved.profile.headRevision, 4);
  assert.equal(proof.saved.profile.activeRevision, active ? 2 : null); assert.deepEqual(proof.saved.profile.active, proof.profileBefore.active);
  assert.equal(proof.cancelled.state.requests.filter(row => row.method === 'PUT' && row.path.endsWith('/draft')).length, 0);
  const puts = proof.unchanged.state.requests.filter(row => row.method === 'PUT' && row.path.endsWith('/draft'));
  assert.equal(puts.length, 2); assert.deepEqual(puts.map(row => row.response.unchanged), [false, true]);
  assert.deepEqual(proof.unchanged.state.persisted, proof.saved.state.persisted);
  assert.deepEqual(proof.populatedCancelled.state.persisted, proof.saved.state.persisted);
  assert.deepEqual(puts[0].request.body.personality.traits, ['QA careful']);
  assert.deepEqual(puts[0].request.body.expertise, ['QA draft review']); assert.deepEqual(puts[0].request.body.toolPreferences, ['qa-readonly']);
  assert.ok(h.actions.filter(row => row[0] === 'press').every(row => row.length === 2 && row[1] !== 'Enter'));
  assert.equal(h.actions.filter(row => row[0] === 'click' && row[1].includes('settings-agent-save')).length, 2);
  assert.deepEqual(proof.samples.at(-1).state.duplicateEvents, proof.before.duplicateEvents);
  assert.ok(proof.observations.some(row => row.phase === 'populated-reopen-opened' && row.ui.editor.exampleCount === 2 && row.ui.editor.avoidCount === 2));
  assert.match(proof.bindingEvidence, /private form.*unexposed/); assert.match(proof.conflict, /excluded/);
});

fixtureTest('draft stage keeps exact rejected Desk autosaves separate from two explicit draft PUT and earlier POST', async t => {
  const h = await draftStageFixture(t), original = h.options.click;
  h.options.click = async selector => {
    await original(selector);
    assert.equal((await request(h.fixture, 'PUT', '/v1/desk/current', {})).status, 403);
  };
  h.options.pause = async () => { assert.equal((await request(h.fixture, 'PUT', '/v1/desk/current', {})).status, 403); };
  const proof = await runPortableDraftEditCase(h.options), state = proof.samples.at(-1).state;
  assert.ok(state.requests.filter(row => row.method === 'PUT' && row.path === '/v1/desk/current').length > 20);
  assert.equal(state.requests.filter(row => row.method === 'PUT' && row.path.endsWith('/draft')).length, 2);
  assert.deepEqual(state.requests.filter(row => row.method === 'POST'), proof.before.requests.filter(row => row.method === 'POST'));
  assert.deepEqual(state.persisted.desk, proof.before.persisted.desk);
});

fixtureTest('draft stage rejects lost pending values/retained focus and never replays ambiguous native save', async t => {
  for (const failure of ['pending', 'focus', 'save-unknown']) {
    const h = await draftStageFixture(t), original = h.options.click;
    h.options.click = async selector => {
      await original(selector);
      if (failure === 'pending' && selector.includes('settings-agent-example-add')) h.pending().traits = '';
      if (failure === 'focus' && selector.includes('settings-agent-example-remove')) h.focus(null);
      if (failure === 'save-unknown' && selector.includes('settings-agent-save')) throw new Error('native result unknown');
    };
    await assert.rejects(runPortableDraftEditCase(h.options));
    const writes = h.fixture.snapshot().requests.filter(row => row.method === 'PUT' && row.path.endsWith('/draft'));
    assert.equal(writes.length, failure === 'save-unknown' ? 1 : 0);
    assert.equal(h.actions.filter(row => row[0] === 'click' && row[1].includes('settings-agent-save')).length, failure === 'save-unknown' ? 1 : 0);
  }
});

fixtureTest('draft input refuses stale/foreign/covered/lost focus or selection before typing, with no retry/fallback', async t => {
  for (const failure of ['deadline', 'foreign', 'covered', 'focus', 'selection', 'native-type']) {
    const h = await draftStageFixture(t), context = h.ui();
    await h.options.click('[data-testid="settings-agent-detail"] .egd-settings-detail-actions > button:first-child');
    h.actions.length = 0;
    const options = { ...h.options, selector: '[data-testid="settings-agent-chip-input"][data-field="traits"]', value: 'owned text',
      validateUi: ui => assertPortableDraftForm(ui, h.profile, context) };
    if (failure === 'deadline') options.assertDeadline = () => { throw new Error('deadline'); };
    if (failure === 'foreign') options.readUi = async () => ({ ...h.ui(), settingsId: 'foreign-card' });
    if (failure === 'covered' || failure === 'focus') options.readTarget = async selector => ({ ...await h.options.readTarget(selector),
      ...(failure === 'covered' ? { targetReady: false } : { focused: false }) });
    if (failure === 'selection') {
      // Nonempty pending text requires a real select-all readback.
      h.pending().traits = 'old text'; options.press = async () => {};
    }
    let types = 0;
    options.typeText = async text => { types++; if (failure === 'native-type') throw new Error('uncertain native typing'); await h.options.typeText(text); };
    await assert.rejects(editPortableDraftInput(options));
    assert.equal(types, failure === 'native-type' ? 1 : 0);
    assert.ok(h.actions.filter(row => row[0] === 'click').length <= 1);
    assert.equal(h.fixture.snapshot().requests.filter(row => row.method === 'PUT' && row.path.endsWith('/draft')).length, 0);
  }
});

fixtureTest('draft form contract rejects ambiguous/oversized rows, errors/busy/changed binding and unavailable controls', async t => {
  const h = await draftStageFixture(t, true), context = h.ui();
  await h.options.click('[data-testid="settings-agent-detail"] .egd-settings-detail-actions > button:first-child');
  const good = h.ui(); assert.equal(assertPortableDraftForm(good, h.profile, context), true);
  for (const alter of [ui => { ui.editor.count = 2; }, ui => { ui.editor.owned = false; }, ui => { ui.editor.busy = true; },
    ui => { ui.editor.errors = 'invalid examples'; }, ui => { ui.editor.fieldErrors = [{ field: 'personalityAvoid' }]; },
    ui => { ui.editor.baseRevision = '2'; }, ui => { ui.editor.profileId = 'wrong'; }, ui => { ui.editor.exampleCount = 4; },
    ui => { ui.editor.avoidCount = 9; }, ui => { ui.editor.examples[0].index = '1'; },
    ui => { ui.editor.examples[0].reply.index = '1'; }, ui => { ui.editor.examples[0].user.truncated = true; },
    ui => { ui.editor.examples[0].reply.length++; }, ui => { ui.editor.avoid[0].text.readOnly = true; },
    ui => { ui.editor.chips.traits.input.disabled = true; }, ui => { ui.editor.actions.position = 'static'; },
    ui => { ui.roomAssignments[0].agentProfileId = h.id; }]) {
    const changed = structuredClone(good); alter(changed); assert.throws(() => assertPortableDraftForm(changed, h.profile, context));
  }
});

test('sticky form footer reduces field reach viewport but not its own buttons or the original import view', async () => {
  const h = settingsNavigationDomFixture(), original = await h.observe();
  const footer = { style: { position: 'sticky' }, getBoundingClientRect: () => ({ left: 120, right: 1230, top: 650, bottom: 710, width: 1110, height: 60 }),
    contains: () => false };
  h.target.closest = selector => selector === '[data-testid="settings-agent-form"]' ? { querySelector: () => footer } : null;
  h.target.bounds = { left: 220, top: 630, right: 1200, bottom: 670, width: 980, height: 40 };
  const clipped = await h.observe(); assert.equal(clipped.viewport.bottom, 650); assert.equal(clipped.targetClip.bottom, 650);
  assert.equal(clipped.targetReady, false); assert.ok(clipped.wheelPoint);
  h.target.bounds.top = 600; h.target.bounds.bottom = 640; assert.equal((await h.observe()).targetReady, true);
  footer.contains = () => true;
  const button = await h.observe(); assert.equal(button.viewport.bottom, original.viewport.bottom); assert.equal(button.targetReady, true);
  h.target.closest = () => null; assert.equal((await h.observe()).viewport.bottom, original.viewport.bottom);
});

test('draft observer reads live values/caret, bounded rows and unexposed binding without fabricating state', async () => {
  const node = (extra = {}) => ({ dataset: {}, childNodes: [], children: [], scrollTop: 0, scrollHeight: 60, clientHeight: 60,
    offsetHeight: 60, clientTop: 0,
    scrollWidth: 300, clientWidth: 300, textContent: '', querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 100, top: 200, right: 400, bottom: 260, width: 300, height: 60 }), ...extra });
  const input = (id, testid, value, index = '0', field) => node({ id, dataset: { testid, index, ...(field ? { field } : {}) }, value,
    textContent: 'stale initial text, not .value', selectionStart: value.length, selectionEnd: value.length });
  const user = input('user-live', 'settings-agent-example-user', 'live question'), reply = input('reply-live', 'settings-agent-example-reply', 'live reply\nsecond line');
  const avoid = input('avoid-live', 'settings-agent-avoid-text', 'live avoid');
  const exampleRow = node({ dataset: { index: '0' }, querySelector: selector => selector.includes('-user') ? user : reply });
  const avoidRow = node({ dataset: { index: '0' }, querySelector: () => avoid });
  const chips = Object.fromEntries(['traits', 'expertise', 'toolPreferences'].map(field => [field, input(`chip-${field}`, 'settings-agent-chip-input', `pending-${field}`, undefined, field)]));
  const content = node(), actions = node(), card = node({ id: 'settings-live', querySelector: selector => selector === '.egd-settings-content' ? content : null });
  let exampleCount = 1, avoidCount = 1;
  const form = node({ closest: () => card, querySelectorAll: selector => selector.includes('example-row') ? Array(exampleCount).fill(exampleRow)
    : selector.includes('avoid-row') ? Array(avoidCount).fill(avoidRow) : [], querySelector: selector => {
    if (selector === '.egd-settings-form-actions') return actions;
    if (selector.includes('aria-pressed')) return { id: 'settings-live-profile-tone-warm' };
    const field = selector.match(/data-field="([^"]+)"/)?.[1];
    return selector.includes('settings-agent-chip-input') ? chips[field] : field ? node() : null;
  } });
  const save = node({ disabled: false }), cancel = node();
  const byId = { 'settings-agent-form': form, 'settings-agent-save': save, 'settings-agent-cancel': cancel };
  const document = { activeElement: reply, querySelector: selector => selector === '.egd-settings-card' ? card : byId[selector.match(/data-testid="([^"]+)"/)?.[1]] || null,
    querySelectorAll: selector => selector === '[data-testid="settings-agent-form"]' ? [form] : [] };
  const harness = { evaluateChrome: source => new Function('window', 'document', 'innerWidth', 'innerHeight', 'getComputedStyle', `return (${source})()`)(
    { __egdesk: { state: {} } }, document, 1280, 600, value => ({ display: 'block', visibility: 'visible', position: value === actions ? 'sticky' : 'static' })) };
  const observed = await observePortableUi(harness);
  assert.equal(observed.editor.profileId, null); assert.equal(observed.editor.baseRevision, null); assert.equal(observed.editor.busy, false);
  assert.equal(observed.editor.examples[0].user.value, 'live question'); assert.equal(observed.editor.examples[0].reply.value, 'live reply\nsecond line');
  assert.equal(observed.editor.avoid[0].text.value, 'live avoid'); assert.equal(observed.editor.chips.traits.input.value, 'pending-traits');
  assert.equal(observed.editor.examples[0].reply.focused, true); assert.equal(observed.editor.examples[0].reply.end, reply.value.length);
  assert.equal(observed.active.id, 'reply-live'); assert.equal(observed.editor.actions.position, 'sticky');
  assert.deepEqual(observed.editor.actions.contentViewport, { top: 200, bottom: 260, clientHeight: 60, scrollHeight: 60, scrollTop: 0 });
  assert.equal(assertPortableDraftFooter(observed), true);
  exampleCount = 100; avoidCount = 100; reply.value = 'x'.repeat(900);
  const bounded = await observePortableUi(harness);
  assert.equal(bounded.editor.examples.length, 4); assert.equal(bounded.editor.avoid.length, 9);
  assert.equal(bounded.editor.exampleCount, 100); assert.equal(bounded.editor.avoidCount, 100);
  assert.equal(bounded.editor.examples[0].reply.value.length, 512); assert.equal(bounded.editor.examples[0].reply.length, 900);
  assert.equal(bounded.editor.examples[0].reply.truncated, true);
});

test('new draft stage follows every old receipt assertion and cannot submit PUT/POST or manipulate DOM itself', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-portable-transfer-flow.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('proof.draftEdit = {};');
  assert.ok(start > source.indexOf("check('receipt fault adds no provider/send/auth/terminal activity'"));
  assert.ok(start > source.indexOf('proof.duplicateUnknown = await runPortableDuplicateUnknownCase'));
  assert.ok(start > source.indexOf("await noReplay('unknown')"));
  assert.ok(source.indexOf('await runPortableDraftEditCase({ proof: proof.draftEdit') > start);
  const stage = source.slice(source.indexOf('export async function runPortableDraftEditCase'), source.indexOf('export async function runCli'));
  assert.doesNotMatch(stage, /loopbackJson|fetch\(|profileRequest|\.click\(|\.focus\(|scrollIntoView|dispatchEvent|setSelectionRange|armFault|operation:/);
  assert.doesNotMatch(stage, /focus: true|\.value\s*=/);
  assert.match(source, /readProfile: id => .*loopbackJson\(`\/profiles\/\$\{id\}`, \{ token, env \}\)/);
  assert.match(source, /result\.providerTurns = afterDraft\.providerTurns/);
  assert.match(source, /assert\.equal\(proof\.initial\.seed\.profileVersion, 'head2-draft'/);
});

fixtureTest('failed retained-focus assertion preserves attached proof and bounded before/after removal evidence', async t => {
  const h = await draftStageFixture(t), attached = { draftEdit: {} }, actionTrace = [], originalClick = h.options.click, originalReach = h.options.reach;
  h.options.proof = attached.draftEdit; h.options.actionTrace = actionTrace;
  h.options.readUi = async () => {
    const value = h.ui(); value.settingsFullscreen = true;
    value.active.tag = value.active.id?.startsWith('reply-') ? 'textarea' : value.active.id ? 'input' : 'body';
    return value;
  };
  h.options.waitUi = async predicate => { const value = await h.options.readUi(); assert.equal(predicate(value), true); return value; };
  h.options.reach = async selector => {
    await originalReach(selector);
    const snapshot = await h.options.readUi();
    actionTrace.push({ kind: 'native-wheel-unit-only', selector, deltaY: -139, before: 967, after: 828 });
    return { scrollTop: 828, targetReady: true, focused: false, activeTestid: snapshot.active.testid };
  };
  h.options.click = async selector => {
    await originalClick(selector); actionTrace.push({ kind: 'native-click-unit-only', selector });
    if (selector.includes('settings-agent-example-remove')) h.focus(null);
  };
  await assert.rejects(runPortableDraftEditCase(h.options), /Focus follows a retained input/);
  const proof = attached.draftEdit;
  assert.ok(proof.observations.length > 0); assert.equal(proof.removalDiagnostics.length, 2);
  const [before, after] = proof.removalDiagnostics;
  assert.equal(before.when, 'before-click-after-reach'); assert.equal(after.when, 'after-click-row-count-wait');
  assert.deepEqual([before.width, before.height, before.settingsFullscreen], [1280, 600, true]);
  assert.equal(before.active.tag, 'textarea'); assert.equal(before.active.index, '2');
  assert.ok(before.retainedIds.includes(before.active.id)); assert.equal(before.selection.end, 'QA draft answer two.'.length);
  assert.deepEqual(after.active, { tag: 'body', id: null, testid: null, index: null }); assert.equal(after.selection, null);
  assert.deepEqual(before.retainedIds, after.retainedIds); assert.equal(before.rows.length, 3); assert.equal(after.rows.length, 2);
  assert.equal(after.rows[1].index, '1'); assert.equal(after.rows[1].controls[1].id, before.retainedIds[1]);
  assert.ok(after.rows[1].controls.every(control => Object.hasOwn(control, 'rowKeyFromInputId')));
  assert.equal(before.reachAction.scrollTop, 828); assert.equal(before.reachAction.activeTestid, 'settings-agent-example-reply');
  assert.equal(after.recentActions.length, 2); assert.equal(after.recentActions.at(-1).kind, 'native-click-unit-only');
  assert.ok(proof.removalDiagnostics.every(value => !Object.hasOwn(value, 'ui')));
  assert.equal(h.actions.filter(row => row[0] === 'click' && row[1].includes('settings-agent-example-remove')).length, 1);
  assert.equal(h.fixture.snapshot().requests.filter(row => row.method === 'PUT' && row.path.endsWith('/draft')).length, 0);
});

fixtureTest('failed tone-focus assertion preserves bounded existing-read evidence before rejection without another click', async t => {
  const h = await draftStageFixture(t), proof = {}, actionTrace = [], originalClick = h.options.click, originalReach = h.options.reach;
  const group = 'settings-owned-profile-tone', button = `${group}-warm`;
  h.options.proof = proof; h.options.actionTrace = actionTrace;
  h.options.readUi = async () => {
    const value = h.ui(); value.settingsFullscreen = true;
    value.active.tag = value.active.id === group ? 'div' : value.active.id?.startsWith('reply-') ? 'textarea' : value.active.id ? 'input' : 'body';
    return value;
  };
  h.options.waitUi = async predicate => { const value = await h.options.readUi(); assert.equal(predicate(value), true); return value; };
  h.options.reach = async selector => {
    await originalReach(selector);
    actionTrace.push({ kind: 'native-wheel-unit-only', selector, deltaY: -240 });
    return { scrollTop: 400, targetReady: true, focused: false, activeTestid: h.ui().active.testid };
  };
  h.options.click = async selector => {
    await originalClick(selector); actionTrace.push({ kind: 'native-click-unit-only', selector });
    if (selector.includes('profile-tone-')) h.focus(group);
  };
  await assert.rejects(runPortableDraftEditCase(h.options), /Tone rerender keeps native button focus or the existing input focus/);
  assert.equal(proof.toneDiagnostics.length, 2);
  const [before, after] = proof.toneDiagnostics;
  assert.equal(before.when, 'before-click-after-reach'); assert.equal(after.when, 'after-click-selected-tone-wait');
  assert.deepEqual([before.width, before.height, before.settingsFullscreen], [1280, 600, true]);
  assert.equal(before.active.tag, 'input'); assert.equal(before.active.testid, 'settings-agent-avoid-text'); assert.equal(before.active.index, '1');
  assert.equal(before.active.id, before.previousInput.id); assert.deepEqual(before.selection, { start: 18, end: 18 });
  assert.equal(before.selectedTone, `${group}-plain`); assert.equal(after.selectedTone, button);
  assert.deepEqual(after.active, { tag: 'div', id: group, testid: null, index: null }); assert.equal(after.selection, null);
  assert.equal(after.expectedButtonId, button); assert.deepEqual(after.previousInput, before.previousInput);
  assert.equal(before.reachAction.targetReady, true); assert.equal(before.reachAction.activeTestid, 'settings-agent-avoid-text');
  assert.equal(after.recentActions.length, 2); assert.equal(after.recentActions.at(-1).kind, 'native-click-unit-only');
  assert.ok(proof.toneDiagnostics.every(value => !Object.hasOwn(value, 'ui')));
  assert.equal(h.actions.filter(row => row[0] === 'click' && row[1].includes('profile-tone-')).length, 1);
  assert.equal(h.fixture.snapshot().requests.filter(row => row.method === 'PUT' && row.path.endsWith('/draft')).length, 0);
});

test('footer geometry rejects the old 18px body strip in overflowing 600/800 forms, but permits short normal-flow forms', () => {
  for (const height of [600, 800]) {
    const bottom = height - 67, ui = { editor: { actions: { position: 'sticky', box: { bottom },
      contentViewport: { top: 200, bottom, clientHeight: bottom - 200, scrollHeight: 2000, scrollTop: 400 } } } };
    assert.equal(assertPortableDraftFooter(ui), true);
    ui.editor.actions.box.bottom -= 18;
    assert.throws(() => assertPortableDraftFooter(ui), /no exposed body strip/);
    ui.editor.actions.contentViewport.scrollHeight = ui.editor.actions.contentViewport.clientHeight;
    ui.editor.actions.box.bottom = 400;
    assert.equal(assertPortableDraftFooter(ui), true, 'A short footer may remain in normal flow above the card bottom');
    ui.editor.actions.contentViewport = null;
    assert.throws(() => assertPortableDraftFooter(ui), /geometry/);
  }
});

test('footer CSS removes bottom spacing only for the existing editor, retaining scroll/flow without a mask', () => {
  const css = fs.readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  const rule = selector => {
    const marker = `${selector} {`, start = css.indexOf(marker); assert.ok(start >= 0, selector);
    return css.slice(start + marker.length, css.indexOf('}', start)).trim().replace(/\s+/g, ' ');
  };
  assert.equal(rule('.egd-settings-content:has(> .egd-settings-agent-form)'), 'padding-bottom: 0;');
  assert.equal(rule('.egd-settings-content > .egd-settings-agent-form'), 'margin-bottom: 0;');
  assert.match(rule('.egd-settings-content'), /overflow-y: auto;/);
  assert.match(rule('.egd-settings-content'), /padding: 14px 16px 18px;/);
  assert.equal(rule('.egd-settings-section'), 'margin-bottom: 18px;');
  assert.equal(rule('.egd-settings-agent-form'), 'display: flex; flex-direction: column; gap: 12px;');
  const footer = rule('.egd-settings-form-actions');
  assert.match(footer, /position: sticky;/); assert.match(footer, /bottom: 0;/);
  assert.doesNotMatch(footer, /overflow|clip|mask|height|position: (?:absolute|fixed)|margin-top: auto/);
  assert.doesNotMatch(css, /\.egd-settings-form-actions::(?:before|after)/);
});
