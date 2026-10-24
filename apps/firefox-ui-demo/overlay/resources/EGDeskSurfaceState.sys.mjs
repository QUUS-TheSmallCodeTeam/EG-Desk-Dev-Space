// Pure surface state. No browser, filesystem, network, or execution side effects.
// Browser-first is a camera pose on the actual Desk, not a second surface mode.
export function initialSurfaceMode() { return 'desk'; }

export function shouldFocusInitialBrowser({ lifecycle, deskSession, legacyStore, recoveryProtected = false } = {}) {
  if (recoveryProtected) return false;
  if (lifecycle?.mode === 'browser' || deskSession?.surface?.mode === 'browser' || deskSession?.surface?.initialBrowserFocus === true) return true;
  return !deskSession && !legacyStore && (!lifecycle || lifecycle.mode === 'desk');
}

export function fitSurfaceCamera(rect, available, maxZoom = 0.85) {
  const zoom = Math.min(maxZoom, available.width / Math.max(1, rect.width), available.height / Math.max(1, rect.height));
  return {
    zoom,
    pan: {
      x: available.left + (available.width - rect.width * zoom) / 2 - rect.x * zoom,
      y: available.top + (available.height - rect.height * zoom) / 2 - rect.y * zoom,
    },
  };
}

// Inputs are projected CSS pixels, not world dimensions. Only presentation
// changes at these boundaries; the View and its runtime keep their identity.
export function surfaceSemanticLevel({
  width, height, fontPx, previous = null,
  detailWidth = 240, detailHeight = 180,
  outlineWidth = 88, outlineHeight = 52,
} = {}) {
  if (![width, height, fontPx].every(value => Number.isFinite(value) && value > 0)) return 'marker';
  const detailEnter = fontPx >= 10.5 && width >= detailWidth && height >= detailHeight;
  const detailStay = previous === 'detail' && fontPx >= 9
    && width >= detailWidth * 0.88 && height >= detailHeight * 0.88;
  if (detailEnter || detailStay) return 'detail';
  const outlineEnter = width >= outlineWidth && height >= outlineHeight;
  const outlineStay = previous === 'outline' && width >= outlineWidth * 0.88
    && height >= outlineHeight * 0.88;
  return outlineEnter || outlineStay ? 'outline' : 'marker';
}

