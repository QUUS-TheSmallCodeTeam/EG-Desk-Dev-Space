// Attach-only acceptance. Main owns the fresh headless profile and listener.
// UI, picker grants, File service/SQLite and ScriptRun collector are real;
// only the OS directory result and terminal HTTP shell I/O are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chrome, loopbackJson, runUiFlow, selectorForId, selectQaThread } from './egdesk-qa-ui-flow.mjs';
import { projectFileFixtureEnabled, validateQaFixtureIsolation, qaBridgeConfig, qaBridgeUrl, QA_PROJECT_PICKER_FILE } from './egdesk-qa-fixture-isolation.mjs';
import { FirefoxMcpChatHarness } from './firefox-mcp-chat-harness.mjs';
import { parseCli, assertBeforeDeadline, observeGuard, observeFirstUse, resizeHeadless,
  waitStableViewport, waitFor, observeTargets, targetIssues, captureHeadlessScreenshot } from './verify-firefox-mcp-headless-ui-regression.mjs';
import { parseProjectTerminalWrite } from './egdesk-project-file-fixture.mjs';
import { chromeWithFileEditor, resolveShownFileEditor } from './egdesk-qa-file-editor.mjs';

export const PROJECT_VIEWPORTS = Object.freeze([{ width: 1280, height: 800 }, { width: 600, height: 600 }]);
export const PROJECT_CAPTURE_STAGES = Object.freeze(['connected-fileview', 'typed-command-editor', 'readable-result', 'terminal-output']);
const BOARD_NAME = 'Owned QA Project Board — 긴 프로젝트 이름과 전체 경로 접근 확인 — native select apply cancel remove';
const SCRIPT_NAME = 'Owned QA check';
const testid = id => `[data-testid=${JSON.stringify(id)}]`;
const writes = state => state.terminalRequests.filter(row => row.route === '/terminal/write');
const operations = (state, operation) => state.fileRequests.filter(row => row.operation === operation);

export const boardPrimarySelector = title => `[data-testid="board-open"][aria-label=${JSON.stringify(`Board ${title} 열기`)}] > .egd-agenda-switch-row-main > .egd-agenda-switch-row-title`;

export function fileDetailAction(ui) {
  if (ui?.count !== 1 || !ui.cardId) return 'wait';
  if (ui.connect?.ownHidden === true) return 'author-hidden';
  if (!ui.snapshot || ui.connect?.disabled) return 'wait';
  if (['outline', 'marker'].includes(ui.presentation?.level) && ui.presentation?.proxy?.visible) return 'native-proxy';
  if (ui.presentation?.level === 'detail' && !ui.presentation?.proxy?.visible) return 'detail';
  return 'wait';
}

export function fileViewportAction(ui) {
  if (ui?.fileView?.inside === true) return 'none';
  if (ui?.presentation?.fullscreen === true) return 'unresolved-clipping';
  if (ui?.presentation?.level !== 'detail') return 'focus-first';
  return 'native-maximize';
}

export function assertFileUiIdentity(before, after) {
  assert.equal(after.cardId, before.cardId);
  for (const key of ['projectId', 'rootId', 'fileId', 'draftId', 'bufferRevision', 'savedRevision', 'dirty', 'originalDirty']) {
    assert.equal(after.snapshot?.[key], before.snapshot?.[key], `native presentation change preserved ${key}`);
  }
  assert.equal(after.scriptName, before.scriptName);
  assert.equal(after.scriptCommand, before.scriptCommand);
  return true;
}

export function assertRunKeptView(before, after) {
  assert.equal(before.activeEntityId, before.cardId, 'File must own the active view before execution');
  assert.equal(after.activeEntityId, before.activeEntityId, 'terminal execution must not steal the active view');
  assert.equal(after.cardId, before.cardId);
  for (const key of ['zoom', 'zoomTarget']) {
    assert.ok(Number.isFinite(before.camera?.[key]) && Math.abs(after.camera?.[key] - before.camera[key]) < 0.00001, `${key} changed during execution`);
  }
  for (const key of ['pan', 'panTarget']) for (const axis of ['x', 'y']) {
    assert.ok(Number.isFinite(before.camera?.[key]?.[axis]) && Math.abs(after.camera?.[key]?.[axis] - before.camera[key][axis]) < 0.5,
      `${key}.${axis} changed during execution`);
  }
  return true;
}

export function textFragmentsVisible(paint, expectedText) {
  return paint?.text === expectedText && paint.styleVisible === true && paint.textNodeCount > 0 &&
    paint.missingTextRects === 0 && Array.isArray(paint.fragments) && paint.fragments.length > 0 &&
    paint.fragments.every(fragment => fragment.inside === true && fragment.clipped === false &&
      fragment.hitCount === 3 && fragment.rect?.width > 0 && fragment.rect?.height > 0);
}

export function fileResultLocationVisible(ui, workspace, expanded) {
  const location = ui?.result?.location, toggle = location?.toggleBox;
  if (location?.detailsTag !== 'details' || location.toggleTag !== 'summary' || !location.childrenOwned ||
      location.detailsCount !== 1 || location.toggleCount !== 1 || location.cwdCount !== 1 ||
      location.open !== expanded || !location.toggleText?.startsWith('실행 위치 · ') ||
      location.cwdPaint?.text !== `실행 폴더 · ${workspace}`) return false;
  if (expanded) return textFragmentsVisible(location.cwdPaint, `실행 폴더 · ${workspace}`);
  return toggle?.visible === true && toggle.inside === true && toggle.clipped === false && toggle.visibleHits === 9 &&
    location.cwdBox?.visible === false && Array.isArray(location.cwdPaint.fragments) &&
    location.cwdPaint.fragments.every(fragment => fragment.hitCount === 0);
}

// Unit-testable receipt validation only; the UI run must collect every sample
// with native summary clicks and actual text Range/occlusion observations.
export function assertFileResultLocationEvidence(samples, workspace, outputMarker) {
  assert.equal(samples?.length, PROJECT_VIEWPORTS.length);
  for (const viewport of PROJECT_VIEWPORTS) {
    const sample = samples.find(value => value.width === viewport.width && value.height === viewport.height);
    assert.ok(sample, 'both viewports need compact and expanded execution-location evidence');
    assert.ok(fileResultLocationVisible(sample.compact, workspace, false));
    assert.ok(captureSubjectsVisible('readable-result', sample.compact, outputMarker));
    assert.ok(fileResultLocationVisible(sample.expanded, workspace, true));
    assert.equal(sample.restored.result.location.open, false);
    assert.equal(sample.restored.result.location.cwdPaint.text, `실행 폴더 · ${workspace}`);
    for (const ui of [sample.compact, sample.expanded, sample.restored]) {
      assert.equal(ui.width, viewport.width); assert.equal(ui.height, viewport.height);
      assert.equal(ui.result.outcome, 'passed');
      assertFileUiIdentity(sample.compact, ui);
    }
    for (const action of [sample.openAction, sample.closeAction]) {
      assert.equal(action?.kind, 'native-click');
      assert.equal(action.selector, `${selectorForId(sample.compact.cardId)} ${testid('file-check-location-toggle')}`);
    }
    for (const capture of [sample.compactCapture, sample.expandedCapture]) {
      assert.equal(capture?.status, 'captured'); assert.equal(capture.width, viewport.width); assert.equal(capture.height, viewport.height);
      assert.ok(capture.path?.startsWith('/')); assert.equal(capture.visualPass, null);
      assert.equal(capture.subjectsVisible, true); assert.equal(capture.fullRendererInside, true);
    }
    assert.equal(sample.compactCapture.stage, 'readable-result');
    assert.equal(sample.expandedCapture.stage, `project-result-location-expanded-${viewport.width}x${viewport.height}`);
    for (const key of ['persisted', 'pickerResults', 'fileRequests']) {
      assert.deepEqual(sample.afterStore[key], sample.beforeStore[key], `location disclosure must not change ${key}`);
    }
    // The real collector's idle polling may continue; reads alone are not an action.
    const sessionEffects = store => store.sessions.map(({ reads, ...session }) => session);
    assert.deepEqual(sessionEffects(sample.afterStore), sessionEffects(sample.beforeStore));
    assert.deepEqual(writes(sample.afterStore), writes(sample.beforeStore), 'location disclosure must never execute another command');
    assert.equal(sample.afterStore.currentOriginalSha256, sample.beforeStore.currentOriginalSha256);
    for (const store of [sample.beforeStore, sample.afterStore]) {
      assert.deepEqual([store.providerTurns, store.nativePickerInvocations, store.nativeProcessSpawns], [0, 0, 0]);
    }
  }
  return true;
}

export function longCommandForNavigation(command) {
  return `${command} # ${'QA_LONG_COMMAND_'.repeat(32)}END_MARKER`;
}

export function nativeCommandNavigationKeys(platform = process.platform) {
  return platform === 'darwin' ? { home: 'meta+ArrowLeft', end: 'meta+ArrowRight' } : { home: 'Home', end: 'End' };
}

export function commandNavigationObservation(ui, expected) {
  return { commandNavigation: ui.commandNavigation, valueMatches: ui.scriptCommand === expected,
    valueLength: ui.scriptCommand?.length ?? null, expectedLength: expected.length,
    valueHead: ui.scriptCommand?.slice(0, 80) ?? null, valueTail: ui.scriptCommand?.slice(-80) ?? null,
    cardId: ui.cardId, width: ui.width, height: ui.height, box: ui.scriptCommandBox };
}

export function assertLongCommandNavigation(proof, command) {
  const expected = longCommandForNavigation(command);
  assert.deepEqual(proof.keys, nativeCommandNavigationKeys(proof.platform));
  for (const sample of [proof.home, proof.end]) {
    assert.equal(sample.width, 600); assert.equal(sample.height, 600);
    assert.equal(sample.scriptCommand, expected);
    assert.ok(sample.scriptCommandBox.visible && sample.scriptCommandBox.inside && !sample.scriptCommandBox.clipped);
    assert.ok(sample.commandNavigation.focused);
    assert.ok(sample.commandNavigation.scrollWidth > sample.commandNavigation.clientWidth + 100);
  }
  assert.equal(proof.home.commandNavigation.selectionStart, 0);
  assert.equal(proof.home.commandNavigation.selectionEnd, 0);
  assert.ok(proof.home.commandNavigation.scrollLeft <= 1);
  assert.equal(proof.end.commandNavigation.selectionStart, expected.length);
  assert.equal(proof.end.commandNavigation.selectionEnd, expected.length);
  assert.ok(proof.end.commandNavigation.scrollLeft > proof.home.commandNavigation.scrollLeft + 100);
  assert.ok(proof.end.commandNavigation.scrollLeft >= proof.end.commandNavigation.scrollWidth - proof.end.commandNavigation.clientWidth - 4);
  assert.equal(proof.restored.scriptCommand, command);
  for (const state of [proof.beforeStore, proof.afterStore]) {
    assert.equal(writes(state).length, 0); assert.equal(operations(state, 'setProjectScripts').length, 0);
  }
  return true;
}

export function projectDialogLayoutIssues(layout) {
  const issues = [];
  for (const name of ['dialog', 'body', 'details', ...(layout?.editor ? ['editor'] : [])]) {
    const value = layout?.[name];
    if (!value || !Number.isFinite(value.clientWidth) || !Number.isFinite(value.scrollWidth) || value.clientWidth <= 0) {
      issues.push(`${name}:missing-layout`);
    } else if (value.scrollWidth - value.clientWidth > 1) issues.push(`${name}:horizontal-overflow`);
  }
  return issues;
}

export function chatProjectFooterVisible(chat, operation = 'request') {
  const request = [chat?.panel?.applyBox, chat?.panel?.cancelBox];
  const room = [chat?.roomProject?.saveBox, chat?.roomProject?.cancelBox];
  const actions = chat?.panel?.actions;
  return ['request', 'room'].includes(operation) && actions?.operation === operation && actions.outsideBody === true &&
    (operation === 'room' ? room : request).every(box => box?.visible && box.inside && !box.clipped && box.visibleHits === 9) &&
    (operation === 'room' ? request : room).every(box => !box?.visible);
}

export function chatProjectReviewReady(chat, expected, operation = 'request') {
  const panel = chat?.panel;
  if (!panel || !chat.threadId || panel.threadId !== chat.threadId) return false;
  if (operation === 'room') return chat.roomProject?.selectedBoardId === expected.boardId && chat.roomProject.saveDisabled === false &&
    chat.roomProject.detailsPaint?.text.includes(expected.title) && chat.roomProject.detailsPaint.text.includes(expected.displayPath);
  return operation === 'request' && panel.selectedBoardId === expected.boardId && panel.applyDisabled === false &&
    panel.titlePaint?.text === expected.title && panel.pathPaint?.text === expected.displayPath;
}

function chatProjectReviewPainted(chat, expected, operation) {
  return operation === 'room' ? roomProjectDetailsVisible(chat?.roomProject, expected) :
    textFragmentsVisible(chat?.panel?.titlePaint, expected.title) && textFragmentsVisible(chat?.panel?.pathPaint, expected.displayPath);
}

// Keep the failed Chat predicate ahead of unrelated File geometry. Range
// summaries are bounded; the complete successful evidence remains separate.
export function chatProjectWaitDiagnostic(chat, expected) {
  const paint = value => value ? { text: value.text?.slice(0, 240), textLength: value.text?.length,
    styleVisible: value.styleVisible, missingTextRects: value.missingTextRects,
    fragmentCount: value.fragments?.length, fragments: value.fragments?.slice(0, 8).map(fragment => ({
      inside: fragment.inside, clipped: fragment.clipped, hitCount: fragment.hitCount,
      rect: fragment.rect, clip: fragment.clip })) } : null;
  const panel = chat?.panel;
  return { threadId: chat?.threadId, roomId: chat?.roomId, composerThreadId: chat?.composerThreadId,
    viewport: [chat?.viewportWidth, chat?.viewportHeight], draftRevision: chat?.draftRevision,
    appliedProjectId: chat?.target?.projectId ?? null,
    conditions: { panelPresent: !!panel, sameThread: !!panel && panel.threadId === chat?.threadId,
      selectedBoardMatches: panel?.selectedBoardId === expected.boardId, applyEnabled: panel?.applyDisabled === false,
      loaded: chatProjectReviewReady(chat, expected), footerVisible: chatProjectFooterVisible(chat),
      titleVisible: textFragmentsVisible(panel?.titlePaint, expected.title),
      pathVisible: textFragmentsVisible(panel?.pathPaint, expected.displayPath) },
    panel: panel ? { threadId: panel.threadId, selectedBoardId: panel.selectedBoardId,
      applyDisabled: panel.applyDisabled, applyBox: panel.applyBox, cancelBox: panel.cancelBox,
      actions: panel.actions, scrollHint: panel.scrollHint, currentEffective: paint(panel.effectivePaint),
      layout: panel.layout, title: paint(panel.titlePaint), path: paint(panel.pathPaint) } : null,
    roomDefault: { editorVisible: chat?.roomProject?.editorBox?.visible ?? false,
      selectedBoardId: chat?.roomProject?.selectedBoardId, saveDisabled: chat?.roomProject?.saveDisabled,
      footerVisible: chatProjectFooterVisible(chat, 'room'),
      source: chat?.roomProject?.currentSource, status: chat?.roomProject?.currentStatus,
      details: paint(chat?.roomProject?.detailsPaint) } };
}

export function assertChatProjectReviewScroll(before, after, expected, operation = 'request') {
  assert.ok(chatProjectReviewReady(before, expected, operation) && chatProjectReviewReady(after, expected, operation));
  assert.ok(chatProjectFooterVisible(before, operation), 'do not scroll past an inaccessible first-page action footer');
  assert.ok(chatProjectFooterVisible(after, operation), 'actions must remain reachable after reviewing the path');
  for (const key of ['threadId', 'roomId', 'composerThreadId', 'target', 'draft', 'draftRevision',
    'composerValue', 'messageCount', 'conversationId', 'activeBoardId', 'viewportWidth', 'viewportHeight']) {
    assert.deepEqual(after[key], before[key], `native review scrolling must preserve ${key}`);
  }
  assert.equal(after.panel.selectedBoardId, before.panel.selectedBoardId);
  if (operation === 'room') assert.equal(after.roomProject.selectedBoardId, before.roomProject.selectedBoardId);
  assert.ok(before.panel.layout.body.scrollHeight > before.panel.layout.body.clientHeight);
  assert.ok(after.panel.layout.body.scrollTop > before.panel.layout.body.scrollTop + 0.5);
  for (const sample of [before, after]) assert.deepEqual(projectDialogLayoutIssues(
    operation === 'room' ? sample.roomProject.layout : sample.panel.layout), []);
  assert.ok(chatProjectReviewPainted(after, expected, operation));
  return true;
}

// Pure D-X3 validators consume adapter/SQLite and native UI observations.
// Unit samples alone never establish that the attached native flow passed.
export function assertRoomDefaultResponse(packet, expected) {
  assert.equal(packet?.ok, true);
  const value = packet.result;
  assert.equal(value.roomId, expected.roomId);
  assert.equal(value.override, null);
  if (!expected.projectId) {
    assert.equal(value.status, 'none'); assert.equal(value.source, null);
    assert.equal(value.project, null); assert.equal(value.inheritance, null);
  } else {
    assert.equal(value.status, 'connected'); assert.equal(value.source, 'board');
    assert.deepEqual(value.inheritance, { boardId: expected.boardId });
    assert.equal(value.project.status, 'connected');
    for (const key of ['projectId', 'rootId', 'title', 'displayPath']) assert.equal(value.project[key], expected[key]);
  }
  return true;
}

