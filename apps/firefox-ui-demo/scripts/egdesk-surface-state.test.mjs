import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { initialSurfaceMode, planBoardProjection, snapshotBoardProjection, remapMemberReferences, recoverDeskSnapshot, canPersistDeskSession, ownedProjectionMembers, missingProjectionMembers, fitSurfaceCamera } from '../overlay/resources/EGDeskSurfaceState.sys.mjs';
import * as Chat from '../overlay/resources/EGDeskChatState.sys.mjs';
import * as Markdown from '../overlay/resources/EGDeskMarkdown.sys.mjs';
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs';
import * as Briefing from '../overlay/resources/EGDeskBriefingState.sys.mjs';
import * as FileCard from '../overlay/resources/EGDeskFileCardState.sys.mjs';
import { createEGDeskFileServiceCallbacks, createEGDeskNativeFilePickers } from '../overlay/resources/EGDeskFileView.sys.mjs';
import { createDeskRecoveryStore, missingDeskRecoveryViews } from '../overlay/resources/EGDeskRecoveryState.sys.mjs';
import { createTerminalCloseController, terminalExitEvidence, terminalResponsePacket } from '../overlay/resources/EGDeskTerminalState.sys.mjs';

// Exercise the actual production runtime-config body, without executing the
// Firefox overlay bootstrap, DOM handlers, bridge requests, or runtime code.
const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const runtimeConfigBody = surfaceSource.match(/  function codexThreadRuntimeConfig\(thread\) \{([\s\S]*?)\n  \}/)?.[1];
assert.ok(runtimeConfigBody, 'production codexThreadRuntimeConfig must remain directly testable');
const productionRuntimeConfig = compileFunction(runtimeConfigBody, ['thread', 'codexThreadAgentProfile', 'codexThreadToolMode', 'codexThreadSystemPrompt']);
const runtimeFor = thread => productionRuntimeConfig(thread,
  () => ({ id: 'test-profile', label: 'Test', name: 'Test', capabilities: [], cwd: '/not-a-thread-default' }),
  () => 'test-tools', () => 'test instruction');

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

const terminalAck = () => terminalResponsePacket({ ok: true, status: 'STOP_REQUESTED', stopRequested: true, exited: false, exitConfirmed: false }, 200);
const terminalReceipt = (sessionId, extra = {}) => terminalResponsePacket({ status: 'EXITED', exited: true, exitConfirmed: true, sessionId, exitCode: 0, signal: null, exitedAt: 123, exitSource: 'process.exit', ...extra }, 200);
const terminalRunning = () => terminalResponsePacket({ data: '', exited: false, exitConfirmed: false }, 200);

test('terminal close observes after kill acknowledgement until native exit is confirmed', async () => {
  let reads = 0;
  let kills = 0;
  const phases = [];
  const controller = createTerminalCloseController({
    requestKill: async id => { assert.equal(id, 'pty-a'); kills++; return terminalAck(); },
    readStatus: async id => { assert.equal(id, 'pty-a'); return ++reads === 3 ? terminalReceipt(id) : terminalRunning(); },
    wait: async () => {}, onState: state => phases.push(state.phase),
  });
  assert.equal(await controller.close('pty-a'), true);
  assert.equal(kills, 1);
  assert.equal(reads, 3);
  assert.equal(controller.snapshot().evidence, 'native-exit');
  assert.equal(phases.at(-1), 'confirmed');
});

