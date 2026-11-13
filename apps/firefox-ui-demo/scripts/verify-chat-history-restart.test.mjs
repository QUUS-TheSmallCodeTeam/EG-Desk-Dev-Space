import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProductionHistoryHttp, seedHistoryRestart, verifyHistoryRestart,
  verifyPagedCanonicalHistory } from './verify-chat-history-restart.mjs';
import * as adapter from './egdesk-chat-history-shape-b-qa-adapter.mjs';
import { openChatStore } from '../helper/egdesk-chat-store.mjs';

function fakeProductionStore(shared = { request: null, data: null }) {
  const coverage = { scope: 'egdesk-local', status: 'complete', reasons: [], nativeHistoryComplete: true };
  function saved() {
    assert.ok(shared.data, 'QA import must precede history reads');
    return shared.data;
  }
  function importOutcome(request) {
    if (shared.request) {
      if (JSON.stringify(shared.request) !== JSON.stringify(request)) return { status: 409, body: { error: 'IMPORT_CONFLICT' } };
      return { status: 200, body: { imported: false, alreadyImported: true,
        clientThreadId: request.clientThreadId, localConversationId: saved().thread.localConversationId, coverage } };
    }
    const run = request.snapshot.runs[0];
    const localRunId = `local-${run.runId}`;
    const thread = { localConversationId: `local-${request.clientThreadId}`,
      clientThreadId: request.clientThreadId, conversationId: request.snapshot.conversationId,
      title: 'QA imported Chat', createdAt: run.createdAt, updatedAt: run.createdAt, coverage,
      // Chat store v3: every saved thread reports its room Agent, null until one is picked.
      agent: null };
    shared.request = structuredClone(request);
    shared.data = { thread, runs: [{ ...structuredClone(run), localRunId, firstSeq: 1, lastSeq: 3 }],
      messages: run.messages.map((message, index) => ({ ...structuredClone(message),
        localMessageId: `local-${message.id}`, localRunId, requestId: run.requestId, seq: index + 1 })),
      events: [{ seq: 3, eventId: `event-${run.runId}`, ts: run.createdAt,
        event: 'run.completed', requestId: run.requestId, localRunId,
        localMessageId: null, runId: run.runId, messageId: null, details: { status: 'completed' } }] };
    return { status: 200, body: { imported: true, alreadyImported: false,
      clientThreadId: request.clientThreadId, localConversationId: thread.localConversationId, coverage } };
  }
  return {
    shared,
    async health() { return { ok: true, appServerReady: false }; },
    async importHistory(request) {
      const result = importOutcome(request);
      if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
      return result.body;
    },
    async importHistoryOutcome(request) { return importOutcome(request); },
    // CHAT-01: the same answer the bridge gives for POST /chat/rooms/agent. The
    // pick is saved on the shared thread, so the second instance must still report it.
    async setRoomAgent({ clientThreadId, profileId, revision = null }) {
      const thread = saved().thread;
      assert.equal(clientThreadId, thread.clientThreadId);
      const same = thread.agent && thread.agent.profileId === profileId && thread.agent.revision === revision;
      if (!same) thread.agent = profileId === null ? null : { profileId, revision, setAt: thread.createdAt + 1 };
      return { accepted: true, clientThreadId, agent: structuredClone(thread.agent) };
    },
    async threads() { return { protocolVersion: 1, threads: [saved().thread], nextCursor: null, hasMore: false }; },
    async history() { return { protocolVersion: 1, ...saved(), nextCursor: null, hasMore: false,
      projectionTruncated: false, coverage }; },
  };
}