export function assertRoomDefaultStoreEvidence(proof, expected) {
  const { initial, cancelled, saved, overrideCleared, reopened } = proof;
  assert.ok(typeof expected.roomId === 'string' && expected.roomId);
  const defaults = state => state.roomDefaults.filter(row => row.roomId === expected.roomId);
  const saves = state => operations(state, 'saveRoomProjectDefault').filter(row => row.request.roomId === expected.roomId);
  const reads = state => operations(state, 'readRoomProjectDefault').filter(row => row.request.roomId === expected.roomId);
  assert.deepEqual(defaults(initial), []); assert.deepEqual(defaults(cancelled), []);
  assert.deepEqual(cancelled.roomDefaults, initial.roomDefaults, 'Cancel cannot persist any room default');
  assert.deepEqual(cancelled.persisted, initial.persisted, 'Cancel cannot alter persisted projects or bindings');
  assert.equal(saves(initial).length, 0); assert.equal(saves(cancelled).length, 0);
  const initialRead = reads(initial).at(-1);
  assert.equal(initialRead?.status, 200);
  assert.deepEqual(initialRead.request, { roomId: expected.roomId });
  assertRoomDefaultResponse(initialRead.response, { roomId: expected.roomId });
  const save = saves(saved);
  assert.equal(save.length, 1); assert.equal(save[0].status, 200);
  assert.deepEqual(save[0].request, { roomId: expected.roomId, boardId: expected.boardId,
    expectedProjectId: expected.projectId, expectedRootId: expected.rootId });
  assertRoomDefaultResponse(save[0].response, expected);
  for (const state of [saved, overrideCleared, reopened]) {
    assert.deepEqual(defaults(state), [{ roomId: expected.roomId, boardId: expected.boardId }]);
    assert.equal(saves(state).length, 1, 'request override clear/reopen must not save a room default again');
    assert.deepEqual(state.persisted, initial.persisted, 'Board inheritance is not a new room-folder attachment or project mutation');
    assert.deepEqual(state.roomDefaults.filter(row => row.roomId !== expected.roomId),
      initial.roomDefaults.filter(row => row.roomId !== expected.roomId), 'no other room may be changed');
  }
  const reopenedRead = reads(reopened).at(-1);
  assert.ok(reopenedRead?.sequence > save[0].sequence, 'reopened room must re-read the saved default');
  if (proof.beforeReopenSequence != null) assert.ok(reopenedRead.sequence > proof.beforeReopenSequence,
    'the saved response from before leaving cannot stand in for a reopen read');
  assertRoomDefaultResponse(reopenedRead.response, expected);
  for (const state of [cancelled, saved, overrideCleared, reopened]) {
    assert.equal(writes(state).length, writes(initial).length);
    assert.equal(state.pickerResults.length, initial.pickerResults.length);
    assert.equal(state.sessions.length, initial.sessions.length);
    assert.equal(state.currentOriginalSha256, initial.currentOriginalSha256);
    assert.deepEqual([state.providerTurns, state.nativePickerInvocations, state.nativeProcessSpawns], [0, 0, 0]);
    for (const row of state.fileRequests.slice(initial.fileRequests.length)) {
      assert.equal(row.status, 200);
      if (row.operation === 'openProject') assert.deepEqual(row.request, { boardId: expected.boardId });
      else {
        assert.ok(['readRoomProjectDefault', 'saveRoomProjectDefault'].includes(row.operation));
        assert.equal(row.request.roomId, expected.roomId, 'no active-Board/local-thread/native-conversation authority substitution');
        if (row.operation === 'readRoomProjectDefault') {
          assert.deepEqual(row.request, { roomId: expected.roomId });
          assertRoomDefaultResponse(row.response, row.sequence < save[0].sequence ? { roomId: expected.roomId } : expected);
        }
      }
    }
  }
  return true;
}

export function roomFolderPreviewVisible(chat, workspace) {
  const room = chat?.roomProject, paint = room?.detailsPaint;
  return room?.mode === 'folder' && room.saveDisabled === false && paint?.text.includes(workspace)
    && textFragmentsVisible(paint, paint.text) && chatProjectFooterVisible(chat, 'room');
}

// A comparison identity derived from an actual read receipt, not a sent payload.
export function assertRoomFolderResponse(packet, expected, source) {
  assert.ok(['room', 'board'].includes(source));
  assert.equal(packet?.ok, true);
  const value = packet.result;
  assert.equal(value.roomId, expected.roomId); assert.equal(value.source, source); assert.equal(value.status, 'connected');
  assert.deepEqual(value.inheritance, { boardId: expected.boardId });
  assert.deepEqual(value.override, source === 'room' ? { projectId: expected.projectId } : null);
  assert.equal(value.project.status, 'connected');
  for (const key of ['projectId', 'rootId', 'displayPath']) assert.equal(value.project[key], expected[key]);
  return { roomId: expected.roomId, status: 'connected', source, boardId: source === 'board' ? expected.boardId : null,
    projectId: expected.projectId, rootId: expected.rootId };
}

export function assertRoomFolderStoreEvidence(proof, expected) {
  const { initial, osCancelled, preparedCancel, cancelled, preparedSave, saved, clearPrepared, cleared } = proof;
  const attaches = value => operations(value, 'attachProject').slice(operations(initial, 'attachProject').length);
  const inherits = value => operations(value, 'inheritRoomProject').slice(operations(initial, 'inheritRoomProject').length);
  const boardBindings = value => value.persisted.bindings.filter(row => row.scope !== 'room' || row.key !== expected.roomId);
  const roomBinding = value => value.persisted.bindings.filter(row => row.scope === 'room' && row.key === expected.roomId);
  const sessionEffects = value => value.sessions.map(({ reads, ...session }) => session);
  assert.equal(roomBinding(initial).length, 0);
  assert.deepEqual(initial.roomDefaults.filter(row => row.roomId === expected.roomId), [{ roomId: expected.roomId, boardId: expected.boardId }]);
  for (const value of [osCancelled, preparedCancel, cancelled, preparedSave]) {
    assert.deepEqual(value.persisted, initial.persisted, 'picker preparation/cancellation is not a project attachment');
    assert.equal(attaches(value).length, 0); assert.equal(inherits(value).length, 0);
  }
  assert.deepEqual(clearPrepared.persisted, saved.persisted, 'choosing inheritance without Save changes no binding');
  assert.equal(inherits(clearPrepared).length, 0);
  const selections = saved.pickerResults.slice(initial.pickerResults.length);
  assert.deepEqual(selections.map(row => row.selection), [null, initial.roomWorkspace, initial.roomWorkspace]);
  assert.notEqual(initial.roomWorkspace, initial.workspace);
  assert.equal(osCancelled.pickerResults.length, initial.pickerResults.length + 1);
  assert.equal(cancelled.pickerResults.length, initial.pickerResults.length + 2);
  assert.equal(attaches(saved).length, 1); const attached = attaches(saved)[0];
  assert.equal(attached.status, 200);
  assert.deepEqual(Object.keys(attached.request).sort(), ['roomId', 'selectionId']);
  assert.equal(attached.request.roomId, expected.roomId);
  const completed = operations(preparedSave, 'completePicker').at(-1);
  assert.equal(completed.status, 200); assert.equal(completed.request.requestId, selections[2].requestId);
  assert.equal(completed.request.absolutePath, initial.roomWorkspace);
  assert.equal(attached.request.selectionId, completed.response.result.selectionId);
  assert.ok(attached.sequence > completed.sequence);
  const room = attached.response.result;
  assert.equal(room.status, 'connected'); assert.equal(room.source, 'room'); assert.equal(room.displayPath, initial.roomWorkspace);
  assert.notEqual(room.projectId, expected.projectId); assert.notEqual(room.rootId, expected.rootId);
  assert.equal(roomBinding(saved).length, 1); assert.equal(roomBinding(saved)[0].projectId, room.projectId);
  const roomExpected = { ...expected, projectId: room.projectId, rootId: room.rootId, displayPath: initial.roomWorkspace };
  const read = value => operations(value, 'readRoomProjectDefault').findLast(row => row.request.roomId === expected.roomId);
  assert.ok(read(saved).sequence > attached.sequence);
  const roomExpectation = assertRoomFolderResponse(read(saved).response, roomExpected, 'room');
  const restored = inherits(cleared);
  assert.equal(restored.length, 1); assert.equal(restored[0].status, 200);
  assert.deepEqual(restored[0].request, { roomId: expected.roomId });
  assert.equal(restored[0].response.result.roomId, expected.roomId); assert.equal(restored[0].response.result.inherited, true);
  assert.ok(read(cleared).sequence > restored[0].sequence);
  const boardExpectation = assertRoomFolderResponse(read(cleared).response, expected, 'board');
  assert.deepEqual(cleared.persisted.bindings, initial.persisted.bindings, 'clear only the room override, never detach the Board');
  for (const value of [osCancelled, preparedCancel, cancelled, preparedSave, saved, clearPrepared, cleared]) {
    assert.deepEqual(value.blockedRoutes, initial.blockedRoutes, 'no unexpected forbidden operation attempts');
    assert.deepEqual(value.roomDefaults, initial.roomDefaults);
    assert.deepEqual(boardBindings(value), boardBindings(initial));
    assert.deepEqual(value.persisted.projects.filter(row => row.id === expected.projectId), initial.persisted.projects.filter(row => row.id === expected.projectId));
    assert.deepEqual(value.terminalRequests, initial.terminalRequests);
    assert.deepEqual(sessionEffects(value), sessionEffects(initial), 'idle terminal reads may advance, shell effects may not');
    assert.equal(value.currentOriginalSha256, initial.currentOriginalSha256);
    assert.deepEqual([value.providerTurns, value.nativePickerInvocations, value.nativeProcessSpawns], [0, 0, 0]);
    for (const row of value.fileRequests.slice(initial.fileRequests.length)) {
      assert.equal(row.status, 200);
      assert.ok(['openPickerChannel', 'beginPicker', 'completePicker', 'attachProject', 'inheritRoomProject', 'readRoomProjectDefault', 'openProject'].includes(row.operation));
      if (['attachProject', 'inheritRoomProject', 'readRoomProjectDefault'].includes(row.operation)) assert.equal(row.request.roomId, expected.roomId);
      if (row.operation === 'openProject') assert.deepEqual(row.request, { boardId: expected.boardId });
    }
  }
  assert.equal(attaches(cleared).length, 1, 'clearing/reviewing cannot replay attachment');
  return { roomExpectation, boardExpectation, basis: 'actual room-default receipts; no Chat send performed' };
}

export function assertRoomFolderUiEvidence(ui, expected, original, workspace) {
  assert.ok(expected.roomId && expected.roomId === original.roomId);
  for (const sample of Object.values(ui)) {
    for (const key of ['threadId', 'roomId', 'conversationId']) assert.equal(sample[key], original[key]);
    assert.equal(sample.composerThreadId, original.threadId); assert.equal(sample.messageCount, 0);
    assert.equal(sample.draft, ''); assert.equal(sample.composerValue, '');
  }
  for (const keys of [['initial', 'osCancelled', 'preparedCancel', 'cancelled', 'preparedSave', 'saved'], ['requestAgain', 'clearPrepared', 'cleared']]) {
    const first = ui[keys[0]];
    for (const field of ['boardId', 'projectId', 'rootId', 'title', 'displayPath']) assert.equal(first.target[field], expected[field]);
    for (const key of keys) {
      assert.deepEqual(ui[key].target, first.target); assert.equal(ui[key].draftRevision, first.draftRevision);
      assert.equal(ui[key].roomProject.effectiveSource, 'request', 'room setting changes never replace the request draft');
    }
  }
  for (const key of ['preparedCancel', 'preparedSave']) {
    assert.ok(roomFolderPreviewVisible(ui[key], workspace));
    assert.deepEqual(projectDialogLayoutIssues(ui[key].roomProject.layout), []);
  }
  assert.equal(ui.osCancelled.roomProject.saveDisabled, true);
  assert.equal(ui.cancelled.roomProject.editorBox, null);
  assert.equal(ui.saved.roomProject.currentSource, 'room'); assert.equal(ui.saved.roomProject.currentStatus, 'connected');
  assert.ok(ui.saved.roomProject.savedText.includes('저장됨'));
  assert.equal(ui.clearPrepared.roomProject.mode, 'inherit'); assert.ok(chatProjectFooterVisible(ui.clearPrepared, 'room'));
  assert.equal(ui.clearPrepared.roomProject.saveDisabled, false);
  assert.equal(ui.cleared.roomProject.currentSource, 'board'); assert.equal(ui.cleared.roomProject.currentStatus, 'connected');
  assert.ok(ui.cleared.roomProject.savedText.includes('지정 해제됨'));
  for (const [key, source, location] of [['roomRevealed', '방 기본', workspace], ['boardRevealed', 'Board 상속', expected.displayPath]]) {
    const sample = ui[key]; assert.equal(sample.target, null);
    assert.ok(textFragmentsVisible(sample.projectSourcePaint, source)); assert.ok(sample.openerDescription.includes(location));
  }
  return true;
}

export function roomProjectDetailsVisible(room, expected) {
  const paint = room?.detailsPaint;
  return room?.selectedBoardId === expected.boardId && room.saveDisabled === false &&
    typeof paint?.text === 'string' && paint.text.includes(expected.title) && paint.text.includes(expected.displayPath) &&
    textFragmentsVisible(paint, paint.text);
}

export function assertRoomDefaultUiEvidence(ui, expected, original) {
  const { roomId, ...target } = expected;
  assert.ok(roomId && roomId === original.roomId, 'use the original clientThreadBinding, never an active Board or native conversation ID');
  for (const key of ['initial', 'selectedBeforeCancel', 'cancelled', 'selectedBeforeSave', 'saved', 'overrideApplied', 'overrideCleared', 'reopened', 'reopenedClosed']) {
    const sample = ui[key];
    assert.equal(sample.roomId, roomId); assert.equal(sample.threadId, original.threadId);
    assert.equal(sample.composerThreadId, original.threadId);
    assert.equal(sample.conversationId, original.conversationId);
    assert.equal(sample.draft, ''); assert.equal(sample.composerValue, ''); assert.equal(sample.messageCount, 0);
    assert.equal(sample.activeBoardId, expected.boardId);
  }
  assert.equal(ui.initial.roomProject.selectedBoardId, '', 'the active Board must not be an implicit initial selection');
  for (const key of ['initial', 'selectedBeforeCancel', 'cancelled', 'selectedBeforeSave', 'saved']) {
    assert.equal(ui[key].target, null); assert.equal(ui[key].draftRevision, ui.initial.draftRevision,
      'default selection, Cancel and Save cannot mutate the request draft');
  }
  for (const key of ['selectedBeforeCancel', 'selectedBeforeSave', 'reopened']) {
    assert.ok(roomProjectDetailsVisible(ui[key].roomProject, expected));
    assert.deepEqual(projectDialogLayoutIssues(ui[key].roomProject.layout), []);
  }
  const sourceVisible = (sample, text) => sample.projectSourcePaint?.text.replace(/\s/g, '') === text.replace(/\s/g, '') &&
    textFragmentsVisible(sample.projectSourcePaint, sample.projectSourcePaint.text);
  assert.deepEqual(ui.overrideApplied.target, target);
  assert.ok(sourceVisible(ui.overrideApplied, '이번 요청'));
  assert.ok(ui.overrideApplied.draftRevision > ui.saved.draftRevision);
  for (const key of ['saved', 'overrideCleared', 'reopenedClosed']) {
    const sample = ui[key];
    assert.equal(sample.target, null); assert.equal(sample.removeBox, null);
    assert.ok(sourceVisible(sample, 'Board 상속'), 'clearing a request override must reveal the saved Board default, not none');
    assert.ok(sample.openerText.includes(expected.title));
    assert.ok(sample.openerDescription.includes(expected.displayPath));
  }
  assert.ok(ui.overrideCleared.draftRevision > ui.overrideApplied.draftRevision);
  assert.equal(ui.reopened.draftRevision, ui.overrideCleared.draftRevision);
  assert.equal(ui.reopenedClosed.draftRevision, ui.overrideCleared.draftRevision);
  assert.equal(ui.reopened.target, null);
  assert.equal(ui.reopened.roomProject.currentSource, 'board');
  assert.equal(ui.reopened.roomProject.currentStatus, 'connected');
  assert.ok(ui.left.homeNewBox?.visible, 'the flow must actually leave the room');
  assert.equal(ui.reopened.threadTitle, original.threadTitle, 'reopen the original room, not a newly created substitute');
  return true;
}

export function assertChatRoomReadReceipt(row, proof) {
  const visits = proof.roomReadWindows;
  assert.ok(Array.isArray(visits) && visits.length >= 1 && visits.length <= 2,
    'room reads need bounded observed native entry windows, not a room-ID allowlist');
  const fresh = visits.at(-1);
  assert.equal(fresh.entry, 'new-room');
  assert.equal(fresh.ui.threadId, proof.initial.threadId);
  assert.equal(fresh.ui.roomId, proof.initial.roomId);
  const lastSequence = Math.max(0, ...proof.afterStore.fileRequests.map(value => value.sequence || 0));
  for (const [index, visit] of visits.entries()) {
    const old = visit.entry === 'dock-room';
    assert.ok(!old || index === 0 && visits.length === 2);
    assert.equal(visit.action.kind, 'native-click');
    assert.equal(visit.action.selector, old ? '#egd-dock .egd-dock-btn[data-id="chat"]' : '.egd-codex-thread-home-new');
    assert.ok(typeof visit.ui.roomId === 'string' && visit.ui.roomId);
    assert.equal(visit.ui.composerThreadId, visit.ui.threadId);
    assert.equal(visit.ui.backBox?.visible, true);
    assert.ok(Number.isFinite(visit.startedAt) && visit.startedAt <= visit.action.at && visit.action.at <= visit.observedAt);
    assert.ok(Number.isInteger(visit.beforeSequence) && visit.beforeSequence >= 0);
    if (old) {
      assert.equal(visit.ui.threadId, proof.beforeDock.threadId);
      assert.equal(visit.ui.roomId, proof.beforeDock.roomId);
      assert.equal(visit.leaveAction.kind, 'native-click');
      assert.equal(visit.leaveAction.selector, '.egd-codex-conversation-back');
      assert.equal(visit.homeUi.homeNewBox?.visible, true);
      assert.ok(visit.observedAt <= visit.leaveAction.at && visit.leaveAction.at <= visit.endedAt);
      assert.ok(Number.isInteger(visit.throughSequence) && visit.throughSequence >= visit.beforeSequence);
      assert.ok(fresh.beforeSequence >= visit.throughSequence && fresh.startedAt >= visit.endedAt);
      assert.notEqual(visit.ui.threadId, fresh.ui.threadId);
      assert.notEqual(visit.ui.roomId, fresh.ui.roomId, 'a new room must not reuse the prior room binding');
    }
  }
  assert.equal(row.operation, 'readRoomProjectDefault');
  assert.equal(row.status, 200);
  const owners = visits.filter(visit => row.request.roomId === visit.ui.roomId &&
    Number.isInteger(row.sequence) && row.sequence > visit.beforeSequence &&
    row.sequence <= (visit.throughSequence ?? lastSequence) && Number.isFinite(row.at) &&
    row.at >= visit.startedAt && row.at <= (visit.endedAt ?? proof.afterStoreAt));
  assert.equal(owners.length, 1, 'read receipt must belong to exactly one observed native room-entry phase');
  assert.deepEqual(row.request, { roomId: owners[0].ui.roomId });
  assertRoomDefaultResponse(row.response, { roomId: owners[0].ui.roomId });
  return true;
}

