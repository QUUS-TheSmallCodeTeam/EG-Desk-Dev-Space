import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertBriefingTargets, assertContextCaptureBatch, assertContextEventIdentity, assertContextSendBindings,
  assertFrozenFileReadAfterMutation, assertImmutableContextRead, captureContextReadEvidence,
  assertPublishedBriefing, assertStoredAgentDelivery, fingerprintQaBytes, observeQaFixtureFile, readContextInspectionPage } from './egdesk-context-qa-contract.mjs';
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
