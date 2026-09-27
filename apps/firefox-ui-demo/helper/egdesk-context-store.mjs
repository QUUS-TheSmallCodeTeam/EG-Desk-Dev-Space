import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chatError, publicText, verifyLocalFile } from './codex-chat-values.mjs'

export const hashContent = value => createHash('sha256').update(value).digest('hex')
const uuid = value => typeof value === 'string' && /^[\da-f-]{36}$/i.test(value)
const fail = (code, message, status = 400) => { throw chatError(code, message, status) }
const small = (value, max = 512) => typeof value === 'string' && value.length <= max ? value : null
const copy = value => JSON.parse(JSON.stringify(value))

export function appDataDirectory(env = process.env, home = os.homedir(), platform = os.platform()) {
  if (env.EGDESK_DATA_DIR) {
    if (!path.isAbsolute(env.EGDESK_DATA_DIR)) fail('INVALID_DATA_DIR', 'EGDESK_DATA_DIR must be absolute')
    return env.EGDESK_DATA_DIR
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'EG-Desk')
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'EG-Desk')
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'egdesk')
}

function safeUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    url.username = ''; url.password = ''
    for (const key of [...url.searchParams.keys()]) if (/token|secret|password|code|state|key/i.test(key)) url.searchParams.delete(key)
    url.hash = ''
    return url.href
  } catch { return null }
}

