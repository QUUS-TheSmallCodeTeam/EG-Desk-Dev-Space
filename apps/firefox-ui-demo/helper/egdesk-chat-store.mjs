import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

const VERSION = 2
const MAX_RECORD_BYTES = 16 * 1024 * 1024
const MAX_IMPORT_BYTES = 64 * 1024 * 1024
const TERMINAL_RUN = new Set(['completed', 'failed', 'interrupted', 'cancelled'])
const TERMINAL_MESSAGE = new Set(['complete', 'final', 'interrupted', 'error'])
export const PRIVATE_KEYS = new Set([
  'reasoning', 'rawreasoning', 'rawmodelreasoning', 'hiddenreasoning', 'reasoningcontent',
  'credential', 'credentials', 'cookie', 'cookies', 'setcookie',
  'authorization', 'authpayload', 'authtoken', 'accesstoken',
  'refreshtoken', 'sessiontoken', 'apikey', 'privatekey', 'secret',
  'password', 'passphrase', 'clientsecret', 'systemprompt',
])

function fail(code, message, httpStatus = 400, cause) {
  throw Object.assign(new Error(message, cause ? { cause } : undefined), { code, httpStatus })
}
const digest = value => createHash('sha256').update(value).digest('hex')
const hash = value => digest(JSON.stringify(value))
const own = (object, key) => Object.hasOwn(object, key)

function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    fail('INVALID_CHAT_RECORD', 'Unexpected chat storage field')
  }
}
function identifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) fail('INVALID_CHAT_RECORD', `${name} must be a non-empty identifier`)
  return value
}
function time(value, name = 'ts') {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CHAT_RECORD', `${name} must be a millisecond timestamp`)
  return value
}
function refList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10000) fail('INVALID_CHAT_RECORD', 'References must be an array of IDs')
  return [...new Set(value.map(item => identifier(item, 'reference')))].sort()
}
function references(input = {}) {
  const sourceRefs = Array.isArray(input.sourceRefs) ? input.sourceRefs : []
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : []
  const messages = Array.isArray(input.messages) ? input.messages : []
  const activities = Array.isArray(input.activities) ? input.activities : []
  const nestedSources = [...messages, ...activities].flatMap(item => [
    ...(Array.isArray(item?.sourceRefs) ? item.sourceRefs : []),
    ...(Array.isArray(item?.detail?.sourceRefs) ? item.detail.sourceRefs : []),
  ])
  return {
    context: refList([
      ...refList(input.contextRefs), ...refList(input.contextSnapshotIds),
      ...refList(input.context?.contextSnapshotIds),
      ...[...sourceRefs, ...nestedSources].map(ref => ref?.packetId ?? ref?.snapshotId).filter(Boolean),
    ]),
    artifact: refList([...refList(input.artifactRefs), ...artifacts.map(item => item?.id).filter(Boolean)]),
    board: refList(input.boardRefs),
  }
}
function combineReferences(...values) {
  const parts = values.filter(Boolean).map(references)
  return Object.fromEntries(['context', 'artifact', 'board'].map(type => [type, [...new Set(parts.flatMap(part => part[type]))].sort()]))
}
function publicJson(value, name = 'public record', maxBytes = MAX_RECORD_BYTES) {
  const seen = new Set()
  function visit(part, depth) {
    if (depth > 64) fail('INVALID_CHAT_RECORD', `${name} is too deeply nested`)
    if (part === null || typeof part === 'boolean' || typeof part === 'string' || (typeof part === 'number' && Number.isFinite(part))) return
    if (typeof part !== 'object' || seen.has(part)) fail('INVALID_CHAT_RECORD', `${name} must be finite JSON data`)
    seen.add(part)
    if (Array.isArray(part)) {
      for (const item of part) visit(item, depth + 1)
    } else {
      for (const [key, child] of Object.entries(part)) {
        if (PRIVATE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) fail('PRIVATE_CHAT_PAYLOAD', `${name} contains a private field: ${key}`)
        visit(child, depth + 1)
      }
    }
    seen.delete(part)
  }
  visit(value, 0)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > maxBytes) fail('CHAT_PAYLOAD_TOO_LARGE', `${name} exceeds the storage limit; nothing was written`, 413)
  return serialized
}
function parse(value) {
  try { return JSON.parse(value) } catch (error) { fail('STORE_CORRUPT', 'Saved chat data is unreadable; database was not reset', 500, error) }
}
function coverage(value) {
  const result = value ?? { scope: 'egdesk-local', status: 'unknown', reasons: [], nativeHistoryComplete: null }
  shape(result, ['scope', 'status', 'reasons', 'nativeHistoryComplete'])
  if (result.scope !== 'egdesk-local' || !['complete', 'partial', 'unknown'].includes(result.status) || !Array.isArray(result.reasons) || result.reasons.some(reason => typeof reason !== 'string') || ![true, false, null].includes(result.nativeHistoryComplete)) {
    fail('INVALID_CHAT_RECORD', 'Invalid local chat coverage')
  }
  publicJson(result, 'coverage')
  return result
}
// CHAT-09 session kind, read from the conversation's first native binding
// event (no schema change): stateless = started without saved native history;
// forkedFrom = the native conversation (and turn) it was branched from.
function bindingSession(row, details) {
  if (!details || details.conversationId !== row.conversation_id) return { stateless: false, forkedFrom: null }
  const from = details.forkedFrom
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
  return {
    stateless: details.stateless === true,
    forkedFrom: from && typeof from === 'object' && !Array.isArray(from) && id(from.conversationId)
      ? { conversationId: from.conversationId, turnId: id(from.turnId), clientThreadId: id(from.clientThreadId) }
      : null,
  }
}
function thread(row, session = { stateless: false, forkedFrom: null }) {
  if (!row) return null
  return {
    localConversationId: row.local_conversation_id, clientThreadId: row.client_thread_id,
    conversationId: row.conversation_id, title: row.title, createdAt: row.created_at,
    updatedAt: row.updated_at, coverage: parse(row.coverage_json),
    // null until the first send binds the conversation to an engine.
    engineId: row.engine_id ?? null, engineProfileId: row.engine_profile_id ?? null,
    stateless: session.stateless, forkedFrom: session.forkedFrom,
  }
}
function savedEvent(row, db) {
  if (!row) return null
  const refs = { contextRefs: [], artifactRefs: [], boardRefs: [] }
  for (const ref of db.prepare('SELECT ref_type, ref_id FROM event_refs WHERE local_conversation_id=? AND seq=? ORDER BY ref_type, ref_id').all(row.local_conversation_id, row.seq)) {
    refs[`${ref.ref_type}Refs`].push(ref.ref_id)
  }
  return {
    seq: row.seq, eventId: row.event_id, ts: row.ts, event: row.event,
    requestId: row.request_id, localRunId: row.local_run_id,
    localMessageId: row.local_message_id, runId: row.run_id,
    messageId: row.message_id, details: parse(row.details_json), ...refs,
  }
}
function request(row) {
  if (!row) return null
  return {
    requestId: row.request_id, fingerprint: row.fingerprint, status: row.status,
    outcome: row.outcome_json === null ? null : parse(row.outcome_json),
    localMessageId: row.local_message_id, acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
  }
}
function page(afterSeq, limit) {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('INVALID_CHAT_QUERY', 'Invalid page; limit must be 1–500')
}
function resultPage(rows, limit, property, convert = row => parse(row.public_json)) {
  const hasMore = rows.length > limit
  const selected = rows.slice(0, limit)
  return { [property]: selected.map(convert), nextCursor: hasMore ? selected.at(-1).last_seq ?? selected.at(-1).seq : null, hasMore }
}

