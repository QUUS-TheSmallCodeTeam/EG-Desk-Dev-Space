// EG-Desk Canvas layout math (UX-02, UX-05, UX-06, CNV-01, CNV-02, CNV-03).
// Pure functions: no DOM, no Services, no storage, no logging. The screen file
// (eg-desk-surface.uc.js) measures rects, calls these, and applies the result.
//
// World rects are { x, y, width, height } in Canvas px (the same shape
// persistentEntityGeometry returns). Client boxes are { left, top, right,
// bottom } in window px (the same shape safeViewportRect returns). A client
// point is world * zoom + pan.
//
// Portions are adapted from MIT-licensed projects:
//   opencove  - Copyright (c) 2026 DeadWaveWave
//               https://github.com/DeadWaveWave/opencove (e10604b9)
//               workspaceSnap.ts:26-308 (snap candidates, axis pick),
//               workspaceArrange.flowPacking.ts:14-101 (flow packing),
//               canvasCollapseArrange.snapshot.ts:121-172 (undo only when the
//               current geometry still equals the recorded one),
//               spaceContainment.ts:32-86 (clamp, innermost region),
//               useSpaceOwnership.drop.helpers.ts:60-101 (one owner per view),
//               useSpaceDrag.ts:93-140 (snap the frame, move members by delta),
//               canvasCollapse.ts:37-90 (collapsed id list, display size).
//   excalidraw - Copyright (c) 2020 Excalidraw
//               https://github.com/excalidraw/excalidraw
//               snapping.ts:41-49 (8px snap distance divided by zoom),
//               SearchMenu.tsx:194-255, :792-887 (frames first, sorted by y,
//               first visible match focused, scale-down fit).
//   xyflow    - Copyright (c) 2019-2025 webkid GmbH
//               https://github.com/xyflow/xyflow
//               MiniMap.tsx:78-90, :155-185 (viewBox and mask path).
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit
//   persons to whom the Software is furnished to do so, subject to the
//   following conditions: The above copyright notice and this permission
//   notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
//   EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
//   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
//   NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
//   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
//   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
//   USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// Patterns only, no code copied (license does not allow it):
//   tldraw (tldraw license) SnapManager.ts:60-100 (only on-screen siblings),
//     HistoryManager.ts:260-312 (one gesture = one undo step),
//     DragAndDropManager.ts:14-15, :86-125 (re-check ownership on an interval);
//   driftwm (GPL-3.0) snap.rs:127-183 (dock with a gap, no alignment to an
//     overlapping neighbour), auto_placement.rs:79-200 (place beside the
//     focused window, aligned first, then sliding along the edge);
//   collab-public (FSL-1.1) edge-indicators.js:8-60 (off-screen dot on the
//     viewport edge along the ray from the centre).

import { fitSurfaceCamera, nearestFreeCanvasSpot } from './EGDeskSurfaceState.sys.mjs';

export const CANVAS_GRID_PX = 24;
export const CANVAS_GAP_PX = 24;
// Screen px; the world threshold is this divided by the camera zoom.
export const CANVAS_SNAP_SCREEN_PX = 8;
export const CANVAS_SNAP_MAX_CANDIDATES = 96;
const SNAP_SEARCH_PADDING_PX = 288;
// A collapsed View keeps its top-left (where its header is) and shows as a
// title tile of this size; the stored geometry keeps the full size.
export const COLLAPSED_VIEW_SIZE = Object.freeze({ width: 240, height: 48 });
// Board ownership under a dragged View is re-checked on an interval, slower
// when many Views move together.
export const REGION_RECHECK_MS = 60;
export const REGION_RECHECK_SLOW_MS = 320;
export const MINIMAP_ROW_LIMIT = 200;
export const MINIMAP_QUERY_MAX = 100;
export const LAYOUT_HISTORY_LIMIT = 50;

export const VIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const finite = (...values) => values.every(Number.isFinite);
const viewId = value => typeof value === 'string' && VIEW_ID_PATTERN.test(value) ? value : null;

// Accepts { x, y, width, height }, { left, top, width, height } or
// { left, top, right, bottom }; null when it is not a usable rect.
export function toWorldRect(value) {
  if (!value || typeof value !== 'object') return null;
  let rect = null;
  if (finite(value.x, value.y, value.width, value.height)) {
    rect = { x: value.x, y: value.y, width: value.width, height: value.height };
  } else if (finite(value.left, value.top, value.width, value.height)) {
    rect = { x: value.left, y: value.top, width: value.width, height: value.height };
  } else if (finite(value.left, value.top, value.right, value.bottom)) {
    rect = { x: value.left, y: value.top, width: value.right - value.left, height: value.bottom - value.top };
  }
  return rect && rect.width >= 0 && rect.height >= 0 ? rect : null;
}

const toBox = value => {
  const rect = toWorldRect(value);
  return rect && rect.width > 0 && rect.height > 0
    ? { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height } : null;
};
const right = rect => rect.x + rect.width;
const bottom = rect => rect.y + rect.height;
const sameRect = (a, b, tolerance = 0.5) => !!a && !!b
  && Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
  && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
const intersectsBox = (rect, box) => rect.x < box.right && right(rect) > box.left
  && rect.y < box.bottom && bottom(rect) > box.top;
const plainRect = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });

export function unionRect(rects) {
  const list = (Array.isArray(rects) ? rects : []).map(toWorldRect).filter(Boolean);
  if (!list.length) return null;
  const x = Math.min(...list.map(rect => rect.x));
  const y = Math.min(...list.map(rect => rect.y));
  return { x, y, width: Math.max(...list.map(right)) - x, height: Math.max(...list.map(bottom)) - y };
}

// ---------------------------------------------------------------------------
// UX-05 snapping: 24px grid, other Views' edges and centres, and docking a
// gap away from a side-by-side neighbour. Option/Alt (`free`) turns it off.

const AXES = Object.freeze({
  x: Object.freeze({ lo: rect => rect.x, size: rect => rect.width, plo: rect => rect.y, psize: rect => rect.height }),
  y: Object.freeze({ lo: rect => rect.y, size: rect => rect.height, plo: rect => rect.x, psize: rect => rect.width }),
});

function axisDistance(moving, other, axis) {
  const A = AXES[axis];
  const a = [A.lo(moving), A.lo(moving) + A.size(moving) / 2, A.lo(moving) + A.size(moving)];
  const b = [A.lo(other), A.lo(other) + A.size(other) / 2, A.lo(other) + A.size(other)];
  let best = Infinity;
  for (const left of a) for (const value of b) best = Math.min(best, Math.abs(left - value));
  return best;
}

