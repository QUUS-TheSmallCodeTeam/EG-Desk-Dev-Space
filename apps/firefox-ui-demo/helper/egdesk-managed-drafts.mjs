import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const validRecord = record => {
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string' || !record.id || typeof record.head !== 'string' || !record.head) fail('INVALID_DRAFT', 'Draft record requires an ID and head')
}

/**
 * One managed SQLite database per authenticated owner scope. This stores only
 * editable draft heads; the backend's source snapshot/object store remains the
 * sole owner of source snapshots. SQLite UPDATE ... WHERE head is the CAS.
 */
export async function openEGDeskManagedDraftStore({ directory, ownerScope } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof ownerScope !== 'string' || !ownerScope || ownerScope.length > 512) fail('INVALID_STORE_SCOPE', 'Absolute managed directory and owner scope are required')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStat = await fs.lstat(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('INVALID_STORE_SCOPE', 'Managed draft directory must not be a symbolic link')
  const fileName = `${createHash('sha256').update(ownerScope).digest('hex')}.sqlite`
  const databasePath = path.join(directory, fileName)
  const existing = await fs.lstat(databasePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('INVALID_STORE_SCOPE', 'Managed draft database is not a regular file')
  const created = await fs.open(databasePath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600)
  await created.close()
  await fs.chmod(databasePath, 0o600)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, head TEXT NOT NULL, payload TEXT NOT NULL);')
  const insert = db.prepare('INSERT OR IGNORE INTO drafts (id, head, payload) VALUES (?, ?, ?)')
  const select = db.prepare('SELECT payload FROM drafts WHERE id = ?')
  const update = db.prepare('UPDATE drafts SET head = ?, payload = ? WHERE id = ? AND head = ?')
  const listAll = db.prepare('SELECT payload FROM drafts ORDER BY id LIMIT ?')
  let closed = false
  const ensureOpen = () => { if (closed) fail('STORE_CLOSED', 'Managed draft store is closed') }
  return {
    async create(record) {
      ensureOpen(); validRecord(record)
      const result = insert.run(record.id, record.head, JSON.stringify(record))
      if (result.changes !== 1) fail('DRAFT_EXISTS', 'Draft ID already exists')
      return structuredClone(record)
    },
    async get(id) {
      ensureOpen()
      if (typeof id !== 'string' || !id) return null
      const row = select.get(id)
      if (!row) return null
      const record = JSON.parse(row.payload)
      validRecord(record)
      return record
    },
    // RT-03 export: read-only listing, capped; a corrupt row is skipped, never repaired here.
    async list({ limit = 1000 } = {}) {
      ensureOpen()
      const max = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 10_000) : 1000
      const records = []
      for (const row of listAll.all(max)) {
        try { const record = JSON.parse(row.payload); validRecord(record); records.push(record) } catch { /* skipped */ }
      }
      return records
    },
    async compareAndSwap(id, expectedHead, next) {
      ensureOpen(); validRecord(next)
      if (typeof id !== 'string' || !id || next.id !== id || typeof expectedHead !== 'string' || !expectedHead || next.head === expectedHead) fail('INVALID_DRAFT', 'Invalid draft compare-and-swap')
      const result = update.run(next.head, JSON.stringify(next), id, expectedHead)
      if (result.changes !== 1) fail('DRAFT_CONFLICT', 'Managed draft head changed; no write was applied')
      return structuredClone(next)
    },
    close() { if (!closed) { closed = true; db.close() } },
    ownerScopeHash: fileName.slice(0, -'.sqlite'.length),
  }
}