// Connected components, not a single global count: a chain of nearby markers
// forms one local region, while unrelated markers remain independent.
export function surfaceProximityClusters(items, distance = 42) {
  if (!Array.isArray(items)) return [];
  const threshold = Number.isFinite(distance) && distance > 0 ? distance : 42;
  const valid = items.filter(item => item && item.id != null
    && Number.isFinite(item.cx) && Number.isFinite(item.cy)
    && (item.width == null || (Number.isFinite(item.width) && item.width > 0))
    && (item.height == null || (Number.isFinite(item.height) && item.height > 0)));
  const seen = new Set();
  const groups = [];
  const near = (a, b) => {
    const dx = Math.abs(a.cx - b.cx);
    const dy = Math.abs(a.cy - b.cy);
    const overlap = dx <= ((a.width || 0) + (b.width || 0)) / 2
      && dy <= ((a.height || 0) + (b.height || 0)) / 2;
    return overlap || Math.hypot(dx, dy) < threshold;
  };
  for (let index = 0; index < valid.length; index += 1) {
    if (seen.has(index)) continue;
    const queue = [index];
    const members = [];
    seen.add(index);
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      members.push(valid[current].id);
      for (let next = 0; next < valid.length; next += 1) {
        if (seen.has(next) || !near(valid[current], valid[next])) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    if (members.length > 1) groups.push(members);
  }
  return groups;
}

// Canvas marks are plain JSON records. An unknown or older type opens as the
// original rectangle instead of an invisible element.
export const CANVAS_SHAPE_TYPES = Object.freeze(['rect', 'ellipse', 'line', 'arrow', 'path', 'label', 'highlight']);
const CANVAS_TOOL_SHAPES = Object.freeze({
  square: 'rect', ellipse: 'ellipse', line: 'line', arrow: 'arrow',
  pencil: 'path', label: 'label', highlight: 'highlight',
});
// 'arrow' is the arrow mark; the selection pointer is 'select'. The active tool
// was never persisted, so no stored state carries the former pointer id.
export const CANVAS_TOOL_IDS = Object.freeze(['select', 'hand', ...Object.keys(CANVAS_TOOL_SHAPES)]);
export const CANVAS_PATH_MAX_POINTS = 2000;
export const CANVAS_LABEL_MAX_LENGTH = 1000;

export function canvasToolShapeType(tool) {
  return Object.hasOwn(CANVAS_TOOL_SHAPES, tool) ? CANVAS_TOOL_SHAPES[tool] : null;
}

export function normalizeCanvasTool(tool) {
  return CANVAS_TOOL_IDS.includes(tool) ? tool : 'select';
}

const round1 = value => Math.round(value * 10) / 10;

export function normalizeCanvasPathPoints(points, max = CANVAS_PATH_MAX_POINTS) {
  if (!Array.isArray(points)) return [];
  const clean = [];
  for (const point of points) {
    const x = Array.isArray(point) ? point[0] : point?.x;
    const y = Array.isArray(point) ? point[1] : point?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const next = [round1(x), round1(y)];
    const last = clean[clean.length - 1];
    if (!last || last[0] !== next[0] || last[1] !== next[1]) clean.push(next);
  }
  const limit = Number.isInteger(max) && max >= 2 ? max : CANVAS_PATH_MAX_POINTS;
  if (clean.length <= limit) return clean;
  // Even thinning keeps the stroke's whole extent, including its last point.
  return Array.from({ length: limit }, (_, index) => clean[Math.round(index * (clean.length - 1) / (limit - 1))]);
}

// Ramer–Douglas–Peucker over pointer samples; tolerance is in world pixels.
export function simplifyCanvasPath(points, tolerance = 1) {
  const clean = normalizeCanvasPathPoints(points);
  if (clean.length <= 2) return clean;
  const limit = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1;
  const keep = new Uint8Array(clean.length);
  keep[0] = 1;
  keep[clean.length - 1] = 1;
  const stack = [[0, clean.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = clean[first];
    const [bx, by] = clean[last];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    let index = -1;
    let farthest = limit;
    for (let current = first + 1; current < last; current += 1) {
      const [px, py] = clean[current];
      const distance = length === 0 ? Math.hypot(px - ax, py - ay)
        : Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
      if (distance > farthest) {
        farthest = distance;
        index = current;
      }
    }
    if (index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return clean.filter((_, index) => keep[index]);
}

// World box for a freehand stroke and its points relative to that box, so
// moving the mark only moves the box.
export function canvasPathBox(points, pad = 6) {
  const clean = normalizeCanvasPathPoints(points);
  if (!clean.length) return null;
  const xs = clean.map(point => point[0]);
  const ys = clean.map(point => point[1]);
  const x = Math.floor(Math.min(...xs) - pad);
  const y = Math.floor(Math.min(...ys) - pad);
  return {
    x, y,
    width: Math.max(12, Math.ceil(Math.max(...xs) + pad) - x),
    height: Math.max(12, Math.ceil(Math.max(...ys) + pad) - y),
    points: clean.map(([px, py]) => [round1(px - x), round1(py - y)]),
  };
}

export function normalizeCanvasLabelText(value, max = CANVAS_LABEL_MAX_LENGTH) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const LINE_FIELDS = ['x1', 'y1', 'x2', 'y2'];
const ROTATE_TRANSFORM = /^rotate\(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?deg\)$/i;

// Saved runtime fields keep the original line keys for every mark and add
// points only for a freehand path and text only for a label.
export function canvasShapeRuntime(type, fields = {}) {
  const runtime = { transform: typeof fields.transform === 'string' ? fields.transform : '' };
  for (const key of LINE_FIELDS) runtime[key] = fields[key] != null && fields[key] !== '' ? String(fields[key]) : null;
  if (type === 'path') runtime.points = normalizeCanvasPathPoints(fields.points);
  if (type === 'label') runtime.text = normalizeCanvasLabelText(fields.text);
  return runtime;
}

export function restoreCanvasShape(record) {
  const type = CANVAS_SHAPE_TYPES.includes(record?.type) ? record.type : 'rect';
  const runtime = record?.runtimeState && typeof record.runtimeState === 'object' ? record.runtimeState : {};
  const line = {};
  for (const key of LINE_FIELDS) line[key] = runtime[key] != null && runtime[key] !== '' ? String(runtime[key]) : null;
  return {
    type,
    transform: typeof runtime.transform === 'string' && ROTATE_TRANSFORM.test(runtime.transform) ? runtime.transform : '',
    line,
    points: type === 'path' ? normalizeCanvasPathPoints(runtime.points) : null,
    text: type === 'label' ? normalizeCanvasLabelText(runtime.text) : null,
  };
}

// Board region: 24px inner padding around its members and a 36px title row.
export function boardRegionRect(memberRects, { padding = 24, titleHeight = 36, fallback = { x: 40, y: 80 } } = {}) {
  const rects = (Array.isArray(memberRects) ? memberRects : []).filter(rect => rect
    && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite));
  if (!rects.length) {
    const x = Number.isFinite(fallback?.x) ? fallback.x : 40;
    const y = Number.isFinite(fallback?.y) ? fallback.y : 80;
    return { x, y, width: 340, height: titleHeight + padding * 2 };
  }
  const x = Math.min(...rects.map(rect => rect.x)) - padding;
  const y = Math.min(...rects.map(rect => rect.y)) - padding - titleHeight;
  const right = Math.max(...rects.map(rect => rect.x + rect.width)) + padding;
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height)) + padding;
  return { x, y, width: right - x, height: bottom - y };
}

// Below this camera zoom the 11.5px Board name would drop under the 9px that
// keeps a View in detail; it leaves the shrinking title row, sits above the
// region and is counter-scaled to stay at its readable screen size.
export function boardRegionLabelScale(zoom, farBelow = 0.8) {
  if (!Number.isFinite(zoom) || zoom <= 0) return { far: false, scale: 1 };
  return zoom < farBelow ? { far: true, scale: 1 / zoom } : { far: false, scale: 1 };
}

// Viewport Board Detection (VIEWPORT_LAYOUT_INTERACTION_MODEL.md): visible
// active Board → largest viewport overlap → active card's Board → most recent
// Board → Desk. A region counts as in view when the shared area is at least
// `minShare` of the smaller of the region and the viewport, so a sliver at the
// screen edge is not announced as another Board in view.
export function resolveViewportBoard({
  viewport, regions = [], activeId = null, activeEntityBoardId = null, recentIds = [], minShare = 0.05,
} = {}) {
  const box = rect => rect && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
    && rect.right > rect.left && rect.bottom > rect.top ? rect : null;
  const view = box(viewport);
  const valid = (Array.isArray(regions) ? regions : []).filter(region => region?.id != null && box(region.rect));
  const known = new Set(valid.map(region => region.id));
  const area = rect => (rect.right - rect.left) * (rect.bottom - rect.top);
  const visible = view ? valid.map((region, order) => {
    const width = Math.min(view.right, region.rect.right) - Math.max(view.left, region.rect.left);
    const height = Math.min(view.bottom, region.rect.bottom) - Math.max(view.top, region.rect.top);
    const overlap = width > 0 && height > 0 ? width * height : 0;
    return { id: region.id, order, overlap, share: overlap / Math.min(area(region.rect), area(view)) };
  }).filter(item => item.overlap > 0 && item.share >= minShare)
    .sort((a, b) => b.overlap - a.overlap || a.order - b.order) : [];
  const visibleIds = visible.map(item => item.id);
  let primaryId = null;
  let reason = 'desk';
  if (activeId != null && visibleIds.includes(activeId)) {
    primaryId = activeId;
    reason = 'active-visible';
  } else if (visibleIds.length) {
    primaryId = visibleIds[0];
    reason = 'largest-overlap';
  } else if (activeEntityBoardId != null && known.has(activeEntityBoardId)) {
    primaryId = activeEntityBoardId;
    reason = 'active-card';
  } else {
    const recent = (Array.isArray(recentIds) ? recentIds : []).find(id => known.has(id));
    if (recent != null) {
      primaryId = recent;
      reason = 'recent';
    }
  }
  const extraCount = primaryId != null && visibleIds.includes(primaryId) ? visibleIds.length - 1 : visibleIds.length;
  return { primaryId, reason, visibleIds, extraCount };
}

// Card placement policy (CNV-02). Outer logical px per View type, from
// egdesk-ux-realization-proposals.md '유형별 최소 크기'. A type not listed
// opens at 640×480 with the common 320×240 minimum.
const viewSize = (width, height, minWidth = 320, minHeight = 240) => Object.freeze({ width, height, minWidth, minHeight });
export const CANVAS_VIEW_SIZES = Object.freeze({
  browser: viewSize(960, 640),
  file: viewSize(720, 640),
  chat: viewSize(420, 600, 320, 420),
  terminal: viewSize(800, 400),
  settings: viewSize(600, 600),
  // The map fills the view up to its former 1760×900 cap.
  ontology: viewSize(1760, 900, 680, 440),
  'input-evidence': viewSize(640, 480),
});
const OTHER_VIEW_SIZE = viewSize(640, 480);

// The type's size shrunk to `room` (world px of the visible safe area), never
// below its minimum. Only the new View gives way; existing Views keep theirs.
export function canvasViewSize(kind, room = null) {
  const base = Object.hasOwn(CANVAS_VIEW_SIZES, kind) ? CANVAS_VIEW_SIZES[kind] : OTHER_VIEW_SIZE;
  const fit = (value, min, limit) => Number.isFinite(limit) && limit > 0 ? Math.max(min, Math.min(value, Math.floor(limit))) : value;
  return {
    width: fit(base.width, base.minWidth, room?.width),
    height: fit(base.height, base.minHeight, room?.height),
    minWidth: base.minWidth,
    minHeight: base.minHeight,
  };
}

const worldBox = rect => !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
  && rect.width > 0 && rect.height > 0;

// Top-left of the spot closest to `target` where a width×height rect keeps
// `gap` px clear of every occupied rect, inside `bounds` when given. The
// closest free point lies on the target's own axis or on an edge of a grown
// obstacle, so only those coordinates are tried. Null when bounds hold none.
export function nearestFreeCanvasSpot({ width, height, target, occupied = [], gap = 24, bounds = null } = {}) {
  if (![width, height, target?.x, target?.y, gap].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const limited = !!bounds && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite);
  // Whole px inside the bounds. A rect wider or taller than the bounds keeps
  // its top or left edge, where its bar is.
  const minX = limited ? Math.ceil(bounds.left) : -Infinity;
  const maxX = limited ? Math.max(minX, Math.floor(bounds.right - width)) : Infinity;
  const minY = limited ? Math.ceil(bounds.top) : -Infinity;
  const maxY = limited ? Math.max(minY, Math.floor(bounds.bottom - height)) : Infinity;
  // Each block is the open range of top-left spots its rect rules out; one
  // that rules out nothing inside the bounds is left out of the search.
  const blocks = (Array.isArray(occupied) ? occupied : []).filter(worldBox).map(rect => ({
    left: rect.x - gap - width, right: rect.x + rect.width + gap,
    top: rect.y - gap - height, bottom: rect.y + rect.height + gap,
  })).filter(block => block.left < maxX && block.right > minX && block.top < maxY && block.bottom > minY);
  const axis = (start, edges, min, max) => [...new Set([Math.min(max, Math.max(min, start)), ...(limited ? [min, max] : []), ...edges])]
    .filter(value => value >= min && value <= max);
  const xs = axis(Math.round(target.x), blocks.flatMap(block => [block.left, block.right]), minX, maxX);
  const ys = axis(Math.round(target.y), blocks.flatMap(block => [block.top, block.bottom]), minY, maxY);
  const candidates = [];
  for (const x of xs) for (const y of ys) candidates.push({ x, y, distance: Math.hypot(x - target.x, y - target.y) });
  candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  const spot = candidates.find(({ x, y }) => blocks.every(block => x <= block.left || x >= block.right || y <= block.top || y >= block.bottom));
  return spot ? { x: spot.x, y: spot.y } : null;
}

// A new View or reopened Board takes the closest empty spot inside the visible
// safe area (world px), centred on `anchor` when given. Without room there it
// takes the closest empty Canvas spot with inView false, so the camera can
// follow it. Occupied rects never move.
export function placeCanvasView({ size, safe, occupied = [], anchor = null, gap = 24 } = {}) {
  const width = size?.width;
  const height = size?.height;
  if (!(width > 0 && height > 0) || !safe || ![safe.left, safe.top, safe.right, safe.bottom].every(Number.isFinite)) return null;
  const center = Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y)
    ? anchor : { x: (safe.left + safe.right) / 2, y: (safe.top + safe.bottom) / 2 };
  const fits = width <= safe.right - safe.left && height <= safe.bottom - safe.top;
  const target = { x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2) };
  const inside = nearestFreeCanvasSpot({ width, height, target, occupied, gap, bounds: safe });
  if (inside) return { x: Math.round(inside.x), y: Math.round(inside.y), width, height, inView: fits };
  const outside = nearestFreeCanvasSpot({ width, height, target, occupied, gap });
  return { x: Math.round(outside.x), y: Math.round(outside.y), width, height, inView: false };
}

