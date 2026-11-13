import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  boardRailRows, boardRailSignature, railFocusIndex, boardListEmptyState, emptyCanvasHint,
} from '../overlay/resources/EGDeskLeftRail.sys.mjs';

const entry = (id, title, extra = {}) => ({ id, title, saved: true, current: false, closed: false, dirty: false, count: 0, ...extra });

// ------------------------------------------------------------ saved Board rows

test('rail rows: only saved Boards appear, in a name order that opening a Board does not reshuffle', () => {
  const entries = [
    entry('b', '회의 준비', { current: true, lastOpenedAt: 30 }),
    entry('draft', '초안', { saved: false }),
    entry('a', '견적 검토', { lastOpenedAt: 10 }),
    entry('c', 'Board 10'), entry('d', 'Board 2'),
  ];
  const rows = boardRailRows(entries);
  assert.deepEqual(rows.map(row => row.label), ['견적 검토', '회의 준비', 'Board 2', 'Board 10']);
  // The list the Board panel sorts 'current first' gives the same rail order.
  assert.deepEqual(boardRailRows([...entries].reverse()).map(row => row.id), ['a', 'b', 'd', 'c']);
});

test('rail rows: the Board being worked in is current, other open Boards are marked open, the rest only open on click', () => {
  const rows = boardRailRows([
    entry('a', '견적 검토', { count: 3 }), entry('b', '회의 준비', { count: 0, closed: true }), entry('c', '자료 정리', { count: 1, dirty: true }),
  ], { openBoardIds: ['a', 'c'], activeBoardId: 'c' });
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.deepEqual({ current: byId.a.current, open: byId.a.open }, { current: false, open: true });
  assert.deepEqual({ current: byId.b.current, open: byId.b.open }, { current: false, open: false });
  assert.deepEqual({ current: byId.c.current, open: byId.c.open }, { current: true, open: true });
  assert.equal(byId.a.ariaLabel, 'Board 견적 검토로 이동');
  assert.equal(byId.b.ariaLabel, 'Board 회의 준비 열기');
  assert.equal(byId.c.ariaLabel, 'Board 자료 정리, 지금 작업 중');
  assert.equal(byId.a.tooltip, '견적 검토 · Canvas에 열려 있음 · 항목 3개');
  assert.equal(byId.b.tooltip, '회의 준비 · 항목 0개');
  assert.equal(byId.c.tooltip, '자료 정리 · 지금 작업 중 · 저장 안 됨 · 항목 1개');
});

test('rail rows: an active Board that is not open on the Canvas is not shown as current', () => {
  const [row] = boardRailRows([entry('a', '견적 검토', { current: true })], { openBoardIds: [], activeBoardId: 'a' });
  assert.deepEqual({ current: row.current, open: row.open }, { current: false, open: false });
});

test('rail rows: blank or missing names fall back to Board, and bad input gives an empty rail', () => {
  assert.deepEqual(boardRailRows([entry('a', '   '), entry('b', null)]).map(row => row.label), ['Board', 'Board']);
  assert.deepEqual(boardRailRows(null), []);
  assert.deepEqual(boardRailRows([null, { title: 'no id', saved: true }]), []);
});

test('rail signature changes only when what the rail shows changes', () => {
  const base = boardRailRows([entry('a', '견적 검토', { count: 2 })], { openBoardIds: ['a'], activeBoardId: 'a' });
  const same = boardRailRows([entry('a', '견적 검토', { count: 2, lastOpenedAt: 99 })], { openBoardIds: ['a'], activeBoardId: 'a' });
  assert.equal(boardRailSignature(base), boardRailSignature(same));
  for (const changed of [
    boardRailRows([entry('a', '견적 검토 2', { count: 2 })], { openBoardIds: ['a'], activeBoardId: 'a' }),
    boardRailRows([entry('a', '견적 검토', { count: 3 })], { openBoardIds: ['a'], activeBoardId: 'a' }),
    boardRailRows([entry('a', '견적 검토', { count: 2 })], { openBoardIds: ['a'] }),
    boardRailRows([entry('a', '견적 검토', { count: 2 })]),
    [],
  ]) assert.notEqual(boardRailSignature(base), boardRailSignature(changed));
});

