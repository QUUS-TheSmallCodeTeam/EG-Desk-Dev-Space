import { randomUUID, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentMatchRanges, contentSnippet, createEGDeskGitReview, EGDESK_GIT_REVIEW_LIMITS } from './egdesk-git-review.mjs'

const MAX_READ_BYTES = 8 * 1024 * 1024
const MAX_LIST = 200
const MAX_SEARCH = 100
const MAX_SEARCH_VISITS = 5000
const MAX_SEARCH_DEPTH = 12
const MAX_DIRECTORY_ENTRIES = 10_000
const MAX_CONTENT_FILE_BYTES = 1024 * 1024
const MAX_CONTENT_FILES = 2000
const CONTENT_WALK_BUDGET_MS = 1000
// Folders a name/content walk skips unless the caller asks to include them.
// Pattern from BloopAI/vibe-kanban (Apache-2.0)
// crates/services/src/services/file_search.rs:247-254 — pattern only.
export const DEFAULT_SEARCH_IGNORES = Object.freeze(['.git', 'node_modules', 'target', 'dist', 'build'])
const GIT_NOT_READY = new Set(['GIT_UNAVAILABLE'])
const toNative = posixPath => path.join(...posixPath.split('/'))
const toPosix = nativePath => nativePath.split(path.sep).join('/')
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
const SHA256_HEX = /^[0-9a-f]{64}$/
const MAX_RESOLVE_PATH = 4096

function checkedHash(value, name) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) fail('INVALID_HASH', `${name} must be a SHA-256 hex digest`)
  return value
}

function checkedText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES) fail('INVALID_TEXT', 'Draft text must be UTF-8 and at most 8 MiB')
  if (text.includes('\0') || !text.isWellFormed()) fail('INVALID_TEXT', 'Draft contains unsupported NUL bytes or unpaired Unicode surrogates')
  return text
}

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

// Myers O((N+M)·D) shortest edit script over line ids (E. Myers, "An O(ND)
// Difference Algorithm and Its Variations", 1986 — the algorithm jsdiff and git
// use; written here from the paper, no code copied). Returns matched [i, j]
// pairs, or null when the edit count or time budget is exceeded.
function myersMatches(a, b, maxEdits, deadline, now) {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = d; break }
    }
    if (found < 0 && (d & 31) === 31 && now() > deadline) return null
  }
  if (found < 0) return null
  const pairs = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const snapshot = trace[d]
    const at = k => snapshot[k + d]
    const k = x - y
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const previousX = at(previousK)
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) { pairs.push([x - 1, y - 1]); x--; y-- }
    x = previousX
    y = previousY
  }
  while (x > 0 && y > 0) { pairs.push([x - 1, y - 1]); x--; y-- }
  return pairs.reverse()
}

const DIFF_MAX_EDITS = 1000
const DIFF_BUDGET_MS = 100

// One entry per separate change, in the File view's existing hunk shape
// {baseStartLine, baseLines, currentStartLine, currentLines} (1-based, no
// context lines). Two edits far apart are two entries. Past the edit or time
// budget it falls back to the single shared-head/tail block it used before.
export function lineDiff(before, after, { now = Date.now, maxEdits = DIFF_MAX_EDITS, budgetMs = DIFF_BUDGET_MS } = {}) {
  if (before === after) return []
  const left = before.split('\n')
  const right = after.split('\n')
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  let leftEnd = left.length
  let rightEnd = right.length
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd-- }
  const single = [{ baseStartLine: start + 1, baseLines: left.slice(start, leftEnd), currentStartLine: start + 1, currentLines: right.slice(start, rightEnd) }]
  if (leftEnd === start || rightEnd === start) return single
  // Lines become small integers so the inner loop compares numbers; the map
  // lives only for this call and is never stored or logged.
  const ids = new Map()
  const idOf = line => { let id = ids.get(line); if (id === undefined) { id = ids.size; ids.set(line, id) } return id }
  const a = left.slice(start, leftEnd).map(idOf)
  const b = right.slice(start, rightEnd).map(idOf)
  const pairs = myersMatches(a, b, maxEdits, now() + budgetMs, now)
  if (!pairs) return single
  const hunks = []
  let i = 0
  let j = 0
  for (const [pi, pj] of [...pairs, [a.length, b.length]]) {
    if (pi > i || pj > j) hunks.push({ baseStartLine: start + i + 1, baseLines: left.slice(start + i, start + pi), currentStartLine: start + j + 1, currentLines: right.slice(start + j, start + pj) })
    i = pi + 1
    j = pj + 1
  }
  return hunks
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
 *
 * D-X1 (대표님 결정 2026-10-24): the original file is written only by the
 * user's own save (saveOriginal) and by a revert during change review
 * (revertReviewed). Both are conditional: the file must still hash to the
 * value the user saw; if it differs but already holds exactly the new bytes
 * the save passes without writing; otherwise SOURCE_CHANGED returns both
 * hashes so the screen can show a comparison. Dirty-write rule after VS Code
 * src/vs/platform/files/common/fileService.ts:502-536 (MIT) — pattern only,
 * with a content hash instead of mtime/size. The write goes to a temporary
 * file in the same folder (O_CREAT|O_EXCL|O_NOFOLLOW), is synced, and is
 * renamed over the original; the handle's identity then moves to the new
 * inode. Limitation: rename is path-based; parent identity is re-checked just
 * before and the result verified just after, and a mismatch is reported as
 * SAVE_UNCERTAIN instead of retried.
 */
