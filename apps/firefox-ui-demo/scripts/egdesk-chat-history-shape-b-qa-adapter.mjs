// QA mapping for the frozen production local-history HTTP contract.
// This synthetic import is never evidence of a native provider turn.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { assertFullPublicCheckpoint } from './seed-chat-history-pagination.mjs';

const MARKER = 'EGDESK_QA_HISTORY_';
const PROJECTION_KIND = 'egdesk-chat-history-qa-projection-v1';
const copy = value => JSON.parse(JSON.stringify(value));
const sha256 = text => createHash('sha256').update(text).digest('hex');

export function makeSeed() {
  const suffix = randomBytes(6).toString('hex');
  const marker = `${MARKER}${suffix}`;
  const now = Date.now();
  const clientThreadId = `qa-client-${suffix}`;
  const conversationId = `qa-native-conversation-${suffix}`;
  const runId = `qa-native-run-${suffix}`;
  const requestId = `qa-request-${suffix}`;
  const sourceId = `qa-source-${suffix}`;
  const packetId = `qa-packet-${suffix}`;
  const answerId = `${conversationId}/${runId}`;
  const sourceText = `${marker} frozen Browser source\nline 2`;
  const userText = `${marker} user text\nattachment remains bound`;
  const assistantText = `${marker} synthetic imported answer\nnot a provider result`;
  const userMessageId = `qa-user-${suffix}`;
  const assistantMessageId = `qa-answer-${suffix}`;
  const capture = { version: 1, id: `qa-attachment-${suffix}`, sourceId, snapshotId: sourceId,
    clientThreadId, hash: sha256(sourceText), capturedAt: now,
    captureScope: { type: 'browser' }, truncated: false,
    sourceRef: { kind: 'browser', viewId: `qa-view-${suffix}`, url: 'about:blank' },
    shape: { readable: true, format: 'text', mime: 'text/plain', lineCount: 2,
      charCount: sourceText.length, byteLength: Buffer.byteLength(sourceText) },
    payloads: { source: { hash: sha256(sourceText), byteLength: Buffer.byteLength(sourceText) } },
    transformations: [] };
  const briefing = { id: `qa-briefing-${suffix}`, title: `${marker} briefing`,
    conversationId, runId, answerId, createdAt: now, presentationStatus: 'proposed',
    steps: [{ id: `qa-step-${suffix}`, text: 'The saved source range is immutable.',
      target: { sourceId, hash: capture.hash, range: { startLine: 1, endLine: 2 } },
      fallback: 'Saved source unavailable; never substitute the live page.' }] };
  const messages = [
    { id: userMessageId, role: 'user', text: userText, status: 'complete', createdAt: now,
      inputSources: [{ id: capture.id, sourceId, hash: capture.hash }] },
    { id: assistantMessageId, role: 'assistant', text: assistantText, status: 'complete', createdAt: now + 1 },
  ];
  const run = { conversationId, runId, answerId, requestId, clientThreadId,
    status: 'completed', stopRequested: false, stopConfirmed: false,
    messages, activities: [{ id: `qa-activity-${suffix}`, kind: 'toolCall', status: 'completed',
      title: `${marker} public tool metadata`, toolName: 'egdesk_read_source', sourceRefs: [sourceId] }],
    artifacts: [{ id: `qa-artifact-${suffix}`, type: 'reference', status: 'referenced',
      label: `${marker} reference`, sourceItemId: assistantMessageId, sourceRefs: [sourceId] }],
    pendingApprovals: [], error: null, createdAt: now, truncated: false, historyComplete: true,
    cwdPublic: '/egdesk-qa-synthetic', accountIdentity: { accountId: 'chatgpt', identityStatus: 'qa-synthetic' },
    contextCaptures: [capture], contextEvents: [{ event: 'context.read.completed',
      details: { sourceId, packetId, hash: sha256(`${marker} packet`), fixtureOnly: true } }], briefing };
  const snapshot = { protocolVersion: 2, conversationId, streamId: `qa-stream-${suffix}`,
    seq: 4, truncated: false, historyComplete: true, runs: [run] };
  return { importRequest: { clientThreadId, importId: `qa-import-${suffix}`, snapshot } };
}

function coverage(value, where) {
  assert.equal(value?.scope, 'egdesk-local', `${where} scope`);
  assert.ok(['complete', 'partial', 'unknown'].includes(value.status), `${where} status`);
  assert.ok(Array.isArray(value.reasons), `${where} reasons`);
  assert.ok(value.nativeHistoryComplete === null || typeof value.nativeHistoryComplete === 'boolean', `${where} nativeHistoryComplete`);
  return value;
}

function mergeUnique(target, values, key, kind) {
  for (const value of values) {
    assert.ok(value && typeof value === 'object' && typeof value[key] === 'string' && value[key], `${kind} needs ${key}`);
    const previous = target.get(value[key]);
    if (previous) assert.deepStrictEqual(previous, value, `${kind} changed between pages`);
    else target.set(value[key], value);
  }
}

