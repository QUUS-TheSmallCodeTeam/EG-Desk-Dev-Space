// CNV-06 memo ↔ target window: the tether line, a memo placed beside its
// target, the remembered target name and the '답 기다리는 중' elapsed label.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Memo from '../overlay/resources/EGDeskMemoState.sys.mjs';
import * as SurfaceState from '../overlay/resources/EGDeskSurfaceState.sys.mjs';

const card = { id: 'egd-card-1', label: '보고서 폴더', rect: { x: 100, y: 100, width: 600, height: 400 } };

test('memo tether: a line runs from the memo edge to the target edge and is absent when they overlap', () => {
  const memo = { x: 800, y: 200, width: 240, height: 160 };
  const line = Memo.memoTetherSegment(memo, card.rect);
  // Centres: memo (920, 280), target (400, 300). The line leaves the memo's left edge and reaches the target's right edge.
  assert.equal(line.x1, 800);
  assert.equal(line.x2, 700);
  assert.ok(line.y1 > 280 && line.y1 < 290 && line.y2 > line.y1 && line.y2 < 300, 'both ends lie on the centre line');
  assert.ok(Math.abs(line.length - Math.hypot(line.x2 - line.x1, line.y2 - line.y1)) < 0.2);
  assert.ok(Math.abs(Math.abs(line.angle) - 180) < 3, 'the line points left toward the target');
  // A memo lying on its target (the on-card pin) needs no line: the badge names the target.
  assert.equal(Memo.memoTetherSegment({ x: 440, y: 148, width: 240, height: 160 }, card.rect), null);
  // Straddling the target edge: the memo edge is already inside the target.
  assert.equal(Memo.memoTetherSegment({ x: 620, y: 200, width: 240, height: 160 }, card.rect), null);
  // Touching side by side: shorter than the minimum is not drawn.
  assert.equal(Memo.memoTetherSegment({ x: 704, y: 200, width: 240, height: 160 }, card.rect), null);
  assert.equal(Memo.memoTetherSegment(memo, null), null);
  assert.equal(Memo.memoTetherSegment({ x: NaN, y: 0, width: 240, height: 160 }, card.rect), null);
  // Above the target: the line is vertical.
  const above = Memo.memoTetherSegment({ x: 280, y: -200, width: 240, height: 160 }, card.rect);
  assert.deepEqual([above.x1, above.y1, above.x2, above.y2, above.angle], [400, -40, 400, 100, 90]);
});

test('memo beside its target: stays attached outside the window and follows its nearest edge on move and resize', () => {
  const memo = Memo.createMemoRecord({ id: 'memo-1', seq: 1, point: { x: 724, y: 148 }, target: card, cards: [card], now: 10 });
  assert.deepEqual(memo.anchor, { kind: 'card', cardId: 'egd-card-1', x: 1, y: 0.12, at: { x: 724, y: 148 }, offset: { x: 24, y: 0 }, label: '보고서 폴더' });
  assert.deepEqual(Memo.memoPosition(memo, [card]), { x: 724, y: 148, attached: true, missing: false });
  const moved = [{ id: card.id, rect: { x: 300, y: 100, width: 600, height: 400 } }];
  assert.deepEqual(Memo.memoPosition(memo, moved), { x: 924, y: 148, attached: true, missing: false });
  const wider = [{ id: card.id, rect: { x: 100, y: 100, width: 900, height: 400 } }];
  assert.deepEqual(Memo.memoPosition(memo, wider), { x: 1024, y: 148, attached: true, missing: false }, 'the gap to the window edge is kept, not scaled');
  assert.deepEqual(Memo.memoPosition(memo, []), { x: 724, y: 148, attached: false, missing: true });
  // Saved and restored unchanged.
  assert.deepEqual(Memo.normalizeMemoRecord(JSON.parse(JSON.stringify(memo))).anchor, memo.anchor);
  // A point inside the target is the ordinary on-card pin: no offset.
  const inside = Memo.createMemoRecord({ id: 'memo-2', point: { x: 250, y: 300 }, target: { id: card.id, rect: card.rect }, now: 10 });
  assert.deepEqual(inside.anchor, { kind: 'card', cardId: 'egd-card-1', x: 0.25, y: 0.5, at: { x: 250, y: 300 } });
  // Without a target the point decides, as before.
  assert.deepEqual(Memo.createMemoRecord({ id: 'memo-3', point: { x: 724, y: 148 }, cards: [card], now: 10 }).anchor, { kind: 'canvas', x: 724, y: 148 });
  assert.throws(() => Memo.createMemoRecord({ id: 'memo-4', point: { x: 0, y: 0 }, target: { id: '../x', rect: card.rect } }), /자리가 없습니다/);
});

