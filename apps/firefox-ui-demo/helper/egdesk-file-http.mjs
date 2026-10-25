import { createEGDeskFileService, FileSurfaceError } from './egdesk-file-service.mjs'
import { openEGDeskManagedDraftStore } from './egdesk-managed-drafts.mjs'
import { openEGDeskProjectStore, projectReconnectState, suggestProjectScripts, PROJECT_LIMITS } from './egdesk-project-store.mjs'
import { guardBridgeRequest, sendJson } from './codex-bridge-http.mjs'
import { randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

// git/* and search/contents are read-only. They take the opaque rootId or a
// changeId from gitChanges; the helper resolves the verified root path itself.
// 2-X (D-X1·X2·X3·X6): drafts/save-original and review/* are the only routes
// that write an original file; projects/* attach a Board folder through a
// picker selection only; resolve maps a printed path to a handle in a root.
export const EGDESK_FILE_ENDPOINTS = Object.freeze({
  openPickerChannel: '/v1/files/picker/channel',
  beginPicker: '/v1/files/picker/begin',
  completePicker: '/v1/files/picker/complete',
  registerRoot: '/v1/files/roots',
  listDirectory: '/v1/files/list',
  search: '/v1/files/search',
  searchContents: '/v1/files/search/contents',
  readFile: '/v1/files/read',
  createDraft: '/v1/files/drafts/create',
  readDraft: '/v1/files/drafts/read',
  updateDraft: '/v1/files/drafts/update',
  saveDraft: '/v1/files/drafts/save',
  diffDraft: '/v1/files/drafts/diff',
  sourceStatus: '/v1/files/drafts/source-status',
  reconnectDraft: '/v1/files/drafts/reconnect',
  saveAs: '/v1/files/save-as',
  gitStatus: '/v1/files/git/status',
  gitChanges: '/v1/files/git/changes',
  gitFileDiff: '/v1/files/git/diff',
  resolvePath: '/v1/files/resolve',
  saveOriginal: '/v1/files/drafts/save-original',
  revertReviewed: '/v1/files/review/revert',
  deleteCreated: '/v1/files/review/delete-created',
  attachProject: '/v1/files/projects/attach',
  openProject: '/v1/files/projects/open',
  inheritRoomProject: '/v1/files/projects/inherit',
  readRoomProjectDefault: '/v1/files/projects/room-default',
  saveRoomProjectDefault: '/v1/files/projects/room-default/save',
  detachProject: '/v1/files/projects/detach',
  setProjectScripts: '/v1/files/projects/scripts',
  suggestProjectScripts: '/v1/files/projects/script-suggestions',
})
const OPERATIONS = new Map(Object.entries(EGDESK_FILE_ENDPOINTS).map(([name, route]) => [route, name]))
const FIELDS = Object.freeze({
  openPickerChannel: [], beginPicker: ['purpose'], completePicker: ['requestId', 'absolutePath', 'cancelled'],
  registerRoot: ['selectionId'], listDirectory: ['directoryId', 'limit', 'cursor'],
  search: ['rootId', 'query', 'limit', 'maxVisits', 'maxDepth', 'includeIgnored'], readFile: ['fileId'],
  searchContents: ['rootId', 'query', 'limit', 'caseSensitive'],
  gitStatus: ['rootId'], gitChanges: ['rootId', 'scope'], gitFileDiff: ['changeId'],
  createDraft: ['fileId'], readDraft: ['draftId'],
  updateDraft: ['draftId', 'expectedHead', 'text', 'operationId'],
  saveDraft: ['draftId', 'expectedHead', 'bufferRevision', 'operationId'],
  diffDraft: ['draftId'], sourceStatus: ['draftId'],
  reconnectDraft: ['draftId', 'expectedHead', 'fileId', 'operationId'],
  saveAs: ['draftId', 'expectedHead', 'directoryId', 'fileName', 'operationId'],
  resolvePath: ['rootId', 'path'],
  saveOriginal: ['draftId', 'expectedHead', 'bufferRevision', 'operationId', 'expectedSourceHash'],
  revertReviewed: ['fileId', 'expectedSha256', 'text', 'operationId'],
  deleteCreated: ['fileId', 'expectedSha256', 'operationId'],
  attachProject: ['boardId', 'roomId', 'selectionId', 'title'],
  openProject: ['boardId', 'roomId'],
  inheritRoomProject: ['roomId'],
  readRoomProjectDefault: ['roomId'],
  saveRoomProjectDefault: ['roomId', 'boardId', 'expectedProjectId', 'expectedRootId'],
  detachProject: ['boardId'],
  setProjectScripts: ['projectId', 'scripts'],
  suggestProjectScripts: ['projectId'],
})
const PROJECT_OPERATIONS = new Set(['attachProject', 'openProject', 'inheritRoomProject', 'readRoomProjectDefault', 'saveRoomProjectDefault', 'detachProject', 'setProjectScripts', 'suggestProjectScripts'])
const TEXT_OPERATIONS = new Set(['updateDraft', 'revertReviewed'])
const SMALL_BODY_BYTES = 64 * 1024
const TEXT_BODY_BYTES = 18 * 1024 * 1024
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, httpStatus: status })
const scopedOwner = ownerScope => {
  if (typeof ownerScope !== 'string' || !ownerScope || ownerScope.length > 512) throw error('OWNER_SCOPE_REQUIRED', 'Authenticated owner scope is required', 403)
  return ownerScope
}

