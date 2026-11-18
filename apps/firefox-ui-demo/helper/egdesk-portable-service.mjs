import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants, statSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { publicText } from './codex-chat-values.mjs'
import { PRIVATE_KEYS } from './egdesk-chat-store.mjs'
import { MAX_BOARDS, MAX_BOARD_BODY_BYTES, MAX_DESK_STATE_BYTES } from './egdesk-desk-store.mjs'
import { PortableBundleError, createEGDeskPortableBundle, loadEGDeskPortableDependencies } from './egdesk-portable-bundle.mjs'
import { EXTRA_KIND, collectPortableExtras, matchExtrasManifest, parseExtraEntry, summarizeExtras, validateExtrasManifest, writePortableAttachments, writePortableDrafts } from './egdesk-portable-extras.mjs'
import { MAX_PROFILES, PROFILE_TEMPLATES, normalizeProfileBody, profileHash, withoutAvatarImage } from './egdesk-profile-store.mjs'

// RT-03: the .egdesk portable bundle wired to the local Desk, chat and profile
// stores. Export writes one file (optionally passphrase-encrypted with the
// bundle library's Argon2id + secretstream envelope) into a helper-chosen
// folder. Inspect and import read a file from that folder or an uploaded copy;
// import always makes new copies and never overwrites what is already here.
// Imported Agent profiles arrive as drafts marked reviewRequired, never active.
//
// Bundle graph (bundle library node types are fixed):
//   root 'desk' (type board) or 'board' (type board), body = root payload
//   children 'board-N' (board), 'chat-N' (chat), 'profile-N' (artifact),
//   each with exactly one 'body' object holding a JSON payload.
export const PORTABLE_LIMITS = Object.freeze({
  // Largest .egdesk file inspect/import reads (the bundle library's encrypted ZIP ceiling).
  maxBundleBytes: 64 * 1024 * 1024,
  // Largest export content (payload bytes before the ZIP); leaves room under the ceiling.
  maxContentBytes: 48 * 1024 * 1024,
  maxChats: 200,
  maxRunsPerChat: 1000,
})
export const MIN_PASSPHRASE_CHARS = 8
const MAX_PASSPHRASE_CHARS = 1024
const MAX_CHAT_IMPORT_BYTES = 64 * 1024 * 1024
const MAX_CHAT_TITLE = 1000
const MAX_LISTED_CONVERSATIONS = 10_000
const MIN_REMAP_ID = 8
const KIND = Object.freeze({ root: 'egdesk.portable.root', board: 'egdesk.portable.board', chat: 'egdesk.portable.chat', profile: 'egdesk.portable.profile' })
// Attachments and File drafts (opt-in, D-R3) travel as 'artifact' nodes too.
const CHILD_TYPE = Object.freeze({ board: 'board', chat: 'chat', profile: 'artifact', attachment: 'artifact', fileDraft: 'artifact' })
const CHILD_LABEL = Object.freeze({ board: 'Board', chat: 'Chat', profile: 'Profile', attachment: 'Attachment', fileDraft: 'File draft' })
const EXPORT_FILE = /^(?!\.)[^\\/:*?"<>|\u0000-\u001f]{1,200}\.egdesk$/u
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MACHINE_PATH = /(?:^|[\s("'])(?:\/[^\s]|~\/|[A-Za-z]:[\\/]|file:\/\/|\\\\[^\s])/i

// Account identifiers never leave this machine; they become null.
const ACCOUNT_KEYS = new Set(['accountidentity', 'accountid', 'accountemail', 'accountkey', 'codexaccountkey', 'bindingaccountkey', 'retainednativebinding', 'ownerhash', 'ownerkey', 'ownerscope', 'engineprofileid', 'authidentitykey', 'identitykey', 'profilescopeid', 'browseridentitykey'])
// Native engine bindings and machine folders inside chat records; also null.
const NATIVE_KEYS = new Set(['conversationid', 'nativeconversationid', 'localconversationid', 'runid', 'messageid', 'cwd', 'cwdpublic'])
// Names of this machine's preference backups inside a Desk state.
const LOCAL_KEYS = new Set(['recoverybackupkey', 'localhistorybackupkey'])
const DESK_NULLS = new Set([...ACCOUNT_KEYS, ...LOCAL_KEYS])
const CHAT_NULLS = new Set([...ACCOUNT_KEYS, ...LOCAL_KEYS, ...NATIVE_KEYS])
const keyName = key => key.toLowerCase().replace(/[_-]/g, '')

function fail(code, message, httpStatus = 400, extra = {}) {
  throw Object.assign(new Error(message), { code, httpStatus }, extra)
}
const damaged = reason => fail('PORTABLE_FILE_DAMAGED', 'The file is damaged or is not an EG-Desk bundle; nothing was imported', 400, { reason })
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const define = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
const cardCount = value => Array.isArray(value?.cards) ? value.cards.length : 0
const safeTime = value => Number.isSafeInteger(value) && value >= 0 ? value : null

/**
 * Copy of JSON data with private fields dropped (PRIVATE_KEYS, counted),
 * the given identifier keys set to null (counted when they held a value) and,
 * for chat content, credential-looking text masked with publicText.
 */
function sanitizeTree(value, { nulls, maskText }, counts, depth = 0) {
  if (depth > 100) fail('PORTABLE_CONTENT_INVALID', 'Content is too deeply nested')
  if (typeof value === 'string') {
    if (!maskText) return value
    // No length cap: a mask can be longer than what it replaces.
    const masked = publicText(value, Number.MAX_SAFE_INTEGER)
    if (masked !== value) counts.maskedTexts++
    return masked
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => sanitizeTree(item, { nulls, maskText }, counts, depth + 1))
  const copy = {}
  // A portable Browser may describe an imported environment, but it cannot
  // carry this Firefox profile's authority to bind its numeric container ID.
  // Preserve the required marker even for an incomplete older record whose
  // sole identity signal is about to be redacted.
  const browserIdentityRequired = value.type === 'browser' && (
    (plain(value.runtimeState) && Object.hasOwn(value.runtimeState, 'browserIdentity')) ||
    (plain(value.sourceRef) && (value.sourceRef.browserIdentityRequired === true ||
      Object.hasOwn(value.sourceRef, 'browserIdentityKey'))))
  for (const [key, child] of Object.entries(value)) {
    const name = keyName(key)
    if (PRIVATE_KEYS.has(name)) { counts.privateFields++; continue }
    if (nulls.has(name)) {
      if (child !== null && child !== undefined) counts.identifiers++
      define(copy, key, null)
      continue
    }
    define(copy, key, sanitizeTree(child, { nulls, maskText }, counts, depth + 1))
  }
  if (browserIdentityRequired) {
    if (!plain(copy.sourceRef)) define(copy, 'sourceRef', {})
    define(copy.sourceRef, 'browserIdentityRequired', true)
  }
  return copy
}
function hasPrivateKey(value, depth = 0) {
  if (depth > 100) fail('PORTABLE_CONTENT_INVALID', 'Content is too deeply nested')
  if (Array.isArray(value)) return value.some(item => hasPrivateKey(item, depth + 1))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => PRIVATE_KEYS.has(keyName(key)) || hasPrivateKey(child, depth + 1))
}
/** Replace Board/thread IDs, leaving draft references for their separate ID map. */
function remapTree(value, map) {
  if (!map.size) return value
  const visit = part => {
    if (typeof part === 'string') return map.get(part) ?? part
    if (Array.isArray(part)) return part.map(visit)
    if (!part || typeof part !== 'object') return part
    const copy = {}
    for (const [key, child] of Object.entries(part)) {
      if (key === 'draftId' && typeof child === 'string') define(copy, key, child)
      else define(copy, map.get(key) ?? key, visit(child))
    }
    return copy
  }
  return visit(value)
}
/** A source draft ID must never resolve against the importing machine's own drafts. */
function remapDraftReferences(value, drafts) {
  if (Array.isArray(value)) return value.map(item => remapDraftReferences(item, drafts))
  if (!value || typeof value !== 'object') return value
  const copy = {}
  for (const [key, child] of Object.entries(value)) {
    define(copy, key, key === 'draftId' && typeof child === 'string'
      ? drafts.get(child) ?? null
      : remapDraftReferences(child, drafts))
  }
  return copy
}
function manifestTitle(text, fallback) {
  if (typeof text !== 'string') return fallback
  const cleaned = Array.from(text.normalize('NFC').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()).slice(0, 120).join('').trim()
  return cleaned && !MACHINE_PATH.test(cleaned) ? cleaned : fallback
}
function slugOf(text) {
  return Array.from(String(text ?? '').normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')).slice(0, 40).join('').replace(/-+$/, '')
}
export function exportFileName({ scope, title, at }) {
  const date = new Date(at)
  const pad = number => String(number).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return ['EG-Desk', scope === 'desk' ? 'Desk' : 'Board', scope === 'board' ? slugOf(title) : '', stamp].filter(Boolean).join('-') + '.egdesk'
}

/**
 * Where exports go: EGDESK_EXPORT_DIR (absolute) when set, else
 * ~/Downloads/EG-Desk when ~/Downloads exists, else <app data>/exports.
 * Reads only; the folder is created on the first export.
 */
export function portableExportLocation({ env = process.env, home = os.homedir(), appDataDir } = {}) {
  if (env.EGDESK_EXPORT_DIR) {
    if (!path.isAbsolute(env.EGDESK_EXPORT_DIR)) fail('PORTABLE_EXPORT_FOLDER_INVALID', 'EGDESK_EXPORT_DIR must be an absolute path', 500)
    return { directory: env.EGDESK_EXPORT_DIR, folder: 'custom' }
  }
  try {
    if (statSync(path.join(home, 'Downloads')).isDirectory()) return { directory: path.join(home, 'Downloads', 'EG-Desk'), folder: 'downloads' }
  } catch { /* No Downloads folder: use app data. */ }
  if (typeof appDataDir === 'string' && path.isAbsolute(appDataDir)) return { directory: path.join(appDataDir, 'exports'), folder: 'app-data' }
  fail('PORTABLE_EXPORT_FOLDER_UNAVAILABLE', 'No export folder is available', 503)
}
/** "~/Downloads/EG-Desk/x.egdesk" for a path inside home, else null (the full path is never sent). */
export function homeRelativePath(target, home = os.homedir()) {
  const relative = path.relative(home, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return `~/${relative.split(path.sep).join('/')}`
}
async function ensureExportDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await fsp.lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('PORTABLE_EXPORT_FOLDER_UNSAFE', 'The export folder is not a plain folder', 500)
}

/**
 * Atomic, create-only file sink for the bundle library. Bytes go to a private
 * (0600) hidden temp file beside the target; publish links it to the first
 * free name ("x (2).egdesk", ...) so an existing file is never replaced.
 * Staged bytes are exactly the output bytes (ciphertext when a passphrase was
 * given), so staging is as protected as the published file.
 */
async function createExportSink(directory, fileName) {
  const tempPath = path.join(directory, `.egdesk-${randomUUID()}.part`)
  const handle = await fsp.open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
  const writable = handle.createWriteStream({ flush: true })
  const closed = new Promise(resolve => writable.once('close', resolve))
  let settled = false
  return {
    atomicPublish: true, stagingProtection: 'encrypted', writable,
    async publish() {
      await closed
      const published = await publishCreateOnly(tempPath, directory, fileName)
      settled = true
      return { fileName: published }
    },
    async abort() {
      if (settled) return
      settled = true
      if (!writable.destroyed) writable.destroy()
      await closed
      await fsp.rm(tempPath, { force: true })
    },
  }
}
async function publishCreateOnly(tempPath, directory, fileName) {
  const base = fileName.slice(0, -'.egdesk'.length)
  for (let index = 1; index <= 99; index++) {
    const candidate = index === 1 ? fileName : `${base} (${index}).egdesk`
    const target = path.join(directory, candidate)
    try { await fsp.link(tempPath, target) }
    catch (error) {
      if (error.code === 'EEXIST') continue
      if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EINVAL'].includes(error.code)) throw error
      // Hard links are unavailable on this volume: exclusive copy, still never replacing a file.
      try { await fsp.copyFile(tempPath, target, constants.COPYFILE_EXCL) }
      catch (copyError) { if (copyError.code === 'EEXIST') continue; throw copyError }
    }
    await fsp.rm(tempPath, { force: true })
    return candidate
  }
  fail('PORTABLE_EXPORT_NAME_TAKEN', 'Too many exported files share this name', 409)
}
async function readExportFile(directory, name, maxBytes) {
  if (typeof name !== 'string' || !EXPORT_FILE.test(name) || name.includes('..')) fail('PORTABLE_HTTP_INPUT', 'fileRef.exportFile must be a .egdesk file name from the export folder')
  let handle
  try { handle = await fsp.open(path.join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
  catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR', 'EISDIR'].includes(error.code)) fail('PORTABLE_FILE_NOT_FOUND', 'The exported file was not found', 404)
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) fail('PORTABLE_FILE_NOT_FOUND', 'The exported file was not found', 404)
    if (info.size > maxBytes) fail('PORTABLE_FILE_TOO_LARGE', `The file exceeds ${maxBytes} bytes`, 413)
    const bytes = await handle.readFile()
    if (bytes.length > maxBytes) fail('PORTABLE_FILE_TOO_LARGE', `The file exceeds ${maxBytes} bytes`, 413)
    return bytes
  } finally { await handle.close() }
}

// ── Export: read the stores into an in-memory, pinned graph ──
/** Every string under a 'draftId' key in a Board/Desk body (File cards keep their working copy there). */
function draftIdsIn(body, found = new Set(), depth = 0) {
  if (depth > 100 || !body || typeof body !== 'object') return found
  for (const [key, child] of Object.entries(body)) {
    if (key === 'draftId' && typeof child === 'string' && child) found.add(child)
    else draftIdsIn(child, found, depth + 1)
  }
  return found
}
function chatThreadIdsIn(body) {
  const ids = new Set()
  for (const card of Array.isArray(body?.cards) ? body.cards : []) {
    const id = card?.type === 'chat' ? card.runtimeState?.activeThreadId : null
    if (typeof id === 'string' && id) ids.add(id)
  }
  return ids
}
function selectChats(chat, threadIds, limits) {
  const matches = thread => threadIds === null || threadIds.has(thread.clientThreadId)
    || [...threadIds].some(id => thread.clientThreadId.startsWith(`${id}-binding-`))
  const chosen = []
  let omitted = 0, listed = 0, cursor = null
  while (listed < MAX_LISTED_CONVERSATIONS) {
    const page = chat.listConversations({ cursor, limit: 100 })
    for (const thread of page.threads) {
      listed++
      if (!matches(thread)) continue
      if (chosen.length < limits.maxChats) chosen.push(thread)
      else omitted++
    }
    if (!page.hasMore || !page.nextCursor) break
    cursor = page.nextCursor
  }
  return { chosen, omitted }
}
function exportChat(chat, thread, limits, counts) {
  const runs = []
  let afterSeq = 0, truncated = false
  while (true) {
    const page = chat.listRuns(thread.clientThreadId, { afterSeq, limit: 500 })
    for (const run of page.runs) {
      if (runs.length >= limits.maxRunsPerChat) { truncated = true; break }
      const { firstSeq, lastSeq, clientThreadId, ...rest } = run
      runs.push(sanitizeTree(rest, { nulls: CHAT_NULLS, maskText: true }, counts))
    }
    if (truncated || !page.hasMore) break
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= afterSeq) fail('CHAT_STORE_CORRUPT', 'Local chat cursor did not advance', 500)
    afterSeq = page.nextCursor
  }
  const title = typeof thread.title === 'string' ? publicText(thread.title, MAX_CHAT_TITLE) : null
  return { kind: KIND.chat, v: 1, clientThreadId: thread.clientThreadId, title, createdAt: safeTime(thread.createdAt), updatedAt: safeTime(thread.updatedAt), truncated, runs }
}
function exportProfiles(profiles) {
  const templates = new Map(PROFILE_TEMPLATES.map(item => [item.id, profileHash(item.body)]))
  const chosen = []
  for (const summary of profiles.list().profiles) {
    const view = profiles.get(summary.id)
    const record = view?.active ?? view?.head
    if (!record) continue
    // Unchanged built-in examples exist on every install; edited ones travel.
    if (view.origin === 'template' && templates.get(view.id) === record.hash) continue
    chosen.push({ kind: KIND.profile, v: 1, lifecycle: view.lifecycle === 'active' ? 'active' : 'draft', body: withoutAvatarImage(record.body) })
  }
  return chosen
}
function exportDeskState(state, includeChats, counts) {
  const value = sanitizeTree(state, { nulls: DESK_NULLS, maskText: false }, counts)
  if (plain(value.chat)) {
    value.chat = includeChats
      ? sanitizeTree(value.chat, { nulls: CHAT_NULLS, maskText: true }, counts)
      // Conversation text stays here unless the user chose to include chats.
      : { ...value.chat, threads: [], activeThreadId: null, threadDrafts: {} }
  }
  return value
}

async function collectExport({ desk, chat, profiles, attachments, fileDrafts, scope, boardId, include, limits, now }) {
  const counts = { privateFields: 0, identifiers: 0, maskedTexts: 0 }
  const exportedAt = now()
  const model = { scope, exportedAt, include, desk: null, board: null, boards: [], chats: [], profiles: [], attachments: [], fileDrafts: [], extras: null }
  let threadIds = null, rootTitle = 'Desk', bytes = 0
  const encoded = []
  const add = (type, title, payload) => {
    const json = Buffer.from(JSON.stringify(payload))
    bytes += json.length
    if (bytes > limits.maxContentBytes) fail('PORTABLE_EXPORT_TOO_LARGE', `The export exceeds ${limits.maxContentBytes} bytes; nothing was written`, 413)
    encoded.push({ type, title, json })
  }
  if (scope === 'board') {
    const found = desk.board(boardId)
    if (!found) fail('BOARD_NOT_FOUND', 'Board does not exist', 404)
    model.board = { boardId: found.boardId, title: found.title, body: sanitizeTree(found.head.body, { nulls: DESK_NULLS, maskText: false }, counts) }
    threadIds = chatThreadIdsIn(found.head.body)
    rootTitle = found.title
  } else {
    const current = desk.current()
    const boards = desk.listBoards().boards
    if (current.state === null && !boards.length) fail('PORTABLE_NOTHING_TO_EXPORT', 'There is no Desk or saved Board to export', 409)
    model.desk = current.state === null ? null : exportDeskState(current.state, include.chats, counts)
  }
  // Opt-in extras (D-R3: off unless asked). Read before the root so its
  // manifest can list what was included and what was left out.
  const boardIds = scope === 'board' ? new Set([boardId]) : new Set(desk.listBoards().boards.map(item => item.boardId))
  const extras = (include.attachments || include.fileDrafts)
    ? await collectPortableExtras({ attachments, fileDrafts, include, scope, boardIds,
      threadIds: scope === 'board' ? threadIds : null, draftIds: scope === 'board' ? draftIdsIn(model.board.body) : null })
    : { entries: [], manifest: { attachments: null, fileDrafts: null } }
  model.extras = extras.manifest
  // The root goes first in the size budget; children follow.
  const rootPayload = scope === 'board'
    ? { kind: KIND.root, v: 1, scope, exportedAt, include, extras: extras.manifest, board: model.board }
    : { kind: KIND.root, v: 1, scope, exportedAt, include, extras: extras.manifest, desk: { state: model.desk } }
  add('root', rootTitle, rootPayload)
  if (scope === 'desk') {
    for (const summary of desk.listBoards().boards) {
      const found = desk.board(summary.boardId)
      if (!found) continue
      const payload = { kind: KIND.board, v: 1, boardId: found.boardId, title: found.title, body: sanitizeTree(found.head.body, { nulls: DESK_NULLS, maskText: false }, counts) }
      model.boards.push(payload)
      add('board', found.title, payload)
    }
  }
  let chatsOmitted = 0
  if (include.chats) {
    if (!chat) fail('PORTABLE_CHAT_STORE_UNAVAILABLE', 'Local chat storage is unavailable', 503)
    const { chosen, omitted } = selectChats(chat, threadIds, limits)
    chatsOmitted = omitted
    for (const thread of chosen) {
      const payload = exportChat(chat, thread, limits, counts)
      model.chats.push(payload)
      add('chat', payload.title, payload)
    }
  }
  if (include.profiles) {
    if (!profiles) fail('PORTABLE_PROFILE_STORE_UNAVAILABLE', 'Local profile storage is unavailable', 503)
    for (const payload of exportProfiles(profiles)) {
      model.profiles.push(payload)
      add('profile', payload.body.name, payload)
    }
  }
  for (const entry of extras.entries) {
    model[entry.type === 'attachment' ? 'attachments' : 'fileDrafts'].push(entry.payload)
    add(entry.type, entry.title, entry.payload)
  }
  return { model, encoded, counts, chatsOmitted, rootId: scope }
}
function exportGraph({ encoded, rootId }) {
  const objects = new Map()
  const nodes = new Map()
  const index = { board: 0, chat: 0, profile: 0, attachment: 0, fileDraft: 0 }
  const children = []
  let root = null
  for (const item of encoded) {
    const hash = createObjectHash(item.json)
    objects.set(hash, item.json)
    if (item.type === 'root') {
      root = { id: rootId, type: 'board', scopeRootId: rootId, title: manifestTitle(item.title, rootId === 'desk' ? 'Desk' : 'Board'), refs: [], objects: [{ sha256: hash, role: 'body' }] }
      continue
    }
    const id = `${item.type}-${++index[item.type]}`
    const fallback = `${CHILD_LABEL[item.type]} ${index[item.type]}`
    nodes.set(id, { id, type: CHILD_TYPE[item.type], scopeRootId: rootId, title: manifestTitle(item.title, fallback), refs: [], objects: [{ sha256: hash, role: 'body' }] })
    children.push(id)
  }
  root.refs = children
  nodes.set(rootId, root)
  return { nodes, objects }
}
const createObjectHash = bytes => createHash('sha256').update(bytes).digest('hex')

function memoryObjectProvider({ nodes, objects }, rootId, exportedAt) {
  return {
    async openExportSnapshot() {
      return {
        getNode: async id => nodes.get(id) ?? null,
        listEvents: async () => [{ id: 'exported', ownerId: rootId, kind: 'state', at: exportedAt }],
        getObjectMeta: async hash => objects.has(hash) ? { size: objects.get(hash).length, portableApproved: true, scopeRootId: rootId } : null,
        openObject: async hash => Readable.from([objects.get(hash)]),
        close: async () => {},
      }
    },
  }
}
const exportOnlyStore = {
  beginStage: async () => fail('PORTABLE_ERROR', 'Import staging is not available during export', 500),
  reopenRepresentative: async () => false,
}
const importOnlyProvider = { openExportSnapshot: async () => fail('PORTABLE_ERROR', 'Export is not available during import', 500) }

// ── Import: staged in memory, parsed, validated, then written ──
const ENVELOPE_DAMAGE = new Set(['ENVELOPE_MAGIC', 'ENVELOPE_HEADER', 'ENVELOPE_POLICY', 'ENVELOPE_SIZE', 'ENVELOPE_TAG', 'ENVELOPE_TRAILING', 'TRUNCATED_ENVELOPE'])
/** Decrypt errors become PASSWORD_REQUIRED, DECRYPT_FAILED (wrong passphrase or altered bytes) or stay as envelope damage. */
function classifyingEnvelope(envelope) {
  return {
    ...envelope,
    decrypt(source, password, options) {
      const inner = envelope.decrypt(source, password, options)
      return Readable.from((async function* () {
        try { for await (const part of inner) yield part }
        catch (error) {
          if (error instanceof PortableBundleError && (ENVELOPE_DAMAGE.has(error.code) || ['MEMORY_BUDGET', 'CANCELLED', 'PASSWORD_REQUIRED'].includes(error.code))) throw error
          throw new PortableBundleError('DECRYPT_FAILED', 'The passphrase is wrong or the file was changed')
        }
      })())
    },
  }
}
function memoryStage(maxBytes) {
  const objects = new Map()
  let total = 0
  const stage = {
    encryptedStaging: true, // Staged bytes stay in this process's memory; nothing reaches disk before commit.
    objects,
    manifest: null,
    onCommit: null,
    async putObject({ sha256, stream }) {
      const parts = []
      let size = 0
      for await (const part of stream) {
        const bytes = Buffer.from(part)
        size += bytes.length
        total += bytes.length
        if (total > maxBytes) throw new PortableBundleError('MEMORY_BUDGET', 'Bundle content exceeds the import limit')
        parts.push(bytes)
      }
      objects.set(sha256, Buffer.concat(parts, size))
    },
    async commitCopy(payload) {
      if (typeof stage.onCommit !== 'function') fail('PORTABLE_ERROR', 'Import was not prepared', 500)
      return stage.onCommit(payload)
    },
    async abort() { objects.clear() },
  }
  return stage
}
function mapReadError(error) {
  if (typeof error?.httpStatus === 'number') return error
  const code = error?.code
  if (code === 'DECRYPT_FAILED') return Object.assign(new Error('The passphrase is wrong or the file was changed; nothing was imported'), { code: 'PORTABLE_PASSPHRASE_INVALID', httpStatus: 400, encrypted: true })
  if (code === 'PASSWORD_REQUIRED') return Object.assign(new Error('This file is locked with a passphrase'), { code: 'PORTABLE_PASSPHRASE_REQUIRED', httpStatus: 400, encrypted: true })
  if (code === 'UNSUPPORTED_VERSION') return Object.assign(new Error('This file was made by a newer EG-Desk'), { code: 'PORTABLE_VERSION_UNSUPPORTED', httpStatus: 400 })
  if (code === 'MEMORY_BUDGET' || code === 'ARCHIVE_BUDGET') return Object.assign(new Error('The file content exceeds the import limit; nothing was imported'), { code: 'PORTABLE_FILE_TOO_LARGE', httpStatus: 413 })
  if (code === 'CRYPTO_UNAVAILABLE' || code === 'CODEC_UNAVAILABLE') return Object.assign(new Error('Portable bundle support is unavailable'), { code: 'PORTABLE_UNAVAILABLE', httpStatus: 503 })
  const reason = error instanceof PortableBundleError && typeof code === 'string' ? code : 'UNREADABLE_ARCHIVE'
  return Object.assign(new Error('The file is damaged or is not an EG-Desk bundle; nothing was imported'), { code: 'PORTABLE_FILE_DAMAGED', httpStatus: 400, reason })
}
function mapExportError(error) {
  if (typeof error?.httpStatus === 'number') return error
  if (error?.code === 'MEMORY_BUDGET' || error?.code === 'ARCHIVE_BUDGET') return Object.assign(new Error('The export exceeds the bundle size limit; nothing was written'), { code: 'PORTABLE_EXPORT_TOO_LARGE', httpStatus: 413 })
  if (error?.code === 'CRYPTO_UNAVAILABLE' || error?.code === 'CODEC_UNAVAILABLE') return Object.assign(new Error('Portable bundle support is unavailable'), { code: 'PORTABLE_UNAVAILABLE', httpStatus: 503 })
  return Object.assign(new Error('The export could not be written; nothing was kept'), { code: 'PORTABLE_EXPORT_FAILED', httpStatus: 500, reason: typeof error?.code === 'string' ? error.code : null })
}

function exactFields(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function readPayload(node, objects) {
  if (!Array.isArray(node.objects) || node.objects.length !== 1 || node.objects[0].role !== 'body') damaged('UNSUPPORTED_CONTENT')
  const bytes = objects.get(node.objects[0].sha256)
  if (!bytes) damaged('MISSING_OBJECT')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { damaged('INVALID_CONTENT') }
  if (!plain(value) || value.v !== 1) damaged('UNSUPPORTED_CONTENT')
  return value
}
const isTitle = value => value === null || typeof value === 'string'
/** The validated content model of a staged bundle, or PORTABLE_FILE_DAMAGED. */
function parseBundleContent(manifest, objects) {
  if (!Array.isArray(manifest?.roots) || manifest.roots.length !== 1) damaged('UNSUPPORTED_CONTENT')
  const byId = new Map(manifest.nodes.map(node => [node.id, node]))
  const root = byId.get(manifest.roots[0])
  if (!root || root.type !== 'board') damaged('UNSUPPORTED_CONTENT')
  const top = readPayload(root, objects)
  if (top.kind !== KIND.root || !['desk', 'board'].includes(top.scope)) damaged('UNSUPPORTED_CONTENT')
  // Files from before the opt-in extras have no 'extras' and a two-key include.
  const legacy = !Object.hasOwn(top, 'extras')
  const includeKeys = legacy ? ['chats', 'profiles'] : ['chats', 'profiles', 'attachments', 'fileDrafts']
  if (!exactFields(top, ['kind', 'v', 'scope', 'exportedAt', 'include', ...(legacy ? [] : ['extras']), top.scope]) || safeTime(top.exportedAt) === null
      || !exactFields(top.include, includeKeys) || includeKeys.some(key => typeof top.include[key] !== 'boolean')) damaged('INVALID_CONTENT')
  const include = { attachments: false, fileDrafts: false, ...top.include }
  const extras = legacy ? { attachments: null, fileDrafts: null } : top.extras
  validateExtrasManifest(extras, include, damaged)
  const model = { scope: top.scope, exportedAt: top.exportedAt, include, desk: null, board: null, boards: [], chats: [], profiles: [], attachments: [], fileDrafts: [], extras }
  const boardPayload = value => {
    if (!exactFields(value, ['boardId', 'title', 'body']) && !exactFields(value, ['kind', 'v', 'boardId', 'title', 'body'])) damaged('INVALID_CONTENT')
    if (typeof value.boardId !== 'string' || !isTitle(value.title) || !plain(value.body)) damaged('INVALID_CONTENT')
    return { boardId: value.boardId, title: value.title, body: value.body }
  }
  if (top.scope === 'board') model.board = boardPayload(top.board)
  else {
    if (!exactFields(top.desk, ['state']) || (top.desk.state !== null && !plain(top.desk.state))) damaged('INVALID_CONTENT')
    model.desk = top.desk.state
  }
  if (manifest.nodes.length !== root.refs.length + 1) damaged('UNSUPPORTED_CONTENT')
  for (const id of root.refs) {
    const node = byId.get(id)
    if (!node || node.id === root.id || node.refs.length) damaged('UNSUPPORTED_CONTENT')
    const value = readPayload(node, objects)
    if (node.type === 'board' && value.kind === KIND.board && top.scope === 'desk') model.boards.push(boardPayload(value))
    else if (node.type === 'chat' && value.kind === KIND.chat) {
      if (!exactFields(value, ['kind', 'v', 'clientThreadId', 'title', 'createdAt', 'updatedAt', 'truncated', 'runs'])
          || typeof value.clientThreadId !== 'string' || !value.clientThreadId.trim() || value.clientThreadId.length > 512 || value.clientThreadId.includes('\0')
          || !isTitle(value.title) || typeof value.truncated !== 'boolean' || !Array.isArray(value.runs) || !value.runs.every(plain)
          || ![value.createdAt, value.updatedAt].every(time => time === null || safeTime(time) !== null)) damaged('INVALID_CONTENT')
      model.chats.push(value)
    } else if (node.type === 'artifact' && value.kind === KIND.profile) {
      if (!exactFields(value, ['kind', 'v', 'lifecycle', 'body']) || !['active', 'draft'].includes(value.lifecycle) || !plain(value.body)) damaged('INVALID_CONTENT')
      model.profiles.push(value)
    } else if (node.type === 'artifact' && (value.kind === EXTRA_KIND.attachment || value.kind === EXTRA_KIND.fileDraft)) {
      const entry = parseExtraEntry(value, damaged)
      if (!include[entry.type === 'attachment' ? 'attachments' : 'fileDrafts']) damaged('MANIFEST_MISMATCH')
      model[entry.type === 'attachment' ? 'attachments' : 'fileDrafts'].push(entry)
    } else damaged('UNSUPPORTED_CONTENT')
  }
  matchExtrasManifest(extras, model.attachments, model.fileDrafts, damaged)
  if (hasPrivateKey(model.desk) || hasPrivateKey(model.board?.body) || model.boards.some(item => hasPrivateKey(item.body)) || model.chats.some(item => hasPrivateKey(item.runs))) {
    fail('PORTABLE_PRIVATE_FIELD', 'The file contains a private field (password, token, key); nothing was imported')
  }
  return model
}
export function summarizeContent(model) {
  const boards = model.scope === 'board' ? [model.board] : model.boards
  const deskCards = cardCount(model.desk)
  const boardCards = boards.reduce((sum, item) => sum + cardCount(item.body), 0)
  return {
    scope: model.scope, exportedAt: model.exportedAt,
    title: model.scope === 'board' ? model.board.title : null,
    desk: model.scope === 'desk' && model.desk !== null,
    boards: boards.length, cards: deskCards + boardCards, deskCards,
    chats: model.chats.length, profiles: model.profiles.length,
    ...summarizeExtras(model),
  }
}

function freshBoardId(taken) {
  for (;;) {
    const id = `agenda-import-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    if (!taken.has(id)) return id
  }
}
function freshThreadId(isTaken) {
  for (;;) {
    const id = `thread-import-${randomBytes(6).toString('hex')}`
    if (!isTaken(id)) return id
  }
}
function jsonBytes(value, max, code, name) {
  const size = Buffer.byteLength(JSON.stringify(value))
  if (size > max) fail(code, `${name} exceeds ${max} bytes; nothing was imported`, 413)
}
/** Choose IDs, rewrite references and validate everything. Writes nothing. */
function planImport(model, { desk, chat, profiles, attachments, fileDrafts }) {
  if (!desk) fail('PORTABLE_STORE_UNAVAILABLE', 'Local Desk storage is unavailable', 503)
  if (model.attachments.length && typeof attachments?.importCopy !== 'function') fail('PORTABLE_ATTACHMENT_STORE_UNAVAILABLE', 'Attachment storage is unavailable; nothing was imported', 503)
  if (model.fileDrafts.length && typeof fileDrafts?.importDraft !== 'function') fail('PORTABLE_DRAFT_STORE_UNAVAILABLE', 'File draft storage is unavailable; nothing was imported', 503)
  if (model.chats.length && !chat) fail('PORTABLE_CHAT_STORE_UNAVAILABLE', 'Local chat storage is unavailable', 503)
  if (model.profiles.length && !profiles) fail('PORTABLE_PROFILE_STORE_UNAVAILABLE', 'Local profile storage is unavailable', 503)
  const counts = { privateFields: 0, identifiers: 0, maskedTexts: 0 }
  const usedBoards = desk.boardIds()
  const sourceBoards = model.scope === 'board' ? [model.board] : model.boards
  if (usedBoards.size + sourceBoards.length > MAX_BOARDS) fail('PORTABLE_LIMIT', `At most ${MAX_BOARDS} Boards can be kept; nothing was imported`, 409)
  const idMap = new Map()
  const takenBoards = new Set(usedBoards)
  const boards = sourceBoards.map(item => {
    let boardId = BOARD_ID.test(item.boardId) && !takenBoards.has(item.boardId) ? item.boardId : freshBoardId(takenBoards)
    takenBoards.add(boardId)
    if (boardId !== item.boardId && item.boardId.length >= MIN_REMAP_ID) idMap.set(item.boardId, boardId)
    return { sourceBoardId: item.boardId, boardId, title: item.title, body: item.body }
  })
  const takenThreads = new Set()
  const threadTaken = id => takenThreads.has(id) || chat.getConversation(id) !== null
  const chats = model.chats.map(item => {
    const clientThreadId = threadTaken(item.clientThreadId) ? freshThreadId(threadTaken) : item.clientThreadId
    takenThreads.add(clientThreadId)
    if (clientThreadId !== item.clientThreadId && item.clientThreadId.length >= MIN_REMAP_ID) idMap.set(item.clientThreadId, clientThreadId)
    return { source: item, clientThreadId }
  })
  const deskRules = { nulls: DESK_NULLS, maskText: false }
  const state = model.desk === null ? null : (() => {
    const value = remapTree(sanitizeTree(model.desk, deskRules, counts), idMap)
    if (plain(value.chat)) value.chat = sanitizeTree(value.chat, { nulls: CHAT_NULLS, maskText: true }, counts)
    jsonBytes(value, MAX_DESK_STATE_BYTES, 'PORTABLE_FILE_TOO_LARGE', 'The Desk state')
    return value
  })()
  for (const item of boards) {
    const body = remapTree(sanitizeTree(item.body, deskRules, counts), idMap)
    if (plain(body.agenda)) body.agenda = { ...body.agenda, id: item.boardId }
    jsonBytes(body, MAX_BOARD_BODY_BYTES, 'PORTABLE_FILE_TOO_LARGE', 'A Board')
    item.body = body
  }
  const chatPlans = chats.map(({ source, clientThreadId }) => {
    const runs = source.runs.map(run => {
      const clean = sanitizeTree(run, { nulls: CHAT_NULLS, maskText: true }, counts)
      delete clean.clientThreadId
      delete clean.firstSeq
      delete clean.lastSeq
      if (!Array.isArray(clean.messages) || !clean.messages.every(message => plain(message) && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string')) {
        damaged('INVALID_CHAT_CONTENT')
      }
      return clean
    })
    const snapshot = { protocolVersion: 2, conversationId: null, truncated: source.truncated, historyComplete: true, runs }
    jsonBytes(snapshot, MAX_CHAT_IMPORT_BYTES, 'PORTABLE_FILE_TOO_LARGE', 'A conversation')
    const title = typeof source.title === 'string' ? publicText(source.title, MAX_CHAT_TITLE) : null
    return { sourceThreadId: source.clientThreadId, clientThreadId, title, createdAt: source.createdAt, snapshot }
  })
  let profilePlans = []
  if (model.profiles.length) {
    const existing = new Set()
    const listed = profiles.list({ includeArchived: true }).profiles
    for (const summary of listed) {
      const view = profiles.get(summary.id)
      for (const record of [view?.active, view?.head]) if (record?.hash) existing.add(record.hash)
    }
    const seen = new Set()
    profilePlans = model.profiles.map(item => {
      let body
      try { body = normalizeProfileBody(item.body) } catch { damaged('INVALID_PROFILE_CONTENT') }
      const hash = profileHash(body)
      const duplicate = existing.has(hash) || seen.has(hash)
      seen.add(hash)
      return { body, lifecycle: item.lifecycle, duplicate }
    })
    const added = profilePlans.filter(item => !item.duplicate).length
    if (listed.filter(item => item.lifecycle !== 'deleted').length + added > MAX_PROFILES) fail('PORTABLE_LIMIT', `At most ${MAX_PROFILES} profiles can be kept; nothing was imported`, 409)
  }
  return { scope: model.scope, state, boards, chats: chatPlans, profiles: profilePlans, attachments: model.attachments, fileDrafts: model.fileDrafts, counts }
}
/** Drafts → Desk (one transaction) → conversations → profiles → attachments. A later failure reports what was written. */
async function writeImport(plan, { desk, chat, profiles, attachments, fileDrafts }) {
  const written = { desk: null, boards: [], chats: [], profiles: [], attachments: [], fileDrafts: [] }
  const partial = error => {
    if (!written.desk && !written.boards.length && !written.chats.length && !written.profiles.length && !written.attachments.length && !written.fileDrafts.length) return error
    return Object.assign(new Error('The import stopped part way; the items listed in written were added'), { code: 'PORTABLE_IMPORT_PARTIAL', httpStatus: 500, written, reason: typeof error?.code === 'string' ? error.code : null })
  }
  try {
    // Drafts first: File cards in the imported Desk/Boards then point at the new draft IDs.
    const draftMap = await writePortableDrafts(plan, { fileDrafts }, written)
    const state = remapDraftReferences(plan.state, draftMap)
    const result = desk.importPortable({ state, boards: plan.boards.map(({ boardId, title, body }) => ({ boardId, title, body: remapDraftReferences(body, draftMap) })) })
    written.desk = result.desk ? { generation: result.desk.generation, unchanged: result.desk.unchanged } : null
    written.boards = result.boards.map((saved, index) => ({ boardId: saved.boardId, title: saved.title, sourceBoardId: plan.boards[index].sourceBoardId, idChanged: saved.boardId !== plan.boards[index].sourceBoardId }))
    for (const item of plan.chats) {
      chat.importConversationCopy({ clientThreadId: item.clientThreadId, title: item.title, createdAt: item.createdAt ?? Date.now(), importId: `portable-${randomUUID()}`, snapshot: item.snapshot })
      written.chats.push({ clientThreadId: item.clientThreadId, title: item.title, sourceThreadId: item.sourceThreadId, idChanged: item.clientThreadId !== item.sourceThreadId, runs: item.snapshot.runs.length })
    }
    for (const item of plan.profiles) {
      if (item.duplicate) { written.profiles.push({ profileId: null, name: item.body.name, status: 'duplicate', active: false, reviewRequired: false }); continue }
      // An Agent from a file is never turned on here, even if it was in use where
      // it was exported: it waits as a draft until the user reads its
      // instructions and activates it (reviewRequired on the profile).
      const created = profiles.importDraft(item.body, { format: 'egdesk' })
      written.profiles.push({ profileId: created.id, name: item.body.name, status: 'imported', active: false, reviewRequired: true })
    }
    await writePortableAttachments(plan, { attachments }, written)
  } catch (error) { throw partial(error) }
  return written
}
function verifyWritten(written, { desk, chat }) {
  if (!written) return false
  if (written.boards.some(item => !desk.board(item.boardId))) return false
  if (written.desk && desk.current().generation < written.desk.generation) return false
  if (written.chats.some(item => !chat?.getConversation(item.clientThreadId))) return false
  return true
}

/**
 * createPortableService({desk, chat, profiles, location, dependencies?, limits?, now?, home?})
 * desk/chat/profiles: store or () => store (null = unavailable).
 * location: () => {directory, folder} (default portableExportLocation()).
 */
export function createPortableService({ desk, chat, profiles, attachments = null, fileDrafts = null, location = () => portableExportLocation(), dependencies, limits: limitOverrides = {}, now = Date.now, home = os.homedir() } = {}) {
  const limits = Object.freeze({ ...PORTABLE_LIMITS, ...limitOverrides })
  const resolve = value => typeof value === 'function' ? value() : value ?? null
  let loading = null
  const loadDependencies = () => {
    if (dependencies) return Promise.resolve(dependencies)
    loading ??= loadEGDeskPortableDependencies().catch(() => {
      loading = null
      fail('PORTABLE_UNAVAILABLE', 'Portable bundle support is unavailable', 503)
    })
    return loading
  }
  let busy = false
  const exclusive = async action => {
    if (busy) fail('PORTABLE_BUSY', 'Another export or import is running', 409)
    busy = true
    try { return await action() } finally { busy = false }
  }
  const stores = () => ({ desk: resolve(desk), chat: resolve(chat), profiles: resolve(profiles), attachments: resolve(attachments), fileDrafts: resolve(fileDrafts) })

  async function sourceBytes({ fileRef, bundle }) {
    if (fileRef !== undefined) return readExportFile(location().directory, fileRef.exportFile, limits.maxBundleBytes)
    if (bundle.length > Math.ceil(limits.maxBundleBytes / 3) * 4 || bundle.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(bundle)) {
      if (bundle.length > Math.ceil(limits.maxBundleBytes / 3) * 4) fail('PORTABLE_FILE_TOO_LARGE', `The file exceeds ${limits.maxBundleBytes} bytes`, 413)
      fail('PORTABLE_HTTP_INPUT', 'bundle must be base64 file bytes')
    }
    const bytes = Buffer.from(bundle, 'base64')
    if (!bytes.length) fail('PORTABLE_HTTP_INPUT', 'bundle is empty')
    if (bytes.length > limits.maxBundleBytes) fail('PORTABLE_FILE_TOO_LARGE', `The file exceeds ${limits.maxBundleBytes} bytes`, 413)
    return bytes
  }

  async function openBundle(input, { apply }) {
    const source = await sourceBytes(input)
    const deps = await loadDependencies()
    const encrypted = deps.envelope.isEncryptedPrefix(source)
    const passphrase = typeof input.passphrase === 'string' && input.passphrase ? input.passphrase : null
    if (encrypted && !passphrase) {
      if (!apply) return { encrypted: true, locked: true, bytes: source.length }
      fail('PORTABLE_PASSPHRASE_REQUIRED', 'This file is locked with a passphrase', 400, { encrypted: true })
    }
    let stage = null
    let written = null
    const context = stores()
    const service = createEGDeskPortableBundle({
      objectProvider: importOnlyProvider,
      importStore: {
        beginStage: async ({ manifest }) => { stage = memoryStage(limits.maxBundleBytes); stage.manifest = manifest; return stage },
        reopenRepresentative: async () => verifyWritten(written, context),
      },
      codec: deps.codec, envelope: classifyingEnvelope(deps.envelope),
    })
    let preview
    try { preview = await service.inspectImport({ source, ...(encrypted ? { password: passphrase } : {}) }) }
    catch (error) { throw mapReadError(error) }
    let model, plan
    try {
      model = parseBundleContent(stage.manifest, stage.objects)
      if (apply) plan = planImport(model, context)
    } catch (error) { await service.cancelImport({ importId: preview.importId }).catch(() => {}); throw error }
    const summary = summarizeContent(model)
    if (!apply) {
      await service.cancelImport({ importId: preview.importId })
      return { encrypted, locked: false, bytes: source.length, formatVersion: `${stage.manifest.version.major}.${stage.manifest.version.minor}`, ...summary }
    }
    stage.onCommit = async () => (written = await writeImport(plan, context))
    const applied = await service.applyNewCopy({ importId: preview.importId })
    return { mode: 'asNew', encrypted, verified: applied.status === 'imported-and-reopened', contents: summary, ...applied.receipt, redacted: plan.counts }
  }

  return {
    limits,
    async exportBundle({ scope, boardId, include = {}, passphrase } = {}) {
      // D-R3: attachments and File drafts stay out unless explicitly true.
      const chosen = { chats: include.chats === true, profiles: include.profiles === true, attachments: include.attachments === true, fileDrafts: include.fileDrafts === true }
      const secret = typeof passphrase === 'string' && passphrase.length ? passphrase : null
      if (secret !== null && (Array.from(secret).length < MIN_PASSPHRASE_CHARS || secret.length > MAX_PASSPHRASE_CHARS)) {
        fail('PORTABLE_PASSPHRASE_TOO_SHORT', `A passphrase needs ${MIN_PASSPHRASE_CHARS}–${MAX_PASSPHRASE_CHARS} characters`)
      }
      return exclusive(async () => {
        const context = stores()
        if (!context.desk) fail('PORTABLE_STORE_UNAVAILABLE', 'Local Desk storage is unavailable', 503)
        const collected = await collectExport({ ...context, scope, boardId, include: chosen, limits, now })
        const graph = exportGraph(collected)
        const deps = await loadDependencies()
        const where = location()
        await ensureExportDirectory(where.directory)
        const service = createEGDeskPortableBundle({ objectProvider: memoryObjectProvider(graph, collected.rootId, collected.model.exportedAt), importStore: exportOnlyStore, codec: deps.codec, envelope: deps.envelope })
        let receipt, sink = null
        try {
          const plan = await service.planExport({ rootIds: [collected.rootId] })
          sink = await createExportSink(where.directory, exportFileName({ scope, title: collected.model.board?.title, at: collected.model.exportedAt }))
          receipt = await service.exportPlan({ planId: plan.planId, sink, ...(secret !== null ? { password: secret } : {}) })
        } catch (error) {
          await sink?.abort().catch(() => {})
          throw mapExportError(error)
        }
        return {
          fileName: receipt.fileName, bytes: receipt.size, encrypted: receipt.encrypted,
          contents: { ...summarizeContent(collected.model), chatsOmitted: collected.chatsOmitted },
          omitted: { attachments: collected.model.extras.attachments?.omitted ?? [], fileDrafts: collected.model.extras.fileDrafts?.omitted ?? [] },
          folder: where.folder, displayPath: homeRelativePath(path.join(where.directory, receipt.fileName), home),
          fileRef: { exportFile: receipt.fileName }, redacted: collected.counts,
        }
      })
    },
    inspectBundle(input) { return exclusive(() => openBundle(input, { apply: false })) },
    importBundle(input) { return exclusive(() => openBundle(input, { apply: true })) },
    async listExports() {
      const where = location()
      let entries = []
      try { entries = await fsp.readdir(where.directory, { withFileTypes: true }) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      const files = []
      for (const entry of entries) {
        if (!entry.isFile() || !EXPORT_FILE.test(entry.name)) continue
        const info = await fsp.lstat(path.join(where.directory, entry.name)).catch(() => null)
        if (!info?.isFile()) continue
        files.push({ fileName: entry.name, bytes: info.size, modifiedAt: Math.floor(info.mtimeMs), fileRef: { exportFile: entry.name } })
      }
      files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.fileName.localeCompare(b.fileName))
      return { folder: where.folder, displayPath: homeRelativePath(where.directory, home), files: files.slice(0, 100) }
    },
  }
}