// ------------------------------------------------------------------- keyboard

test('rail keyboard: arrows step and stop at the ends, Home/End jump, other keys are left alone', () => {
  assert.equal(railFocusIndex({ key: 'ArrowDown', index: 0, count: 4 }), 1);
  assert.equal(railFocusIndex({ key: 'ArrowDown', index: 3, count: 4 }), 3);
  assert.equal(railFocusIndex({ key: 'ArrowUp', index: 2, count: 4 }), 1);
  assert.equal(railFocusIndex({ key: 'ArrowUp', index: 0, count: 4 }), 0);
  assert.equal(railFocusIndex({ key: 'Home', index: 2, count: 4 }), 0);
  assert.equal(railFocusIndex({ key: 'End', index: 0, count: 4 }), 3);
  for (const key of ['Enter', ' ', 'Tab', 'ArrowLeft', 'a']) assert.equal(railFocusIndex({ key, index: 1, count: 4 }), null);
  assert.equal(railFocusIndex({ key: 'ArrowDown', index: -1, count: 4 }), null);
  assert.equal(railFocusIndex({ key: 'ArrowDown', index: 0, count: 0 }), null);
});

// ------------------------------------------------------- Board list empty state

test('Board list: with nothing saved and no search it says so and offers 새 Board and 가져오기', () => {
  assert.deepEqual(boardListEmptyState({ total: 0, query: '', filter: 'all', canImport: true }),
    { kind: 'none-saved', message: '저장한 Board가 없습니다', actions: ['new', 'import'] });
  assert.deepEqual(boardListEmptyState({ total: 0, query: '  ', filter: 'recent', canImport: false }),
    { kind: 'none-saved', message: '저장한 Board가 없습니다', actions: ['new'] });
});

test('Board list: a search or a filter with no match keeps its own words and offers no start buttons', () => {
  assert.deepEqual(boardListEmptyState({ total: 0, query: '견적', filter: 'all', canImport: true }),
    { kind: 'no-match', message: '검색 결과가 없습니다.', actions: [] });
  assert.deepEqual(boardListEmptyState({ total: 3, query: '견적', filter: 'closed', canImport: true }),
    { kind: 'no-match', message: '검색 결과가 없습니다.', actions: [] });
  assert.deepEqual(boardListEmptyState({ total: 3, query: '', filter: 'closed', canImport: true }),
    { kind: 'filter-empty', message: '닫은 Board가 없습니다', actions: [] });
  assert.deepEqual(boardListEmptyState({ total: 3, query: '', filter: 'recent', canImport: true }),
    { kind: 'filter-empty', message: '최근에 쓴 Board가 없습니다', actions: [] });
});

// ----------------------------------------------------------- empty Canvas hint

test('empty Canvas hint: shows only while the Canvas holds nothing, and comes back when it empties again', () => {
  assert.equal(emptyCanvasHint({ cards: 0, shapes: 0, boards: 0 }).visible, true);
  assert.equal(emptyCanvasHint().visible, true);
  for (const counts of [{ cards: 1 }, { shapes: 1 }, { boards: 1 }, { cards: 2, shapes: 3 }]) {
    assert.equal(emptyCanvasHint(counts).visible, false, JSON.stringify(counts));
  }
});

test('empty Canvas hint: three equal cues point up, left and down — never right — in Korean, without a call to action', () => {
  const { cues } = emptyCanvasHint({ savedBoards: 2 });
  assert.deepEqual(cues.map(cue => [cue.id, cue.direction]), [['search', 'up'], ['board', 'left'], ['dock', 'down']]);
  assert.deepEqual(cues.map(cue => cue.text), ['⌘K 검색 또는 AI에게 요청', '왼쪽에서 저장한 Board 열기', '아래 Dock에서 채팅과 창 열기']);
  for (const cue of cues) {
    assert.doesNotMatch(cue.text.replace(/Board|Dock|AI/g, ''), /[A-Za-z]{2,}/, 'only product nouns stay in English');
    assert.doesNotMatch(cue.text, /시작하|환영|클릭|눌러|오른쪽|[!]/);
    assert.doesNotMatch(cue.text, /\p{Extended_Pictographic}/u);
  }
});

