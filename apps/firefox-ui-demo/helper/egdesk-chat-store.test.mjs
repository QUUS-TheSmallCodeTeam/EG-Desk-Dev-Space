import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openChatStore } from './egdesk-chat-store.mjs'

const T = 1_800_000_000_000
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
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-chat-test-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
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
  assert.equal(statSync(path.join(dataDir, filename)).mode & 0o077, 0)
  const raw = new DatabaseSync(path.join(dataDir, filename))
  assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1)
  raw.close()
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
  assert.equal(store.importSnapshot({ clientThreadId: 'import-client', importId: 'legacy-1', snapshot }).alreadyImported, true)
  store.close()
  const reopened = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  t.after(() => reopened.close())
  assert.equal(reopened.getLatestRun('import-client').messages[1].text, exactText)
  assert.equal(reopened.listEvents('import-client', { limit: 2 }).events[1].details.run.messages[1].text, exactText)
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
