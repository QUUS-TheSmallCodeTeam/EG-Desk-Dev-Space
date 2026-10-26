// QA-only observations and assertions. No selectors, transport replacement,
// provider calls, or file writes. Passing these helpers is not live UI/tool proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';

const CONTEXT_EVENTS = new Set(['context.bound', 'context.read.started',
  'context.read.completed', 'context.read.failed', 'reader.started',
  'reader.completed', 'reader.failed', 'briefing.published']);
const CAPTURE_SCOPES = new Set(['file', 'document-text', 'dom-range', 'selection', 'board-selection']);

function text(value, name) {
  assert.ok(typeof value === 'string' && value.trim(), `${name} must be nonempty`);
  return value;
}

function uniqueKeys(values, name) {
  assert.ok(Array.isArray(values), `${name} must be an array`);
  values.forEach(value => text(value, name));
  assert.equal(new Set(values).size, values.length, `${name} contains duplicate IDs`);
  return values;
}

function record(value, name) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
}

function timestamp(value) {
  assert.ok(typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'string' && Number.isFinite(Date.parse(value)), 'capturedAt is required');
}

function captureScope(value) {
  record(value, 'captureScope');
  assert.ok(CAPTURE_SCOPES.has(value.type), 'Unknown capture scope type');
}

function captureMetadata(capture) {
  text(capture?.id, 'Capture attachment id');
  text(capture.sourceId, 'Server sourceId');
  assert.equal(capture.snapshotId, capture.sourceId, 'snapshotId must alias the immutable sourceId');
  text(capture.hash, 'Server capture hash');
  timestamp(capture.capturedAt);
  captureScope(capture.captureScope);
  assert.equal(typeof capture.truncated, 'boolean', 'Capture truncation must be explicit');
  assert.ok(Object.hasOwn(capture, 'shape') && capture.shape != null, 'Declared capture shape is required');
  record(capture.sourceRef, 'Capture sourceRef');
  return { id: capture.id, sourceId: capture.sourceId, snapshotId: capture.snapshotId,
    hash: capture.hash, capturedAt: capture.capturedAt, captureScope: capture.captureScope,
    truncated: capture.truncated, shape: capture.shape, sourceRef: capture.sourceRef,
    ...(capture.payloads === undefined ? {} : { payloads: capture.payloads }),
    ...(capture.transformations === undefined ? {} : { transformations: capture.transformations }) };
}

function frozenCopy(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = item => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}

export function fingerprintQaBytes(value) {
  assert.ok(typeof value === 'string' || value instanceof Uint8Array,
    'Evidence requires explicit UTF-8 text or bytes');
  const bytes = Buffer.from(value);
  return Object.freeze({ byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
}

function assertFingerprint(value, name) {
  assert.ok(value && /^[0-9a-f]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0,
  `${name} requires an observed SHA-256 and byte length`);
}

export function observeQaFixtureFile(profile, candidate) {
  const { root } = assertQaFixtureManifest(profile);
  assert.ok(typeof candidate === 'string' && path.isAbsolute(candidate)
    && path.resolve(candidate) === candidate, 'QA file path must be absolute and normalized');
  assert.ok(candidate.startsWith(`${root}${path.sep}`), 'QA file must be inside its manifest fixture root');
  const info = fs.lstatSync(candidate);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o022) === 0 && fs.realpathSync.native(candidate) === candidate,
  'QA evidence file must be canonical, user-owned and not group/world writable');
  const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    assert.ok(opened.dev === info.dev && opened.ino === info.ino, 'QA evidence file changed before opening');
    return Object.freeze({ path: candidate, ...fingerprintQaBytes(fs.readFileSync(fd)) });
  } finally { fs.closeSync(fd); }
}

function assertRunBinding(binding) {
  record(binding, 'Run binding');
  text(binding.conversationId, 'conversationId');
  text(binding.runId, 'runId');
  assert.equal(binding.answerId, `${binding.conversationId}/${binding.runId}`, 'Run binding answerId is inconsistent');
}

function assertAgentPacket(packet) {
  assert.equal(packet?.role, 'agent_input', 'A stored agent_input packet is required');
  text(packet.packetId, 'Stored packetId');
  assert.equal(packet.mime, 'application/json', 'Agent input must retain its JSON MIME');
  assert.equal(typeof packet.text, 'string', 'Exact returned tool text is required');
  JSON.parse(packet.text);
  assert.equal(packet.hash, fingerprintQaBytes(packet.text).sha256, 'Stored tool packet hash differs from its exact text');
  text(packet.mode, 'Recorded delivery mode');
  record(packet.coverage, 'Recorded delivery coverage');
  assert.equal(packet.deliveryStatus, 'sent-to-app-server', 'Packet was not handed to the native app-server');
  assertRunBinding(packet.binding);
}