test('missing terminal registry entry is unknown, not native exit evidence; retry can later observe actual exit', async () => {
  assert.equal(terminalExitEvidence({ ok: true }, 'pty-gone'), null);
  assert.equal(terminalExitEvidence({ error: 'offline', exited: true }, 'pty-gone'), null);
  assert.equal(terminalExitEvidence({ error: 'Session not found', exited: true }, 'pty-gone'), null);
  let receipt = false;
  const controller = createTerminalCloseController({ requestKill: async () => terminalAck(), readStatus: async id => receipt ? terminalReceipt(id) : terminalResponsePacket({ status: 'UNKNOWN', code: 'UNKNOWN_SESSION', exited: null, exitConfirmed: false }, 404), wait: async () => {} });
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
    requestKill: async () => { kills++; return terminalAck(); },
    readStatus: async id => { assert.equal(id, 'pty-offline'); reads++; if (offline) throw new Error('network unavailable'); return terminalReceipt(id); },
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
  const controller = createTerminalCloseController({ requestKill: async () => terminalAck(), readStatus: async id => { reads++; return exited ? terminalReceipt(id) : terminalRunning(); }, wait: async () => {}, maxAttempts: 2 });
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

test('terminal exit proof requires the same session, native confirmation and HTTP 200 independently of body status', () => {
  const receipt = terminalReceipt('pty-proof');
  assert.equal(receipt.status, 'EXITED');
  assert.equal(receipt.httpStatus, 200);
  assert.equal(terminalExitEvidence(receipt, 'pty-proof'), 'native-exit');
  for (const invalid of [
    { exited: true },
    { ...receipt, sessionId: 'another-pty' },
    { ...receipt, exitConfirmed: false },
    { ...receipt, exitConfirmed: undefined },
    { ...receipt, httpStatus: 500 },
    { ...receipt, httpStatus: 404 },
    { ...receipt, status: 'UNKNOWN' },
    { ...receipt, status: 'STOP_REQUESTED' },
    terminalAck(),
  ]) assert.equal(terminalExitEvidence(invalid, 'pty-proof'), null);
});

test('kill can return an already-observed exit receipt and finish without another read', async () => {
  const receipt = terminalReceipt('pty-exited', { signal: 'SIGTERM', exitSource: 'pty.onExit' });
  const controller = createTerminalCloseController({ requestKill: async () => receipt, readStatus: async () => assert.fail('exit receipt already proves termination'), wait: async () => {} });
  assert.equal(await controller.close('pty-exited'), true);
  assert.deepEqual(controller.snapshot().receipt, receipt);
  assert.equal(controller.snapshot().lastKillResponse.status, 'EXITED');
  assert.equal(controller.snapshot().lastKillResponse.httpStatus, 200);
});

test('KILL_FAILED and live read output retain response fields and never imply stopped', async () => {
  const output = [];
  const controller = createTerminalCloseController({
    requestKill: async () => terminalResponsePacket({ ok: false, code: 'KILL_FAILED' }, 500),
    readStatus: async () => terminalResponsePacket({ status: 'RUNNING', sessionId: 'pty-live', data: 'still running', exited: false, exitConfirmed: false, truncated: true }, 200),
    onOutput: data => output.push(data), wait: async () => {}, maxAttempts: 2,
  });
  assert.equal(await controller.close('pty-live'), false);
  assert.equal(controller.snapshot().phase, 'timeout');
  assert.equal(controller.snapshot().killAccepted, false);
  assert.equal(controller.snapshot().lastKillResponse.code, 'KILL_FAILED');
  assert.equal(controller.snapshot().lastKillResponse.httpStatus, 500);
  assert.equal(controller.snapshot().lastResponse.status, 'RUNNING');
  assert.equal(controller.snapshot().lastResponse.truncated, true);
  assert.deepEqual(output, ['still running', 'still running']);
});

test('an in-flight close for one PTY cannot confirm a different session', async () => {
  const controller = createTerminalCloseController({ requestKill: async id => terminalReceipt(id), readStatus: async () => assert.fail('already exited'), wait: async () => {} });
  const first = controller.close('pty-first');
  assert.equal(await controller.close('pty-other'), false);
  assert.equal(await first, true);
  assert.equal(controller.snapshot().receipt.sessionId, 'pty-first');
});

test('legacy provider-marker IDs cannot hide an A-to-B email account change', () => {
  for (const accountId of ['chatgpt', 'ChatGPT', 'apikey', 'API_KEY', 'api-key', 'codex', 'openai']) {
    const accountA = { isLoggedIn: true, provider: 'codex', authMode: 'chatgpt', accountId, accountEmail: 'a@example.test' };
    const accountB = { ...accountA, accountEmail: 'b@example.test' };
    assert.equal(Chat.codexAccountKey(accountA), 'codex:chatgpt:a@example.test');
    assert.equal(Chat.codexAccountChanged(Chat.codexAccountKey(accountA), accountB), true);
  }
  const providerMarker = { isLoggedIn: true, provider: 'provider-marker', authMode: 'mode-marker', accountEmail: 'a@example.test' };
  assert.equal(Chat.codexAccountKey({ ...providerMarker, accountId: 'provider-marker' }), 'codex:mode-marker:a@example.test');
  assert.equal(Chat.codexAccountKey({ ...providerMarker, accountId: 'mode-marker' }), 'codex:mode-marker:a@example.test');
});

test('typed null account ID falls back to email while a real ID retains precedence', () => {
  const accountA = { isLoggedIn: true, authMode: 'chatgpt', accountId: null, accountEmail: 'a@example.test' };
  assert.equal(Chat.codexAccountChanged(Chat.codexAccountKey(accountA), { ...accountA, accountEmail: 'b@example.test' }), true);
  assert.equal(Chat.codexAccountChanged(Chat.codexAccountKey(accountA), { ...accountA, accountEmail: ' A@EXAMPLE.TEST ' }), false);
  const realId = { ...accountA, accountId: 'native-account-id' };
  assert.equal(Chat.codexAccountKey(realId), 'codex:chatgpt:native-account-id');
  assert.equal(Chat.codexAccountChanged(Chat.codexAccountKey(realId), { ...realId, accountEmail: 'changed-email@example.test' }), false);
});

test('unknown identity and transient account lookup failure do not manufacture identity or trigger reset', () => {
  const knownKey = 'codex:chatgpt:a@example.test';
  const unknown = { isLoggedIn: true, authMode: 'chatgpt', accountId: 'chatgpt', accountEmail: null };
  assert.equal(Chat.codexAccountKey(unknown), null);
  assert.equal(Chat.codexAccountChanged(knownKey, unknown), false);
  assert.equal(Chat.codexAccountChanged(knownKey, { isLoggedIn: false, accountId: 'chatgpt', accountEmail: 'b@example.test', statusText: 'lookup failed' }), false);
  assert.equal(Chat.codexAccountChanged('codex:chatgpt:chatgpt', { ...unknown, accountEmail: 'a@example.test' }), false);
});

test('public known identity contract supports real ID and email basis without provider-marker identity', () => {
  const emailIdentity = { isLoggedIn: true, authMode: 'chatgpt', accountId: null, accountEmail: 'a@example.test', identityStatus: 'known', identityBasis: 'email' };
  assert.equal(Chat.codexAccountKey(emailIdentity), 'codex:chatgpt:a@example.test');
  const idIdentity = { ...emailIdentity, accountId: 'real-account-a', identityBasis: 'accountId' };
  assert.equal(Chat.codexAccountKey(idIdentity), 'codex:chatgpt:real-account-a');
});

test('explicit unknown identity cannot reset an account even if stale identity fields remain', () => {
  const unknown = { isLoggedIn: true, authMode: 'chatgpt', accountId: 'stale-account-b', accountEmail: 'b@example.test', identityStatus: 'unknown', identityBasis: null };
  assert.equal(Chat.codexAccountKey(unknown), null);
  assert.equal(Chat.codexAccountChanged('codex:chatgpt:real-account-a', unknown), false);
  assert.equal(Chat.codexAccountKey({ ...unknown, accountId: null, accountEmail: null }), null);
});

const authA = { isLoggedIn: true, authMode: 'chatgpt', accountId: null, accountEmail: 'a@example.test', identityStatus: 'known', identityBasis: 'email' };
const authB = { ...authA, accountEmail: 'b@example.test' };
const savedNativeRoom = () => ({ id: 'kept-local-room', title: 'Kept title', conversationId: 'native-a', messages: [{ id: 'kept-message', role: 'assistant', content: 'local transcript A', artifacts: [artifact] }] });

test('restored provider-only or missing ownership cannot adopt a saved CID under a newly observed account', () => {
  for (const owner of ['codex:chatgpt:chatgpt', 'codex:apiKey:apikey', null, undefined]) {
    const original = savedNativeRoom();
    const detached = Chat.detachNativeThread(original, owner, 'restore');
    const next = Chat.reconcileNativeThread(detached, authB);
    assert.equal(next.id, original.id);
    assert.deepEqual(next.messages, original.messages);
    assert.equal(next.retainedNativeBinding.conversationId, 'native-a');
    assert.equal(next.retainedNativeBinding.clientThreadId, original.id);
    assert.equal(next.retainedNativeBinding.accountKey, owner || null);
    assert.equal(next.conversationId, null);
    assert.equal(next.bindingAccountKey, null);
    assert.notEqual(Chat.clientThreadBinding(next), original.id);
    assert.equal(Chat.nativeBindingHeld(next), true);
    assert.equal(Chat.canResumeNativeThread(next, authB), false);
    assert.equal(Chat.canAdmitChatEvent(Chat.createChatProtocolState(), [next], { conversationId: 'native-a', clientThreadId: original.id }), false);
  }
});

test('quarantined ownership survives re-save under B without a current-account stamp', () => {
  const held = Chat.reconcileNativeThread(Chat.detachNativeThread(savedNativeRoom(), null, 'first'), authB);
  const roundTrip = JSON.parse(JSON.stringify(held));
  const restored = Chat.reconcileNativeThread(Chat.detachNativeThread(roundTrip, Chat.codexAccountKey(authB), 'second'), authB);
  assert.equal(restored.retainedNativeBinding.accountKey, null);
  assert.equal(restored.retainedNativeBinding.conversationId, 'native-a');
  assert.equal(restored.bindingAccountKey, null);
  assert.equal(restored.conversationId, null);
  assert.equal(Chat.canResumeNativeThread(restored, authB), false);
  assert.deepEqual(restored.messages, held.messages);
});

test('verified matching ownership resumes; a mismatch retains the record without deleting it', () => {
  const staged = Chat.detachNativeThread(savedNativeRoom(), Chat.codexAccountKey(authA), 'restore');
  const match = Chat.reconcileNativeThread(staged, authA);
  assert.equal(match.conversationId, 'native-a');
  assert.equal(Chat.canResumeNativeThread(match, authA), true);
  const mismatch = Chat.reconcileNativeThread(staged, authB);
  assert.equal(mismatch.conversationId, null);
  assert.equal(mismatch.bindingAccountKey, null);
  assert.equal(Chat.canResumeNativeThread(mismatch, authB), false);
  assert.deepEqual(mismatch.messages, savedNativeRoom().messages);
  const verifiedReturn = Chat.reconcileNativeThread(mismatch, authA);
  assert.equal(Chat.canResumeNativeThread(verifiedReturn, authA), true);
});

test('restore-before-auth and auth-before-restore require the same positive ownership match', () => {
  const unknown = { isLoggedIn: false, identityStatus: 'unknown', identityBasis: null };
  const before = Chat.detachNativeThread(savedNativeRoom(), Chat.codexAccountKey(authA), 'before');
  const waiting = Chat.reconcileNativeThread(before, unknown);
  assert.equal(waiting.conversationId, null);
  assert.equal(Chat.canResumeNativeThread(waiting, unknown), false);
  const afterReceipt = Chat.reconcileNativeThread(waiting, authA);
  const alreadyKnown = Chat.reconcileNativeThread(Chat.detachNativeThread(savedNativeRoom(), Chat.codexAccountKey(authA), 'after'), authA);
  assert.equal(afterReceipt.conversationId, alreadyKnown.conversationId);
  assert.equal(Chat.canResumeNativeThread(afterReceipt, authA), true);
  assert.equal(Chat.canResumeNativeThread(alreadyKnown, authA), true);
  const unknownOwner = Chat.reconcileNativeThread(Chat.detachNativeThread(savedNativeRoom(), null, 'unknown-owner'), authA);
  assert.equal(Chat.canResumeNativeThread(unknownOwner, authA), false);
});

test('fresh no-CID empty rooms remain usable and transient lookup failure does not detach a verified live binding', () => {
  const fresh = Chat.reconcileNativeThread(Chat.detachNativeThread({ id: 'fresh', messages: [], conversationId: null }, null, 'new'), authB);
  assert.equal(Chat.nativeBindingHeld(fresh), false);
  assert.equal(Chat.buildChatRequest(fresh, 'new user request', 'new-request').conversationId, undefined);
  assert.equal(Chat.buildChatRequest(fresh, 'new user request', 'new-request').profileEnabled, false);
  const verified = Chat.reconcileNativeThread(Chat.detachNativeThread(savedNativeRoom(), Chat.codexAccountKey(authA), 'a'), authA);
  const transient = { ...authA, identityStatus: 'unknown', identityBasis: null };
  const unchanged = Chat.reconcileNativeThread(verified, transient);
  assert.equal(unchanged, verified);
  assert.equal(unchanged.conversationId, 'native-a');
  assert.equal(Chat.canResumeNativeThread(unchanged, transient), false);
  assert.equal(Chat.canResumeNativeThread(unchanged, authA), true);
});

test('an explicit null per-room owner never borrows a newer snapshot-global owner', () => {
  const room = { ...savedNativeRoom(), bindingAccountKey: null };
  const staged = Chat.detachNativeThread(room, Chat.codexAccountKey(authB), 'restore');
  const next = Chat.reconcileNativeThread(staged, authB);
  assert.equal(next.retainedNativeBinding.accountKey, null);
  assert.equal(Chat.canResumeNativeThread(next, authB), false);
});

test('known A then explicit unknown fresh submission captures null instead of a cached A key', () => {
  const state = Chat.createChatProtocolState();
  const cachedA = Chat.codexAccountKey(authA);
  Chat.registerChatRequest(state, { requestId: 'known', clientThreadId: 'room-a' }, authA);
  assert.equal(state.requests.known.accountKey, cachedA);
  const unknown = { ...authA, identityStatus: 'unknown', identityBasis: null };
  Chat.registerChatRequest(state, { requestId: 'unknown', clientThreadId: 'fresh-room', accountKey: cachedA }, unknown);
  assert.equal(state.requests.unknown.accountKey, null);
  const run = Chat.acceptChatRequest(state, { accepted: true, conversationId: 'fresh-cid', runId: 'fresh-turn' }, 'unknown');
  assert.equal(run.accountKey, null);
  assert.deepEqual(Chat.nativeBindingForRun({ conversationId: null, bindingAccountKey: cachedA, bindingState: 'verified' }, run), { bindingAccountKey: null, bindingState: 'live-unverified' });
});

test('later known identity and later response metadata cannot retroactively promote unknown submission ownership', () => {
  const state = Chat.createChatProtocolState();
  const auth = { ...authA, identityStatus: 'unknown', identityBasis: null };
  Chat.registerChatRequest(state, { requestId: 'request-a', clientThreadId: 'ui-a' }, auth);
  Object.assign(auth, authA);
  const run = Chat.reduceChatEvent(state, envelope('run.started', 1));
  Chat.acceptChatRequest(state, { accepted: true, conversationId: 'conversation-a', runId: 'turn-a', accountKey: Chat.codexAccountKey(auth) }, 'request-a');
  assert.equal(run.accountKey, null);
  assert.equal(run.submissionOwnerCaptured, true);
  const thread = { id: 'ui-a', conversationId: run.conversationId, ...Chat.nativeBindingForRun({ conversationId: null }, run) };
  assert.equal(Chat.reconcileNativeThread(thread, auth), thread);
  assert.equal(thread.bindingAccountKey, null);
  assert.equal(Chat.canResumeNativeThread(thread, auth), false);
});

test('unknown request cannot borrow an old verified owner for a different CID', () => {
  const current = { conversationId: 'old-cid', bindingAccountKey: Chat.codexAccountKey(authA), bindingState: 'verified' };
  assert.deepEqual(Chat.nativeBindingForRun(current, { conversationId: 'new-cid', accountKey: null }), { bindingAccountKey: null, bindingState: 'live-unverified' });
});

test('a transient unknown lookup retains existing ownership proof only for the same verified CID', () => {
  const current = { conversationId: 'same-cid', bindingAccountKey: Chat.codexAccountKey(authA), bindingState: 'verified' };
  assert.deepEqual(Chat.nativeBindingForRun(current, { conversationId: 'same-cid', accountKey: null }), { bindingAccountKey: current.bindingAccountKey, bindingState: 'verified' });
  assert.equal(Chat.canResumeNativeThread(current, { ...authA, identityStatus: 'unknown' }), false);
  assert.equal(Chat.canResumeNativeThread(current, authA), true);
});

test('production runtime config forwards explicit thread cwd through ordinary Codex requests', () => {
  for (const profileEnabled of [false, true]) {
    const thread = { id: 'cwd-room', cwd: '/tmp/isolated-work-context', profileEnabled };
    const runtime = runtimeFor(thread);
    assert.equal(runtime.cwd, thread.cwd);
    assert.equal(Object.hasOwn(runtime, 'cwd'), true);
    const body = Chat.buildChatRequest(thread, 'work here', 'cwd-request', runtime);
    assert.equal(JSON.parse(JSON.stringify(body)).cwd, thread.cwd);
    assert.equal(body.profileEnabled, profileEnabled);
    if (!profileEnabled) {
      assert.equal(Object.hasOwn(body, 'agentProfile'), false);
      assert.equal(Object.hasOwn(body, 'systemPrompt'), false);
      assert.equal(Object.hasOwn(body, 'toolMode'), false);
    }
  }
});

test('unset cwd preserves omission and never inherits a persona cwd', () => {
  for (const thread of [{ id: 'unset' }, { id: 'undefined', cwd: undefined }]) {
    const runtime = runtimeFor(thread);
    assert.equal(Object.hasOwn(runtime, 'cwd'), false);
    assert.equal(Object.hasOwn(Chat.buildChatRequest(thread, 'hello', 'q', runtime), 'cwd'), false);
  }
  assert.equal(Chat.buildChatRequest({ id: 'direct', cwd: '/tmp/explicit-thread' }, 'hello', 'q').cwd, '/tmp/explicit-thread');
});

test('explicit invalid cwd is forwarded unchanged for backend validation rather than silently defaulted', () => {
  for (const cwd of ['', null, false, 0, 'relative-directory', [], {}]) {
    const thread = { id: 'invalid-cwd', cwd, profileEnabled: false };
    const runtime = runtimeFor(thread);
    assert.equal(runtime.cwd, cwd);
    const wire = JSON.parse(JSON.stringify(Chat.buildChatRequest(thread, 'hello', 'q', runtime)));
    assert.equal(Object.hasOwn(wire, 'cwd'), true);
    assert.deepEqual(wire.cwd, cwd);
  }
  const body = Chat.buildChatRequest({ id: 'runtime-cwd', cwd: '/tmp/thread-value' }, 'hello', 'q', { cwd: '' });
  assert.equal(body.cwd, '');
});

test('terminal production HTML bootstraps from existing chrome assets without executable inline script', () => {
  const resources = new URL('../overlay/resources/', import.meta.url);
  const html = readFileSync(new URL('terminal.html', resources), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const prefix = 'chrome://userchrome/content/';
  const sources = scripts.map(([, attributes, body]) => {
    assert.equal(body.trim(), '', 'existing CSP must not need executable inline script');
    const src = attributes.match(/\bsrc\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    assert.ok(src?.startsWith(prefix), 'script must use the existing allowed chrome source');
    const path = new URL(src.slice(prefix.length), resources);
    assert.ok(path.href.startsWith(resources.href));
    assert.ok(existsSync(path), `production script asset missing: ${src}`);
    return src;
  });
  const initUrl = `${prefix}egdesk-terminal-init.js`;
  assert.equal(sources.filter(src => src === initUrl).length, 1);
  assert.equal(sources.at(-1), initUrl, 'vendor globals load before the initializer');
  assert.ok(sources.includes(`${prefix}vendor/xterm.min.js`));
  assert.ok(sources.includes(`${prefix}vendor/addon-fit.min.js`));
  const initializer = readFileSync(new URL('egdesk-terminal-init.js', resources), 'utf8');
  for (const [, dependency] of initializer.matchAll(/\bimport\(['"]([^'"]+)['"]\)/g)) {
    assert.ok(dependency.startsWith(prefix));
    assert.ok(existsSync(new URL(dependency.slice(prefix.length), resources)));
  }
  assert.equal(/\son\w+\s*=/i.test(html), false, 'no inline event handlers');
  assert.equal(html.includes('unsafe-inline'), false);
});

// Minimal inert DOM: execute the production renderer without Firefox or a
// bridge. Any HTML-string sink fails, so untrusted text cannot become markup.
function markdownDOM() {
  const doc = {
    createElement: tag => new Node(tag),
    createTextNode: value => new Node('#text', value),
  };
  class Node {
    constructor(tag, value = '') {
      this.tag = tag; this.value = value; this.ownerDocument = doc;
      this.children = []; this.attributes = {}; this.listeners = {};
    }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    set innerHTML(_) { throw new Error('production renderer must use safe DOM text'); }
    get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
    all(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.all(tag)]); }
    dispatch(type, fields = {}) {
      const event = { ...fields, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      for (const callback of this.listeners[type] || []) callback(event);
      return event;
    }
  }
  return doc.createElement('div');
}
const markdownPath = '/private/var/folders/6__test_dir/T/qa_fixtures/real_turn/egdesk_real_file.txt';
const markdownArtifact = () => ({ id: 'artifact-1', type: 'file', target: { path: markdownPath },
  label: 'QA text file', status: 'available', conversationId: 'conversation-1', runId: 'turn-1',
  answerId: 'conversation-1/turn-1', relation: 'referenced', verifiedAt: 1 });
const markdownContext = artifact => ({ conversationId: artifact.conversationId, runId: artifact.runId,
  answerId: artifact.answerId, artifacts: [artifact] });

test('production Markdown renders A6-shaped file label and preserves inline-code underscores', () => {
  const root = markdownDOM();
  const source = `Created and verified [QA text file](${markdownPath}) with exactly \`EGDESK_REAL_UI_345aa46e5c1e\` followed by one newline.`;
  Markdown.appendMarkdown(root, source);
  assert.equal(root.textContent, 'Created and verified QA text file with exactly EGDESK_REAL_UI_345aa46e5c1e followed by one newline.');
  assert.equal(root.all('code')[0].textContent, 'EGDESK_REAL_UI_345aa46e5c1e');
  assert.equal(root.all('em').length, 0);
  assert.equal(root.all('a').length, 0, 'unverified label must not invent a file/card');
  assert.equal(root.all('span')[0].attributes['data-verification'], 'unverified');
  assert.equal(Markdown.plainMarkdownText(source), root.textContent);
});

test('verified inline file opens only on click or Enter through the same-answer artifact', () => {
  const root = markdownDOM(), artifact = markdownArtifact(), opened = [];
  const context = { ...markdownContext(artifact), openArtifact: value => opened.push(value) };
  Markdown.appendMarkdown(root, `[QA text file](${markdownPath})`, context);
  assert.equal(opened.length, 0, 'rendering must not open a card or move Canvas');
  const link = root.all('a')[0];
  assert.equal(link.attributes.href, undefined, 'no default local-file navigation');
  assert.equal(link.attributes.role, 'link');
  assert.equal(link.attributes.tabindex, '0');
  assert.equal(link.attributes['data-testid'], 'chat-inline-artifact');
  assert.equal(link.attributes['data-answer-id'], artifact.answerId);
  const clicked = link.dispatch('click');
  assert.ok(clicked.prevented && clicked.stopped);
  link.dispatch('keydown', { key: 'Enter' });
  assert.equal(opened.length, 2);
  assert.ok(opened.every(value => value === artifact), 'pass the verified object, not a parsed-path fabrication');
  artifact.status = 'missing';
  link.dispatch('click');
  assert.equal(opened.length, 2, 'recheck artifact availability on activation');
});

test('local link matching requires path plus conversation, run and answer verification', () => {
  const artifact = markdownArtifact();
  for (const change of [
    { answerId: 'other-answer' }, { runId: 'other-run' }, { conversationId: 'other-conversation' },
    { answerId: null }, { artifacts: [{ ...artifact, verifiedAt: null }] },
    { artifacts: [{ ...artifact, target: { path: '/different/path.txt' } }] },
  ]) {
    const root = markdownDOM();
    Markdown.appendMarkdown(root, `[QA text file](${markdownPath})`, {
      ...markdownContext(artifact), ...change, openArtifact() { assert.fail('unverified click'); },
    });
    assert.equal(root.textContent, 'QA text file');
    assert.equal(root.all('a').length, 0);
  }
  const spaced = { ...artifact, target: { path: '/tmp/qa file_with_underscores.txt' } };
  assert.equal(Markdown.verifiedFileLink('file:///tmp/qa%20file_with_underscores.txt', markdownContext(spaced)), spaced);
  assert.equal(Markdown.verifiedFileLink('file://remote/tmp/qa%20file_with_underscores.txt', markdownContext(spaced)), null);
});

test('code and destinations are opaque before emphasis; ordinary emphasis still works', () => {
  const root = markdownDOM();
  Markdown.appendMarkdown(root, 'EGDESK_REAL_UI **bold** _italic_ *around `a_b_c`* [file](/tmp/a_b_c.txt)');
  assert.equal(root.textContent, 'EGDESK_REAL_UI bold italic around a_b_c file');
  assert.deepEqual(root.all('em').map(node => node.textContent), ['italic', 'around a_b_c']);
  assert.equal(root.all('strong')[0].textContent, 'bold');
  assert.equal(root.all('code')[0].textContent, 'a_b_c');
});

test('unsafe Markdown destinations render plain labels without navigation handlers', () => {
  for (const destination of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,evil',
    'chrome://browser/content/browser.xhtml', 'resource://gre/evil', '//remote/file', 'file:///tmp/unverified.txt']) {
    const root = markdownDOM();
    Markdown.appendMarkdown(root, `[safe label](${destination})`, {
      openArtifact() { assert.fail('unexpected file open'); }, openWeb() { assert.fail('unsafe URL open'); },
    });
    assert.equal(root.textContent, 'safe label');
    assert.equal(root.all('a').length, 0);
    assert.equal(root.all('span')[0].attributes.href, undefined);
    assert.deepEqual(root.all('span')[0].listeners, {});
  }
});

test('untrusted HTML stays text in labels, inline code and fenced code', () => {
  const root = markdownDOM();
  const html = '<img src=x onerror=alert(1)>';
  Markdown.appendMarkdown(root, `<script>alert(1)</script> [${html}](javascript:alert(1)) \`${html}\`\n\`\`\`html\n${html}\n\`\`\``);
  assert.equal(root.all('script').length, 0);
  assert.equal(root.all('img').length, 0);
  assert.ok(root.textContent.includes('<script>alert(1)</script>'));
  assert.deepEqual(root.all('code').map(node => node.textContent), [html, html]);
  assert.equal(root.all('a').length, 0);
});

test('safe web Markdown and bare links retain the existing Browser-card callback', () => {
  const root = markdownDOM(), opened = [];
  Markdown.appendMarkdown(root, '[readable](https://example.test/a_b?q=c_d) https://example.test/x_y.', { openWeb: url => opened.push(url) });
  assert.equal(root.textContent, 'readable https://example.test/x_y.');
  assert.deepEqual(root.all('a').map(link => link.attributes.href), ['https://example.test/a_b?q=c_d', 'https://example.test/x_y']);
  assert.equal(opened.length, 0);
  root.all('a')[0].dispatch('click');
  assert.deepEqual(opened, ['https://example.test/a_b?q=c_d']);
});

test('actual overlay rich-text path supplies the same-answer artifact scope and preserves held bindings', () => {
  const body = surfaceSource.match(/  function appendRichText\(container, text, message, thread\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(body);
  const render = compileFunction(body, ['container', 'text', 'message', 'thread', 'codexRuns', 'Markdown', 'ChatState',
    'getCodexThreadById', 'state', 'openCodexResultLink', 'openUrlInBrowserCard']);
  const artifact = markdownArtifact(), opened = [];
  let thread = { id: 'room-1', conversationId: artifact.conversationId };
  const message = { role: 'assistant', answerId: artifact.answerId, runId: artifact.runId, conversationId: artifact.conversationId };
  const run = { ...message, artifacts: [artifact] };
  const root = markdownDOM();
  const draw = target => render(target, `[QA text file](${markdownPath})`, message, thread, () => [run], Markdown, Chat,
    () => thread, { codex: {} }, value => opened.push(value), () => assert.fail('local link must not use URL callback'));
  draw(root);
  root.all('a')[0].dispatch('click');
  assert.deepEqual(opened, [artifact]);
  thread = { ...thread, conversationId: null, retainedNativeBinding: { conversationId: artifact.conversationId } };
  root.all('a')[0].dispatch('click');
  assert.equal(opened.length, 1, 'previous DOM cannot open a newly held binding');
  const held = markdownDOM();
  draw(held);
  assert.equal(held.all('a').length, 0);
  assert.ok(surfaceSource.includes("appendRichText(content, parts.text || (message.status === 'streaming' ? '…' : ''), message, activeThread)"));
});

const browserInput = () => ({ id: 'input-1', kind: 'browser', label: 'Page', sourceRef: { viewId: 'browser-1', uri: 'https://example.test/', boardId: 'board-1' } });
test('explicit input selections deduplicate, remove independently and never mutate prior draft', () => {
  const first = browserInput(), file = { id: 'file-1', kind: 'file', label: 'File', sourceRef: { path: '/tmp/file.txt' } };
  const draft = InputContext.addInputSources([], [first, file, { ...first, id: 'duplicate' }]);
  assert.equal(draft.length, 2);
  first.label = 'Changed outside';
  assert.equal(draft[0].label, 'Page');
  assert.deepEqual(InputContext.removeInputSource(draft, 'input-1').map(item => item.id), ['file-1']);
  assert.equal(draft.length, 2);
});

test('Browser capture preserves exact included text, excludes controls/hidden text and declares loaded-DOM coverage', () => {
  const root = { tagName: 'BODY', parentElement: null, getAttribute() {}, style: { display: 'block', visibility: 'visible', opacity: '1' } };
  const parent = (tagName, extra = {}) => ({ ...root, tagName, parentElement: root, ...extra });
  const texts = [
    { nodeValue: 'real  text\nwith_space', parentElement: parent('P') },
    { nodeValue: 'do not read password', parentElement: parent('INPUT') },
    { nodeValue: 'editable draft', parentElement: parent('DIV', { isContentEditable: true }) },
    { nodeValue: 'hidden', parentElement: parent('DIV', { hidden: true }) },
    { nodeValue: 'const secret = 1', parentElement: parent('SCRIPT') },
    { nodeValue: 'last paragraph', parentElement: parent('P') },
  ];
  const doc = { body: root, title: 'Test', defaultView: {
    location: { href: 'https://example.test/' }, NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }, getComputedStyle: node => node.style,
  }, createTreeWalker: (_root, _type, filter) => {
    const accepted = texts.filter(node => filter.acceptNode(node) === 1);
    let index = 0;
    return { nextNode: () => accepted[index++] || null };
  } };
  const result = InputContext.captureDocumentText(doc);
  assert.equal(result.text, 'real  text\nwith_space\nlast paragraph');
  assert.equal(result.coverage.completeDocument, false);
  assert.equal(result.coverage.completeWithinBoundary, true);
  assert.ok(result.coverage.excluded.includes('child-frames'));
  const partial = InputContext.captureDocumentText(doc, { maxChars: 6 });
  assert.equal(partial.text, 'real  ');
  assert.equal(partial.truncated, true);
  assert.equal(partial.coverage.completeWithinBoundary, false);
  texts[0].nodeValue = 'x'.repeat(80000);
  const fullDefault = InputContext.captureDocumentText(doc);
  assert.ok(fullDefault.text.startsWith(texts[0].nodeValue));
  assert.equal(fullDefault.truncated, false, 'default loaded-DOM capture has no silent character cap');
});

test('input snapshots remain immutable and keep content separate from spatial context', async () => {
  const source = browserInput();
  const snapshots = await InputContext.captureInputSources([source], { browser: async () => ({
    text: 'Actual source body', url: source.sourceRef.uri, executionContext: { geometry: { x: 1, y: 2 } },
    coverage: { scope: 'loaded-dom-visible-text', completeDocument: false },
  }) }, { nextId: () => 'capture-1', now: () => 100 });
  source.sourceRef.uri = 'https://changed.test/';
  assert.equal(snapshots[0].sourceRef.uri, 'https://example.test/');
  assert.equal(snapshots[0].content.text, 'Actual source body');
  assert.equal(snapshots[0].content.geometry, undefined);
  assert.equal(snapshots[0].executionContext.geometry.x, 1);
  assert.throws(() => { snapshots[0].content.text = 'mutated'; }, TypeError);
  assert.throws(() => InputContext.inputSnapshot(source, { text: 'old', url: 'https://example.test/' }), /주소가 바뀌/);
});

test('batch attachment wire has one schema: file bytes are helper-owned, browser content and scope explicit', () => {
  const file = { id: 'file', kind: 'file', label: 'File', sourceRef: { path: '/tmp/file.txt' } };
  const fileWire = InputContext.captureAttachment(file, null, 100);
  assert.deepEqual(fileWire, { id: 'file', kind: 'file', label: 'File', capturedAt: 100,
    sourceRef: { kind: 'file', resourceId: '/tmp/file.txt', path: '/tmp/file.txt' }, captureScope: { type: 'file' } });
  const source = browserInput();
  assert.throws(() => InputContext.captureAttachment(source), /실제 캡처/);
  const snapshot = InputContext.inputSnapshot(source, { text: 'actual', url: source.sourceRef.uri, truncated: true,
    coverage: { scope: 'loaded-dom-visible-text', completeDocument: false } }, { id: 'capture' });
  const wire = InputContext.captureAttachment(source, snapshot);
  assert.equal(wire.content.text, 'actual');
  assert.equal(wire.content.mime, 'text/plain');
  assert.equal(wire.content.truncated, true);
  assert.equal(wire.captureScope.type, 'document-text');
  assert.equal(wire.sourceRef.viewId, 'browser-1');
  assert.equal(wire.executionContext, undefined);
  assert.equal(wire.systemPrompt, undefined);
});

test('capture receipt preserves source mapping without treating it as resource authority', () => {
  const source = browserInput();
  const receipt = { id: source.id, sourceId: 'snapshot', snapshotId: 'snapshot', hash: 'hash', capturedAt: 1, sourceRef: { kind: 'browser' }, shape: {} };
  const reference = InputContext.capturedInputReference(source, receipt);
  source.sourceRef.viewId = 'different';
  assert.equal(reference.localSource.sourceRef.viewId, 'browser-1');
  assert.equal(reference.sourceRef.permission, undefined);
  assert.throws(() => InputContext.capturedInputReference(source, { snapshotId: 'fake' }), /저장 확인/);
});

const briefingFixture = () => ({ id: 'briefing-1', title: 'Answer', steps: [
  { id: 'step-1', text: 'First source', target: { sourceId: 'snapshot-1' }, fallback: 'Inspect source' },
  { id: 'step-2', text: 'Second source', target: { sourceId: 'snapshot-2' }, fallback: 'Inspect source' },
] });
test('Briefing requires explicit steps, bounds navigation, and retains the original view independently', () => {
  assert.equal(Briefing.validBriefing({ id: 'invented', steps: [] }), false);
  const viewport = { pan: { x: 10, y: 20 }, zoom: 0.8, activeEntityId: 'browser-1' };
  const session = Briefing.beginBriefing(briefingFixture(), viewport);
  viewport.pan.x = 999;
  assert.equal(session.previousView.pan.x, 10);
  assert.equal(Briefing.currentBriefingStep(session).id, 'step-1');
  assert.equal(Briefing.selectBriefingStep(session, -1), session);
  assert.equal(Briefing.currentBriefingStep(Briefing.selectBriefingStep(session, 1)).id, 'step-2');
  assert.equal(session.index, 0);
});

test('Briefing target lookup never substitutes a different view for missing/stale sources', () => {
  const step = briefingFixture().steps[0];
  const reference = { sourceId: 'snapshot-1', hash: 'fixed', localSource: { sourceRef: { viewId: 'original' } } };
  const other = { id: 'unrelated', sourceMatches: true, revisionMatches: true, geometry: { x: 1, y: 2, width: 3, height: 4 } };
  assert.equal(Briefing.resolveBriefingTargets(step, { references: [reference], views: [other] })[0].status, 'missing');
  const evidence = { ...other, id: 'pinned-evidence', sourceId: 'snapshot-1', hash: 'fixed', evidenceKey: InputContext.inputEvidenceKey(reference) };
  const stale = Briefing.resolveBriefingTargets(step, { references: [reference], views: [{ ...evidence, revisionMatches: false }] });
  assert.equal(stale[0].status, 'stale');
  assert.equal(Briefing.briefingBounds(stale), null);
  const current = Briefing.resolveBriefingTargets(step, { references: [reference], views: [evidence] });
  assert.deepEqual(Briefing.briefingBounds(current), other.geometry);
  assert.deepEqual(other.geometry, { x: 1, y: 2, width: 3, height: 4 });
});

test('Briefing comments prepare a visible draft and explicit source IDs without executing a turn', () => {
  const session = Briefing.beginBriefing(briefingFixture(), { pan: { x: 0, y: 0 }, zoom: 1 });
  const draft = Briefing.briefingCommentDraft(session, 'Compare this', [{ reference: { sourceId: 'snapshot-1' }, status: 'stale' }]);
  assert.equal(draft.stepId, 'step-1');
  assert.match(draft.text, /의견: Compare this/);
  assert.deepEqual(draft.contextSnapshotIds, ['snapshot-1']);
  assert.equal(draft.autoSend, undefined);
});

test('final GET separates paginated immutable source from exact delivered packet and never rereads Live', () => {
  const reference = { sourceId: 'source-1', hash: 'hash-1', localSource: { label: 'Original' } };
  const stored = { capture: { sourceId: 'source-1', hash: 'hash-1', capturedAt: 100,
    sourceRef: { path: '/tmp/selected.txt' }, captureScope: { type: 'file' }, shape: {}, payloads: [], transformations: [] },
    source: { role: 'source', mime: 'text/plain', hash: 'hash-1', rangeHash: 'range-1',
      range: { startLine: 1, endLine: 200, totalLines: 600 }, text: 'saved data only', nextLine: 201 }, delivered: null, bindings: [] };
  const snapshot = InputContext.storedSnapshotForView(stored, reference);
  assert.equal(snapshot.content.text, 'saved data only');
  assert.equal(snapshot.nextLine, 201);
  assert.equal(snapshot.content.coverage.completeDocument, false);
  const root = markdownDOM();
  root.appendChild(InputContext.inputSnapshotView(root.ownerDocument, snapshot));
  assert.match(root.textContent, /원문 캡처/);
  assert.match(root.textContent, /전달 기록 없음/);
  assert.equal(root.all('a').length, 0);
  assert.equal(root.all('button').length, 0, 'read-only source display never reads or opens Live');
  assert.throws(() => InputContext.storedSnapshotForView({ ...stored, capture: { ...stored.capture, hash: 'changed' }, source: { ...stored.source, hash: 'changed' } }, reference), /다른 응답/);
  assert.throws(() => InputContext.storedSnapshotForView({ ...stored, source: { ...stored.source, role: 'raw-reasoning' } }, reference), /원문 응답/);
  const exactPacket = '{"packet":"what was sent","text":"source-derived payload"}';
  const delivered = { role: 'agent_input', packetId: 'packet-1', mime: 'application/json', hash: 'packet-hash', text: exactPacket,
    mode: 'reader', coverage: { complete: false }, deliveryStatus: 'sent-to-app-server', binding: { conversationId: 'c', runId: 'r', answerId: 'c/r' } };
  const withDelivery = InputContext.storedSnapshotForView({ ...stored, delivered }, reference);
  const inspector = markdownDOM();
  inspector.appendChild(InputContext.inputSnapshotView(inspector.ownerDocument, withDelivery));
  assert.ok(inspector.all('pre').some(node => node.textContent === exactPacket));
  assert.match(inspector.textContent, /모델의 수신·완독·작업 완료를 뜻하지 않습니다/);
  const evidence = markdownDOM();
  evidence.appendChild(InputContext.inputSnapshotView(evidence.ownerDocument, withDelivery, { includeDelivered: false }));
  assert.equal(evidence.textContent.includes(exactPacket), false, 'presentation exposes selected source, not private delivery records');
});

test('Briefing range matching uses immutable source/hash/range, never just the original live viewId', () => {
  const ref = { sourceId: 'source', hash: 'fixed', localSource: { sourceRef: { viewId: 'live' } } };
  const range = { startLine: 201, endLine: 240 };
  const step = { id: 'step', text: 'Focus this range', target: { sourceId: 'source', viewId: 'live', range } };
  const wrong = { id: 'live', sourceId: 'source', hash: 'fixed', sourceMatches: true, revisionMatches: true,
    evidenceKey: InputContext.inputEvidenceKey(ref), geometry: { x: 10, y: 20, width: 640, height: 480 } };
  assert.equal(Briefing.resolveBriefingTargets(step, { references: [ref], views: [wrong] })[0].status, 'missing');
  const correct = { ...wrong, id: 'immutable-view', evidenceKey: InputContext.inputEvidenceKey({ ...ref, presentationRange: range }) };
  assert.equal(Briefing.resolveBriefingTargets(step, { references: [ref], views: [correct] })[0].status, 'available');
  assert.deepEqual(correct.geometry, wrong.geometry);
  assert.throws(() => InputContext.projectionRange({ startLine: 1, endLine: 501 }), /최대 500행/);
});

test('production batch coordinator sends real content once and uses the rotated wire binding', async () => {
  const body = surfaceSource.match(/    async function captureThreadInputs\(thread, sources, token\) \{([\s\S]*?)\n    \}/)?.[1];
  assert.ok(body);
  const run = compileFunction(`return (async () => {${body}\n})();`, ['thread', 'sources', 'token', 'epochScope', 'captureChatInputs', 'fetchJson', 'InputContext', 'ChatState']);
  const browser = browserInput(), file = { id: 'file-1', kind: 'file', label: 'File', sourceRef: { path: '/tmp/file.txt' } };
  const calls = [];
  const fetchJson = async (route, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ route, payload });
    return { captures: payload.attachments.map(item => ({ id: item.id, sourceId: `stored-${item.id}`,
      snapshotId: `stored-${item.id}`, hash: `hash-${item.id}`, sourceRef: item.sourceRef, captureScope: item.captureScope })) };
  };
  const references = await run({ id: 'local-room', clientBindingId: 'wire-after-reset' }, [browser, file], {}, { valid: () => true },
    async ([source]) => [InputContext.inputSnapshot(source, { text: 'actual browser body', url: source.sourceRef.uri })], fetchJson, InputContext, Chat);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/context/captures');
  assert.equal(calls[0].payload.clientThreadId, 'wire-after-reset');
  assert.equal(calls[0].payload.attachments[0].content.text, 'actual browser body');
  assert.equal(calls[0].payload.attachments[1].content, undefined, 'helper reads actual file bytes');
  assert.deepEqual(references.map(ref => ref.sourceId), ['stored-input-1', 'stored-file-1']);
  const wire = Chat.buildChatRequest({ id: 'local-room', profileEnabled: false }, 'Inspect', 'request-1', {
    contextSnapshotIds: references.map(ref => ref.sourceId), contextCapabilities: { read: true, reader: true, publishBriefing: true }, systemPrompt: 'not ordinary Codex',
  });
  assert.deepEqual(wire.contextSnapshotIds, ['stored-input-1', 'stored-file-1']);
  assert.deepEqual(wire.contextCapabilities, { read: true, reader: true, publishBriefing: true });
  assert.equal(wire.profileEnabled, false);
  assert.equal(wire.systemPrompt, undefined);
  assert.equal(wire.attachments, undefined, 'Chat sends immutable IDs, not a second competing payload shape');
  await assert.rejects(() => run({ id: 'room' }, [browser], {}, { valid: () => false }, () => assert.fail(), () => assert.fail(), InputContext, Chat), /연결이 바뀌/);
});

test('context/Reader/Briefing events preserve answer provenance and never become chat tool spam', () => {
  const state = Chat.createChatProtocolState();
  Chat.registerChatRequest(state, { requestId: 'q', clientThreadId: 'thread' });
  const envelope = { type: 'chat.event', v: 2, provider: 'codex', streamId: 'stream', conversationId: 'conversation', runId: 'turn',
    answerId: 'conversation/turn', requestId: 'q', clientThreadId: 'thread', ts: 1 };
  let seq = 0;
  const event = (name, details) => Chat.reduceChatEvent(state, { ...envelope, event: name, seq: ++seq, details });
  const capture = { id: 'input', sourceId: 'source-1', snapshotId: 'source-1', hash: 'fixed', sourceRef: {} };
  event('context.bound', { captures: [capture] });
  event('context.read.started', { sourceId: 'source-1' });
  event('reader.completed', { sourceId: 'source-1' });
  const run = event('briefing.published', { briefing: briefingFixture() });
  assert.equal(run.messages.length, 0);
  assert.equal(run.contextEvents.length, 2);
  assert.equal(run.briefing.id, 'briefing-1');
  event('message.completed', { messageId: 'assistant', text: 'Final answer' });
  const projected = Chat.projectRunMessages([], run);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].contextCaptures[0].hash, 'fixed');
  assert.equal(projected[0].briefing.id, 'briefing-1');
  const historyOnly = Chat.projectRunMessages(projected, { ...run, briefing: undefined, contextCaptures: undefined, contextEvents: undefined });
  assert.equal(historyOnly[0].briefing.id, 'briefing-1', 'partial hydration cannot erase already-persisted publication');
});

