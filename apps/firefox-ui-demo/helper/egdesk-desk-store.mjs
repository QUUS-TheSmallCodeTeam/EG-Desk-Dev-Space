import { createHash } from 'node:crypto'
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PRIVATE_KEYS } from './egdesk-chat-store.mjs'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

// RT-07 / CTX-01 / CTX-02 local Desk store (one SQLite file per owner scope).
// - Desk recovery journal: every accepted Desk save becomes an immutable
//   generation, unless its content equals the head. Old generations are
//   pruned by one fixed rule (DESK_RETENTION); the head is never pruned.
// - Saved Boards: immutable revisions with a head. A save compares
//   expectedRevision in the same transaction; revert publishes an old body as
//   a new revision instead of moving the head back.
// The two never share rows: a Desk save never changes a Board and a Board
// save never makes a Desk generation. State text lives only in this file.
const VERSION = 1
export const MAX_DESK_STATE_BYTES = 4 * 1024 * 1024
export const MAX_BOARD_BODY_BYTES = 4 * 1024 * 1024
export const MAX_BOARDS = 500
export const MAX_BOARD_REVISIONS = 2000
export const MAX_TITLE_CHARS = 80
// Keep the newest `recent` generations, plus the newest generation of each
// local day for the last `dailyDays` days (today included). If what is kept
// still exceeds `maxBytes`, the oldest kept generations go first. The head
// always stays.
export const DESK_RETENTION = Object.freeze({ recent: 200, dailyDays: 30, maxBytes: 512 * 1024 * 1024 })
export const DESK_REASONS = Object.freeze(['autosave', 'explicit', 'import', 'restore'])
export const SAVE_REASONS = Object.freeze(['autosave', 'explicit'])
export const BOARD_LIFECYCLES = Object.freeze(['active', 'archived'])
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SINGLE_LINE_BAD = /[\u0000-\u001f\u007f\u2028\u2029]/
const MAX_DEPTH = 100
const DAY_MS = 86_400_000

function fail(code, message, httpStatus = 400, extra) {
  throw Object.assign(new Error(message), { code, httpStatus }, extra)
}
const digest = value => createHash('sha256').update(value).digest('hex')
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))

