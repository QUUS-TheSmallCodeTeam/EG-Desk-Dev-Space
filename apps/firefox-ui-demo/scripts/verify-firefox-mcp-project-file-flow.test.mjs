import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertProjectEnvironment, assertProjectFlowEvidence, PROJECT_VIEWPORTS, PROJECT_CAPTURE_STAGES,
  boardPrimarySelector, boardRowFitIssues, fileDetailAction, fileViewportAction, assertFileUiIdentity,
  assertRunKeptView, captureSubjectsVisible, textFragmentsVisible, longCommandForNavigation,
  assertLongCommandNavigation, assertChatProjectEvidence, nativeCommandNavigationKeys,
  commandNavigationObservation, projectDialogLayoutIssues, assertRoomDefaultResponse,
  assertRoomDefaultStoreEvidence, assertRoomDefaultUiEvidence, roomProjectDetailsVisible,
  fileResultLocationVisible, assertFileResultLocationEvidence, projectUiObservationSources,
  PROJECT_OBSERVATION_SOURCE_BUDGET, mergeProjectUiObservations, observeProjectUi, waitStableProjectUi,
  chatProjectFooterVisible, chatProjectReviewReady, chatProjectWaitDiagnostic,
  assertChatProjectReviewScroll, assertChatRoomReadReceipt, roomFolderPreviewVisible,
  assertRoomFolderResponse, assertRoomFolderUiEvidence, assertProjectWatchEnvironment,
  assertProjectWatchEvidence, awaitProjectWatchDeadline, runProjectWatcherCli, projectWatchScope,
  guardProjectWatchHarness, projectWatchJson, waitWatcherFileUi, observeWatchUi } from './verify-firefox-mcp-project-file-flow.mjs';
import { fakeFileCard } from './egdesk-qa-file-editor.test.mjs';
import { runInNewContext } from 'node:vm';
import { parseCli } from './verify-firefox-mcp-headless-ui-regression.mjs';
import { terminalScriptLine } from '../overlay/resources/EGDeskTerminalState.sys.mjs';

const ENV = { EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1',
  EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_TOKEN: 'unit-project-token-no-credentials' };

test('watcher acceptance requires explicit isolated ports and fails closed on missing opt-in', () => {
  const env = { ...ENV, EGDESK_QA_PROJECT_FILE_WATCH: '1', EGDESK_MARIONETTE_PORT: '2829', EGDESK_QA_FIXTURE_PORT: '49318',
    EGDESK_QA_MCP_ENTRY: path.resolve('qa-mcp-entry.mjs'), EGDESK_QA_GECKODRIVER: path.resolve('geckodriver') };
  if (process.platform === 'darwin') assert.equal(assertProjectWatchEnvironment(env), true);
  else assert.throws(() => assertProjectWatchEnvironment(env), /macOS-only/);
  for (const invalid of [
    { ...env, EGDESK_QA_PROJECT_FILE_WATCH: '0' },
    { ...env, EGDESK_MARIONETTE_PORT: '' },
    { ...env, EGDESK_QA_FIXTURE_PORT: '' },
    { ...env, EGDESK_MARIONETTE_PORT: env.EGDESK_QA_FIXTURE_PORT },
    { ...env, EGDESK_QA_FIXTURE_PORT: '65536' },
    { ...env, EGDESK_QA_FIXTURE_PORT: '39218' },
    { ...env, EGDESK_QA_MCP_ENTRY: undefined },
    { ...env, EGDESK_QA_GECKODRIVER: 'relative-driver' },
    { ...env, EGDESK_QA_REAL_TURN: '1' },
  ]) assert.throws(() => assertProjectWatchEnvironment(invalid));
});

test('watcher CLI never starts a new scenario or failure screenshot after the deadline', { timeout: 1000 }, async () => {
  let connectResolved, scenarioCalls = 0, closeCalls = 0, shots = 0;
  const connect = new Promise(resolve => { connectResolved = resolve; });
  const fake = { evidenceDir: null, connect: () => connect, close: async () => { closeCalls++; }, screenshot: () => { shots++; } };
  const options = { profile: '/fixture-only', deadlineMs: Date.now() + 60 };
  const result = await runProjectWatcherCli(options, { env: { EGDESK_MARIONETTE_PORT: '2829' },
    validateEnvironment() {}, validateIsolation: () => ({ fixture: true }), createHarness: () => fake,
    scenario: async () => { scenarioCalls++; } });
  assert.equal(result.automatedAssertionsPassed, false);
  assert.match(result.error, /deadline/);
  assert.equal(result.failureScreenshot, 'not-attempted');
  assert.equal(closeCalls, 1); assert.equal(shots, 0); assert.equal(scenarioCalls, 0);
  connectResolved(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scenarioCalls, 0, 'late MCP connect cannot start the scenario');
  let ran = false;
  await assert.rejects(awaitProjectWatchDeadline(() => { ran = true; }, Date.now() - 1), /deadline/);
  assert.equal(ran, false);
});

test('watcher CLI preserves the original error while independently recording MCP cleanup failure', { timeout: 1000 }, async () => {
  let calls = 0;
  const fake = { evidenceDir: null, connect: async () => {}, close: async () => { calls++; throw new Error('cleanup failed'); } };
  const result = await runProjectWatcherCli({ profile: '/fixture-only', deadlineMs: Date.now() + 500 }, {
    env: { EGDESK_MARIONETTE_PORT: '2829' }, validateEnvironment() {}, validateIsolation: () => ({ fixture: true }),
    createHarness: () => fake, scenario: async () => { throw new Error('scenario failed'); } });
  assert.equal(result.error, 'scenario failed'); assert.equal(result.cleanupError, 'cleanup failed');
  assert.equal(result.automatedAssertionsPassed, false); assert.equal(calls, 1);
});

test('watcher scope describes planned stages and never labels them observed before execution', () => {
  const scope = projectWatchScope();
  assert.ok(scope.planned.includes('connected-root filesystem watcher'));
  assert.equal(Object.hasOwn(scope, 'actual'), false);
  assert.equal(scope.providerCalls, 'not-measured');
  assert.match(scope.outerIsolation, /independent launcher/);
});

test('watcher retries only incoherent observations, never input, and preserves fatal failures', async () => {
  let reads = 0, predicateCalls = 0;
  const harness = { click() { assert.fail('no native click replay'); }, press() { assert.fail('no native key replay'); } };
  const ready = { count: 1, cardId: 'file-1' };
  const wait = async (_harness, read, accept, deadline) => {
    assert.equal(deadline, 1000);
    const transient = await read(); assert.equal(transient, null); assert.equal(accept(transient), false);
    const observed = await read(); assert.equal(accept(observed), true); return observed;
  };
  const observed = await waitWatcherFileUi(harness, value => { predicateCalls++; return value.count === 1; }, 1000,
    { wait, observe: async () => {
      if (++reads === 1) throw Object.assign(new Error('moving camera'), { code: 'QA_PROJECT_OBSERVATION_UNSTABLE' });
      return ready;
    } });
  assert.equal(observed, ready); assert.equal(reads, 2); assert.equal(predicateCalls, 1);
  await assert.rejects(waitWatcherFileUi(harness, () => true, 1000,
    { wait: async (_h, read) => read(), observe: async () => { throw new Error('MCP unavailable'); } }), /MCP unavailable/);
});

