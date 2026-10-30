import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Layout from '../overlay/resources/EGDeskCanvasLayout.sys.mjs';
import { createLayerStack } from '../overlay/resources/EGDeskLayerStack.sys.mjs';
import { planBoardProjection, snapshotBoardProjection } from '../overlay/resources/EGDeskSurfaceState.sys.mjs';

const {
  snapCanvasRect, moveRegionWithMembers, createLayoutHistory, arrangeWithoutOverlap, placeBesideOpener,
  edgeIndicatorPoint, edgeIndicators, minimapSearchRows, minimapFocusCamera, minimapViewBox,
  normalizeCollapsedIds, setCollapsedId, isCollapsedId, displayRect, clampViewRect, innermostRegionAt,
  regionDropSuggestion, regionRecheckInterval, owningProjectionByView, addProjectionMember, removeProjectionMember,
  toWorldRect, unionRect, snapGuideScreenBoxes, arrangeInVisibleArea, normalizeCanvasGroups, canvasGroupOf,
  expandCanvasGroupSelection, createCanvasGroup, dissolveCanvasGroups, pruneCanvasGroups, remapCanvasGroups,
  canvasGroupFrames, parsePlacementInput,
} = Layout;

const rect = (x, y, width, height, id) => (id ? { id, x, y, width, height } : { x, y, width, height });
const overlaps = (a, b, gap = 0) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap
  && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

// ---------------------------------------------------------------- snapping

test('snap: a View lands on the 24px grid within 8 screen px, and Option/Alt keeps it free', () => {
  const near = snapCanvasRect({ rect: rect(29, 46, 300, 200) });
  assert.equal(near.x, 24);
  assert.equal(near.y, 48);
  assert.equal(near.snappedX, 'grid');
  assert.deepEqual(near.guides, [], 'the grid draws no guide line');
  const far = snapCanvasRect({ rect: rect(36, 60, 300, 200) });
  assert.equal(far.x, 36, '12px from the grid is past the 8px reach');
  assert.equal(far.dx, 0);
  const free = snapCanvasRect({ rect: rect(29, 46, 300, 200), free: true });
  assert.deepEqual([free.x, free.y, free.dx, free.dy], [29, 46, 0, 0]);
});

test('snap: the reach is 8 screen px, so it is 16 world px at 50% zoom and 4 at 200%', () => {
  assert.equal(snapCanvasRect({ rect: rect(36, 0, 100, 100), zoom: 0.5 }).x, 48);
  assert.equal(snapCanvasRect({ rect: rect(30, 0, 100, 100), zoom: 2 }).x, 30);
  assert.equal(snapCanvasRect({ rect: rect(27, 0, 100, 100), zoom: 2 }).x, 24);
});

test('snap: edges and centres of a View above or below line up and draw a guide; the edge wins a tie with the grid', () => {
  const other = rect(103, 400, 300, 200, 'other');
  const left = snapCanvasRect({ rect: rect(98, 0, 200, 150), candidates: [other], enableGrid: false });
  assert.equal(left.x, 103);
  assert.equal(left.snappedX, 'align');
  assert.deepEqual(left.guides[0], { kind: 'v', x: 103, y1: 0, y2: 600, reason: 'edge' });
  const center = snapCanvasRect({ rect: rect(150, 0, 200, 150), candidates: [rect(100, 400, 300, 200)], enableGrid: false });
  assert.equal(center.x + center.width / 2, 250);
  assert.equal(center.guides[0].reason, 'center');
  // 101 is 5 from grid 96 and 3 from the edge 104 -> edge; equal distance -> edge as well.
  const tie = snapCanvasRect({ rect: rect(100, 0, 200, 150), candidates: [rect(104, 400, 300, 200)] });
  assert.equal(tie.x, 104);
  const exactTie = snapCanvasRect({ rect: rect(98, 0, 200, 150), candidates: [rect(100, 400, 300, 200)] });
  assert.equal(exactTie.x, 100, 'grid 96 and edge 100 are both 2 away; the edge wins');
  assert.equal(exactTie.snappedX, 'align');
});

test('snap: a side-by-side neighbour docks 24px away instead of lining up on top of it', () => {
  const neighbour = rect(500, 100, 300, 300, 'n');
  const moving = rect(170, 120, 310, 200);
  const result = snapCanvasRect({ rect: moving, candidates: [neighbour], enableGrid: false });
  assert.equal(result.x + result.width, 476, 'right edge stops at neighbour.left - 24');
  assert.equal(result.snappedX, 'dock');
  const gap = result.guides.find(guide => guide.kind === 'gap');
  assert.deepEqual([gap.axis, gap.start, gap.end], ['x', 476, 500]);
  // Same right edge as the neighbour would stack the two; it is never offered.
  const stacked = snapCanvasRect({ rect: rect(492, 120, 310, 200), candidates: [neighbour], enableGrid: false, threshold: 10 });
  assert.notEqual(stacked.x + stacked.width, 800);
  // Docking on the left side of the moving View.
  const leftDock = snapCanvasRect({ rect: rect(830, 150, 200, 100), candidates: [neighbour], enableGrid: false });
  assert.equal(leftDock.x, 824);
});

test('snap: only Views inside the visible area and outside the moving set are candidates', () => {
  const offscreen = rect(103, 5000, 300, 200, 'far');
  const self = rect(103, 400, 300, 200, 'self');
  const viewport = { left: 0, top: 0, right: 1200, bottom: 800 };
  const result = snapCanvasRect({ rect: rect(98, 0, 200, 150), candidates: [offscreen, self], excludeIds: ['self'], viewport, enableGrid: false });
  assert.equal(result.x, 98);
  const many = Array.from({ length: 300 }, (_, i) => rect(5000 + i * 400, 5000, 100, 100, `v${i}`));
  many.push(rect(103, 400, 300, 200, 'near'));
  assert.equal(snapCanvasRect({ rect: rect(98, 0, 200, 150), candidates: many, enableGrid: false }).x, 103,
    'the nearest of more than 96 candidates is still considered');
});