test('native user hydration keeps the submitted immutable input references once', () => {
  const reference = { sourceId: 'source-1', snapshotId: 'source-1', hash: 'fixed' };
  const existing = [{ id: 'optimistic', requestId: 'q', role: 'user', content: 'Read', inputReferences: [reference] }];
  const run = { conversationId: 'conversation', runId: 'turn', answerId: 'conversation/turn', requestId: 'q', messages: [{ id: 'native-user', role: 'user', content: 'Read', status: 'complete' }], artifacts: [] };
  const projected = Chat.projectRunMessages(existing, run);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].id, 'optimistic');
  assert.deepEqual(projected[0].inputReferences, [reference]);
  assert.equal(Chat.detachNativeThread({ id: 'room', preparingInput: true }, null, 'new').preparingInput, false);
});

test('ordinary legacy threads and unknown identity do not implicitly require unavailable context tools', () => {
  const auth = { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'known@example.test', identityStatus: 'known' };
  assert.equal(Chat.contextCapabilitiesForRequest({ conversationId: 'legacy' }, auth), null);
  assert.equal(Chat.contextCapabilitiesForRequest({}, { ...auth, identityStatus: 'unknown' }), null);
  assert.equal(Chat.contextCapabilitiesForRequest({}, auth).publishBriefing, true);
  assert.equal(Chat.contextCapabilitiesForRequest({ conversationId: 'modern', contextToolsAvailable: true }, auth).read, true);
  assert.equal(Chat.contextCapabilitiesForRequest({ conversationId: 'legacy' }, auth, ['explicit-source']).reader, true);
});

