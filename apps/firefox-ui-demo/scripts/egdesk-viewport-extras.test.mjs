import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import * as Extras from '../overlay/resources/EGDeskViewportExtras.sys.mjs';
import * as CanvasLayout from '../overlay/resources/EGDeskCanvasLayout.sys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');

test('typed zoom: plain numbers and a trailing % are accepted, 1–400% only, never clamped', () => {
  assert.deepEqual(Extras.parseZoomPercentInput('150'), { ok: true, percent: 150, zoom: 1.5 });
  assert.deepEqual(Extras.parseZoomPercentInput(' 85.5 % '), { ok: true, percent: 85.5, zoom: 0.855 });
  assert.deepEqual(Extras.parseZoomPercentInput('１００％'), { ok: true, percent: 100, zoom: 1 }, 'full-width digits typed with a Korean IME');
  assert.equal(Extras.parseZoomPercentInput('1').zoom, 0.01);
  assert.equal(Extras.parseZoomPercentInput('400').zoom, 4);
  for (const [text, reason] of [['', 'empty'], ['  ', 'empty'], ['abc', 'not-number'], ['-20', 'not-number'], ['1e2', 'not-number'],
    ['0', 'out-of-range'], ['0.5', 'out-of-range'], ['401', 'out-of-range'], ['99999', 'out-of-range']]) {
    const result = Extras.parseZoomPercentInput(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.reason, reason, text);
    assert.match(result.message, /[가-힣]/, 'the reason is shown in Korean');
  }
  assert.match(Extras.parseZoomPercentInput('500').message, /1~400%/);
});

test('typed zoom keeps the screen point under the anchor fixed', () => {
  assert.equal(Extras.ZOOM_STEP, 1.25, 'the + and − buttons and the zoom keys step by 1.25');
  const camera = Extras.zoomCameraAt({ pan: { x: 100, y: 40 }, zoom: 1, nextZoom: 2, anchor: { x: 400, y: 300 } });
  assert.deepEqual(camera, { pan: { x: -200, y: -220 }, zoom: 2 });
  const worldBefore = { x: (400 - 100) / 1, y: (300 - 40) / 1 };
  assert.deepEqual({ x: (400 - camera.pan.x) / camera.zoom, y: (300 - camera.pan.y) / camera.zoom }, worldBefore);
  assert.equal(Extras.zoomCameraAt({ pan: { x: 0, y: 0 }, zoom: 0, nextZoom: 1, anchor: { x: 0, y: 0 } }), null);
});

test('돌아가기 remembers exactly one earlier view, replaced by a later move and cleared by returning', () => {
  const view = Extras.createReturnView();
  const here = { pan: { x: 10, y: 20 }, zoom: 1 };
  assert.equal(view.available(here), false);
  assert.equal(view.take(here), null);
  assert.equal(view.remember({ pan: { x: NaN, y: 0 }, zoom: 1 }), false, 'a broken camera is never stored');
  assert.equal(view.remember(here), true);
  assert.equal(view.available(here), false, 'the move did not happen yet: nothing to return to');
  const moved = { pan: { x: -400, y: 20 }, zoom: 0.5 };
  assert.equal(view.available(moved), true);
  here.pan.x = 999;
  assert.deepEqual(view.peek(), { pan: { x: 10, y: 20 }, zoom: 1 }, 'the remembered view is a copy');
  view.remember(moved);
  assert.deepEqual(view.take({ pan: { x: 0, y: 0 }, zoom: 1 }), moved, 'only the view before the last explicit move is kept');
  assert.equal(view.available({ pan: { x: 0, y: 0 }, zoom: 1 }), false, 'returning uses the remembered view up');
  const kept = Extras.createReturnView();
  const a = { pan: { x: 0, y: 0 }, zoom: 1 }, fit = { pan: { x: 50, y: 60 }, zoom: 0.5 };
  assert.equal(kept.rememberIfMoved(a, fit), true, '전체 보기 moved the camera: the view before it is kept');
  assert.equal(kept.rememberIfMoved(fit, fit), false, '전체 보기 pressed again moved nothing');
  assert.deepEqual(kept.peek(), a, 'so the first view is still the one to return to');
  assert.equal(Extras.returnButtonView(false).disabled, true);
  assert.match(Extras.returnButtonView(false).title, /돌아갈 자리가 없습니다/);
  assert.equal(Extras.returnButtonView(true).disabled, false);
  assert.equal(Extras.sameCamera({ pan: { x: 0, y: 0 }, zoom: 1 }, { pan: { x: 0.2, y: -0.3 }, zoom: 1.0001 }), true);
});