function responseError(cause) {
  const code = cause?.code || 'FILE_SERVICE_ERROR'
  const conflicts = new Set(['DRAFT_CONFLICT', 'BUFFER_CONFLICT', 'TARGET_EXISTS', 'ROOT_CHANGED', 'RESOURCE_CHANGED', 'DRAFT_EXISTS', 'SOURCE_RECONNECT_CONFLICT', 'SOURCE_CHANGED', 'SOURCE_RECONNECT_REQUIRED', 'ORIGINAL_HARD_LINKED', 'PROJECT_RECONNECT_REQUIRED'])
  const missing = new Set(['UNKNOWN_ROOT', 'UNKNOWN_RESOURCE', 'UNKNOWN_DRAFT', 'UNKNOWN_CHANGE', 'RESOURCE_UNAVAILABLE', 'ROOT_UNAVAILABLE', 'UNKNOWN_PROJECT'])
  const large = new Set(['FILE_TOO_LARGE', 'DIRECTORY_TOO_LARGE', 'BODY_TOO_LARGE'])
  const saveFailures = new Set(['SAVE_AS_INCOMPLETE', 'SAVE_AS_UNCERTAIN', 'SAVE_AS_FAILED', 'SAVE_UNCERTAIN', 'SAVE_FAILED'])
  const gitFailures = { GIT_UNAVAILABLE: 503, GIT_TIMEOUT: 504, GIT_FAILED: 500 }
  const known = cause instanceof FileSurfaceError || cause?.httpStatus || conflicts.has(code) || missing.has(code) || large.has(code)
  const status = cause?.httpStatus || (conflicts.has(code) ? 409 : missing.has(code) ? 404 : large.has(code) ? 413 : code === 'SAVE_AS_UNAVAILABLE' ? 503 : saveFailures.has(code) ? 500 : code === 'UNSUPPORTED_EDIT' ? 415 : Object.hasOwn(gitFailures, code) && cause instanceof FileSurfaceError ? gitFailures[code] : cause instanceof FileSurfaceError ? 400 : 500)
  return { status, body: { ok: false, code: known ? code : 'FILE_SERVICE_ERROR', error: known ? cause.message : 'The file operation could not be completed', ...(cause instanceof FileSurfaceError ? { details: cause.details } : {}) } }
}

/** Route-specific bounded JSON reader; invoke this before the bridge's 64 KiB reader. */
export async function readEGDeskFileBody(req, operation) {
  const maximum = TEXT_OPERATIONS.has(operation) ? TEXT_BODY_BYTES : SMALL_BODY_BYTES
  const chunks = []
  let size = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += chunk.length
    if (size > maximum) throw error('BODY_TOO_LARGE', 'File request exceeds its bounded size limit', 413)
    chunks.push(chunk)
  }
  if (!size) return {}
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) throw error('CONTENT_TYPE', 'Expected application/json', 415)
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
  catch { throw error('INVALID_JSON', 'Expected a JSON object') }
}

