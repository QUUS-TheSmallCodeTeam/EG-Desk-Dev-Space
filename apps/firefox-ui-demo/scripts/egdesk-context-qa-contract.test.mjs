import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertBriefingTargets, assertContextCaptureBatch, assertContextEventIdentity, assertContextSendBindings,
  assertFrozenFileReadAfterMutation, assertImmutableContextRead, captureContextReadEvidence,
  assertPublishedBriefing, assertStoredAgentDelivery, fingerprintQaBytes, observeQaFixtureFile, readContextInspectionPage,
  assertContextSourceChangeScope, contextSourceChangeResponse, assertContextSourceChangePanel,
  assertContextSourceRequest, classifyContextSourceTerminal, assertBriefingCommentList,
  assertBriefingCommentSaved, assertBriefingCommentDraft, assertBriefingCommentStore,
  assertBriefingCommentReceipt, assertBriefingCommentGetDelta, summarizeBriefingCommentGetDelta,
  assertBriefingPanelInvariant, planBriefingPanelWheel } from './egdesk-context-qa-contract.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';

// Synthetic metadata tests QA oracles only, never production capture/tool handling.
const metadata = (file = '/unused/qa.txt') => ({ id: 'attachment-A', sourceId: 'source-A', snapshotId: 'source-A',
  hash: 'server-opaque-hash', capturedAt: 1700000000000, captureScope: { type: 'file' }, truncated: false,
  sourceRef: { kind: 'file', resourceId: 'resource-A', path: file, revision: 1 },
  shape: { mime: 'text/plain', coverage: 'full' } });

function inspection(capture, text, { startLine = 1, totalLines = text.split('\n').length, delivered = null, bindings = [] } = {}) {
  const endLine = startLine + text.split('\n').length - 1;
  return { capture, source: { role: 'source', mime: 'text/plain', hash: capture.hash,
    rangeHash: fingerprintQaBytes(text).sha256, text, range: { startLine, endLine, totalLines },
    nextLine: endLine < totalLines ? endLine + 1 : null }, delivered, bindings };
}

const evidence = (capture, text) => captureContextReadEvidence(inspection(capture, text));

const sourceScope = () => ({ owner: 'codex:fixture:owner-A', engineId: 'codex', engineProfileId: 'codex-default',
  clientThreadId: 'wire-A', conversationId: 'conversation-A', sourceId: 'source-A' });

function sourceChangeSample(state = 'active', reason = null, changedAt = null) {
  const scope = sourceScope(), packetText = JSON.stringify({ fixtureOnly: true, selected: 'stored bounded excerpt' });
  const binding = { conversationId: scope.conversationId, runId: 'run-A', answerId: `${scope.conversationId}/run-A` };
  const packet = { role: 'agent_input', packetId: 'packet-A', mime: 'application/json', text: packetText,
    hash: fingerprintQaBytes(packetText).sha256, mode: 'fixture-only', coverage: { sourceId: scope.sourceId },
    deliveryStatus: 'sent-to-app-server', binding };
  const snapshot = captureContextReadEvidence(inspection(metadata(), 'immutable source\nsecond line', {
    delivered: packet, bindings: [{ bindingId: 'binding-A', ...binding }],
  }));
  const labels = { loading: '원본 변경 정보 확인 중', active: '추적 범위에서 감지된 변경 없음',
    missing: '변경 추적 기록 없음 · 최신 여부 미확인', failed: '원본 변경 정보를 확인하지 못했습니다',
    fileChanged: '캡처 후 파일 변경 감지', navigated: '캡처 후 브라우저 페이지 이동 감지', unknown: '캡처 후 원본 변경 감지' };
  const panel = { exists: true, scope, sourceId: scope.sourceId, statusSourceId: scope.sourceId,
    statusConversationId: scope.conversationId, state, reason, statusCount: 1, statusReadable: true,
    placedBetweenSourceAndDelivery: true, statusText: labels[state === 'stale' ? reason : state]
      + (changedAt === null ? '' : ' · 감지 시각 fixture-localized-time'),
    changedAt: changedAt === null ? null : new Date(changedAt).toISOString(), sourceLabel: '원문 캡처 · 1–2 / 2행',
    sourceText: snapshot.source.text, sourceMetadata: `캡처 hash: ${snapshot.capture.hash}`, packetId: packet.packetId,
    sourceHashes: [snapshot.capture.hash], rangeHashes: [snapshot.source.rangeHash],
    packetMetadataValues: [{ mode: packet.mode, packetId: packet.packetId, hash: packet.hash }],
    packetText, packetMetadata: `hash ${packet.hash}` };
  return { panel, expected: { scope, state, reason, changedAt, snapshot } };
}

test('CTX04 source status uses exact owner/engine/profile/thread/conversation/source, never another engine or first-row fallback', () => {
  const scope = sourceScope();
  assert.equal(assertContextSourceChangeScope({ ...scope }, scope), true);
  for (const key of Object.keys(scope)) assert.throws(() => assertContextSourceChangeScope({ ...scope, [key]: 'foreign' }, scope), /crossed/);
  assert.throws(() => assertContextSourceChangeScope({ ...scope, engineId: 'claude' }, { ...scope, engineId: 'claude' }), /never falls back/);
  const response = { conversationId: scope.conversationId, sources: [
    { sourceId: 'other', state: 'active', path: '/same/file', viewId: 'same-view' },
    { sourceId: scope.sourceId, state: 'stale', reason: 'fileChanged', changedAt: 1700000000000 },
  ] };
  assert.deepEqual(contextSourceChangeResponse(response, scope), { state: 'stale', reason: 'fileChanged', changedAt: 1700000000000 });
  assert.throws(() => contextSourceChangeResponse({ ...response, conversationId: 'conversation-B' }, scope), /crossed conversation/);
  assert.throws(() => contextSourceChangeResponse({ ...response, sources: [...response.sources, response.sources[1]] }, scope), /exactly one/);
});

