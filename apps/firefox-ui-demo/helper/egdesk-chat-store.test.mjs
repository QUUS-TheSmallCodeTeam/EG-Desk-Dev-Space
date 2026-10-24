import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MAX_ROOM_MEMBERS, PRIVATE_KEYS, openChatStore as openNativeChatStore, roomMemberKey, roomMembersFromLegacy } from './egdesk-chat-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

const T = 1_800_000_000_000
const fixtureStores = new Map()
function openChatStore(options) {
  const store = openNativeChatStore(options)
  fixtureStores.get(options.dataDir)?.push(store)
  return store
}
const userMessage = (text = 'Hello') => ({ id: 'native-user-1', messageId: 'native-user-1', role: 'user', text, phase: null, status: 'complete', clientId: 'request-1', contextRefs: ['ctx-1'] })
const assistantMessage = (text, status = 'streaming') => ({ id: 'native-assistant-1', messageId: 'native-assistant-1', role: 'assistant', text, phase: null, status, completionConfirmed: status === 'complete', sourceRefs: [{ packetId: 'packet-1' }] })
const publicRun = (text, status = 'inProgress') => ({
  conversationId: 'native-thread-1', runId: 'native-run-1', answerId: 'native-answer-1',
  requestId: 'request-1', clientThreadId: 'client-1', status,
  messages: [userMessage(), assistantMessage(text, status === 'completed' ? 'complete' : status === 'interrupted' ? 'interrupted' : 'streaming')],
  activities: [{ id: 'activity-1', type: 'tool', status: 'completed', detail: { summary: 'Read a file', sourceRefs: [{ packetId: 'packet-1' }] } }],
  artifacts: [{ id: 'artifact-1', type: 'file', label: 'report', status: 'available' }],
  context: { contextSnapshotIds: ['ctx-1'], briefing: { title: 'Work' } },
  cwdPublic: '/visible/workspace', accountIdentity: { label: 'Local account' },
  pendingApprovals: [], error: null, truncated: false, historyComplete: true,
})

function fixture(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-chat-store-test-')
  const handles = []
  fixtureStores.set(dataDir, handles)
  t.after(() => {
    // Windows cannot remove a live SQLite database. Close every fixture handle
    // (including reopen tests) before removing this exact owned directory.
    for (const store of handles) store.close()
    fixtureStores.delete(dataDir)
    assert.equal(realpathSync.native(dataDir), dataDir)
    assert.match(path.basename(dataDir), /^egdesk-chat-store-test-/)
    rmSync(dataDir, { recursive: true, force: true })
  })
  return dataDir
}
function opened(t, scope = 'desktop/profile-a') {
  const dataDir = fixture(t)
  const store = openChatStore({ dataDir, ownerScope: scope })
  t.after(() => store.close())
  return { dataDir, store }
}
function conversation(store, clientThreadId = 'client-1') {
  return store.createConversation({ clientThreadId, localConversationId: `local-${clientThreadId}`, createdAt: T })
}

test('accepted user message and request fingerprint commit together and survive reopen', t => {
  const { dataDir, store } = opened(t)
  const created = conversation(store)
  assert.equal(created.conversationId, null)
  const input = { clientThreadId: 'client-1', requestId: 'request-1', fingerprint: 'fingerprint-1', ts: T + 1, localMessageId: 'local-user-1', message: userMessage() }
  const first = store.acceptRequest(input)
  assert.equal(first.accepted, true)
  assert.equal(first.message.id, 'native-user-1')
  assert.equal(first.message.text, 'Hello')
  assert.equal(first.message.localMessageId, 'local-user-1')
  assert.equal(store.acceptRequest(input).accepted, false)
  assert.equal(store.listEvents('client-1').events.length, 1)
  assert.equal(store.getRequest({ clientThreadId: 'client-1', requestId: 'request-1' }).fingerprint, 'fingerprint-1')
  assert.throws(() => store.acceptRequest({ ...input, fingerprint: 'changed' }), { code: 'REQUEST_CONFLICT', httpStatus: 409 })
  assert.throws(() => store.acceptRequest({ ...input, message: userMessage('Different') }), { code: 'REQUEST_CONFLICT' })
  assert.equal(store.listMessages('client-1').messages.length, 1)
  store.close()
  const reopened = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  t.after(() => reopened.close())
  assert.equal(reopened.getConversation('client-1').localConversationId, 'local-client-1')
  assert.equal(reopened.getRequest({ clientThreadId: 'client-1', requestId: 'request-1' }).status, 'accepted')
  assert.deepEqual(reopened.listMessages('client-1').messages[0], first.message)
  assert.equal(reopened.acceptRequest(input).accepted, false)
  assert.throws(() => store.listEvents('client-1'), { code: 'STORE_CLOSED' })
  const filename = readdirSync(dataDir).find(name => name.endsWith('.sqlite'))
  assert.ok(filename.startsWith('chat-') && !filename.includes('profile-a'))
  assert.equal(isOwnedAndPrivate(path.join(dataDir, filename), statSync(path.join(dataDir, filename)), 0o077), true)
  const raw = new DatabaseSync(path.join(dataDir, filename))
  assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3)
  raw.close()
})

test('an unsafe existing database is refused without tightening permissions or changing content', t => {
  const { dataDir, store } = opened(t)
  conversation(store)
  store.close()
  const filename = path.join(dataDir, readdirSync(dataDir).find(name => name.endsWith('.sqlite')))
  const before = readFileSync(filename)
  if (process.platform === 'win32') execFileSync('icacls.exe', [filename, '/grant', '*S-1-5-32-545:(W)'], { windowsHide: true, stdio: 'pipe' })
  else chmodSync(filename, 0o666)
  assert.equal(isOwnedAndPrivate(filename, statSync(filename), 0o077), false)
  assert.throws(() => openChatStore({ dataDir, ownerScope: 'desktop/profile-a' }), { code: 'INVALID_STORE_SCOPE' })
  assert.equal(isOwnedAndPrivate(filename, statSync(filename), 0o077), false)
  assert.deepEqual(readFileSync(filename), before)
})