// The smallest camera pan that shows a world rect inside the safe area
// (client px). On an axis where the rect is larger than the area, its top or
// left edge, where the bar is, is aligned instead.
export function revealRectPan(rect, safe, { pan, zoom } = {}) {
  if (!pan || !Number.isFinite(pan.x) || !Number.isFinite(pan.y)) return null;
  if (!worldBox(rect) || !(zoom > 0) || !safe || ![safe.left, safe.top, safe.right, safe.bottom].every(Number.isFinite)) {
    return { x: pan.x, y: pan.y };
  }
  const axis = (start, size, offset, low, high) => {
    const near = start * zoom + offset;
    const far = near + size * zoom;
    if (far - near > high - low || near < low) return offset + low - near;
    return far > high ? offset - (far - high) : offset;
  };
  return { x: axis(rect.x, rect.width, pan.x, safe.left, safe.right), y: axis(rect.y, rect.height, pan.y, safe.top, safe.bottom) };
}

// The lowest camera zoom at which every given View (world px, with its kind
// and body font) opens in semantic detail, by the floors the projection focus
// uses: a Browser 0.83 until its page font is measured, any other View 0.76
// and a 10.6px body font, and each at least the 240×180px detail box.
export function semanticDetailZoomFloor(views = []) {
  let floor = 0;
  for (const view of Array.isArray(views) ? views : []) {
    if (!(view?.width > 0 && view?.height > 0)) continue;
    const fontPx = view.fontPx > 0 ? view.fontPx : 14;
    floor = Math.max(floor, view.kind === 'browser' ? 0.83 : 0.76, 10.6 / fontPx, 241 / view.width, 181 / view.height);
  }
  return floor;
}

