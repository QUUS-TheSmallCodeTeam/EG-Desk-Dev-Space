#!/usr/bin/env node
// Direct, synthetic StoreA seed for production HTTP pagination/restart QA.
// Run only before Main starts the bridge; never invokes Codex or a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';

export const PAGED_EVENT_COUNT = 125;
export const PAGINATION_SEED_FILE = 'canonical-pagination-seed.json';
const scriptPath = fileURLToPath(import.meta.url);

export function assertFullPublicCheckpoint(actual, expected, label = 'public checkpoint') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) && actual.length === expected.length, `${label} array length changed`);
    expected.forEach((item, index) => assertFullPublicCheckpoint(actual[index], item, `${label}[${index}]`));
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual), `${label} object is missing`);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), `${label}.${key} is missing`);
      assertFullPublicCheckpoint(actual[key], value, `${label}.${key}`);
    }
  } else {
    assert.deepStrictEqual(actual, expected, `${label} changed`);
  }
}

function sameCanonicalThread(before, after) {
  for (const key of ['localConversationId', 'clientThreadId', 'conversationId', 'title', 'createdAt']) {
    assert.deepStrictEqual(after?.[key], before?.[key], `legacy import replaced canonical ${key}`);
  }
  assert.deepStrictEqual(after.coverage, before.coverage, 'legacy import replaced canonical coverage');
}

function allEvents(store, clientThreadId) {
  const events = [];
  let afterSeq = 0;
  for (let page = 0; page < 100; page++) {
    const batch = store.listEvents(clientThreadId, { afterSeq, limit: 100 });
    assert.ok(Array.isArray(batch.events) && typeof batch.hasMore === 'boolean', 'StoreA needs explicit event pages');
    for (const event of batch.events) {
      assert.ok(event.seq > afterSeq, 'StoreA afterSeq must be exclusive');
      events.push(event);
    }
    if (!batch.hasMore) return events;
    const next = Number(batch.nextCursor);
    assert.ok(Number.isSafeInteger(next) && next > afterSeq, 'StoreA event cursor stalled');
    afterSeq = next;
  }
  throw new Error('StoreA event scan exceeded 100 pages');
}