test('맞춤 toggle wording follows the state; anything but false counts as on', () => {
  assert.equal(Extras.snapToggleView(undefined).pressed, 'true');
  assert.equal(Extras.snapToggleView(true).menuLabel, '격자 맞춤 끄기');
  assert.equal(Extras.snapToggleView(false).pressed, 'false');
  assert.equal(Extras.snapToggleView(false).menuLabel, '격자 맞춤 켜기');
  assert.match(Extras.snapToggleView(false).title, /끔/);
  assert.equal(Extras.snapToggleView(true).label, '맞춤');
});

test('edge dots: each off-screen View gets a named dot on its side; a View on screen gets none', () => {
  const viewport = { x: 0, y: 0, width: 1000, height: 600 };
  const targets = [
    { id: 'on-screen', rect: { x: 100, y: 100, width: 200, height: 100 } },
    { id: 'far-right', rect: { x: 3000, y: 250, width: 200, height: 100 } },
    { id: 'above', rect: { x: 400, y: -900, width: 200, height: 100 } },
  ];
  const points = CanvasLayout.edgeIndicators(targets, { viewport, pan: { x: 0, y: 0 }, zoom: 1, limit: Extras.EDGE_DOT_TARGET_LIMIT });
  const dots = Extras.edgeDotModel(points, { titles: { 'far-right': '견적서.xlsx', above: '  ' } });
  assert.deepEqual(dots.map(dot => [dot.side, dot.id, dot.type]), [['top', 'above', 'view'], ['right', 'far-right', 'view']]);
  assert.equal(dots[1].label, '오른쪽 화면 밖 · 견적서.xlsx 창으로 이동');
  assert.equal(dots[0].label, '위쪽 화면 밖 · 이름 없는 창으로 이동', 'a View without a name says "창" once');
  // The window hands over a Map made in another global, where `instanceof Map` is false.
  const foreignTitles = vm.runInNewContext("new Map([['far-right', '견적서.xlsx'], ['above', '파일']])");
  assert.equal(foreignTitles instanceof Map, false);
  assert.deepEqual(Extras.edgeDotModel(points, { titles: foreignTitles }).map(dot => dot.label),
    ['위쪽 화면 밖 · 파일 창으로 이동', '오른쪽 화면 밖 · 견적서.xlsx 창으로 이동']);
  assert.equal(dots[1].x, 992, 'the dot sits on the edge, inset by 8px');
});

test('edge dots: more than three on one side fold into "+N" that leads to the nearest folded View', () => {
  const points = [50, 40, 30, 20, 10].map((distance, index) => ({ id: `v${index}`, side: 'left', x: 8, y: 100 + index * 60, distance }));
  const dots = Extras.edgeDotModel(points, { titles: new Map([['v2', '조사 메모']]) });
  assert.equal(dots.length, 3, 'two nearest dots and one +N');
  assert.deepEqual(dots.filter(dot => dot.type === 'view').map(dot => dot.id).sort(), ['v3', 'v4']);
  const more = dots.find(dot => dot.type === 'more');
  assert.equal(more.text, '+3');
  assert.equal(more.id, 'v2', 'pressing +N goes to the nearest of the folded Views');
  assert.deepEqual(more.ids, ['v2', 'v1', 'v0']);
  assert.equal(more.label, '왼쪽 화면 밖 창 3개 더 · 가장 가까운 조사 메모 창으로 이동');
  assert.equal(Extras.edgeDotModel(points.slice(0, 3)).every(dot => dot.type === 'view'), true, 'three still fit as separate dots');
});

