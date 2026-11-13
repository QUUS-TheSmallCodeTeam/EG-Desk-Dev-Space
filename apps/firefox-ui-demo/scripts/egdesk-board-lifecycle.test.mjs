import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Lifecycle from '../overlay/resources/EGDeskBoardLifecycle.sys.mjs';
import {
  isBoardTrashed, trashBoard, restoreBoard, purgeBoard, trashedBoardEntries, liveBoardIds,
  boardDeletePrompt, boardPurgePrompt, boardSavedNotice, boardCloseSummary, boardRenameResult, uniqueBoardTitle,
  boardTrashedAtLabel, boardRowKeyAction,
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
});

test('close summary lists what closes together and offers 저장 후 닫기 first', () => {
  const summary = boardCloseSummary({ dirtyCount: 3, viewCount: 5, terminalCount: 2, runningCount: 1 });
  assert.equal(summary.copy, '저장하지 않은 변경 3건이 있습니다.');
  assert.equal(summary.closing, '같이 닫히는 것: 화면 5개 · 터미널 2개(실행 종료) · 진행 중인 일 1건(중단)');
  assert.deepEqual(summary.actions.map(action => [action.action, action.label, action.kind]), [
    ['save', '저장 후 닫기', 'primary'], ['discard', '저장하지 않고 닫기', 'ghost'], ['continue', '취소', 'ghost'],
  ]);
  assert.equal(summary.defaultAction, 'save');
  const quiet = boardCloseSummary({ dirtyCount: 1, viewCount: 1 });
  assert.equal(quiet.copy, '저장하지 않은 변경이 있습니다.');
  assert.equal(quiet.closing, '같이 닫히는 것: 화면 1개');
  assert.equal(boardCloseSummary({}).closing, '같이 닫히는 화면이 없습니다.');
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
    boardNotice: message => notices.push(message), syncViewportAgendaRail: () => { rails += 1; },
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
