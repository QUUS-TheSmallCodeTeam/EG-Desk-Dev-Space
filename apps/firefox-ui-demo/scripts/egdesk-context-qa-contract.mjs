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
    truncated: capture.truncated, shape: capture.shape, sourceRef: capture.sourceRef };
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

// Adapters select the declared GET projection and supply its exact delivered
// bytes. This does not guess the pending GET response body/projection schema.
// hash remains the server's opaque value; sha256 below is QA evidence.
export function captureContextReadEvidence(capture, deliveredBytes) {
  return frozenCopy({ capture: captureMetadata(capture), delivered: fingerprintQaBytes(deliveredBytes) });
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
  assertFingerprint(before.delivered, 'Captured projection');
  assert.deepEqual(after, before, 'Immutable capture metadata or delivered projection bytes changed');
  return true;
}

// Full-file, byte-preserving projection scenario only. Other Browser/Board or
// ranged projections use their declared adapter plus assertImmutableContextRead.
export function assertFrozenFileReadAfterMutation({ snapshotBefore, snapshotAfter, liveBefore, liveAfter }) {
  assertImmutableContextRead(snapshotBefore, snapshotAfter);
  assertFingerprint(liveBefore, 'Original file');
  assertFingerprint(liveAfter, 'Changed live file');
  assert.equal(snapshotBefore.capture.captureScope.type, 'file', 'Expected a full file capture scope');
  assert.equal(snapshotBefore.capture.truncated, false, 'Full-file proof cannot use a truncated capture');
  assert.equal(snapshotBefore.capture.sourceRef.path, liveBefore.path, 'Snapshot was captured from a different file');
  assert.equal(liveAfter.path, liveBefore.path, 'Live mutation must target the same original file');
  assert.deepEqual(snapshotBefore.delivered, { sha256: liveBefore.sha256, byteLength: liveBefore.byteLength },
    'The captured projection did not match the original full file');
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
    assert.ok(Object.keys(step.target).every(key => ['sourceId', 'artifactId', 'viewId', 'range'].includes(key)),
      'Briefing cannot use raw-path or other unbound target fallbacks');
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
