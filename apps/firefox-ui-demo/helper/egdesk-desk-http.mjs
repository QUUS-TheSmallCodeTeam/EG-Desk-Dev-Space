import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'
import { MAX_BOARD_BODY_BYTES, MAX_DESK_STATE_BYTES } from './egdesk-desk-store.mjs'
import { boardToJsonCanvas } from './egdesk-json-canvas.mjs'

// RT-07 / CTX-01 / CTX-02 Desk and Board routes over the local Desk store.
// Same contract as the profile routes: loopback/Origin guard, application/json
// object bodies, {code, error} failures with publicText messages. Desk state
// and Board bodies can exceed the usual 64 KiB, so those two routes get their
// own body limit (store limit plus 64 KiB for the envelope); every other body
// stays at 64 KiB. Works while Codex is signed out (no auth call).
const SMALL_BODY = 65536
export const DESK_BODY_LIMITS = Object.freeze({
  small: SMALL_BODY,
  deskState: MAX_DESK_STATE_BYTES + SMALL_BODY,
  board: MAX_BOARD_BODY_BYTES + SMALL_BODY,
  // Earlier preference values: one Desk snapshot plus Boards, sent as text.
  import: 32 * 1024 * 1024,
})
const BOARD = '([A-Za-z0-9][A-Za-z0-9._-]{0,127})'
const NUMBER = '([1-9]\\d{0,15})'
const ROUTES = [
  // '_search' can never be a Board ID (IDs start with a letter or digit).
  ['GET', /^\/v1\/boards\/_search$/, 'search'],
  ['GET', /^\/v1\/desk\/current$/, 'current'],
  ['PUT', /^\/v1\/desk\/current$/, 'save'],
  ['GET', /^\/v1\/desk\/generations$/, 'generations'],
  ['GET', new RegExp(`^/v1/desk/generations/${NUMBER}$`), 'generation'],
  ['POST', /^\/v1\/desk\/restore$/, 'restore'],
  ['POST', /^\/v1\/desk\/import$/, 'import'],
  ['GET', /^\/v1\/boards$/, 'boards'],
  ['GET', new RegExp(`^/v1/boards/${BOARD}$`), 'board'],
  ['GET', new RegExp(`^/v1/boards/${BOARD}/export$`), 'exportBoard'],
  ['PUT', new RegExp(`^/v1/boards/${BOARD}$`), 'saveBoard'],
  ['GET', new RegExp(`^/v1/boards/${BOARD}/revisions$`), 'revisions'],
  ['GET', new RegExp(`^/v1/boards/${BOARD}/revisions/${NUMBER}$`), 'revision'],
  ['POST', new RegExp(`^/v1/boards/${BOARD}/revert$`), 'revert'],
  ['POST', new RegExp(`^/v1/boards/${BOARD}/merge$`), 'merge'],
]
const BODY_LIMIT = { save: 'deskState', saveBoard: 'board', import: 'import', restore: 'small', revert: 'small', merge: 'board' }
const QUERY_KEYS = { generations: ['limit', 'before'], revisions: ['limit', 'before'], search: ['q', 'limit'], exportBoard: ['format'] }

function httpError(code, message, httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus })
}
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) throw httpError('DESK_HTTP_INPUT', 'Invalid Desk request fields')
}
function query(url, allowed) {
  const keys = [...url.searchParams.keys()]
  if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length) throw httpError('DESK_HTTP_INPUT', 'Invalid Desk query')
}
function numberParam(url, name) {
  const value = url.searchParams.get(name)
  if (value === null) return undefined
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw httpError('DESK_HTTP_INPUT', `${name} must be a positive integer`)
  return Number(value)
}
const isDeskPath = pathname => pathname === '/v1/desk' || pathname.startsWith('/v1/desk/') || pathname === '/v1/boards' || pathname.startsWith('/v1/boards/')

/**
 * handleDeskHttp(req, url, {store, readJson, send, port}) → true when it owned the URL.
 * store: Desk store or () => store (null means storage is unavailable → 503).
 * GET  /v1/desk/current                         → newest generation with state (nulls when empty) + lastImport
 * PUT  /v1/desk/current {state, parentGeneration, reason?: autosave|explicit}
 *                                               → 201 new generation | 200 unchanged; 409 DESK_GENERATION_CONFLICT {generation, stateHash}
 * GET  /v1/desk/generations?limit=&before=      → {head, generations (no state), hasMore, nextBefore, retention}
 * GET  /v1/desk/generations/:g                  → one generation with state
 * POST /v1/desk/restore {generation, parentGeneration?} → 201 new restore generation | 200 unchanged
 * POST /v1/desk/import {deskSnapshot?, boards?: [{boardId, title?, body}]}
 *                                               → 201 imported | 200 {duplicate: true}
 * GET  /v1/boards                               → {boards}
 * GET  /v1/boards/:id                           → Board with head revision body
 * GET  /v1/boards/:id/export?format=json-canvas → {canvas, report} from the saved head; attachment records excluded
 * PUT  /v1/boards/:id {body, expectedRevision, title?}
 *                                               → 201 new revision | 200 unchanged; 409 BOARD_REVISION_CONFLICT {headRevision}
 * GET  /v1/boards/:id/revisions?limit=&before=  → summaries, newest first
 * GET  /v1/boards/:id/revisions/:revision       → one revision with body
 * POST /v1/boards/:id/revert {revision, expectedRevision?} → 201 new revision | 200 unchanged
 * GET  /v1/boards/_search?q=&limit=             → {query, index, boards: [Board summary + fields, snippet]}
 *                                                 (CTX-03: title, card names, memo text; best match first)
 * POST /v1/boards/:id/merge {body, baseRevision, prefer?: mine|theirs}
 *                                               → 200 {headRevision, body, hash, conflicts, clean, unchanged};
 *                                                 writes nothing (CTX-01: save the merged body with
 *                                                 expectedRevision = headRevision)
 */
