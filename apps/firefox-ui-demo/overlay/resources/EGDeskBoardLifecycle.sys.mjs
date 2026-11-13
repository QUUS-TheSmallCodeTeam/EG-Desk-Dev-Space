// Saved Board lifecycle: 휴지통 (trash) · 복구 · 완전히 삭제 · 이름 변경 · 닫기/저장 안내.
//
// The Board list is the preference store the screen keeps:
//   { version: 2, activeAgendaId, agendas: { [boardId]: snapshot }, meta: { [boardId]: record } }.
// The bridge's Desk store has no delete route, so deleting is a mark on the
// record (`meta[boardId].deletedAt`, a time) — the saved Board itself stays
// until the person deletes it for good. A record without the mark is a normal
// Board, so lists written before this module read unchanged.
//
// Everything here is pure: stores go in and new stores come out, and the copy
// functions return the Korean words the screen shows.

const TITLE_LIMIT = 80;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const cleanTitle = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT).trim();
const titleOr = (value, fallback = 'Board') => cleanTitle(value) || fallback;
const wholeCount = value => Math.max(0, Math.round(Number(value) || 0));
const snapshotCount = snapshot => (Array.isArray(snapshot?.cards) ? snapshot.cards.length : 0)
  + (Array.isArray(snapshot?.shapes) ? snapshot.shapes.length : 0);
const boardIds = store => Array.from(new Set([
  ...Object.keys(isObject(store?.meta) ? store.meta : {}),
  ...Object.keys(isObject(store?.agendas) ? store.agendas : {}),
].filter(Boolean)));
const titleIn = (store, id) => titleOr(store?.agendas?.[id]?.agenda?.title || store?.meta?.[id]?.title);
const copyStore = store => ({
  ...(isObject(store) ? store : {}),
  agendas: { ...(isObject(store?.agendas) ? store.agendas : {}) },
  meta: { ...(isObject(store?.meta) ? store.meta : {}) },
});

export function isBoardTrashed(meta) {
  return Number.isFinite(meta?.deletedAt) && meta.deletedAt > 0;
}

/** Ids of the Boards the lists show (everything not in the trash). */
export function liveBoardIds(store) {
  return boardIds(store).filter(id => !isBoardTrashed(store.meta?.[id]));
}

/** Trash rows, newest first. */
export function trashedBoardEntries(store) {
  return boardIds(store).filter(id => isBoardTrashed(store.meta?.[id])).map(id => ({
    id,
    title: titleIn(store, id),
    count: snapshotCount(store.agendas?.[id]),
    saved: !!store.agendas?.[id],
    deletedAt: store.meta[id].deletedAt,
  })).sort((a, b) => b.deletedAt - a.deletedAt);
}

export function trashBoard(store, boardId, now = Date.now()) {
  if (!boardId || !boardIds(store).includes(boardId) || isBoardTrashed(store.meta?.[boardId])) return { ok: false, store };
  const next = copyStore(store);
  next.meta[boardId] = { ...(next.meta[boardId] || {}), id: boardId, title: titleIn(store, boardId), deletedAt: now };
  if (next.activeAgendaId === boardId) next.activeAgendaId = null;
  return { ok: true, store: next, title: titleIn(store, boardId) };
}