// Only the final GET wire shape is accepted. A paged source is never relabeled
// as model-delivered input; delivered stays null until a real handoff is recorded.
export function captureContextReadEvidence(response) {
  const capture = captureMetadata(response?.capture);
  const source = response.source;
  assert.equal(source?.role, 'source', 'Final inspector source.role must be source');
  text(source.mime, 'Captured source MIME');
  assert.equal(source.hash, capture.hash, 'Source whole-capture hash changed');
  const { startLine, endLine, totalLines } = source.range || {};
  assert.ok(Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine)
    && Number.isSafeInteger(totalLines) && startLine >= 1 && endLine >= startLine
    && endLine <= totalLines && endLine - startLine < 500, 'Invalid captured source range or 500-line limit');
  assert.equal(typeof source.text, 'string', 'Captured range text must be explicit');
  assert.equal(source.text.split('\n').length, endLine - startLine + 1, 'Captured range line count differs from its text');
  assert.equal(source.rangeHash, fingerprintQaBytes(source.text).sha256, 'Captured range hash differs from exact text');
  assert.equal(source.nextLine, endLine < totalLines ? endLine + 1 : null, 'Source nextLine must advance without gaps');
  assert.ok(Array.isArray(response.bindings), 'Stored bindings must be explicit');
  for (const binding of response.bindings) { text(binding.bindingId, 'bindingId'); assertRunBinding(binding); }
  assert.ok(Object.hasOwn(response, 'delivered'), 'Delivered must be explicitly null or a stored packet');
  if (response.delivered !== null) {
    assertAgentPacket(response.delivered);
    assert.ok(response.bindings.some(binding => ['conversationId', 'runId', 'answerId']
      .every(field => binding[field] === response.delivered.binding[field])), 'Delivered packet has no matching stored binding');
  }
  return frozenCopy({ capture, source, delivered: response.delivered, bindings: response.bindings });
}

// Exactly one explicit GET per invocation. No capture, retry, or automatic
// next-page/full-source fetch. UI Next/Previous actions drive subsequent calls.
export async function readContextInspectionPage(readGet, { sourceId, startLine = 1, endLine, packetId }) {
  text(sourceId, 'Stored sourceId');
  assert.ok(Number.isSafeInteger(startLine) && startLine >= 1, 'startLine must be positive');
  if (endLine !== undefined) assert.ok(Number.isSafeInteger(endLine) && endLine >= startLine
    && endLine - startLine < 500, 'Explicit range must contain at most 500 lines');
  const params = new URLSearchParams({ startLine: String(startLine) });
  if (endLine !== undefined) params.set('endLine', String(endLine));
  if (packetId !== undefined) params.set('packetId', text(packetId, 'Requested packetId'));
  const observed = captureContextReadEvidence(await readGet(`/context/captures/${encodeURIComponent(sourceId)}?${params}`));
  assert.equal(observed.capture.sourceId, sourceId, 'Inspection returned a different immutable source');
  assert.equal(observed.source.range.startLine, startLine, 'Inspection returned a different startLine');
  if (endLine !== undefined) assert.ok(observed.source.range.endLine <= endLine, 'Inspection exceeded the requested range');
  if (packetId !== undefined) assert.equal(observed.delivered?.packetId, packetId, 'Inspection returned a different historical packet');
  return observed;
}

// expectedToolText must come from the observed named tool result in a native
// test, not from GET source text or a reconstructed/summarized packet.
export function assertStoredAgentDelivery(packet, { packetId, binding, expectedToolText }) {
  assertAgentPacket(packet);
  assertRunBinding(binding);
  assert.equal(packet.packetId, packetId, 'Stored delivery packetId differs from the observed handoff');
  assert.deepEqual(packet.binding, binding, 'Stored delivery belongs to a different native answer');
  assert.equal(typeof expectedToolText, 'string', 'Observed named tool result text is required');
  assert.equal(packet.text, expectedToolText, 'Stored delivery bytes differ from the exact named tool response');
  return true;
}

