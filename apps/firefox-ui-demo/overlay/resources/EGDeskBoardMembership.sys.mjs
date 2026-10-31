// CNV-03 Board membership of Desk Windows, decided 2026-10-24:
//   D-V1 one View belongs to one Board at most;
//   D-V2 a new View is never added to a Board on its own — opening it inside a
//        Board region, or dropping it there, only suggests the membership;
//   D-V3 the suggestion is a chip the person accepts or declines;
//   D-V4 a new Board saved from open Views binds those Views where they are,
//        nothing is copied.
// Pure rules over Board projections ({ id, boardId, title, members, idMap,
// offset, ... } as the screen keeps them). The membership edits themselves are
// EGDeskCanvasLayout's addProjectionMember / removeProjectionMember; this
// module turns them into patches the screen applies to its live objects, and
// decides what the View bar menu and the suggestion chip say.
import { addProjectionMember, removeProjectionMember, regionDropSuggestion } from './EGDeskCanvasLayout.sys.mjs';
import { planBoardProjection } from './EGDeskSurfaceState.sys.mjs';

export const NO_OPEN_BOARD_LABEL = '열린 Board가 없어요';

const projectionList = projections => Array.isArray(projections)
  ? projections.filter(item => item?.id != null)
  : projections && typeof projections === 'object' ? Object.values(projections).filter(item => item?.id != null) : [];
const titleOf = projection => typeof projection?.title === 'string' && projection.title.trim() ? projection.title.trim() : 'Board';
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

// Rows of the View bar's Board menu. The current Board's '빼기' comes first,
// then every other open Board as '넣기' (D-V1: joining one leaves the other).
// Other Boards are ordered: the active Board, then the most recently selected,
// then by title.
export function membershipMenuItems({ projections, ownerId = null, activeId = null, recentIds = [] } = {}) {
  const list = projectionList(projections);
  const owner = ownerId != null ? list.find(item => item.id === ownerId) || null : null;
  const recent = Array.isArray(recentIds) ? recentIds : [];
  const rank = projection => projection.id === activeId ? -1
    : recent.indexOf(projection.id) >= 0 ? recent.indexOf(projection.id) : Number.MAX_SAFE_INTEGER;
  const items = [];
  if (owner) {
    items.push({ action: 'remove', projectionId: owner.id, label: `'${titleOf(owner)}'에서 빼기`,
      title: `이 화면을 Board '${titleOf(owner)}'에서 뺍니다. 화면은 Desk에 남습니다.`, testid: 'window-board-remove' });
  }
  const others = list.filter(item => item.id !== owner?.id)
    .sort((a, b) => rank(a) - rank(b) || titleOf(a).localeCompare(titleOf(b), 'ko'));
  for (const projection of others) {
    items.push({ action: owner ? 'move' : 'add', projectionId: projection.id, label: `'${titleOf(projection)}'에 넣기`,
      title: owner ? `이 화면을 Board '${titleOf(owner)}'에서 '${titleOf(projection)}'(으)로 옮깁니다.` : `이 화면을 Board '${titleOf(projection)}'에 넣습니다.`,
      testid: 'window-board-add' });
  }
  return { items, empty: items.length ? null : NO_OPEN_BOARD_LABEL };
}

export function suggestionCopy({ action = 'add', title = 'Board', fromTitle = null } = {}) {
  if (action === 'move') {
    return { message: `'${fromTitle || 'Board'}'에서 '${title}'(으)로 옮길까요?`, accept: '옮기기', decline: '아니요' };
  }
  return { message: `'${title}'에 넣을까요?`, accept: '넣기', decline: '아니요' };
}

// The chip to show when a View is opened inside, or dropped into, a Board
// region it does not belong to (D-V2, D-V3). `quiet` is true while the Desk or
// a Board is being restored: restored Views keep their recorded membership and
// get no chip. `regions` are [{ id, rect }] in world px; `projections` the
// live Board projections.
export function membershipSuggestion({ viewRect, point = null, regions = [], projections = {}, ownerId = null, quiet = false } = {}) {
  if (quiet) return null;
  const hit = regionDropSuggestion({ viewRect, point, regions, ownerId });
  if (!hit) return null;
  const list = projectionList(projections);
  const target = list.find(item => item.id === hit.projectionId);
  if (!target) return null;
  const from = hit.fromId != null ? list.find(item => item.id === hit.fromId) || null : null;
  const title = titleOf(target);
  const fromTitle = from ? titleOf(from) : null;
  return { ...hit, title, fromTitle, ...suggestionCopy({ action: hit.action, title, fromTitle }) };
}

// Plans 'add' (join a Board, leaving any other) or 'remove' without touching
// the live projection objects: `patches` carry the next members/idMap of every
// projection that changed, so the screen can assign them in place. Menus, Board
// regions and restore code hold the same projection objects, which is why they
// are never replaced.
export function planMembershipChange(projections, { action = 'add', projectionId = null, viewId = null, kind = 'card', record = null } = {}) {
  const before = new Map(projectionList(projections).map(item => [item.id, item]));
  const result = action === 'remove'
    ? removeProjectionMember(projections, { viewId, projectionId })
    : addProjectionMember(projections, { projectionId, viewId, kind, record });
  const base = { changed: !!result.changed, from: result.from ?? null, to: result.to ?? null, member: result.member ?? null, patches: [] };
  if (!result.changed) return base;
  base.patches = projectionList(result.projections)
    .filter(item => before.get(item.id) !== item)
    .map(item => ({ id: item.id, members: item.members, idMap: item.idMap }));
  return base;
}

// D-V4: the projection of a Board just saved from open Views. The snapshot's
// records are the Views as they stand (Desk coordinates, so the offset is 0),
// and each member keeps its View id as its source id, so the Views are bound
// where they are and the next save maps them 1:1. Nothing opens anew.
export function inPlaceBoardProjection(snapshot, projectionId) {
  const projection = planBoardProjection(snapshot, projectionId);
  projection.idMap = Object.fromEntries(Object.keys(projection.idMap).map(id => [id, id]));
  for (const member of projection.members) member.viewId = member.sourceId;
  projection.bindings = copy(snapshot.agenda?.contextBindings || []);
  projection.offset = { x: 0, y: 0 };
  projection.dirty = false;
  return projection;
}