const V1_TABLES = `
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
const REQUIRED_TABLES = ['threads', 'events', 'event_refs', 'messages', 'runs', 'requests', 'native_runs', 'native_messages', 'imports']
// v2 only adds engine binding columns. Every v1 conversation and run was Codex;
// a thread without a native conversation was never sent and stays unbound.
const V2_UPGRADE = `
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
const V2_COLUMNS = { threads: ['engine_id', 'engine_profile_id', 'engine_bound_at'], runs: ['engine_id', 'engine_version', 'engine_profile_id'] }

// Older builds refuse a v2 file (closed, never reset), so the exact v1 data is
// kept beside it first. VACUUM INTO writes one consistent copy, WAL included,
// into a new private file; nothing is migrated unless the copy completed.
function backupV1(db, filename) {
  const target = `${filename}.v1.bak`
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    closeSync(openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600))
    db.prepare('VACUUM INTO ?').run(temporary)
    const info = lstatSync(temporary)
    if (!info.isFile() || info.isSymbolicLink() || !isOwnedAndPrivate(temporary, info, 0o077)) throw new Error('Backup is not private')
    renameSync(temporary, target)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* Keep original error. */ }
    fail('STORE_MIGRATION_FAILED', 'Chat history backup failed; the database was kept unchanged', 500, error)
  }
}

function initialize(db, filename) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  if (String(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode).toLowerCase() !== 'wal') fail('STORE_OPEN_FAILED', 'WAL could not be enabled', 500)
  db.exec('PRAGMA synchronous=FULL;')
  if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) fail('STORE_OPEN_FAILED', 'FULL durability could not be enabled', 500)
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('STORE_CORRUPT', 'Chat database failed integrity check; database was not reset', 500)
  const version = db.prepare('PRAGMA user_version').get().user_version
  const tablesPresent = () => {
    const found = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
    return REQUIRED_TABLES.every(name => found.has(name))
  }
  if (version === VERSION) {
    const columnsPresent = Object.entries(V2_COLUMNS).every(([table, names]) => {
      const found = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name))
      return names.every(name => found.has(name))
    })
    if (!tablesPresent() || !columnsPresent) fail('STORE_CORRUPT', 'Chat schema is incomplete; database was not reset', 500)
    return
  }
  if (version === 1) {
    if (!tablesPresent()) fail('STORE_CORRUPT', 'Chat schema is incomplete; database was not reset', 500)
    backupV1(db, filename)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`${V2_UPGRADE} PRAGMA user_version=${VERSION};`)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* Preserve original failure. */ }
      fail('STORE_MIGRATION_FAILED', 'Chat history could not be upgraded; the v1 database was kept unchanged', 500, error)
    }
    return
  }
  if (version !== 0 || db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()) fail('UNSUPPORTED_STORE_VERSION', 'Existing chat database has an unsupported schema; database was not reset', 500)
  db.exec(`BEGIN IMMEDIATE;
    ${V1_TABLES}
    ${V2_UPGRADE}
    PRAGMA user_version=${VERSION};
    COMMIT;`)
}