// Capture receipts correlate to attachment IDs, not inferred response ordering.
// Account/thread/run authority is separately verified from the actual backend.
export function assertContextCaptureBatch(request, response) {
  text(request?.clientThreadId, 'Wire clientThreadId');
  assert.ok(Array.isArray(request.attachments) && request.attachments.length, 'Batch attachments are required');
  uniqueKeys(request.attachments.map(item => item.id), 'Attachment IDs');
  for (const item of request.attachments) {
    assert.ok(['file', 'browser', 'board'].includes(item.kind), 'Unknown attachment kind');
    text(item.label, 'Attachment label');
    record(item.sourceRef, 'Attachment sourceRef');
    timestamp(item.capturedAt);
    captureScope(item.captureScope);
    if (item.content !== undefined) {
      record(item.content, 'Declared captured content');
      text(item.content.mime, 'Declared MIME');
      assert.equal(typeof item.content.text, 'string', 'Captured text must be explicit');
      assert.equal(typeof item.content.truncated, 'boolean', 'Content truncation must be explicit');
    }
  }
  assert.ok(Array.isArray(response?.captures), 'Batch capture receipts are required');
  uniqueKeys(response.captures.map(item => item.id), 'Capture attachment IDs');
  response.captures.forEach(captureMetadata);
  assert.deepEqual(response.captures.map(item => item.id).sort(), request.attachments.map(item => item.id).sort(),
    'Capture receipts differ from the exact requested attachment batch');
  return true;
}

export function assertContextSendBindings(body, { clientThreadId, sourceIds }) {
  text(clientThreadId, 'Expected wire clientThreadId');
  uniqueKeys(sourceIds, 'Expected immutable source IDs');
  uniqueKeys(body?.contextSnapshotIds, 'Sent snapshot IDs');
  assert.equal(body.clientThreadId, clientThreadId, 'Attachment owner differs from the expected wire thread');
  assert.deepEqual(body.contextSnapshotIds, sourceIds, 'Attached snapshot IDs or their requested order changed');
  assert.deepEqual(body.contextCapabilities, { read: true, reader: true, publishBriefing: true },
    'Context capabilities differ from the explicit request');
  return true;
}

export function assertImmutableContextRead(before, after) {
  assert.ok(before?.capture?.sourceId, 'A captured before-observation is required');
  captureMetadata(before.capture);
  captureContextReadEvidence(before);
  captureContextReadEvidence(after);
  assert.deepEqual(after.capture, before.capture, 'Immutable capture metadata changed');
  assert.deepEqual(after.source, before.source, 'Immutable captured source range changed');
  return true;
}

const SOURCE_CHANGE_LABELS = Object.freeze({
  loading: '원본 변경 정보 확인 중', active: '추적 범위에서 감지된 변경 없음',
  missing: '변경 추적 기록 없음 · 최신 여부 미확인', failed: '원본 변경 정보를 확인하지 못했습니다',
  fileChanged: '캡처 후 파일 변경 감지', navigated: '캡처 후 브라우저 페이지 이동 감지', unknown: '캡처 후 원본 변경 감지',
});

export function assertContextSourceChangeScope(actual, expected) {
  assert.equal(expected.engineId, 'codex', 'CTX04 never falls back from another engine to Codex');
  for (const key of ['owner', 'engineId', 'engineProfileId', 'clientThreadId', 'conversationId', 'sourceId']) {
    text(expected[key], `Expected source-status ${key}`);
    assert.equal(actual?.[key], expected[key], `Source-status crossed ${key}`);
  }
  return true;
}

// Tracking is separate mutable metadata. No absent row, active row or failed
// query can certify that an immutable capture is the latest original.
export function contextSourceChangeResponse(response, scope) {
  assertContextSourceChangeScope(scope, scope);
  assert.equal(response?.conversationId, scope.conversationId, 'Source-status response crossed conversationId');
  assert.ok(Array.isArray(response.sources), 'Source-status sources must be explicit');
  const rows = response.sources.filter(row => row?.sourceId === scope.sourceId);
  assert.ok(rows.length <= 1, 'Source-status needs exactly one matching source, not a first-row fallback');
  if (!rows.length) return Object.freeze({ state: 'missing', reason: null, changedAt: null });
  const row = rows[0];
  assert.ok(['active', 'stale'].includes(row.state), 'Unknown source tracking state');
  if (row.state === 'active') return Object.freeze({ state: 'active', reason: null, changedAt: null });
  const reason = ['fileChanged', 'navigated'].includes(row.reason) ? row.reason : 'unknown';
  const changedAt = Number.isFinite(row.changedAt) && row.changedAt >= 0 && Number.isFinite(new Date(row.changedAt).getTime())
    ? row.changedAt : null;
  return Object.freeze({ state: 'stale', reason, changedAt });
}