export function assertChatProjectEvidence(proof, expected) {
  const { threadId } = proof.initial;
  assert.ok(threadId && typeof proof.initial.roomId === 'string' && proof.initial.roomId);
  for (const sample of [proof.initial, proof.panelInitial, proof.selectedBeforeCancel, proof.cancelled,
    proof.selectedBeforeApply, proof.applied, proof.narrowApplied, proof.details, proof.cancelledAfterApply,
    proof.removed, proof.reopenedAfterRemove]) {
    assert.equal(sample.threadId, threadId);
    assert.equal(sample.roomId, proof.initial.roomId);
    assert.equal(sample.composerThreadId, threadId);
    assert.equal(sample.composerValue, ''); assert.equal(sample.draft, '');
    assert.equal(sample.messageCount, 0); assert.equal(sample.conversationId, null);
    assert.equal(sample.activeBoardId, expected.boardId);
  }
  for (const sample of [proof.initial, proof.panelInitial, proof.selectedBeforeCancel, proof.cancelled,
    proof.selectedBeforeApply, proof.removed, proof.reopenedAfterRemove]) assert.equal(sample.target, null);
  assert.equal(proof.panelInitial.panel.selectedBoardId, '');
  assert.equal(proof.panelInitial.panel.applyDisabled, true);
  assert.equal(proof.reopenedAfterRemove.panel.selectedBoardId, '');
  assert.equal(proof.reopenedAfterRemove.panel.applyDisabled, true);
  for (const sample of [proof.selectedBeforeCancel, proof.selectedBeforeApply, proof.details]) {
    assert.equal(sample.panel.threadId, threadId);
    assert.equal(sample.panel.selectedBoardId, expected.boardId);
    assert.equal(sample.panel.applyDisabled, false);
    assert.ok(textFragmentsVisible(sample.panel.titlePaint, expected.title));
    assert.ok(textFragmentsVisible(sample.panel.pathPaint, expected.displayPath));
    assert.deepEqual(projectDialogLayoutIssues(sample.panel.layout), [], 'full-path dialog must not have a horizontal scrollbar');
  }
  for (const sample of [proof.applied, proof.narrowApplied, proof.details, proof.cancelledAfterApply]) {
    assert.deepEqual(sample.target, expected);
    assert.ok(sample.openerText.includes(expected.title));
    assert.ok(sample.openerDescription.includes(expected.displayPath));
  }
  assert.equal(proof.cancelled.draftRevision, proof.initial.draftRevision);
  assert.ok(proof.applied.draftRevision > proof.selectedBeforeApply.draftRevision);
  assert.equal(proof.cancelledAfterApply.draftRevision, proof.applied.draftRevision);
  assert.ok(proof.removed.draftRevision > proof.cancelledAfterApply.draftRevision);
  assert.equal(proof.removed.removeBox, null);
  assert.equal(proof.narrowApplied.viewportWidth, 600);
  assert.equal(proof.details.viewportWidth, 600);
  assert.ok(proof.narrowApplied.openerOverflowPx > 0, 'the selected project name must exercise the actual truncated chip');
  assert.ok(proof.narrowApplied.openerBox.visible && proof.narrowApplied.openerBox.inside && !proof.narrowApplied.openerBox.clipped);
  const beforeOpens = operations(proof.beforeStore, 'openProject').length;
  const selectedOpens = operations(proof.selectedStore, 'openProject').length;
  assert.ok(selectedOpens > beforeOpens);
  assert.ok(operations(proof.appliedStore, 'openProject').length > selectedOpens, 'Apply must re-read the real helper binding');
  for (const state of [proof.selectedStore, proof.appliedStore, proof.afterStore]) {
    assert.equal(writes(state).length, writes(proof.beforeStore).length);
    assert.equal(state.pickerResults.length, proof.beforeStore.pickerResults.length);
    assert.equal(state.sessions.length, proof.beforeStore.sessions.length);
    assert.equal(operations(state, 'attachProject').length, operations(proof.beforeStore, 'attachProject').length);
    assert.deepEqual([state.providerTurns, state.nativePickerInvocations, state.nativeProcessSpawns], [0, 0, 0]);
    const project = operations(state, 'openProject').at(-1)?.response?.result?.project;
    assert.equal(project?.status, 'connected');
    for (const key of ['projectId', 'rootId', 'title', 'displayPath']) assert.equal(project[key], expected[key]);
  }
  const reads = proof.afterStore.fileRequests.slice(proof.beforeStore.fileRequests.length);
  assert.ok(reads.length >= 4);
  for (const row of reads) {
    assert.equal(row.status, 200);
    if (row.operation === 'openProject') assert.deepEqual(row.request, { boardId: expected.boardId });
    else assertChatRoomReadReceipt(row, proof);
  }
  return true;
}

export function captureSubjectsVisible(stage, ui, outputMarker, nonce) {
  const fullyShown = box => box?.visible === true && box.inside === true && box.clipped === false;
  if (stage === 'typed-command-editor') return fullyShown(ui.scriptNameBox) && fullyShown(ui.scriptCommandBox);
  if (stage === 'readable-result') return ui.result?.outcome === 'passed' &&
    fullyShown(ui.result.headlineBox) && textFragmentsVisible(ui.result.exitTextPaint, '종료 코드 0') && fullyShown(ui.result.outputBox) &&
    ui.result.text.includes(outputMarker);
  if (stage === 'terminal-output') return ui.terminals?.some(terminal => terminal.level === 'detail' &&
    terminal.renderedOutput?.some(line => line.text.includes(outputMarker) && line.fullyVisible && line.projectedFontPx >= 10.5) &&
    terminal.renderedOutput?.some(line => line.text.includes(`[egdesk-run:${nonce}:exit=0]`) && line.fullyVisible && line.projectedFontPx >= 10.5));
  return fullyShown(ui.fileView) && !!ui.snapshot?.projectId;
}

export function boardRowFitIssues(value) {
  const issues = [];
  if (value?.count !== 1 || value?.primaryCount !== 1) issues.push('ambiguous-board-row-or-primary');
  if (value?.primaryContainsSecondary || value?.primaryInsideSecondary) issues.push('secondary-action-not-primary');
  const row = value?.row, clip = value?.clip;
  if (!row || !clip || !(row.width > 0 && row.height > 0)) issues.push('missing-row-geometry');
  else {
    if (row.left < clip.left - 0.5 || row.right > clip.right + 0.5) issues.push('board-row-horizontally-clipped');
    if (row.top < clip.top - 0.5 || row.bottom > clip.bottom + 0.5) issues.push('board-row-vertically-clipped');
  }
  if ((value?.listOverflowX || 0) > 1) issues.push('board-list-horizontal-overflow');
  return issues;
}

export async function observeBoardPrimary(harness, title) {
  return chrome(harness, ({ selector }) => {
    const primaries = [...document.querySelectorAll(selector)], primary = primaries.length === 1 ? primaries[0] : null;
    const row = primary?.closest('[data-testid="board-open"]'), list = row?.closest('.egd-agenda-switch-list');
    const rect = row?.getBoundingClientRect();
    let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const ancestors = [];
    for (let parent = row?.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), r = parent.getBoundingClientRect();
      const sx = parent.offsetWidth ? r.width / parent.offsetWidth : 1, sy = parent.offsetHeight ? r.height / parent.offsetHeight : 1;
      const bounds = { left: r.left + parent.clientLeft * sx, top: r.top + parent.clientTop * sy,
        right: r.left + (parent.clientLeft + parent.clientWidth) * sx, bottom: r.top + (parent.clientTop + parent.clientHeight) * sy };
      const clipsX = /(auto|scroll|hidden|clip)/.test(style.overflowX), clipsY = /(auto|scroll|hidden|clip)/.test(style.overflowY);
      if (clipsX) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
      if (clipsY) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
      if (clipsX || clipsY) ancestors.push({ className: parent.className, bounds, clipsX, clipsY });
    }
    return { count: row ? 1 : 0, primaryCount: primaries.length, primaryText: primary?.textContent || null,
      primaryContainsSecondary: !!primary?.querySelector('.egd-agenda-switch-row-action, button, [role="button"]'),
      primaryInsideSecondary: !!primary?.closest('.egd-agenda-switch-row-action'),
      row: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
      clip, ancestors, listOverflowX: list ? list.scrollWidth - list.clientWidth : null };
  }, { selector: boardPrimarySelector(title) });
}

export function assertProjectEnvironment(env = process.env) {
  assert.equal(projectFileFixtureEnabled(env), true, 'EGDESK_QA_PROJECT_FILE_FIXTURE=1 is required');
  assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16,
    'EGDESK_QA_FIXTURE_TOKEN for the owned fixture is required');
  assert.equal(env.EGDESK_QA_REAL_TURN, '0');
  return true;
}

// The watcher flow attaches only to a separately launched, explicit owned
// profile/port pair. It never launches Firefox or discovers a personal profile.
export function assertProjectWatchEnvironment(env = process.env) {
  assertProjectEnvironment(env);
  assert.equal(env.EGDESK_QA_PROJECT_FILE_WATCH, '1', 'watcher fixture must be explicitly enabled');
  for (const key of ['EGDESK_MARIONETTE_PORT', 'EGDESK_QA_FIXTURE_PORT']) {
    assert.match(env[key] || '', /^[1-9]\d{0,4}$/, `${key} must be explicit`);
    assert.ok(Number(env[key]) <= 65535, `${key} must be a valid port`);
  }
  assert.notEqual(env.EGDESK_MARIONETTE_PORT, env.EGDESK_QA_FIXTURE_PORT);
  qaBridgeConfig(env); // Also rejects the production bridge port before attach.
  for (const key of ['EGDESK_QA_MCP_ENTRY', 'EGDESK_QA_GECKODRIVER']) {
    assert.ok(typeof env[key] === 'string' && path.isAbsolute(env[key]), `${key} must be an explicit absolute path`);
  }
  assert.equal(process.platform, 'darwin', 'recursive native watcher QA is macOS-only');
  return true;
}

// Receipt validation is deliberately separate: passing this with synthetic
// objects is a unit test, never a native acceptance result.
export function assertProjectWatchEvidence(proof) {
  const { before, after, fixtureBefore, fixtureAfter, bridgeBefore, bridgeAfter, event, broadcast, screenshots, visibleTarget } = proof;
  assert.ok(before.cardId && before.snapshot?.rootId && before.snapshot?.draftId);
  assert.equal(before.snapshot.sourceConnection, 'connected');
  assert.equal(before.snapshot.projectId, null, 'ordinary picked root, not an inferred Board');
  assert.ok(fixtureBefore.watchEnabled && fixtureBefore.watchRoots.some(row => row.rootId === before.snapshot.rootId && row.watching));
  assert.equal(fixtureBefore.watchWrites.length, 0);
  assert.equal(before.folderExpanded, true);
  assert.equal(before.createdCount, 0);
  assert.equal(before.editor.focused, true);
  assert.ok(before.editor.value.length > 0);
  assert.equal(before.editor.selectionStart, 0);
  assert.equal(before.editor.selectionEnd, before.editor.value.length);
  assert.ok(['codemirror', 'textarea'].includes(before.editor.mode), 'the shown editor surface is identified');
  assert.equal(before.editor.shownText, before.editor.value, 'the shown editor displays the working-copy model text');
  assert.ok(bridgeBefore.clients > 0);
  assert.equal(event.topic, 'file.changed');
  assert.equal(event.payload?.rootId, before.snapshot.rootId);
  assert.equal(event.payload?.relativePath, 'qa-expanded/qa-watch-created.txt');
  assert.ok(['rename', 'change'].includes(event.payload?.change));
  assert.ok(event.id && fixtureAfter.watchEvents.some(row => row.id === event.id));
  assert.equal(broadcast.eventId, event.id);
  assert.ok(broadcast.clients > 0, 'actual SSE clients were present at broadcast');
  assert.ok(bridgeAfter.observed.projectFileWatchBroadcasts.some(row => row.eventId === event.id && row.clients > 0));
  assert.deepEqual(fixtureAfter.watchWrites.map(row => [row.relativePath, row.operation]),
    [['qa-expanded/qa-watch-created.txt', 'create-only']]);
  const initialFolder = operations(fixtureBefore, 'listDirectory').find(row => row.status === 200 &&
    row.response?.result?.entries?.some(entry => entry.name === 'qa-existing.txt'));
  assert.ok(initialFolder?.request?.directoryId, 'the expanded fixture folder was actually listed before the change');
  assert.ok(operations(fixtureAfter, 'listDirectory').some(row => row.status === 200 && row.sequence > event.sequence &&
    row.request?.directoryId === initialFolder.request.directoryId &&
    row.response?.result?.entries?.some(entry => entry.name === 'qa-watch-created.txt')),
  'the real File service re-listed the same folder after the filesystem event');
  assert.equal(after.cardId, before.cardId);
  assert.equal(after.folderExpanded, true);
  assert.equal(after.createdCount, 1);
  assert.equal(after.createdVisible, true);
  assert.deepEqual(targetIssues(visibleTarget), [], 'created item is an unobstructed, in-viewport target');
  assert.deepEqual(after.editor, before.editor, 'working copy, selection, and focus are unchanged');
  for (const key of ['rootId', 'projectId', 'fileId', 'draftId', 'sourceRevision', 'sourceConnection', 'bufferRevision', 'savedRevision', 'dirty', 'originalDirty']) {
    assert.equal(after.snapshot[key], before.snapshot[key], `${key} changed during watcher refresh`);
  }
  assert.equal(fixtureAfter.currentOriginalSha256, fixtureBefore.originalSha256);
  assert.equal(fixtureBefore.currentOriginalSha256, fixtureBefore.originalSha256);
  assert.equal(fixtureAfter.terminalRequests.length, 0);
  assert.equal(operations(fixtureAfter, 'saveOriginal').length, 0);
  assert.equal(fixtureAfter.blockedRoutes.some(row => row.route.includes('save-original')), false);
  for (const bridge of [bridgeBefore, bridgeAfter]) {
    assert.equal(bridge.observed.sends.length, 0);
    assert.equal(bridge.observed.authWrites.length, 0);
    assert.equal(bridge.runs.length, 0);
  }
  for (const stage of ['watch-before', 'watch-after']) {
    const capture = screenshots.find(row => row.viewport === stage);
    assert.equal(capture?.status, 'captured');
    assert.equal(capture.visualPass, null);
    assert.ok(typeof capture.path === 'string' && capture.path.startsWith('/'));
  }
  return true;
}

// Pure evidence validation, separately unit-tested. Unit receipts are not a UI
// pass: only runProjectFileFlow can collect these from the attached real UI.
export function assertProjectFlowEvidence(proof) {
  const { initial, cancelled, connected, reopened, saved, completed, dirty, restored, lost, quiet,
    uiConnected, uiCompleted, uiDirty, uiLost, screenshots } = proof;
  assert.equal(initial.persisted.projects.length, 0);
  assert.equal(writes(initial).length, 0);
  assert.equal(cancelled.persisted.projects.length, 0);
  assert.equal(operations(cancelled, 'attachProject').length, 0);
  assert.equal(writes(cancelled).length, 0);
  assert.equal(cancelled.pickerResults.length, 1);
  assert.equal(cancelled.pickerResults[0].selection, null);
  assert.equal(connected.persisted.projects.length, 1);
  assert.equal(connected.persisted.bindings.length, 1);
  assert.equal(operations(connected, 'attachProject').length, 1);
  assert.equal(connected.pickerResults.length, 2);
  assert.equal(connected.pickerResults[1].selection, connected.workspace);
  const attached = operations(connected, 'attachProject')[0];
  assert.equal(attached.status, 200);
  assert.equal(attached.request.boardId, proof.boardId);
  assert.equal(connected.persisted.bindings[0].key, proof.boardId);
  assert.equal(uiConnected.snapshot.projectId, attached.response.result.projectId);
  const selected = connected.pickerResults[1];
  const begin = operations(connected, 'beginPicker').find(row => row.response?.result?.requestId === selected.requestId);
  const complete = operations(connected, 'completePicker').find(row => row.request.requestId === selected.requestId);
  assert.ok(begin && complete && begin.sequence < selected.sequence && selected.sequence < complete.sequence && complete.sequence < attached.sequence);
  assert.equal(attached.request.selectionId, complete.response.result.selectionId);
  assert.equal(operations(reopened, 'attachProject').length, 1);
  assert.equal(reopened.pickerResults.length, 2);
  assert.ok(operations(reopened, 'openProject').length > operations(connected, 'openProject').length);
  assert.equal(writes(reopened).length, 0);
  assert.equal(operations(saved, 'setProjectScripts').length, 1);
  assert.equal(operations(saved, 'setProjectScripts')[0].request.scripts[0].command, saved.command);
  assert.equal(writes(saved).length, 0);
  assert.equal(writes(completed).length, 1);
  assert.equal(writes(completed)[0].accepted, true);
  assert.equal(uiCompleted.result.outcome, 'passed');
  assertRunKeptView(proof.uiBeforeRun, uiCompleted);
  assert.ok(uiCompleted.result.text.includes('종료 코드 0'));
  assert.ok(uiCompleted.result.text.includes(completed.outputMarker));
  assert.equal(uiCompleted.result.location?.open, false, 'new execution result must start compact before any QA disclosure click');
  assertFileResultLocationEvidence(proof.resultLocations, completed.workspace, completed.outputMarker);
  assert.ok(uiCompleted.terminals.some(row => row.text.includes(completed.outputMarker)));
  assert.equal(writes(dirty).length, 1);
  assert.equal(uiDirty.snapshot.originalDirty, true);
  assert.ok(uiDirty.status.includes('원본에 저장하지 않은 변경'));
  assert.equal(writes(restored).length, 1);
  assert.equal(writes(lost).length, 2);
  assert.equal(writes(lost)[1].accepted, true);
  assert.equal(uiLost.result.outcome, 'unknown');
  assert.equal(uiLost.result.busy, false);
  assert.ok(lost.terminalRequests.some(row => row.outputLost));
  assert.equal(writes(quiet).length, 2, 'output loss must not automatically replay');
  assert.ok(proof.noReplayObservedMs >= 1500, 'bounded post-loss observation is required');
  assert.equal(quiet.sessions.length, 1, 'the real idle owned terminal must be reused');
  assert.equal(quiet.sessions[0].writes, 2);
  assert.equal(writes(quiet)[0].request.sessionId, writes(quiet)[1].request.sessionId);
  assert.equal(writes(quiet)[0].nonce, parseProjectTerminalWrite(writes(quiet)[0].request.data, quiet));
  assert.equal(writes(quiet)[1].nonce, parseProjectTerminalWrite(writes(quiet)[1].request.data, quiet));
  assert.notEqual(writes(quiet)[0].nonce, writes(quiet)[1].nonce);
  for (const state of [initial, cancelled, connected, reopened, saved, completed, dirty, restored, lost, quiet]) {
    assert.equal(state.originalSha256, initial.originalSha256);
    assert.equal(state.currentOriginalSha256, initial.originalSha256);
    assert.deepEqual([state.providerTurns, state.nativePickerInvocations, state.nativeProcessSpawns], [0, 0, 0]);
  }
  for (const stage of PROJECT_CAPTURE_STAGES) for (const size of PROJECT_VIEWPORTS) {
    const capture = screenshots.find(row => row.stage === stage && row.width === size.width && row.height === size.height);
    assert.equal(capture?.status, 'captured', `${stage} ${size.width}x${size.height} screenshot required`);
    assert.ok(typeof capture.path === 'string' && capture.path.startsWith('/'));
    assert.equal(capture.visualPass, null, 'screenshots require first-person review; never infer a visual pass');
    assert.equal(capture.subjectsVisible, true, `${stage}: actual subjects must be visible`);
    if (stage !== 'terminal-output') assert.equal(capture.fullRendererInside, true,
      `${stage}: whole FileView renderer, not just one panned button, must fit`);
  }
  return true;
}