test('memo move: a memo beside its window stays linked on empty Canvas, re-pins on another window, and an on-card memo still comes free', () => {
  const other = { id: 'egd-card-2', label: 'Chat', rect: { x: 1200, y: 100, width: 400, height: 400 } };
  const beside = Memo.createMemoRecord({ id: 'memo-1', point: { x: 724, y: 148 }, target: card, now: 10 });
  const nudged = Memo.moveMemo(beside, { x: 760, y: 560 }, [card, other], { now: 20 });
  assert.deepEqual(nudged.anchor, { kind: 'card', cardId: 'egd-card-1', x: 1, y: 1, at: { x: 760, y: 560 }, offset: { x: 60, y: 60 }, label: '보고서 폴더' });
  assert.equal(nudged.updatedAt, 20);
  const repinned = Memo.moveMemo(beside, { x: 1300, y: 200 }, [card, other], { now: 20 });
  assert.deepEqual(repinned.anchor, { kind: 'card', cardId: 'egd-card-2', x: 0.25, y: 0.25, at: { x: 1300, y: 200 }, label: 'Chat' });
  assert.deepEqual(Memo.moveMemo(beside, { x: 760, y: 560 }, [other], { now: 20 }).anchor, { kind: 'canvas', x: 760, y: 560 }, 'a closed target cannot hold the memo');
  const onCard = Memo.createMemoRecord({ id: 'memo-2', point: { x: 250, y: 300 }, cards: [card], now: 10 });
  assert.deepEqual(Memo.moveMemo(onCard, { x: 900, y: 900 }, [card, other], { now: 20 }).anchor, { kind: 'canvas', x: 900, y: 900 });
});

test('memo reconnect: [다시 연결] pins the memo where it is to the chosen window and remembers that window name', () => {
  const lost = Memo.normalizeMemoRecord({ id: 'memo-1', anchor: { kind: 'card', cardId: 'closed-card', x: 0.5, y: 0.5, at: { x: 900, y: 50 }, label: '  닫힌\n창  ' }, text: '확인', createdAt: 1 });
  assert.equal(lost.anchor.label, '닫힌 창', 'the remembered name is one clean line');
  assert.equal(Memo.memoPosition(lost, [card]).missing, true);
  const linked = Memo.attachMemoToCard(lost, card, { x: 900, y: 50 }, { now: 30 });
  assert.deepEqual(linked.anchor, { kind: 'card', cardId: 'egd-card-1', x: 1, y: 0, at: { x: 900, y: 50 }, offset: { x: 200, y: -50 }, label: '보고서 폴더' });
  assert.deepEqual(Memo.memoPosition(linked, [card]), { x: 900, y: 50, attached: true, missing: false }, 'the memo does not jump');
  assert.equal(linked.text, '확인');
  assert.equal(linked.updatedAt, 30);
  assert.throws(() => Memo.attachMemoToCard(lost, { id: 'egd-card-1', rect: null }, { x: 0, y: 0 }), /찾을 수 없습니다/);
  assert.throws(() => Memo.attachMemoToCard(lost, { id: lost.id, rect: card.rect }, { x: 0, y: 0 }), /찾을 수 없습니다/);
  // The remembered name is local display data: it never joins an Agent question.
  const draft = Memo.memoAskDraft(linked, { agentId: 'rio', agentName: 'Rio' });
  assert.equal(draft.text.includes('보고서 폴더'), false);
  // Far-away offsets are bounded and a long name is cut.
  const far = Memo.normalizeMemoRecord({ id: 'm', anchor: { kind: 'card', cardId: 'c', x: 0, y: 0, offset: { x: -9e9, y: 12.34 }, label: 'x'.repeat(200) } });
  assert.deepEqual(far.anchor.offset, { x: -Memo.MEMO_ANCHOR_REACH, y: 12.3 });
  assert.equal(far.anchor.label.length, Memo.MEMO_LIMITS.target);
  assert.equal('offset' in Memo.normalizeMemoRecord({ id: 'm', anchor: { kind: 'card', cardId: 'c', x: 0, y: 0, offset: { x: 0, y: 0 } } }).anchor, false);
});

