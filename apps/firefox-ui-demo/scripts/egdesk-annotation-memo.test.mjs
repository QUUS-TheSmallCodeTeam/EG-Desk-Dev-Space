import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Annotation from '../overlay/resources/EGDeskAnnotationState.sys.mjs';
import * as Memo from '../overlay/resources/EGDeskMemoState.sys.mjs';
import { CANVAS_SHAPE_TYPES, planBoardProjection, snapshotBoardProjection, remapMemberReferences } from '../overlay/resources/EGDeskSurfaceState.sys.mjs';
import { PRIVATE_KEYS } from '../helper/egdesk-chat-store.mjs';

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const privateKeysIn = value => {
  const found = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (PRIVATE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) found.push(key);
      walk(child);
    }
  };
  walk(value);
  return found;
};

// Shape of a Browser observation: EGDeskBrowserAgentRuntimeChild snapshot.
const observation = (over = {}) => ({ documentId: 'doc-1', revision: 4, viewport: { width: 1000, height: 800, devicePixelRatio: 2 }, scroll: { x: 0, y: 200, maxY: 2000 }, ...over });

const agentSet = (over = {}) => ({
  id: 'set-1', targetCardId: 'egd-card-7', targetKind: 'browser', agendaId: 'board-a', sourceRunId: 'run-9',
  sourceMessageId: 'answer-3', createdByAgentId: 'rio', grounding: 'dom',
  source: { documentId: 'doc-1', revision: 4, viewport: { width: 1000, height: 800 }, scroll: { x: 0, y: 200 } },
  createdAt: 1000,
  items: [
    { id: 'login', type: 'box', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, label: '로그인 버튼', purpose: 'locate', confidence: 0.934, ref: 'e12' },
    { id: 'tag', type: 'label', at: { x: 0.5, y: 0.05 }, label: '여기' },
    { id: 'point', type: 'arrow', from: { x: 0.5, y: 0.06 }, to: { x: 0.25, y: 0.2 }, fromItemId: 'tag', toItemId: 'login' },
  ],
  ...over,
});