test('full public run checkpoint projects ordered messages, preserves partial/final text and indexed refs', t => {
  const { dataDir, store } = opened(t)
  conversation(store)
  const partial = publicRun('A partial answer')
  const first = store.appendEvent({ clientThreadId: 'client-1', eventKey: 'run:1:partial', ts: T + 2, event: 'message.delta', localRunId: 'local-run-1', requestId: 'request-1', runId: 'native-run-1', details: { delta: 'A partial answer' }, contextRefs: ['ctx-1'], artifactRefs: ['artifact-1'], boardRefs: ['board-1'], runCheckpoint: partial })
  assert.equal(first.seq, 1)
  assert.equal(store.listEvents('client-1').events.length, 3) // checkpoint plus both public messages
  assert.deepEqual(store.listEvents('client-1').events[0].details.run, partial)
  assert.equal(store.getLatestRun('client-1').messages[1].text, 'A partial answer')
  assert.deepEqual(store.getLatestRun('client-1').activities, partial.activities)
  assert.deepEqual(store.getLatestRun('client-1').context, partial.context)
  assert.deepEqual(store.getLatestRun('client-1').artifacts, partial.artifacts)
  assert.deepEqual(store.getLatestRun('client-1').accountIdentity, partial.accountIdentity)
  assert.equal(store.listEvents('client-1', { refType: 'board', refId: 'board-1' }).events[0].eventId, first.eventId)
  assert.equal(store.listEvents('client-1', { refType: 'context', refId: 'ctx-1' }).events[0].eventId, first.eventId)
  assert.deepEqual(store.listEvents('client-1').events[0].contextRefs, ['ctx-1', 'packet-1'])
  assert.deepEqual(store.listEvents('client-1').events[0].artifactRefs, ['artifact-1'])
  assert.deepEqual(store.listEvents('client-1').events[0].boardRefs, ['board-1'])
  const finalRun = publicRun('The final complete answer', 'completed')
  const second = store.appendEvent({ clientThreadId: 'client-1', eventKey: 'run:1:final', ts: T + 3, event: 'run.completed', localRunId: 'local-run-1', requestId: 'request-1', runId: 'native-run-1', details: { status: 'completed' }, runCheckpoint: finalRun })
  assert.equal(second.seq, 4)
  assert.equal(store.getLatestRun('client-1').messages[1].text, 'The final complete answer')
  assert.equal(store.getLatestRun('client-1').status, 'completed')
  assert.equal(store.listMessages('client-1').messages.find(message => message.role === 'assistant').text, 'The final complete answer')
  assert.equal(store.listEvents('client-1').events.filter(event => event.event === 'message.checkpoint' && event.details.message.role === 'assistant')[0].details.message.text, 'A partial answer')
  assert.deepEqual(store.appendEvent({ clientThreadId: 'client-1', eventKey: 'run:1:final', ts: T + 3, event: 'run.completed', localRunId: 'local-run-1', requestId: 'request-1', runId: 'native-run-1', details: { status: 'completed' }, runCheckpoint: finalRun }), second)
  assert.throws(() => store.appendEvent({ clientThreadId: 'client-1', eventKey: 'run:1:final', ts: T + 3, event: 'run.completed', localRunId: 'local-run-1', requestId: 'request-1', runId: 'native-run-1', details: { status: 'failed' }, runCheckpoint: finalRun }), { code: 'EVENT_CONFLICT', httpStatus: 409 })
  store.close()
  const reopened = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  t.after(() => reopened.close())
  assert.equal(reopened.getLatestRun('client-1').messages[1].text, 'The final complete answer')
  assert.deepEqual(reopened.getLatestRun('client-1').accountIdentity, partial.accountIdentity)
  assert.equal(reopened.listEvents('client-1').events.filter(event => event.event === 'message.checkpoint' && event.details.message.role === 'assistant')[0].details.message.text, 'A partial answer')
})

test('interrupted public content and explicit paging are retained without silent caps', t => {
  const { store } = opened(t)
  conversation(store)
  const interrupted = publicRun('Work completed before interruption', 'interrupted')
  store.appendEvent({ clientThreadId: 'client-1', eventKey: 'interrupted', ts: T + 1, event: 'run.completed', localRunId: 'local-run-1', runCheckpoint: interrupted })
  assert.equal(store.getLatestRun('client-1').messages[1].text, 'Work completed before interruption')
  assert.equal(store.getLatestRun('client-1').status, 'interrupted')
  const first = store.listEvents('client-1', { limit: 2 })
  assert.equal(first.events.length, 2)
  assert.equal(first.hasMore, true)
  const next = store.listEvents('client-1', { afterSeq: first.nextCursor, limit: 2 })
  assert.equal(next.events.length, 1)
  assert.equal(next.hasMore, false)
  assert.equal(next.nextCursor, null)
  assert.throws(() => store.listEvents('client-1', { limit: 501 }), { code: 'INVALID_CHAT_QUERY' })
})

test('private payload fields reject before any write, while public tool metadata is preserved', t => {
  const { store } = opened(t)
  conversation(store)
  assert.throws(() => store.acceptRequest({ clientThreadId: 'client-1', requestId: 'r1', fingerprint: 'f1', ts: T + 1, localMessageId: 'm1', message: { ...userMessage(), authPayload: { token: 'private' } } }), { code: 'PRIVATE_CHAT_PAYLOAD' })
  assert.equal(store.getRequest({ clientThreadId: 'client-1', requestId: 'r1' }), null)
  assert.throws(() => store.appendEvent({ clientThreadId: 'client-1', eventKey: 'bad', ts: T + 1, event: 'tool.done', details: { rawReasoning: 'private' } }), { code: 'PRIVATE_CHAT_PAYLOAD' })
  assert.throws(() => store.appendEvent({ clientThreadId: 'client-1', eventKey: 'bad2', ts: T + 1, event: 'tool.done', details: { cookie: 'private' } }), { code: 'PRIVATE_CHAT_PAYLOAD' })
  assert.equal(store.listEvents('client-1').events.length, 0)
  const detail = { tool: { summary: 'Read file', sourceRefs: [{ packetId: 'packet-1' }] }, artifactRefs: ['artifact-1'] }
  assert.deepEqual(store.appendEvent({ clientThreadId: 'client-1', eventKey: 'public', ts: T + 1, event: 'tool.done', details: detail }).details, detail)
})

test('native bindings remain separate from local IDs and conflicting remaps fail', t => {
  const { store } = opened(t)
  conversation(store)
  const binding = { clientThreadId: 'client-1', conversationId: 'native-thread-1', localRunId: 'local-run-1', runId: 'native-run-1', localMessageId: 'local-message-1', messageId: 'native-message-1' }
  assert.deepEqual(store.bindNative(binding), binding)
  assert.deepEqual(store.bindNative(binding), binding)
  assert.equal(store.getConversation('client-1').localConversationId, 'local-client-1')
  assert.equal(store.getConversation('client-1').conversationId, 'native-thread-1')
  assert.throws(() => store.bindNative({ clientThreadId: 'client-1', conversationId: 'other-thread' }), { code: 'NATIVE_MAPPING_CONFLICT', httpStatus: 409 })
  assert.throws(() => store.bindNative({ clientThreadId: 'client-1', localRunId: 'local-run-1', runId: 'other-run' }), { code: 'NATIVE_MAPPING_CONFLICT' })
  assert.throws(() => store.bindNative({ clientThreadId: 'client-1', localMessageId: 'local-message-1', messageId: 'other-message' }), { code: 'NATIVE_MAPPING_CONFLICT' })
})