function checkedBody(operation, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) throw error('INVALID_JSON', 'Expected a JSON object')
  const allowed = new Set(FIELDS[operation])
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw error('UNEXPECTED_FIELD', `Field is not allowed: ${key}`)
  if (Buffer.byteLength(JSON.stringify(body)) > (TEXT_OPERATIONS.has(operation) ? TEXT_BODY_BYTES : SMALL_BODY_BYTES)) throw error('BODY_TOO_LARGE', 'File request exceeds its bounded size limit', 413)
  for (const key of ['requestId', 'selectionId', 'rootId', 'directoryId', 'fileId', 'draftId', 'expectedHead', 'operationId', 'changeId', 'boardId', 'roomId', 'projectId', 'expectedSha256', 'expectedSourceHash']) {
    if (Object.hasOwn(body, key) && (typeof body[key] !== 'string' || !body[key] || body[key].length > 512)) throw error('INVALID_ID', `Invalid ${key}`)
  }
  if (Object.hasOwn(body, 'path') && (typeof body.path !== 'string' || !body.path || body.path.length > 4096)) throw error('INVALID_PATH', 'Invalid path')
  if (Object.hasOwn(body, 'title') && body.title != null && (typeof body.title !== 'string' || body.title.length > PROJECT_LIMITS.maxTitleChars)) throw error('INVALID_PROJECT_REQUEST', 'Invalid project title')
  if (Object.hasOwn(body, 'scripts') && (!Array.isArray(body.scripts) || body.scripts.length > PROJECT_LIMITS.maxScripts)) throw error('INVALID_PROJECT_SCRIPT', 'Invalid project commands')
  if (operation === 'readRoomProjectDefault' || operation === 'saveRoomProjectDefault') {
    for (const key of FIELDS[operation]) if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 512 || body[key].includes('\0')) throw error('INVALID_PROJECT_REQUEST', `${key} is required`)
  }
  return body
}

/**
 * Bridge hookup: create once with the stable EG-Desk local owner/data directory,
 * then await adapter.handle(req,res,{url}). No Codex/AI account auth is required.
 * An optional ownerScope argument must match the constructor's localOwnerScope;
 * a subscription/account switch cannot silently reassign local file authority.
 * resolveRootSelection({selectionId,ownerScope,context}) consumes a privileged
 * picker grant and returns its absolute directory path, or null for cancellation.
 * dispatch is the transport-free form returning {status,body}, or null for a
 * route outside /v1/files. Picker routes require the actual request in
 * dispatch({request}). A native channel is bootstrapped only when Origin and
 * Sec-Fetch-Site are both absent (the existing privileged chrome/local CLI
 * boundary), then bound to a short-lived in-memory nonce. Web-origin requests
 * cannot bootstrap or use this channel. Both forms share scoped services.
 * Board projects (D-X3) live in projects-<owner hash>.sqlite under
 * projectDirectory (default: draftDirectory); projectStoreForOwner(owner)
 * may supply the store instead. resolveProjectWorkspace() is the backend-only
 * hook the bridge uses for an Agent's working folder (wired by bundle 2-E).
 */