function projectTextPaint(node) {
      if (!node) return null;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim(), fragments = [];
      let styleVisible = !!node.isConnected && !node.closest('[hidden],[inert],[aria-hidden="true"]');
      let textNodeCount = 0, missingTextRects = 0;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
        const value = textNode.data, start = value.search(/\S/);
        if (start < 0) continue;
        textNodeCount++;
        const end = value.length - (value.match(/\s*$/)?.[0].length || 0), owner = textNode.parentElement;
        const range = document.createRange(); range.setStart(textNode, start); range.setEnd(textNode, end);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
        range.detach?.();
        if (!rects.length) missingTextRects++;
        let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        for (let parent = owner; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent), r = parent.getBoundingClientRect();
          if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0 || css.contentVisibility === 'hidden') styleVisible = false;
          // Inline spans have no client box of their own. Their clipping block
          // ancestors do; use the client bounds to exclude scrollbars/borders.
          if (css.display === 'inline' || css.display === 'contents') continue;
          const sx = parent.offsetWidth ? r.width / parent.offsetWidth : 1, sy = parent.offsetHeight ? r.height / parent.offsetHeight : 1;
          if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
            clip.left = Math.max(clip.left, r.left + parent.clientLeft * sx);
            clip.right = Math.min(clip.right, r.left + (parent.clientLeft + parent.clientWidth) * sx);
          }
          if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
            clip.top = Math.max(clip.top, r.top + parent.clientTop * sy);
            clip.bottom = Math.min(clip.bottom, r.top + (parent.clientTop + parent.clientHeight) * sy);
          }
        }
        for (const r of rects) {
          const hits = [0.2, 0.5, 0.8].map(fx => {
            const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * 0.5);
            return { owned: !!hit && (hit === owner || owner.contains(hit)), tag: hit?.localName || null,
              className: typeof hit?.className === 'string' ? hit.className : null };
          });
          fragments.push({ text: value.slice(start, end), rect: { left: r.left, top: r.top, right: r.right,
            bottom: r.bottom, width: r.width, height: r.height }, clip, hits,
            inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
            clipped: r.left < clip.left - 0.5 || r.top < clip.top - 0.5 || r.right > clip.right + 0.5 || r.bottom > clip.bottom + 0.5,
            hitCount: hits.filter(hit => hit.owned).length });
        }
      }
      return { text, styleVisible, textNodeCount, missingTextRects, fragments };
}

function projectBox(node) {
      if (!node) return null;
      const r = node.getBoundingClientRect(), style = getComputedStyle(node);
      let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      let visibleHits = 0;
      if (right - left > 2 && bottom - top > 2) for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.2, 0.5, 0.8]) {
        const hit = document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
        if (hit && (hit === node || node.contains(hit))) visibleHits++;
      }
      const visible = !!node.isConnected && !node.closest('[hidden],[inert],[aria-hidden="true"]') &&
        style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 &&
        visibleHits > 0;
      return { visible, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        visibleHits, clipped: right - left < r.width - 1 || bottom - top < r.height - 1,
        x: r.x, y: r.y, width: r.width, height: r.height };
}

function observeProjectFilePart({ box }) {
    const cards = [...document.querySelectorAll('[data-testid="file-card"]')];
    const card = cards.length === 1 ? cards[0] : null;
    const find = name => card?.querySelector(`[data-testid="${name}"]`);
    const connect = find('file-project-connect'), connectStyle = connect && getComputedStyle(connect);
    // Match the shipped semantic projection's font source without touching its
    // private cache, DOM, or camera. Record measured inputs, not a guessed LOD.
    const semanticBody = card?.querySelector('.egd-card-body, .egd-chat-card-body, .egd-settings-content') || card;
    const bodyFontCssPx = semanticBody ? Number.parseFloat(getComputedStyle(semanticBody).fontSize) : null;
    const zoom = window.__egdesk?.state?.zoom;
    const projectedFontPx = Number.isFinite(bodyFontCssPx) && Number.isFinite(zoom) ? bodyFontCssPx * zoom : null;
    const cardRect = card?.getBoundingClientRect();
    const projection = window.__egdesk?.state?.boards?.projections?.[window.__egdesk?.state?.boards?.activeProjectionId];
    const command = find('file-script-command');
    return { count: cards.length, cardId: card?.id || null, fileView: box(find('file-view')),
      minimapTitle: card?._fileRecord?.root?.name || '파일', activeEntityId: window.__egdesk?.state?.activeEntityId || null,
      camera: { zoom, zoomTarget: window.__egdesk?.state?.zoomTarget, pan: { ...window.__egdesk?.state?.pan },
        panTarget: { ...window.__egdesk?.state?.panTarget } },
      snapshot: card?._fileView?.snapshot?.() || null,
      board: projection ? { boardId: projection.boardId, title: projection.title } : null,
      presentation: { level: card?.dataset.egdSemanticLevel || null, currentLod: card?.dataset.egdSemanticLevel || null,
        fullscreen: window.__egdesk?.state?.cardFullscreen?.cardId === card?.id,
        maximizeControl: box(card?.querySelector('.egd-card-dot-max')),
        proxy: box(card?.querySelector('.egd-semantic-proxy[data-kind="file"]')), zoom, zoomTarget: window.__egdesk?.state?.zoomTarget,
        bodyFontCssPx, projectedFontPx, fontSource: 'current computed semantic-body font-size times observed camera zoom',
        cachedEntryFontVerified: false, detailEnterFontPx: 10.5, detailStayFontPx: 9,
        detailEnterReadable: projectedFontPx != null && projectedFontPx >= 10.5,
        detailStayReadable: projectedFontPx != null && projectedFontPx >= 9,
        projectedWidth: cardRect?.width ?? null, projectedHeight: cardRect?.height ?? null,
        detailEnterSizeFits: !!cardRect && cardRect.width >= 240 && cardRect.height >= 180 },
      connect: { text: connect?.textContent || '', disabled: connect?.disabled ?? true, ownHidden: connect?.hidden ?? null,
        hiddenAncestor: connect?.closest('[hidden]')?.className || null, inertAncestor: connect?.closest('[inert]')?.className || null,
        ariaHiddenAncestor: connect?.closest('[aria-hidden="true"]')?.className || null,
        display: connectStyle?.display, visibility: connectStyle?.visibility, pointerEvents: connectStyle?.pointerEvents },
      scriptName: find('file-script-name')?.value ?? null, scriptCommand: find('file-script-command')?.value ?? null,
      scriptNameBox: box(find('file-script-name')), scriptCommandBox: box(find('file-script-command')),
      commandNavigation: command ? { focused: document.activeElement === command, selectionStart: command.selectionStart,
        selectionEnd: command.selectionEnd, scrollLeft: command.scrollLeft, scrollWidth: command.scrollWidth,
        clientWidth: command.clientWidth } : null,
      editor: find('file-editor')?.value ?? null,
      status: card?.querySelector('.egdesk-file-status')?.textContent || '',
      error: card?.querySelector('.egdesk-file-error:not([hidden])')?.textContent || null,
      width: innerWidth, height: innerHeight };
}

function observeProjectResultPart({ box, textPaint }) {
    const cards = [...document.querySelectorAll('[data-testid="file-card"]')];
    const card = cards.length === 1 ? cards[0] : null;
    const find = name => card?.querySelector(`[data-testid="${name}"]`);
    const result = find('file-check-result');
    const locationDetails = result?.querySelector('[data-testid="file-check-location-details"]');
    const locationToggle = result?.querySelector('[data-testid="file-check-location-toggle"]');
    const locationCwd = result?.querySelector('[data-testid="file-check-cwd"]');
    return {
      result: { text: result?.textContent || '', busy: result?.getAttribute('aria-busy') === 'true',
        outcome: result?.querySelector('.egdesk-run-result')?.dataset.outcome || null, box: box(result),
        headlineBox: box(result?.querySelector('.egdesk-run-result-headline')), exitBox: box(result?.querySelector('.egdesk-run-result-exit')),
        exitTextPaint: textPaint(result?.querySelector('.egdesk-run-result-exit')),
        outputBox: box(result?.querySelector('.egdesk-run-result-tail')),
        location: { detailsTag: locationDetails?.localName || null, toggleTag: locationToggle?.localName || null,
          detailsCount: result?.querySelectorAll('[data-testid="file-check-location-details"]').length || 0,
          toggleCount: result?.querySelectorAll('[data-testid="file-check-location-toggle"]').length || 0,
          cwdCount: result?.querySelectorAll('[data-testid="file-check-cwd"]').length || 0,
          childrenOwned: !!locationDetails && locationToggle?.parentElement === locationDetails && locationCwd?.parentElement === locationDetails,
          open: locationDetails?.open ?? null, toggleText: locationToggle?.textContent || '', toggleBox: box(locationToggle),
          cwdBox: box(locationCwd), cwdPaint: textPaint(locationCwd) } },
    };
}

function observeProjectChatPart({ box, textPaint }) {
    const projection = window.__egdesk?.state?.boards?.projections?.[window.__egdesk?.state?.boards?.activeProjectionId];
    const codex = window.__egdesk?.state?.codex, thread = codex?.threads?.find(row => row.id === codex.activeThreadId);
    const roomId = thread ? ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs').clientThreadBinding(thread) : null;
    const chatFind = name => document.querySelector(`[data-testid="${name}"]`);
    const panel = chatFind('chat-project-panel'), choice = chatFind('chat-project-board'), details = chatFind('chat-project-details');
    const body = chatFind('chat-project-body'), actions = chatFind('chat-project-actions');
    const opener = chatFind('chat-project-open'), composer = document.querySelector('.egd-codex-input');
    const layout = node => node ? { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
      scrollLeft: node.scrollLeft, overflowX: getComputedStyle(node).overflowX,
      scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      overflowY: getComputedStyle(node).overflowY } : null;
    return {
      chat: { threadId: thread?.id || null, threadTitle: thread?.title || null, roomId, conversationId: thread?.conversationId || null,
        messageCount: thread?.messages?.length ?? null, target: thread?.requestProjectTarget ? { ...thread.requestProjectTarget } : null,
        draft: codex?.threadDrafts?.[thread?.id] || '', draftRevision: codex?.threadDraftRevisions?.[thread?.id] || 0,
        activeBoardId: projection?.boardId || null, viewportWidth: innerWidth, viewportHeight: innerHeight,
        composerThreadId: composer?.dataset.threadId || null, composerValue: composer?.value ?? null, composerBox: box(composer),
        openerCount: document.querySelectorAll('[data-testid="chat-project-open"]').length,
        openerBox: box(opener), openerText: opener?.textContent || '', openerDescription: opener?.getAttribute('aria-label') || '',
        openerOverflowPx: opener ? opener.scrollWidth - opener.clientWidth : null,
        removeBox: box(chatFind('chat-project-remove')), backBox: box(document.querySelector('.egd-codex-conversation-back')),
        projectSourcePaint: textPaint(chatFind('chat-project-source')),
        roomProject: { openBox: box(chatFind('chat-room-project-open')), openText: chatFind('chat-room-project-open')?.textContent || '',
          editorBox: box(chatFind('chat-room-project-editor')),
          bodyBox: box(body),
          mode: chatFind('chat-room-project-editor')?.dataset.mode || null,
          chooseFolderBox: box(chatFind('chat-room-project-choose-folder')), inheritBox: box(chatFind('chat-room-project-inherit')),
          savedText: chatFind('chat-room-project-saved')?.textContent || '',
          effectiveSource: chatFind('chat-project-effective')?.dataset.source || null,
          effectivePaint: textPaint(chatFind('chat-project-effective')),
          selectedBoardId: chatFind('chat-room-project-board')?.value ?? null,
          options: [...(chatFind('chat-room-project-board')?.options || [])].map(option => ({ value: option.value, label: option.textContent })),
          saveDisabled: chatFind('chat-room-project-save')?.disabled ?? true,
          saveBox: box(chatFind('chat-room-project-save')), cancelBox: box(chatFind('chat-room-project-cancel')),
          detailsPaint: textPaint(chatFind('chat-room-project-details')),
          currentText: chatFind('chat-room-project-current')?.textContent || '',
          currentSource: chatFind('chat-room-project-current')?.dataset.source || null,
          currentStatus: chatFind('chat-room-project-current')?.dataset.status || null,
          layout: { dialog: layout(panel), body: layout(body), editor: layout(chatFind('chat-room-project-editor')),
            details: layout(chatFind('chat-room-project-details')) } },
        homeNewBox: box(document.querySelector('.egd-codex-thread-home-new')),
        panel: panel ? { threadId: panel.dataset.threadId, box: box(panel), selectedBoardId: choice?.value ?? null,
          applyBox: box(chatFind('chat-project-apply')), cancelBox: box(chatFind('chat-project-cancel')),
          actions: { operation: actions?.dataset.operation || null,
            outsideBody: !!body && !!actions && panel.contains(actions) && !body.contains(actions) },
          scrollHint: { box: box(chatFind('chat-project-scroll-hint')), text: chatFind('chat-project-scroll-hint')?.textContent || '' },
          effectivePaint: textPaint(chatFind('chat-project-effective')),
          layout: { dialog: layout(panel), body: layout(body), details: layout(details) },
          options: [...(choice?.options || [])].map(option => ({ value: option.value, label: option.textContent })),
          applyDisabled: chatFind('chat-project-apply')?.disabled ?? true, detailsText: details?.textContent || '',
          titlePaint: textPaint(details?.querySelector('strong')), pathPaint: textPaint(details?.querySelector('p')) } : null },
    };
}