test('CTX04 the same capture can be stale in A and active in B; missing/evicted/restarted tracking never becomes freshness', () => {
  const a = sourceScope(), b = { ...a, clientThreadId: 'wire-B', conversationId: 'conversation-B' };
  assert.equal(contextSourceChangeResponse({ conversationId: a.conversationId,
    sources: [{ sourceId: a.sourceId, state: 'stale', reason: 'navigated', changedAt: 1700000000000 }] }, a).state, 'stale');
  assert.deepEqual(contextSourceChangeResponse({ conversationId: b.conversationId,
    sources: [{ sourceId: a.sourceId, state: 'active' }] }, b), { state: 'active', reason: null, changedAt: null });
  for (const sources of [[], [{ sourceId: 'foreign', state: 'active', viewId: 'same-view', path: '/same/file' }]]) {
    assert.deepEqual(contextSourceChangeResponse({ conversationId: a.conversationId, sources }, a), { state: 'missing', reason: null, changedAt: null });
  }
  const unknown = contextSourceChangeResponse({ conversationId: a.conversationId,
    sources: [{ sourceId: a.sourceId, state: 'stale', reason: 'unrecognized', changedAt: NaN }] }, a);
  assert.deepEqual(unknown, { state: 'stale', reason: 'unknown', changedAt: null });
});

test('CTX04 loading/active/stale/missing/failed status is separate from immutable body/hash/range and exact stored payload', () => {
  const before = sourceChangeSample('loading').panel;
  for (const [state, reason, changedAt] of [['loading', null, null], ['active', null, null], ['missing', null, null], ['failed', null, null],
    ['stale', 'fileChanged', 1700000000000], ['stale', 'navigated', 1700000001000], ['stale', 'unknown', null]]) {
    const { panel, expected } = sourceChangeSample(state, reason, changedAt);
    assert.equal(assertContextSourceChangePanel(panel, { ...expected, before }), true);
  }
  const { panel, expected } = sourceChangeSample();
  for (const [key, value] of [['sourceText', 'new live body'], ['sourceMetadata', 'new hash'], ['packetText', '{}'],
    ['packetId', 'new-packet'], ['sourceId', 'another-source'], ['sourceLabel', 'changed range'], ['packetMetadata', 'new delivery hash']]) {
    assert.throws(() => assertContextSourceChangePanel({ ...panel, [key]: value }, { ...expected, before }));
  }
  assert.throws(() => assertContextSourceChangePanel({ ...panel, statusText: '최신 원본입니다' }, expected), /wording/);
});

test('CTX04 crossed packet binding, stale detection time, duplicate/unpainted or misplaced line is never accepted', () => {
  const { panel, expected } = sourceChangeSample('stale', 'fileChanged', 1700000000000);
  for (const change of [{ changedAt: new Date(1700000000001).toISOString() }, { statusCount: 2 }, { statusReadable: false },
    { placedBetweenSourceAndDelivery: false }, { statusConversationId: 'conversation-B' }, { exists: false }]) {
    assert.throws(() => assertContextSourceChangePanel({ ...panel, ...change }, expected));
  }
  const snapshot = structuredClone(expected.snapshot);
  snapshot.delivered.binding = { ...snapshot.delivered.binding, conversationId: 'conversation-B', answerId: 'conversation-B/run-A' };
  snapshot.bindings = [{ bindingId: 'binding-B', ...snapshot.delivered.binding }];
  assert.throws(() => assertContextSourceChangePanel(panel, { ...expected, snapshot }), /packet binding/);
  assert.throws(() => assertContextSourceChangePanel({ ...panel, scope: { ...panel.scope, conversationId: 'conversation-B' } }, expected), /crossed/);
});

test('review reproduction: an initially wrong range or delivery hash is rejected against the store, not frozen as the UI oracle', () => {
  const { panel, expected } = sourceChangeSample();
  for (const patch of [{ sourceLabel: '원문 캡처 · 201–240 / 610행' }, { sourceHashes: ['wrong'] }, { rangeHashes: ['wrong'] },
    { packetMetadataValues: [{ ...panel.packetMetadataValues[0], hash: 'wrong-payload-hash' }] }]) {
    const wrong = { ...panel, ...patch };
    assert.throws(() => assertContextSourceChangePanel(wrong, { ...expected, before: wrong }), /range|hash|metadata/);
  }
});

test('exact source terminal receipts distinguish peer-close from server finish, never UI callback delivery', () => {
  const { owner, ...route } = sourceScope();
  const before = { holdId: 'hold-A', requestId: 'request-A', R: route, account: 'a', epoch: 0, heldSourceId: route.sourceId,
    armedAt: 10, deadlineAt: 9000, receivedAt: 20, snapshotHash: 'a'.repeat(64), releaseAttempts: 0,
    writeAttempted: false, terminalCause: null, finishAt: null, closeAt: null, endReturnedAt: null, writableFinishedAtClose: null };
  assert.deepEqual(assertContextSourceRequest(before, { route, account: 'a', holdId: 'hold-A' }), before);
  const finished = { ...before, releaseAttemptAt: 60, releaseAttempts: 1, writeAttempted: true, responseStatus: 200,
    endReturnedAt: 61, finishAt: 462, terminalCause: 'finished' };
  const aborted = { ...before, releaseAttemptAt: 60, releaseAttempts: 1, closeAt: 40,
    writableFinishedAtClose: false, terminalCause: 'peer-close-before-finish' };
  const options = after => ({ actionStartedAt: 30, actionFinishedAt: 50, release: { httpStatus: after.writeAttempted ? 200 : 409,
    body: { ok: after.writeAttempted, ...(after.writeAttempted ? {} : { code: 'QA_SOURCE_RESPONSE_ALREADY_CLOSED' }), receipt: structuredClone(after) } } });
  assert.equal(classifyContextSourceTerminal(before, finished, options(finished)), 'serverResponseFinished');
  assert.equal(classifyContextSourceTerminal(before, aborted, options(aborted)), 'transportAborted');
  for (const change of [{ requestId: null }, { terminalCause: 'peer-close-before-finish' }, { receivedAt: null }, { snapshotHash: null }]) {
    assert.throws(() => assertContextSourceRequest({ ...before, ...change }, { route, account: 'a', holdId: 'hold-A' }));
  }
  for (const patch of [{ finishAt: null }, { requestId: 'another' }, { account: 'b' }, { epoch: 1 }, { snapshotHash: 'b'.repeat(64) },
    { R: { ...route, conversationId: 'foreign' } }, { terminalCause: 'expiry' }, { terminalCause: 'server-close' },
    { terminalCause: 'account-change' }, { terminalCause: 'write-error' }]) {
    assert.throws(() => classifyContextSourceTerminal(before, { ...finished, ...patch }, options({ ...finished, ...patch })));
  }
  assert.throws(() => classifyContextSourceTerminal(before, { ...aborted, writeAttempted: true }, options(aborted)));
  assert.throws(() => classifyContextSourceTerminal(before, { ...aborted, closeAt: 25 }, options(aborted)));
  const missing = options(aborted); missing.release.body.code = 'QA_SOURCE_RESPONSE_NOT_HELD';
  assert.throws(() => classifyContextSourceTerminal(before, aborted, missing));
});