test('watcher opens once, waits for coherent camera and an unobstructed target before picker input', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-project-file-flow.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function runProjectFileWatcherFlow(');
  const open = source.indexOf("await click('#egd-dock .egd-dock-btn[data-id=", start);
  const viewport = source.indexOf('await waitStableViewport(harness, size, deadlineMs)', open);
  const stable = source.indexOf('await waitStableProjectUi(harness, deadlineMs)', viewport);
  const targetWait = source.indexOf('targets.length === 1 && targetIssues(targets[0]).length === 0', stable);
  const picker = source.indexOf("await click(rootTarget, 'select owned folder through real picker grant')", targetWait);
  assert.ok(start > 0 && open > start && viewport > open && stable > viewport && targetWait > stable && picker > targetWait);
  assert.equal((source.slice(open, picker).match(/await click\('#egd-dock/g) || []).length, 1);
});

test('watcher deadline aborts the scope and a late scenario cannot mutate the returned receipt', { timeout: 1000 }, async () => {
  let release, closing = 0, capturedSignal;
  const pending = new Promise(resolve => { release = resolve; });
  const fake = { evidenceDir: null, connect: async () => {}, close: async () => { closing++; } };
  const result = await runProjectWatcherCli({ profile: '/fixture-only', deadlineMs: Date.now() + 60 }, {
    env: { EGDESK_MARIONETTE_PORT: '2829' }, validateEnvironment() {}, validateIsolation: () => ({ fixture: true }),
    createHarness: () => fake, scenario: async ({ check }, { signal, fixtureOperations }) => {
      capturedSignal = signal;
      fixtureOperations.push({ route: '/__qa/project-file/watch-create', status: 'pending', dispatched: true });
      await pending; check('late', true);
    } });
  assert.match(result.error, /deadline/); assert.equal(closing, 1); assert.equal(capturedSignal.aborted, true);
  assert.deepEqual(result.checks, []); assert.equal(result.fixtureOperations[0].status, 'unknown');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result.checks, [], 'a late callback cannot alter the already returned receipt');
  assert.equal(result.fixtureOperations[0].status, 'unknown');
});

test('a late scenario cannot change checks while cleanup is still awaiting', { timeout: 1000 }, async () => {
  let releaseScenario, cleanupStarted, finishCleanup;
  const scenarioWait = new Promise(resolve => { releaseScenario = resolve; });
  const cleanupEntered = new Promise(resolve => { cleanupStarted = resolve; });
  const cleanupWait = new Promise(resolve => { finishCleanup = resolve; });
  const fake = { evidenceDir: null, connect: async () => {}, close: async () => { cleanupStarted(); await cleanupWait; } };
  const running = runProjectWatcherCli({ profile: '/fixture-only', deadlineMs: Date.now() + 60 }, {
    env: { EGDESK_MARIONETTE_PORT: '2829' }, validateEnvironment() {}, validateIsolation: () => ({ fixture: true }),
    createHarness: () => fake, scenario: async ({ result }) => {
      await scenarioWait; result.checks.push({ label: 'late direct write', passed: true });
    } });
  await cleanupEntered; releaseScenario(); await new Promise(resolve => setImmediate(resolve)); finishCleanup();
  const result = await running;
  assert.match(result.error, /deadline/); assert.deepEqual(result.checks, []);
});

test('late MCP results are rejected and a cancelled fixture POST remains unknown', { timeout: 1000 }, async () => {
  let active = true, release, called = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const guarded = guardProjectWatchHarness({ click() { called++; return pending; } }, () => {
    if (!active) throw new Error('expired');
  });
  const action = guarded.click(); active = false; release('late');
  await assert.rejects(action, /expired/); assert.equal(called, 1);
  assert.throws(() => guarded.click(), /expired/); assert.equal(called, 1);
  const controller = new AbortController(), operations = [];
  const env = { ...ENV, EGDESK_QA_FIXTURE_PORT: '49318' };
  let requestSignal;
  const request = projectWatchJson('/__qa/project-file/watch-create', { method: 'POST', body: {}, token: ENV.EGDESK_QA_FIXTURE_TOKEN,
    env, signal: controller.signal, deadlineMs: Date.now() + 500, operations,
    fetchImpl: async (_url, options) => { requestSignal = options.signal; return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }); } });
  controller.abort(); await assert.rejects(request, /aborted/);
  assert.equal(requestSignal.aborted, true); assert.equal(operations[0].status, 'unknown');
});

test('watcher receipt requires correlated real event, SSE client, same folder re-list and undisturbed editor', () => {
  const snapshot = { rootId: 'root', projectId: null, fileId: 'file', draftId: 'draft', sourceRevision: 'rev',
    sourceConnection: 'connected', bufferRevision: 1, savedRevision: 0, dirty: false, originalDirty: true };
  const editor = { mode: 'codemirror', value: 'draft', shownText: 'draft', selectionStart: 0, selectionEnd: 5, focused: true };
  const before = { cardId: 'card', snapshot, folderExpanded: true, createdCount: 0, createdVisible: false, editor };
  const after = { ...structuredClone(before), createdCount: 1, createdVisible: true };
  const event = { id: 'event', sequence: 10, topic: 'file.changed', payload: { rootId: 'root',
    relativePath: 'qa-expanded/qa-watch-created.txt', change: 'rename' } };
  const list = { operation: 'listDirectory', status: 200, sequence: 5, request: { directoryId: 'folder' },
    response: { result: { entries: [{ name: 'qa-existing.txt' }] } } };
  const refresh = { ...structuredClone(list), sequence: 11,
    response: { result: { entries: [{ name: 'qa-existing.txt' }, { name: 'qa-watch-created.txt' }] } } };
  const fixtureBefore = { watchEnabled: true, watchRoots: [{ rootId: 'root', watching: true }], watchWrites: [],
    originalSha256: 'hash', currentOriginalSha256: 'hash', fileRequests: [list] };
  const fixtureAfter = { ...structuredClone(fixtureBefore), watchEvents: [event], fileRequests: [list, refresh],
    watchWrites: [{ relativePath: event.payload.relativePath, operation: 'create-only' }], terminalRequests: [], blockedRoutes: [] };
  const broadcast = { eventId: 'event', clients: 1 };
  const bridgeBefore = { clients: 1, observed: { sends: [], authWrites: [] }, runs: [] };
  const bridgeAfter = { ...structuredClone(bridgeBefore), observed: { sends: [], authWrites: [], projectFileWatchBroadcasts: [broadcast] } };
  const screenshots = ['watch-before', 'watch-after'].map(viewport => ({ viewport, status: 'captured', path: `/tmp/${viewport}.png`, visualPass: null }));
  const visibleTarget = { visible: true, inViewport: true, hitCount: 9, disabled: false, readOnly: false };
  const proof = { before, after, fixtureBefore, fixtureAfter, bridgeBefore, bridgeAfter, event, broadcast, screenshots, visibleTarget };
  assert.equal(assertProjectWatchEvidence(proof), true);
  const textarea = structuredClone(proof);
  for (const side of [textarea.before, textarea.after]) side.editor.mode = 'textarea';
  assert.equal(assertProjectWatchEvidence(textarea), true, 'textarea fallback is accepted as the shown editor');
  for (const corrupt of [
    p => { p.before.editor.mode = p.after.editor.mode = null; },
    p => { p.before.editor.shownText = p.after.editor.shownText = 'stale'; },
    p => p.after.editor.mode = 'textarea',
    p => p.event.payload.rootId = 'other', p => p.broadcast.clients = 0,
    p => p.fixtureAfter.watchEvents = [], p => p.fixtureAfter.fileRequests[1].status = 403,
    p => p.fixtureAfter.fileRequests[1].sequence = 9, p => p.fixtureAfter.fileRequests[1].request.directoryId = 'other',
    p => p.after.createdVisible = false, p => p.visibleTarget.hitCount = 0, p => p.after.folderExpanded = false,
    p => p.after.editor.focused = false, p => p.after.editor.selectionEnd = 0,
    p => p.after.snapshot.draftId = 'different', p => p.fixtureAfter.currentOriginalSha256 = 'changed',
    p => p.bridgeAfter.runs.push({}), p => p.screenshots[0].visualPass = true,
  ]) { const invalid = structuredClone(proof); corrupt(invalid); assert.throws(() => assertProjectWatchEvidence(invalid)); }
});

test('watch observation reads the shown editor: CodeMirror content when mounted, else the textarea', async () => {
  for (const mode of ['codemirror', 'textarea']) {
    const fake = fakeFileCard({ mode, text: 'draft', focus: mode === 'codemirror' ? 'content' : 'textarea',
      selection: ({ lines }) => ({ startContainer: lines[0].textNode, startOffset: 0, endContainer: lines[0].textNode, endOffset: 5 }) });
    fake.textarea.selectionStart = 0; fake.textarea.selectionEnd = 5;
    Object.assign(fake.card, { id: 'card', querySelectorAll: () => [] });
    const card = fake.card, base = card.querySelector;
    card.querySelector = selector => selector.includes('treeitem') ? null : base(selector);
    const harness = { evaluateChrome: source => runInNewContext(`(${source})()`, {
      document: { querySelectorAll: selector => selector === '[data-testid="file-card"]' ? [card] : [], activeElement: fake.doc.activeElement },
      getComputedStyle: () => ({}), innerWidth: 800, innerHeight: 600 }) };
    const value = await observeWatchUi(harness);
    assert.deepEqual(JSON.parse(JSON.stringify(value.editor)), { mode, value: 'draft', shownText: 'draft', selectionStart: 0, selectionEnd: 5, focused: true });
    // A hidden textarea's own focus/selection is not the shown editor's.
    if (mode === 'codemirror') {
      fake.doc.activeElement = fake.textarea;
      assert.equal((await observeWatchUi(harness)).editor.focused, false);
    }
  }
});

test('project and watcher flows type only into the resolved shown editor, never the hidden textarea selector', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-project-file-flow.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes("type(field('file-editor')"));
  assert.ok(!source.includes("testid('file-editor')"));
  assert.equal(source.match(/await resolveShownFileEditor\(harness, card\)/g)?.length, 2);
  assert.equal(source.match(/await type\(shownEditor\.input, /g)?.length, 2);
  assert.ok(source.includes('const editor = shownEditor.input;'));
});

test('data-ready FileView at compact semantic zoom requires native projection focus, never unhiding DOM', () => {
  const ui = { count: 1, cardId: 'file-1', snapshot: {}, connect: { disabled: false, ownHidden: false },
    presentation: { level: 'outline', proxy: { visible: true } } };
  assert.equal(fileDetailAction(ui), 'native-proxy');
  assert.equal(fileDetailAction({ ...ui, connect: { ...ui.connect, ownHidden: true } }), 'author-hidden');
  assert.equal(fileDetailAction({ ...ui, snapshot: null }), 'wait');
  assert.equal(fileDetailAction({ ...ui, presentation: { level: null, proxy: null } }), 'wait');
  assert.equal(fileDetailAction({ ...ui, presentation: { level: 'detail', proxy: { visible: false } } }), 'detail');
  assert.equal(fileDetailAction({ ...ui, presentation: { level: 'outline', proxy: { visible: false } } }), 'wait');
  assert.equal(fileDetailAction({ ...ui, presentation: { ...ui.presentation, detailEnterReadable: true } }), 'native-proxy',
    'the actual rendered LOD, not a diagnostic font calculation, selects the native action');
});

test('narrow overflow requires native card resize, not a partial-button or unreadable zoom fit', () => {
  const ui = { cardId: 'file', fileView: { inside: false }, snapshot: { projectId: 'p', rootId: 'r', dirty: false },
    scriptName: 'typed', scriptCommand: 'printf owned', presentation: { level: 'detail', fullscreen: false } };
  assert.equal(fileViewportAction(ui), 'native-maximize');
  assert.equal(fileViewportAction({ ...ui, fileView: { inside: true } }), 'none');
  assert.equal(fileViewportAction({ ...ui, presentation: { level: 'outline' } }), 'focus-first');
  assert.equal(fileViewportAction({ ...ui, presentation: { level: 'detail', fullscreen: true } }), 'unresolved-clipping');
  assert.equal(assertFileUiIdentity(ui, { ...ui, fileView: { inside: true }, presentation: { level: 'detail', fullscreen: true } }), true);
  assert.throws(() => assertFileUiIdentity(ui, { ...ui, snapshot: { ...ui.snapshot, projectId: 'foreign' } }));
  assert.throws(() => assertFileUiIdentity(ui, { ...ui, scriptCommand: '' }));
});

test('execution cannot steal File focus or camera before explicit capture navigation', () => {
  const before = { cardId: 'file-1', activeEntityId: 'file-1', camera: { zoom: 0.96, zoomTarget: 0.96,
    pan: { x: 100, y: 200 }, panTarget: { x: 100, y: 200 } } };
  assert.equal(assertRunKeptView(before, structuredClone(before)), true);
  for (const corrupt of [value => value.activeEntityId = 'terminal-1', value => value.camera.zoom = 0.35,
    value => value.camera.pan.x += 10, value => value.camera.panTarget.y += 10]) {
    const after = structuredClone(before); corrupt(after); assert.throws(() => assertRunKeptView(before, after));
  }
});

test('separate result/terminal captures require visible readable content, not merely an offscreen buffer receipt', () => {
  const box = { visible: true, inside: true, clipped: false };
  const exitTextPaint = { text: '종료 코드 0', styleVisible: true, textNodeCount: 1, missingTextRects: 0,
    fragments: [{ inside: true, clipped: false, hitCount: 3, rect: { width: 25, height: 15 } }] };
  const result = { result: { outcome: 'passed', text: 'QA_PROJECT_OUTPUT_unit', headlineBox: box,
    exitBox: { ...box, visible: false, visibleHits: 0 }, exitTextPaint, outputBox: box } };
  assert.equal(captureSubjectsVisible('readable-result', result, 'QA_PROJECT_OUTPUT_unit', 'unitnonce123'), true);
  assert.equal(captureSubjectsVisible('readable-result', { result: { ...result.result, outputBox: { ...box, clipped: true } } }, 'QA_PROJECT_OUTPUT_unit'), false);
  assert.equal(captureSubjectsVisible('readable-result', { result: { ...result.result, exitTextPaint: null } }, 'QA_PROJECT_OUTPUT_unit'), false);
  const terminal = { level: 'detail', text: 'QA_PROJECT_OUTPUT_unit\n[egdesk-run:unitnonce123:exit=0]',
    renderedOutput: [{ text: 'QA_PROJECT_OUTPUT_unit', fullyVisible: true, projectedFontPx: 12.5 },
      { text: '[egdesk-run:unitnonce123:exit=0]', fullyVisible: true, projectedFontPx: 12.5 }] };
  assert.equal(captureSubjectsVisible('terminal-output', { terminals: [terminal] }, 'QA_PROJECT_OUTPUT_unit', 'unitnonce123'), true);
  assert.equal(captureSubjectsVisible('terminal-output', { terminals: [{ ...terminal, renderedOutput: [] }] }, 'QA_PROJECT_OUTPUT_unit', 'unitnonce123'), false);
  for (const corrupt of [value => value.level = 'outline', value => value.renderedOutput[0].fullyVisible = false,
    value => value.renderedOutput[1].projectedFontPx = 3.8, value => value.renderedOutput[1].text = '[egdesk-run:foreign123:exit=0]']) {
    const changed = structuredClone(terminal); corrupt(changed);
    assert.equal(captureSubjectsVisible('terminal-output', { terminals: [changed] }, 'QA_PROJECT_OUTPUT_unit', 'unitnonce123'), false);
  }
});