test('backend run.context hydration restores fixed input/output captures, packet receipts and published Briefing', () => {
  const state = Chat.createChatProtocolState();
  const capture = { sourceId: 'output-source', hash: 'output-hash', sourceRef: { resourceId: 'artifact-1' } };
  const briefing = { ...briefingFixture(), steps: [{ id: 'result', text: 'Output', target: { sourceId: 'output-source', artifactId: 'artifact-1', hash: 'output-hash' }, fallback: 'Unavailable' }] };
  const [run] = Chat.mergeChatSnapshot(state, { streamId: 'stream', seq: 1, conversationId: 'c', connection: 'ready', runs: [{ runId: 'r', status: 'completed',
    messages: [{ id: 'a', role: 'assistant', text: 'Done', status: 'complete' }], context: { captures: [capture], packets: [{ packetId: 'packet' }], briefings: [briefing] } }] }, 'wire');
  assert.equal(run.contextCaptures[0].sourceId, 'output-source');
  assert.equal(run.contextPackets[0].packetId, 'packet');
  assert.deepEqual(Chat.projectRunMessages([], run)[0].briefing, briefing);
  assert.equal(Briefing.resolveBriefingTargets(briefing.steps[0], { references: [{ ...capture, hash: 'wrong' }] })[0].status, 'stale');
});

