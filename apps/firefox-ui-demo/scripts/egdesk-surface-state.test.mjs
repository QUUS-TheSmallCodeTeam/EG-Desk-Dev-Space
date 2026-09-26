import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSurfaceMode, planBoardProjection, snapshotBoardProjection, remapMemberReferences, recoverDeskSnapshot, canPersistDeskSession, ownedProjectionMembers, missingProjectionMembers, fitSurfaceCamera } from '../overlay/resources/EGDeskSurfaceState.sys.mjs';
import * as Chat from '../overlay/resources/EGDeskChatState.sys.mjs';
import { createDeskRecoveryStore, missingDeskRecoveryViews } from '../overlay/resources/EGDeskRecoveryState.sys.mjs';
import { createTerminalCloseController, terminalExitEvidence } from '../overlay/resources/EGDeskTerminalState.sys.mjs';

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

test('unarchived corrupt recovery cannot overwrite original bytes', () => {
  let bytes = '{broken original';
  let called = false;
  const recovery = recoverDeskSnapshot({ unreadable: true }, () => { called = true; });
  const surface = { restoring: false, recoveryProtected: recovery.protected };
  if (canPersistDeskSession(surface)) bytes = '{}';
  assert.equal(called, false);
  assert.equal(bytes, '{broken original');
  assert.equal(recovery.protected, true);
});