test('edge dots on one side never stack and stay inside the visible area', () => {
  const stacked = ['a', 'b', 'c'].map((id, index) => ({ id, side: 'right', x: 992, y: 300 + index, distance: index }));
  const spread = Extras.edgeDotModel(stacked, { bounds: { left: 0, top: 0, right: 1000, bottom: 600 } });
  assert.deepEqual(spread.map(dot => dot.y), [300, 324, 348]);
  const corner = ['a', 'b', 'c'].map((id, index) => ({ id, side: 'bottom', x: 990 + index, y: 592, distance: index }));
  const kept = Extras.edgeDotModel(corner, { bounds: { left: 8, top: 8, right: 992, bottom: 592 } });
  assert.deepEqual(kept.map(dot => dot.x), [944, 968, 992], 'pushed back from the corner instead of leaving the screen');
  assert.ok(kept.every(dot => dot.y === 592));
});

test('edge dots hide while the minimap, a maximized View or the first Browser screen already orient the user', () => {
  assert.equal(Extras.edgeDotsVisible({}), true);
  for (const key of ['minimapOpen', 'fullscreen', 'browserFocus', 'restoring']) {
    assert.equal(Extras.edgeDotsVisible({ [key]: true }), false, key);
  }
});

// --- wiring in the surface script (source checks; the real screen is checked separately) ---