function fixture(t) {
  const source = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-loader-fixture-'));
  const owned = [[source, 'egdesk-loader-fixture-']];
  t.after(() => {
    for (const [directory, prefix] of owned.reverse()) {
      assert.equal(path.dirname(directory), canonicalTempRoot());
      assert.ok(path.basename(directory).startsWith(prefix));
      assert.equal(fs.realpathSync.native(directory), directory);
      fs.rmSync(directory, { recursive: true, force: false });
    }
  });
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), 'unit loader only\n');
  const profile = bootstrapQaProfile({ loaderSource: source }).profile;
  owned.push([profile, 'egdesk-chat-test-']);
  return { profile, root: path.join(profile, 'qa-fixtures'), source };
}

test('QA byte fingerprints retain exact UTF-8/newlines without retaining content', () => {
  const text = 'QA_원문\n';
  const bytes = Buffer.from(text);
  const original = fingerprintQaBytes(bytes);
  assert.deepEqual(original, fingerprintQaBytes(text));
  assert.equal(original.byteLength, Buffer.byteLength(text));
  assert.notEqual(original.sha256, fingerprintQaBytes(text.trim()).sha256);
  bytes.fill(0);
  assert.deepEqual(original, fingerprintQaBytes(text));
  assert.deepEqual(Object.keys(original).sort(), ['byteLength', 'sha256']);
  assert.throws(() => fingerprintQaBytes({ text }), /explicit UTF-8/);
});

test('file evidence is bound to the guarded manifest, not caller-selected roots or symlinks', t => {
  const { profile, root, source } = fixture(t);
  const file = path.join(root, 'original.txt');
  fs.writeFileSync(file, 'original\n', { mode: 0o600 });
  assert.deepEqual(observeQaFixtureFile(profile, file), { path: file, ...fingerprintQaBytes('original\n') });
  assert.throws(() => observeQaFixtureFile(profile, path.join(source, LOADER_FILES[0])), /manifest fixture root/);
  assert.throws(() => observeQaFixtureFile(profile, root), /manifest fixture root/);
  fs.symlinkSync(file, path.join(root, 'file-link'));
  assert.throws(() => observeQaFixtureFile(profile, path.join(root, 'file-link')), /canonical/);
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'file.txt'), 'nested');
  fs.symlinkSync(nested, path.join(root, 'directory-link'));
  assert.throws(() => observeQaFixtureFile(profile, path.join(root, 'directory-link', 'file.txt')), /canonical/);
  fs.chmodSync(file, 0o622);
  assert.throws(() => observeQaFixtureFile(profile, file), /writable/);
});

test('capture observations copy metadata and keep server hashes distinct from QA byte hashes', () => {
  const input = metadata();
  const observed = evidence(input, 'original\n');
  input.sourceRef.revision = 2;
  assert.equal(observed.capture.sourceRef.revision, 1);
  assert.equal(observed.capture.hash, 'server-opaque-hash');
  assert.equal(observed.source.rangeHash, fingerprintQaBytes('original\n').sha256);
  assert.equal(observed.delivered, null);
  assert.throws(() => { observed.capture.sourceRef.revision = 2; }, TypeError);
  assert.throws(() => evidence({ ...metadata(), snapshotId: '' }, 'x'), /snapshotId/);
  assert.throws(() => evidence({ ...metadata(), captureScope: { type: 'guessed' } }, 'x'), /Unknown capture/);
  assert.throws(() => evidence({ snapshotId: 'legacy', contentHash: 'legacy', source: {} }, 'x'), /attachment id/);
});

test('batch v1 receipts correlate attachment IDs and reject the superseded single-source request', () => {
  const request = { clientThreadId: 'wire-A', attachments: [{ id: 'attachment-A', kind: 'file', label: 'QA file',
    sourceRef: { path: '/unused/qa.txt' }, capturedAt: 1700000000000, captureScope: { type: 'file' } }] };
  const response = { captures: [metadata()] };
  assert.equal(assertContextCaptureBatch(request, response), true);
  assert.throws(() => assertContextCaptureBatch({ clientThreadId: 'wire-A', source: { kind: 'file' } }, response), /Batch attachments/);
  assert.throws(() => assertContextCaptureBatch(request, { captures: [{ ...metadata(), id: 'foreign-attachment' }] }), /exact requested/);
  assert.throws(() => assertContextCaptureBatch(request, { captures: [{ ...metadata(), snapshotId: 'different' }] }), /alias/);
  assert.throws(() => assertContextCaptureBatch(request, { captures: [] }), /exact requested/);
  const browser = { ...request.attachments[0], kind: 'browser', captureScope: { type: 'selection', locator: 'qa-selection' },
    sourceRef: { url: 'about:blank', viewId: 'qa-view' }, content: { mime: 'text/plain', text: 'selected QA text', truncated: false } };
  assert.equal(assertContextCaptureBatch({ ...request, attachments: [browser] },
    { captures: [{ ...metadata(), sourceRef: browser.sourceRef, captureScope: browser.captureScope }] }), true);
});

test('attachment send oracle rejects cross-thread, reordered, duplicate or extra snapshot bindings', () => {
  const expected = { clientThreadId: 'wire-A-not-local-room-A', sourceIds: ['source-A', 'source-B'] };
  const body = { clientThreadId: expected.clientThreadId, contextSnapshotIds: [...expected.sourceIds],
    contextCapabilities: { read: true, reader: true, publishBriefing: true } };
  assert.equal(assertContextSendBindings(body, expected), true);
  assert.throws(() => assertContextSendBindings({ ...body, clientThreadId: 'wire-B' }, expected), /owner/);
  assert.throws(() => assertContextSendBindings({ ...body, contextSnapshotIds: ['source-B', 'source-A'] }, expected), /order/);
  assert.throws(() => assertContextSendBindings({ ...body, contextSnapshotIds: ['source-A', 'source-A'] }, expected), /duplicate/);
  assert.throws(() => assertContextSendBindings({ ...body, contextSnapshotIds: ['source-A', 'source-B', 'other'] }, expected), /snapshot IDs/);
  assert.throws(() => assertContextSendBindings({ ...body, contextCapabilities: { ...body.contextCapabilities, write: true } }, expected), /capabilities/);
});