function snapCandidates(rect, candidates, { viewport, excludeIds, threshold }) {
  const box = viewport ? toBox(viewport) : null;
  const excluded = new Set(Array.isArray(excludeIds) || excludeIds instanceof Set ? excludeIds : []);
  const list = (Array.isArray(candidates) ? candidates : []).filter(item => !(item?.id != null && excluded.has(item.id)))
    .map(toWorldRect).filter(other => other && other.width > 0 && other.height > 0 && (!box || intersectsBox(other, box)));
  if (list.length <= CANVAS_SNAP_MAX_CANDIDATES) return list;
  const reach = threshold + SNAP_SEARCH_PADDING_PX;
  const grown = { left: rect.x - SNAP_SEARCH_PADDING_PX, top: rect.y - SNAP_SEARCH_PADDING_PX,
    right: right(rect) + SNAP_SEARCH_PADDING_PX, bottom: bottom(rect) + SNAP_SEARCH_PADDING_PX };
  return list.map(other => {
    const distance = Math.min(axisDistance(rect, other, 'x'), axisDistance(rect, other, 'y'));
    return { other, distance, area: other.width * other.height, near: distance <= reach || intersectsBox(other, grown) };
  }).filter(item => item.near)
    .sort((a, b) => a.distance - b.distance || a.area - b.area)
    .slice(0, CANVAS_SNAP_MAX_CANDIDATES).map(item => item.other);
}

function axisSnap(rect, others, axis, sources, { threshold, grid, gap, enableGrid, enableObject }) {
  const A = AXES[axis];
  const lo = A.lo(rect);
  const line = { low: lo, center: lo + A.size(rect) / 2, high: lo + A.size(rect) };
  const plo = A.plo(rect);
  const phi = plo + A.psize(rect);
  const found = [];
  if (enableGrid && grid > 0) {
    // Moving snaps its leading edge to the grid; resizing snaps the dragged edge.
    const source = sources.includes('low') ? 'low' : sources.includes('high') ? 'high' : null;
    if (source) {
      const delta = Math.round(line[source] / grid) * grid - line[source];
      if (Math.abs(delta) <= threshold) found.push({ type: 'grid', delta, source });
    }
  }
  if (enableObject) {
    for (const other of others) {
      const olo = A.lo(other);
      const ohi = olo + A.size(other);
      const oplo = A.plo(other);
      const ophi = oplo + A.psize(other);
      const sideBySide = phi > oplo && ophi > plo;
      if (sideBySide) {
        // Lining up with a neighbour that shares the perpendicular span would
        // only stack the two; dock a gap away instead.
        if (sources.includes('high')) {
          const delta = olo - gap - line.high;
          if (Math.abs(delta) <= threshold) found.push({ type: 'dock', delta, source: 'high', contact: olo, other });
        }
        if (sources.includes('low')) {
          const delta = ohi + gap - line.low;
          if (Math.abs(delta) <= threshold) found.push({ type: 'dock', delta, source: 'low', contact: ohi, other });
        }
        continue;
      }
      for (const [source, target, reason] of [['low', olo, 'edge'], ['center', olo + A.size(other) / 2, 'center'], ['high', ohi, 'edge']]) {
        if (!sources.includes(source)) continue;
        const delta = target - line[source];
        if (Math.abs(delta) <= threshold) found.push({ type: 'align', delta, source, target, reason, other });
      }
    }
  }
  let best = null;
  for (const candidate of found) {
    const size = Math.abs(candidate.delta);
    const bestSize = best ? Math.abs(best.delta) : Infinity;
    if (size < bestSize || (size === bestSize && best?.type === 'grid' && candidate.type !== 'grid')) best = candidate;
  }
  return best;
}

function snapGuide(best, axis, rect) {
  if (!best || best.type === 'grid') return null;
  const other = best.other;
  if (best.type === 'align') {
    return axis === 'x'
      ? { kind: 'v', x: best.target, y1: Math.min(rect.y, other.y), y2: Math.max(bottom(rect), bottom(other)), reason: best.reason }
      : { kind: 'h', y: best.target, x1: Math.min(rect.x, other.x), x2: Math.max(right(rect), right(other)), reason: best.reason };
  }
  const edge = best.source === 'high' ? (axis === 'x' ? right(rect) : bottom(rect)) : (axis === 'x' ? rect.x : rect.y);
  const A = AXES[axis];
  const overlapLow = Math.max(A.plo(rect), A.plo(other));
  const overlapHigh = Math.min(A.plo(rect) + A.psize(rect), A.plo(other) + A.psize(other));
  return { kind: 'gap', axis, start: Math.min(edge, best.contact), end: Math.max(edge, best.contact), at: (overlapLow + overlapHigh) / 2 };
}

// `rect` is where the pointer would put the View (or Board region). With
// `edges` ({ left, right, top, bottom } booleans) only the dragged edges snap
// and the size changes instead, never below minWidth/minHeight.
export function snapCanvasRect({
  rect, candidates = [], excludeIds = [], zoom = 1, grid = CANVAS_GRID_PX, gap = CANVAS_GAP_PX,
  threshold = null, free = false, viewport = null, edges = null, minWidth = 0, minHeight = 0,
  enableGrid = true, enableObject = true,
} = {}) {
  const base = toWorldRect(rect);
  if (!base) return null;
  const unchanged = { ...base, dx: 0, dy: 0, guides: [], snappedX: null, snappedY: null };
  const limit = Number.isFinite(threshold) ? threshold : CANVAS_SNAP_SCREEN_PX / (zoom > 0 ? zoom : 1);
  if (free || !(limit > 0) || (!enableGrid && !enableObject)) return unchanged;
  const others = enableObject ? snapCandidates(base, candidates, { viewport, excludeIds, threshold: limit }) : [];
  const resize = !!edges && typeof edges === 'object';
  const sourcesX = resize ? (edges.right ? ['high'] : edges.left ? ['low'] : []) : ['low', 'center', 'high'];
  const sourcesY = resize ? (edges.bottom ? ['high'] : edges.top ? ['low'] : []) : ['low', 'center', 'high'];
  const options = { threshold: limit, grid, gap, enableGrid, enableObject };
  let bestX = sourcesX.length ? axisSnap(base, others, 'x', sourcesX, options) : null;
  let bestY = sourcesY.length ? axisSnap(base, others, 'y', sourcesY, options) : null;
  const next = { ...base };
  if (!resize) {
    next.x += bestX?.delta || 0;
    next.y += bestY?.delta || 0;
  } else {
    if (bestX) {
      const width = bestX.source === 'high' ? base.width + bestX.delta : base.width - bestX.delta;
      if (width < minWidth || width <= 0) bestX = null;
      else { next.width = width; if (bestX.source === 'low') next.x = base.x + bestX.delta; }
    }
    if (bestY) {
      const height = bestY.source === 'high' ? base.height + bestY.delta : base.height - bestY.delta;
      if (height < minHeight || height <= 0) bestY = null;
      else { next.height = height; if (bestY.source === 'low') next.y = base.y + bestY.delta; }
    }
  }
  const guides = [snapGuide(bestX, 'x', next), snapGuide(bestY, 'y', next)].filter(Boolean);
  return {
    ...next, dx: next.x - base.x, dy: next.y - base.y, guides,
    snappedX: bestX?.type || null, snappedY: bestY?.type || null,
  };
}