test('production immutable read omits a default endLine so short captures remain readable', async () => {
  const body = surfaceSource.match(/      async readInput\(reference, options = \{\}\) \{([\s\S]*?)\n      \},/)?.[1];
  assert.ok(body);
  const run = compileFunction(`return (async () => {${body}\n})();`, ['reference', 'options', 'epochScope', 'fetchJson', 'InputContext', 'boardNotice']);
  const scope = { begin: () => ({}), valid: () => true, finish() {} };
  const reference = { sourceId: 'fixed', hash: 'hash' };
  const response = { capture: { sourceId: 'fixed', hash: 'hash', sourceRef: {}, capturedAt: 100, captureScope: { type: 'file' } },
    source: { role: 'source', mime: 'text/plain', hash: 'hash', rangeHash: 'range', text: 'one line', range: { startLine: 1, endLine: 1, totalLines: 1 }, nextLine: null }, delivered: null, bindings: [] };
  const urls = [];
  const returned = await run(reference, {}, scope, async url => { urls.push(url); return response; }, InputContext, () => assert.fail('short source should not error'));
  assert.equal(urls[0], '/context/captures/fixed?startLine=1');
  assert.equal(returned.source.text, 'one line');
  const binary = InputContext.storedSnapshotForView({ ...response, source: { ...response.source, rangeHash: null, text: null, range: null, byteLength: 100 } }, reference);
  assert.equal(binary.binary, true);
  assert.equal(binary.content.text, null, 'binary source is not fabricated text');
});

