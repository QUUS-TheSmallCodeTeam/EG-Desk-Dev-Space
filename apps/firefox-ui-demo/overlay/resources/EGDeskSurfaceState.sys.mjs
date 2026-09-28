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
