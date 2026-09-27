import { randomUUID, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'

const MAX_READ_BYTES = 8 * 1024 * 1024
const MAX_LIST = 200
const MAX_SEARCH = 100
const MAX_SEARCH_VISITS = 5000
const MAX_SEARCH_DEPTH = 12
const MAX_DIRECTORY_ENTRIES = 10_000
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export class FileSurfaceError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'FileSurfaceError'
    this.code = code
    this.details = details
  }
}

const fail = (code, message, details) => { throw new FileSurfaceError(code, message, details) }
const positiveLimit = (value, fallback, ceiling) => {
  if (value == null) return fallback
  if (!Number.isInteger(value) || value < 1 || value > ceiling) fail('INVALID_LIMIT', `Limit must be between 1 and ${ceiling}`)
  return value
}
const inside = (root, candidate) => {
  const rel = path.relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino
const sizeNumber = stat => Number(stat.size)
const revisionFor = (stat, digest) => `${stat.dev}:${stat.ino}:${digest}`
const captureMime = name => name.toLowerCase().endsWith('.json') ? 'application/json'
  : name.toLowerCase().endsWith('.csv') ? 'text/csv'
    : name.toLowerCase().endsWith('.tsv') ? 'text/tab-separated-values' : 'text/plain'
const NATIVE_SAVE_ERROR_CODES = new Set(['EGDESK_NATIVE_REFUSED', 'EGDESK_NATIVE_UNAVAILABLE', 'EGDESK_NATIVE_PROTOCOL', 'EGDESK_NATIVE_READBACK_MISMATCH', 'EGDESK_NATIVE_TIMEOUT', 'EGDESK_NATIVE_OUTPUT_LIMIT'])

function saveAsFailure(cause, fileName) {
  const reportedCreated = cause?.created ?? cause?.details?.created
  const created = reportedCreated === true ? true : reportedCreated === false ? false : null
  const fileMayExist = cause?.fileMayExist === true || cause?.details?.fileMayExist === true || created !== false
  const nativeCode = NATIVE_SAVE_ERROR_CODES.has(cause?.code) ? cause.code : null
  const nativeStatus = nativeCode && Number.isInteger(cause.nativeStatus) && cause.nativeStatus >= 1 && cause.nativeStatus <= 11 ? cause.nativeStatus : null
  // Only the validated leaf name and explicit outcome fields cross into HTTP.
  // Native messages, stderr, filesystem paths and device/inode are never copied.
  const targetName = typeof fileName === 'string' && !/[\\/\0]/.test(fileName)
    ? fileName.replace(/[\u0001-\u001f\u007f]/g, '\ufffd').slice(0, 255) : null
  const details = { ...(targetName ? { targetName } : {}), created, fileMayExist, originalUpdated: false,
    ...(nativeCode ? { nativeCode } : {}), ...(nativeStatus == null ? {} : { nativeStatus }) }
  if ((cause?.code === 'EEXIST' || cause?.code === 'TARGET_EXISTS' || nativeCode === 'EGDESK_NATIVE_REFUSED' && nativeStatus === 5) && created !== true && cause?.fileMayExist !== true && cause?.details?.fileMayExist !== true) {
    return new FileSurfaceError('TARGET_EXISTS', 'A file with this name already exists; choose a new name', { ...details, created: false, fileMayExist: false, targetExists: true, recovery: 'choose-new-target' })
  }
  if (nativeCode === 'EGDESK_NATIVE_UNAVAILABLE' || cause?.code === 'SAVE_AS_UNAVAILABLE') {
    return new FileSurfaceError('SAVE_AS_UNAVAILABLE', 'Create-only file storage is unavailable', { ...details, recovery: fileMayExist ? 'inspect-target-before-retry' : 'retry-when-available' })
  }
  if (fileMayExist) {
    return new FileSurfaceError(created === true ? 'SAVE_AS_INCOMPLETE' : 'SAVE_AS_UNCERTAIN',
      created === true ? 'The new file was created but its completed contents were not verified' : 'The new file outcome could not be verified',
      { ...details, recovery: 'inspect-target-before-retry' })
  }
  return new FileSurfaceError('SAVE_AS_FAILED', 'The new file could not be created', { ...details, recovery: 'reselect-location' })
}

function validLeaf(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0') || path.basename(name) !== name) {
    fail('INVALID_NAME', 'A single file name is required')
  }
  return name
}