test('snap: resizing moves only the dragged edge and never goes below the minimum size', () => {
  const grow = snapCanvasRect({ rect: rect(0, 0, 293, 200), edges: { right: true } });
  assert.deepEqual([grow.x, grow.width], [0, 288]);
  const left = snapCanvasRect({ rect: rect(29, 0, 300, 200), edges: { left: true } });
  assert.deepEqual([left.x, left.width], [24, 305]);
  const dock = snapCanvasRect({ rect: rect(0, 100, 470, 200), edges: { right: true }, candidates: [rect(500, 100, 200, 200)], enableGrid: false });
  assert.equal(dock.width, 476);
  const tooSmall = snapCanvasRect({ rect: rect(0, 0, 325, 245), edges: { right: true, bottom: true }, minWidth: 325, minHeight: 245 });
  assert.deepEqual([tooSmall.width, tooSmall.height], [325, 245], 'snapping down to 312/240 would break the minimum');
  assert.equal(snapCanvasRect({ rect: null }), null);
});

test('snap guides: lines and gap bars become screen boxes with the camera, 1px thick at any zoom', () => {
  const other = rect(100, 400, 300, 200, 'other');
  const aligned = snapCanvasRect({ rect: rect(98, 0, 200, 150), candidates: [other], enableGrid: false });
  const boxes = snapGuideScreenBoxes(aligned.guides, { pan: { x: 10, y: 20 }, zoom: 0.5 });
  assert.deepEqual(boxes, [{ kind: 'v', reason: 'edge', left: 59.5, top: 20, width: 1, height: 300 }]);
  const docked = snapCanvasRect({ rect: rect(170, 120, 310, 200), candidates: [rect(500, 100, 300, 300, 'n')], enableGrid: false });
  const gap = snapGuideScreenBoxes(docked.guides, { pan: { x: 0, y: 0 }, zoom: 2 });
  assert.equal(gap[0].kind, 'gap');
  assert.deepEqual([gap[0].left, gap[0].width, gap[0].height], [952, 48, 1], 'the bar spans the 24px gap at 200%');
  assert.deepEqual(snapGuideScreenBoxes(aligned.guides, { pan: null, zoom: 1 }), []);
  assert.deepEqual(snapGuideScreenBoxes([{ kind: 'v' }, null], { pan: { x: 0, y: 0 }, zoom: 1 }), []);
});

test('Board title drag moves the region and every member by the same snapped delta', () => {
  const moved = moveRegionWithMembers({
    region: rect(0, 0, 500, 400), dx: 29, dy: 50,
    members: [{ id: 'a', rect: rect(24, 60, 200, 100) }, { id: 'b', rect: rect(250, 60, 200, 100) }],
    snap: { candidates: [rect(24, 60, 200, 100, 'a')] },
  });
  assert.deepEqual([moved.region.x, moved.region.y], [24, 48]);
  assert.deepEqual(moved.members.map(item => [item.id, item.x, item.y]), [['a', 48, 108], ['b', 274, 108]]);
  assert.deepEqual([moved.dx, moved.dy], [24, 48]);
  const plain = moveRegionWithMembers({ region: rect(0, 0, 10, 10), members: [], dx: 7, dy: 3 });
  assert.deepEqual([plain.region.x, plain.region.y], [7, 3]);
});

// ---------------------------------------------------------------- undo

test('layout undo: one drag is one step, and a gesture that ends where it began records nothing', () => {
  const history = createLayoutHistory();
  const still = history.startGesture('move', [{ id: 'egd-card-1', rect: rect(0, 0, 100, 100) }]);
  assert.equal(still.commit([{ id: 'egd-card-1', rect: rect(0, 0, 100, 100) }]), false);
  const drag = history.startGesture('move', [{ id: 'egd-card-1', rect: rect(0, 0, 100, 100) }]);
  assert.equal(drag.commit([{ id: 'egd-card-1', rect: rect(48, 24, 100, 100) }]), true);
  assert.equal(drag.commit([{ id: 'egd-card-1', rect: rect(96, 24, 100, 100) }]), false, 'a gesture commits once');
  assert.deepEqual(history.size(), { undo: 1, redo: 0 });
  const current = new Map([['egd-card-1', rect(48, 24, 100, 100)]]);
  const undone = history.undo(id => current.get(id));
  assert.equal(undone.status, 'undone');
  assert.deepEqual(undone.rects, [{ id: 'egd-card-1', x: 0, y: 0, width: 100, height: 100 }]);
  current.set('egd-card-1', rect(0, 0, 100, 100));
  const redone = history.redo(id => current.get(id));
  assert.equal(redone.status, 'redone');
  assert.deepEqual(redone.rects[0], { id: 'egd-card-1', x: 48, y: 24, width: 100, height: 100 });
});

test('layout undo: a View moved, resized or closed since the step is not overwritten', () => {
  const history = createLayoutHistory();
  history.record({ label: 'arrange', items: [
    { id: 'a', before: rect(0, 0, 100, 100), after: rect(24, 0, 100, 100) },
    { id: 'b', before: rect(200, 0, 100, 100), after: rect(148, 0, 100, 100) },
  ] });
  history.record({ label: 'move', items: [{ id: 'c', before: rect(0, 300, 50, 50), after: rect(24, 300, 50, 50) }] });
  const now = new Map([['a', rect(24, 0, 100, 100)], ['b', rect(150, 0, 100, 100)], ['c', rect(24, 300, 50, 50)]]);
  assert.equal(history.undo(id => now.get(id)).status, 'undone');
  const stale = history.undo(id => now.get(id));
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.staleIds, ['b']);
  assert.deepEqual(stale.rects, []);
  assert.equal(history.undo(() => null).status, 'empty', 'the stale step was dropped, not retried');
  assert.equal(history.canRedo(), true);
  history.record({ label: 'move', items: [{ id: 'd', before: rect(0, 0, 1, 1), after: rect(1, 0, 1, 1) }] });
  assert.equal(history.canRedo(), false, 'a new step clears redo');
});