test('memo beside its target: reopening a Board gives the target a new id and the memo keeps its side spot and remembered name', () => {
  const memo = Memo.createMemoRecord({ id: 'memo-1', seq: 1, point: { x: 724, y: 148 }, target: card, now: 10 });
  const reopened = Memo.normalizeMemoRecord(SurfaceState.remapMemberReferences(JSON.parse(JSON.stringify(memo)), { 'egd-card-1': 'projection-1-member-0' }));
  assert.deepEqual(reopened.anchor, { ...memo.anchor, cardId: 'projection-1-member-0' });
  assert.deepEqual(Memo.memoPosition(reopened, [{ id: 'projection-1-member-0', rect: card.rect }]), { x: 724, y: 148, attached: true, missing: false });
  // The old id on another Board's window is not this memo's target.
  assert.equal(Memo.memoPosition(reopened, [card]).missing, true);
});

test('memo wait: the pending row says how long the question has waited, in Korean, without a clock', () => {
  const asked = 1_000_000;
  const at = minutes => asked + minutes * 60_000;
  assert.equal(Memo.memoWaitLabel(asked, asked + 20_000), '방금 물음');
  assert.equal(Memo.memoWaitLabel(asked, at(1)), '1분째');
  assert.equal(Memo.memoWaitLabel(asked, at(59)), '59분째');
  assert.equal(Memo.memoWaitLabel(asked, at(60)), '1시간째');
  assert.equal(Memo.memoWaitLabel(asked, at(72)), '1시간 12분째');
  assert.equal(Memo.memoWaitLabel(asked, at(60 * 24 * 3 + 5)), '3일째');
  assert.equal(Memo.memoWaitLabel(asked, asked - 5000), '방금 물음', 'a clock that moved back never shows a negative wait');
  assert.equal(Memo.memoWaitLabel(undefined, asked), '', 'an ask without a recorded time shows no elapsed text');
  assert.equal(Memo.memoWaitLabel(asked, NaN), '');
});

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
function surfaceFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start, `${name} has a complete body`);
  return source.slice(start, end + 4);
}
function fakeNode(attrs = {}, ...children) {
  const node = { dataset: attrs.data || {}, style: {}, children: [], parentNode: null, hidden: attrs.hidden === true, isConnected: true,
    classList: { contains: name => (attrs.class || '').split(/\s+/).includes(name) }, ...attrs,
    insertBefore(child, before) { child.parentNode = node; node.children.splice(Math.max(0, node.children.indexOf(before)), 0, child); return child; },
    remove() { node.isConnected = false; } };
  for (const child of children.flat()) if (child && typeof child === 'object') { child.parentNode = node; node.children.push(child); }
  node.textContent = children.flat().filter(child => typeof child === 'string').join('');
  return node;
}

