import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'
import { AGENT_EXPORT_FORMATS, exportAgentFile, importAgentFile } from './egdesk-profile-file.mjs'

// Agent Profile routes over the local profile store. Same contract as the
// bridge: loopback/Origin guard, application/json bodies up to 64 KiB (an
// Agent file import 128 KiB, an avatar photo 768 KiB), and {code, error}
// failures with publicText messages.
const MAX_BODY = 65536
const MAX_IMPORT_BODY = 128 * 1024
const MAX_IMAGE_BODY = 768 * 1024
const ID = '([a-z0-9][a-z0-9-]{0,79})'
// Fixed paths come before /profiles/:id, whose ID pattern would also match them.
const ROUTES = [
  ['GET', /^\/profiles$/, 'list'],
  ['POST', /^\/profiles$/, 'create'],
  ['GET', /^\/profiles\/tool-presets$/, 'presets'],
  ['POST', /^\/profiles\/import$/, 'import'],
  ['POST', /^\/profiles\/avatar-images$/, 'putImage'],
  ['GET', /^\/profiles\/avatar-images\/(img-[0-9a-f]{64})$/, 'getImage'],
  ['GET', new RegExp(`^/profiles/${ID}$`), 'get'],
  ['GET', new RegExp(`^/profiles/${ID}/revisions$`), 'revisions'],
  ['GET', new RegExp(`^/profiles/${ID}/revisions/([1-9]\\d{0,8})$`), 'revision'],
  ['PUT', new RegExp(`^/profiles/${ID}/draft$`), 'draft'],
  ['POST', new RegExp(`^/profiles/${ID}/activate$`), 'activate'],
  ['POST', new RegExp(`^/profiles/${ID}/duplicate$`), 'duplicate'],
  ['POST', new RegExp(`^/profiles/${ID}/lifecycle$`), 'lifecycle'],
  ['GET', new RegExp(`^/profiles/${ID}/diff$`), 'diff'],
  ['GET', new RegExp(`^/profiles/${ID}/export$`), 'export'],
]
const BODY_LIMITS = { create: MAX_BODY, draft: MAX_BODY, activate: MAX_BODY, duplicate: MAX_BODY, lifecycle: MAX_BODY, import: MAX_IMPORT_BODY, putImage: MAX_IMAGE_BODY }

function httpError(code, message, httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus })
}
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) throw httpError('PROFILE_HTTP_INPUT', 'Invalid profile request fields')
}
function query(url, allowed) {
  const keys = [...url.searchParams.keys()]
  if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length) throw httpError('PROFILE_HTTP_INPUT', 'Invalid profile query')
}
function revisionParam(value, name) {
  if (value === null || !/^[1-9]\d{0,8}$/.test(value)) throw httpError('PROFILE_HTTP_INPUT', `${name} must be a positive revision number`)
  return Number(value)
}

/**
 * handleProfileHttp(req, url, {store, readJson, send, ensureAuth, port}) → true when it owned the URL.
 * store: profile store or () => store (null means storage is unavailable).
 * send(status, data) writes the response; readJson(req, {maxBytes}) defaults to readJsonBody.
 * GET /profiles[?includeArchived=true]       → {profiles} (each with latestSource, reviewRequired)
 * POST /profiles {body, toolPreset?}         → 201 {id, revision, hash, unchanged, profile}
 *                                            toolPreset fills toolCeiling only when body has none
 * GET /profiles/tool-presets                 → {defaultPreset, presets: [{id, label, description, toolCeiling}]}
 * POST /profiles/import {text, filename?, dryRun?}
 *                                            → dryRun: 200 {dryRun: true, format, flavor, body, preview}, nothing written
 *                                            → else 201 like create plus preview: always a draft, reviewRequired
 * GET /profiles/:id/export?format=md|codex-toml[&revision=]
 *                                            → {profileId, revision, hash, format, filename, mediaType, text, omitted}
 * POST /profiles/avatar-images {mediaType, imageBase64}
 *                                            → 201 (200 when already kept) {assetId, mediaType, width, height, byteSize, unchanged}
 * GET /profiles/avatar-images/:assetId       → {assetId, mediaType, width, height, byteSize, imageBase64}
 * GET /profiles/:id                          → profile with active/head revisions, source[], reviewRequired
 * GET /profiles/:id/revisions[/:revision]    → summaries, or one revision with body
 * PUT /profiles/:id/draft {body, expectedRevision}
 * POST /profiles/:id/activate {revision, expectedActiveRevision}
 * POST /profiles/:id/duplicate {revision?, name?} → 201 like create: a new draft
 *                                            copied from that revision (default: active, else latest),
 *                                            named name or "<name> 사본"; the original is unchanged
 * POST /profiles/:id/lifecycle {action: disable|archive|restore|delete}
 * GET /profiles/:id/diff?from=&to=           → {profileId, from, to, changes}
 */