export function uniqueBoardTitle(title, taken = []) {
  const base = titleOr(title);
  const used = new Set((Array.isArray(taken) ? taken : []).map(cleanTitle));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

// A restored Board comes back closed and saved, under its own name unless a
// live Board took that name meanwhile. Nothing reopens or runs on its own.
export function restoreBoard(store, boardId, now = Date.now()) {
  if (!boardId || !isBoardTrashed(store?.meta?.[boardId])) return { ok: false, store };
  const original = titleIn(store, boardId);
  const taken = new Set(liveBoardIds(store).map(id => titleIn(store, id)));
  let title = original;
  if (taken.has(title)) {
    title = `${original} (복구)`;
    for (let n = 2; taken.has(title); n += 1) title = `${original} (복구 ${n})`;
  }
  const next = copyStore(store);
  const { deletedAt: _deletedAt, ...meta } = next.meta[boardId];
  next.meta[boardId] = { ...meta, id: boardId, title, closedAt: now, restoredAt: now, updatedAt: Math.max(meta.updatedAt || 0, now) };
  const snapshot = next.agendas[boardId];
  if (snapshot?.agenda && snapshot.agenda.title !== title) next.agendas[boardId] = { ...snapshot, agenda: { ...snapshot.agenda, title } };
  return { ok: true, store: next, title, renamed: title !== original };
}

/** Deleting for good is only offered from the trash. */
export function purgeBoard(store, boardId) {
  if (!boardId || !isBoardTrashed(store?.meta?.[boardId])) return { ok: false, store };
  const next = copyStore(store);
  const title = titleIn(store, boardId);
  delete next.agendas[boardId];
  delete next.meta[boardId];
  if (next.activeAgendaId === boardId) next.activeAgendaId = null;
  return { ok: true, store: next, title };
}

export function boardTrashedAtLabel(deletedAt, now = Date.now()) {
  if (!Number.isFinite(deletedAt) || deletedAt <= 0) return '삭제됨';
  const minutes = Math.floor(Math.max(0, now - deletedAt) / 60_000);
  if (minutes < 1) return '방금 삭제';
  if (minutes < 60) return `${minutes}분 전 삭제`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}시간 전 삭제`;
  return `${Math.floor(minutes / (60 * 24))}일 전 삭제`;
}

// What the delete confirmation says. A Board that is open on the Desk is
// closed first (its own close confirmation covers unsaved changes and
// terminals), so the confirmation only explains that.
export function boardDeletePrompt({ title, count, open = false } = {}) {
  const name = titleOr(title);
  if (open) {
    return {
      canDelete: false,
      heading: `'${name}' Board가 열려 있습니다`,
      lines: ['이 Board는 지금 Desk에 열려 있습니다.', '먼저 Board를 닫은 뒤 삭제해 주세요. 닫아도 저장된 Board는 목록에 남습니다.'],
      confirmLabel: null,
      cancelLabel: '확인',
    };
  }
  return {
    canDelete: true,
    heading: `'${name}' Board를 휴지통으로 옮길까요?`,
    lines: [
      `저장된 구성(항목 ${wholeCount(count)}개)이 Board 목록에서 빠집니다.`,
      'Board 목록 아래 휴지통에서 다시 복구할 수 있습니다.',
      '원본 파일과 열려 있는 다른 화면은 그대로 둡니다.',
    ],
    confirmLabel: '휴지통으로 이동',
    cancelLabel: '취소',
  };
}

export function boardPurgePrompt({ title, count, keepsHistory = false } = {}) {
  const name = titleOr(title);
  return {
    heading: `'${name}' Board를 완전히 삭제할까요?`,
    lines: [
      `저장된 구성(항목 ${wholeCount(count)}개)이 이 PC의 Board 목록에서 지워지고 되돌릴 수 없습니다.`,
      '원본 파일은 그대로 둡니다.',
      ...(keepsHistory ? ['이미 남겨 둔 버전 기록은 이 삭제로 지워지지 않습니다.'] : []),
    ],
    confirmLabel: '완전히 삭제',
    cancelLabel: '취소',
  };
}

const savedParts = (count, shapeCount) => [
  wholeCount(count) ? `화면 ${wholeCount(count)}개` : null,
  wholeCount(shapeCount) ? `도형 ${wholeCount(shapeCount)}개` : null,
].filter(Boolean).join(' · ');

export function boardSavedNotice({ title, count, shapeCount } = {}) {
  const name = cleanTitle(title);
  const parts = savedParts(count, shapeCount);
  if (!parts) return name ? `'${name}' Board 저장됨 · 화면 없음` : '빈 Board로 저장됨';
  return `${name ? `'${name}' ` : ''}Board에 ${parts} 저장됨`;
}

// 다른 이름으로 저장: the arrangement on screen is saved as a new Board with
// its own name. The open Board, its saved copy and the active Board stay as
// they are; the new Board waits closed in the Board list.
export function liveBoardTitles(store) {
  return liveBoardIds(store).map(id => titleIn(store, id));
}

export function boardSaveAsName(input, taken = []) {
  const title = cleanTitle(input);
  if (!title) return { ok: false, title: '', message: 'Board 이름을 입력해 주세요.' };
  if ((Array.isArray(taken) ? taken : []).map(cleanTitle).includes(title)) {
    return { ok: false, title, message: `'${title}' 이름의 Board가 이미 있습니다. 다른 이름을 입력해 주세요.` };
  }
  return { ok: true, title };
}

export function boardSaveAsPrompt({ title, viewCount, taken = [] } = {}) {
  const name = titleOr(title);
  return {
    heading: `'${name}' Board를 다른 이름으로 저장`,
    suggested: uniqueBoardTitle(`${name} 사본`, taken),
    lines: [
      `지금 화면에 있는 구성(화면 ${wholeCount(viewCount)}개)을 새 Board로 저장합니다.`,
      `열려 있는 '${name}' Board와 저장된 내용은 바뀌지 않습니다.`,
    ],
    confirmLabel: '저장',
    cancelLabel: '취소',
  };
}

export function saveBoardAs(store, { snapshot, newId, title, sourceId, now = Date.now() } = {}) {
  if (!newId || !isObject(snapshot) || boardIds(store).includes(newId)) return { ok: false, store, message: 'Board를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  const name = boardSaveAsName(title, liveBoardTitles(store));
  if (!name.ok) return { ok: false, store, message: name.message };
  const saved = JSON.parse(JSON.stringify(snapshot));
  saved.savedAt = now;
  saved.agenda = { ...(isObject(saved.agenda) ? saved.agenda : {}), id: newId, title: name.title };
  if (isObject(saved.desk)) saved.desk = { ...saved.desk, activeAgendaId: newId };
  const next = copyStore(store);
  next.agendas[newId] = saved;
  next.meta[newId] = { id: newId, title: name.title, createdAt: now, updatedAt: now, lastOpenedAt: null, closedAt: now, duplicatedFrom: sourceId || null };
  return {
    ok: true, store: next, id: newId, title: name.title, snapshot: saved,
    count: Array.isArray(saved.cards) ? saved.cards.length : 0, shapeCount: Array.isArray(saved.shapes) ? saved.shapes.length : 0,
  };
}

export function boardSavedAsNotice({ title, count, shapeCount } = {}) {
  const parts = savedParts(count, shapeCount);
  return `'${titleOr(title)}' Board로 ${parts ? `${parts} 저장됨` : '저장됨(화면 없음)'} · Board 목록에서 열 수 있습니다.`;
}

// The close confirmation: saving is the default, closing without saving is a
// plain second choice, and what closes together is said in one line. Actions
// come in the order the buttons sit (the default last, on the right).
export function boardCloseSummary({ dirtyCount, viewCount, terminalCount } = {}) {
  const dirty = wholeCount(dirtyCount), views = wholeCount(viewCount), terminals = Math.min(views, wholeCount(terminalCount));
  const parts = [
    views ? `화면 ${views}개` : null,
    terminals ? `그중 터미널 ${terminals}개(실행 중인 명령도 종료)` : null,
  ].filter(Boolean);
  return {
    copy: dirty > 1 ? `저장하지 않은 변경 ${dirty}건이 있습니다.` : '저장하지 않은 변경이 있습니다.',
    closing: parts.length ? `같이 닫히는 것: ${parts.join(' · ')}` : '같이 닫히는 화면이 없습니다.',
    kept: '저장된 Board는 Board 목록에 남아 다시 열 수 있습니다.',
    actions: [
      { action: 'continue', label: '취소', kind: 'ghost', title: '닫지 않고 계속 작업합니다 (Esc)' },
      { action: 'discard', label: '저장하지 않고 닫기', kind: 'ghost', title: '마지막으로 저장한 상태를 그대로 두고 Board를 닫습니다' },
      { action: 'save', label: '저장 후 닫기', kind: 'primary', title: '변경을 저장하고 Board를 닫습니다' },
    ],
    defaultAction: 'save',
  };
}

export function boardRenameResult(currentTitle, input) {
  const title = cleanTitle(input);
  if (!title) return { ok: false, changed: false, title: titleOr(currentTitle), message: 'Board 이름을 입력해 주세요.' };
  return { ok: true, changed: title !== cleanTitle(currentTitle), title };
}

// Keys on a Board list row. While a name is being edited the row leaves every
// key to the field.
export function boardRowKeyAction(ev, { editing = false } = {}) {
  if (editing || !ev || ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) return 'actions';
  if (ev.shiftKey) return null;
  if (ev.key === 'F2') return 'rename';
  if (ev.key === 'Delete') return 'delete';
  return null;
}