function observeProjectTerminalPart({ box }) {
    return {
      terminals: [...document.querySelectorAll('.egd-terminal-card')].map(node => {
        const frame = node._termBrowser, api = frame?.contentWindow?.terminalAPI, frameRect = frame?.getBoundingClientRect();
        const frameDocument = frame?.contentDocument;
        const frameBox = box(frame), sx = frame?.clientWidth ? frameRect.width / frame.clientWidth : 0,
          sy = frame?.clientHeight ? frameRect.height / frame.clientHeight : 0;
        const renderedOutput = [...(frameDocument?.querySelectorAll('.xterm-rows > div') || [])].filter(line =>
          /QA_PROJECT_OUTPUT_|\[egdesk-run:/.test(line.textContent || '')).map(line => {
          const range = frameDocument.createRange(); range.selectNodeContents(line);
          const r = range.getBoundingClientRect(); range.detach?.();
          const left = frameRect.left + r.left * sx, top = frameRect.top + r.top * sy,
            right = frameRect.left + r.right * sx, bottom = frameRect.top + r.bottom * sy;
          const ownHit = frameDocument.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          const outerHit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
          return { text: line.textContent, projectedFontPx: Number.parseFloat(frame.contentWindow.getComputedStyle(line).fontSize) * sy,
            rect: { left, top, right, bottom }, fullyVisible: !!frameBox?.visible && r.width > 0 && r.height > 0 &&
              r.left >= 0 && r.top >= 0 && r.right <= frame.clientWidth && r.bottom <= frame.clientHeight &&
              left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight && outerHit === frame &&
              !!ownHit && (line === ownHit || line.contains(ownHit)) };
        });
        return { id: node.id, sessionId: api?.ptyId || null, connected: api?.isConnected?.() ?? false,
          level: node.dataset.egdSemanticLevel || null, renderedOutput,
          text: api?.bufferText?.() || '', box: box(node), contentBox: frameBox };
      }), };
}

// Every chunk carries its own read-only state fence. No browser globals are
// installed, and no observation retry dispatches input or replays an action.
function projectObservationIdentity() {
  const state = window.__egdesk?.state, cards = [...document.querySelectorAll('[data-testid="file-card"]')];
  const file = cards.length === 1 ? cards[0] : null, find = id => file?.querySelector('[data-testid="' + id + '"]');
  const codex = state?.codex, thread = codex?.threads?.find(row => row.id === codex.activeThreadId);
  const roomId = thread ? ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs').clientThreadBinding(thread) : null;
  const panel = document.querySelector('[data-testid="chat-project-panel"]');
  const result = find('file-check-result'), command = find('file-script-command');
  const projection = state?.boards?.projections?.[state?.boards?.activeProjectionId];
  const scrolls = [file, panel].filter(Boolean).flatMap(root => [root, ...root.querySelectorAll('*')]
    .filter(node => node.scrollTop || node.scrollLeft || node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight)
    .map(node => [node.localName, node.id, node.className, node.scrollLeft, node.scrollTop, node.clientWidth, node.clientHeight, node.scrollWidth, node.scrollHeight]));
  return { documentURI: document.documentURI, width: innerWidth, height: innerHeight,
    fileIds: cards.map(node => node.id), fileSnapshot: file?._fileView?.snapshot?.() || null,
    activeEntityId: state?.activeEntityId || null, boardId: projection?.boardId || null,
    level: file?.dataset.egdSemanticLevel || null, fullscreenCardId: state?.cardFullscreen?.cardId || null,
    camera: { zoom: state?.zoom, zoomTarget: state?.zoomTarget, pan: { ...state?.pan }, panTarget: { ...state?.panTarget } },
    scriptName: find('file-script-name')?.value ?? null, scriptCommand: command?.value ?? null,
    commandSelection: command ? [command.selectionStart, command.selectionEnd, document.activeElement === command] : null,
    editor: find('file-editor')?.value ?? null,
    resultText: result?.textContent || '', resultBusy: result?.getAttribute('aria-busy') === 'true',
    resultOutcome: result?.querySelector('.egdesk-run-result')?.dataset.outcome || null,
    locationOpen: find('file-check-location-details')?.open ?? null,
    threadId: thread?.id || null, roomId, conversationId: thread?.conversationId || null,
    draftRevision: codex?.threadDraftRevisions?.[thread?.id] || 0,
    target: thread?.requestProjectTarget ? { ...thread.requestProjectTarget } : null,
    composerThreadId: document.querySelector('.egd-codex-input')?.dataset.threadId || null,
    panelText: panel?.textContent || null, panelThreadId: panel?.dataset.threadId || null,
    projectChoice: panel?.querySelector('[data-testid="chat-project-board"]')?.value ?? null,
    roomChoice: panel?.querySelector('[data-testid="chat-room-project-board"]')?.value ?? null,
    roomMode: panel?.querySelector('[data-testid="chat-room-project-editor"]')?.dataset.mode || null,
    roomSource: panel?.querySelector('[data-testid="chat-room-project-current"]')?.dataset.source || null,
    effectiveSource: panel?.querySelector('[data-testid="chat-project-effective"]')?.dataset.source || null,
    terminals: [...document.querySelectorAll('.egd-terminal-card')].map(node => {
      const api = node._termBrowser?.contentWindow?.terminalAPI;
      return { id: node.id, sessionId: api?.ptyId || null, text: api?.bufferText?.() || '', level: node.dataset.egdSemanticLevel || null };
    }), scrolls };
}

const PROJECT_OBSERVATION_PARTS = Object.freeze([
  ['file', observeProjectFilePart, false], ['result', observeProjectResultPart, true],
  ['chat', observeProjectChatPart, true], ['terminal', observeProjectTerminalPart, false],
]);
// Leave headroom for the unchanged harness's profile-binding wrapper.
export const PROJECT_OBSERVATION_SOURCE_BUDGET = 14 * 1024;
export function projectUiObservationSources() {
  return PROJECT_OBSERVATION_PARTS.map(([part, reader, needsText]) => {
    const source = 'async () => {\nconst identity = (' + projectObservationIdentity.toString() + ');\n' +
      'const before = identity();\nconst box = (' + projectBox.toString() + ');\n' +
      (needsText ? 'const textPaint = (' + projectTextPaint.toString() + ');\n' : '') +
      'const value = (' + reader.toString() + ')({ box' + (needsText ? ', textPaint' : '') + ' });\n' +
      'return { part: ' + JSON.stringify(part) + ', before, value, after: identity() };\n}';
    const bytes = Buffer.byteLength(source, 'utf8');
    assert.ok(bytes < PROJECT_OBSERVATION_SOURCE_BUDGET, part + ' observation exceeds its bounded source budget: ' + bytes);
    return { part, source, bytes };
  });
}

export function mergeProjectUiObservations(chunks) {
  assert.deepEqual(chunks.map(chunk => chunk?.part), PROJECT_OBSERVATION_PARTS.map(([part]) => part));
  const reference = chunks[0].before;
  assert.ok(reference && typeof reference === 'object', 'split observations require an identity fence');
  const changedFields = new Set();
  for (const chunk of chunks) for (const identity of [chunk.before, chunk.after]) {
    for (const key of new Set([...Object.keys(reference), ...Object.keys(identity || {})])) {
      if (JSON.stringify(identity?.[key]) !== JSON.stringify(reference[key])) changedFields.add(key);
    }
  }
  if (changedFields.size) throw Object.assign(new Error('Project UI changed across split observations: ' + [...changedFields].join(', ')),
    { code: 'QA_PROJECT_OBSERVATION_CHANGED', changedFields: [...changedFields] });
  const [file, result, chat, terminal] = chunks.map(chunk => chunk.value);
  assert.equal(file.count, reference.fileIds.length);
  assert.equal(file.cardId, reference.fileIds.length === 1 ? reference.fileIds[0] : null);
  assert.deepEqual(file.snapshot, reference.fileSnapshot);
  assert.equal(file.width, reference.width); assert.equal(file.height, reference.height);
  assert.deepEqual(file.camera, reference.camera);
  assert.equal(file.activeEntityId, reference.activeEntityId);
  assert.equal(chat.chat.threadId, reference.threadId); assert.equal(chat.chat.roomId, reference.roomId);
  assert.equal(chat.chat.draftRevision, reference.draftRevision);
  assert.deepEqual(chat.chat.target, reference.target);
  assert.equal(chat.chat.composerThreadId, reference.composerThreadId);
  assert.equal(result.result.text, reference.resultText); assert.equal(result.result.busy, reference.resultBusy);
  assert.equal(result.result.outcome, reference.resultOutcome); assert.equal(result.result.location.open, reference.locationOpen);
  assert.deepEqual(terminal.terminals.map(({ id, sessionId, text, level }) => ({ id, sessionId, text, level })), reference.terminals);
  return { ...file, ...result, ...chat, ...terminal };
}

export async function observeProjectUi(harness) {
  const sources = projectUiObservationSources(), changes = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const chunks = [];
    for (const { source } of sources) chunks.push(await harness.evaluateChrome(source));
    try {
      return { ...mergeProjectUiObservations(chunks), observationCoherence: { coherent: true, attempts: attempt,
        changes, fingerprint: createHash('sha256').update(JSON.stringify(chunks[0].before)).digest('hex'),
        scripts: sources.map(({ part, bytes }) => ({ part, bytes })) } };
    } catch (error) {
      if (error.code !== 'QA_PROJECT_OBSERVATION_CHANGED') throw error;
      changes.push({ attempt, fields: error.changedFields });
    }
  }
  throw Object.assign(new Error('Project UI did not stabilize across three read-only observation attempts: ' + JSON.stringify(changes)),
    { code: 'QA_PROJECT_OBSERVATION_UNSTABLE', changes });
}

// A native key can return while smooth scrolling is still moving. Discard
// incoherent reads, not the user's action; never replay input or alter motion.
// Require three matching coherent fences after the animation has settled.
export async function waitStableProjectUi(harness, deadlineMs, { timeoutMs = 5000, intervalMs = 80,
  now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), onProgress = () => {} } = {}) {
  assert.ok(timeoutMs > 0 && timeoutMs <= 5000 && intervalMs > 0 && intervalMs <= 200);
  const started = now(), end = Math.min(started + timeoutMs, deadlineMs);
  const progress = { requiredStableSamples: 3, stableSamples: 0, reads: 0, transientErrors: 0, samples: [] };
  let previous = null, last;
  const record = sample => {
    progress.samples.push(sample);
    if (progress.samples.length > 16) progress.samples.shift();
    progress.elapsedMs = now() - started;
    onProgress(structuredClone(progress));
  };
  assertBeforeDeadline(deadlineMs, now());
  while (now() < end) {
    assertBeforeDeadline(deadlineMs, now());
    progress.reads++;
    try {
      last = await observeProjectUi(harness);
      const fingerprint = last.observationCoherence.fingerprint;
      progress.stableSamples = fingerprint === previous ? progress.stableSamples + 1 : 1;
      previous = fingerprint;
      record({ read: progress.reads, coherent: true, fingerprint, stableSamples: progress.stableSamples });
      assertBeforeDeadline(deadlineMs, now());
      if (now() < end && progress.stableSamples === 3) return { ...last, observationStability: structuredClone(progress) };
    } catch (error) {
      if (error.code !== 'QA_PROJECT_OBSERVATION_UNSTABLE') throw error;
      previous = null; progress.stableSamples = 0; progress.transientErrors++;
      record({ read: progress.reads, coherent: false, changes: error.changes });
    }
    if (now() < end) await pause(Math.min(intervalMs, end - now()));
  }
  throw Object.assign(new Error('Project UI did not produce three stable coherent observations within the bounded wait: ' + JSON.stringify(progress)),
    { code: 'QA_PROJECT_STABILITY_TIMEOUT', progress });
}

