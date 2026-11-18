import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PRIVATE_KEYS } from './egdesk-chat-store.mjs'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'
import { DAY_MS, DESK_AUTOSAVE_MERGE_MS, DESK_RETENTION, autosaveWindowMerges, planDeskRetention } from './egdesk-recovery-journal.mjs'

// RT-07 / CTX-01 / CTX-02 local Desk store (one SQLite file per owner scope).
// - Desk recovery journal: every accepted Desk save becomes an immutable
//   generation, unless its content equals the head. Old generations are
//   pruned by one fixed rule (DESK_RETENTION); the head is never pruned.
//   Autosaves within one DESK_AUTOSAVE_MERGE_MS window replace the head
//   autosave instead of adding a row (D-R1, 60 s); an explicit save, a
//   restore and an import always add a row, and a head another writer
//   collided with (409) is never replaced. Both rules are pure functions in
//   helper/egdesk-recovery-journal.mjs; this file only feeds them rows.
//   Chat transcripts inside a Desk state (chat.threads[].messages) are kept
//   once per message in desk_blobs and shared by every generation that holds
//   them; reads give back the exact state that was saved.
// - Saved Boards: immutable revisions with a head. A save compares
//   expectedRevision in the same transaction; revert publishes an old body as
//   a new revision instead of moving the head back. Each head is indexed for
//   search (title, card names, memo and label text; SQLite FTS5 trigram when
//   available). mergeBoardBodies merges per card (base, mine, theirs).
// The two never share rows: a Desk save never changes a Board and a Board
// save never makes a Desk generation. State text lives only in this file.
//
// Patterns followed (no code copied):
// - VS Code working copy history (MIT, Copyright (c) Microsoft Corporation):
//   a save within the merge window replaces the newest entry instead of
//   adding one (src/vs/workbench/services/workingCopy/common/
//   workingCopyHistoryService.ts:122-140, workbench.localHistory.mergeWindow).
//   Unlike VS Code the window is anchored at the first save it absorbed, so
//   continuous editing still leaves one recovery point per window.
// - excalidraw (MIT, Copyright (c) 2020 Excalidraw): merge per element ID,
//   remote order first, then local-only elements (packages/excalidraw/data/
//   reconcile.ts:23-39, :73-110). Here a common base decides instead of
//   version numbers.
// - context-mode (ELv2, pattern only): FTS5 trigram table with weighted bm25
//   per column (src/store.ts:333-346, :394-412).
// - tldraw (tldraw license, pattern only): a schema version and ordered
//   migrations (packages/store/src/lib/migrate.ts:55-106); document state kept
//   apart from session state (TLSessionStateSnapshot.ts:83-130).
const VERSION = 3
export const MAX_DESK_STATE_BYTES = 4 * 1024 * 1024
export const MAX_BOARD_BODY_BYTES = 4 * 1024 * 1024
export const MAX_BOARDS = 500
export const MAX_BOARD_REVISIONS = 2000
export const MAX_TITLE_CHARS = 80
// D-R1: keep the newest `recent` generations, plus the newest generation of
// each local day for the last `dailyDays` days (today included). If what is
// kept still exceeds `maxBytes`, the oldest kept generations go first. The
// head always stays. Bytes are what is on disk: a shared chat message counts
// once. The numbers and the rule live in egdesk-recovery-journal.mjs.
export { DESK_AUTOSAVE_MERGE_MS, DESK_RETENTION }
export const DESK_REASONS = Object.freeze(['autosave', 'explicit', 'import', 'restore'])
export const SAVE_REASONS = Object.freeze(['autosave', 'explicit'])
export const BOARD_LIFECYCLES = Object.freeze(['active', 'archived'])
export const BOARD_SEARCH_LIMITS = Object.freeze({ queryChars: 200, terms: 8, results: 100, cardsChars: 32 * 1024, notesChars: 64 * 1024, snippetChars: 120 })
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SINGLE_LINE_BAD = /[\u0000-\u001f\u007f\u2028\u2029]/
const MAX_DEPTH = 100
const CONTESTED_KEPT = 64

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
/**
 * CTX-02 / RT-07: what a Desk generation keeps on disk. Each non-empty
 * chat.threads[i].messages list is replaced by null in the stored text (key
 * order kept) and its messages become content-addressed blobs; chatRefs
 * records [threadIndex, [blobHash...]] to put them back. A Desk without chat
 * is stored as sent.
 */
function deskPayload(value) {
  const base = payload(value, 'desk')
  const threads = plain(value.chat) && Array.isArray(value.chat.threads) ? value.chat.threads : null
  const refs = [], blobs = new Map()
  const stripped = threads ? threads.map((thread, index) => {
    if (!plain(thread) || !Array.isArray(thread.messages) || !thread.messages.length) return thread
    refs.push([index, thread.messages.map(message => {
      const json = JSON.stringify(message)
      const hash = digest(json)
      blobs.set(hash, json)
      return hash
    })])
    return { ...thread, messages: null }
  }) : null
  if (!refs.length) return { ...base, storedJson: base.json, refsJson: null, blobs, storedBytes: base.bytes }
  const storedJson = JSON.stringify({ ...value, chat: { ...value.chat, threads: stripped } })
  const refsJson = JSON.stringify(refs)
  return { ...base, storedJson, refsJson, blobs, storedBytes: Buffer.byteLength(storedJson) + Buffer.byteLength(refsJson) }
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

// ── Board search text ──

const searchLine = (value, max = 500) => typeof value === 'string' ? Array.from(value.normalize('NFC').replace(/\s+/g, ' ').trim()).slice(0, max).join('') : ''
const searchBody = (value, max) => typeof value === 'string' ? Array.from(value.normalize('NFC').replace(/\r\n?/g, '\n').trim()).slice(0, max).join('') : ''
function urlWords(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    let pathname = url.pathname
    try { pathname = decodeURIComponent(pathname) } catch { /* Keep encoded. */ }
    return `${url.hostname}${pathname === '/' ? '' : pathname}`
  } catch { return '' }
}
const capped = (parts, max) => Array.from(parts.filter(Boolean).join('\n')).slice(0, max).join('')
/**
 * CTX-03 search text of one Board body: card names (Browser title and site,
 * result title, folder name, any title/label/name field) and memo text (label
 * marks, memos and their replies). Only strings are read; nothing else.
 */