test('view bar wiring: 1.25 steps, typed zoom, 돌아가기 and 맞춤 are real controls', () => {
  assert.match(surfaceSource, /zoomOutButton\.addEventListener\('click', \(\) => zoomAtSafeCenter\(1 \/ ViewportExtras\.ZOOM_STEP\)\)/);
  assert.match(surfaceSource, /zoomInButton\.addEventListener\('click', \(\) => zoomAtSafeCenter\(ViewportExtras\.ZOOM_STEP\)\)/);
  assert.match(surfaceSource, /zoomCanvasByFactor\(zoomOut \? 1 \/ ViewportExtras\.ZOOM_STEP : ViewportExtras\.ZOOM_STEP,/, 'the zoom keys use the same step');
  assert.match(surfaceSource, /const zoomValue = el\('button', \{ type: 'button', class: 'egd-zoom-value'/, 'the zoom number is a button');
  assert.match(surfaceSource, /ViewportExtras\.parseZoomPercentInput\(zoomInput\.value\)/);
  assert.match(surfaceSource, /data: \{ testid: 'canvas-view-return' \}/);
  assert.match(surfaceSource, /data: \{ testid: 'canvas-snap-toggle' \}/);
  assert.match(surfaceSource, /'placement-snap-toggle'/, 'the placement menu has the same toggle');
});

test('돌아가기 wiring: 전체 보기 and the minimap/찾기 move remember the view first', () => {
  const fitStart = surfaceSource.indexOf("    zoomFitButton.addEventListener('click', () => {");
  const fitBody = surfaceSource.slice(fitStart, surfaceSource.indexOf('\n    });', fitStart));
  assert.ok(fitBody.indexOf('state.rememberCanvasReturnView?.()') > 0, '전체 보기 remembers');
  assert.ok(fitBody.indexOf('state.rememberCanvasReturnView?.()') < fitBody.indexOf('setCanvasViewportTarget('), 'before the camera moves');
  const moveStart = surfaceSource.indexOf('  function moveCameraToMinimapNode(node) {');
  const moveBody = surfaceSource.slice(moveStart, surfaceSource.indexOf('\n  }\n', moveStart));
  assert.ok(moveBody.indexOf('state.rememberCanvasReturnView?.()') > 0, 'minimap and 찾기 share this move');
  assert.ok(moveBody.indexOf('state.rememberCanvasReturnView?.()') < moveBody.indexOf('state.setCanvasPanTarget(pan)'));
});

test('맞춤 off: dragging skips grid and guides exactly like holding Option/Alt, and the choice is saved', () => {
  assert.match(surfaceSource, /free: g\.free \|\| state\.canvasSnapEnabled === false,/);
  assert.match(surfaceSource, /snap: state\.canvasSnapEnabled !== false,/, 'saved with the Desk');
  assert.match(surfaceSource, /state\.setCanvasSnapEnabled\?\.\(snapshot\.desk\.snap, \{ persist: false \}\)/, 'restored with the Desk');
});

test('view bar and edge dot styles use tokens, show focus, and respect reduced motion', () => {
  const block = css.slice(css.indexOf('.egd-zoom-value {'), css.indexOf('#egd-input-helper-status {'));
  assert.ok(block.includes('.egd-zoom-value:focus-visible'));
  assert.ok(block.includes('.egd-zoom-button:disabled'));
  assert.ok(block.includes('.egd-zoom-snap[aria-pressed="true"]'));
  assert.ok(block.includes('.egd-edge-dot:hover'));
  assert.ok(block.includes('.egd-edge-dot:focus-visible'));
  const motion = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(motion, /\[class\*="egd-"\][\s\S]*?transition: none !important;/, 'the surface-wide rule stills the dot (class egd-edge-dot)');
  assert.doesNotMatch(block, /@media \(prefers-reduced-motion/, 'no second reduced-motion block ahead of the surface-wide one');
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no colour outside the tokens');
});

// --- the view bar handlers, cut from the surface script and run against fakes ---

const compile = (body, keys) => new Function(...keys, body);
const cut = (start, end) => {
  const from = surfaceSource.indexOf(start);
  assert.ok(from > 0, `surface script still has: ${start}`);
  const to = surfaceSource.indexOf(end, from);
  assert.ok(to > from);
  return surfaceSource.slice(from + start.length, to);
};

function viewBarHarness() {
  const attrs = new Map();
  const zoomInput = { hidden: false, value: '', title: '', selected: 0,
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k), select() { this.selected++; } };
  const zoomValue = { hidden: true, focused: 0, focus() { this.focused++; } };
  const state = { panTarget: { x: 100, y: 40 }, zoomTarget: 1, cardFullscreen: null, canvasUserCameraRevision: 0 };
  const moves = [];
  const deps = {
    state, zoomInput, zoomValue, ViewportExtras: Extras,
    safeViewportRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    currentCameraTarget: () => ({ pan: { ...state.panTarget }, zoom: state.zoomTarget }),
    setCanvasViewportTarget: camera => { moves.push(camera); state.panTarget = { ...camera.pan }; state.zoomTarget = camera.zoom; },
    exitCardFullscreen: () => { state.cardFullscreen = null; },
  };
  deps.closeZoomInput = compile(`return ({ restoreFocus = false } = {}) => {${cut(
    '    const closeZoomInput = ({ restoreFocus = false } = {}) => {', '\n    };')}\n}`, Object.keys(deps))(...Object.values(deps));
  const keydown = compile(`return ev => {${cut("    zoomInput.addEventListener('keydown', ev => {", '\n    });')}\n}`,
    Object.keys(deps))(...Object.values(deps));
  const key = (name, extra = {}) => {
    const ev = { key: name, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...extra };
    keydown(ev);
    return ev;
  };
  return { state, zoomInput, zoomValue, attrs, moves, key };
}

test('typed zoom in the view bar: Enter applies around the visible centre, a bad value stays as an error, Esc cancels', () => {
  const h = viewBarHarness();
  h.zoomInput.value = '500';
  h.key('Enter');
  assert.equal(h.attrs.get('aria-invalid'), 'true');
  assert.match(h.zoomInput.title, /1~400%/);
  assert.equal(h.zoomInput.hidden, false, 'the field stays open with the reason');
  assert.equal(h.moves.length, 0, 'an out-of-range value is not clamped and applied');

  h.zoomInput.value = '200%';
  const enter = h.key('Enter');
  assert.equal(enter.prevented, 1);
  assert.deepEqual(h.moves, [{ pan: { x: -200, y: -220 }, zoom: 2 }]);
  assert.equal(h.state.canvasUserCameraRevision, 1, 'a typed zoom is a user camera move');
  assert.equal(h.zoomInput.hidden, true);
  assert.equal(h.zoomValue.hidden, false);
  assert.equal(h.zoomValue.focused, 1, 'focus returns to the zoom number');
  assert.equal(h.attrs.has('aria-invalid'), false);

  const again = viewBarHarness();
  again.zoomInput.value = '100';
  again.key('Enter');
  assert.equal(again.moves.length, 0, 'the same zoom moves nothing');
  assert.equal(again.state.canvasUserCameraRevision, 0);

  const esc = viewBarHarness();
  esc.zoomInput.value = '300';
  const ev = esc.key('Escape');
  assert.equal(ev.stopped, 1, 'Esc closes only the field');
  assert.equal(esc.moves.length, 0);
  assert.equal(esc.zoomInput.hidden, true);
  assert.equal(esc.zoomValue.focused, 1);

  const ime = viewBarHarness();
  ime.zoomInput.value = '300';
  ime.key('Enter', { isComposing: true });
  assert.equal(ime.moves.length, 0, 'an Enter that ends IME composition is not a submit');
});

test('돌아가기 in the view bar: 전체 보기 then 돌아가기 lands on the view before, once', async () => {
  const state = { panTarget: { x: 10, y: 20 }, zoomTarget: 1, cardFullscreen: null, surface: {}, canvasUserCameraRevision: 0 };
  const button = { disabled: false, title: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; } };
  const moves = [];
  const setCanvasViewportTarget = camera => { moves.push(camera); state.panTarget = { ...camera.pan }; state.zoomTarget = camera.zoom; };
  const body = cut('    const returnView = ViewportExtras.createReturnView();', '\n\n    // Typed zoom:');
  compile(`const returnView = ViewportExtras.createReturnView();${body}`,
    ['state', 'ViewportExtras', 'zoomReturnButton', 'setCanvasViewportTarget', 'window'])(
    state, Extras, button, setCanvasViewportTarget, { requestAnimationFrame: fn => fn() });

  button.listeners.click();
  assert.equal(moves.length, 0, 'nothing to return to yet');
  assert.equal(button.disabled, true);
  assert.match(button.title, /돌아갈 자리가 없습니다/);

  state.rememberCanvasReturnView();           // 전체 보기 calls this, then moves
  state.panTarget = { x: -300, y: 80 }; state.zoomTarget = 0.4;
  await Promise.resolve();
  assert.equal(button.disabled, false);
  assert.equal(button.attrs['aria-label'], '이동하기 전에 보던 자리로 돌아가기');

  state.rememberCanvasReturnView();           // 전체 보기 again: no move
  await Promise.resolve();
  button.listeners.click();
  assert.deepEqual(moves, [{ pan: { x: 10, y: 20 }, zoom: 1 }], 'back to the view before the first move');
  assert.equal(state.canvasUserCameraRevision, 1);
  assert.equal(button.disabled, true, 'one remembered view, used once');

  state.cardFullscreen = { cardId: 'c1' };
  state.rememberCanvasReturnView();
  state.panTarget = { x: 0, y: 0 };
  await Promise.resolve();
  assert.equal(button.disabled, true, 'a maximized View keeps its own return and does not fill this one');
});

// --- moving a View with the arrow keys, and Shift+View bar press to pick several ---

test('arrow keys move by 16px, with Shift by 128px; any other key is left alone', () => {
  assert.deepEqual(Extras.nudgeDelta('ArrowLeft'), { dx: -16, dy: 0 });
  assert.deepEqual(Extras.nudgeDelta('ArrowRight'), { dx: 16, dy: 0 });
  assert.deepEqual(Extras.nudgeDelta('ArrowUp'), { dx: 0, dy: -16 });
  assert.deepEqual(Extras.nudgeDelta('ArrowDown', { shift: true }), { dx: 0, dy: 128 });
  assert.deepEqual(Extras.nudgeDelta('ArrowLeft', { shift: true }), { dx: -128, dy: 0 });
  for (const key of ['Enter', 'Escape', 'a', 'Tab', '', null, undefined]) assert.equal(Extras.nudgeDelta(key), null);
  const view = Extras.nudgeView();
  assert.equal(view.label, '방향키로 옮기기');
  assert.match(view.title, /16px/);
  assert.match(view.title, /128px/);
  assert.match(view.hint, /Enter/);
  assert.match(view.hint, /Esc/);
  assert.equal(Extras.nudgeStatus({ x: 48, y: -16 }), 'x 48, y -16 — Enter 적용 · Esc 취소');
});

test('Shift+View bar press adds an unselected View and takes a selected one out; the last one stays', () => {
  assert.deepEqual(Extras.shiftClickSelection(['a'], ['b'], 'a'), { ids: ['a', 'b'], activeId: 'b' }, 'adds, and the pressed View is the active one');
  assert.deepEqual(Extras.shiftClickSelection(['a', 'b', 'c'], ['b'], 'a'), { ids: ['a', 'c'], activeId: 'a' }, 'takes out, active stays');
  assert.deepEqual(Extras.shiftClickSelection(['a', 'b'], ['a'], 'a'), { ids: ['b'], activeId: 'b' }, 'the active one taken out hands over');
  assert.deepEqual(Extras.shiftClickSelection(['a'], ['a'], 'a'), { ids: ['a'], activeId: 'a' }, 'never empties the selection');
  assert.deepEqual(Extras.shiftClickSelection([], ['a'], null), { ids: ['a'], activeId: 'a' });
  // A grouped View comes and goes with its group (the pressed View is first).
  assert.deepEqual(Extras.shiftClickSelection(['x'], ['g1', 'g2'], 'x'), { ids: ['x', 'g1', 'g2'], activeId: 'g1' });
  assert.deepEqual(Extras.shiftClickSelection(['x', 'g1', 'g2'], ['g2', 'g1'], 'g1'), { ids: ['x'], activeId: 'x' });
  assert.deepEqual(Extras.shiftClickSelection(['g1', 'g2'], ['g1', 'g2'], 'g1'), { ids: ['g1', 'g2'], activeId: 'g1' }, 'a group that is the whole selection stays');
  assert.deepEqual(Extras.shiftClickSelection(['a', null, 'a', 'b'], ['c', 'c'], 'zz'), { ids: ['a', 'b', 'c'], activeId: 'c' }, 'duplicates and blanks are dropped');
  assert.deepEqual(Extras.shiftClickSelection(['a'], [], 'a'), { ids: ['a'], activeId: 'a' }, 'nothing pressed changes nothing');
});

function moveDialogHarness() {
  const rects = new Map([['card', { x: 96, y: 48, width: 400, height: 300 }], ['mate', { x: 600, y: 48, width: 320, height: 250 }]]);
  const nodes = new Map([...rects.keys()].map(id => [id, { id, isConnected: true }]));
  const card = nodes.get('card');
  const inputs = [{ value: '96' }, { value: '48' }];
  const status = { textContent: '' };
  const dirty = [];
  let frames = 0;
  const deps = {
    card, inputs, status, ViewportExtras: Extras, state: { canvasGroups: [] },
    CanvasLayout: { expandCanvasGroupSelection: () => ['card', 'mate'] },
    document: { getElementById: id => nodes.get(id) || null },
    isCardFullscreen: () => false,
    rectOf: node => (node?.isConnected ? { ...rects.get(node.id) } : null),
    applyPersistentEntityGeometry: (node, rect) => rects.set(node.id, { ...rect }),
    scheduleGroupFrames: () => { frames++; },
    markAgendaDirty: (reason, node) => dirty.push([reason, node.id]),
  };
  const built = compile(`${cut('      // [방향키로 옮기기] start', '      // [방향키로 옮기기] end')}
    return { nudge, revertNudge, origin: () => nudgeOrigin };`, Object.keys(deps))(...Object.values(deps));
  return { ...built, rects, inputs, status, dirty, nodes, frames: () => frames };
}

test('move dialog: arrow presses move the View and its group at once and show the new x, y', () => {
  const h = moveDialogHarness();
  h.nudge(Extras.nudgeDelta('ArrowRight'));
  h.nudge(Extras.nudgeDelta('ArrowDown', { shift: true }));
  assert.deepEqual(h.rects.get('card'), { x: 112, y: 176, width: 400, height: 300 });
  assert.deepEqual(h.rects.get('mate'), { x: 616, y: 176, width: 320, height: 250 }, 'the group moves by the same amount');
  assert.deepEqual(h.inputs.map(input => input.value), ['112', '176']);
  assert.equal(h.status.textContent, 'x 112, y 176 — Enter 적용 · Esc 취소');
  assert.deepEqual(h.origin().get('card'), { x: 96, y: 48, width: 400, height: 300 }, 'the place before the first press is kept for undo and Esc');
  assert.ok(h.frames() >= 2);
});

test('move dialog: Esc after arrow presses puts every moved View back', () => {
  const h = moveDialogHarness();
  h.revertNudge();
  assert.deepEqual(h.dirty, [], 'nothing moved, nothing to put back');
  h.nudge(Extras.nudgeDelta('ArrowLeft', { shift: true }));
  h.nudge(Extras.nudgeDelta('ArrowUp'));
  h.revertNudge();
  assert.deepEqual(h.rects.get('card'), { x: 96, y: 48, width: 400, height: 300 });
  assert.deepEqual(h.rects.get('mate'), { x: 600, y: 48, width: 320, height: 250 });
  assert.equal(h.origin(), null);
  assert.deepEqual(h.dirty.map(entry => entry[1]).sort(), ['card', 'mate'], 'the Desk is saved again with the restored places');
});

test('move dialog wiring: the arrow button is a real control, apply records from the place before the arrows, closing reverts', () => {
  assert.match(surfaceSource, /data: \{ testid: 'placement-nudge' \}/);
  assert.match(surfaceSource, /const step = ViewportExtras\.nudgeDelta\(ev\.key, \{ shift: ev\.shiftKey \}\);/);
  assert.match(surfaceSource, /const before = nudgeOrigin\?\.get\(card\.id\) \|\| rectOf\(card\);/);
  assert.match(surfaceSource, /const start = nudgeOrigin\?\.get\(id\) \|\| rectOf\(node\);/);
  assert.match(surfaceSource, /dialog\._revert\?\.\(\);/, 'Esc, 취소 and any other close put the View back');
  assert.match(css, /\.egd-placement-nudge:focus-visible \{[^}]*outline: var\(--egd-focus-outline\)/);
  assert.match(css, /\.egd-placement-nudge:hover \{/);
});

test('Shift+View bar press: the pick is applied on click, a drag is not a pick', () => {
  const nodes = new Map(['a', 'b', 'c'].map(id => [id, { id, isConnected: true }]));
  const calls = [];
  const state = { activeEntityId: 'a', expandCanvasSelection: list => list };
  const deps = {
    state, ViewportExtras: Extras,
    document: { getElementById: id => nodes.get(id) || null },
    cardOf: target => target?.card || null,
    setSelectedEntities: (list, active) => calls.push({ ids: list.map(node => node.id), active: active?.id || null }),
  };
  const body = cut("    window.addEventListener('click', ev => {\n      const pick = shiftPick;", '\n    }, true);');
  const h = compile(`let shiftPick = null;
    const onClick = ev => {
      const pick = shiftPick;${body}
    };
    return { set: pick => { shiftPick = pick; }, get: () => shiftPick, onClick };`, Object.keys(deps))(...Object.values(deps));
  const b = nodes.get('b');
  h.set({ card: b, ids: ['a'], pressed: ['b'], activeId: 'a', x: 100, y: 100 });
  h.onClick({ button: 0, clientX: 101, clientY: 102, target: { card: b } });
  assert.deepEqual(calls, [{ ids: ['a', 'b'], active: 'b' }]);
  assert.equal(h.get(), null, 'one press, one pick');
  h.onClick({ button: 0, clientX: 101, clientY: 102, target: { card: b } });
  assert.equal(calls.length, 1, 'a plain click afterwards changes nothing here');
  h.set({ card: b, ids: ['a'], pressed: ['b'], activeId: 'a', x: 100, y: 100 });
  h.onClick({ button: 0, clientX: 130, clientY: 100, target: { card: b } });
  assert.equal(calls.length, 1, 'the View was dragged, not picked');
  h.set({ card: b, ids: ['a', 'b', 'c'], pressed: ['b'], activeId: 'a', x: 5, y: 5 });
  h.onClick({ button: 0, clientX: 5, clientY: 5, target: { card: b } });
  assert.deepEqual(calls[1], { ids: ['a', 'c'], active: 'a' }, 'a selected View is taken out');
  assert.match(surfaceSource, /shiftPick = ev\.shiftKey\s*\? \{ card, ids: selectedCards\(\)\.map\(node => node\.id\)/, 'the selection is read before the press changes it');
});