export function sourceShape(text, mime = 'text/plain', filename = '') {
  if (text === null) return { format: 'unsupported-binary', mime, readable: false }
  const lines = text.split('\n')
  const table = /(?:csv|tab-separated)/.test(mime) || /\.(csv|tsv)$/i.test(filename)
  const code = /\.(?:[cm]?js|tsx?|py|rb|rs|go|java|c|h|cpp|sh|sql)$/i.test(filename)
  return {
    readable: true, format: table ? 'table' : code ? 'code' : /json/.test(mime) || /\.json$/i.test(filename) ? 'json' : 'text',
    mime, lineCount: lines.length, charCount: text.length, byteLength: Buffer.byteLength(text),
    sectionStarts: lines.flatMap((line, index) => /^#{1,6}\s|^(?:class|function|export (?:class|function))\s/.test(line) ? [index + 1] : []).slice(0, 2000),
  }
}

export class ImmutableContextStore {
  constructor({ dataDir, now = Date.now, maxCaptureBytes = 32 * 1024 * 1024, allowedRoots = [process.cwd()] } = {}) {
    if (!dataDir || !path.isAbsolute(dataDir)) fail('INVALID_DATA_DIR', 'An absolute app-owned data directory is required')
    this.root = path.join(dataDir, 'context')
    this.now = now
    this.maxCaptureBytes = maxCaptureBytes
    if (!Array.isArray(allowedRoots) || !allowedRoots.length || allowedRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) fail('INVALID_CONTEXT_ROOTS', 'Context file roots must be configured absolute directories')
    this.allowedRoots = allowedRoots
  }

  ownerScope(ownerKey) {
    if (typeof ownerKey !== 'string' || !ownerKey) fail('IDENTITY_REQUIRED', 'A known Codex account identity is required', 403)
    return hashContent(ownerKey)
  }

  async directory(ownerKey, kind) {
    if (!['sources', 'blobs', 'bindings', 'packets', 'briefings', 'readers', 'scratch', 'deliveries', 'threads'].includes(kind)) fail('INVALID_RECORD', 'Invalid context record kind')
    const dir = path.join(this.root, this.ownerScope(ownerKey), kind)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  async blob(ownerKey, bytes) {
    const hash = hashContent(bytes)
    const file = path.join(await this.directory(ownerKey, 'blobs'), hash)
    try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (hashContent(await readFile(file)) !== hash) fail('SNAPSHOT_CORRUPT', 'Stored capture integrity check failed', 409)
    return hash
  }

  async readBlob(ownerKey, hash) {
    if (!/^[\da-f]{64}$/.test(hash)) fail('SNAPSHOT_CORRUPT', 'Invalid capture hash', 409)
    const bytes = await readFile(path.join(await this.directory(ownerKey, 'blobs'), hash))
    if (hashContent(bytes) !== hash) fail('SNAPSHOT_CORRUPT', 'Stored capture integrity check failed', 409)
    return bytes
  }

  async putRecord(ownerKey, kind, record, id = randomUUID()) {
    if (!uuid(id)) fail('INVALID_RECORD_ID', 'Invalid record ID')
    const value = { ...record, id, ownerScope: this.ownerScope(ownerKey) }
    await writeFile(path.join(await this.directory(ownerKey, kind), `${id}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    return id
  }

  async getRecord(ownerKey, kind, id) {
    if (!uuid(id)) fail('INVALID_RECORD_ID', 'Invalid record ID')
    let record
    try { record = JSON.parse(await readFile(path.join(await this.directory(ownerKey, kind), `${id}.json`), 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') fail('CONTEXT_NOT_FOUND', 'Context is unavailable for this account', 404)
      throw error
    }
    if (record.ownerScope !== this.ownerScope(ownerKey) || record.id !== id) fail('CONTEXT_FORBIDDEN', 'Context ownership mismatch', 403)
    return record
  }

  async listRecords(ownerKey, kind, predicate = () => true) {
    const names = (await readdir(await this.directory(ownerKey, kind))).filter(name => /^[\da-f-]{36}\.json$/i.test(name))
    if (names.length > 2000) fail('CONTEXT_INDEX_LIMIT', 'Context index requires explicit archival before further listing', 409)
    const found = []
    for (const name of names) {
      const record = await this.getRecord(ownerKey, kind, name.slice(0, -5))
      if (predicate(record)) found.push(record)
    }
    return found
  }

  async markNativeThread(ownerKey, conversationId) {
    const key = hashContent(conversationId).slice(0, 32)
    const id = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`
    try { await this.putRecord(ownerKey, 'threads', { conversationId, toolsVersion: 1 }, id) } catch (error) { if (error.code !== 'EEXIST') throw error }
    return id
  }

  async hasNativeTools(ownerKey, conversationId) {
    const key = hashContent(conversationId).slice(0, 32)
    const id = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`
    try { const record = await this.getRecord(ownerKey, 'threads', id); return record.conversationId === conversationId && record.toolsVersion === 1 } catch (error) { if (error.code === 'CONTEXT_NOT_FOUND') return false; throw error }
  }

  async captureAttachments(ownerKey, { clientThreadId, attachments }) {
    if (!small(clientThreadId) || !Array.isArray(attachments) || !attachments.length || attachments.length > 16) fail('INVALID_CAPTURE', 'Provide a clientThreadId and 1–16 selected attachments')
    const captures = []
    for (const attachment of attachments) captures.push(await this.capture(ownerKey, clientThreadId, attachment))
    return captures
  }

  async capture(ownerKey, clientThreadId, attachment, { scopedRoot = null } = {}) {
    const kind = attachment?.kind
    if (!['file', 'browser', 'board'].includes(kind)) fail('INVALID_CAPTURE', 'Unsupported attachment kind')
    const sourceRef = attachment.sourceRef || attachment.source || {}
    const viewId = small(sourceRef.viewId) || small(attachment.source?.viewId)
    const source = {
      kind, resourceId: small(sourceRef.resourceId) || small(attachment.id),
      title: publicText(attachment.label || attachment.source?.title || kind, 300),
      viewId, revision: small(sourceRef.revision), url: safeUrl(sourceRef.url),
    }
    const scope = attachment.captureScope || { type: kind === 'file' ? 'file' : kind === 'board' ? 'board-selection' : 'selection' }
    if (!['file', 'document-text', 'dom-range', 'selection', 'board-selection'].includes(scope.type)) fail('INVALID_CAPTURE_SCOPE', 'Name the captured file, DOM range or selection')
    if ((kind === 'file') !== (scope.type === 'file')) fail('INVALID_CAPTURE_SCOPE', 'File byte captures and UI selection captures must retain their actual scope')
    const coverage = attachment.capture?.coverage || {}
    let bytes, text, mime = attachment.content?.mime || 'text/plain', truncated = false
    if (kind === 'file') {
      const requestedPath = sourceRef.path
      const canonical = await verifyLocalFile(requestedPath)
      if (!canonical) fail('SOURCE_UNAVAILABLE', 'Selected local file is unavailable or protected', 403)
      const roots = await Promise.all((scopedRoot ? [scopedRoot] : this.allowedRoots).map(root => realpath(root)))
      if (!roots.some(root => canonical.startsWith(`${root}${path.sep}`))) fail('SOURCE_OUTSIDE_ROOT', 'Selected file is outside configured context roots', 403)
      const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try {
        const before = await handle.stat()
        if (!before.isFile()) fail('INVALID_SOURCE', 'Only regular selected files can be captured')
        if (before.size > this.maxCaptureBytes) fail('CAPTURE_LIMIT', 'This source exceeds the local capture byte limit; no clipped capture was created', 413)
        bytes = await handle.readFile()
        const after = await handle.stat()
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) fail('SOURCE_CHANGED', 'File changed during capture; retry capture', 409)
        source.path = canonical
      } finally { await handle.close() }
      if (/\.json$/i.test(canonical)) mime = 'application/json'
      if (/\.csv$/i.test(canonical)) mime = 'text/csv'
      if (/\.tsv$/i.test(canonical)) mime = 'text/tab-separated-values'
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) text = null } catch { text = null }
      if (text === null && mime === 'text/plain') mime = 'application/octet-stream'
    } else {
      if (typeof attachment.content?.text !== 'string' || typeof attachment.content?.truncated !== 'boolean') fail('INVALID_CAPTURE', 'Visible text and an explicit truncated flag are required')
      text = attachment.content.text
      bytes = Buffer.from(text)
      truncated = attachment.content.truncated
    }
    if (bytes.length > this.maxCaptureBytes) fail('CAPTURE_LIMIT', 'Captured content exceeds the byte limit; no silent clipping is permitted', 413)
    const rawHash = await this.blob(ownerKey, bytes)
    const deliveredText = text === null ? null : publicText(text, Infinity)
    const projectionHash = deliveredText === null ? null : await this.blob(ownerKey, Buffer.from(deliveredText))
    const sourceId = randomUUID()
    const manifest = {
      version: 1, sourceId, snapshotId: sourceId, id: sourceId, uiId: small(attachment.id), clientThreadId,
      hash: rawHash, revision: rawHash, capturedAt: kind !== 'file' && Number.isFinite(attachment.capturedAt) ? attachment.capturedAt : this.now(), storedAt: this.now(),
      kind, label: source.title, source, sourceRef: { ...source },
      captureScope: { type: scope.type, locator: small(scope.locator, 2000) }, truncated,
      capture: { coverage: { scope: scope.type, complete: !truncated, limits: small(coverage.limits, 2000), description: small(coverage.description, 2000), provenance: kind === 'file' ? 'local-file-bytes' : 'explicit-ui-capture' } },
      shape: sourceShape(deliveredText, mime, source.path || ''),
      payloads: { source: { hash: rawHash, byteLength: bytes.length }, projection: projectionHash ? { hash: projectionHash, byteLength: Buffer.byteLength(deliveredText) } : null },
      transformations: projectionHash && projectionHash !== rawHash ? [{ type: 'credential-redaction', fromHash: rawHash, toHash: projectionHash }] : [],
    }
    await this.putRecord(ownerKey, 'sources', manifest, sourceId)
    return this.publicManifest(manifest)
  }

  publicManifest(manifest) {
    const { ownerScope, ...value } = manifest
    return copy({ ...value, id: value.uiId || value.sourceId })
  }

  async getCapture(ownerKey, sourceId) {
    return this.publicManifest(await this.getRecord(ownerKey, 'sources', sourceId))
  }

  async readProjection(ownerKey, sourceId) {
    const manifest = await this.getRecord(ownerKey, 'sources', sourceId)
    if (!manifest.payloads?.projection || !manifest.shape.readable) fail('UNSUPPORTED_SOURCE_FORMAT', 'Capture is preserved, but this format has no supported text projection', 422)
    return { manifest: this.publicManifest(manifest), text: (await this.readBlob(ownerKey, manifest.payloads.projection.hash)).toString('utf8') }
  }

  async inspect(ownerKey, sourceId, { startLine = 1, endLine, packetId } = {}) {
    const manifest = await this.getRecord(ownerKey, 'sources', sourceId)
    const raw = await this.readBlob(ownerKey, manifest.hash)
    let text
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); if (text.includes('\0')) text = null } catch { text = null }
    const receipts = await this.listRecords(ownerKey, 'deliveries', record => record.sourceId === sourceId && (!packetId || record.packetId === packetId))
    const receipt = receipts.filter(record => record.deliveryStatus === 'sent-to-app-server').sort((a, b) => b.sentAt - a.sentAt)[0]
    let delivered = null
    if (receipt) {
      const record = await this.getRecord(ownerKey, 'packets', receipt.packetId)
      if (record.packet.sourceId !== sourceId || hashContent(record.deliveryText) !== record.deliveryHash) fail('PACKET_CORRUPT', 'Delivered packet integrity check failed', 409)
      delivered = { role: 'agent_input', packetId: receipt.packetId, mime: 'application/json', hash: record.deliveryHash, text: record.deliveryText, mode: record.packet.mode, coverage: record.packet.coverage, deliveryStatus: 'sent-to-app-server', binding: record.binding }
    } else if (packetId) fail('DELIVERY_NOT_FOUND', 'This packet was not confirmed sent for the source', 404)
    const bindings = (await this.listRecords(ownerKey, 'bindings', record => record.sourceIds.includes(sourceId))).map(record => ({ bindingId: record.id, conversationId: record.conversationId, runId: record.runId, answerId: record.answerId }))
    if (text === null) return { capture: this.publicManifest(manifest), source: { role: 'source', mime: manifest.shape.mime, hash: manifest.hash, rangeHash: null, text: null, range: null, nextLine: null, byteLength: raw.length }, delivered, bindings }
    const lines = text.split('\n')
    const end = endLine ?? Math.min(lines.length, startLine + 199)
    if (!Number.isInteger(startLine) || !Number.isInteger(end) || startLine < 1 || end < startLine || end > lines.length || end - startLine >= 500) fail('INVALID_RANGE', 'Inspect an explicit range of at most 500 captured lines')
    const rangeText = lines.slice(startLine - 1, end).join('\n')
    if (Buffer.byteLength(rangeText) > 2 * 1024 * 1024) fail('INSPECT_RANGE_LIMIT', 'This line range exceeds the inspector byte limit; no clipped source was returned', 413)
    return { capture: this.publicManifest(manifest), source: { role: 'source', mime: manifest.shape.mime, hash: manifest.hash, rangeHash: hashContent(rangeText), text: rangeText, range: { startLine, endLine: end, totalLines: lines.length }, nextLine: end < lines.length ? end + 1 : null }, delivered, bindings }
  }

  async bind(ownerKey, run, sourceIds, capabilities) {
    const captures = []
    for (const id of sourceIds) captures.push(await this.getCapture(ownerKey, id))
    const binding = { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId, clientThreadId: run.clientThreadId, sourceIds: [...sourceIds], capabilities: { read: capabilities.read === true, reader: capabilities.reader === true, publishBriefing: capabilities.publishBriefing === true }, capturedAt: this.now() }
    const id = await this.putRecord(ownerKey, 'bindings', binding)
    return { bindingId: id, ...binding, captures }
  }

  async captureOutput(ownerKey, run, artifact, cwd) {
    if (!artifact || artifact.runId !== run.runId || artifact.answerId !== run.answerId || artifact.conversationId !== run.conversationId || artifact.type !== 'file') fail('INVALID_ARTIFACT_TARGET', 'Output must be an existing file artifact of this run', 403)
    if (!cwd || !path.isAbsolute(cwd)) fail('OUTPUT_CWD_REQUIRED', 'An explicit run cwd is required to capture an output')
    const root = await realpath(cwd)
    const file = await verifyLocalFile(artifact.target?.path, { artifact: true })
    if (!file || (file !== root && !file.startsWith(`${root}${path.sep}`))) fail('OUTPUT_OUTSIDE_CWD', 'Output artifact is outside the run cwd or unavailable', 403)
    return this.capture(ownerKey, run.clientThreadId || run.conversationId, { id: artifact.id, kind: 'file', label: artifact.label, sourceRef: { path: file, resourceId: artifact.id }, captureScope: { type: 'file' } }, { scopedRoot: root })
  }
}