function decodedText(bytes) {
  if (bytes.includes(0)) return null
  try { return textDecoder.decode(bytes) }
  catch { return null }
}

function lineDiff(before, after) {
  if (before === after) return []
  const left = before.split('\n')
  const right = after.split('\n')
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  let leftEnd = left.length
  let rightEnd = right.length
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd-- }
  return [{ baseStartLine: start + 1, baseLines: left.slice(start, leftEnd), currentStartLine: start + 1, currentLines: right.slice(start, rightEnd) }]
}

/**
 * Only the trusted picker/backend calls registerRoot. Renderer requests carry
 * opaque IDs returned by list/search, never filesystem paths. `draftStore`
 * must durably implement create/get/compareAndSwap(id, expectedHead, next).
 * External files are read-only; only the managed draft head is CAS-updated.
 * Save As requires a native createOnlyAdapter with capability
 * `descriptor-relative-create-only`. Its createFile opens/verifies rootPath,
 * walks relativeDirectory through directory descriptors with no-follow, then
 * creates fileName with O_EXCL and verifies bytes through that same descriptor.
 * No path-based fallback is safe against a concurrent parent-directory swap.
 */
export function createEGDeskFileService({ draftStore, createOnlyAdapter, makeId = randomUUID, now = Date.now } = {}) {
  if (!draftStore || !['create', 'get', 'compareAndSwap'].every(key => typeof draftStore[key] === 'function')) {
    fail('DRAFT_STORE_REQUIRED', 'A managed compare-and-swap draft store is required')
  }
  const roots = new Map()
  const resources = new Map()
  const saveAsAvailable = createOnlyAdapter?.capability === 'descriptor-relative-create-only' && typeof createOnlyAdapter.createFile === 'function'

  async function checkedRoot(rootId) {
    const root = roots.get(rootId)
    if (!root) fail('UNKNOWN_ROOT', 'Root handle is not authorized')
    const stat = await fs.lstat(root.path, { bigint: true }).catch(() => fail('ROOT_UNAVAILABLE', 'Authorized root is unavailable'))
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, root.identity)) fail('ROOT_CHANGED', 'Authorized root identity changed')
    return root
  }

  async function checkedResource(id, requiredKind) {
    const resource = resources.get(id)
    if (!resource) fail('UNKNOWN_RESOURCE', 'Resource handle is not authorized')
    const root = await checkedRoot(resource.rootId)
    const target = path.join(root.path, resource.relativePath)
    if (!inside(root.path, target)) fail('ROOT_ESCAPE', 'Resource is outside its authorized root')
    const stat = await fs.lstat(target, { bigint: true }).catch(() => fail('RESOURCE_UNAVAILABLE', 'Resource is missing'))
    if (stat.isSymbolicLink()) fail('SYMLINK', 'Symbolic links are not followed')
    if (!sameIdentity(stat, resource.identity)) fail('RESOURCE_CHANGED', 'Resource identity changed; reopen it')
    if (requiredKind && resource.kind !== requiredKind) fail('WRONG_KIND', `Expected a ${requiredKind}`)
    const real = await fs.realpath(target)
    if (!inside(root.path, real)) fail('ROOT_ESCAPE', 'Resource resolved outside its authorized root')
    return { root, resource, target, stat }
  }

  function handle(rootId, relativePath, kind, stat) {
    const id = makeId()
    resources.set(id, { rootId, relativePath, kind, identity: { dev: stat.dev, ino: stat.ino } })
    return id
  }

  async function registerRoot(absolutePath) {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) fail('INVALID_ROOT', 'Picker must provide an absolute directory path')
    const initial = await fs.lstat(absolutePath, { bigint: true })
    if (!initial.isDirectory() || initial.isSymbolicLink()) fail('INVALID_ROOT', 'Root must be a real directory, not a symbolic link')
    const real = await fs.realpath(absolutePath)
    const stat = await fs.lstat(real, { bigint: true })
    if (!sameIdentity(initial, stat)) fail('ROOT_CHANGED', 'Root changed during authorization')
    const rootId = makeId()
    roots.set(rootId, { path: real, identity: { dev: stat.dev, ino: stat.ino } })
    const directoryId = handle(rootId, '', 'directory', stat)
    return { rootId, directoryId, name: path.basename(real), displayPath: real, capability: saveAsAvailable ? 'read-and-create-only' : 'read-and-managed-copy', saveAsAvailable }
  }

  async function listDirectory({ directoryId, limit, cursor = 0 }) {
    const { root, resource, target } = await checkedResource(directoryId, 'directory')
    const pageSize = positiveLimit(limit, 100, MAX_LIST)
    if (!Number.isInteger(cursor) || cursor < 0) fail('INVALID_CURSOR', 'Cursor must be a non-negative integer')
    const names = []
    const directory = await fs.opendir(target)
    for await (const entry of directory) {
      if (names.length >= MAX_DIRECTORY_ENTRIES) fail('DIRECTORY_TOO_LARGE', 'Directory exceeds the 10,000-entry listing limit')
      names.push(entry.name)
    }
    names.sort((a, b) => a.localeCompare(b))
    const entries = []
    for (const name of names.slice(cursor, cursor + pageSize)) {
      const relativePath = path.join(resource.relativePath, name)
      const stat = await fs.lstat(path.join(root.path, relativePath), { bigint: true }).catch(() => null)
      if (!stat || stat.isSymbolicLink()) { entries.push({ name, kind: 'blocked', reason: stat ? 'symlink' : 'unavailable' }); continue }
      const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'blocked'
      entries.push({ name, kind, ...(kind === 'blocked' ? { reason: 'special-file' } : { id: handle(resource.rootId, relativePath, kind, stat), size: kind === 'file' ? sizeNumber(stat) : null }) })
    }
    return { entries, nextCursor: cursor + pageSize < names.length ? cursor + pageSize : null, total: names.length }
  }

  async function search({ rootId, query, limit, maxVisits = MAX_SEARCH_VISITS, maxDepth = MAX_SEARCH_DEPTH }) {
    const root = await checkedRoot(rootId)
    if (typeof query !== 'string' || !query.trim() || query.length > 256) fail('INVALID_QUERY', 'Search query must contain 1–256 characters')
    const resultLimit = positiveLimit(limit, 50, MAX_SEARCH)
    const visitLimit = positiveLimit(maxVisits, MAX_SEARCH_VISITS, MAX_SEARCH_VISITS)
    const depthLimit = positiveLimit(maxDepth, MAX_SEARCH_DEPTH, MAX_SEARCH_DEPTH)
    const needle = query.toLocaleLowerCase()
    const queue = [{ relativePath: '', depth: 0 }]
    const matches = []
    let visited = 0
    let stoppedInsideDirectory = false
    while (queue.length && visited < visitLimit && matches.length < resultLimit) {
      const current = queue.shift()
      const currentPath = path.join(root.path, current.relativePath)
      const currentStat = await fs.lstat(currentPath, { bigint: true }).catch(() => null)
      if (!currentStat?.isDirectory() || currentStat.isSymbolicLink()) continue
      const currentReal = await fs.realpath(currentPath).catch(() => null)
      if (!currentReal || !inside(root.path, currentReal)) continue
      let directory
      try { directory = await fs.opendir(currentPath) }
      catch { continue }
      for await (const dirent of directory) {
        if (visited >= visitLimit || matches.length >= resultLimit) { stoppedInsideDirectory = true; break }
        const name = dirent.name
        visited++
        const relativePath = path.join(current.relativePath, name)
        const target = path.join(root.path, relativePath)
        const stat = await fs.lstat(target, { bigint: true }).catch(() => null)
        if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue
        if (name.toLocaleLowerCase().includes(needle)) {
          matches.push({ id: handle(rootId, relativePath, stat.isDirectory() ? 'directory' : 'file', stat), name, relativePath, kind: stat.isDirectory() ? 'directory' : 'file' })
        }
        if (stat.isDirectory() && current.depth < depthLimit) queue.push({ relativePath, depth: current.depth + 1 })
      }
    }
    return { matches, visited, truncated: stoppedInsideDirectory || queue.length > 0 || visited >= visitLimit || matches.length >= resultLimit, scope: 'names' }
  }

  async function readFile({ fileId }) {
    const { resource, target, stat } = await checkedResource(fileId, 'file')
    if (!stat.isFile()) fail('WRONG_KIND', 'Expected a regular file')
    if (stat.size > BigInt(MAX_READ_BYTES)) fail('FILE_TOO_LARGE', 'File exceeds the 8 MiB exact-read limit', { size: sizeNumber(stat), limit: MAX_READ_BYTES })
    const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const before = await file.stat({ bigint: true })
      if (!sameIdentity(before, stat)) fail('RESOURCE_CHANGED', 'File changed before read')
      const bytes = await file.readFile()
      const after = await file.stat({ bigint: true })
      if (!sameIdentity(after, before) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || bytes.length !== sizeNumber(after)) fail('RESOURCE_CHANGED', 'File changed during read')
      const currentPathStat = await fs.lstat(target, { bigint: true }).catch(() => fail('RESOURCE_CHANGED', 'File moved during read'))
      if (!sameIdentity(currentPathStat, before) || currentPathStat.isSymbolicLink()) fail('RESOURCE_CHANGED', 'File path changed during read')
      const real = await fs.realpath(target)
      if (!inside((await checkedRoot(resource.rootId)).path, real)) fail('ROOT_ESCAPE', 'File resolved outside its authorized root')
      const digest = hash(bytes)
      const text = decodedText(bytes)
      return { fileId, name: path.basename(target), size: bytes.length, sha256: digest, diskRevision: revisionFor(after, digest), bytesBase64: bytes.toString('base64'), kind: text == null ? 'binary-or-invalid-utf8' : 'text', text }
    } finally { await file.close() }
  }

  async function requireDraft(draftId) {
    if (typeof draftId !== 'string' || !draftId) fail('UNKNOWN_DRAFT', 'Draft ID is required')
    const draft = await draftStore.get(draftId)
    if (!draft || draft.id !== draftId || typeof draft.head !== 'string') fail('UNKNOWN_DRAFT', 'Managed draft is unavailable')
    return draft
  }
  const publicDraft = draft => ({ ...draft, mode: 'managed-working-copy', originalUpdated: false, saveAsAvailable, sourceConnection: resources.has(draft.fileId) ? 'authorized-handle' : 'reconnect-required' })

  async function createDraft({ fileId }) {
    const source = await readFile({ fileId })
    if (source.kind !== 'text') fail('UNSUPPORTED_EDIT', 'Binary or invalid UTF-8 files cannot be edited here')
    const record = { id: makeId(), fileId, rootId: resources.get(fileId).rootId, name: source.name, head: makeId(), baseText: source.text, text: source.text, sourceHash: source.sha256, sourceRevision: source.diskRevision, bufferRevision: 0, savedRevision: 0, savedHash: source.sha256, createdAt: now(), updatedAt: now() }
    await draftStore.create(record)
    return publicDraft(record)
  }

  async function readDraft({ draftId }) { return publicDraft(await requireDraft(draftId)) }

  // Internal context-capture source. A renderer may carry this opaque reference,
  // but only the owner-bound adapter may resolve it to bytes. Never consult the
  // external original here: it may have changed, moved, or been disconnected.
  async function resolveCaptureSource(captureRef) {
    const keys = ['fileId', 'draftId', 'head', 'revision']
    if (!captureRef || typeof captureRef !== 'object' || Array.isArray(captureRef) ||
      Object.keys(captureRef).some(key => !keys.includes(key)) ||
      keys.slice(0, 3).some(key => typeof captureRef[key] !== 'string' || !captureRef[key] || captureRef[key].length > 512) ||
      !Number.isSafeInteger(captureRef.revision) || captureRef.revision < 0) {
      fail('INVALID_CAPTURE_REF', 'An exact managed working-copy reference is required')
    }
    const draft = await requireDraft(captureRef.draftId)
    if (draft.fileId !== captureRef.fileId || draft.head !== captureRef.head || draft.bufferRevision !== captureRef.revision) {
      fail('CAPTURE_STALE', 'Working copy changed; select the current revision again')
    }
    if (typeof draft.text !== 'string' || typeof draft.name !== 'string' || !draft.name ||
      path.basename(draft.name) !== draft.name || draft.name.includes('\0') ||
      draft.text.includes('\0') || !draft.text.isWellFormed()) fail('INVALID_DRAFT', 'Managed working copy is invalid')
    const bytes = Buffer.from(draft.text, 'utf8')
    if (bytes.length > MAX_READ_BYTES) fail('FILE_TOO_LARGE', 'Managed working copy exceeds the 8 MiB capture limit')
    return { bytes, mime: captureMime(draft.name), name: draft.name, sha256: hash(bytes), captureRef: { ...captureRef } }
  }

  async function swapDraft(draft, expectedHead, next, operationId) {
    if (typeof expectedHead !== 'string' || expectedHead !== draft.head) fail('DRAFT_CONFLICT', 'Draft head changed; refresh before saving', { currentHead: draft.head })
    if (typeof operationId !== 'string' || !operationId) fail('OPERATION_ID_REQUIRED', 'Operation ID is required')
    const updated = { ...draft, ...next, head: makeId(), updatedAt: now(), lastOperationId: operationId }
    try { return publicDraft(await draftStore.compareAndSwap(draft.id, expectedHead, updated)) }
    catch (error) {
      if (error?.code === 'DRAFT_CONFLICT') fail('DRAFT_CONFLICT', 'Draft head changed; latest working copy remains available')
      throw error
    }
  }

  async function updateDraft({ draftId, expectedHead, text, operationId }) {
    const draft = await requireDraft(draftId)
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES) fail('INVALID_TEXT', 'Draft text must be UTF-8 and at most 8 MiB')
    if (text.includes('\0') || !text.isWellFormed()) fail('INVALID_TEXT', 'Draft contains unsupported NUL bytes or unpaired Unicode surrogates')
    return swapDraft(draft, expectedHead, { text, bufferRevision: draft.bufferRevision + 1 }, operationId)
  }

  async function saveDraft({ draftId, expectedHead, bufferRevision, operationId }) {
    const draft = await requireDraft(draftId)
    if (bufferRevision !== draft.bufferRevision) fail('BUFFER_CONFLICT', 'A newer text buffer exists; it was not replaced', { currentBufferRevision: draft.bufferRevision })
    const savedHash = hash(Buffer.from(draft.text, 'utf8'))
    const saved = await swapDraft(draft, expectedHead, { savedRevision: bufferRevision, savedHash }, operationId)
    return { draft: saved, receipt: { mode: 'managed-working-copy', target: draftId, savedRevision: bufferRevision, sha256: savedHash, originalUpdated: false } }
  }

  async function diffDraft({ draftId }) {
    const draft = await requireDraft(draftId)
    return { draftId, baseHash: draft.sourceHash, currentHash: hash(Buffer.from(draft.text, 'utf8')), bufferRevision: draft.bufferRevision, savedRevision: draft.savedRevision, hunks: lineDiff(draft.baseText, draft.text) }
  }

  async function sourceStatus({ draftId }) {
    const draft = await requireDraft(draftId)
    try {
      const source = await readFile({ fileId: draft.fileId })
      return { status: source.diskRevision === draft.sourceRevision ? 'unchanged' : 'changed', sourceRevision: source.diskRevision, sourceHash: source.sha256 }
    } catch (error) {
      if (['UNKNOWN_RESOURCE', 'UNKNOWN_ROOT', 'RESOURCE_CHANGED', 'RESOURCE_UNAVAILABLE', 'ROOT_CHANGED', 'ROOT_UNAVAILABLE'].includes(error?.code)) return { status: 'unavailable', reason: error.code }
      throw error
    }
  }

  async function reconnectDraft({ draftId, expectedHead, fileId, operationId }) {
    const draft = await requireDraft(draftId)
    if (expectedHead !== draft.head) fail('DRAFT_CONFLICT', 'Draft head changed; reconnect was not applied')
    const source = await readFile({ fileId })
    if (source.kind !== 'text' || source.sha256 !== draft.sourceHash) fail('SOURCE_RECONNECT_CONFLICT', 'Selected source differs from the draft baseline; working copy is preserved', { expectedSourceHash: draft.sourceHash, selectedSourceHash: source.sha256 })
    const reconnected = await swapDraft(draft, expectedHead, { fileId, rootId: resources.get(fileId).rootId, sourceRevision: source.diskRevision, name: source.name }, operationId)
    return { draft: reconnected, source: { fileId, name: source.name, size: source.size, sha256: source.sha256, diskRevision: source.diskRevision } }
  }

  async function saveAs({ draftId, expectedHead, directoryId, fileName, operationId }) {
    if (!saveAsAvailable) throw saveAsFailure({ code: 'SAVE_AS_UNAVAILABLE', created: false, fileMayExist: false }, fileName)
    const draft = await requireDraft(draftId)
    if (expectedHead !== draft.head) fail('DRAFT_CONFLICT', 'Draft head changed; create-only export was not attempted')
    if (typeof operationId !== 'string' || !operationId) fail('OPERATION_ID_REQUIRED', 'Operation ID is required')
    const { root, resource: directoryResource, stat: directoryStat } = await checkedResource(directoryId, 'directory')
    validLeaf(fileName)
    const bytes = Buffer.from(draft.text, 'utf8')
    try {
      const receipt = await createOnlyAdapter.createFile({
        rootPath: root.path,
        rootIdentity: { dev: String(root.identity.dev), ino: String(root.identity.ino) },
        relativeDirectory: directoryResource.relativePath,
        directoryIdentity: { dev: String(directoryStat.dev), ino: String(directoryStat.ino) },
        fileName, bytes, operationId,
      })
      if (receipt?.created !== true || receipt.sha256 !== hash(bytes) || receipt.size !== bytes.length || !/^\d+$/.test(receipt.dev) || !/^\d+$/.test(receipt.ino)) fail('READBACK_FAILED', 'Native create-only receipt did not match the draft', { created: receipt?.created === true ? true : null, fileMayExist: true })
      const identity = { dev: BigInt(receipt.dev), ino: BigInt(receipt.ino) }
      return { mode: 'create-only-save-as', targetName: fileName, resourceId: handle(directoryResource.rootId, path.join(directoryResource.relativePath, fileName), 'file', identity), sha256: receipt.sha256, size: receipt.size, originalUpdated: false }
    } catch (error) {
      throw saveAsFailure(error, fileName)
    }
  }

  return { registerRoot, listDirectory, search, readFile, createDraft, readDraft, resolveCaptureSource, updateDraft, saveDraft, diffDraft, sourceStatus, reconnectDraft, saveAs }
}