export function boardSearchText(body) {
  const cards = [], notes = []
  for (const card of Array.isArray(body?.cards) ? body.cards : []) {
    if (!plain(card)) continue
    const state = plain(card.runtimeState) ? card.runtimeState : {}
    const source = plain(card.sourceRef) ? card.sourceRef : {}
    const names = [card.title, card.label, card.name, state.title, state.label, state.name, plain(state.root) ? state.root.name : null, source.title, source.label]
      .map(value => searchLine(value))
    if (card.type === 'browser') names.push(urlWords(state.uri ?? source.uri))
    const line = [...new Set(names.filter(Boolean))].join(' · ')
    if (line) cards.push(line)
  }
  for (const shape of Array.isArray(body?.shapes) ? body.shapes : []) {
    if (plain(shape) && shape.type === 'label') notes.push(searchBody(shape.runtimeState?.text, 1000))
  }
  for (const memo of Array.isArray(body?.memos) ? body.memos : []) {
    if (!plain(memo)) continue
    notes.push(searchBody(memo.text, 2000))
    for (const reply of Array.isArray(memo.replies) ? memo.replies : []) if (plain(reply)) notes.push(searchBody(reply.text, 2000))
  }
  return { cards: capped(cards, BOARD_SEARCH_LIMITS.cardsChars), notes: capped(notes, BOARD_SEARCH_LIMITS.notesChars) }
}
function searchTerms(query) {
  if (typeof query !== 'string') fail('INVALID_BOARD_QUERY', 'q (search text) is required')
  const text = query.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!text || Array.from(text).length > BOARD_SEARCH_LIMITS.queryChars) fail('INVALID_BOARD_QUERY', `Search text must be 1–${BOARD_SEARCH_LIMITS.queryChars} characters`)
  const terms = [...new Set(text.split(' '))]
  if (terms.length > BOARD_SEARCH_LIMITS.terms) fail('INVALID_BOARD_QUERY', `Search text may hold at most ${BOARD_SEARCH_LIMITS.terms} words`)
  return terms
}
function snippetOf(text, terms) {
  if (!text) return null
  const lower = text.toLowerCase()
  let at = -1, size = 0
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase())
    if (found !== -1 && (at === -1 || found < at)) { at = found; size = term.length }
  }
  if (at === -1) return null
  const half = Math.floor((BOARD_SEARCH_LIMITS.snippetChars - size) / 2)
  const start = Math.max(0, at - half), end = Math.min(text.length, at + size + half)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}

// ── Card-level three-way merge (CTX-01) ──

const COLLECTIONS = Object.freeze({ cards: 'card', shapes: 'shape', memos: 'memo' })
const same = (a, b) => canonical(a) === canonical(b)
function idIndex(list, who, name) {
  const map = new Map()
  if (list === undefined || list === null) return map
  if (!Array.isArray(list)) fail('INVALID_BOARD_MERGE', `${who} ${name} must be a list`)
  for (const item of list) {
    if (!plain(item) || typeof item.id !== 'string' || !item.id) fail('INVALID_BOARD_MERGE', `Every item in ${who} ${name} needs a text id`)
    if (map.has(item.id)) fail('INVALID_BOARD_MERGE', `${who} ${name} repeats id ${item.id}`)
    map.set(item.id, item)
  }
  return map
}
/** Set merge for ID lists: added by either side stays, removed by either side goes. Theirs order first. */
function mergeIdList(base, mine, theirs) {
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
  const b = new Set(strings(base)), m = new Set(strings(mine)), t = new Set(strings(theirs))
  const keep = id => (m.has(id) && t.has(id)) || (m.has(id) && !b.has(id)) || (t.has(id) && !b.has(id))
  return [...new Set([...strings(theirs), ...strings(mine)])].filter(keep)
}

/**
 * mergeBoardBodies({base, mine, theirs, prefer = 'mine'}) -> {body, conflicts, clean}
 * Pure three-way merge of saved Board bodies. Cards, marks (shapes) and memos
 * merge by id; every other top-level field, and each agenda field, merges as
 * one value. A side that left a value as it was in base takes the other
 * side's value. When both changed it differently, `prefer` wins and a
 * conflict is listed; a deletion never beats a change (the changed one is
 * kept and listed). agenda.memberCardIds follows the merged cards. savedAt is
 * the later of the two. base may be null (both created the Board).
 * conflicts: [{kind: card|shape|memo|field, id?, path?, reason:
 * both-changed|both-added|mine-deleted|theirs-deleted, kept: mine|theirs,
 * mine, theirs}] with null for a deleted side.
 */
