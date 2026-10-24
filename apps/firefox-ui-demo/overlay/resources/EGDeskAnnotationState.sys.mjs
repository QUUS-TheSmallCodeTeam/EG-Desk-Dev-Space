// AI annotation sets over Canvas cards: proposal, accept/dismiss, edit
// provenance, card-local projection and Board persistence. Pure data: no DOM,
// no provider requests, no capture. An annotation is a display mark only. It
// never acts on the card under it, and its geometry is never reused as input
// coordinates for that card.
//
// Patterns followed (no code copied):
// - tldraw/agent-template (MIT, Copyright (c) 2024 tldraw Inc.): structured
//   shape data with a note and target ids (shared/format/FocusedShape.ts),
//   pending/accepted/rejected per agent action and accept/reject of a whole
//   group (shared/types/ChatHistoryItem.ts,
//   client/components/chat-history/ChatHistoryGroupWithDiff.tsx).
// - excalidraw (MIT, Copyright (c) 2020 Excalidraw): a 0..1 ratio on the bound
//   element instead of absolute pixels (packages/element/src/types.ts
//   FixedPointBinding).
// Contract and product rules: docs/AI_CANVAS_ANNOTATION_LAYER.md.

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const token = value => typeof value === 'string' && TOKEN.test(value) ? value : null;
const round4 = value => Math.round(value * 10000) / 10000;
const round1 = value => Math.round(value * 10) / 10;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const msTime = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export const ANNOTATION_ITEM_TYPES = Object.freeze(['box', 'ellipse', 'highlight', 'line', 'arrow', 'label']);
export const ANNOTATION_PURPOSES = Object.freeze(['locate', 'critique', 'evidence', 'instruction', 'diff', 'warning']);
export const ANNOTATION_STATUSES = Object.freeze(['proposed', 'accepted', 'edited', 'dismissed']);
export const ANNOTATION_TARGET_KINDS = Object.freeze(['browser', 'image', 'pdf', 'deck', 'file', 'canvas-region']);
export const ANNOTATION_GROUNDING = Object.freeze(['dom', 'visual', 'both']);
// coordinate: card-space values are ratios of the captured content area; a
// mark moved by the user after scrolling may sit outside 0..1, but never
// further than this many content areas away.
export const ANNOTATION_LIMITS = Object.freeze({ items: 32, label: 120, note: 280, coordinate: 100, canvasCoordinate: 1e7 });

const RECT_TYPES = new Set(['box', 'ellipse', 'highlight']);
const LINE_TYPES = new Set(['line', 'arrow']);
// Every annotation type renders as an existing Canvas shape type
// (EGDeskSurfaceState CANVAS_SHAPE_TYPES), so marks stay user-editable.
const SHAPE_FOR_TYPE = Object.freeze({ box: 'rect', ellipse: 'ellipse', highlight: 'highlight', line: 'line', arrow: 'arrow', label: 'label' });
const KEPT = new Set(['accepted', 'edited']);

export function annotationShapeType(type) {
  return Object.hasOwn(SHAPE_FOR_TYPE, type) ? SHAPE_FOR_TYPE[type] : null;
}

function text(value, max) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

function bounded(value, space) {
  const limit = space === 'canvas' ? ANNOTATION_LIMITS.canvasCoordinate : ANNOTATION_LIMITS.coordinate;
  return finite(value) && Math.abs(value) <= limit;
}
const roundFor = space => space === 'canvas' ? round1 : round4;

function normPoint(raw, space) {
  if (!raw || typeof raw !== 'object' || !bounded(raw.x, space) || !bounded(raw.y, space)) return null;
  const round = roundFor(space);
  return { x: round(raw.x), y: round(raw.y) };
}

// Accepts {x, y, w, h} or {x, y, width, height}; always stores {x, y, w, h}.
function normRect(raw, space) {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw.w ?? raw.width;
  const h = raw.h ?? raw.height;
  if (!bounded(raw.x, space) || !bounded(raw.y, space) || !bounded(w, space) || !bounded(h, space)) return null;
  const round = roundFor(space);
  const rect = { x: round(raw.x), y: round(raw.y), w: round(w), h: round(h) };
  return rect.w > 0 && rect.h > 0 ? rect : null;
}

