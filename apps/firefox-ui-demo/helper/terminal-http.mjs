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
])
const bad = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus })

export function createTerminalHttpHandler({ registry, factory, port = 39218 } = {}) {
  if (!registry || !factory || typeof factory.create !== 'function' || typeof factory.catalog !== 'function') {
    throw new TypeError('Terminal HTTP requires a registry and session factory')
  }
  return async (req, res, url) => {
    const route = url?.pathname || new URL(req.url, 'http://127.0.0.1').pathname
    if (route !== '/terminal/shells' && !POST_FIELDS.has(route)) return false
    if (!guardBridgeRequest(req, typeof port === 'function' ? port() : port)) {
      sendJson(res, 403, { ok: false, code: 'LOOPBACK_REQUIRED', error: 'Loopback origin required' })
      return true
    }
    setBridgeCors(req, res)
    try {
      if (route === '/terminal/shells') {
        if (req.method !== 'GET') throw bad('METHOD_NOT_ALLOWED', 'Use GET for terminal shell capabilities', 405)
        sendJson(res, 200, factory.catalog())
        return true
      }
      if (req.method !== 'POST') throw bad('METHOD_NOT_ALLOWED', 'Use POST for terminal operations', 405)
      const body = await readJsonBody(req)
      if (Object.keys(body).some(key => !POST_FIELDS.get(route).includes(key))) {
        throw bad('INVALID_TERMINAL_REQUEST', 'Terminal request has an unsupported field')
      }
      let result
      if (route === '/terminal/spawn') {
        const session = await factory.create(body)
        result = registry.snapshot(session.id)
      } else {
        if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 160 || body.sessionId.includes('\0')) {
          throw bad('INVALID_TERMINAL_SESSION', 'A terminal session ID is required')
        }
        if (route === '/terminal/write') {
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