test('layout undo: labels are fixed tokens, the limit drops the oldest, and closed Views are stale', () => {
  const history = createLayoutHistory({ limit: 2 });
  for (let i = 0; i < 3; i += 1) history.record({ label: i === 0 ? 'Free text label' : 'resize', items: [{ id: `v${i}`, before: rect(0, 0, 10, 10), after: rect(10, 0, 10, 10) }] });
  assert.deepEqual(history.size(), { undo: 2, redo: 0 });
  const rects = new Map([['v2', rect(10, 0, 10, 10)]]);
  assert.equal(history.undo(id => rects.get(id)).label, 'resize');
  assert.equal(history.undo(id => rects.get(id)).status, 'stale', 'v1 is no longer on the Canvas');
  const sanitized = createLayoutHistory();
  sanitized.record({ label: '사용자 입력 문장', items: [{ id: 'v', before: rect(0, 0, 1, 1), after: rect(2, 0, 1, 1) }] });
  assert.equal(sanitized.undo(() => rect(2, 0, 1, 1)).label, 'move');
  assert.equal(sanitized.record({ items: [{ id: 'not a view id!', before: rect(0, 0, 1, 1), after: rect(1, 0, 1, 1) }] }), false);
});

test('layout undo: grouping is a step of its own that hands back the group list, and a no-op records nothing', () => {
  const history = createLayoutHistory();
  const before = [];
  const after = [{ id: 'egd-group-1', viewIds: ['a', 'b'] }];
  assert.equal(history.record({ label: 'group', items: [], groups: { before, after } }), true);
  assert.equal(history.record({ label: 'group', items: [], groups: { before: after, after } }), false, 'same groups, no step');
  const undone = history.undo(() => null);
  assert.equal(undone.status, 'undone');
  assert.deepEqual(undone.rects, []);
  assert.deepEqual(undone.groups, []);
  const redone = history.redo(() => null);
  assert.deepEqual(redone.groups, after);
  assert.notEqual(redone.groups[0], after[0], 'a copy, not the recorded object');
  history.record({ label: 'move', items: [{ id: 'a', before: rect(0, 0, 1, 1), after: rect(2, 0, 1, 1) }] });
  assert.equal(history.undo(() => rect(2, 0, 1, 1)).groups, null, 'a plain move carries no group list');
});

// ---------------------------------------------------------------- arrange

test('arrange: chosen Views keep their sizes and reading order and never overlap', () => {
  const items = [
    rect(400, 30, 300, 200, 'c'), rect(10, 20, 200, 300, 'a'), rect(250, 10, 400, 150, 'b'),
    rect(30, 700, 500, 250, 'd'), rect(600, 650, 200, 200, 'e'),
  ];
  const { placements, changed } = arrangeWithoutOverlap({ items });
  assert.equal(changed, true);
  assert.deepEqual(placements.map(item => item.id), ['b', 'a', 'c', 'e', 'd'], 'top to bottom, then left to right');
  for (const item of placements) {
    const source = items.find(entry => entry.id === item.id);
    assert.deepEqual([item.width, item.height], [source.width, source.height]);
  }
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      assert.equal(overlaps(placements[i], placements[j], 23.999), false, `${placements[i].id} and ${placements[j].id} keep 24px apart`);
    }
  }
  assert.deepEqual([placements[0].x, placements[0].y], [0, 0], 'starts at the grid-aligned top-left of the selection');
});

test('arrange: a block that would cover another View moves as a whole; duplicates and bad input are ignored', () => {
  const items = [rect(0, 0, 200, 200, 'a'), rect(220, 0, 200, 200, 'b'), rect(0, 0, 200, 200, 'a')];
  const obstacles = [rect(100, 100, 400, 400, 'x'), rect(0, 0, 200, 200, 'a')];
  const { placements, bounds } = arrangeWithoutOverlap({ items, obstacles, wrapWidth: 1000 });
  assert.equal(placements.length, 2);
  for (const item of placements) assert.equal(overlaps(item, obstacles[0], 23.999), false);
  assert.ok(bounds.width >= 424);
  assert.deepEqual(arrangeWithoutOverlap({ items: [null, { id: 'x' }] }), { placements: [], bounds: null, changed: false });
  const wrapped = arrangeWithoutOverlap({ items: [rect(0, 0, 300, 100, 'p'), rect(0, 200, 300, 100, 'q'), rect(0, 400, 300, 100, 'r')], wrapWidth: 640 });
  assert.deepEqual(wrapped.placements.map(item => [item.x, item.y]), [[0, 0], [324, 0], [0, 124]]);
});

