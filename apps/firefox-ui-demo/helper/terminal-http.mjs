import { guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'
import { terminalDimensions } from './terminal-platform.mjs'
import { terminalResponseStatus } from './terminal-sessions.mjs'

const POST_FIELDS = new Map([
  ['/terminal/spawn', ['cols', 'rows', 'shellId', 'shell']],
  ['/terminal/write', ['sessionId', 'data']],
  ['/terminal/read', ['sessionId']],
  ['/terminal/resize', ['sessionId', 'cols', 'rows']],
  ['/terminal/kill', ['sessionId']],
  ['/terminal/detach', ['sessionId', 'bridgeInstance']],
  ['/terminal/attach', ['sessionId', 'bridgeInstance']],
  ['/terminal/close-local-scope', []],
  ['/terminal/open-url', ['sessionId', 'token', 'url']],
])
const bad = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus })

export function createTerminalHttpHandler({ registry, factory, port = 39218, urlOpen = null } = {}) {
  if (!registry || !factory || typeof factory.create !== 'function' || typeof factory.catalog !== 'function') {
    throw new TypeError('Terminal HTTP requires a registry and session factory')
  }
  const pendingScopes = new Map()
  const key = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
  return async (req, res, url) => {
    const route = url?.pathname || new URL(req.url, 'http://127.0.0.1').pathname
    if (route !== '/terminal/shells' && !POST_FIELDS.has(route)) return false
    if (route === '/terminal/open-url' && !urlOpen) return false // flag off: the route does not exist
    if (!guardBridgeRequest(req, typeof port === 'function' ? port() : port)) {
      sendJson(res, 403, { ok: false, code: 'LOOPBACK_REQUIRED', error: 'Loopback origin required' })
      return true
    }
    setBridgeCors(req, res)
    try {
      if (route === '/terminal/shells') {
        if (req.method !== 'GET') throw bad('METHOD_NOT_ALLOWED', 'Use GET for terminal shell capabilities', 405)
        sendJson(res, 200, { ...factory.catalog(), ...(urlOpen ? { openUrl: true } : {}) }) // c34/c35: the card learns that addresses may open in an EG-Desk Browser Card
        return true
      }
      if (req.method !== 'POST') throw bad('METHOD_NOT_ALLOWED', 'Use POST for terminal operations', 405)
      const body = await readJsonBody(req)
      if (Object.keys(body).some(key => !POST_FIELDS.get(route).includes(key))) {
        throw bad('INVALID_TERMINAL_REQUEST', 'Terminal request has an unsupported field')
      }
      // c34: the opener of a terminal session posts the address a program wants opened (its own per-session token, no owner/view scope: it runs in the shell, not in the card)
      if (route === '/terminal/open-url') { sendJson(res, 200, urlOpen.accept(body)); return true }
      const owner = req.headers['x-egdesk-terminal-owner']
      const view = req.headers['x-egdesk-terminal-view']
      if ((owner !== undefined || view !== undefined) &&
          (typeof owner !== 'string' || !key.test(owner) || typeof view !== 'string' || !key.test(view) ||
          (req.headers.origin !== undefined && !['chrome://browser', 'chrome://userchrome'].includes(req.headers.origin)))) {
        throw bad('TERMINAL_SCOPE_REQUIRED', 'Verified local terminal scope required', 403)
      }
      const lifecycle = ['/terminal/detach', '/terminal/attach', '/terminal/close-local-scope'].includes(route)
      if (lifecycle && !owner) throw bad('TERMINAL_SCOPE_REQUIRED', 'Verified local terminal scope required', 403)
      if (route === '/terminal/close-local-scope') {
        const pending = pendingScopes.get(owner)
        if (pending) pending.closed = true
        registry.closeLocalScope(owner)
        sendJson(res, 200, { ok: true, status: 'CLOSE_REQUESTED', exitConfirmed: false })
        return true
      }
      let result
      if (route === '/terminal/spawn') {
        let pending
        if (owner) {
          pending = pendingScopes.get(owner) || { count: 0, closed: false }
          if (pending.closed) throw bad('TERMINAL_SCOPE_CLOSED', 'Terminal scope is closing', 409)
          pendingScopes.set(owner, pending)
          pending.count++
        }
        try {
          const session = await factory.create(body)
          result = owner ? registry.ownLocal(session.id, owner, view) : registry.snapshot(session.id)
          if (pending?.closed) registry.closeLocalScope(owner)
        } finally {
          if (pending && --pending.count === 0) pendingScopes.delete(owner)
        }
      } else {
        if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 160 || body.sessionId.includes('\0')) {
          throw bad('INVALID_TERMINAL_SESSION', 'A terminal session ID is required')
        }
        if (lifecycle) {
          if (typeof body.bridgeInstance !== 'string' || !key.test(body.bridgeInstance)) throw bad('INVALID_TERMINAL_BRIDGE', 'A bridge instance is required')
          result = route === '/terminal/detach'
            ? registry.detachLocal(body.sessionId, owner, view, body.bridgeInstance)
            : registry.attachLocal(body.sessionId, owner, view, body.bridgeInstance)
        } else if ((result = registry.authorizeLocal(body.sessionId, owner, view))) {
          // Do not expose output or touch the native process on rejected ownership.
        } else if (route === '/terminal/write') {
          if (typeof body.data !== 'string' || Buffer.byteLength(body.data, 'utf8') > 64 * 1024) {
            throw bad('INVALID_TERMINAL_INPUT', 'Terminal input must be bounded text')
          }
          result = await registry.write(body.sessionId, body.data)
        } else if (route === '/terminal/read') result = registry.read(body.sessionId)
        else if (route === '/terminal/kill') result = await registry.kill(body.sessionId)
        else {
          if (body.cols === undefined || body.rows === undefined) throw bad('INVALID_TERMINAL_SIZE', 'Explicit resize dimensions are required')
          const { cols, rows } = terminalDimensions(body.cols, body.rows)
          result = await registry.resize(body.sessionId, cols, rows)
        }
      }
      sendJson(res, terminalResponseStatus(result), result)
    } catch (error) {
      sendJson(res, error.httpStatus || 500, { ok: false,
        code: error.code || 'TERMINAL_OPERATION_FAILED',
        error: publicText(error.message || 'Terminal operation failed', 2000),
        ...(error.transport ? { transport: error.transport, usePty: error.usePty, degraded: error.degraded } : {}),
        ...(Object.hasOwn(error, 'nativeCreated') ? { nativeCreated: error.nativeCreated } : {}),
      })
    }
    return true
  }
}