export function seedCanonicalPagedHistory({ openChatStore, dataDir, ownerScope,
  eventCount = PAGED_EVENT_COUNT, now = Date.now() }) {
  assert.equal(typeof openChatStore, 'function');
  assert.ok(Number.isSafeInteger(eventCount) && eventCount > 100 && eventCount <= 500);
  assert.ok(typeof ownerScope === 'string' && ownerScope, 'explicit local ownerScope is required');
  const suffix = randomBytes(6).toString('hex');
  const marker = `EGDESK_QA_HISTORY_PAGINATION_${suffix}`;
  const clientThreadId = `qa-page-client-${suffix}`;
  const conversationId = `qa-page-native-${suffix}`;
  const title = `${marker} canonical Chat`;
  const coverage = { scope: 'egdesk-local', status: 'complete', reasons: [], nativeHistoryComplete: null };
  // Production mounts StoreA below the app data root; keep the checkpoint's
  // dataDir at that root so the HTTP restart probe binds to EGDESK_DATA_DIR.
  const store = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope });
  try {
    const created = store.createConversation({ clientThreadId, title, createdAt: now, coverage });
    assert.ok(created?.localConversationId, 'StoreA did not create the canonical local thread');
    store.bindNative({ clientThreadId, conversationId });
    store.appendMessage({ clientThreadId, eventKey: `${marker}-user`, ts: now + 1,
      localMessageId: `qa-page-user-${suffix}`,
      message: { id: `qa-page-public-user-${suffix}`, role: 'user', text: `${marker} exact user text\nline 2`,
        status: 'complete', createdAt: now + 1 } });
    const pageMessage = { id: `qa-page-answer-${suffix}`, role: 'assistant',
      text: `${marker} full later-page answer\nnot a native provider result`, status: 'completed',
      createdAt: now + 101, contextRefs: [`qa-page-source-${suffix}`],
      inputSources: [{ sourceId: `qa-page-source-${suffix}`, range: { startLine: 201, endLine: 240 } }] };
    const pageRun = { conversationId, runId: `qa-page-run-${suffix}`,
      answerId: `${conversationId}/qa-page-run-${suffix}`, clientThreadId,
      requestId: `qa-page-request-${suffix}`, status: 'completed', stopRequested: false,
      stopConfirmed: false, messages: [pageMessage], activities: [{ id: `qa-page-activity-${suffix}`,
        kind: 'toolCall', status: 'completed', title: `${marker} public tool metadata` }],
      artifacts: [{ id: `qa-page-artifact-${suffix}`, type: 'reference', label: `${marker} artifact` }],
      pendingApprovals: [], error: null, createdAt: now + 101, truncated: false, historyComplete: true,
      contextCaptures: [{ sourceId: `qa-page-source-${suffix}`, hash: `qa-hash-${suffix}` }],
      briefing: { id: `qa-page-briefing-${suffix}`, title: `${marker} later-page Briefing`,
        conversationId, runId: `qa-page-run-${suffix}`,
        answerId: `${conversationId}/qa-page-run-${suffix}`,
        steps: [{ id: `qa-page-step-${suffix}`, target: { sourceId: `qa-page-source-${suffix}`,
          range: { startLine: 201, endLine: 240 } } }] } };
    for (let index = 1; index <= eventCount; index++) {
      const isLaterPageBody = index === 101;
      store.appendEvent({ clientThreadId, eventKey: `${marker}-event-${index}`, ts: now + index + 1,
        event: 'qa.synthetic.pagination', details: { marker, ordinal: index,
          ...(isLaterPageBody ? { message: pageMessage, run: pageRun } : {}) },
        ...(isLaterPageBody ? { runCheckpoint: pageRun } : {}) });
    }
    const before = store.getConversation(clientThreadId);
    assert.equal(before.conversationId, conversationId);
    assert.deepStrictEqual(before.coverage, coverage);
    const canonicalEvents = allEvents(store, clientThreadId)
      .filter(event => event.details?.marker === marker);
    assert.equal(canonicalEvents.length, eventCount, 'canonical event tail was capped before HTTP QA');
    assert.deepStrictEqual(canonicalEvents.map(event => event.details.ordinal),
      Array.from({ length: eventCount }, (_, index) => index + 1));
    const laterBody = canonicalEvents.find(event => event.details.ordinal === 101);
    assertFullPublicCheckpoint(laterBody.details.message, pageMessage,
      'StoreA later-page public message');
    assertFullPublicCheckpoint(laterBody.details.run, pageRun,
      'StoreA later-page public run');
    const legacyImportId = `qa-first-legacy-import-${suffix}`;
    const partialSnapshot = { protocolVersion: 2, conversationId, streamId: `qa-legacy-${suffix}`,
      seq: 1, truncated: true, historyComplete: false, runs: [] };
    const legacyReceipt = store.importSnapshot({ clientThreadId, importId: legacyImportId,
      snapshot: partialSnapshot });
    assert.equal(legacyReceipt.clientThreadId, clientThreadId);
    const after = store.getConversation(clientThreadId);
    sameCanonicalThread(before, after);
    const laterEvents = allEvents(store, clientThreadId).filter(event => event.details?.marker === marker);
    assert.deepStrictEqual(laterEvents, canonicalEvents, 'legacy import rewrote canonical event pages');
    const messages = store.listMessages(clientThreadId, { afterSeq: 0, limit: 100 });
    assert.ok(messages.messages.some(message => message.text === `${marker} exact user text\nline 2`),
      'legacy import removed the canonical user message');
    return { kind: 'egdesk-canonical-pagination-seed-v1', clientThreadId, conversationId,
      localConversationId: before.localConversationId, title, coverage, marker, eventCount,
      firstEventSeq: canonicalEvents[0].seq, lastEventSeq: canonicalEvents.at(-1).seq,
      firstEventId: canonicalEvents[0].eventId, lastEventId: canonicalEvents.at(-1).eventId,
      laterBody: { eventId: laterBody.eventId, seq: laterBody.seq,
        message: pageMessage, run: pageRun },
      legacyImportId, dataDir, nativeProviderTurn: 'not-run' };
  } finally {
    store.close();
  }
}

function cliPairs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    assert.ok(['--profile', '--store-module', '--owner-scope'].includes(key) && value && !options.has(key),
      'Expected unique --profile, --store-module and --owner-scope pairs');
    options.set(key, value);
  }
  assert.equal(options.size, 3);
  assert.equal(options.get('--owner-scope'), 'local-desktop-v1',
    'StoreA QA seed must use the production local owner scope');
  return options;
}

async function cli() {
  const options = cliPairs(process.argv.slice(2));
  const manifest = assertQaFixtureManifest(options.get('--profile'));
  assert.ok(manifest.backendDataDir, 'QA profile lacks a backend data directory');
  assert.equal(fs.realpathSync.native(process.env.EGDESK_DATA_DIR || ''), manifest.backendDataDir,
    'EGDESK_DATA_DIR must match this guarded QA profile');
  const modulePath = options.get('--store-module');
  assert.ok(path.isAbsolute(modulePath), '--store-module must be absolute');
  assert.equal(fs.realpathSync.native(modulePath), modulePath, 'StoreA module must not be a symlink');
  assert.equal(path.dirname(modulePath), path.resolve(path.dirname(scriptPath), '../helper'),
    'StoreA module must be in the EG-Desk helper directory');
  const checkpointPath = path.join(manifest.backendDataDir, PAGINATION_SEED_FILE);
  assert.ok(!fs.existsSync(checkpointPath), 'pagination seed already exists in this QA data directory');
  const module = await import(pathToFileURL(modulePath).href);
  const checkpoint = seedCanonicalPagedHistory({ openChatStore: module.openChatStore,
    dataDir: manifest.backendDataDir, ownerScope: options.get('--owner-scope') });
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ kind: checkpoint.kind, clientThreadId: checkpoint.clientThreadId,
    eventCount: checkpoint.eventCount, checkpointPath, nativeProviderTurn: 'not-run' })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  cli().catch(error => { console.error(`Canonical pagination seed failed: ${error.message}`); process.exitCode = 1; });
}
