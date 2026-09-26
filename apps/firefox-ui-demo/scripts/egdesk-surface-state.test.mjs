import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSurfaceMode, planBoardProjection, snapshotBoardProjection, remapMemberReferences, recoverDeskSnapshot, canPersistDeskSession, ownedProjectionMembers, missingProjectionMembers } from '../overlay/resources/EGDeskSurfaceState.sys.mjs';
import * as Chat from '../overlay/resources/EGDeskChatState.sys.mjs';

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

const envelope = (event, seq, details = {}, identity = {}) => ({
  type: 'chat.event', v: 2, provider: 'codex', event, streamId: 'stream-a', seq, ts: 1,
  requestId: 'request-a', clientThreadId: 'ui-a', conversationId: 'conversation-a', runId: 'turn-a', answerId: 'conversation-a/turn-a', details, ...identity,
});
const artifact = { id: 'file-a', type: 'file', target: { path: '/tmp/existing.txt' }, label: '참조', status: 'available', relation: 'referenced', verifiedAt: 1, conversationId: 'conversation-a', runId: 'turn-a', answerId: 'conversation-a/turn-a', sourceItemId: 'assistant-a' };

test('ordinary Codex omits persona fields even if legacy defaults remain on the thread', () => {
  const runtime = { agentProfile: { id: 'persona' }, systemPrompt: 'persona instruction', toolMode: 'custom' };
  assert.deepEqual(Chat.buildChatRequest({ id: 'ui-a', agentProfileId: 'legacy' }, 'hello', 'request-a', runtime), { clientThreadId: 'ui-a', requestId: 'request-a', message: 'hello' });
  const selected = Chat.buildChatRequest({ id: 'ui-a', profileEnabled: true }, 'hello', 'r2', runtime);
  assert.equal(selected.profileEnabled, true);
  assert.equal(selected.systemPrompt, 'persona instruction');
});

test('SSE preceding HTTP is merged into the accepted actual turn, without losing final state', () => {
  const state = Chat.createChatProtocolState();
  Chat.registerChatRequest(state, { requestId: 'request-a', clientThreadId: 'ui-a' });
  Chat.reduceChatEvent(state, envelope('run.started', 1));
  Chat.reduceChatEvent(state, envelope('message.delta', 2, { messageId: 'assistant-a', delta: 'actual ' }));
  Chat.reduceChatEvent(state, envelope('message.started', 3, { messageId: 'assistant-a', text: '' }));
  Chat.reduceChatEvent(state, envelope('message.completed', 4, { messageId: 'assistant-a', text: 'actual answer', phase: 'final_answer' }));
  const run = Object.values(state.runs)[0];
  assert.equal(Chat.isRunBusy(run), true);
  Chat.reduceChatEvent(state, envelope('run.completed', 5, { status: 'completed' }));
  Chat.acceptChatRequest(state, { accepted: true, conversationId: 'conversation-a', runId: 'turn-a', answerId: run.answerId }, 'request-a');
  assert.equal(Object.keys(state.runs).length, 1);
  assert.equal(run.messages[0].content, 'actual answer');
  assert.equal(run.status, 'completed');
  assert.equal(state.requests['request-a'].status, 'accepted');
});

test('duplicate events and completed native items do not duplicate text', () => {
  const state = Chat.createChatProtocolState();
  const delta = envelope('message.delta', 1, { messageId: 'm', delta: 'hello' });
  Chat.reduceChatEvent(state, delta);
  assert.equal(Chat.reduceChatEvent(state, delta), null);
  Chat.reduceChatEvent(state, envelope('message.completed', 2, { messageId: 'm', text: 'hello' }));
  Chat.reduceChatEvent(state, envelope('message.completed', 3, { messageId: 'm', text: 'hello' }));
  assert.equal(Object.values(state.runs)[0].messages.length, 1);
  assert.equal(Object.values(state.runs)[0].messages[0].content, 'hello');
});

test('only interrupted run completion confirms stop; runtime loss is offline/failed', () => {
  const state = Chat.createChatProtocolState();
  const run = Chat.reduceChatEvent(state, envelope('run.started', 1));
  Chat.reduceChatEvent(state, envelope('run.stop_requested', 2));
  assert.equal(run.status, 'stopping');
  assert.equal(Chat.isRunBusy(run), true);
  Chat.reduceChatEvent(state, envelope('run.unavailable', 3, { error: { code: 'RUNTIME_LOST' } }));
  assert.equal(run.status, 'failed');
  assert.equal(state.connection, 'offline');
  Chat.reduceChatEvent(state, envelope('run.completed', 4, { status: 'interrupted' }));
  assert.equal(run.status, 'interrupted');
  assert.equal(Chat.isRunBusy(run), false);
});