test('memo tether wiring: the line is drawn in the Canvas layer for an attached memo and hidden without a target', () => {
  const layer = fakeNode({ id: 'egd-canvas-layer' });
  const target = fakeNode({ id: 'egd-card-1', class: 'egd-canvas-card', geometry: { ...card.rect } });
  const memo = Memo.createMemoRecord({ id: 'memo-1', point: { x: 800, y: 200 }, target: card, now: 10 });
  const root = fakeNode({ id: 'egd-memo-card-1', class: 'egd-canvas-card egd-memo-card', geometry: { x: 800, y: 200, width: 240, height: 160 },
    data: { memoAnchor: 'attached' }, _memoRecord: memo });
  const region = fakeNode({ class: 'egd-board-region' });
  for (const node of [region, target, root]) { node.parentNode = layer; layer.children.push(node); }
  const nodes = new Map([[target.id, target]]);
  const scope = { document: { getElementById: id => nodes.get(id) || null }, MemoState: Memo,
    persistentEntityGeometry: node => node.geometry, el: (tag, attrs) => fakeNode(attrs) };
  const sync = Function(...Object.keys(scope), `${surfaceFunction('syncMemoExtraLinkLines')}\n${surfaceFunction('syncMemoTether')}\nreturn syncMemoTether;`)(...Object.values(scope));
  sync(root);
  const line = root._memoTether;
  assert.deepEqual(layer.children, [region, target, line, root], 'the line sits in the Canvas layer just before its memo: above Board regions, in world coordinates');
  assert.equal(line.class, 'egd-memo-tether');
  assert.equal(line['aria-hidden'], 'true');
  assert.deepEqual([line.hidden, line.style.left, line.style.width], [false, '800px', `${Memo.memoTetherSegment(root.geometry, card.rect).length}px`]);
  assert.match(line.style.transform, /^rotate\(-?\d+(\.\d+)?deg\)$/);
  // The target moved: the same element is re-aimed, not duplicated.
  target.geometry = { x: 100, y: 600, width: 600, height: 400 };
  sync(root);
  assert.equal(root._memoTether, line);
  assert.equal(layer.children.length, 4);
  assert.equal(line.style.top, `${Memo.memoTetherSegment(root.geometry, target.geometry).y1}px`);
  // Target closed ('대상 없음') or a free memo: no line.
  root.dataset.memoAnchor = 'missing';
  sync(root);
  assert.equal(line.hidden, true);
  root.dataset.memoAnchor = 'attached';
  nodes.delete(target.id);
  sync(root);
  assert.equal(line.hidden, true, 'a target that is no longer on the Canvas draws nothing');
  // A hidden memo (its Board is hidden) hides its line as well.
  nodes.set(target.id, target);
  sync(root);
  assert.equal(line.hidden, false);
  root.hidden = true;
  sync(root);
  assert.equal(line.hidden, true);
});

test('memo sync is quiet: repeating it with nothing changed rewrites no text, so the Canvas observer is not woken again', () => {
  // Assigning textContent replaces the text node even for the same string; the
  // memo observer watches child changes in the whole Canvas layer and would
  // re-run this sync on every frame.
  const writes = [];
  const counted = name => {
    let text = '';
    return { hidden: false, title: '', attrs: {}, setAttribute(key, value) { this.attrs[key] = value; },
      get textContent() { return text; }, set textContent(value) { writes.push(name); text = value; } };
  };
  const badge = counted('badge');
  const memo = Memo.createMemoRecord({ id: 'memo-1', point: { x: 724, y: 148 }, target: card, now: 10 });
  const target = { id: card.id, dataset: {}, classList: { contains: () => false }, querySelector: () => null };
  const root = { _memoRecord: memo, isConnected: true, dataset: {}, style: {}, querySelector: selector => selector === '.egd-memo-anchor' ? badge : null,
    _memoMissing: { row: counted('row'), label: counted('label'), relink: counted('relink'), remove: counted('remove') } };
  let cards = [card];
  const scope = { document: { getElementById: id => id === card.id && cards.length ? target : null }, memoAnchorCandidates: () => cards, MemoState: Memo, state: {},
    syncMemoTether() {}, memoTargetLabel: () => cards.length ? card.label : '' };
  const api = Function(...Object.keys(scope), `let memoRelink = null;\n${surfaceFunction('syncMemoCardPosition')}\n${surfaceFunction('syncMemoLinkUi')}\nreturn { syncMemoCardPosition, syncMemoLinkUi };`)(...Object.values(scope));
  const sync = () => { api.syncMemoCardPosition(root); api.syncMemoLinkUi(root); };
  sync();
  assert.deepEqual([root.dataset.memoAnchor, badge.textContent, root._memoMissing.row.hidden], ['attached', '📎 창', true]);
  writes.length = 0;
  sync();
  assert.deepEqual(writes, [], 'an unchanged attached memo writes nothing');
  // Its window closes: the texts change once, then stay quiet again.
  cards = [];
  sync();
  assert.deepEqual([root.dataset.memoAnchor, badge.textContent, root._memoMissing.row.hidden, root._memoMissing.label.textContent, root._memoMissing.relink.textContent],
    ['missing', '대상 없음', false, '원래 창: 보고서 폴더', '다시 연결']);
  writes.length = 0;
  sync();
  assert.deepEqual(writes, [], 'an unchanged 대상 없음 memo writes nothing');
});