export function mergeBoardBodies({ base = null, mine, theirs, prefer = 'mine' } = {}) {
  if (!plain(mine) || !plain(theirs) || (base !== null && base !== undefined && !plain(base))) fail('INVALID_BOARD_MERGE', 'base, mine and theirs must be Board bodies')
  if (!['mine', 'theirs'].includes(prefer)) fail('INVALID_BOARD_MERGE', 'prefer must be mine or theirs')
  const b = base ?? {}
  const conflicts = []
  const merge3 = (bv, mv, tv, where) => {
    if (same(mv, tv)) return mv
    if (same(bv, mv)) return tv
    if (same(bv, tv)) return mv
    const reason = mv === undefined ? 'mine-deleted' : tv === undefined ? 'theirs-deleted' : bv === undefined ? 'both-added' : 'both-changed'
    const kept = reason === 'mine-deleted' ? 'theirs' : reason === 'theirs-deleted' ? 'mine' : prefer
    conflicts.push({ ...where, reason, kept, mine: mv ?? null, theirs: tv ?? null })
    return kept === 'mine' ? mv : tv
  }
  const keys = [...new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(b)])]
  const body = {}
  const keptCards = new Set() // cards a conflict kept (e.g. changed on one side, deleted on the other)
  for (const key of keys) {
    if (key === 'savedAt') {
      const times = [mine.savedAt, theirs.savedAt].filter(Number.isFinite)
      const value = times.length ? Math.max(...times) : mine.savedAt ?? theirs.savedAt
      if (value !== undefined) body.savedAt = value
      continue
    }
    if (Object.hasOwn(COLLECTIONS, key) && [b[key], mine[key], theirs[key]].some(Array.isArray)) {
      const kind = COLLECTIONS[key]
      const bm = idIndex(b[key], 'base', key), mm = idIndex(mine[key], 'mine', key), tm = idIndex(theirs[key], 'theirs', key)
      const merged = []
      for (const id of new Set([...tm.keys(), ...mm.keys()])) {
        const before = conflicts.length
        const value = merge3(bm.get(id), mm.get(id), tm.get(id), { kind, id })
        if (value !== undefined) merged.push(value)
        if (kind === 'card' && conflicts.length > before && value !== undefined) keptCards.add(id)
      }
      body[key] = merged
      continue
    }
    if (key === 'agenda' && [b.agenda, mine.agenda, theirs.agenda].every(value => value === undefined || plain(value)) && (plain(mine.agenda) || plain(theirs.agenda))) {
      const ba = b.agenda ?? {}, ma = mine.agenda ?? {}, ta = theirs.agenda ?? {}
      const agenda = {}
      for (const field of new Set([...Object.keys(ta), ...Object.keys(ma), ...Object.keys(ba)])) {
        const value = field === 'memberCardIds'
          ? ([ba, ma, ta].some(side => Array.isArray(side.memberCardIds)) ? mergeIdList(ba.memberCardIds, ma.memberCardIds, ta.memberCardIds) : undefined)
          : merge3(ba[field], ma[field], ta[field], { kind: 'field', path: `agenda.${field}` })
        if (value !== undefined) agenda[field] = value
      }
      body.agenda = agenda
      continue
    }
    const value = merge3(b[key], mine[key], theirs[key], { kind: 'field', path: key })
    if (value !== undefined) body[key] = value
  }
  // Members follow the merged cards, in card order: a member without a card
  // goes, and a card a conflict kept stays a member.
  if (plain(body.agenda) && Array.isArray(body.agenda.memberCardIds) && Array.isArray(body.cards)) {
    const members = new Set(body.agenda.memberCardIds)
    body.agenda.memberCardIds = body.cards.map(card => card.id).filter(id => members.has(id) || keptCards.has(id))
  }
  return { body, conflicts, clean: conflicts.length === 0 }
}

// ── Schema ──

// Frozen: the schema shipped as user_version 1.
const V1_SCHEMA = `
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
`
const V1_REQUIRED = ['desk_generations', 'boards', 'board_revisions', 'desk_imports', 'store_meta',
  'desk_generations_immutable', 'board_revisions_immutable', 'board_revisions_kept']
