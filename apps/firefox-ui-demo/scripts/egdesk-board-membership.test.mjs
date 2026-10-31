import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_OPEN_BOARD_LABEL, membershipMenuItems, suggestionCopy, membershipSuggestion, planMembershipChange, inPlaceBoardProjection,
} from '../overlay/resources/EGDeskBoardMembership.sys.mjs';
import { snapshotBoardProjection } from '../overlay/resources/EGDeskSurfaceState.sys.mjs';

const rect = (x, y, width, height) => ({ x, y, width, height });
const projection = (id, title, members = [], extra = {}) => ({
  id, boardId: `logical-${id}`, title, members, idMap: Object.fromEntries(members.map(member => [member.sourceId, member.viewId])),
  offset: { x: 0, y: 0 }, bindings: [], source: { agenda: { id: `logical-${id}`, title } }, ...extra,
});
const member = (viewId, sourceId = viewId, kind = 'card') => ({ sourceId, viewId, kind, record: { id: sourceId, type: 'browser', geometry: rect(0, 0, 10, 10) } });

// ------------------------------------------------------------- View bar menu

test('menu: the current Board comes first as 빼기, the active Board leads the 넣기 rows, then recent, then title', () => {
  const projections = {
    a: projection('a', '자료 정리', [member('v1')]),
    b: projection('b', '회의 준비'),
    c: projection('c', '가나다'),
    d: projection('d', '하하하'),
  };
  const owned = membershipMenuItems({ projections, ownerId: 'a', activeId: 'c', recentIds: ['d', 'c'] });
  assert.deepEqual(owned.items.map(item => [item.action, item.projectionId]), [['remove', 'a'], ['move', 'c'], ['move', 'd'], ['move', 'b']]);
  assert.equal(owned.items[0].label, "'자료 정리'에서 빼기");
  assert.equal(owned.items[1].label, "'가나다'에 넣기");
  assert.equal(owned.empty, null);
  const unowned = membershipMenuItems({ projections, ownerId: null, activeId: null, recentIds: [] });
  assert.deepEqual(unowned.items.map(item => [item.action, item.projectionId]), [['add', 'c'], ['add', 'a'], ['add', 'd'], ['add', 'b']], 'no active or recent Board: by title');
  const sole = membershipMenuItems({ projections: { a: projections.a }, ownerId: 'a' });
  assert.deepEqual(sole.items.map(item => item.action), ['remove'], 'the only open Board offers leaving it');
});

test('menu: an unknown owner id is treated as no owner, and no open Board says so', () => {
  const none = membershipMenuItems({ projections: {}, ownerId: 'gone' });
  assert.deepEqual(none.items, []);
  assert.equal(none.empty, NO_OPEN_BOARD_LABEL);
  const stale = membershipMenuItems({ projections: { a: projection('a', 'A') }, ownerId: 'gone' });
  assert.deepEqual(stale.items.map(item => item.action), ['add']);
  assert.deepEqual(membershipMenuItems({ projections: [projection('x', '  ')] }).items.map(item => item.label), ["'Board'에 넣기"], 'a blank title reads as Board');
});

// ------------------------------------------------------------ suggestion chip

test('suggestion: only inside a Board region the View does not belong to, never while restoring', () => {
  const regions = [{ id: 'a', rect: rect(0, 0, 500, 400) }, { id: 'b', rect: rect(1000, 0, 500, 400) }];
  const projections = { a: projection('a', '자료 정리'), b: projection('b', '회의 준비') };
  const inA = membershipSuggestion({ viewRect: rect(100, 100, 200, 100), regions, projections });
  assert.deepEqual(inA, { projectionId: 'a', action: 'add', fromId: null, title: '자료 정리', fromTitle: null,
    message: "'자료 정리'에 넣을까요?", accept: '넣기', decline: '아니요' });
  const moved = membershipSuggestion({ viewRect: rect(1100, 100, 200, 100), regions, projections, ownerId: 'a' });
  assert.deepEqual([moved.action, moved.fromId, moved.message, moved.accept], ['move', 'a', "'자료 정리'에서 '회의 준비'(으)로 옮길까요?", '옮기기']);
  assert.equal(membershipSuggestion({ viewRect: rect(100, 100, 200, 100), regions, projections, ownerId: 'a' }), null, 'already in that Board');
  assert.equal(membershipSuggestion({ viewRect: rect(600, 100, 200, 100), regions, projections }), null, 'outside every region');
  assert.equal(membershipSuggestion({ viewRect: rect(100, 100, 200, 100), regions, projections, quiet: true }), null, 'restoring');
  assert.equal(membershipSuggestion({ viewRect: rect(100, 100, 200, 100), regions, projections: { b: projections.b } }), null, 'a region without a live projection');
  assert.equal(membershipSuggestion({ viewRect: rect(100, 100, 200, 100), regions, projections, point: { x: 1200, y: 50 } }).projectionId, 'b', 'the pointer decides when given');
  assert.deepEqual(suggestionCopy({}), { message: "'Board'에 넣을까요?", accept: '넣기', decline: '아니요' });
});