test('old full-file read evidence remains fixed while the same live fixture actually changes', t => {
  const { profile, root } = fixture(t);
  const file = path.join(root, 'original.txt');
  const original = 'QA_OLD_INPUT\n';
  fs.writeFileSync(file, original, { mode: 0o600 });
  const liveBefore = observeQaFixtureFile(profile, file);
  const capture = { ...metadata(file), hash: liveBefore.sha256 };
  const snapshotBefore = evidence(capture, original);
  fs.writeFileSync(file, 'QA_CHANGED_LIVE\n'); // Deliberate unit fixture mutation, not a provider/tool operation.
  const liveAfter = observeQaFixtureFile(profile, file);
  const snapshotAfter = evidence(capture, original);
  assert.equal(assertFrozenFileReadAfterMutation({ snapshotBefore, snapshotAfter, liveBefore, liveAfter, expectedSourceText: original }), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'QA_CHANGED_LIVE\n');
});

test('stale snapshot oracle rejects live rereads, rewritten metadata and unchanged mutation controls', () => {
  const capture = { ...metadata(), hash: fingerprintQaBytes('old\n').sha256 };
  const snapshotBefore = evidence(capture, 'old\n');
  const liveBefore = { path: '/unused/qa.txt', ...fingerprintQaBytes('old\n') };
  const liveAfter = { path: liveBefore.path, ...fingerprintQaBytes('changed\n') };
  const values = { snapshotBefore, snapshotAfter: snapshotBefore, liveBefore, liveAfter, expectedSourceText: 'old\n' };
  assert.throws(() => assertImmutableContextRead(snapshotBefore, evidence(capture, 'changed\n')), /Immutable/);
  assert.throws(() => assertImmutableContextRead(snapshotBefore, evidence({ ...capture, hash: 'rewritten' }, 'old\n')), /Immutable/);
  assert.throws(() => assertFrozenFileReadAfterMutation({ ...values, liveAfter: liveBefore }), /not actually changed/);
  assert.throws(() => assertFrozenFileReadAfterMutation({ ...values, liveAfter: { path: liveBefore.path } }), /observed SHA-256/);
  assert.throws(() => assertFrozenFileReadAfterMutation({ ...values, liveAfter: { ...liveAfter, path: '/unused/other.txt' } }), /same original/);
  assert.throws(() => assertFrozenFileReadAfterMutation({ ...values, liveBefore: { ...liveBefore, ...fingerprintQaBytes('wrong original') } }), /did not match/);
});

test('final inspector rejects interim projection-only responses and altered range bytes', () => {
  const valid = inspection(metadata(), 'line one\nline two');
  assert.equal(captureContextReadEvidence(valid).source.role, 'source');
  assert.throws(() => captureContextReadEvidence({ capture: metadata(), role: 'projection', text: 'old shape' }), /source.role/);
  assert.throws(() => captureContextReadEvidence({ ...valid, source: { ...valid.source, rangeHash: 'wrong' } }), /range hash/);
  assert.throws(() => captureContextReadEvidence({ ...valid, source: { ...valid.source, nextLine: 1 } }), /nextLine/);
  assert.throws(() => captureContextReadEvidence({ ...valid, delivered: undefined }), /agent_input/);
});

test('source pagination is one explicit GET at a time, never an automatic full-source read', async () => {
  const lines = Array.from({ length: 610 }, (_, index) => `captured line ${index + 1}`);
  const capture = { ...metadata(), hash: fingerprintQaBytes(lines.join('\n')).sha256 };
  const calls = [];
  const readGet = async route => {
    calls.push(route);
    const url = new URL(route, 'http://qa.invalid');
    assert.equal(url.pathname, '/context/captures/source-A');
    const startLine = Number(url.searchParams.get('startLine') || 1);
    const endLine = Number(url.searchParams.get('endLine') || Math.min(lines.length, startLine + 199));
    return inspection(capture, lines.slice(startLine - 1, endLine).join('\n'), { startLine, totalLines: lines.length });
  };
  const first = await readContextInspectionPage(readGet, { sourceId: 'source-A' });
  assert.equal(calls.length, 1);
  assert.equal(first.source.nextLine, 201);
  assert.equal(first.source.range.endLine, 200);
  const second = await readContextInspectionPage(readGet, { sourceId: 'source-A', startLine: 201, endLine: 240 });
  assert.equal(calls.length, 2);
  assert.equal(second.source.text, lines.slice(200, 240).join('\n'));
  assert.equal(second.source.range.totalLines, 610);
  await assert.rejects(readContextInspectionPage(readGet, { sourceId: 'source-A', startLine: 1, endLine: 501 }), /500 lines/);
  assert.equal(calls.length, 2);
});

test('stored agent packet evidence is distinct from captured source and requires exact observed tool text', async () => {
  const binding = { conversationId: 'conversation-A', runId: 'run-A', answerId: 'conversation-A/run-A' };
  const expectedToolText = JSON.stringify({ fixtureOnly: true, sourceId: 'source-A', selected: 'one bounded excerpt' });
  const packet = { role: 'agent_input', packetId: 'packet-A', mime: 'application/json',
    hash: fingerprintQaBytes(expectedToolText).sha256, text: expectedToolText, mode: 'fixture-only',
    coverage: { sourceId: 'source-A', startLine: 1, endLine: 1 }, deliveryStatus: 'sent-to-app-server', binding };
  const before = evidence(metadata(), 'full captured source\n');
  const after = captureContextReadEvidence(inspection(metadata(), 'full captured source\n', {
    delivered: packet, bindings: [{ bindingId: 'binding-A', ...binding }],
  }));
  assert.equal(assertImmutableContextRead(before, after), true);
  assert.notEqual(after.source.text, after.delivered.text);
  assert.equal(assertStoredAgentDelivery(after.delivered, { packetId: 'packet-A', binding, expectedToolText }), true);
  assert.throws(() => assertStoredAgentDelivery(after.delivered, { packetId: 'packet-A', binding, expectedToolText: after.source.text }), /exact named tool response/);
  assert.throws(() => assertStoredAgentDelivery(null, { packetId: 'packet-A', binding, expectedToolText }), /agent_input/);
  assert.throws(() => captureContextReadEvidence({ ...after, delivered: { ...packet, hash: 'changed' } }), /packet hash/);
  assert.throws(() => captureContextReadEvidence({ ...after, bindings: [] }), /matching stored binding/);
  assert.equal((await readContextInspectionPage(async () => after, { sourceId: 'source-A', packetId: 'packet-A' })).delivered.packetId, 'packet-A');
  await assert.rejects(readContextInspectionPage(async () => after, { sourceId: 'source-A', packetId: 'packet-B' }), /historical packet/);
});