test('two distinct bridge instances preserve exact public Chat, references and local IDs without native calls', async () => {
  const first = fakeProductionStore();
  const dataDir = '/synthetic/qa/backend-data';
  const checkpoint = await seedHistoryRestart({ http: first, adapter, dataDir, bridgePid: 111 });
  assert.equal(checkpoint.kind, 'egdesk-production-chat-history-restart-v1');
  assert.equal(checkpoint.expected.messages.length, 2);
  assert.equal(checkpoint.expected.attachmentRefs.length, 1);
  assert.equal(checkpoint.expected.briefingRefs.length, 1);
  assert.equal(checkpoint.roomAgent.profileId, 'qa-room-agent-chat-01', 'the seed phase recorded the room Agent on both routes');
  assert.deepEqual(checkpoint.expected.thread.agent, checkpoint.roomAgent);
  const second = fakeProductionStore(first.shared);
  const result = await verifyHistoryRestart({ http: second, adapter, dataDir, bridgePid: 222, checkpoint });
  assert.equal(result.exactHistoryRestored, true);
  assert.equal(result.nativeProviderTurn, 'not-run');
  await assert.rejects(verifyHistoryRestart({ http: second, adapter, dataDir, bridgePid: 111, checkpoint }), /different observed bridge PID/);
  second.shared.data.messages[1].text = 'mutated after restart';
  await assert.rejects(verifyHistoryRestart({ http: second, adapter, dataDir, bridgePid: 333, checkpoint }),
    /history changed across bridge restart/);
});

test('production probe rejects a fixture bridge, a ready engine and a missing history route', async () => {
  const fixture = fakeProductionStore();
  fixture.health = async () => ({ ok: true, fixture: true, appServerReady: false });
  await assert.rejects(seedHistoryRestart({ http: fixture, adapter, dataDir: '/synthetic', bridgePid: 1 }),
    /in-memory fixture transport/);
  fixture.health = async () => ({ ok: true, appServerReady: true });
  await assert.rejects(seedHistoryRestart({ http: fixture, adapter, dataDir: '/synthetic', bridgePid: 1 }),
    /ready native Codex engine/);
  fixture.health = async () => ({ ok: true, appServerReady: false });
  fixture.threads = async () => { throw new Error('GET /chat/history/threads returned HTTP 404'); };
  await assert.rejects(seedHistoryRestart({ http: fixture, adapter, dataDir: '/synthetic', bridgePid: 1 }),
    /HTTP 404/);
});

test('HTTP adapter only issues the approved loopback history routes', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  const http = createProductionHistoryHttp(fakeFetch);
  const request = adapter.makeSeed().importRequest;
  await http.health();
  await http.threads({ cursor: 'next', limit: 20 });
  await http.history({ clientThreadId: request.clientThreadId, afterSeq: 0, limit: 100 });
  await http.importHistory(request);
  await http.setRoomAgent({ clientThreadId: request.clientThreadId, profileId: 'qa-room-agent-chat-01' });
  assert.deepEqual(calls.map(item => item.method), ['GET', 'GET', 'GET', 'POST', 'POST']);
  assert.deepEqual(calls.map(item => new URL(item.url).pathname),
    ['/health', '/chat/history/threads', '/chat/history', '/chat/history/import', '/chat/rooms/agent']);
  assert.ok(calls.every(item => new URL(item.url).origin === 'http://127.0.0.1:39218'));
});