// CORE_REVIEW_REGRESSIONS_BEGIN
test('submitted draft matching includes user revision, exact text and both attachment sets', () => {
  const thread = { inputSources: [{ id: 'a', sourceRef: { path: '/a' } }], briefingInputs: [{ sourceId: 'fixed' }] };
  const submitted = Chat.snapshotChatDraft(thread, ' A ', 2);
  assert.equal(Chat.chatDraftMatches(thread, ' A ', 2, submitted), true);
  assert.equal(Chat.chatDraftMatches(thread, 'B', 3, submitted), false);
  assert.equal(Chat.chatDraftMatches(thread, ' A ', 4, submitted), false, 'A → B → A is newer user intent');
  assert.equal(Chat.chatDraftMatches({ ...thread, inputSources: [] }, ' A ', 2, submitted), false);
  assert.equal(Chat.chatDraftMatches({ ...thread, briefingInputs: [] }, ' A ', 2, submitted), false);
  thread.inputSources[0].sourceRef.path = '/new';
  assert.equal(submitted.inputSources[0].sourceRef.path, '/a');
});

test('actual send path preserves draft B and new attachments typed during delayed capture of draft A', async () => {
  const body = surfaceSource.match(/      async sendMessage\(\) \{([\s\S]*?)\n      \},/)?.[1];
  assert.ok(body);
  const deps = ['state', 'getActiveCodexThread', 'getCodexThreadDraft', 'ChatState', 'threadBusy', 'epochScope', 'updateThreadById', 'emit',
    'captureThreadInputs', 'getCodexThreadById', 'protocol', 'codexThreadAgentProfile', 'appendMessageToThread', 'createCodexMessage', 'SELF_MEMBER', 'codexThreadRuntimeConfig', 'fetchJson', 'syncProtocolRun'];
  const send = compileFunction(`return (async () => {${body}\n})();`, deps);
  const initial = { id: 'room', inputSources: [{ id: 'a' }], briefingInputs: [], messages: [], profileEnabled: false };
  const state = { codex: { activeThreadId: 'room', threads: [initial], threadDrafts: { room: 'A' }, threadDraftRevisions: { room: 1 },
    authStatus: { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'known@example.test', identityStatus: 'known' }, connected: true } };
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const getThread = (_codex, id = 'room') => state.codex.threads.find(thread => thread.id === id);
  const update = (id, fn) => { const index = state.codex.threads.findIndex(thread => thread.id === id); state.codex.threads[index] = fn(state.codex.threads[index]); };
  let payload;
  const running = send(state, () => getThread(null), (codex, id) => codex.threadDrafts[id] || '', Chat, () => false,
    { begin: () => ({}), valid: () => true, finish() {} }, update, () => {}, () => delayed, getThread, Chat.createChatProtocolState(), () => ({}),
    (id, message) => update(id, thread => ({ ...thread, messages: [...thread.messages, message] })),
    (role, content, status, options) => ({ role, content, status, ...options }), 'self', () => ({}),
    async (_url, request) => { payload = JSON.parse(request.body); return { accepted: true, conversationId: 'c', runId: 'r', answerId: 'c/r' }; }, () => {});
  state.codex.threadDrafts.room = 'B';
  state.codex.threadDraftRevisions.room = 2;
  update('room', thread => ({ ...thread, inputSources: [...thread.inputSources, { id: 'b' }] }));
  release([{ sourceId: 'captured-a', snapshotId: 'captured-a' }]);
  await running;
  assert.equal(payload.message, 'A');
  assert.deepEqual(payload.contextSnapshotIds, ['captured-a']);
  assert.equal(state.codex.threadDrafts.room, 'B');
  assert.deepEqual(getThread(null).inputSources.map(input => input.id), ['a', 'b']);
  assert.equal(getThread(null).messages[0].content, 'A');
});

test('production evidence restore requests and verifies the saved range before marking loaded', async () => {
  const body = surfaceSource.match(/else shell\.slots\.content\.appendChild\(el\('button', \{ 'aria-label': '저장된 당시 입력 불러오기', onclick: async \(\) => \{([\s\S]*?)\n    \} \}, '당시 입력 불러오기'\)\);/)?.[1];
  assert.ok(body);
  const restore = compileFunction(`return (async () => {${body}\n})();`, ['state', 'reference', 'shell', 'InputContext', 'document', 'boardNotice']);
  const reference = { sourceId: 'source', hash: 'fixed', presentationRange: { startLine: 201, endLine: 240 } };
  const stored = { capture: { sourceId: 'source', hash: 'fixed', capturedAt: 1, sourceRef: {}, captureScope: { type: 'file' } },
    source: { role: 'source', mime: 'text/plain', hash: 'fixed', rangeHash: 'range', text: '201–240', range: { startLine: 201, endLine: 240, totalLines: 300 }, nextLine: 241 }, delivered: null, bindings: [] };
  const shell = { root: { isConnected: true, _inputEvidenceLoaded: false }, slots: { content: { replaceChildren() {} } } };
  let requested;
  const state = { codexBridge: { readInput: async (_ref, range) => { requested = range; return stored; } } };
  await restore(state, reference, shell, InputContext, markdownDOM().ownerDocument, () => assert.fail('valid range'));
  assert.deepEqual(requested, reference.presentationRange);
  assert.equal(shell.root._inputEvidenceLoaded, true);
  shell.root._inputEvidenceLoaded = false;
  stored.source.range = { startLine: 1, endLine: 200, totalLines: 300 };
  let error;
  await restore(state, reference, shell, InputContext, markdownDOM().ownerDocument, value => { error = value; });
  assert.equal(shell.root._inputEvidenceLoaded, false);
  assert.match(error, /요청 행 범위/);
  stored.source.range = { startLine: 201, endLine: 239, totalLines: 300 };
  assert.throws(() => InputContext.inputEvidenceSnapshot(stored, reference), /요청 행 범위/);
});
// CORE_REVIEW_REGRESSIONS_END

test('File Card persistence retains opaque root/draft IDs but never caret, credentials or editor text', () => {
  const record = FileCard.fileCardRecord({ rootId: 'root', directoryId: 'dir', name: 'Selected', displayPath: '/private/path', selectionId: 'one-shot' }, {
    fileId: 'file', draftId: 'draft', bufferRevision: 2, savedRevision: 1, scrollTop: 50,
    text: 'do not put managed content in preferences', selectionStart: 4, active: true, password: 'never',
  });
  assert.deepEqual(record.root, { rootId: 'root', directoryId: 'dir', name: 'Selected' });
  assert.equal(record.draftId, 'draft');
  assert.equal(record.scrollTop, 50);
  for (const key of ['text', 'selectionStart', 'active', 'password', 'selectionId']) assert.equal(record[key], undefined);
});