export function createEGDeskFileHttpAdapter({ draftDirectory, projectDirectory, localOwnerScope = 'egdesk-local', resolveRootSelection, createOnlyAdapter, storeForOwner, projectStoreForOwner, port = 39218, now = Date.now, onRootRegistered = null, gitReview } = {}) {
  const localOwner = scopedOwner(localOwnerScope)
  const boundOwner = requested => {
    if (requested != null && requested !== localOwner) throw error('OWNER_SCOPE_MISMATCH', 'File operations belong to the configured local EG-Desk owner', 403)
    return localOwner
  }
  const owners = new Map()
  const pickerRequests = new Map()
  const pickerSelections = new Map()
  const pickerChannels = new Map()
  let closed = false
  const prunePickers = () => {
    for (const map of [pickerRequests, pickerSelections, pickerChannels]) for (const [id, grant] of map) if (grant.expiresAt <= now()) map.delete(id)
  }
  const requireNativeTransport = request => {
    if (!request || !guardBridgeRequest(request, port) || Object.hasOwn(request.headers || {}, 'origin') || Object.hasOwn(request.headers || {}, 'sec-fetch-site')) throw error('NATIVE_PICKER_CHANNEL_REQUIRED', 'Native picker handoff requires the privileged local channel', 403)
  }
  const requirePickerChannel = (request, owner) => {
    requireNativeTransport(request)
    const token = request.headers?.['x-egdesk-picker-channel']
    const channel = typeof token === 'string' ? pickerChannels.get(token) : null
    if (!channel || channel.owner !== owner || channel.expiresAt <= now()) throw error('PICKER_CHANNEL_EXPIRED', 'Native picker channel is unavailable or expired', 403)
    return token
  }
  async function entryForOwner(ownerScope) {
    scopedOwner(ownerScope)
    if (closed) throw error('ADAPTER_CLOSED', 'File adapter is closed', 503)
    if (!owners.has(ownerScope)) {
      const pending = (async () => {
        const store = storeForOwner ? await storeForOwner(ownerScope) : await openEGDeskManagedDraftStore({ directory: draftDirectory, ownerScope })
        return { store, service: createEGDeskFileService({ draftStore: store, createOnlyAdapter, onRootRegistered, ...(gitReview ? { gitReview } : {}) }) }
      })()
      owners.set(ownerScope, pending)
      pending.catch(() => { if (owners.get(ownerScope) === pending) owners.delete(ownerScope) })
    }
    return owners.get(ownerScope)
  }

  const projectStores = new Map()
  async function projectsForOwner(ownerScope) {
    if (closed) throw error('ADAPTER_CLOSED', 'File adapter is closed', 503)
    if (!projectStores.has(ownerScope)) {
      const directory = projectDirectory || draftDirectory
      if (!projectStoreForOwner && !directory) throw error('PROJECTS_UNAVAILABLE', 'Project folders are not configured', 503)
      const pending = (async () => {
        const store = projectStoreForOwner ? await projectStoreForOwner(ownerScope) : await openEGDeskProjectStore({ directory, ownerScope, now })
        return { store, roots: new Map() }
      })()
      projectStores.set(ownerScope, pending)
      pending.catch(() => { if (projectStores.get(ownerScope) === pending) projectStores.delete(ownerScope) })
    }
    return projectStores.get(ownerScope)
  }

  // A privileged picker selection → verified absolute folder (or null when the
  // user cancelled). Shared by registerRoot and attachProject.
  async function consumeSelection(selectionId, owner, request, context) {
    if (!selectionId) throw error('SELECTION_REQUIRED', 'A privileged selection ID is required')
    const grant = pickerSelections.get(selectionId)
    pickerSelections.delete(selectionId)
    if (grant?.owner === owner) {
      if (requirePickerChannel(request, owner) !== grant.channel) throw error('PICKER_CHANNEL_EXPIRED', 'Native selection belongs to another channel', 403)
      return grant.absolutePath
    }
    if (typeof resolveRootSelection === 'function') return resolveRootSelection({ selectionId, ownerScope: owner, context })
    throw error('PICKER_GRANT_EXPIRED', 'Native selection is expired or already consumed', 409)
  }

  const sameFolder = (described, project) => described.absolutePath === project.workspaceRoot && described.identity.dev === project.identity.dev && described.identity.ino === project.identity.ino

  // A stored project → a live root handle. Reuses a cached root while it
  // still checks out; otherwise reconnects only when the folder at the stored
  // path has the stored dev/ino (D-X3).
  async function connectProject(service, projects, project) {
    const cached = projects.roots.get(project.id)
    if (cached) {
      const described = await service.describeRoot(cached.rootId).catch(() => null)
      if (described && sameFolder(described, project)) return { status: 'connected', root: cached }
      projects.roots.delete(project.id)
    }
    const stat = await fs.lstat(project.workspaceRoot, { bigint: true }).catch(() => null)
    const state = projectReconnectState(project, stat)
    if (state !== 'connected') return { status: 'reconnect-required', reason: state }
    const root = await service.registerRoot(project.workspaceRoot).catch(() => null)
    const described = root ? await service.describeRoot(root.rootId).catch(() => null) : null
    if (!described || !sameFolder(described, project)) return { status: 'reconnect-required', reason: 'identity-changed' }
    projects.roots.set(project.id, root)
    return { status: 'connected', root }
  }

  const projectView = (project, source, connection) => ({
    projectId: project.id, title: project.title, name: path.basename(project.workspaceRoot) || project.title, source,
    scripts: project.scripts.map(script => ({ ...script })), status: connection.status,
    ...(connection.status === 'connected'
      ? { rootId: connection.root.rootId, directoryId: connection.root.directoryId, displayPath: connection.root.displayPath, saveAsAvailable: connection.root.saveAsAvailable, capability: connection.root.capability }
      : { reason: connection.reason }),
  })

  async function roomDefaultView(roomId, service, projects) {
    const inheritance = projects.store.inheritanceForRoom(roomId)
    const override = projects.store.forRoom(roomId)
    let selected
    try { selected = projects.store.effective({ roomId }) }
    catch (cause) {
      if (cause.code !== 'PROJECT_INHERITANCE_UNAVAILABLE') throw cause
      return { roomId, inheritance, override: null, project: null, source: 'board', status: 'unavailable', reason: cause.code }
    }
    const connection = selected.project ? await connectProject(service, projects, selected.project) : null
    // Connecting a folder yields. Do not publish an observation combining an
    // old selection with a new connection or inheritance choice.
    const latest = projects.store.effective({ roomId })
    if (latest.project?.id !== selected.project?.id || latest.source !== selected.source || latest.boardId !== selected.boardId ||
        (latest.project && !sameFolder({ absolutePath: selected.project.workspaceRoot, identity: selected.project.identity }, latest.project)) ||
        projects.store.inheritanceForRoom(roomId)?.boardId !== inheritance?.boardId || projects.store.forRoom(roomId)?.id !== override?.id ||
        (connection?.status === 'connected' && projects.roots.get(selected.project.id)?.rootId !== connection.root.rootId)) {
      throw error('PROJECT_WORKSPACE_CHANGED', 'Room project changed during verification; read the current default again', 409)
    }
    return { roomId, inheritance, override: override ? { projectId: override.id } : null,
      project: selected.project ? projectView(selected.project, selected.source, connection) : null,
      source: selected.source, status: connection?.status ?? 'none', ...(connection?.reason ? { reason: connection.reason } : {}) }
  }

  async function projectOperation(operation, body, { owner, request, context }) {
    const { service } = await entryForOwner(owner)
    const projects = await projectsForOwner(owner)
    const { store } = projects
    if (operation === 'readRoomProjectDefault') return roomDefaultView(body.roomId, service, projects)
    if (operation === 'saveRoomProjectDefault') {
      const project = store.forBoard(body.boardId)
      if (!project || project.id !== body.expectedProjectId) throw error('PROJECT_TARGET_CHANGED', 'The selected Board project changed; review it and Save again', 409)
      const connection = await connectProject(service, projects, project)
      if (connection.status !== 'connected') throw error('PROJECT_RECONNECT_REQUIRED', 'Reconnect the selected project folder before saving', 409)
      if (connection.root.rootId !== body.expectedRootId) throw error('PROJECT_TARGET_CHANGED', 'The selected folder connection changed; review it and Save again', 409)
      const described = await service.describeRoot(body.expectedRootId)
      if (!sameFolder(described, project)) throw error('PROJECT_RECONNECT_REQUIRED', 'The selected folder identity changed', 409)
      store.saveRoomInheritance({ roomId: body.roomId, boardId: body.boardId, expectedProject: project })
      return roomDefaultView(body.roomId, service, projects)
    }
    if (operation === 'attachProject') {
      if (body.boardId == null && body.roomId == null) throw error('INVALID_PROJECT_REQUEST', 'A boardId or roomId is required')
      const selected = await consumeSelection(body.selectionId, owner, request, context)
      if (selected == null) return { cancelled: true }
      const root = await service.registerRoot(selected)
      const described = await service.describeRoot(root.rootId)
      const folder = { workspaceRoot: described.absolutePath, identity: described.identity, title: body.title }
      const project = body.roomId != null
        ? await store.attachToRoom({ roomId: body.roomId, boardId: body.boardId ?? null, ...folder })
        : await store.attachToBoard({ boardId: body.boardId, ...folder })
      projects.roots.set(project.id, root)
      return projectView(project, body.roomId != null ? 'room' : 'board', { status: 'connected', root })
    }
    if (operation === 'openProject') {
      const { project, source } = await store.effective({ boardId: body.boardId ?? null, roomId: body.roomId ?? null })
      if (!project) return { project: null, source: null }
      return { project: projectView(project, source, await connectProject(service, projects, project)), source }
    }
    if (operation === 'inheritRoomProject') return { roomId: body.roomId, inherited: true, removed: await store.inheritRoom({ roomId: body.roomId }) }
    if (operation === 'detachProject') return { boardId: body.boardId, removed: await store.detachBoard({ boardId: body.boardId }) }
    if (operation === 'setProjectScripts') {
      const project = await store.setScripts({ projectId: body.projectId, scripts: body.scripts })
      return { projectId: project.id, scripts: project.scripts }
    }
    // suggestProjectScripts: package.json at the project folder, shown only.
    const project = await store.get(body.projectId)
    if (!project) throw error('UNKNOWN_PROJECT', 'Project is not attached', 404)
    const connection = await connectProject(service, projects, project)
    if (connection.status !== 'connected') throw error('PROJECT_RECONNECT_REQUIRED', 'Pick the project folder again', 409)
    let suggestions = []
    try {
      const found = await service.resolvePath({ rootId: connection.root.rootId, path: 'package.json' })
      const read = found.kind === 'file' ? await service.readFile({ fileId: found.id }) : null
      if (read?.kind === 'text' && read.size <= PROJECT_LIMITS.maxPackageJsonBytes) suggestions = suggestProjectScripts(read.text)
    } catch (cause) { if (!['RESOURCE_UNAVAILABLE', 'FILE_TOO_LARGE'].includes(cause?.code)) throw cause }
    return { projectId: project.id, suggestions }
  }

  async function dispatch({ method, pathname, body = {}, ownerScope, context, request } = {}) {
    if (typeof pathname !== 'string' || !(pathname === '/v1/files' || pathname.startsWith('/v1/files/'))) return null
    try {
      const owner = boundOwner(ownerScope)
      if (closed) throw error('ADAPTER_CLOSED', 'File adapter is closed', 503)
      const operation = OPERATIONS.get(pathname)
      if (!operation) throw error('NOT_FOUND', 'Unknown file operation', 404)
      if (method !== 'POST') throw error('METHOD_NOT_ALLOWED', 'File operations require POST', 405)
      checkedBody(operation, body)
      prunePickers()
      if (operation === 'openPickerChannel') {
        requireNativeTransport(request)
        if (pickerChannels.size >= 16) throw error('PICKER_LIMIT', 'Too many native picker channels', 429)
        const token = randomBytes(32).toString('base64url')
        const expiresAt = now() + 60 * 60_000
        pickerChannels.set(token, { owner, expiresAt })
        return { status: 200, body: { ok: true, result: { token, expiresAt } } }
      }
      if (operation === 'beginPicker' || operation === 'completePicker') {
        const channel = requirePickerChannel(request, owner)
        if (operation === 'beginPicker') {
          if (!['folder', 'save-as-directory'].includes(body.purpose || 'folder')) throw error('INVALID_PICKER_PURPOSE', 'Unsupported native picker purpose')
          if (pickerRequests.size + pickerSelections.size >= 64) throw error('PICKER_LIMIT', 'Too many pending native selections', 429)
          const requestId = randomUUID()
          const expiresAt = now() + 120_000
          pickerRequests.set(requestId, { owner, channel, expiresAt, purpose: body.purpose || 'folder' })
          return { status: 200, body: { ok: true, result: { requestId, expiresAt } } }
        }
        const grant = pickerRequests.get(body.requestId)
        pickerRequests.delete(body.requestId)
        if (!grant || grant.owner !== owner || grant.channel !== channel) throw error('PICKER_GRANT_EXPIRED', 'Native picker request is expired or already consumed', 409)
        if (body.cancelled === true) return { status: 200, body: { ok: true, result: { cancelled: true } } }
        if (typeof body.absolutePath !== 'string' || body.absolutePath.length > 4096 || !path.isAbsolute(body.absolutePath)) throw error('INVALID_PICKER_PATH', 'Native picker must return an absolute directory path')
        const selectionId = randomUUID()
        pickerSelections.set(selectionId, { ...grant, absolutePath: body.absolutePath })
        return { status: 200, body: { ok: true, result: { selectionId, expiresAt: grant.expiresAt } } }
      }
      if (PROJECT_OPERATIONS.has(operation)) return { status: 200, body: { ok: true, result: await projectOperation(operation, body, { owner, request, context }) } }
      const { service } = await entryForOwner(owner)
      let result
      if (operation === 'registerRoot') {
        const selectedPath = await consumeSelection(body.selectionId, owner, request, context)
        result = selectedPath == null ? { cancelled: true } : await service.registerRoot(selectedPath)
      } else result = await service[operation](body)
      return { status: 200, body: { ok: true, result } }
    } catch (cause) { return responseError(cause) }
  }

  async function handle(req, res, { ownerScope, url, body, context } = {}) {
    let pathname
    try { pathname = url?.pathname || new URL(req.url, `http://127.0.0.1:${port}`).pathname }
    catch { return false }
    if (!(pathname === '/v1/files' || pathname.startsWith('/v1/files/'))) return false
    if (!guardBridgeRequest(req, port)) { sendJson(res, 403, { ok: false, code: 'LOOPBACK_REQUIRED', error: 'Trusted loopback origin is required' }); return true }
    let response
    try {
      boundOwner(ownerScope)
      const operation = OPERATIONS.get(pathname)
      const parsed = body === undefined && operation && req.method === 'POST' ? await readEGDeskFileBody(req, operation) : body || {}
      response = await dispatch({ method: req.method, pathname, body: parsed, ownerScope, context, request: req })
    } catch (cause) { response = responseError(cause) }
    sendJson(res, response.status, response.body)
    return true
  }

  async function registerAuthorizedRoot({ ownerScope, absolutePath }) {
    // Backend-only convenience for a native picker callback. Never pass an
    // unverified renderer body path to this method.
    const { service } = await entryForOwner(boundOwner(ownerScope))
    return service.registerRoot(absolutePath)
  }

  async function resolveCaptureSource({ ownerScope, captureRef, assertActive = () => {} } = {}) {
    // Backend-only byte handoff for /context/captures. The local file owner is
    // stable across AI account changes; the caller separately guards its
    // account/epoch through assertActive before and after the async lookup.
    if (ownerScope !== localOwner) throw error('OWNER_SCOPE_MISMATCH', 'Capture requires the configured local EG-Desk owner', 403)
    const owner = boundOwner(ownerScope)
    if (typeof assertActive !== 'function') throw error('INVALID_CAPTURE_REF', 'Capture guard must be a function')
    assertActive()
    const { service } = await entryForOwner(owner)
    assertActive()
    const source = await service.resolveCaptureSource(captureRef)
    assertActive()
    return source
  }

  // Backend-only (2-E wires it into the Agent's working folder and allowed
  // roots): the effective project folder for a Board/room, verified by dev/ino.
  // Only null means no association; disconnected folders retain their status.
  // expectedRoomProject compares the observed identity, not a revision/CAS.
  async function resolveProjectWorkspace({ ownerScope, boardId = null, roomId = null, projectTarget = null, expectedRoomProject } = {}) {
    const owner = boundOwner(ownerScope)
    const identifier = value => typeof value === 'string' && value.trim() && value.length <= 512 && !value.includes('\0')
    if ([boardId, roomId].some(value => value !== null && !identifier(value))) throw error('INVALID_PROJECT_SCOPE', 'Only opaque Board and room IDs are accepted')
    if (projectTarget !== null) {
      if (!projectTarget || typeof projectTarget !== 'object' || Array.isArray(projectTarget) || Object.keys(projectTarget).length !== 3 ||
          !['boardId', 'projectId', 'rootId'].every(key => Object.hasOwn(projectTarget, key) && identifier(projectTarget[key])) || (boardId !== null && boardId !== projectTarget.boardId)) throw error('INVALID_PROJECT_TARGET', 'Only matching opaque target IDs are accepted')
      projectTarget = Object.freeze({ boardId: projectTarget.boardId, projectId: projectTarget.projectId, rootId: projectTarget.rootId })
    }
    if (expectedRoomProject !== undefined) {
      const value = expectedRoomProject
      const keys = ['roomId', 'status', 'source', 'boardId', 'projectId', 'rootId']
      if (projectTarget || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
          !keys.every(key => Object.hasOwn(value, key)) || !identifier(value.roomId) ||
          !(value.status === 'none'
            ? ['source', 'boardId', 'projectId', 'rootId'].every(key => value[key] === null)
            : value.status === 'connected' && identifier(value.projectId) && identifier(value.rootId) &&
              (value.source === 'board' ? identifier(value.boardId) : value.source === 'room' && value.boardId === null))) {
        throw error('INVALID_EXPECTED_ROOM_PROJECT', 'expectedRoomProject requires an exact connected or none identity and cannot accompany projectTarget')
      }
      // A comparison precondition, never a selection, override or grant.
      // Snapshot before even the first store-opening await.
      expectedRoomProject = Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])))
      if (expectedRoomProject.roomId !== roomId) throw error('PROJECT_WORKSPACE_CHANGED', 'The observed project belongs to another room; review the current room before sending', 409)
    }
    const assertExpectedSelection = (selected, rootId) => {
      if (!expectedRoomProject) return
      const project = selected.project
      if (expectedRoomProject.status !== (project ? 'connected' : 'none') ||
          expectedRoomProject.source !== (selected.source ?? null) || expectedRoomProject.projectId !== (project?.id ?? null) ||
          expectedRoomProject.boardId !== (project && selected.source === 'board' ? selected.boardId ?? boardId : null) ||
          (rootId !== undefined && expectedRoomProject.rootId !== rootId)) {
        throw error('PROJECT_WORKSPACE_CHANGED', 'The observed room project changed; review the current default before sending', 409)
      }
    }
    const { service } = await entryForOwner(owner)
    const projects = await projectsForOwner(owner)
    let selected
    if (projectTarget !== null) {
      const project = projects.store.forBoard(projectTarget.boardId)
      if (!project || project.id !== projectTarget.projectId) throw error('PROJECT_TARGET_CHANGED', 'The selected project changed; select it and Apply again', 409)
      selected = { project, source: 'request', boardId: projectTarget.boardId }
    } else selected = projects.store.effective({ boardId, roomId })
    assertExpectedSelection(selected)
    const { project, source } = selected
    if (!project) return null
    const connection = await connectProject(service, projects, project)
    if (connection.status !== 'connected') return { projectId: project.id, source, status: connection.status, reason: connection.reason }
    if (projectTarget && connection.root.rootId !== projectTarget.rootId) throw error('PROJECT_TARGET_CHANGED', 'The selected folder connection changed; select it and Apply again', 409)
    assertExpectedSelection(selected, connection.root.rootId)
    const described = await service.describeRoot(connection.root.rootId)
    if (!sameFolder(described, project)) throw error('PROJECT_RECONNECT_REQUIRED', 'Project folder identity changed', 409)
    const latest = projectTarget
      ? { project: projects.store.forBoard(projectTarget.boardId), source: 'request', boardId: projectTarget.boardId }
      : projects.store.effective({ boardId, roomId })
    assertExpectedSelection(latest, connection.root.rootId)
    if (!latest.project || latest.project.id !== project.id || latest.source !== source || latest.boardId !== selected.boardId ||
        !sameFolder(described, latest.project) || projects.roots.get(project.id)?.rootId !== connection.root.rootId) {
      throw error(projectTarget ? 'PROJECT_TARGET_CHANGED' : 'PROJECT_WORKSPACE_CHANGED', 'Project selection changed during verification; review it before sending', 409)
    }
    return { projectId: project.id, source, status: 'connected', rootId: connection.root.rootId, absolutePath: described.absolutePath,
      fileOwnerScope: owner, identity: { ...described.identity }, boardId: selected.boardId ?? (source === 'board' ? boardId : null), roomId }
  }

  // Read-only: an origin is evidence, never a grant to register its saved path.
  // After restart, an ordinary authorized project open must establish a live
  // connection first. Its handle may differ, but the original dev/ino may not.
  async function resolveRunProjectOrigin({ ownerScope, origin, assertActive = () => {} } = {}) {
    const owner = boundOwner(ownerScope)
    assertActive()
    const p = origin?.project
    if (!p || p.fileOwnerScope !== owner) throw error('PROJECT_ORIGIN_SCOPE_MISMATCH', 'Run origin belongs to another local file owner', 403)
    const { service } = await entryForOwner(owner)
    const projects = await projectsForOwner(owner)
    assertActive()
    const candidates = projects.store.list().filter(project => project.workspaceRoot === p.startCwd)
    let changed = false
    for (const project of candidates) {
      if (project.identity.dev !== p.fsIdentity?.dev || project.identity.ino !== p.fsIdentity?.ino) { changed = true; continue }
      const connection = projects.roots.get(project.id)
      if (!connection) continue
      // Snapshot only public fields from this already-authorized live handle.
      // Neither saved provenance nor describeRoot's private fields are DTOs.
      const publicRoot = { rootId: connection.rootId, directoryId: connection.directoryId, displayPath: connection.displayPath }
      const validId = value => typeof value === 'string' && value.trim() && value.length <= 300 && !value.includes('\0')
      if (!validId(publicRoot.rootId) || !validId(publicRoot.directoryId) || typeof publicRoot.displayPath !== 'string' ||
          !path.isAbsolute(publicRoot.displayPath) || publicRoot.displayPath.length > 4096 || publicRoot.displayPath.includes('\0')) continue
      const described = await service.describeRoot(publicRoot.rootId).catch(() => null)
      assertActive()
      if (!described || !sameFolder(described, project)) { changed = true; continue }
      // Check authorization again after the filesystem await. A detached or
      // rebound project must not release an old cached handle.
      const current = projects.store.get(project.id)
      const currentConnection = projects.roots.get(project.id)
      if (!current || !sameFolder(described, current) || currentConnection !== connection ||
          Object.keys(publicRoot).some(key => currentConnection[key] !== publicRoot[key]) || publicRoot.displayPath !== described.absolutePath) continue
      return { status: 'verified', verified: true, projectId: p.projectId, source: p.source,
        rootId: publicRoot.rootId, directoryId: publicRoot.directoryId, displayPath: publicRoot.displayPath }
    }
    return { status: changed ? 'reconnect-required' : 'unavailable', verified: false, reason: changed ? 'identity-changed' : 'connection-required' }
  }

  async function close() {
    closed = true
    const settled = await Promise.allSettled(owners.values())
    for (const result of settled) if (result.status === 'fulfilled') await result.value.store.close?.()
    owners.clear()
    for (const result of await Promise.allSettled(projectStores.values())) if (result.status === 'fulfilled') await result.value.store.close?.()
    projectStores.clear()
    pickerRequests.clear(); pickerSelections.clear(); pickerChannels.clear()
  }
  return { dispatch, handle, registerAuthorizedRoot, resolveCaptureSource, resolveProjectWorkspace, resolveRunProjectOrigin, close, endpoints: EGDESK_FILE_ENDPOINTS }
}

export async function handleEGDeskFiles(req, res, { adapter, ...context } = {}) {
  if (!adapter?.handle) throw new TypeError('File HTTP adapter is required')
  return adapter.handle(req, res, context)
}
