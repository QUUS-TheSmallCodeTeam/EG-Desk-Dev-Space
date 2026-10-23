import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'

// Agent Profile routes over the local profile store. Same contract as the
// bridge: loopback/Origin guard, application/json bodies up to 64 KiB, and
// {code, error} failures with publicText messages.
const MAX_BODY = 65536
const ID = '([a-z0-9][a-z0-9-]{0,79})'
const ROUTES = [
  ['GET', /^\/profiles$/, 'list'],
  ['POST', /^\/profiles$/, 'create'],
  ['GET', new RegExp(`^/profiles/${ID}$`), 'get'],
  ['GET', new RegExp(`^/profiles/${ID}/revisions$`), 'revisions'],
  ['GET', new RegExp(`^/profiles/${ID}/revisions/([1-9]\\d{0,8})$`), 'revision'],
  ['PUT', new RegExp(`^/profiles/${ID}/draft$`), 'draft'],
  ['POST', new RegExp(`^/profiles/${ID}/activate$`), 'activate'],
  ['POST', new RegExp(`^/profiles/${ID}/lifecycle$`), 'lifecycle'],
  ['GET', new RegExp(`^/profiles/${ID}/diff$`), 'diff'],
]

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
 * GET /profiles[?includeArchived=true]       → {profiles}
 * POST /profiles {body}                      → 201 {id, revision, hash, unchanged, profile}
 * GET /profiles/:id                          → profile with active/head revisions
 * GET /profiles/:id/revisions[/:revision]    → summaries, or one revision with body
 * PUT /profiles/:id/draft {body, expectedRevision}
 * POST /profiles/:id/activate {revision, expectedActiveRevision}
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
    const body = ['create', 'draft', 'activate', 'lifecycle'].includes(action) ? await readJson(req, { maxBytes: MAX_BODY }) : null
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
      fields(body, ['body'])
      result = profiles.createDraft(body.body)
      status = 201
    } else if (action === 'draft') {
      fields(body, ['body', 'expectedRevision'])
      result = profiles.saveDraft(id, body.body, body.expectedRevision)
    } else if (action === 'activate') {
      fields(body, ['revision', 'expectedActiveRevision'])
      result = profiles.activate(id, body.revision, body.expectedActiveRevision)
    } else if (action === 'lifecycle') {
      fields(body, ['action'])
      result = profiles.lifecycle(id, body.action)
    } else {
      query(url, action === 'diff' ? ['from', 'to'] : [])
      if (action === 'get') {
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