// The guide lines a snap returned, as screen boxes: a thin line for 'v'/'h'
// alignment and a bar across the 24px gap for 'gap'. The screen file draws
// them as fixed elements, so they never scale with the camera.
export function snapGuideScreenBoxes(guides = [], { pan, zoom, thickness = 1 } = {}) {
  if (!finite(pan?.x, pan?.y) || !(zoom > 0)) return [];
  const sx = x => x * zoom + pan.x;
  const sy = y => y * zoom + pan.y;
  const size = Number.isFinite(thickness) && thickness > 0 ? thickness : 1;
  const half = size / 2;
  const out = [];
  for (const guide of Array.isArray(guides) ? guides : []) {
    if (!guide || typeof guide !== 'object') continue;
    if (guide.kind === 'v' && finite(guide.x, guide.y1, guide.y2)) {
      out.push({ kind: 'v', reason: guide.reason || null, left: sx(guide.x) - half,
        top: sy(Math.min(guide.y1, guide.y2)), width: size, height: Math.abs(guide.y2 - guide.y1) * zoom });
    } else if (guide.kind === 'h' && finite(guide.y, guide.x1, guide.x2)) {
      out.push({ kind: 'h', reason: guide.reason || null, left: sx(Math.min(guide.x1, guide.x2)),
        top: sy(guide.y) - half, width: Math.abs(guide.x2 - guide.x1) * zoom, height: size });
    } else if (guide.kind === 'gap' && finite(guide.start, guide.end, guide.at)) {
      const length = Math.abs(guide.end - guide.start) * zoom;
      if (guide.axis === 'x') out.push({ kind: 'gap', axis: 'x', left: sx(Math.min(guide.start, guide.end)), top: sy(guide.at) - half, width: length, height: size });
      else out.push({ kind: 'gap', axis: 'y', left: sx(guide.at) - half, top: sy(Math.min(guide.start, guide.end)), width: size, height: length });
    }
  }
  return out;
}

// CNV-01: dragging a Board's title row moves the region; its member Views
// follow by the same (snapped) delta.
export function moveRegionWithMembers({ region, members = [], dx = 0, dy = 0, snap = null } = {}) {
  const frame = toWorldRect(region);
  if (!frame || !finite(dx, dy)) return null;
  const desired = { ...frame, x: frame.x + dx, y: frame.y + dy };
  const memberIds = (Array.isArray(members) ? members : []).map(member => member?.id).filter(id => id != null);
  const snapped = snap && typeof snap === 'object'
    ? snapCanvasRect({ ...snap, rect: desired, edges: null, excludeIds: [...(snap.excludeIds || []), ...memberIds] })
    : { ...desired, guides: [] };
  const moveX = snapped.x - frame.x;
  const moveY = snapped.y - frame.y;
  return {
    region: { ...frame, x: snapped.x, y: snapped.y },
    members: (Array.isArray(members) ? members : []).map(member => {
      const rect = toWorldRect(member?.rect);
      return member?.id != null && rect ? { id: member.id, ...rect, x: rect.x + moveX, y: rect.y + moveY } : null;
    }).filter(Boolean),
    dx: moveX, dy: moveY, guides: snapped.guides,
  };
}

// ---------------------------------------------------------------------------
// UX-05 layout undo. One gesture (a drag, a resize, an arrange) is one step.
// A step is undone only while every View still has the rect the step left it
// with; a View moved, resized or closed since makes the step stale and it is
// dropped instead of overwriting the newer geometry. A step may also carry
// the group list before and after ([그룹으로 묶기]/[그룹 해제]); undo and redo
// hand back the list to restore.

const historyItems = (items, field) => (Array.isArray(items) ? items : []).map(item => {
  const id = viewId(item?.id);
  const rect = toWorldRect(item?.[field] ?? item?.rect);
  return id && rect ? { id, rect: plainRect(rect) } : null;
}).filter(Boolean);

export function createLayoutHistory({ limit = LAYOUT_HISTORY_LIMIT, tolerance = 0.5 } = {}) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : LAYOUT_HISTORY_LIMIT;
  let undos = [];
  let redos = [];

  function record({ label = 'move', items = [], groups = null } = {}) {
    const byId = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const id = viewId(item?.id);
      const before = toWorldRect(item?.before);
      const after = toWorldRect(item?.after);
      if (!id || !before || !after) continue;
      const known = byId.get(id);
      byId.set(id, { id, before: known ? known.before : plainRect(before), after: plainRect(after) });
    }
    const changed = [...byId.values()].filter(item => !sameRect(item.before, item.after, 0));
    const groupStep = groups && typeof groups === 'object'
      ? { before: normalizeCanvasGroups(groups.before), after: normalizeCanvasGroups(groups.after) } : null;
    const groupsChanged = !!groupStep && JSON.stringify(groupStep.before) !== JSON.stringify(groupStep.after);
    if (!changed.length && !groupsChanged) return false;
    undos.push({ label: typeof label === 'string' && LABEL_PATTERN.test(label) ? label : 'move', items: changed, groups: groupsChanged ? groupStep : null });
    if (undos.length > max) undos = undos.slice(undos.length - max);
    redos = [];
    return true;
  }

  function step(from, to, expect, apply, readRect, done) {
    const entry = from.pop();
    if (!entry) return { status: 'empty', label: null, rects: [], staleIds: [], groups: null };
    const read = typeof readRect === 'function' ? readRect : () => null;
    const staleIds = entry.items.filter(item => !sameRect(toWorldRect(read(item.id)), item[expect], tolerance)).map(item => item.id);
    if (staleIds.length) return { status: 'stale', label: entry.label, rects: [], staleIds, groups: null };
    to.push(entry);
    return {
      status: done, label: entry.label, rects: entry.items.map(item => ({ id: item.id, ...item[apply] })), staleIds: [],
      groups: entry.groups ? entry.groups[apply].map(group => ({ id: group.id, viewIds: [...group.viewIds] })) : null,
    };
  }

  return {
    record,
    // Capture rects at pointer-down, commit at pointer-up. A gesture that
    // ends where it started records nothing.
    startGesture(label, items = []) {
      const before = historyItems(items, 'rect');
      let open = true;
      return {
        commit(afterItems = []) {
          if (!open) return false;
          open = false;
          const after = new Map(historyItems(afterItems, 'rect').map(item => [item.id, item.rect]));
          return record({ label, items: before.filter(item => after.has(item.id))
            .map(item => ({ id: item.id, before: item.rect, after: after.get(item.id) })) });
        },
        cancel() { open = false; },
      };
    },
    undo(readRect) { return step(undos, redos, 'after', 'before', readRect, 'undone'); },
    redo(readRect) { return step(redos, undos, 'before', 'after', readRect, 'redone'); },
    canUndo: () => undos.length > 0,
    canRedo: () => redos.length > 0,
    size: () => ({ undo: undos.length, redo: redos.length }),
    clear() { undos = []; redos = []; },
  };
}