test('empty Canvas hint: with no saved Board the left cue names what the rail really offers', () => {
  assert.equal(emptyCanvasHint({ savedBoards: 0 }).cues[1].text, '왼쪽 +에서 새 Board 만들기');
  assert.equal(emptyCanvasHint({ shortcut: 'Ctrl+K' }).cues[0].text, 'Ctrl+K 검색 또는 AI에게 요청');
});

// ------------------------------------------------------------------ DOM wiring

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const declaration = name => {
  const start = surfaceSource.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `${name} is declared`);
  const end = surfaceSource.indexOf('\n  }\n', start);
  return surfaceSource.slice(start, end + 4);
};
const compileFunction = (body, keys) => new Function(...keys, body);

function fakeNode(tag, props = {}, children = []) {
  const node = {
    tag, attrs: {}, dataset: {}, classList: null, children: [], parent: null, listeners: {}, hidden: false, focused: false,
    scrollHeight: 0, clientHeight: 0,
    setAttribute(key, value) { this.attrs[key] = String(value); },
    getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; },
    removeAttribute(key) { delete this.attrs[key]; },
    appendChild(child) { if (child == null) return child; child.parent = this; this.children.push(child); return child; },
    replaceChildren(...next) { this.children = []; for (const child of next) this.appendChild(child); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
    contains(other) { for (let at = other; at; at = at.parent) if (at === this) return true; return false; },
    focus() { fakeNode.focused = this; },
    prepend(child) { child.parent = this; this.children.unshift(child); },
    querySelectorAll(selector) { assert.equal(selector, 'button'); return this.all().filter(node => node.tag === 'button'); },
    get textContent() { return this.text ?? this.children.map(child => child.textContent).join(''); },
    all() { return [this, ...this.children.flatMap(child => child.all())]; },
    byClass(name) { return this.all().filter(node => (node.attrs.class || '').split(/\s+/).includes(name)); },
    click() { this.listeners.click?.({ stopPropagation() {}, preventDefault() {}, target: this }); },
  };
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'data') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.listeners[key.slice(2).toLowerCase()] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(typeof child === 'string' ? { text: child, textContent: child, all: () => [], parent: null } : child);
  return node;
}
const el = (tag, props, ...children) => fakeNode(tag, props, children.filter(child => child != null));
const LeftRail = { boardRailRows, boardRailSignature, railFocusIndex, boardListEmptyState, emptyCanvasHint };

function railHarness({ entries = [], projections = {}, activeProjectionId = null } = {}) {
  const calls = { opened: [], created: 0, files: 0, hintSyncs: 0, listToggles: 0 };
  const state = { boards: { projections, activeProjectionId }, entries };
  const nodes = {};
  const observers = [];
  const documentElement = {};
  const document = { activeElement: null, documentElement, getElementById: id => nodes[id] || null };
  class MutationObserver {
    constructor(run) { this.run = run; }
    observe(target, options) { observers.push({ run: this.run, target, options }); }
  }
  // The Board list of the screen: toggling adds or removes its panel.
  const toggleAgendaSwitcher = () => {
    calls.listToggles += 1;
    if (nodes['egd-agenda-switcher']) delete nodes['egd-agenda-switcher'];
    else nodes['egd-agenda-switcher'] = {};
  };
  const source = ['boardRailChip', 'renderBoardRail', 'syncBoardRail', 'moveBoardRailFocus', 'syncDeskRailButton', 'deskRailButton', 'buildPresetBag']
    .map(declaration).join('\n');
  const api = compileFunction(`let boardRailSignatureShown = null;\nlet deskRailListOpenAtPress = false;\n${source}\nreturn { buildPresetBag, syncBoardRail, moveBoardRailFocus };`,
    ['el', 'deskIcon', 'document', 'state', 'LeftRail', 'agendaListEntries', 'switchAgenda', 'createNewAgenda', 'openFileFromUserAction', 'syncEmptyCanvasHint',
      'toggleAgendaSwitcher', 'MutationObserver'])(
    el, name => fakeNode('svg', { class: 'egd-ui-icon', data: { icon: name } }), document, state, LeftRail,
    () => state.entries, id => calls.opened.push(id), () => { calls.created += 1; }, () => { calls.files += 1; }, () => { calls.hintSyncs += 1; },
    toggleAgendaSwitcher, MutationObserver);
  const bag = api.buildPresetBag();
  nodes['egd-preset-bag'] = bag;
  nodes['egd-bag-boards'] = bag.all().find(node => node.attrs.id === 'egd-bag-boards');
  return { ...api, bag, state, calls, document, nodes, observers, documentElement };
}