test('wrapped exit metadata requires every actual text fragment, not hits in its blank union box', () => {
  // Validator inputs only. The real headless run must collect Range rectangles
  // and occlusion hits; these unit samples never claim a rendered UI pass.
  const fragment = { inside: true, clipped: false, hitCount: 3, rect: { width: 20, height: 15 } };
  const paint = { text: '종료 코드 0', styleVisible: true, textNodeCount: 1, missingTextRects: 0,
    fragments: [structuredClone(fragment), structuredClone(fragment)] };
  assert.equal(textFragmentsVisible(paint, '종료 코드 0'), true);
  for (const corrupt of [value => value.text = '종료 코드 10', value => value.styleVisible = false,
    value => value.textNodeCount = 0, value => value.missingTextRects = 1, value => value.fragments = [],
    value => value.fragments[1].inside = false, value => value.fragments[1].clipped = true,
    value => value.fragments[1].hitCount = 2, value => value.fragments[1].rect.width = 0]) {
    const changed = structuredClone(paint); corrupt(changed);
    assert.equal(textFragmentsVisible(changed, '종료 코드 0'), false);
  }
});

test('600px long-command acceptance requires platform-native caret/scroll endpoints, unchanged full value and zero writes', () => {
  const command = 'printf owned', long = longCommandForNavigation(command);
  assert.ok(long.length > 500 && long.startsWith(command));
  const sample = { width: 600, height: 600, scriptCommand: long,
    scriptCommandBox: { visible: true, inside: true, clipped: false },
    commandNavigation: { focused: true, selectionStart: 0, selectionEnd: 0, scrollLeft: 0, scrollWidth: 4000, clientWidth: 300 } };
  const proof = { platform: 'darwin', keys: nativeCommandNavigationKeys('darwin'),
    home: structuredClone(sample), end: { ...structuredClone(sample), commandNavigation: {
    ...sample.commandNavigation, selectionStart: long.length, selectionEnd: long.length, scrollLeft: 3700 } },
    restored: { scriptCommand: command }, beforeStore: { terminalRequests: [], fileRequests: [] },
    afterStore: { terminalRequests: [], fileRequests: [] } };
  assert.equal(assertLongCommandNavigation(proof, command), true);
  for (const corrupt of [value => value.keys.home = 'Home', value => value.home.width = 1280, value => value.end.scriptCommand += 'changed',
    value => value.home.commandNavigation.selectionStart = 1, value => value.home.commandNavigation.selectionEnd = 1,
    value => value.end.commandNavigation.selectionEnd--, value => value.end.commandNavigation.scrollLeft = 0,
    value => value.end.commandNavigation.focused = false, value => value.end.scriptCommandBox.clipped = true,
    value => value.restored.scriptCommand = long, value => value.afterStore.terminalRequests.push({ route: '/terminal/write' }),
    value => value.afterStore.fileRequests.push({ operation: 'setProjectScripts' })]) {
    const changed = structuredClone(proof); corrupt(changed); assert.throws(() => assertLongCommandNavigation(changed, command));
  }
});

test('macOS input endpoints use supported Meta arrows and retain bounded focused failure diagnostics', () => {
  assert.deepEqual(nativeCommandNavigationKeys('darwin'), { home: 'meta+ArrowLeft', end: 'meta+ArrowRight' });
  for (const platform of ['linux', 'win32']) assert.deepEqual(nativeCommandNavigationKeys(platform), { home: 'Home', end: 'End' });
  const value = 'owned'.repeat(1000), ui = { scriptCommand: value, commandNavigation: { focused: true,
    selectionStart: value.length, selectionEnd: value.length, scrollLeft: 500 }, width: 600, height: 600 };
  const observed = commandNavigationObservation(ui, value);
  assert.equal(observed.valueMatches, true); assert.equal(observed.valueLength, 5000);
  assert.equal(observed.commandNavigation.selectionStart, 5000);
  assert.equal(observed.valueHead.length, 80); assert.equal(observed.valueTail.length, 80);
  assert.ok(JSON.stringify(observed).length < 500);
  assert.equal(commandNavigationObservation({ ...ui, scriptCommand: 'changed' }, value).valueMatches, false);
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-project-file-flow.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('navigation.observations.length > 12'));
  assert.ok(source.includes('navigation.lastObservation = observed'));
  assert.ok(source.includes('navigation.failure = { key, intent: name, expectedPosition: position'));
  assert.ok(!source.includes('setSelectionRange'));
});

function chatProjectReceipts() {
  const expected = { boardId: 'owned-board', projectId: 'owned-project', rootId: 'owned-root',
    title: 'Owned QA long project name for native selector evidence', displayPath: '/owned/qa/long/path/workspace' };
  const paint = text => ({ text, styleVisible: true, textNodeCount: 1, missingTextRects: 0,
    fragments: [{ inside: true, clipped: false, hitCount: 3, rect: { width: 120, height: 16 } }] });
  const base = { threadId: 'empty-room', roomId: 'canonical-client-binding', composerThreadId: 'empty-room', composerValue: '', draft: '',
    messageCount: 0, conversationId: null, activeBoardId: expected.boardId, target: null, draftRevision: 0,
    viewportWidth: 1280, openerText: '실행 프로젝트', openerDescription: '실행 프로젝트', removeBox: null, backBox: { visible: true } };
  const emptyPanel = { selectedBoardId: '', applyDisabled: true, threadId: base.threadId };
  const selectedPanel = { threadId: base.threadId, selectedBoardId: expected.boardId, applyDisabled: false,
    actions: { operation: 'request', outsideBody: true },
    titlePaint: paint(expected.title), pathPaint: paint(expected.displayPath),
    layout: Object.fromEntries(['dialog', 'body', 'details'].map(name => [name, { clientWidth: 480, scrollWidth: 480, overflowX: 'auto' }])) };
  const applied = { ...base, target: expected, draftRevision: 1, openerText: `실행 프로젝트 · ${expected.title}`,
    openerDescription: `${expected.title} · ${expected.displayPath}`, removeBox: { visible: true } };
  const store = { terminalRequests: [{ route: '/terminal/write' }, { route: '/terminal/write' }],
    fileRequests: [{ operation: 'attachProject', sequence: 1 }], pickerResults: [{}, {}], sessions: [{}],
    providerTurns: 0, nativePickerInvocations: 0, nativeProcessSpawns: 0 };
  const proof = { initial: { ...base }, panelInitial: { ...base, panel: emptyPanel },
    selectedBeforeCancel: { ...base, panel: selectedPanel }, cancelled: { ...base },
    selectedBeforeApply: { ...base, panel: selectedPanel }, applied,
    narrowApplied: { ...applied, viewportWidth: 600, openerOverflowPx: 100, openerBox: { visible: true, inside: true, clipped: false } },
    details: { ...applied, viewportWidth: 600, panel: selectedPanel }, cancelledAfterApply: { ...applied },
    removed: { ...base, draftRevision: 2 }, reopenedAfterRemove: { ...base, draftRevision: 2, panel: emptyPanel },
    beforeStore: structuredClone(store), afterStoreAt: 100,
    roomReadWindows: [{ entry: 'new-room', startedAt: 10, action: { kind: 'native-click', selector: '.egd-codex-thread-home-new', at: 11 },
      observedAt: 12, beforeSequence: 1, ui: { ...base } }] };
  const open = () => store.fileRequests.push({ operation: 'openProject', status: 200, sequence: store.fileRequests.length + 1,
    request: { boardId: expected.boardId },
    response: { result: { project: { ...expected, status: 'connected' } } } });
  open(); open(); proof.selectedStore = structuredClone(store);
  open(); proof.appliedStore = structuredClone(store);
  open(); proof.afterStore = structuredClone(store);
  return { proof: structuredClone(proof), expected };
}

test('R11 loaded candidate is not proof of painted full path or reachable first-page actions', () => {
  const { proof, expected } = chatProjectReceipts(), chat = proof.details;
  const visible = { visible: true, inside: true, clipped: false, visibleHits: 9 };
  chat.panel.applyBox = { ...visible }; chat.panel.cancelBox = { ...visible };
  assert.equal(chatProjectReviewReady(chat, expected), true);
  assert.equal(chatProjectFooterVisible(chat), true);
  chat.panel.pathPaint.fragments[0].clipped = true;
  chat.panel.pathPaint.fragments[0].hitCount = 0;
  assert.equal(chatProjectReviewReady(chat, expected), true, 'loading and visibility are distinct predicates');
  assert.equal(textFragmentsVisible(chat.panel.pathPaint, expected.displayPath), false);
  for (const box of ['applyBox', 'cancelBox']) for (const patch of [
    { inside: false }, { clipped: true }, { visible: false }, { visibleHits: 8 }]) {
    const changed = structuredClone(chat); Object.assign(changed.panel[box], patch);
    assert.equal(chatProjectFooterVisible(changed), false, 'scrolling cannot waive inaccessible actions');
  }
  for (const patch of [{ threadId: 'foreign' }, { selectedBoardId: '' }, { applyDisabled: true }]) {
    assert.equal(chatProjectReviewReady({ ...chat, panel: { ...chat.panel, ...patch } }, expected), false);
  }
  for (const actions of [{ operation: 'room', outsideBody: true }, { operation: 'request', outsideBody: false }]) {
    assert.equal(chatProjectFooterVisible({ ...chat, panel: { ...chat.panel, actions } }), false);
  }
  chat.roomProject = { saveBox: { ...visible }, cancelBox: { ...visible } };
  assert.equal(chatProjectFooterVisible(chat), false, 'two competing operations cannot share the visible footer');
});