test('memo follow: a moved window re-places its memos, a moved memo only re-aims its line, and a memo being dragged is not pulled back', () => {
  let observed = null;
  const frames = [], calls = [], removed = [];
  const has = names => ({ contains: name => names.includes(name) });
  const layer = { id: 'egd-canvas-layer', lines: [], querySelectorAll() { return this.lines; } };
  const memoRoot = { id: 'memo', parentNode: layer, isConnected: true, _memoRecord: {}, classList: has(['egd-canvas-card', 'egd-memo-card']) };
  const windowCard = { id: 'window', parentNode: layer, classList: has(['egd-canvas-card']) };
  const line = { parentNode: layer, classList: has(['egd-memo-tether']), _memoRoot: memoRoot, remove() { removed.push('line'); } };
  const scope = {
    document: { getElementById: id => id === layer.id ? layer : null, querySelectorAll: () => [] }, MemoState: Memo,
    MutationObserver: class { constructor(callback) { observed = callback; } observe() {} },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; }, window: { setInterval() {} },
    memoCards: () => [memoRoot], syncMemoCardPosition: root => calls.push(`position:${root.id}`),
    syncMemoLinkUi: root => calls.push(`link:${root.id}`), syncMemoTether: root => calls.push(`tether:${root.id}`),
  };
  Function(...Object.keys(scope), `let memoAnchorObserver = null;\n${surfaceFunction('ensureMemoAnchorObserver')}\nreturn ensureMemoAnchorObserver;`)(...Object.values(scope))();
  const frame = () => { assert.equal(frames.length, 1, 'one frame is queued'); frames.shift()(); return calls.splice(0); };
  // The memo itself moved (a drag, fold/unfold): only its line follows.
  observed([{ type: 'attributes', target: memoRoot }]);
  assert.deepEqual(frame(), ['tether:memo']);
  // The line being re-aimed does not wake the sync again.
  observed([{ type: 'attributes', target: line }]);
  assert.equal(frames.length, 0);
  // A window moved or resized: its memos are placed again and their line and '대상 없음' row follow.
  observed([{ type: 'attributes', target: windowCard }, { type: 'attributes', target: memoRoot }]);
  assert.deepEqual(frame(), ['position:memo', 'link:memo']);
  // Something inside a window changed style: not a move.
  observed([{ type: 'attributes', target: { parentNode: windowCard, classList: has([]) } }]);
  assert.equal(frames.length, 0);
  // While the user drags the memo, a change elsewhere on the Canvas does not pull it back to its anchor.
  memoRoot._memoDragging = true;
  observed([{ type: 'childList', target: windowCard }]);
  assert.deepEqual(frame(), ['link:memo']);
  delete memoRoot._memoDragging;
  // A line whose memo is gone is removed with the next full pass; a live one stays.
  layer.lines = [line, { _memoRoot: { isConnected: false }, remove() { removed.push('orphan'); } }];
  observed([{ type: 'childList', target: layer }]);
  assert.deepEqual([frame(), removed], [['position:memo', 'link:memo'], ['orphan']]);
});