/** Synchronous local-only event store. The caller admits public records before writing. */
export function openChatStore({ dataDir, ownerScope } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof ownerScope !== 'string' || !ownerScope.trim() || ownerScope.length > 512) fail('INVALID_STORE_SCOPE', 'Absolute dataDir and local desktop/profile ownerScope are required')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dataDir)
  // Resolve parent aliases (for example macOS /var) but reject a linked store itself.
  const canonical = realpathSync.native(dataDir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(canonical, stat, 0o077)) fail('INVALID_STORE_SCOPE', 'Chat directory must be private and not a symlink')
  const filename = path.join(canonical, `chat-${digest(ownerScope)}.sqlite`)
  const privateDatabase = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && isOwnedAndPrivate(filename, info, 0o077)
  try {
    if (!privateDatabase(lstatSync(filename))) fail('INVALID_STORE_SCOPE', 'Chat database must be a private, unlinked regular file')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const descriptor = openSync(filename, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600)
  closeSync(descriptor)
  // Windows ignores POSIX modes; inherited DACLs must actually be private.
  // Reject an unsafe existing file rather than changing its permissions in place.
  if (!privateDatabase(lstatSync(filename))) fail('INVALID_STORE_SCOPE', 'Chat database must be a private, unlinked regular file')
  let db
  try { db = new DatabaseSync(filename); initialize(db, filename) }
  catch (error) {
    try { db?.close() } catch { /* Keep original error. */ }
    if (['STORE_CORRUPT', 'UNSUPPORTED_STORE_VERSION', 'STORE_OPEN_FAILED', 'STORE_MIGRATION_FAILED'].includes(error.code)) throw error
    fail('STORE_OPEN_FAILED', 'Chat database could not be opened; database was not reset', 500, error)
  }

  const q = {
    thread: db.prepare('SELECT * FROM threads WHERE client_thread_id=?'),
    event: db.prepare('SELECT * FROM events WHERE local_conversation_id=? AND event_key=?'),
    eventSeq: db.prepare('SELECT * FROM events WHERE local_conversation_id=? AND seq=?'),
    message: db.prepare('SELECT * FROM messages WHERE local_conversation_id=? AND local_message_id=?'),
    run: db.prepare('SELECT * FROM runs WHERE local_conversation_id=? AND local_run_id=?'),
    request: db.prepare('SELECT * FROM requests WHERE local_conversation_id=? AND request_id=?'),
    // The binding is among a conversation's first events; seq order stops there.
    binding: db.prepare("SELECT details_json FROM events WHERE local_conversation_id=? AND event='native.thread.bound' ORDER BY seq LIMIT 1"),
    native: db.prepare('SELECT * FROM threads WHERE conversation_id=? LIMIT 2'),
  }
  const publicThread = row => {
    if (!row) return null
    const binding = row.conversation_id ? q.binding.get(row.local_conversation_id) : null
    return thread(row, bindingSession(row, binding ? parse(binding.details_json) : null))
  }
  let closed = false
  const ensureOpen = () => { if (closed) fail('STORE_CLOSED', 'Chat store is closed', 500) }
  const requireThread = clientThreadId => {
    const row = q.thread.get(identifier(clientThreadId, 'clientThreadId'))
    if (!row) fail('CONVERSATION_NOT_FOUND', 'Local conversation does not exist', 404)
    return row
  }
  const tx = action => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = action(); db.exec('COMMIT'); return result }
    catch (error) { try { db.exec('ROLLBACK') } catch { /* Preserve original failure. */ } throw error }
  }
  const insertRefs = (localId, seq, refs) => {
    const stmt = db.prepare('INSERT INTO event_refs VALUES (?, ?, ?, ?)')
    for (const [type, values] of Object.entries(refs)) for (const refId of values) stmt.run(localId, seq, type, refId)
  }
  const normalizedMessage = (message, localMessageId, localRunId, requestId, seq) => {
    const raw = publicJson(message, 'public message')
    const parsed = parse(raw)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || !['user', 'assistant'].includes(parsed.role) || typeof parsed.text !== 'string') fail('INVALID_CHAT_RECORD', 'A public user/assistant message with exact text is required')
    if (own(parsed, 'localMessageId') && parsed.localMessageId !== localMessageId) fail('MESSAGE_CONFLICT', 'Public message local ID disagrees with storage ID', 409)
    return { ...parsed, localMessageId, localRunId, requestId, seq }
  }
  const priorEventTs = (localId, seq) => q.eventSeq.get(localId, seq)?.ts ?? -1
  const projectMessage = (localId, seq, localMessageId, localRunId, requestId, message) => {
    const existing = q.message.get(localId, localMessageId)
    const projected = normalizedMessage(message, localMessageId, localRunId, requestId, seq)
    if (existing?.local_run_id && localRunId && existing.local_run_id !== localRunId) fail('MESSAGE_CONFLICT', 'Local message moved to a different run', 409)
    if (existing) {
      const prior = parse(existing.public_json)
      if (priorEventTs(localId, existing.last_seq) > priorEventTs(localId, seq) ||
          (TERMINAL_MESSAGE.has(prior.status) && !TERMINAL_MESSAGE.has(projected.status)) ||
          (prior.completionConfirmed === true && projected.completionConfirmed !== true && projected.role === 'assistant')) return prior
    }
    // Public message.id/messageId may be a pre-dispatch UI ID. Only an explicit
    // bindNative call establishes the native mapping.
    const bound = db.prepare('SELECT message_id FROM native_messages WHERE local_conversation_id=? AND local_message_id=?').get(localId, localMessageId)
    const messageId = bound?.message_id ?? null
    const payload = publicJson(projected, 'saved message')
    if (existing) db.prepare('UPDATE messages SET local_run_id=?, request_id=?, message_id=?, last_seq=?, public_json=? WHERE local_conversation_id=? AND local_message_id=?').run(localRunId ?? existing.local_run_id, requestId ?? existing.request_id, messageId ?? existing.message_id, seq, payload, localId, localMessageId)
    else db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(localId, localMessageId, localRunId, requestId, messageId, seq, seq, payload)
    return projected
  }
  const projectRun = (localId, seq, localRunId, requestId, run) => {
    const parsed = parse(publicJson(run, 'public v2 run'))
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) fail('INVALID_CHAT_RECORD', 'Run checkpoint requires the full public v2 run including messages')
    if (own(parsed, 'localRunId') && parsed.localRunId !== localRunId) fail('RUN_CONFLICT', 'Public run local ID disagrees with storage ID', 409)
    const existing = q.run.get(localId, localRunId)
    const runId = typeof parsed.runId === 'string' ? parsed.runId : null
    if (existing && existing.run_id && runId && existing.run_id !== runId) fail('RUN_CONFLICT', 'Local run identity changed', 409)
    if (existing) {
      const prior = parse(existing.public_json)
      if (priorEventTs(localId, existing.last_seq) > priorEventTs(localId, seq) ||
          (TERMINAL_RUN.has(prior.status) && !TERMINAL_RUN.has(parsed.status))) return null
    }
    const projected = { ...parsed, localRunId, requestId: requestId ?? parsed.requestId ?? existing?.request_id ?? null, firstSeq: existing?.first_seq ?? seq, lastSeq: seq }
    const payload = publicJson(projected, 'saved run')
    // run.engine stays canonical in public_json; columns are an index copy.
    const engineText = (value, limit) => typeof value === 'string' && value && value.length <= limit ? value : null
    const engine = [engineText(parsed.engine?.id, 64), engineText(parsed.engine?.version, 64), engineText(parsed.engine?.engineProfileId, 512)]
    if (existing) db.prepare('UPDATE runs SET request_id=?, run_id=?, last_seq=?, public_json=?, engine_id=COALESCE(?, engine_id), engine_version=COALESCE(?, engine_version), engine_profile_id=COALESCE(?, engine_profile_id) WHERE local_conversation_id=? AND local_run_id=?').run(projected.requestId, runId ?? existing.run_id, seq, payload, ...engine, localId, localRunId)
    else db.prepare('INSERT INTO runs (local_conversation_id, local_run_id, request_id, run_id, first_seq, last_seq, public_json, engine_id, engine_version, engine_profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(localId, localRunId, projected.requestId, runId, seq, seq, payload, ...engine)
    return projected
  }
  function appendCore(row, value) {
    const { eventKey, ts, event, requestId = null, localRunId = null, localMessageId = null, runId = null, messageId = null, details = {}, runCheckpoint = null, message = null, refs = references(), project = true } = value
    const localId = row.local_conversation_id
    const publicDetails = message !== null ? { ...details, message } : runCheckpoint !== null ? { ...details, run: runCheckpoint } : details
    const canonical = { eventKey, ts, event, requestId, localRunId, localMessageId, runId, messageId, details: publicDetails, runCheckpoint, message, refs }
    const eventHash = hash(canonical)
    const prior = q.event.get(localId, eventKey)
    if (prior) {
      if (prior.event_hash !== eventHash) fail('EVENT_CONFLICT', 'Event key was replayed with different payload', 409)
      return { record: savedEvent(prior, db), inserted: false, checkpointProjected: false }
    }
    const seq = db.prepare('SELECT last_seq FROM threads WHERE local_conversation_id=?').get(localId).last_seq + 1
    const eventId = `evt-${digest(`${localId}\0${eventKey}`).slice(0, 32)}`
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      localId, seq, eventKey, eventHash, eventId, ts, event, requestId,
      localRunId, localMessageId, runId, messageId, publicJson(publicDetails, 'public event details'),
      runCheckpoint === null ? null : publicJson(runCheckpoint, 'public run checkpoint'),
      message === null ? null : publicJson(message, 'public message'),
    )
    insertRefs(localId, seq, refs)
    const checkpointProjected = runCheckpoint !== null && project ? projectRun(localId, seq, localRunId, requestId, runCheckpoint) !== null : false
    if (message !== null && project) projectMessage(localId, seq, localMessageId, localRunId, requestId, message)
    db.prepare('UPDATE threads SET last_seq=?, updated_at=MAX(updated_at, ?) WHERE local_conversation_id=?').run(seq, ts, localId)
    return { record: savedEvent(q.eventSeq.get(localId, seq), db), inserted: true, checkpointProjected }
  }
  function checkpointMessages(row, eventKey, ts, localRunId, requestId, runCheckpoint, project = true) {
    const messages = runCheckpoint.messages
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      const nativeKey = typeof message.id === 'string' ? message.id : typeof message.messageId === 'string' ? message.messageId : String(index)
      const localMessageId = typeof message.localMessageId === 'string' ? message.localMessageId : `lm-${digest(`${localRunId}\0${nativeKey}`).slice(0, 32)}`
      const messageId = typeof message.messageId === 'string' && message.messageId.trim() ? message.messageId : null
      appendCore(row, { eventKey: `${eventKey}:message:${index}`, ts, event: 'message.checkpoint', requestId, localRunId, localMessageId, runId: runCheckpoint.runId ?? null, messageId, details: {}, message, refs: references(message), project })
    }
  }
  function create(input) {
    shape(input, ['clientThreadId', 'localConversationId', 'title', 'createdAt', 'coverage'])
    const clientThreadId = identifier(input.clientThreadId, 'clientThreadId')
    const existing = q.thread.get(clientThreadId)
    if (existing) {
      if ((input.localConversationId !== undefined && input.localConversationId !== existing.local_conversation_id) || (input.title !== undefined && input.title !== existing.title) || (input.createdAt !== undefined && input.createdAt !== existing.created_at) || (input.coverage !== undefined && publicJson(coverage(input.coverage)) !== existing.coverage_json)) fail('CONVERSATION_CONFLICT', 'Conversation identity was replayed with different content', 409)
      return publicThread(existing)
    }
    const localConversationId = identifier(input.localConversationId ?? randomUUID(), 'localConversationId')
    const createdAt = time(input.createdAt ?? Date.now(), 'createdAt')
    const title = input.title === undefined ? null : input.title
    if (title !== null && (typeof title !== 'string' || title.length > 1000)) fail('INVALID_CHAT_RECORD', 'Invalid conversation title')
    db.prepare('INSERT INTO threads (local_conversation_id, client_thread_id, conversation_id, title, created_at, updated_at, last_seq, coverage_json) VALUES (?, ?, NULL, ?, ?, ?, 0, ?)').run(localConversationId, clientThreadId, title, createdAt, createdAt, publicJson(coverage(input.coverage)))
    return publicThread(q.thread.get(clientThreadId))
  }
  function bind(row, input) {
    const localId = row.local_conversation_id
    // A conversation is locked to the engine (and engine account slot) of its
    // first send; another engine continues only in a new conversation.
    if (input.engineId !== undefined || input.engineProfileId !== undefined) {
      const engineId = identifier(input.engineId, 'engineId')
      const engineProfileId = input.engineProfileId === undefined ? null : identifier(input.engineProfileId, 'engineProfileId')
      if ((row.engine_id && row.engine_id !== engineId) || (engineProfileId && row.engine_profile_id && row.engine_profile_id !== engineProfileId)) fail('ENGINE_MAPPING_CONFLICT', 'Local conversation is bound to a different engine', 409)
      if (!row.engine_id) db.prepare('UPDATE threads SET engine_id=?, engine_profile_id=?, engine_bound_at=? WHERE local_conversation_id=?').run(engineId, engineProfileId, Date.now(), localId)
      else if (!row.engine_profile_id && engineProfileId) db.prepare('UPDATE threads SET engine_profile_id=? WHERE local_conversation_id=?').run(engineProfileId, localId)
    }
    if (input.conversationId !== undefined) {
      const nativeId = identifier(input.conversationId, 'conversationId')
      if (row.conversation_id && row.conversation_id !== nativeId) fail('NATIVE_MAPPING_CONFLICT', 'Local conversation already has a different native thread', 409)
      db.prepare('UPDATE threads SET conversation_id=? WHERE local_conversation_id=?').run(nativeId, localId)
    }
    for (const [localKey, nativeKey, table] of [['localRunId', 'runId', 'native_runs'], ['localMessageId', 'messageId', 'native_messages']]) {
      if (input[localKey] === undefined && input[nativeKey] === undefined) continue
      const localValue = identifier(input[localKey], localKey)
      const nativeValue = identifier(input[nativeKey], nativeKey)
      const existing = db.prepare(`SELECT ${nativeKey === 'runId' ? 'run_id' : 'message_id'} AS native_id FROM ${table} WHERE local_conversation_id=? AND ${nativeKey === 'runId' ? 'local_run_id' : 'local_message_id'}=?`).get(localId, localValue)
      if (existing && existing.native_id !== nativeValue) fail('NATIVE_MAPPING_CONFLICT', 'Local item already has a different native ID', 409)
      if (!existing) db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(localId, localValue, nativeValue)
      const projected = nativeKey === 'runId' ? q.run.get(localId, localValue) : q.message.get(localId, localValue)
      if (projected && projected[nativeKey === 'runId' ? 'run_id' : 'message_id'] && projected[nativeKey === 'runId' ? 'run_id' : 'message_id'] !== nativeValue) fail('NATIVE_MAPPING_CONFLICT', 'Projected native ID disagrees with binding', 409)
      db.prepare(`UPDATE ${nativeKey === 'runId' ? 'runs' : 'messages'} SET ${nativeKey === 'runId' ? 'run_id' : 'message_id'}=? WHERE local_conversation_id=? AND ${nativeKey === 'runId' ? 'local_run_id' : 'local_message_id'}=?`).run(nativeValue, localId, localValue)
    }
    return { clientThreadId: row.client_thread_id, ...(input.conversationId !== undefined || row.conversation_id ? { conversationId: input.conversationId ?? row.conversation_id } : {}), ...(input.engineId !== undefined ? { engineId: input.engineId } : {}), ...(input.engineProfileId !== undefined ? { engineProfileId: input.engineProfileId } : {}), ...(input.localRunId !== undefined ? { localRunId: input.localRunId, runId: input.runId } : {}), ...(input.localMessageId !== undefined ? { localMessageId: input.localMessageId, messageId: input.messageId } : {}) }
  }
  function resolveLocalRunId(row, givenLocalRunId, nativeRunId, requestId, hasCheckpoint) {
    if (givenLocalRunId !== undefined) return identifier(givenLocalRunId, 'localRunId')
    if (!hasCheckpoint) return null
    const localId = row.local_conversation_id
    const matches = new Set()
    if (nativeRunId) {
      for (const found of db.prepare('SELECT local_run_id FROM native_runs WHERE local_conversation_id=? AND run_id=?').all(localId, nativeRunId)) matches.add(found.local_run_id)
      for (const found of db.prepare('SELECT local_run_id FROM runs WHERE local_conversation_id=? AND run_id=?').all(localId, nativeRunId)) matches.add(found.local_run_id)
    }
    if (requestId) for (const found of db.prepare('SELECT local_run_id FROM runs WHERE local_conversation_id=? AND request_id=?').all(localId, requestId)) matches.add(found.local_run_id)
    if (matches.size > 1) fail('LOCAL_RUN_ID_REQUIRED', 'Multiple local runs match; provide localRunId')
    if (matches.size === 1) return [...matches][0]
    if (nativeRunId) return `lr-${digest(`${localId}\0native:${nativeRunId}`).slice(0, 32)}`
    if (requestId) return `lr-${digest(`${localId}\0request:${requestId}`).slice(0, 32)}`
    fail('LOCAL_RUN_ID_REQUIRED', 'Checkpoint requires localRunId, native runId, or requestId')
  }

  return {
    createConversation(input) { ensureOpen(); return tx(() => create(input)) },
    getConversation(clientThreadId) { ensureOpen(); return publicThread(q.thread.get(identifier(clientThreadId, 'clientThreadId'))) },
    // The local conversation bound to one native conversation, or null.
    getConversationByNative(conversationId) {
      ensureOpen()
      const rows = q.native.all(identifier(conversationId, 'conversationId'))
      if (rows.length > 1) fail('NATIVE_MAPPING_CONFLICT', 'More than one local conversation claims this native thread', 409)
      return publicThread(rows[0] ?? null)
    },
    listConversations({ cursor = null, limit = 100 } = {}) {
      ensureOpen(); page(0, limit)
      let boundary = null
      if (cursor !== null) {
        try { boundary = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { fail('INVALID_CHAT_QUERY', 'Invalid conversation cursor') }
        if (!Array.isArray(boundary) || boundary.length !== 2 || !Number.isSafeInteger(boundary[0]) || typeof boundary[1] !== 'string') fail('INVALID_CHAT_QUERY', 'Invalid conversation cursor')
      }
      const rows = boundary
        ? db.prepare('SELECT * FROM threads WHERE updated_at < ? OR (updated_at = ? AND client_thread_id > ?) ORDER BY updated_at DESC, client_thread_id LIMIT ?').all(boundary[0], boundary[0], boundary[1], limit + 1)
        : db.prepare('SELECT * FROM threads ORDER BY updated_at DESC, client_thread_id LIMIT ?').all(limit + 1)
      const hasMore = rows.length > limit
      const selected = rows.slice(0, limit)
      return { threads: selected.map(publicThread), nextCursor: hasMore ? Buffer.from(JSON.stringify([selected.at(-1).updated_at, selected.at(-1).client_thread_id])).toString('base64url') : null, hasMore }
    },
    acceptRequest(input) {
      ensureOpen(); shape(input, ['clientThreadId', 'requestId', 'fingerprint', 'ts', 'localMessageId', 'message'])
      const row = requireThread(input.clientThreadId)
      const requestId = identifier(input.requestId, 'requestId')
      const fingerprint = identifier(input.fingerprint, 'fingerprint')
      const localMessageId = identifier(input.localMessageId, 'localMessageId')
      const ts = time(input.ts)
      const message = parse(publicJson(input.message, 'accepted user message'))
      if (message.role !== 'user' || typeof message.text !== 'string') fail('INVALID_CHAT_RECORD', 'Accepted request requires exact public user message')
      const messageHash = hash(message)
      return tx(() => {
        const prior = q.request.get(row.local_conversation_id, requestId)
        if (prior) {
          if (prior.fingerprint !== fingerprint || prior.message_hash !== messageHash || prior.local_message_id !== localMessageId) fail('REQUEST_CONFLICT', 'requestId was reused with different content', 409)
          return { accepted: false, message: parse(q.message.get(row.local_conversation_id, localMessageId).public_json), request: request(prior) }
        }
        if (q.message.get(row.local_conversation_id, localMessageId)) fail('MESSAGE_CONFLICT', 'Accepted user message ID already belongs to another request', 409)
        const result = appendCore(row, { eventKey: `request:${requestId}:accepted`, ts, event: 'message.accepted', requestId, localMessageId, message, details: {}, refs: references(message) })
        if (!result.inserted) fail('REQUEST_CONFLICT', 'Accepted request event already exists without request record', 409)
        db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)').run(row.local_conversation_id, requestId, fingerprint, messageHash, localMessageId, 'accepted', ts, ts)
        return { accepted: true, message: parse(q.message.get(row.local_conversation_id, localMessageId).public_json), request: request(q.request.get(row.local_conversation_id, requestId)) }
      })
    },
    getRequest({ clientThreadId, requestId }) { ensureOpen(); const row = requireThread(clientThreadId); return request(q.request.get(row.local_conversation_id, identifier(requestId, 'requestId'))) },
    recordRequestOutcome(input) {
      ensureOpen(); shape(input, ['clientThreadId', 'requestId', 'ts', 'outcome'])
      const row = requireThread(input.clientThreadId)
      const requestId = identifier(input.requestId, 'requestId')
      const ts = time(input.ts)
      const outcomeJson = publicJson(input.outcome, 'public request outcome')
      if (!input.outcome || Array.isArray(input.outcome) || typeof input.outcome !== 'object') fail('INVALID_CHAT_RECORD', 'Request outcome must be a public object')
      return tx(() => {
        const prior = q.request.get(row.local_conversation_id, requestId)
        if (!prior) fail('REQUEST_NOT_FOUND', 'Accepted request does not exist', 404)
        if (prior.outcome_json === outcomeJson) return request(prior)
        appendCore(row, { eventKey: `request:${requestId}:outcome:${digest(outcomeJson)}`, ts, event: 'request.outcome', requestId, details: parse(outcomeJson) })
        db.prepare('UPDATE requests SET status=?, outcome_json=?, updated_at=? WHERE local_conversation_id=? AND request_id=?').run(typeof input.outcome.status === 'string' ? input.outcome.status : 'settled', outcomeJson, ts, row.local_conversation_id, requestId)
        return request(q.request.get(row.local_conversation_id, requestId))
      })
    },
    appendMessage(input) {
      ensureOpen(); shape(input, ['clientThreadId', 'eventKey', 'ts', 'localMessageId', 'localRunId', 'requestId', 'message', 'contextRefs', 'artifactRefs', 'boardRefs'])
      const row = requireThread(input.clientThreadId)
      const eventKey = identifier(input.eventKey, 'eventKey')
      const localMessageId = identifier(input.localMessageId, 'localMessageId')
      const localRunId = input.localRunId === undefined ? null : identifier(input.localRunId, 'localRunId')
      const requestId = input.requestId === undefined ? null : identifier(input.requestId, 'requestId')
      const message = parse(publicJson(input.message, 'public message'))
      const messageId = typeof message.messageId === 'string' && message.messageId.trim() ? message.messageId : null
      return tx(() => {
        appendCore(row, { eventKey, ts: time(input.ts), event: 'message.updated', requestId, localRunId, localMessageId, messageId, details: {}, message, refs: combineReferences(input, message) })
        return parse(q.message.get(row.local_conversation_id, localMessageId).public_json)
      })
    },
    appendEvent(input) {
      ensureOpen(); shape(input, ['clientThreadId', 'eventKey', 'ts', 'event', 'details', 'requestId', 'localRunId', 'localMessageId', 'runId', 'messageId', 'contextRefs', 'artifactRefs', 'boardRefs', 'runCheckpoint'])
      const row = requireThread(input.clientThreadId)
      const eventKey = identifier(input.eventKey, 'eventKey')
      const event = identifier(input.event, 'event')
      const ts = time(input.ts)
      const checkpoint = input.runCheckpoint === undefined ? null : parse(publicJson(input.runCheckpoint, 'public v2 run'))
      const requestId = input.requestId === undefined ? checkpoint?.requestId ?? null : identifier(input.requestId, 'requestId')
      const runId = input.runId === undefined ? checkpoint?.runId ?? null : identifier(input.runId, 'runId')
      const localRunId = resolveLocalRunId(row, input.localRunId, runId, requestId, checkpoint !== null)
      if (checkpoint && (!Array.isArray(checkpoint.messages) || (checkpoint.runId && runId && checkpoint.runId !== runId))) fail('INVALID_CHAT_RECORD', 'Checkpoint must be a full public run matching the native runId')
      const details = input.details === undefined ? {} : parse(publicJson(input.details, 'public event details'))
      if (!details || Array.isArray(details) || typeof details !== 'object') fail('INVALID_CHAT_RECORD', 'Event details must be a public object')
      return tx(() => {
        const result = appendCore(row, { eventKey, ts, event, details, requestId, localRunId, localMessageId: input.localMessageId ?? null, runId, messageId: input.messageId ?? null, runCheckpoint: checkpoint, refs: combineReferences(input, details, checkpoint) })
        if (checkpoint && result.inserted) checkpointMessages(row, eventKey, ts, localRunId, requestId, checkpoint, result.checkpointProjected)
        return result.record
      })
    },
    bindNative(input) { ensureOpen(); shape(input, ['clientThreadId', 'conversationId', 'engineId', 'engineProfileId', 'localRunId', 'runId', 'localMessageId', 'messageId']); return tx(() => bind(requireThread(input.clientThreadId), input)) },
    listEvents(clientThreadId, { afterSeq = 0, limit = 100, refType, refId } = {}) {
      ensureOpen(); page(afterSeq, limit)
      const row = requireThread(clientThreadId)
      let rows
      if (refType !== undefined || refId !== undefined) {
        if (!['context', 'artifact', 'board'].includes(refType)) fail('INVALID_CHAT_QUERY', 'Invalid reference type')
        identifier(refId, 'refId')
        rows = db.prepare('SELECT e.* FROM events e JOIN event_refs r ON r.local_conversation_id=e.local_conversation_id AND r.seq=e.seq WHERE e.local_conversation_id=? AND e.seq>? AND r.ref_type=? AND r.ref_id=? ORDER BY e.seq LIMIT ?').all(row.local_conversation_id, afterSeq, refType, refId, limit + 1)
      } else rows = db.prepare('SELECT * FROM events WHERE local_conversation_id=? AND seq>? ORDER BY seq LIMIT ?').all(row.local_conversation_id, afterSeq, limit + 1)
      return resultPage(rows, limit, 'events', eventRow => savedEvent(eventRow, db))
    },
    listMessages(clientThreadId, { afterSeq = 0, limit = 100 } = {}) {
      ensureOpen(); page(afterSeq, limit)
      const row = requireThread(clientThreadId)
      return resultPage(db.prepare('SELECT * FROM messages WHERE local_conversation_id=? AND last_seq>? ORDER BY last_seq LIMIT ?').all(row.local_conversation_id, afterSeq, limit + 1), limit, 'messages')
    },
    listRuns(clientThreadId, { afterSeq = 0, limit = 100 } = {}) {
      ensureOpen(); page(afterSeq, limit)
      const row = requireThread(clientThreadId)
      return resultPage(db.prepare('SELECT * FROM runs WHERE local_conversation_id=? AND last_seq>? ORDER BY last_seq LIMIT ?').all(row.local_conversation_id, afterSeq, limit + 1), limit, 'runs')
    },
    getLatestRun(clientThreadId) {
      ensureOpen(); const row = requireThread(clientThreadId)
      const run = db.prepare('SELECT public_json FROM runs WHERE local_conversation_id=? ORDER BY last_seq DESC LIMIT 1').get(row.local_conversation_id)
      return run ? parse(run.public_json) : null
    },
    importSnapshot(input) {
      ensureOpen(); shape(input, ['clientThreadId', 'importId', 'snapshot'])
      const prepared = prepareImport(input)
      return tx(() => applyImport(prepared))
    },
    /**
     * RT-03 portable import as a new conversation: create it (title, createdAt)
     * and import its public v2 runs in one transaction. A clientThreadId that
     * already exists is CONVERSATION_EXISTS (409) and nothing is written.
     */
    importConversationCopy(input) {
      ensureOpen(); shape(input, ['clientThreadId', 'importId', 'snapshot', 'title', 'createdAt'])
      const prepared = prepareImport({ clientThreadId: input.clientThreadId, importId: input.importId, snapshot: input.snapshot })
      return tx(() => {
        if (q.thread.get(prepared.clientThreadId)) fail('CONVERSATION_EXISTS', 'A conversation with this ID already exists; nothing was imported', 409)
        create({ clientThreadId: prepared.clientThreadId, title: input.title ?? null, createdAt: input.createdAt ?? Date.now() })
        return applyImport(prepared)
      })
    },
    close() { if (!closed) { db.close(); closed = true } },
  }

  function prepareImport(input) {
    const clientThreadId = identifier(input.clientThreadId, 'clientThreadId')
    const importId = identifier(input.importId, 'importId')
    const snapshotJson = publicJson(input.snapshot, 'public v2 snapshot', MAX_IMPORT_BYTES)
    const snapshot = parse(snapshotJson)
    if (snapshot.protocolVersion !== 2 || !Array.isArray(snapshot.runs) || typeof snapshot.truncated !== 'boolean' || typeof snapshot.historyComplete !== 'boolean') fail('INVALID_CHAT_RECORD', 'Import requires an existing public v2 chat snapshot')
    if (snapshot.runs.some(run => (run.conversationId && snapshot.conversationId && run.conversationId !== snapshot.conversationId) || (run.clientThreadId && run.clientThreadId !== clientThreadId))) fail('INVALID_CHAT_RECORD', 'Snapshot runs must belong to the selected thread')
    const payloadHash = digest(snapshotJson)
    const reasons = [
      snapshot.truncated || snapshot.runs.some(run => run.truncated) ? 'snapshot-truncated' : null,
      !snapshot.historyComplete || snapshot.runs.some(run => run.historyComplete === false) ? 'native-history-incomplete' : null,
    ].filter(Boolean)
    const importedCoverage = coverage({ scope: 'egdesk-local', status: reasons.length ? 'partial' : 'complete', reasons, nativeHistoryComplete: snapshot.historyComplete })
    return { clientThreadId, importId, snapshot, payloadHash, importedCoverage }
  }

  // Runs inside the caller's transaction.
  function applyImport({ clientThreadId, importId, snapshot, payloadHash, importedCoverage }) {
    const saved = create({ clientThreadId })
    const row = q.thread.get(clientThreadId)
    const prior = db.prepare('SELECT payload_hash, state FROM imports WHERE local_conversation_id=? AND import_id=?').get(row.local_conversation_id, importId)
    if (prior) {
      if (prior.payload_hash !== payloadHash) fail('IMPORT_CONFLICT', 'Import ID was reused with different content', 409)
      return { imported: false, alreadyImported: prior.state === 'imported', clientThreadId, localConversationId: saved.localConversationId, coverage: thread(q.thread.get(clientThreadId)).coverage, ...(prior.state === 'skipped' ? { skippedReason: 'canonical-history-present' } : {}) }
    }
    if (row.last_seq > 0 || thread(row).coverage.status !== 'unknown') {
      db.prepare('INSERT INTO imports VALUES (?, ?, ?, ?)').run(row.local_conversation_id, importId, payloadHash, 'skipped')
      return { imported: false, alreadyImported: false, clientThreadId, localConversationId: saved.localConversationId, coverage: thread(row).coverage, skippedReason: 'canonical-history-present' }
    }
    if (typeof snapshot.conversationId === 'string' && snapshot.conversationId) bind(row, { conversationId: snapshot.conversationId })
    const ts = Date.now()
    appendCore(row, { eventKey: `import:${importId}`, ts, event: 'history.imported', details: { importId, runCount: snapshot.runs.length, truncated: snapshot.truncated, historyComplete: snapshot.historyComplete } })
    for (let index = 0; index < snapshot.runs.length; index++) {
      const run = snapshot.runs[index]
      const nativeRunId = typeof run.runId === 'string' ? run.runId : null
      const mapped = nativeRunId ? db.prepare('SELECT local_run_id FROM native_runs WHERE local_conversation_id=? AND run_id=?').get(row.local_conversation_id, nativeRunId) : null
      const suppliedLocalRunId = run.localRunId == null ? null : identifier(run.localRunId, 'localRunId')
      if (mapped && suppliedLocalRunId && mapped.local_run_id !== suppliedLocalRunId) fail('NATIVE_MAPPING_CONFLICT', 'Imported local run ID disagrees with existing native mapping', 409)
      const localRunId = suppliedLocalRunId ?? mapped?.local_run_id ?? `lr-${digest(`${row.local_conversation_id}\0${nativeRunId ?? `${importId}:${index}`}`).slice(0, 32)}`
      if (q.run.get(row.local_conversation_id, localRunId)) continue // Preserve canonical captured run.
      const eventKey = `import:${importId}:run:${index}`
      appendCore(row, { eventKey, ts, event: 'run.imported', requestId: run.requestId ?? null, localRunId, runId: nativeRunId, details: {}, runCheckpoint: run, refs: references(run) })
      checkpointMessages(row, eventKey, ts, localRunId, run.requestId ?? null, run)
      if (nativeRunId) bind(row, { localRunId, runId: nativeRunId })
    }
    db.prepare('INSERT INTO imports VALUES (?, ?, ?, ?)').run(row.local_conversation_id, importId, payloadHash, 'imported')
    db.prepare('UPDATE threads SET coverage_json=? WHERE local_conversation_id=?').run(publicJson(importedCoverage), row.local_conversation_id)
    return { imported: true, alreadyImported: false, clientThreadId, localConversationId: saved.localConversationId, coverage: importedCoverage }
  }
}
