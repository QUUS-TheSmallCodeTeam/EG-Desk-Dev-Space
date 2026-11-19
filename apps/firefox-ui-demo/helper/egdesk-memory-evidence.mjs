import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'
import { assertPatchedSqliteRuntime } from './egdesk-sqlite-runtime.mjs'

// A grant selects evidence to inspect; neither a grant nor a relation is a receipt of truth.
const require = createRequire(import.meta.url)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digest = /^[0-9a-f]{64}$/
const token = value => typeof value === 'string' && value.length === 43 && value.startsWith('memrow:') && uuid.test(value.slice(7))
const relations = new Set(['counted', 'posted', 'recorded', 'copied', 'derived', 'scheduled', 'coverage'])
const MAX_PACK = 4000, MAX_SOURCES = 6
const fail = () => { throw new Error('Memory evidence unavailable') }
const check = value => { if (!value) fail() }
const positive = n => Number.isSafeInteger(n) && n > 0
const sha = s => createHash('sha256').update(s).digest('hex')
const fields = (v, expected) => {
  check(v && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).length === expected.length)
  for (const key of expected) {
    const d = Object.getOwnPropertyDescriptor(v, key)
    check(d?.enumerable && Object.hasOwn(d, 'value'))
  }
}
function authority(value) {
  fields(value, ['ownerKey', 'agentId', 'clientThreadId'])
  const { ownerKey, agentId, clientThreadId } = value
  const ids = [ownerKey, agentId, clientThreadId]
  check(ids.every(id => typeof id === 'string' && id.trim() && id.isWellFormed() && !id.includes('\0')))
  return { ownerKey, clientThreadId, key: sha(JSON.stringify(ids)) }
}
function validatePin(v, source, stored) {
  const keys = ['sourceId', 'revision', 'startLine', 'endLine']
  fields(v, [...keys, ...(source ? ['relation'] : []), ...(stored ? ['projectionHash'] : [])])
  const { sourceId, revision, startLine, endLine } = v
  check(typeof sourceId === 'string' && sourceId.length === 36 && uuid.test(sourceId))
  check(typeof revision === 'string' && revision.length === 64 && digest.test(revision))
  check(positive(startLine) && positive(endLine) && endLine >= startLine && endLine - startLine < MAX_PACK)
  check(source ? relations.has(v.relation) : endLine === startLine)
  if (stored) check(typeof v.projectionHash === 'string' && v.projectionHash.length === 64 && digest.test(v.projectionHash))
  return { ...(source ? { relation: v.relation } : {}), sourceId, revision, startLine, endLine, ...(stored ? { projectionHash: v.projectionHash } : {}) }
}
function selection(v, stored = false) {
  const hasExpiry = !stored && v != null && Object.hasOwn(v, 'expiresAt')
  fields(v, ['ledger', 'sources', ...(hasExpiry ? ['expiresAt'] : [])])
  if (hasExpiry) check(positive(v.expiresAt)) // null, strings and an explicit undefined are not permanent grants.
  check(Array.isArray(v.sources) && v.sources.length >= 1 && v.sources.length <= MAX_SOURCES)
  const ledger = validatePin(v.ledger, false, stored), sources = []
  for (let i = 0; i < v.sources.length; i++) {
    check(Object.hasOwn(v.sources, i))
    const p = validatePin(v.sources[i], true, stored)
    // The ledger row cannot corroborate itself, even via a second capture of the same bytes.
    if (p.revision === ledger.revision && p.startLine <= ledger.startLine && ledger.endLine <= p.endLine) {
      check(p.relation === 'copied' && p.startLine === ledger.startLine && p.endLine === ledger.endLine)
    }
    for (const q of sources) if (q.revision === p.revision) {
      if (q.sourceId === p.sourceId) check(q.endLine < p.startLine || p.endLine < q.startLine)
      else check(q.startLine !== p.startLine || q.endLine !== p.endLine || q.relation !== p.relation)
    }
    sources.push(p)
  }
  return { ledger, sources, expiresAt: hasExpiry ? v.expiresAt : null }
}
function projectionHash(m, scope, pin) {
  check(m?.version === 1 && m.clientThreadId === scope.clientThreadId && m.sourceId === pin.sourceId && m.snapshotId === pin.sourceId &&
    m.revision === pin.revision && m.hash === pin.revision && m.payloads?.source?.hash === pin.revision && m.shape?.readable === true &&
    m.truncated === false && m.capture?.coverage?.complete === true && positive(m.shape.lineCount) && pin.endLine <= m.shape.lineCount)
  const hash = m.payloads?.projection?.hash
  check(typeof hash === 'string' && hash.length === 64 && digest.test(hash))
  return hash
}
function selectedLines(text, { startLine, endLine }) {
  let pos = 0
  for (let n = 1; n < startLine; n++) {
    pos = text.indexOf('\n', pos) + 1
    check(pos !== 0)
  }
  const result = []
  let chars = 0
  for (let n = startLine; n <= endLine; n++) {
    const nl = text.indexOf('\n', pos)
    check(nl !== -1 || n === endLine)
    let end = nl === -1 ? text.length : nl
    if (nl !== -1 && end > pos && text[end - 1] === '\r') end-- // CRLF is one line delimiter.
    chars += end - pos + (n === startLine ? 0 : 1)
    check(chars <= MAX_PACK)
    const line = text.slice(pos, end)
    check(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(line) && line.isWellFormed())
    result.push(line)
    pos = nl + 1
  }
  const value = result.join('\n')
  check(value.trim().length > 0)
  return value
}