export function assertContextSourceChangePanel(panel, { scope, state, reason = null, changedAt = null, snapshot, before }) {
  assertContextSourceChangeScope(panel?.scope, scope);
  assert.ok(['loading', 'active', 'stale', 'missing', 'failed'].includes(state), 'Expected source-change state must be explicit');
  assert.equal(panel.exists, true, 'Historical inspector must remain open');
  assert.equal(panel.statusCount, 1, 'Exactly one source-change line');
  assert.equal(panel.state, state, 'Source-change line has the wrong state');
  assert.equal(panel.reason || null, state === 'stale' ? reason : null, 'Source-change reason differs');
  assert.equal(panel.statusSourceId, scope.sourceId, 'Source-change line crossed immutable source');
  assert.equal(panel.statusConversationId, scope.conversationId, 'Source-change line crossed native conversation');
  assert.equal(panel.sourceId, scope.sourceId, 'Historical inspector changed its capture');
  assert.equal(panel.placedBetweenSourceAndDelivery, true, 'Source-change metadata must follow source label and precede delivery');
  assert.equal(panel.statusReadable, true, 'Source-change text must be painted, unclipped and unobscured');
  const label = SOURCE_CHANGE_LABELS[state === 'stale' ? reason : state];
  assert.ok(label, 'Unknown expected stale reason');
  assert.equal(panel.statusText.split(' · 감지 시각 ')[0], label, 'Source tracking wording must not imply latest-source certainty');
  assert.equal(panel.changedAt, state === 'stale' && changedAt !== null ? new Date(changedAt).toISOString() : null,
    'Detection time is distinct from capture time');
  const recorded = captureContextReadEvidence(snapshot);
  assert.equal(recorded.capture.sourceId, scope.sourceId);
  if (recorded.delivered) assert.equal(recorded.delivered.binding.conversationId, scope.conversationId,
    'Historical packet binding cannot be mixed with another conversation status');
  assert.equal(panel.sourceText, recorded.source.text, 'Status changed immutable source body/range');
  const range = recorded.source.range;
  assert.equal(panel.sourceLabel, `원문 캡처 · ${range.startLine}–${range.endLine} / ${range.totalLines}행${recorded.capture.truncated ? ' · 일부 캡처' : ''}`,
    'Visible source range must match the actual stored range, not the first UI label');
  assert.deepEqual(panel.sourceHashes, [recorded.capture.hash], 'Rendered whole-capture hash differs from the store');
  assert.deepEqual(panel.rangeHashes, [recorded.source.rangeHash], 'Rendered range hash differs from the exact stored body');
  assert.equal(panel.packetId, recorded.delivered?.packetId ?? null, 'Status changed stored packet identity');
  assert.equal(panel.packetText, recorded.delivered?.text ?? null, 'Status changed exact stored payload');
  assert.deepEqual(panel.packetMetadataValues, recorded.delivered ? [{ mode: recorded.delivered.mode,
    packetId: recorded.delivered.packetId, hash: recorded.delivered.hash }] : [], 'Rendered delivery metadata differs from the stored payload hash/identity');
  if (before) for (const key of ['sourceId', 'sourceText', 'sourceMetadata', 'sourceLabel', 'packetId', 'packetText', 'packetMetadata']) {
    assert.deepEqual(panel[key], before[key], `Source-status update changed immutable inspector ${key}`);
  }
  return true;
}

export function assertContextSourceRequest(receipt, { route, account, holdId }) {
  text(holdId, 'Exact armed holdId'); text(account, 'Expected fixture account');
  assert.equal(receipt?.holdId, holdId, 'Source GET belongs to another hold');
  assert.deepEqual(receipt.R, route, 'Source GET crossed the exact route');
  assert.equal(receipt.account, account, 'Source GET crossed account');
  assert.equal(receipt.heldSourceId, route.sourceId, 'Held source differs from requested capture');
  text(receipt.requestId, 'Actually received source GET requestId');
  assert.ok(Number.isSafeInteger(receipt.epoch) && receipt.epoch >= 0, 'Source GET needs an account epoch');
  assert.ok(Number.isFinite(receipt.armedAt) && Number.isFinite(receipt.deadlineAt) && Number.isFinite(receipt.receivedAt)
    && receipt.receivedAt >= receipt.armedAt && receipt.receivedAt < receipt.deadlineAt, 'Source GET was not received within its hold');
  assert.match(receipt.snapshotHash || '', /^[0-9a-f]{64}$/, 'Held response snapshot hash is required');
  assert.equal(receipt.terminalCause, null, 'Source request already terminated before the native action');
  assert.equal(receipt.writeAttempted, false); assert.equal(receipt.releaseAttempts, 0);
  return frozenCopy(receipt);
}