// A View opened from a Chat (an artifact chip) is framed with that Chat:
// the smallest pan when both fit at the current zoom, else a zoom out centred
// on both. The zoom never rises, and never drops below `minZoom` (the
// semantic detail floor) nor below a current zoom already under that floor.
// Null when they cannot share the safe area, so the new View shows alone.
export function pairedRevealCamera(rects, safe, { pan, zoom, minZoom = 0 } = {}) {
  const boxes = (Array.isArray(rects) ? rects : []).filter(worldBox);
  if (boxes.length < 2 || !(zoom > 0) || !pan || !Number.isFinite(pan.x) || !Number.isFinite(pan.y)
    || !safe || ![safe.left, safe.top, safe.right, safe.bottom].every(Number.isFinite)) return null;
  const left = Math.min(...boxes.map(rect => rect.x));
  const top = Math.min(...boxes.map(rect => rect.y));
  const union = { x: left, y: top,
    width: Math.max(...boxes.map(rect => rect.x + rect.width)) - left,
    height: Math.max(...boxes.map(rect => rect.y + rect.height)) - top };
  const area = { left: safe.left, top: safe.top, width: safe.right - safe.left, height: safe.bottom - safe.top };
  const fitZoom = Math.min(zoom, area.width / union.width, area.height / union.height);
  const floor = Math.min(zoom, Number.isFinite(minZoom) ? minZoom : 0);
  if (!(fitZoom > 0) || fitZoom < floor) return null;
  if (fitZoom >= zoom) return { zoom, pan: revealRectPan(union, safe, { pan, zoom }) };
  return fitSurfaceCamera(union, area, fitZoom);
}