// v2 adds columns and tables only. v1 generations keep their full text
// (chat_refs_json NULL, stored_bytes NULL = bytes, window_start NULL = created).
const V2_UPGRADE = `
    ALTER TABLE desk_generations ADD COLUMN window_start INTEGER;
    ALTER TABLE desk_generations ADD COLUMN stored_bytes INTEGER;
    ALTER TABLE desk_generations ADD COLUMN chat_refs_json TEXT;
    CREATE TABLE desk_blobs (
      hash TEXT PRIMARY KEY, refs INTEGER NOT NULL CHECK (refs >= 0),
      bytes INTEGER NOT NULL CHECK (bytes > 0), json TEXT NOT NULL
    );
    CREATE TRIGGER desk_blobs_fixed BEFORE UPDATE OF hash, bytes, json ON desk_blobs
      BEGIN SELECT RAISE(ABORT, 'desk blobs are immutable'); END;
`
const V2_REQUIRED = [...V1_REQUIRED, 'desk_blobs', 'desk_blobs_fixed', 'board_search']
// Private owner control; not part of any Board body, projection, journal, or export.
const V3_UPGRADE = `
    CREATE TABLE board_agent_ask_policies (
      board_id TEXT PRIMARY KEY REFERENCES boards(board_id) ON DELETE CASCADE,
      version TEXT NOT NULL, profile_id TEXT NOT NULL, profile_name TEXT NOT NULL,
      profile_revision INTEGER NOT NULL CHECK (profile_revision > 0), profile_hash TEXT NOT NULL,
      excerpts_json TEXT NOT NULL, public_instructions TEXT NOT NULL,
      code_digest TEXT, code_expires INTEGER, code_used INTEGER NOT NULL DEFAULT 0 CHECK (code_used IN (0,1))
    );
`
const V2_COLUMNS = ['window_start', 'stored_bytes', 'chat_refs_json']
const SEARCH_FTS = "CREATE VIRTUAL TABLE board_search USING fts5(title, cards, notes, board_id UNINDEXED, tokenize='trigram')"
const SEARCH_PLAIN = 'CREATE TABLE board_search (board_id TEXT PRIMARY KEY, title TEXT NOT NULL, cards TEXT NOT NULL, notes TEXT NOT NULL)'
export const BOARD_SEARCH_INDEXES = Object.freeze(['fts5-trigram', 'plain'])

// Older builds refuse a newer file (closed, never reset), so the exact data is
// kept beside it first. VACUUM INTO writes one consistent copy, WAL included,
// into a new private file; nothing is migrated unless the copy completed.
function backup(db, filename, version) {
  const target = `${filename}.v${version}.bak`
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    closeSync(openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600))
    db.prepare('VACUUM INTO ?').run(temporary)
    const info = lstatSync(temporary)
    if (!info.isFile() || info.isSymbolicLink() || !isOwnedAndPrivate(temporary, info, 0o077)) throw new Error('Backup is not private')
    renameSync(temporary, target)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* Keep original error. */ }
    fail('STORE_MIGRATION_FAILED', 'Desk backup failed; the database was kept unchanged', 500, { cause: error })
  }
}
function searchIndexer(db) {
  const remove = db.prepare('DELETE FROM board_search WHERE board_id=?')
  const insert = db.prepare('INSERT INTO board_search (title, cards, notes, board_id) VALUES (?, ?, ?, ?)')
  return (id, name, body) => {
    const text = boardSearchText(body)
    remove.run(id)
    insert.run(searchLine(name, MAX_TITLE_CHARS), text.cards, text.notes, id)
  }
}
/** Creates board_search (FTS5 trigram, or a plain table when FTS5 is missing) and indexes every Board head. */
function createSearch(db) {
  let kind = 'fts5-trigram'
  try { db.exec(SEARCH_FTS) } catch { db.exec(SEARCH_PLAIN); kind = 'plain' }
  const index = searchIndexer(db)
  for (const row of db.prepare('SELECT b.board_id, b.title, r.body_json FROM boards b JOIN board_revisions r ON r.board_id=b.board_id AND r.revision=b.head_revision').all()) {
    let body = null
    try { body = JSON.parse(row.body_json) } catch { /* Indexed by title only. */ }
    index(row.board_id, row.title, body)
  }
  db.prepare("INSERT OR REPLACE INTO store_meta (name, value) VALUES ('board_search', ?)").run(kind)
  return kind
}
function initialize(db, filename) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  if (String(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode).toLowerCase() !== 'wal') fail('STORE_OPEN_FAILED', 'WAL could not be enabled', 500)
  db.exec('PRAGMA synchronous=FULL;')
  if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) fail('STORE_OPEN_FAILED', 'FULL durability could not be enabled', 500)
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('STORE_CORRUPT', 'Desk database failed integrity check; database was not reset', 500)
  const version = db.prepare('PRAGMA user_version').get().user_version
  const found = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map(row => row.name))
  const migrate = steps => {
    db.exec('BEGIN IMMEDIATE')
    try { steps(); db.exec(`PRAGMA user_version=${VERSION}`); db.exec('COMMIT') }
    catch (error) {
      try { db.exec('ROLLBACK') } catch { /* Preserve original failure. */ }
      throw error
    }
  }
  if (version === VERSION) {
    const names = found()
    const columns = new Set(db.prepare('PRAGMA table_info(desk_generations)').all().map(row => row.name))
    if ([...V2_REQUIRED, 'board_agent_ask_policies'].some(name => !names.has(name)) || V2_COLUMNS.some(name => !columns.has(name))) fail('STORE_CORRUPT', 'Desk schema is incomplete; database was not reset', 500)
    return
  }
  if (version === 1) {
    if (V1_REQUIRED.some(name => !found().has(name))) fail('STORE_CORRUPT', 'Desk schema is incomplete; database was not reset', 500)
    backup(db, filename, 1)
    try { migrate(() => { db.exec(V2_UPGRADE); createSearch(db); db.exec(V3_UPGRADE) }) }
    catch (error) { fail('STORE_MIGRATION_FAILED', 'Desk records could not be upgraded; the v1 database was kept unchanged', 500, { cause: error }) }
    return
  }
  if (version === 2) {
    if (V2_REQUIRED.some(name => !found().has(name))) fail('STORE_CORRUPT', 'Desk schema is incomplete; database was not reset', 500)
    backup(db, filename, 2)
    try { migrate(() => db.exec(V3_UPGRADE)) }
    catch (error) { fail('STORE_MIGRATION_FAILED', 'Desk records could not be upgraded; the v2 database was kept unchanged', 500, { cause: error }) }
    return
  }
  if (version !== 0 || db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()) fail('UNSUPPORTED_STORE_VERSION', 'Existing Desk database has an unsupported schema; database was not reset', 500)
  migrate(() => { db.exec(V1_SCHEMA); db.exec(V2_UPGRADE); createSearch(db); db.exec(V3_UPGRADE) })
}