/** JSON text of a public object, or a coded failure; nothing is written on failure. */
function jsonText(value, { name, invalid, privateCode, maxBytes, tooLarge }) {
  if (!plain(value)) fail(invalid, `${name} must be a JSON object`)
  const ancestors = new Set()
  const visit = (part, depth) => {
    if (depth > MAX_DEPTH) fail(invalid, `${name} is too deeply nested`)
    if (part === null || typeof part === 'boolean' || typeof part === 'string' || (typeof part === 'number' && Number.isFinite(part))) return
    if (typeof part !== 'object' || ancestors.has(part) || (!Array.isArray(part) && !plain(part))) fail(invalid, `${name} must be finite JSON data`)
    ancestors.add(part)
    if (Array.isArray(part)) for (const item of part) visit(item, depth + 1)
    else for (const [key, child] of Object.entries(part)) {
      // Same private-field gate as the chat store: such keys never reach disk.
      if (PRIVATE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) fail(privateCode, `${name} contains a private field: ${key}`)
      visit(child, depth + 1)
    }
    ancestors.delete(part)
  }
  visit(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > maxBytes) fail(tooLarge, `${name} exceeds ${maxBytes} bytes; nothing was written`, 413)
  return json
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
/**
 * Content hash: sorted keys, top-level `savedAt` left out. The screen stamps
 * savedAt on every write, so re-saving an unchanged Desk or Board makes no new
 * generation or revision. The stored text keeps savedAt as sent.
 */
export function contentHash(value) {
  if (!plain(value)) fail('INVALID_DESK_CONTENT', 'Content must be a JSON object')
  const content = { ...value }
  delete content.savedAt
  return digest(canonical(content))
}
function payload(value, kind) {
  const desk = kind === 'desk'
  const json = jsonText(value, desk
    ? { name: 'Desk state', invalid: 'INVALID_DESK_STATE', privateCode: 'PRIVATE_DESK_PAYLOAD', maxBytes: MAX_DESK_STATE_BYTES, tooLarge: 'DESK_STATE_TOO_LARGE' }
    : { name: 'Board body', invalid: 'INVALID_BOARD_BODY', privateCode: 'PRIVATE_BOARD_PAYLOAD', maxBytes: MAX_BOARD_BODY_BYTES, tooLarge: 'BOARD_BODY_TOO_LARGE' })
  return { json, hash: contentHash(value), bytes: Buffer.byteLength(json), value }
}
const count = value => Array.isArray(value) ? value.length : null

function positive(value, code, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, `${name} must be a positive integer`)
  return value
}
const nullablePositive = (value, code, name) => value === null ? null : positive(value, code, name)
export function boardId(value) {
  if (typeof value !== 'string' || !BOARD_ID.test(value)) fail('INVALID_BOARD_ID', 'Board ID is invalid')
  return value
}
function title(value) {
  if (typeof value !== 'string') fail('INVALID_BOARD_TITLE', 'Board title must be text')
  const text = value.normalize('NFC').trim()
  const length = Array.from(text).length
  if (!length || length > MAX_TITLE_CHARS || SINGLE_LINE_BAD.test(text)) fail('INVALID_BOARD_TITLE', `Board title must be a single line of 1–${MAX_TITLE_CHARS} characters`)
  return text
}
// Fallback only: a Board body written by the screen carries agenda.title.
function titleFromBody(body) {
  try { return title(body?.agenda?.title) } catch { return null }
}
// Earlier titles were never length-checked; an import keeps them readable
// instead of refusing the whole import.
function importTitle(value, body) {
  try { return title(value) } catch { /* Fall through. */ }
  const fromBody = titleFromBody(body)
  if (fromBody) return fromBody
  const text = typeof value === 'string' ? Array.from(value.normalize('NFC').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()).slice(0, MAX_TITLE_CHARS).join('').trim() : ''
  return text || 'Board'
}
function page(limit, before, fallback, maximum, code) {
  const size = limit === undefined || limit === null ? fallback : limit
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) fail(code, `limit must be 1–${maximum}`)
  return { limit: size, before: before === undefined || before === null ? null : positive(before, code, 'before') }
}
function retentionRule(input = {}) {
  if (!plain(input) || Object.keys(input).some(key => !Object.hasOwn(DESK_RETENTION, key))) fail('INVALID_STORE_OPTIONS', 'retention has an unsupported field')
  const rule = { ...DESK_RETENTION, ...input }
  for (const key of Object.keys(DESK_RETENTION)) positive(rule[key], 'INVALID_STORE_OPTIONS', `retention.${key}`)
  return Object.freeze(rule)
}

const REQUIRED = ['desk_generations', 'boards', 'board_revisions', 'desk_imports', 'store_meta',
  'desk_generations_immutable', 'board_revisions_immutable', 'board_revisions_kept']