test('conversation snapshots do not suppress events for other conversations in the same stream', () => {
  const state = Chat.createChatProtocolState();
  Chat.mergeChatSnapshot(state, { conversationId: 'conversation-a', streamId: 'stream-a', seq: 10, connection: 'ready', runs: [] }, 'ui-a');
  const run = Chat.reduceChatEvent(state, envelope('message.delta', 9, { messageId: 'b', delta: 'other' }, { conversationId: 'conversation-b', runId: 'turn-b', clientThreadId: 'ui-b' }));
  assert.equal(run.messages[0].content, 'other');
  assert.equal(Chat.runsForThread(state, { id: 'ui-a', conversationId: 'conversation-a' }).length, 0);
});

test('stale snapshots and responses from a prior stream cannot regress live text or run status', () => {
  const state = Chat.createChatProtocolState();
  const run = Chat.reduceChatEvent(state, envelope('message.delta', 5, { messageId: 'm', delta: 'newer' }));
  Chat.mergeChatSnapshot(state, { conversationId: run.conversationId, streamId: 'stream-a', seq: 2, connection: 'ready', runs: [{ runId: run.runId, status: 'inProgress', messages: [{ id: 'm', text: 'old' }] }] }, 'ui-a');
  assert.equal(run.messages[0].content, 'newer');
  Chat.reduceChatEvent(state, envelope('run.completed', 1, { status: 'completed' }, { streamId: 'stream-b' }));
  Chat.mergeChatSnapshot(state, { conversationId: run.conversationId, streamId: 'stream-a', seq: 99, connection: 'offline', runs: [{ runId: run.runId, status: 'inProgress', messages: [] }] }, 'ui-a');
  assert.equal(run.status, 'completed');
});

test('only verified explicit artifacts produce chips; authoritative empty lists remove stale references', () => {
  const state = Chat.createChatProtocolState();
  const run = Chat.reduceChatEvent(state, envelope('message.completed', 1, { messageId: 'm', text: 'file /tmp/inferred.txt [report]' }));
  assert.deepEqual(run.artifacts, []);
  Chat.reduceChatEvent(state, envelope('artifact.available', 2, { artifacts: [artifact, { id: 'fake', label: 'file' }] }));
  assert.equal(run.artifacts.length, 1);
  Chat.reduceChatEvent(state, envelope('artifact.available', 3, { artifacts: [] }));
  assert.equal(run.artifacts.length, 1);
  Chat.mergeChatSnapshot(state, { conversationId: run.conversationId, streamId: 'stream-a', seq: 4, connection: 'ready', runs: [{ runId: run.runId, messages: [], artifacts: [] }] }, 'ui-a');
  assert.deepEqual(run.artifacts, []);
});

test('native user IDs hydrate optimistic messages once using request/turn/role order', () => {
  const run = { conversationId: 'c', runId: 'r', requestId: 'q', answerId: 'c/r', messages: [{ id: 'native-u', role: 'user', text: 'original prompt', status: 'complete' }, { id: 'native-a', role: 'assistant', text: 'EGDESK_BRIDGE_OK', phase: 'final_answer', status: 'complete' }], artifacts: [] };
  const optimistic = [{ id: 'local-u', requestId: 'q', role: 'user', content: 'original prompt', createdAt: 42 }];
  const once = Chat.projectRunMessages(optimistic, run, 100);
  const twice = Chat.projectRunMessages(once, run, 200);
  assert.equal(twice.length, 2);
  assert.equal(twice[0].id, 'local-u');
  assert.equal(twice[0].providerItemId, 'native-u');
  assert.equal(twice[0].createdAt, 42);
  assert.equal(twice[1].content, 'EGDESK_BRIDGE_OK');
  const another = Chat.projectRunMessages(twice, { ...run, requestId: null, runId: 'r2', answerId: 'c/r2', messages: [{ id: 'native-u2', role: 'user', text: 'original prompt' }] });
  assert.equal(another.filter(message => message.role === 'user').length, 2);
  assert.equal(another[0].runId, 'r');
});

