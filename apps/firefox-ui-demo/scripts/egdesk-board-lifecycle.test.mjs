import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Lifecycle from '../overlay/resources/EGDeskBoardLifecycle.sys.mjs';
import {
  isBoardTrashed, trashBoard, restoreBoard, purgeBoard, trashedBoardEntries, liveBoardIds,
  boardDeletePrompt, boardPurgePrompt, boardSavedNotice, boardCloseSummary, boardRenameResult, uniqueBoardTitle,
  boardTrashedAtLabel, boardRowKeyAction, boardSaveAsName, boardSaveAsPrompt, boardSavedAsNotice, saveBoardAs, liveBoardTitles,
} from '../overlay/resources/EGDeskBoardLifecycle.sys.mjs';

const snapshot = (id, title, cards = 0) => ({ agenda: { id, title }, cards: Array.from({ length: cards }, (_, i) => ({ id: `${id}-c${i}` })), shapes: [], savedAt: 100 });
const storeOf = (...boards) => ({
  version: 2, updatedAt: 1, activeAgendaId: boards[0]?.[0] || null,
  agendas: Object.fromEntries(boards.map(([id, title, cards]) => [id, snapshot(id, title, cards)])),
  meta: Object.fromEntries(boards.map(([id, title, , extra]) => [id, { id, title, createdAt: 1, updatedAt: 2, ...(extra || {}) }])),
});

// ------------------------------------------------------------------ 휴지통

test('a record without deletedAt is a normal Board; only a positive deletedAt is trash', () => {
  assert.equal(isBoardTrashed(undefined), false);
  assert.equal(isBoardTrashed({ id: 'a', title: 'A' }), false);
  assert.equal(isBoardTrashed({ deletedAt: null }), false);
  assert.equal(isBoardTrashed({ deletedAt: 0 }), false);
  assert.equal(isBoardTrashed({ deletedAt: 'yesterday' }), false);
  assert.equal(isBoardTrashed({ deletedAt: 1700000000000 }), true);
});

test('moving to trash marks the record, keeps the saved Board, and leaves the input store untouched', () => {
  const store = storeOf(['a', '자료 정리', 3], ['b', '회의 준비', 1]);
  const before = JSON.stringify(store);
  const result = trashBoard(store, 'b', 5000);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(store), before, 'pure: the given store is not changed');
  assert.equal(result.store.meta.b.deletedAt, 5000);
  assert.deepEqual(result.store.agendas.b, store.agendas.b, 'the saved Board itself stays');
  assert.deepEqual(liveBoardIds(result.store), ['a']);
  assert.deepEqual(trashedBoardEntries(result.store).map(entry => [entry.id, entry.title, entry.count, entry.deletedAt]), [['b', '회의 준비', 1, 5000]]);
  assert.equal(trashBoard(store, 'missing', 1).ok, false);
  assert.equal(trashBoard(result.store, 'b', 9000).ok, false, 'already in the trash');
});

test('a trashed Board that was the remembered current Board is no longer remembered as current', () => {
  const store = storeOf(['a', 'A', 1], ['b', 'B', 1]);
  assert.equal(trashBoard(store, 'a', 10).store.activeAgendaId, null);
  assert.equal(trashBoard(store, 'b', 10).store.activeAgendaId, 'a');
});

test('trash rows are newest first and a Board known only by its meta still appears', () => {
  const store = storeOf(['a', 'A', 2, { deletedAt: 100 }], ['b', 'B', 0, { deletedAt: 300 }], ['c', 'C', 1]);
  store.meta.d = { id: 'd', title: '초안', deletedAt: 200 };
  assert.deepEqual(trashedBoardEntries(store).map(entry => entry.id), ['b', 'd', 'a']);
  assert.equal(trashedBoardEntries(store).find(entry => entry.id === 'd').count, 0);
  assert.deepEqual(liveBoardIds(store), ['c']);
  assert.deepEqual(trashedBoardEntries(null), []);
  assert.deepEqual(liveBoardIds(undefined), []);
});

test('restore brings the Board back as a closed Board and renames it when a live Board took its name', () => {
  const store = storeOf(['a', '자료 정리', 2, { deletedAt: 100, lastOpenedAt: 50 }], ['b', '자료 정리', 1], ['c', '자료 정리 (복구)', 1]);
  const before = JSON.stringify(store);
  const result = restoreBoard(store, 'a', 900);
  assert.equal(JSON.stringify(store), before);
  assert.equal(result.ok, true);
  assert.equal(result.renamed, true);
  assert.equal(result.title, '자료 정리 (복구 2)');
  assert.equal(result.store.meta.a.title, '자료 정리 (복구 2)');
  assert.equal(result.store.agendas.a.agenda.title, '자료 정리 (복구 2)');
  assert.equal('deletedAt' in result.store.meta.a, false);
  assert.equal(result.store.meta.a.closedAt, 900, 'restored Boards come back closed: nothing reopens or runs on its own');
  assert.equal(result.store.meta.a.restoredAt, 900);
  assert.deepEqual(liveBoardIds(result.store).sort(), ['a', 'b', 'c']);
  const plain = restoreBoard(storeOf(['x', '혼자', 0, { deletedAt: 5 }]), 'x', 6);
  assert.equal(plain.renamed, false);
  assert.equal(plain.title, '혼자');
  assert.equal(restoreBoard(store, 'b', 1).ok, false, 'not in the trash');
  assert.equal(restoreBoard(store, 'nope', 1).ok, false);
});

test('permanent delete removes only a trashed Board, body and record together', () => {
  const store = storeOf(['a', 'A', 2, { deletedAt: 100 }], ['b', 'B', 1]);
  const before = JSON.stringify(store);
  assert.equal(purgeBoard(store, 'b').ok, false, 'a live Board must go through the trash first');
  const result = purgeBoard(store, 'a');
  assert.equal(JSON.stringify(store), before);
  assert.equal(result.ok, true);
  assert.equal('a' in result.store.agendas, false);
  assert.equal('a' in result.store.meta, false);
  assert.deepEqual(Object.keys(result.store.agendas), ['b']);
});

test('trash time is said in Korean, relative to now', () => {
  const now = Date.UTC(2026, 10, 14, 12);
  assert.equal(boardTrashedAtLabel(now - 20_000, now), '방금 삭제');
  assert.equal(boardTrashedAtLabel(now - 5 * 60_000, now), '5분 전 삭제');
  assert.equal(boardTrashedAtLabel(now - 3 * 3_600_000, now), '3시간 전 삭제');
  assert.equal(boardTrashedAtLabel(now - 2 * 86_400_000, now), '2일 전 삭제');
  assert.equal(boardTrashedAtLabel(null, now), '삭제됨');
});