// These are server/transport facts only. Neither classification proves a UI
// callback ran, and peer-close does not identify AbortController as its cause.
export function classifyContextSourceTerminal(before, after, { actionStartedAt, actionFinishedAt, release }) {
  for (const key of ['holdId', 'requestId', 'R', 'account', 'epoch', 'heldSourceId', 'armedAt', 'deadlineAt', 'receivedAt', 'snapshotHash']) {
    assert.deepEqual(after?.[key], before[key], `Source terminal receipt changed ${key}`);
    assert.deepEqual(release?.body?.receipt?.[key], before[key], `Release reply changed ${key}`);
  }
  assert.ok(Number.isFinite(actionStartedAt) && actionStartedAt >= before.receivedAt
    && Number.isFinite(actionFinishedAt) && actionFinishedAt >= actionStartedAt, 'Source GET must precede the native action');
  assert.ok(Number.isFinite(after.releaseAttemptAt) && after.releaseAttemptAt >= actionFinishedAt
    && after.releaseAttemptAt < before.deadlineAt, 'Exact release must follow the native action within the hold budget');
  assert.equal(after.releaseAttempts, 1, 'No repeated or guessed release attempts');
  assert.equal(release.body.receipt.releaseAttemptAt, after.releaseAttemptAt);
  assert.equal(release.body.receipt.releaseAttempts, 1);
  if (after.terminalCause === 'peer-close-before-finish') {
    assert.equal(release.httpStatus, 409); assert.equal(release.body.code, 'QA_SOURCE_RESPONSE_ALREADY_CLOSED');
    assert.equal(release.body.receipt.terminalCause, 'peer-close-before-finish');
    assert.equal(release.body.receipt.writeAttempted, false); assert.equal(after.writeAttempted, false);
    assert.equal(after.finishAt, null); assert.equal(after.endReturnedAt, null); assert.equal(after.writableFinishedAtClose, false);
    assert.ok(Number.isFinite(after.closeAt) && after.closeAt >= actionStartedAt && after.closeAt <= after.releaseAttemptAt,
      'Peer close must follow the native action and precede the refused write');
    return 'transportAborted';
  }
  assert.equal(after.terminalCause, 'finished', 'Expiry/server-close/account-change/write-error is not late-response proof');
  assert.equal(release.httpStatus, 200); assert.equal(release.body.ok, true); assert.equal(release.body.receipt.writeAttempted, true);
  assert.ok(release.body.receipt.terminalCause === null || release.body.receipt.terminalCause === 'finished');
  assert.equal(after.writeAttempted, true); assert.equal(after.responseStatus, 200);
  assert.ok(Number.isFinite(after.endReturnedAt) && after.endReturnedAt >= after.releaseAttemptAt
    && Number.isFinite(after.finishAt) && after.finishAt >= after.releaseAttemptAt, 'Server response has not finished');
  return 'serverResponseFinished';
}

// Verifies original file bytes and the exact requested stored source range.
// A delivered tool packet is independent and is checked separately above.
export function assertFrozenFileReadAfterMutation({ snapshotBefore, snapshotAfter, liveBefore, liveAfter, expectedSourceText }) {
  assertImmutableContextRead(snapshotBefore, snapshotAfter);
  assertFingerprint(liveBefore, 'Original file');
  assertFingerprint(liveAfter, 'Changed live file');
  assert.equal(snapshotBefore.capture.captureScope.type, 'file', 'Expected a full file capture scope');
  assert.equal(snapshotBefore.capture.truncated, false, 'Full capture proof cannot use a truncated source');
  assert.equal(snapshotBefore.capture.sourceRef.path, liveBefore.path, 'Snapshot was captured from a different file');
  assert.equal(liveAfter.path, liveBefore.path, 'Live mutation must target the same original file');
  assert.equal(snapshotBefore.capture.hash, liveBefore.sha256, 'Capture hash did not match the original file bytes');
  assert.equal(typeof expectedSourceText, 'string', 'Expected captured range text is required separately');
  assert.equal(snapshotBefore.source.text, expectedSourceText, 'Captured range differs from its exact expected bytes');
  assert.notEqual(liveAfter.sha256, liveBefore.sha256, 'Live original was not actually changed');
  return true;
}