function initialize(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  if (String(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode).toLowerCase() !== 'wal') fail('STORE_OPEN_FAILED', 'WAL could not be enabled', 500)
  db.exec('PRAGMA synchronous=FULL;')
  if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) fail('STORE_OPEN_FAILED', 'FULL durability could not be enabled', 500)
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('STORE_CORRUPT', 'Desk database failed integrity check; database was not reset', 500)
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version === VERSION) {
    const found = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map(row => row.name))
    if (REQUIRED.some(name => !found.has(name))) fail('STORE_CORRUPT', 'Desk schema is incomplete; database was not reset', 500)
    return
  }
  if (version !== 0 || db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()) fail('UNSUPPORTED_STORE_VERSION', 'Existing Desk database has an unsupported schema; database was not reset', 500)
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE desk_generations (
      generation INTEGER PRIMARY KEY AUTOINCREMENT,
      parent INTEGER, seq INTEGER NOT NULL CHECK (seq > 0), state_hash TEXT NOT NULL,
      created INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('autosave','explicit','import','restore')),
      restored_from INTEGER, card_count INTEGER, shape_count INTEGER,
      bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= ${MAX_DESK_STATE_BYTES}),
      state_json TEXT NOT NULL
    );
    CREATE TRIGGER desk_generations_immutable BEFORE UPDATE ON desk_generations
      BEGIN SELECT RAISE(ABORT, 'desk generations are immutable'); END;
    CREATE TABLE boards (
      board_id TEXT PRIMARY KEY, title TEXT NOT NULL, head_revision INTEGER NOT NULL,
      metadata_version INTEGER NOT NULL CHECK (metadata_version > 0),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
      created INTEGER NOT NULL, updated INTEGER NOT NULL,
      FOREIGN KEY(board_id, head_revision) REFERENCES board_revisions(board_id, revision) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE board_revisions (
      board_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
      parent_revision INTEGER, hash TEXT NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('user','import')),
      reverted_from INTEGER,
      bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= ${MAX_BOARD_BODY_BYTES}),
      body_json TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY(board_id, revision),
      FOREIGN KEY(board_id) REFERENCES boards(board_id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER board_revisions_immutable BEFORE UPDATE ON board_revisions
      BEGIN SELECT RAISE(ABORT, 'board revisions are immutable'); END;
    CREATE TRIGGER board_revisions_kept BEFORE DELETE ON board_revisions
      BEGIN SELECT RAISE(ABORT, 'board revisions are kept'); END;
    CREATE TABLE desk_imports (import_hash TEXT PRIMARY KEY, created INTEGER NOT NULL, result_json TEXT NOT NULL);
    CREATE TABLE store_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=${VERSION};
    COMMIT;`)
}

/**
 * openDeskStore({dataDir, ownerScope, now?, utcOffsetMinutes?, retention?})
 * Synchronous, local-only. Same file rules as the chat and profile stores:
 * private non-symlink directory, private unlinked 0600 database, WAL + FULL.
 * utcOffsetMinutes fixes what "one day" means for retention (default: this
 * machine's offset at open). now and retention exist for tests.
 */
export function openDeskStore({ dataDir, ownerScope, now = Date.now, utcOffsetMinutes = -new Date().getTimezoneOffset(), retention } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof ownerScope !== 'string' || !ownerScope.trim() || ownerScope.length > 512 || ownerScope.includes('\0')) fail('INVALID_STORE_SCOPE', 'Absolute dataDir and local owner scope are required')
  if (typeof now !== 'function' || !Number.isSafeInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 24 * 60) fail('INVALID_STORE_OPTIONS', 'Invalid clock options')
  const rule = retentionRule(retention)
  const owner = digest(ownerScope)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dataDir)
  const canonicalDir = realpathSync.native(dataDir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(canonicalDir, stat, 0o077)) fail('INVALID_STORE_SCOPE', 'Desk directory must be private and not a symlink')
  const filename = path.join(canonicalDir, `desk-${owner}.sqlite`)
  const privateDatabase = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && isOwnedAndPrivate(filename, info, 0o077)
  try {
    if (!privateDatabase(lstatSync(filename))) fail('INVALID_STORE_SCOPE', 'Desk database must be a private, unlinked regular file')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  closeSync(openSync(filename, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600))
  if (!privateDatabase(lstatSync(filename))) fail('INVALID_STORE_SCOPE', 'Desk database must be a private, unlinked regular file')
  let db
  try { db = new DatabaseSync(filename); initialize(db) }
  catch (error) {
    try { db?.close() } catch { /* Keep original error. */ }
    if (['STORE_CORRUPT', 'UNSUPPORTED_STORE_VERSION', 'STORE_OPEN_FAILED'].includes(error.code)) throw error
    fail('STORE_OPEN_FAILED', 'Desk database could not be opened; database was not reset', 500)
  }

  const SUMMARY = 'generation, parent, seq, state_hash, created, reason, restored_from, card_count, shape_count, bytes'
  const q = {
    head: db.prepare(`SELECT ${SUMMARY} FROM desk_generations ORDER BY generation DESC LIMIT 1`),
    generation: db.prepare('SELECT * FROM desk_generations WHERE generation=?'),
    page: db.prepare(`SELECT ${SUMMARY} FROM desk_generations WHERE generation < ? ORDER BY generation DESC LIMIT ?`),
    kept: db.prepare('SELECT generation, created, bytes FROM desk_generations ORDER BY generation DESC'),
    insertGeneration: db.prepare('INSERT INTO desk_generations (parent, seq, state_hash, created, reason, restored_from, card_count, shape_count, bytes, state_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    deleteGeneration: db.prepare('DELETE FROM desk_generations WHERE generation=?'),
    board: db.prepare('SELECT * FROM boards WHERE board_id=?'),
    boards: db.prepare('SELECT * FROM boards ORDER BY updated DESC, board_id LIMIT ?'),
    boardCount: db.prepare('SELECT COUNT(*) AS n FROM boards'),
    insertBoard: db.prepare('INSERT INTO boards VALUES (?, ?, ?, 1, ?, ?, ?)'),
    moveBoard: db.prepare('UPDATE boards SET head_revision=?, title=?, metadata_version=?, updated=? WHERE board_id=?'),
    revision: db.prepare('SELECT * FROM board_revisions WHERE board_id=? AND revision=?'),
    revisionSummary: db.prepare('SELECT board_id, revision, parent_revision, hash, author, reverted_from, bytes, created FROM board_revisions WHERE board_id=? AND revision < ? ORDER BY revision DESC LIMIT ?'),
    insertRevision: db.prepare('INSERT INTO board_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    importOf: db.prepare('SELECT result_json FROM desk_imports WHERE import_hash=?'),
    lastImport: db.prepare('SELECT import_hash, created FROM desk_imports ORDER BY created DESC, rowid DESC LIMIT 1'),
    insertImport: db.prepare('INSERT INTO desk_imports VALUES (?, ?, ?)'),
  }
  let closed = false
  const ensureOpen = () => { if (closed) fail('STORE_CLOSED', 'Desk store is closed', 500) }
  const tx = action => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = action(); db.exec('COMMIT'); return result }
    catch (error) { try { db.exec('ROLLBACK') } catch { /* Preserve original failure. */ } throw error }
  }
  const clock = () => {
    const ts = now()
    if (!Number.isSafeInteger(ts) || ts < 0) fail('STORE_CLOCK', 'Clock returned an invalid time', 500)
    return ts
  }
  const dayOf = ts => Math.floor((ts + utcOffsetMinutes * 60_000) / DAY_MS)
  const parse = (text, what) => { try { return JSON.parse(text) } catch { fail('STORE_CORRUPT', `Saved ${what} is unreadable; database was not reset`, 500) } }

  // ── Desk generations ──
  const generationSummary = row => ({
    generation: row.generation, parent: row.parent, seq: row.seq, stateHash: row.state_hash,
    createdAt: row.created, reason: row.reason, restoredFrom: row.restored_from,
    cardCount: row.card_count, shapeCount: row.shape_count, bytes: row.bytes,
  })
  function generationRecord(row) {
    const state = parse(row.state_json, 'Desk state')
    if (contentHash(state) !== row.state_hash) fail('STORE_CORRUPT', 'Saved Desk state does not match its hash', 500)
    return { ...generationSummary(row), state }
  }
  const conflict = head => fail('DESK_GENERATION_CONFLICT', 'Desk changed since this state was loaded', 409, { generation: head?.generation ?? null, stateHash: head?.state_hash ?? null })
  const lastImport = () => {
    const row = q.lastImport.get()
    return row ? { importId: row.import_hash, importedAt: row.created } : null
  }
  /** Fixed retention rule; runs inside the inserting transaction. Returns how many were removed. */
  function prune(ts) {
    const rows = q.kept.all()
    const keep = new Set(rows.slice(0, rule.recent).map(row => row.generation))
    const today = dayOf(ts), days = new Set()
    for (const row of rows) { // Newest first, so the first row of a day is its newest.
      const day = dayOf(row.created)
      if (today - day >= rule.dailyDays || days.has(day)) continue
      days.add(day)
      keep.add(row.generation)
    }
    let bytes = rows.reduce((sum, row) => keep.has(row.generation) ? sum + row.bytes : sum, 0)
    for (let index = rows.length - 1; index > 0 && bytes > rule.maxBytes; index--) {
      if (keep.delete(rows[index].generation)) bytes -= rows[index].bytes
    }
    let removed = 0
    for (const row of rows) if (!keep.has(row.generation)) { q.deleteGeneration.run(row.generation); removed++ }
    return removed
  }
  function appendGeneration(head, { json, hash, bytes, value }, reason, restoredFrom = null) {
    const ts = clock()
    const info = q.insertGeneration.run(head?.generation ?? null, (head?.seq ?? 0) + 1, hash, ts, reason, restoredFrom, count(value.cards), count(value.shapes), bytes, json)
    const pruned = prune(ts)
    return { ...generationSummary(q.generation.get(Number(info.lastInsertRowid))), unchanged: false, pruned }
  }
  const unchanged = head => ({ ...generationSummary(head), unchanged: true, pruned: 0 })

  // ── Boards ──
  const boardSummary = row => ({
    boardId: row.board_id, title: row.title, headRevision: row.head_revision,
    metadataVersion: row.metadata_version, lifecycle: row.lifecycle,
    createdAt: row.created, updatedAt: row.updated,
  })
  const revisionSummary = row => ({
    boardId: row.board_id, revision: row.revision, parentRevision: row.parent_revision,
    hash: row.hash, author: row.author, revertedFrom: row.reverted_from, bytes: row.bytes, createdAt: row.created,
  })
  function revisionRecord(row) {
    const body = parse(row.body_json, 'Board revision')
    if (contentHash(body) !== row.hash) fail('STORE_CORRUPT', 'Saved Board revision does not match its hash', 500)
    return { ...revisionSummary(row), body }
  }
  function requireBoard(id) {
    const row = q.board.get(boardId(id))
    if (!row) fail('BOARD_NOT_FOUND', 'Board does not exist', 404)
    return row
  }
  function requireRevision(row, revision) {
    const found = q.revision.get(row.board_id, positive(revision, 'INVALID_BOARD_REVISION', 'revision'))
    if (!found) fail('BOARD_REVISION_NOT_FOUND', 'Board revision does not exist', 404)
    return found
  }
  const revisionConflict = row => fail('BOARD_REVISION_CONFLICT', 'Board changed since this edit started', 409, { headRevision: row?.head_revision ?? null })
  const boardResult = (id, revision, hash, isUnchanged, boardCreated = false) => ({ boardId: id, revision, hash, unchanged: isUnchanged, boardCreated, board: boardSummary(q.board.get(id)) })
  function createBoard(id, name, body, author, ts) {
    if (q.boardCount.get().n >= MAX_BOARDS) fail('BOARD_LIMIT', `At most ${MAX_BOARDS} Boards can be kept`, 409)
    q.insertBoard.run(id, name, 1, 'active', ts, ts)
    q.insertRevision.run(id, 1, null, body.hash, author, null, body.bytes, body.json, ts)
  }
  function appendRevision(row, body, { name = row.title, revertedFrom = null } = {}) {
    if (row.head_revision >= MAX_BOARD_REVISIONS) fail('BOARD_REVISION_LIMIT', `A Board keeps at most ${MAX_BOARD_REVISIONS} revisions`, 409)
    const ts = Math.max(clock(), row.updated)
    const next = row.head_revision + 1
    q.insertRevision.run(row.board_id, next, row.head_revision, body.hash, 'user', revertedFrom, body.bytes, body.json, ts)
    q.moveBoard.run(next, name, row.metadata_version + (name === row.title ? 0 : 1), ts, row.board_id)
    return next
  }

  // ── Import of the screen's earlier preference values ──
  function importItems({ deskSnapshot, boards } = {}) {
    let desk = null
    if (deskSnapshot !== undefined && deskSnapshot !== null) {
      let value = deskSnapshot
      if (typeof value === 'string') { try { value = JSON.parse(value) } catch { fail('DESK_IMPORT_UNREADABLE', 'The earlier Desk snapshot is unreadable; nothing was imported') } }
      if (!plain(value)) fail('DESK_IMPORT_UNREADABLE', 'The earlier Desk snapshot is not a Desk object; nothing was imported')
      desk = payload(value, 'desk')
    }
    const list = boards === undefined || boards === null ? [] : boards
    if (!Array.isArray(list) || list.length > MAX_BOARDS) fail('INVALID_DESK_IMPORT', `boards must be a list of at most ${MAX_BOARDS} items`)
    const items = list.map(item => {
      if (!plain(item) || Object.keys(item).some(key => !['boardId', 'title', 'body'].includes(key))) fail('INVALID_DESK_IMPORT', 'Each Board needs {boardId, title?, body}')
      let value = item.body
      if (typeof value === 'string') { try { value = JSON.parse(value) } catch { fail('DESK_IMPORT_UNREADABLE', 'An earlier Board is unreadable; nothing was imported') } }
      const body = payload(value, 'board')
      const id = boardId(item.boardId)
      const name = importTitle(item.title, value)
      return { id, name, body }
    })
    if (new Set(items.map(item => item.id)).size !== items.length) fail('INVALID_DESK_IMPORT', 'Board IDs in one import must be unique')
    if (!desk && !items.length) fail('INVALID_DESK_IMPORT', 'Nothing to import')
    const importHash = digest(canonical({
      desk: desk?.hash ?? null,
      boards: items.map(item => [item.id, item.name, item.body.hash]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    }))
    return { desk, items, importHash }
  }

  return {
    ownerScopeHash: owner,
    retention: rule,
    /** The newest generation with its state, or nulls for an empty store. */
    current() {
      ensureOpen()
      const head = q.head.get()
      const row = head ? q.generation.get(head.generation) : null
      return row ? { ...generationRecord(row), lastImport: lastImport() } : {
        generation: null, parent: null, seq: null, stateHash: null, createdAt: null, reason: null,
        restoredFrom: null, cardCount: null, shapeCount: null, bytes: null, state: null, lastImport: lastImport(),
      }
    },
    /**
     * Save the screen's Desk. parentGeneration is the generation the screen last
     * saw (null for an empty store). Content equal to the head makes no new
     * generation; otherwise a stale parent is a 409 carrying the latest generation.
     */
    saveCurrent({ state, parentGeneration, reason = 'autosave' } = {}) {
      ensureOpen()
      if (!SAVE_REASONS.includes(reason)) fail('INVALID_DESK_REASON', 'reason must be autosave or explicit')
      if (parentGeneration === undefined) fail('INVALID_DESK_GENERATION', 'parentGeneration is required (null for an empty Desk store)')
      const parent = nullablePositive(parentGeneration, 'INVALID_DESK_GENERATION', 'parentGeneration')
      const desk = payload(state, 'desk')
      return tx(() => {
        const head = q.head.get()
        // Same content as the head (including a retried save whose answer was lost).
        if (head && head.state_hash === desk.hash) return unchanged(head)
        if ((head?.generation ?? null) !== parent) conflict(head)
        return appendGeneration(head, desk, reason)
      })
    },
    generations({ limit, before } = {}) {
      ensureOpen()
      const chosen = page(limit, before, 50, 500, 'INVALID_DESK_QUERY')
      const rows = q.page.all(chosen.before ?? Number.MAX_SAFE_INTEGER, chosen.limit + 1)
      const hasMore = rows.length > chosen.limit
      const shown = rows.slice(0, chosen.limit).map(generationSummary)
      return { head: q.head.get()?.generation ?? null, generations: shown, hasMore, nextBefore: hasMore ? shown.at(-1).generation : null, retention: { ...rule } }
    },
    generation(generation) {
      ensureOpen()
      const row = q.generation.get(positive(generation, 'INVALID_DESK_GENERATION', 'generation'))
      if (!row) fail('DESK_GENERATION_NOT_FOUND', 'Desk generation does not exist or was pruned', 404)
      return generationRecord(row)
    },
    /** Publish an earlier generation's state as a new generation (reason restore). */
    restore({ generation, parentGeneration } = {}) {
      ensureOpen()
      const target = positive(generation, 'INVALID_DESK_GENERATION', 'generation')
      const expected = parentGeneration === undefined ? undefined : nullablePositive(parentGeneration, 'INVALID_DESK_GENERATION', 'parentGeneration')
      return tx(() => {
        const source = q.generation.get(target)
        if (!source) fail('DESK_GENERATION_NOT_FOUND', 'Desk generation does not exist or was pruned', 404)
        const { state } = generationRecord(source)
        const head = q.head.get()
        if (expected !== undefined && head.generation !== expected) conflict(head)
        if (head.state_hash === source.state_hash) return unchanged(head)
        return { ...appendGeneration(head, { json: source.state_json, hash: source.state_hash, bytes: source.bytes, value: state }, 'restore', source.generation) }
      })
    },
    listBoards() {
      ensureOpen()
      return { boards: q.boards.all(MAX_BOARDS).map(boardSummary) }
    },
    board(id) {
      ensureOpen()
      const row = q.board.get(boardId(id))
      return row ? { ...boardSummary(row), head: revisionRecord(q.revision.get(row.board_id, row.head_revision)) } : null
    },
    boardRevisions(id, { limit, before } = {}) {
      ensureOpen()
      const row = requireBoard(id)
      const chosen = page(limit, before, 100, 500, 'INVALID_BOARD_QUERY')
      const rows = q.revisionSummary.all(row.board_id, chosen.before ?? Number.MAX_SAFE_INTEGER, chosen.limit + 1)
      const hasMore = rows.length > chosen.limit
      const shown = rows.slice(0, chosen.limit).map(revisionSummary)
      return { boardId: row.board_id, headRevision: row.head_revision, revisions: shown, hasMore, nextBefore: hasMore ? shown.at(-1).revision : null }
    },
    boardRevision(id, revision) {
      ensureOpen()
      return revisionRecord(requireRevision(requireBoard(id), revision))
    },
    /**
     * Save a Board. expectedRevision is the head this edit started from (null
     * to create). Content equal to the head makes no revision; otherwise a
     * different head is BOARD_REVISION_CONFLICT (409) with headRevision.
     * title (optional) defaults to body.agenda.title; a title change bumps
     * metadataVersion only.
     */
    saveBoard(id, { body, expectedRevision, title: givenTitle } = {}) {
      ensureOpen()
      const key = boardId(id)
      if (expectedRevision === undefined) fail('INVALID_BOARD_REVISION', 'expectedRevision is required (null to create a Board)')
      const expected = nullablePositive(expectedRevision, 'INVALID_BOARD_REVISION', 'expectedRevision')
      const saved = payload(body, 'board')
      const name = givenTitle === undefined || givenTitle === null ? titleFromBody(body) : title(givenTitle)
      return tx(() => {
        const row = q.board.get(key)
        if (!row) {
          if (expected !== null) revisionConflict(null)
          createBoard(key, name ?? 'Board', saved, 'user', clock())
          return boardResult(key, 1, saved.hash, false, true)
        }
        const head = q.revision.get(key, row.head_revision)
        if (row.head_revision !== expected) {
          // Same content as the head, e.g. a retried save whose answer was lost.
          if (head.hash === saved.hash) return boardResult(key, row.head_revision, head.hash, true)
          revisionConflict(row)
        }
        if (head.hash === saved.hash) {
          if (name && name !== row.title) q.moveBoard.run(row.head_revision, name, row.metadata_version + 1, Math.max(clock(), row.updated), key)
          return boardResult(key, row.head_revision, head.hash, true)
        }
        return boardResult(key, appendRevision(row, saved, { name: name ?? row.title }), saved.hash, false)
      })
    },
    /** Publish an earlier revision's body as a new revision; the title is kept. */
    revertBoard(id, { revision, expectedRevision } = {}) {
      ensureOpen()
      const expected = expectedRevision === undefined ? undefined : nullablePositive(expectedRevision, 'INVALID_BOARD_REVISION', 'expectedRevision')
      return tx(() => {
        const row = requireBoard(id)
        const source = requireRevision(row, revision)
        const { body } = revisionRecord(source)
        if (expected !== undefined && row.head_revision !== expected) revisionConflict(row)
        const head = q.revision.get(row.board_id, row.head_revision)
        if (head.hash === source.hash) return { ...boardResult(row.board_id, row.head_revision, head.hash, true), revertedFrom: null }
        const next = appendRevision(row, { json: source.body_json, hash: source.hash, bytes: source.bytes, value: body }, { revertedFrom: source.revision })
        return { ...boardResult(row.board_id, next, source.hash, false), revertedFrom: source.revision }
      })
    },
    /**
     * One-time import of the screen's earlier preference values. The Desk
     * snapshot becomes an `import` generation only when the store has no Desk
     * yet; each Board becomes revision 1 (author import) only when its ID is
     * new. Nothing is overwritten. The same import again is a duplicate.
     */
    importPrefs(input) {
      ensureOpen()
      if (!plain(input) || Object.keys(input).some(key => !['deskSnapshot', 'boards'].includes(key))) fail('INVALID_DESK_IMPORT', 'Send {deskSnapshot?, boards?}')
      const { desk, items, importHash } = importItems(input)
      return tx(() => {
        const previous = q.importOf.get(importHash)
        if (previous) return { duplicate: true, ...parse(previous.result_json, 'import record') }
        const ts = clock()
        let deskResult = null
        if (desk) {
          const head = q.head.get()
          if (!head) deskResult = { status: 'imported', generation: appendGeneration(null, desk, 'import').generation, skipReason: null }
          else if (head.state_hash === desk.hash) deskResult = { status: 'unchanged', generation: head.generation, skipReason: null }
          else deskResult = { status: 'skipped', generation: head.generation, skipReason: 'DESK_EXISTS' }
        }
        const boardResults = items.map(({ id, name, body }) => {
          const row = q.board.get(id)
          if (!row) { createBoard(id, name, body, 'import', ts); return { boardId: id, status: 'imported', revision: 1, skipReason: null } }
          const head = q.revision.get(id, row.head_revision)
          return head.hash === body.hash
            ? { boardId: id, status: 'unchanged', revision: row.head_revision, skipReason: null }
            : { boardId: id, status: 'skipped', revision: row.head_revision, skipReason: 'BOARD_EXISTS' }
        })
        const result = { importId: importHash, importedAt: ts, desk: deskResult, boards: boardResults }
        q.insertImport.run(importHash, ts, JSON.stringify(result))
        return { duplicate: false, ...result }
      })
    },
    /** Board IDs in use (summaries only), for choosing import IDs without reading bodies. */
    boardIds() {
      ensureOpen()
      return new Set(q.boards.all(MAX_BOARDS).map(row => row.board_id))
    },
    /**
     * RT-03 portable .egdesk import as a new copy, in one transaction. Every
     * Board is created as revision 1 (author import) under an ID that must be
     * free; an ID already in use is BOARD_EXISTS (409) and nothing is written.
     * The Desk state, when given, becomes a new `import` generation on top of
     * the current head (the earlier head stays in the journal), or nothing new
     * when it equals the head.
     */
    importPortable({ state = null, boards = [] } = {}) {
      ensureOpen()
      const desk = state === null ? null : payload(state, 'desk')
      if (!Array.isArray(boards) || boards.length > MAX_BOARDS) fail('INVALID_DESK_IMPORT', `boards must be a list of at most ${MAX_BOARDS} items`)
      const items = boards.map(item => {
        if (!plain(item) || Object.keys(item).some(key => !['boardId', 'title', 'body'].includes(key))) fail('INVALID_DESK_IMPORT', 'Each Board needs {boardId, title?, body}')
        const body = payload(item.body, 'board')
        return { id: boardId(item.boardId), name: importTitle(item.title, item.body), body }
      })
      if (new Set(items.map(item => item.id)).size !== items.length) fail('INVALID_DESK_IMPORT', 'Board IDs in one import must be unique')
      if (!desk && !items.length) fail('INVALID_DESK_IMPORT', 'Nothing to import')
      return tx(() => {
        if (q.boardCount.get().n + items.length > MAX_BOARDS) fail('BOARD_LIMIT', `At most ${MAX_BOARDS} Boards can be kept`, 409)
        for (const item of items) if (q.board.get(item.id)) fail('BOARD_EXISTS', 'A Board with this ID already exists; nothing was imported', 409)
        const ts = clock()
        const boardResults = items.map(({ id, name, body }) => {
          createBoard(id, name, body, 'import', ts)
          return { boardId: id, title: name, revision: 1 }
        })
        let deskResult = null
        if (desk) {
          const head = q.head.get()
          deskResult = head && head.state_hash === desk.hash ? unchanged(head) : appendGeneration(head, desk, 'import')
        }
        return { desk: deskResult, boards: boardResults }
      })
    },
    close() { if (!closed) { db.close(); closed = true } },
  }
}