// ---------------------------------------------------------------------------
// UX-05 [겹침 없이 정리]: chosen Views keep their sizes and reading order
// (top to bottom, then left to right) and are packed in rows from the
// grid-aligned top-left of their current bounds. A block that would cover
// another View or Board region moves to the closest free spot as a whole.

const snapDown = (value, grid) => Math.floor(value / (grid > 0 ? grid : 1)) * (grid > 0 ? grid : 1);

export function arrangeWithoutOverlap({
  items = [], gap = CANVAS_GAP_PX, grid = CANVAS_GRID_PX, wrapWidth = null, aspect = 16 / 9, obstacles = [], start = null,
} = {}) {
  const seen = new Set();
  const list = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = viewId(item?.id);
    const rect = toWorldRect(item?.rect ?? item);
    if (!id || !rect || !(rect.width > 0 && rect.height > 0) || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, rect: plainRect(rect) });
  }
  if (!list.length) return { placements: [], bounds: null, changed: false };
  list.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : CANVAS_GAP_PX;
  const bounds = unionRect(list.map(item => item.rect));
  const origin = finite(start?.x, start?.y) ? { x: start.x, y: start.y } : { x: snapDown(bounds.x, grid), y: snapDown(bounds.y, grid) };
  const widest = Math.max(...list.map(item => item.rect.width));
  const area = list.reduce((sum, item) => sum + (item.rect.width + safeGap) * (item.rect.height + safeGap), 0);
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const wrap = Math.max(widest, Number.isFinite(wrapWidth) && wrapWidth > 0 ? wrapWidth : snapDown(Math.sqrt(area * ratio), grid));
  const placed = [];
  let cursorX = origin.x;
  let cursorY = origin.y;
  let rowHeight = 0;
  for (const item of list) {
    if (cursorX !== origin.x && cursorX + item.rect.width > origin.x + wrap) {
      cursorX = origin.x;
      cursorY += rowHeight + safeGap;
      rowHeight = 0;
    }
    placed.push({ id: item.id, x: cursorX, y: cursorY, width: item.rect.width, height: item.rect.height });
    cursorX += item.rect.width + safeGap;
    rowHeight = Math.max(rowHeight, item.rect.height);
  }
  let block = unionRect(placed);
  const blockers = (Array.isArray(obstacles) ? obstacles : []).filter(item => !(item?.id != null && seen.has(item.id)))
    .map(toWorldRect).filter(rect => rect && rect.width > 0 && rect.height > 0);
  const grownBlock = { left: block.x - safeGap, top: block.y - safeGap, right: right(block) + safeGap, bottom: bottom(block) + safeGap };
  if (blockers.some(rect => intersectsBox(rect, grownBlock))) {
    const spot = nearestFreeCanvasSpot({ width: block.width, height: block.height, target: { x: block.x, y: block.y }, occupied: blockers, gap: safeGap });
    if (spot) {
      const moveX = spot.x - block.x;
      const moveY = spot.y - block.y;
      for (const item of placed) { item.x += moveX; item.y += moveY; }
      block = unionRect(placed);
    }
  }
  const original = new Map(list.map(item => [item.id, item.rect]));
  return { placements: placed, bounds: block, changed: placed.some(item => !sameRect(item, original.get(item.id), 0)) };
}

// [선택 N개 겹침 없이 정리] inside the visible area (world box of the safe
// area). The block starts at the grid-aligned top-left of the selection,
// pulled inside the visible area when it is outside, and wraps at the visible
// area's right edge. A group whose member is chosen moves as one block that
// keeps its inner layout; Views not chosen and Board regions are obstacles.
export function arrangeInVisibleArea({
  items = [], groups = [], visible = null, obstacles = [], gap = CANVAS_GAP_PX, grid = CANVAS_GRID_PX, margin = CANVAS_GAP_PX,
} = {}) {
  const empty = { placements: [], bounds: null, changed: false, start: null, wrapWidth: null };
  const views = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const id = viewId(item?.id);
    const rect = toWorldRect(item?.rect ?? item);
    if (!id || !rect || !(rect.width > 0 && rect.height > 0) || seen.has(id)) continue;
    seen.add(id);
    views.push({ id, rect: plainRect(rect) });
  }
  if (!views.length) return empty;
  // One block per group (its members' union) or per ungrouped View.
  const blocks = [];
  const blockOf = new Map();
  for (const view of views) {
    const group = canvasGroupOf(groups, view.id);
    const key = group ? `group:${group.id}` : view.id;
    let block = blockOf.get(key);
    if (!block) {
      block = { key, members: [] };
      blockOf.set(key, block);
      blocks.push(block);
    }
    block.members.push(view);
  }
  for (const block of blocks) block.rect = unionRect(block.members.map(member => member.rect));
  const bounds = unionRect(blocks.map(block => block.rect));
  const step = grid > 0 ? grid : 1;
  const pad = Number.isFinite(margin) && margin >= 0 ? margin : CANVAS_GAP_PX;
  const box = visible ? toBox(visible) : null;
  let x = snapDown(bounds.x, step);
  let y = snapDown(bounds.y, step);
  let wrapWidth = null;
  if (box) {
    const left = Math.ceil((box.left + pad) / step) * step;
    const top = Math.ceil((box.top + pad) / step) * step;
    if (x < left || x >= box.right - pad) x = left;
    if (y < top || y >= box.bottom - pad) y = top;
    wrapWidth = Math.max(step, box.right - pad - x);
  }
  // Block ids are internal; a group's key never collides with a View id
  // because View ids cannot contain ':'.
  const packed = arrangeWithoutOverlap({
    items: blocks.map((block, index) => ({ id: `b${index}`, rect: block.rect })),
    gap, grid, obstacles, start: { x, y }, wrapWidth,
  });
  const placements = [];
  packed.placements.forEach(placed => {
    const block = blocks[Number(placed.id.slice(1))];
    if (!block) return;
    const dx = placed.x - block.rect.x;
    const dy = placed.y - block.rect.y;
    for (const member of block.members) placements.push({ id: member.id, ...member.rect, x: member.rect.x + dx, y: member.rect.y + dy });
  });
  const original = new Map(views.map(view => [view.id, view.rect]));
  return {
    placements, bounds: unionRect(placements), start: { x, y }, wrapWidth,
    changed: placements.some(item => !sameRect(item, original.get(item.id), 0)),
  };
}

