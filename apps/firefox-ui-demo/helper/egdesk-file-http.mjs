import { createEGDeskFileService, FileSurfaceError } from './egdesk-file-service.mjs'
import { openEGDeskManagedDraftStore } from './egdesk-managed-drafts.mjs'
import { guardBridgeRequest, sendJson } from './codex-bridge-http.mjs'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'

export const EGDESK_FILE_ENDPOINTS = Object.freeze({
  openPickerChannel: '/v1/files/picker/channel',
  beginPicker: '/v1/files/picker/begin',
  completePicker: '/v1/files/picker/complete',
  registerRoot: '/v1/files/roots',
  listDirectory: '/v1/files/list',
  search: '/v1/files/search',
  readFile: '/v1/files/read',
  createDraft: '/v1/files/drafts/create',
  readDraft: '/v1/files/drafts/read',
  updateDraft: '/v1/files/drafts/update',
  saveDraft: '/v1/files/drafts/save',
  diffDraft: '/v1/files/drafts/diff',
  sourceStatus: '/v1/files/drafts/source-status',
  reconnectDraft: '/v1/files/drafts/reconnect',
  saveAs: '/v1/files/save-as',
})
const OPERATIONS = new Map(Object.entries(EGDESK_FILE_ENDPOINTS).map(([name, route]) => [route, name]))
const FIELDS = Object.freeze({
  openPickerChannel: [], beginPicker: ['purpose'], completePicker: ['requestId', 'absolutePath', 'cancelled'],
  registerRoot: ['selectionId'], listDirectory: ['directoryId', 'limit', 'cursor'],
  search: ['rootId', 'query', 'limit', 'maxVisits', 'maxDepth'], readFile: ['fileId'],
  createDraft: ['fileId'], readDraft: ['draftId'],
  updateDraft: ['draftId', 'expectedHead', 'text', 'operationId'],
  saveDraft: ['draftId', 'expectedHead', 'bufferRevision', 'operationId'],
  diffDraft: ['draftId'], sourceStatus: ['draftId'],
  reconnectDraft: ['draftId', 'expectedHead', 'fileId', 'operationId'],
  saveAs: ['draftId', 'expectedHead', 'directoryId', 'fileName', 'operationId'],
})
const SMALL_BODY_BYTES = 64 * 1024
const TEXT_BODY_BYTES = 18 * 1024 * 1024
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, httpStatus: status })
const scopedOwner = ownerScope => {
  if (typeof ownerScope !== 'string' || !ownerScope || ownerScope.length > 512) throw error('OWNER_SCOPE_REQUIRED', 'Authenticated owner scope is required', 403)
  return ownerScope
}

function responseError(cause) {
  const code = cause?.code || 'FILE_SERVICE_ERROR'
  const conflicts = new Set(['DRAFT_CONFLICT', 'BUFFER_CONFLICT', 'TARGET_EXISTS', 'ROOT_CHANGED', 'RESOURCE_CHANGED', 'DRAFT_EXISTS', 'SOURCE_RECONNECT_CONFLICT'])
  const missing = new Set(['UNKNOWN_ROOT', 'UNKNOWN_RESOURCE', 'UNKNOWN_DRAFT', 'RESOURCE_UNAVAILABLE', 'ROOT_UNAVAILABLE'])
  const large = new Set(['FILE_TOO_LARGE', 'DIRECTORY_TOO_LARGE', 'BODY_TOO_LARGE'])
  const saveFailures = new Set(['SAVE_AS_INCOMPLETE', 'SAVE_AS_UNCERTAIN', 'SAVE_AS_FAILED'])
  const known = cause instanceof FileSurfaceError || cause?.httpStatus || conflicts.has(code) || missing.has(code) || large.has(code)
  const status = cause?.httpStatus || (conflicts.has(code) ? 409 : missing.has(code) ? 404 : large.has(code) ? 413 : code === 'SAVE_AS_UNAVAILABLE' ? 503 : saveFailures.has(code) ? 500 : code === 'UNSUPPORTED_EDIT' ? 415 : cause instanceof FileSurfaceError ? 400 : 500)
  return { status, body: { ok: false, code: known ? code : 'FILE_SERVICE_ERROR', error: known ? cause.message : 'The file operation could not be completed', ...(cause instanceof FileSurfaceError ? { details: cause.details } : {}) } }
}

/** Route-specific bounded JSON reader; invoke this before the bridge's 64 KiB reader. */
export async function readEGDeskFileBody(req, operation) {
  const maximum = operation === 'updateDraft' ? TEXT_BODY_BYTES : SMALL_BODY_BYTES
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
  if (Buffer.byteLength(JSON.stringify(body)) > (operation === 'updateDraft' ? TEXT_BODY_BYTES : SMALL_BODY_BYTES)) throw error('BODY_TOO_LARGE', 'File request exceeds its bounded size limit', 413)
  for (const key of ['requestId', 'selectionId', 'rootId', 'directoryId', 'fileId', 'draftId', 'expectedHead', 'operationId']) {
    if (Object.hasOwn(body, key) && (typeof body[key] !== 'string' || !body[key] || body[key].length > 512)) throw error('INVALID_ID', `Invalid ${key}`)
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
 */
export function createEGDeskFileHttpAdapter({ draftDirectory, localOwnerScope = 'egdesk-local', resolveRootSelection, createOnlyAdapter, storeForOwner, port = 39218, now = Date.now } = {}) {
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
        return { store, service: createEGDeskFileService({ draftStore: store, createOnlyAdapter }) }
      })()
      owners.set(ownerScope, pending)
      pending.catch(() => { if (owners.get(ownerScope) === pending) owners.delete(ownerScope) })
    }
    return owners.get(ownerScope)
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
      const { service } = await entryForOwner(owner)
      let result
      if (operation === 'registerRoot') {
        if (!body.selectionId) throw error('SELECTION_REQUIRED', 'A privileged selection ID is required')
        const grant = pickerSelections.get(body.selectionId)
        pickerSelections.delete(body.selectionId)
        let selectedPath
        if (grant?.owner === owner) {
          if (requirePickerChannel(request, owner) !== grant.channel) throw error('PICKER_CHANNEL_EXPIRED', 'Native selection belongs to another channel', 403)
          selectedPath = grant.absolutePath
        }
        else if (typeof resolveRootSelection === 'function') selectedPath = await resolveRootSelection({ selectionId: body.selectionId, ownerScope: owner, context })
        else throw error('PICKER_GRANT_EXPIRED', 'Native selection is expired or already consumed', 409)
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

  async function close() {
    closed = true
    const settled = await Promise.allSettled(owners.values())
    for (const result of settled) if (result.status === 'fulfilled') await result.value.store.close?.()
    owners.clear()
    pickerRequests.clear(); pickerSelections.clear(); pickerChannels.clear()
  }
  return { dispatch, handle, registerAuthorizedRoot, close, endpoints: EGDESK_FILE_ENDPOINTS }
}

export async function handleEGDeskFiles(req, res, { adapter, ...context } = {}) {
  if (!adapter?.handle) throw new TypeError('File HTTP adapter is required')
  return adapter.handle(req, res, context)
}
