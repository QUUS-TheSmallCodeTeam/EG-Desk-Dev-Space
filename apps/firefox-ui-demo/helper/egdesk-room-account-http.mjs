import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'

// L1 c21, owner decision (2), provisional: POST /chat/room-account { clientThreadId, engineProfileId } switches THIS room to another account of
// its engine (the runtime's switchRoomAccount: same room, new native thread on the next message). Off (404) unless EGDESK_ROOM_ACCOUNT=on.
// Loopback JSON only. The answer is closed: { status, clientThreadId, engineProfileId } or { status: 'refused', code }.
export const ROOM_ACCOUNT_PATH = '/chat/room-account'
export function createRoomAccountHttpHandler({ chat, enabled = () => false, port = 39218 } = {}) {
  if (!chat) throw new TypeError('chat is required')
  return async (req, res, url) => {
    if (url.pathname !== ROOM_ACCOUNT_PATH) return false
    const reply = (code, body) => { if (!res.destroyed && !res.writableEnded) sendJson(res, code, body); return true }
    let on = false
    try { on = enabled() === true } catch { on = false }
    if (!on) return reply(404, { status: 'off' })
    if (!guardBridgeRequest(req, port)) return reply(403, { status: 'refused', code: 'LOOPBACK_REQUIRED' })
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, { status: 'refused', code: 'POST_REQUIRED' }) }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { status: 'refused', code: 'JSON_REQUIRED' })
    let body
    try { body = await readJsonBody(req, { maxBytes: 2048 }) } catch { return reply(400, { status: 'refused', code: 'INVALID' }) }
    try {
      const out = chat.switchRoomAccount({ clientThreadId: body?.clientThreadId, engineProfileId: body?.engineProfileId })
      return reply(200, { status: out.status, clientThreadId: out.clientThreadId, engineProfileId: out.engineProfileId })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'FAILED'
      const http = Number.isInteger(error?.httpStatus) ? error.httpStatus : Number.isInteger(error?.status) ? error.status : 409
      return reply(http >= 400 && http < 600 ? http : 409, { status: 'refused', code })
    }
  }
}