test('arrange in view: the block starts inside the visible area, wraps at its right edge, and a group moves as one block', () => {
  const visible = { left: 1000, top: 1000, right: 1700, bottom: 1600 };
  const items = [rect(-500, -500, 300, 200, 'a'), rect(-100, -500, 300, 200, 'b'), rect(-500, -200, 300, 200, 'c')];
  const result = arrangeInVisibleArea({ items, visible });
  assert.deepEqual(result.start, { x: 1032, y: 1032 }, 'grid-aligned, a gap inside the visible top-left');
  assert.equal(result.wrapWidth, 1700 - 24 - 1032);
  assert.deepEqual(result.placements.map(item => [item.id, item.x, item.y]), [['a', 1032, 1032], ['b', 1356, 1032], ['c', 1032, 1256]]);
  for (const item of result.placements) assert.ok(item.x + item.width <= 1700 && item.y + item.height <= 1600, `${item.id} stays in view`);
  const inside = arrangeInVisibleArea({ items: [rect(1210, 1105, 100, 100, 'p'), rect(1230, 1120, 100, 100, 'q')], visible });
  assert.deepEqual(inside.start, { x: 1200, y: 1104 }, 'a selection already in view keeps its own top-left');
  const groups = [{ id: 'g', viewIds: ['b', 'c'] }];
  const grouped = arrangeInVisibleArea({ items, groups, visible, obstacles: [] });
  const b = grouped.placements.find(item => item.id === 'b');
  const c = grouped.placements.find(item => item.id === 'c');
  assert.deepEqual([c.x - b.x, c.y - b.y], [-400, 300], 'the group keeps its inner layout');
  assert.equal(grouped.placements.length, 3);
  assert.deepEqual(arrangeInVisibleArea({ items: [] }).placements, []);
  const blocked = arrangeInVisibleArea({ items: [rect(0, 0, 100, 100, 'x')], visible: { left: 0, top: 0, right: 500, bottom: 500 },
    obstacles: [rect(0, 0, 400, 400, 'wall')] });
  assert.equal(overlaps(blocked.placements[0], rect(0, 0, 400, 400), 23.999), false, 'a View not chosen is an obstacle');
});

// ---------------------------------------------------------------- beside opener

test('beside opener: a View opened from a Chat opens 24px to its right, top-aligned', () => {
  const chat = rect(100, 100, 420, 600);
  const spot = placeBesideOpener({ opener: chat, size: { width: 560, height: 560 }, occupied: [chat] });
  assert.deepEqual(spot, { x: 544, y: 100, width: 560, height: 560, side: 'right', inView: false, aligned: true });
});

test('beside opener: it slides along the side past what is in the way, then tries the left', () => {
  const chat = rect(100, 100, 420, 600);
  const blocker = rect(544, 50, 300, 300);
  const slid = placeBesideOpener({ opener: chat, size: { width: 400, height: 300 }, occupied: [chat, blocker] });
  assert.equal(slid.side, 'right');
  assert.equal(slid.y, 374, 'below the blocker plus the gap, still facing the Chat');
  assert.equal(slid.aligned, false);
  const wall = rect(544, -1000, 300, 3000);
  const left = placeBesideOpener({ opener: chat, size: { width: 400, height: 300 }, occupied: [chat, wall] });
  assert.deepEqual([left.side, left.x, left.y], ['left', -324, 100]);
  const boxed = placeBesideOpener({ opener: chat, size: { width: 400, height: 300 }, occupied: [chat, rect(-2000, -2000, 5000, 2080), rect(-2000, 724, 5000, 2000), wall, rect(-2000, -2000, 2076, 5000)] });
  assert.equal(boxed, null, 'no side has room, so the caller falls back to placeCanvasView');
});

test('beside opener: a side inside the visible area beats the preferred side outside it', () => {
  const chat = rect(1000, 100, 420, 600);
  const safe = { left: 0, top: 0, right: 1500, bottom: 900 };
  const spot = placeBesideOpener({ opener: chat, size: { width: 400, height: 300 }, occupied: [chat], safe });
  assert.deepEqual([spot.side, spot.inView, spot.x], ['left', true, 576]);
});

// ---------------------------------------------------------------- edge indicators

test('edge dot: a View outside the visible area shows on the edge facing it; a visible one shows none', () => {
  const viewport = { left: 0, top: 0, right: 1000, bottom: 600 };
  const camera = { pan: { x: 0, y: 0 }, zoom: 1 };
  assert.equal(edgeIndicatorPoint({ rect: rect(100, 100, 100, 100), viewport, ...camera }), null);
  const rightSide = edgeIndicatorPoint({ rect: rect(2000, 250, 100, 100), viewport, ...camera });
  assert.equal(rightSide.side, 'right');
  assert.equal(rightSide.x, 992);
  assert.ok(Math.abs(rightSide.y - 300) < 1e-9);
  assert.equal(Math.round(rightSide.angle), 0);
  const above = edgeIndicatorPoint({ rect: rect(450, -900, 100, 100), viewport, ...camera });
  assert.deepEqual([above.side, above.x, above.y], ['top', 500, 8]);
  const zoomed = edgeIndicatorPoint({ rect: rect(450, 250, 100, 100), viewport, pan: { x: -2000, y: 0 }, zoom: 1 });
  assert.equal(zoomed.side, 'left');
  const rows = edgeIndicators([{ id: 'a', kind: 'briefing', rect: rect(2000, 250, 100, 100) }, { id: 'b', rect: rect(0, 0, 10, 10) }], { viewport, ...camera });
  assert.deepEqual(rows.map(row => [row.id, row.kind, row.side]), [['a', 'briefing', 'right']]);
});

// ---------------------------------------------------------------- minimap