test('accepted UI message ID can later bind and project a distinct native message ID', t => {
  const { store } = opened(t)
  conversation(store)
  const local = { id: 'local-ui-message', messageId: 'local-ui-message', role: 'user', text: 'Exact accepted text', status: 'complete' }
  store.acceptRequest({ clientThreadId: 'client-1', requestId: 'request-1', fingerprint: 'fingerprint-1', ts: T + 1, localMessageId: 'local-message-1', message: local })
  store.bindNative({ clientThreadId: 'client-1', localMessageId: 'local-message-1', messageId: 'native-message-1' })
  const native = { ...local, id: 'native-message-1', messageId: 'native-message-1' }
  const saved = store.appendMessage({ clientThreadId: 'client-1', eventKey: 'native-message-1', ts: T + 2, localMessageId: 'local-message-1', requestId: 'request-1', message: native })
  assert.equal(saved.id, 'native-message-1')
  assert.equal(saved.text, 'Exact accepted text')
  assert.equal(store.listMessages('client-1').messages.length, 1)
})

test('omitted localRunId resolves the same native run across distinct event keys', t => {
  const { store } = opened(t)
  conversation(store)
  const partial = { ...publicRun('Partial'), requestId: null }
  const complete = { ...publicRun('Complete', 'completed'), requestId: null }
  store.appendEvent({ clientThreadId: 'client-1', eventKey: 'run-start', ts: T + 1, event: 'run.started', runId: 'native-run-1', runCheckpoint: partial })
  store.appendEvent({ clientThreadId: 'client-1', eventKey: 'run-finish', ts: T + 2, event: 'run.completed', runId: 'native-run-1', runCheckpoint: complete })
  assert.equal(store.listRuns('client-1').runs.length, 1)
  assert.equal(store.getLatestRun('client-1').messages[1].text, 'Complete')
  assert.throws(() => store.appendEvent({ clientThreadId: 'client-1', eventKey: 'ambiguous', ts: T + 3, event: 'run.started', runCheckpoint: { ...partial, runId: null } }), { code: 'LOCAL_RUN_ID_REQUIRED' })
})

test('late partial checkpoints remain canonical events but cannot regress final projections', t => {
  const { store } = opened(t)
  conversation(store)
  const final = publicRun('Confirmed final answer', 'completed')
  store.appendEvent({ clientThreadId: 'client-1', eventKey: 'final-first', ts: T + 10, event: 'run.completed', localRunId: 'local-run-1', runCheckpoint: final })
  const partial = publicRun('Earlier partial answer', 'inProgress')
  store.appendEvent({ clientThreadId: 'client-1', eventKey: 'late-partial', ts: T + 5, event: 'message.delta', localRunId: 'local-run-1', runCheckpoint: partial })
  store.appendEvent({ clientThreadId: 'client-1', eventKey: 'late-arriving-partial', ts: T + 20, event: 'message.delta', localRunId: 'local-run-1', runCheckpoint: partial })
  assert.equal(store.getLatestRun('client-1').status, 'completed')
  assert.equal(store.getLatestRun('client-1').messages[1].text, 'Confirmed final answer')
  assert.equal(store.listMessages('client-1').messages.find(message => message.role === 'assistant').text, 'Confirmed final answer')
  assert.equal(store.listEvents('client-1').events.find(event => event.event === 'message.delta').details.run.messages[1].text, 'Earlier partial answer')
  assert.equal(store.listEvents('client-1').events.filter(event => event.event === 'message.checkpoint' && event.details.message.role === 'assistant').at(-1).details.message.text, 'Earlier partial answer')
  assert.equal(store.getConversation('client-1').updatedAt, T + 20)
})

test('request outcome, standalone message replay and thread pages remain queryable', t => {
  const { store } = opened(t)
  conversation(store)
  conversation(store, 'client-2')
  conversation(store, 'client-3')
  const firstPage = store.listConversations({ limit: 2 })
  assert.equal(firstPage.threads.length, 2)
  assert.equal(firstPage.hasMore, true)
  assert.equal(store.listConversations({ cursor: firstPage.nextCursor, limit: 2 }).threads.length, 1)
  store.acceptRequest({ clientThreadId: 'client-1', requestId: 'request-1', fingerprint: 'f1', ts: T + 1, localMessageId: 'local-user-1', message: userMessage() })
  const outcome = { status: 'accepted', conversationId: 'native-thread-1', runId: 'native-run-1' }
  const saved = store.recordRequestOutcome({ clientThreadId: 'client-1', requestId: 'request-1', ts: T + 2, outcome })
  assert.deepEqual(saved.outcome, outcome)
  assert.equal(store.recordRequestOutcome({ clientThreadId: 'client-1', requestId: 'request-1', ts: T + 3, outcome }).updatedAt, T + 2)
  const input = { clientThreadId: 'client-1', eventKey: 'assistant-partial-1', ts: T + 4, localMessageId: 'local-assistant-1', localRunId: 'local-run-1', requestId: 'request-1', message: assistantMessage('Exact partial'), boardRefs: ['board-1'] }
  const message = store.appendMessage(input)
  assert.equal(message.id, 'native-assistant-1')
  assert.equal(message.text, 'Exact partial')
  assert.deepEqual(store.appendMessage(input), message)
  assert.throws(() => store.appendMessage({ ...input, message: assistantMessage('Changed') }), { code: 'EVENT_CONFLICT', httpStatus: 409 })
  assert.equal(store.listEvents('client-1', { refType: 'board', refId: 'board-1' }).events[0].details.message.text, 'Exact partial')
  assert.equal(store.listEvents('client-1', { refType: 'context', refId: 'packet-1' }).events[0].details.message.text, 'Exact partial')
})