test('native review scroll proof keeps applied/current identity separate from the candidate and rejects hidden text', () => {
  const { proof, expected } = chatProjectReceipts(), before = proof.details;
  before.panel.applyBox = { visible: true, inside: true, clipped: false, visibleHits: 9 };
  before.panel.cancelBox = { ...before.panel.applyBox };
  Object.assign(before.panel.layout.body, { scrollTop: 0, scrollHeight: 640, clientHeight: 380, overflowY: 'auto' });
  before.panel.pathPaint.fragments[0].clipped = true;
  const after = structuredClone(before);
  after.panel.layout.body.scrollTop = 260;
  after.panel.pathPaint.fragments[0].clipped = false;
  assert.equal(assertChatProjectReviewScroll(before, after, expected), true);
  for (const corrupt of [
    value => value.panel.layout.body.scrollTop = 0,
    value => value.panel.layout.body.scrollWidth += 2,
    value => value.panel.pathPaint.fragments[0].hitCount = 0,
    value => value.panel.pathPaint.fragments[0].clipped = true,
    value => value.panel.titlePaint.fragments[0].inside = false,
    value => value.panel.cancelBox.visibleHits = 8,
    value => value.panel.selectedBoardId = 'foreign',
    value => value.target = null, value => value.draftRevision++,
    value => value.roomId = 'active-board', value => value.composerValue = 'changed',
  ]) {
    const changed = structuredClone(after); corrupt(changed);
    assert.throws(() => assertChatProjectReviewScroll(before, changed, expected));
  }
  const hiddenBefore = structuredClone(before); hiddenBefore.panel.applyBox.clipped = true;
  assert.throws(() => assertChatProjectReviewScroll(hiddenBefore, after, expected), /first-page action footer/);
});

test('room review uses its own fixed Save/Cancel operation and complete path, never hidden request controls', () => {
  const { proof, expected } = chatProjectReceipts(), before = proof.details;
  before.panel.actions.operation = 'room';
  Object.assign(before.panel.layout.body, { scrollTop: 0, scrollHeight: 640, clientHeight: 380, overflowY: 'auto' });
  const box = { visible: true, inside: true, clipped: false, visibleHits: 9 };
  before.roomProject = { selectedBoardId: expected.boardId, saveDisabled: false, saveBox: { ...box }, cancelBox: { ...box },
    layout: structuredClone(before.panel.layout),
    detailsPaint: { ...structuredClone(before.panel.pathPaint), text: `${expected.title} ${expected.displayPath}` } };
  before.panel.layout.details = { scrollWidth: 0, clientWidth: 0 };
  before.roomProject.detailsPaint.fragments[0].clipped = true;
  assert.equal(chatProjectReviewReady(before, expected, 'room'), true);
  assert.equal(chatProjectFooterVisible(before, 'room'), true);
  assert.equal(chatProjectFooterVisible(before), false);
  const after = structuredClone(before);
  after.panel.layout.body.scrollTop = 260;
  after.roomProject.detailsPaint.fragments[0].clipped = false;
  assert.equal(assertChatProjectReviewScroll(before, after, expected, 'room'), true);
  for (const corrupt of [value => value.roomProject.selectedBoardId = 'other',
    value => value.roomProject.detailsPaint.text = expected.title,
    value => value.roomProject.detailsPaint.fragments[0].hitCount = 0,
    value => value.roomProject.saveBox.inside = false,
    value => value.panel.applyBox = { ...box }]) {
    const changed = structuredClone(after); corrupt(changed);
    assert.throws(() => assertChatProjectReviewScroll(before, changed, expected, 'room'));
  }
});

test('Chat wait diagnostics retain the actual failed predicates with bounded Range summaries, not offscreen File prefixes', () => {
  const { proof, expected } = chatProjectReceipts(), chat = proof.details;
  chat.panel.pathPaint.text = 'x'.repeat(20000);
  chat.panel.pathPaint.fragments = Array.from({ length: 2000 }, () => ({ inside: false, clipped: true,
    hitCount: 0, rect: { top: 550, bottom: 570 }, clip: { top: 130, bottom: 520 } }));
  const diagnostic = chatProjectWaitDiagnostic(chat, expected);
  assert.equal(diagnostic.conditions.sameThread, true);
  assert.equal(diagnostic.conditions.selectedBoardMatches, true);
  assert.equal(diagnostic.conditions.pathVisible, false);
  assert.equal(diagnostic.conditions.footerVisible, false);
  assert.equal(diagnostic.panel.path.textLength, 20000);
  assert.equal(diagnostic.panel.path.text.length, 240);
  assert.equal(diagnostic.panel.path.fragmentCount, 2000);
  assert.equal(diagnostic.panel.path.fragments.length, 8);
  assert.ok(JSON.stringify(diagnostic).length < 6000);
  assert.equal(Object.hasOwn(diagnostic, 'fileView'), false);
});

test('Chat native project evidence separates active Board, pending selection, Apply, Cancel and Remove', () => {
  const { proof, expected } = chatProjectReceipts();
  assert.equal(assertChatProjectEvidence(proof, expected), true);
  for (const corrupt of [value => value.initial.target = expected,
    value => value.panelInitial.panel.selectedBoardId = expected.boardId,
    value => value.selectedBeforeCancel.target = expected, value => value.cancelled.target = expected,
    value => value.applied.target.projectId = 'foreign', value => value.cancelledAfterApply.target = null,
    value => value.cancelledAfterApply.draftRevision++, value => value.removed.target = expected,
    value => value.reopenedAfterRemove.panel.selectedBoardId = expected.boardId,
    value => value.details.panel.pathPaint.fragments[0].clipped = true,
    value => value.details.panel.layout.body.scrollWidth += 10,
    value => value.details.panel.titlePaint.fragments[0].hitCount = 0,
    value => value.details.composerValue = 'unexpected', value => value.details.threadId = 'other-room',
    value => value.details.roomId = 'empty-room',
    value => value.details.messageCount = 1, value => value.details.conversationId = 'provider-room',
    value => value.details.activeBoardId = 'other-board', value => value.narrowApplied.openerOverflowPx = 0,
    value => value.narrowApplied.openerBox.clipped = true,
    value => value.appliedStore = structuredClone(value.selectedStore),
    value => value.afterStore.fileRequests.at(-1).request.boardId = 'foreign',
    value => value.afterStore.fileRequests.at(-1).response.result.project.rootId = 'foreign',
    value => value.afterStore.terminalRequests.push({ route: '/terminal/write' }),
    value => value.afterStore.nativeProcessSpawns++, value => value.afterStore.providerTurns++,
    value => value.afterStore.pickerResults.push({}), value => value.afterStore.sessions.push({})]) {
    const changed = structuredClone(proof); corrupt(changed); assert.throws(() => assertChatProjectEvidence(changed, expected));
  }
});

test('request-project baseline permits only canonical read-only empty-default receipts, not implicit Board authority or writes', () => {
  const { proof, expected } = chatProjectReceipts(), roomId = proof.initial.roomId;
  const row = { operation: 'readRoomProjectDefault', status: 200, sequence: 6, at: 50, request: { roomId },
    response: { ok: true, result: { roomId, override: null, inheritance: null, source: null, status: 'none', project: null } } };
  proof.afterStore.fileRequests.push(row);
  assert.equal(assertChatProjectEvidence(proof, expected), true);
  for (const corrupt of [value => value.operation = 'saveRoomProjectDefault', value => value.request.roomId = proof.initial.threadId,
    value => value.request.boardId = expected.boardId, value => value.response.result.source = 'board',
    value => value.response.result.project = expected]) {
    const changed = structuredClone(proof); corrupt(changed.afterStore.fileRequests.at(-1));
    assert.throws(() => assertChatProjectEvidence(changed, expected));
  }
});

test('R13 initial Dock room read and native new-room reads are bound to separate observed entry windows', () => {
  const { proof, expected } = chatProjectReceipts();
  const oldUi = { ...proof.initial, threadId: 'initial-local-thread', roomId: 'initial-canonical-binding',
    composerThreadId: 'initial-local-thread' };
  proof.beforeDock = { threadId: oldUi.threadId, roomId: oldUi.roomId };
  proof.roomReadWindows.unshift({ entry: 'dock-room', startedAt: 1,
    action: { kind: 'native-click', selector: '#egd-dock .egd-dock-btn[data-id="chat"]', at: 3 },
    observedAt: 5, ui: oldUi, beforeSequence: 1, throughSequence: 2,
    leaveAction: { kind: 'native-click', selector: '.egd-codex-conversation-back', at: 7 },
    homeUi: { homeNewBox: { visible: true } }, endedAt: 8 });
  proof.roomReadWindows[1].beforeSequence = 2;
  const receipt = (roomId, sequence, at) => ({ operation: 'readRoomProjectDefault', status: 200, sequence, at,
    request: { roomId }, response: { ok: true, result: { roomId, override: null, inheritance: null, project: null, source: null, status: 'none' } } });
  const oldRead = receipt(oldUi.roomId, 2, 2), newRead = receipt(proof.initial.roomId, 7, 14);
  proof.afterStore.fileRequests = [proof.afterStore.fileRequests[0], oldRead,
    ...proof.afterStore.fileRequests.slice(1).map(row => ({ ...row, sequence: row.sequence + 1 })), newRead];
  assert.equal(assertChatProjectEvidence(proof, expected), true);
  assert.equal(assertChatRoomReadReceipt(oldRead, proof), true);
  assert.equal(assertChatRoomReadReceipt(newRead, proof), true);
  for (const corrupt of [
    value => value.roomReadWindows.shift(),
    value => value.roomReadWindows[0].ui.roomId = 'unobserved-room',
    value => value.roomReadWindows[0].ui.composerThreadId = 'foreign',
    value => value.roomReadWindows[0].action.selector = '.unrelated-control',
    value => value.roomReadWindows[0].homeUi.homeNewBox.visible = false,
    value => value.roomReadWindows[1].ui.roomId = oldUi.roomId,
    value => value.afterStore.fileRequests[1].at = 15,
    value => value.afterStore.fileRequests[1].sequence = 8,
    value => value.afterStore.fileRequests.at(-1).at = 9,
    value => value.afterStore.fileRequests.at(-1).request.roomId = oldUi.roomId,
    value => value.afterStore.fileRequests.at(-1).response.result.roomId = oldUi.roomId,
    value => value.afterStore.fileRequests.at(-1).operation = 'saveRoomProjectDefault',
  ]) {
    const changed = structuredClone(proof); corrupt(changed);
    assert.throws(() => assertChatProjectEvidence(changed, expected));
  }
});

test('full-path dialog rejects measured horizontal overflow even if CSS hides its scrollbar', () => {
  const layout = Object.fromEntries(['dialog', 'body', 'details'].map(name => [name, { clientWidth: 480, scrollWidth: 480, overflowX: 'auto' }]));
  assert.deepEqual(projectDialogLayoutIssues(layout), []);
  for (const name of Object.keys(layout)) {
    const changed = structuredClone(layout); changed[name].scrollWidth = 482;
    assert.deepEqual(projectDialogLayoutIssues(changed), [`${name}:horizontal-overflow`]);
    changed[name].overflowX = 'hidden';
    assert.deepEqual(projectDialogLayoutIssues(changed), [`${name}:horizontal-overflow`]);
    changed[name].clientWidth = 0;
    assert.deepEqual(projectDialogLayoutIssues(changed), [`${name}:missing-layout`]);
  }
});