// Geometry fields per type: rect for box/ellipse/highlight, from+to for
// line/arrow, at for label.
function normGeometry(type, raw, space) {
  if (RECT_TYPES.has(type)) {
    const rect = normRect(raw?.rect, space);
    return rect ? { rect } : null;
  }
  if (LINE_TYPES.has(type)) {
    const from = normPoint(raw?.from, space), to = normPoint(raw?.to, space);
    return from && to && (from.x !== to.x || from.y !== to.y) ? { from, to } : null;
  }
  const at = normPoint(raw?.at, space);
  return at ? { at } : null;
}

const geometryOf = item => RECT_TYPES.has(item.type) ? { rect: { ...item.rect } }
  : LINE_TYPES.has(item.type) ? { from: { ...item.from }, to: { ...item.to } } : { at: { ...item.at } };
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function normEdit(raw, type, space) {
  if (!raw || typeof raw !== 'object') return null;
  const original = normGeometry(type, raw.original, space);
  if (!original) return null;
  const label = text(raw.original?.label, ANNOTATION_LIMITS.label);
  if (label) original.label = label;
  const edit = { original, editedBy: raw.editedBy === 'agent' ? 'agent' : 'user' };
  const editedAt = msTime(raw.editedAt);
  if (editedAt !== null) edit.editedAt = editedAt;
  return edit;
}

function normItem(raw, space, index) {
  if (!raw || typeof raw !== 'object' || !ANNOTATION_ITEM_TYPES.includes(raw.type)) return null;
  const geometry = normGeometry(raw.type, raw, space);
  if (!geometry) return null;
  const label = text(raw.label, ANNOTATION_LIMITS.label);
  if (raw.type === 'label' && !label) return null;
  const item = { id: token(raw.id) || `item-${index + 1}`, type: raw.type, ...geometry };
  if (label) item.label = label;
  const note = text(raw.note, ANNOTATION_LIMITS.note);
  if (note) item.note = note;
  if (ANNOTATION_PURPOSES.includes(raw.purpose)) item.purpose = raw.purpose;
  if (finite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1) item.confidence = Math.round(raw.confidence * 100) / 100;
  // Element ref from the Browser observation the mark was computed from. It
  // lets a later tool find the same element again; it is not an input target.
  const ref = token(raw.ref);
  if (ref && space === 'card') item.ref = ref;
  if (LINE_TYPES.has(raw.type)) {
    const fromItemId = token(raw.fromItemId), toItemId = token(raw.toItemId);
    if (fromItemId) item.fromItemId = fromItemId;
    if (toItemId) item.toItemId = toItemId;
  }
  item.status = ANNOTATION_STATUSES.includes(raw.status) ? raw.status : 'proposed';
  const edit = item.status === 'edited' || item.status === 'dismissed' ? normEdit(raw.edit, raw.type, space) : null;
  if (edit) item.edit = edit;
  return item;
}

function normSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = {};
  if (typeof raw.documentId === 'string' && raw.documentId && raw.documentId.length <= 128) source.documentId = raw.documentId;
  if (Number.isSafeInteger(raw.revision) && raw.revision >= 0) source.revision = raw.revision;
  const viewport = raw.viewport;
  if (Number.isSafeInteger(viewport?.width) && Number.isSafeInteger(viewport?.height) && viewport.width > 0 && viewport.height > 0) {
    source.viewport = { width: viewport.width, height: viewport.height };
  }
  const scroll = raw.scroll;
  if (finite(scroll?.x) && finite(scroll?.y)) source.scroll = { x: Math.max(0, Math.round(scroll.x)), y: Math.max(0, Math.round(scroll.y)) };
  return Object.keys(source).length ? source : null;
}