test('activities and approval proposals remain outside the transcript and artifact list', () => {
  const state = Chat.createChatProtocolState();
  const run = Chat.reduceChatEvent(state, envelope('activity.started', 1, { id: 'act', kind: 'commandExecution', title: 'actual command', status: 'inProgress' }));
  Chat.reduceChatEvent(state, envelope('approval.required', 2, { approvalId: 'approval-a', status: 'pending', choices: ['decline'], paths: ['/tmp/proposed.txt'] }));
  assert.deepEqual(run.messages, []);
  assert.deepEqual(run.artifacts, []);
  assert.deepEqual(run.pendingApprovals[0].choices, ['decline']);
  Chat.reduceChatEvent(state, envelope('approval.resolved', 3, { approvalId: 'approval-a' }));
  assert.deepEqual(run.pendingApprovals, []);
  assert.equal(Chat.isRunBusy(run), true);
});

test('approval choices bind the exact run and replySent does not complete execution', () => {
  const run = { conversationId: 'c', runId: 'r', status: 'inProgress', pendingApprovals: [{ approvalId: 'p', kind: 'commandExecution', status: 'pending', choices: ['accept', 'decline'] }] };
  assert.deepEqual(Chat.approvalRequestFor(run, 'p', 'accept'), { approvalId: 'p', conversationId: 'c', runId: 'r', decision: 'accept' });
  assert.equal(Chat.approvalRequestFor(run, 'p', 'cancel'), null);
  assert.equal(Chat.acknowledgeApprovalReply(run, { accepted: true, approvalId: 'p', conversationId: 'other', runId: 'r', status: 'replySent' }), false);
  assert.equal(Chat.acknowledgeApprovalReply(run, { accepted: true, approvalId: 'p', conversationId: 'c', runId: 'r', status: 'replySent' }), true);
  assert.equal(Chat.approvalRequestFor(run, 'p', 'accept'), null);
  assert.equal(Chat.isRunBusy(run), true);
  run.pendingApprovals = [];
  Chat.acknowledgeApprovalReply(run, { accepted: true, approvalId: 'p', conversationId: 'c', runId: 'r', status: 'replySent' });
  assert.deepEqual(run.pendingApprovals, []);
});

test('unknown network scope blocks only accept and leaves explicit denial available', () => {
  const approval = { approvalId: 'p', kind: 'commandExecution', status: 'pending', choices: ['accept', 'decline', 'cancel'], networkContext: { protocol: 'https' } };
  const run = { conversationId: 'c', runId: 'r', pendingApprovals: [approval] };
  assert.equal(Chat.approvalRequestFor(run, 'p', 'accept'), null);
  assert.equal(Chat.approvalRequestFor(run, 'p', 'decline').decision, 'decline');
  assert.equal(Chat.approvalRequestFor(run, 'p', 'cancel').decision, 'cancel');
  approval.networkContext.host = 'example.test';
  assert.equal(Chat.approvalRequestFor(run, 'p', 'accept').decision, 'accept');
  approval.stale = true;
  assert.equal(Chat.approvalRequestFor(run, 'p', 'decline'), null);
});

test('profile selection affects new requests, not the author of an existing answer', () => {
  const run = { requestId: 'q', conversationId: 'c', runId: 'r', answerId: 'c/r', authorName: 'Selected Agent', messages: [{ id: 'a', role: 'assistant', text: 'actual answer' }], artifacts: [] };
  const first = Chat.projectRunMessages([], run);
  const restored = Chat.projectRunMessages(first, { ...run, authorName: 'Codex' });
  assert.equal(restored[0].authorName, 'Selected Agent');
  assert.equal(Chat.buildChatRequest({ id: 'ui', profileEnabled: false }, 'next', 'q2', { systemPrompt: 'old' }).systemPrompt, undefined);
});

test('a nonterminal unsupported interaction leaves the run stoppable', () => {
  const state = Chat.createChatProtocolState();
  const run = Chat.reduceChatEvent(state, envelope('run.started', 1));
  Chat.reduceChatEvent(state, envelope('run.unavailable', 2, { status: 'inProgress', error: { code: 'UNSUPPORTED_INTERACTION' } }));
  assert.equal(Chat.isRunBusy(run), true);
  assert.notEqual(run.status, 'interrupted');
});