// Words the Desk shows. Internal identifiers (state.agenda, data-testid,
// search result `type`) keep their names; only the visible copy is Korean,
// and product nouns (Board, Canvas, Chat, Browser) stay as the user knows them.
export function boardEntryStatusLabel(entry = {}) {
  if (entry.dirty) return '저장 안 됨';
  if (entry.closed) return '닫힘';
  if (entry.current) return '현재';
  if (entry.saved) return '저장됨';
  return '초안';
}

export function boardEntryRecencyLabel(entry = {}) {
  if (entry.closed) return '닫은 기록';
  return entry.lastOpenedAt ? '최근' : '보관됨';
}

export function boardItemCountLabel(count) {
  return `항목 ${Math.max(0, Math.round(Number(count) || 0))}개`;
}

export function boardSaveStatusTitle(dirty) {
  return dirty ? '저장하지 않은 변경이 있습니다' : '저장됨';
}

const RAIL_SEARCH_SECTIONS = Object.freeze({
  agenda: 'Board', card: 'Canvas', history: '방문 기록', file: '파일', thread: 'Chat', web: '웹',
});
export function railSearchSectionLabel(type) {
  return Object.hasOwn(RAIL_SEARCH_SECTIONS, type) ? RAIL_SEARCH_SECTIONS[type] : '기타';
}

