#!/usr/bin/env node
// QA-only, two-process probe for the production bridge's local history routes.
// Main starts/restarts the bridge. This script never starts Firefox, Codex, or a provider turn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { PAGINATION_SEED_FILE, assertFullPublicCheckpoint } from './seed-chat-history-pagination.mjs';

const BRIDGE_URL = 'http://127.0.0.1:39218';
const CHECKPOINT_KIND = 'egdesk-production-chat-history-restart-v1';
const PROJECTION_KIND = 'egdesk-chat-history-qa-projection-v1';
const QA_MARKER = 'EGDESK_QA_HISTORY_';
const scriptPath = fileURLToPath(import.meta.url);

function object(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function nonempty(value, label) {
  assert.ok(typeof value === 'string' && value.length > 0, `${label} must be nonempty`);
  return value;
}

function jsonCopy(value) {
  const copy = JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(copy, value, 'QA projection must be stable JSON');
  return copy;
}

function assertProjection(value, clientThreadId) {
  const projection = jsonCopy(object(value, 'QA projection'));
  assert.equal(projection.kind, PROJECTION_KIND);
  assert.equal(projection.clientThreadId, clientThreadId);
  assert.ok(projection.title === null || typeof projection.title === 'string',
    'QA title must preserve the stored string or null');
  for (const key of ['messages', 'attachmentRefs', 'briefingRefs']) {
    assert.ok(Array.isArray(projection[key]) && projection[key].length > 0, `QA projection needs ${key}`);
  }
  for (const message of projection.messages) {
    object(message, 'message');
    nonempty(message.id, 'message.id');
    assert.ok(['user', 'assistant'].includes(message.role), 'message.role must be user or assistant');
    assert.ok(typeof message.rawText === 'string', 'message.rawText must preserve exact text');
  }
  for (const key of ['attachmentRefs', 'briefingRefs']) {
    for (const reference of projection[key]) object(reference, `${key} item`);
  }
  assert.ok(JSON.stringify(projection).includes(QA_MARKER), 'QA projection has no synthetic marker');
  return projection;
}

function assertImportRequest(value) {
  const request = object(value, 'history import request');
  nonempty(request.clientThreadId, 'clientThreadId');
  nonempty(request.importId, 'importId');
  object(request.snapshot, 'snapshot');
  assert.deepStrictEqual(Object.keys(request).sort(), ['clientThreadId', 'importId', 'snapshot']);
  assert.ok(JSON.stringify(request.snapshot).includes(QA_MARKER), 'import snapshot has no synthetic marker');
  return jsonCopy(request);
}

export function createProductionHistoryHttp(fetchImpl = globalThis.fetch) {
  assert.equal(typeof fetchImpl, 'function');
  async function get(route, params = {}) {
    const url = new URL(route, BRIDGE_URL);
    assert.equal(url.origin, BRIDGE_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}`);
    return response.json();
  }
  async function importHistoryOutcome(importRequest) {
    const request = assertImportRequest(importRequest);
    const response = await fetchImpl(`${BRIDGE_URL}/chat/history/import`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      redirect: 'error', signal: AbortSignal.timeout(10000) });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  }
  return Object.freeze({
    health: () => get('/health'),
    threads: ({ cursor, limit = 50 } = {}) => get('/chat/history/threads', { cursor, limit }),
    history: ({ clientThreadId, afterSeq, limit = 50 }) => {
      nonempty(clientThreadId, 'clientThreadId');
      return get('/chat/history', { clientThreadId, afterSeq, limit });
    },
    importHistoryOutcome,
    async importHistory(importRequest) {
      const outcome = await importHistoryOutcome(importRequest);
      if (outcome.status < 200 || outcome.status >= 300) {
        throw new Error(`/chat/history/import returned HTTP ${outcome.status}`);
      }
      return outcome.body;
    },
  });
}

async function assertOfflineProductionBridge(http) {
  const health = object(await http.health(), 'bridge health');
  assert.equal(health.ok, true, 'bridge is not healthy');
  assert.notEqual(health.fixture, true, 'in-memory fixture transport cannot prove production DB durability');
  assert.equal(health.appServerReady, false, 'QA probe refuses a ready native Codex engine');
}

// CHAT-01: the Agent recorded for the room (chat store v3 thread.agent — null, or
// {profileId, revision, setAt} written by a send's recordRoomAgent or by
// POST /chat/rooms/agent) rides on the thread of both production routes. The
// shape-b adapter already requires the listed thread (/chat/history/threads)
// and the history thread (/chat/history) to be deepStrictEqual, so this one
// check of the projection's thread covers both routes.
function assertRoomAgent(projection) {
  const thread = object(projection.thread, 'projection.thread');
  assert.ok(Object.hasOwn(thread, 'agent'), 'thread must carry the room Agent field (chat store v3)');
  if (thread.agent === null) return null;
  const agent = object(thread.agent, 'thread.agent');
  assert.deepStrictEqual(Object.keys(agent).sort(), ['profileId', 'revision', 'setAt']);
  assert.match(agent.profileId, /^[a-z0-9][a-z0-9-]{0,79}$/, 'room Agent must be an Agent profile ID');
  assert.ok(agent.revision === null || (Number.isSafeInteger(agent.revision) && agent.revision > 0),
    'room Agent revision must be null (follow the active revision) or a positive integer');
  assert.ok(Number.isSafeInteger(agent.setAt) && agent.setAt > 0, 'room Agent needs the time it was picked');
  return jsonCopy(agent);
}

async function observeThroughBothRoutes(http, adapter, clientThreadId) {
  assert.equal(typeof adapter.readCanonical, 'function', 'shape adapter needs readCanonical');
  const calls = { threads: 0, history: 0 };
  const readOnly = Object.freeze({
    async threads(args) { calls.threads++; return http.threads(args); },
    async history(args) { calls.history++; return http.history(args); },
  });
  const observed = assertProjection(await adapter.readCanonical(readOnly, clientThreadId), clientThreadId);
  assert.ok(calls.threads > 0 && calls.history > 0, 'adapter must read both production history routes');
  assertRoomAgent(observed);
  return observed;
}

export async function verifyPagedCanonicalHistory(http, seed) {
  object(seed, 'pagination seed');
  assert.equal(seed.kind, 'egdesk-canonical-pagination-seed-v1');
  assert.ok(Number.isSafeInteger(seed.eventCount) && seed.eventCount > 100,
    'pagination proof requires more than one 100-event page');
  let cursor, listed = null;
  for (let index = 0; index < 100; index++) {
    const page = await http.threads({ cursor, limit: 50 });
    assert.equal(page.protocolVersion, 1);
    const match = page.threads.find(thread => thread.clientThreadId === seed.clientThreadId);
    if (match) {
      assert.equal(listed, null, 'canonical thread appeared twice');
      listed = match;
    }
    if (!page.hasMore) break;
    assert.ok(page.nextCursor != null && page.nextCursor !== cursor, 'thread-list cursor stalled');
    cursor = page.nextCursor;
    if (index === 99) throw new Error('thread-list pagination exceeded 100 pages');
  }
  assert.ok(listed, 'canonical thread missing after first-write legacy import');
  for (const key of ['localConversationId', 'clientThreadId', 'conversationId', 'title']) {
    assert.deepStrictEqual(listed[key], seed[key], `legacy import replaced canonical ${key}`);
  }
  assert.deepStrictEqual(listed.coverage, seed.coverage,
    'legacy import replaced canonical complete coverage');
  const pages = [];
  let afterSeq = 0;
  for (let index = 0; index < 100; index++) {
    const page = await http.history({ clientThreadId: seed.clientThreadId, afterSeq, limit: 100 });
    assert.equal(page.protocolVersion, 1);
    assert.equal(typeof page.projectionTruncated, 'boolean', 'history needs explicit projectionTruncated');
    assert.deepStrictEqual(page.coverage, seed.coverage, 'history coverage changed after legacy import');
    assert.equal(page.thread?.localConversationId, seed.localConversationId);
    assert.ok(Array.isArray(page.events), 'history page has no events array');
    for (const event of page.events) assert.ok(event.seq > afterSeq, 'afterSeq must be exclusive');
    pages.push(page);
    if (!page.hasMore) break;
    const next = Number(page.nextCursor);
    assert.ok(Number.isSafeInteger(next) && next > afterSeq, 'history cursor stalled');
    afterSeq = next;
    if (index === 99) throw new Error('history pagination exceeded 100 pages');
  }
  assert.ok(pages.length >= 2, '125 canonical events must require a later HTTP page');
  assert.equal(pages[0].hasMore, true, 'first page silently claimed history complete');
  const first = pages[0].events.find(event => event.eventId === seed.firstEventId);
  assert.equal(first?.seq, seed.firstEventSeq, 'first event was lost from the first page');
  const laterPage = pages.slice(1).find(page => page.events.some(event => event.eventId === seed.laterBody.eventId));
  assert.ok(laterPage, 'full public checkpoint was missing from a later page');
  const later = laterPage.events.find(event => event.eventId === seed.laterBody.eventId);
  assert.equal(later.seq, seed.laterBody.seq);
  assertFullPublicCheckpoint(later.details?.message, seed.laterBody.message,
    'later-page public message');
  assertFullPublicCheckpoint(later.details?.run, seed.laterBody.run,
    'later-page public run');
  const canonical = pages.flatMap(page => page.events)
    .filter(event => event.details?.marker === seed.marker);
  assert.equal(canonical.length, seed.eventCount, 'canonical events were silently capped');
  assert.deepStrictEqual(canonical.map(event => event.details.ordinal),
    Array.from({ length: seed.eventCount }, (_, index) => index + 1));
  assert.equal(canonical.at(-1).eventId, seed.lastEventId);
  assert.equal(canonical.at(-1).seq, seed.lastEventSeq);
  return { thread: listed, events: canonical, pageCount: pages.length,
    projectionTruncatedPages: pages.map(page => page.projectionTruncated) };
}

export async function seedHistoryRestart({ http, adapter, dataDir, bridgePid, paginationSeed = null }) {
  await assertOfflineProductionBridge(http);
  assert.equal(typeof adapter.makeSeed, 'function', 'shape adapter needs makeSeed');
  assert.equal(typeof adapter.assertImported, 'function', 'shape adapter needs assertImported');
  const importRequest = assertImportRequest(object(await adapter.makeSeed(), 'QA seed').importRequest);
  const receipt = await http.importHistory(importRequest);
  const observed = await observeThroughBothRoutes(http, adapter, importRequest.clientThreadId);
  await adapter.assertImported({ importRequest, receipt, observed });
  const repeated = await http.importHistory(importRequest);
  assert.equal(repeated?.alreadyImported, true, 'same importId and payload must be an idempotent no-op');
  assert.equal(repeated?.imported, false, 'repeated import must not create a second record');
  assert.deepStrictEqual(await observeThroughBothRoutes(http, adapter, importRequest.clientThreadId), observed,
    'idempotent import changed saved history');
  const conflicting = structuredClone(importRequest);
  conflicting.snapshot.streamId = `${conflicting.snapshot.streamId}-conflict`;
  assert.equal((await http.importHistoryOutcome(conflicting)).status, 409,
    'same importId with a different public snapshot must conflict');
  assert.deepStrictEqual(await observeThroughBothRoutes(http, adapter, importRequest.clientThreadId), observed,
    'conflicting import partially changed saved history');
  const paginationObserved = paginationSeed ? await verifyPagedCanonicalHistory(http, paginationSeed) : null;
  return { kind: CHECKPOINT_KIND, dataDir, seedBridgePid: bridgePid,
    clientThreadId: importRequest.clientThreadId, importId: importRequest.importId,
    snapshotSha256: createHash('sha256').update(JSON.stringify(importRequest.snapshot)).digest('hex'),
    expected: observed, paginationObserved,
    // CHAT-01: the room Agent as both routes reported it before the restart.
    roomAgent: assertRoomAgent(observed) };
}

export async function verifyHistoryRestart({ http, adapter, dataDir, bridgePid, checkpoint,
  paginationSeed = null }) {
  object(checkpoint, 'checkpoint');
  assert.equal(checkpoint.kind, CHECKPOINT_KIND);
  assert.equal(checkpoint.dataDir, dataDir, 'restart must use the same isolated data directory');
  assert.ok(Number.isSafeInteger(bridgePid) && bridgePid > 0 && bridgePid !== checkpoint.seedBridgePid,
    'Main must provide a different observed bridge PID after restart');
  const expected = assertProjection(checkpoint.expected, checkpoint.clientThreadId);
  await assertOfflineProductionBridge(http);
  const observed = await observeThroughBothRoutes(http, adapter, checkpoint.clientThreadId);
  assert.deepStrictEqual(observed, expected, 'production HTTP/DB history changed across bridge restart');
  // CHAT-01: the Agent recorded for the room is still the same on /chat/history/threads and /chat/history.
  assert.deepStrictEqual(assertRoomAgent(observed), checkpoint.roomAgent ?? null,
    'CHAT-01: the room Agent changed across bridge restart');
  if (paginationSeed) {
    assert.ok(checkpoint.paginationObserved, 'seed phase did not record canonical pagination evidence');
    assert.deepStrictEqual(await verifyPagedCanonicalHistory(http, paginationSeed), checkpoint.paginationObserved,
      'canonical event pages changed across bridge restart');
  }
  return { kind: CHECKPOINT_KIND, phase: 'verify', clientThreadId: checkpoint.clientThreadId,
    bridgePid, exactHistoryRestored: true, nativeProviderTurn: 'not-run' };
}

function isolatedDataDir(profile) {
  const manifest = assertQaFixtureManifest(nonempty(profile, '--profile'));
  assert.ok(manifest.backendDataDir, 'QA profile has no manifest-bound backend data directory');
  const directory = manifest.backendDataDir;
  assert.ok(process.env.EGDESK_DATA_DIR, 'EGDESK_DATA_DIR is required for the QA probe');
  assert.equal(fs.realpathSync.native(process.env.EGDESK_DATA_DIR), directory,
    'probe EGDESK_DATA_DIR must match the isolated bridge directory');
  return directory;
}

function cliOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    assert.ok(['--phase', '--profile', '--bridge-pid', '--adapter'].includes(key) && value && !options.has(key),
      'Expected unique --phase, --profile, --bridge-pid and --adapter pairs');
    options.set(key, value);
  }
  assert.equal(options.size, 4, 'All four QA options are required');
  assert.ok(['seed', 'verify'].includes(options.get('--phase')), '--phase must be seed or verify');
  const bridgePid = Number(options.get('--bridge-pid'));
  assert.ok(Number.isSafeInteger(bridgePid) && bridgePid > 0, '--bridge-pid must be positive');
  return { phase: options.get('--phase'), dataDir: isolatedDataDir(options.get('--profile')),
    bridgePid, adapterPath: options.get('--adapter') };
}

async function cli() {
  const options = cliOptions(process.argv.slice(2));
  assert.ok(path.isAbsolute(options.adapterPath), '--adapter must be absolute');
  const adapterPath = fs.realpathSync.native(options.adapterPath);
  assert.equal(adapterPath, options.adapterPath, 'adapter must not be a symlink');
  assert.equal(path.dirname(adapterPath), path.dirname(scriptPath), 'adapter must be a sibling QA script');
  const adapter = await import(pathToFileURL(adapterPath).href);
  const http = createProductionHistoryHttp();
  const checkpointPath = path.join(options.dataDir, 'history-restart-checkpoint.json');
  const paginationSeedPath = path.join(options.dataDir, PAGINATION_SEED_FILE);
  const paginationSeed = JSON.parse(fs.readFileSync(paginationSeedPath, 'utf8'));
  assert.equal(paginationSeed.dataDir, options.dataDir, 'pagination seed belongs to another data directory');
  if (options.phase === 'seed') {
    assert.ok(!fs.existsSync(checkpointPath), 'QA checkpoint already exists; use a fresh isolated data directory');
    const checkpoint = await seedHistoryRestart({ http, adapter, paginationSeed, ...options });
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ kind: CHECKPOINT_KIND, phase: 'seed',
      clientThreadId: checkpoint.clientThreadId, bridgePid: options.bridgePid,
      checkpointPath, nativeProviderTurn: 'not-run' })}\n`);
  } else {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    const result = await verifyHistoryRestart({ http, adapter, checkpoint, paginationSeed, ...options });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  cli().catch(error => { console.error(`History restart QA failed: ${error.message}`); process.exitCode = 1; });
}