// One structured set from an Agent, a user tool or a saved Board. Invalid items
// are dropped; a set with no usable item is refused. The input is not mutated
// and unknown fields are not carried over.
export function normalizeAnnotationSet(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('표식 묶음이 없습니다.');
  const id = token(input.id);
  if (!id) throw new Error('표식 묶음 id가 없습니다.');
  const targetCardId = token(input.targetCardId);
  if (input.space === 'card' && !targetCardId) throw new Error('표식을 붙일 카드가 없습니다.');
  const space = targetCardId ? 'card' : 'canvas';
  const set = { version: 1, id, space };
  if (targetCardId) set.targetCardId = targetCardId;
  if (space === 'card' && ANNOTATION_TARGET_KINDS.includes(input.targetKind)) set.targetKind = input.targetKind;
  for (const key of ['agendaId', 'sourceRunId', 'sourceMessageId', 'createdByAgentId']) {
    const value = token(input[key]);
    if (value) set[key] = value;
  }
  if (ANNOTATION_GROUNDING.includes(input.grounding)) set.grounding = input.grounding;
  const source = space === 'card' ? normSource(input.source) : null;
  if (source) set.source = source;
  set.createdAt = msTime(input.createdAt) ?? now;
  const items = [];
  const seen = new Set();
  for (const [index, raw] of (Array.isArray(input.items) ? input.items : []).entries()) {
    if (items.length >= ANNOTATION_LIMITS.items) break;
    const item = normItem(raw, space, index);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  if (!items.length) throw new Error('표시할 수 있는 표식이 없습니다.');
  // Arrow ends may point at other marks of the same set (tldraw fromId/toId);
  // an end that names no mark here is dropped, not guessed.
  for (const item of items) {
    for (const key of ['fromItemId', 'toItemId']) {
      if (item[key] && (item[key] === item.id || !seen.has(item[key]))) delete item[key];
    }
  }
  set.items = items;
  return set;
}

// Browser observation element bounds are viewport-local CSS pixels
// (EGDeskBrowserAgentRuntimeChild elementItem/observationState). The ratio
// rect is the part of the element inside the viewport, or null when none is.
export function rectFromViewportBounds(bounds, viewport) {
  if (!bounds || !viewport || !finite(bounds.x) || !finite(bounds.y) || !finite(bounds.width) || !finite(bounds.height)) return null;
  if (!finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) return null;
  const left = Math.max(0, bounds.x), top = Math.max(0, bounds.y);
  const right = Math.min(viewport.width, bounds.x + bounds.width), bottom = Math.min(viewport.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  return { x: round4(left / viewport.width), y: round4(top / viewport.height),
    w: round4((right - left) / viewport.width), h: round4((bottom - top) / viewport.height) };
}

// Whether marks computed on an earlier observation still describe the card.
// 'unbound': free-canvas set or no document identity, never stale.
// 'unknown': the current identity is unavailable, so positions cannot be trusted.
// 'stale': another document is loaded (navigation, reload).
// 'revised': same document, but its content or viewport size changed since, so
//   marks may have drifted. Shown with a hint, still acceptable.
export function annotationFreshness(set, current) {
  const source = set?.source;
  if (set?.space !== 'card' || !source?.documentId) return { status: 'unbound', stale: false };
  if (!current || typeof current.documentId !== 'string' || !current.documentId) {
    return { status: 'unknown', stale: true, reason: '지금 카드의 페이지를 확인할 수 없어 표식 위치를 믿을 수 없습니다.' };
  }
  if (current.documentId !== source.documentId) return { status: 'stale', stale: true, reason: '표식을 만든 뒤 카드의 페이지가 바뀌었습니다.' };
  const viewportChanged = source.viewport && current.viewport
    && (source.viewport.width !== current.viewport.width || source.viewport.height !== current.viewport.height);
  const revised = Number.isSafeInteger(source.revision) && Number.isSafeInteger(current.revision) && current.revision !== source.revision;
  if (viewportChanged || revised) return { status: 'revised', stale: false, reason: '표식을 만든 뒤 페이지 내용이 바뀌어 위치가 어긋났을 수 있습니다.' };
  return { status: 'current', stale: false };
}
export const annotationStale = (set, current) => annotationFreshness(set, current).stale;

// Same document scrolled since capture: shift marks by the scroll distance in
// content-area ratios. Display only; it never changes the stored geometry.
export function annotationScrollOffset(set, current) {
  const source = set?.source;
  if (!source?.scroll || !source.viewport || !finite(current?.scroll?.x) || !finite(current?.scroll?.y)) return { x: 0, y: 0 };
  if (annotationFreshness(set, current).stale) return { x: 0, y: 0 };
  return { x: round4((source.scroll.x - current.scroll.x) / source.viewport.width),
    y: round4((source.scroll.y - current.scroll.y) / source.viewport.height) };
}

const validRect = rect => rect && finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height) && rect.width > 0 && rect.height > 0;
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

// One mark in Canvas world coordinates. contentRect is the target card's
// content box in world coordinates (it follows card move and resize); it is
// ignored for a free-canvas set. Returns null when a card-space mark has no
// content box to sit in.
export function projectItem(item, contentRect, { space = 'card', offset = { x: 0, y: 0 } } = {}) {
  if (!item || !ANNOTATION_ITEM_TYPES.includes(item.type)) return null;
  const canvas = space === 'canvas';
  if (!canvas && !validRect(contentRect)) return null;
  const dx = finite(offset?.x) ? offset.x : 0, dy = finite(offset?.y) ? offset.y : 0;
  const point = p => canvas ? { x: round1(p.x), y: round1(p.y) }
    : { x: round1(contentRect.x + (p.x + dx) * contentRect.width), y: round1(contentRect.y + (p.y + dy) * contentRect.height) };
  const projected = { id: item.id, type: item.type, shapeType: annotationShapeType(item.type), status: item.status };
  for (const key of ['label', 'note', 'purpose', 'confidence']) if (item[key] !== undefined) projected[key] = item[key];
  let box;
  if (RECT_TYPES.has(item.type)) {
    const origin = point(item.rect);
    projected.rect = { ...origin, width: round1(canvas ? item.rect.w : item.rect.w * contentRect.width),
      height: round1(canvas ? item.rect.h : item.rect.h * contentRect.height) };
    box = projected.rect;
  } else if (LINE_TYPES.has(item.type)) {
    const from = point(item.from), to = point(item.to);
    projected.line = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    box = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
      width: Math.max(Math.abs(to.x - from.x), 0.1), height: Math.max(Math.abs(to.y - from.y), 0.1) };
  } else {
    projected.point = point(item.at);
    box = { ...projected.point, width: 0.1, height: 0.1 };
  }
  projected.visible = canvas || overlaps(box, contentRect);
  return projected;
}