test('legacy import skips an already-captured conversation without changing records or coverage', t => {
  const { store } = opened(t)
  conversation(store)
  store.appendEvent({ clientThreadId: 'client-1', eventKey: 'captured', ts: T + 1, event: 'run.completed', localRunId: 'captured-local-run', runCheckpoint: publicRun('Captured canonical text', 'completed') })
  store.bindNative({ clientThreadId: 'client-1', localRunId: 'captured-local-run', runId: 'native-run-1' })
  const snapshot = { protocolVersion: 2, conversationId: 'native-thread-1', streamId: 'stream-1', seq: 1, truncated: false, historyComplete: true, runs: [publicRun('Older native text', 'completed')] }
  const before = store.listEvents('client-1').events.length
  const originalCoverage = store.getConversation('client-1').coverage
  const first = store.importSnapshot({ clientThreadId: 'client-1', importId: 'import-1', snapshot })
  assert.equal(first.imported, false)
  assert.equal(first.skippedReason, 'canonical-history-present')
  assert.deepEqual(first.coverage, originalCoverage)
  assert.equal(store.getLatestRun('client-1').messages[1].text, 'Captured canonical text')
  assert.equal(store.listEvents('client-1').events.length, before)
  const replay = store.importSnapshot({ clientThreadId: 'client-1', importId: 'import-1', snapshot })
  assert.equal(replay.imported, false)
  assert.equal(replay.skippedReason, 'canonical-history-present')
  assert.equal(store.listEvents('client-1').events.length, before)
  assert.throws(() => store.importSnapshot({ clientThreadId: 'client-1', importId: 'import-1', snapshot: { ...snapshot, seq: 2 } }), { code: 'IMPORT_CONFLICT', httpStatus: 409 })
  assert.equal(store.listEvents('client-1').events.length, before)
  assert.throws(() => store.importSnapshot({ clientThreadId: 'client-1', importId: 'private', snapshot: { ...snapshot, runs: [{ ...publicRun('x'), credentials: 'bad' }] } }), { code: 'PRIVATE_CHAT_PAYLOAD' })
  assert.equal(store.listEvents('client-1').events.length, before)
})

test('first-write legacy import retains exact public v2 runs and paged canonical events', t => {
  const { dataDir, store } = opened(t)
  const exactText = 'A'.repeat(1_100_000) + ' 끝'
  const snapshot = { protocolVersion: 2, conversationId: 'native-thread-1', streamId: 'stream-1', seq: 8, truncated: true, historyComplete: false, runs: [{ ...publicRun(exactText, 'interrupted'), clientThreadId: 'import-client' }] }
  const first = store.importSnapshot({ clientThreadId: 'import-client', importId: 'legacy-1', snapshot })
  assert.equal(first.imported, true)
  assert.equal(first.coverage.status, 'partial')
  assert.equal(first.coverage.nativeHistoryComplete, false)
  assert.equal(store.getConversation('import-client').conversationId, 'native-thread-1')
  assert.equal(store.getLatestRun('import-client').messages[1].text, exactText)
  const events = store.listEvents('import-client', { limit: 2 })
  assert.equal(events.hasMore, true)
  const runEvent = events.events[1]
  assert.equal(runEvent.details.run.messages[1].text, exactText)
  assert.equal(store.listEvents('import-client').events.find(event => event.event === 'message.checkpoint' && event.details.message.role === 'assistant').messageId, 'native-assistant-1')
  assert.equal(store.importSnapshot({ clientThreadId: 'import-client', importId: 'legacy-1', snapshot }).alreadyImported, true)
  store.close()
  const reopened = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  t.after(() => reopened.close())
  assert.equal(reopened.getLatestRun('import-client').messages[1].text, exactText)
  assert.equal(reopened.listEvents('import-client', { limit: 2 }).events[1].details.run.messages[1].text, exactText)
})

test('local-only public v2 import keeps supplied local IDs and never promotes UI IDs to native', t => {
  const { dataDir, store } = opened(t)
  const localRun = {
    localRunId: 'local-run-from-prefs', conversationId: null, runId: null,
    requestId: null, clientThreadId: 'local-only-client', status: 'interrupted',
    messages: [
      { id: 'ui-user-1', messageId: null, localMessageId: 'local-user-1', role: 'user', text: 'Local user text', status: 'complete' },
      { id: 'ui-answer-1', messageId: null, localMessageId: 'local-answer-1', role: 'assistant', text: 'Local partial answer', status: 'interrupted' },
    ], activities: [], artifacts: [], historyComplete: false, truncated: false,
  }
  const snapshot = { protocolVersion: 2, conversationId: null, streamId: 'local-only', seq: 0, truncated: false, historyComplete: false, runs: [localRun] }
  const result = store.importSnapshot({ clientThreadId: 'local-only-client', importId: 'local-import-1', snapshot })
  assert.equal(result.imported, true)
  assert.equal(result.coverage.status, 'partial')
  assert.equal(store.getConversation('local-only-client').conversationId, null)
  assert.equal(store.getLatestRun('local-only-client').localRunId, 'local-run-from-prefs')
  assert.equal(store.getLatestRun('local-only-client').runId, null)
  const messages = store.listMessages('local-only-client').messages
  assert.deepEqual(messages.map(message => message.localMessageId), ['local-user-1', 'local-answer-1'])
  assert.deepEqual(messages.map(message => message.messageId), [null, null])
  assert.deepEqual(messages.map(message => message.id), ['ui-user-1', 'ui-answer-1'])
  const messageEvents = store.listEvents('local-only-client').events.filter(event => event.event === 'message.checkpoint')
  assert.deepEqual(messageEvents.map(event => event.messageId), [null, null])
  assert.deepEqual(messageEvents.map(event => event.localMessageId), ['local-user-1', 'local-answer-1'])
  const appended = store.appendMessage({ clientThreadId: 'local-only-client', eventKey: 'local-ui-followup', ts: T + 30, localMessageId: 'local-followup-1', message: { id: 'ui-followup-1', messageId: null, role: 'user', text: 'Follow-up text', status: 'complete' } })
  assert.equal(appended.id, 'ui-followup-1')
  assert.equal(store.listEvents('local-only-client').events.at(-1).messageId, null)
  store.close()
  const reopened = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  t.after(() => reopened.close())
  assert.equal(reopened.getLatestRun('local-only-client').localRunId, 'local-run-from-prefs')
  assert.deepEqual(reopened.listEvents('local-only-client').events.filter(event => event.event === 'message.checkpoint').map(event => event.messageId), [null, null])
})

test('oversized public content returns 413 without partial accepted request or import', t => {
  const { store } = opened(t)
  conversation(store)
  const tooLarge = 'X'.repeat(16 * 1024 * 1024)
  assert.throws(() => store.acceptRequest({ clientThreadId: 'client-1', requestId: 'oversize', fingerprint: 'f', ts: T + 1, localMessageId: 'oversize', message: userMessage(tooLarge) }), { code: 'CHAT_PAYLOAD_TOO_LARGE', httpStatus: 413 })
  assert.equal(store.getRequest({ clientThreadId: 'client-1', requestId: 'oversize' }), null)
  assert.equal(store.listEvents('client-1').events.length, 0)
})