// ------------------------------------------------------------------ 확인 문구

test('delete confirmation names the Board, what goes, and what stays; an open Board is closed first', () => {
  const prompt = boardDeletePrompt({ title: '자료 정리', count: 3, open: false });
  assert.equal(prompt.canDelete, true);
  assert.equal(prompt.heading, "'자료 정리' Board를 휴지통으로 옮길까요?");
  assert.equal(prompt.confirmLabel, '휴지통으로 이동');
  assert.equal(prompt.cancelLabel, '취소');
  assert.match(prompt.lines.join(' '), /저장된 구성\(항목 3개\)/);
  assert.match(prompt.lines.join(' '), /휴지통에서 다시 복구/);
  assert.match(prompt.lines.join(' '), /원본 파일.*그대로/);
  const open = boardDeletePrompt({ title: '자료 정리', count: 3, open: true });
  assert.equal(open.canDelete, false);
  assert.equal(open.confirmLabel, null);
  assert.equal(open.cancelLabel, '확인');
  assert.match(open.lines.join(' '), /지금 Desk에 열려 있습니다/);
  assert.match(open.lines.join(' '), /먼저 Board를 닫/);
  assert.equal(boardDeletePrompt({}).heading, "'Board' Board를 휴지통으로 옮길까요?");
});

test('permanent delete asks once more and says it cannot be undone', () => {
  const prompt = boardPurgePrompt({ title: '회의 준비', count: 2 });
  assert.equal(prompt.heading, "'회의 준비' Board를 완전히 삭제할까요?");
  assert.equal(prompt.confirmLabel, '완전히 삭제');
  assert.match(prompt.lines.join(' '), /되돌릴 수 없습니다/);
  assert.equal(prompt.lines.some(line => /버전 기록/.test(line)), false);
  assert.equal(boardPurgePrompt({ title: '회의 준비', count: 2, keepsHistory: true }).lines.some(line => /버전 기록/.test(line)), true);
});

test('save notice says how many 화면 went in', () => {
  assert.equal(boardSavedNotice({ title: '자료 정리', count: 4 }), "'자료 정리' Board에 화면 4개 저장됨");
  assert.equal(boardSavedNotice({ count: 0 }), '빈 Board로 저장됨');
  assert.equal(boardSavedNotice({ title: '  ', count: 2.4 }), 'Board에 화면 2개 저장됨');
  assert.equal(boardSavedNotice({ title: '자료 정리', count: 4, shapeCount: 2 }), "'자료 정리' Board에 화면 4개 · 도형 2개 저장됨");
  assert.equal(boardSavedNotice({ title: '자료 정리', count: 0, shapeCount: 1 }), "'자료 정리' Board에 도형 1개 저장됨");
  assert.equal(boardSavedAsNotice({ title: '자료 정리 사본', count: 3 }), "'자료 정리 사본' Board로 화면 3개 저장됨 · Board 목록에서 열 수 있습니다.");
  assert.equal(boardSavedAsNotice({ title: '빈 것', count: 0 }), "'빈 것' Board로 저장됨(화면 없음) · Board 목록에서 열 수 있습니다.");
});

// ------------------------------------------------------------------ 다른 이름으로 저장

test('save as: the name must be given and free among the Boards the list shows', () => {
  assert.deepEqual(boardSaveAsName('  새   이름 ', ['자료 정리']), { ok: true, title: '새 이름' });
  assert.equal(boardSaveAsName('   ', []).message, 'Board 이름을 입력해 주세요.');
  const taken = boardSaveAsName('자료 정리', ['회의', ' 자료 정리 ']);
  assert.equal(taken.ok, false);
  assert.equal(taken.message, "'자료 정리' 이름의 Board가 이미 있습니다. 다른 이름을 입력해 주세요.");
  const store = storeOf(['a', '자료 정리', 3], ['b', '회의', 1, { deletedAt: 10 }]);
  assert.deepEqual(liveBoardTitles(store), ['자료 정리'], 'a name that only exists in the trash is free');
});

test('save as prompt suggests a free name and says the open Board stays', () => {
  const prompt = boardSaveAsPrompt({ title: '자료 정리', viewCount: 4, taken: ['자료 정리', '자료 정리 사본'] });
  assert.equal(prompt.heading, "'자료 정리' Board를 다른 이름으로 저장");
  assert.equal(prompt.suggested, '자료 정리 사본 2');
  assert.deepEqual(prompt.lines, [
    '지금 화면에 있는 구성(화면 4개)을 새 Board로 저장합니다.',
    "열려 있는 '자료 정리' Board와 저장된 내용은 바뀌지 않습니다.",
  ]);
  assert.deepEqual([prompt.confirmLabel, prompt.cancelLabel], ['저장', '취소']);
  assert.equal(boardSaveAsPrompt({ title: '회의', viewCount: 0, taken: [] }).suggested, '회의 사본');
});

test('save as adds a new closed Board and leaves the source Board, the active Board and the input store untouched', () => {
  const store = storeOf(['a', '자료 정리', 3], ['b', '회의', 1]);
  const before = JSON.stringify(store);
  const live = { ...snapshot('a', '자료 정리', 4), desk: { activeAgendaId: 'a' } };
  const result = saveBoardAs(store, { snapshot: live, newId: 'n1', title: ' 자료 정리 2차 ', sourceId: 'a', now: 500 });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(store), before);
  assert.deepEqual([result.id, result.title, result.count, result.shapeCount], ['n1', '자료 정리 2차', 4, 0]);
  assert.equal(result.store.activeAgendaId, 'a');
  assert.deepEqual(result.store.agendas.a, store.agendas.a);
  assert.deepEqual(result.store.agendas.n1.agenda, { id: 'n1', title: '자료 정리 2차' });
  assert.equal(result.store.agendas.n1.savedAt, 500);
  assert.equal(result.store.agendas.n1.cards.length, 4);
  assert.deepEqual(result.store.agendas.n1.desk, { activeAgendaId: 'n1' });
  assert.deepEqual(result.store.meta.n1, { id: 'n1', title: '자료 정리 2차', createdAt: 500, updatedAt: 500, lastOpenedAt: null, closedAt: 500, duplicatedFrom: 'a' });
  assert.equal(live.agenda.id, 'a', 'the snapshot handed in is not changed');
  assert.notEqual(result.snapshot.cards, live.cards);

  assert.equal(saveBoardAs(store, { snapshot: live, newId: 'n2', title: '회의', sourceId: 'a' }).message, "'회의' 이름의 Board가 이미 있습니다. 다른 이름을 입력해 주세요.");
  assert.equal(saveBoardAs(store, { snapshot: live, newId: 'n2', title: '', sourceId: 'a' }).ok, false);
  assert.equal(saveBoardAs(store, { snapshot: live, newId: 'b', title: '새 것', sourceId: 'a' }).ok, false, 'never writes over an existing Board');
  assert.equal(saveBoardAs(store, { snapshot: null, newId: 'n3', title: '새 것' }).ok, false);
});