test('minimap search: Boards first, each top to bottom, case-insensitive, all rows (not the first 8)', () => {
  const boards = [{ id: 'b2', title: 'Release Plan', rect: rect(0, 900, 400, 300) }, { id: 'b1', title: '디자인 리뷰', rect: rect(0, 0, 400, 300) }];
  const views = Array.from({ length: 12 }, (_, i) => ({ id: `v${i}`, title: `Browser ${i}`, kind: 'browser', rect: rect(i * 100, 2000 - i * 100, 90, 90), projectionId: null }));
  views.push({ id: 'vr', title: 'release notes', kind: 'file', rect: rect(0, 400, 100, 100), projectionId: 'b1' });
  const all = minimapSearchRows({ boards, views });
  assert.equal(all.rows.length, 15);
  assert.deepEqual(all.rows.slice(0, 2).map(row => row.id), ['b1', 'b2']);
  assert.equal(all.focusIndex, -1);
  const found = minimapSearchRows({ query: 'RELEASE', boards, views, viewport: { left: 0, top: 0, right: 1000, bottom: 800 } });
  assert.deepEqual(found.rows.map(row => [row.id, row.kind, row.visible]), [['b2', 'board', false], ['vr', 'view', true]]);
  assert.equal(found.focusIndex, 1, 'the first match already on screen gets focus');
  assert.deepEqual(found.rows[1].match, { start: 0, length: 7 });
  assert.equal(found.rows[1].projectionId, 'b1');
  const korean = minimapSearchRows({ query: '리뷰', boards, views });
  assert.deepEqual(korean.rows.map(row => row.id), ['b1']);
  assert.equal(korean.focusIndex, 0, 'nothing on screen: the first match');
  assert.equal(minimapSearchRows({ query: 'zzz', boards, views }).focusIndex, -1);
  const limited = minimapSearchRows({ boards, views, limit: 3, activeId: 'b2' });
  assert.deepEqual([limited.rows.length, limited.total, limited.truncated, limited.focusIndex], [3, 15, true, 1]);
});

test('minimap focus: the camera stays when the target is fully in view, else centres it without zooming in', () => {
  const safe = { left: 0, top: 0, right: 1000, bottom: 800 };
  assert.equal(minimapFocusCamera({ rect: rect(100, 100, 200, 200), safe, pan: { x: 0, y: 0 }, zoom: 1 }), null);
  const offscreen = minimapFocusCamera({ rect: rect(3000, 3000, 200, 200), safe, pan: { x: 0, y: 0 }, zoom: 0.5 });
  assert.equal(offscreen.zoom, 0.5);
  assert.equal(3100 * offscreen.zoom + offscreen.pan.x, 500);
  const big = minimapFocusCamera({ rect: rect(0, 0, 4000, 1000), safe, pan: { x: 0, y: 0 }, zoom: 1 });
  assert.ok(big.zoom < 1 && Math.abs(big.zoom - 952 / 4000) < 1e-9);
});

test('minimap SVG: the viewBox and mask follow the xyflow formula in world coordinates', () => {
  const box = minimapViewBox({ content: rect(0, 0, 2000, 1000), view: rect(500, 200, 800, 500), width: 200, height: 150 });
  assert.equal(box.scale, 10);
  assert.equal(box.viewBox, '-50 -300 2100 1600');
  assert.ok(box.maskPath.endsWith('M500,200h800v500h-800z'));
  assert.equal(minimapViewBox({ view: null, width: 200, height: 150 }), null);
});

// ---------------------------------------------------------------- collapse, clamp, regions

test('collapse: ids are a clean list, and only the shown size changes', () => {
  assert.deepEqual(normalizeCollapsedIds([' egd-card-1 ', 'egd-card-1', '', 7, 'bad id', 'egd-card-2']), ['egd-card-1', 'egd-card-2']);
  assert.deepEqual(normalizeCollapsedIds({ 'egd-card-1': true }), []);
  let ids = setCollapsedId([], 'egd-card-3', true);
  ids = setCollapsedId(ids, 'egd-card-3', true);
  assert.deepEqual(ids, ['egd-card-3']);
  assert.equal(isCollapsedId(ids, 'egd-card-3'), true);
  assert.deepEqual(setCollapsedId(ids, 'egd-card-3', false), []);
  const full = rect(100, 200, 960, 640);
  assert.deepEqual(displayRect(full, { collapsed: true }), { x: 100, y: 200, width: 240, height: 48 });
  assert.deepEqual(displayRect(full), full);
  assert.deepEqual(full, rect(100, 200, 960, 640), 'the stored rect is untouched');
});

test('clamp: a View is pulled inside a Board region and shrinks only when it cannot fit', () => {
  const region = { x: 0, y: 0, width: 600, height: 400 };
  assert.deepEqual(clampViewRect(rect(550, -50, 200, 100), region), { x: 388, y: 12, width: 200, height: 100 });
  assert.deepEqual(clampViewRect(rect(10, 10, 900, 100), { left: 0, top: 0, right: 600, bottom: 400 }), { x: 12, y: 12, width: 576, height: 100 });
});

test('regions: the innermost region under the point wins, and dropping in another Board only suggests', () => {
  const regions = [
    { id: 'outer', rect: rect(0, 0, 1000, 1000) },
    { id: 'small', rect: rect(100, 100, 300, 300) },
    { id: 'nested', parentId: 'outer', rect: rect(50, 50, 800, 800) },
  ];
  assert.equal(innermostRegionAt(regions, { x: 200, y: 200 }).id, 'nested', 'depth beats area');
  assert.equal(innermostRegionAt(regions.slice(0, 2), { x: 200, y: 200 }).id, 'small');
  assert.equal(innermostRegionAt(regions, { x: 5000, y: 5000 }), null);
  const loop = [{ id: 'a', parentId: 'b', rect: rect(0, 0, 10, 10) }, { id: 'b', parentId: 'a', rect: rect(0, 0, 10, 10) }];
  assert.ok(innermostRegionAt(loop, { x: 5, y: 5 }), 'a parent loop does not hang');
  assert.deepEqual(regionDropSuggestion({ viewRect: rect(150, 150, 100, 100), regions: regions.slice(0, 2) }), { projectionId: 'small', action: 'add', fromId: null });
  assert.deepEqual(regionDropSuggestion({ viewRect: rect(150, 150, 100, 100), regions: regions.slice(0, 2), ownerId: 'outer' }), { projectionId: 'small', action: 'move', fromId: 'outer' });
  assert.equal(regionDropSuggestion({ viewRect: rect(150, 150, 100, 100), regions: regions.slice(0, 2), ownerId: 'small' }), null);
  assert.equal(regionDropSuggestion({ viewRect: rect(150, 150, 100, 100), point: { x: 900, y: 900 }, regions: regions.slice(0, 2) }).projectionId, 'outer');
  assert.equal(regionRecheckInterval(3), 60);
  assert.equal(regionRecheckInterval(11), 320);
});

