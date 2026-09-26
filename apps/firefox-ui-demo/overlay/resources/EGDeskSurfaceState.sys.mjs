// Pure surface state. No browser, filesystem, network, or execution side effects.
export function initialSurfaceMode({ lifecycle, deskSession, legacyStore, existingSurface = false }) {
  if (lifecycle?.mode === 'browser' || lifecycle?.mode === 'desk') return lifecycle.mode;
  if (lifecycle || deskSession || legacyStore || existingSurface) return 'desk';
  return 'browser';
}

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
export function remapMemberReferences(value, ids) {
  if (typeof value === 'string') return ids[value] || value;
  if (Array.isArray(value)) return value.map(item => remapMemberReferences(item, ids));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [ids[key] || key, remapMemberReferences(item, ids)]));
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