// -------------------------------------------------------- membership patches

test('plan add: a new member joins with its geometry relative to the Board, as one patch', () => {
  const projections = { a: projection('a', 'A', [], { offset: { x: 100, y: 50 } }), b: projection('b', 'B') };
  const change = planMembershipChange(projections, { action: 'add', projectionId: 'a', viewId: 'view-1', kind: 'card',
    record: { id: 'view-1', type: 'browser', geometry: rect(160, 90, 300, 200) } });
  assert.equal(change.changed, true);
  assert.deepEqual([change.from, change.to], [null, 'a']);
  assert.deepEqual(change.patches.map(patch => patch.id), ['a']);
  assert.deepEqual(change.patches[0].idMap, { 'view-1': 'view-1' });
  assert.equal(change.member.viewId, 'view-1');
  assert.equal(change.member.sourceId, 'view-1');
  assert.deepEqual(change.member.record.geometry, rect(60, 40, 300, 200), 'stored like serializeAgendaSnapshot stores it');
  assert.deepEqual(projections.a.members, [], 'the live projection is untouched until the screen applies the patch');
  assert.equal(planMembershipChange(projections, { action: 'add', projectionId: 'missing', viewId: 'view-1' }).changed, false);
});

test('plan move: joining another Board leaves the current one in the same change (D-V1)', () => {
  const projections = { a: projection('a', 'A', [member('view-1')]), b: projection('b', 'B') };
  const change = planMembershipChange(projections, { action: 'add', projectionId: 'b', viewId: 'view-1', record: { id: 'view-1', type: 'browser', geometry: rect(0, 0, 10, 10) } });
  assert.deepEqual([change.changed, change.from, change.to], [true, 'a', 'b']);
  assert.deepEqual(change.patches.map(patch => [patch.id, patch.members.map(row => row.viewId), patch.idMap]),
    [['a', [], {}], ['b', ['view-1'], { 'view-1': 'view-1' }]]);
  const same = planMembershipChange(projections, { action: 'add', projectionId: 'a', viewId: 'view-1' });
  assert.deepEqual([same.changed, same.patches, same.member?.viewId], [false, [], 'view-1'], 'already a member: nothing to patch');
});

test('plan remove: the View leaves its Board and stays; unknown Views change nothing', () => {
  const projections = { a: projection('a', 'A', [member('view-1'), member('view-2')]) };
  const change = planMembershipChange(projections, { action: 'remove', viewId: 'view-1', projectionId: 'a' });
  assert.deepEqual([change.changed, change.from, change.member.viewId], [true, 'a', 'view-1']);
  assert.deepEqual(change.patches, [{ id: 'a', members: [member('view-2')], idMap: { 'view-2': 'view-2' } }]);
  assert.equal(planMembershipChange(projections, { action: 'remove', viewId: 'view-9' }).changed, false);
  assert.equal(planMembershipChange(projections, { action: 'remove', viewId: 'view-1', projectionId: 'other' }).changed, false, 'a wrong Board does not remove');
});

// ------------------------------------------------------------- D-V4 in place

test('in-place projection: a Board saved from open Views binds them by their own ids with no offset', () => {
  const snapshot = {
    version: 1, savedAt: 1,
    agenda: { id: 'logical-new', title: '새 보드', memberCardIds: ['egd-browser-card-3'], contextBindings: [{ kind: 'view', viewId: 'egd-browser-card-3' }] },
    cards: [{ id: 'egd-browser-card-3', type: 'browser', geometry: rect(240, 120, 720, 480) }],
    shapes: [{ id: 'egd-shape-4', type: 'rect', geometry: rect(10, 10, 50, 50) }],
  };
  const bound = inPlaceBoardProjection(snapshot, 'egd-board-7');
  assert.deepEqual([bound.id, bound.boardId, bound.title, bound.offset, bound.dirty], ['egd-board-7', 'logical-new', '새 보드', { x: 0, y: 0 }, false]);
  assert.deepEqual(bound.idMap, { 'egd-browser-card-3': 'egd-browser-card-3', 'egd-shape-4': 'egd-shape-4' });
  assert.deepEqual(bound.members.map(row => [row.viewId, row.sourceId, row.kind]), [['egd-browser-card-3', 'egd-browser-card-3', 'card'], ['egd-shape-4', 'egd-shape-4', 'shape']]);
  assert.deepEqual(bound.members[0].record.geometry, rect(240, 120, 720, 480), 'Desk coordinates as saved');
  assert.deepEqual(bound.bindings, [{ kind: 'view', viewId: 'egd-browser-card-3' }]);
  const again = snapshotBoardProjection(bound, {}, 2);
  assert.deepEqual(again.agenda.memberCardIds, ['egd-browser-card-3']);
  assert.deepEqual(again.cards.map(card => card.id), ['egd-browser-card-3'], 'the next save keeps the same source ids');
  assert.deepEqual(again.agenda.contextBindings, snapshot.agenda.contextBindings);
});