export async function runProjectFileFlow({ harness, result, check }, { profile, deadlineMs, env = process.env }) {
  assertProjectEnvironment(env);
  assertBeforeDeadline(deadlineMs);
  const isolation = validateQaFixtureIsolation(profile, { env });
  const descriptor = isolation.files[QA_PROJECT_PICKER_FILE].projectPickerTransform;
  check('fingerprinted OS-result-only transform; real FileView and terminal source fingerprints',
    descriptor?.kind === 'project-file-os-directory-result-v1' &&
    !!isolation.files['resources/EGDeskFileView.sys.mjs'] && !!isolation.files['resources/EGDeskRunResult.sys.mjs']);
  result.pickerTransform = descriptor;
  const roomPickerDescriptor = isolation.files['JS/eg-desk-surface.uc.js']?.roomProjectPickerTransform;
  check('room folder uses a separately fingerprinted OS-result-only boundary before any native input',
    roomPickerDescriptor?.kind === 'chat-room-project-os-directory-result-v1');
  result.roomPickerTransform = roomPickerDescriptor;
  result.sourceProof = isolation.files;
  result.observationScripts = projectUiObservationSources().map(({ part, bytes }) => ({ part, bytes }));
  result.scope = { actual: ['native headless UI input', 'picker channel/begin/complete', 'File HTTP adapter',
    'project SQLite persistence', 'terminal-init/write queue/ScriptRun collector'],
  synthetic: { picker: 'OS-directory-result-only', shell: 'terminal-http-io-only' },
  excluded: ['hardware foreground', 'native OS picker', 'native shell/PTY', 'Git', 'provider/model turns'] };
  result.actions = [];
  const proof = result.projectProof = { screenshots: [], resultLocations: [] };
  const token = env.EGDESK_QA_FIXTURE_TOKEN;
  const state = () => loopbackJson('/__qa/project-file/state', { token, env });
  const configure = body => { assertBeforeDeadline(deadlineMs); return loopbackJson('/__qa/project-file/config', { method: 'POST', body, token, env }); };
  const waitUi = accept => waitFor(harness, observeProjectUi, accept, deadlineMs, { timeoutMs: 20000 });
  let size = PROJECT_VIEWPORTS[0];
  const resize = async next => { assertBeforeDeadline(deadlineMs); await resizeHeadless(harness, next, deadlineMs);
    await waitStableViewport(harness, next, deadlineMs); size = next; };
  const safeTarget = async selector => {
    assertBeforeDeadline(deadlineMs); await waitStableViewport(harness, size, deadlineMs);
    const targets = await observeTargets(harness, selector);
    check(`one unobstructed native target: ${selector}`, targets.length === 1 && targetIssues(targets[0]).length === 0,
      { count: targets.length, issues: targetIssues(targets[0]), rect: targets[0]?.rect });
    assertBeforeDeadline(deadlineMs);
  };
  const click = async (selector, label) => { await safeTarget(selector); await harness.click(selector);
    const action = { label, selector, kind: 'native-click', at: Date.now() };
    result.actions.push(action); await waitStableViewport(harness, size, deadlineMs); return action; };
  const type = async (selector, value) => {
    await click(selector, 'focus typed field');
    assertBeforeDeadline(deadlineMs); await harness.press(process.platform === 'darwin' ? 'meta+a' : 'Control+a', selector);
    assertBeforeDeadline(deadlineMs); await harness.typeText(value, { selector });
    result.actions.push({ label: 'native typed field', selector, value, at: Date.now() });
  };
  const focusViaMinimap = async (cardId, label) => {
    const before = await observeProjectUi(harness);
    await click('.egd-rail-icon[aria-label="미니맵"]', 'open native minimap for owned view');
    await click(`#egd-desk-minimap .egd-minimap-list button.egd-minimap-row[title=${JSON.stringify(`${label} 보기`)}]`,
      `native minimap reveal: ${label}`);
    const after = await waitUi(value => value.activeEntityId === cardId);
    check('native minimap focuses the same owned view without reducing readable zoom',
      after.camera.zoom === before.camera.zoom && after.camera.zoomTarget === before.camera.zoomTarget);
    (result.nativeViewReveals ||= []).push({ target: cardId, before: before.camera, after: after.camera });
  };
  const ensureFileDetail = async (expectedCardId, entry = 'existing-card-or-capture') => {
    // FileReady is data readiness, not semantic-zoom readiness. Read the actual
    // shipped projection, then click its native button once if it is compact.
    await waitStableViewport(harness, size, deadlineMs);
    const before = await waitUi(value => value.cardId === expectedCardId && fileDetailAction(value) !== 'wait');
    const action = fileDetailAction(before);
    (result.filePresentationTransitions ||= []).push({ entry, before, summaryClicked: action === 'native-proxy',
      acceptance: action === 'detail' ? 'ready-without-summary-click' : 'native-summary-recovery-only' });
    check('File project connect is not author-hidden', action !== 'author-hidden', before);
    if (action === 'native-proxy') {
      await click(`${selectorForId(expectedCardId)} > .egd-semantic-proxy[data-kind="file"]`, 'native File projection focus');
    }
    const after = await waitUi(value => value.cardId === expectedCardId && fileDetailAction(value) === 'detail');
    await waitStableViewport(harness, size, deadlineMs);
    await waitFor(harness, () => observeTargets(harness, `${selectorForId(expectedCardId)} ${testid('file-project-connect')}`),
      targets => targets.length === 1 && targetIssues(targets[0]).length === 0, deadlineMs, { timeoutMs: 5000 });
    result.filePresentationTransitions.at(-1).after = after;
    return after;
  };
  const captureSupplement = async (stage, observed) => {
    const captured = { stage, ...await captureHeadlessScreenshot(harness, stage, deadlineMs), observed };
    result.screenshots.push(captured);
    check(`${stage}: native UX evidence captured; visual review pending`, captured.status === 'captured' &&
      captured.width === size.width && captured.height === size.height, { path: captured.path, width: captured.width, height: captured.height });
    return captured;
  };
  const verifyLongCommand = async () => {
    const current = await observeProjectUi(harness), selector = `${selectorForId(current.cardId)} ${testid('file-script-command')}`;
    const navigation = proof.longCommandNavigation = { beforeStore: await state(), platform: process.platform,
      keys: nativeCommandNavigationKeys(), observations: [] };
    const longCommand = longCommandForNavigation(proof.initial.command);
    await type(selector, longCommand);
    await waitUi(value => value.scriptCommand === longCommand);
    navigation.beforeKeys = commandNavigationObservation(await observeProjectUi(harness), longCommand);
    for (const [name, position] of [['home', 0], ['end', longCommand.length]]) {
      const key = navigation.keys[name];
      await safeTarget(selector); assertBeforeDeadline(deadlineMs); await harness.press(key, selector);
      result.actions.push({ label: `native ${name} endpoint in long command without editing or execution`, key,
        platform: navigation.platform, selector, at: Date.now() });
      try {
        await waitFor(harness, async () => {
          const observed = { key, intent: name, at: Date.now(), ...commandNavigationObservation(await observeProjectUi(harness), longCommand) };
          navigation.lastObservation = observed;
          navigation.observations.push(observed);
          if (navigation.observations.length > 12) navigation.observations.shift();
          return observed;
        }, value => value.valueMatches && value.commandNavigation?.selectionStart === position &&
          value.commandNavigation.selectionEnd === position && value.commandNavigation.focused, deadlineMs, { timeoutMs: 5000 });
      } catch (error) {
        navigation.failure = { key, intent: name, expectedPosition: position, last: navigation.lastObservation, cause: error.message };
        throw new Error(`Native command ${name} (${key}) did not reach its endpoint: ${JSON.stringify(navigation.lastObservation)}`);
      }
      navigation[name] = await observeProjectUi(harness);
      await captureSupplement(`project-long-command-${name}-600x600`, navigation[name]);
    }
    await type(selector, proof.initial.command);
    navigation.restored = await waitUi(value => value.scriptCommand === proof.initial.command);
    navigation.afterStore = await state();
    check('600px platform-native start/end keys preserve the complete long command; no save or terminal write',
      assertLongCommandNavigation(navigation, proof.initial.command));
  };
  const captureResultLocation = async (compact, compactCapture) => {
    const sample = { width: size.width, height: size.height, compact, compactCapture, beforeStore: await state() };
    proof.resultLocations.push(sample); // Retain the last observed disclosure state even on timeout.
    const selector = `${selectorForId(compact.cardId)} ${testid('file-check-location-toggle')}`;
    check('result location starts compact with a visible native summary and no painted full path',
      fileResultLocationVisible(compact, proof.initial.workspace, false), compact.result.location);
    sample.openAction = await click(selector, 'expand actual result execution location');
    sample.expanded = await waitUi(value => value.result.location.open === true);
    if (!fileResultLocationVisible(sample.expanded, proof.initial.workspace, true)) {
      // A native scroll of the opened disclosure may be needed in the narrow
      // File window. Do not assign details.open, scroll offsets, or CSS.
      assertBeforeDeadline(deadlineMs); await harness.press('End', selector);
      result.actions.push({ label: 'native End to reveal expanded execution path', kind: 'native-key', key: 'End', selector, at: Date.now() });
    }
    await waitFor(harness, async () => {
      sample.expanded = await observeProjectUi(harness);
      return sample.expanded.result.location;
    }, () => fileResultLocationVisible(sample.expanded, proof.initial.workspace, true), deadlineMs, { timeoutMs: 5000 });
    sample.expandedCapture = await captureSupplement(`project-result-location-expanded-${size.width}x${size.height}`, sample.expanded);
    sample.expandedCapture.subjectsVisible = fileResultLocationVisible(sample.expanded, proof.initial.workspace, true);
    sample.expandedCapture.fullRendererInside = sample.expanded.fileView?.inside === true;
    proof.screenshots.push(sample.expandedCapture);
    check('expanded execution path is fully painted without clipping or occlusion',
      sample.expandedCapture.subjectsVisible && sample.expandedCapture.fullRendererInside, sample.expanded.result.location);
    const toggle = sample.expanded.result.location.toggleBox;
    if (!toggle?.visible || !toggle.inside || toggle.clipped || toggle.visibleHits !== 9) {
      assertBeforeDeadline(deadlineMs); await harness.press('Home', selector);
      result.actions.push({ label: 'native Home to reach execution-location summary', kind: 'native-key', key: 'Home', selector, at: Date.now() });
    }
    sample.closeAction = await click(selector, 'restore compact result location before the next capture');
    sample.restored = await waitUi(value => value.result.location.open === false);
    sample.afterStore = await state();
  };
  const captureStage = async stage => {
    let maximizedForCapture = false;
    for (const viewport of PROJECT_VIEWPORTS) {
      await resize(viewport);
      if (stage === 'terminal-output') {
        const terminal = proof.uiCompleted.terminals[0];
        check('one original owned terminal selected for output capture', proof.uiCompleted.terminals.length === 1 && !!terminal.sessionId);
        await focusViaMinimap(terminal.id, 'Terminal');
      } else {
        const before = await observeProjectUi(harness), action = fileViewportAction(before);
        if (action === 'native-maximize') {
          // The shipped green window control temporarily resizes this Card to
          // the actual viewport and retains its restore rect. No camera values,
          // DOM styles or hidden attributes are assigned by the verifier.
          await click(`${selectorForId(before.cardId)} .egd-card-dot-max`, 'native File window maximize for narrow inspection');
          const after = await waitUi(value => value.cardId === before.cardId && value.presentation.fullscreen && value.fileView?.inside);
          check('native card resize retains project, draft and typed command identity', assertFileUiIdentity(before, after));
          (result.nativeCardResizes ||= []).push({ viewport, before, after });
          maximizedForCapture = true;
        } else check('no unresolved File clipping after canonical native resize', action !== 'unresolved-clipping', before);
        await ensureFileDetail(before.cardId);
      }
      if (stage === 'typed-command-editor' && viewport.width === 600) await verifyLongCommand();
      let ui = await observeProjectUi(harness);
      const nonce = proof.completed && writes(proof.completed)[0]?.nonce;
      if (stage === 'readable-result' && !captureSubjectsVisible(stage, ui, proof.initial.outputMarker, nonce)) {
        // Native End on the real disclosure focuses/scrolls its workspace; it
        // does not expand, click, or synthesize a result.
        assertBeforeDeadline(deadlineMs);
        await harness.press('End', `${selectorForId(ui.cardId)} .egdesk-run-result-output-summary`);
        result.actions.push({ label: 'native End in result disclosure', at: Date.now() });
      }
      ui = await waitUi(value => captureSubjectsVisible(stage, value, proof.initial.outputMarker, nonce) &&
        (stage !== 'readable-result' || fileResultLocationVisible(value, proof.initial.workspace, false)));
      const subjectsVisible = captureSubjectsVisible(stage, ui, proof.initial.outputMarker, nonce);
      const captured = { stage, ...await captureHeadlessScreenshot(harness, `project-${stage}-${viewport.width}x${viewport.height}`, deadlineMs),
        subjectsVisible: !!subjectsVisible, fullRendererInside: ui.fileView?.inside === true, observed: ui };
      result.screenshots.push(captured); proof.screenshots.push(captured);
      check(`${stage} ${viewport.width}x${viewport.height}: capture exists; visual review pending`,
        captured.status === 'captured' && captured.width === viewport.width && captured.height === viewport.height && !!subjectsVisible
          && (stage === 'terminal-output' || captured.fullRendererInside), captured);
      if (stage === 'readable-result') await captureResultLocation(ui, captured);
    }
    await resize(PROJECT_VIEWPORTS[0]);
    if (maximizedForCapture) {
      const before = await observeProjectUi(harness);
      await click(`${selectorForId(before.cardId)} .egd-card-dot-max`, 'native restore File window after narrow capture');
      const after = await waitUi(value => value.cardId === before.cardId && !value.presentation.fullscreen);
      check('native restore retains project, draft and typed command identity', assertFileUiIdentity(before, after));
    }
  };

  const verifyChatProjectSelection = async () => {
    const selectedProject = proof.connected.persisted.projects[0];
    const expected = { boardId: proof.boardId, projectId: proof.uiLost.snapshot.projectId,
      rootId: proof.uiLost.snapshot.rootId, title: selectedProject.title, displayPath: proof.initial.workspace };
    check('owned project title exercises a long selected name without a fixture attach substitution',
      expected.title === BOARD_NAME && expected.title.length > 60);
    const chatProof = proof.chatProject = { expected, beforeStore: await state(), reviewReveals: [] };
    const waitChat = async (accept, phase = 'chat-ui') => {
      try {
        return await waitFor(harness, async () => {
          const chat = (await observeProjectUi(harness)).chat;
          chatProof.lastWait = { phase, at: Date.now(), observation: chatProjectWaitDiagnostic(chat, expected) };
          return chat;
        }, accept, deadlineMs, { timeoutMs: 20000 });
      } catch (error) {
        throw new Error(`Chat project wait failed (${phase}): ${JSON.stringify(chatProof.lastWait)}; cause: ${error.message.slice(0, 180)}`);
      }
    };
    const openPanel = async () => {
      await click(testid('chat-project-open'), 'open actual Chat request-project selector');
      const opened = await waitChat(value => !!value.panel && value.panel.threadId === value.threadId, 'project-panel-open');
      (chatProof.panelEntries ||= []).push(opened);
      check('project panel first entry exposes only request Apply/Cancel outside its scroll body',
        chatProjectFooterVisible(opened), chatProjectWaitDiagnostic(opened, expected));
      return opened;
    };
    const reviewProject = async (phase, operation = 'request') => {
      const before = await waitChat(value => chatProjectReviewReady(value, expected, operation), `${phase}:loaded`);
      const sample = { phase, operation, before }; chatProof.reviewReveals.push(sample);
      // R11 exposed a real 600px UX defect as well as an old QA assumption.
      // Never scroll past hidden Apply/Cancel to manufacture an accessible UI.
      check(`${phase}: first-page ${operation === 'room' ? 'Save' : 'Apply'}/Cancel are fully visible before review scrolling`,
        chatProjectFooterVisible(before, operation), chatProjectWaitDiagnostic(before, expected));
      check(`${phase}: loaded project dialog has no horizontal overflow`,
        projectDialogLayoutIssues(operation === 'room' ? before.roomProject.layout : before.panel.layout).length === 0,
        operation === 'room' ? before.roomProject.layout : before.panel.layout);
      if (phase === 'narrow-reopened-project-details') await captureSupplement('chat-project-first-page-actions-600x600', before);
      if (chatProjectReviewPainted(before, expected, operation)) {
        sample.after = before; return before;
      }
      const body = before.panel.layout.body;
      check(`${phase}: clipped full path has an actual vertical scroll container`,
        /^(auto|scroll)$/.test(body.overflowY) && body.scrollHeight > body.clientHeight + 1 &&
        body.scrollTop < body.scrollHeight - body.clientHeight - 0.5, body);
      check(`${phase}: additional content has a visible scroll cue`,
        !!before.panel.scrollHint.text && before.panel.scrollHint.box?.visible && before.panel.scrollHint.box.inside &&
        !before.panel.scrollHint.box.clipped, before.panel.scrollHint);
      const selector = testid('chat-project-body');
      assertBeforeDeadline(deadlineMs);
      sample.action = { label: 'native End to review the complete candidate project path',
        kind: 'native-key', key: 'End', selector, at: Date.now() };
      result.actions.push(sample.action);
      sample.scroll = await harness.scrollWithKey(selector, 'End');
      const settled = await waitStableProjectUi(harness, deadlineMs, { onProgress: progress => {
        sample.settle = progress;
        chatProof.lastWait = { phase: `${phase}:native-scroll-settle`, at: Date.now(), stability: progress };
      } });
      sample.after = settled.chat;
      chatProof.lastWait = { phase: `${phase}:native-scroll-full-path`, at: Date.now(),
        stability: settled.observationStability, observation: chatProjectWaitDiagnostic(sample.after, expected) };
      check(`${phase}: settled candidate title and full path are fully painted`,
        chatProjectReviewPainted(sample.after, expected, operation), chatProjectWaitDiagnostic(sample.after, expected));
      check(`${phase}: native scroll preserves applied/draft identities and exposes full text and actions`,
        sample.scroll.moved && assertChatProjectReviewScroll(before, sample.after, expected, operation), sample.scroll);
      return sample.after;
    };
    const chooseBoard = async () => {
      const before = (await observeProjectUi(harness)).chat;
      const options = before.panel?.options || [], index = options.findIndex(option => option.value === expected.boardId);
      check('native select contains exactly one owned Board candidate', index > 0 && options.length <= 16 &&
        options.filter(option => option.value === expected.boardId).length === 1 && options[index].label === BOARD_NAME);
      const selector = testid('chat-project-board');
      await click(selector, 'open native Board select');
      for (const key of ['Home', ...Array(index).fill('ArrowDown'), 'Enter']) {
        assertBeforeDeadline(deadlineMs); await harness.press(key, selector);
        result.actions.push({ label: 'native Board option key', key, selector, at: Date.now() });
      }
      const selected = await reviewProject('native-selected-project');
      check('loaded project dialog shows its full path without horizontal overflow', projectDialogLayoutIssues(selected.panel.layout).length === 0,
        { layout: selected.panel.layout, issues: projectDialogLayoutIssues(selected.panel.layout) });
      return selected;
    };
    const lastFileSequence = value => Math.max(0, ...value.fileRequests.map(row => row.sequence));
    chatProof.beforeDock = (await observeProjectUi(harness)).chat;
    chatProof.roomReadWindows = [];
    const dockStartedAt = Date.now();
    const dockAction = await click('#egd-dock .egd-dock-btn[data-id="chat"]', 'Chat from native Dock without a provider turn');
    let chat = await waitChat(value => value.homeNewBox?.visible || value.backBox?.visible);
    if (chat.backBox?.visible) {
      const visit = { entry: 'dock-room', startedAt: dockStartedAt, action: dockAction,
        observedAt: Date.now(), ui: chat, beforeSequence: lastFileSequence(chatProof.beforeStore) };
      chatProof.roomReadWindows.push(visit);
      visit.leaveAction = await click('.egd-codex-conversation-back', 'return to actual Chat room list');
      visit.homeUi = await waitChat(value => value.homeNewBox?.visible, 'initial-room-left');
      visit.throughSequence = lastFileSequence(await state());
      visit.endedAt = Date.now();
    }
    const beforeNewRoom = await state(), newRoomStartedAt = Date.now();
    const newRoomAction = await click('.egd-codex-thread-home-new', 'create empty Chat through native new-room button');
    chatProof.initial = await waitChat(value => value.openerCount === 1 && value.composerBox?.visible && value.composerThreadId === value.threadId);
    chatProof.roomReadWindows.push({ entry: 'new-room', startedAt: newRoomStartedAt, action: newRoomAction,
      observedAt: Date.now(), ui: chatProof.initial, beforeSequence: lastFileSequence(beforeNewRoom) });
    check('active Board is not inherited as Chat request authority', chatProof.initial.target === null &&
      chatProof.initial.activeBoardId === expected.boardId && chatProof.initial.messageCount === 0);
    chatProof.panelInitial = await openPanel();
    check('an unselected Chat starts with no preselected active Board', chatProof.panelInitial.panel.selectedBoardId === '' &&
      chatProof.panelInitial.panel.applyDisabled);
    chatProof.selectedBeforeCancel = await chooseBoard();
    await click(testid('chat-project-cancel'), 'cancel reviewed project without applying');
    chatProof.cancelled = await waitChat(value => !value.panel);
    await openPanel();
    chatProof.selectedBeforeApply = await chooseBoard();
    chatProof.selectedStore = await state();
    await click(testid('chat-project-apply'), 'apply explicitly selected real helper project');
    chatProof.applied = await waitChat(value => !value.panel && value.target?.projectId === expected.projectId);
    chatProof.appliedStore = await state();

    await resize(PROJECT_VIEWPORTS[1]);
    await click('#egd-dock .egd-dock-btn[data-id="chat"]', 'native reveal of selected Chat at 600px');
    chatProof.narrowApplied = await waitChat(value => value.openerBox?.visible && value.openerBox.inside && !value.openerBox.clipped);
    await safeTarget(testid('chat-project-open'));
    await safeTarget(testid('chat-project-remove'));
    await captureSupplement('chat-selected-long-project-600x600', chatProof.narrowApplied);
    await openPanel();
    chatProof.details = await reviewProject('narrow-reopened-project-details');
    check('600px full project path has no dialog/body/details horizontal overflow',
      projectDialogLayoutIssues(chatProof.details.panel.layout).length === 0,
      { layout: chatProof.details.panel.layout, issues: projectDialogLayoutIssues(chatProof.details.panel.layout) });
    await captureSupplement('chat-selected-project-details-600x600', chatProof.details);
    // Change only the dialog's pending choice, then cancel: the applied draft
    // target must remain intact. Never call the bridge setter from evaluation.
    await click(testid('chat-project-board'), 'edit pending choice in the real native selector');
    for (const key of ['Home', 'Enter']) {
      assertBeforeDeadline(deadlineMs); await harness.press(key, testid('chat-project-board'));
      result.actions.push({ label: 'native clear pending Board option', key, at: Date.now() });
    }
    await waitChat(value => value.panel?.selectedBoardId === '' && value.panel.applyDisabled);
    await click(testid('chat-project-cancel'), 'cancel pending change while preserving applied project');
    chatProof.cancelledAfterApply = await waitChat(value => !value.panel);
    await click(testid('chat-project-remove'), 'remove explicit Chat request project without sending');
    chatProof.removed = await waitChat(value => value.target === null && !value.removeBox);
    chatProof.reopenedAfterRemove = await openPanel();
    await click(testid('chat-project-cancel'), 'close empty selector after removal');
    await waitChat(value => !value.panel);
    chatProof.afterStore = await state();
    chatProof.afterStoreAt = Date.now();
    check('native Chat select/apply/cancel/remove uses real project reads, preserves draft and never runs',
      assertChatProjectEvidence(chatProof, expected));
    await resize(PROJECT_VIEWPORTS[0]);
    await click('#egd-dock .egd-dock-btn[data-id="chat"]', 'native reveal before room-default acceptance');

    // D-X3 uses only the supplied shipped controls. The canonical binding is
    // captured before any project selection, not derived from the active Board
    // or a provider conversation. No direct bridge/default-store setters.
    const original = chatProof.initial;
    const roomExpected = { ...expected, roomId: original.roomId };
    const roomProof = proof.roomDefault = { expected: roomExpected, original, ui: {} };
    const waitRoom = async (phase, accept) => waitChat(value => {
      roomProof.lastObservation = { phase, value };
      return accept(value);
    }, phase);
    const closeProjectPanel = async () => {
      if ((await observeProjectUi(harness)).chat.panel) {
        await click(testid('chat-project-cancel'), 'close project panel without changing request selection');
        await waitRoom('close-project-panel', value => !value.panel);
      }
    };
    const openRoomEditor = async () => {
      if (!(await observeProjectUi(harness)).chat.panel) await openPanel();
      const ready = await waitRoom('room-default-opener', value => value.roomProject.openBox?.visible);
      check('room-default entry is the explicit user-facing default-project control',
        ready.roomProject.openText.includes('이 방의 기본 프로젝트'), ready.roomProject.openText);
      await click(testid('chat-room-project-open'), 'open 이 방의 기본 프로젝트');
      const opened = await waitRoom('room-default-editor', value => value.roomProject.editorBox?.visible && value.roomProject.options.length > 0);
      check('room editor first entry exposes only Save/Cancel outside its scroll body',
        chatProjectFooterVisible(opened, 'room'), chatProjectWaitDiagnostic(opened, expected));
      return opened;
    };
    const chooseDefaultBoard = async () => {
      const before = (await observeProjectUi(harness)).chat, options = before.roomProject.options;
      const index = options.findIndex(option => option.value === expected.boardId);
      check('room-default native select has the owned Board exactly once', index > 0 && options.length <= 16 &&
        options.filter(option => option.value === expected.boardId).length === 1 && options[index].label === BOARD_NAME);
      const selector = testid('chat-room-project-board');
      await click(selector, 'select explicit Board inheritance for this room');
      for (const key of ['Home', ...Array(index).fill('ArrowDown'), 'Enter']) {
        assertBeforeDeadline(deadlineMs); await harness.press(key, selector);
        result.actions.push({ label: 'native room-default Board option key', kind: 'native-key', key, selector, at: Date.now() });
      }
      const selected = await reviewProject('review-room-default-path', 'room');
      check('room-default full path has no horizontal dialog/editor/details overflow',
        projectDialogLayoutIssues(selected.roomProject.layout).length === 0, selected.roomProject.layout);
      return selected;
    };
    roomProof.ui.initial = await openRoomEditor();
    check('initial default editor uses the original client binding and does not preselect the active Board',
      !!original.roomId && roomProof.ui.initial.roomId === original.roomId && roomProof.ui.initial.roomProject.selectedBoardId === '');
    roomProof.initial = await waitFor(harness, state, value => operations(value, 'readRoomProjectDefault')
      .some(row => row.request.roomId === original.roomId && row.status === 200), deadlineMs);
    roomProof.ui.selectedBeforeCancel = await chooseDefaultBoard();
    await click(testid('chat-room-project-cancel'), 'cancel reviewed room default without persistence');
    await waitRoom('cancel-room-default', value => !value.roomProject.editorBox?.visible);
    await closeProjectPanel();
    roomProof.ui.cancelled = (await observeProjectUi(harness)).chat;
    roomProof.cancelled = await state();
    check('room-default Cancel caused zero saves or binding changes',
      operations(roomProof.cancelled, 'saveRoomProjectDefault').length === 0 &&
      JSON.stringify(roomProof.cancelled.roomDefaults) === JSON.stringify(roomProof.initial.roomDefaults) &&
      JSON.stringify(roomProof.cancelled.persisted) === JSON.stringify(roomProof.initial.persisted));

    await openRoomEditor();
    roomProof.ui.selectedBeforeSave = await chooseDefaultBoard();
    await click(testid('chat-room-project-save'), 'save the reviewed Board as this room default');
    roomProof.saved = await waitFor(harness, state, value => operations(value, 'saveRoomProjectDefault')
      .some(row => row.request.roomId === original.roomId && row.status === 200), deadlineMs);
    roomProof.ui.savedInPanel = await waitRoom('saved-default-current-label', value => value.roomProject.currentText.includes(expected.title) &&
      value.roomProject.currentSource === 'board' && value.roomProject.currentStatus === 'connected');
    await closeProjectPanel();
    roomProof.ui.saved = await waitRoom('saved-default-chip', value => value.target === null &&
      value.projectSourcePaint?.text.replace(/\s/g, '') === 'Board상속' && value.openerText.includes(expected.title));
    await captureSupplement('chat-room-project-saved-1280x800', roomProof.ui.saved);

    await openPanel();
    await chooseBoard();
    await click(testid('chat-project-apply'), 'apply request override above the saved room default');
    roomProof.ui.overrideApplied = await waitRoom('request-override-over-default', value => !value.panel &&
      value.target?.projectId === expected.projectId && value.projectSourcePaint?.text.replace(/\s/g, '') === '이번요청');
    await click(testid('chat-project-remove'), 'clear only the request override and reveal saved default');
    roomProof.ui.overrideCleared = await waitRoom('default-revealed-after-remove', value => value.target === null && !value.removeBox &&
      value.projectSourcePaint?.text.replace(/\s/g, '') === 'Board상속' && value.openerText.includes(expected.title));
    roomProof.overrideCleared = await state();
    roomProof.beforeReopenSequence = Math.max(0, ...roomProof.overrideCleared.fileRequests.map(row => row.sequence));
    await click('.egd-codex-conversation-back', 'leave the original room through native Back');
    roomProof.ui.left = await waitRoom('actual-room-list', value => value.homeNewBox?.visible);
    assertBeforeDeadline(deadlineMs);
    await selectQaThread(harness, { id: original.threadId, title: original.threadTitle });
    result.actions.push({ label: 'native reopen original room using identity-checked existing row helper',
      kind: 'native-room-select', threadId: original.threadId, roomId: original.roomId, at: Date.now() });
    await waitRoom('original-room-reopened', value => value.threadId === original.threadId && value.roomId === original.roomId &&
      value.composerThreadId === original.threadId);
    await openRoomEditor();
    await waitRoom('persisted-default-current', value => value.roomProject.currentSource === 'board' && value.roomProject.currentStatus === 'connected');
    roomProof.ui.reopened = await reviewProject('persisted-default-details', 'room');
    roomProof.reopened = await waitFor(harness, state, value => operations(value, 'readRoomProjectDefault')
      .some(row => row.request.roomId === original.roomId && row.sequence > roomProof.beforeReopenSequence && row.status === 200), deadlineMs);
    await captureSupplement('chat-room-project-reopened-1280x800', roomProof.ui.reopened);
    await click(testid('chat-room-project-cancel'), 'close reopened default without saving again');
    await waitRoom('close-reopened-default', value => !value.roomProject.editorBox?.visible);
    await closeProjectPanel();
    roomProof.ui.reopenedClosed = await waitRoom('reopened-default-chip', value => value.target === null &&
      value.projectSourcePaint?.text.replace(/\s/g, '') === 'Board상속');
    roomProof.reopened = await state();
    check('D-X3 native Cancel/Save/override-clear/reopen stays bound to the original room and leaves the request draft intact',
      assertRoomDefaultUiEvidence(roomProof.ui, roomExpected, original));
    check('D-X3 native actions persisted exactly one real SQLite inheritance and re-read it after room reopen',
      assertRoomDefaultStoreEvidence(roomProof, roomExpected));

    // Existing Board inheritance is the starting authority. Only native Save
    // may attach the separately owned room folder; request draft is independent.
    const folderProof = proof.roomFolder = { expected: roomExpected, original, ui: {}, reveals: [] };
    const folderPath = proof.initial.roomWorkspace;
    const bodyKey = async (key, label) => {
      assertBeforeDeadline(deadlineMs);
      const selector = testid('chat-project-body');
      result.actions.push({ label, kind: 'native-key', key, selector, at: Date.now() });
      const scroll = await harness.scrollWithKey(selector, key);
      const settled = await waitStableProjectUi(harness, deadlineMs);
      folderProof.reveals.push({ label, key, scroll, chat: settled.chat });
      return settled.chat;
    };
    const roomControl = async (name, boxKey, label) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const chat = (await observeProjectUi(harness)).chat, target = chat.roomProject[boxKey], body = chat.roomProject.bodyBox;
        if (target?.visible && target.inside && !target.clipped && target.visibleHits === 9) break;
        const key = target && body && target.y < body.y ? 'PageUp'
          : target && body && target.y + target.height > body.y + body.height ? 'PageDown' : null;
        if (!key) break;
        await bodyKey(key, `native reveal ${name}`);
      }
      await click(testid(name), label); // unchanged complete 9/9 click preflight
    };
    const folderPreview = async phase => {
      let sample = await waitRoom(phase, value => value.roomProject.mode === 'folder' && !value.roomProject.saveDisabled &&
        value.roomProject.detailsPaint?.text.includes(folderPath));
      check(`${phase}: Save/Cancel visible before review scroll`, chatProjectFooterVisible(sample, 'room'));
      if (!roomFolderPreviewVisible(sample, folderPath)) sample = await bodyKey('End', 'native review of complete room-folder preview');
      check(`${phase}: actual full path and Save/Cancel are painted`, roomFolderPreviewVisible(sample, folderPath));
      check(`${phase}: no horizontal dialog overflow`, projectDialogLayoutIssues(sample.roomProject.layout).length === 0);
      return sample;
    };
    const applyRequestAgain = async () => {
      await openPanel(); await chooseBoard();
      await click(testid('chat-project-apply'), 'preserve independent request-only Board target while editing room folder');
      await waitRoom('independent-request-applied', value => !value.panel && value.target?.projectId === expected.projectId);
      await openPanel();
      return waitRoom('independent-request-effective', value => value.roomProject.effectiveSource === 'request');
    };
    folderProof.ui.initial = await applyRequestAgain();
    folderProof.initial = await state();
    await configure({ pickerResults: ['cancel', 'select-owned-room', 'select-owned-room'] });
    await openRoomEditor();
    await roomControl('chat-room-project-choose-folder', 'chooseFolderBox', 'native cancel of room OS picker result');
    folderProof.ui.osCancelled = await waitRoom('room-picker-cancel', value => value.roomProject.mode === 'folder' &&
      value.roomProject.saveDisabled && value.roomProject.detailsPaint?.text.includes('취소'));
    folderProof.osCancelled = await state();
    await click(testid('chat-room-project-cancel'), 'close OS-cancelled room editor');
    await waitRoom('room-picker-cancel-closed', value => !value.roomProject.editorBox);
    await openRoomEditor();
    await roomControl('chat-room-project-choose-folder', 'chooseFolderBox', 'prepare owned room folder without attachment');
    folderProof.ui.preparedCancel = await folderPreview('room-folder-before-cancel');
    folderProof.preparedCancel = await state();
    await captureSupplement('chat-room-folder-preview-before-cancel-1280x800', folderProof.ui.preparedCancel);
    await click(testid('chat-room-project-cancel'), 'cancel prepared grant without saving a room binding');
    folderProof.ui.cancelled = await waitRoom('prepared-room-folder-cancelled', value => !value.roomProject.editorBox);
    folderProof.cancelled = await state();
    check('OS cancel and prepared-folder Cancel made no attachment or binding changes',
      JSON.stringify(folderProof.cancelled.persisted) === JSON.stringify(folderProof.initial.persisted));
    await openRoomEditor();
    await roomControl('chat-room-project-choose-folder', 'chooseFolderBox', 'prepare owned room folder for explicit Save');
    folderProof.ui.preparedSave = await folderPreview('room-folder-before-save');
    folderProof.preparedSave = await state();
    await click(testid('chat-room-project-save'), 'save prepared folder once to the original client-bound room');
    folderProof.ui.saved = await waitRoom('room-folder-saved', value => !value.roomProject.editorBox &&
      value.roomProject.currentSource === 'room' && value.roomProject.currentStatus === 'connected' &&
      value.roomProject.effectiveSource === 'request' && value.roomProject.savedText.includes('저장됨'));
    folderProof.saved = await state();
    await captureSupplement('chat-room-folder-saved-request-still-effective-1280x800', folderProof.ui.saved);
    await closeProjectPanel();
    await click(testid('chat-project-remove'), 'remove only request override to reveal the saved room folder');
    folderProof.ui.roomRevealed = await waitRoom('room-folder-effective', value => value.target === null &&
      value.projectSourcePaint?.text === '방 기본' && value.openerDescription.includes(folderPath));
    folderProof.ui.requestAgain = await applyRequestAgain();
    await openRoomEditor();
    await roomControl('chat-room-project-inherit', 'inheritBox', 'choose return to existing Board inheritance without detaching it');
    folderProof.ui.clearPrepared = await waitRoom('room-inherit-prepared', value => value.roomProject.mode === 'inherit' && !value.roomProject.saveDisabled);
    check('inheritance confirmation exposes Save/Cancel', chatProjectFooterVisible(folderProof.ui.clearPrepared, 'room'));
    folderProof.clearPrepared = await state();
    await click(testid('chat-room-project-save'), 'save removal of only the original room override');
    folderProof.ui.cleared = await waitRoom('room-folder-override-cleared', value => !value.roomProject.editorBox &&
      value.roomProject.currentSource === 'board' && value.roomProject.currentStatus === 'connected' &&
      value.roomProject.effectiveSource === 'request' && value.roomProject.savedText.includes('지정 해제됨'));
    folderProof.cleared = await state();
    await closeProjectPanel();
    await click(testid('chat-project-remove'), 'reveal preserved Board inheritance after room override removal');
    folderProof.ui.boardRevealed = await waitRoom('inherited-Board-effective', value => value.target === null &&
      value.projectSourcePaint?.text === 'Board 상속' && value.openerDescription.includes(expected.displayPath));
    check('native room folder Cancel/Save/clear preserve original room, request draft and full preview',
      assertRoomFolderUiEvidence(folderProof.ui, roomExpected, original, folderPath));
    folderProof.expectations = assertRoomFolderStoreEvidence(folderProof, roomExpected);
    check('one actual room attach and one inherit restore have real HTTP/SQLite receipts; no project send asserted', true, folderProof.expectations);
  };

  const guard = await observeGuard(harness);
  check('owned profile on 2829, headless Firefox chrome, mounted Desk, no signed-in account', harness.profile === profile &&
    harness.marionettePort === 2829 && guard.headless && guard.mounted && !guard.loggedIn && !guard.accountBound &&
    guard.documentURI === 'chrome://browser/content/browser.xhtml', guard);
  proof.initial = await state();
  check('fresh owned fixture before captures', proof.initial.profile === profile && proof.initial.persisted.projects.length === 0 &&
    !proof.initial.fileRequests.length && !proof.initial.terminalRequests.length);
  const mainBefore = await loopbackJson('/__qa/state', { token, env });
  check('no provider activity before project-only QA', !mainBefore.observed.sends.length && !mainBefore.runs.length && !mainBefore.observed.authWrites.length);
  await resize(size);
  const first = await observeFirstUse(harness);
  if (first.initialBrowserFocus || first.fullscreen) {
    assertBeforeDeadline(deadlineMs); await harness.press('meta+-');
    result.actions.push({ label: 'native first-use zoom-out', at: Date.now() });
    await waitFor(harness, observeFirstUse, value => !value.initialBrowserFocus && !value.fullscreen, deadlineMs);
  }
  // Build/open an empty Board through the shipped UI, never by state injection.
  await click('.egd-rail-switcher[aria-label="Board 목록"]', 'Board list');
  await click('button[aria-label="새 Board"]', 'new Board');
  await type('#egd-board-scope input[aria-label="Board 이름"]', BOARD_NAME);
  await click('#egd-board-scope button[aria-label="빈 Board 저장"]', 'save empty owned Board');
  if (await chrome(harness, () => !!document.getElementById('egd-agenda-switcher'))) {
    await click('.egd-rail-switcher[aria-label="Board 목록"]', 'close stale Board list');
  }
  await click('.egd-rail-switcher[aria-label="Board 목록"]', 'refresh Board list');
  proof.boardOpenGeometry = await observeBoardPrimary(harness, BOARD_NAME);
  check('whole Board row fits its clipping ancestors; secondary controls are not the primary target',
    boardRowFitIssues(proof.boardOpenGeometry).length === 0,
    { ...proof.boardOpenGeometry, issues: boardRowFitIssues(proof.boardOpenGeometry) });
  await click(boardPrimarySelector(BOARD_NAME), 'open saved owned Board by primary title');
  const boardNotice = await chrome(harness, () => document.getElementById('egd-board-notice')?.textContent || null);
  if (boardNotice) {
    check('only the notice produced by this owned Board creation is dismissed', boardNotice.includes('Board를 저장했습니다.'), boardNotice);
    await click('#egd-board-notice button[aria-label="안내 닫기"]', 'dismiss owned Board-save notice by native close button');
  }
  await click('#egd-dock .egd-dock-btn[data-id="create"]', 'open the 새 카드 menu from the Dock');
  await click('[data-testid="file-dock-open"]', 'Files from the 새 카드 menu');
  let ui = await waitUi(value => value.count === 1 && !!value.snapshot && !value.connect.disabled);
  ui = await ensureFileDetail(ui.cardId, 'new-files-dock');
  proof.boardId = ui.board?.boardId;
  check('project connection visibly targets the selected Board', !!proof.boardId && ui.connect.text.includes(BOARD_NAME), ui.connect);
  let card = selectorForId(ui.cardId);
  const field = id => `${card} ${testid(id)}`;
  await configure({ pickerResults: ['cancel', 'select-owned'] });
  await click(field('file-project-connect'), 'cancel first actual folder selection');
  await waitFor(harness, state, value => value.pickerResults.length === 1 && operations(value, 'completePicker').length === 1, deadlineMs);
  await waitUi(value => !value.connect.disabled);
  proof.cancelled = await state();
  check('cancel attaches nothing and writes no command', !proof.cancelled.persisted.projects.length &&
    !operations(proof.cancelled, 'attachProject').length && !writes(proof.cancelled).length);
  await click(field('file-project-connect'), 'select owned folder through actual picker grant');
  proof.uiConnected = await waitUi(value => !!value.snapshot?.projectId && !value.connect.disabled);
  proof.connected = await state();
  await captureStage('connected-fileview');

  // Closing only this clean owned Card tests service-backed reopen, not a call
  // to _fileView.openProject or a synthetic attach response.
  await click(`${card} .egd-card-dot-close`, 'close connected FileView');
  await waitUi(value => value.count === 0);
  await click('#egd-dock .egd-dock-btn[data-id="create"]', 'open the 새 카드 menu again');
  await click('[data-testid="file-dock-open"]', 'reopen FileView from Files');
  ui = await waitUi(value => value.count === 1 && !!value.snapshot && !value.connect.disabled);
  ui = await ensureFileDetail(ui.cardId, 'reopen-files-dock');
  check('reopen created another actual FileView', ui.cardId !== proof.uiConnected.cardId);
  card = selectorForId(ui.cardId);
  await click(field('file-project-connect'), 'reopen persisted Board project without another picker');
  await waitUi(value => value.snapshot?.projectId === proof.uiConnected.snapshot.projectId && !value.connect.disabled);
  proof.reopened = await state();
  await click(field('file-script-settings'), 'open command settings');
  await type(field('file-script-name'), SCRIPT_NAME);
  await type(field('file-script-command'), proof.initial.command);
  await waitUi(value => value.scriptName === SCRIPT_NAME && value.scriptCommand === proof.initial.command);
  await captureStage('typed-command-editor');
  await click(field('file-script-save'), 'save typed command without running');
  await waitFor(harness, state, value => operations(value, 'setProjectScripts').length === 1, deadlineMs);
  proof.saved = await state();
  check('typing and saving never write terminal input', !writes(proof.saved).length);
  await waitStableViewport(harness, size, deadlineMs);
  proof.uiBeforeRun = await observeProjectUi(harness);
  await click(field('file-project-check'), 'run exactly one saved command');
  proof.uiCompleted = await waitUi(value => value.result.outcome === 'passed' && !value.result.busy);
  check('actual command execution preserves File camera and active view before QA capture navigation',
    assertRunKeptView(proof.uiBeforeRun, proof.uiCompleted));
  proof.completed = await state();
  check('fresh execution result defaults to compact location before any disclosure action',
    proof.uiCompleted.result.location.open === false, proof.uiCompleted.result.location);
  // Reveal the actual result's output using its native disclosure control.
  await click(`${card} .egdesk-run-result-output-summary`, 'show result output');
  await captureStage('readable-result');
  check('native execution-location disclosure preserves the original path and causes no command or file effects',
    assertFileResultLocationEvidence(proof.resultLocations, proof.initial.workspace, proof.initial.outputMarker));
  await captureStage('terminal-output');
  // This explicit user reveal is separate from the execution no-focus-steal
  // assertion above and never calls File/Terminal runtime entrypoints.
  await focusViaMinimap((await observeProjectUi(harness)).cardId, (await observeProjectUi(harness)).minimapTitle);
  await ensureFileDetail((await observeProjectUi(harness)).cardId);
  await click(`${card} [role="treeitem"][data-relative-path="qa-project.txt"]`, 'open owned original in FileView');
  await waitUi(value => value.editor === proof.initial.originalText && !!value.snapshot?.draftId);
  // Type into the editor actually shown (CodeMirror content, else textarea).
  const shownEditor = await resolveShownFileEditor(harness, card);
  proof.editorMode = shownEditor.mode;
  await type(shownEditor.input, `${proof.initial.originalText}Uncommitted working-copy edit\n`);
  await waitUi(value => value.snapshot?.originalDirty === true);
  await click(field('file-project-check'), 'dirty original must block before terminal spawn/write');
  proof.uiDirty = await waitUi(value => value.status.includes('원본에 저장하지 않은 변경'));
  proof.dirty = await state();
  await type(shownEditor.input, proof.initial.originalText);
  await click(field('file-save-copy'), 'save restored working copy only');
  await waitUi(value => !value.snapshot?.dirty && !value.snapshot?.originalDirty && value.editor === proof.initial.originalText);
  proof.restored = await state();
  await configure({ nextTerminalOutcome: 'output-loss' });
  await click(field('file-project-check'), 'accepted command followed by synthetic output loss');
  proof.uiLost = await waitUi(value => value.result.outcome === 'unknown' && !value.result.busy);
  proof.lost = await state();
  const lossObservedAt = Date.now();
  await waitFor(harness, state, value => {
    check('output-loss observation: no additional terminal write', writes(value).length === 2);
    return Date.now() - lossObservedAt >= 1500;
  }, deadlineMs, { timeoutMs: 5000, intervalMs: 300 });
  proof.noReplayObservedMs = Date.now() - lossObservedAt;
  proof.quiet = await state();
  // Additive UI-only acceptance, after the complete File execution/guard flow.
  await verifyChatProjectSelection();
  const mainAfter = await loopbackJson('/__qa/state', { token, env });
  check('project-only flow made zero provider turns or auth writes', !mainAfter.observed.sends.length &&
    !mainAfter.runs.length && !mainAfter.observed.authWrites.length && mainAfter.providerTurns === 0);
  check('actual UI + filestore flow evidence, not mocked DOM', assertProjectFlowEvidence(proof));
  result.selectedCasesVerified = true;
  result.actualUiAndFileStoreVerified = true;
  result.chatProjectSelectionVerified = true;
  result.longCommandNavigationVerified = true;
  result.resultLocationDisclosureVerified = true;
  result.roomProjectDefaultVerified = true;
  result.roomProjectFolderOverrideVerified = true;
  result.providerTurns = 0; result.nativePickerInvocations = 0; result.nativeProcessSpawns = 0;
  result.visualReview = 'pending-first-person-review'; result.visualPass = null;
  result.unverified = ['Actual native picker and shell/PTY (explicitly synthetic)', 'Hardware foreground behavior (not exercised)',
    'Visual quality requires first-person review of all core, project-selection/navigation, expanded-location, room-default and room-folder captures',
    'Provider send/frozen request execution (not exercised)', 'No-replay observed for bounded post-loss interval only'];
}