test('D-X3 receipt validators require explicit Save, canonical room identity and persisted re-read; no UI pass is inferred', () => {
  const expected = { roomId: 'client-binding-not-local-id', boardId: 'board-1', projectId: 'project-1',
    rootId: 'root-1', title: 'QA room project', displayPath: '/owned/qa/workspace' };
  const none = { ok: true, result: { roomId: expected.roomId, inheritance: null, override: null, project: null, source: null, status: 'none' } };
  const connected = { ok: true, result: { roomId: expected.roomId, inheritance: { boardId: expected.boardId }, override: null,
    source: 'board', status: 'connected', project: { ...expected, status: 'connected' } } };
  assert.equal(assertRoomDefaultResponse(none, { roomId: expected.roomId }), true);
  assert.equal(assertRoomDefaultResponse(connected, expected), true);
  const state = { roomDefaults: [], persisted: { bindings: [{ scope: 'board', key: expected.boardId, projectId: expected.projectId }] },
    fileRequests: [{ operation: 'readRoomProjectDefault', sequence: 1, request: { roomId: expected.roomId }, status: 200, response: none }],
    terminalRequests: [], pickerResults: [{}], sessions: [], currentOriginalSha256: 'unchanged',
    providerTurns: 0, nativePickerInvocations: 0, nativeProcessSpawns: 0 };
  const proof = { initial: structuredClone(state), cancelled: structuredClone(state), beforeReopenSequence: 3 };
  state.fileRequests.push({ operation: 'saveRoomProjectDefault', sequence: 3, status: 200,
    request: { roomId: expected.roomId, boardId: expected.boardId, expectedProjectId: expected.projectId, expectedRootId: expected.rootId }, response: connected });
  state.roomDefaults.push({ roomId: expected.roomId, boardId: expected.boardId });
  proof.saved = structuredClone(state); proof.overrideCleared = structuredClone(state);
  state.fileRequests.push({ operation: 'readRoomProjectDefault', sequence: 4, request: { roomId: expected.roomId }, status: 200, response: connected });
  proof.reopened = structuredClone(state);
  assert.equal(assertRoomDefaultStoreEvidence(proof, expected), true);
  for (const corrupt of [value => value.initial.fileRequests[0].response.result.roomId = 'local-thread-id',
    value => value.cancelled.roomDefaults.push({ roomId: expected.roomId, boardId: expected.boardId }),
    value => value.cancelled.fileRequests.push(structuredClone(value.saved.fileRequests[1])),
    value => value.saved.fileRequests[1].request.expectedRootId = 'foreign',
    value => value.saved.fileRequests[1].status = 409,
    value => value.saved.fileRequests[1].response.result.source = 'room',
    value => value.overrideCleared.roomDefaults = [],
    value => value.overrideCleared.fileRequests.push(structuredClone(value.saved.fileRequests[1])),
    value => value.reopened.fileRequests.at(-1).sequence = 2,
    value => value.beforeReopenSequence = 4,
    value => value.reopened.fileRequests.push({ operation: 'readRoomProjectDefault', status: 200, request: { roomId: 'local-thread-id' } }),
    value => value.reopened.fileRequests.push({ operation: 'attachProject', status: 200, request: {} }),
    value => value.reopened.roomDefaults.push({ roomId: 'other-room', boardId: expected.boardId }),
    value => value.reopened.fileRequests.at(-1).response.result.project = null,
    value => value.reopened.persisted.bindings.push({ scope: 'room', key: expected.roomId }),
    value => value.reopened.terminalRequests.push({ route: '/terminal/write' }),
    value => value.reopened.currentOriginalSha256 = 'changed', value => value.reopened.providerTurns++]) {
    const changed = structuredClone(proof); corrupt(changed); assert.throws(() => assertRoomDefaultStoreEvidence(changed, expected));
  }
});

test('D-X3 UI receipts separate saved default, request override, Cancel and native same-room reopen', () => {
  const target = { boardId: 'owned-board', projectId: 'project-1', rootId: 'root-1', title: 'Owned room project', displayPath: '/owned/workspace' };
  const expected = { ...target, roomId: 'original-client-binding' };
  const paint = text => ({ text, styleVisible: true, textNodeCount: 1, missingTextRects: 0,
    fragments: [{ inside: true, clipped: false, hitCount: 3, rect: { width: 200, height: 18 } }] });
  const layout = Object.fromEntries(['dialog', 'body', 'details'].map(name => [name, { clientWidth: 480, scrollWidth: 480 }]));
  const base = { threadId: 'local-thread-not-room-binding', threadTitle: 'Actual empty room', roomId: expected.roomId,
    composerThreadId: 'local-thread-not-room-binding', conversationId: null, draft: '', composerValue: '', messageCount: 0,
    activeBoardId: target.boardId, target: null, draftRevision: 2, removeBox: null };
  const roomProject = { selectedBoardId: target.boardId, saveDisabled: false, layout, currentSource: 'board', currentStatus: 'connected',
    detailsPaint: paint(`${target.title} ${target.displayPath} 저장 전 확인`) };
  const selected = { ...base, roomProject };
  const saved = { ...base, openerText: `실행 프로젝트 · ${target.title}`, openerDescription: `${target.title} · ${target.displayPath}`,
    projectSourcePaint: paint('Board 상속') };
  const cleared = { ...saved, draftRevision: 4 };
  const ui = { initial: { ...base, roomProject: { selectedBoardId: '', saveDisabled: true } },
    selectedBeforeCancel: selected, cancelled: base, selectedBeforeSave: selected, saved,
    overrideApplied: { ...saved, target, draftRevision: 3, projectSourcePaint: paint('이번 요청') },
    overrideCleared: cleared, left: { homeNewBox: { visible: true } },
    reopened: { ...cleared, roomProject }, reopenedClosed: cleared };
  assert.equal(roomProjectDetailsVisible(roomProject, expected), true);
  assert.equal(assertRoomDefaultUiEvidence(ui, expected, base), true);
  for (const corrupt of [value => value.initial.roomId = target.boardId,
    value => value.selectedBeforeSave.roomId = base.threadId,
    value => value.initial.roomProject.selectedBoardId = target.boardId,
    value => value.saved.draftRevision++, value => value.cancelled.target = target,
    value => value.reopened.roomProject.detailsPaint.fragments[0].hitCount = 0,
    value => value.reopened.roomProject.layout.body.scrollWidth += 20,
    value => value.reopened.roomProject.currentSource = 'room',
    value => value.overrideApplied.projectSourcePaint.text = 'Board 상속',
    value => value.overrideApplied.target = null,
    value => value.overrideCleared.target = target, value => value.overrideCleared.removeBox = { visible: true },
    value => value.overrideCleared.projectSourcePaint.text = '실행 프로젝트',
    value => value.overrideCleared.projectSourcePaint.fragments[0].clipped = true,
    value => value.saved.openerDescription = '', value => value.reopened.draftRevision++,
    value => value.reopened.threadId = 'new-room', value => value.reopened.threadTitle = 'Substituted room',
    value => value.reopenedClosed.conversationId = 'provider-conversation',
    value => value.reopenedClosed.messageCount++, value => value.left.homeNewBox.visible = false]) {
    const changed = structuredClone(ui); corrupt(changed);
    assert.throws(() => assertRoomDefaultUiEvidence(changed, expected, base));
  }
  assert.throws(() => assertRoomDefaultUiEvidence(ui, { ...expected, roomId: base.threadId }, base));
});

test('room-folder response comparison distinguishes room authority from preserved Board inheritance', () => {
  const expected = { roomId: 'client-room', boardId: 'owned-board', projectId: 'room-project', rootId: 'room-root', displayPath: '/owned/room' };
  const packet = { ok: true, result: { roomId: expected.roomId, source: 'room', status: 'connected',
    inheritance: { boardId: expected.boardId }, override: { projectId: expected.projectId }, project: { ...expected, status: 'connected' } } };
  assert.deepEqual(assertRoomFolderResponse(packet, expected, 'room'), { roomId: expected.roomId,
    status: 'connected', source: 'room', boardId: null, projectId: expected.projectId, rootId: expected.rootId });
  const board = structuredClone(packet); board.result.source = 'board'; board.result.override = null;
  assert.equal(assertRoomFolderResponse(board, expected, 'board').boardId, expected.boardId);
  for (const corrupt of [p => { p.ok = false; }, p => { p.result.roomId = 'provider-conversation'; },
    p => { p.result.source = 'board'; }, p => { p.result.status = 'none'; }, p => { p.result.inheritance = null; },
    p => { p.result.override.projectId = 'foreign'; }, p => { p.result.project.rootId = 'foreign'; },
    p => { p.result.project.displayPath = '/foreign'; }, p => { p.result.project.status = 'disconnected'; }]) {
    const changed = structuredClone(packet); corrupt(changed); assert.throws(() => assertRoomFolderResponse(changed, expected, 'room'));
  }
  assert.throws(() => assertRoomFolderResponse(packet, expected, 'request'));
});