// ---------------------------------------------------------------------------
// UX-05 groups ([그룹으로 묶기]/[그룹 해제]): a visual bundle of Views that
// move and select together. A group is { id, viewIds } with two or more
// Views; a View is in one group at most. Groups are separate from Board
// membership (D-V1) and are saved with the Desk, not with a Board.

export const CANVAS_GROUP_MAX_VIEWS = 200;

export function normalizeCanvasGroups(value) {
  const out = [];
  const seenGroups = new Set();
  const seenViews = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const id = viewId(item?.id);
    if (!id || seenGroups.has(id)) continue;
    const viewIds = [];
    for (const raw of Array.isArray(item.viewIds) ? item.viewIds : []) {
      const key = viewId(raw);
      if (!key || seenViews.has(key) || viewIds.includes(key)) continue;
      viewIds.push(key);
      if (viewIds.length >= CANVAS_GROUP_MAX_VIEWS) break;
    }
    if (viewIds.length < 2) continue;
    seenGroups.add(id);
    for (const key of viewIds) seenViews.add(key);
    out.push({ id, viewIds });
  }
  return out;
}

export function canvasGroupOf(groups, id) {
  const key = viewId(id);
  if (!key) return null;
  return (Array.isArray(groups) ? groups : []).find(group => Array.isArray(group?.viewIds) && group.viewIds.includes(key)) || null;
}

// Every View that moves or selects with the given ones: the ids themselves
// plus the rest of each one's group, in the order first seen.
export function expandCanvasGroupSelection(groups, ids) {
  const out = [];
  const add = key => { if (key && !out.includes(key)) out.push(key); };
  for (const raw of Array.isArray(ids) ? ids : []) {
    const key = viewId(raw);
    if (!key) continue;
    add(key);
    const group = canvasGroupOf(groups, key);
    if (group) for (const member of group.viewIds) add(member);
  }
  return out;
}

// [그룹으로 묶기]: the chosen Views form one group. Each leaves its previous
// group, and a previous group left with one View dissolves.
export function createCanvasGroup(groups, ids, { id = null } = {}) {
  const current = normalizeCanvasGroups(groups);
  const members = [...new Set((Array.isArray(ids) ? ids : []).map(viewId).filter(Boolean))].slice(0, CANVAS_GROUP_MAX_VIEWS);
  if (members.length < 2) return { groups: current, group: null, changed: false };
  const taken = new Set(current.map(group => group.id));
  let groupId = viewId(id) && !taken.has(id) ? id : null;
  for (let n = 1; !groupId; n += 1) {
    const candidate = `egd-group-${n}`;
    if (!taken.has(candidate)) groupId = candidate;
  }
  const memberSet = new Set(members);
  const kept = current.map(group => ({ id: group.id, viewIds: group.viewIds.filter(key => !memberSet.has(key)) }))
    .filter(group => group.viewIds.length >= 2);
  const group = { id: groupId, viewIds: members };
  return { groups: [...kept, group], group, changed: true };
}

// [그룹 해제]: every group that holds one of the Views dissolves.
export function dissolveCanvasGroups(groups, ids) {
  const current = normalizeCanvasGroups(groups);
  const keys = new Set((Array.isArray(ids) ? ids : []).map(viewId).filter(Boolean));
  const dissolved = current.filter(group => group.viewIds.some(key => keys.has(key))).map(group => group.id);
  if (!dissolved.length) return { groups: current, dissolved: [], changed: false };
  return { groups: current.filter(group => !dissolved.includes(group.id)), dissolved, changed: true };
}

// Closed Views leave their groups; a group left with one View dissolves.
export function pruneCanvasGroups(groups, liveIds) {
  const live = new Set((Array.isArray(liveIds) ? liveIds : []).map(viewId).filter(Boolean));
  const current = normalizeCanvasGroups(groups);
  const next = normalizeCanvasGroups(current.map(group => ({ id: group.id, viewIds: group.viewIds.filter(key => live.has(key)) })));
  return { groups: next, changed: JSON.stringify(next) !== JSON.stringify(current) };
}

// Restored Views may come back under new ids (saved id -> live id).
export function remapCanvasGroups(groups, idMap) {
  const map = idMap instanceof Map ? idMap : new Map(Object.entries(idMap && typeof idMap === 'object' ? idMap : {}));
  return normalizeCanvasGroups((Array.isArray(groups) ? groups : []).map(group => ({
    id: group?.id, viewIds: (Array.isArray(group?.viewIds) ? group.viewIds : []).map(key => map.get(key) ?? key),
  })));
}

// The frame drawn around each group: the union of its members' rects plus a
// padding, in world px. `rectById` is a function or a Map/object of rects;
// a group with fewer than two members on the Canvas draws nothing.
export function canvasGroupFrames(groups, rectById, { padding = 8 } = {}) {
  let read = typeof rectById === 'function' ? rectById : id => rectById?.[id];
  try {
    // Native Map branding works across globals without reading user hooks.
    Map.prototype.has.call(rectById, null);
    read = id => Map.prototype.get.call(rectById, id);
  } catch {} // Non-Maps keep the existing function/property lookup.
  const pad = Number.isFinite(padding) && padding >= 0 ? padding : 8;
  const out = [];
  for (const group of normalizeCanvasGroups(groups)) {
    const rects = group.viewIds.map(id => toWorldRect(read(id))).filter(Boolean);
    const union = unionRect(rects);
    if (!union || rects.length < 2) continue;
    out.push({ id: group.id, count: rects.length, x: union.x - pad, y: union.y - pad, width: union.width + pad * 2, height: union.height + pad * 2 });
  }
  return out;
}

// [이동]/[크기] numeric input: integers in Canvas px, applied as typed (no
// snapping). Width and height never go below the View's minimum. A field
// left empty keeps its current value; a field that is not a number names
// itself in `field`.
export function parsePlacementInput(values = {}, { minWidth = 1, minHeight = 1, maxAbs = 1e6 } = {}) {
  const number = raw => {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) && Math.abs(value) <= maxAbs ? value : null;
  };
  const rect = {};
  for (const field of ['x', 'y', 'width', 'height']) {
    const raw = values?.[field];
    if (raw == null || raw === '') continue;
    const value = number(raw);
    if (value === null) return { ok: false, field, rect: null };
    rect[field] = Math.round(value);
  }
  if (!Object.keys(rect).length) return { ok: false, field: null, rect: null };
  if (rect.width != null) rect.width = Math.max(Math.max(1, Number.isFinite(minWidth) ? minWidth : 1), rect.width);
  if (rect.height != null) rect.height = Math.max(Math.max(1, Number.isFinite(minHeight) ? minHeight : 1), rect.height);
  return { ok: true, field: null, rect };
}