export function deskMinimapCaption(zoom, count) {
  const percent = Number.isFinite(zoom) ? Math.round(zoom * 100) : 100;
  return `${percent}% · 대상 ${Math.max(0, Number(count) || 0)}개`;
}

// Desk Minimap (UX-02). A world rect ({ left, top, width, height }) in the
// minimap's pixel frame: `bounds`, `scale` and offsets come from its model.
export function minimapBox(rect, model, minSize = 3) {
  return {
    left: Math.round(model.offsetX + (rect.left - model.bounds.left) * model.scale),
    top: Math.round(model.offsetY + (rect.top - model.bounds.top) * model.scale),
    width: Math.max(minSize, Math.round(rect.width * model.scale)),
    height: Math.max(minSize, Math.round(rect.height * model.scale)),
  };
}

// Each Board's region on the minimap. Its name is written only when the box
// is wide enough to read it; a smaller box keeps a name-less handle.
export function minimapBoardRegions({ regions = [], model, activeId = null, labelMinWidth = 48, labelMinHeight = 14 } = {}) {
  if (!model?.bounds || ![model.bounds.left, model.bounds.top, model.offsetX, model.offsetY].every(Number.isFinite)
      || !(model.scale > 0)) return [];
  return (Array.isArray(regions) ? regions : []).filter(region => region?.id != null && region.rect
    && [region.rect.left, region.rect.top, region.rect.width, region.rect.height].every(Number.isFinite)
    && region.rect.width > 0 && region.rect.height > 0).map(region => {
    const box = minimapBox(region.rect, model, 8);
    return {
      id: region.id, title: String(region.title || 'Board'), ...box,
      active: region.id === activeId, showLabel: box.width >= labelMinWidth && box.height >= labelMinHeight,
    };
  });
}

