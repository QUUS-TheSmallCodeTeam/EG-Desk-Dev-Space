import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { seedCanonicalPagedHistory } from './seed-chat-history-pagination.mjs';
import { openChatStore } from '../helper/egdesk-chat-store.mjs';

function fakeStoreFactory({ overwriteCoverage = false, capEvents = false } = {}) {
  const state = { thread: null, events: [], messages: [], closed: false, calls: [] };
  const openChatStore = ({ dataDir, ownerScope }) => {
    state.calls.push({ dataDir, ownerScope });
    return {
      createConversation({ clientThreadId, title, createdAt, coverage }) {
        state.thread = { localConversationId: `local-${clientThreadId}`, clientThreadId,
          conversationId: null, title, createdAt, updatedAt: createdAt, coverage: structuredClone(coverage) };
        return structuredClone(state.thread);
      },
      bindNative({ conversationId }) { state.thread.conversationId = conversationId; },
      appendMessage({ message }) { state.messages.push(structuredClone(message)); },
      appendEvent({ eventKey, ts, event, details }) {
        const saved = { seq: state.events.length + 1, eventId: eventKey, ts,
          event, details: structuredClone(details) };
        state.events.push(saved);
        return structuredClone(saved);
      },
      getConversation() { return structuredClone(state.thread); },
      listEvents(_clientThreadId, { afterSeq, limit }) {
        const page = state.events.filter(event => event.seq > afterSeq).slice(0, limit);
        return { events: structuredClone(page), nextCursor: page.at(-1)?.seq ?? null,
          hasMore: !capEvents && state.events.some(event => event.seq > page.at(-1)?.seq) };
      },
      listMessages() { return { messages: structuredClone(state.messages), nextCursor: null, hasMore: false }; },
      importSnapshot({ clientThreadId, importId }) {
        if (overwriteCoverage) state.thread.coverage = { scope: 'egdesk-local', status: 'partial',
          reasons: ['legacy-overwrite'], nativeHistoryComplete: false };
        return { imported: true, alreadyImported: false, clientThreadId, importId,
          localConversationId: state.thread.localConversationId, coverage: structuredClone(state.thread.coverage) };
      },
      close() { state.closed = true; },
    };
  };
  return { openChatStore, state };
}

test('canonical StoreA seed spans two pages and a first legacy import cannot replace thread or coverage', () => {
  const { openChatStore, state } = fakeStoreFactory();
  const result = seedCanonicalPagedHistory({ openChatStore, dataDir: '/synthetic/backend-data',
    ownerScope: 'egdesk-local', now: 1000 });
  assert.equal(result.eventCount, 125);
  assert.equal(result.firstEventSeq, 1);
  assert.equal(result.lastEventSeq, 125);
  assert.equal(result.laterBody.seq, 101);
  assert.match(result.laterBody.message.text, /full later-page answer/);
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.coverage.nativeHistoryComplete, null);
  assert.equal(state.events.length, 125);
  assert.equal(state.closed, true);
  assert.deepEqual(state.calls, [{ dataDir: '/synthetic/backend-data/chat', ownerScope: 'egdesk-local' }]);
});

test('canonical seed fails if legacy import weakens coverage or StoreA silently caps events', () => {
  const overwritten = fakeStoreFactory({ overwriteCoverage: true });
  assert.throws(() => seedCanonicalPagedHistory({ openChatStore: overwritten.openChatStore,
    dataDir: '/synthetic', ownerScope: 'egdesk-local' }), /legacy import replaced canonical coverage/);
  assert.equal(overwritten.state.closed, true);
  const capped = fakeStoreFactory({ capEvents: true });
  assert.throws(() => seedCanonicalPagedHistory({ openChatStore: capped.openChatStore,
    dataDir: '/synthetic', ownerScope: 'egdesk-local' }), /canonical event tail was capped/);
  assert.equal(capped.state.closed, true);
});

test('actual StoreA SQLite reopens the canonical 125-event QA seed and its later public checkpoint', t => {
  const dataDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'egdesk-chat-pagination-unit-'));
  t.after(() => {
    assert.equal(path.dirname(dataDir), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('egdesk-chat-pagination-unit-'));
    assert.equal(fs.realpathSync.native(dataDir), dataDir);
    fs.rmSync(dataDir, { recursive: true, force: false });
  });
  const ownerScope = 'local-desktop-v1';
  const checkpoint = seedCanonicalPagedHistory({ openChatStore, dataDir, ownerScope, now: 1000 });
  const reopened = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope });
  try {
    const thread = reopened.getConversation(checkpoint.clientThreadId);
    assert.equal(thread.localConversationId, checkpoint.localConversationId);
    assert.deepEqual(thread.coverage, checkpoint.coverage);
    const first = reopened.listEvents(checkpoint.clientThreadId, { afterSeq: 0, limit: 100 });
    assert.equal(first.hasMore, true);
    const later = reopened.listEvents(checkpoint.clientThreadId, { afterSeq: first.nextCursor, limit: 100 });
    assert.ok(later.events.some(event => event.eventId === checkpoint.laterBody.eventId));
    assert.equal([...first.events, ...later.events].filter(event => event.details?.marker === checkpoint.marker).length, 125);
  } finally {
    reopened.close();
  }
});