test('room-folder UI proof requires complete preview, fixed footer, unchanged request draft and original client binding', () => {
  // Validator samples only; these cannot stand in for native browser evidence.
  const target = { boardId: 'owned-board', projectId: 'board-project', rootId: 'board-root', title: 'Owned Board project', displayPath: '/owned/board' };
  const expected = { ...target, roomId: 'client-binding' }, workspace = '/owned/room-folder';
  const paint = text => ({ text, styleVisible: true, textNodeCount: 1, missingTextRects: 0,
    fragments: [{ inside: true, clipped: false, hitCount: 3, rect: { width: 200, height: 18 } }] });
  const box = { visible: true, inside: true, clipped: false, visibleHits: 9 };
  const layout = Object.fromEntries(['dialog', 'body', 'editor', 'details'].map(key => [key, { clientWidth: 480, scrollWidth: 480 }]));
  const original = { threadId: 'local-thread', roomId: expected.roomId, conversationId: null };
  const base = { ...original, composerThreadId: original.threadId, messageCount: 0, draft: '', composerValue: '',
    target, draftRevision: 10, roomProject: { effectiveSource: 'request', editorBox: null },
    panel: { applyBox: null, cancelBox: null, actions: { operation: 'room', outsideBody: true } } };
  const preview = { ...base, roomProject: { ...base.roomProject, editorBox: box, mode: 'folder', saveDisabled: false,
    detailsPaint: paint(`선택한 방 전용 폴더 ${workspace}`), saveBox: box, cancelBox: box, layout } };
  const ui = { initial: base, osCancelled: { ...base, roomProject: { ...base.roomProject, saveDisabled: true } },
    preparedCancel: preview, cancelled: base, preparedSave: preview,
    saved: { ...base, roomProject: { ...base.roomProject, currentSource: 'room', currentStatus: 'connected', savedText: '방 기본값 저장됨' } },
    roomRevealed: { ...base, target: null, projectSourcePaint: paint('방 기본'), openerDescription: workspace },
    requestAgain: { ...base, draftRevision: 12 },
    clearPrepared: { ...preview, draftRevision: 12, roomProject: { ...preview.roomProject, mode: 'inherit' } },
    cleared: { ...base, draftRevision: 12, roomProject: { ...base.roomProject, currentSource: 'board', currentStatus: 'connected', savedText: '방 전용 지정 해제됨' } },
    boardRevealed: { ...base, target: null, projectSourcePaint: paint('Board 상속'), openerDescription: target.displayPath } };
  assert.equal(roomFolderPreviewVisible(preview, workspace), true);
  assert.equal(assertRoomFolderUiEvidence(ui, expected, original, workspace), true);
  const mutations = [u => { u.saved.roomId = 'provider-conversation'; }, u => { u.saved.composerThreadId = 'other'; },
    u => { u.cancelled.messageCount++; }, u => { u.saved.draft = 'sent'; }, u => { u.saved.composerValue = 'sent'; },
    u => { u.preparedCancel.target = { ...target, rootId: 'foreign' }; }, u => { u.cancelled.draftRevision++; },
    u => { u.saved.roomProject.effectiveSource = 'room'; }, u => { u.preparedSave.roomProject.detailsPaint.fragments[0].clipped = true; },
    u => { u.preparedSave.roomProject.detailsPaint.text = '/different'; }, u => { u.preparedSave.roomProject.saveBox.visibleHits = 6; },
    u => { u.preparedSave.roomProject.layout.body.scrollWidth += 3; }, u => { u.preparedSave.panel.actions.outsideBody = false; },
    u => { u.osCancelled.roomProject.saveDisabled = false; }, u => { u.cancelled.roomProject.editorBox = box; },
    u => { u.saved.roomProject.savedText = ''; }, u => { u.saved.roomProject.currentSource = 'board'; },
    u => { u.clearPrepared.roomProject.mode = 'folder'; }, u => { u.cleared.roomProject.currentSource = 'room'; },
    u => { u.cleared.roomProject.savedText = ''; }, u => { u.roomRevealed.target = target; },
    u => { u.boardRevealed.projectSourcePaint.text = '없음'; }, u => { u.boardRevealed.openerDescription = ''; }];
  for (const corrupt of mutations) {
    // JSON avoids aliasing shared unit samples, like separately collected UI observations.
    const changed = JSON.parse(JSON.stringify(ui)); corrupt(changed);
    assert.throws(() => assertRoomFolderUiEvidence(changed, expected, original, workspace));
  }
  assert.throws(() => assertRoomFolderUiEvidence(ui, { ...expected, roomId: 'active-board' }, original, workspace));
});