test('File Card can restore managed draft without silently granting an expired folder handle', async () => {
  const calls = [];
  const view = {
    openRoot: async root => { calls.push(['root', root]); throw Object.assign(new Error('Reconnect folder'), { code: 'UNKNOWN_ROOT' }); },
    restoreDraft: async ids => { calls.push(['draft', ids]); },
    openFile: () => assert.fail('managed draft restoration must use its no-focus factory path'),
  };
  const record = { root: { rootId: 'old-root', directoryId: 'old-dir' }, fileId: 'old-file', draftId: 'saved-draft' };
  const result = await FileCard.restoreFileCard(view, record);
  assert.equal(result.rootRestored, false);
  assert.equal(result.draftRestored, true);
  assert.equal(result.errors[0].code, 'UNKNOWN_ROOT');
  assert.deepEqual(calls[1], ['draft', { draftId: 'saved-draft' }]);
  assert.deepEqual(record.root, { rootId: 'old-root', directoryId: 'old-dir' });
});

test('File close waits for the factory flush/dispose, coalesces clicks, and exposes a retry on failure', async () => {
  let complete, attempts = 0;
  const states = [];
  const gate = FileCard.createFileCloseGate({ dispose: () => { attempts++; return new Promise(resolve => { complete = resolve; }); }, onState: state => states.push(state) });
  const first = gate.requestClose(), second = gate.requestClose();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.equal(states.at(-1).status, 'closing');
  complete(false);
  assert.equal(await first, false);
  assert.equal(states.at(-1).status, 'blocked');
  const retry = gate.requestClose();
  await Promise.resolve();
  assert.equal(attempts, 2);
  complete(true);
  assert.equal(await retry, true);
  assert.equal(await gate.requestClose(), true);
  assert.equal(attempts, 2);
});

test('File close synchronous failures also release the gate for a working retry', async () => {
  let fail = true;
  const gate = FileCard.createFileCloseGate({ dispose: () => { if (fail) throw new Error('write failed'); return true; } });
  assert.equal(await gate.requestClose(), false);
  fail = false;
  assert.equal(await gate.requestClose(), true);
});

test('actual outer Card close leaves the window and cleanup intact until file flush succeeds', async () => {
  const body = surfaceSource.match(/  function closeCanvasCard\(card, cleanup\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(body);
  const close = compileFunction(body, ['card', 'cleanup', 'closeCanvasCard', 'isCardFullscreen', 'exitCardFullscreen', 'unregisterSourceRefCard', 'state', 'setActiveEntity', 'syncOntologyPresentationState', 'markAgendaDirty', 'boardNotice', 'console', 'TAG']);
  let removed = 0, cleaned = 0, allowed = false;
  const card = { id: 'file-card', _beforeClose: async () => allowed, _cleanup: () => cleaned++, remove: () => removed++ };
  const state = { activeEntityId: card.id };
  const run = (target, cleanup) => close(target, cleanup, run, () => false, () => {}, () => {}, state, () => {}, () => {}, () => {}, () => {}, { warn() {} }, 'test');
  assert.equal(await run(card), false);
  assert.equal(removed, 0);
  assert.equal(cleaned, 0);
  allowed = true;
  assert.equal(await run(card), true);
  assert.equal(removed, 1);
  assert.equal(cleaned, 1);
});

test('File UI transport forwards only the real picker nonce, not Engine identity or origin overrides', async () => {
  const body = surfaceSource.match(/  async function requestLocalFilePacket\(path, body, requestOptions = \{\}\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(body);
  const request = compileFunction(`return (async () => {${body}\n})();`, ['path', 'body', 'requestOptions', 'window', 'fetch']);
  const window = { AbortController, setTimeout: () => 1, clearTimeout() {} };
  const calls = [];
  const fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { rootId: 'opaque' } }) }; };
  const result = await request('/v1/files/roots', { selectionId: 'selected-by-helper' }, { headers: { 'X-EGDesk-Picker-Channel': 'actual-nonce' } }, window, fetch);
  assert.equal(result.result.rootId, 'opaque');
  assert.equal(calls[0].options.headers['X-EGDesk-Picker-Channel'], 'actual-nonce');
  assert.equal(calls[0].options.headers.Origin, undefined);
  assert.equal(calls[0].options.headers['Sec-Fetch-Site'], undefined);
  assert.equal(JSON.parse(calls[0].options.body).ownerScope, undefined);
  await assert.rejects(() => request('/v1/files/roots', {}, { headers: { Origin: 'null' } }, window, fetch), /허용되지 않은 파일 채널/);
});