// ---------------------------------------------------------------------------
// CNV-02: a View opened from a Chat (or another View) opens beside it, a gap
// away: right, left, below, above. Each side first tries the opener's top
// (or left) line, then slides along that side past whatever is in the way
// while still facing the opener. Sides inside `safe` (world box of the
// visible area) win. Null means no side has room; the caller then uses
// placeCanvasView.

export function placeBesideOpener({
  opener, size, occupied = [], gap = CANVAS_GAP_PX, safe = null, sides = ['right', 'left', 'below', 'above'],
} = {}) {
  const anchor = toWorldRect(opener);
  const width = size?.width;
  const height = size?.height;
  if (!anchor || !(width > 0 && height > 0) || !Number.isFinite(gap)) return null;
  const view = safe ? toBox(safe) : null;
  const blocks = (Array.isArray(occupied) ? occupied : []).map(toWorldRect)
    .filter(rect => rect && rect.width > 0 && rect.height > 0)
    .map(rect => ({ left: rect.x - gap - width, right: right(rect) + gap, top: rect.y - gap - height, bottom: bottom(rect) + gap, rect }));
  const free = (x, y) => blocks.every(block => x <= block.left || x >= block.right || y <= block.top || y >= block.bottom);
  const order = (Array.isArray(sides) ? sides : []).filter(side => ['right', 'left', 'below', 'above'].includes(side));
  const found = [];
  order.forEach((side, sideIndex) => {
    const horizontal = side === 'right' || side === 'left';
    const fixed = side === 'right' ? right(anchor) + gap
      : side === 'left' ? anchor.x - gap - width
        : side === 'below' ? bottom(anchor) + gap : anchor.y - gap - height;
    const start = horizontal ? anchor.y : anchor.x;
    const length = horizontal ? height : width;
    const spanLow = horizontal ? anchor.y : anchor.x;
    const spanHigh = spanLow + (horizontal ? anchor.height : anchor.width);
    const slides = new Set([start]);
    for (const block of blocks) {
      if (horizontal) { slides.add(block.bottom); slides.add(block.top); } else { slides.add(block.right); slides.add(block.left); }
    }
    for (const along of slides) {
      // Still facing the opener: the new View's span overlaps the opener's.
      if (!(along < spanHigh && along + length > spanLow)) continue;
      const x = horizontal ? fixed : along;
      const y = horizontal ? along : fixed;
      if (!free(x, y)) continue;
      const inView = !!view && x >= view.left && y >= view.top && x + width <= view.right && y + height <= view.bottom;
      found.push({ x, y, side, inView, aligned: along === start, rank: [view && !inView ? 1 : 0, sideIndex, Math.abs(along - start)] });
    }
  });
  if (!found.length) return null;
  found.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  const best = found[0];
  return { x: Math.round(best.x), y: Math.round(best.y), width, height, side: best.side, inView: best.inView, aligned: best.aligned };
}

// ---------------------------------------------------------------------------
// UX-02 off-screen indicators: a Briefing target or an Agent's working View
// outside the visible area shows as a dot on the area's edge, on the line
// from the area's centre to the View's centre.

export function edgeIndicatorPoint({ rect, viewport, pan, zoom, inset = 8 } = {}) {
  const world = toWorldRect(rect);
  const box = toBox(viewport);
  if (!world || !box || !finite(pan?.x, pan?.y) || !(zoom > 0)) return null;
  const left = world.x * zoom + pan.x;
  const top = world.y * zoom + pan.y;
  const screen = { left, top, right: left + world.width * zoom, bottom: top + world.height * zoom };
  const offscreen = screen.right <= box.left || screen.left >= box.right || screen.bottom <= box.top || screen.top >= box.bottom;
  if (!offscreen) return null;
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const tx = (screen.left + screen.right) / 2;
  const ty = (screen.top + screen.bottom) / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const room = Math.max(0, Math.min(inset, (box.right - box.left) / 2, (box.bottom - box.top) / 2));
  const hx = (box.right - box.left) / 2 - room;
  const hy = (box.bottom - box.top) / 2 - room;
  const sx = dx === 0 ? Infinity : hx / Math.abs(dx);
  const sy = dy === 0 ? Infinity : hy / Math.abs(dy);
  const scale = Math.min(sx, sy);
  if (!Number.isFinite(scale)) return null;
  const x = cx + dx * scale;
  const y = cy + dy * scale;
  return {
    x, y,
    side: sx <= sy ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top'),
    angle: Math.atan2(dy, dx) * 180 / Math.PI,
    distance: Math.hypot(tx - x, ty - y),
  };
}

export function edgeIndicators(targets = [], { viewport, pan, zoom, inset = 8, limit = 12 } = {}) {
  const out = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    if (out.length >= limit) break;
    if (target?.id == null) continue;
    const point = edgeIndicatorPoint({ rect: target.rect, viewport, pan, zoom, inset });
    if (point) out.push({ id: target.id, kind: typeof target.kind === 'string' ? target.kind : 'view', ...point });
  }
  return out;
}

// ---------------------------------------------------------------------------
// UX-02 minimap list with search. Boards first, then Views, each from top to
// bottom; the first match already on screen gets focus. Titles are matched
// case-insensitively after NFC normalisation, so Korean input compares as
// typed. Only titles are used; Board or View contents are never searched.

const searchText = value => String(value ?? '').normalize('NFC').toLocaleLowerCase();