test('all context/reader/Briefing phases retain the actual conversation/run/answer identity', () => {
  const identity = { conversationId: 'qa-native-conversation', runId: 'qa-native-run', answerId: 'qa-native-conversation/qa-native-run' };
  for (const event of ['context.bound', 'context.read.started', 'context.read.completed', 'context.read.failed',
    'reader.started', 'reader.completed', 'reader.failed', 'briefing.published']) {
    const envelope = { type: 'chat.event', v: 2, provider: 'codex', event, ...identity };
    assert.equal(assertContextEventIdentity(envelope, identity), true);
    for (const field of ['conversationId', 'runId', 'answerId']) {
      assert.throws(() => assertContextEventIdentity({ ...envelope, [field]: 'another' }, identity), /crossed/);
    }
  }
});

test('Briefing steps cannot point at unrelated snapshots or silently omit a fallback', () => {
  const briefing = { id: 'briefing-A', title: 'QA read', steps: [
    { id: 'step-A', text: 'Show captured input', target: { sourceId: 'source-A' }, fallback: 'Captured text' },
  ] };
  const scope = { sourceIds: ['source-A'], artifactIds: ['artifact-A'], viewIds: ['qa-view'] };
  assert.equal(assertBriefingTargets(briefing, scope), true);
  assert.throws(() => assertBriefingTargets(briefing, { sourceIds: ['source-B'] }), /not bound/);
  assert.throws(() => assertBriefingTargets({ ...briefing, steps: [...briefing.steps, ...briefing.steps] }, scope), /duplicate/);
  const withTarget = target => ({ ...briefing, steps: [{ ...briefing.steps[0], target }] });
  assert.equal(assertBriefingTargets(withTarget({ sourceId: 'source-A', viewId: 'qa-view' }), scope), true);
  assert.equal(assertBriefingTargets(withTarget({ artifactId: 'artifact-A' }), scope), true);
  assert.throws(() => assertBriefingTargets(withTarget({ sourceId: 'source-A', viewId: 'unrelated-view' }), scope), /not bound/);
  assert.throws(() => assertBriefingTargets(withTarget({ path: '/unused/qa.txt' }), scope), /raw-path/);
  assert.throws(() => assertBriefingTargets({ ...briefing, steps: [{ id: 'old', description: 'legacy', targets: [] }] }, scope), /Step text/);
  assert.throws(() => assertBriefingTargets({ ...briefing, steps: [{ id: 'empty', text: 'Missing', target: {} }] }, scope), /fallback/);
  assert.equal(assertBriefingTargets({ ...briefing, steps: [{ id: 'fallback', text: 'Unavailable target', target: {}, fallback: 'Preserved captured text' }] }, scope), true);
});

test('published Briefing requires native-answer identity and verified target hashes', () => {
  const identity = { conversationId: 'conversation', runId: 'run', answerId: 'conversation/run' };
  const capture = metadata();
  const briefing = { id: 'briefing', title: 'Captured input', ...identity, presentationStatus: 'proposed',
    steps: [{ id: 'step', text: 'Show the original', target: { sourceId: capture.sourceId, hash: capture.hash }, fallback: 'Unavailable' }] };
  const scope = { identity, captures: [capture] };
  assert.equal(assertPublishedBriefing(briefing, scope), true);
  for (const field of ['conversationId', 'runId', 'answerId']) {
    const missing = { ...briefing }; delete missing[field];
    assert.throws(() => assertPublishedBriefing(missing, scope), /crossed or omitted/);
  }
  assert.throws(() => assertPublishedBriefing({ ...briefing, steps: [{ ...briefing.steps[0], target: { sourceId: capture.sourceId } }] }, scope), /immutable hash/);
  assert.throws(() => assertPublishedBriefing({ ...briefing, presentationStatus: 'open-now' }, scope), /not an instruction/);
});

test('multi-target Briefing steps: target equals targets[0] and every target passes the same binding and hash checks', () => {
  const identity = { conversationId: 'conversation', runId: 'run', answerId: 'conversation/run' };
  const a = { ...metadata(), sourceId: 'source-A', snapshotId: 'source-A', hash: 'hash-A' };
  const b = { ...metadata(), id: 'attachment-B', sourceId: 'source-B', snapshotId: 'source-B', hash: 'hash-B' };
  const first = { sourceId: 'source-A', hash: 'hash-A', range: { startLine: 2, endLine: 3 } };
  const second = { sourceId: 'source-B', hash: 'hash-B', viewId: 'view-B' };
  const step = { id: 'both', text: 'Both agree', target: first, targets: [first, second], emphasis: 'spotlight', fallback: 'Open both' };
  const briefing = { id: 'briefing', title: 'Compare', ...identity, presentationStatus: 'proposed', steps: [step] };
  const scope = { identity, captures: [a, b], viewIds: ['view-B'] };
  assert.equal(assertPublishedBriefing(briefing, scope), true);
  assert.equal(assertBriefingTargets(briefing, { sourceIds: ['source-A', 'source-B'], viewIds: ['view-B'] }), true);
  // The original single-target shape still passes unchanged.
  assert.equal(assertPublishedBriefing({ ...briefing, steps: [{ id: 'one', text: 'One', target: first, fallback: 'Open' }] }, scope), true);
  const withStep = extra => ({ ...briefing, steps: [{ ...step, ...extra }] });
  assert.throws(() => assertPublishedBriefing(withStep({ target: second }), scope), /equal targets\[0\]/);
  assert.throws(() => assertPublishedBriefing(withStep({ targets: [] }), scope), /1–6 targets/);
  assert.throws(() => assertPublishedBriefing(withStep({ targets: Array.from({ length: 7 }, () => first) }), scope), /1–6 targets/);
  assert.throws(() => assertPublishedBriefing(withStep({ targets: [first, { sourceId: 'source-B' }] }), scope), /immutable hash/);
  assert.throws(() => assertPublishedBriefing(withStep({ targets: [first, { ...second, hash: 'hash-A' }] }), scope), /immutable hash/);
  assert.throws(() => assertBriefingTargets(withStep({ targets: [first, { path: '/unused/qa.txt' }] }), { sourceIds: ['source-A', 'source-B'] }), /raw-path/);
  assert.throws(() => assertBriefingTargets(withStep({ targets: [first, { sourceId: 'source-C' }] }), { sourceIds: ['source-A', 'source-B'] }), /not bound/);
  assert.throws(() => assertBriefingTargets(withStep({ targets: [first, { ...second, viewId: 'unrelated' }] }), { sourceIds: ['source-A', 'source-B'], viewIds: ['view-B'] }), /not bound/);
  assert.throws(() => assertBriefingTargets(withStep({ targets: 'source-A' }), { sourceIds: ['source-A'] }), /1–6 targets/);
  assert.throws(() => assertBriefingTargets(withStep({ emphasis: 'blink' }), { sourceIds: ['source-A', 'source-B'], viewIds: ['view-B'] }), /emphasis/);
  assert.throws(() => assertBriefingTargets(withStep({ description: 'legacy' }), { sourceIds: ['source-A', 'source-B'], viewIds: ['view-B'] }), /Legacy/);
});

