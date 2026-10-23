import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertFreshAccountRoom, assertNativeTerminalExit, assertOrdinarySend, assertPlainRenderedMessage, assertRealTurnArtifact, ChatProtocolProbe, recoveryMarkerMatches } from './egdesk-chat-qa-contract.sys.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';

const streamId = 'stream-fixture';
test('recovery oracle recognizes normalized Browser scope without a discarded resourceId', () => {
  const marker = 'qa-recovery-new-corrupt';
  const normalized = { kind: 'browser-url', scope: marker, uri: 'about:blank' };
  assert.equal(recoveryMarkerMatches(normalized, marker), true);
  assert.equal(recoveryMarkerMatches({ ...normalized, scope: 'qa-recovery', resourceId: marker }, marker), false);
  assert.equal(recoveryMarkerMatches({ ...normalized, scope: 'qa-recovery-new-partial' }, marker), false);
  assert.equal(recoveryMarkerMatches({ ...normalized, uri: 'https://example.invalid' }, marker), false);
  assert.equal(recoveryMarkerMatches({ ...normalized, kind: 'file' }, marker), false);
});

function event(seq, kind, { requestId = 'request-a', clientThreadId = 'thread-a',
  conversationId = 'conversation-a', runId = 'run-a', details = {}, itemId } = {}) {
  return { type: 'chat.event', v: 2, provider: 'codex', event: kind,
    streamId, seq, ts: Date.now(), requestId, clientThreadId,
    conversationId, runId, answerId: `${conversationId}/${runId}`, ...(itemId ? { itemId } : {}), details };
}

test('ordinary Codex send omits persona fields unless profileEnabled', () => {
  assert.equal(assertOrdinarySend({ message: 'hello', cwd: '/tmp/test' }), true);
  assert.equal(assertOrdinarySend({ message: 'ordinary again', profileEnabled: false }), true);
  assert.throws(() => assertOrdinarySend({ message: 'hello', systemPrompt: 'forced' }), /persona fields/);
  assert.equal(assertOrdinarySend({ message: 'hello', profileEnabled: true, systemPrompt: 'explicit' }), true);
});

test('rendered fixture oracle preserves raw bytes and all visible line content', () => {
  const raw = 'First line.\nSecond line.\nQA-LIVE-INCREMENT\n';
  assert.equal(assertPlainRenderedMessage(raw, raw, 'First line.\nSecond line.\nQA-LIVE-INCREMENT'), true);
  assert.throws(() => assertPlainRenderedMessage(raw, raw.trim(), raw), /raw message/);
  assert.throws(() => assertPlainRenderedMessage(raw, raw, 'First line.Second line.QA-LIVE-INCREMENT'), /Rendered/);
  assert.throws(() => assertPlainRenderedMessage(raw, raw, 'Second line.\nFirst line.\nQA-LIVE-INCREMENT'), /Rendered/);
  assert.throws(() => assertPlainRenderedMessage('QA_LIVE_INCREMENT\n', 'QA_LIVE_INCREMENT\n', 'QALIVEINCREMENT'), /Rendered/);
});

test('account-switch oracle requires the explicit fresh room rather than sending from a held transcript', () => {
  const previous = { localThreadId: 'room-a', wireClientThreadId: 'wire-a' };
  const fresh = { localThreadId: 'room-b', wireClientThreadId: 'wire-b', conversationId: null,
    messageCount: 0, bindingHeld: false, profileEnabled: false };
  assert.equal(assertFreshAccountRoom(previous, fresh), true);
  assert.throws(() => assertFreshAccountRoom(previous, { ...fresh, localThreadId: 'room-a' }), /fresh empty/);
  assert.throws(() => assertFreshAccountRoom(previous, { ...fresh, bindingHeld: true }), /retained native/);
  assert.throws(() => assertFreshAccountRoom(previous, { ...fresh, conversationId: 'old-native' }), /retained native/);
  assert.throws(() => assertFreshAccountRoom(previous, { ...fresh, messageCount: 1 }), /fresh empty/);
});

