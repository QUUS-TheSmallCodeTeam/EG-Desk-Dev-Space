import { constants, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

// RT-07 / CHAT-06 local workflow store: one SQLite file for the task graph
// journal, the native task ledger, Agent plans, task sources and written gate
// answers. Before this, four JSON files were each rewritten whole (and
// fsynced) on every event, so saving grew with the history.
//
// - task_events: the graph journal, append-only. Rows are never updated or
//   deleted and must arrive in seq order (triggers), the way an event log is
//   kept in vercel/workflow (Apache-2.0) packages/world/src/events.ts.
// - ledger_meta + ledger_rows: the native ledger as keyed rows written in one
//   transaction, only the rows that changed, like the checkpoint/writes tables
//   of langchain-ai/langgraphjs (MIT) libs/checkpoint-sqlite/src/index.ts.
// - records: small ordered records (plans, sources, gate answers) with a
//   bounded count that the owning module prunes oldest first.
// - store_meta: one marker per legacy JSON file imported once. The JSON file
//   itself is never changed or deleted.
// Both references were read for their pattern only; no code was copied.
// File rules match egdesk-desk-store.mjs: private non-symlink directory,
// private unlinked 0600 database, WAL + FULL, quick_check, user_version.
// A database that fails a check is reported and left as it is, never reset.
const VERSION = 1
export const WORKFLOW_STORE_FILE = 'workflow.sqlite'
export const LEGACY_PARTS = Object.freeze(['task-events', 'native-ledger', 'task-sources', 'task-plans'])
export const RECORD_KINDS = Object.freeze(['plan', 'source', 'gate-answer'])
// g (procedures): saved Browser procedures. The `records` table has a CHECK on its kinds that older databases keep, so this kind lives in its own table,
// created on first use (a database that never saves a procedure is unchanged). The API is the same as for the other kinds.
export const PROCEDURE_RECORD_KIND = 'browser_procedure'
export const LEDGER_COLLECTIONS = Object.freeze(['graphs', 'attempts', 'approvals', 'boardFences'])
const REQUIRED = ['task_events', 'ledger_meta', 'ledger_rows', 'records', 'store_meta',
  'task_events_append_only', 'task_events_kept', 'task_events_in_order']

export function workflowStoreError(code, message, httpStatus = 500) {
  return Object.assign(new Error(message), { code, httpStatus })
}
const fail = (code, message) => { throw workflowStoreError(code, message) }

function initialize(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  if (String(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode).toLowerCase() !== 'wal') fail('WORKFLOW_STORE_OPEN_FAILED', 'WAL could not be enabled')
  db.exec('PRAGMA synchronous=FULL;')
  if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) fail('WORKFLOW_STORE_OPEN_FAILED', 'FULL durability could not be enabled')
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('WORKFLOW_STORE_CORRUPT', 'Workflow database failed its integrity check; it was not reset')
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version === VERSION) {
    const found = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map(row => row.name))
    if (REQUIRED.some(name => !found.has(name))) fail('WORKFLOW_STORE_CORRUPT', 'Workflow schema is incomplete; the database was not reset')
    return
  }
  if (version !== 0 || db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()) {
    fail('WORKFLOW_STORE_UNSUPPORTED_VERSION', 'Existing workflow database has an unsupported schema; it was not reset')
  }
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE task_events (
      seq INTEGER PRIMARY KEY CHECK (seq > 0),
      at TEXT NOT NULL, type TEXT NOT NULL, event_json TEXT NOT NULL
    );
    CREATE TRIGGER task_events_append_only BEFORE UPDATE ON task_events
      BEGIN SELECT RAISE(ABORT, 'task events are append-only'); END;
    CREATE TRIGGER task_events_kept BEFORE DELETE ON task_events
      BEGIN SELECT RAISE(ABORT, 'task events are kept'); END;
    CREATE TRIGGER task_events_in_order BEFORE INSERT ON task_events
      WHEN NEW.seq <> (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_events)
      BEGIN SELECT RAISE(ABORT, 'task events are appended in seq order'); END;
    CREATE TABLE ledger_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0), digest TEXT NOT NULL
    );
    CREATE TABLE ledger_rows (
      collection TEXT NOT NULL CHECK (collection IN ('graphs','attempts','approvals','boardFences')),
      pos INTEGER NOT NULL CHECK (pos >= 0), row_json TEXT NOT NULL,
      PRIMARY KEY (collection, pos)
    );
    CREATE TABLE records (
      kind TEXT NOT NULL CHECK (kind IN ('plan','source','gate-answer')),
      record_key TEXT NOT NULL, ord INTEGER NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY (kind, record_key)
    );
    CREATE INDEX records_order ON records (kind, ord);
    CREATE TABLE store_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=${VERSION};
    COMMIT;`)
}

/**
 * Bytes of a legacy JSON file, or null when it does not exist. Read only: the
 * file is never changed, renamed or deleted, so an older helper still finds it.
 */
export function readLegacyFile(directory, fileName) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null
  try { return readFileSync(path.join(directory, fileName), 'utf8') }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error }
}

/**
 * openWorkflowStore({ directory }) -> store (synchronous, local only)
 *   store.events   count(), rows() -> [{ seq, json }], append(expectedCount, events)
 *   store.ledger   read() -> null | { revision, digest, rows: { graphs: [json], ... } },
 *                  write({ expectedDigest, revision, digest, changes: [{ collection, pos, json|null }] })
 *   store.records  list(kind) -> [{ key, json }] oldest first, insert(kind, key, json),
 *                  replace(kind, key, json) (keeps its place), remove(kind, key), count(kind)
 *   store.legacy   marker(part), importOnce(part, fn) -> { imported, marker }
 *   store.transaction(fn), store.close(), store.closed
 * A conflicting writer gets WORKFLOW_STORE_CONFLICT; nothing is written then.
 */
export function openWorkflowStore({ directory } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory === path.parse(directory).root || directory.includes('\0')) {
    throw new TypeError('A dedicated absolute workflow-store directory is required')
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  const canonicalDir = stat.isDirectory() && !stat.isSymbolicLink() ? realpathSync.native(directory) : null
  if (!canonicalDir || !isOwnedAndPrivate(canonicalDir, stat, 0o077)) {
    throw new TypeError('Workflow-store directory must be a real directory, owned by this user and private (0700)')
  }
  const filename = path.join(canonicalDir, WORKFLOW_STORE_FILE)
  const privateDatabase = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && isOwnedAndPrivate(filename, info, 0o077)
  try {
    if (!privateDatabase(lstatSync(filename))) throw new TypeError('Workflow database must be a private, unlinked regular file')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  closeSync(openSync(filename, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600))
  if (!privateDatabase(lstatSync(filename))) throw new TypeError('Workflow database must be a private, unlinked regular file')
  let db
  try { db = new DatabaseSync(filename); initialize(db) }
  catch (error) {
    try { db?.close() } catch { /* Keep the original error. */ }
    if (['WORKFLOW_STORE_CORRUPT', 'WORKFLOW_STORE_UNSUPPORTED_VERSION', 'WORKFLOW_STORE_OPEN_FAILED'].includes(error.code)) throw error
    fail('WORKFLOW_STORE_OPEN_FAILED', 'Workflow database could not be opened; it was not reset')
  }

  const q = {
    lastSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM task_events'),
    events: db.prepare('SELECT seq, event_json FROM task_events ORDER BY seq'),
    insertEvent: db.prepare('INSERT INTO task_events (seq, at, type, event_json) VALUES (?, ?, ?, ?)'),
    ledgerMeta: db.prepare('SELECT revision, digest FROM ledger_meta WHERE id = 1'),
    ledgerRows: db.prepare('SELECT collection, pos, row_json FROM ledger_rows ORDER BY collection, pos'),
    putLedgerMeta: db.prepare('INSERT INTO ledger_meta (id, revision, digest) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, digest = excluded.digest'),
    putLedgerRow: db.prepare('INSERT INTO ledger_rows (collection, pos, row_json) VALUES (?, ?, ?) ON CONFLICT(collection, pos) DO UPDATE SET row_json = excluded.row_json'),
    deleteLedgerRow: db.prepare('DELETE FROM ledger_rows WHERE collection = ? AND pos = ?'),
    records: db.prepare('SELECT record_key, record_json FROM records WHERE kind = ? ORDER BY ord'),
    recordCount: db.prepare('SELECT COUNT(*) AS n FROM records WHERE kind = ?'),
    insertRecord: db.prepare('INSERT INTO records (kind, record_key, ord, record_json) VALUES (?, ?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM records WHERE kind = ?), ?)'),
    replaceRecord: db.prepare('UPDATE records SET record_json = ? WHERE kind = ? AND record_key = ?'),
    removeRecord: db.prepare('DELETE FROM records WHERE kind = ? AND record_key = ?'),
    meta: db.prepare('SELECT value FROM store_meta WHERE name = ?'),
    putMeta: db.prepare('INSERT INTO store_meta (name, value) VALUES (?, ?)'),
  }
  let closed = false
  let depth = 0
  const ensureOpen = () => { if (closed) fail('WORKFLOW_STORE_CLOSED', 'Workflow store is closed') }
  function transaction(action) {
    ensureOpen()
    if (depth > 0) return action()
    db.exec('BEGIN IMMEDIATE')
    depth += 1
    try { const result = action(); db.exec('COMMIT'); return result }
    catch (error) { try { db.exec('ROLLBACK') } catch { /* Keep the original failure. */ } throw error }
    finally { depth -= 1 }
  }
  const kindOf = kind => { if (!RECORD_KINDS.includes(kind)) throw new TypeError('Unknown workflow record kind'); return kind }
  const text = (value, name) => { if (typeof value !== 'string' || !value) throw new TypeError(`${name} must be nonempty text`); return value }

  const events = {
    count() { ensureOpen(); return q.lastSeq.get().n },
    rows() { ensureOpen(); return q.events.all().map(row => ({ seq: row.seq, json: row.event_json })) },
    /** Appends whole events after exactly expectedCount stored ones, in one transaction. */
    append(expectedCount, list) {
      if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || !Array.isArray(list)) throw new TypeError('append(expectedCount, events) needs a count and a list')
      return transaction(() => {
        if (q.lastSeq.get().n !== expectedCount) fail('WORKFLOW_STORE_CONFLICT', 'Task journal changed outside this writer')
        for (const event of list) {
          if (!Number.isSafeInteger(event?.seq) || typeof event.at !== 'string' || typeof event.type !== 'string') throw new TypeError('Each task event needs seq, at and type')
          q.insertEvent.run(event.seq, event.at, event.type, JSON.stringify(event))
        }
        return expectedCount + list.length
      })
    },
  }

  const ledger = {
    read() {
      ensureOpen()
      const meta = q.ledgerMeta.get()
      const rows = Object.fromEntries(LEDGER_COLLECTIONS.map(name => [name, []]))
      for (const row of q.ledgerRows.all()) {
        const list = rows[row.collection]
        if (!list || row.pos !== list.length) fail('WORKFLOW_STORE_CORRUPT', 'Native ledger rows are not contiguous')
        list.push(row.row_json)
      }
      if (!meta) {
        if (LEDGER_COLLECTIONS.some(name => rows[name].length)) fail('WORKFLOW_STORE_CORRUPT', 'Native ledger rows exist without a revision')
        return null
      }
      return { revision: meta.revision, digest: meta.digest, rows }
    },
    /** Writes only the changed rows and the new revision when the stored digest is still expectedDigest (null = empty). */
    write({ expectedDigest = null, revision, digest, changes = [] } = {}) {
      if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('revision must be a non-negative integer')
      text(digest, 'digest')
      if (!Array.isArray(changes)) throw new TypeError('changes must be a list')
      return transaction(() => {
        if ((q.ledgerMeta.get()?.digest ?? null) !== expectedDigest) fail('WORKFLOW_STORE_CONFLICT', 'Native ledger changed outside this writer')
        for (const change of changes) {
          if (!LEDGER_COLLECTIONS.includes(change?.collection) || !Number.isSafeInteger(change.pos) || change.pos < 0) throw new TypeError('Invalid ledger row change')
          if (change.json === null) q.deleteLedgerRow.run(change.collection, change.pos)
          else q.putLedgerRow.run(change.collection, change.pos, text(change.json, 'row json'))
        }
        q.putLedgerMeta.run(revision, digest)
      })
    },
  }

  const procedureTable = () => {
    db.exec('CREATE TABLE IF NOT EXISTS procedure_records (record_key TEXT PRIMARY KEY, ord INTEGER NOT NULL, record_json TEXT NOT NULL)')
    db.exec('CREATE INDEX IF NOT EXISTS procedure_records_order ON procedure_records (ord)')
  }
  let procedureQ = null
  const proc = () => {
    if (!procedureQ) {
      procedureTable()
      procedureQ = {
        list: db.prepare('SELECT record_key, record_json FROM procedure_records ORDER BY ord'),
        count: db.prepare('SELECT COUNT(*) AS n FROM procedure_records'),
        insert: db.prepare('INSERT INTO procedure_records (record_key, ord, record_json) VALUES (?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM procedure_records), ?)'),
        replace: db.prepare('UPDATE procedure_records SET record_json = ? WHERE record_key = ?'),
        remove: db.prepare('DELETE FROM procedure_records WHERE record_key = ?'),
      }
    }
    return procedureQ
  }
  const isProc = kind => kind === PROCEDURE_RECORD_KIND
  const records = {
    list(kind) { ensureOpen(); return isProc(kind) ? proc().list.all().map(row => ({ key: row.record_key, json: row.record_json })) : q.records.all(kindOf(kind)).map(row => ({ key: row.record_key, json: row.record_json })) },
    count(kind) { ensureOpen(); return isProc(kind) ? proc().count.get().n : q.recordCount.get(kindOf(kind)).n },
    insert(kind, key, json) { ensureOpen(); if (isProc(kind)) proc().insert.run(text(key, 'key'), text(json, 'json')); else q.insertRecord.run(kindOf(kind), text(key, 'key'), kind, text(json, 'json')) },
    replace(kind, key, json) {
      ensureOpen()
      const changes = isProc(kind) ? proc().replace.run(text(json, 'json'), text(key, 'key')).changes : q.replaceRecord.run(text(json, 'json'), kindOf(kind), text(key, 'key')).changes
      if (changes !== 1) fail('WORKFLOW_STORE_CONFLICT', 'Workflow record is missing')
    },
    remove(kind, key) { ensureOpen(); return (isProc(kind) ? proc().remove.run(text(key, 'key')) : q.removeRecord.run(kindOf(kind), text(key, 'key'))).changes === 1 },
  }

  const markerName = part => {
    if (!LEGACY_PARTS.includes(part)) throw new TypeError('Unknown legacy part')
    return `legacy:${part}`
  }
  const legacy = {
    marker(part) {
      ensureOpen()
      const row = q.meta.get(markerName(part))
      if (!row) return null
      try { return JSON.parse(row.value) } catch { fail('WORKFLOW_STORE_CORRUPT', 'Legacy import marker is unreadable') }
    },
    /**
     * Runs fn once per part, in one transaction with its marker. fn returns a
     * small JSON fact ({ source, ... }); if fn throws, nothing is written and
     * the next open tries again.
     */
    importOnce(part, fn) {
      const name = markerName(part)
      return transaction(() => {
        const existing = q.meta.get(name)
        if (existing) return { imported: false, marker: JSON.parse(existing.value) }
        const fact = fn()
        const marker = { ...(fact && typeof fact === 'object' && !Array.isArray(fact) ? fact : {}), at: new Date().toISOString() }
        q.putMeta.run(name, JSON.stringify(marker))
        return { imported: true, marker }
      })
    },
  }

  return {
    directory: canonicalDir,
    filename,
    events, ledger, records, legacy, transaction,
    get closed() { return closed },
    close() { if (!closed) { closed = true; db.close() } },
  }
}