// ---------------------------------------------------------------- Board membership

function boardState() {
  const projection = planBoardProjection({
    agenda: { id: 'board-a', title: 'A', memberCardIds: ['c1'] },
    cards: [{ id: 'c1', type: 'browser', geometry: { x: 0, y: 0, width: 10, height: 10 } }], shapes: [],
  }, 'egd-board-1');
  projection.offset = { x: 100, y: 50 };
  const other = planBoardProjection({ agenda: { id: 'board-b', title: 'B', memberCardIds: [] }, cards: [], shapes: [] }, 'egd-board-2');
  return { [projection.id]: projection, [other.id]: other };
}

test('membership: an open View joins a Board with its own id, no copy, and leaves its previous Board', () => {
  const before = boardState();
  const frozen = JSON.stringify(before);
  const added = addProjectionMember(before, {
    projectionId: 'egd-board-2', viewId: 'egd-board-1-member-0', kind: 'card',
    record: { id: 'egd-board-1-member-0', type: 'browser', geometry: { x: 300, y: 300, width: 10, height: 10 } },
  });
  assert.equal(JSON.stringify(before), frozen, 'inputs are not mutated');
  assert.equal(added.changed, true);
  assert.deepEqual([added.from, added.to], ['egd-board-1', 'egd-board-2']);
  assert.equal(added.member.viewId, 'egd-board-1-member-0');
  assert.deepEqual(added.projections['egd-board-1'].members, []);
  assert.deepEqual(added.projections['egd-board-1'].idMap, {});
  assert.deepEqual(owningProjectionByView(added.projections), new Map([['egd-board-1-member-0', 'egd-board-2']]));
  const again = addProjectionMember(added.projections, { projectionId: 'egd-board-2', viewId: 'egd-board-1-member-0' });
  assert.equal(again.changed, false);
  assert.equal(again.projections, added.projections);
});

test('membership labels omit ambiguous View or projection IDs without changing legacy records', () => {
  const projections = [
    { id: 'a', title: '같은 이름', members: [{ viewId: 'shared' }, { viewId: 'only-a' }, { viewId: 'only-a' }] },
    { id: 'b', title: '같은 이름', members: [{ viewId: 'shared' }, { viewId: 'only-b' }] },
    { id: 'duplicate', title: '처음', members: [{ viewId: 'duplicate-owner' }] },
    { id: 'duplicate', title: '나중', members: [] },
  ];
  const before = structuredClone(projections);
  assert.deepEqual(owningProjectionByView(projections), new Map([['only-a', 'a'], ['only-b', 'b']]));
  assert.deepEqual(projections, before, 'resolving display metadata never repairs or mutates records');
});

test('membership: geometry is stored relative to the Board offset and the Board saves the View under its id', () => {
  const state = boardState();
  const added = addProjectionMember(state, {
    projectionId: 'egd-board-1', viewId: 'egd-card-9', kind: 'card',
    record: { id: 'egd-card-9', type: 'file', geometry: { x: 400, y: 250, width: 720, height: 640 } },
  });
  const member = added.member;
  assert.deepEqual([member.sourceId, member.record.geometry.x, member.record.geometry.y], ['egd-card-9', 300, 200]);
  const saved = snapshotBoardProjection(added.projections['egd-board-1'], {}, 1);
  assert.deepEqual(saved.agenda.memberCardIds, ['c1', 'egd-card-9']);
  assert.equal(saved.cards.find(card => card.id === 'egd-card-9').type, 'file');
  const clash = addProjectionMember(added.projections, { projectionId: 'egd-board-1', viewId: 'c1' });
  assert.equal(clash.member.sourceId, 'c1-2', 'a source id already used gets a suffix');
  assert.equal(clash.member.record.type, 'missing');
});

test('membership: removing a View keeps other Boards and works with arrays; bad ids change nothing', () => {
  const state = boardState();
  const removed = removeProjectionMember(state, { viewId: 'egd-board-1-member-0' });
  assert.equal(removed.changed, true);
  assert.equal(removed.from, 'egd-board-1');
  assert.equal(removed.member.sourceId, 'c1');
  assert.equal(removed.projections['egd-board-2'], state['egd-board-2']);
  assert.equal(removeProjectionMember(state, { viewId: 'nope' }).changed, false);
  assert.equal(removeProjectionMember(state, { viewId: null }).changed, false);
  const list = Object.values(boardState());
  const fromList = addProjectionMember(list, { projectionId: 'egd-board-2', viewId: 'egd-card-1' });
  assert.ok(Array.isArray(fromList.projections));
  assert.equal(fromList.projections[1].members.length, 1);
  assert.equal(addProjectionMember(state, { projectionId: 'missing', viewId: 'egd-card-1' }).changed, false);
});

test('rect helpers accept the Canvas and client shapes', () => {
  assert.deepEqual(toWorldRect({ left: 1, top: 2, right: 11, bottom: 22 }), rect(1, 2, 10, 20));
  assert.deepEqual(toWorldRect({ left: 1, top: 2, width: 3, height: 4 }), rect(1, 2, 3, 4));
  assert.equal(toWorldRect({ x: 1 }), null);
  assert.deepEqual(unionRect([rect(0, 0, 10, 10), rect(20, 5, 10, 10), null]), rect(0, 0, 30, 15));
});

// ---------------------------------------------------------------- Escape layers

const keyEvent = (extra = {}) => {
  const event = { key: 'Escape', prevented: 0, stopped: 0, defaultPrevented: false, ...extra };
  event.preventDefault = () => { event.prevented += 1; event.defaultPrevented = true; };
  event.stopPropagation = () => { event.stopped += 1; };
  return event;
};