function commentFixture() {
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const room = { engineId: 'codex', engineProfileId: 'codex-default', clientThreadId: 'local-A',
    conversationId: 'native-A', runId: 'run-A', answerId: 'native-A/run-A' };
  const briefing = { id: uuid(1), title: 'Stored briefing', steps: [{ id: 'step-A', sourceIds: ['source-A'] }, { id: 'step-B', sourceIds: ['source-B'] }] };
  const request = { stepId: 'step-A', text: 'Keep this saved comment', clientRequestId: uuid(2) };
  const saved = { id: uuid(3), briefingId: briefing.id, stepId: 'step-A', stepIndex: 0, seq: 1, text: request.text,
    clientRequestId: request.clientRequestId, sourceIds: ['source-A'], resolved: false, resolvedAt: null,
    conversationId: room.conversationId, runId: room.runId, answerId: room.answerId, createdAt: 100, updatedAt: 100 };
  return { uuid, room, briefing, request, saved, response: { briefingId: briefing.id, comments: [saved] } };
}

test('Briefing comments oracle accepts exact stored UUID/number/scope and recovers by request UUID only', () => {
  const f = commentFixture();
  assert.deepEqual(assertBriefingCommentList(f.response, f), [f.saved]);
  const actual = assertBriefingCommentSaved(f.response, f);
  assert.deepEqual(actual, f.saved); assert.equal(Object.isFrozen(actual), true);
  assert.throws(() => assertBriefingCommentSaved(f.response, { ...f, request: { ...f.request, clientRequestId: f.uuid(99) } }), /exact request UUID/);
  assert.throws(() => assertBriefingCommentSaved(f.response, { ...f, request: { ...f.request, text: 'different' } }));
  assert.throws(() => assertBriefingCommentSaved(f.response, { ...f, request: { ...f.request, sourceIds: [] } }), /exact request/);
  assert.deepEqual(assertBriefingCommentList({ briefingId: f.briefing.id, comments: [] }, f), []);
});

test('Briefing comments oracle rejects mixed conversations, unknown steps/sources, duplicate identity and private authority', () => {
  const f = commentFixture();
  for (const patch of [{ conversationId: 'native-B' }, { runId: 'run-B' }, { answerId: 'native-A/run-B' },
    { stepId: 'absent' }, { stepIndex: 1 }, { sourceIds: ['source-B'] }, { sourceIds: ['source-A', 'source-A'] },
    { seq: 0 }, { clientRequestId: 'not-uuid' }, { ownerKey: 'private' }, { requestDigest: 'private' }]) {
    assert.throws(() => assertBriefingCommentList({ ...f.response, comments: [{ ...f.saved, ...patch }] }, f));
  }
  for (const second of [f.saved, { ...f.saved, id: f.uuid(4), seq: 2 },
    { ...f.saved, id: f.uuid(4), clientRequestId: f.uuid(5) }]) {
    assert.throws(() => assertBriefingCommentList({ ...f.response, comments: [f.saved, second] }, f), /Duplicate|unique and ordered/);
  }
  assert.throws(() => assertBriefingCommentList(f.response, { ...f, room: { ...f.room, engineId: 'claude' } }), /fallback/);
  assert.throws(() => assertBriefingCommentList({ ...f.response, briefingId: f.uuid(99) }, f), /crossed/);
});

test('Briefing comments QA retains the 16KiB/2000-character/6-source/200-row bounds', () => {
  const f = commentFixture();
  assert.doesNotThrow(() => assertBriefingCommentList({ ...f.response, comments: [{ ...f.saved, text: 'x'.repeat(2000) }] }, f));
  assert.throws(() => assertBriefingCommentList({ ...f.response, comments: [{ ...f.saved, text: 'x'.repeat(2001) }] }, f), /bounded stored/);
  assert.throws(() => assertBriefingCommentList({ ...f.response, comments: Array(201).fill(f.saved) }, f), /Bounded explicit/);
  assert.throws(() => assertBriefingCommentList({ ...f.response, comments: [{ ...f.saved, sourceIds: Array.from({ length: 7 }, (_, i) => `source-${i}`) }] }, f), /source bound/);
  assert.throws(() => assertBriefingCommentSaved(f.response, { ...f, request: { ...f.request, text: 'x'.repeat(16384) } }), /16KiB/);
  assert.throws(() => assertBriefingCommentList({ briefingId: f.briefing.id }, f), /explicit/);
});

test('Briefing comment draft preserves existing text/attachments and rejects repeated or foreign insertion', () => {
  const { briefing, saved, room } = commentFixture();
  const before = { scope: { ...room, owner: 'fixture-owner' }, draft: 'Already typed draft',
    inputSources: [{ id: 'prepared-selection', sourceId: 'preserved' }],
    briefingInputs: [{ sourceId: 'preserved', hash: 'old-hash', sourceRef: { kind: 'file' } }], briefingCommentRefs: [] };
  const draftText = '[Stored briefing · 1단계 · 의견 #1]\n의견: Keep this saved comment';
  const after = { ...structuredClone(before), draft: `${before.draft}\n\n${draftText}`,
    briefingInputs: [...structuredClone(before.briefingInputs), { sourceId: 'source-A', hash: 'capture-hash' }],
    briefingCommentRefs: [{ commentId: saved.id, commentSeq: 1, briefingId: briefing.id, stepId: saved.stepId, draftText }] };
  const expected = { briefing, saved, sourceHashes: { 'source-A': 'capture-hash' } };
  assert.equal(assertBriefingCommentDraft(before, after, expected), true);
  assert.equal(assertBriefingCommentDraft(after, structuredClone(after), expected), true);
  assert.throws(() => assertBriefingCommentDraft(after, { ...after, draft: `${after.draft}\n${draftText}` }, expected), /duplicated/);
  for (const mutate of [v => { v.scope.conversationId = 'native-B'; }, v => { v.inputSources = []; },
    v => { v.briefingInputs[0].hash = 'changed'; }, v => { v.briefingInputs[1].hash = 'changed'; },
    v => { v.briefingCommentRefs[0].commentId = 'other'; }, v => { v.draft = draftText; }]) {
    const bad = structuredClone(after); mutate(bad); assert.throws(() => assertBriefingCommentDraft(before, bad, expected));
  }
});