test('owner scopes isolate files and schema initializes only once', t => {
  const dataDir = fixture(t)
  const one = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  conversation(one)
  one.close()
  const two = openChatStore({ dataDir, ownerScope: 'desktop/profile-b' })
  t.after(() => two.close())
  assert.equal(two.getConversation('client-1'), null)
  conversation(two)
  const again = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  t.after(() => again.close())
  assert.equal(again.getConversation('client-1').localConversationId, 'local-client-1')
  assert.equal(readdirSync(dataDir).filter(name => name.endsWith('.sqlite')).length, 2)
})

test('corrupt database and unsupported schema fail closed without reset', t => {
  const dataDir = fixture(t)
  const store = openChatStore({ dataDir, ownerScope: 'corrupt-owner' })
  conversation(store)
  store.close()
  const filename = path.join(dataDir, readdirSync(dataDir).find(name => name.endsWith('.sqlite')))
  const before = readFileSync(filename)
  const db = new DatabaseSync(filename)
  db.exec('PRAGMA user_version=99')
  db.close()
  assert.throws(() => openChatStore({ dataDir, ownerScope: 'corrupt-owner' }), { code: 'UNSUPPORTED_STORE_VERSION' })
  assert.ok(readFileSync(filename).length >= before.length)
  writeFileSync(filename, Buffer.from('not a SQLite database'))
  const corrupt = readFileSync(filename)
  assert.throws(() => openChatStore({ dataDir, ownerScope: 'corrupt-owner' }), { code: 'STORE_OPEN_FAILED' })
  assert.deepEqual(readFileSync(filename), corrupt)
})

// Frozen copy of the schema shipped as user_version 1 (before engine columns).
const V1_SCHEMA = `
    CREATE TABLE threads (
      local_conversation_id TEXT PRIMARY KEY, client_thread_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT, title TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
      coverage_json TEXT NOT NULL
    );
    CREATE INDEX threads_recent ON threads(updated_at DESC, client_thread_id);
    CREATE TABLE events (
      local_conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, event_key TEXT NOT NULL,
      event_hash TEXT NOT NULL, event_id TEXT NOT NULL, ts INTEGER NOT NULL,
      event TEXT NOT NULL, request_id TEXT, local_run_id TEXT, local_message_id TEXT,
      run_id TEXT, message_id TEXT, details_json TEXT NOT NULL,
      run_json TEXT, message_json TEXT,
      PRIMARY KEY(local_conversation_id, seq), UNIQUE(local_conversation_id, event_key),
      FOREIGN KEY(local_conversation_id) REFERENCES threads(local_conversation_id)
    );
    CREATE TABLE event_refs (
      local_conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, ref_type TEXT NOT NULL,
      ref_id TEXT NOT NULL, PRIMARY KEY(local_conversation_id, seq, ref_type, ref_id),
      FOREIGN KEY(local_conversation_id, seq) REFERENCES events(local_conversation_id, seq)
    );
    CREATE INDEX event_ref_lookup ON event_refs(local_conversation_id, ref_type, ref_id, seq);
    CREATE TABLE messages (
      local_conversation_id TEXT NOT NULL, local_message_id TEXT NOT NULL,
      local_run_id TEXT, request_id TEXT, message_id TEXT,
      first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, public_json TEXT NOT NULL,
      PRIMARY KEY(local_conversation_id, local_message_id),
      FOREIGN KEY(local_conversation_id) REFERENCES threads(local_conversation_id)
    );
    CREATE INDEX messages_recent ON messages(local_conversation_id, last_seq);
    CREATE TABLE runs (
      local_conversation_id TEXT NOT NULL, local_run_id TEXT NOT NULL,
      request_id TEXT, run_id TEXT, first_seq INTEGER NOT NULL,
      last_seq INTEGER NOT NULL, public_json TEXT NOT NULL,
      PRIMARY KEY(local_conversation_id, local_run_id),
      FOREIGN KEY(local_conversation_id) REFERENCES threads(local_conversation_id)
    );
    CREATE INDEX runs_recent ON runs(local_conversation_id, last_seq);
    CREATE TABLE requests (
      local_conversation_id TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, message_hash TEXT NOT NULL, local_message_id TEXT NOT NULL,
      status TEXT NOT NULL, outcome_json TEXT, accepted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(local_conversation_id, request_id),
      FOREIGN KEY(local_conversation_id) REFERENCES threads(local_conversation_id)
    );
    CREATE TABLE native_runs (
      local_conversation_id TEXT NOT NULL, local_run_id TEXT NOT NULL, run_id TEXT NOT NULL,
      PRIMARY KEY(local_conversation_id, local_run_id),
      FOREIGN KEY(local_conversation_id) REFERENCES threads(local_conversation_id)
    );
    CREATE TABLE native_messages (
      local_conversation_id TEXT NOT NULL, local_message_id TEXT NOT NULL, message_id TEXT NOT NULL,
      PRIMARY KEY(local_conversation_id, local_message_id),
      FOREIGN KEY(local_conversation_id) REFERENCES threads(local_conversation_id)
    );
    CREATE TABLE imports (
      local_conversation_id TEXT NOT NULL, import_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY(local_conversation_id, import_id),
      FOREIGN KEY(local_conversation_id) REFERENCES threads(local_conversation_id)
    );
`
function writeV1Database(dataDir, ownerScope) {
  // Created through the store so the file is private, then rebuilt as v1.
  openChatStore({ dataDir, ownerScope }).close()
  const filename = path.join(dataDir, readdirSync(dataDir).find(name => name.endsWith('.sqlite')))
  for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, { force: true })
  writeFileSync(filename, '', { mode: 0o600 })
  const db = new DatabaseSync(filename)
  db.exec('PRAGMA journal_mode=WAL;')
  db.exec(`BEGIN; ${V1_SCHEMA} PRAGMA user_version=1; COMMIT;`)
  const coverageJson = JSON.stringify({ scope: 'egdesk-local', status: 'unknown', reasons: [], nativeHistoryComplete: null })
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('local-sent', 'client-sent', 'native-thread-1', 'Sent before upgrade', T, T + 3, 2, coverageJson)
  db.prepare('INSERT INTO threads VALUES (?, ?, NULL, NULL, ?, ?, 0, ?)').run('local-draft', 'client-draft', T, T, coverageJson)
  db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)').run('local-sent', 1, 'native-thread:request-1', 'hash-1', 'evt-1', T + 1, 'native.thread.bound', JSON.stringify({ conversationId: 'native-thread-1', ownerHash: 'owner-hash' }))
  db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL)').run('local-sent', 2, 'run-final', 'hash-2', 'evt-2', T + 2, 'run.completed', 'request-1', 'local-run-1', 'native-run-1', JSON.stringify({ status: 'completed' }), JSON.stringify(publicRun('Answer kept across the upgrade', 'completed')))
  db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)').run('local-sent', 'local-run-1', 'request-1', 'native-run-1', 2, 2, JSON.stringify({ ...publicRun('Answer kept across the upgrade', 'completed'), localRunId: 'local-run-1' }))
  db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('local-sent', 'request-1', 'fingerprint-1', 'message-hash-1', 'local-user-1', 'accepted', JSON.stringify({ accepted: true }), T + 1, T + 3)
  db.close()
  return filename
}