test('Escape layers: each press closes only the newest open layer, one per key press', () => {
  const closed = [];
  const changes = [];
  const stack = createLayerStack({ onChange: list => changes.push(list.map(item => item.kind).join(',')) });
  stack.push({ id: 'fs', kind: 'fullscreen', dismiss: reason => closed.push(['fs', reason]) });
  stack.push({ id: 'menu', kind: 'menu', dismiss: reason => closed.push(['menu', reason]) });
  assert.deepEqual(stack.top(), { id: 'menu', kind: 'menu' });
  const first = keyEvent();
  assert.deepEqual(stack.handleEscape(first), { handled: true, dismissed: true, id: 'menu', kind: 'menu', reason: 'dismissed' });
  assert.deepEqual([first.prevented, first.stopped], [1, 1]);
  assert.equal(stack.handleEscape(first).reason, 'already-handled');
  // A listener that sees the event again (window and document, or a
  // non-cancelable synthetic event) still closes nothing more.
  const uncancelable = keyEvent();
  uncancelable.preventDefault = () => {};
  stack.push({ id: 'menu2', kind: 'menu', dismiss: reason => closed.push(['menu2', reason]) });
  assert.equal(stack.handleEscape(uncancelable).id, 'menu2');
  assert.equal(stack.handleEscape(uncancelable).reason, 'claimed', 'the same event never closes a second layer');
  const second = keyEvent();
  assert.equal(stack.handleEscape(second).id, 'fs');
  assert.deepEqual(closed, [['menu', 'escape'], ['menu2', 'escape'], ['fs', 'escape']]);
  assert.equal(stack.handleEscape(keyEvent()).reason, 'empty');
  assert.deepEqual(changes, ['fullscreen', 'fullscreen,menu', 'fullscreen', 'fullscreen,menu', 'fullscreen', '']);
});

test('Escape layers: Korean IME composition, other keys and already handled Escapes are left alone', () => {
  let count = 0;
  const stack = createLayerStack();
  stack.push({ kind: 'popover', dismiss: () => { count += 1; } });
  assert.equal(stack.handleEscape(keyEvent({ isComposing: true })).reason, 'composing');
  assert.equal(stack.handleEscape(keyEvent({ keyCode: 229 })).reason, 'composing');
  assert.equal(stack.handleEscape(keyEvent({ key: 'Enter' })).reason, 'not-escape');
  assert.equal(stack.handleEscape(keyEvent({ defaultPrevented: true })).reason, 'already-handled');
  assert.equal(count, 0);
  assert.equal(stack.size(), 1);
});

test('Escape layers: a layer can refuse or block, and nothing under it closes', () => {
  const lower = [];
  const stack = createLayerStack();
  stack.push({ id: 'peek', kind: 'peek', dismiss: () => lower.push('peek') });
  stack.push({ id: 'confirm', kind: 'dialog', dismissOnEscape: false, dismiss: () => lower.push('confirm') });
  const blocked = stack.handleEscape(keyEvent());
  assert.deepEqual([blocked.handled, blocked.dismissed, blocked.reason], [true, false, 'blocked']);
  stack.remove('confirm');
  stack.push({ id: 'unsaved', kind: 'dialog', dismiss: () => false });
  const refused = stack.handleEscape(keyEvent());
  assert.deepEqual([refused.dismissed, refused.reason], [false, 'refused']);
  assert.deepEqual(lower, []);
  assert.deepEqual(stack.list().map(layer => layer.id), ['peek', 'unsaved']);
});

test('Escape layers: re-opening moves a layer to the top, a failing layer is still removed, pop and clear work', () => {
  const stack = createLayerStack();
  stack.push({ id: 'minimap', kind: 'minimap' });
  stack.push({ id: 'menu', kind: 'menu' });
  stack.push({ id: 'minimap', kind: 'minimap' });
  assert.deepEqual(stack.list().map(layer => layer.id), ['menu', 'minimap']);
  stack.push({ id: 'broken', kind: 'menu', dismiss: () => { throw new Error('boom'); } });
  assert.equal(stack.handleEscape(keyEvent()).reason, 'dismiss-failed');
  assert.equal(stack.has('broken'), false);
  stack.push({ id: 'self', kind: 'menu', dismiss: () => { stack.remove('self'); } });
  assert.deepEqual(stack.pop(), { id: 'self', kind: 'menu' });
  assert.deepEqual(stack.pop(), { id: 'minimap', kind: 'minimap' });
  assert.equal(stack.push({ id: 'bad id!' }), null);
  assert.equal(stack.push(null), null);
  assert.match(stack.push({ kind: 'Not A Token' }), /^layer-\d+$/);
  assert.equal(stack.top().kind, 'layer');
  stack.clear();
  assert.equal(stack.size(), 0);
  assert.equal(stack.pop(), null);
});

test('Escape layers: pointer-down outside closes only a top layer that asked for it', () => {
  const closed = [];
  const stack = createLayerStack();
  stack.push({ id: 'fs', kind: 'fullscreen', dismiss: () => closed.push('fs') });
  assert.equal(stack.handlePointerDown({ target: 'canvas' }).reason, 'not-dismissable');
  stack.push({ id: 'menu', kind: 'menu', dismissOnPointerOutside: true, contains: target => target === 'menu-item', dismiss: reason => closed.push(reason) });
  assert.equal(stack.handlePointerDown({ target: 'menu-item' }).reason, 'inside');
  const outside = stack.handlePointerDown({ target: 'canvas' });
  assert.deepEqual([outside.handled, outside.id], [true, 'menu']);
  assert.deepEqual(closed, ['pointer-down-outside']);
});

// ---------------------------------------------------------------- module hygiene

// ---------------------------------------------------------------- groups and numeric input