test('SSE before POST correlates once; messages do not complete runs; stop request is not interruption', () => {
  const probe = new ChatProtocolProbe();
  probe.ingest(event(1, 'run.started'));
  probe.ingest(event(2, 'message.started', { details: { messageId: 'message-a' } }));
  probe.ingest(event(3, 'message.delta', { details: { messageId: 'message-a', delta: 'ordinary text /tmp/not-an-artifact' } }));
  probe.ingest(event(4, 'message.completed', { details: { messageId: 'message-a' } }));
  const linked = probe.linkPost({ accepted: true, conversationId: 'conversation-a', requestId: 'request-a',
    runId: 'run-a', answerId: 'conversation-a/run-a' }, { clientThreadId: 'thread-a' });
  assert.equal(linked.status, 'running');
  assert.equal(linked.messages['message-a'].status, 'completed');
  assert.deepEqual(linked.artifacts, []);
  assert.deepEqual(probe.ingest(event(4, 'message.completed', { details: { messageId: 'message-a' } })),
    { accepted: false, reason: 'duplicate-seq' });
  probe.ingest(event(5, 'run.stop_requested'));
  assert.equal(probe.byRun('run-a').stopRequested, true);
  assert.equal(probe.byRun('run-a').status, 'running');
  probe.ingest(event(6, 'run.completed', { details: { status: 'interrupted' } }));
  assert.equal(probe.byRun('run-a').status, 'interrupted');
});

test('two client threads stay isolated and a mismatched POST cannot steal an early SSE run', () => {
  const probe = new ChatProtocolProbe();
  probe.ingest(event(1, 'run.started'));
  probe.ingest(event(2, 'run.started', { requestId: 'request-b', clientThreadId: 'thread-b',
    conversationId: 'conversation-b', runId: 'run-b' }));
  assert.deepEqual(probe.byThread('thread-a').map((run) => run.runId), ['run-a']);
  assert.deepEqual(probe.byThread('thread-b').map((run) => run.runId), ['run-b']);
  assert.throws(() => probe.linkPost({ accepted: true, conversationId: 'conversation-b', requestId: 'request-a',
    runId: 'run-b', answerId: 'conversation-b/run-b' }, { clientThreadId: 'thread-a' }), /early SSE request/);
  assert.throws(() => probe.ingest(event(3, 'message.delta', { clientThreadId: 'thread-b',
    details: { messageId: 'message-a', delta: 'leak' } })), /correlation mismatch/);
});

test('the probe admits known engines only: Codex always, listed engines by engineId', () => {
  const probe = new ChatProtocolProbe();
  assert.equal(probe.ingest({ ...event(1, 'run.started'), engineId: 'codex' }).accepted, true);
  assert.throws(() => probe.ingest({ ...event(2, 'run.started', { runId: 'run-b' }), engineId: 'claude' }), /known engine/);
  assert.throws(() => probe.ingest({ ...event(3, 'run.started', { runId: 'run-c' }), provider: 'other' }), /known engine/);
  assert.throws(() => probe.ingest({ ...event(4, 'run.started', { runId: 'run-d' }), engineId: null }), /known engine/,
    'an explicit invalid engineId is not read as the provider');
  const listed = new ChatProtocolProbe({ engineIds: ['codex', 'claude'] });
  assert.equal(listed.ingest({ ...event(1, 'run.started', { runId: 'run-b' }), engineId: 'claude' }).accepted, true);
  assert.equal(listed.ingest(event(2, 'run.started')).accepted, true, 'an older provider-only Codex envelope still counts');
});