export async function handleProfileHttp(req, url, { store, readJson = readJsonBody, send, ensureAuth, port = 39218 } = {}) {
  if (url.pathname !== '/profiles' && !url.pathname.startsWith('/profiles/')) return false
  if (typeof send !== 'function') throw new TypeError('send is required')
  if (!guardBridgeRequest(req, port)) {
    send(403, { code: 'PROFILE_LOOPBACK_REQUIRED', error: 'Untrusted profile request origin' })
    return true
  }
  try {
    let match = null, action = null
    for (const [method, pattern, name] of ROUTES) {
      const found = url.pathname.match(pattern)
      if (found && req.method === method) { match = found; action = name; break }
    }
    if (!action) throw httpError('PROFILE_ROUTE_NOT_FOUND', 'Unknown profile endpoint', 404)
    const body = Object.hasOwn(BODY_LIMITS, action) ? await readJson(req, { maxBytes: BODY_LIMITS[action] }) : null
    if (typeof ensureAuth === 'function') await ensureAuth()
    // Resolve after every await so an owner switch never writes to the old store.
    const profiles = typeof store === 'function' ? store() : store
    if (!profiles) throw httpError('PROFILE_STORE_UNAVAILABLE', 'Local profile storage is unavailable', 503)
    const id = match[1]
    let status = 200, result
    if (action === 'list') {
      query(url, ['includeArchived'])
      const flag = url.searchParams.get('includeArchived')
      if (flag !== null && !['true', 'false'].includes(flag)) throw httpError('PROFILE_HTTP_INPUT', 'includeArchived must be true or false')
      result = profiles.list({ includeArchived: flag === 'true' })
    } else if (action === 'create') {
      fields(body, ['body', 'toolPreset'], ['body'])
      result = profiles.createDraft(body.body, Object.hasOwn(body, 'toolPreset') ? { toolPreset: body.toolPreset } : {})
      status = 201
    } else if (action === 'import') {
      fields(body, ['text', 'filename', 'dryRun'], ['text'])
      if (Object.hasOwn(body, 'dryRun') && typeof body.dryRun !== 'boolean') throw httpError('PROFILE_HTTP_INPUT', 'dryRun must be true or false')
      const parsed = importAgentFile(body.text, { filename: body.filename })
      if (body.dryRun === true) result = { dryRun: true, format: parsed.format, flavor: parsed.flavor, body: parsed.body, preview: parsed.preview }
      else {
        result = { ...profiles.importDraft(parsed.body, { format: parsed.format, flavor: parsed.flavor }), preview: parsed.preview }
        status = 201
      }
    } else if (action === 'putImage') {
      fields(body, ['mediaType', 'imageBase64'])
      result = profiles.putAvatarImage(body)
      status = result.unchanged ? 200 : 201
    } else if (action === 'draft') {
      fields(body, ['body', 'expectedRevision'])
      result = profiles.saveDraft(id, body.body, body.expectedRevision)
    } else if (action === 'activate') {
      fields(body, ['revision', 'expectedActiveRevision'])
      result = profiles.activate(id, body.revision, body.expectedActiveRevision)
    } else if (action === 'duplicate') {
      fields(body, ['revision', 'name'], [])
      result = profiles.duplicate(id, body.revision, { name: body.name })
      status = 201
    } else if (action === 'lifecycle') {
      fields(body, ['action'])
      result = profiles.lifecycle(id, body.action)
    } else {
      query(url, action === 'diff' ? ['from', 'to'] : action === 'export' ? ['format', 'revision'] : [])
      if (action === 'presets') result = profiles.toolPresets()
      else if (action === 'getImage') {
        const { bytes, ...image } = profiles.getAvatarImage(match[1])
        result = { ...image, imageBase64: bytes.toString('base64') }
      } else if (action === 'export') {
        const format = url.searchParams.get('format') ?? 'md'
        if (!AGENT_EXPORT_FORMATS.includes(format)) throw httpError('PROFILE_HTTP_INPUT', `format must be one of ${AGENT_EXPORT_FORMATS.join(', ')}`)
        const revision = url.searchParams.has('revision') ? revisionParam(url.searchParams.get('revision'), 'revision') : undefined
        const source = profiles.exportRevision(id, revision)
        result = { profileId: source.profileId, revision: source.revision, hash: source.hash, ...exportAgentFile(source.body, format) }
      } else if (action === 'get') {
        result = profiles.get(id)
        if (!result) throw httpError('PROFILE_NOT_FOUND', 'Profile does not exist', 404)
      } else if (action === 'revisions') result = profiles.revisions(id)
      else if (action === 'revision') result = profiles.getRevision(id, Number(match[2]))
      else result = profiles.diff(id, revisionParam(url.searchParams.get('from'), 'from'), revisionParam(url.searchParams.get('to'), 'to'))
    }
    send(status, result)
  } catch (error) {
    const known = typeof error.code === 'string' && Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599
    send(known ? error.httpStatus : 500, {
      code: known ? error.code : 'PROFILE_ERROR',
      error: known ? publicText(error.message, 2000) : 'Profile request could not be completed',
      // Conflicts carry the current revisions so the editor can reload instead of guessing.
      ...['headRevision', 'activeRevision'].reduce((extra, key) => {
        if (known && (error[key] === null || Number.isSafeInteger(error[key]))) extra[key] = error[key]
        return extra
      }, {}),
      ...(known && typeof error.lifecycle === 'string' ? { lifecycle: error.lifecycle } : {}),
    })
  }
  return true
}

/** Bridge mount: `if (await handleProfileHttp(req, res, url)) return`. */
export function createProfileHttpHandler({ store, ensureAuth, port = 39218 } = {}) {
  return (req, res, url) => handleProfileHttp(req, url, { store, ensureAuth, port, send: (status, data) => sendJson(res, status, data) })
}