test('room-folder native acceptance fails closed without its OS-only provenance and preserves all production flow boundaries', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-project-file-flow.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('roomProjectPickerTransform') < source.indexOf("await harness.press('meta+-')"));
  assert.ok(source.includes("roomPickerDescriptor?.kind === 'chat-room-project-os-directory-result-v1'"));
  for (const selector of ['chat-room-project-choose-folder', 'chat-room-project-inherit', 'chat-room-project-save', 'chat-room-project-cancel']) assert.ok(source.includes(`'${selector}'`));
  assert.ok(source.includes("pickerResults: ['cancel', 'select-owned-room', 'select-owned-room']"));
  assert.ok(source.includes('assertRoomFolderStoreEvidence(folderProof, roomExpected)'));
  assert.ok(source.includes("basis: 'actual room-default receipts; no Chat send performed'"));
  for (const { source: observation } of projectUiObservationSources()) {
    assert.ok(Buffer.byteLength(observation) <= PROJECT_OBSERVATION_SOURCE_BUDGET);
    for (const key of ['roomMode:', 'roomSource:', 'effectiveSource:']) assert.ok(observation.includes(key));
  }
  assert.doesNotMatch(source, /\.setSelectionRange\(|\.openProject\(|\.consume\(|\.attachProject\(/);
});

test('Board primary title avoids secondary buttons without hiding the actually observed whole-row overflow', () => {
  assert.equal(boardPrimarySelector('Owned QA Project Board'), '[data-testid="board-open"][aria-label="Board Owned QA Project Board 열기"] > .egd-agenda-switch-row-main > .egd-agenda-switch-row-title');
  const observed = { count: 1, primaryCount: 1, primaryContainsSecondary: false, primaryInsideSecondary: false,
    row: { left: 101, top: 210, right: 461, bottom: 280, width: 360, height: 70 },
    clip: { left: 101, top: 202, right: 439, bottom: 280 }, listOverflowX: 22 };
  assert.deepEqual(boardRowFitIssues(observed), ['board-row-horizontally-clipped', 'board-list-horizontal-overflow']);
  const fitted = { ...observed, row: { ...observed.row, right: 439, width: 338 }, listOverflowX: 0 };
  assert.deepEqual(boardRowFitIssues(fitted), []);
  assert.ok(boardRowFitIssues({ ...fitted, primaryInsideSecondary: true }).includes('secondary-action-not-primary'));
  assert.ok(boardRowFitIssues({ ...fitted, primaryCount: 2 }).includes('ambiguous-board-row-or-primary'));
  assert.ok(boardRowFitIssues({ ...fitted, clip: { ...fitted.clip, bottom: 270 } }).includes('board-row-vertically-clipped'));
});

test('canonical fixture token, explicit model-free opt-in and existing two CLI arguments are required', () => {
  assert.equal(assertProjectEnvironment(ENV), true);
  for (const env of [{}, { ...ENV, EGDESK_QA_REAL_TURN: '1' },
    { ...ENV, EGDESK_QA_PROJECT_FILE_FIXTURE: '0' }, { ...ENV, EGDESK_QA_FIXTURE_TRANSPORT: '0' },
    { ...ENV, EGDESK_QA_CLAUDE_FIXTURE: '1' }, { ...ENV, EGDESK_QA_FIXTURE_TOKEN: '' },
    { ...ENV, EGDESK_QA_FIXTURE_TOKEN: undefined, EGDESK_QA_TOKEN: 'not-the-canonical-token' }]) assert.throws(() => assertProjectEnvironment(env));
  const now = Date.parse('2026-10-25T19:00:00Z');
  assert.deepEqual(parseCli(['--profile', '/tmp/example', '--deadline-utc', '2026-10-26T01:00:00Z'], now),
    { profile: '/tmp/example', deadlineMs: Date.parse('2026-10-26T01:00:00Z') });
  assert.throws(() => parseCli(['--profile', '/tmp/example'], now));
  assert.throws(() => parseCli(['--profile', '/tmp/example', '--deadline-utc', '2026-10-26T01:00:00Z', '--launch', '1'], now));
});

// These are evidence-validator unit inputs, not browser/DOM outcomes. Nothing
// in this test executes runProjectFileFlow or reports an actual UI pass.
function locationReceipts(store) {
  const box = { visible: true, inside: true, clipped: false, visibleHits: 9 };
  const paint = text => ({ text, styleVisible: true, textNodeCount: 1, missingTextRects: 0,
    fragments: [{ inside: true, clipped: false, hitCount: 3, rect: { width: 200, height: 15 } }] });
  return PROJECT_VIEWPORTS.map(size => {
    const compact = { ...size, cardId: 'file-1', snapshot: { projectId: 'project-1', rootId: 'root-1' },
      fileView: box, result: { outcome: 'passed', text: store.outputMarker, headlineBox: box, outputBox: box,
        exitTextPaint: paint('종료 코드 0'), location: { detailsTag: 'details', toggleTag: 'summary',
          detailsCount: 1, toggleCount: 1, cwdCount: 1, childrenOwned: true, open: false,
          toggleText: '실행 위치 · Owned QA Project', toggleBox: box, cwdBox: { ...box, visible: false },
          cwdPaint: { ...paint(`실행 폴더 · ${store.workspace}`), missingTextRects: 1, fragments: [] } } } };
    const expanded = structuredClone(compact);
    expanded.result.location.open = true;
    expanded.result.location.cwdBox = box;
    expanded.result.location.cwdPaint = paint(`실행 폴더 · ${store.workspace}`);
    const capture = stage => ({ ...size, stage, status: 'captured', path: `/unit/${stage}-${size.width}.png`,
      subjectsVisible: true, fullRendererInside: true, visualPass: null });
    const action = { kind: 'native-click', selector: '[id="file-1"] [data-testid="file-check-location-toggle"]' };
    return { ...size, compact, expanded, restored: structuredClone(compact), openAction: { ...action }, closeAction: { ...action },
      compactCapture: capture('readable-result'), expandedCapture: capture(`project-result-location-expanded-${size.width}x${size.height}`),
      beforeStore: structuredClone(store), afterStore: structuredClone(store) };
  });
}

function receipts() {
  const state = { workspace: '/owned/unit/workspace', command: 'printf unit', outputMarker: 'UNIT_OUTPUT',
    originalSha256: 'same-hash', currentOriginalSha256: 'same-hash', providerTurns: 0, nativePickerInvocations: 0,
    nativeProcessSpawns: 0, fileRequests: [], terminalRequests: [], pickerResults: [],
    persisted: { projects: [], bindings: [] }, sessions: [] };
  const clone = () => structuredClone(state);
  const proof = { boardId: 'board-1', initial: clone() };
  state.pickerResults.push({ requestId: 'cancel', selection: null, sequence: 2 });
  proof.cancelled = clone();
  state.fileRequests.push({ operation: 'beginPicker', sequence: 4, response: { result: { requestId: 'select' } } },
    { operation: 'completePicker', sequence: 6, request: { requestId: 'select' }, response: { result: { selectionId: 'grant' } } },
    { operation: 'attachProject', sequence: 7, status: 200, request: { boardId: 'board-1', selectionId: 'grant' }, response: { result: { projectId: 'project-1' } } });
  state.pickerResults.push({ requestId: 'select', selection: state.workspace, sequence: 5 });
  state.persisted = { projects: [{ id: 'project-1' }], bindings: [{ key: 'board-1' }] };
  proof.connected = clone(); proof.uiConnected = { snapshot: { projectId: 'project-1' } };
  state.fileRequests.push({ operation: 'openProject' }); proof.reopened = clone();
  state.fileRequests.push({ operation: 'setProjectScripts', request: { scripts: [{ command: state.command }] } });
  proof.saved = clone();
  const write = nonce => ({ route: '/terminal/write', nonce, accepted: true,
    request: { sessionId: 'reused-owned-session', data: terminalScriptLine({ command: state.command, cwd: state.workspace, nonce }) } });
  state.terminalRequests.push(write('firstnonce1234')); state.sessions.push({ writes: 1 });
  proof.completed = clone();
  proof.uiBeforeRun = { cardId: 'file-1', activeEntityId: 'file-1', camera: { zoom: 0.96, zoomTarget: 0.96,
    pan: { x: 100, y: 200 }, panTarget: { x: 100, y: 200 } } };
  proof.uiCompleted = { ...structuredClone(proof.uiBeforeRun), result: { outcome: 'passed', text: '종료 코드 0 UNIT_OUTPUT', location: { open: false } }, terminals: [{ text: 'UNIT_OUTPUT' }] };
  proof.resultLocations = locationReceipts(proof.completed);
  proof.dirty = clone(); proof.uiDirty = { snapshot: { originalDirty: true }, status: '원본에 저장하지 않은 변경' };
  proof.restored = clone();
  state.terminalRequests.push(write('secondnonce1234'), { route: '/terminal/read', outputLost: true }); state.sessions[0].writes = 2;
  proof.lost = clone(); proof.uiLost = { result: { outcome: 'unknown', busy: false } };
  proof.quiet = clone(); proof.noReplayObservedMs = 1500;
  proof.screenshots = PROJECT_CAPTURE_STAGES.flatMap(stage => PROJECT_VIEWPORTS.map(size =>
    ({ stage, ...size, status: 'captured', path: `/unit/${stage}-${size.width}.png`, visualPass: null, subjectsVisible: true, fullRendererInside: true })));
  return proof;
}

test('File result location requires native summary clicks, hidden compact path, actual full-path paint and zero disclosure effects', () => {
  const proof = receipts(), { workspace, outputMarker } = proof.completed;
  assert.equal(assertFileResultLocationEvidence(proof.resultLocations, workspace, outputMarker), true);
  const polled = structuredClone(proof.resultLocations);
  polled[0].beforeStore.sessions[0].reads = 2; polled[0].afterStore.sessions[0].reads = 5;
  assert.equal(assertFileResultLocationEvidence(polled, workspace, outputMarker), true);
  for (const corrupt of [samples => samples.pop(), samples => samples[0].compact.result.location.open = true,
    samples => samples[0].compact.result.location.cwdBox.visible = true,
    samples => samples[0].compact.result.location.toggleBox.visibleHits = 6,
    samples => samples[0].compact.result.location.detailsTag = 'div',
    samples => samples[0].expanded.result.location.toggleTag = 'button',
    samples => samples[0].expanded.result.location.childrenOwned = false,
    samples => samples[0].expanded.result.location.cwdCount = 2,
    samples => samples[0].expanded.result.location.cwdPaint.text = '실행 폴더 · /other',
    samples => samples[0].expanded.result.location.cwdPaint.fragments[0].clipped = true,
    samples => samples[0].expanded.result.location.cwdPaint.fragments[0].hitCount = 2,
    samples => samples[0].expanded.snapshot.projectId = 'other-project',
    samples => samples[0].openAction.kind = 'page-eval',
    samples => samples[0].openAction.selector = '[data-testid="chat-project-open"]',
    samples => samples[0].closeAction = null, samples => samples[0].restored.result.location.open = true,
    samples => samples[0].expandedCapture.subjectsVisible = false,
    samples => samples[0].expandedCapture.visualPass = true,
    samples => samples[0].expandedCapture.fullRendererInside = false,
    samples => samples[0].afterStore.terminalRequests.push({ route: '/terminal/write' }),
    samples => samples[0].afterStore.sessions.push({ writes: 0 }),
    samples => samples[0].afterStore.fileRequests.push({ operation: 'openProject' }),
    samples => samples[0].afterStore.currentOriginalSha256 = 'changed',
    samples => samples[0].afterStore.providerTurns = 1]) {
    const changed = structuredClone(proof.resultLocations); corrupt(changed);
    assert.throws(() => assertFileResultLocationEvidence(changed, workspace, outputMarker));
  }
  assert.equal(fileResultLocationVisible({}, workspace, false), false);
});

test('evidence requires actual picker sequence, persistence, typed command, one write, original guard, and unknown loss', () => {
  assert.equal(assertProjectFlowEvidence(receipts()), true);
  for (const corrupt of [
    value => value.cancelled.persisted.projects.push({}),
    value => value.cancelled.terminalRequests.push({ route: '/terminal/write' }),
    value => value.connected.pickerResults[1].selection = '/outside',
    value => value.connected.fileRequests[2].request.selectionId = 'injected',
    value => value.connected.fileRequests[0].sequence = 20,
    value => value.uiConnected.snapshot.projectId = 'injected',
    value => value.reopened.pickerResults.push({}),
    value => value.saved.fileRequests[4].request.scripts[0].command = 'other',
    value => value.saved.terminalRequests.push({ route: '/terminal/write' }),
    value => value.completed.terminalRequests.push({ route: '/terminal/write' }),
    value => value.uiCompleted.terminals[0].text = '',
    value => value.uiCompleted.camera.pan.x += 10,
    value => value.uiCompleted.result.location.open = true,
    value => value.resultLocations = [],
    value => value.uiDirty.snapshot.originalDirty = false,
    value => value.dirty.terminalRequests.push({ route: '/terminal/write' }),
    value => value.uiLost.result.outcome = 'passed',
    value => value.lost.terminalRequests.pop(),
    value => value.quiet.terminalRequests.push({ route: '/terminal/write' }),
    value => value.quiet.sessions.push({ writes: 1 }),
    value => value.quiet.terminalRequests[1].request.sessionId = 'unowned-session',
    value => value.quiet.terminalRequests[1].request.data = value.quiet.terminalRequests[0].request.data,
    value => value.noReplayObservedMs = 0,
    value => value.quiet.currentOriginalSha256 = 'modified',
    value => value.quiet.nativeProcessSpawns = 1,
    value => value.quiet.nativePickerInvocations = 1,
    value => value.quiet.providerTurns = 1,
  ]) {
    const value = receipts(); corrupt(value); assert.throws(() => assertProjectFlowEvidence(value));
  }
});

test('all eight separate-content captures are mandatory and none can declare automatic visual success', () => {
  assert.deepEqual(PROJECT_VIEWPORTS, [{ width: 1280, height: 800 }, { width: 600, height: 600 }]);
  assert.deepEqual(PROJECT_CAPTURE_STAGES, ['connected-fileview', 'typed-command-editor', 'readable-result', 'terminal-output']);
  for (const mutate of [
    value => value.screenshots.pop(), value => value.screenshots[0].status = 'unsupported',
    value => value.screenshots[0].width = 800, value => value.screenshots[0].subjectsVisible = false,
    value => value.screenshots[0].fullRendererInside = false,
    value => value.screenshots[0].visualPass = true, value => value.screenshots[0].path = null,
  ]) { const value = receipts(); mutate(value); assert.throws(() => assertProjectFlowEvidence(value)); }
});

test('split observer sources fit the actual unchanged profile-bound MCP wrapper, retaining text/geometry/native checks', () => {
  const harness = fs.readFileSync(new URL('./firefox-mcp-chat-harness.mjs', import.meta.url), 'utf8');
  assert.ok(harness.includes("Buffer.byteLength(boundSource, 'utf8') >= 16 * 1024"));
  const start = harness.indexOf('const boundSource = `') + 'const boundSource = '.length;
  const end = harness.indexOf(';\n    if (Buffer.byteLength(boundSource', start);
  assert.ok(start > 0 && end > start);
  // Build only the exact existing wrapper string; no browser code is executed.
  const bind = new Function('profile', 'functionSource', 'return ' + harness.slice(start, end).replaceAll('this.#profile', 'profile'));
  const profile = '/private/var/folders/kp/6__wg5p50y74lp5cwm4hm8vm0000gn/T/egdesk-chat-test-nYm8Iu';
  const sources = projectUiObservationSources();
  assert.deepEqual(sources.map(row => row.part), ['file', 'result', 'chat', 'terminal']);
  assert.equal(PROJECT_OBSERVATION_SOURCE_BUDGET, 14 * 1024);
  for (const { part, source, bytes } of sources) {
    assert.equal(bytes, Buffer.byteLength(source)); assert.ok(bytes < PROJECT_OBSERVATION_SOURCE_BUDGET, part);
    for (const prefix of [profile, profile + '-long-경로-"quoted"-'.repeat(30)]) {
      assert.ok(Buffer.byteLength(bind(prefix, source)) < 16 * 1024, part + ': full profile-bound source must fit');
    }
    assert.equal(typeof new Function('return (' + source + ');')(), 'function');
    assert.ok(source.includes('const before = identity()') && source.includes('after: identity()'));
    assert.ok(!/dispatchEvent|\.click\(|\.focus\(|\.value\s*=|\.style\.[a-z]+\s*=|\.open\s*=/.test(source));
    assert.ok(!/globalThis\[|window\.__egdesk\s*=|eval\(/.test(source));
  }
  const byPart = Object.fromEntries(sources.map(row => [row.part, row.source]));
  assert.ok(byPart.file.includes('getComputedStyle(semanticBody).fontSize'));
  assert.ok(byPart.result.includes('cwdPaint: textPaint(locationCwd)') && byPart.result.includes('exitTextPaint: textPaint('));
  assert.ok(byPart.chat.includes('chat-room-project-details') && byPart.chat.includes('scrollWidth: node.scrollWidth, clientWidth: node.clientWidth'));
  assert.ok(byPart.terminal.includes('frameDocument.elementFromPoint') && byPart.terminal.includes('projectedFontPx'));
});

// Transport/coherence-validator unit samples only. No rendered DOM outcomes
// are mocked into an acceptance run and these tests cannot claim a UI pass.
function observationChunks() {
  const identity = { documentURI: 'chrome://browser/content/browser.xhtml', width: 1280, height: 800,
    fileIds: ['file-1'], fileSnapshot: { projectId: 'owned-project', rootId: 'owned-root' },
    activeEntityId: 'file-1', boardId: 'owned-board', camera: { zoom: 1, zoomTarget: 1, pan: { x: 1, y: 2 }, panTarget: { x: 1, y: 2 } },
    threadId: 'local-thread', roomId: 'client-binding', draftRevision: 3, target: null, composerThreadId: 'local-thread',
    resultText: 'actual-result-marker', resultBusy: false, resultOutcome: 'passed', locationOpen: false,
    panelText: 'reviewed project', projectChoice: 'owned-board', roomChoice: '', scrolls: [['div', 'file', 0, 20]],
    terminals: [{ id: 'term-1', sessionId: 'owned-session', text: 'actual-output-marker', level: 'detail' }] };
  const values = {
    file: { count: 1, cardId: 'file-1', snapshot: identity.fileSnapshot, width: 1280, height: 800,
      camera: identity.camera, activeEntityId: 'file-1', fileView: { inside: true } },
    result: { result: { text: identity.resultText, busy: false, outcome: 'passed', location: { open: false } } },
    chat: { chat: { threadId: identity.threadId, roomId: identity.roomId, draftRevision: 3, target: null, composerThreadId: identity.threadId } },
    terminal: { terminals: identity.terminals },
  };
  return ['file', 'result', 'chat', 'terminal'].map(part => ({ part, before: structuredClone(identity),
    value: structuredClone(values[part]), after: structuredClone(identity) }));
}

test('split observations reject changed room/File/viewport/revision/output/scroll identity and never merge cross-state evidence', () => {
  const chunks = observationChunks(), merged = mergeProjectUiObservations(chunks);
  assert.equal(merged.cardId, 'file-1'); assert.equal(merged.chat.roomId, 'client-binding');
  assert.equal(merged.result.outcome, 'passed'); assert.equal(merged.terminals[0].sessionId, 'owned-session');
  for (const mutate of [value => value.roomId = 'local-thread', value => value.threadId = 'other-room',
    value => value.composerThreadId = 'other-room', value => value.fileIds = ['other-file'],
    value => value.fileSnapshot.rootId = 'other-root', value => value.draftRevision++, value => value.target = { projectId: 'other' },
    value => value.width = 600, value => value.camera.pan.x++, value => value.locationOpen = true,
    value => value.resultText = 'new-run-output', value => value.resultBusy = true, value => value.resultOutcome = 'unknown',
    value => value.terminals[0].sessionId = 'other-session', value => value.scrolls[0][3]++,
    value => value.panelText = 'new project preview', value => value.projectChoice = 'other-board']) {
    for (const edge of ['before', 'after']) {
      const changed = observationChunks(); mutate(changed[2][edge]);
      assert.throws(() => mergeProjectUiObservations(changed), { code: 'QA_PROJECT_OBSERVATION_CHANGED' });
    }
  }
  for (const mutate of [value => value.pop(), value => value[2].part = 'file', value => value[0].value.cardId = 'other-file',
    value => value[1].value.result.outcome = 'unknown', value => value[2].value.chat.roomId = 'active-board',
    value => value[3].value.terminals[0].sessionId = 'other-session']) {
    const changed = observationChunks(); mutate(changed); assert.throws(() => mergeProjectUiObservations(changed));
  }
});

test('observation-only retries are bounded, discard changed samples and never retry native input', async () => {
  const sources = projectUiObservationSources(), indexOf = source => sources.findIndex(row => row.source === source);
  let calls = 0;
  const harness = { async evaluateChrome(source) {
    const index = indexOf(source); assert.ok(index >= 0);
    const chunk = observationChunks()[index];
    if (calls < 4 && index === 2) chunk.after.roomId = 'transient-room';
    calls++; return chunk;
  }, click() { assert.fail('observation cannot retry input'); }, press() { assert.fail('observation cannot dispatch keys'); } };
  const value = await observeProjectUi(harness);
  assert.equal(calls, 8); assert.equal(value.observationCoherence.attempts, 2);
  assert.deepEqual(value.observationCoherence.changes, [{ attempt: 1, fields: ['roomId'] }]);
  assert.equal(value.chat.roomId, 'client-binding');
  calls = 0;
  harness.evaluateChrome = async source => {
    const chunk = observationChunks()[indexOf(source)]; calls++;
    if (chunk.part === 'result') chunk.after.locationOpen = true;
    return chunk;
  };
  await assert.rejects(observeProjectUi(harness), /three read-only observation attempts:.*locationOpen/);
  assert.equal(calls, 12);
});

test('R12 smooth-scroll incoherence is discarded until three matching coherent observations, with zero input replay', async () => {
  const sources = projectUiObservationSources();
  let calls = 0, clock = 0, latest;
  const harness = { async evaluateChrome(source) {
    const index = sources.findIndex(row => row.source === source), round = Math.floor(calls++ / 4);
    const chunk = observationChunks()[index];
    if (round < 3) { if (index === 2) chunk.after.scrolls[0][4]++; }
    else for (const edge of ['before', 'after']) chunk[edge].scrolls[0][4] = [32.15, 70, 94][Math.min(round - 3, 2)];
    return chunk;
  }, press() { assert.fail('native End must not be replayed'); }, click() { assert.fail('no click retry'); },
  scrollWithKey() { assert.fail('no additional scroll input'); } };
  const observed = await waitStableProjectUi(harness, 1000, { timeoutMs: 500, intervalMs: 10,
    now: () => clock, pause: async ms => { clock += ms; }, onProgress: value => { latest = value; } });
  assert.equal(calls, 32);
  assert.equal(observed.observationStability.reads, 6);
  assert.equal(observed.observationStability.transientErrors, 1);
  assert.equal(observed.observationStability.stableSamples, 3);
  assert.deepEqual(latest, observed.observationStability);
  assert.deepEqual(latest.samples[0].changes.map(row => row.fields), [['scrolls'], ['scrolls'], ['scrolls']]);
  assert.equal(new Set(latest.samples.slice(-3).map(row => row.fingerprint)).size, 1);
  assert.equal(clock, 50);
});

test('stable observation resets on coherent motion, respects its time/deadline bounds and retains bounded diagnostics', async () => {
  const sources = projectUiObservationSources();
  let calls = 0, clock = 0, latest;
  const harness = { async evaluateChrome(source) {
    const index = sources.findIndex(row => row.source === source), round = Math.floor(calls++ / 4);
    const chunk = observationChunks()[index];
    for (const edge of ['before', 'after']) chunk[edge].scrolls[0][4] = round;
    return chunk;
  }, press() { assert.fail('no native input'); } };
  const options = { timeoutMs: 250, intervalMs: 10, now: () => clock,
    pause: async ms => { clock += ms; }, onProgress: value => { latest = value; } };
  await assert.rejects(waitStableProjectUi(harness, 1000, options), { code: 'QA_PROJECT_STABILITY_TIMEOUT' });
  assert.equal(clock, 250); assert.equal(calls, 100);
  assert.equal(latest.stableSamples, 1); assert.equal(latest.samples.length, 16);
  calls = 0; clock = 0;
  await assert.rejects(waitStableProjectUi(harness, 15, options), { code: 'QA_PROJECT_STABILITY_TIMEOUT' });
  assert.equal(clock, 15); assert.equal(calls, 8);
});

test('non-coherence failures are never retried and settling does not weaken candidate title/path proof', async () => {
  let calls = 0;
  await assert.rejects(waitStableProjectUi({ async evaluateChrome() { calls++; throw new Error('MCP size guard'); } }, 1000,
    { now: () => 0, pause: async () => assert.fail('fatal errors cannot be retried') }), /MCP size guard/);
  assert.equal(calls, 1);
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-project-file-flow.mjs', import.meta.url), 'utf8');
  const key = source.indexOf("sample.scroll = await harness.scrollWithKey(selector, 'End')");
  const settle = source.indexOf('const settled = await waitStableProjectUi', key);
  const proof = source.indexOf('settled candidate title and full path are fully painted', settle);
  assert.ok(key > 0 && settle > key && proof > settle);
  assert.ok(source.includes('textFragmentsVisible(chat?.panel?.titlePaint, expected.title)'));
  assert.ok(source.includes('textFragmentsVisible(chat?.panel?.pathPaint, expected.displayPath)'));
});

test('verifier is attach-only and does not inject attach/openProject or mutate evaluated DOM', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-project-file-flow.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("runUiFlow('firefox-mcp-project-file-flow'"));
  assert.ok(source.includes('captureHeadlessScreenshot'));
  assert.ok(source.includes('resizeHeadless'));
  assert.ok(!/child_process|spawnSync|execFile|bootstrapQaProfile|prepareQaFirefox|createBrowserTab|\.openProject\(/.test(source));
  const observation = source.slice(source.indexOf('function projectTextPaint'), source.indexOf('export async function runProjectFileFlow'));
  assert.ok(!/dispatchEvent|\.click\(|\.focus\(|\.value\s*=|\.style\.[a-z]+\s*=|\.openProject\(/.test(observation));
  assert.ok(observation.includes('NodeFilter.SHOW_TEXT') && observation.includes('range.getClientRects()'));
  assert.ok(observation.includes('exitTextPaint: textPaint('));
  for (const selector of ['file-check-location-details', 'file-check-location-toggle', 'file-check-cwd']) assert.ok(observation.includes(selector));
  assert.ok(observation.includes('cwdPaint: textPaint(locationCwd)'));
  assert.ok(!/\.open\s*=/.test(observation));
  assert.ok(source.includes("sample.openAction = await click(selector, 'expand actual result execution location')"));
  assert.ok(observation.includes('.clientThreadBinding(thread)'));
  assert.ok(observation.includes('scrollWidth: node.scrollWidth, clientWidth: node.clientWidth'));
  assert.ok(!source.includes('/chat/send'));
  assert.ok(!source.includes('열린 창 전체 보기'), 'capture navigation must not compact all content with Fit All');
  assert.ok(!/\.setRequestProjectTarget\(|\.readRequestProject\(|newQaThread\(/.test(source), 'Chat target selection cannot call runtime setters or inject room metadata');
  assert.ok(!/\.saveRoomProjectDefault\(|\.readRoomProjectDefault\(/.test(source), 'room defaults must be driven through native controls');
  assert.ok(source.includes('await selectQaThread(harness, { id: original.threadId, title: original.threadTitle })'));
  assert.ok(source.includes("chatProof.details = await reviewProject('narrow-reopened-project-details')"));
  assert.ok(source.indexOf('chatProjectFooterVisible(before, operation), chatProjectWaitDiagnostic(before, expected)') <
    source.indexOf("sample.scroll = await harness.scrollWithKey(selector, 'End')"), 'first-page footer check precedes any review scrolling');
  assert.ok(source.includes('chatProof.lastWait = { phase, at: Date.now(), observation: chatProjectWaitDiagnostic(chat, expected) }'));
  assert.ok(!/\.scrollTop\s*=|\.scrollIntoView\(|\.setSelectionRange\(/.test(source));
  assert.ok(source.includes('row.sequence > roomProof.beforeReopenSequence'));
  for (const selector of ['chat-room-project-open', 'chat-room-project-editor', 'chat-room-project-board',
    'chat-room-project-details', 'chat-room-project-save', 'chat-room-project-cancel', 'chat-room-project-current', 'chat-project-source',
    'chat-project-body', 'chat-project-actions', 'chat-project-scroll-hint']) {
    assert.ok(source.includes(selector));
  }
  assert.ok(source.includes("'new-files-dock'") && source.includes("'reopen-files-dock'"));
  assert.ok(source.includes("acceptance: action === 'detail' ? 'ready-without-summary-click' : 'native-summary-recovery-only'"));
  assert.ok(source.indexOf('await verifyChatProjectSelection();') > source.indexOf('proof.quiet = await state();'));
  assert.ok(source.includes("for (const key of ['Home', ...Array(index).fill('ArrowDown'), 'Enter'])"));
  for (const diagnostic of ['getComputedStyle(semanticBody).fontSize', 'currentLod:', 'projectedFontPx',
    'detailEnterReadable:', 'detailStayReadable:', 'detailEnterSizeFits:', 'cachedEntryFontVerified: false']) {
    assert.ok(observation.includes(diagnostic), diagnostic);
  }
});