test('Briefing comment actual-store projection requires scoped complete records and independent text hashes', () => {
  const f = commentFixture(), room = { ...f.room, briefing: f.briefing };
  const row = { id: f.saved.id, clientRequestId: f.saved.clientRequestId, seq: 1, stepId: 'step-A', sourceIds: ['source-A'],
    storedHash: fingerprintQaBytes(JSON.stringify(f.saved)).sha256, textHash: fingerprintQaBytes(f.saved.text).sha256 };
  const state = { briefingComments: { version: 1, receiptLimit: 64, receipts: [], storeInspection: {
    kind: 'qa-read-only-store', readAt: 100, briefings: [{ briefingId: f.briefing.id, conversationId: room.conversationId,
      account: 'a', count: 1, truncated: false, comments: [row] }] } } };
  assert.deepEqual(assertBriefingCommentStore(state, { room, account: 'a' }), [row]);
  for (const mutate of [v => { v.briefingComments.storeInspection.kind = 'production'; },
    v => { v.briefingComments.storeInspection.briefings[0].conversationId = 'native-B'; },
    v => { v.briefingComments.storeInspection.briefings[0].account = 'b'; },
    v => { v.briefingComments.storeInspection.briefings[0].truncated = true; },
    v => { v.briefingComments.storeInspection.briefings[0].count = 2; },
    v => { delete v.briefingComments.storeInspection.briefings[0].comments[0].textHash; },
    v => { v.briefingComments.storeInspection.briefings[0].comments[0].sourceIds = ['foreign']; }]) {
    const bad = structuredClone(state); mutate(bad);
    assert.throws(() => assertBriefingCommentStore(bad, { room, account: 'a' }));
  }
});

function commentTransportFixture() {
  const f = commentFixture(), route = { engineId: f.room.engineId, engineProfileId: f.room.engineProfileId,
    clientThreadId: f.room.clientThreadId, conversationId: f.room.conversationId, briefingId: f.briefing.id };
  const post = { kind: 'production', method: 'POST', requestId: f.uuid(11), clientRequestId: f.request.clientRequestId,
    R: route, account: 'a', epoch: 3, holdId: null, armedAt: null, receivedAt: 10, committedAt: 12,
    commentId: f.saved.id, readCompletedAt: null, responseStatus: 201, writeAttempted: true, endReturnedAt: 14,
    finishAt: 15, closeAt: 16, writableFinishedAtClose: true, releaseAttempts: 0, releaseAttemptAt: null,
    terminalCause: 'finished', listed: [] };
  const get = { ...post, method: 'GET', requestId: f.uuid(12), clientRequestId: null, commentId: null,
    receivedAt: 20, committedAt: null, readCompletedAt: 22, responseStatus: 200,
    endReturnedAt: 24, finishAt: 25, closeAt: 26, listed: [{ id: f.saved.id, clientRequestId: f.request.clientRequestId, seq: 1 }] };
  return { ...f, route, post, get, expected: { route, account: 'a', epoch: 3 } };
}

test('Comment terminal oracle validates finished, lost and legitimate no-finish transport-aborted receipts', () => {
  const { uuid, post, get, expected } = commentTransportFixture();
  for (const row of [post, get]) assert.doesNotThrow(() => assertBriefingCommentReceipt(row, { ...expected, terminal: 'finished' }));
  const lost = { ...post, holdId: uuid(20), armedAt: 5, endReturnedAt: null, finishAt: null,
    writeAttempted: false, writableFinishedAtClose: false, terminalCause: 'committed-response-lost' };
  assert.doesNotThrow(() => assertBriefingCommentReceipt(lost, { ...expected, terminal: 'committed-response-lost' }));
  const cancelled = { ...lost, terminalCause: 'peer-close-before-finish', releaseAttempts: 1, releaseAttemptAt: 30 };
  assert.doesNotThrow(() => assertBriefingCommentReceipt(cancelled, { ...expected, terminal: 'peer-close-before-finish' }));
  const lostGet = { ...get, endReturnedAt: null, finishAt: null, writeAttempted: false,
    writableFinishedAtClose: false, terminalCause: 'recovery-get-response-lost' };
  assert.doesNotThrow(() => assertBriefingCommentReceipt(lostGet, { ...expected, terminal: 'recovery-get-response-lost' }));
  for (const patch of [{ epoch: 9 }, { finishAt: null }, { finishAt: 19 }, { endReturnedAt: 21 },
    { writeAttempted: false }, { closeAt: 23 }, { writableFinishedAtClose: false }, { readCompletedAt: null }]) {
    assert.throws(() => assertBriefingCommentReceipt({ ...get, ...patch }, { ...expected, terminal: 'finished' }));
  }
  for (const patch of [{ closeAt: null }, { closeAt: 11 }, { endReturnedAt: 13 }, { finishAt: 15 },
    { writeAttempted: true }, { writableFinishedAtClose: true }, { releaseAttemptAt: 11 }, { committedAt: null }]) {
    assert.throws(() => assertBriefingCommentReceipt({ ...cancelled, ...patch }, { ...expected, terminal: 'peer-close-before-finish' }));
  }
});