export async function handleDeskHttp(req, url, { store, readJson = readJsonBody, send, port = 39218 } = {}) {
  if (!isDeskPath(url.pathname)) return false
  if (typeof send !== 'function') throw new TypeError('send is required')
  if (!guardBridgeRequest(req, port)) {
    send(403, { code: 'DESK_LOOPBACK_REQUIRED', error: 'Untrusted Desk request origin' })
    return true
  }
  try {
    let match = null, action = null, pathMatched = false
    for (const [method, pattern, name] of ROUTES) {
      const found = url.pathname.match(pattern)
      if (!found) continue
      pathMatched = true
      if (req.method === method) { match = found; action = name; break }
    }
    if (!action) throw pathMatched ? httpError('METHOD_NOT_ALLOWED', 'Method not allowed for this Desk endpoint', 405) : httpError('DESK_ROUTE_NOT_FOUND', 'Unknown Desk endpoint', 404)
    const body = BODY_LIMIT[action] ? await readJson(req, { maxBytes: DESK_BODY_LIMITS[BODY_LIMIT[action]] }) : null
    // Resolve after the await so a reopened store is the one written.
    const desk = typeof store === 'function' ? store() : store
    if (!desk) throw httpError('DESK_STORE_UNAVAILABLE', 'Local Desk storage is unavailable', 503)
    query(url, QUERY_KEYS[action] ?? [])
    let status = 200, result
    if (action === 'current') result = desk.current()
    else if (action === 'save') {
      fields(body, ['state', 'parentGeneration', 'reason'], ['state', 'parentGeneration'])
      result = desk.saveCurrent(body)
      status = result.unchanged ? 200 : 201
    } else if (action === 'generations') result = desk.generations({ limit: numberParam(url, 'limit'), before: numberParam(url, 'before') })
    else if (action === 'generation') result = desk.generation(Number(match[1]))
    else if (action === 'restore') {
      fields(body, ['generation', 'parentGeneration'], ['generation'])
      result = desk.restore(body)
      status = result.unchanged ? 200 : 201
    } else if (action === 'import') {
      fields(body, ['deskSnapshot', 'boards'], [])
      result = desk.importPrefs(body)
      status = result.duplicate ? 200 : 201
    } else if (action === 'boards') result = desk.listBoards()
    else if (action === 'board') {
      result = desk.board(match[1])
      if (!result) throw httpError('BOARD_NOT_FOUND', 'Board does not exist', 404)
    } else if (action === 'exportBoard') {
      if (url.searchParams.get('format') !== 'json-canvas') throw httpError('DESK_HTTP_INPUT', 'format must be json-canvas')
      const saved = desk.board(match[1])
      if (!saved) throw httpError('BOARD_NOT_FOUND', 'Board does not exist', 404)
      // Only the store's head is input. No renderer body, filesystem lookup or
      // attachment opt-in; preserve the converter's omission/report contract.
      result = boardToJsonCanvas(saved.head.body, { title: saved.title, includeAttachments: false })
    } else if (action === 'saveBoard') {
      fields(body, ['body', 'expectedRevision', 'title'], ['body', 'expectedRevision'])
      result = desk.saveBoard(match[1], body)
      status = result.unchanged ? 200 : 201
    } else if (action === 'revisions') result = desk.boardRevisions(match[1], { limit: numberParam(url, 'limit'), before: numberParam(url, 'before') })
    else if (action === 'revision') result = desk.boardRevision(match[1], Number(match[2]))
    else if (action === 'search') {
      const text = url.searchParams.get('q')
      result = desk.searchBoards({ query: text === null ? undefined : text, limit: numberParam(url, 'limit') })
    } else if (action === 'merge') {
      fields(body, ['body', 'baseRevision', 'prefer'], ['body', 'baseRevision'])
      result = desk.mergeBoard(match[1], body)
    } else {
      fields(body, ['revision', 'expectedRevision'], ['revision'])
      result = desk.revertBoard(match[1], body)
      status = result.unchanged ? 200 : 201
    }
    send(status, result)
  } catch (error) {
    const known = typeof error.code === 'string' && Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599
    send(known ? error.httpStatus : 500, {
      code: known ? error.code : 'DESK_ERROR',
      error: known ? publicText(error.message, 2000) : 'Desk request could not be completed',
      // Conflicts carry the latest generation/revision so the screen can reload instead of guessing.
      ...['generation', 'headRevision'].reduce((extra, key) => {
        if (known && (error[key] === null || Number.isSafeInteger(error[key]))) extra[key] = error[key]
        return extra
      }, {}),
      ...(known && (error.stateHash === null || (typeof error.stateHash === 'string' && /^[0-9a-f]{64}$/.test(error.stateHash))) ? { stateHash: error.stateHash } : {}),
    })
  }
  return true
}

/** Bridge mount: `if (await handleDeskHttp(req, res, url)) return`. */
export function createDeskHttpHandler({ store, port = 39218 } = {}) {
  return (req, res, url) => handleDeskHttp(req, url, { store, port, send: (status, data) => sendJson(res, status, data) })
}