test('memo open: Dock [메모] opens beside the selected window in a free spot and stays attached to it', () => {
  const selected = fakeNode({ id: 'egd-card-1', class: 'egd-canvas-card', geometry: { ...card.rect } });
  const chat = fakeNode({ id: 'egd-card-2', class: 'egd-canvas-card', geometry: { x: 724, y: 100, width: 400, height: 600 } });
  let spawned = null, revealed = null, focused = null;
  const scope = {
    state: { activeEntityId: 'egd-card-1' }, MemoState: Memo, SurfaceState,
    document: { getElementById: id => id === selected.id ? selected : null, querySelectorAll: () => [selected, chat] },
    persistentEntityGeometry: node => node.geometry, cardLabelForViewportRail: () => card.label,
    safeViewportWorldRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900 }),
    spawnMemoCard: options => { spawned = options; return { querySelector: () => ({ focus() {} }) }; },
    focusCanvasCard: root => { focused = root; }, revealPlacedCanvasCard: (root, placement) => { revealed = placement; },
  };
  const open = Function(...Object.keys(scope), `${surfaceFunction('spawnMemoFromDock')}\nreturn spawnMemoFromDock;`)(...Object.values(scope));
  open();
  assert.deepEqual(spawned.target, { id: 'egd-card-1', label: card.label, rect: card.rect });
  const memoRect = { ...spawned.point, ...Memo.MEMO_FRAME.folded };
  const overlaps = other => memoRect.x < other.x + other.width + 24 && memoRect.x + memoRect.width + 24 > other.x
    && memoRect.y < other.y + other.height + 24 && memoRect.y + memoRect.height + 24 > other.y;
  assert.equal(overlaps(selected.geometry), false, 'the memo does not cover the window it is about');
  assert.equal(overlaps(chat.geometry), false, 'nor the Chat next to it');
  assert.equal(revealed.inView, true);
  assert.ok(focused);
  const memo = Memo.createMemoRecord({ id: 'memo-1', point: spawned.point, target: spawned.target });
  assert.equal(memo.anchor.cardId, 'egd-card-1');
  assert.ok(Memo.memoTetherSegment(memoRect, card.rect), 'a line can be drawn back to the selected window');
  // Nothing selected: a free memo in an empty spot of the visible Canvas.
  scope.state.activeEntityId = null;
  open();
  assert.equal(spawned.target, null);
  const freeRect = { ...spawned.point, ...Memo.MEMO_FRAME.folded };
  assert.equal([selected.geometry, chat.geometry].some(other => freeRect.x < other.x + other.width && freeRect.x + freeRect.width > other.x
    && freeRect.y < other.y + other.height && freeRect.y + freeRect.height > other.y), false);
});

test('memo CSS: folded title is not squeezed by the Board menu text, the tether is a token-coloured line and hides with annotations', () => {
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `rule exists: ${selector}`); return match[1];
  };
  assert.match(rule('.egd-memo-card[data-memo-expanded="false"] .egd-desk-window-board-menu-text'), /display:\s*none/);
  assert.match(rule('.egd-memo-card .egd-memo-title'), /flex:\s*0\s+0\s+auto/, 'the short memo title keeps its full width');
  // A folded memo in a Board: the Board name would run into the title, so it stays in the chevron's tooltip.
  assert.match(rule('.egd-memo-card[data-memo-expanded="false"] .egd-desk-window-board'), /display:\s*none/);  const tether = rule('.egd-memo-tether');
  assert.match(tether, /pointer-events:\s*none/);
  assert.match(tether, /background:\s*var\(--egd-/);
  assert.match(tether, /transform-origin:\s*0\s+50%/);
  assert.match(rule(':root[data-egd-annotations-hidden="true"] .egd-memo-tether'), /display:\s*none/);
  assert.match(rule('.egd-memo-missing[hidden]'), /display:\s*none/);
  for (const selector of ['.egd-memo-missing button:hover', '.egd-memo-missing button:disabled', 'button.egd-memo-ask-open:hover']) rule(selector);
});

