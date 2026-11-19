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
// Local opt-in aliases, never extracted from captures or inferred from previous messages.
const MAX_ROWS = 64, MAX_TERMS = 8, MAX_TERM = 64, MAX_WORDS = 6
const explicitLabel = '직접 선택한 근거'
const words = /[\p{L}\p{M}\p{N}_]+(?:[-'’][\p{L}\p{M}\p{N}_]+)*/gu
const hangulPhrase = /^[가-힣]+(?: [가-힣]+)*$/u
const generic = new Set(('왜 왜요 왜냐면 뭐 뭐지 뭐야 뭔가 무엇 무엇을 뭔데 누가 누구 언제 어디 어떻게 얼마나 얼마 몇 개 갯 개수 그거 이거 저거 그건 이건 저건 그게 이게 그것 이것 저것 이 그 저 지금 오늘 어제 내일 방금 다시 그냥 좀 또 더 알려줘 알려 주세요 보여줘 해줘 말해줘 설명해줘 부탁해 네 아니요 맞아 그래 응 질문 내용 정보 근거 출처 이유 앞서 이전 다음 here there this that these those the a an it its is are be do did does why what how who where when which much many more yes no now today please show tell me help explain again details information source reason').split(' '))
const suffixes = new Set(('은 는 이 가 을 를 도 만 의 에 엔 와 과 야 요 로 랑 에서 에선 에도 에는 에게 에게서 한테 께 께서 으로 으로는 로는 부터 까지 보다 처럼 이랑 이야 이에요 예요 인가 인가요 일까 일까요 이지 이죠 이나 이라도 이면 라면 은요 는요 이요 가요 만요 에서도 에서는').split(' '))
const aliasKey = s => hangulPhrase.test(s) ? s.replaceAll(' ', '') : s
function nonspecific(word) {
  if (generic.has(word) || /^\p{Nd}+(?:개|명|건|원|일|시|분|초|달|월|년|회|번|items?)?$/u.test(word)) return true
  for (let n = 1; n <= 3 && n < word.length; n++) if (suffixes.has(word.slice(-n)) && generic.has(word.slice(0, -n))) return true
  return false
}
function userLabel(value) {
  check(typeof value === 'string' && value.length <= 160 && value.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
  const label = value.normalize('NFC').trim()
  check(label.length > 0 && label.length <= 80)
  return label
}
function alias(value) {
  check(typeof value === 'string' && value.length <= 128 && value.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
  const term = value.normalize('NFKC').toLowerCase().trim().replace(/\p{Zs}+/gu, ' ')
  const parts = term.match(words) || [], key = aliasKey(term)
  check(term.length <= MAX_TERM && parts.length >= 1 && parts.length <= MAX_WORDS && parts.join(' ') === term &&
    /\p{L}/u.test(term) && (term.match(/[\p{L}\p{N}]/gu) || []).length >= (/[가-힣]/u.test(term) ? 2 : 3))
  // A user may explicitly select the conventional count phrase, but never a lone interrogative or generic follow-up.
  check(key === '몇개' || (!nonspecific(key) && parts.some(word => !nonspecific(word))))
  return term
}
function discoveryMeta(meta) {
  fields(meta, ['label', 'terms'])
  const label = userLabel(meta.label), terms = []
  check(Array.isArray(meta.terms) && meta.terms.length >= 1 && meta.terms.length <= MAX_TERMS)
  for (let i = 0; i < meta.terms.length; i++) {
    check(Object.hasOwn(meta.terms, i)); terms.push(alias(meta.terms[i]))
  }
  check(new Set(terms.map(aliasKey)).size === terms.length)
  return { label, terms }
}
function messageKeys(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 2048 && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\p{Cf}]/u.test(value))
  const text = value.normalize('NFKC').toLowerCase(), parts = [...text.matchAll(words)], keys = new Set()
  check(parts.length <= 160)
  for (let i = 0; i < parts.length; i++) {
    let phrase = ''
    for (let j = i; j < parts.length && j < i + MAX_WORDS; j++) {
      if (j > i && !/^\p{Zs}+$/u.test(text.slice(parts[j - 1].index + parts[j - 1][0].length, parts[j].index))) break
      const word = parts[j][0]; phrase += (j === i ? '' : ' ') + word
      if (phrase.length > MAX_TERM + 9) break
      keys.add(aliasKey(phrase))
      // Only remove one whole, known particle/copula at the last word's edge; never search inside a token.
      for (let n = 1; n <= 3 && n < word.length; n++) if (suffixes.has(word.slice(-n))) keys.add(aliasKey(phrase.slice(0, -n)))
    }
  }
  return keys
}
function selection(v, stored = false) {
  const hasExpiry = !stored && v != null && Object.hasOwn(v, 'expiresAt')
  const hasDiscovery = !stored && v != null && Object.hasOwn(v, 'discovery')
  fields(v, ['ledger', 'sources', ...(hasExpiry ? ['expiresAt'] : []), ...(hasDiscovery ? ['discovery'] : [])])
  const discovery = hasDiscovery ? discoveryMeta(v.discovery) : null
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
  return { ledger, sources, expiresAt: hasExpiry ? v.expiresAt : null, discovery }
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
  check(directory?.isDirectory() && isOwnedAndPrivate(dir, directory, 0o077) && (process.platform === 'win32' || (directory.mode & 0o200)))
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
  const database = safeFile(file)
  check(database && (process.platform === 'win32' || (database.mode & 0o200)))
  return { file, fresh }
}
const APP_ID = 0x4d455647 // MEVG
const liveInScope = `g.scope_key=? AND (g.expires_at IS NULL OR g.expires_at>?)
  AND NOT EXISTS (SELECT 1 FROM revoked r WHERE r.id=g.id)`
const active = `FROM grants g WHERE g.id=? AND ${liveInScope}`
const metadata = 'g.id, g.discovery_label AS label, g.discovery_terms AS terms'
const v2Objects = `CREATE INDEX grants_by_scope ON grants(scope_key);
  CREATE INDEX discoverable_by_scope ON grants(scope_key) WHERE discovery_terms IS NOT NULL;
  CREATE TABLE turn_inputs(scope_key TEXT NOT NULL, run_key TEXT NOT NULL, id TEXT NOT NULL REFERENCES grants(id),
    PRIMARY KEY(scope_key, run_key, id)) WITHOUT ROWID, STRICT;`
// A separate, private opt-in: document grants and old chat rows never create speech references.
// One row is the entire generation. A compare-and-delete removes its whole bounded window atomically.
const SPEECH_WINDOW = 12, SPEECH_SPANS = 6, SPEECH_TEXT = 20_000, SPEECH_JSON = 16_384
const speechSchema = `CREATE TABLE speech_grants(scope_key TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE,
  refs TEXT NOT NULL CHECK(length(CAST(refs AS BLOB))<=${SPEECH_JSON}), seal TEXT NOT NULL) WITHOUT ROWID, STRICT`
const speechSources = new Set(['self_reported_observation', 'attributed_report', 'inference', 'record_based', 'unspecified', 'unknown'])
const speechForms = new Set(['assertion', 'plan', 'conditional', 'question', 'unknown'])
const speechTimes = new Set(['past_anchored', 'past_unspecified', 'at_utterance', 'ongoing_no_end', 'future_anchored', 'future_unspecified', 'unknown'])
const validGeneration = v => typeof v === 'string' && v.length === 36 && uuid.test(v)
const speechSeal = (key, generation, refs) => sha(JSON.stringify(['speech-v1', key, generation, refs]))
function denseValues(value, max) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max && Reflect.ownKeys(value).length === value.length + 1)
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, i); check(d?.enumerable && Object.hasOwn(d, 'value')); return d.value
  })
}
function speechReference(v) {
  fields(v, ['localMessageId', 'role', 'seq', 'spokenAt', 'offsetMinutes', 'hash', 'interpretations'])
  const { localMessageId, role, seq, spokenAt, offsetMinutes, hash } = v
  // Only IDs minted for the live public message path, not native/provider IDs or snapshot fallbacks.
  check(typeof localMessageId === 'string' && localMessageId.length === 36 && /^msg-[0-9a-f]{32}$/.test(localMessageId))
  check((role === 'user' || role === 'assistant') && positive(seq) && Number.isSafeInteger(spokenAt) && spokenAt >= 0 && Number.isFinite(new Date(spokenAt).getTime()))
  check(Number.isInteger(offsetMinutes) && Math.abs(offsetMinutes) <= 840 && typeof hash === 'string' && hash.length === 64 && digest.test(hash))
  let priorEnd = 0
  const interpretations = denseValues(v.interpretations, SPEECH_SPANS).map(span => {
    fields(span, ['start', 'end', 'source', 'form', 'time'])
    const { start, end, source, form, time } = span
    // UTF-16 half-open ranges. The caller must additionally verify against the exact public text; this store never receives that text.
    check(Number.isSafeInteger(start) && Number.isSafeInteger(end) && priorEnd <= start && start < end && end <= SPEECH_TEXT)
    check(speechSources.has(source) && speechForms.has(form) && speechTimes.has(time))
    priorEnd = end; return { start, end, source, form, time }
  })
  return { localMessageId, role, seq, spokenAt, offsetMinutes, hash, interpretations }
}
function speechState(db, key, expected) {
  const row = db?.prepare(`SELECT generation, CASE WHEN length(CAST(refs AS BLOB))<=${SPEECH_JSON} THEN refs END AS refs, seal
    FROM speech_grants WHERE scope_key=?${expected === undefined ? '' : ' AND generation=?'}`).get(key, ...(expected === undefined ? [] : [expected]))
  if (!row) return null
  check(validGeneration(row.generation) && typeof row.refs === 'string' && row.seal === speechSeal(key, row.generation, row.refs))
  const records = denseValues(JSON.parse(row.refs), SPEECH_WINDOW).map(speechReference)
  check(records.every((record, i) => !i || records[i - 1].seq < record.seq) && new Set(records.map(r => r.localMessageId)).size === records.length && JSON.stringify(records) === row.refs)
  return { generation: row.generation, records }
}
function speechWrite(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const result = fn(); db.exec('COMMIT'); return result }
  catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e }
}
function runKey(value) {
  check(typeof value === 'string' && value.length >= 1 && value.length <= 256 && value.isWellFormed() && !/[\s\p{Cc}\p{Cf}]/u.test(value))
  return sha(value)
}
function decodeMeta(row) {
  check(row && token(row.id))
  if (row.label === null && row.terms === null) return { id: row.id, label: explicitLabel, automatic: false }
  check(typeof row.terms === 'string' && row.terms.length <= MAX_TERMS * (MAX_TERM + 4))
  const { label, terms } = discoveryMeta({ label: row.label, terms: JSON.parse(row.terms) })
  return { id: row.id, label, automatic: true, terms }
}
function publicMeta(row) { const { id, label, automatic } = decodeMeta(row); return { id, label, automatic } }

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
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;')
      const version = () => db.prepare('PRAGMA user_version').get().user_version
      const ours = () => db.prepare('PRAGMA application_id').get().application_id === APP_ID
      if (loc.fresh) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE grants(id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, expires_at INTEGER, pins TEXT NOT NULL, discovery_label TEXT, discovery_terms TEXT) STRICT;
          CREATE TABLE revoked(id TEXT PRIMARY KEY REFERENCES grants(id)) STRICT;
          ${v2Objects} ${speechSchema}; PRAGMA application_id=${APP_ID}; PRAGMA user_version=3; COMMIT;`)
      } else if (ours() && [1, 2].includes(version())) {
        db.exec('BEGIN IMMEDIATE')
        const from = version(), columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).join(',')
        check(ours() && [1, 2, 3].includes(from)) // Recheck after acquiring the write lock.
        if (from !== 3) {
          check(db.prepare('PRAGMA quick_check(1)').get().quick_check === 'ok' && columns('revoked') === 'id' &&
            !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger'").get() && !db.prepare('PRAGMA foreign_key_check').get())
          if (from === 1) {
            check(columns('grants') === 'id,scope_key,expires_at,pins')
            db.exec(`ALTER TABLE grants ADD COLUMN discovery_label TEXT; ALTER TABLE grants ADD COLUMN discovery_terms TEXT;
              ${v2Objects} PRAGMA user_version=2;`)
          }
          check(columns('grants') === 'id,scope_key,expires_at,pins,discovery_label,discovery_terms' && columns('turn_inputs') === 'scope_key,run_key,id' &&
            db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND tbl_name='grants' AND name IN ('grants_by_scope','discoverable_by_scope')").get().n === 2)
          db.exec(`${speechSchema}; PRAGMA user_version=3;`)
        }
        db.exec('COMMIT')
      }
      check(ours() && version() === 3 && db.prepare("SELECT sql FROM sqlite_schema WHERE name='speech_grants'").get()?.sql === speechSchema &&
        !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name='speech_grants'").get())
      this.#db = db
      return db
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); throw e }
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
      // Only pins, scope digest and explicitly authored discovery metadata; never capture text or raw identity.
      db.prepare('INSERT INTO grants(id,scope_key,expires_at,pins,discovery_label,discovery_terms) VALUES(?,?,?,?,?,?)')
        .run(id, s.key, spec.expiresAt, JSON.stringify(pins), spec.discovery?.label ?? null, spec.discovery ? JSON.stringify(spec.discovery.terms) : null)
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
  // Local only. Lists expose the authored label (or one constant), never pins, aliases, capture text, or credentials from a capture.
  list(scope) {
    try {
      const s = authority(scope)
      const rows = this.#database()?.prepare(`SELECT ${metadata} FROM grants g WHERE ${liveInScope} ORDER BY g.rowid DESC LIMIT ?`).all(s.key, this.#time(), MAX_ROWS)
      return (rows || []).map(publicMeta)
    } catch { return [] }
  }
  getMeta(scope, id) {
    try {
      if (!token(id)) return null
      const s = authority(scope)
      return publicMeta(this.#database()?.prepare(`SELECT ${metadata} ${active}`).get(id, s.key, this.#time()))
    } catch { return null }
  }
  find(scope, message) {
    try {
      const s = authority(scope), keys = messageKeys(message)
      if (!keys.size) return null
      const rows = this.#database()?.prepare(`SELECT ${metadata} FROM grants g WHERE ${liveInScope} AND g.discovery_terms IS NOT NULL LIMIT ?`).all(s.key, this.#time(), MAX_ROWS + 1)
      // Never hide a potential competitor behind a row limit or choose a recent grant to break a tie.
      if (!rows?.length || rows.length > MAX_ROWS) return null
      let winner = null
      for (const row of rows) {
        const { id, label, terms } = decodeMeta(row)
        if (terms.some(term => keys.has(aliasKey(term)))) {
          if (winner) return null
          winner = { id, label }
        }
      }
      return winner && this.#lookup(s, winner.id, false) ? winner : null
    } catch { return null }
  }
  #forTurn(s, run) {
    // Count all recorded handles, including now-inactive ones: an ambiguous run can never become unambiguous again.
    const row = this.#database()?.prepare(`SELECT ${metadata} FROM grants g WHERE ${liveInScope} AND g.id=(
      SELECT MIN(id) FROM turn_inputs WHERE scope_key=? AND run_key=? HAVING COUNT(*)=1)`).get(s.key, this.#time(), s.key, run)
    if (!row) return null
    const { id, label } = publicMeta(row); return { id, label }
  }
  rememberTurn(scope, localRunId, id) {
    try {
      if (!token(id)) return false
      const s = authority(scope), run = runKey(localRunId), db = this.#database()
      if (!db) return false
      // A host-recorded input link, not a claim the model read, used or verified it. Two append-only entries suffice to mark permanent ambiguity.
      db.prepare(`INSERT INTO turn_inputs(scope_key,run_key,id) SELECT ?,?,g.id ${active}
        AND (SELECT COUNT(*) FROM turn_inputs WHERE scope_key=? AND run_key=?)<2 ON CONFLICT DO NOTHING`)
        .run(s.key, run, id, s.key, this.#time(), s.key, run)
      return this.#forTurn(s, run)?.id === id
    } catch { return false }
  }
  forTurn(scope, localRunId) {
    try { return this.#forTurn(authority(scope), runKey(localRunId)) } catch { return null }
  }
  // Internal host API only. Call rememberSpeech after checking the authoritative live event and exact public message.
  speechGrant(scope) {
    try { const s = authority(scope); return speechState(this.#database(), s.key)?.generation ?? null } catch { return null }
  }
  // Management distinguishes missing from damaged or unreadable. A denied read is not proof of erasure.
  speechConsentState(scope) {
    try { const s = authority(scope); return Boolean(speechState(this.#database(), s.key)) } catch { return null }
  }
  clearSpeech(scope) {
    try {
      const s = authority(scope), db = this.#database(); if (!db) return true
      return speechWrite(db, () => { db.prepare('DELETE FROM speech_grants WHERE scope_key=?').run(s.key)
        return !db.prepare('SELECT 1 FROM speech_grants WHERE scope_key=?').get(s.key) })
    } catch { return false }
  }
  enableSpeech(scope) {
    try {
      const s = authority(scope), db = this.#database(true)
      return speechWrite(db, () => {
        const current = speechState(db, s.key)
        if (current) return current.generation
        const generation = randomUUID(), refs = '[]'
        db.prepare('INSERT INTO speech_grants(scope_key,generation,refs,seal) VALUES(?,?,?,?)').run(s.key, generation, refs, speechSeal(s.key, generation, refs))
        return generation
      })
    } catch { return null }
  }
  disableSpeech(scope, expectedGeneration) {
    try {
      const s = authority(scope); if (!validGeneration(expectedGeneration)) return false
      // Still let the matching owner erase a generation with corrupt derived references.
      return this.#database()?.prepare('DELETE FROM speech_grants WHERE scope_key=? AND generation=?').run(s.key, expectedGeneration).changes === 1
    } catch { return false }
  }
  rememberSpeech(scope, generation, record) {
    try {
      const s = authority(scope); if (!validGeneration(generation)) return false
      const ref = speechReference(record), db = this.#database(); if (!db) return false
      return speechWrite(db, () => {
        const state = speechState(db, s.key, generation); if (!state) return false
        const records = state.records, prior = records.find(r => r.seq === ref.seq || r.localMessageId === ref.localMessageId)
        if (prior) return JSON.stringify(prior) === JSON.stringify(ref) // Immutable exact retries only.
        if (records.length === SPEECH_WINDOW && ref.seq < records[0].seq) return false
        records.push(ref); records.sort((a, b) => a.seq - b.seq)
        if (records.length > SPEECH_WINDOW) records.shift()
        const refs = JSON.stringify(records)
        return db.prepare('UPDATE speech_grants SET refs=?,seal=? WHERE scope_key=? AND generation=?')
          .run(refs, speechSeal(s.key, generation, refs), s.key, generation).changes === 1
      })
    } catch { return false }
  }
  recentSpeech(scope, generation) {
    try {
      const s = authority(scope); if (!validGeneration(generation)) return []
      return speechState(this.#database(), s.key, generation)?.records ?? []
    } catch { return [] }
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
