// DSN-04 · UX-05 · UX-06 keyboard rules (overlay/resources/surface/EGDeskSurfaceKeys.mjs)
// and how the surface file wires them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Keys from '../overlay/resources/surface/EGDeskSurfaceKeys.mjs';
import * as LayerStack from '../overlay/resources/EGDeskLayerStack.sys.mjs';
import * as ViewportExtras from '../overlay/resources/EGDeskViewportExtras.sys.mjs';

const surfaceJs = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');

test('UX-06 registry: one list in the agreed Escape order, every kind in a known tier', () => {
  const tiers = Keys.ESCAPE_LAYER_REGISTRY.map(layer => Keys.escapeTierOf(layer.kind));
  // 작은 메뉴 → 확인창 → 검색 결과·Board 목록·기록 패널·미니맵 → 크게 띄운 창 위 Chat → 원래 크기
  const firstOf = tier => tiers.indexOf(tier);
  assert.deepEqual(Keys.ESCAPE_TIERS.map(firstOf), [...Keys.ESCAPE_TIERS.map(firstOf)].sort((a, b) => a - b), 'listed tier by tier');
  for (const layer of Keys.ESCAPE_LAYER_REGISTRY) {
    assert.ok(Keys.ESCAPE_TIERS.includes(Keys.escapeTierOf(layer.kind)), layer.id);
    assert.equal(LayerStack.escapeRank(layer.kind), Keys.ESCAPE_TIERS.indexOf(Keys.escapeTierOf(layer.kind)), `${layer.id}: same rank as the stack`);
    assert.match(layer.label, /[가-힣]/, `${layer.id}: Korean label`);
  }
  assert.equal(new Set(Keys.ESCAPE_LAYER_REGISTRY.map(layer => layer.id)).size, Keys.ESCAPE_LAYER_REGISTRY.length);
  const order = Keys.escapeCloseOrder();
  assert.equal(order[0], 'minimap-stack', 'inside a tier the newest registration closes first');
  assert.deepEqual(order.slice(-3), ['chat-peek', 'view-fullscreen', 'focus-view']);
  assert.ok(order.indexOf('board-close-guard') < order.indexOf('rail-search'));
  assert.ok(order.indexOf('rail-search') < order.indexOf('minimap'), 'search results before the minimap');
  assert.throws(() => Keys.registeredEscapeLayer('nope', 'menu'), /not in ESCAPE_LAYER_REGISTRY/);
  assert.throws(() => Keys.registeredEscapeLayer('minimap', 'menu'), /is minimap, not menu/);
  assert.equal(Keys.registeredEscapeLayer('chat-peek', 'peek').label, '크게 띄운 창 위 Chat');
  assert.deepEqual(Keys.escapeRegistryGaps(['chat-peek', 'other']).unknown, ['other']);
});

test('UX-06 peek and focus view: only a peek is closed by Escape; 집중 보기 ends from a page that left Escape unused', () => {
  assert.equal(Keys.chatPeekEscapeOpen({ fullscreen: true, mode: 'maximized', hudMode: 'peek' }), true);
  assert.equal(Keys.chatPeekEscapeOpen({ fullscreen: true, mode: 'maximized', hudMode: 'pinned' }), false);
  assert.equal(Keys.chatPeekEscapeOpen({ fullscreen: true, mode: 'focus', hudMode: 'peek' }), false);
  assert.equal(Keys.chatPeekEscapeOpen({ fullscreen: false, hudMode: 'peek' }), false);
  const base = { key: 'Escape', mode: 'focus', topKind: 'focus' };
  assert.deepEqual(Keys.focusViewEscapeRoute(base), { act: true, reason: 'focus-view' });
  assert.equal(Keys.focusViewEscapeRoute({ ...base, topKind: null }).act, true);
  for (const [extra, reason] of [[{ key: 'Enter' }, 'not-escape'], [{ mode: 'maximized' }, 'not-focus-view'],
    [{ initialBrowserFocus: true }, 'first-run-focus'], [{ composing: true }, 'composing'], [{ defaultPrevented: true }, 'already-handled'],
    [{ repeat: true }, 'held'], [{ topKind: 'menu' }, 'layer-above']]) {
    assert.deepEqual(Keys.focusViewEscapeRoute({ ...base, ...extra }), { act: false, reason });
  }
});