test('memo 대상 없음: the row names the closed window and [다시 연결] pins the memo to the next window pressed', () => {
  const listeners = [];
  const windowStub = {
    addEventListener(type, handler, options = {}) { listeners.push({ type, handler, signal: options.signal, once: options.once === true }); },
    setTimeout(handler) { handler(); return 0; },
  };
  const dispatch = (type, event) => {
    const fired = { type, prevented: false, stopped: false, preventDefault() { fired.prevented = true; }, stopPropagation() { fired.stopped = true; }, ...event };
    for (const listener of listeners.filter(item => item.type === type && !item.signal?.aborted && !item.done)) {
      if (listener.once) listener.done = true;
      listener.handler(fired);
    }
    return fired;
  };
  const rootAttrs = new Map();
  const notices = [];
  const part = () => ({ hidden: false, textContent: '', title: '', attrs: {}, focused: 0, setAttribute(name, value) { this.attrs[name] = value; }, focus() { this.focused += 1; } });
  const lost = Memo.normalizeMemoRecord({ id: 'memo-1', anchor: { kind: 'card', cardId: 'closed-card', x: 0.5, y: 0.5, at: { x: 900, y: 50 }, label: '닫힌 창' }, text: '확인', createdAt: 1 });
  const inside = { inside: true };
  const root = { _memoRecord: lost, isConnected: true, offsetLeft: 900, offsetTop: 50, dataset: { memoAnchor: 'missing' },
    _memoAnchorProjectionId: 'projection-1', contains: node => node === inside,
    _memoMissing: { row: part(), label: part(), relink: part(), remove: part() } };
  const windowCard = { id: 'egd-card-1', classList: { contains: () => false } };
  const scope = {
    document: { documentElement: { setAttribute: (name, value) => rootAttrs.set(name, value), removeAttribute: name => rootAttrs.delete(name) } },
    window: windowStub, AbortController, MemoState: Memo, boardNotice: message => notices.push(message),
    persistentEntityGeometry: () => ({ ...card.rect, zIndex: 3 }), cardLabelForViewportRail: () => card.label,
    syncMemoTether() {}, memoTargetLabel: () => card.label,
    updateMemoRecord(target, next, reason) { target._memoRecord = next; target._reason = reason; target.dataset.memoAnchor = 'attached'; },
  };
  const api = Function(...Object.keys(scope), `let memoRelink = null;\n${surfaceFunction('syncMemoLinkUi')}\n${surfaceFunction('relinkMemoTo')}\n${surfaceFunction('toggleMemoRelink')}\nreturn { syncMemoLinkUi, toggleMemoRelink };`)(...Object.values(scope));
  const parts = root._memoMissing;

  api.syncMemoLinkUi(root);
  assert.deepEqual([parts.row.hidden, parts.label.textContent, parts.relink.textContent, parts.remove.hidden], [false, '원래 창: 닫힌 창', '다시 연결', false]);
  assert.equal(parts.relink.attrs['aria-pressed'], 'false');

  // Waiting for a window: the row says what to do, Esc cancels and nothing changes.
  api.toggleMemoRelink(root);
  assert.deepEqual([parts.label.textContent, parts.relink.textContent, parts.relink.attrs['aria-pressed'], parts.remove.hidden], ['연결할 창을 누르세요 · Esc 취소', '취소', 'true', true]);
  assert.equal(rootAttrs.get('data-egd-memo-relinking'), 'true');
  assert.equal(dispatch('keydown', { key: 'a' }).prevented, false, 'other keys pass through');
  const escape = dispatch('keydown', { key: 'Escape' });
  assert.deepEqual([escape.prevented, escape.stopped, parts.relink.focused], [true, true, 1], 'Esc closes only this mode and returns focus to the button');
  assert.deepEqual([parts.label.textContent, parts.relink.textContent, rootAttrs.has('data-egd-memo-relinking'), root._memoRecord], ['원래 창: 닫힌 창', '다시 연결', false, lost]);
  assert.equal(dispatch('mousedown', { button: 0, target: { closest: () => windowCard } }).prevented, false, 'a press after Esc is an ordinary press');

  // The button again cancels too; a press inside the memo itself is not a choice.
  api.toggleMemoRelink(root);
  assert.equal(dispatch('mousedown', { button: 0, target: inside }).prevented, false);
  api.toggleMemoRelink(root);
  assert.deepEqual([parts.relink.textContent, rootAttrs.has('data-egd-memo-relinking')], ['다시 연결', false]);

  // A press on empty Canvas leaves the memo as it was and says so.
  api.toggleMemoRelink(root);
  const empty = dispatch('mousedown', { button: 0, target: { closest: () => null } });
  assert.deepEqual([empty.prevented, root._memoRecord, notices], [true, lost, ['창을 누르지 않아 메모를 연결하지 않았습니다.']]);
  dispatch('mouseup', {});

  // The next window pressed becomes the target; that press does nothing else in the window.
  api.toggleMemoRelink(root);
  const press = dispatch('mousedown', { button: 0, target: { closest: selector => selector === '.egd-canvas-card' ? windowCard : null } });
  assert.deepEqual([press.prevented, press.stopped], [true, true]);
  assert.deepEqual(root._memoRecord.anchor, { kind: 'card', cardId: 'egd-card-1', x: 1, y: 0, at: { x: 900, y: 50 }, offset: { x: 200, y: -50 }, label: card.label });
  assert.deepEqual([root._reason, '_memoAnchorProjectionId' in root], ['memo-relink', false]);
  assert.equal(dispatch('click', {}).prevented, true, 'the click of that press is swallowed');
  dispatch('mouseup', {});
  assert.equal(dispatch('click', {}).prevented, false, 'later clicks work normally');
  api.syncMemoLinkUi(root);
  assert.deepEqual([parts.row.hidden, rootAttrs.has('data-egd-memo-relinking')], [true, false], 'attached again: the row is gone');
});