test('a v1 database is backed up, then opens as v3 with every conversation, run and request kept and Codex as its engine', t => {
  const dataDir = fixture(t)
  const filename = writeV1Database(dataDir, 'desktop/profile-a')
  const store = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  const sent = store.getConversation('client-sent')
  assert.equal(sent.conversationId, 'native-thread-1')
  assert.equal(sent.title, 'Sent before upgrade')
  assert.equal(sent.engineId, 'codex')
  assert.equal(sent.engineProfileId, 'codex-default')
  const draft = store.getConversation('client-draft')
  assert.equal(draft.engineId, null, 'a chat never sent is not bound to an engine')
  assert.equal(store.getLatestRun('client-sent').messages[1].text, 'Answer kept across the upgrade')
  assert.equal(store.getRequest({ clientThreadId: 'client-sent', requestId: 'request-1' }).fingerprint, 'fingerprint-1')
  assert.deepEqual(store.listEvents('client-sent').events.map(event => event.event), ['native.thread.bound', 'run.completed'])
  assert.equal(store.listConversations({ limit: 10 }).threads.length, 2)
  // The upgraded chat keeps accepting work, and the first send binds the draft.
  store.acceptRequest({ clientThreadId: 'client-sent', requestId: 'request-2', fingerprint: 'fingerprint-2', ts: T + 4, localMessageId: 'local-user-2', message: userMessage('After upgrade') })
  assert.deepEqual(store.bindNative({ clientThreadId: 'client-draft', conversationId: 'native-thread-2', engineId: 'codex', engineProfileId: 'codex-default' }), { clientThreadId: 'client-draft', conversationId: 'native-thread-2', engineId: 'codex', engineProfileId: 'codex-default' })
  assert.equal(store.getConversation('client-draft').engineId, 'codex')
  store.close()
  const raw = new DatabaseSync(filename)
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3)
  assert.equal(raw.prepare("SELECT engine_id FROM runs WHERE local_run_id='local-run-1'").get().engine_id, 'codex')
  raw.close()
  const backup = `${filename}.v1.bak`
  assert.equal(isOwnedAndPrivate(backup, statSync(backup), 0o077), true)
  assert.deepEqual(readdirSync(dataDir).filter(name => name.includes('.tmp')), [])
  const old = new DatabaseSync(backup)
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 1)
  assert.equal(old.prepare('SELECT COUNT(*) AS count FROM threads').get().count, 2)
  assert.equal(old.prepare('SELECT COUNT(*) AS count FROM events').get().count, 2)
  assert.equal(old.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('threads') WHERE name='engine_id'").get().count, 0)
  old.close()
  // Reopening v2 neither migrates again nor rewrites the backup.
  const backupBytes = readFileSync(backup)
  const again = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  assert.equal(again.getConversation('client-sent').engineId, 'codex')
  again.close()
  assert.deepEqual(readFileSync(backup), backupBytes)
})

test('a conversation stays bound to its first engine and runs copy their engine record into the index columns', t => {
  const { dataDir, store } = opened(t)
  conversation(store)
  assert.equal(store.getConversation('client-1').engineId, null)
  store.bindNative({ clientThreadId: 'client-1', conversationId: 'native-thread-1', engineId: 'codex', engineProfileId: 'codex-default' })
  assert.deepEqual(store.bindNative({ clientThreadId: 'client-1', conversationId: 'native-thread-1', engineId: 'codex' }), { clientThreadId: 'client-1', conversationId: 'native-thread-1', engineId: 'codex' })
  assert.throws(() => store.bindNative({ clientThreadId: 'client-1', engineId: 'claude', engineProfileId: 'claude-default' }), { code: 'ENGINE_MAPPING_CONFLICT', httpStatus: 409 })
  assert.throws(() => store.bindNative({ clientThreadId: 'client-1', engineId: 'codex', engineProfileId: 'codex-work' }), { code: 'ENGINE_MAPPING_CONFLICT' })
  assert.throws(() => store.bindNative({ clientThreadId: 'client-1', engineProfileId: 'codex-default' }), { code: 'INVALID_CHAT_RECORD' })
  assert.deepEqual([store.getConversation('client-1').engineId, store.getConversation('client-1').engineProfileId], ['codex', 'codex-default'])
  const engine = { id: 'codex', version: '0.162.1', engineProfileId: 'codex-default' }
  store.appendEvent({ clientThreadId: 'client-1', eventKey: 'run-start', ts: T + 1, event: 'run.started', localRunId: 'local-run-1', runCheckpoint: { ...publicRun('Partial'), engine } })
  store.appendEvent({ clientThreadId: 'client-1', eventKey: 'run-end', ts: T + 2, event: 'run.completed', localRunId: 'local-run-1', runCheckpoint: publicRun('Done', 'completed') })
  assert.deepEqual(store.listEvents('client-1').events[0].details.run.engine, engine)
  const raw = new DatabaseSync(path.join(dataDir, readdirSync(dataDir).find(name => name.endsWith('.sqlite'))))
  assert.deepEqual({ ...raw.prepare("SELECT engine_id, engine_version, engine_profile_id FROM runs WHERE local_run_id='local-run-1'").get() }, { engine_id: 'codex', engine_version: '0.162.1', engine_profile_id: 'codex-default' })
  raw.close()
})

