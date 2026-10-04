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
    assert.ok(!Object.hasOwn(step, 'targets') && !Object.hasOwn(step, 'description'), 'Legacy Briefing shape is not accepted');
    assert.ok(Object.hasOwn(step, 'fallback'), 'Step must declare fallback');
    assert.ok(Object.keys(step.target).every(key => ['sourceId', 'artifactId', 'viewId', 'range', 'hash'].includes(key)),
      'Briefing cannot use raw-path or other unbound target fallbacks');
    if (step.target.hash !== undefined) { text(step.target.sourceId, 'Hashed immutable sourceId'); text(step.target.hash, 'Immutable target hash'); }
    let references = 0;
    for (const [field, ids] of Object.entries(allowed)) {
      if (step.target[field] === undefined) continue;
      assert.ok(ids.has(step.target[field]), `Briefing ${field} is not bound to this answer/current run`);
      references++;
    }
    if (!references) assert.ok(step.fallback, 'Targetless step requires an explicit fallback');
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
    const capture = captures.find(item => item.sourceId === step.target.sourceId);
    assert.ok(capture && step.target.hash === capture.hash, 'Published target lacks its verified immutable hash');
  }
  return true;
}