test('first and later HTTP event pages prove complete durable history despite one projected message', async () => {
  const coverage = { scope: 'egdesk-local', status: 'complete', reasons: [], nativeHistoryComplete: null };
  const thread = { localConversationId: 'qa-local-page', clientThreadId: 'qa-client-page',
    conversationId: 'qa-native-page', title: 'canonical QA', createdAt: 1, updatedAt: 2, coverage };
  const marker = 'EGDESK_QA_HISTORY_PAGINATION_UNIT';
  const laterMessage = { id: 'qa-later-message', role: 'assistant', text: `${marker} exact body` };
  const laterRun = { runId: 'qa-later-run', messages: [laterMessage], activities: [], artifacts: [],
    contextCaptures: [{ sourceId: 'qa-source' }], briefing: { id: 'qa-briefing' } };
  const events = Array.from({ length: 125 }, (_, index) => ({ seq: index + 1,
    eventId: `qa-event-${index + 1}`, event: 'qa.synthetic.pagination',
    details: { marker, ordinal: index + 1,
      ...(index === 100 ? { message: laterMessage, run: laterRun } : {}) } }));
  const seed = { kind: 'egdesk-canonical-pagination-seed-v1', clientThreadId: thread.clientThreadId,
    localConversationId: thread.localConversationId, conversationId: thread.conversationId,
    title: thread.title, coverage, marker, eventCount: 125,
    firstEventId: events[0].eventId, firstEventSeq: 1,
    lastEventId: events.at(-1).eventId, lastEventSeq: 125,
    laterBody: { eventId: events[100].eventId, seq: 101,
      message: structuredClone(laterMessage), run: structuredClone(laterRun) } };
  const calls = [];
  const http = { async threads() { return { protocolVersion: 1, threads: [thread], hasMore: false, nextCursor: null }; },
    async history({ afterSeq, limit }) {
      calls.push(afterSeq);
      const page = events.filter(event => event.seq > afterSeq).slice(0, limit);
      return { protocolVersion: 1, thread, coverage, runs: [], messages: [{ id: 'only-one-message' }],
        events: page, nextCursor: page.at(-1)?.seq ?? null, hasMore: events.some(event => event.seq > page.at(-1)?.seq),
        projectionTruncated: afterSeq === 0 };
    } };
  const observed = await verifyPagedCanonicalHistory(http, seed);
  assert.equal(observed.pageCount, 2);
  assert.deepEqual(observed.projectionTruncatedPages, [true, false]);
  assert.deepEqual(calls, [0, 100]);
  assert.equal(observed.events.length, 125);
  events[100].details.run.messages[0].text = 'wrong later-page body';
  await assert.rejects(verifyPagedCanonicalHistory(http, seed), /later-page public message\.text changed/);
});

test('frozen-shape adapter reads actual StoreA SQLite after close/reopen without a provider', async t => {
  const dataDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'egdesk-chat-history-unit-'));
  t.after(() => {
    assert.equal(path.dirname(dataDir), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('egdesk-chat-history-unit-'));
    assert.equal(fs.realpathSync.native(dataDir), dataDir);
    fs.rmSync(dataDir, { recursive: true, force: false });
  });
  function storeHttp(store) {
    return {
      async health() { return { ok: true, appServerReady: false }; },
      async threads({ cursor, limit }) { return { protocolVersion: 1,
        ...store.listConversations({ cursor, limit }) }; },
      async history({ clientThreadId, afterSeq, limit }) {
        const thread = store.getConversation(clientThreadId);
        const events = store.listEvents(clientThreadId, { afterSeq, limit });
        return { protocolVersion: 1, thread,
          runs: store.listRuns(clientThreadId, { afterSeq, limit }).runs,
          messages: store.listMessages(clientThreadId, { afterSeq, limit }).messages,
          events: events.events, nextCursor: events.nextCursor, hasMore: events.hasMore,
          projectionTruncated: false, coverage: thread.coverage };
      },
      async importHistory(request) { return store.importSnapshot(request); },
      // CHAT-01: the bridge's POST /chat/rooms/agent is this one store write.
      async setRoomAgent({ clientThreadId, profileId, revision = null }) {
        return { accepted: true, ...store.setRoomAgent({ clientThreadId, profileId, revision, ts: Date.now() }) };
      },
      async importHistoryOutcome(request) {
        try { return { status: 200, body: store.importSnapshot(request) }; }
        catch (error) { return { status: error.httpStatus || 500, body: { code: error.code } }; }
      },
    };
  }
  const ownerScope = 'egdesk-qa-shape-b-unit';
  const first = openChatStore({ dataDir, ownerScope });
  let checkpoint;
  try {
    checkpoint = await seedHistoryRestart({ http: storeHttp(first), adapter, dataDir, bridgePid: 111 });
  } finally { first.close(); }
  assert.equal(checkpoint.roomAgent.profileId, 'qa-room-agent-chat-01', 'the real store saved the room Agent before the close');
  const reopened = openChatStore({ dataDir, ownerScope });
  try {
    const verified = await verifyHistoryRestart({ http: storeHttp(reopened), adapter,
      dataDir, bridgePid: 222, checkpoint });
    assert.equal(verified.exactHistoryRestored, true);
  } finally { reopened.close(); }
});
