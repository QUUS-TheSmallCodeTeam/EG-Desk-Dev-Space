import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { assertProjectEnvironment, assertProjectFlowEvidence, PROJECT_VIEWPORTS, PROJECT_CAPTURE_STAGES,
  boardPrimarySelector, boardRowFitIssues, fileDetailAction, fileViewportAction, assertFileUiIdentity,
  assertRunKeptView, captureSubjectsVisible, textFragmentsVisible, longCommandForNavigation,
  assertLongCommandNavigation, assertChatProjectEvidence, nativeCommandNavigationKeys,
  commandNavigationObservation, projectDialogLayoutIssues, assertRoomDefaultResponse,
  assertRoomDefaultStoreEvidence, assertRoomDefaultUiEvidence, roomProjectDetailsVisible,
  fileResultLocationVisible, assertFileResultLocationEvidence } from './verify-firefox-mcp-project-file-flow.mjs';
import { parseCli } from './verify-firefox-mcp-headless-ui-regression.mjs';
import { terminalScriptLine } from '../overlay/resources/EGDeskTerminalState.sys.mjs';

const ENV = { EGDESK_QA_PROJECT_FILE_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1',
  EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_TOKEN: 'unit-project-token-no-credentials' };

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
    viewportWidth: 1280, openerText: '실행 프로젝트', openerDescription: '실행 프로젝트', removeBox: null };
  const emptyPanel = { selectedBoardId: '', applyDisabled: true, threadId: base.threadId };
  const selectedPanel = { threadId: base.threadId, selectedBoardId: expected.boardId, applyDisabled: false,
    titlePaint: paint(expected.title), pathPaint: paint(expected.displayPath),
    layout: Object.fromEntries(['dialog', 'body', 'details'].map(name => [name, { clientWidth: 480, scrollWidth: 480, overflowX: 'auto' }])) };
  const applied = { ...base, target: expected, draftRevision: 1, openerText: `실행 프로젝트 · ${expected.title}`,
    openerDescription: `${expected.title} · ${expected.displayPath}`, removeBox: { visible: true } };
  const store = { terminalRequests: [{ route: '/terminal/write' }, { route: '/terminal/write' }],
    fileRequests: [{ operation: 'attachProject' }], pickerResults: [{}, {}], sessions: [{}],
    providerTurns: 0, nativePickerInvocations: 0, nativeProcessSpawns: 0 };
  const proof = { initial: { ...base }, panelInitial: { ...base, panel: emptyPanel },
    selectedBeforeCancel: { ...base, panel: selectedPanel }, cancelled: { ...base },
    selectedBeforeApply: { ...base, panel: selectedPanel }, applied,
    narrowApplied: { ...applied, viewportWidth: 600, openerOverflowPx: 100, openerBox: { visible: true, inside: true, clipped: false } },
    details: { ...applied, viewportWidth: 600, panel: selectedPanel }, cancelledAfterApply: { ...applied },
    removed: { ...base, draftRevision: 2 }, reopenedAfterRemove: { ...base, draftRevision: 2, panel: emptyPanel },
    beforeStore: structuredClone(store) };
  const open = () => store.fileRequests.push({ operation: 'openProject', status: 200, request: { boardId: expected.boardId },
    response: { result: { project: { ...expected, status: 'connected' } } } });
  open(); open(); proof.selectedStore = structuredClone(store);
  open(); proof.appliedStore = structuredClone(store);
  open(); proof.afterStore = structuredClone(store);
  return { proof: structuredClone(proof), expected };
}

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
  const row = { operation: 'readRoomProjectDefault', status: 200, request: { roomId },
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

test('verifier is attach-only and does not inject attach/openProject or mutate evaluated DOM', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-project-file-flow.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("runUiFlow('firefox-mcp-project-file-flow'"));
  assert.ok(source.includes('captureHeadlessScreenshot'));
  assert.ok(source.includes('resizeHeadless'));
  assert.ok(!/child_process|spawnSync|execFile|bootstrapQaProfile|prepareQaFirefox|createBrowserTab|\.openProject\(/.test(source));
  const observation = source.slice(source.indexOf('export async function observeProjectUi'), source.indexOf('export async function runProjectFileFlow'));
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
  assert.ok(source.includes('row.sequence > roomProof.beforeReopenSequence'));
  for (const selector of ['chat-room-project-open', 'chat-room-project-editor', 'chat-room-project-board',
    'chat-room-project-details', 'chat-room-project-save', 'chat-room-project-cancel', 'chat-room-project-current', 'chat-project-source']) {
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