test('groups: a clean list of two-or-more Views, one group per View, and selection expands to the whole group', () => {
  const groups = normalizeCanvasGroups([
    { id: 'g1', viewIds: ['a', 'b', 'a'] }, { id: 'g2', viewIds: ['b', 'c'] }, { id: 'g1', viewIds: ['x', 'y'] },
    { id: 'bad id!', viewIds: ['m', 'n'] }, { id: 'g3', viewIds: ['c', 'd'] }, null,
  ]);
  assert.deepEqual(groups, [{ id: 'g1', viewIds: ['a', 'b'] }, { id: 'g3', viewIds: ['c', 'd'] }], 'g2 is left with one View and dissolves');
  assert.equal(canvasGroupOf(groups, 'd').id, 'g3');
  assert.equal(canvasGroupOf(groups, 'zzz'), null);
  assert.deepEqual(expandCanvasGroupSelection(groups, ['d', 'e', 'a']), ['d', 'c', 'e', 'a', 'b']);
  assert.deepEqual(normalizeCanvasGroups({ id: 'g' }), []);
});

test('groups: [그룹으로 묶기] takes Views out of their old groups, [그룹 해제] dissolves, closed Views prune', () => {
  const start = [{ id: 'egd-group-1', viewIds: ['a', 'b', 'c'] }];
  const made = createCanvasGroup(start, ['c', 'd', 'd']);
  assert.equal(made.changed, true);
  assert.deepEqual(made.groups, [{ id: 'egd-group-1', viewIds: ['a', 'b'] }, { id: 'egd-group-2', viewIds: ['c', 'd'] }]);
  const collapsed = createCanvasGroup([{ id: 'egd-group-1', viewIds: ['a', 'b'] }], ['b', 'z']);
  assert.deepEqual(collapsed.groups, [{ id: 'egd-group-2', viewIds: ['b', 'z'] }], 'a group left with one View dissolves; ids are not reused');
  assert.equal(createCanvasGroup(start, ['only']).changed, false);
  const dissolved = dissolveCanvasGroups(made.groups, ['a', 'nobody']);
  assert.deepEqual(dissolved, { groups: [{ id: 'egd-group-2', viewIds: ['c', 'd'] }], dissolved: ['egd-group-1'], changed: true });
  assert.equal(dissolveCanvasGroups(made.groups, ['nobody']).changed, false);
  const pruned = pruneCanvasGroups(made.groups, ['a', 'b', 'c']);
  assert.deepEqual(pruned, { groups: [{ id: 'egd-group-1', viewIds: ['a', 'b'] }], changed: true });
  assert.equal(pruneCanvasGroups(pruned.groups, ['a', 'b']).changed, false);
  const remapped = remapCanvasGroups(made.groups, new Map([['a', 'a-2']]));
  assert.deepEqual(remapped[0].viewIds, ['a-2', 'b']);
  assert.deepEqual(remapCanvasGroups(made.groups, { c: 'c-9' })[1].viewIds, ['c-9', 'd']);
});

test('groups: the frame is the members\' union plus padding, and skips groups with fewer than two Views on the Canvas', () => {
  const groups = [{ id: 'g', viewIds: ['a', 'b'] }, { id: 'h', viewIds: ['c', 'gone'] }];
  const rects = new Map([['a', rect(100, 100, 200, 100)], ['b', rect(400, 150, 100, 300)], ['c', rect(0, 0, 10, 10)]]);
  assert.deepEqual(canvasGroupFrames(groups, rects), [{ id: 'g', count: 2, x: 92, y: 92, width: 416, height: 366 }]);
  assert.deepEqual(canvasGroupFrames(groups, id => rects.get(id), { padding: 0 })[0], { id: 'g', count: 2, x: 100, y: 100, width: 400, height: 350 });
  assert.deepEqual(canvasGroupFrames(groups, { a: rect(0, 0, 1, 1) }), []);
});

test('numeric input: integers as typed, empty fields keep their value, sizes never go below the minimum', () => {
  assert.deepEqual(parsePlacementInput({ x: '48', y: ' -24 ' }), { ok: true, field: null, rect: { x: 48, y: -24 } });
  assert.deepEqual(parsePlacementInput({ width: '100', height: '' }, { minWidth: 320, minHeight: 250 }), { ok: true, field: null, rect: { width: 320 } });
  assert.deepEqual(parsePlacementInput({ x: '12.6', y: 7 }), { ok: true, field: null, rect: { x: 13, y: 7 } });
  assert.deepEqual(parsePlacementInput({ x: '10', y: 'abc' }), { ok: false, field: 'y', rect: null });
  assert.deepEqual(parsePlacementInput({ x: '1e3' }), { ok: false, field: 'x', rect: null });
  assert.deepEqual(parsePlacementInput({}), { ok: false, field: null, rect: null });
  assert.deepEqual(parsePlacementInput({ width: '5', height: '5' }).rect, { width: 5, height: 5 }, 'the default minimum is 1');
});

test('both modules stay pure and carry the MIT notices of the code they adapt', () => {
  const layout = readFileSync(new URL('../overlay/resources/EGDeskCanvasLayout.sys.mjs', import.meta.url), 'utf8');
  const layers = readFileSync(new URL('../overlay/resources/EGDeskLayerStack.sys.mjs', import.meta.url), 'utf8');
  for (const source of [layout, layers]) {
    assert.doesNotMatch(source, /\b(document|window|Services|ChromeUtils|localStorage|console)\./);
    assert.match(source, /Permission is hereby granted/);
  }
  assert.match(layout, /Copyright \(c\) 2026 DeadWaveWave/);
  assert.match(layout, /Copyright \(c\) 2020 Excalidraw/);
  assert.match(layout, /Copyright \(c\) 2019-2025 webkid GmbH/);
  assert.match(layers, /Copyright \(c\) 2026 DeadWaveWave/);
});