export async function readCanonical(readOnly, clientThreadId) {
  const threads = [];
  let cursor;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await readOnly.threads({ cursor, limit: 50 });
    assert.equal(page?.protocolVersion, 1);
    assert.ok(Array.isArray(page.threads), 'thread listing missing threads');
    assert.equal(typeof page.hasMore, 'boolean', 'thread listing needs explicit hasMore');
    threads.push(...page.threads);
    if (!page.hasMore) break;
    assert.ok(page.nextCursor != null && page.nextCursor !== cursor, 'thread listing stalled');
    cursor = page.nextCursor;
    if (pageNumber === 99) throw new Error('thread listing exceeded 100 explicit pages');
  }
  const matches = threads.filter(thread => thread.clientThreadId === clientThreadId);
  assert.equal(matches.length, 1, 'local thread must appear exactly once in thread listing');
  const listedThread = matches[0];
  coverage(listedThread.coverage, 'listed thread coverage');
  const runs = new Map(), messages = new Map(), events = new Map();
  let afterSeq = 0, thread = null, lastCoverage = null, projectionTruncated = false;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await readOnly.history({ clientThreadId, afterSeq, limit: 100 });
    assert.equal(page?.protocolVersion, 1);
    assert.ok(Array.isArray(page.runs) && Array.isArray(page.messages) && Array.isArray(page.events),
      'history page needs runs, messages and events');
    assert.equal(typeof page.hasMore, 'boolean', 'history needs explicit hasMore');
    assert.equal(typeof page.projectionTruncated, 'boolean', 'history needs explicit projectionTruncated');
    for (const event of page.events) {
      assert.ok(Number.isSafeInteger(event.seq) && event.seq > afterSeq,
        'history afterSeq must be exclusive for every returned event');
    }
    assert.equal(page.thread?.clientThreadId, clientThreadId);
    if (thread) assert.deepStrictEqual(page.thread, thread, 'thread changed between history pages');
    thread = page.thread;
    lastCoverage = coverage(page.coverage, 'history coverage');
    projectionTruncated ||= page.projectionTruncated === true;
    mergeUnique(runs, page.runs, 'localRunId', 'run');
    mergeUnique(messages, page.messages, 'localMessageId', 'message');
    mergeUnique(events, page.events, 'eventId', 'event');
    if (!page.hasMore) break;
    const next = Number(page.nextCursor);
    assert.ok(Number.isSafeInteger(next) && next > afterSeq, 'history cursor did not advance');
    afterSeq = next;
    if (pageNumber === 99) throw new Error('history exceeded 100 explicit pages');
  }
  assert.equal(projectionTruncated, false, 'history projection was silently truncated');
  assert.deepStrictEqual(thread, listedThread, 'thread list and history disagree');
  const orderedEvents = [...events.values()].sort((a, b) => a.seq - b.seq);
  for (let index = 0; index < orderedEvents.length; index++) {
    const event = orderedEvents[index];
    assert.ok(Number.isSafeInteger(event.seq) && event.seq > 0, 'event sequence must be positive');
    if (index) assert.ok(event.seq > orderedEvents[index - 1].seq, 'events must have unique ascending seq');
  }
  const savedRuns = [...runs.values()].sort((a, b) => a.firstSeq - b.firstSeq);
  const savedMessages = [...messages.values()].sort((a, b) => a.seq - b.seq);
  const attachmentRefs = savedRuns.flatMap(run => run.contextCaptures || []);
  const briefingRefs = savedRuns.map(run => run.briefing).filter(Boolean);
  return copy({ kind: PROJECTION_KIND, clientThreadId, title: thread.title,
    thread, coverage: lastCoverage, runs: savedRuns,
    messages: savedMessages.map(message => ({ ...message, rawText: message.text ?? message.content ?? '' })),
    events: orderedEvents, attachmentRefs, briefingRefs });
}

export function assertImported({ importRequest, receipt, observed }) {
  const snapshot = importRequest.snapshot;
  const original = snapshot.runs[0];
  assert.equal(receipt?.imported, true, 'first import must create local history');
  assert.equal(receipt?.alreadyImported, false);
  assert.equal(receipt?.clientThreadId, importRequest.clientThreadId);
  assert.equal(receipt?.localConversationId, observed.thread.localConversationId);
  assert.equal(observed.thread.conversationId, snapshot.conversationId);
  assert.equal(coverage(receipt.coverage, 'import coverage').status, 'complete');
  assert.equal(observed.coverage.status, 'complete');
  assert.equal(observed.coverage.nativeHistoryComplete, true);
  const run = observed.runs.find(item => item.runId === original.runId);
  assert.ok(run?.localRunId && run.requestId === original.requestId, 'saved run lost local/request identity');
  for (const key of ['messages', 'activities', 'artifacts', 'contextCaptures', 'contextEvents',
    'briefing', 'cwdPublic', 'accountIdentity']) {
    assertFullPublicCheckpoint(run[key], original[key], `full public run field ${key}`);
  }
  for (const message of original.messages) {
    const saved = observed.messages.find(item => item.id === message.id);
    assert.ok(saved?.localMessageId && saved.localRunId === run.localRunId,
      'saved message lost local run/message identity');
    assert.equal(saved.requestId, original.requestId);
    assert.equal(saved.rawText, message.text, 'saved message text changed');
    if (message.inputSources) assertFullPublicCheckpoint(saved.inputSources, message.inputSources, 'message inputSources');
  }
  assertFullPublicCheckpoint(observed.attachmentRefs, original.contextCaptures, 'attachment references');
  assertFullPublicCheckpoint(observed.briefingRefs, [original.briefing], 'Briefing references');
  assert.ok(observed.events.every((item, index, all) => index === 0 || item.seq > all[index - 1].seq));
  return true;
}