export function assertContextEventIdentity(event, expected) {
  assert.ok(event?.type === 'chat.event' && event.v === 2 && event.provider === 'codex'
    && CONTEXT_EVENTS.has(event.event), 'Expected a v2 Codex context/reader/Briefing event');
  text(expected.conversationId, 'Expected conversationId');
  text(expected.runId, 'Expected runId');
  assert.equal(expected.answerId, `${expected.conversationId}/${expected.runId}`, 'Expected answer identity is inconsistent');
  for (const field of ['conversationId', 'runId', 'answerId']) {
    assert.equal(event[field], expected[field], `Context event crossed ${field}`);
  }
  return true;
}

// CHAT-05/CNV-07 (egdesk_publish_briefing_multi): a step may also carry
// targets[] (1–6). Then target must equal targets[0], and every item passes
// the same key and binding checks as the singular target.
const BRIEFING_MAX_TARGETS = 6;
const BRIEFING_EMPHASIS = new Set(['spotlight', 'outline']);

function stepTargetList(step) {
  if (!Object.hasOwn(step, 'targets')) return [step.target];
  assert.ok(Array.isArray(step.targets) && step.targets.length >= 1 && step.targets.length <= BRIEFING_MAX_TARGETS,
    `Multi-target step needs 1–${BRIEFING_MAX_TARGETS} targets`);
  assert.deepEqual(step.target, step.targets[0], 'Multi-target step target must equal targets[0]');
  return step.targets;
}

export function assertBriefingTargets(briefing, { sourceIds, artifactIds = [], viewIds = [] }) {
  text(briefing?.id, 'Briefing id');
  text(briefing?.title, 'Briefing title');
  const allowed = {
    sourceId: new Set(uniqueKeys(sourceIds, 'Bound immutable source IDs')),
    artifactId: new Set(uniqueKeys(artifactIds, 'Same-answer artifact IDs')),
    viewId: new Set(uniqueKeys(viewIds, 'Current run-bound view hints')),
  };
  assert.ok(Array.isArray(briefing.steps) && briefing.steps.length, 'Briefing needs explicit steps');
  uniqueKeys(briefing.steps.map(step => step.id), 'Briefing step IDs');
  for (const step of briefing.steps) {
    text(step.text, 'Step text');
    record(step.target, 'Singular Briefing target');
    assert.ok(!Object.hasOwn(step, 'description'), 'Legacy Briefing shape is not accepted');
    assert.ok(Object.hasOwn(step, 'fallback'), 'Step must declare fallback');
    if (step.emphasis !== undefined) assert.ok(BRIEFING_EMPHASIS.has(step.emphasis), 'Briefing emphasis must be spotlight or outline');
    for (const target of stepTargetList(step)) {
      record(target, 'Briefing target');
      assert.ok(Object.keys(target).every(key => ['sourceId', 'artifactId', 'viewId', 'range', 'hash'].includes(key)),
        'Briefing cannot use raw-path or other unbound target fallbacks');
      if (target.hash !== undefined) { text(target.sourceId, 'Hashed immutable sourceId'); text(target.hash, 'Immutable target hash'); }
      let references = 0;
      for (const [field, ids] of Object.entries(allowed)) {
        if (target[field] === undefined) continue;
        assert.ok(ids.has(target[field]), `Briefing ${field} is not bound to this answer/current run`);
        references++;
      }
      if (!references) assert.ok(step.fallback, 'Targetless step requires an explicit fallback');
    }
  }
  return true;
}

// Published DTOs are enriched by egdesk-context-runtime.publish after validation;
// these server-bound fields are not caller-supplied publication authority.
export function assertPublishedBriefing(briefing, { identity, captures, artifactIds = [], viewIds = [] }) {
  assertRunBinding(identity);
  for (const field of ['conversationId', 'runId', 'answerId']) {
    assert.equal(briefing[field], identity[field], `Published Briefing crossed or omitted ${field}`);
  }
  assert.equal(briefing.presentationStatus, 'proposed', 'Publishing is not an instruction to navigate automatically');
  assertBriefingTargets(briefing, { sourceIds: captures.map(item => item.sourceId), artifactIds, viewIds });
  for (const step of briefing.steps) {
    for (const target of stepTargetList(step)) {
      const capture = captures.find(item => item.sourceId === target.sourceId);
      assert.ok(capture && target.hash === capture.hash, 'Published target lacks its verified immutable hash');
    }
  }
  return true;
}
