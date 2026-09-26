import { chatError, publicText, validateChatCwd } from './codex-chat-values.mjs'

// Verified Firefox chrome and local CLI callers can omit Origin.
// Ordinary web origins must match this loopback service; never echo arbitrary origins.
export function guardBridgeRequest(req, port = 39218) {
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) return false
  const local = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  if (req.socket?.remoteAddress && !local.has(req.socket.remoteAddress)) return false
  if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(req.headers.host)) return false
  const fetchSite = req.headers['sec-fetch-site']
  // Opaque pages on another loopback port can be same-site. Present metadata
  // must identify a trusted initiation context; omission remains valid for CLI.
  if (Object.hasOwn(req.headers, 'sec-fetch-site') && !['none', 'same-origin'].includes(fetchSite)) return false
  const origin = req.headers.origin
  return origin === undefined || ['chrome://browser', 'chrome://userchrome', `http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin)
}

export function setBridgeCors(req, res) {
  if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
  res.setHeader('Vary', 'Origin')
}

export async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) throw chatError('BODY_TOO_LARGE', 'Request body exceeds 64 KiB', 413)
    chunks.push(chunk)
  }
  if (!size) return {}
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw chatError('CONTENT_TYPE', 'Expected application/json', 415)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body
  } catch { throw chatError('INVALID_JSON', 'Expected a JSON object') }
}

export function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function createChatHttpHandler(chat, ensureAuth) {
  return async (req, res, url) => {
    const routes = new Set(['/chat/send', '/chat/resume', '/chat/interrupt', '/chat/approval'])
    if (req.method === 'GET' && url.pathname === '/chat/state') {
      sendJson(res, 200, chat.snapshot(url.searchParams.get('conversationId')))
      return true
    }
    if (req.method !== 'POST' || !routes.has(url.pathname)) return false
    let body = {}
    try {
      body = await readJsonBody(req)
      // Reject explicit invalid context before even the authentication RPCs.
      if (url.pathname === '/chat/send') validateChatCwd(body)
      // Existing correlated stop/denial is fail-safe even if account lookup is
      // unavailable. Runtime methods still verify connection, turn and callback.
      const isSafetyResponse = url.pathname === '/chat/interrupt'
        || (url.pathname === '/chat/approval' && ['decline', 'cancel'].includes(body.decision))
      if (!isSafetyResponse) await ensureAuth()
      const action = { '/chat/send': 'send', '/chat/resume': 'resume', '/chat/interrupt': 'interrupt', '/chat/approval': 'replyApproval' }[url.pathname]
      const result = await chat[action](body)
      sendJson(res, url.pathname === '/chat/send' ? 202 : 200, result)
    } catch (error) {
      sendJson(res, error.httpStatus || 500, {
        accepted: false,
        conversationId: typeof error.conversationId === 'string' ? error.conversationId : (typeof body.conversationId === 'string' ? body.conversationId : ''),
        requestId: typeof error.requestId === 'string' ? error.requestId : (typeof body.requestId === 'string' ? body.requestId : null),
        ...(typeof error.resumeRequired === 'boolean' ? { resumeRequired: error.resumeRequired } : {}),
        code: typeof error.code === 'string' ? error.code : 'CHAT_ERROR',
        error: publicText(error.message, 2000),
      })
    }
    return true
  }
}