test('annotation: an Agent set normalizes to fixed keys, drops bad items and never mutates input', () => {
  const input = deepFreeze(agentSet({
    systemPrompt: 'x', secret: 'y',
    items: [
      ...agentSet().items,
      { type: 'box', rect: { x: 0, y: 0, width: 0.2, height: 0.2 }, reasoning: 'hidden', note: '  너무   작음\n글자 ' },
      { type: 'box', rect: { x: 0, y: 0, w: 0, h: 0.2 } },
      { type: 'label', at: { x: 0.1, y: 0.1 } },
      { type: 'line', from: { x: 0.1, y: 0.1 }, to: { x: 0.1, y: 0.1 } },
      { type: 'polygon', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { id: 'login', type: 'ellipse', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { type: 'arrow', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, fromItemId: 'nowhere', toItemId: 'login' },
    ],
  }));
  const set = Annotation.normalizeAnnotationSet(input, { now: 5 });
  assert.equal(set.space, 'card');
  assert.equal(set.createdAt, 1000);
  assert.deepEqual(set.items.map(item => item.id), ['login', 'tag', 'point', 'item-4', 'item-10']);
  assert.deepEqual(set.items[0], { id: 'login', type: 'box', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, label: '로그인 버튼',
    purpose: 'locate', confidence: 0.93, ref: 'e12', status: 'proposed' });
  assert.deepEqual(set.items[3].rect, { x: 0, y: 0, w: 0.2, h: 0.2 });
  assert.equal(set.items[3].note, '너무 작음 글자');
  assert.equal(set.items[2].fromItemId, 'tag');
  assert.equal(set.items[4].fromItemId, undefined, 'an arrow end that names no mark is dropped');
  assert.equal(set.items[4].toItemId, 'login');
  assert.deepEqual(privateKeysIn(set), [], 'Board store would refuse a private key');
  assert.equal(JSON.stringify(set).includes('hidden'), false);
});

test('annotation: refuses a set without id, card or usable mark; free-canvas sets use world coordinates', () => {
  assert.throws(() => Annotation.normalizeAnnotationSet({ items: agentSet().items }), /id가 없습니다/);
  assert.throws(() => Annotation.normalizeAnnotationSet({ id: 's', space: 'card', items: agentSet().items }), /카드가 없습니다/);
  assert.throws(() => Annotation.normalizeAnnotationSet({ id: 's', targetCardId: 'c', items: [{ type: 'box', rect: { x: NaN, y: 0, w: 1, h: 1 } }] }), /표식이 없습니다/);
  const many = Array.from({ length: 40 }, (_, index) => ({ type: 'box', rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, id: `b${index}` }));
  assert.equal(Annotation.normalizeAnnotationSet({ id: 's', targetCardId: 'c', items: many }).items.length, Annotation.ANNOTATION_LIMITS.items);
  const canvas = Annotation.normalizeAnnotationSet({ id: 'free', source: { documentId: 'ignored' }, targetKind: 'browser',
    items: [{ type: 'box', rect: { x: 120.04, y: -80, w: 300, h: 140 }, ref: 'e1' }] }, { now: 7 });
  assert.equal(canvas.space, 'canvas');
  assert.equal(canvas.source, undefined);
  assert.equal(canvas.targetKind, undefined);
  assert.equal(canvas.createdAt, 7);
  assert.deepEqual(canvas.items[0], { id: 'item-1', type: 'box', rect: { x: 120, y: -80, w: 300, h: 140 }, status: 'proposed' });
});

test('annotation: every mark renders as an existing Canvas shape type', () => {
  for (const type of Annotation.ANNOTATION_ITEM_TYPES) assert.ok(CANVAS_SHAPE_TYPES.includes(Annotation.annotationShapeType(type)), type);
  assert.equal(Annotation.annotationShapeType('constructor'), null);
});

test('annotation: Browser element bounds become a ratio of the visible viewport', () => {
  const view = observation();
  assert.deepEqual(Annotation.rectFromViewportBounds({ x: 100, y: 160, width: 300, height: 80 }, view.viewport), { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  assert.deepEqual(Annotation.rectFromViewportBounds({ x: -50, y: 700, width: 150, height: 200 }, view.viewport), { x: 0, y: 0.875, w: 0.1, h: 0.125 });
  assert.equal(Annotation.rectFromViewportBounds({ x: 0, y: 900, width: 10, height: 10 }, view.viewport), null);
  assert.equal(Annotation.rectFromViewportBounds({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 10 }), null);
});

test('annotation: marks follow the card when it moves or resizes and round-trip through a user drag', () => {
  const set = Annotation.normalizeAnnotationSet(agentSet());
  const card = { x: 500, y: 300, width: 1000, height: 800 };
  const box = Annotation.projectItem(set.items[0], card);
  assert.deepEqual(box.rect, { x: 600, y: 460, width: 300, height: 80 });
  assert.equal(box.shapeType, 'rect');
  assert.equal(box.visible, true);
  const moved = Annotation.projectItem(set.items[0], { x: -200, y: 40, width: 500, height: 400 });
  assert.deepEqual(moved.rect, { x: -150, y: 120, width: 150, height: 40 });
  assert.deepEqual(Annotation.projectItem(set.items[2], card).line, { x1: 1000, y1: 348, x2: 750, y2: 460 });
  assert.deepEqual(Annotation.projectItem(set.items[1], card).point, { x: 1000, y: 340 });
  assert.equal(Annotation.projectItem(set.items[0], { x: 0, y: 0, width: 0, height: 10 }), null);
  assert.deepEqual(Annotation.unprojectRect({ x: 600, y: 460, width: 300, height: 80 }, card), { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  assert.deepEqual(Annotation.unprojectPoint({ x: 1000, y: 340 }, card), { x: 0.5, y: 0.05 });
  const free = Annotation.normalizeAnnotationSet({ id: 'free', items: [{ type: 'box', rect: { x: 10, y: 20, w: 30, h: 40 } }] });
  assert.deepEqual(Annotation.projectItem(free.items[0], null, { space: 'canvas' }).rect, { x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(Annotation.unprojectRect({ x: 10, y: 20, width: 30, height: 40 }, null, { space: 'canvas' }), { x: 10, y: 20, w: 30, h: 40 });
});

test('annotation: freshness separates a reloaded page from a revised one and from an unconfirmable one', () => {
  const set = Annotation.normalizeAnnotationSet(agentSet());
  assert.deepEqual(Annotation.annotationFreshness(set, observation()), { status: 'current', stale: false });
  assert.equal(Annotation.annotationFreshness(set, observation({ revision: 5 })).status, 'revised');
  assert.equal(Annotation.annotationFreshness(set, observation({ viewport: { width: 1200, height: 800 } })).status, 'revised');
  assert.equal(Annotation.annotationStale(set, observation({ revision: 9 })), false);
  const reloaded = Annotation.annotationFreshness(set, observation({ documentId: 'doc-2' }));
  assert.equal(reloaded.status, 'stale');
  assert.equal(reloaded.stale, true);
  assert.equal(Annotation.annotationFreshness(set, undefined).status, 'unknown');
  assert.equal(Annotation.annotationStale(set, {}), true);
  const free = Annotation.normalizeAnnotationSet({ id: 'free', items: [{ type: 'box', rect: { x: 1, y: 1, w: 1, h: 1 } }] });
  assert.deepEqual(Annotation.annotationFreshness(free, undefined), { status: 'unbound', stale: false });
});

test('annotation: a scrolled page shifts marks for display without changing stored geometry', () => {
  const set = Annotation.normalizeAnnotationSet(agentSet());
  const card = { x: 0, y: 0, width: 1000, height: 800 };
  const scrolled = observation({ scroll: { x: 0, y: 360 } });
  assert.deepEqual(Annotation.annotationScrollOffset(set, scrolled), { x: 0, y: -0.2 });
  const drawn = Annotation.projectAnnotationSet(set, card, scrolled);
  assert.equal(drawn.freshness.status, 'current');
  assert.deepEqual(drawn.items[0].rect, { x: 100, y: 0, width: 300, height: 80 });
  assert.equal(drawn.items[1].visible, false, 'the label scrolled out of the card');
  assert.deepEqual(set.items[0].rect, { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  // A drag after scrolling is stored relative to the captured area again.
  assert.deepEqual(Annotation.unprojectRect({ x: 100, y: 0, width: 300, height: 80 }, card, { offset: drawn.offset }), { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  assert.deepEqual(Annotation.annotationScrollOffset(set, observation({ documentId: 'doc-2', scroll: { x: 0, y: 900 } })), { x: 0, y: 0 });
});

test('annotation: accept the whole group in one step, accept or dismiss single marks, keep user edits', () => {
  const set = deepFreeze(Annotation.normalizeAnnotationSet(agentSet()));
  assert.equal(Annotation.annotationSetStatus(set), 'proposed');
  assert.equal(Annotation.annotationSummaryText(set), '표식 3개 · 확인 대기 3');
  const all = Annotation.acceptAnnotations(set, { current: observation({ revision: 6 }) });
  assert.deepEqual(all.items.map(item => item.status), ['accepted', 'accepted', 'accepted']);
  assert.equal(Annotation.annotationSetStatus(all), 'accepted');
  const one = Annotation.dismissAnnotations(set, { itemIds: ['tag'] });
  assert.deepEqual(one.items.map(item => item.status), ['proposed', 'dismissed', 'proposed']);
  assert.equal(Annotation.annotationSetStatus(one), 'partial');
  assert.equal(Annotation.annotationSummaryText(one), '표식 3개 · 확인 대기 2 · 지움 1');
  assert.equal(Annotation.dismissAnnotations(one, { itemIds: ['tag'] }), one, 'no change keeps the same object');
  assert.equal(Annotation.projectAnnotationSet(one, { x: 0, y: 0, width: 100, height: 100 }, observation()).items.length, 2);
  const none = Annotation.dismissAnnotations(set);
  assert.equal(Annotation.annotationSetStatus(none), 'dismissed');
  const edited = Annotation.editAnnotationItem(set, 'login', { rect: { x: 0.12, y: 0.2, w: 0.3, h: 0.1 }, label: '로그인' }, { now: 50 });
  assert.equal(edited.items[0].status, 'edited');
  assert.deepEqual(edited.items[0].edit, { original: { rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, label: '로그인 버튼' }, editedBy: 'user', editedAt: 50 });
  const again = Annotation.editAnnotationItem(edited, 'login', { rect: { x: 0.2, y: 0.2, w: 0.3, h: 0.1 } }, { now: 60 });
  assert.deepEqual(again.items[0].edit.original.rect, { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, 'the first original survives later edits');
  assert.equal(again.items[0].label, '로그인');
  const lineMoved = Annotation.editAnnotationItem(set, 'point', { to: { x: 0.3, y: 0.3 } });
  assert.deepEqual([lineMoved.items[2].from, lineMoved.items[2].to], [{ x: 0.5, y: 0.06 }, { x: 0.3, y: 0.3 }]);
  assert.equal(Annotation.editAnnotationItem(set, 'login', { rect: set.items[0].rect }), set);
  assert.throws(() => Annotation.editAnnotationItem(set, 'tag', { label: ' ' }), /글자가 필요/);
  assert.throws(() => Annotation.editAnnotationItem(one, 'tag', { at: { x: 0.2, y: 0.2 } }), /지운 표식/);
  assert.throws(() => Annotation.editAnnotationItem(set, 'missing', {}), /찾을 수 없습니다/);
  const keptEdit = Annotation.acceptAnnotations(Annotation.dismissAnnotations(edited, { itemIds: ['login'] }), { current: observation() });
  assert.equal(keptEdit.items[0].status, 'edited', 'restoring a dismissed edit keeps it an edit');
  assert.equal(Annotation.annotationCounts(keptEdit).edited, 1);
});

test('annotation: accepting re-checks the card first; a stale or unconfirmable set is refused, dismiss still works', () => {
  const set = Annotation.normalizeAnnotationSet(agentSet());
  assert.throws(() => Annotation.acceptAnnotations(set, { current: observation({ documentId: 'doc-2' }) }), error => error.code === 'ANNOTATION_STALE');
  assert.throws(() => Annotation.acceptAnnotations(set), error => error.code === 'ANNOTATION_STALE');
  assert.equal(Annotation.dismissAnnotations(set).items.every(item => item.status === 'dismissed'), true);
  const free = Annotation.normalizeAnnotationSet({ id: 'free', items: [{ type: 'box', rect: { x: 1, y: 1, w: 1, h: 1 } }] });
  assert.equal(Annotation.acceptAnnotations(free).items[0].status, 'accepted');
});

test('annotation: Board saves only kept marks and restores them through the same rules', () => {
  const set = Annotation.normalizeAnnotationSet(agentSet());
  assert.equal(Annotation.annotationSetForBoard(set), null, 'proposals stay a dirty overlay');
  const decided = Annotation.dismissAnnotations(Annotation.acceptAnnotations(set, { itemIds: ['login', 'point'], current: observation() }), { itemIds: ['tag'] });
  const saved = Annotation.annotationSetForBoard(decided);
  assert.deepEqual(saved.items.map(item => item.id), ['login', 'point']);
  assert.notEqual(saved.items[0], decided.items[0], 'a saved copy, not shared objects');
  assert.equal(saved.items[1].fromItemId, undefined, 'the arrow no longer points at the dismissed label');
  assert.equal(saved.items[1].toItemId, 'login');
  assert.equal(decided.items[2].fromItemId, 'tag', 'the live set is unchanged');
  assert.deepEqual(privateKeysIn(saved), []);
  const restored = Annotation.restoreAnnotationSet(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored, saved);
  assert.equal(Annotation.restoreAnnotationSet({ id: 'x' }), null);
  // After a restart the Browser card loads a new document: kept marks are stale.
  assert.equal(Annotation.projectAnnotationSet(restored, { x: 0, y: 0, width: 10, height: 10 }, observation({ documentId: 'doc-after-restart' })).freshness.stale, true);
});

const cards = [
  { id: 'egd-card-1', rect: { x: 0, y: 0, width: 400, height: 300 } },
  { id: 'egd-card-2', rect: { x: 200, y: 100, width: 400, height: 300 } },
];

test('memo: a memo pins to the topmost card under it as a ratio and follows that card', () => {
  const memo = Memo.createMemoRecord({ id: 'memo-1', seq: 1, point: { x: 300, y: 250 }, cards, text: '  이 표가 맞는지\r\n\r\n\r\n확인  ', now: 10 });
  assert.deepEqual(memo.anchor, { kind: 'card', cardId: 'egd-card-2', x: 0.25, y: 0.5, at: { x: 300, y: 250 } });
  assert.equal(memo.text, '이 표가 맞는지\n\n확인');
  assert.equal(memo.expanded, false);
  assert.deepEqual(Memo.memoFrame(memo), { width: 240, height: 160 });
  assert.deepEqual(Memo.memoPosition(memo, cards), { x: 300, y: 250, attached: true, missing: false });
  const resized = [{ id: 'egd-card-2', rect: { x: 1000, y: 0, width: 800, height: 600 } }];
  assert.deepEqual(Memo.memoPosition(memo, resized), { x: 1200, y: 300, attached: true, missing: false });
  assert.deepEqual(Memo.memoPosition(memo, []), { x: 300, y: 250, attached: false, missing: true }, 'closed card keeps the memo visible');
  const free = Memo.moveMemo(memo, { x: 900, y: 900 }, cards, { now: 20 });
  assert.deepEqual(free.anchor, { kind: 'canvas', x: 900, y: 900 });
  assert.equal(free.updatedAt, 20);
  assert.throws(() => Memo.createMemoRecord({ id: 'memo-2', point: { x: NaN, y: 0 } }), /자리가 없습니다/);
  assert.throws(() => Memo.createMemoRecord({ id: 'memo-3', point: { x: 0, y: 0 }, text: 'x'.repeat(Memo.MEMO_LIMITS.text + 1) }), /2000자/);
});

test('memo: folded 240×160 and expanded 320×280 are the only frames; folding is not a content change', () => {
  const memo = Memo.createMemoRecord({ id: 'm', point: { x: 0, y: 900 }, now: 5 });
  assert.deepEqual(Memo.MEMO_FRAME, { folded: { width: 240, height: 160 }, expanded: { width: 320, height: 280 } });
  const open = Memo.setMemoExpanded(memo, true);
  assert.deepEqual([open.expanded, Memo.memoFrame(open)], [true, { width: 320, height: 280 }]);
  assert.equal(open.updatedAt, 5, 'opening the thread leaves updatedAt alone');
  assert.equal(Memo.setMemoExpanded(open, true), open);
  assert.deepEqual(Memo.memoFrame(Memo.setMemoExpanded(open, false)), { width: 240, height: 160 });
  assert.deepEqual(Memo.memoFrame(null), { width: 240, height: 160 });
});

const memoSurfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const memoCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
function memoSurfaceFunction(name) {
  const start = memoSurfaceSource.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = memoSurfaceSource.indexOf('\n  }', start);
  assert.ok(end > start, `${name} has a complete body`);
  return memoSurfaceSource.slice(start, end + 4);
}
function memoElement(tag, attrs = {}, ...children) {
  const node = {
    tag, dataset: attrs.data || {}, style: attrs.style || {}, children: [], parentNode: null,
    classList: new Set((attrs.class || '').split(/\s+/).filter(Boolean)),
    addEventListener() {}, removeEventListener() {},
    appendChild(child) {
      if (typeof child === 'string') child = { textContent: child };
      if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
      child.parentNode = this; this.children.push(child); return child;
    },
    ...attrs,
  };
  for (const child of children) node.appendChild(child);
  return node;
}

test('memo UI: only the memo title stays in the common bar; target and fixed actions use the second row', () => {
  for (const expanded of [false, true]) for (const resolved of [false, true]) {
    let shell, shellOptions;
    const scope = {
      ensureMemoAnchorObserver() {}, memoAnchorCandidates: () => [], MemoState: Memo, memoCards: () => [],
      spawnDeskWindowShell(options) {
        shellOptions = options;
        const identity = memoElement('div'), actions = memoElement('div');
        const topbar = memoElement('div', {}, identity, actions);
        const header = memoElement('div', {}, topbar);
        const toolbar = options.toolbar ? header.appendChild(memoElement('div')) : null;
        const content = memoElement('div');
        const root = memoElement('div', { isConnected: true }, header, content);
        shell = { root, slots: { identity, actions, topbar, header, toolbar, content }, resizeHits: [], registerCleanup() {} };
        return shell;
      },
      el: memoElement, updateMemoRecord(root, next) { root._memoRecord = next; },
      window: { addEventListener() {}, removeEventListener() {} },
      syncMemoCardFrame() {}, renderMemoCard() {}, syncMemoCardPosition() {}, state: {},
    };
    const spawn = Function(...Object.keys(scope), `let cardSeq = 0;\n${memoSurfaceFunction('spawnMemoCard')}\nreturn spawnMemoCard;`)(...Object.values(scope));
    const record = Memo.normalizeMemoRecord({ id: 'layout-memo', anchor: { kind: 'canvas', x: 20, y: 30 }, expanded, resolved });
    const root = spawn({ record, restore: true });
    assert.equal(shellOptions.toolbar, true, 'the existing shell provides the memo-only second row');
    assert.deepEqual(shell.slots.identity.children.map(n => n.class), ['egd-memo-title']);
    assert.equal(shell.slots.actions.parentNode, shell.slots.toolbar, 'actions leave the common title/Board row');
    assert.equal(shell.slots.toolbar.children[0].dataset.testid, 'memo-anchor');
    assert.equal(shell.slots.toolbar.classList.has('egd-memo-targetbar'), true);
    assert.deepEqual([root._memoRecord.expanded, root._memoRecord.resolved], [expanded, resolved]);
    assert.deepEqual([shellOptions.style.width, shellOptions.style.height], expanded ? ['320px', '280px'] : ['240px', '160px']);
    const event = { stopPropagation() {} };
    shell.slots.actions.children[0].onclick(event);
    assert.equal(root._memoRecord.resolved, !resolved, 'resolve/reopen retains its existing record transition');
    shell.slots.actions.children[1].onclick(event);
    assert.equal(root._memoRecord.expanded, !expanded, 'expand/fold retains its existing record transition');
  }
});

test('memo badge: exact target View display text is local-only; Agent label and id binding do not change', () => {
  const rect = { x: 10, y: 20, width: 600, height: 400 };
  const title = { textContent: '원본 A — 길고 서로 다른 실제 표시 제목' };
  const card = {
    dataset: { deskWindowKind: 'browser' },
    classList: { contains: name => name === 'egd-browser-card' },
    querySelector: selector => selector === '.egd-card-page-title' ? title : selector === '.egd-card-url' ? { value: 'synthetic:never-send-title' } : null,
    getAttribute() { throw new Error('Do not read hidden title/source metadata'); },
    get _browserState() { throw new Error('Do not inspect internal Browser state'); },
    get _xulBrowser() { throw new Error('Do not inspect a Browser/provider'); },
  };
  const decoy = Object.create(card);
  decoy.querySelector = () => ({ textContent: '비교 B — 다른 제목' });
  const nodes = new Map([['target-a', card], ['decoy-b', decoy]]);
  const badge = {};
  const memo = Memo.createMemoRecord({ id: 'badge-memo', text: '합성 메모 본문', point: { x: 50, y: 60 }, cards: [{ id: 'target-a', rect }] });
  const root = { _memoRecord: memo, isConnected: true, dataset: {}, style: {}, querySelector: () => badge };
  const scope = { document: { getElementById: id => nodes.get(id) }, memoAnchorCandidates: () => [{ id: 'target-a', rect }], MemoState: Memo, state: {} };
  const api = Function(...Object.keys(scope), `${memoSurfaceFunction('cardLabelForViewportRail')}\n${memoSurfaceFunction('memoTargetLabel')}\n${memoSurfaceFunction('syncMemoCardPosition')}\nreturn { syncMemoCardPosition, memoTargetLabel };`)(...Object.values(scope));
  const agentBefore = Memo.memoAskDraft(memo, { agentId: 'rio', target: api.memoTargetLabel(memo) });
  api.syncMemoCardPosition(root);
  assert.equal(badge.textContent, `📎 ${title.textContent}`);
  assert.equal(badge.title, `${title.textContent} 위에 붙은 메모 · 카드가 움직이면 따라갑니다`);
  title.textContent = '원본 A — 바뀐 표시 제목';
  api.syncMemoCardPosition(root);
  assert.equal(badge.textContent, `📎 ${title.textContent}`, 'read the current display, not a cached/source title');
  title.textContent = '   ';
  api.syncMemoCardPosition(root);
  assert.equal(badge.textContent, '📎 Browser', 'no display title falls back to the View type, not private metadata');
  const agentAfter = Memo.memoAskDraft(memo, { agentId: 'rio', target: api.memoTargetLabel(memo) });
  assert.deepEqual(agentAfter, agentBefore, 'badge-only titles never expand Agent messages or shared context');
  assert.equal(root._memoRecord.anchor.cardId, 'target-a', 'display text never becomes an identity lookup');
  for (const [kind, selector, fallback] of [
    ['chat', '.egd-chat-card-title', 'Chat'], ['file', '.egd-file-card-title', '파일'],
    ['terminal', '.egd-terminal-title', 'Terminal'], ['settings', '.egd-settings-title', 'Settings'],
    ['ontology', '.egd-ontology-title', 'Ontology'], ['input-evidence', '.egd-desk-window-identity strong', '자료'],
    ['result', '.egd-result-card-title', '결과'],
  ]) {
    card.dataset.deskWindowKind = kind;
    card.querySelector = query => { assert.equal(query, selector); return title; };
    title.textContent = `실제 ${kind} 표시 제목`;
    api.syncMemoCardPosition(root);
    assert.equal(badge.textContent, `📎 ${title.textContent}`);
    title.textContent = '';
    api.syncMemoCardPosition(root);
    assert.equal(badge.textContent, `📎 ${fallback}`);
  }
  for (const kind of ['unknown', 'constructor', 'toString', '__proto__']) {
    card.dataset.deskWindowKind = kind;
    card.querySelector = () => { throw new Error('Unknown kinds cannot query arbitrary metadata'); };
    api.syncMemoCardPosition(root);
    assert.equal(badge.textContent, '📎 Card');
  }
  nodes.delete('target-a');
  scope.memoAnchorCandidates = () => [];
  const missing = Function(...Object.keys(scope), `${memoSurfaceFunction('syncMemoCardPosition')}\nreturn syncMemoCardPosition;`)(...Object.values(scope));
  missing(root);
  assert.equal(badge.textContent, '대상 없음', 'a similarly titled card does not replace a missing id');
  root._memoRecord = Memo.moveMemo(memo, { x: 900, y: 900 }, []);
  missing(root);
  assert.equal(badge.textContent, '위치 고정');
});

test('memo CSS: compact target row ellipsizes only its badge and preserves body/reply scrolling', () => {
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = memoCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `rule exists: ${selector}`); return match[1];
  };
  const row = rule('.egd-memo-card .egd-memo-targetbar');
  assert.match(row, /min-height:\s*28px/);
  assert.match(row, /min-width:\s*0/);
  const frame = rule('.egd-memo-card');
  assert.match(frame, /min-width:\s*240px/, 'the common 320px minimum cannot enlarge the folded frame');
  assert.match(frame, /min-height:\s*160px/, 'the common 250px minimum cannot enlarge the folded frame');
  const badge = rule('.egd-memo-anchor');
  for (const property of [/flex:\s*1\s+1\s+auto/, /min-width:\s*0/, /overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /white-space:\s*nowrap/]) assert.match(badge, property);
  const buttons = rule('.egd-memo-card .egd-desk-window-actions button');
  assert.match(buttons, /flex:\s*0\s+0\s+auto/);
  assert.match(buttons, /white-space:\s*nowrap/);
  assert.match(rule('.egd-memo-text'), /min-height:\s*56px/);
  assert.match(rule('.egd-memo-thread'), /overflow:\s*auto/);
  assert.match(rule('.egd-memo-detail'), /overflow:\s*auto/, 'an extra Board offer or pending row must not clip the last input');
  assert.match(rule('.egd-memo-card .egd-card-body'), /min-height:\s*0/);
});

test('memo: restore is lenient but keeps ids, answer ids and asks unique; no private keys', () => {
  const raw = deepFreeze({
    id: 'memo-9', seq: 3, anchor: { kind: 'card', cardId: 'egd-card-1', x: 1.4, y: -1 }, text: 'x'.repeat(2100), resolved: 'yes',
    size: { width: 300, baseHeight: 20 }, expanded: 'yes', createdAt: 100, updatedAt: 50, apiKey: 'never',
    replies: [
      { id: 'reply-1', author: { kind: 'user' }, text: '사람 답글' },
      { id: 'reply-2', author: { kind: 'agent', agentId: 'rio', name: 'Rio' }, text: 'Agent 답', answerId: 'answer-1', askId: 'ask-1' },
      { id: 'reply-3', author: { kind: 'agent', agentId: 'rio' }, text: '중복 답', answerId: 'answer-1' },
      { id: 'reply-1', author: { kind: 'user' }, text: '중복 id' },
      { id: 'reply-4', author: { kind: 'agent', agentId: 'rio' }, text: '답변 id 없음' },
      { id: 'reply-5', author: { kind: 'robot' }, text: '?' },
    ],
    asks: [{ askId: 'ask-1', agentId: 'rio', status: 'answered', answerId: 'answer-1' }, { askId: 'ask-1', agentId: 'rio' },
      { askId: 'ask-2', agentId: 'mina', status: 'weird', requestId: 'request-abc', threadId: 'thread-dm-1', extra: 1 }, { askId: 'ask-3', agentId: 'mina', requestId: '../x' }],
    links: [{ targetViewId: 'egd-card-2', label: '참고' }, { targetViewId: 'egd-card-2' }, { targetViewId: 'memo-9' }, { targetViewId: '../etc' }],
  });
  const memo = Memo.normalizeMemoRecord(raw);
  assert.deepEqual(memo.anchor, { kind: 'card', cardId: 'egd-card-1', x: 1, y: 0 });
  assert.equal(memo.text.length, Memo.MEMO_LIMITS.text);
  assert.equal(memo.resolved, false);
  assert.equal(memo.expanded, false);
  assert.equal(Object.hasOwn(memo, 'size'), false, 'a memo has two fixed frames, no free size');
  assert.equal(memo.updatedAt, 100);
  assert.deepEqual(memo.replies.map(reply => reply.id), ['reply-1', 'reply-2']);
  assert.deepEqual(memo.asks, [{ askId: 'ask-1', agentId: 'rio', status: 'answered', answerId: 'answer-1' },
    { askId: 'ask-2', agentId: 'mina', status: 'pending', requestId: 'request-abc', threadId: 'thread-dm-1' }, { askId: 'ask-3', agentId: 'mina', status: 'pending' }]);
  assert.deepEqual(memo.links, [{ targetViewId: 'egd-card-2', label: '참고' }]);
  assert.deepEqual(privateKeysIn(memo), []);
  assert.throws(() => Memo.normalizeMemoRecord({ id: 'm' }), /자리가 없습니다/);
  assert.throws(() => Memo.normalizeMemoRecord({ anchor: { kind: 'canvas', x: 0, y: 0 } }), /id가 없습니다/);
});

test('memo: [Agent에게 묻기] drafts one Chat message with the memo, recent replies and question', () => {
  let memo = Memo.createMemoRecord({ id: 'memo-1', seq: 4, point: { x: 10, y: 10 }, cards, text: '매출 표의 3분기 숫자가 이상함', now: 1 });
  memo = Memo.linkMemo(memo, 'egd-card-2', '원본 표');
  for (const text of ['첫째', '둘째', '셋째', '넷째']) memo = Memo.appendMemoReply(memo, { author: { kind: 'user' }, text }).memo;
  const before = memo;
  const draft = Memo.memoAskDraft(memo, { agentId: 'rio', agentName: 'Rio', question: ' 원인이 뭘까? ', target: ' Browser ·  매출 표 ' });
  assert.equal(memo, before, 'drafting does not change the memo');
  assert.deepEqual({ ...draft, text: undefined }, { memoId: 'memo-1', askId: 'ask-1', agentId: 'rio', agentName: 'Rio', text: undefined,
    contextCardIds: ['egd-card-1', 'egd-card-2'], basedOnMemoRevision: Memo.memoAskDraft(memo, { agentId: 'rio' }).basedOnMemoRevision });
  assert.equal(draft.text, '[메모 #4 · memo-1]\n\n매출 표의 3분기 숫자가 이상함\n\n대상: Browser · 매출 표\n\n최근 답글:\n나: 둘째\n나: 셋째\n나: 넷째\n\n질문: 원인이 뭘까?');
  assert.equal(Memo.memoAskDraft(memo, { agentId: 'rio', question: 'q' }).text.includes('대상:'), false, 'a free Canvas memo names no target');
  assert.throws(() => Memo.memoAskDraft(memo, { question: 'x' }), /Agent를 골라/);
  assert.throws(() => Memo.memoAskDraft(memo, { agentId: 'rio', question: 'x'.repeat(501) }), /500자/);
  const empty = Memo.createMemoRecord({ id: 'memo-2', point: { x: 900, y: 900 } });
  assert.throws(() => Memo.memoAskDraft(empty, { agentId: 'rio' }), /내용이나 질문/);
  assert.equal(Memo.memoAskDraft(empty, { agentId: 'rio', question: '이거 뭐야' }).text, '[메모 · memo-2]\n\n(내용 없음)\n\n질문: 이거 뭐야');
});

test('memo: an Agent answer joins its memo once, only while the ask is pending, only from the asked Agent', () => {
  let memo = Memo.createMemoRecord({ id: 'memo-1', seq: 1, point: { x: 900, y: 900 }, text: '확인 부탁', now: 1 });
  const draft = Memo.memoAskDraft(memo, { agentId: 'rio', question: '맞아?' });
  memo = Memo.recordMemoAsk(memo, draft, { now: 2, requestId: 'request-1', threadId: 'thread-dm-x' });
  assert.equal(Memo.recordMemoAsk(memo, draft), memo, 'recording the same ask twice is a no-op');
  assert.deepEqual(Memo.pendingMemoAsks(memo), [{ askId: 'ask-1', agentId: 'rio', status: 'pending', askedAt: 2, requestId: 'request-1', threadId: 'thread-dm-x', basedOnMemoRevision: draft.basedOnMemoRevision }]);
  assert.deepEqual(Memo.findPendingMemoAsk([null, Memo.createMemoRecord({ id: 'other', point: { x: 1, y: 1 } }), memo], 'request-1'), { memo, ask: memo.asks[0] });
  assert.equal(Memo.findPendingMemoAsk([memo], 'request-9'), null);
  assert.equal(Memo.findPendingMemoAsk([memo], undefined), null);
  assert.equal(Memo.memoAskDraft(memo, { agentId: 'rio', question: '또' }).askId, 'ask-2');
  const wrongAgent = Memo.appendMemoReply(memo, { author: { kind: 'agent', agentId: 'mina' }, text: '제가 답할게요', answerId: 'a-0', askId: 'ask-1' });
  assert.deepEqual([wrongAgent.appended, wrongAgent.reason, wrongAgent.memo], [false, 'ask-mismatch', memo]);
  const first = Memo.appendMemoReply(memo, { author: { kind: 'agent', agentId: 'rio', name: 'Rio' }, text: '네, 맞습니다.', answerId: 'a-1', askId: 'ask-1', runId: 'run-1' }, { now: 3 });
  assert.equal(first.appended, true);
  assert.deepEqual(first.memo.replies.at(-1), { id: 'reply-1', author: { kind: 'agent', agentId: 'rio', name: 'Rio' }, text: '네, 맞습니다.', createdAt: 3, answerId: 'a-1', askId: 'ask-1', runId: 'run-1', basedOnMemoRevision: draft.basedOnMemoRevision });
  assert.deepEqual(first.memo.asks[0], { askId: 'ask-1', agentId: 'rio', status: 'answered', askedAt: 2, requestId: 'request-1', threadId: 'thread-dm-x', answerId: 'a-1', basedOnMemoRevision: draft.basedOnMemoRevision });
  assert.equal(Memo.findPendingMemoAsk([first.memo], 'request-1'), null, 'an answered ask is no longer pending');
  const repeat = Memo.appendMemoReply(first.memo, { author: { kind: 'agent', agentId: 'rio' }, text: '네, 맞습니다.', answerId: 'a-1', askId: 'ask-1' });
  assert.deepEqual([repeat.appended, repeat.reason, repeat.memo], [false, 'duplicate', first.memo]);
  const late = Memo.appendMemoReply(first.memo, { author: { kind: 'agent', agentId: 'rio' }, text: '추가 답', answerId: 'a-2', askId: 'ask-1' });
  assert.deepEqual([late.appended, late.reason], [false, 'ask-closed']);
  let cancelled = Memo.recordMemoAsk(first.memo, Memo.memoAskDraft(first.memo, { agentId: 'rio', question: '하나 더' }));
  cancelled = Memo.cancelMemoAsk(cancelled, 'ask-2');
  assert.equal(Memo.cancelMemoAsk(cancelled, 'ask-2'), cancelled);
  assert.equal(Memo.appendMemoReply(cancelled, { author: { kind: 'agent', agentId: 'rio' }, text: '늦은 답', answerId: 'a-3', askId: 'ask-2' }).reason, 'ask-closed');
  // Without an ask (copied from Chat by hand) an Agent answer still needs its answer id.
  const manual = Memo.appendMemoReply(first.memo, { author: { kind: 'agent', agentId: 'rio' }, text: 'y'.repeat(2500), answerId: 'a-9' });
  assert.equal(manual.memo.replies.at(-1).text.length, Memo.MEMO_LIMITS.reply);
  assert.equal(manual.memo.replies.at(-1).truncated, true);
  assert.throws(() => Memo.appendMemoReply(first.memo, { author: { kind: 'agent', agentId: 'rio' }, text: 'x' }), /답변 id/);
  assert.throws(() => Memo.appendMemoReply(first.memo, { author: { kind: 'user' }, text: 'x'.repeat(2001) }), /2000자/);
  assert.throws(() => Memo.appendMemoReply(first.memo, { author: { kind: 'user' }, text: '   ' }), /내용을 입력/);
  assert.throws(() => Memo.appendMemoReply(first.memo, { author: { kind: 'robot' }, text: 'x' }), /작성자/);
  assert.throws(() => Memo.recordMemoAsk(first.memo, { ...draft, memoId: 'other' }), /다른 메모/);
});

const fakeCompletedMemoRun = (overrides = {}) => ({ requestId: 'request-1', answerId: 'answer-7', runId: 'run-7', status: 'completed', messages: [
    { id: 'u1', role: 'user', content: '[메모 · memo-1]\n\n질문: 맞아?', status: 'complete' },
    { id: 'a1', role: 'assistant', content: '  네, 맞습니다.\r\n', status: 'complete' },
    { id: 'a2', role: 'assistant', text: '근거는 3쪽입니다.', status: 'complete' },
    { id: 'a3', role: 'assistant', content: '실패한 조각', status: 'error' },
  ], ...overrides });

test('memo: a completed Chat run becomes one Agent reply; unfinished or empty runs become nothing', () => {
  const run = fakeCompletedMemoRun();
  assert.deepEqual(Memo.memoReplyFromRun(run), { answerId: 'answer-7', runId: 'run-7', text: '네, 맞습니다.\n\n근거는 3쪽입니다.' });
  assert.equal(Memo.memoReplyFromRun({ ...run, status: 'running' }), null);
  assert.equal(Memo.memoReplyFromRun({ ...run, answerId: null }), null);
  assert.equal(Memo.memoReplyFromRun({ ...run, messages: [run.messages[0]] }), null);
  assert.equal(Memo.memoReplyFromRun(null), null);
  let memo = Memo.createMemoRecord({ id: 'memo-1', point: { x: 900, y: 900 }, text: '확인 부탁', now: 1 });
  memo = Memo.recordMemoAsk(memo, Memo.memoAskDraft(memo, { agentId: 'rio', question: '맞아?' }), { now: 2, requestId: 'request-1', threadId: 't' });
  const found = Memo.findPendingMemoAsk([memo], run.requestId);
  const reply = Memo.memoReplyFromRun(run);
  const joined = Memo.appendMemoReply(found.memo, { author: { kind: 'agent', agentId: found.ask.agentId, name: 'Rio' }, ...reply, askId: found.ask.askId }, { now: 3 });
  assert.equal(joined.appended, true);
  assert.equal(joined.memo.replies[0].answerId, 'answer-7');
  assert.equal(Memo.memoAuthorName(joined.memo.replies[0].author), 'Rio');
  assert.equal(Memo.memoAuthorName({ kind: 'user' }), '나');
  assert.equal(Memo.memoAuthorName({ kind: 'agent', agentId: 'x' }), 'Agent');
});

test('memo: resolve, edit, numbering and JSON Canvas edges', () => {
  const memo = Memo.createMemoRecord({ id: 'memo-1', seq: 2, point: { x: 900, y: 900 }, text: 'a', now: 1 });
  const resolved = Memo.setMemoResolved(memo, true, { now: 5 });
  assert.deepEqual([resolved.resolved, resolved.updatedAt], [true, 5]);
  assert.equal(Memo.setMemoResolved(resolved, true), resolved);
  assert.equal(Memo.editMemoText(memo, ' a '), memo);
  assert.equal(Memo.editMemoText(memo, 'b', { now: 9 }).text, 'b');
  assert.throws(() => Memo.editMemoText(memo, 'x'.repeat(2001)), /2000자/);
  assert.equal(Memo.nextMemoSeq([memo, { seq: 7 }, { seq: 'x' }, null]), 8);
  assert.equal(Memo.nextMemoSeq([]), 1);
  const linked = Memo.linkMemo(Memo.linkMemo(memo, 'egd-card-1', '근거'), 'egd-card-1', '근거 표');
  assert.deepEqual(linked.links, [{ targetViewId: 'egd-card-1', label: '근거 표' }]);
  assert.deepEqual(Memo.memoLinksForCanvas(linked), [{ id: 'memo-1->egd-card-1', fromNode: 'memo-1', toNode: 'egd-card-1', toEnd: 'arrow', label: '근거 표' }]);
  assert.deepEqual(Memo.unlinkMemo(linked, 'egd-card-1').links, []);
  assert.equal(Memo.unlinkMemo(linked, 'nope'), linked);
  assert.throws(() => Memo.linkMemo(memo, 'memo-1'), /대상을 찾을 수 없습니다/);
  let full = memo;
  for (let index = 0; index < Memo.MEMO_LIMITS.links; index += 1) full = Memo.linkMemo(full, `egd-card-${index}`);
  assert.throws(() => Memo.linkMemo(full, 'egd-card-99'), /8개까지/);
});

test('annotation + memo: opening a Board with new view ids remaps the card each one points at', () => {
  const ids = { 'egd-card-7': 'egd-card-70', 'egd-card-1': 'egd-card-10', 'egd-card-2': 'egd-card-20' };
  const saved = Annotation.annotationSetForBoard(Annotation.acceptAnnotations(Annotation.normalizeAnnotationSet(agentSet()), { current: observation() }));
  const reopened = Annotation.restoreAnnotationSet(remapMemberReferences(saved, ids));
  assert.equal(reopened.targetCardId, 'egd-card-70');
  assert.equal(reopened.items[0].ref, 'e12', 'element refs are opaque, not view ids');
  const memo = Memo.linkMemo(Memo.createMemoRecord({ id: 'memo-1', point: { x: 300, y: 250 }, cards }), 'egd-card-1');
  const moved = Memo.normalizeMemoRecord(remapMemberReferences(memo, ids));
  assert.equal(moved.anchor.cardId, 'egd-card-20');
  assert.deepEqual(moved.links, [{ targetViewId: 'egd-card-10' }]);
});

test('memo Board save reverses live anchor ids without rewriting canonical fallback records or opaque text', () => {
  const memo = Memo.createMemoRecord({ id: 'memo-1', point: { x: 300, y: 250 }, cards, text: 'egd-card-2', now: 1 });
  const snapshot = deepFreeze({ agenda: { id: 'board-a', memberCardIds: ['note', 'egd-card-2'] },
    cards: [{ id: 'note', type: 'memo', runtimeState: memo }, { id: 'egd-card-2', type: 'browser' }], shapes: [] });
  const projection = planBoardProjection(snapshot, 'projection-a');
  const live = deepFreeze({ id: projection.idMap.note, type: 'memo', runtimeState: remapMemberReferences(memo, projection.idMap) });
  const saved = snapshotBoardProjection(projection, { [live.id]: live }, 2);
  assert.deepEqual(saved.cards[0].runtimeState, memo);
  assert.deepEqual(snapshotBoardProjection(projection, {}, 3).cards[0].runtimeState, memo, 'unmounted members already carry source ids');
  assert.equal(saved.cards[0].runtimeState.text, 'egd-card-2');
  assert.equal(live.runtimeState.anchor.cardId, projection.idMap['egd-card-2'], 'saving never changes the live memo');
});

test('memo Board projection reserves absent anchor identities without inventing a target member', () => {
  for (const target of ['gone', 'constructor', 'toString']) {
    const memo = Memo.normalizeMemoRecord({ id: 'memo-1', anchor: { kind: 'card', cardId: target, x: 0.5, y: 0.5, at: { x: 90, y: 80 } } }, { now: 1 });
    const snapshot = deepFreeze({ agenda: { id: 'board-a', memberCardIds: ['note'] },
      cards: [{ id: 'note', type: 'memo', runtimeState: memo }], shapes: [] });
    const a = planBoardProjection(snapshot, 'projection-a'), b = planBoardProjection(snapshot, 'projection-b');
    assert.equal(Object.hasOwn(a.idMap, target), true);
    assert.notEqual(a.idMap[target], target);
    assert.notEqual(a.idMap[target], b.idMap[target], 'missing anchors are scoped to their own Board opening');
    assert.deepEqual(a.members.map(member => member.sourceId), ['note']);
    const live = { id: a.idMap.note, type: 'memo', runtimeState: remapMemberReferences(memo, a.idMap) };
    assert.deepEqual(snapshotBoardProjection(a, { [live.id]: live }, 2).cards[0].runtimeState.anchor, memo.anchor);
  }
});

const oldMemoAnswer = /수정 전 메모/;
const memoJson = value => JSON.parse(JSON.stringify(value));
const revisionDraft = memo => Memo.memoAskDraft(memo, { agentId: 'rio', agentName: 'Rio', question: '맞아?' });
const revisionMemo = () => Memo.createMemoRecord({ id: 'memo-1', seq: 1, point: { x: 900, y: 900 }, text: '본문 A', now: 1 });

// Compile the existing memo zone, not a replacement send/attach/row model.
// This also carries any local helpers with it without making their names an API.
function memoRuntimeElement(tag, attrs = {}, ...children) {
    const node = memoElement(tag, attrs, ...children.filter(child => child != null && child !== false));
    node.replacements = 0;
    node.setAttribute = (key, value) => { node[key] = String(value); };
    node.getAttribute = key => node[key] ?? null;
    node.replaceChildren = (...next) => {
      node.replacements += 1;
      for (const child of node.children) child.parentNode = null;
      node.children = [];
      for (const child of next.filter(child => child != null && child !== false)) node.appendChild(child);
    };
    Object.defineProperty(node, 'textContent', {
      get: () => node.children.map(child => child.textContent || '').join(''),
      set: value => node.replaceChildren(String(value)),
    });
    return node;
}

function memoRevisionHarness(record = revisionMemo()) {
  const element = memoRuntimeElement;
  const selectors = new Map([
    ['.egd-memo-text', element('textarea', { value: record.text })],
    ['.egd-memo-thread', element('div')], ['.egd-memo-title', element('strong')],
    ['.egd-memo-toggle', element('button')], ['.egd-memo-resolve', element('button')],
    ['.egd-memo-status', element('button')], ['.egd-memo-ask-status', element('div')],
    ['.egd-memo-ask-send', element('button')], ['.egd-memo-ask-agent', element('select', { value: 'rio' })],
  ]);
  const root = element('div', { isConnected: true });
  root._memoRecord = record;
  root._deskWindowShell = {};
  root.querySelector = selector => selectors.get(selector) || null;
  const roots = [root], notices = [], sent = [];
  const profiles = [{ id: 'rio', name: 'Rio' }, { id: 'mina', name: 'Mina' }];
  const state = { codex: {
    threads: profiles.map(profile => ({ id: `dm-${profile.id}`, title: profile.name, type: 'dm', profileEnabled: true, agentProfileId: profile.id, updatedAt: 1 })),
    threadDrafts: { 'unrelated-room': '이전부터 쓰던 다른 방 초안' },
    chatProtocol: { requests: { 'old-request': { localThreadId: 'unrelated-room', status: 'accepted' } } },
  } };
  let releaseSend, signalStarted;
  const gate = new Promise(resolve => { releaseSend = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  state.codexBridge = {
    createThread() { throw new Error('Synthetic Agent rooms already exist; no real room creation'); },
    selectThread() {},
    async sendMessage() {
      sent.push({ text: state.codex.threadDrafts['dm-rio'], memo: root._memoRecord });
      signalStarted();
      const outcome = await gate;
      if (outcome === 'reject') throw new Error('synthetic send rejected');
      if (outcome === 'accept') state.codex.chatProtocol.requests['request-1'] = { localThreadId: 'dm-rio', status: 'accepted' };
    },
  };
  const scope = {
    MemoState: Memo, state, el: element,
    document: {
      activeElement: selectors.get('.egd-memo-text'),
      querySelectorAll: selector => selector === '.egd-memo-card' ? roots : [],
      getElementById: id => id === 'egd-canvas-layer' ? { children: [] } : null,
    },
    codexAgentProfileChoices: () => profiles,
    codexAgentProfile: id => profiles.find(profile => profile.id === id),
    codexProfileAvatar: (_avatar, name) => element('span', {}, name),
    formatMessageTime: () => '합성 시각', markAgendaDirty() {},
    boardNotice: message => notices.push(message),
    spawnCodexChatCard: () => ({}), dismissChatReturnCue() {},
    console: { warn() {} }, TAG: 'memo-regression',
  };
  const start = memoSurfaceSource.indexOf('  const MEMO_RUN_ENDED =');
  const end = memoSurfaceSource.indexOf('  // Dock [메모]', start);
  assert.ok(start >= 0 && end > start, 'the existing memo zone is available');
  const api = Function(...Object.keys(scope), `${memoSurfaceSource.slice(start, end)}\nreturn { askMemoAgent, attachMemoRepliesFromRun, renderMemoCard };`)(...Object.values(scope));
  const render = () => api.renderMemoCard(root);
  const set = next => { root._memoRecord = next; selectors.get('.egd-memo-text').value = next.text; render(); };
  render();
  return {
    root, state, sent, notices, started, render, set,
    ask: () => api.askMemoAgent(root, { agentId: 'rio', agentName: 'Rio', question: '맞아?' }),
    completeSend: (outcome = 'accept') => releaseSend(outcome),
    edit: text => set(Memo.editMemoText(root._memoRecord, text, { now: 1 })),
    attach: (run = fakeCompletedMemoRun()) => api.attachMemoRepliesFromRun(run),
    warning(answerId = 'answer-7') {
      const row = selectors.get('.egd-memo-thread').children.find(node => node.dataset.answerId === answerId);
      assert.ok(row, `actual memoReplyRow rendered answer ${answerId}`);
      return oldMemoAnswer.test(row.textContent);
    },
    replyText: () => selectors.get('.egd-memo-thread').textContent,
    editorText: () => selectors.get('.egd-memo-text').value,
    restore() { set(Memo.normalizeMemoRecord(memoJson(root._memoRecord), { now: 1 })); },
  };
}

async function acceptMemoQuestion(harness, beforeAcceptance = () => {}) {
  const sending = harness.ask();
  await harness.started;
  try { beforeAcceptance(); }
  finally { harness.completeSend(); }
  assert.equal(await sending, true, 'the fake request was accepted through askMemoAgent');
}

test('memo revision: a dispatch basis tracks body edits, not timestamps or unrelated memo changes', () => {
  const original = deepFreeze(revisionMemo()), before = memoJson(original);
  const draft = deepFreeze(revisionDraft(original)), draftBefore = memoJson(draft);
  assert.notEqual(draft.basedOnMemoRevision, undefined, 'the existing basedOnMemoRevision contract identifies the dispatched body');
  const basis = memo => revisionDraft(memo).basedOnMemoRevision;
  const same = Memo.editMemoText(original, '  본문 A\r\n  ', { now: 999 });
  assert.deepEqual(basis(same), draft.basedOnMemoRevision, 'normalized identical body is not a new revision');
  const changed = Memo.editMemoText(original, '본문 B', { now: 1 });
  assert.notDeepEqual(basis(changed), draft.basedOnMemoRevision, 'a real edit counts even when the clock has not advanced');
  const back = Memo.editMemoText(changed, original.text, { now: 1 });
  assert.notDeepEqual(basis(back), draft.basedOnMemoRevision, 'A→B→A is not the original body revision');
  const replied = Memo.appendMemoReply(original, { author: { kind: 'user' }, text: '사람 답글' }, { now: 999 }).memo;
  const pending = Memo.recordMemoAsk(original, draft, { now: 999, requestId: 'request-1', threadId: 'dm-rio' });
  for (const [name, memo] of [
    ['expand', Memo.setMemoExpanded(original, true)], ['resolve', Memo.setMemoResolved(original, true, { now: 999 })],
    ['move', Memo.moveMemo(original, { x: 400, y: 300 }, [], { now: 999 })],
    ['link', Memo.linkMemo(original, 'other-view', '참고', { now: 999 })],
    ['unlink', Memo.unlinkMemo(Memo.linkMemo(original, 'other-view'), 'other-view', { now: 999 })],
    ['user reply', replied], ['ask', pending], ['cancel', Memo.cancelMemoAsk(pending, draft.askId, { now: 999 })],
  ]) assert.deepEqual(basis(memo), draft.basedOnMemoRevision, `${name} does not change the body revision`);
  assert.deepEqual(original, before, 'all original memo fields remain untouched');
  assert.deepEqual(draft, draftBefore, 'the original outgoing draft remains untouched');
});

test('memo revision: operational send/accept/completed-run/row paths show older-body answers at the right time', async t => {
  for (const scenario of [
    { name: 'same body while send is pending', before: h => h.edit(' 본문 A '), expected: false },
    { name: 'edit before request acceptance', before: h => h.edit('본문 B'), expected: true },
    { name: 'edit after request acceptance', after: h => h.edit('본문 B'), expected: true },
    { name: 'different edits before and after acceptance', before: h => h.edit('본문 B'), after: h => h.edit('본문 C'), expected: true },
    { name: 'A→B→A while the answer is pending', after: h => { h.edit('본문 B'); h.edit('본문 A'); }, expected: true },
  ]) await t.test(scenario.name, async () => {
    const original = deepFreeze(revisionMemo()), snapshot = memoJson(original);
    const dispatched = deepFreeze(revisionDraft(original)), draftSnapshot = memoJson(dispatched);
    const h = memoRevisionHarness(original);
    await acceptMemoQuestion(h, () => scenario.before?.(h));
    assert.deepEqual(h.root._memoRecord.asks[0].basedOnMemoRevision, dispatched.basedOnMemoRevision, 'acceptance records the dispatch basis, not the latest editor revision');
    scenario.after?.(h);
    const latestBody = h.root._memoRecord.text;
    const run = deepFreeze(fakeCompletedMemoRun()), runSnapshot = memoJson(run);
    h.attach(run);
    assert.equal(h.root._memoRecord.replies.length, 1);
    assert.equal(h.warning(), scenario.expected, 'the actual row distinguishes an older-body answer');
    assert.equal(h.root._memoRecord.text, latestBody, 'attaching an answer never rolls back the current body');
    assert.equal(h.editorText(), latestBody, 'active editor input is retained');
    assert.equal(h.sent[0].text, dispatched.text, 'the dispatched text stays at the original body');
    assert.equal(h.state.codex.threadDrafts['unrelated-room'], '이전부터 쓰던 다른 방 초안');
    assert.deepEqual(original, snapshot); assert.deepEqual(dispatched, draftSnapshot); assert.deepEqual(run, runSnapshot);
  });
});

test('memo revision: edits after an attached answer update the real row; non-body changes do not', async () => {
  const h = memoRevisionHarness(); await acceptMemoQuestion(h); h.attach();
  assert.equal(h.warning(), false);
  h.set(Memo.setMemoResolved(Memo.setMemoExpanded(h.root._memoRecord, false), true, { now: 999 }));
  h.set(Memo.moveMemo(h.root._memoRecord, { x: 30, y: 40 }, [], { now: 1000 }));
  h.set(Memo.appendMemoReply(h.root._memoRecord, { author: { kind: 'user' }, text: '본문은 그대로' }, { now: 1001 }).memo);
  assert.equal(h.warning(), false, 'layout, resolved state and another reply are not a body edit');
  h.edit('본문 B'); assert.equal(h.warning(), true, 'an already attached answer becomes older-body after editing');
  h.edit('본문 A'); assert.equal(h.warning(), true, 'returning to A does not erase intervening revision history');
});

test('memo revision: pending and answered JSON roundtrips retain the send basis without changing originals', async () => {
  const h = memoRevisionHarness();
  const dispatched = deepFreeze(revisionDraft(h.root._memoRecord)), draftBefore = memoJson(dispatched);
  await acceptMemoQuestion(h, () => h.edit('본문 B'));
  const pending = deepFreeze(h.root._memoRecord), pendingBefore = memoJson(pending);
  h.restore();
  assert.deepEqual(h.root._memoRecord, pendingBefore, 'normalizing a saved pending ask retains its data');
  assert.deepEqual(h.root._memoRecord.asks[0].basedOnMemoRevision, dispatched.basedOnMemoRevision);
  h.attach(); assert.equal(h.warning(), true);
  const answered = deepFreeze(h.root._memoRecord), answeredBefore = memoJson(answered);
  h.restore();
  assert.deepEqual(h.root._memoRecord, answeredBefore, 'normalizing a saved answer retains its data');
  assert.equal(h.warning(), true, 'reopening does not relabel an old-body answer as current');
  assert.deepEqual(pending, pendingBefore); assert.deepEqual(answered, answeredBefore); assert.deepEqual(dispatched, draftBefore);
});

test('memo revision: rejected or unconfirmed synthetic sends preserve current body and the outgoing draft', async t => {
  for (const outcome of ['reject', 'unconfirmed']) await t.test(outcome, async () => {
    const original = deepFreeze(revisionMemo()), snapshot = memoJson(original), draft = deepFreeze(revisionDraft(original));
    const h = memoRevisionHarness(original), sending = h.ask();
    await h.started; h.edit('수락을 기다리며 쓴 본문 B'); h.completeSend(outcome);
    assert.equal(await sending, false);
    assert.equal(h.root._memoRecord.asks.length, 0, 'an unaccepted send does not create a pending ask');
    assert.equal(h.root._memoRecord.text, '수락을 기다리며 쓴 본문 B');
    assert.equal(h.editorText(), '수락을 기다리며 쓴 본문 B');
    assert.equal(h.state.codex.threadDrafts['dm-rio'], draft.text, 'the original question remains available in the recipient room');
    assert.equal(h.state.codex.threadDrafts['unrelated-room'], '이전부터 쓰던 다른 방 초안');
    assert.deepEqual(original, snapshot);
  });
});

test('memo revision: duplicate, cancellation and another Agent still cannot attach an answer', async t => {
  await t.test('duplicate completion and unknown request', async () => {
    const h = memoRevisionHarness(); await acceptMemoQuestion(h); h.edit('본문 B'); h.attach();
    const attached = deepFreeze(h.root._memoRecord), before = memoJson(attached);
    h.attach(); h.attach(fakeCompletedMemoRun({ requestId: 'other-request', answerId: 'other-answer' }));
    assert.equal(h.root._memoRecord, attached); assert.deepEqual(attached, before);
    assert.equal(h.root._memoRecord.replies.length, 1);
  });
  for (const ended of ['cancelled', 'failed', 'interrupted', 'unavailable']) await t.test(ended, async () => {
    const h = memoRevisionHarness(); await acceptMemoQuestion(h); h.edit('본문 B');
    h.attach(fakeCompletedMemoRun({ status: ended }));
    const cancelled = deepFreeze(h.root._memoRecord), before = memoJson(cancelled);
    h.attach();
    assert.equal(cancelled.asks[0].status, 'cancelled');
    assert.equal(h.root._memoRecord, cancelled); assert.deepEqual(cancelled, before);
    assert.equal(cancelled.replies.length, 0); assert.doesNotMatch(h.replyText(), oldMemoAnswer);
  });
  await t.test('explicit cancel and wrong Agent', async () => {
    const h = memoRevisionHarness(); await acceptMemoQuestion(h); h.edit('본문 B');
    const pending = deepFreeze(h.root._memoRecord), before = memoJson(pending);
    const wrong = Memo.appendMemoReply(pending, { author: { kind: 'agent', agentId: 'mina' }, ...Memo.memoReplyFromRun(fakeCompletedMemoRun()), askId: pending.asks[0].askId });
    assert.equal(wrong.appended, false); assert.equal(wrong.memo, pending); assert.deepEqual(pending, before);
    h.set(Memo.cancelMemoAsk(pending, pending.asks[0].askId));
    const cancelled = deepFreeze(h.root._memoRecord); h.attach();
    assert.equal(h.root._memoRecord, cancelled); assert.equal(cancelled.replies.length, 0);
  });
});

test('memo revision: legacy unknown basis and human replies never get an older-body warning', async () => {
  const h = memoRevisionHarness(); await acceptMemoQuestion(h); h.attach();
  const legacy = memoJson(h.root._memoRecord);
  for (const item of [...legacy.asks, ...legacy.replies]) delete item.basedOnMemoRevision;
  h.set(Memo.normalizeMemoRecord(legacy, { now: 1 })); h.edit('본문 B');
  assert.equal(h.warning(), false, 'missing historical basis is unknown, not evidence of an older body');
  const originalBasis = revisionDraft(revisionMemo()).basedOnMemoRevision;
  const withHuman = memoJson(Memo.appendMemoReply(h.root._memoRecord, { author: { kind: 'user' }, text: '사람 답글' }).memo);
  withHuman.replies.at(-1).basedOnMemoRevision = originalBasis;
  h.set(Memo.normalizeMemoRecord(withHuman, { now: 1 })); h.restore();
  assert.doesNotMatch(h.replyText(), oldMemoAnswer, 'unknown Agent basis and a human reply are not mislabeled after restore');
});

test('memo revision: first new legacy question keeps its submitted basis across acceptance edits without guessing history', async t => {
  for (const history of [false, true]) await t.test(history ? 'unknown historical answer, then A→B→A' : 'no historical answers, then A→B', async () => {
    const raw = memoJson(revisionMemo());
    delete raw.revision;
    if (history) {
      raw.asks = [{ askId: 'legacy-ask', agentId: 'rio', status: 'answered', answerId: 'legacy-answer', requestId: 'legacy-request' }];
      raw.replies = [{ id: 'legacy-reply', author: { kind: 'agent', agentId: 'rio', name: 'Rio' }, text: '기반을 모르는 옛 답', askId: 'legacy-ask', answerId: 'legacy-answer' }];
    }
    const original = deepFreeze(Memo.normalizeMemoRecord(raw, { now: 1 })), before = memoJson(original);
    assert.equal(Object.hasOwn(original, 'revision'), false, 'the fixture really has no memo revision');
    const submitted = deepFreeze(revisionDraft(original)), draftBefore = memoJson(submitted);
    assert.notEqual(submitted.basedOnMemoRevision, undefined, 'a newly observed body has its own new-question basis');
    const h = memoRevisionHarness(original);
    await acceptMemoQuestion(h, () => { h.edit('본문 B'); if (history) h.edit('본문 A'); });
    const accepted = h.root._memoRecord.asks.find(ask => ask.requestId === 'request-1');
    assert.deepEqual(accepted.basedOnMemoRevision, submitted.basedOnMemoRevision, 'acceptance cannot borrow the edited body revision');
    assert.notDeepEqual(revisionDraft(h.root._memoRecord).basedOnMemoRevision, submitted.basedOnMemoRevision);
    h.restore(); h.attach(); h.restore();
    const reply = h.root._memoRecord.replies.find(item => item.answerId === 'answer-7');
    assert.equal(reply.askId, accepted.askId);
    assert.deepEqual(reply.basedOnMemoRevision, submitted.basedOnMemoRevision);
    assert.equal(h.warning(), true, 'the new answer is for the body submitted before the acceptance edit');
    if (history) {
      assert.deepEqual(h.root._memoRecord.asks.find(ask => ask.askId === 'legacy-ask'), before.asks[0]);
      assert.deepEqual(h.root._memoRecord.replies.find(item => item.answerId === 'legacy-answer'), before.replies[0]);
      assert.equal(h.warning('legacy-answer'), false, 'the new baseline must not invent historical provenance');
    }
    assert.equal(h.sent[0].text, submitted.text);
    assert.deepEqual(original, before); assert.deepEqual(submitted, draftBefore);
  });
});

test('memo revision: pure-state overlapping requests to one Agent keep distinct bases when answers arrive in reverse order', () => {
  // Two accepted records are constructed with the existing state API. This is
  // not a claim that a busy Agent room permits two concurrent UI sends.
  const original = deepFreeze(revisionMemo()), originalBefore = memoJson(original);
  const a = deepFreeze(revisionDraft(original));
  let memo = Memo.recordMemoAsk(original, a, { requestId: 'overlap-a', threadId: 'dm-rio', now: 2 });
  memo = Memo.editMemoText(memo, '본문 B', { now: 3 });
  const b = deepFreeze(revisionDraft(memo));
  assert.notEqual(a.askId, b.askId); assert.equal(a.agentId, b.agentId);
  assert.notDeepEqual(a.basedOnMemoRevision, b.basedOnMemoRevision);
  memo = deepFreeze(Memo.recordMemoAsk(memo, b, { requestId: 'overlap-b', threadId: 'dm-rio', now: 4 }));
  const pendingBefore = memoJson(memo), draftsBefore = memoJson([a, b]);
  const h = memoRevisionHarness(memo);
  const runB = deepFreeze(fakeCompletedMemoRun({ requestId: 'overlap-b', answerId: 'answer-b', runId: 'run-b' }));
  const runA = deepFreeze(fakeCompletedMemoRun({ requestId: 'overlap-a', answerId: 'answer-a', runId: 'run-a' }));
  h.attach(runB);
  assert.equal(h.root._memoRecord.asks.find(ask => ask.askId === a.askId).status, 'pending');
  assert.equal(h.root._memoRecord.asks.find(ask => ask.askId === b.askId).answerId, 'answer-b');
  assert.equal(h.warning('answer-b'), false);
  h.attach(runA);
  for (const [draft, answerId] of [[a, 'answer-a'], [b, 'answer-b']]) {
    const reply = h.root._memoRecord.replies.find(item => item.answerId === answerId);
    const ask = h.root._memoRecord.asks.find(item => item.askId === draft.askId);
    assert.equal(reply.askId, draft.askId); assert.deepEqual(reply.basedOnMemoRevision, draft.basedOnMemoRevision);
    assert.equal(ask.status, 'answered'); assert.equal(ask.answerId, answerId);
    assert.deepEqual(ask.basedOnMemoRevision, draft.basedOnMemoRevision);
  }
  assert.deepEqual(h.root._memoRecord.replies.map(reply => reply.answerId), ['answer-b', 'answer-a']);
  h.restore();
  assert.equal(h.warning('answer-a'), true); assert.equal(h.warning('answer-b'), false);
  const done = h.root._memoRecord; h.attach(runA); h.attach(runB);
  assert.equal(h.root._memoRecord, done, 'duplicate completions do not reconnect either request');
  assert.deepEqual(original, originalBefore); assert.deepEqual(memo, pendingBefore); assert.deepEqual([a, b], draftsBefore);
});

function memoInputFixture(record, emptyProfiles) {
  const created = [], roots = [], timers = new Map();
  const counts = { choices: 0, profileReads: 0, profileLoads: 0, options: 0, sends: 0 };
  const el = (tag, attrs, ...children) => {
    if (tag === 'option') counts.options += 1;
    const node = memoRuntimeElement(tag, attrs, ...children); created.push(node); return node;
  };
  const profiles = emptyProfiles ? [] : [{ id: 'rio', name: 'Rio', server: true }];
  const document = {
    activeElement: null,
    getElementById: id => id === 'egd-canvas-layer' ? { children: [] } : null,
    querySelectorAll: selector => selector === '.egd-memo-card' ? roots : [],
  };
  let timerId = 0;
  const scope = {
    MemoState: Memo, el, document, TAG: 'memo-input-regression', console: { warn() {} },
    state: { codex: { threads: [], threadDrafts: {}, chatProtocol: { requests: {} } }, codexBridge: {
      loadProfiles() { counts.profileLoads += 1; },
      sendMessage() { counts.sends += 1; throw new Error('No transport in the input fixture'); },
    } },
    codexAgentProfileChoices() { counts.choices += 1; return profiles; },
    codexAgentProfile(id) { counts.profileReads += 1; return profiles.find(profile => profile.id === id); },
    codexProfileAvatar: (_avatar, name) => el('span', {}, name), formatMessageTime: () => '합성 시각',
    markAgendaDirty() {}, boardNotice(message) { throw new Error(message); },
    window: { addEventListener() {}, removeEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 0,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    spawnDeskWindowShell(options) {
      const identity = el('div'), actions = el('div'), topbar = el('div', {}, identity, actions);
      const toolbar = el('div'), header = el('div', {}, topbar, toolbar), content = el('div');
      const root = el('div', { isConnected: true, style: options.style }, header, content);
      root.querySelector = selector => created.find(node => node.classList.has(selector.slice(1))) || null;
      const shell = { root, slots: { identity, actions, topbar, toolbar, header, content }, resizeHits: [], registerCleanup() {} };
      root._deskWindowShell = shell; roots.push(root); return shell;
    },
  };
  const start = memoSurfaceSource.indexOf('  const MEMO_RUN_ENDED =');
  const end = memoSurfaceSource.indexOf('  // Dock [메모]', start);
  assert.ok(start >= 0 && end > start);
  const spawn = Function(...Object.keys(scope), `let cardSeq = 0;\n${memoSurfaceSource.slice(start, end)}\nreturn spawnMemoCard;`)(...Object.values(scope));
  const root = spawn({ record, restore: true }), textarea = root.querySelector('.egd-memo-text');
  const containers = ['.egd-memo-ask-agent', '.egd-memo-thread', '.egd-memo-ask-status'].map(selector => root.querySelector(selector));
  const row = answerId => containers[1].children.find(node => node.dataset.answerId === answerId);
  const visibleText = node => node.hidden ? '' : node.children ? node.children.map(visibleText).join('') : node.textContent || '';
  return { root, textarea, counts, containers,
    input(text) { document.activeElement = textarea; textarea.value = text; textarea.oninput({ target: textarea, isComposing: false }); },
    flush() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); },
    warning(answerId) { assert.ok(row(answerId)); return oldMemoAnswer.test(visibleText(row(answerId))); },
  };
}

test('memo input: 60 body events update revision guidance without rebuilding unrelated UI or querying empty profiles', async t => {
  for (const emptyProfiles of [true, false]) await t.test(emptyProfiles ? 'empty profiles and thread' : 'older/current answers and pending ask', () => {
    let record = revisionMemo();
    if (!emptyProfiles) {
      const first = revisionDraft(record);
      record = Memo.recordMemoAsk(record, first, { requestId: 'input-a', threadId: 'dm-rio' });
      record = Memo.editMemoText(record, '본문 B');
      const second = revisionDraft(record);
      record = Memo.recordMemoAsk(record, second, { requestId: 'input-b', threadId: 'dm-rio' });
      for (const [draft, answerId] of [[first, 'input-answer-a'], [second, 'input-answer-b']]) {
        record = Memo.appendMemoReply(record, { author: { kind: 'agent', agentId: 'rio', name: 'Rio' }, text: '보존할 답 원문', askId: draft.askId, answerId }).memo;
      }
      record = Memo.recordMemoAsk(record, revisionDraft(record), { requestId: 'input-pending', threadId: 'dm-rio' });
    }
    const h = memoInputFixture(record, emptyProfiles), before = { ...h.counts };
    const collection = h.containers.map(node => ({ node, replacements: node.replacements, children: [...node.children] }));
    if (!emptyProfiles) { assert.equal(h.warning('input-answer-a'), true); assert.equal(h.warning('input-answer-b'), false); }
    for (let n = 1; n <= 60; n++) h.input(record.text + 'x'.repeat(n));
    const delta = Object.fromEntries(Object.keys(before).map(key => [key, h.counts[key] - before[key]]));
    t.diagnostic(JSON.stringify({ fixture: emptyProfiles ? 'empty-profile-input' : 'answered-and-pending-input', inputEvents: 60, ...delta,
      collectionReplacements: h.containers.map((node, index) => node.replacements - collection[index].replacements) }));
    assert.deepEqual(delta, { choices: 0, profileReads: 0, profileLoads: 0, options: 0, sends: 0 });
    const unchanged = () => {
      for (const saved of collection) {
        assert.equal(saved.node.replacements, saved.replacements, 'body input does not replace the select/thread/pending collection');
        assert.equal(saved.node.children.length, saved.children.length);
        saved.children.forEach((node, index) => assert.equal(saved.node.children[index], node, 'existing options, reply rows and pending controls retain identity'));
      }
    };
    unchanged(); h.flush(); unchanged();
    assert.deepEqual(h.counts, before, 'the delayed body save also avoids unrelated rebuilds and profile queries');
    assert.equal(h.root._memoRecord.text, record.text + 'x'.repeat(60));
    if (!emptyProfiles) { assert.equal(h.warning('input-answer-a'), true); assert.equal(h.warning('input-answer-b'), true, 'the same current-answer row changes to older-body guidance'); }
  });
});