export function createEGDeskFileService({ draftStore, createOnlyAdapter, makeId = randomUUID, now = Date.now, onRootRegistered = null, gitReview = createEGDeskGitReview() } = {}) {
  if (!draftStore || !['create', 'get', 'compareAndSwap'].every(key => typeof draftStore[key] === 'function')) {
    fail('DRAFT_STORE_REQUIRED', 'A managed compare-and-swap draft store is required')
  }
  const roots = new Map()
  const resources = new Map()
  // Opaque change handles from gitChanges. Two list generations per root stay
  // valid so a click racing an automatic refresh still resolves.
  const changes = new Map()
  const changeGeneration = new Map()
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
    // RT-06: a connected root may be watched for changes. The watcher gets the
    // verified real path backend-side; responses and events keep the opaque ID.
    if (typeof onRootRegistered === 'function') { try { onRootRegistered({ rootId, absolutePath: real }) } catch {} }
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

  // Regular, non-symlink file or directory strictly inside the root, as a new
  // opaque handle; null for anything else (missing, symlink, escaped, special).
  async function handleForRelative(root, rootId, nativeRelative, wantKind = null) {
    if (!nativeRelative || path.isAbsolute(nativeRelative)) return null
    const target = path.join(root.path, nativeRelative)
    if (!inside(root.path, target) || target === root.path) return null
    const stat = await fs.lstat(target, { bigint: true }).catch(() => null)
    if (!stat || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return null
    const kind = stat.isDirectory() ? 'directory' : 'file'
    if (wantKind && kind !== wantKind) return null
    const real = await fs.realpath(target).catch(() => null)
    if (!real || !inside(root.path, real)) return null
    return { id: handle(rootId, nativeRelative, kind, stat), kind, stat }
  }

  // BFS over the root that skips DEFAULT_SEARCH_IGNORES (unless includeIgnored)
  // and never follows symlinks or leaves the root.
  async function walkRoot(root, { visitLimit, depthLimit, includeIgnored, onEntry, shouldStop }) {
    const queue = [{ relativePath: '', depth: 0 }]
    let visited = 0
    let stoppedInsideDirectory = false
    while (queue.length && visited < visitLimit && !shouldStop()) {
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
        if (visited >= visitLimit || shouldStop()) { stoppedInsideDirectory = true; break }
        const name = dirent.name
        if (!includeIgnored && DEFAULT_SEARCH_IGNORES.includes(name)) continue
        visited++
        const relativePath = path.join(current.relativePath, name)
        const stat = await fs.lstat(path.join(root.path, relativePath), { bigint: true }).catch(() => null)
        if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue
        await onEntry({ name, relativePath, stat })
        if (stat.isDirectory() && current.depth < depthLimit) queue.push({ relativePath, depth: current.depth + 1 })
      }
    }
    return { visited, incomplete: stoppedInsideDirectory || queue.length > 0 || visited >= visitLimit }
  }

  // Inside a git work tree, `git ls-files -co --exclude-standard` lists exactly
  // the names a .gitignore-aware search should see (vibe-kanban TaskForm mode,
  // file_search.rs:257-266); folder names come from file ancestors as in
  // t3code withDirectoryAncestors (WorkspaceSearchIndex.ts:283-295). Pattern only.
  async function searchGitIndex(root, rootId, needle, resultLimit) {
    let listed
    try { listed = await gitReview?.listFiles?.(root.path) }
    catch { return null }
    if (!listed) return null
    const candidates = new Map()
    for (const filePath of listed.paths) {
      const parts = filePath.split('/')
      if (parts.some(part => !part || part === '.' || part === '..')) continue
      for (let depth = 1; depth <= parts.length; depth++) {
        if (!parts[depth - 1].toLocaleLowerCase().includes(needle)) continue
        const candidate = parts.slice(0, depth).join('/')
        if (!candidates.has(candidate)) candidates.set(candidate, { depth, kind: depth === parts.length ? 'file' : 'directory' })
      }
    }
    const ordered = [...candidates].sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]))
    const matches = []
    let stoppedAtLimit = false
    for (const [candidate, { kind }] of ordered) {
      if (matches.length >= resultLimit) { stoppedAtLimit = true; break }
      const nativeRelative = toNative(candidate)
      const resolved = await handleForRelative(root, rootId, nativeRelative, kind)
      if (resolved) matches.push({ id: resolved.id, name: path.basename(nativeRelative), relativePath: nativeRelative, kind })
    }
    return { matches, visited: listed.paths.length, truncated: listed.truncated || stoppedAtLimit, scope: 'names', source: 'git-index' }
  }

  async function search({ rootId, query, limit, maxVisits = MAX_SEARCH_VISITS, maxDepth = MAX_SEARCH_DEPTH, includeIgnored = false }) {
    const root = await checkedRoot(rootId)
    if (typeof query !== 'string' || !query.trim() || query.length > 256) fail('INVALID_QUERY', 'Search query must contain 1–256 characters')
    if (typeof includeIgnored !== 'boolean') fail('INVALID_OPTION', 'includeIgnored must be a boolean')
    const resultLimit = positiveLimit(limit, 50, MAX_SEARCH)
    const visitLimit = positiveLimit(maxVisits, MAX_SEARCH_VISITS, MAX_SEARCH_VISITS)
    const depthLimit = positiveLimit(maxDepth, MAX_SEARCH_DEPTH, MAX_SEARCH_DEPTH)
    const needle = query.toLocaleLowerCase()
    if (!includeIgnored) {
      const viaGit = await searchGitIndex(root, rootId, needle, resultLimit)
      if (viaGit) return viaGit
    }
    const matches = []
    const walked = await walkRoot(root, {
      visitLimit, depthLimit, includeIgnored,
      shouldStop: () => matches.length >= resultLimit,
      onEntry: ({ name, relativePath, stat }) => {
        if (!name.toLocaleLowerCase().includes(needle)) return
        const kind = stat.isDirectory() ? 'directory' : 'file'
        matches.push({ id: handle(rootId, relativePath, kind, stat), name, relativePath, kind })
      },
    })
    return { matches, visited: walked.visited, truncated: walked.incomplete || matches.length >= resultLimit, scope: 'names', source: 'walk' }
  }

  async function contentLines(root, nativeRelative, stat) {
    if (stat.size > BigInt(MAX_CONTENT_FILE_BYTES)) return null
    const target = path.join(root.path, nativeRelative)
    let file
    try { file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
    catch { return null }
    try {
      const opened = await file.stat({ bigint: true })
      if (!sameIdentity(opened, stat) || !opened.isFile() || opened.size > BigInt(MAX_CONTENT_FILE_BYTES)) return null
      const text = decodedText(await file.readFile())
      return text == null ? null : text.split('\n')
    } catch { return null }
    finally { await file.close().catch(() => {}) }
  }

  // Content search: `git grep` inside a work tree, otherwise a bounded walk
  // over UTF-8 text files of at most 1 MiB. Query text is never logged.
  // Result shape follows t3code's ProjectSearchContentsInput/Result (MIT,
  // packages/contracts/src/project.ts:262-293): untrimmed query ≤256,
  // {path, lineNumber, lineContent, matchRanges}, truncated; ≤100 hits per file
  // (apps/server/src/workspace/WorkspaceSearchIndex.ts:42-43). Pattern only.
  async function searchContents({ rootId, query, limit, caseSensitive = false }) {
    const root = await checkedRoot(rootId)
    if (typeof query !== 'string' || !query.trim() || query.length > 256 || /[\0\r\n]/.test(query)) fail('INVALID_QUERY', 'Content search needs one line of 1–256 characters')
    if (typeof caseSensitive !== 'boolean') fail('INVALID_OPTION', 'caseSensitive must be a boolean')
    const resultLimit = positiveLimit(limit, 50, MAX_SEARCH)
    const matches = []
    const resolvedFiles = new Map()
    const addMatch = async (nativeRelative, lineNumber, line, knownHandle = null) => {
      let fileHandle = knownHandle || resolvedFiles.get(nativeRelative)
      if (fileHandle === undefined) {
        fileHandle = (await handleForRelative(root, rootId, nativeRelative, 'file'))?.id || null
        resolvedFiles.set(nativeRelative, fileHandle)
      }
      if (!fileHandle) return
      const ranges = contentMatchRanges(line, query, caseSensitive)
      matches.push({ fileId: fileHandle, relativePath: toPosix(nativeRelative), lineNumber, ...contentSnippet(line, ranges) })
    }
    let grep = null
    try { grep = await gitReview?.grep?.(root.path, { query, caseSensitive, limit: resultLimit + 1 }) }
    catch (error) { if (!['GIT_UNAVAILABLE', 'GIT_TIMEOUT', 'GIT_FAILED'].includes(error?.code)) throw error }
    if (grep) {
      for (const match of grep.matches) {
        if (matches.length > resultLimit) break
        const parts = match.relativePath.split('/')
        if (parts.some(part => !part || part === '.' || part === '..')) continue
        await addMatch(toNative(match.relativePath), match.lineNumber, match.lineContent)
      }
      return { matches: matches.slice(0, resultLimit), truncated: grep.truncated || matches.length > resultLimit, scope: 'contents', source: 'git-grep' }
    }
    const deadline = now() + CONTENT_WALK_BUDGET_MS
    let files = 0
    let budgetStop = false
    const walked = await walkRoot(root, {
      visitLimit: MAX_SEARCH_VISITS, depthLimit: MAX_SEARCH_DEPTH, includeIgnored: false,
      shouldStop: () => matches.length > resultLimit || files >= MAX_CONTENT_FILES || (budgetStop ||= now() > deadline),
      onEntry: async ({ relativePath, stat }) => {
        if (!stat.isFile() || matches.length > resultLimit) return
        files++
        const lines = await contentLines(root, relativePath, stat)
        if (!lines) return
        let knownHandle = null
        let perFile = 0
        for (let index = 0; index < lines.length && matches.length <= resultLimit && perFile < EGDESK_GIT_REVIEW_LIMITS.grepMatchesPerFile; index++) {
          const line = lines[index].replace(/\r$/, '')
          if (!contentMatchRanges(line, query, caseSensitive).length) continue
          knownHandle ||= handle(rootId, relativePath, 'file', stat)
          await addMatch(relativePath, index + 1, line, knownHandle)
          perFile++
        }
      },
    })
    return { matches: matches.slice(0, resultLimit), truncated: walked.incomplete || budgetStop || files >= MAX_CONTENT_FILES || matches.length > resultLimit, scope: 'contents', source: 'walk' }
  }

  const gitError = error => {
    if (error instanceof FileSurfaceError) return error
    const code = typeof error?.code === 'string' && /^(?:GIT_[A-Z_]+|INVALID_PATH|NOT_A_REPOSITORY)$/.test(error.code) ? error.code : 'GIT_FAILED'
    return new FileSurfaceError(code, code === 'GIT_TIMEOUT' ? 'git did not answer in time' : code === 'NOT_A_REPOSITORY' ? 'The connected folder is not inside a git repository' : 'git review failed')
  }
  const gitUnavailable = rootId => ({ rootId, available: false, isRepo: false, branch: null, truncated: false })

  // Tree decoration: root-relative POSIX paths with one state each. Untracked
  // folders arrive as one `directory: true` entry (status --untracked-files=normal).
  async function gitStatus({ rootId }) {
    const root = await checkedRoot(rootId)
    try {
      const result = await gitReview.status(root.path, { untracked: 'normal' })
      return { rootId, available: true, isRepo: result.isRepo, branch: result.branch, truncated: result.truncated,
        entries: result.entries.filter(entry => entry.state !== 'ignored').map(({ relativePath, previousPath, state, staged, unstaged, directory }) => ({ relativePath, previousPath, state, staged, unstaged, directory })) }
    } catch (error) {
      if (GIT_NOT_READY.has(error?.code)) return { ...gitUnavailable(rootId), entries: [] }
      throw gitError(error)
    }
  }

  // '커밋 안 한 변경' list. Each file gets an opaque changeId for gitFileDiff;
  // file handles are created only when a diff is opened.
  async function gitChanges({ rootId, scope = 'uncommitted' }) {
    const root = await checkedRoot(rootId)
    if (scope !== 'uncommitted') fail('UNSUPPORTED_SCOPE', 'Only uncommitted changes are available here; turn changes come from the chat runtime')
    let result
    try { result = await gitReview.changes(root.path) }
    catch (error) {
      if (GIT_NOT_READY.has(error?.code)) return { ...gitUnavailable(rootId), scope, files: [], totals: { files: 0, additions: 0, deletions: 0 } }
      throw gitError(error)
    }
    const generation = (changeGeneration.get(rootId) || 0) + 1
    changeGeneration.set(rootId, generation)
    for (const [id, change] of changes) if (change.rootId === rootId && change.generation < generation - 1) changes.delete(id)
    const files = result.files.map(file => {
      const changeId = makeId()
      changes.set(changeId, { rootId, generation, relativePath: file.relativePath, previousPath: file.previousPath, status: file.status })
      return { changeId, ...file }
    })
    const totals = files.reduce((sum, file) => ({ files: sum.files + 1, additions: sum.additions + (file.additions || 0), deletions: sum.deletions + (file.deletions || 0) }), { files: 0, additions: 0, deletions: 0 })
    return { rootId, scope, available: true, isRepo: result.isRepo, branch: result.branch, truncated: result.truncated, countsAvailable: result.countsAvailable !== false, files, totals }
  }

  // One file's change against HEAD, in the lineDiff hunk shape plus the raw
  // unified patch (≤1 MiB). Untracked files are read through the exact-read path.
  async function gitFileDiff({ changeId }) {
    const change = changes.get(changeId)
    if (!change) fail('UNKNOWN_CHANGE', 'Change list is out of date; refresh it')
    const root = await checkedRoot(change.rootId)
    const base = { changeId, relativePath: change.relativePath, previousPath: change.previousPath, status: change.status }
    const current = change.status === 'deleted' ? null : await handleForRelative(root, change.rootId, toNative(change.relativePath), 'file')
    const fileId = current?.id || null
    if (change.status === 'untracked') {
      if (!current) fail('RESOURCE_UNAVAILABLE', 'File is missing')
      if (current.stat.size > BigInt(EGDESK_GIT_REVIEW_LIMITS.patchMaxBytes)) return { ...base, fileId, binary: false, truncated: true, tooLarge: true, patch: '', hunks: [] }
      const read = await readFile({ fileId })
      if (read.kind !== 'text') return { ...base, fileId, binary: true, truncated: false, tooLarge: false, patch: '', hunks: [] }
      return { ...base, fileId, binary: false, truncated: false, tooLarge: false, ...gitReview.newFilePatch(change.relativePath, read.text) }
    }
    try {
      const diff = await gitReview.fileDiff(root.path, { relativePath: change.relativePath, previousPath: change.previousPath })
      return { ...base, fileId, binary: diff.binary, truncated: diff.truncated, tooLarge: false, patch: diff.patch, hunks: diff.hunks }
    } catch (error) { throw gitError(error) }
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
    checkedText(text)
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
    return { draftId, baseHash: draft.sourceHash, currentHash: hash(Buffer.from(draft.text, 'utf8')), bufferRevision: draft.bufferRevision, savedRevision: draft.savedRevision, hunks: lineDiff(draft.baseText, draft.text, { now }) }
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

  // Backend-only (no HTTP route): the verified real path and identity of a
  // registered root, for the project store and the bridge working folder.
  async function describeRoot(rootId) {
    const root = await checkedRoot(rootId)
    return { rootId, absolutePath: root.path, name: path.basename(root.path), identity: { dev: String(root.identity.dev), ino: String(root.identity.ino) } }
  }

  // A path an Agent, a test runner or a file:// link printed → an opaque handle
  // inside the connected root, so the File view can open it at a line. Absolute
  // paths must lie lexically under the root's real path (nothing outside is
  // touched); relative paths may not climb with '..'. Never follows symlinks.
  async function resolvePath({ rootId, path: requested }) {
    const root = await checkedRoot(rootId)
    if (typeof requested !== 'string' || !requested || requested.length > MAX_RESOLVE_PATH || requested.includes('\0')) fail('INVALID_PATH', 'A file path of at most 4096 characters is required')
    let candidate = requested
    if (/^file:/i.test(candidate)) {
      try { candidate = fileURLToPath(candidate) } catch { fail('INVALID_PATH', 'The file link could not be read') }
    }
    let nativeRelative
    if (path.isAbsolute(candidate)) {
      const relative = path.relative(root.path, path.normalize(candidate))
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('NOT_IN_ROOT', 'This file is outside the connected folder')
      nativeRelative = relative
    } else {
      const parts = candidate.split(path.sep === '\\' ? /[\\/]/ : /\//).filter(part => part && part !== '.')
      if (!parts.length || parts.includes('..')) fail('NOT_IN_ROOT', 'This file is outside the connected folder')
      nativeRelative = path.join(...parts)
    }
    const resolved = await handleForRelative(root, rootId, nativeRelative)
    if (!resolved) fail('RESOURCE_UNAVAILABLE', 'The file is missing or cannot be opened here')
    return { id: resolved.id, kind: resolved.kind, name: path.basename(nativeRelative), relativePath: toPosix(nativeRelative) }
  }

  // Exact bytes through one O_NOFOLLOW descriptor bound to `identity`.
  async function exactRead(target, identity) {
    let file
    try { file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
    catch (error) { fail(error?.code === 'ELOOP' ? 'SYMLINK' : 'RESOURCE_UNAVAILABLE', 'The original file is missing or cannot be opened') }
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || !sameIdentity(before, identity)) fail('RESOURCE_CHANGED', 'Resource identity changed; reopen it')
      if (before.size > BigInt(MAX_READ_BYTES)) fail('FILE_TOO_LARGE', 'File exceeds the 8 MiB exact-read limit', { size: sizeNumber(before), limit: MAX_READ_BYTES })
      const bytes = await file.readFile()
      const after = await file.stat({ bigint: true })
      if (!sameIdentity(after, before) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || bytes.length !== sizeNumber(after)) fail('RESOURCE_CHANGED', 'File changed during read')
      return { bytes, stat: after, digest: hash(bytes) }
    } finally { await file.close().catch(() => {}) }
  }

  function moveIdentity(resource, from, to) {
    for (const [id, other] of resources) {
      if (other.rootId === resource.rootId && other.relativePath === resource.relativePath && sameIdentity(other.identity, from)) resources.set(id, { ...other, identity: { dev: to.dev, ino: to.ino } })
    }
  }

  async function syncDirectory(directory) {
    let handle
    try { handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0)); await handle.sync() }
    catch {} // Windows cannot open a directory; the rename is still complete.
    finally { await handle?.close().catch(() => {}) }
  }

  // The D-X1 conditional write. Returns {written, unchanged, sha256, size,
  // diskRevision}. Throws SOURCE_CHANGED (with both hashes) when the file no
  // longer hashes to expectedSha256 and does not already hold `bytes`.
  async function conditionalWrite(fileId, bytes, expectedSha256) {
    const { root, resource, target, stat } = await checkedResource(fileId, 'file')
    if (!stat.isFile()) fail('WRONG_KIND', 'Expected a regular file')
    if (stat.nlink > 1n) fail('ORIGINAL_HARD_LINKED', 'This file has other hard links; save a copy with a new name instead', { originalUpdated: false })
    if (bytes.length > MAX_READ_BYTES) fail('FILE_TOO_LARGE', 'Text exceeds the 8 MiB write limit', { size: bytes.length, limit: MAX_READ_BYTES })
    const nextDigest = hash(bytes)
    const unchanged = current => ({ written: false, unchanged: true, sha256: current.digest, size: current.bytes.length, diskRevision: revisionFor(current.stat, current.digest), originalUpdated: false })
    const current = await exactRead(target, resource.identity)
    if (current.digest !== expectedSha256) {
      if (current.bytes.equals(bytes)) return unchanged(current)
      fail('SOURCE_CHANGED', 'The original file changed after it was opened; compare before saving', { expectedSourceHash: expectedSha256, currentSourceHash: current.digest, originalUpdated: false })
    }
    if (current.bytes.equals(bytes)) return unchanged(current)
    const directory = path.dirname(target)
    const directoryStat = await fs.lstat(directory, { bigint: true }).catch(() => null)
    const directoryReal = directoryStat ? await fs.realpath(directory).catch(() => null) : null
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink() || !directoryReal || !inside(root.path, directoryReal)) fail('ROOT_ESCAPE', 'The file folder is outside its authorized root')
    const temporary = path.join(directory, `.egdesk-save-${randomUUID().replace(/-/g, '').slice(0, 16)}.tmp`)
    const mode = Number(stat.mode & 0o777n) || 0o644
    let temporaryStat = null
    let renamed = false
    try {
      const file = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), mode)
      try {
        temporaryStat = await file.stat({ bigint: true })
        await file.writeFile(bytes)
        await file.chmod(mode).catch(() => {})
        await file.sync()
      } finally { await file.close() }
      // Re-check right before replacing: same original bytes, same folder.
      const again = await exactRead(target, resource.identity)
      if (again.digest !== expectedSha256) fail('SOURCE_CHANGED', 'The original file changed while saving; compare before saving', { expectedSourceHash: expectedSha256, currentSourceHash: again.digest, originalUpdated: false })
      const directoryAgain = await fs.lstat(directory, { bigint: true })
      if (!sameIdentity(directoryAgain, directoryStat) || directoryAgain.isSymbolicLink()) fail('RESOURCE_CHANGED', 'The file folder changed while saving', { originalUpdated: false })
      await fs.rename(temporary, target)
      renamed = true
    } catch (error) {
      // Remove only the temporary file this call created (never a stranger's).
      if (!renamed && temporaryStat) {
        const leftover = await fs.lstat(temporary, { bigint: true }).catch(() => null)
        if (leftover && sameIdentity(leftover, temporaryStat)) await fs.unlink(temporary).catch(() => {})
      }
      if (error instanceof FileSurfaceError) throw error
      fail('SAVE_FAILED', 'The original file could not be saved', { originalUpdated: false })
    }
    await syncDirectory(directory)
    const after = await fs.lstat(target, { bigint: true }).catch(() => null)
    const real = after ? await fs.realpath(target).catch(() => null) : null
    if (!after || after.isSymbolicLink() || !sameIdentity(after, temporaryStat) || !real || !inside(root.path, real)) {
      fail('SAVE_UNCERTAIN', 'The save finished but the result could not be verified; check the file before saving again', { originalUpdated: null })
    }
    moveIdentity(resource, resource.identity, after)
    return { written: true, unchanged: false, sha256: nextDigest, size: bytes.length, diskRevision: revisionFor(after, nextDigest), originalUpdated: true }
  }

  // User save of the working copy into the original (D-X1). expectedSourceHash
  // is the disk hash the user saw on a comparison screen; without it the draft's
  // own baseline is expected.
  async function saveOriginal({ draftId, expectedHead, bufferRevision, operationId, expectedSourceHash }) {
    const draft = await requireDraft(draftId)
    if (typeof expectedHead !== 'string' || expectedHead !== draft.head) fail('DRAFT_CONFLICT', 'Draft head changed; refresh before saving', { currentHead: draft.head })
    if (bufferRevision !== draft.bufferRevision) fail('BUFFER_CONFLICT', 'A newer text buffer exists; it was not saved', { currentBufferRevision: draft.bufferRevision })
    if (typeof operationId !== 'string' || !operationId) fail('OPERATION_ID_REQUIRED', 'Operation ID is required')
    const expected = expectedSourceHash == null ? draft.sourceHash : checkedHash(expectedSourceHash, 'expectedSourceHash')
    if (!resources.has(draft.fileId)) fail('SOURCE_RECONNECT_REQUIRED', 'Reconnect the original file before saving to it', { originalUpdated: false })
    const written = await conditionalWrite(draft.fileId, Buffer.from(draft.text, 'utf8'), expected)
    const baseline = { baseText: draft.text, sourceHash: written.sha256, sourceRevision: written.diskRevision }
    let saved = null
    try { saved = await swapDraft(draft, expectedHead, { ...baseline, savedRevision: draft.bufferRevision, savedHash: written.sha256 }, operationId) }
    catch (error) {
      if (error?.code !== 'DRAFT_CONFLICT') throw error
      // Newer typing landed while writing: keep that text, move only the
      // source baseline so the next save compares against what is on disk.
      const latest = await requireDraft(draftId).catch(() => null)
      if (latest) saved = await swapDraft(latest, latest.head, baseline, operationId).catch(() => null)
    }
    return { draft: saved, receipt: { mode: 'original', savedRevision: draft.bufferRevision, sha256: written.sha256, size: written.size, written: written.written, unchanged: written.unchanged, originalUpdated: written.originalUpdated, draftUpdated: saved != null } }
  }

  // Change review revert (D-X1·D-X2): the screen computed `text` (the current
  // file with chosen chunks put back) against the bytes hashing to
  // expectedSha256. Text is never logged.
  async function revertReviewed({ fileId, expectedSha256, text, operationId }) {
    checkedHash(expectedSha256, 'expectedSha256')
    checkedText(text)
    if (typeof operationId !== 'string' || !operationId) fail('OPERATION_ID_REQUIRED', 'Operation ID is required')
    const written = await conditionalWrite(fileId, Buffer.from(text, 'utf8'), expectedSha256)
    return { fileId, ...written }
  }

  // Remove a file an Agent created, only while it still hashes to what the
  // Agent wrote (Zed action_log reject-created pattern, GPL — pattern only).
  // The screen offers this after an explicit confirmation.
  async function deleteCreated({ fileId, expectedSha256, operationId }) {
    checkedHash(expectedSha256, 'expectedSha256')
    if (typeof operationId !== 'string' || !operationId) fail('OPERATION_ID_REQUIRED', 'Operation ID is required')
    const { resource, target, stat } = await checkedResource(fileId, 'file')
    if (!stat.isFile()) fail('WRONG_KIND', 'Expected a regular file')
    if (stat.nlink > 1n) fail('ORIGINAL_HARD_LINKED', 'This file has other hard links and is not removed', { deleted: false })
    const current = await exactRead(target, resource.identity)
    if (current.digest !== expectedSha256) fail('SOURCE_CHANGED', 'The file changed after the Agent created it; it is kept', { expectedSourceHash: expectedSha256, currentSourceHash: current.digest, deleted: false })
    const again = await fs.lstat(target, { bigint: true }).catch(() => null)
    if (!again || again.isSymbolicLink() || !sameIdentity(again, resource.identity)) fail('RESOURCE_CHANGED', 'The file changed before removal; it is kept', { deleted: false })
    await fs.unlink(target)
    for (const [id, other] of resources) if (other.rootId === resource.rootId && other.relativePath === resource.relativePath) resources.delete(id)
    return { fileId, deleted: true, sha256: current.digest }
  }

  return { registerRoot, listDirectory, search, searchContents, readFile, createDraft, readDraft, resolveCaptureSource, updateDraft, saveDraft, diffDraft, sourceStatus, reconnectDraft, saveAs, gitStatus, gitChanges, gitFileDiff,
    saveOriginal, revertReviewed, deleteCreated, resolvePath, describeRoot }
}
