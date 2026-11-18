import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { BoardAskError, boardAskPublicError } from './egdesk-board-agent-ask.mjs'

const ROOT = '/v1/board-agent-ask'
const limits = { policy: 80 * 1024, prepare: 80 * 1024, run: 256, cancel: 256 }

export function createBoardAgentAskHttpHandler({ service, port = 39218 } = {}) {
  return async (req, res, url) => {
    if (url.pathname !== ROOT && !url.pathname.startsWith(ROOT + '/')) return false
    const send = (status, data) => { if (!res.destroyed) sendJson(res, status, data) }
    if (!guardBridgeRequest(req, port)) {
      send(403, { code: 'BOARD_AGENT_ASK_LOOPBACK_REQUIRED', error: 'Loopback origin required' })
      return true
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (res.destroyed) abort()
    res.once('close', abort)
    try {
      const action = url.pathname.slice(ROOT.length + 1)
      if (!Object.hasOwn(limits, action)) throw new BoardAskError('ROUTE', 'Unknown Board Agent ask route', 404)
      if (req.method !== 'POST') throw new BoardAskError('METHOD', 'Expected POST', 405)
      if (url.search) throw new BoardAskError('INPUT', 'Unexpected query fields', 400)
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new BoardAskError('CONTENT_TYPE', 'Expected application/json', 415)
      const maxBytes = limits[action]
      if (Number(req.headers['content-length']) > maxBytes) throw new BoardAskError('BODY_TOO_LARGE', 'Board Agent ask body too large', 413)
      const body = await readJsonBody(req, { maxBytes })
      if (controller.signal.aborted) return true
      const value = await service[action](body, { signal: controller.signal })
      send(200, value)
    } catch (error) {
      const result = error?.code === 'BODY_TOO_LARGE' ? { status: 413, code: 'BOARD_AGENT_ASK_BODY_TOO_LARGE', error: 'Board Agent ask body too large' }
        : error?.code === 'INVALID_JSON' ? { status: 400, code: 'BOARD_AGENT_ASK_INPUT', error: 'Expected a JSON object' }
        : boardAskPublicError(error)
      const { status, ...publicBody } = result
      send(status, publicBody)
    } finally { res.off('close', abort) }
    return true
  }
}
