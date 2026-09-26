import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSurfaceMode, planBoardProjection, snapshotBoardProjection, remapMemberReferences, recoverDeskSnapshot, canPersistDeskSession, ownedProjectionMembers, missingProjectionMembers } from '../overlay/resources/EGDeskSurfaceState.sys.mjs';

test('onboarding considers lifecycle and independent Desk state, not just Board absence', () => {
  assert.equal(initialSurfaceMode({}), 'browser');
  assert.equal(initialSurfaceMode({ lifecycle: { mode: 'desk' } }), 'desk');
  assert.equal(initialSurfaceMode({ deskSession: { cards: [] } }), 'desk');
  assert.equal(initialSurfaceMode({ legacyStore: { agendas: {} } }), 'desk');
  assert.equal(initialSurfaceMode({ legacyStore: { unreadable: true } }), 'desk');
  assert.equal(initialSurfaceMode({ lifecycle: { unreadable: true } }), 'desk');
  assert.equal(initialSurfaceMode({ lifecycle: { mode: 'browser' }, deskSession: {} }), 'browser');
});

const saved = {
  version: 1, savedAt: 1,
  agenda: { id: 'agenda-compatible', title: 'A', memberCardIds: ['browser', 'missing'], contextBindings: [{ cardId: 'browser', targetCardId: 'missing', resourceId: 'original-resource', nested: { viewIds: ['browser'] } }] },
  cards: [{ id: 'browser', type: 'browser', geometry: { x: 40, y: 80, width: 720, height: 500 }, sourceRef: { uri: 'https://example.test/' }, runtimeState: { uri: 'https://example.test/' } }],
  shapes: [{ id: 'shape', type: 'rect', geometry: { x: 1, y: 2 } }],
};

test('independent projections remap view references, retaining source and missing membership', () => {
  const original = structuredClone(saved);
  const first = planBoardProjection(saved, 'projection-a');
  const second = planBoardProjection(saved, 'projection-b');
  assert.notEqual(first.members[0].viewId, second.members[0].viewId);
  assert.equal(first.bindings[0].cardId, first.idMap.browser);
  assert.equal(first.bindings[0].targetCardId, first.idMap.missing);
  assert.equal(first.bindings[0].resourceId, 'original-resource');
  assert.equal(first.members.find(m => m.sourceId === 'missing').record.type, 'missing');
  assert.deepEqual(saved, original);
});

test('saving A cannot collect B or independent Canvas cards, and does not lose missing references', () => {
  const projection = planBoardProjection(saved, 'projection-a');
  const snapshot = snapshotBoardProjection(projection, {
    [projection.idMap.browser]: { ...saved.cards[0], id: projection.idMap.browser, runtimeState: { uri: 'https://changed.test/' } },
    'projection-b-member-0': { id: 'unrelated', type: 'browser' },
    'free-card': { id: 'free-card', type: 'browser' },
  }, 123);
  assert.deepEqual(snapshot.cards.map(c => c.id), ['browser', 'missing']);
  assert.deepEqual(snapshot.shapes.map(c => c.id), ['shape']);
  assert.deepEqual(snapshot.agenda.contextBindings, saved.agenda.contextBindings);
  assert.equal(snapshot.cards[0].runtimeState.uri, 'https://changed.test/');
  assert.equal(snapshot.agenda.id, 'agenda-compatible');
  assert.equal(snapshot.savedAt, 123);
  assert.equal(saved.savedAt, 1);
});

test('binding remapping never rewrites opaque IDs, object keys, labels or URLs', () => {
  const binding = { cardId: 'a', resourceId: 'p-member-0', label: 'a', url: 'a', a: 'a', nested: { targetViewId: 'a', externalId: 'a', viewIds: ['a'] } };
  const projected = remapMemberReferences(binding, { a: 'p-member-0' });
  assert.equal(projected.cardId, 'p-member-0');
  assert.equal(projected.resourceId, 'p-member-0');
  assert.equal(projected.label, 'a');
  assert.equal(projected.a, 'a');
  assert.equal(projected.nested.externalId, 'a');
  assert.deepEqual(remapMemberReferences(projected, { 'p-member-0': 'a' }), binding);
});

test('corrupt recovery stays protected and cannot overwrite original bytes', () => {
  let bytes = '{broken original';
  let called = false;
  const recovery = recoverDeskSnapshot({ unreadable: true }, () => { called = true; });
  const surface = { restoring: false, recoveryProtected: recovery.protected };
  if (canPersistDeskSession(surface)) bytes = '{}';
  assert.equal(called, false);
  assert.equal(bytes, '{broken original');
  assert.equal(recovery.protected, true);
});

test('partial and refused restoration preserve the prior snapshot and inhibit later saves', () => {
  const bytes = JSON.stringify(saved);
  for (const restore of [() => false, () => { throw new Error('second member failed'); }]) {
    let stored = bytes;
    const recovery = recoverDeskSnapshot(JSON.parse(stored), restore);
    if (canPersistDeskSession({ restoring: false, recoveryProtected: recovery.protected })) stored = '{"cards":[]}';
    assert.equal(stored, bytes);
    assert.equal(recovery.restored, false);
  }
});

test('a successful restore or a genuinely empty profile permits Desk persistence', () => {
  for (const snapshot of [null, saved]) {
    const result = recoverDeskSnapshot(snapshot, () => true);
    assert.equal(canPersistDeskSession({ restoring: false, recoveryProtected: result.protected }), true);
  }
  assert.equal(canPersistDeskSession({ restoring: true, recoveryProtected: false }), false);
});

test('reopening recovers only absent members and closing only targets owned views', () => {
  const projection = planBoardProjection(saved, 'p');
  const alive = projection.members[0].viewId;
  assert.deepEqual(missingProjectionMembers(projection, [alive]).map(m => m.viewId), projection.members.slice(1).map(m => m.viewId));
  assert.deepEqual(ownedProjectionMembers(projection, { [alive]: 'p', [projection.members[1].viewId]: 'another-board', unrelated: 'p' }), [alive]);
  assert.equal(saved.agenda.id, 'agenda-compatible');
});