test('DSN-04 roving tabindex: one stop, last focused remembered, skipped items never hold it, arrows wrap', () => {
  assert.deepEqual(Keys.rovingTabIndexes({ count: 3 }), [0, -1, -1]);
  assert.deepEqual(Keys.rovingTabIndexes({ count: 3, isSkipped: i => i === 0 }), [-1, 0, -1]);
  assert.deepEqual(Keys.rovingTabIndexes({ count: 3, lastFocused: 2 }), [-1, -1, 0]);
  assert.deepEqual(Keys.rovingTabIndexes({ count: 3, focused: 1, lastFocused: 2 }), [-1, 0, -1]);
  assert.deepEqual(Keys.rovingTabIndexes({ count: 2, isSkipped: () => true }), [-1, -1]);
  assert.equal(Keys.rovingNextIndex('ArrowRight', { count: 3, current: 2 }), 0);
  assert.equal(Keys.rovingNextIndex('ArrowLeft', { count: 3, current: 0 }), 2);
  assert.equal(Keys.rovingNextIndex('ArrowRight', { count: 3, current: 0, isSkipped: i => i === 1 }), 2);
  assert.equal(Keys.rovingNextIndex('ArrowRight', { count: 3, current: 2, loop: false }), 2);
  assert.equal(Keys.rovingNextIndex('Home', { count: 3, current: 2, isSkipped: i => i === 0 }), 1);
  assert.equal(Keys.rovingNextIndex('End', { count: 3, current: 0 }), 2);
  assert.equal(Keys.rovingNextIndex('Tab', { count: 3, current: 0 }), null);
});

test('DSN-04 keyboard tooltip: the short name, not the long help, and none when the button already shows it', () => {
  assert.equal(Keys.keyboardTooltipText({ ariaLabel: ' 미니맵 ', title: 'x' }), '미니맵');
  assert.equal(Keys.keyboardTooltipText({ title: '집중 보기 — 상단 바와 Dock을 숨기고 화면 전체로 봅니다' }), '집중 보기');
  assert.equal(Keys.keyboardTooltipText({ text: '  맞춤 ' }), '맞춤');
  assert.equal(Keys.keyboardTooltipText({}), '');
  assert.equal(Keys.keyboardTooltipText({ ariaLabel: '가'.repeat(100) }).length, 80);
  assert.equal(Keys.keyboardTooltipNeeded({ name: '맞춤', visibleText: ' 맞춤' }), false);
  assert.equal(Keys.keyboardTooltipNeeded({ name: '창 닫기', visibleText: '' }), true);
  const viewport = { width: 1000, height: 800 };
  assert.deepEqual(Keys.keyboardTooltipPosition({ left: 100, top: 10, width: 20, height: 20 }, { width: 60, height: 20 }, viewport),
    { side: 'below', left: 80, top: 36 });
  assert.deepEqual(Keys.keyboardTooltipPosition({ left: 990, top: 760, width: 20, height: 20 }, { width: 60, height: 20 }, viewport),
    { side: 'above', left: 936, top: 734 }, 'Dock buttons: above, kept on screen');
});

test('UX-05 header keys: arrows on the 24px grid, Shift five cells, Option/Alt 1px free, Shift+Space selects', () => {
  const move = key => Keys.windowHeaderKeyAction({ key });
  assert.deepEqual(move('ArrowRight'), { type: 'move', dx: 1, dy: 0, shift: false, free: false });
  assert.deepEqual(Keys.windowHeaderKeyAction({ key: 'ArrowUp', shiftKey: true, altKey: true }), { type: 'move', dx: 0, dy: -1, shift: true, free: true });
  assert.deepEqual(Keys.windowHeaderKeyAction({ key: ' ', shiftKey: true }), { type: 'select-toggle' });
  for (const event of [{ key: ' ' }, { key: 'ArrowLeft', metaKey: true }, { key: 'ArrowLeft', ctrlKey: true }, { key: 'ArrowLeft', isComposing: true },
    { key: 'ArrowLeft', keyCode: 229 }, { key: 'Enter' }, { key: 'z', metaKey: true }]) assert.equal(Keys.windowHeaderKeyAction(event), null, JSON.stringify(event));
  const at = (rect, key, extra = {}, options = {}) => Keys.windowKeyMove(rect, Keys.windowHeaderKeyAction({ key, ...extra }), options);
  assert.deepEqual(at({ x: 48, y: 24 }, 'ArrowRight'), { x: 72, y: 24 });
  assert.deepEqual(at({ x: 48, y: 24 }, 'ArrowLeft'), { x: 24, y: 24 });
  assert.deepEqual(at({ x: 10, y: 24 }, 'ArrowRight'), { x: 24, y: 24 }, 'off-grid: first press lands on the line ahead');
  assert.deepEqual(at({ x: 10, y: 24 }, 'ArrowLeft'), { x: 0, y: 24 });
  assert.deepEqual(at({ x: 10, y: 30 }, 'ArrowDown'), { x: 10, y: 48 }, 'only the moved axis snaps');
  assert.deepEqual(at({ x: 48, y: 24 }, 'ArrowRight', { shiftKey: true }), { x: 168, y: 24 });
  assert.deepEqual(at({ x: 10, y: 24 }, 'ArrowRight', { shiftKey: true }), { x: 120, y: 24 });
  assert.deepEqual(at({ x: 10, y: 24 }, 'ArrowRight', { altKey: true }), { x: 11, y: 24 }, 'Option/Alt: 1px, no grid');
  assert.deepEqual(at({ x: 10, y: 24 }, 'ArrowRight', {}, { snap: false }), { x: 34, y: 24 }, '[맞춤] off: plain 24px steps');
  assert.equal(Keys.windowKeyMove({ x: NaN, y: 0 }, move('ArrowRight')), null);
  assert.equal(Keys.windowKeyMove({ x: 0, y: 0 }, { type: 'select-toggle' }), null);
  assert.equal(Keys.windowKeyMoveStatus({ x: 24.4, y: 48 }), '창 위치 24, 48 · 24px 격자');
  assert.equal(Keys.windowKeyMoveStatus({ x: 1, y: 2 }, { free: true }), '창 위치 1, 2 · 격자 해제');
  assert.match(Keys.WINDOW_HEADER_KEY_HINT, /Shift\+Space/);
});