test('close summary lists what closes together and makes 저장 후 닫기 the default', () => {
  const summary = boardCloseSummary({ dirtyCount: 3, viewCount: 5, terminalCount: 2 });
  assert.equal(summary.copy, '저장하지 않은 변경 3건이 있습니다.');
  assert.equal(summary.closing, '같이 닫히는 것: 화면 5개 · 그중 터미널 2개(실행 중인 명령도 종료)');
  assert.equal(summary.kept, '저장된 Board는 Board 목록에 남아 다시 열 수 있습니다.');
  // In the order the buttons sit, the default last (right), as on the other Board dialogs.
  assert.deepEqual(summary.actions.map(action => [action.action, action.label, action.kind]), [
    ['continue', '취소', 'ghost'], ['discard', '저장하지 않고 닫기', 'ghost'], ['save', '저장 후 닫기', 'primary'],
  ]);
  assert.equal(summary.actions.every(action => action.title), true);
  assert.equal(summary.defaultAction, 'save');
  const quiet = boardCloseSummary({ dirtyCount: 1, viewCount: 1 });
  assert.equal(quiet.copy, '저장하지 않은 변경이 있습니다.');
  assert.equal(quiet.closing, '같이 닫히는 것: 화면 1개');
  assert.equal(boardCloseSummary({}).closing, '같이 닫히는 화면이 없습니다.');
  // A count that cannot be true (more terminals than 화면) is not repeated to the person.
  assert.equal(boardCloseSummary({ viewCount: 1, terminalCount: 4 }).closing, '같이 닫히는 것: 화면 1개 · 그중 터미널 1개(실행 중인 명령도 종료)');
});

// ------------------------------------------------------------------ 이름

test('rename: trimmed, blank refused, unchanged is a quiet cancel', () => {
  assert.deepEqual(boardRenameResult('자료 정리', '  회의   준비 '), { ok: true, changed: true, title: '회의 준비' });
  assert.deepEqual(boardRenameResult('자료 정리', '자료 정리 '), { ok: true, changed: false, title: '자료 정리' });
  const blank = boardRenameResult('자료 정리', '   ');
  assert.equal(blank.ok, false);
  assert.equal(blank.message, 'Board 이름을 입력해 주세요.');
  assert.equal(boardRenameResult('a', 'x'.repeat(200)).title.length, 80);
});

test('unique title appends a number only when the name is taken', () => {
  assert.equal(uniqueBoardTitle('자료', ['회의']), '자료');
  assert.equal(uniqueBoardTitle('자료', ['자료']), '자료 2');
  assert.equal(uniqueBoardTitle('자료', ['자료', '자료 2', ' 자료 3 ']), '자료 4');
  assert.equal(uniqueBoardTitle('', []), 'Board');
});