export function minimapSearchRows({
  query = '', boards = [], views = [], viewport = null, activeId = null, limit = MINIMAP_ROW_LIMIT,
} = {}) {
  const needle = searchText(query).trim().slice(0, MINIMAP_QUERY_MAX);
  const box = viewport ? toBox(viewport) : null;
  const order = (a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x;
  // A View's Board is named only from the open Boards passed in here; a saved
  // Board that is not on the Desk is never resolved.
  const boardTitles = new Map((Array.isArray(boards) ? boards : [])
    .filter(board => board?.id != null).map(board => [board.id, String(board.title || 'Board').slice(0, 200)]));
  const collect = (list, kind) => (Array.isArray(list) ? list : []).map(item => {
    const rect = toWorldRect(item?.rect);
    if (item?.id == null || !rect) return null;
    const title = String(item.title ?? '').slice(0, 200);
    const at = needle ? searchText(title).indexOf(needle) : -1;
    if (needle && at < 0) return null;
    const projectionId = kind === 'view' ? item.projectionId ?? null : null;
    return {
      id: item.id, kind, title, rect,
      viewKind: kind === 'view' && typeof item.kind === 'string' ? item.kind : null,
      projectionId,
      boardTitle: projectionId != null ? boardTitles.get(projectionId) ?? null : null,
      match: needle ? { start: at, length: needle.length } : null,
      visible: !!box && intersectsBox(rect, box),
      active: item.id === activeId,
    };
  }).filter(Boolean).sort(order);
  const all = [...collect(boards, 'board'), ...collect(views, 'view')];
  const max = Number.isInteger(limit) && limit > 0 ? limit : MINIMAP_ROW_LIMIT;
  const rows = all.slice(0, max).map(({ rect, ...row }) => row);
  let focusIndex;
  if (needle) {
    const visible = rows.findIndex(row => row.visible);
    focusIndex = visible >= 0 ? visible : rows.length ? 0 : -1;
  } else {
    focusIndex = rows.findIndex(row => row.active);
  }
  return { rows, focusIndex, total: all.length, truncated: all.length > rows.length };
}

// What a minimap row is, in the words the Desk already uses for its Views
// (the edge indicators say the same). The current Board stays '현재 Board'; a
// current View reads '활성 브라우저', '활성 대화' …; an unknown kind is '화면'.
export const MINIMAP_VIEW_KIND_LABELS = Object.freeze({
  browser: '브라우저', chat: '대화', file: '파일', terminal: '터미널', settings: '설정',
  ontology: '온톨로지', 'input-evidence': '자료', result: '결과', memo: '메모', shape: '도형',
});
export function minimapRowKindLabel({ kind = 'view', viewKind = null, current = false } = {}) {
  if (kind === 'board') return current ? '현재 Board' : 'Board';
  const type = typeof viewKind === 'string' && Object.hasOwn(MINIMAP_VIEW_KIND_LABELS, viewKind)
    ? MINIMAP_VIEW_KIND_LABELS[viewKind] : '화면';
  return current ? `활성 ${type}` : type;
}

// Choosing a row moves the camera only when the target is not already fully
// inside the safe area (client box): centred, zooming out to fit if needed,
// never zooming in. Null means leave the camera where it is.
export function minimapFocusCamera({ rect, safe, pan, zoom, padding = 24 } = {}) {
  const world = toWorldRect(rect);
  const box = toBox(safe);
  if (!world || !box || !finite(pan?.x, pan?.y) || !(zoom > 0)) return null;
  const left = world.x * zoom + pan.x;
  const top = world.y * zoom + pan.y;
  if (left >= box.left && top >= box.top && left + world.width * zoom <= box.right && top + world.height * zoom <= box.bottom) return null;
  const pad = Math.max(0, Math.min(Number.isFinite(padding) ? padding : 0, (box.right - box.left) / 4, (box.bottom - box.top) / 4));
  return fitSurfaceCamera(world, {
    left: box.left + pad, top: box.top + pad, width: box.right - box.left - pad * 2, height: box.bottom - box.top - pad * 2,
  }, zoom);
}

// A world-coordinate SVG minimap: the shapes keep world rects and only the
// viewBox and the mask path change when the camera moves. `content` is the
// union of everything drawn, `view` the visible world rect; `width`/`height`
// the SVG's px size.
const svgNumber = value => Math.round(value * 100) / 100;
export function minimapViewBox({ content = null, view, width, height, offsetScale = 5 } = {}) {
  const visible = toWorldRect(view);
  if (!visible || !(width > 0 && height > 0)) return null;
  const bounds = unionRect([content, visible].filter(Boolean));
  const scale = Math.max(bounds.width / width, bounds.height / height);
  if (!(scale > 0)) return null;
  const viewWidth = scale * width;
  const viewHeight = scale * height;
  const offset = (Number.isFinite(offsetScale) ? offsetScale : 5) * scale;
  const x = bounds.x - (viewWidth - bounds.width) / 2 - offset;
  const y = bounds.y - (viewHeight - bounds.height) / 2 - offset;
  const w = viewWidth + offset * 2;
  const h = viewHeight + offset * 2;
  const n = svgNumber;
  return {
    x: n(x), y: n(y), width: n(w), height: n(h), scale,
    viewBox: `${n(x)} ${n(y)} ${n(w)} ${n(h)}`,
    maskPath: `M${n(x - offset)},${n(y - offset)}h${n(w + offset * 2)}v${n(h + offset * 2)}h${n(-w - offset * 2)}z`
      + ` M${n(visible.x)},${n(visible.y)}h${n(visible.width)}v${n(visible.height)}h${n(-visible.width)}z`,
  };
}

// ---------------------------------------------------------------------------
// UX-06 collapse (the yellow dot). Collapsed Views are a list of View ids, not
// an object keyed by them, so a stored Desk record never carries ids as keys.

export function normalizeCollapsedIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => typeof item === 'string' ? item.trim() : null).map(viewId).filter(Boolean))];
}

export function setCollapsedId(list, id, collapsed) {
  const ids = normalizeCollapsedIds(list);
  const key = viewId(id);
  if (!key) return ids;
  if (collapsed) return ids.includes(key) ? ids : [...ids, key];
  return ids.filter(item => item !== key);
}

export function isCollapsedId(list, id) {
  return Array.isArray(list) && viewId(id) != null && list.includes(id);
}

// The rect shown (and used for snapping, arranging and free-spot search)
// while the stored geometry keeps the full size.
export function displayRect(rect, { collapsed = false, collapsedSize = COLLAPSED_VIEW_SIZE } = {}) {
  const world = toWorldRect(rect);
  if (!world) return null;
  if (!collapsed) return world;
  const width = collapsedSize?.width > 0 ? collapsedSize.width : COLLAPSED_VIEW_SIZE.width;
  const height = collapsedSize?.height > 0 ? collapsedSize.height : COLLAPSED_VIEW_SIZE.height;
  return { x: world.x, y: world.y, width, height };
}

