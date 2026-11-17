import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { openEGDeskManagedDraftStore } from './egdesk-managed-drafts.mjs'
import { isSafeEntryName } from './egdesk-portable-extras.mjs'

// RT-03 bridge adapters for the opt-in .egdesk extras (see
// egdesk-portable-extras.mjs for the provider contract).
// - Attachments come from the immutable context store of the signed-in
//   account. Only the credential-redacted projection of a readable capture is
//   exported (binary captures go as stored). Imports become new 'sources'
//   records with a new ID and no conversation; nothing existing is replaced.
// - File drafts come from the local managed draft store. An import is a new
//   draft with no file, root or path: it reads as 'reconnect-required' and can
//   only reach an original through the existing reconnect + save-original
//   checks (D-X1).
const fail = (code, message, httpStatus = 503) => { throw Object.assign(new Error(message), { code, httpStatus }) }
const EXT = { 'text/plain': '.txt', 'text/markdown': '.md', 'application/json': '.json', 'text/csv': '.csv', 'text/tab-separated-values': '.tsv', 'text/html': '.html', 'image/png': '.png', 'image/jpeg': '.jpg', 'application/pdf': '.pdf' }

/** A plain, unique file name from a capture label; never a path. */
export function attachmentFileName(label, mime, taken) {
  const base = String(label ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s~]+/, '').trim().slice(0, 80) || 'capture'
  const ext = path.extname(base) ? '' : (EXT[String(mime).split(';')[0]] ?? '')
  for (let index = 1; ; index++) {
    const name = index === 1 ? `${base}${ext}` : `${base} (${index})${ext}`
    if (!taken.has(name) && isSafeEntryName(name)) { taken.add(name); return name }
    if (index > 999) return null
  }
}

/**
 * createContextAttachmentProvider({store, ownerKey}) — store: ImmutableContextStore,
 * ownerKey: () => current account key or null (signed out = unavailable).
 */
export function createContextAttachmentProvider({ store, ownerKey }) {
  const owner = () => {
    const key = typeof ownerKey === 'function' ? ownerKey() : null
    if (!store || typeof key !== 'string' || !key) fail('PORTABLE_ATTACHMENT_STORE_UNAVAILABLE', 'Attachments need a signed-in account; nothing was exported')
    return key
  }
  return {
    async exportList({ threadIds = null } = {}) {
      const key = owner()
      const wanted = threadIds === null ? null : new Set(threadIds)
      const records = await store.listRecords(key, 'sources', record => typeof record?.hash === 'string'
        && (wanted === null || wanted.has(record.clientThreadId)))
      records.sort((a, b) => (a.storedAt ?? 0) - (b.storedAt ?? 0) || String(a.sourceId).localeCompare(String(b.sourceId)))
      const taken = new Set()
      return records.map(record => {
        const projection = record.shape?.readable && record.payloads?.projection?.hash ? record.payloads.projection : null
        const mime = typeof record.shape?.mime === 'string' ? record.shape.mime : 'application/octet-stream'
        const size = (projection ?? record.payloads?.source)?.byteLength
        return {
          name: attachmentFileName(record.label ?? record.source?.title, mime, taken), mime,
          ...(Number.isSafeInteger(size) ? { size } : {}),
          read: () => store.readBlob(key, projection ? projection.hash : record.hash),
        }
      })
    },
    async importCopy({ name, mime, bytes, sha256 }) {
      const key = owner()
      const hash = await store.blob(key, bytes)
      if (hash !== sha256) fail('PORTABLE_ENTRY_UNSAFE', 'Attachment hash changed while importing', 400)
      let text = null
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) text = null } catch { text = null }
      const sourceId = randomUUID()
      const now = Date.now()
      const source = { kind: 'portable-import', title: name }
      await store.putRecord(key, 'sources', {
        version: 1, sourceId, snapshotId: sourceId, uiId: null, clientThreadId: null,
        hash, revision: hash, capturedAt: now, storedAt: now, kind: 'import', label: name, source, sourceRef: { ...source },
        captureScope: { type: 'portable-import', locator: null }, truncated: false,
        capture: { coverage: { scope: 'portable-import', complete: true, limits: null, description: null, provenance: 'egdesk-portable' } },
        shape: text === null ? { format: 'unsupported-binary', mime, readable: false } : { readable: true, format: 'text', mime, lineCount: text.split('\n').length, charCount: text.length, byteLength: bytes.length },
        payloads: { source: { hash, byteLength: bytes.length }, projection: text === null ? null : { hash, byteLength: bytes.length } },
        transformations: [],
      }, sourceId)
      return { id: sourceId }
    },
  }
}

/** createManagedDraftProvider({directory, ownerScope}) — opens the local managed draft store lazily. */
export function createManagedDraftProvider({ directory, ownerScope = 'egdesk-local', open = openEGDeskManagedDraftStore }) {
  let opening = null
  const store = () => (opening ??= open({ directory, ownerScope }).catch(error => { opening = null; throw error }))
  return {
    async exportList({ draftIds = null } = {}) {
      const drafts = await store()
      const records = draftIds === null ? await drafts.list({ limit: 1000 }) : (await Promise.all(draftIds.map(id => drafts.get(id)))).filter(Boolean)
      return records.map(record => ({ id: record.id, name: record.name, text: record.text }))
    },
    async importDraft({ name, text }) {
      const drafts = await store()
      const now = Date.now()
      // No fileId/rootId: the draft is disconnected and cannot write any original.
      const record = { id: randomUUID(), fileId: null, rootId: null, name, head: randomUUID(), baseText: text, text, sourceHash: null, sourceRevision: null, bufferRevision: 0, savedRevision: 0, savedHash: null, createdAt: now, updatedAt: now, origin: 'portable-import' }
      await drafts.create(record)
      return { draftId: record.id }
    },
    close: async () => { if (opening) (await opening.catch(() => null))?.close() },
  }
}