const stat = p => lstatSync(p, { throwIfNoEntry: false })
function location(dataDir, create) {
  let root = stat(dataDir)
  if (!root && !create) return null
  if (!root) { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); root = stat(dataDir) }
  check(root?.isDirectory() && !root.isSymbolicLink())
  const canonical = realpathSync.native(dataDir)
  check(isOwnedAndPrivate(canonical, root, 0o022))
  const dir = path.join(canonical, 'memory-evidence')
  if (!stat(dir) && create) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const directory = stat(dir)
  if (!directory && !create) return null
  check(directory?.isDirectory() && isOwnedAndPrivate(dir, directory, 0o077))
  const file = path.join(dir, 'grants.sqlite')
  const safeFile = p => {
    const s = stat(p)
    if (s) check(s.isFile() && s.nlink === 1 && isOwnedAndPrivate(p, s, 0o077))
    return s
  }
  const existing = safeFile(file)
  for (const ext of ['-journal', '-wal', '-shm']) if (safeFile(file + ext)) check(existing)
  if (!existing && !create) return null
  assertPatchedSqliteRuntime() // Never open or create a persistent SQLite file on an unsupported runtime.
  let fresh = false
  if (!existing) {
    try { closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600)); fresh = true }
    catch (e) { if (e.code !== 'EEXIST') throw e }
  }
  check(safeFile(file))
  return { file, fresh }
}
const APP_ID = 0x4d455647 // MEVG
const active = `FROM grants g WHERE g.id=? AND g.scope_key=? AND (g.expires_at IS NULL OR g.expires_at>?)
  AND NOT EXISTS (SELECT 1 FROM revoked r WHERE r.id=g.id)`

