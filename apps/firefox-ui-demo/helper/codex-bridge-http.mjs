import { chatError, publicText, validateChatCwd } from './codex-chat-values.mjs'
import { applyRateLimitsUpdate, normalizeRateLimits } from './codex-account-usage.mjs'
import { publicAuthIdentityKey } from './codex-auth-state.mjs'

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

export async function readJsonBody(req, { maxBytes = 65536 } = {}) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw chatError('BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`, 413)
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

const queryInteger = (value, name, fallback, maximum) => {
  if (value === null) return fallback
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw chatError('INVALID_HISTORY_QUERY', `${name} must be a non-negative integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number > maximum) throw chatError('INVALID_HISTORY_QUERY', `${name} is out of range`)
  return number
}

const historyId = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw chatError('INVALID_HISTORY_QUERY', `${name} is required`)
  return value
}

export function createChatHttpHandler(chat, ensureAuth, history = chat) {
  return async (req, res, url) => {
    const routes = new Set(['/chat/send', '/chat/resume', '/chat/interrupt', '/chat/approval', '/chat/user-input', '/chat/fork'])
    if ((req.method === 'GET' && ['/chat/history/threads', '/chat/history'].includes(url.pathname)) ||
        (req.method === 'POST' && url.pathname === '/chat/history/import')) {
      try {
        if (req.method === 'GET' && url.pathname === '/chat/history/threads') {
          const cursor = url.searchParams.get('cursor')
          if (cursor !== null && cursor.length > 512) throw chatError('INVALID_HISTORY_QUERY', 'cursor is out of range')
          const limit = queryInteger(url.searchParams.get('limit'), 'limit', 50, 100)
          if (!limit) throw chatError('INVALID_HISTORY_QUERY', 'limit must be positive')
          sendJson(res, 200, await history.listLocalThreads({ cursor, limit }))
        } else if (req.method === 'GET') {
          const clientThreadId = historyId(url.searchParams.get('clientThreadId'), 'clientThreadId')
          const afterSeq = queryInteger(url.searchParams.get('afterSeq'), 'afterSeq', 0, Number.MAX_SAFE_INTEGER)
          const limit = queryInteger(url.searchParams.get('limit'), 'limit', 100, 500)
          if (!limit) throw chatError('INVALID_HISTORY_QUERY', 'limit must be positive')
          sendJson(res, 200, await history.getLocalHistory({ clientThreadId, afterSeq, limit }))
        } else {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024 * 1024 })
          historyId(body.clientThreadId, 'clientThreadId')
          historyId(body.importId, 'importId')
          const snapshot = body.snapshot
          if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.protocolVersion !== 2 || !Array.isArray(snapshot.runs)) {
            throw chatError('INVALID_HISTORY_IMPORT', 'Expected a public v2 chat snapshot')
          }
          const result = await history.importLocalHistory(body)
          sendJson(res, result.alreadyImported ? 200 : 201, result)
        }
      } catch (error) {
        sendJson(res, error.httpStatus || 500, {
          code: typeof error.code === 'string' ? error.code : 'CHAT_HISTORY_ERROR',
          error: publicText(error.message, 2000),
        })
      }
      return true
    }
    if (req.method === 'GET' && url.pathname === '/chat/state') {
      sendJson(res, 200, chat.snapshot(url.searchParams.get('conversationId')))
      return true
    }
    if (req.method !== 'POST' || !routes.has(url.pathname)) return false
    let body = {}
    try {
      body = await readJsonBody(req, { maxBytes: url.pathname === '/chat/send' ? 2 * 1024 * 1024 : 65536 })
      // Reject explicit invalid context before even the authentication RPCs.
      if (url.pathname === '/chat/send') validateChatCwd(body)
      // Existing correlated stop/denial is fail-safe even if account lookup is
      // unavailable. Runtime methods still verify connection, turn and callback.
      const isSafetyResponse = url.pathname === '/chat/interrupt'
        || (url.pathname === '/chat/approval' && ['decline', 'cancel'].includes(body.decision))
        || (url.pathname === '/chat/user-input' && body.action === 'skip')
      if (!isSafetyResponse) await ensureAuth(body)
      const action = { '/chat/send': 'send', '/chat/resume': 'resume', '/chat/interrupt': 'interrupt', '/chat/approval': 'replyApproval', '/chat/user-input': 'replyUserInput', '/chat/fork': 'fork' }[url.pathname]
      const result = await chat[action](body)
      // A new branch is created (201); a retried one answers with it (200).
      sendJson(res, url.pathname === '/chat/send' ? 202 : url.pathname === '/chat/fork' && !result?.duplicate ? 201 : 200, result)
    } catch (error) {
      sendJson(res, error.httpStatus || 500, {
        accepted: false,
        conversationId: typeof error.conversationId === 'string' ? error.conversationId : (typeof body.conversationId === 'string' ? body.conversationId : ''),
        requestId: typeof error.requestId === 'string' ? error.requestId : (typeof body.requestId === 'string' ? body.requestId : null),
        ...(typeof error.resumeRequired === 'boolean' ? { resumeRequired: error.resumeRequired } : {}),
        ...(typeof error.saved === 'boolean' ? { saved: error.saved } : {}),
        ...(typeof error.durable === 'boolean' ? { durable: error.durable } : {}),
        ...(typeof error.dispatchStatus === 'string' ? { dispatchStatus: error.dispatchStatus } : {}),
        ...(['clientThreadId', 'localConversationId', 'localRunId', 'localMessageId'].reduce((fields, key) => {
          if (typeof error[key] === 'string') fields[key] = error[key]
          return fields
        }, {})),
        code: typeof error.code === 'string' ? error.code : 'CHAT_ERROR',
        error: publicText(error.message, 2000),
      })
    }
    return true
  }
}

/**
 * CU-01 computer control setting for ordinary Codex threads.
 * POST /settings/computer-control {policy: 'inherit'|'off'} → 200 {policy, verified}
 * Loopback/Origin guard, an application/json object with exactly one key. No
 * Codex call is made, so it works signed out; the policy takes effect on the
 * next send. /v1/state carries the same {policy, verified} as computerControl.
 */
export function createComputerControlHttpHandler(chat, { port = 39218 } = {}) {
  return async (req, res, url) => {
    if (url.pathname !== '/settings/computer-control') return false
    if (!guardBridgeRequest(req, port)) {
      sendJson(res, 403, { code: 'SETTINGS_LOOPBACK_REQUIRED', error: 'Untrusted settings request origin' })
      return true
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'Use POST with {policy}' })
      return true
    }
    try {
      const body = await readJsonBody(req, { maxBytes: 1024 })
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'policy')) throw chatError('INVALID_COMPUTER_CONTROL_POLICY', "Send exactly {policy: 'inherit' | 'off'}", 400)
      sendJson(res, 200, chat.setComputerControlPolicy(body.policy))
    } catch (error) {
      sendJson(res, error.httpStatus || 500, { code: typeof error.code === 'string' ? error.code : 'SETTINGS_ERROR', error: publicText(error.message, 2000) })
    }
    return true
  }
}

/**
 * ChatGPT usage for the signed-in identity (account/rateLimits/read and the
 * sparse account/rateLimits/updated notification).
 * - A read answered after a sign-out or account switch is dropped.
 * - A failed read changes nothing: no invented 0%, the last value goes stale.
 * - Reads for one identity are coalesced and, unless forced, throttled.
 * auth() → current auth state ({isLoggedIn, accountId, accountEmail, rateLimits}).
 * update(patch) applies {rateLimits} to that state and broadcasts it.
 */
export function createRateLimitSync({ request, auth, ready = () => true, update, now = Date.now, minIntervalMs = 60_000 }) {
  let inFlight = null, checked = null
  const owner = () => { const state = auth(); return state?.isLoggedIn ? publicAuthIdentityKey(state) : null }
  function refresh({ force = false } = {}) {
    const identity = owner()
    if (!identity || !ready()) return Promise.resolve()
    if (inFlight?.identity === identity) return inFlight.promise
    if (!force && checked?.identity === identity && now() - checked.at < minIntervalMs) return Promise.resolve()
    checked = { identity, at: now() }
    const read = { identity, promise: null }
    let answer
    try { answer = Promise.resolve(request('account/rateLimits/read', { excludeResetCreditDetails: true })) }
    catch (error) { answer = Promise.reject(error) }
    read.promise = answer
      .then(result => { if (owner() === identity) update({ rateLimits: normalizeRateLimits(result, now()) }) })
      .catch(() => {})
      .finally(() => { if (inFlight === read) inFlight = null })
    inFlight = read
    return read.promise
  }
  function notify(message) {
    if (message?.method !== 'account/rateLimits/updated' || !owner()) return false
    update({ rateLimits: applyRateLimitsUpdate(auth().rateLimits ?? null, message.params, now()) })
    return true
  }
  return { refresh, notify }
}

/**
 * Wait before reconnect attempt `failures` (1 = first retry): 1s, 2s, 4s …
 * capped at maxMs, shortened by up to `jitter` of itself so restarted
 * clients do not retry in step. random() → [0, 1).
 */
export function backoffDelayMs(failures, { initialMs = 1000, maxMs = 30_000, jitter = 0.2, random = Math.random } = {}) {
  const step = Math.max(1, Math.floor(Number(failures) || 1))
  const base = Math.min(maxMs, initialMs * 2 ** Math.min(step - 1, 30))
  return Math.max(0, Math.round(base - base * jitter * random()))
}

/**
 * Consecutive app-server reconnect failures for /v1/state: a count and the
 * next attempt time only, never the failure text. reset() after a ready
 * connection starts the next loss again at the initial delay.
 */
export function createReconnectBackoff({ now = Date.now, ...delay } = {}) {
  let failures = 0, nextAttemptAt = null
  return {
    next() {
      failures += 1
      const ms = backoffDelayMs(failures, delay)
      nextAttemptAt = now() + ms
      return ms
    },
    attempting() { nextAttemptAt = null },
    reset() { failures = 0; nextAttemptAt = null },
    snapshot() { return { consecutiveFailures: failures, nextAttemptAt } },
  }
}
