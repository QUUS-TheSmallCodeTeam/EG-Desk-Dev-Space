import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createPortableTransferFixture } from './egdesk-portable-transfer-fixture.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { assertPortableEnvironment, assertPortableStoreInvariant, assertPortableImportedDraft,
  assertPortableExportFile, assertPortablePinnedExport, assertPortableNoReplay,
  assertPortableMissingHead, assertPortableAttachmentOmission,
  assertPortableDuplicateReady, assertPortableDuplicateUi, assertPortableDuplicatedDraft,
  assertPortableDuplicateNoReplay, assertPortableRejectedDeskAutosaves, runPortableDuplicateCase, PORTABLE_DUPLICATE_NOTICE,
  observePortableFirstUse, preparePortableInstructionEdge, observePortableSettingsNavigation, navigatePortableSettings,
  portableObservationSources, PORTABLE_OBSERVATION_BUDGET, portableTextVisible } from './verify-firefox-mcp-portable-transfer-flow.mjs';

const TOKEN = 'portable-verifier-unit-only-token';
const ENV = { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1',
  EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_PORT: '49318', EGDESK_QA_FIXTURE_TOKEN: TOKEN };
function setup(t) {
  const loader = createPrivateQaTempDirectory('egdesk-portable-verifier-loader-');
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(loader, name), `unit loader ${name}\n`, { mode: 0o600 });
  const { profile } = bootstrapQaProfile({ loaderSource: loader });
  const fixture = createPortableTransferFixture({ profile, token: TOKEN, env: ENV }), root = fixture.snapshot().root;
  t.after(() => {
    fixture.dispose();
    for (const [directory, prefix] of [[root, 'egdesk-portable-transfer-'], [profile, 'egdesk-chat-test-'], [loader, 'egdesk-portable-verifier-loader-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot()); assert.equal(fs.realpathSync.native(directory), directory);
      assert.ok(path.basename(directory).startsWith(prefix)); fs.rmSync(directory, { recursive: true });
    }
  });
  return fixture;
}
async function request(fixture, method, route, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: route, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:49318', 'content-type': 'application/json', 'x-egdesk-qa-token': TOKEN } });
  let status, value;
  const res = { setHeader() {}, writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } };
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

test('store receipt assertions reject changed Board head, unexpected activation, provider or output injection', t => {
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

test('real saved-head converter excludes attachment records on the named node with an empty omission report', async t => {
  const { state, converted, ui } = await attachmentExport(t);
  assert.deepEqual(converted.response.report.omitted, []);
  assert.deepEqual(converted.response.canvas.nodes.find(node => node.id === 'qa-file').egdesk,
    { kind: 'card', type: 'file', omitted: 'attachment' });
  assert.equal(assertPortableAttachmentOmission(state, converted, ui), true);
});

test('attachment proof rejects wrong or absent original node; unrelated report entries cannot substitute', async t => {
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

test('attachment proof rejects original path or text leaks and missing or inaccurate exclusion notice', async t => {
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

test('import proof reads real preview and confirmed SQLite draft with exact original Markdown', async t => {
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

test('pinned-export validator checks actual new head and exact old revision bytes; unit files are not UI proof', async t => {
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

test('unknown/no-replay receipt validator rejects repeat export, file change and reenabled action', t => {
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

test('missing-head proof requires actual Desk 404 and cannot stand in for a successful UI capture', async t => {
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

test('duplicate proof verifies real v2 request, source provenance and new inactive draft v1 while head stays v3', async t => {
  const h = await duplicateFixture(t);
  assert.equal(assertPortableDuplicateReady(h.before, h.uiBefore), true);
  const { after, uiAfter, id } = await h.commit();
  assert.equal(assertPortableDuplicatedDraft(h.before, after, h.uiBefore, uiAfter), id);
  assert.equal(assertPortableStoreInvariant(h.initial, after, { imported: 1, headAdvanced: true, duplicated: 1 }), true);
  assert.throws(() => assertPortableStoreInvariant(h.initial, after, { imported: 1, headAdvanced: true }),
    'Original R7 invariant still refuses a duplicate without the explicit new stage');
  assert.equal(assertPortableDuplicateNoReplay(after, Array.from({ length: 4 }, () => ({ state: after, ui: uiAfter })), h.uiBefore, id), true);
});

test('duplicate readiness rejects wrong or ambiguous displayed profile, pending/disabled command and pre-click effects', async t => {
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

test('duplicate validator rejects missing pin, head-v3 copy, extra fields, forged receipt and unrelated writes', async t => {
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

test('duplicate UI/no-replay proof refuses original detail, changed room, inaccurate notice and a later second request', async t => {
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

test('duplicate stage preserves all earlier transfer checks, pins the native command once, and captures exact notices', async t => {
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

test('duplicate stage aborts stale bindings or deadline before click; ambiguous input is never replayed', async t => {
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

test('R8 exact blocked Desk autosaves can intervene before and after duplication without weakening profile write counts', async t => {
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

test('Desk autosave exception refuses successful, delegated, wrong-query, wrong-code or database-mutating requests', async t => {
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

test('duplicate stage tolerates only real rejected Desk PUT during post-click observation, not another click or write', async t => {
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
