import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'
import { PORTABLE_LIMITS, createPortableService, portableExportLocation } from './egdesk-portable-service.mjs'

// RT-03 portable .egdesk routes. Same contract as the Desk routes: loopback/
// Origin guard, application/json object bodies, {code, error} failures with
// publicText messages; works while Codex is signed out (local data only).
// Export bodies stay at 64 KiB; inspect/import may carry an uploaded file as
// base64, so they get their own larger limit. A passphrase is used for one
// request and is never stored, logged or returned.
const SMALL_BODY = 65536
export const uploadBodyLimit = maxBundleBytes => Math.ceil(maxBundleBytes / 3) * 4 + SMALL_BODY
export const PORTABLE_BODY_LIMITS = Object.freeze({ small: SMALL_BODY, upload: uploadBodyLimit(PORTABLE_LIMITS.maxBundleBytes) })
const ROUTES = {
  '/v1/portable/exports': ['GET', 'exports'],
  '/v1/portable/export': ['POST', 'export'],
  '/v1/portable/inspect': ['POST', 'inspect'],
  '/v1/portable/import': ['POST', 'import'],
}
const EXTRA_FIELDS = ['reason', 'encrypted', 'locked', 'written']

function httpError(code, message, httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus })
}
function fields(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) throw httpError('PORTABLE_HTTP_INPUT', 'Invalid portable request fields')
}
function passphraseField(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw httpError('PORTABLE_HTTP_INPUT', 'passphrase must be text')
  return value
}
function exportInput(body) {
  fields(body, ['scope', 'boardId', 'include', 'passphrase'], ['scope'])
  if (!['desk', 'board'].includes(body.scope)) throw httpError('PORTABLE_HTTP_INPUT', 'scope must be desk or board')
  if (body.scope === 'board' ? typeof body.boardId !== 'string' || !body.boardId : body.boardId !== undefined) throw httpError('PORTABLE_HTTP_INPUT', 'boardId is required for a Board export only')
  const include = body.include ?? {}
  fields(include, ['chats', 'profiles'])
  if (Object.values(include).some(value => typeof value !== 'boolean')) throw httpError('PORTABLE_HTTP_INPUT', 'include.chats and include.profiles must be true or false')
  return { scope: body.scope, ...(body.scope === 'board' ? { boardId: body.boardId } : {}), include, passphrase: passphraseField(body.passphrase) }
}
function sourceInput(body, withMode) {
  fields(body, withMode ? ['fileRef', 'bundle', 'passphrase', 'mode'] : ['fileRef', 'bundle', 'passphrase'], withMode ? ['mode'] : [])
  if (withMode && body.mode !== 'asNew') throw httpError('PORTABLE_HTTP_INPUT', "mode must be 'asNew'")
  if ((body.fileRef === undefined) === (body.bundle === undefined)) throw httpError('PORTABLE_HTTP_INPUT', 'Send exactly one of fileRef or bundle')
  if (body.fileRef !== undefined) {
    fields(body.fileRef, ['exportFile'], ['exportFile'])
    if (typeof body.fileRef.exportFile !== 'string') throw httpError('PORTABLE_HTTP_INPUT', 'fileRef.exportFile must be a file name')
  } else if (typeof body.bundle !== 'string') throw httpError('PORTABLE_HTTP_INPUT', 'bundle must be base64 text')
  return { ...(body.fileRef !== undefined ? { fileRef: body.fileRef } : { bundle: body.bundle }), passphrase: passphraseField(body.passphrase) }
}

/**
 * handlePortableHttp(req, url, {service, readJson, send, port}) → true when it owned the URL.
 * service: createPortableService(...) or () => service.
 * GET  /v1/portable/exports            → {folder, displayPath, files: [{fileName, bytes, modifiedAt, fileRef}]}
 * POST /v1/portable/export {scope: 'desk'|'board', boardId?, include?: {chats, profiles}, passphrase?}
 *                                       → 201 {fileName, bytes, encrypted, contents, folder, displayPath, fileRef, redacted}
 * POST /v1/portable/inspect {fileRef: {exportFile} | bundle: base64, passphrase?}
 *                                       → 200 summary | 200 {encrypted: true, locked: true, bytes} without a passphrase
 * POST /v1/portable/import {fileRef | bundle, passphrase?, mode: 'asNew'}
 *                                       → 201 {mode, desk, boards, chats, profiles, contents, verified, redacted}
 */
export async function handlePortableHttp(req, url, { service, readJson = readJsonBody, send, port = 39218 } = {}) {
  if (url.pathname !== '/v1/portable' && !url.pathname.startsWith('/v1/portable/')) return false
  if (typeof send !== 'function') throw new TypeError('send is required')
  if (!guardBridgeRequest(req, port)) {
    send(403, { code: 'PORTABLE_LOOPBACK_REQUIRED', error: 'Untrusted portable request origin' })
    return true
  }
  try {
    const route = ROUTES[url.pathname]
    if (!route) throw httpError('PORTABLE_ROUTE_NOT_FOUND', 'Unknown portable endpoint', 404)
    if (req.method !== route[0]) throw httpError('METHOD_NOT_ALLOWED', 'Method not allowed for this portable endpoint', 405)
    if ([...url.searchParams.keys()].length) throw httpError('PORTABLE_HTTP_INPUT', 'Invalid portable query')
    const action = route[1]
    const portable = typeof service === 'function' ? service() : service
    const limit = action === 'export' ? SMALL_BODY : uploadBodyLimit(portable?.limits?.maxBundleBytes ?? PORTABLE_LIMITS.maxBundleBytes)
    const body = action === 'exports' ? null : await readJson(req, { maxBytes: limit })
    if (!portable) throw httpError('PORTABLE_UNAVAILABLE', 'Portable bundle support is unavailable', 503)
    if (action === 'exports') send(200, await portable.listExports())
    else if (action === 'export') send(201, await portable.exportBundle(exportInput(body)))
    else if (action === 'inspect') send(200, await portable.inspectBundle(sourceInput(body, false)))
    else send(201, await portable.importBundle(sourceInput(body, true)))
  } catch (error) {
    const known = typeof error.code === 'string' && Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599
    const extra = {}
    if (known) for (const key of EXTRA_FIELDS) {
      const value = error[key]
      if (typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value)) extra[key] = value
      else if (typeof value === 'boolean') extra[key] = value
      else if (key === 'written' && value && typeof value === 'object') extra[key] = value
    }
    send(known ? error.httpStatus : 500, {
      code: known ? error.code : 'PORTABLE_ERROR',
      error: known ? publicText(error.message, 2000) : 'Portable request could not be completed',
      ...extra,
    })
  }
  return true
}

/**
 * Bridge mount: `if (await handlePortableHttp(req, res, url)) return`.
 * desk/chat/profiles: () => store (null while unavailable). appDataDir is the
 * fallback export folder parent when ~/Downloads does not exist.
 */
export function createPortableHttpHandler({ desk, chat, profiles, appDataDir, port = 39218, ...options } = {}) {
  const service = createPortableService({ desk, chat, profiles, location: () => portableExportLocation({ appDataDir }), ...options })
  return (req, res, url) => handlePortableHttp(req, url, { service, port, send: (status, data) => sendJson(res, status, data) })
}