export class MemoryEvidenceStore {
  #dataDir; #captures; #now; #db; #closed = false
  constructor({ dataDir, captures, now = Date.now } = {}) {
    check(typeof dataDir === 'string' && path.isAbsolute(dataDir) && !dataDir.includes('\0') && typeof now === 'function')
    check(typeof captures?.getCapture === 'function' && typeof captures.readProjection === 'function')
    this.#dataDir = path.resolve(dataDir); this.#captures = captures; this.#now = now
  }
  #time() { const t = this.#now(); check(Number.isSafeInteger(t) && t >= 0); return t }
  #database(create = false) {
    check(!this.#closed)
    if (this.#db) return this.#db
    const loc = location(this.#dataDir, create)
    if (!loc) return null
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(loc.file)
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50; PRAGMA synchronous=FULL;')
      if (loc.fresh) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE grants(id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, expires_at INTEGER, pins TEXT NOT NULL) STRICT;
          CREATE TABLE revoked(id TEXT PRIMARY KEY REFERENCES grants(id)) STRICT;
          PRAGMA application_id=${APP_ID}; PRAGMA user_version=1; COMMIT;`)
      }
      check(db.prepare('PRAGMA application_id').get().application_id === APP_ID && db.prepare('PRAGMA user_version').get().user_version === 1)
      this.#db = db
      return db
    } catch (e) { db.close(); throw e }
  }
  async #materialize(scope, { ledger, sources }) {
    const project = async pin => {
      const { projectionHash: expected, ...publicPin } = pin
      const manifest = await this.#captures.getCapture(scope.ownerKey, pin.sourceId)
      const hash = projectionHash(manifest, scope, pin)
      check(expected === undefined || expected === hash)
      // readProjection checks both the original blob and the projection blob. Never inspect raw text or follow the original path.
      const checked = await this.#captures.readProjection(scope.ownerKey, pin.sourceId)
      check(projectionHash(checked.manifest, scope, pin) === hash && typeof checked.text === 'string' && checked.text.length === checked.manifest.shape.charCount)
      const text = selectedLines(checked.text, pin)
      return { public: { ...publicPin, text }, pinned: { ...publicPin, projectionHash: hash } }
    }
    const row = await project(ledger)
    const pack = { version: 1, ledger: row.public, sources: [] }
    const pins = { ledger: row.pinned, sources: [] }
    for (const source of sources) {
      const evidence = await project(source)
      pack.sources.push(evidence.public); pins.sources.push(evidence.pinned)
    }
    check(JSON.stringify(pack).length <= MAX_PACK)
    return { pack, pins }
  }
  async bind(scope, request) {
    try {
      check(!this.#closed)
      const s = authority(scope), spec = selection(request)
      check(spec.expiresAt === null || spec.expiresAt > this.#time())
      const { pins } = await this.#materialize(s, spec)
      const db = this.#database(true), id = `memrow:${randomUUID()}`
      check(spec.expiresAt === null || spec.expiresAt > this.#time())
      // Only opaque pins and scope digest, never text, capture metadata, or raw identity. INSERT never replaces an old grant.
      db.prepare('INSERT INTO grants(id,scope_key,expires_at,pins) VALUES(?,?,?,?)').run(id, s.key, spec.expiresAt, JSON.stringify(pins))
      return id
    } catch { fail() }
  }
  #lookup(s, id, withPins) {
    return this.#database()?.prepare(`SELECT ${withPins ? 'g.pins' : '1'} ${active}`).get(id, s.key, this.#time())
  }
  async read(scope, selectionId) {
    try {
      if (!token(selectionId)) return null
      const s = authority(scope), row = this.#lookup(s, selectionId, true)
      if (!row) return null
      const { pack } = await this.#materialize(s, selection(JSON.parse(row.pins), true))
      // No transaction spans await: reauthorize against the currently committed grant just before returning any text.
      return this.#lookup(s, selectionId, true)?.pins === row.pins ? pack : null
    } catch { return null }
  }
  isActive(scope, selectionId) {
    try { return token(selectionId) && !!this.#lookup(authority(scope), selectionId, false) } catch { return false }
  }
  revoke(scope, selectionId) {
    try {
      if (!token(selectionId)) return false
      const s = authority(scope)
      // This table is insert-only. Even an expired grant can be tombstoned; nothing ever undoes revocation.
      return this.#database()?.prepare(`INSERT INTO revoked(id) SELECT id FROM grants WHERE id=? AND scope_key=?
        ON CONFLICT(id) DO NOTHING`).run(selectionId, s.key).changes === 1
    } catch { return false }
  }
  close() { this.#closed = true; this.#db?.close(); this.#db = null }
}