// Inverse of projectItem for a user drag or resize: a world rect back to the
// stored geometry. Pass the same offset used for display so stored values stay
// relative to the captured content area.
export function unprojectRect(rect, contentRect, { space = 'card', offset = { x: 0, y: 0 } } = {}) {
  if (!validRect(rect)) return null;
  if (space === 'canvas') return normRect(rect, 'canvas');
  if (!validRect(contentRect)) return null;
  const dx = finite(offset?.x) ? offset.x : 0, dy = finite(offset?.y) ? offset.y : 0;
  return normRect({ x: (rect.x - contentRect.x) / contentRect.width - dx, y: (rect.y - contentRect.y) / contentRect.height - dy,
    w: rect.width / contentRect.width, h: rect.height / contentRect.height }, 'card');
}

export function unprojectPoint(point, contentRect, { space = 'card', offset = { x: 0, y: 0 } } = {}) {
  if (!point || !finite(point.x) || !finite(point.y)) return null;
  if (space === 'canvas') return normPoint(point, 'canvas');
  if (!validRect(contentRect)) return null;
  const dx = finite(offset?.x) ? offset.x : 0, dy = finite(offset?.y) ? offset.y : 0;
  return normPoint({ x: (point.x - contentRect.x) / contentRect.width - dx, y: (point.y - contentRect.y) / contentRect.height - dy }, 'card');
}

// Everything the screen needs to draw one set: freshness, scroll offset and
// the non-dismissed marks in world coordinates.
export function projectAnnotationSet(set, contentRect, current) {
  const freshness = annotationFreshness(set, current);
  const offset = annotationScrollOffset(set, current);
  const items = (set?.items || []).filter(item => item.status !== 'dismissed')
    .map(item => projectItem(item, contentRect, { space: set.space, offset })).filter(Boolean);
  return { setId: set?.id ?? null, freshness, offset, items };
}