test('runtime loss is failed/offline evidence, not a completed stop', () => {
  const probe = new ChatProtocolProbe();
  probe.ingest(event(1, 'run.started'));
  probe.ingest(event(2, 'run.unavailable', { details: { error: { code: 'RUNTIME_LOST' } } }));
  assert.equal(probe.byRun('run-a').status, 'failed');
  assert.equal(probe.byRun('run-a').error.code, 'RUNTIME_LOST');
  assert.equal(probe.byRun('run-a').stopRequested, false);
});

test('approval acknowledgement only marks replySent until approval.resolved arrives', () => {
  const probe = new ChatProtocolProbe();
  probe.ingest(event(1, 'run.started'));
  probe.ingest(event(2, 'approval.required', { details: { approval: {
    approvalId: 'approval-a', kind: 'fileChange', status: 'pending', choices: ['decline', 'cancel'],
    itemId: 'file-a', reason: 'QA only', paths: ['/tmp/proposed-but-not-created.txt'],
  } } }));
  const response = { accepted: true, approvalId: 'approval-a', conversationId: 'conversation-a', runId: 'run-a', status: 'replySent' };
  const replied = probe.markApprovalReply(response);
  assert.equal(replied.pendingApprovals[0].status, 'replySent');
  assert.equal(replied.status, 'running');
  assert.deepEqual(replied.artifacts, []);
  assert.throws(() => probe.markApprovalReply(response), /STALE_APPROVAL/);
  probe.ingest(event(3, 'approval.resolved', { details: { approvalId: 'approval-a' } }));
  assert.equal(probe.byRun('run-a').pendingApprovals.length, 0);
  assert.equal(probe.byRun('run-a').status, 'running');
});

test('an artifact must be a structured, stat-verified reference inside a dedicated test root', (t) => {
  const source = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-loader-fixture-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `unit ${name}`);
  const { profile, realTurnCwd: root } = bootstrapQaProfile({ loaderSource: source });
  t.after(() => {
    for (const [directory, prefix] of [[profile, 'egdesk-chat-test-'], [source, 'egdesk-loader-fixture-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot());
      assert.ok(path.basename(directory).startsWith(prefix));
      fs.rmSync(directory, { recursive: true, force: false });
    }
  });
  const file = path.join(root, 'harmless.txt');
  fs.writeFileSync(file, 'QA only\n', { mode: 0o600 });
  const artifact = { id: 'artifact-a', type: 'file', target: { path: file }, label: 'harmless.txt',
    status: 'available', conversationId: 'conversation-a', runId: 'run-a', answerId: 'conversation-a/run-a',
    sourceItemId: 'message-a', relation: 'referenced', verifiedAt: new Date().toISOString() };
  assert.equal(assertRealTurnArtifact(profile, artifact), file);
  assert.throws(() => assertRealTurnArtifact(profile, { ...artifact, relation: 'created' }), /explicit/);
  assert.throws(() => assertRealTurnArtifact(profile, { ...artifact, target: { path: '/tmp/something-else' } }));
});

test('native Terminal acceptance rejects missing sessions and kill acknowledgements', () => {
  const receipt = { sessionId: 'term-unit', status: 'EXITED', exited: true, exitConfirmed: true,
    exitSource: 'pty.onExit', exitedAt: 1700000000000, exitCode: 0 };
  assert.equal(assertNativeTerminalExit(receipt, 'term-unit'), true);
  assert.throws(() => assertNativeTerminalExit({ ok: true, sessionId: 'term-unit', status: 'STOP_REQUESTED' }, 'term-unit'));
  assert.throws(() => assertNativeTerminalExit({ ...receipt, error: 'Session not found' }, 'term-unit'));
  assert.equal(assertNativeTerminalExit({ ...receipt, exitSource: 'process.exit' }, 'term-unit'), true);
  assert.throws(() => assertNativeTerminalExit({ ...receipt, exitSource: 'registry-delete' }, 'term-unit'));
  assert.throws(() => assertNativeTerminalExit({ ...receipt, status: 'UNKNOWN', exitConfirmed: false }, 'term-unit'));
});