test('an incomplete v1 or v2 schema fails closed without a backup, migration or reset', t => {
  const dataDir = fixture(t)
  const filename = writeV1Database(dataDir, 'desktop/broken-v1')
  const db = new DatabaseSync(filename)
  db.exec('DROP TABLE imports')
  db.close()
  assert.throws(() => openChatStore({ dataDir, ownerScope: 'desktop/broken-v1' }), { code: 'STORE_CORRUPT' })
  assert.equal(readdirSync(dataDir).some(name => name.includes('.bak')), false)
  const check = new DatabaseSync(filename)
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1)
  check.close()
  const other = fixture(t)
  openChatStore({ dataDir: other, ownerScope: 'desktop/broken-v2' }).close()
  const v2 = path.join(other, readdirSync(other).find(name => name.endsWith('.sqlite')))
  const raw = new DatabaseSync(v2)
  raw.exec('DROP INDEX threads_engine; ALTER TABLE threads DROP COLUMN engine_bound_at;')
  raw.close()
  assert.throws(() => openChatStore({ dataDir: other, ownerScope: 'desktop/broken-v2' }), { code: 'STORE_CORRUPT' })
})

// ── v3: the Agent picked for each room and room members as objects ──

// Frozen copy of the v2 upgrade (engine columns) shipped as user_version 2.
const V2_UPGRADE_FROZEN = `
    ALTER TABLE threads ADD COLUMN engine_id TEXT;
    ALTER TABLE threads ADD COLUMN engine_profile_id TEXT;
    ALTER TABLE threads ADD COLUMN engine_bound_at INTEGER;
    UPDATE threads SET engine_id = 'codex', engine_profile_id = 'codex-default' WHERE conversation_id IS NOT NULL;
    ALTER TABLE runs ADD COLUMN engine_id TEXT;
    ALTER TABLE runs ADD COLUMN engine_version TEXT;
    ALTER TABLE runs ADD COLUMN engine_profile_id TEXT;
    UPDATE runs SET engine_id = 'codex' WHERE engine_id IS NULL;
    CREATE INDEX threads_engine ON threads(engine_id, updated_at DESC);
`
function privateKeysIn(value, found = []) {
  if (Array.isArray(value)) for (const item of value) privateKeysIn(item, found)
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) found.push(key)
    privateKeysIn(child, found)
  }
  return found
}

test('a v2 database is backed up, then opens as v3 with every conversation kept and no room Agent or members yet', t => {
  const dataDir = fixture(t)
  const filename = writeV1Database(dataDir, 'desktop/profile-v2')
  const upgrade = new DatabaseSync(filename)
  upgrade.exec(`BEGIN; ${V2_UPGRADE_FROZEN} PRAGMA user_version=2; COMMIT;`)
  upgrade.close()
  const store = openChatStore({ dataDir, ownerScope: 'desktop/profile-v2' })
  const sent = store.getConversation('client-sent')
  assert.deepEqual([sent.title, sent.engineId, sent.engineProfileId, sent.agent], ['Sent before upgrade', 'codex', 'codex-default', null])
  assert.equal(store.getLatestRun('client-sent').messages[1].text, 'Answer kept across the upgrade')
  assert.deepEqual(store.listRoomMembers('client-sent'), { clientThreadId: 'client-sent', members: [] })
  store.close()
  const raw = new DatabaseSync(filename)
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3)
  raw.close()
  const backup = `${filename}.v2.bak`
  assert.equal(isOwnedAndPrivate(backup, statSync(backup), 0o077), true)
  const old = new DatabaseSync(backup)
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(old.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='room_members'").get().count, 0)
  old.close()
  // A v2 file missing its engine columns is damaged, not something to upgrade.
  const other = fixture(t)
  const broken = writeV1Database(other, 'desktop/broken-v2-upgrade')
  const mark = new DatabaseSync(broken)
  mark.exec('PRAGMA user_version=2')
  mark.close()
  assert.throws(() => openChatStore({ dataDir: other, ownerScope: 'desktop/broken-v2-upgrade' }), { code: 'STORE_CORRUPT' })
  assert.equal(readdirSync(other).some(name => name.includes('.bak')), false)
})

test('CHAT-01: each room remembers the Agent picked for it (profile and revision) across restarts, apart from its engine', t => {
  const { dataDir, store } = opened(t)
  conversation(store, 'room-a')
  conversation(store, 'room-b')
  assert.equal(store.getConversation('room-a').agent, null)
  assert.deepEqual(store.setRoomAgent({ clientThreadId: 'room-a', profileId: 'code-reviewer', revision: 3, ts: T + 5 }), { clientThreadId: 'room-a', agent: { profileId: 'code-reviewer', revision: 3, setAt: T + 5 } })
  // The same choice again keeps when it was made; a new revision is a new choice.
  assert.equal(store.setRoomAgent({ clientThreadId: 'room-a', profileId: 'code-reviewer', revision: 3, ts: T + 9 }).agent.setAt, T + 5)
  store.setRoomAgent({ clientThreadId: 'room-b', profileId: 'designer', ts: T + 6 })
  assert.deepEqual(store.getConversation('room-b').agent, { profileId: 'designer', revision: null, setAt: T + 6 })
  store.bindNative({ clientThreadId: 'room-a', conversationId: 'native-a', engineId: 'codex', engineProfileId: 'codex-default' })
  assert.deepEqual([store.getConversation('room-a').engineProfileId, store.getConversation('room-a').agent.profileId], ['codex-default', 'code-reviewer'])
  assert.deepEqual(store.listConversations({ limit: 10 }).threads.map(item => [item.clientThreadId, item.agent?.profileId ?? null]).sort(), [['room-a', 'code-reviewer'], ['room-b', 'designer']])
  store.close()
  const reopened = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  t.after(() => reopened.close())
  assert.deepEqual(reopened.getConversation('room-a').agent, { profileId: 'code-reviewer', revision: 3, setAt: T + 5 })
  assert.deepEqual(reopened.setRoomAgent({ clientThreadId: 'room-a', profileId: null }), { clientThreadId: 'room-a', agent: null })
  for (const input of [
    { clientThreadId: 'room-a' }, { clientThreadId: 'room-a', profileId: 'Code Reviewer' }, { clientThreadId: 'room-a', profileId: 'x'.repeat(81) },
    { clientThreadId: 'room-a', profileId: 'designer', revision: 0 }, { clientThreadId: 'room-a', profileId: null, revision: 2 },
    { clientThreadId: 'room-a', profileId: 'designer', extra: true },
  ]) assert.throws(() => reopened.setRoomAgent(input), { code: 'INVALID_CHAT_RECORD' }, JSON.stringify(input))
  assert.throws(() => reopened.setRoomAgent({ clientThreadId: 'room-missing', profileId: 'designer' }), { code: 'CONVERSATION_NOT_FOUND', httpStatus: 404 })
})