test('Comment GET delta audits all received requests before success/scope filters and ties recovery to the original POST epoch', () => {
  const { uuid, post, get, expected } = commentTransportFixture(), options = { ...expected, count: 1, parent: post };
  assert.deepEqual(assertBriefingCommentGetDelta([post], [post, get], options), [get]);
  for (const extra of [{ ...get, requestId: uuid(13), responseStatus: 503, readCompletedAt: null, listed: [] },
    { ...get, requestId: uuid(14), R: { ...get.R, conversationId: 'native-B' } },
    { ...get, requestId: uuid(15), receivedAt: null }, { ...get, requestId: uuid(16), method: 'INVALID' }]) {
    assert.throws(() => assertBriefingCommentGetDelta([post], [post, get, extra], options));
  }
  assert.throws(() => assertBriefingCommentGetDelta([post], [post, { ...get, epoch: 9 }], options), /epoch/);
  assert.throws(() => assertBriefingCommentGetDelta([post], [post, { ...get, R: { ...get.R, conversationId: 'native-B' } }], options), /scope/);
  assert.throws(() => assertBriefingCommentGetDelta([post], [post, get], { ...options, parent: { ...post, epoch: 9 } }), /original POST epoch/);
  assert.throws(() => assertBriefingCommentGetDelta([post, get], [post], { ...options, count: 0 }), /disappeared/);
  assert.throws(() => assertBriefingCommentGetDelta([post, get], [post, { ...get, method: 'POST' }], { ...options, count: 0 }));
  assert.throws(() => assertBriefingCommentGetDelta([post], [post, get, get], options), /Duplicate/);
});

test('Comment GET diagnostics preserve actual delta/scope/timing, cap eight rows and omit secrets/text/payload', () => {
  const { uuid, post, get } = commentTransportFixture();
  const after = [post, get, ...Array.from({ length: 10 }, (_, i) => ({ ...get, requestId: uuid(100 + i), epoch: i,
    R: { ...get.R, conversationId: `native-${i}`, auth: 'PRIVATE_AUTH', token: 'PRIVATE_TOKEN' },
    secret: 'PRIVATE_SECRET', text: 'PRIVATE_TEXT', payload: 'PRIVATE_PAYLOAD', listed: [{ text: 'PRIVATE_LIST' }] }))];
  const summary = summarizeBriefingCommentGetDelta([post, get], after, { action: 'open-briefing', expected: 1 });
  assert.deepEqual([summary.action, summary.expected, summary.before, summary.after, summary.delta, summary.omitted],
    ['open-briefing', 1, 1, 11, 10, 2]);
  assert.equal(summary.receipts.length, 8); assert.equal(summary.receipts[0].requestId, uuid(100));
  assert.equal(summary.receipts[0].R.conversationId, 'native-0'); assert.equal(summary.receipts[7].epoch, 7);
  for (const key of ['receivedAt', 'readCompletedAt', 'endReturnedAt', 'finishAt', 'closeAt', 'responseStatus', 'terminalCause', 'writeAttempted']) {
    assert.equal(summary.receipts[0][key], get[key]);
  }
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE/); assert.equal(Object.isFrozen(summary), true);
  const malformed = summarizeBriefingCommentGetDelta([], [{ ...get, requestId: undefined, receivedAt: undefined,
    R: { ...get.R, conversationId: 'x'.repeat(1024) } }], { action: 'test', expected: 1 });
  assert.equal(malformed.delta, 1); assert.equal(malformed.receipts[0].malformedIdentityOrReceiveTime, true);
  assert.equal(malformed.receipts[0].R.conversationId.length, 256); assert.equal(malformed.receipts[0].stringsTruncated, true);
});

test('Briefing wheel planner only scrolls the observed panel toward a clipped target with a nine-hit native point', () => {
  const value = { exists: true, cameraSettled: true, viewport: { width: 800, height: 600 },
    panel: { id: 'egd-answer-briefing', client: { left: 100, top: 100, right: 500, bottom: 400 },
      clientHeight: 300, scrollTop: 0, scrollHeight: 1000 },
    access: { count: 1, insidePanel: true, visible: true, rect: { left: 120, right: 450, top: 450, bottom: 550 },
      wheelPoint: { x: 130, y: 200, hits: 9, scrollTarget: 'egd-answer-briefing' } } };
  assert.deepEqual(planBriefingPanelWheel(value), { x: 130, y: 200, deltaX: 0, deltaY: 156 });
  const up = structuredClone(value); up.panel.scrollTop = 400; up.access.rect.top = -20; up.access.rect.bottom = 80;
  assert.equal(planBriefingPanelWheel(up).deltaY, -126);
  for (const mutate of [v => { v.access.wheelPoint.scrollTarget = 'textarea'; }, v => { v.access.wheelPoint.hits = 8; },
    v => { v.access.insidePanel = false; }, v => { v.access.count = 2; }, v => { v.access.wheelPoint.x = 10; },
    v => { v.access.rect.top = 100; v.access.rect.bottom = 150; }, v => { v.access.rect.bottom = 900; },
    v => { v.panel.scrollTop = 700; }, v => { v.cameraSettled = false; }]) {
    const bad = structuredClone(value); mutate(bad); assert.throws(() => planBriefingPanelWheel(bad));
  }
});

test('Briefing wheel invariant permits only internal vertical scroll, not scope/camera/draft/attachment/panel changes', () => {
  const base = { exists: true, cameraSettled: true, alerts: [], activeThreadId: 'A', briefingId: 'briefing-A', stepId: 'one',
    presentationId: 'presentation-A', roomGeneration: 1, camera: { zoom: 1, pan: { x: 0, y: 0 } }, viewport: { width: 800, height: 600 },
    rooms: [{ id: 'A', scope: { owner: 'a', conversationId: 'native-A' }, draft: 'keep', briefingInputs: [{ sourceId: 's', hash: 'h' }] }],
    inputText: 'opinion', originalText: '', status: 'included', clientRequestId: 'uuid', listState: 'ready', rows: [],
    panel: { id: 'egd-answer-briefing', rect: {}, client: {}, clientHeight: 300, clientWidth: 400, scrollHeight: 900, scrollWidth: 400, scrollTop: 0, scrollLeft: 0 },
    access: { selector: 'row', count: 1, identity: { commentId: 'c' }, insidePanel: true, rect: { top: 450 } } };
  const scrolled = structuredClone(base); scrolled.panel.scrollTop = 100; scrolled.access.rect.top = 350;
  assert.equal(assertBriefingPanelInvariant(base, scrolled), true);
  for (const mutate of [v => { v.activeThreadId = 'B'; }, v => { v.camera.pan.x = 1; }, v => { v.rooms[0].draft += 'changed'; },
    v => { v.rooms[0].briefingInputs[0].hash = 'changed'; }, v => { v.presentationId = 'new'; }, v => { v.viewport.height++; },
    v => { v.panel.scrollLeft = 1; }, v => { v.panel.clientHeight++; }, v => { v.clientRequestId = 'new'; },
    v => { v.access.identity.commentId = 'other'; }]) {
    const bad = structuredClone(scrolled); mutate(bad); assert.throws(() => assertBriefingPanelInvariant(base, bad));
  }
});