// Boards and Views whose minimap box holds a point (map px), in the given
// order. A View inside a Board it belongs to (`projectionId`) is picked through
// that Board, so pressing a Board's region goes to the Board. More than one
// left over opens the '이 위치의 N개' list.
export function minimapTargetsAt(point, targets = [], slop = 2) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return [];
  const hits = (Array.isArray(targets) ? targets : []).filter(target => {
    const box = target?.box;
    return !!box && [box.left, box.top, box.width, box.height].every(Number.isFinite)
      && point.x >= box.left - slop && point.x <= box.left + box.width + slop
      && point.y >= box.top - slop && point.y <= box.top + box.height + slop;
  });
  const boards = new Set(hits.filter(target => target.kind === 'board').map(target => target.id));
  return hits.filter(target => target.kind === 'board' || target.projectionId == null || !boards.has(target.projectionId));
}

export function minimapStackTitle(count) {
  return `이 위치의 ${Math.max(0, Math.round(Number(count) || 0))}개`;
}

// Bridge connection, said by state. A short drop reads '다시 연결 중…' while
// the overlay retries; only after `quietAttempts` failed reconnects does it say
// the connection is lost and offer one retry. The raw transport error, the
// round-trip time and the build fields go to the folded '자세히'. A bridge that
// does not report `bridge` yet (older build) is read as matching.
export const BRIDGE_QUIET_RECONNECTS = 3;
export function bridgeConnectionNotice({
  connected = false, failures = 0, error = null, latencyMs = null, bridge = null, quietAttempts = BRIDGE_QUIET_RECONNECTS,
} = {}) {
  const build = bridge && typeof bridge === 'object' ? bridge : {};
  const details = [];
  if (typeof error === 'string' && error.trim()) details.push(`오류: ${error.trim()}`);
  if (Number.isFinite(latencyMs)) details.push(`응답 시간 ${Math.round(latencyMs)}ms`);
  if (typeof build.buildHash === 'string' && build.buildHash) details.push(`브리지 빌드 ${build.buildHash.slice(0, 12)}`);
  if (Number.isFinite(build.startedAt)) details.push(`브리지 시작 ${new Date(build.startedAt).toISOString()}`);
  if (connected && build.sourceMismatch === true) {
    return { state: 'mismatch', text: '브리지 버전이 맞지 않습니다 · 다시 시작 필요', action: null, details };
  }
  if (connected) return { state: 'online', text: '연결됨', action: null, details };
  if ((Number(failures) || 0) < quietAttempts) return { state: 'reconnecting', text: '다시 연결 중…', action: null, details };
  return { state: 'offline', text: '연결이 끊겼습니다', action: '다시 시도', details };
}

// Camera moves settle at once when the system asks for reduced motion, unless
// the caller chose explicitly.
export function cameraMoveImmediate(options = {}, reducedMotion = false) {
  return typeof options?.immediate === 'boolean' ? options.immediate : reducedMotion === true;
}

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
export function ownedProjectionMembers(projection, ownership) {
  return projection.members.map(member => member.viewId).filter(id => ownership[id] === projection.id);
}
export function missingProjectionMembers(projection, existingIds) {
  const present = new Set(existingIds);
  return projection.members.filter(member => !present.has(member.viewId));
}
// These are view-reference fields in the Board binding payload. Resource identity,
// labels, URLs and arbitrary object keys are opaque, even when they equal a view ID.
const VIEW_FIELDS = new Set(['cardId', 'sourceCardId', 'targetCardId', 'viewId', 'sourceViewId', 'targetViewId', 'entityId', 'cardIds', 'viewIds', 'memberCardIds']);
export function remapMemberReferences(value, ids, field = '') {
  if (typeof value === 'string') return VIEW_FIELDS.has(field) ? ids[value] || value : value;
  if (Array.isArray(value)) return value.map(item => remapMemberReferences(item, ids, field));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapMemberReferences(item, ids, key)]));
}