test('CHAT-10: room members are objects (person, Agent profiles, earlier names) kept in order with when they joined', t => {
  const { store } = opened(t)
  conversation(store, 'board-room')
  const set = store.setRoomMembers({ clientThreadId: 'board-room', ts: T + 1, members: [
    { kind: 'user' }, { kind: 'agent', profileId: 'codex-assistant', role: 'admin' }, { profileId: 'designer', addedAt: T - 50 },
  ] })
  assert.deepEqual(set.members, [
    { memberKey: 'user', kind: 'user', profileId: null, role: 'owner', addedAt: T + 1, label: null },
    { memberKey: 'agent:codex-assistant', kind: 'agent', profileId: 'codex-assistant', role: 'admin', addedAt: T + 1, label: null },
    { memberKey: 'agent:designer', kind: 'agent', profileId: 'designer', role: 'member', addedAt: T - 50, label: null },
  ])
  // Replacing the list keeps each existing member's join time; order is the new order.
  const reordered = store.setRoomMembers({ clientThreadId: 'board-room', ts: T + 9, members: [{ profileId: 'designer' }, { kind: 'user' }, { profileId: 'researcher' }] })
  assert.deepEqual(reordered.members.map(item => [item.memberKey, item.addedAt]), [['agent:designer', T - 50], ['user', T + 1], ['agent:researcher', T + 9]])
  // Add: a new member goes last; an existing one changes role but keeps its place and join time.
  const added = store.addRoomMember({ clientThreadId: 'board-room', member: { profileId: 'codex-assistant', role: 'admin' }, ts: T + 10 })
  assert.deepEqual([added.added, added.members.at(-1).memberKey, added.members.at(-1).addedAt], [true, 'agent:codex-assistant', T + 10])
  const promoted = store.addRoomMember({ clientThreadId: 'board-room', member: { profileId: 'designer', role: 'admin' }, ts: T + 11 })
  assert.deepEqual([promoted.added, promoted.members[0].role, promoted.members[0].addedAt], [false, 'admin', T - 50])
  const removed = store.removeRoomMember({ clientThreadId: 'board-room', memberKey: 'agent:researcher' })
  assert.deepEqual([removed.removed, removed.members.map(item => item.memberKey)], [true, ['agent:designer', 'user', 'agent:codex-assistant']])
  assert.equal(store.removeRoomMember({ clientThreadId: 'board-room', memberKey: 'agent:researcher' }).removed, false)
  assert.deepEqual(store.listRoomMembers('board-room').members.map(item => item.memberKey), ['agent:designer', 'user', 'agent:codex-assistant'])

  for (const members of [
    [{ kind: 'user' }, { kind: 'user' }], [{ profileId: 'designer' }, { profileId: 'designer', role: 'admin' }],
    [{ kind: 'robot' }], [{ kind: 'agent' }], [{ kind: 'user', profileId: 'designer' }], [{ profileId: 'Designer' }],
    [{ profileId: 'designer', role: 'guest' }], [{ profileId: 'designer', label: '줄\n바꿈' }], [{ profileId: 'designer', memberKey: 'agent:other' }],
    [{ profileId: 'designer', nickname: 'x' }], 'designer', Array.from({ length: MAX_ROOM_MEMBERS + 1 }, (_, n) => ({ profileId: `agent-${n}` })),
  ]) assert.throws(() => store.setRoomMembers({ clientThreadId: 'board-room', members }), { code: 'INVALID_CHAT_RECORD' }, JSON.stringify(members).slice(0, 80))
  assert.deepEqual(store.listRoomMembers('board-room').members.length, 3, 'a refused list writes nothing')
  store.setRoomMembers({ clientThreadId: 'board-room', members: Array.from({ length: MAX_ROOM_MEMBERS }, (_, n) => ({ profileId: `agent-${n}` })) })
  assert.throws(() => store.addRoomMember({ clientThreadId: 'board-room', member: { kind: 'user' } }), { code: 'ROOM_MEMBER_LIMIT', httpStatus: 409 })
  assert.throws(() => store.listRoomMembers('room-missing'), { code: 'CONVERSATION_NOT_FOUND' })
  assert.deepEqual(privateKeysIn([set, added, removed, store.getConversation('board-room')]), [])
})

test('earlier name lists become member objects: the person, linked Agents and unlinked names kept as labels', t => {
  const { store } = opened(t)
  conversation(store, 'legacy-room')
  // What the screen kept: names, and roles in an object keyed by those names.
  const participants = Object.freeze(['나', '코덱스 어시스턴트', '디자인 리뷰어', '  ', 7, '코덱스 어시스턴트', 'Codex'])
  const participantRoles = Object.freeze({ 나: 'owner', '코덱스 어시스턴트': 'admin', '디자인 리뷰어': 'superuser' })
  const resolveProfileId = name => ({ '코덱스 어시스턴트': 'codex-assistant', Codex: 'codex-assistant' })[name] ?? null
  const members = roomMembersFromLegacy({ participants, participantRoles, resolveProfileId, addedAt: T })
  assert.deepEqual(members, [
    { kind: 'user', role: 'owner', addedAt: T },
    { kind: 'agent', profileId: 'codex-assistant', role: 'admin', label: '코덱스 어시스턴트', addedAt: T },
    { kind: 'agent', role: 'member', label: '디자인 리뷰어', addedAt: T },
  ], 'two names for one Agent become one member; an unknown role falls back')
  const saved = store.setRoomMembers({ clientThreadId: 'legacy-room', members })
  const legacyKey = roomMemberKey({ kind: 'agent', label: '디자인 리뷰어' })
  assert.match(legacyKey, /^legacy:[0-9a-f]{32}$/)
  assert.deepEqual(saved.members.map(item => [item.memberKey, item.profileId, item.label]), [['user', null, null], ['agent:codex-assistant', 'codex-assistant', '코덱스 어시스턴트'], [legacyKey, null, '디자인 리뷰어']])
  // Later the screen links the earlier name to a real Agent: remove the label-only member, add the profile.
  store.removeRoomMember({ clientThreadId: 'legacy-room', memberKey: legacyKey })
  store.addRoomMember({ clientThreadId: 'legacy-room', member: { profileId: 'design-reviewer', label: '디자인 리뷰어' } })
  assert.deepEqual(store.listRoomMembers('legacy-room').members.map(item => item.memberKey), ['user', 'agent:codex-assistant', 'agent:design-reviewer'])
  assert.deepEqual(roomMembersFromLegacy({}), [])
  assert.deepEqual(roomMembersFromLegacy({ participants: ['나', 'x'.repeat(200)], selfName: '나' })[1].label.length, 80)
})