test('UX-05 priority: Briefing target first, then Agent-working windows, order otherwise kept; edge dots follow it', () => {
  const sets = { briefingIds: new Set(['c']), agentIds: ['b', 'c'] };
  assert.deepEqual(Keys.prioritizeWindows(['a', 'b', 'c', 'd'], sets), ['c', 'b', 'a', 'd']);
  assert.deepEqual(Keys.prioritizeWindows([{ id: 'a' }, { id: 'b' }], { agentIds: ['b'] }).map(item => item.id), ['b', 'a']);
  assert.equal(Keys.windowPriorityRank('x', {}), 2);
  // Three far windows on the right plus a fourth that an Agent works in: it keeps its own dot.
  const point = (id, distance) => ({ id, side: 'right', x: 900, y: 100 + distance, distance });
  const indicators = [point('near-1', 10), point('near-2', 20), point('near-3', 30), point('agent', 400)];
  const plain = ViewportExtras.edgeDotModel(indicators, { perSide: 3 });
  assert.deepEqual(plain.filter(dot => dot.type === 'view').map(dot => dot.id), ['near-1', 'near-2']);
  const ranked = ViewportExtras.edgeDotModel(indicators, { perSide: 3, priority: id => Keys.windowPriorityRank(id, { agentIds: ['agent'] }) });
  assert.deepEqual(ranked.filter(dot => dot.type === 'view').map(dot => dot.id).sort(), ['agent', 'near-1']);
  assert.equal(ranked.find(dot => dot.type === 'more').count, 2);
});

test('surface wiring: header keys, attention sets, roving groups and the tooltip are hooked in', () => {
  assert.match(surfaceJs, /const SurfaceKeys = ChromeUtils\.importESModule\('chrome:\/\/userchrome\/content\/surface\/EGDeskSurfaceKeys\.mjs', \{ global: 'current' \}\);/);
  assert.match(surfaceJs, /const action = SurfaceKeys\.windowHeaderKeyAction\(ev\);/);
  assert.match(surfaceJs, /SurfaceKeys\.windowKeyMove\(start, action, \{ grid: CanvasLayout\.CANVAS_GRID_PX, snap \}\)/);
  assert.match(surfaceJs, /history\.record\(\{ label: 'move', items \}\)/);
  assert.match(surfaceJs, /priority: id => SurfaceKeys\.windowPriorityRank\(id, sets\)/);
  assert.match(surfaceJs, /function windowAttentionSets\(cards = \[\]\)/);
  assert.ok(css.includes('#egd-key-tooltip'), 'tooltip style');
  assert.ok(css.includes('.egd-visually-hidden'), 'live status is visually hidden');
});

test('CNV-03 inferred default: Canvas shapes are never Board members; inside a Board area they show by position', () => {
  const add = surfaceJs.slice(surfaceJs.indexOf('  function addViewToBoard(view, projectionId) {'), surfaceJs.indexOf('  function removeViewFromBoard('));
  assert.match(add, /if \(view\.classList\.contains\('egd-canvas-shape'\)\) return false;\n    const kind = 'card';/);
  const chooser = surfaceJs.slice(surfaceJs.indexOf('  function showBoardScopeChooser() {'), surfaceJs.indexOf('    const commitScope = memberIds => {'));
  assert.match(chooser, /\.filter\(view => !view\.classList\.contains\('egd-canvas-shape'\)\)\.map\(view => view\.id\)/);
  // Old Board records with shape members still restore.
  assert.match(surfaceJs, /if \(member\.kind === 'shape'\) view = restoreShapeFromState\(/);
  const doc = readFileSync(new URL('../docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md', import.meta.url), 'utf8');
  assert.match(doc, /## Board Membership of Shapes and Keyboard Placement/);
  assert.match(doc, /Canvas shapes      -> never Board members/);
});