// Keep a View inside a container (a Board region or the visible area),
// shrinking it only when it cannot fit.
export function clampViewRect(rect, container, { padding = 12 } = {}) {
  const view = toWorldRect(rect);
  const area = toWorldRect(container);
  if (!view || !area) return null;
  const pad = Number.isFinite(padding) && padding >= 0 ? padding : 12;
  const width = Math.min(view.width, Math.max(1, area.width - pad * 2));
  const height = Math.min(view.height, Math.max(1, area.height - pad * 2));
  const minX = area.x + pad;
  const minY = area.y + pad;
  const maxX = right(area) - pad - width;
  const maxY = bottom(area) - pad - height;
  return {
    x: Math.min(Math.max(view.x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(view.y, minY), Math.max(minY, maxY)),
    width, height,
  };
}

// ---------------------------------------------------------------------------
// CNV-03 Board regions and membership. One View belongs to one Board at most
// (D-V1 recommendation). Regions are [{ id, rect, parentId? }].

export function innermostRegionAt(regions = [], point) {
  if (!finite(point?.x, point?.y)) return null;
  const list = (Array.isArray(regions) ? regions : []).map((region, index) => ({ region, index, rect: toWorldRect(region?.rect) }))
    .filter(item => item.region?.id != null && item.rect);
  const byId = new Map(list.map(item => [item.region.id, item]));
  const depth = item => {
    let count = 0;
    const visited = new Set([item.region.id]);
    let parentId = item.region.parentId ?? null;
    while (parentId != null && byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      count += 1;
      parentId = byId.get(parentId).region.parentId ?? null;
    }
    return count;
  };
  const hits = list.filter(({ rect }) => point.x >= rect.x && point.x <= right(rect) && point.y >= rect.y && point.y <= bottom(rect));
  if (!hits.length) return null;
  hits.sort((a, b) => depth(b) - depth(a) || a.rect.width * a.rect.height - b.rect.width * b.rect.height || b.index - a.index);
  return hits[0].region;
}

export function regionRecheckInterval(movingCount = 1) {
  return movingCount > 10 ? REGION_RECHECK_SLOW_MS : REGION_RECHECK_MS;
}

// A View dropped inside a Board region it does not belong to gets a
// suggestion ('[이름]에 추가'); nothing changes until the person accepts it
// (D-V2, D-V3 recommendations). `point` is the pointer (world px); without it
// the View's centre is used.
export function regionDropSuggestion({ viewRect, point = null, regions = [], ownerId = null } = {}) {
  const rect = toWorldRect(viewRect);
  const at = finite(point?.x, point?.y) ? point : rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  if (!at) return null;
  const region = innermostRegionAt(regions, at);
  if (!region || region.id === ownerId) return null;
  return { projectionId: region.id, action: ownerId != null ? 'move' : 'add', fromId: ownerId ?? null };
}

const projectionList = projections => Array.isArray(projections)
  ? projections.filter(item => item?.id != null)
  : projections && typeof projections === 'object' ? Object.values(projections).filter(item => item?.id != null) : [];

const rebuildProjections = (projections, replaced) => {
  if (Array.isArray(projections)) return projections.map(item => replaced.get(item?.id) || item);
  const next = {};
  for (const [key, item] of Object.entries(projections || {})) next[key] = replaced.get(item?.id) || item;
  return next;
};

const hasMember = (projection, id) => Array.isArray(projection?.members) && projection.members.some(member => member?.viewId === id);

// View id -> unambiguous projection id, from recorded member lists only.
// Conflicting legacy records are left untouched and have no displayed owner.
export function owningProjectionByView(projections) {
  const list = projectionList(projections);
  const owners = new Map();
  const conflicts = new Set();
  const projectionIds = new Map();
  for (const projection of list) {
    projectionIds.set(projection.id, (projectionIds.get(projection.id) || 0) + 1);
  }
  for (const projection of list) {
    for (const member of Array.isArray(projection.members) ? projection.members : []) {
      const id = member?.viewId;
      if (typeof id !== 'string' || !id || typeof projection.id !== 'string' || !projection.id) continue;
      if (projectionIds.get(projection.id) > 1 || (owners.has(id) && owners.get(id) !== projection.id)) {
        owners.delete(id);
        conflicts.add(id);
      } else if (!conflicts.has(id)) owners.set(id, projection.id);
    }
  }
  return owners;
}

function withoutMember(projection, id) {
  const members = projection.members.filter(member => member?.viewId !== id);
  const idMap = Object.fromEntries(Object.entries(projection.idMap || {}).filter(([, value]) => value !== id));
  return { ...projection, members, idMap };
}

// Binds an existing View to a Board as it is: the View keeps its id and no
// copy opens (bindExisting). It leaves any other Board first. `record` is the
// View's serialized state in Desk coordinates; its geometry is stored relative
// to the projection's offset, as serializeAgendaSnapshot does on save.
export function addProjectionMember(projections, { projectionId, viewId: id, kind = 'card', record = null } = {}) {
  const list = projectionList(projections);
  const target = list.find(item => item.id === projectionId);
  const key = viewId(id);
  if (!target || !key || !Array.isArray(target.members)) return { projections, changed: false, from: null, to: null, member: null };
  const replaced = new Map();
  let from = null;
  for (const projection of list) {
    if (projection.id === target.id || !hasMember(projection, key)) continue;
    from ??= projection.id;
    replaced.set(projection.id, withoutMember(projection, key));
  }
  let member = target.members.find(item => item?.viewId === key) || null;
  if (!member) {
    const taken = new Set([...target.members.map(item => item?.sourceId), ...Object.keys(target.idMap || {})]);
    let sourceId = key;
    for (let n = 2; taken.has(sourceId); n += 1) sourceId = `${key}-${n}`;
    const stored = record && typeof record === 'object' ? JSON.parse(JSON.stringify(record)) : { type: 'missing' };
    stored.id = sourceId;
    if (stored.geometry && typeof stored.geometry === 'object') {
      if (Number.isFinite(stored.geometry.x)) stored.geometry.x -= target.offset?.x || 0;
      if (Number.isFinite(stored.geometry.y)) stored.geometry.y -= target.offset?.y || 0;
    }
    member = { sourceId, viewId: key, kind: kind === 'shape' ? 'shape' : 'card', record: stored };
    replaced.set(target.id, { ...target, members: [...target.members, member], idMap: { ...(target.idMap || {}), [sourceId]: key } });
  }
  if (!replaced.size) return { projections, changed: false, from: null, to: target.id, member };
  return { projections: rebuildProjections(projections, replaced), changed: true, from, to: target.id, member };
}

// Takes a View out of its Board ('Board에서 제외'). The View stays on the
// Canvas; the screen clears its dataset.projectionId/boardId/memberId. Context
// bindings that point at it are left as they are.
export function removeProjectionMember(projections, { viewId: id, projectionId = null } = {}) {
  const key = viewId(id);
  const owner = key ? projectionList(projections).find(item => (projectionId == null || item.id === projectionId) && hasMember(item, key)) : null;
  if (!owner) return { projections, changed: false, from: null, member: null };
  const member = owner.members.find(item => item?.viewId === key);
  return {
    projections: rebuildProjections(projections, new Map([[owner.id, withoutMember(owner, key)]])),
    changed: true, from: owner.id, member,
  };
}