test('memo 답 기다리는 중: the pending row shows the elapsed time and [Chat에서 보기] next to [기다리지 않기]', () => {
  const render = surfaceFunction('renderMemoCard');
  const pendingRow = render.slice(render.indexOf("class: 'egd-memo-ask-pending'"), render.indexOf("'기다리지 않기'"));
  assert.match(pendingRow, /MemoState\.memoWaitLabel\(ask\.askedAt, now\)/);
  assert.match(pendingRow, /class: 'egd-memo-ask-elapsed'[^\n]*datetime: new Date\(ask\.askedAt\)\.toISOString\(\)/);
  assert.match(pendingRow, /class: 'egd-memo-ask-open'[^\n]*title: '이 질문을 보낸 Chat 대화를 엽니다\.'/);
  assert.match(pendingRow, /openMemoAskInChat\(ask\); \} \}, 'Chat에서 보기'\)/);
  // [Chat에서 보기] opens the conversation the question went out in, else that Agent's room, and says so when neither is left.
  const opened = [], notices = [];
  const threads = [{ id: 'thread-dm', type: 'dm', profileEnabled: true, agentProfileId: 'rio', updatedAt: 5 }, { id: 'thread-asked', type: 'dm', profileEnabled: true, agentProfileId: 'rio', updatedAt: 1 }];
  const chatCard = { id: 'chat-card' };
  const scope = {
    state: { codex: { threads, hudView: 'list' }, codexBridge: { selectThread: (id, options) => opened.push([id, options]) }, focusChatDockIfCompact: () => false },
    boardNotice: message => notices.push(message), dismissChatReturnCue() {}, spawnCodexChatCard: () => chatCard,
    focusCanvasCard: target => opened.push(['focus', target.id]), revealOpenCanvasCard: target => opened.push(['reveal', target.id]),
  };
  const open = Function(...Object.keys(scope), `${surfaceFunction('memoAgentThread')}\n${surfaceFunction('openMemoAskInChat')}\nreturn openMemoAskInChat;`)(...Object.values(scope));
  assert.equal(open({ askId: 'a1', agentId: 'rio', threadId: 'thread-asked' }), true);
  assert.deepEqual(opened, [['thread-asked', { openConversation: true }], ['focus', 'chat-card'], ['reveal', 'chat-card']]);
  assert.equal(scope.state.codex.hudView, 'conversation');
  opened.length = 0;
  assert.equal(open({ askId: 'a2', agentId: 'rio', threadId: 'thread-deleted' }), true);
  assert.deepEqual(opened[0], ['thread-dm', { openConversation: true }], 'falls back to that Agent\'s current room');
  opened.length = 0;
  assert.equal(open({ askId: 'a3', agentId: 'mina' }), false);
  assert.deepEqual([opened, notices], [[], ['이 질문을 보낸 대화를 찾을 수 없습니다. 대화방이 지워졌을 수 있습니다.']]);
});