test('row keys: F2 renames, Delete moves to trash, Shift+F10 opens the row actions; typing in a field is left alone', () => {
  const key = (k, extra = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
  assert.equal(boardRowKeyAction(key('F2')), 'rename');
  assert.equal(boardRowKeyAction(key('Delete')), 'delete');
  assert.equal(boardRowKeyAction(key('F10', { shiftKey: true })), 'actions');
  assert.equal(boardRowKeyAction(key('ContextMenu')), 'actions');
  assert.equal(boardRowKeyAction(key('F10')), null);
  assert.equal(boardRowKeyAction(key('F2', { ctrlKey: true })), null);
  assert.equal(boardRowKeyAction(key('F2'), { editing: true }), null);
  assert.equal(boardRowKeyAction(key('Delete'), { editing: true }), null);
  assert.equal(boardRowKeyAction(key('Enter')), null);
});

// ------------------------------------------------------------------ 화면 배선

const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const declaration = name => {
  const start = surface.indexOf(`\n  function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = surface.indexOf('\n  }\n', start);
  return surface.slice(start, next + 4);
};

test('screen: Board delete no longer answers with a not-connected notice and never opens a system prompt', () => {
  assert.equal(surface.includes('Board 삭제와 복구 정책은 아직 연결되지 않았습니다'), false);
  assert.equal(/window\.prompt\('Board 이름'/.test(surface), false);
  const remove = declaration('deleteAgenda');
  assert.match(remove, /BoardLifecycle\.boardDeletePrompt\(/);
  assert.match(surface, /BoardLifecycle\.trashBoard\(/);
  assert.match(surface, /BoardLifecycle\.restoreBoard\(/);
  assert.match(surface, /BoardLifecycle\.purgeBoard\(/);
});

test('screen: every list of saved Boards skips the trash', () => {
  const entries = declaration('agendaListEntries');
  assert.match(entries, /BoardLifecycle\.isBoardTrashed\(/);
  assert.match(declaration('chatRequestProjectCandidates'), /BoardLifecycle\.isBoardTrashed\(/);
  assert.match(declaration('buildRailSearchHistoryResults'), /BoardLifecycle\.isBoardTrashed\(/);
  assert.match(declaration('switchAgenda'), /BoardLifecycle\.isBoardTrashed\(/);
});

// A small stand-in for the chrome document: enough to run the production
// delete / restore / permanent-delete functions cut out of the surface script.
function lifecycleHarness(initialStore, { projections = {}, historyReady = false, writable = true } = {}) {
  let store = JSON.parse(JSON.stringify(initialStore));
  const attached = [];
  const notices = [];
  let rails = 0;
  const document = {
    activeElement: null,
    documentElement: { appendChild: node => { attached.push(node); node.isConnected = true; } },
    getElementById: id => attached.find(node => node.id === id && node.isConnected) || null,
    querySelector: () => null,
  };
  const el = (tag, props = {}, ...children) => {
    const node = { tag, dataset: {}, attrs: {}, listeners: {}, children: children.filter(child => child != null), isConnected: false,
      get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); },
      focus() { document.activeElement = this; }, remove() { this.isConnected = false; },
      find(action) { return this.dataset.action === action ? this : this.children.map(child => typeof child === 'string' ? null : child.find(action)).find(Boolean) || null; },
      setAttribute(name, value) { this.attrs[name] = value; } };
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'id') node.id = value;
      else if (key === 'data') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.listeners[key.slice(2)] = value;
      else node.attrs[key] = value;
    }
    return node;
  };
  const deps = {
    document, el, BoardLifecycle: Lifecycle, state: { boards: { projections } },
    coerceAgendaStore: () => JSON.parse(JSON.stringify(store)),
    writeAgendaStoreAndSync: next => { if (!writable) return false; store = JSON.parse(JSON.stringify(next)); return true; },
    boardNotice: message => notices.push(message), boardDoneNotice: message => notices.push(message), syncViewportAgendaRail: () => { rails += 1; },
    agendaCardCountForSnapshot: snapshot => (snapshot?.cards?.length || 0) + (snapshot?.shapes?.length || 0),
    agendaSwitcherRow: () => null, boardVersionHistoryReady: () => historyReady,
  };
  const names = ['closeBoardConfirm', 'showBoardConfirm', 'writeBoardLifecycleStore', 'focusBoardTrashToggle',
    'moveAgendaToTrash', 'restoreAgendaFromTrash', 'purgeAgendaFromTrash', 'deleteAgenda'];
  const api = new Function(...Object.keys(deps), `let boardTrashOpen = false;\n${names.map(declaration).join('\n')}\nreturn { ${names.join(', ')}, trashOpen: () => boardTrashOpen };`)(...Object.values(deps));
  return { ...api, document, notices, store: () => store, rails: () => rails, dialog: () => document.getElementById('egd-board-confirm') };
}
const press = node => node.listeners.click({ stopPropagation() {}, target: node });

test('screen: delete asks first, 취소 keeps the Board, 휴지통으로 이동 marks it and opens the trash section', () => {
  const h = lifecycleHarness(storeOf(['a', '자료 정리', 3], ['b', '회의 준비', 1]));
  assert.equal(h.deleteAgenda('b'), true);
  const dialog = h.dialog();
  assert.equal(dialog.attrs.role, 'alertdialog');
  assert.match(dialog.textContent, /'회의 준비' Board를 휴지통으로 옮길까요\?/);
  assert.match(dialog.textContent, /항목 1개/);
  assert.equal(h.document.activeElement, dialog.find('cancel'), 'focus starts on 취소');
  press(dialog.find('cancel'));
  assert.equal(h.dialog(), null);
  assert.equal(Lifecycle.isBoardTrashed(h.store().meta.b), false);

  h.deleteAgenda('b');
  h.dialog().listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.dialog(), null, 'Esc closes the confirmation');
  assert.equal(Lifecycle.isBoardTrashed(h.store().meta.b), false);

  h.deleteAgenda('b');
  assert.equal(h.dialog().find('confirm').textContent, '휴지통으로 이동');
  press(h.dialog().find('confirm'));
  assert.equal(h.dialog(), null);
  assert.equal(Lifecycle.isBoardTrashed(h.store().meta.b), true);
  assert.ok(h.store().agendas.b, 'the saved Board is kept for restore');
  assert.equal(h.trashOpen(), true);
  assert.equal(h.rails(), 1);
  assert.match(h.notices.at(-1), /'회의 준비' Board를 휴지통으로 옮겼습니다.*복구/);
  assert.equal(h.deleteAgenda('b'), false, 'already in the trash');
  assert.equal(h.deleteAgenda('missing'), false);
});

test('screen: a Board that is open on the Desk is not deleted; the confirmation only says to close it first', () => {
  const h = lifecycleHarness(storeOf(['a', '자료 정리', 3]), { projections: { p1: { id: 'p1', boardId: 'a' } } });
  h.deleteAgenda('a');
  assert.equal(h.dialog().find('confirm'), null);
  assert.equal(h.dialog().find('cancel').textContent, '확인');
  assert.match(h.dialog().textContent, /먼저 Board를 닫/);
  assert.equal(h.deleteAgenda('a', { confirmed: true }), false);
  assert.equal(Lifecycle.isBoardTrashed(h.store().meta.a), false);
});

test('screen: restore returns the Board to the list; permanent delete asks once more and then removes it', () => {
  const h = lifecycleHarness(storeOf(['a', '자료 정리', 3, { deletedAt: 10 }], ['b', '자료 정리', 1], ['c', '회의', 2, { deletedAt: 20 }]), { historyReady: true });
  assert.equal(h.restoreAgendaFromTrash('a'), true);
  assert.equal(Lifecycle.isBoardTrashed(h.store().meta.a), false);
  assert.equal(h.store().meta.a.title, '자료 정리 (복구)');
  assert.match(h.notices.at(-1), /같은 이름의 Board가 있어 '자료 정리 \(복구\)' 이름으로 복구했습니다/);
  assert.equal(h.restoreAgendaFromTrash('b'), false);
  assert.match(h.notices.at(-1), /복구하지 못했습니다/);

  assert.equal(h.purgeAgendaFromTrash('b'), false, 'only from the trash');
  assert.equal(h.purgeAgendaFromTrash('c'), true);
  assert.match(h.dialog().textContent, /'회의' Board를 완전히 삭제할까요\?/);
  assert.match(h.dialog().textContent, /되돌릴 수 없습니다/);
  assert.match(h.dialog().textContent, /버전 기록/);
  assert.ok(h.store().agendas.c, 'nothing is removed before the second confirmation');
  press(h.dialog().find('confirm'));
  assert.equal('c' in h.store().agendas, false);
  assert.equal('c' in h.store().meta, false);
  assert.match(h.notices.at(-1), /완전히 삭제했습니다/);
});

// The production name field and its commit, cut out of the surface script.
function renameHarness({ title = '자료 정리', renameOk = true } = {}) {
  const renames = [], notices = [];
  let renders = 0, rowFocus = 0;
  const panel = { id: 'egd-agenda-switcher' };
  const document = { getElementById: id => id === 'egd-agenda-switcher' ? panel : null };
  const el = (tag, props = {}) => {
    const node = { tag, attrs: {}, listeners: {}, dataset: {}, value: props.value ?? '', title: props.title ?? '', isConnected: true,
      setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; } };
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('on') && typeof value === 'function') node.listeners[key.slice(2)] = value;
      else if (key === 'data') Object.assign(node.dataset, value);
      else node.attrs[key] = value;
    }
    return node;
  };
  const deps = {
    document, el, BoardLifecycle: Lifecycle,
    agendaListEntries: () => [{ id: 'a', title }],
    renameAgenda: (id, next) => { renames.push([id, next]); return renameOk ? next : false; },
    boardNotice: message => notices.push(message),
    renderAgendaSwitcherPanel: () => { renders += 1; },
    agendaSwitcherRow: () => ({ focus: () => { rowFocus += 1; } }),
  };
  const api = new Function(...Object.keys(deps), `let boardRenamingId = 'a';\n${declaration('endAgendaRename')}\n${declaration('buildAgendaRenameField')}\nreturn { endAgendaRename, buildAgendaRenameField, renaming: () => boardRenamingId };`)(...Object.values(deps));
  const input = api.buildAgendaRenameField({ id: 'a', title });
  const key = k => { let prevented = false, stopped = false; input.listeners.keydown({ key: k, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }); return { prevented, stopped }; };
  return { ...api, input, key, renames, notices, renders: () => renders, rowFocus: () => rowFocus };
}

test('screen: the name is edited in its row — Enter keeps it, Esc drops it, and no key leaks to the row', () => {
  const h = renameHarness();
  assert.equal(h.input.attrs.type, 'text');
  assert.equal(h.input.value, '자료 정리');
  assert.equal(h.input.attrs['aria-label'], 'Board 자료 정리 이름 변경');
  assert.deepEqual(h.key('a'), { prevented: false, stopped: true }, 'typing never reaches the row (Enter/Space would open the Board)');
  h.input.value = '  회의   준비 ';
  assert.deepEqual(h.key('Enter'), { prevented: true, stopped: true });
  assert.deepEqual(h.renames, [['a', '회의 준비']]);
  assert.equal(h.renaming(), null);
  assert.equal(h.rowFocus(), 1, 'focus returns to the same row');

  const esc = renameHarness();
  esc.input.value = '버릴 이름';
  esc.key('Escape');
  assert.deepEqual(esc.renames, []);
  assert.equal(esc.renaming(), null);
  assert.equal(esc.rowFocus(), 1);
});

test('screen: an empty name is refused in place and leaving the field keeps only a real name', () => {
  const h = renameHarness();
  h.input.value = '   ';
  h.key('Enter');
  assert.equal(h.input.attrs['aria-invalid'], 'true');
  assert.equal(h.input.title, 'Board 이름을 입력해 주세요.');
  assert.equal(h.renaming(), 'a', 'still editing');
  assert.deepEqual(h.renames, []);
  h.input.value = '새';
  h.input.listeners.input();
  assert.equal('aria-invalid' in h.input.attrs, false);
  h.input.listeners.blur();
  assert.deepEqual(h.renames, [['a', '새']]);
  assert.equal(h.rowFocus(), 0, 'leaving the field does not pull focus back');

  const blank = renameHarness();
  blank.input.value = '';
  blank.input.listeners.blur();
  assert.deepEqual(blank.renames, []);
  assert.equal(blank.renaming(), null);

  const same = renameHarness();
  same.key('Enter');
  assert.deepEqual(same.renames, [], 'an unchanged name writes nothing');

  const failed = renameHarness({ renameOk: false });
  failed.input.value = '다른 이름';
  failed.key('Enter');
  assert.match(failed.notices.at(-1), /이름을 바꾸지 못했습니다/);
});

test('screen: Board list row hands F2 / Delete / Shift+F10 to the row actions', () => {
  const calls = [];
  const focused = [];
  const handle = new Function('BoardLifecycle', 'beginAgendaRename', 'deleteAgenda', `let boardRenamingId = null;\n${declaration('handleAgendaRowKey')}\nreturn handleAgendaRowKey;`)(
    Lifecycle, id => calls.push(['rename', id]), id => calls.push(['delete', id]));
  const row = { querySelector: selector => ({ focus: () => focused.push(selector) }) };
  const ev = (key, extra = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra });
  const f2 = ev('F2');
  assert.equal(handle(f2, { id: 'a' }, row), true);
  assert.equal(f2.prevented, true);
  assert.equal(handle(ev('Delete'), { id: 'a' }, row), true);
  assert.equal(handle(ev('F10', { shiftKey: true }), { id: 'a' }, row), true);
  assert.equal(handle(ev('x'), { id: 'a' }, row), false);
  assert.deepEqual(calls, [['rename', 'a'], ['delete', 'a']]);
  assert.deepEqual(focused, ['.egd-agenda-switch-row-action']);
  const render = declaration('renderAgendaSwitcherPanel');
  assert.match(render, /return handleAgendaRowKey\(ev, entry, ev\.currentTarget\)/);
  assert.match(render, /boardRenamingId === entry\.id\s*\? buildAgendaRenameField\(entry\)/);
  assert.equal(/'✎'|'⧉'|'🗑︎'/.test(render), false, 'row actions are drawn icons, not text glyphs');
});

test('screen: when the list cannot be written nothing is claimed', () => {
  const h = lifecycleHarness(storeOf(['a', '자료 정리', 3]), { writable: false });
  assert.equal(h.deleteAgenda('a', { confirmed: true }), false);
  assert.match(h.notices.at(-1), /옮기지 못했습니다/);
  assert.equal(h.trashOpen(), false);
});

// ------------------------------------------------------------------ 닫기 확인창

// The production close confirmation, cut out of the surface script.
function closeGuardHarness({ dirtyReasons = ['move', 'resize'], views = {}, members = [] } = {}) {
  const attached = [];
  const closes = [];
  let switcherCloses = 0;
  const document = {
    activeElement: null,
    documentElement: { appendChild: node => { attached.push(node); node.isConnected = true; } },
    getElementById: id => views[id] || attached.find(node => node.id === id && node.isConnected) || null,
  };
  const el = (tag, props = {}, ...children) => {
    const node = { tag, dataset: {}, attrs: {}, listeners: {}, children: children.filter(child => child != null), isConnected: false,
      get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); },
      focus() { document.activeElement = this; }, remove() { this.isConnected = false; },
      find(action) { return this.dataset.action === action ? this : this.children.map(child => typeof child === 'string' ? null : child.find(action)).find(Boolean) || null; },
      querySelector(selector) { const action = /data-action="([a-z]+)"/.exec(selector)?.[1]; return action ? this.find(action) : null; },
      all(tagName) { return [...(this.tag === tagName ? [this] : []), ...this.children.flatMap(child => typeof child === 'string' ? [] : child.all(tagName))]; } };
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'id') node.id = value;
      else if (key === 'data') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.listeners[key.slice(2)] = value;
      else node.attrs[key] = value;
    }
    return node;
  };
  const state = { agenda: { closeGuardOpen: false, dirtyReasons }, boards: { activeProjectionId: 'p1', projections: { p1: { id: 'p1', boardId: 'a', members } } } };
  const deps = {
    document, el, state, BoardLifecycle: Lifecycle,
    currentViewportAgendaLabel: () => '자료 정리',
    completeAgendaClose: options => { closes.push(options); },
    closeAgendaSwitcher: () => { switcherCloses += 1; },
  };
  const names = ['closeAgendaCloseGuard', 'boardCloseFacts', 'showAgendaCloseGuard'];
  const api = new Function(...Object.keys(deps), `${names.map(declaration).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));
  return { ...api, document, state, closes, switcherCloses: () => switcherCloses, dialog: () => document.getElementById('egd-agenda-close-guard') };
}

test('screen: Board close asks with 저장 후 닫기 as the default and says what closes together', () => {
  const terminal = { dataset: { projectionId: 'p1' }, _closeOwnedRuntime: async () => true };
  const browser = { dataset: { projectionId: 'p1' } };
  const borrowed = { dataset: { projectionId: 'p2' }, _closeOwnedRuntime: async () => true };
  const h = closeGuardHarness({
    views: { v1: terminal, v2: browser, v3: borrowed },
    members: [{ viewId: 'v1' }, { viewId: 'v2' }, { viewId: 'v3' }, { viewId: 'gone' }],
  });
  assert.deepEqual(h.boardCloseFacts(h.state.boards.projections.p1), { viewCount: 2, terminalCount: 1 }, 'only the 화면 this Board owns and still has');
  assert.equal(h.showAgendaCloseGuard(), false);
  const dialog = h.dialog();
  assert.equal(h.state.agenda.closeGuardOpen, true);
  assert.match(dialog.textContent, /Board를 닫을까요\?/);
  assert.match(dialog.textContent, /저장하지 않은 변경 2건이 있습니다\./);
  assert.match(dialog.textContent, /같이 닫히는 것: 화면 2개 · 그중 터미널 1개\(실행 중인 명령도 종료\)/);
  assert.match(dialog.textContent, /저장된 Board는 Board 목록에 남아 다시 열 수 있습니다\./);
  assert.deepEqual(dialog.all('button').map(button => [button.dataset.action, button.textContent]), [
    ['continue', '취소'], ['discard', '저장하지 않고 닫기'], ['save', '저장 후 닫기'],
  ]);
  assert.equal(dialog.all('button').every(button => button.attrs.type === 'button' && button.attrs.title), true);
  assert.equal(/danger/.test(dialog.find('discard').attrs.class), false, 'closing without saving is a plain choice, not the red one');
  assert.equal(h.document.activeElement, dialog.find('save'), 'focus starts on the default');
  assert.equal(/버리고 닫기|계속 작업/.test(dialog.textContent), false);

  press(dialog.find('save'));
  assert.deepEqual(h.closes, [{ saveFirst: true, projectionId: 'p1' }]);
  press(dialog.find('discard'));
  assert.deepEqual(h.closes.at(-1), { saveFirst: false, projectionId: 'p1' });
});

test('screen: 취소, Esc and a click outside keep the Board open and put focus back', () => {
  const h = closeGuardHarness();
  const opener = { isConnected: true, focus() { h.document.activeElement = this; } };
  h.document.activeElement = opener;
  h.showAgendaCloseGuard();
  press(h.dialog().find('continue'));
  assert.equal(h.dialog(), null);
  assert.equal(h.state.agenda.closeGuardOpen, false);
  assert.equal(h.switcherCloses(), 1);
  assert.equal(h.document.activeElement, opener);
  assert.deepEqual(h.closes, []);

  h.showAgendaCloseGuard();
  let prevented = false;
  h.dialog().listeners.keydown({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(h.dialog(), null);
  assert.equal(prevented, true);
  assert.equal(h.document.activeElement, opener);

  h.showAgendaCloseGuard();
  const dialog = h.dialog();
  dialog.listeners.click({ target: dialog });
  assert.equal(h.dialog(), null);
  assert.deepEqual(h.closes, []);

  h.showAgendaCloseGuard();
  const first = h.dialog();
  h.document.activeElement = null;
  assert.equal(h.showAgendaCloseGuard(), false, 'a second request reuses the open confirmation');
  assert.equal(h.dialog(), first);
  assert.equal(h.document.activeElement, first.find('save'));
});

// ------------------------------------------------------------------ 저장 안내 · 다른 이름으로 저장 (화면)

function saveAsHarness(initialStore, { writable = true, snapshotFor = () => ({ ...snapshot('a', '자료 정리', 2), shapes: [{ id: 's1' }] }), saveResult } = {}) {
  let store = JSON.parse(JSON.stringify(initialStore));
  const attached = [], notices = [], synced = [], saves = [];
  let rails = 0;
  const document = {
    activeElement: null,
    documentElement: { appendChild: node => { attached.push(node); node.isConnected = true; } },
    getElementById: id => attached.find(node => node.id === id && node.isConnected) || null,
  };
  const el = (tag, props = {}, ...children) => {
    const node = { tag, dataset: {}, attrs: {}, listeners: {}, children: children.filter(child => child != null), isConnected: false, hidden: false, value: '', selected: false,
      get textContent() { return this._text ?? this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); },
      set textContent(value) { this._text = String(value); },
      focus() { document.activeElement = this; }, select() { this.selected = true; }, remove() { this.isConnected = false; },
      setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
      find(action) { return this.dataset.action === action ? this : this.children.map(child => typeof child === 'string' ? null : child.find(action)).find(Boolean) || null; },
      all(tagName) { return [...(this.tag === tagName ? [this] : []), ...this.children.flatMap(child => typeof child === 'string' ? [] : child.all(tagName))]; } };
    for (const [key, value] of Object.entries(props)) {
      if (key === 'hidden') node.hidden = !!value;
      else if (value == null || value === false) continue;
      else if (key === 'id') node.id = value;
      else if (key === 'value') node.value = value;
      else if (key === 'data') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.listeners[key.slice(2)] = value;
      else node.attrs[key] = value;
    }
    return node;
  };
  const state = { boards: { activeProjectionId: 'p1', projections: { p1: { id: 'p1', boardId: 'a', title: '자료 정리', members: [{ viewId: 'v1' }, { viewId: 'v2' }, { viewId: 'v3' }] } } } };
  let seq = 0;
  const deps = {
    document, el, state, BoardLifecycle: Lifecycle,
    coerceAgendaStore: () => JSON.parse(JSON.stringify(store)),
    writeAgendaStoreAndSync: next => { if (!writable) return false; store = JSON.parse(JSON.stringify(next)); return true; },
    serializeAgendaSnapshot: options => snapshotFor(options),
    saveCurrentAgendaState: options => { saves.push(options); return saveResult === undefined ? { agenda: { id: 'a', title: '자료 정리' }, cards: [{}, {}], shapes: [] } : saveResult; },
    syncBoardToStore: (...args) => { synced.push(args); return Promise.resolve({}); },
    newAgendaId: () => `new-${++seq}`,
    boardNotice: message => notices.push(message), boardDoneNotice: message => notices.push(message), syncViewportAgendaRail: () => { rails += 1; },
  };
  const names = ['saveBoardWithNotice', 'closeBoardSaveAs', 'commitBoardSaveAs', 'openBoardSaveAs'];
  const api = new Function(...Object.keys(deps), `${names.map(declaration).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));
  return { ...api, document, state, notices, synced, saves, store: () => store, rails: () => rails, dialog: () => document.getElementById('egd-board-save-as') };
}

test('screen: 저장 says in one line how many 화면 went in, and says nothing when the save did not happen', () => {
  const h = saveAsHarness(storeOf(['a', '자료 정리', 2]));
  const saved = h.saveBoardWithNotice({ projectionId: 'p1' });
  assert.deepEqual(h.saves, [{ projectionId: 'p1' }]);
  assert.equal(saved.agenda.id, 'a');
  assert.deepEqual(h.notices, ["'자료 정리' Board에 화면 2개 저장됨"]);
  const failed = saveAsHarness(storeOf(['a', '자료 정리', 2]), { saveResult: null });
  assert.equal(failed.saveBoardWithNotice(), null);
  assert.deepEqual(failed.notices, []);
});

test('screen: 다른 이름으로 저장 asks for the name in a dialog, saves a new closed Board and leaves the open one alone', () => {
  const h = saveAsHarness(storeOf(['a', '자료 정리', 2], ['b', '회의', 1]));
  const opener = { isConnected: true, focus() { h.document.activeElement = this; } };
  h.document.activeElement = opener;
  const dialog = h.openBoardSaveAs('p1');
  assert.equal(dialog, h.dialog());
  assert.equal(dialog.attrs.role, 'dialog');
  assert.match(dialog.textContent, /다른 이름으로 저장/);
  assert.match(dialog.textContent, /구성\(화면 3개\)을 새 Board로 저장합니다/);
  assert.match(dialog.textContent, /열려 있는 '자료 정리' Board와 저장된 내용은 바뀌지 않습니다/);
  const input = dialog.all('input')[0];
  assert.equal(input.value, '자료 정리 사본');
  assert.equal(input.attrs['aria-label'], '새 Board 이름');
  assert.equal(h.document.activeElement, input);
  assert.equal(input.selected, true, 'the suggested name is selected so typing replaces it');
  assert.deepEqual(dialog.all('button').map(button => [button.dataset.action, button.textContent, button.attrs.type]), [['cancel', '취소', 'button'], ['confirm', '저장', 'button']]);
  const error = dialog.all('p').find(node => node.attrs.role === 'alert');
  assert.equal(error.hidden, true);

  input.value = '회의';
  press(dialog.find('confirm'));
  assert.equal(h.dialog(), dialog, 'a taken name keeps the dialog open');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "'회의' 이름의 Board가 이미 있습니다. 다른 이름을 입력해 주세요.");
  assert.equal(input.attrs['aria-invalid'], 'true');
  assert.deepEqual(Object.keys(h.store().agendas), ['a', 'b']);
  input.value = '자료 정리 2차';
  input.listeners.input();
  assert.equal(error.hidden, true);
  assert.equal('aria-invalid' in input.attrs, false);

  let prevented = false;
  input.listeners.keydown({ key: 'Enter', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.equal(h.dialog(), null);
  assert.equal(h.document.activeElement, opener, 'focus returns to where the person was');
  const stored = h.store();
  const added = Object.keys(stored.agendas).filter(id => id !== 'a' && id !== 'b');
  assert.equal(added.length, 1, 'exactly one Board is added (the refused name added none)');
  const [newId] = added;
  assert.equal(stored.agendas[newId].agenda.title, '자료 정리 2차');
  assert.equal(stored.agendas[newId].agenda.id, newId);
  assert.equal(stored.meta[newId].duplicatedFrom, 'a');
  assert.ok(stored.meta[newId].closedAt > 0, 'the new Board is saved closed; nothing opens or moves');
  assert.equal(stored.activeAgendaId, 'a');
  assert.equal(h.state.boards.projections.p1.boardId, 'a');
  assert.deepEqual(h.synced.map(args => [args[0], args[2]]), [[newId, '자료 정리 2차']]);
  assert.equal(h.rails(), 1);
  assert.deepEqual(h.notices, ["'자료 정리 2차' Board로 화면 2개 · 도형 1개 저장됨 · Board 목록에서 열 수 있습니다."]);
});

test('screen: 다른 이름으로 저장 closes on 취소, Esc and a press outside without saving, and claims nothing when the list cannot be written', () => {
  const h = saveAsHarness(storeOf(['a', '자료 정리', 2]));
  press(h.openBoardSaveAs('p1').find('cancel'));
  assert.equal(h.dialog(), null);
  const escaped = h.openBoardSaveAs('p1');
  escaped.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.dialog(), null);
  const outside = h.openBoardSaveAs('p1');
  outside.listeners.mousedown({ target: outside.all('input')[0] });
  outside.listeners.click({ target: outside });
  assert.equal(h.dialog(), outside, 'a drag that started in the name field does not close the dialog');
  outside.listeners.mousedown({ target: outside });
  outside.listeners.click({ target: outside });
  assert.equal(h.dialog(), null);
  assert.deepEqual(Object.keys(h.store().agendas), ['a']);
  assert.deepEqual(h.notices, []);

  assert.equal(h.openBoardSaveAs('missing'), null);
  assert.match(h.notices.at(-1), /Board를 먼저 선택해 주세요/);

  const locked = saveAsHarness(storeOf(['a', '자료 정리', 2]), { writable: false });
  const dialog = locked.openBoardSaveAs('p1');
  press(dialog.find('confirm'));
  assert.equal(locked.dialog(), dialog);
  assert.match(dialog.all('p').find(node => node.attrs.role === 'alert').textContent, /저장하지 못했습니다/);
  assert.deepEqual(locked.notices, []);
  assert.deepEqual(locked.synced, []);

  const gone = saveAsHarness(storeOf(['a', '자료 정리', 2]), { snapshotFor: () => null });
  assert.equal(gone.commitBoardSaveAs('p1', '새 이름').ok, false);
});

test('screen: the Board menu and the Board list save through the one-line notice, and the menu offers 다른 이름으로 저장', () => {
  const menu = declaration('toggleBoardRegionMenu');
  assert.match(menu, /item\('저장', '이 Board 저장', 'board-save', \(\) => saveBoardWithNotice\(\{ projectionId \}\)\)/);
  assert.match(menu, /item\('다른 이름으로 저장…', [^\n]*'board-save-as', \(\) => openBoardSaveAs\(projectionId\)\)/);
  assert.match(declaration('renderAgendaSwitcherPanel'), /saveBoardWithNotice\(\);/);
});

// ------------------------------------------------------------------ 보관함

test('archive is a list category only: the saved Board, its name and its open state are untouched', () => {
  const store = storeOf(['a', '자료 정리', 3], ['b', '회의', 1], ['c', '지난 것', 2, { deletedAt: 10 }]);
  const before = JSON.stringify(store);
  assert.equal(Lifecycle.isBoardArchived(store.meta.a), false);
  assert.equal(Lifecycle.isBoardArchived({ archivedAt: 'x' }), false);
  const archived = Lifecycle.archiveBoard(store, 'b', 700);
  assert.equal(archived.ok, true);
  assert.equal(archived.title, '회의');
  assert.equal(JSON.stringify(store), before);
  assert.equal(archived.store.meta.b.archivedAt, 700);
  assert.deepEqual(archived.store.agendas.b, store.agendas.b);
  assert.equal(archived.store.activeAgendaId, 'a');
  assert.equal(Lifecycle.archiveBoard(archived.store, 'b', 800).ok, false, 'already archived');
  assert.equal(Lifecycle.archiveBoard(store, 'c', 800).ok, false, 'a Board in the trash is not archived');
  assert.equal(Lifecycle.archiveBoard(store, 'missing', 800).ok, false);

  const back = Lifecycle.unarchiveBoard(archived.store, 'b');
  assert.equal(back.ok, true);
  assert.equal('archivedAt' in back.store.meta.b, false);
  assert.equal(Lifecycle.unarchiveBoard(store, 'a').ok, false);

  // A Board restored from the trash comes back to the normal list.
  const trashed = trashBoard(archived.store, 'b', 900);
  assert.equal('archivedAt' in restoreBoard(trashed.store, 'b', 950).store.meta.b, false);
});

test('archived Boards show only under 보관함, except the Board that is open now', () => {
  const match = Lifecycle.boardListFilterMatch;
  const plain = { closed: false, lastOpenedAt: 5, updatedAt: 5 };
  const closed = { closed: true, lastOpenedAt: null, updatedAt: null };
  const archived = { ...closed, archived: true, updatedAt: 3 };
  assert.deepEqual(['all', 'recent', 'closed', 'archived'].map(filter => match(plain, filter)), [true, true, false, false]);
  assert.deepEqual(['all', 'recent', 'closed', 'archived'].map(filter => match(closed, filter)), [true, false, true, false]);
  assert.deepEqual(['all', 'recent', 'closed', 'archived'].map(filter => match(archived, filter)), [false, false, false, true]);
  assert.equal(match({ ...archived, current: true }, 'all'), true, 'the open Board never disappears from its own list');
  assert.equal(match(plain, undefined), true);
  assert.deepEqual(Lifecycle.boardArchiveAction({ archived: false, title: '회의' }), { archive: true, label: '보관함으로 이동', ariaLabel: 'Board 회의 보관함으로 이동' });
  assert.deepEqual(Lifecycle.boardArchiveAction({ archived: true, title: '회의' }), { archive: false, label: '보관 해제', ariaLabel: 'Board 회의 보관 해제' });
});

test('screen: 보관함으로 이동 / 보관 해제 write the mark and say where the Board went', () => {
  let store = storeOf(['a', '자료 정리', 3], ['b', '회의', 1]);
  const notices = [];
  let rails = 0, writable = true;
  const deps = {
    BoardLifecycle: Lifecycle,
    coerceAgendaStore: () => JSON.parse(JSON.stringify(store)),
    writeAgendaStoreAndSync: next => { if (!writable) return false; store = JSON.parse(JSON.stringify(next)); return true; },
    boardNotice: message => notices.push(message), boardDoneNotice: message => notices.push(message), syncViewportAgendaRail: () => { rails += 1; },
    agendaSwitcherRow: () => null, document: { querySelector: () => null },
  };
  const names = ['writeBoardLifecycleStore', 'setAgendaArchived'];
  const api = new Function(...Object.keys(deps), `${names.map(declaration).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));
  assert.equal(api.setAgendaArchived('b', true), true);
  assert.ok(store.meta.b.archivedAt > 0);
  assert.ok(store.agendas.b, 'the saved Board is kept');
  assert.equal(notices.at(-1), "'회의' Board를 보관함으로 옮겼습니다. Board 목록의 '보관함'에서 다시 꺼낼 수 있습니다.");
  assert.equal(api.setAgendaArchived('b', false), true);
  assert.equal('archivedAt' in store.meta.b, false);
  assert.equal(notices.at(-1), "'회의' Board를 보관함에서 꺼냈습니다.");
  assert.equal(rails, 2);
  writable = false;
  assert.equal(api.setAgendaArchived('a', true), false);
  assert.match(notices.at(-1), /보관함으로 옮기지 못했습니다/);
  assert.equal('archivedAt' in store.meta.a, false);

  const render = declaration('renderAgendaSwitcherPanel');
  assert.match(render, /\['archived', '보관함', counts\.archived\]/);
  assert.match(render, /setAgendaArchived\(entry\.id, archiveAction\.archive\)/);
  assert.match(declaration('agendaEntryMatchesFilter'), /BoardLifecycle\.boardListFilterMatch\(entry, filter\)/);
  assert.match(declaration('agendaListEntries'), /archived: BoardLifecycle\.isBoardArchived\(meta\)/);
  assert.match(declaration('agendaFilterCounts'), /archived: agendaListEntries\(\{ filter: 'archived', query: '' \}\)\.length/);
  // Saving an open Board keeps its 보관함 mark.
  assert.match(declaration('saveCurrentAgendaState'), /archivedAt: store\.meta\[agendaId\]\.archivedAt/);
});