function decide(set, itemIds, change) {
  const wanted = Array.isArray(itemIds) ? new Set(itemIds) : null;
  let changed = false;
  const items = set.items.map(item => {
    if (wanted && !wanted.has(item.id)) return item;
    const next = change(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? { ...set, items } : set;
}

// Accept marks (all marks of the set when itemIds is omitted: one click for
// the whole proposal group). A user edit stays 'edited'. A document-bound set
// must be re-checked against the card's current identity first; a stale or
// unconfirmable set is refused with code ANNOTATION_STALE.
export function acceptAnnotations(set, { itemIds = null, current } = {}) {
  const freshness = annotationFreshness(set, current);
  if (freshness.stale) throw Object.assign(new Error(freshness.reason), { code: 'ANNOTATION_STALE' });
  return decide(set, itemIds, item => item.status === 'proposed' ? { ...item, status: 'accepted' }
    : item.status === 'dismissed' ? { ...item, status: item.edit ? 'edited' : 'accepted' } : item);
}

// Dismissing is always allowed, also on a stale set. Edit provenance is kept
// for run history; the mark leaves the visible Canvas.
export function dismissAnnotations(set, { itemIds = null } = {}) {
  return decide(set, itemIds, item => item.status === 'dismissed' ? item : { ...item, status: 'dismissed' });
}

// A user (or Agent) moved, resized or relabelled one mark. patch holds the
// stored geometry for its type (rect | from+to | at, as unprojectRect /
// unprojectPoint return) and/or label. The first edit keeps the original.
export function editAnnotationItem(set, itemId, patch = {}, { by = 'user', now = Date.now() } = {}) {
  const index = set?.items?.findIndex(item => item.id === itemId) ?? -1;
  if (index < 0) throw new Error('고칠 표식을 찾을 수 없습니다.');
  const item = set.items[index];
  if (item.status === 'dismissed') throw new Error('지운 표식은 고칠 수 없습니다.');
  const hasGeometry = ['rect', 'from', 'to', 'at'].some(key => patch?.[key] !== undefined);
  const geometry = hasGeometry ? normGeometry(item.type, { ...geometryOf(item), ...patch }, set.space) : geometryOf(item);
  if (!geometry) throw new Error('표식 위치가 올바르지 않습니다.');
  const label = patch?.label === undefined ? item.label ?? null : text(patch.label, ANNOTATION_LIMITS.label);
  if (item.type === 'label' && !label) throw new Error('글자 표식에는 글자가 필요합니다.');
  if (sameJson(geometry, geometryOf(item)) && label === (item.label ?? null)) return set;
  const original = item.edit?.original || { ...geometryOf(item), ...(item.label ? { label: item.label } : {}) };
  const next = { ...item, ...geometry, status: 'edited',
    edit: { original, editedBy: by === 'agent' ? 'agent' : 'user', ...(msTime(now) !== null ? { editedAt: now } : {}) } };
  if (label) next.label = label; else delete next.label;
  const items = set.items.slice();
  items[index] = next;
  return { ...set, items };
}

export function annotationCounts(set) {
  const counts = { total: 0, proposed: 0, accepted: 0, edited: 0, dismissed: 0 };
  for (const item of set?.items || []) {
    counts.total += 1;
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
  }
  return counts;
}

// Group state, as tldraw derives one acceptance for a group of actions:
// 'proposed' (nothing decided), 'partial' (some decided, some waiting),
// 'accepted' (nothing waiting, at least one kept), 'dismissed' (all removed).
export function annotationSetStatus(set) {
  const counts = annotationCounts(set);
  const kept = counts.accepted + counts.edited;
  if (counts.proposed) return counts.proposed === counts.total ? 'proposed' : 'partial';
  return kept ? 'accepted' : 'dismissed';
}

// Short line for a Chat answer or card badge, never a coordinate dump.
export function annotationSummaryText(set) {
  const counts = annotationCounts(set);
  const parts = [`표식 ${counts.total}개`];
  if (counts.proposed) parts.push(`확인 대기 ${counts.proposed}`);
  if (counts.accepted + counts.edited) parts.push(`받음 ${counts.accepted + counts.edited}`);
  if (counts.dismissed) parts.push(`지움 ${counts.dismissed}`);
  return parts.join(' · ');
}

// Board saved state holds only marks the user kept. Proposals stay a dirty
// overlay and dismissed marks leave the Canvas (run history may keep them).
// An arrow end that pointed at a mark which is not saved is dropped.
export function annotationSetForBoard(set) {
  const kept = (set?.items || []).filter(item => KEPT.has(item.status));
  if (!kept.length) return null;
  const ids = new Set(kept.map(item => item.id));
  const copy = JSON.parse(JSON.stringify({ ...set, items: kept }));
  for (const item of copy.items) {
    for (const key of ['fromItemId', 'toItemId']) if (item[key] && !ids.has(item[key])) delete item[key];
  }
  return copy;
}

export function restoreAnnotationSet(record, { now = Date.now() } = {}) {
  try { return annotationSetForBoard(normalizeAnnotationSet(record, { now })); }
  catch { return null; }
}
