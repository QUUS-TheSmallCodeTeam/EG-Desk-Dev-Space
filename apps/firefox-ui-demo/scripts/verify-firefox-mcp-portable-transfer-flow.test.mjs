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
function settingsNavigationFixture({ top = 1000 } = {}) {
  const model = { top, scrollTop: 0, scrollHeight: 1600, focused: false, activeTestid: 'settings-agent-import', reads: 0 };
  const wheels = [], clicks = [], trace = [];
  const read = async () => {
    model.reads++;
    const targetRect = { left: 220, right: 1200, top: model.top - model.scrollTop, bottom: model.top - model.scrollTop + 160, width: 980, height: 160 };
    const viewport = { left: 100, top: 200, right: 1250, bottom: 730 };
    return { settingsId: 'settings-original', selector: INSTRUCTIONS, cards: 1, contents: 1, count: 1,
      transferState: 'preview', owned: true, contentVisible: true, targetVisible: true, disabled: false,
      focused: model.focused, activeTestid: model.activeTestid,
      targetRect, targetClip: viewport, viewport, bounds: { ...viewport, width: 1150, height: 530 },
      targetReady: targetRect.top >= viewport.top && targetRect.bottom <= viewport.bottom,
      point: { x: 710, y: Math.round(targetRect.top + 80) }, wheelPoint: { x: 112, y: 465 },
      scrollTop: model.scrollTop, scrollHeight: model.scrollHeight, clientHeight: 530 };
  };
  const options = { read, wheelAt: async input => { wheels.push(input); model.scrollTop += input.deltaY; },
    clickPoint: async point => { clicks.push(point); model.focused = true; model.activeTestid = 'import-instructions'; },
    pause: async () => {}, assertDeadline() {}, focus: true, trace };
  return { model, wheels, clicks, trace, options };
}

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