/**
 * openDeskStore({dataDir, ownerScope, now?, utcOffsetMinutes?, retention?, autosaveMergeMs?})
 * Synchronous, local-only. Same file rules as the chat and profile stores:
 * private non-symlink directory, private unlinked 0600 database, WAL + FULL.
 * utcOffsetMinutes fixes what "one day" means for retention (default: this
 * machine's offset at open). now, retention and autosaveMergeMs (0 turns the
 * autosave window off) exist for tests.
 */
export function openDeskStore({ dataDir, ownerScope, now = Date.now, utcOffsetMinutes = -new Date().getTimezoneOffset(), retention, autosaveMergeMs = DESK_AUTOSAVE_MERGE_MS } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof ownerScope !== 'string' || !ownerScope.trim() || ownerScope.length > 512 || ownerScope.includes('\0')) fail('INVALID_STORE_SCOPE', 'Absolute dataDir and local owner scope are required')
  if (typeof now !== 'function' || !Number.isSafeInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 24 * 60) fail('INVALID_STORE_OPTIONS', 'Invalid clock options')
  if (!Number.isSafeInteger(autosaveMergeMs) || autosaveMergeMs < 0 || autosaveMergeMs > DAY_MS) fail('INVALID_STORE_OPTIONS', 'autosaveMergeMs must be 0–86400000')
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
  try { db = new DatabaseSync(filename); initialize(db, filename) }
  catch (error) {
    try { db?.close() } catch { /* Keep original error. */ }
    if (['STORE_CORRUPT', 'UNSUPPORTED_STORE_VERSION', 'STORE_OPEN_FAILED', 'STORE_MIGRATION_FAILED'].includes(error.code)) throw error
    fail('STORE_OPEN_FAILED', 'Desk database could not be opened; database was not reset', 500)
  }
  const searchIndex = db.prepare("SELECT value FROM store_meta WHERE name='board_search'").get()?.value
  if (!BOARD_SEARCH_INDEXES.includes(searchIndex)) {
    db.close()
    fail('STORE_CORRUPT', 'Desk search index is unknown; database was not reset', 500)
  }

  const SUMMARY = 'generation, parent, seq, state_hash, created, reason, restored_from, card_count, shape_count, bytes, window_start, stored_bytes'
  const q = {
    head: db.prepare(`SELECT ${SUMMARY} FROM desk_generations ORDER BY generation DESC LIMIT 1`),
    generation: db.prepare('SELECT * FROM desk_generations WHERE generation=?'),
    // CTX-02: the '복구 기록' list also shows how many Boards were open; counted
    // from the saved text at read time (no column), like card_count at write time.
    page: db.prepare(`SELECT ${SUMMARY}, CASE WHEN json_type(state_json, '$.boardProjections.projections') = 'object'
      THEN (SELECT COUNT(*) FROM json_each(desk_generations.state_json, '$.boardProjections.projections')) ELSE 0 END AS board_count
      FROM desk_generations WHERE generation < ? ORDER BY generation DESC LIMIT ?`),
    kept: db.prepare('SELECT generation, created, bytes, stored_bytes, chat_refs_json IS NOT NULL AS shared FROM desk_generations ORDER BY generation DESC'),
    refsOf: db.prepare('SELECT chat_refs_json FROM desk_generations WHERE generation=?'),
    insertGeneration: db.prepare('INSERT INTO desk_generations (parent, seq, state_hash, created, reason, restored_from, card_count, shape_count, bytes, state_json, window_start, stored_bytes, chat_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    deleteGeneration: db.prepare('DELETE FROM desk_generations WHERE generation=?'),
    blob: db.prepare('SELECT json, bytes FROM desk_blobs WHERE hash=?'),
    blobBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM desk_blobs'),
    addBlob: db.prepare('INSERT INTO desk_blobs (hash, refs, bytes, json) VALUES (?, 1, ?, ?) ON CONFLICT(hash) DO UPDATE SET refs = refs + 1'),
    dropBlobRef: db.prepare('UPDATE desk_blobs SET refs = refs - 1 WHERE hash=?'),
    deleteBlob: db.prepare('DELETE FROM desk_blobs WHERE hash=? AND refs <= 0'),
    board: db.prepare('SELECT * FROM boards WHERE board_id=?'),
    boardHeadHash: db.prepare('SELECT hash FROM board_revisions WHERE board_id=? AND revision=?'),
    askPolicy: db.prepare('SELECT * FROM board_agent_ask_policies WHERE board_id=?'),
    putAskPolicy: db.prepare(`INSERT INTO board_agent_ask_policies (board_id,version,profile_id,profile_name,profile_revision,profile_hash,excerpts_json,public_instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(board_id) DO UPDATE SET version=excluded.version, profile_id=excluded.profile_id,
      profile_name=excluded.profile_name, profile_revision=excluded.profile_revision,
      profile_hash=excluded.profile_hash, excerpts_json=excluded.excerpts_json, public_instructions=excluded.public_instructions,
      code_digest=NULL, code_expires=NULL, code_used=0`),
    issueAskCode: db.prepare('UPDATE board_agent_ask_policies SET code_digest=?, code_expires=?, code_used=0 WHERE board_id=? AND version=?'),
    consumeAskCode: db.prepare('UPDATE board_agent_ask_policies SET code_used=1 WHERE board_id=? AND version=? AND code_digest=? AND code_used=0 AND code_expires>?'),
    dropAskPolicy: db.prepare('DELETE FROM board_agent_ask_policies WHERE board_id=?'),
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
  const indexBoard = searchIndexer(db)
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
  const parse = (text, what) => { try { return JSON.parse(text) } catch { fail('STORE_CORRUPT', `Saved ${what} is unreadable; database was not reset`, 500) } }
  // Heads another writer collided with (409). Such a head is never replaced
  // by the autosave window, so the overwritten work stays in the journal.
  const contested = new Set()
  const contest = generation => {
    if (!Number.isSafeInteger(generation)) return
    contested.add(generation)
    if (contested.size > CONTESTED_KEPT) contested.delete(contested.values().next().value)
  }

  // ── Desk generations ──
  const generationSummary = row => ({
    generation: row.generation, parent: row.parent, seq: row.seq, stateHash: row.state_hash,
    createdAt: row.created, reason: row.reason, restoredFrom: row.restored_from,
    cardCount: row.card_count, shapeCount: row.shape_count, bytes: row.bytes,
  })
  const refsIn = text => {
    if (text === null || text === undefined) return []
    const refs = parse(text, 'Desk chat references')
    if (!Array.isArray(refs) || refs.some(ref => !Array.isArray(ref) || ref.length !== 2 || !Number.isSafeInteger(ref[0]) || !Array.isArray(ref[1]) || ref[1].some(hash => typeof hash !== 'string'))) fail('STORE_CORRUPT', 'Saved Desk chat references are unreadable; database was not reset', 500)
    return refs
  }
  const distinctHashes = refs => new Set(refs.flatMap(ref => ref[1]))
  function generationRecord(row) {
    const state = parse(row.state_json, 'Desk state')
    const refs = refsIn(row.chat_refs_json)
    if (refs.length) {
      const threads = state?.chat?.threads
      const cache = new Map()
      for (const [index, hashes] of refs) {
        if (!Array.isArray(threads) || !plain(threads[index]) || threads[index].messages !== null) fail('STORE_CORRUPT', 'Saved Desk chat does not match its references', 500)
        threads[index].messages = hashes.map(hash => {
          if (!cache.has(hash)) {
            const blob = q.blob.get(hash)
            if (!blob) fail('STORE_CORRUPT', 'A saved chat message is missing; database was not reset', 500)
            cache.set(hash, blob.json)
          }
          return parse(cache.get(hash), 'chat message')
        })
      }
    }
    if (contentHash(state) !== row.state_hash) fail('STORE_CORRUPT', 'Saved Desk state does not match its hash', 500)
    return { ...generationSummary(row), state }
  }
  const conflict = head => {
    contest(head?.generation)
    fail('DESK_GENERATION_CONFLICT', 'Desk changed since this state was loaded', 409, { generation: head?.generation ?? null, stateHash: head?.state_hash ?? null })
  }
  const lastImport = () => {
    const row = q.lastImport.get()
    return row ? { importId: row.import_hash, importedAt: row.created } : null
  }
  /** Removes one generation and lets go of its shared chat messages. */
  function removeGeneration(generation) {
    const hashes = distinctHashes(refsIn(q.refsOf.get(generation)?.chat_refs_json))
    q.deleteGeneration.run(generation)
    for (const hash of hashes) { q.dropBlobRef.run(hash); q.deleteBlob.run(hash) }
  }
  /**
   * D-R1 retention (planDeskRetention); runs inside the inserting transaction.
   * Rows carry their own on-disk bytes; shared chat messages are counted once,
   * and looked up only when the upper bound exceeds the budget. Returns how
   * many generations were removed.
   */
  function prune(ts) {
    const rows = q.kept.all()
    const plan = planDeskRetention(rows.map(row => ({ generation: row.generation, createdAt: row.created, bytes: row.stored_bytes ?? row.bytes, shared: row.shared === 1 })), {
      rule, now: ts, utcOffsetMinutes,
      sharedBytes: q.blobBytes.get().n, // Upper bound: every shared message counted once (all of them are in use).
      hashesOf: generation => [...distinctHashes(refsIn(q.refsOf.get(generation).chat_refs_json))],
      blobBytesOf: hash => q.blob.get(hash)?.bytes ?? 0,
    })
    for (const generation of plan.remove) removeGeneration(generation)
    return plan.remove.length
  }
  /**
   * Adds a generation on top of head. With replace, the new generation takes
   * the head's place in the chain (same parent and seq, same window start)
   * and the head is removed: one recovery point for the whole window.
   */
  function appendGeneration(head, desk, reason, { restoredFrom = null, ts = clock(), replace = false } = {}) {
    const parent = replace ? head.parent : head?.generation ?? null
    const seq = replace ? head.seq : (head?.seq ?? 0) + 1
    const windowStart = replace ? head.window_start ?? head.created : ts
    const info = q.insertGeneration.run(parent, seq, desk.hash, ts, reason, restoredFrom, count(desk.value.cards), count(desk.value.shapes), desk.bytes, desk.storedJson, windowStart, desk.storedBytes, desk.refsJson)
    for (const [hash, json] of desk.blobs) q.addBlob.run(hash, Buffer.byteLength(json), json)
    if (replace) removeGeneration(head.generation)
    const pruned = prune(ts)
    return { ...generationSummary(q.generation.get(Number(info.lastInsertRowid))), unchanged: false, pruned, merged: replace, replacedGeneration: replace ? head.generation : null }
  }
  const unchanged = head => ({ ...generationSummary(head), unchanged: true, pruned: 0, merged: false, replacedGeneration: null })
  // D-R1 autosave window (autosaveWindowMerges), fed the head row's columns.
  const mergeable = (head, ts) => autosaveWindowMerges({ ts, mergeMs: autosaveMergeMs, contested,
    head: head ? { generation: head.generation, reason: head.reason, createdAt: head.created, windowStart: head.window_start } : null })

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
  function requireAskBoard(id) {
    const row = requireBoard(id)
    if (row.lifecycle !== 'active') fail('BOARD_NOT_ACTIVE', 'Board is not active', 409)
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
    indexBoard(id, name, body.value)
  }
  function appendRevision(row, body, { name = row.title, revertedFrom = null } = {}) {
    if (row.head_revision >= MAX_BOARD_REVISIONS) fail('BOARD_REVISION_LIMIT', `A Board keeps at most ${MAX_BOARD_REVISIONS} revisions`, 409)
    const ts = Math.max(clock(), row.updated)
    const next = row.head_revision + 1
    q.insertRevision.run(row.board_id, next, row.head_revision, body.hash, 'user', revertedFrom, body.bytes, body.json, ts)
    q.moveBoard.run(next, name, row.metadata_version + (name === row.title ? 0 : 1), ts, row.board_id)
    indexBoard(row.board_id, name, body.value)
    return next
  }

  // ── Import of the screen's earlier preference values ──
  function importItems({ deskSnapshot, boards } = {}) {
    let desk = null
    if (deskSnapshot !== undefined && deskSnapshot !== null) {
      let value = deskSnapshot
      if (typeof value === 'string') { try { value = JSON.parse(value) } catch { fail('DESK_IMPORT_UNREADABLE', 'The earlier Desk snapshot is unreadable; nothing was imported') } }
      if (!plain(value)) fail('DESK_IMPORT_UNREADABLE', 'The earlier Desk snapshot is not a Desk object; nothing was imported')
      desk = deskPayload(value)
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
    autosaveMergeMs,
    searchIndex,
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
     * An autosave within the window of a head autosave replaces it (merged:
     * true, replacedGeneration); the answer's generation is always the new head.
     */
    saveCurrent({ state, parentGeneration, reason = 'autosave' } = {}) {
      ensureOpen()
      if (!SAVE_REASONS.includes(reason)) fail('INVALID_DESK_REASON', 'reason must be autosave or explicit')
      if (parentGeneration === undefined) fail('INVALID_DESK_GENERATION', 'parentGeneration is required (null for an empty Desk store)')
      const parent = nullablePositive(parentGeneration, 'INVALID_DESK_GENERATION', 'parentGeneration')
      const desk = deskPayload(state)
      return tx(() => {
        const head = q.head.get()
        // Same content as the head (including a retried save whose answer was lost).
        if (head && head.state_hash === desk.hash) return unchanged(head)
        if ((head?.generation ?? null) !== parent) conflict(head)
        const ts = clock()
        return appendGeneration(head, desk, reason, { ts, replace: reason === 'autosave' && mergeable(head, ts) })
      })
    },
    generations({ limit, before } = {}) {
      ensureOpen()
      const chosen = page(limit, before, 50, 500, 'INVALID_DESK_QUERY')
      let rows
      try { rows = q.page.all(chosen.before ?? Number.MAX_SAFE_INTEGER, chosen.limit + 1) }
      catch { fail('STORE_CORRUPT', 'Saved Desk state is unreadable; database was not reset', 500) }
      const hasMore = rows.length > chosen.limit
      // boardCount: open Board regions at that point (boardProjections.projections), beside cardCount and shapeCount.
      const shown = rows.slice(0, chosen.limit).map(row => ({ ...generationSummary(row), boardCount: row.board_count }))
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
        return appendGeneration(head, deskPayload(state), 'restore', { restoredFrom: source.generation })
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
    // Separate narrow API used only by the Board Agent ask service.
    boardAgentAskIdentity(id) {
      ensureOpen()
      const row = requireAskBoard(id)
      const hash = q.boardHeadHash.get(row.board_id, row.head_revision)?.hash
      if (!hash) fail('STORE_CORRUPT', 'Board head metadata is unavailable', 500)
      return { revision: row.head_revision, metadataVersion: row.metadata_version, hash }
    },
    boardAgentAskPolicy(id) {
      ensureOpen()
      const row = q.askPolicy.get(requireAskBoard(id).board_id)
      return row ? { version: row.version, profileId: row.profile_id, profileName: row.profile_name,
        profileRevision: row.profile_revision, profileHash: row.profile_hash, excerpts: parse(row.excerpts_json, 'Board ask policy'),
        publicInstructions: row.public_instructions, codeDigest: row.code_digest, codeExpiresAt: row.code_expires, codeUsed: Boolean(row.code_used) } : null
    },
    writeBoardAgentAskPolicy(id, expectedVersion, next) {
      ensureOpen()
      return tx(() => {
        const key = requireAskBoard(id).board_id
        if ((q.askPolicy.get(key)?.version ?? null) !== expectedVersion) fail('BOARD_AGENT_ASK_POLICY_CONFLICT', 'Board ask policy changed; reload before editing', 409)
        if (!next) { q.dropAskPolicy.run(key); return }
        q.putAskPolicy.run(key, randomUUID(), next.profileId, next.profileName, next.profileRevision, next.profileHash, JSON.stringify(next.excerpts), next.publicInstructions)
      })
    },
    issueBoardAgentAskCode(id, version, digest, expiresAt) {
      ensureOpen()
      const key = requireAskBoard(id).board_id
      if (!q.issueAskCode.run(digest, expiresAt, key, version).changes) fail('BOARD_AGENT_ASK_POLICY_CONFLICT', 'Board ask policy changed; reload before editing', 409)
    },
    consumeBoardAgentAskCode(id, version, digest, at) {
      ensureOpen()
      return !!q.consumeAskCode.run(requireAskBoard(id).board_id, version, digest, at).changes
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
          if (name && name !== row.title) {
            q.moveBoard.run(row.head_revision, name, row.metadata_version + 1, Math.max(clock(), row.updated), key)
            indexBoard(key, name, saved.value)
          }
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
     * CTX-01: merge an edit that started from baseRevision onto the current
     * head, per card (mergeBoardBodies, mine = body, theirs = head). Writes
     * nothing: the screen shows conflicts (if any) and saves the merged body
     * with expectedRevision = headRevision.
     */
    mergeBoard(id, { body, baseRevision, prefer = 'mine' } = {}) {
      ensureOpen()
      const row = requireBoard(id)
      const mine = payload(body, 'board')
      const base = revisionRecord(requireRevision(row, baseRevision))
      const head = revisionRecord(q.revision.get(row.board_id, row.head_revision))
      const merged = mergeBoardBodies({ base: base.body, mine: mine.value, theirs: head.body, prefer })
      const checked = payload(merged.body, 'board')
      return {
        boardId: row.board_id, baseRevision: base.revision, headRevision: row.head_revision,
        body: merged.body, hash: checked.hash, conflicts: merged.conflicts, clean: merged.clean, unchanged: checked.hash === head.hash,
      }
    },
    /**
     * CTX-03 Board search over title, card names and memo text. Words of 3+
     * characters use the FTS5 trigram index (bm25: title 8, cards 3, memo 1);
     * shorter words (common in Korean) are matched as substrings. Every word
     * must appear somewhere in the Board.
     */
    searchBoards({ query, limit } = {}) {
      ensureOpen()
      const terms = searchTerms(query)
      const size = limit === undefined || limit === null ? 20 : limit
      if (!Number.isSafeInteger(size) || size < 1 || size > BOARD_SEARCH_LIMITS.results) fail('INVALID_BOARD_QUERY', `limit must be 1–${BOARD_SEARCH_LIMITS.results}`)
      const fts = searchIndex === 'fts5-trigram'
      const long = fts ? terms.filter(term => Array.from(term).length >= 3) : []
      const short = terms.filter(term => !long.includes(term))
      const like = term => `%${term.replace(/[\\%_]/g, match => `\\${match}`)}%`
      const where = [], params = []
      if (long.length) { where.push('board_search MATCH ?'); params.push(long.map(term => `"${term.replace(/"/g, '""')}"`).join(' AND ')) }
      for (const term of short) {
        where.push("(board_search.title LIKE ? ESCAPE '\\' OR board_search.cards LIKE ? ESCAPE '\\' OR board_search.notes LIKE ? ESCAPE '\\')")
        params.push(like(term), like(term), like(term))
      }
      const rank = long.length ? 'bm25(board_search, 8.0, 3.0, 1.0)'
        : `(CASE WHEN ${short.map(() => "board_search.title LIKE ? ESCAPE '\\'").join(' AND ')} THEN 0 ELSE 1 END)`
      const rankParams = long.length ? [] : short.map(like)
      const rows = db.prepare(`SELECT board_search.board_id AS board_id, board_search.title AS indexed_title, board_search.cards AS cards, board_search.notes AS notes, ${rank} AS rank
        FROM board_search JOIN boards ON boards.board_id = board_search.board_id
        WHERE ${where.join(' AND ')} ORDER BY rank, boards.updated DESC, boards.board_id LIMIT ?`).all(...rankParams, ...params, size)
      const has = (text, term) => text.toLowerCase().includes(term.toLowerCase())
      return {
        query: terms.join(' '), index: searchIndex,
        boards: rows.map(row => {
          const board = q.board.get(row.board_id)
          const fields = [['title', row.indexed_title], ['cards', row.cards], ['notes', row.notes]].filter(([, text]) => terms.some(term => has(text, term))).map(([name]) => name)
          return { ...boardSummary(board), fields, snippet: snippetOf(row.notes, terms) ?? snippetOf(row.cards, terms) }
        }),
      }
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
          if (!head) deskResult = { status: 'imported', generation: appendGeneration(null, desk, 'import', { ts }).generation, skipReason: null }
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
      const desk = state === null ? null : deskPayload(state)
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
          deskResult = head && head.state_hash === desk.hash ? unchanged(head) : appendGeneration(head, desk, 'import', { ts })
        }
        return { desk: deskResult, boards: boardResults }
      })
    },
    close() { if (!closed) { db.close(); closed = true } },
  }
}