test('left rail: the fake presets are gone and the rail lists the saved Boards under Desk and 파일', () => {
  assert.doesNotMatch(surfaceSource, /const PRESETS = \[/);
  assert.doesNotMatch(surfaceSource, /새 프리셋|React 개발|리서치 모드|글쓰기/);
  const h = railHarness({
    entries: [entry('b', '회의 준비'), entry('a', '견적 검토', { count: 2 })],
    projections: { p1: { id: 'p1', boardId: 'a' } }, activeProjectionId: 'p1',
  });
  assert.equal(h.bag.attrs.role, 'navigation');
  assert.equal(h.bag.byClass('egd-bag-file').length, 1);
  const chips = h.bag.byClass('egd-bag-board');
  assert.deepEqual(chips.map(chip => chip.textContent), ['견적 검토', '회의 준비']);
  assert.deepEqual(chips.map(chip => chip.tag), ['button', 'button']);
  assert.equal(chips[0].attrs['aria-current'], 'true');
  assert.match(chips[0].attrs.class, /\begd-bag-chip-active\b/);
  assert.equal(chips[0].dataset.open, 'true');
  assert.equal(chips[1].attrs['aria-current'], undefined);
  assert.doesNotMatch(chips[1].attrs.class, /egd-bag-chip-active/);
  assert.equal(chips[1].attrs['aria-label'], 'Board 회의 준비 열기');
  assert.equal(chips[1].attrs.title, '회의 준비 · 항목 0개');
});

test('left rail: a Board row opens that Board through the existing open action, + starts a new Board', () => {
  const h = railHarness({ entries: [entry('a', '견적 검토'), entry('b', '회의 준비')] });
  h.bag.byClass('egd-bag-board')[1].click();
  assert.deepEqual(h.calls.opened, ['b']);
  const add = h.bag.byClass('egd-bag-add');
  assert.equal(add.length, 1);
  assert.equal(add[0].attrs['aria-label'], '새 Board');
  assert.equal(add[0].attrs.title, '새 Board');
  add[0].click();
  assert.equal(h.calls.created, 1);
  h.bag.byClass('egd-bag-file')[0].click();
  assert.equal(h.calls.files, 1);
});

test('left rail: with no saved Board only Desk, 파일 and + remain, and the list takes no room', () => {
  const h = railHarness();
  assert.equal(h.bag.byClass('egd-bag-board').length, 0);
  assert.equal(h.bag.byClass('egd-bag-list')[0].hidden, true);
  assert.equal(h.bag.byClass('egd-bag-file').length, 1);
  assert.equal(h.bag.byClass('egd-bag-add').length, 1);
});

test('left rail: a sync redraws only when the rows changed and keeps the keyboard focus on the same Board', () => {
  const h = railHarness({ entries: [entry('a', '견적 검토'), entry('b', '회의 준비')] });
  const before = h.bag.byClass('egd-bag-board');
  const hintSyncs = h.calls.hintSyncs;
  assert.equal(h.syncBoardRail(), false, 'nothing changed');
  assert.equal(h.bag.byClass('egd-bag-board')[0], before[0], 'the same nodes stay');
  assert.equal(h.calls.hintSyncs, hintSyncs);
  h.state.entries = [...h.state.entries, entry('c', '자료 정리')];
  fakeNode.focused = null;
  const list = h.bag.byClass('egd-bag-list')[0];
  h.document.activeElement = before[1];
  assert.equal(h.syncBoardRail(), true);
  assert.deepEqual(h.bag.byClass('egd-bag-board').map(chip => chip.dataset.boardId), ['a', 'c', 'b']);
  assert.equal(fakeNode.focused?.dataset.boardId, 'b', 'focus returns to the Board that had it');
  assert.equal(list.hidden, false);
  assert.equal(h.calls.hintSyncs, hintSyncs + 1, 'the empty Canvas cue follows what the rail offers');
  h.document.activeElement = null;
  h.state.boards.projections = { p9: { id: 'p9', boardId: 'c' } };
  h.state.boards.activeProjectionId = 'p9';
  assert.equal(h.syncBoardRail(), true);
  assert.equal(h.bag.byClass('egd-bag-board')[1].attrs['aria-current'], 'true');
});

test('left rail: ↑/↓/Home/End move between rail items without leaving the rail', () => {
  const h = railHarness({ entries: [entry('a', '견적 검토'), entry('b', '회의 준비')] });
  const items = h.bag.all().filter(node => node.tag === 'button');
  assert.deepEqual(items.map(node => node.attrs.class.split(' ').pop()), ['egd-bag-header', 'egd-bag-file', 'egd-bag-board', 'egd-bag-board', 'egd-bag-add']);
  const press = (key, target) => {
    let prevented = false;
    h.moveBoardRailFocus({ key, target, preventDefault() { prevented = true; } });
    return prevented;
  };
  fakeNode.focused = null;
  assert.equal(press('ArrowDown', items[0]), true);
  assert.equal(fakeNode.focused, items[1]);
  assert.equal(press('ArrowDown', items[1]), true);
  assert.equal(fakeNode.focused, items[2]);
  assert.equal(press('End', items[2]), true);
  assert.equal(fakeNode.focused, items[4]);
  assert.equal(press('ArrowUp', items[4]), true);
  assert.equal(fakeNode.focused, items[3]);
  assert.equal(press('Home', items[3]), true);
  assert.equal(fakeNode.focused, items[0]);
  fakeNode.focused = null;
  assert.equal(press('Enter', items[1]), false, 'Enter keeps the native button activation');
  assert.equal(fakeNode.focused, null);
  for (const modified of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }]) {
    let prevented = false;
    h.moveBoardRailFocus({ key: 'ArrowDown', target: items[0], ...modified, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
  }
});

test('left rail: Desk is a button that opens the existing Board list and says whether the list is open', () => {
  const h = railHarness({ entries: [entry('a', '견적 검토')] });
  const desk = h.bag.byClass('egd-bag-header');
  assert.equal(desk.length, 1);
  assert.equal(desk[0].tag, 'button');
  assert.equal(desk[0].attrs.type, 'button');
  assert.equal(desk[0].textContent, 'Desk');
  assert.equal(desk[0].attrs.title, 'Board 목록');
  assert.equal(desk[0].attrs['aria-label'], 'Desk · Board 목록');
  assert.equal(desk[0].attrs['aria-expanded'], 'false');
  desk[0].click();
  assert.equal(h.calls.listToggles, 1);
  assert.equal(desk[0].attrs['aria-expanded'], 'true');
  desk[0].click();
  assert.equal(h.calls.listToggles, 2, 'a keyboard press on the open list closes it');
  assert.equal(desk[0].attrs['aria-expanded'], 'false');
});

test('left rail: a pointer press on Desk while the list is open only closes it, and the list closing elsewhere is followed', () => {
  const h = railHarness();
  const desk = h.bag.byClass('egd-bag-header')[0];
  desk.click();
  assert.equal(desk.attrs['aria-expanded'], 'true');
  // The list closes itself on the press outside it; the click that follows must not open it again.
  desk.listeners.pointerdown();
  delete h.nodes['egd-agenda-switcher'];
  desk.click();
  assert.equal(h.calls.listToggles, 1);
  assert.equal(desk.attrs['aria-expanded'], 'false');
  desk.listeners.pointerdown();
  desk.click();
  assert.equal(h.calls.listToggles, 2, 'the next press opens it');
  assert.equal(desk.attrs['aria-expanded'], 'true');
  // Esc, a press elsewhere or choosing a Board removes the panel without the rail being touched.
  assert.equal(h.observers.length, 1);
  assert.equal(h.observers[0].target, h.documentElement);
  assert.deepEqual(h.observers[0].options, { childList: true });
  delete h.nodes['egd-agenda-switcher'];
  h.observers[0].run();
  assert.equal(desk.attrs['aria-expanded'], 'false');
});

const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`))?.[1] || '';
};

test('left rail CSS: long lists scroll inside the rail, + stays in view, long names are cut with the full name in the tooltip', () => {
  assert.match(rule('.egd-bag-list'), /overflow-y: auto;/);
  assert.match(rule('.egd-bag-list'), /min-height: 0;/);
  assert.match(rule('.egd-bag-list[hidden]'), /display: none;/);
  assert.match(rule('.egd-bag-add'), /flex: 0 0 auto;/);
  assert.match(rule('.egd-bag-board .egd-bag-label'), /-webkit-line-clamp: 2;/);
  assert.match(rule('.egd-bag-board .egd-bag-label'), /overflow: hidden;/);
  assert.match(rule('.egd-bag-chip:active'), /background: var\(--egd-/);
  // The shared `.egd-edge button` reset (one class + one tag) clears fill and padding of any
  // single-class rule, so the pressed look and the Board row padding carry two classes.
  assert.match(rule('.egd-edge button'), /background: transparent;/);
  assert.match(rule('.egd-bag-chip.egd-bag-chip-active'), /background: var\(--egd-primary-container\);/);
  assert.match(rule('.egd-bag-chip.egd-bag-board'), /padding: 6px 1px 5px;/);
  assert.match(rule('button.egd-bag-header'), /color: var\(--egd-on-surface\);/);
  assert.match(rule('button.egd-bag-header.egd-bag-header-muted'), /color: var\(--egd-on-surface-variant\);/);
  assert.match(css, /\n\.egd-bag-header:hover,\n\.egd-bag-header\[aria-expanded="true"\] \{ background: var\(--egd-hover\); \}/);
  assert.match(rule('.egd-bag-header:active'), /background: var\(--egd-/);
  assert.match(css, /\n\.egd-bag-header:focus-visible,\n\.egd-bag-chip:focus-visible,\n\.egd-bag-add:focus-visible \{ outline: var\(--egd-focus-outline\);/);
  assert.match(rule('.egd-bag-board[data-open="true"]::after'), /background: var\(--egd-/);
});

function hintHarness({ counts = { cards: 0, shapes: 0, boards: 0 }, saved = 0 } = {}) {
  const live = { ...counts, saved, storeReads: 0 };
  const layerObservers = [], timers = [];
  const layer = { id: 'egd-canvas-layer' };
  const viewport = fakeNode('div', { id: 'egd-canvas-viewport' });
  const document = {
    getElementById: id => viewport.all().find(node => node.attrs?.id === id) || null,
    querySelectorAll: selector => ({ length: { '.egd-canvas-card': live.cards, '.egd-canvas-shape': live.shapes, '.egd-board-region': live.boards }[selector] }),
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target, options) { layerObservers.push({ target, options, callback: this.callback }); }
  }
  const source = ['emptyCanvasHintState', 'renderEmptyCanvasHint', 'syncEmptyCanvasHint', 'installEmptyCanvasHint'].map(declaration).join('\n');
  const api = compileFunction(`${source}\nreturn { syncEmptyCanvasHint, installEmptyCanvasHint };`,
    ['el', 'svgEl', 'document', 'window', 'LeftRail', 'agendaListEntries', 'MutationObserver', 'EMPTY_CANVAS_HINT_SETTLE_MS'])(
    el, (tag, props, ...children) => fakeNode(tag, props, children), document, { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } },
    LeftRail, () => { live.storeReads += 1; return Array.from({ length: live.saved }, (_, index) => entry(`b${index}`, `Board ${index}`)); },
    MutationObserver, 300);
  api.installEmptyCanvasHint(viewport, layer);
  const hint = viewport.all().find(node => node.attrs.id === 'egd-canvas-hint');
  return { ...api, viewport, layer, hint, live, layerObservers, timers };
}

test('empty Canvas hint DOM: one decorative layer with three cues, shown on an empty Canvas', () => {
  const h = hintHarness({ saved: 1 });
  assert.ok(h.hint, 'the hint layer is mounted in the Canvas viewport');
  assert.equal(h.hint.parent, h.viewport);
  assert.equal(h.viewport.children[0], h.hint, 'under the Canvas layer, so every View covers it');
  assert.equal(h.hint.attrs['aria-hidden'], 'true', 'decoration only: the Edges themselves carry the accessible names');
  // The first look waits for a restored Desk to mount its Views, then fades in.
  assert.equal(h.hint.dataset.visible, undefined);
  assert.deepEqual(h.timers.map(timer => timer.ms), [300]);
  h.timers[0].fn();
  assert.equal(h.hint.dataset.visible, 'true');
  const cues = h.hint.byClass('egd-canvas-hint-cue');
  assert.deepEqual(cues.map(cue => cue.dataset.cue), ['search', 'board', 'dock']);
  assert.deepEqual(cues.map(cue => cue.textContent), ['⌘K 검색 또는 AI에게 요청', '왼쪽에서 저장한 Board 열기', '아래 Dock에서 채팅과 창 열기']);
  assert.equal(h.hint.all().filter(node => node.tag === 'button' || node.tag === 'a' || node.listeners?.click).length, 0, 'nothing in it can be pressed');
  assert.equal(h.hint.all().filter(node => node.tag === 'svg').length, 3, 'each cue carries its direction mark');
});

test('empty Canvas hint DOM: the first View hides it, an emptied Canvas brings it back, and it follows the Canvas itself', () => {
  const h = hintHarness();
  assert.equal(h.layerObservers.length, 1);
  assert.equal(h.layerObservers[0].target, h.layer);
  assert.deepEqual(h.layerObservers[0].options, { childList: true });
  h.layerObservers[0].callback();
  assert.equal(h.hint.dataset.visible, 'true');
  assert.equal(h.hint.byClass('egd-canvas-hint-cue')[1].textContent, '왼쪽 +에서 새 Board 만들기');
  h.live.cards = 1;
  const reads = h.live.storeReads;
  h.layerObservers[0].callback();
  assert.equal(h.hint.dataset.visible, 'false');
  assert.equal(h.live.storeReads, reads, 'a Canvas with Views never reads the saved Boards for the hint');
  assert.equal(h.hint.byClass('egd-canvas-hint-cue').length, 3, 'the cues stay in place while they fade out');
  h.live.cards = 0; h.live.boards = 1;
  h.layerObservers[0].callback();
  assert.equal(h.hint.dataset.visible, 'false', 'an open Board region is not an empty Canvas');
  h.live.boards = 0;
  h.live.cards = 0; h.live.shapes = 1;
  h.layerObservers[0].callback();
  assert.equal(h.hint.dataset.visible, 'false');
  h.live.shapes = 0; h.live.saved = 2;
  h.layerObservers[0].callback();
  assert.equal(h.hint.dataset.visible, 'true');
  assert.equal(h.hint.byClass('egd-canvas-hint-cue')[1].textContent, '왼쪽에서 저장한 Board 열기', 'the left cue follows what the rail offers now');
});

test('empty Canvas hint CSS: pencil-light, unclickable, 400ms fade that is instant under reduced motion', () => {
  const base = rule('#egd-canvas-hint');
  assert.match(base, /pointer-events: none;/);
  assert.match(base, /opacity: 0;/);
  assert.match(base, /transition: opacity 400ms/);
  assert.match(base, /color: var\(--egd-on-surface-variant\);/);
  assert.match(base, /font: 400 12px\/[\d.]+ var\(--egd-font\);/);
  assert.doesNotMatch(base, /background|border|box-shadow/);
  assert.match(rule('#egd-canvas-hint[data-visible="true"]'), /opacity: \.4;/);
  // The Desk's shared reduced-motion rule reaches every egd- id, the hint included.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\[id\^="egd-"\], \[id\^="egd-"\] \*,[^{]*\{\s*transition: none !important;/);
  assert.doesNotMatch(css, /#egd-canvas-hint[^{]*\{[^}]*animation/);
  // Hidden with the rest of the Desk chrome while a Browser takes the whole screen.
  assert.match(css, /:root\.egd-initial-browser-focus #egd-canvas-hint,\n:root\.egd-browser-fullscreen-active #egd-canvas-hint \{ display: none; \}/);
});

test('Board list panel: the empty list uses the empty-state words and wires 새 Board and 가져오기 to the existing actions', () => {
  const calls = { created: 0, imported: 0, closed: 0 };
  const build = compileFunction(`${declaration('agendaSwitcherEmptyState')}\nreturn agendaSwitcherEmptyState;`,
    ['el', 'LeftRail', 'state', 'createNewAgenda', 'portableImportReady', 'openPortableImport', 'closeAgendaSwitcher']);
  const make = (state, total, ready = true) => build(el, LeftRail, state, () => { calls.created += 1; }, () => ready,
    () => { calls.imported += 1; }, () => { calls.closed += 1; })(total);
  const none = make({ agenda: { switcherQuery: '', switcherFilter: 'all' } }, 0);
  assert.match(none.attrs.class, /\begd-agenda-switch-empty\b/);
  assert.equal(none.dataset.kind, 'none-saved');
  assert.equal(none.byClass('egd-agenda-switch-empty-text')[0].textContent, '저장한 Board가 없습니다');
  const buttons = none.all().filter(node => node.tag === 'button');
  assert.deepEqual(buttons.map(button => button.textContent), ['새 Board', '가져오기']);
  buttons[0].click();
  assert.deepEqual(calls, { created: 1, imported: 0, closed: 0 });
  buttons[1].click();
  assert.deepEqual(calls, { created: 1, imported: 1, closed: 1 }, 'the import sheet replaces the Board list');
  assert.deepEqual(make({ agenda: { switcherQuery: '', switcherFilter: 'all' } }, 0, false).all().filter(node => node.tag === 'button').map(button => button.textContent), ['새 Board']);
  const search = make({ agenda: { switcherQuery: '견적', switcherFilter: 'all' } }, 0);
  assert.equal(search.textContent, '검색 결과가 없습니다.');
  assert.equal(search.all().filter(node => node.tag === 'button').length, 0);
  assert.equal(make({ agenda: { switcherQuery: '', switcherFilter: 'closed' } }, 2).textContent, '닫은 Board가 없습니다');
  assert.match(declaration('renderAgendaSwitcherPanel'), /\.\.\.\(rows\.length \? rows : \[agendaSwitcherEmptyState\(counts\.all\)\]\),/);
});

test('Board list panel CSS: the two starts keep a button frame above the shared edge-button reset, with hover, press and focus looks', () => {
  const start = rule('.egd-agenda-switch-empty-actions .egd-agenda-switch-action');
  assert.match(start, /border: 1px solid var\(--egd-outline\);/);
  assert.match(start, /padding: 0 9px;/);
  assert.match(start, /background: var\(--egd-surface-elevated\);/);
  assert.match(rule('.egd-agenda-switch-empty-actions .egd-agenda-switch-action-primary'), /background: var\(--egd-primary-container\);/);
  assert.match(rule('.egd-agenda-switch-empty-actions .egd-agenda-switch-action:hover'), /background: var\(--egd-hover\);/);
  assert.match(rule('.egd-agenda-switch-empty-actions .egd-agenda-switch-action:active'), /background: var\(--egd-/);
  assert.match(rule('.egd-agenda-switch-empty-actions .egd-agenda-switch-action:focus-visible'), /outline: var\(--egd-focus-outline\);/);
});