test('unarchived partial and refused restoration preserve the prior snapshot', () => {
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
  assert.deepEqual(Chat.buildChatRequest({ id: 'ui-a', agentProfileId: 'legacy' }, 'hello', 'request-a', runtime), { clientThreadId: 'ui-a', requestId: 'request-a', message: 'hello', profileEnabled: false });
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
  const approval = { approvalId: 'p', kind: 'commandExecution', status: 'pending', choices: ['accept', 'decline', 'cancel'], scope: 'request', networkApprovalContext: { protocol: 'https' } };
  const run = { conversationId: 'c', runId: 'r', pendingApprovals: [approval] };
  assert.equal(Chat.approvalRequestFor(run, 'p', 'accept'), null);
  assert.equal(Chat.approvalRequestFor(run, 'p', 'decline').decision, 'decline');
  assert.equal(Chat.approvalRequestFor(run, 'p', 'cancel').decision, 'cancel');
  approval.networkApprovalContext.host = 'example.test';
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

function recoveryFixture(raw) {
  const values = new Map([['current-desk', raw]]);
  const writes = [];
  let id = 0;
  const store = createDeskRecoveryStore({
    read: key => values.get(key) ?? null,
    write: (key, value) => { writes.push(key); values.set(key, value); },
    listKeys: prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
    makeId: () => String(++id), now: () => 1,
  });
  return { store, values, writes };
}

test('production recovery archives exact corrupt bytes and permits durable new work', () => {
  const original = '{ broken 한글 original\n';
  const { store, values, writes } = recoveryFixture(original);
  const result = store.recover(values.get('current-desk'), () => assert.fail('corrupt JSON must not reach restore'));
  assert.equal(result.recoveryProtected, false);
  assert.equal(store.get(result.backupKey).raw, original);
  assert.equal(values.get('current-desk'), original);
  const current = { ...structuredClone(saved), cards: [{ id: 'new-work', type: 'browser', runtimeState: { uri: 'https://new.test/' } }] };
  assert.equal(canPersistDeskSession({ restoring: false, recoveryProtected: result.recoveryProtected }), true);
  values.set('current-desk', JSON.stringify(current));
  assert.equal(store.recover(values.get('current-desk'), restored => restored.cards[0].id === 'new-work').restored, true);
  assert.equal(store.get(result.backupKey).raw, original);
  assert.equal(writes.length, 1);
});

test('production partial-restore retry adds absent views while preserving current edits and raw backup', () => {
  const original = JSON.stringify(saved);
  const { store, values } = recoveryFixture(original);
  const live = new Map([['new-work', { edited: true }]]);
  const failed = store.recover(original, snapshot => { live.set(snapshot.cards[0].id, { edited: true }); throw new Error('later view failed'); });
  assert.equal(failed.recoveryProtected, false);
  values.set('current-desk', JSON.stringify({ cards: [...live.keys()] }));
  const retry = store.recover(store.get(failed.backupKey).raw, snapshot => {
    const missing = missingDeskRecoveryViews(snapshot, [...live.keys()]);
    assert.equal(missing.cards.length, 0);
    for (const shape of missing.shapes) live.set(shape.id, shape);
    return true;
  });
  assert.equal(retry.restored, true);
  assert.deepEqual(live.get('browser'), { edited: true });
  assert.deepEqual(live.get('new-work'), { edited: true });
  assert.equal(live.has('shape'), true);
  assert.equal(store.get(failed.backupKey).raw, original);
  assert.equal(store.list().length, 1);
});

test('recovery never automatically deletes prior originals or duplicates identical backup bytes', () => {
  const { store } = recoveryFixture('broken');
  const a = store.preserve('broken', 'parse failed');
  assert.equal(store.preserve('broken', 'retry').key, a.key);
  const b = store.preserve('different broken bytes', 'another failure');
  assert.notEqual(b.key, a.key);
  assert.equal(store.get(a.key).raw, 'broken');
  assert.equal(store.list().length, 2);
});

test('failed backup verification protects the primary record instead of silently losing it', () => {
  const values = new Map([['current-desk', 'original']]);
  const store = createDeskRecoveryStore({ read: key => values.get(key) ?? null, write: () => {}, listKeys: () => [], makeId: () => 'failed-write' });
  const result = store.recover('original', () => false);
  assert.equal(result.recoveryProtected, true);
  assert.equal(values.get('current-desk'), 'original');
  assert.equal(canPersistDeskSession({ restoring: false, recoveryProtected: result.recoveryProtected }), false);
});

test('invalid restored grouping cannot poison the new working Desk before it is archived', () => {
  const broken = { ...structuredClone(saved), boardProjections: { projections: { broken: { members: null } } } };
  const { store } = recoveryFixture(JSON.stringify(broken));
  let restored = false;
  const result = store.recover(JSON.stringify(broken), () => { restored = true; return true; });
  assert.equal(restored, false);
  assert.equal(result.recoveryProtected, false);
  assert.equal(store.get(result.backupKey).raw, JSON.stringify(broken));
});

test('terminal close observes after kill acknowledgement until native exit is confirmed', async () => {
  let reads = 0;
  let kills = 0;
  const phases = [];
  const controller = createTerminalCloseController({
    requestKill: async id => { assert.equal(id, 'pty-a'); kills++; return { ok: true }; },
    readStatus: async id => { assert.equal(id, 'pty-a'); return { exited: ++reads === 3, data: '' }; },
    wait: async () => {}, onState: state => phases.push(state.phase),
  });
  assert.equal(await controller.close('pty-a'), true);
  assert.equal(kills, 1);
  assert.equal(reads, 3);
  assert.equal(controller.snapshot().evidence, 'native-exit');
  assert.equal(phases.at(-1), 'confirmed');
});

test('missing terminal registry entry is unknown, not native exit evidence; retry can later observe actual exit', async () => {
  assert.equal(terminalExitEvidence({ ok: true }), null);
  assert.equal(terminalExitEvidence({ error: 'offline', exited: true }), null);
  assert.equal(terminalExitEvidence({ error: 'Session not found', exited: true }), null);
  let receipt = false;
  const controller = createTerminalCloseController({ requestKill: async () => ({ ok: true }), readStatus: async () => receipt ? { exited: true, exitCode: 0 } : { error: 'Session not found', data: '', exited: true }, wait: async () => {} });
  assert.equal(await controller.close('pty-gone'), false);
  assert.equal(controller.snapshot().phase, 'unknown');
  receipt = true;
  assert.equal(await controller.retry(), true);
  assert.equal(controller.snapshot().evidence, 'native-exit');
});

test('terminal offline retry is bounded and re-observes the same PTY without spawning or repeating accepted kill', async () => {
  let offline = true;
  let reads = 0;
  let kills = 0;
  const controller = createTerminalCloseController({
    requestKill: async () => { kills++; return { ok: true }; },
    readStatus: async id => { assert.equal(id, 'pty-offline'); reads++; if (offline) throw new Error('network unavailable'); return { exited: true }; },
    wait: async () => {}, maxFailures: 2,
  });
  assert.equal(await controller.close('pty-offline'), false);
  assert.equal(reads, 2);
  assert.equal(controller.snapshot().phase, 'offline');
  offline = false;
  assert.equal(await controller.retry(), true);
  assert.equal(kills, 1);
  assert.equal(reads, 3);
});

test('terminal timeout does not claim closure and repeated close calls share one observation loop', async () => {
  let exited = false;
  let reads = 0;
  const controller = createTerminalCloseController({ requestKill: async () => ({ ok: true }), readStatus: async () => { reads++; return { exited }; }, wait: async () => {}, maxAttempts: 2 });
  const first = controller.close('pty-slow');
  assert.equal(controller.close('pty-slow'), first);
  assert.equal(await first, false);
  assert.equal(controller.snapshot().phase, 'timeout');
  assert.equal(reads, 2);
  exited = true;
  assert.equal(await controller.retry(), true);
});

test('Desk entry camera fits the Browser outside rail/sidebar/dock without changing its logical geometry', () => {
  const browser = { x: 0, y: 0, width: 1600, height: 960 };
  const before = { ...browser };
  const usable = { left: 100, top: 90, width: 1460, height: 780 };
  const { pan, zoom } = fitSurfaceCamera(browser, usable);
  assert.ok(pan.x >= usable.left);
  assert.ok(pan.y >= usable.top);
  assert.ok(pan.x + browser.width * zoom <= usable.left + usable.width + .001);
  assert.ok(pan.y + browser.height * zoom <= usable.top + usable.height + .001);
  assert.deepEqual(browser, before);
});

test('account reset drops all correlated data without inventing a stopped run', () => {
  const state = Chat.createChatProtocolState();
  Chat.registerChatRequest(state, { requestId: 'request-a', clientThreadId: 'ui-a' });
  Chat.reduceChatEvent(state, envelope('run.started', 1));
  Chat.reduceChatEvent(state, envelope('artifact.available', 2, artifact));
  Chat.reduceChatEvent(state, envelope('approval.required', 3, { approvalId: 'old-private-approval', kind: 'commandExecution', status: 'pending', choices: ['accept'] }));
  state.histories['conversation-a'] = { truncated: true };
  state.extraAccountCache = { private: 'old-account' };
  Chat.resetChatProtocol(state);
  assert.deepEqual(state.runs, {});
  assert.deepEqual(state.requests, {});
  assert.deepEqual(state.streams, {});
  assert.deepEqual(state.histories, {});
  assert.equal(state.connection, 'offline');
  assert.equal(state.unobservedPreviousRun, true);
  assert.equal(JSON.stringify(state).includes('old-private-approval'), false);
  assert.equal(JSON.stringify(state).includes('/tmp/existing.txt'), false);
  assert.equal(state.extraAccountCache, undefined);
  assert.equal(Chat.canAdmitChatEvent(state, [{ id: 'ui-a', conversationId: null }], envelope('run.started', 4)), false);
});

test('account epoch aborts refresh and rejects late fixture responses after reset', async () => {
  const state = Chat.createChatProtocolState();
  const scope = Chat.createChatEpochScope();
  const token = scope.begin();
  const oldStreamEpoch = scope.current();
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const work = (async () => {
    const snapshot = await response;
    if (scope.valid(token)) Chat.mergeChatSnapshot(state, snapshot, 'old-ui');
  })();
  scope.reset();
  Chat.resetChatProtocol(state);
  finish({ conversationId: 'old-account', streamId: 'old-stream', seq: 9, runs: [{ runId: 'old-turn', messages: [], artifacts: [artifact] }] });
  await work;
  assert.equal(token.signal.aborted, true);
  assert.equal(scope.valid(oldStreamEpoch), false);
  assert.deepEqual(state.runs, {});
  assert.equal(scope.valid(scope.begin()), true);
});

test('account read failure is not an account-reset identity signal', () => {
  const known = { isLoggedIn: true, accountId: 'account-a', authMode: 'chatgpt' };
  assert.equal(Chat.codexAccountKey(known), 'codex:chatgpt:account-a');
  assert.equal(Chat.codexAccountKey({ isLoggedIn: false, statusText: 'lookup failed' }), null);
  assert.notEqual(Chat.codexAccountKey({ ...known, accountId: 'account-b' }), Chat.codexAccountKey(known));
});

test('explicit 503 rejection releases pending state; ambiguous network and resume-required replies do not claim rejection', () => {
  assert.equal(Chat.submissionFailureStatus({ accepted: false, status: 503, code: 'BRIDGE_OFFLINE' }), 'failed');
  assert.equal(Chat.submissionFailureStatus({ accepted: false, status: 500, resumeRequired: true }), 'unconfirmed');
  assert.equal(Chat.submissionFailureStatus(new Error('network failure')), 'unconfirmed');
  assert.equal(Chat.submissionFailureStatus({ status: 403 }), 'failed');
});

test('successful explicit full-history reconciliation releases uncertainty without claiming acceptance or stop', () => {
  const state = Chat.createChatProtocolState();
  state.requests.q = { requestId: 'q', clientThreadId: 'ui-a', status: 'unconfirmed' };
  assert.equal(Chat.settleReconciledRequests(state, 'ui-a', { historyComplete: false, truncated: true }), 0);
  assert.equal(state.requests.q.status, 'unconfirmed');
  assert.equal(Chat.settleReconciledRequests(state, 'ui-a', { historyComplete: true, truncated: false }), 1);
  assert.equal(state.requests.q.status, 'reconciled');
  assert.deepEqual(state.runs, {});
});

test('hydrated complete status is not item completion proof: live deltas continue until completionConfirmed', () => {
  const state = Chat.createChatProtocolState();
  const snapshot = { conversationId: 'conversation-a', streamId: 'stream-a', seq: 1, connection: 'ready', runs: [{ runId: 'turn-a', status: 'inProgress', messages: [{ id: 'm', role: 'assistant', text: 'part ', status: 'complete', completionConfirmed: false }] }] };
  const [run] = Chat.mergeChatSnapshot(state, snapshot, 'ui-a');
  Chat.reduceChatEvent(state, envelope('message.delta', 2, { messageId: 'm', delta: 'two' }));
  assert.equal(run.messages[0].content, 'part two');
  assert.equal(run.messages[0].status, 'streaming');
  Chat.reduceChatEvent(state, envelope('run.completed', 3, { status: 'completed' }));
  assert.notEqual(run.messages[0].completionConfirmed, true);
  Chat.reduceChatEvent(state, envelope('message.completed', 4, { messageId: 'm', text: 'authoritative complete' }));
  Chat.reduceChatEvent(state, envelope('message.delta', 5, { messageId: 'm', delta: 'ignored late delta' }));
  assert.equal(run.messages[0].content, 'authoritative complete');
  assert.equal(run.messages[0].completionConfirmed, true);
});

test('history completeness flags survive snapshots and stale snapshots cannot hide truncation', () => {
  const state = Chat.createChatProtocolState();
  Chat.mergeChatSnapshot(state, { conversationId: 'c', streamId: 's', seq: 5, truncated: true, historyComplete: false, runs: [{ runId: 'r', status: 'inProgress', messages: [], truncated: true, historyComplete: false }] }, 'ui');
  Chat.mergeChatSnapshot(state, { conversationId: 'c', streamId: 's', seq: 3, truncated: false, historyComplete: true, runs: [] }, 'ui');
  assert.equal(state.histories.c.truncated, true);
  assert.equal(state.histories.c.historyComplete, false);
  assert.equal(state.runs['c/r'].truncated, true);
  Chat.mergeChatSnapshot(state, { conversationId: 'c', streamId: 's', seq: 6, truncated: false, historyComplete: true, runs: [{ runId: 'r', truncated: false, historyComplete: true }] }, 'ui');
  assert.equal(state.histories.c.historyComplete, true);
  assert.equal(state.runs['c/r'].truncated, false);
});

test('final network approval contract honors null/disabled scope and public host/protocol', () => {
  const approval = { approvalId: 'p', kind: 'commandExecution', status: 'pending', choices: ['accept', 'decline'], scope: 'request', networkApprovalContext: null, acceptDisabledReason: 'Network target missing' };
  const run = { conversationId: 'c', runId: 'r', pendingApprovals: [approval] };
  assert.equal(Chat.approvalRequestFor(run, 'p', 'accept'), null);
  assert.equal(Chat.approvalRequestFor(run, 'p', 'decline').decision, 'decline');
  delete approval.acceptDisabledReason;
  approval.networkApprovalContext = { host: 'example.test', protocol: 'https' };
  assert.equal(Chat.approvalRequestFor(run, 'p', 'accept').decision, 'accept');
});

test('profile-on to ordinary Codex explicitly sends false on the same conversation', () => {
  const thread = { id: 'ui', conversationId: 'native-thread', profileEnabled: true };
  const persona = { agentProfile: { id: 'chosen' }, systemPrompt: 'chosen instruction', toolMode: 'custom' };
  const on = Chat.buildChatRequest(thread, 'first', 'request-on', persona);
  thread.profileEnabled = false;
  const off = Chat.buildChatRequest(thread, 'next', 'request-off', persona);
  assert.equal(on.profileEnabled, true);
  assert.equal(off.profileEnabled, false);
  assert.equal(off.conversationId, on.conversationId);
  assert.deepEqual(Object.keys(off).sort(), ['clientThreadId', 'conversationId', 'message', 'profileEnabled', 'requestId'].sort());
});

test('account reset rotates only the wire binding, avoiding a retained backend client-to-CID mapping', () => {
  const thread = { id: 'local-room', title: 'User title', conversationId: 'old-native' };
  const registeredBackend = new Map([[Chat.clientThreadBinding(thread), 'old-native']]);
  const reset = { ...thread, conversationId: null, clientBindingId: Chat.freshClientThreadBinding(thread, 'next-account-generation') };
  const request = Chat.buildChatRequest(reset, 'new request', 'new-request');
  assert.equal(reset.id, thread.id);
  assert.equal(reset.title, thread.title);
  assert.notEqual(request.clientThreadId, thread.id);
  assert.equal(registeredBackend.get(request.clientThreadId), undefined);
  assert.equal(request.conversationId, undefined);
  const state = Chat.createChatProtocolState();
  assert.equal(Chat.canAdmitChatEvent(state, [reset], { conversationId: 'old-native', clientThreadId: thread.id }), false);
});

test('fresh wire IDs still correlate SSE-before-HTTP to the stable local room and reject old-binding events', () => {
  const thread = { id: 'ui-a', clientBindingId: 'new-binding', conversationId: null };
  const state = Chat.createChatProtocolState();
  Chat.registerChatRequest(state, { requestId: 'request-a', clientThreadId: 'new-binding', localThreadId: 'ui-a' });
  const next = envelope('run.started', 1, {}, { clientThreadId: 'new-binding' });
  assert.equal(Chat.canAdmitChatEvent(state, [thread], next), true);
  assert.equal(Chat.canAdmitChatEvent(state, [thread], { ...next, clientThreadId: 'old-binding' }), false);
  const run = Chat.reduceChatEvent(state, next);
  assert.equal(run.clientThreadId, 'new-binding');
  assert.equal(run.localThreadId, 'ui-a');
  assert.equal(Chat.runsForThread(state, thread)[0], run);
  assert.deepEqual(Chat.runsForThread(state, null), []);
});