export function projectWatchScope() {
  return { planned: ['headless native input', 'File picker channel/grant and HTTP adapter',
    'connected-root filesystem watcher', 'workflow bus and SSE', 'FileView tree refresh'],
  synthetic: ['OS directory result only', 'fixture bridge transport'],
  excluded: ['foreground input', 'native OS picker', 'original save', 'Agent start', 'provider calls'],
  providerCalls: 'not-measured', providerBoundary: 'model-free fixture with real turns disabled',
  outerIsolation: 'independent launcher must verify OS policy and listener ownership' };
}

// A late MCP result must not unlock another action after cancellation/deadline.
export function guardProjectWatchHarness(harness, assertCurrent) {
  return new Proxy(harness, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return (...args) => {
      assertCurrent();
      return Promise.resolve(value.apply(target, args)).then(result => { assertCurrent(); return result; });
    };
  } });
}

// Aborting a sent POST does not prove whether the fixture applied it. The
// caller retains an unknown receipt and never retries an ambiguous mutation.
export async function projectWatchJson(route, { method = 'GET', body, token, env = process.env, signal,
  deadlineMs, assertCurrent = () => assertBeforeDeadline(deadlineMs), operations = [], fetchImpl = globalThis.fetch } = {}) {
  assertCurrent();
  const record = method === 'POST' ? { route, status: 'pending', dispatched: false } : null;
  if (record) operations.push(record);
  try {
    const timeout = Math.max(1, Math.min(10000, deadlineMs - Date.now()));
    const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
    if (record) record.dispatched = true;
    const response = await fetchImpl(qaBridgeUrl(route, env), { method, redirect: 'error', signal: AbortSignal.any(signals),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-EGDESK-QA-Token': token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assertCurrent();
    const value = await response.json();
    assertCurrent();
    if (record) { record.status = response.ok ? 'completed' : 'responded-error'; record.httpStatus = response.status; }
    if (!response.ok) throw new Error(`${route.split('?')[0]} failed (${response.status}): ${value.code || value.error?.code || value.error || 'request failed'}`);
    return value;
  } catch (error) {
    if (record?.status === 'pending') record.status = record.dispatched ? 'unknown' : 'not-dispatched';
    throw error;
  }
}

export async function observeWatchUi(harness) {
  return chromeWithFileEditor(harness, () => {
    const cards = [...document.querySelectorAll('[data-testid="file-card"]')];
    const card = cards.length === 1 ? cards[0] : null;
    const editor = card ? readShownFileEditor(card) : null;
    const folder = card?.querySelector('[role="treeitem"][data-relative-path="qa-expanded"]');
    const created = [...(card?.querySelectorAll('[role="treeitem"][data-relative-path="qa-expanded/qa-watch-created.txt"]') || [])];
    const item = created.length === 1 ? created[0] : null;
    const rect = item?.getBoundingClientRect(), style = item && getComputedStyle(item);
    const visible = !!rect && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 &&
      rect.right <= innerWidth && rect.bottom <= innerHeight && style.display !== 'none' &&
      style.visibility === 'visible' && !item.closest('[hidden], [inert], [aria-hidden="true"]');
    return { count: cards.length, cardId: card?.id || null, snapshot: card?._fileView?.snapshot?.() || null,
      folderExpanded: folder?.getAttribute('aria-expanded') === 'true', createdCount: created.length, createdVisible: visible,
      editor: editor ? { mode: editor.mode, value: editor.value, shownText: editor.shownText, selectionStart: editor.selectionStart,
        selectionEnd: editor.selectionEnd, focused: editor.focused } : null };
  });
}

export async function waitWatcherFileUi(harness, predicate, deadlineMs, { observe = observeProjectUi, wait = waitFor } = {}) {
  return wait(harness, async () => {
    try { return await observe(harness); }
    catch (error) {
      if (error.code === 'QA_PROJECT_OBSERVATION_UNSTABLE') return null;
      throw error;
    }
  }, value => !!value && predicate(value), deadlineMs);
}

export async function runProjectFileWatcherFlow({ harness, result, check }, { profile, deadlineMs, env = process.env,
  signal, assertCurrent = () => assertBeforeDeadline(deadlineMs), fixtureOperations = [] }) {
  assertProjectWatchEnvironment(env);
  assertBeforeDeadline(deadlineMs);
  const isolation = validateQaFixtureIsolation(profile, { env });
  const picker = isolation.files[QA_PROJECT_PICKER_FILE]?.projectPickerTransform;
  check('profile has the reviewed picker-result-only transform and real FileView source',
    picker?.kind === 'project-file-os-directory-result-v1' && !!isolation.files['resources/EGDeskFileView.sys.mjs']);
  result.sourceProof = isolation.files;
  result.scope = projectWatchScope();
  result.observedStages = [];
  result.actions = [];
  const proof = result.watcherProof = { screenshots: [] };
  const token = env.EGDESK_QA_FIXTURE_TOKEN;
  const request = (route, options = {}) => projectWatchJson(route, { ...options, token, env, signal, deadlineMs,
    assertCurrent, operations: fixtureOperations });
  const state = () => request('/__qa/project-file/state');
  const bridge = () => request('/__qa/state');
  const post = (route, body = {}) => request(route, { method: 'POST', body });
  assertBeforeDeadline(deadlineMs);
  const guard = await observeGuard(harness);
  check('only the explicit owned profile and port, headless Firefox, without an account',
    harness.profile === profile && harness.marionettePort === Number(env.EGDESK_MARIONETTE_PORT) &&
    guard.documentURI === 'chrome://browser/content/browser.xhtml' && guard.headless && guard.mounted && !guard.loggedIn && !guard.accountBound, guard);
  result.observedStages.push('headless profile and account guard');
  const initial = await state();
  check('fresh owned watcher fixture before native input', initial.profile === profile && initial.watchEnabled &&
    initial.fileRequests.length === 0 && initial.watchWrites.length === 0 && initial.terminalRequests.length === 0);
  proof.initial = initial;
  const size = PROJECT_VIEWPORTS[0];
  assertBeforeDeadline(deadlineMs);
  await resizeHeadless(harness, size, deadlineMs); await waitStableViewport(harness, size, deadlineMs);
  const first = await observeFirstUse(harness);
  if (first.initialBrowserFocus || first.fullscreen) {
    assertBeforeDeadline(deadlineMs); await harness.press('meta+-');
    result.actions.push({ label: 'native first-use zoom-out', kind: 'native-key' });
    await waitFor(harness, observeFirstUse, value => !value.initialBrowserFocus && !value.fullscreen, deadlineMs);
  }
  const click = async (selector, label) => {
    assertBeforeDeadline(deadlineMs);
    const targets = await observeTargets(harness, selector);
    check(`one unobstructed native target: ${label}`, targets.length === 1 && targetIssues(targets[0]).length === 0,
      { count: targets.length, issues: targetIssues(targets[0]), rect: targets[0]?.rect });
    assertBeforeDeadline(deadlineMs);
    await harness.click(selector); result.actions.push({ label, selector, kind: 'native-click' });
    if (!result.observedStages.includes('native headless input')) result.observedStages.push('native headless input');
  };
  await click('#egd-dock .egd-dock-btn[data-id="create"]', 'open the 새 카드 menu');
  await click('[data-testid="file-dock-open"]', 'open File');
  // Data-ready does not mean that the native canvas camera has settled.
  // Observe the motion; never replay the opening click or alter camera state.
  await waitStableViewport(harness, size, deadlineMs);
  let ui = await waitStableProjectUi(harness, deadlineMs);
  if (ui.count !== 1 || fileDetailAction(ui) === 'wait') {
    ui = await waitWatcherFileUi(harness, value => value.count === 1 && fileDetailAction(value) !== 'wait', deadlineMs);
  }
  check('File is not author-hidden', fileDetailAction(ui) !== 'author-hidden');
  if (fileDetailAction(ui) === 'native-proxy') {
    await click(`${selectorForId(ui.cardId)} > .egd-semantic-proxy[data-kind="file"]`, 'reveal File');
    await waitStableViewport(harness, size, deadlineMs);
    ui = await waitWatcherFileUi(harness, value => value.cardId === ui.cardId && fileDetailAction(value) === 'detail', deadlineMs);
  }
  const card = selectorForId(ui.cardId);
  const rootTarget = `${card} ${testid('file-connect-root')}`;
  await waitFor(harness, () => observeTargets(harness, rootTarget),
    targets => targets.length === 1 && targetIssues(targets[0]).length === 0, deadlineMs, { timeoutMs: 5000 });
  await post('/__qa/project-file/config', { pickerResults: ['select-owned'] });
  await click(rootTarget, 'select owned folder through real picker grant');
  await waitFor(harness, observeWatchUi, value => !!value.snapshot?.rootId && value.snapshot.sourceConnection === 'connected', deadlineMs);
  const rootState = await waitFor(harness, state, value => value.watchRoots.some(row => row.watching && row.rootKind === 'workspace'), deadlineMs);
  check('the selected root was registered with the real watcher', rootState.fileRequests.some(row => row.operation === 'registerRoot' && row.status === 200));
  result.observedStages.push('fixture picker grant and root registration');
  await click(`${card} [role="treeitem"][data-relative-path="qa-expanded"]`, 'expand owned nested folder');
  await waitFor(harness, observeWatchUi, value => value.folderExpanded, deadlineMs);
  await click(`${card} [role="treeitem"][data-relative-path="qa-project.txt"]`, 'open owned working copy');
  await waitFor(harness, observeWatchUi, value => !!value.snapshot?.draftId, deadlineMs);
  // Native input goes to the editor actually shown (CodeMirror content, else textarea).
  const shownEditor = await resolveShownFileEditor(harness, card);
  const editor = shownEditor.input;
  proof.editorMode = shownEditor.mode;
  const text = 'Owned watcher QA: unsaved working copy stays selected.';
  await click(editor, 'focus working copy');
  assertBeforeDeadline(deadlineMs); await harness.press('meta+a', editor);
  assertBeforeDeadline(deadlineMs); await harness.typeText(text, { selector: editor });
  result.actions.push({ label: 'type fixture-only working copy', kind: 'native-input' });
  await waitFor(harness, state, value => operations(value, 'updateDraft').some(row => row.status === 200 && row.request.text === text), deadlineMs);
  assertBeforeDeadline(deadlineMs); await harness.press('meta+a', editor);
  proof.before = await waitFor(harness, observeWatchUi, value => value.editor?.value === text && value.editor.focused &&
    value.editor.selectionStart === 0 && value.editor.selectionEnd === text.length, deadlineMs);
  proof.fixtureBefore = await state();
  proof.bridgeBefore = await waitFor(harness, bridge, value => value.clients > 0, deadlineMs);
  const beforeShot = await captureHeadlessScreenshot(harness, 'watch-before', deadlineMs);
  proof.screenshots.push(beforeShot); result.screenshots.push(beforeShot);
  check('create-only fixture operation has a selected watched root and an SSE client',
    proof.fixtureBefore.watchRoots.some(row => row.rootId === proof.before.snapshot.rootId && row.watching) && proof.bridgeBefore.clients > 0);
  await post('/__qa/project-file/watch-create');
  proof.after = await waitFor(harness, observeWatchUi, value => value.createdCount === 1 && value.createdVisible, deadlineMs);
  const createdTargets = await observeTargets(harness, `${card} [role="treeitem"][data-relative-path="qa-expanded/qa-watch-created.txt"]`);
  check('the new tree row is actually visible and unobstructed', createdTargets.length === 1 && targetIssues(createdTargets[0]).length === 0);
  proof.visibleTarget = createdTargets[0];
  proof.fixtureAfter = await state(); proof.bridgeAfter = await bridge();
  proof.event = proof.fixtureAfter.watchEvents.find(row => row.topic === 'file.changed' && row.payload?.rootId === proof.before.snapshot.rootId &&
    row.payload?.relativePath === 'qa-expanded/qa-watch-created.txt' &&
    proof.bridgeAfter.observed.projectFileWatchBroadcasts?.some(sent => sent.eventId === row.id && sent.clients > 0));
  proof.broadcast = proof.bridgeAfter.observed.projectFileWatchBroadcasts?.find(row => row.eventId === proof.event?.id && row.clients > 0);
  const afterShot = await captureHeadlessScreenshot(harness, 'watch-after', deadlineMs);
  proof.screenshots.push(afterShot); result.screenshots.push(afterShot);
  check('real watcher event reached SSE and refreshed the visible File tree without disturbing the editor', assertProjectWatchEvidence(proof));
  result.observedStages.push('fixture filesystem watcher event', 'fixture SSE broadcast attempted with connected client',
    'FileView tree refreshed after watcher event');
  result.unverified = ['Screenshot visual review', 'hardware foreground behavior', 'actual native OS picker', 'provider call count'];
}

export async function awaitProjectWatchDeadline(work, deadlineMs, now = Date.now) {
  assertBeforeDeadline(deadlineMs, now());
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => { assertBeforeDeadline(deadlineMs, now()); return work(); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('QA deadline reached; no further actions')), Math.max(1, deadlineMs - now())); }),
    ]);
    assertBeforeDeadline(deadlineMs, now());
    return value;
  } finally { clearTimeout(timer); }
}