export function recoverDeskSnapshot(snapshot, restore) {
  if (snapshot == null) return { restored: false, protected: false, reason: null };
  const validRecord = record => record && typeof record.id === 'string' && typeof record.type === 'string';
  if (snapshot.unreadable || !snapshot.agenda?.id || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.shapes)
      || !snapshot.cards.every(validRecord) || !snapshot.shapes.every(validRecord)) {
    return { restored: false, protected: true, reason: 'Desk 기록을 읽을 수 없습니다.' };
  }
  const projections = snapshot.boardProjections?.projections;
  if (snapshot.boardProjections && (!projections || typeof projections !== 'object' || Array.isArray(projections)
      || Object.values(projections).some(projection => !projection?.id || !projection.boardId || !projection.source?.agenda?.id
        || !projection.idMap || !Array.isArray(projection.members)
        || projection.members.some(member => !member?.viewId || !member.sourceId || !member.record)))) {
    return { restored: false, protected: true, reason: 'Desk의 Board 구성 기록을 읽을 수 없습니다.' };
  }
  if (snapshot.chat && (!Array.isArray(snapshot.chat.threads)
      || snapshot.chat.threads.some(thread => !thread?.id || !Array.isArray(thread.messages)))) {
    return { restored: false, protected: true, reason: 'Desk의 대화 기록을 읽을 수 없습니다.' };
  }
  try {
    const restored = restore(snapshot) === true;
    return { restored, protected: !restored, reason: restored ? null : 'Desk 기록을 모두 복원하지 못했습니다.' };
  } catch (error) {
    return { restored: false, protected: true, reason: error.message || 'Desk 복원 중 오류가 발생했습니다.' };
  }
}

export function canPersistDeskSession(surface) {
  return !surface.restoring && !surface.recoveryProtected;
}

export function planBoardProjection(snapshot, projectionId) {
  if (!snapshot?.agenda?.id || !projectionId) throw new Error('Board and projection IDs are required');
  const cards = snapshot.cards || [];
  const shapes = snapshot.shapes || [];
  const ids = [...new Set([...(snapshot.agenda.memberCardIds || []), ...cards.map(x => x.id), ...shapes.map(x => x.id)].filter(Boolean))];
  const idMap = Object.fromEntries(ids.map((id, index) => [id, `${projectionId}-member-${index}`]));
  return {
    id: projectionId, boardId: snapshot.agenda.id, title: snapshot.agenda.title || 'Board',
    source: copy(snapshot), idMap,
    bindings: remapMemberReferences(copy(snapshot.agenda.contextBindings || []), idMap),
    members: ids.map(id => {
      const card = cards.find(x => x.id === id);
      const shape = shapes.find(x => x.id === id);
      return { sourceId: id, viewId: idMap[id], kind: shape ? 'shape' : 'card', record: copy(card || shape || { id, type: 'missing' }) };
    }),
  };
}

// Only explicitly owned members are considered. Unrelated Canvas records cannot leak in.
export function snapshotBoardProjection(projection, records, now = Date.now()) {
  const snapshot = copy(projection.source);
  const inverse = Object.fromEntries(Object.entries(projection.idMap).map(([source, view]) => [view, source]));
  snapshot.savedAt = now;
  snapshot.cards = [];
  snapshot.shapes = [];
  for (const member of projection.members) {
    const record = copy(records[member.viewId] || member.record);
    record.id = member.sourceId;
    (member.kind === 'shape' ? snapshot.shapes : snapshot.cards).push(record);
  }
  snapshot.agenda = {
    ...snapshot.agenda, title: projection.title,
    memberCardIds: projection.members.filter(x => x.kind !== 'shape').map(x => x.sourceId),
    contextBindings: remapMemberReferences(copy(projection.bindings), inverse),
  };
  return snapshot;
}