test('File UI transport preserves sanitized native partial-file warning details', async () => {
  const body = surfaceSource.match(/  async function requestLocalFilePacket\(path, body, requestOptions = \{\}\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(body);
  const request = compileFunction(`return (async () => {${body}\n})();`, ['path', 'body', 'requestOptions', 'window', 'fetch']);
  const window = { AbortController, setTimeout: () => 1, clearTimeout() {} };
  const details = JSON.parse('{"warnings":[{"kind":"native-partial-file","name":"draft.txt"}],"__proto__":{"unsafe":true},"constructor":"unsafe"}');
  const fetch = async () => ({ ok: false, status: 409, json: async () => ({
    ok: false, code: 'NATIVE_PARTIAL_FILE', error: 'Partial native file remains', details,
  }) });
  await assert.rejects(() => request('/v1/files/save-as', {}, {}, window, fetch), error => {
    assert.equal(error.code, 'NATIVE_PARTIAL_FILE');
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { warnings: [{ kind: 'native-partial-file', name: 'draft.txt' }] });
    assert.equal(Object.hasOwn(error.details, '__proto__'), false);
    return true;
  });
});

test('production native File picker wrapper uses channel/begin/OS/complete/roots with one-shot IDs', async () => {
  const events = [];
  const service = createEGDeskFileServiceCallbacks({ request: async (path, body, options) => {
    events.push({ path, body, headers: options?.headers });
    if (path.endsWith('/channel')) return { ok: true, result: { token: 'channel-from-helper', expiresAt: Date.now() + 10000 } };
    assert.equal(options.headers['X-EGDesk-Picker-Channel'], 'channel-from-helper');
    if (path.endsWith('/begin')) return { ok: true, result: { requestId: 'request-from-helper' } };
    if (path.endsWith('/complete')) return { ok: true, result: { selectionId: 'selection-from-helper' } };
    assert.equal(path, '/v1/files/roots');
    assert.deepEqual(body, { selectionId: 'selection-from-helper' });
    return { ok: true, result: { rootId: 'root', directoryId: 'directory', name: 'Fixture' } };
  } });
  const picker = createEGDeskNativeFilePickers({ service, pickDirectory: async () => { events.push({ nativePicker: true }); return '/fixture/selected'; } });
  assert.deepEqual(await picker.chooseRoot(), { rootId: 'root', directoryId: 'directory', name: 'Fixture' });
  assert.deepEqual(events.map(event => event.path || 'native-picker'), ['/v1/files/picker/channel', '/v1/files/picker/begin', 'native-picker', '/v1/files/picker/complete', '/v1/files/roots']);
  assert.deepEqual(events[3].body, { requestId: 'request-from-helper', absolutePath: '/fixture/selected' });
});

test('native Save As callback cancels replacement instead of authorizing overwrite', async () => {
  const body = surfaceSource.match(/  function pickNativeFileSaveFile\(\{ defaultName = 'copy.txt' \} = \{\}\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(body);
  const choose = compileFunction(body, ['defaultName', 'Cc', 'Ci', 'window']);
  let result = 2;
  const picker = { init() {}, appendFilters() {}, file: { exists: () => result === 2, parent: { path: '/fixture/selected' }, leafName: 'copy.txt' }, open: callback => callback(result) };
  const Cc = { '@mozilla.org/filepicker;1': { createInstance: () => picker } };
  const Ci = { nsIFilePicker: { returnOK: 0, returnCancel: 1, returnReplace: 2, modeSave: 1, filterAll: 1 } };
  await assert.rejects(() => choose('copy.txt', Cc, Ci, {}), /기존 파일은 덮어쓰지 않습니다/);
  result = 1;
  assert.equal(await choose('copy.txt', Cc, Ci, {}), null);
  result = 0;
  assert.deepEqual(await choose('copy.txt', Cc, Ci, {}), { parentPath: '/fixture/selected', fileName: 'copy.txt' });
});

test('20KB attachment URLs retain exact source data while the picker constrains row and checkbox sizing', () => {
  const url = `https://example.test/long?payload=${'a_b'.repeat(7000)}`;
  const source = { ...browserInput(), sourceRef: { viewId: 'long-page', uri: url } };
  const snapshot = InputContext.inputSnapshot(source, { url, text: 'actual page content' });
  assert.equal(InputContext.inputSourceLocation(source), url);
  assert.equal(InputContext.captureAttachment(source, snapshot).sourceRef.url, url);
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  const row = css.match(/\.egd-input-source-choice \{([^}]+)\}/)?.[1];
  const checkbox = css.match(/\.egd-input-source-choice > input\[type="checkbox"\] \{([^}]+)\}/)?.[1];
  assert.match(row, /grid-template-columns:\s*18px minmax\(0, 1fr\)/);
  assert.match(row, /min-width:\s*0/);
  assert.match(checkbox, /min-width:\s*18px/);
  assert.match(css, /\.egd-input-source-choice small \{[^}]*white-space:\s*normal/);
});

test('production Browser actor registration admits Fission webIsolated and web/file families without privileged chrome scope', () => {
  const body = surfaceSource.match(/  function ensureBrowserAgentActor\(\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(body);
  let registration;
  const ensure = compileFunction(body, ['browserAgentActorReady', 'ChromeUtils', 'BROWSER_AGENT_ACTOR_NAME', 'console', 'TAG']);
  const api = { importESModule: () => ({ ActorManagerParent: { addJSWindowActors: value => { registration = value; } } }) };
  assert.equal(ensure(false, api, 'EGDeskBrowserAgentRuntime', { warn() {} }, 'test'), true);
  const options = registration.EGDeskBrowserAgentRuntime;
  assert.deepEqual(options.remoteTypes, ['web', 'file']);
  assert.equal(options.safeForUntrustedWebProcess, true);
  assert.equal(options.allFrames, false);
  assert.notEqual(options.includeChrome, true);
  assert.equal(options.child.events, undefined, 'explicit Card queries, not unnecessary automatic page events');
  for (const remoteType of ['web', 'webIsolated=http://127.0.0.1', 'webIsolated=https://example.test', 'webCOOP+COEP=https://example.test', 'file']) {
    assert.ok(options.remoteTypes.some(prefix => remoteType.startsWith(prefix)), remoteType);
  }
  for (const remoteType of ['parent', 'privilegedabout', 'extension']) assert.equal(options.remoteTypes.some(prefix => remoteType.startsWith(prefix)), false);
  assert.equal(surfaceSource.includes('dom.jsipc.check_safeForUntrustedWebProcess'), false, 'never disable the process safety preference');
});

test('production capture queries the bound WindowGlobal and surfaces type errors or mid-capture navigation', async () => {
  const body = surfaceSource.match(/    const browserAgentActorRequest = async \(method, payload = \{\}\) => \{([\s\S]*?)\n    \};/)?.[1];
  assert.ok(body);
  const request = compileFunction(`return (async () => {${body}\n})();`, ['method', 'payload', 'ensureBrowserAgentActor', 'xulBrowser', 'BROWSER_AGENT_ACTOR_NAME', 'card']);
  const card = { isConnected: true }, browser = { browsingContext: {} };
  const calls = [];
  const global = { getActor: name => ({ sendQuery: async (method, payload) => { calls.push({ name, method, payload }); return { text: 'real declared capture' }; } }) };
  browser.browsingContext.currentWindowGlobal = global;
  const result = await request('captureInput', { options: {} }, () => true, browser, 'EGDeskBrowserAgentRuntime', card);
  assert.equal(result.text, 'real declared capture');
  assert.deepEqual(calls, [{ name: 'EGDeskBrowserAgentRuntime', method: 'captureInput', payload: { options: {} } }]);
  global.getActor = () => { throw new Error("Window protocol doesn't match remote type 'webIsolated=http://127.0.0.1'"); };
  await assert.rejects(() => request('captureInput', {}, () => true, browser, 'Actor', card), /webIsolated/);
  global.getActor = () => ({ sendQuery: async () => { browser.browsingContext.currentWindowGlobal = {}; return { text: 'old page' }; } });
  await assert.rejects(() => request('captureInput', {}, () => true, browser, 'Actor', card), /changed during capture/);
  const readBody = surfaceSource.match(/    const readBrowserDocument = \(\) => \{([\s\S]*?)\n    \};/)?.[1];
  assert.ok(readBody);
  assert.equal(readBody.includes('selectedBrowser'), false, 'capture cannot silently read the globally selected native tab');
});

test('Browser child actor query handlers return promises for native sendQuery', async () => {
  const previous = globalThis.JSWindowActorChild;
  try {
    globalThis.JSWindowActorChild = class {};
    const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs');
    const actor = new EGDeskBrowserAgentRuntimeChild();
    actor.snapshot = () => ({ text: ['scoped document'] });
    const query = actor.receiveMessage({ name: 'snapshot', data: { options: {} } });
    assert.ok(query instanceof Promise);
    assert.deepEqual(await query, { text: ['scoped document'] });
  } finally {
    if (previous === undefined) delete globalThis.JSWindowActorChild;
    else globalThis.JSWindowActorChild = previous;
  }
});

// GLOBAL_CLEAR_TERMINAL_REGRESSIONS_BEGIN
test('public agenda.clearView retains live Terminal and session after failed termination, then retries confirmed close', async () => {
  const clearCanvas = surfaceSource.match(/  async function clearCanvasEntitiesForRestore\(\) \{([\s\S]*?)\n  \}/)?.[1];
  const clearView = surfaceSource.match(/  async function clearCurrentAgendaView\(options = \{\}\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(clearCanvas && clearView);
  assert.ok(surfaceSource.includes('clearView: clearCurrentAgendaView'));
  const bindPublicApi = compileFunction(`async function clearCanvasEntitiesForRestore() {${clearCanvas}\n}\nasync function clearCurrentAgendaView(options = {}) {${clearView}\n}\nreturn {clearView:clearCurrentAgendaView};`,
    ['state', 'document', 'unregisterSourceRefCard', 'exitCardFullscreen', 'syncViewportAgendaRail', 'refreshDeskMinimap', 'boardNotice']);
  for (const failure of [false, new Error('KILL_FAILED'), { exited: true, exitConfirmed: false }]) {
    let confirmed = false, cleanupCalls = 0, closeCalls = 0, removed = false, refreshes = 0;
    let sessionId = 'actual-session-fixture';
    const terminal = { id: 'terminal', _closeOwnedRuntime: async () => {
      closeCalls++;
      if (confirmed) return true;
      if (failure instanceof Error) throw failure;
      return failure;
    }, _cleanup: () => { cleanupCalls++; sessionId = null; }, remove: () => { removed = true; } };
    const state = { cardFullscreen: { cardId: 'terminal' }, sourceRefs: { cardsByKey: { terminal: 'terminal' } }, activeEntityId: 'terminal',
      codex: { chatCardEntityId: null, chatDockMode: 'hud' }, agenda: { suppressDirty: false, dirty: true, dirtyReasons: ['work'] } };
    const notices = [];
    const api = bindPublicApi(state, { querySelectorAll: selector => selector === '.egd-canvas-card' && !removed ? [terminal] : [] },
      card => { delete state.sourceRefs.cardsByKey[card.id]; }, () => { state.cardFullscreen = null; }, () => { refreshes++; }, () => {}, message => notices.push(message));
    assert.equal(await api.clearView(), false);
    assert.equal(removed, false);
    assert.equal(cleanupCalls, 0, 'cleanup must not clear the session reference or issue an unconfirmed kill');
    assert.equal(sessionId, 'actual-session-fixture');
    assert.equal(state.sourceRefs.cardsByKey.terminal, 'terminal');
    assert.equal(state.activeEntityId, 'terminal');
    assert.equal(state.cardFullscreen.cardId, 'terminal');
    assert.equal(state.agenda.dirty, true);
    assert.equal(state.agenda.suppressDirty, false);
    assert.ok(notices.length);
    confirmed = true;
    assert.equal(await api.clearView(), true);
    assert.equal(closeCalls, 2);
    assert.equal(cleanupCalls, 1);
    assert.equal(removed, true);
    assert.equal(sessionId, null);
    assert.equal(state.activeEntityId, null);
    assert.equal(state.agenda.dirty, false);
    assert.equal(refreshes, 2);
  }
});
// GLOBAL_CLEAR_TERMINAL_REGRESSIONS_END

test('snapshot inspector keeps concise source/delivery labels and folds paths, hashes and caveats', () => {
  const snapshot = { id: 'source', label: 'Report', capturedAt: 1, hash: 'whole-hash', rangeHash: 'page-hash', storedRole: 'source',
    sourceRef: { path: '/private/long/source.txt' }, range: { startLine: 1, endLine: 200, totalLines: 610 },
    content: { text: 'exact source\nbytes', truncated: true, boundary: 'declared capture scope' },
    delivered: { packetId: 'packet', hash: 'delivered-hash', text: '{"exact":"payload"}', mode: 'reader', binding: { runId: 'run', answerId: 'answer' } } };
  const root = markdownDOM();
  const rendered = InputContext.inputSnapshotView(root.ownerDocument, snapshot);
  const visibleParagraphs = rendered.children.filter(child => child.tag === 'p').map(child => child.textContent);
  assert.deepEqual(visibleParagraphs, ['원문 캡처 · 1–200 / 610행 · 일부 캡처']);
  const sourceDetails = rendered.all('details').find(child => child.attributes['data-testid'] === 'chat-input-source-details');
  assert.equal(sourceDetails.attributes.open, undefined);
  assert.ok(sourceDetails.textContent.includes('/private/long/source.txt'));
  assert.ok(sourceDetails.textContent.includes('whole-hash'));
  assert.ok(sourceDetails.textContent.includes('완독 여부는 별개'));
  const delivery = rendered.all('details').find(child => child.attributes['data-testid'] === 'chat-input-delivery');
  assert.equal(delivery.attributes.open, undefined);
  assert.equal(delivery.children[0].textContent, '전달된 입력 보기');
  assert.ok(rendered.all('pre').some(child => child.textContent === snapshot.content.text));
  assert.ok(rendered.all('pre').some(child => child.textContent === snapshot.delivered.text));
});

test('production inspector pagination is outside the sole scroll body and makes no camera or model request', async () => {
  const code = surfaceSource.match(/      async inspectInput\(threadId, reference, options = \{\}\) \{([\s\S]*?)\n      \},/)?.[1];
  assert.ok(code);
  const inspect = compileFunction(`return (async () => {${code}\n})();`, ['threadId', 'reference', 'options', 'getCodexThreadById', 'state', 'InputContext', 'openChatInputPanel', 'el', 'document']);
  const panel = markdownDOM(), body = panel.ownerDocument.createElement('div');
  const doc = panel.ownerDocument;
  const el = (tag, props = {}, ...children) => {
    const node = doc.createElement(tag); node.focus = () => {};
    for (const [key, value] of Object.entries(props)) {
      if (key === 'data') for (const [name, val] of Object.entries(value)) node.setAttribute(`data-${name}`, val);
      else if (key === 'onclick') node.addEventListener('click', value);
      else if (value != null) node.setAttribute(key, value);
    }
    for (const child of children) if (child != null) node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
    return node;
  };
  const response = { capture: { sourceId: 's', hash: 'h', capturedAt: 1, sourceRef: {}, captureScope: { type: 'file' } },
    source: { role: 'source', hash: 'h', rangeHash: 'r', mime: 'text/plain', text: 'immutable', range: { startLine: 1, endLine: 200, totalLines: 610 }, nextLine: 201 }, delivered: null, bindings: [] };
  let reads = 0;
  await inspect.call({ readInput: async () => { reads++; return response; } }, 'thread', { sourceId: 's', snapshotId: 's', hash: 'h' }, {},
    () => ({ id: 'thread' }), { codex: {} }, InputContext, () => panel.appendChild(body), el,
    { getElementById: () => panel, querySelector: () => body });
  assert.equal(reads, 1);
  assert.equal(panel.children.filter(child => child.tag === 'nav').length, 1);
  assert.equal(body.children.some(child => child.tag === 'nav'), false);
  assert.equal(body.children[0].tag, 'details', 'advanced packet lookup is folded');
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  assert.match(css, /\.egd-codex-input-panel-footer \{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /\.egd-input-snapshot pre \{[^}]*max-height:\s*none;\s*overflow:\s*visible/);
});