// Unlike the legacy runner, this watcher entry never begins a failure capture
// after the deadline. Main owns Firefox/fixture; this wrapper only attaches to
// the explicit QA profile and closes its own MCP connection on every outcome.
export async function runProjectWatcherCli(options, { env = process.env, now = Date.now,
  validateEnvironment = assertProjectWatchEnvironment, validateIsolation = validateQaFixtureIsolation,
  createHarness = value => new FirefoxMcpChatHarness(value), scenario = runProjectFileWatcherFlow } = {}) {
  validateEnvironment(env); assertBeforeDeadline(options.deadlineMs, now());
  const isolation = validateIsolation(options.profile, { env });
  const result = { kind: 'firefox-mcp-project-file-watcher-flow', automatedAssertionsPassed: false,
    visualReview: 'pending', providerCalls: 'not-measured', checks: [], screenshots: [], fixtureIsolation: isolation };
  const controller = new AbortController(), fixtureOperations = [];
  let harness, receipt, active = true;
  const assertCurrent = () => {
    if (!active || controller.signal.aborted) throw new Error('Watcher QA is no longer current');
    assertBeforeDeadline(options.deadlineMs, now());
  };
  try {
    assertCurrent();
    harness = createHarness({ profile: options.profile, marionettePort: Number(env.EGDESK_MARIONETTE_PORT) });
    assertCurrent();
    await awaitProjectWatchDeadline(() => harness.connect(), options.deadlineMs, now);
    const guarded = guardProjectWatchHarness(harness, assertCurrent);
    await awaitProjectWatchDeadline(() => scenario({ harness: guarded, result, check(label, condition, details = undefined) {
      assertCurrent();
      result.checks.push({ label, passed: Boolean(condition), ...(details === undefined ? {} : { details }) });
      assert.ok(condition, label);
    } }, { ...options, env, signal: controller.signal, assertCurrent, fixtureOperations }), options.deadlineMs, now);
    assertCurrent();
    result.automatedAssertionsPassed = true;
  } catch (error) {
    result.error = String(error?.message || error);
    result.failureScreenshot = 'not-attempted';
  } finally {
    active = false;
    controller.abort();
    for (const operation of fixtureOperations) if (operation.status === 'pending') {
      operation.status = operation.dispatched ? 'unknown' : 'not-dispatched';
    }
    // Freeze the scenario's evidence before awaiting cleanup: a continuation
    // that was already in flight can still hold its original result object.
    receipt = structuredClone(result);
    receipt.fixtureOperations = structuredClone(fixtureOperations);
    try { await harness?.close(); }
    catch (error) { receipt.cleanupError = String(error?.message || error); receipt.automatedAssertionsPassed = false; }
    if (harness?.evidenceDir) {
      try {
        receipt.evidenceFile = path.join(harness.evidenceDir, 'result.json');
        fs.writeFileSync(receipt.evidenceFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) { receipt.evidenceWriteError = String(error?.message || error); receipt.automatedAssertionsPassed = false; }
    }
  }
  // A late scenario continuation cannot mutate the returned or saved receipt.
  return receipt;
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv);
  assertProjectEnvironment(env);
  if (env.EGDESK_QA_PROJECT_FILE_WATCH === '1') {
    assertProjectWatchEnvironment(env);
    const result = await runProjectWatcherCli(options, { env });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.automatedAssertionsPassed) process.exitCode = 1;
    return result;
  }
  assert.ok(env.EGDESK_QA_PROJECT_FILE_WATCH == null || env.EGDESK_QA_PROJECT_FILE_WATCH === '0', 'invalid watcher fixture opt-in');
  // runUiFlow performs only profile-bound attach, never process launch.
  await runUiFlow('firefox-mcp-project-file-flow', context => runProjectFileFlow(context, { ...options, env }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
