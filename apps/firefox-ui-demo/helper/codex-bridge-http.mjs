import { chatError, publicErrorKind, publicText, validateChatCwd } from './codex-chat-values.mjs'
import { applyRateLimitsUpdate, normalizeRateLimits } from './codex-account-usage.mjs'
import { ACCESS_FAILURE_KINDS, accessCause, accessFailureScope, publicAccessFailure, publicAuthIdentityKey } from './codex-auth-state.mjs'
import { BOARD_MEMBERS_PATH, readBoardMembers, writeBoardMembers } from './egdesk-board-members.mjs'

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

// POST routes → runtime method. 2-R additions:
//   /chat/board/send       → sendBoard (D-M2: @mentioned members or the Lead answer; 202)
//   /chat/share            → shareMessages (D-M3: copies into another conversation; 200)
//   /chat/subagent/reassign → reassignSubAgent (D-M1: a blocked sub-Agent's task to its parent; 202)
//   /chat/rooms/agent      → setRoomAgent (CHAT-01: the room's Agent picked without a send, null = plain Codex; 200)
const CHAT_ACTIONS = Object.freeze({
  '/chat/send': 'send', '/chat/resume': 'resume', '/chat/interrupt': 'interrupt', '/chat/approval': 'replyApproval',
  '/chat/user-input': 'replyUserInput', '/chat/fork': 'fork',
  '/chat/board/send': 'sendBoard', '/chat/share': 'shareMessages', '/chat/subagent/reassign': 'reassignSubAgent',
  '/chat/rooms/agent': 'setRoomAgent',
})
const SENDS = new Set(['/chat/send', '/chat/board/send'])
// CHAT-01: a local-store write like /chat/history/import — no engine, no turn —
// so it takes no engine account check: a pick made while signed out is still
// kept for the next start, and the offline QA restart probe can record one.
const LOCAL_WRITES = new Set(['/chat/rooms/agent'])

export function createChatHttpHandler(chat, ensureAuth, history = chat) {
  return async (req, res, url) => {
    const routes = new Set(Object.keys(CHAT_ACTIONS))
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
    // A server-owned origin lookup. IDs are selectors, never path/owner
    // authority; the runtime rechecks account and current root without RPCs.
    if (req.method === 'GET' && url.pathname === '/chat/run-project-origin') {
      try {
        if ([...url.searchParams.keys()].some(key => !['conversationId', 'runId'].includes(key))) throw chatError('INVALID_RUN_ORIGIN_QUERY', 'Only original conversation and run IDs are accepted')
        const query = {}
        for (const key of ['conversationId', 'runId']) {
          const values = url.searchParams.getAll(key)
          if (values.length !== 1 || !values[0].trim() || values[0].length > 300 || values[0].includes('\0')) throw chatError('INVALID_RUN_ORIGIN_QUERY', `Exactly one ${key} is required`)
          query[key] = values[0]
        }
        sendJson(res, 200, await chat.runProjectOrigin(query))
      } catch (cause) {
        sendJson(res, cause.httpStatus || 500, { code: cause.code || 'RUN_ORIGIN_ERROR', error: 'Run project origin could not be verified' })
      }
      return true
    }
    // CODE-05·06: a run's changed lines and command output, from bridge
    // memory (CodexChatRuntime.runChanges / commandOutput). Like /chat/state
    // they need no account call; runs of a signed-out account are gone.
    //   GET /chat/run-changes?conversationId=&runId=[&itemId=]
    //   GET /chat/command-output?conversationId=&runId=&itemId=
    if (req.method === 'GET' && (url.pathname === '/chat/run-changes' || url.pathname === '/chat/command-output')) {
      try {
        const id = (name, required = true) => {
          const value = url.searchParams.get(name)
          if (value === null && !required) return null
          if (typeof value !== 'string' || !value.trim() || value.length > 300) throw chatError('INVALID_RUN_OUTPUT_QUERY', `${name} is required`)
          return value
        }
        const query = { conversationId: id('conversationId'), runId: id('runId'), itemId: id('itemId', url.pathname === '/chat/command-output') }
        sendJson(res, 200, url.pathname === '/chat/run-changes' ? chat.runChanges(query) : chat.commandOutput(query))
      } catch (error) {
        sendJson(res, error.httpStatus || 500, { code: typeof error.code === 'string' ? error.code : 'RUN_OUTPUT_ERROR', error: publicText(error.message, 2000) })
      }
      return true
    }
    // CHAT-10: a Board room's members in the chat store (egdesk-board-members.mjs).
    // Local-store only like /chat/rooms/agent: no engine account check.
    if (url.pathname === BOARD_MEMBERS_PATH && (req.method === 'GET' || req.method === 'POST')) {
      if (!guardBridgeRequest(req)) {
        sendJson(res, 403, { code: 'BOARD_MEMBERS_LOOPBACK_REQUIRED', error: 'Untrusted Board members request origin' })
        return true
      }
      try {
        if (req.method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'clientThreadId') || url.searchParams.getAll('clientThreadId').length !== 1) {
            throw chatError('INVALID_BOARD_MEMBERS', 'Exactly one clientThreadId is required', 400)
          }
          sendJson(res, 200, readBoardMembers(chat, url.searchParams.get('clientThreadId')))
        } else sendJson(res, 200, writeBoardMembers(chat, await readJsonBody(req, { maxBytes: 65536 })))
      } catch (error) {
        sendJson(res, error.httpStatus || 500, { code: typeof error.code === 'string' ? error.code : 'BOARD_MEMBERS_ERROR', error: publicText(error.message, 2000) })
      }
      return true
    }
    if (req.method !== 'POST' || !routes.has(url.pathname)) return false
    let body = {}
    try {
      body = await readJsonBody(req, { maxBytes: SENDS.has(url.pathname) ? 2 * 1024 * 1024 : 65536 })
      // Reject explicit invalid context before even the authentication RPCs.
      if (SENDS.has(url.pathname)) validateChatCwd(body)
      // Existing correlated stop/denial is fail-safe even if account lookup is
      // unavailable. Runtime methods still verify connection, turn and callback.
      const isSafetyResponse = url.pathname === '/chat/interrupt'
        || (url.pathname === '/chat/approval' && ['decline', 'cancel'].includes(body.decision))
        || (url.pathname === '/chat/user-input' && body.action === 'skip')
      if (!isSafetyResponse && !LOCAL_WRITES.has(url.pathname)) await ensureAuth(body, { useAgent: SENDS.has(url.pathname), allowIsolated: true })
      const action = CHAT_ACTIONS[url.pathname]
      if (typeof chat[action] !== 'function') throw Object.assign(new Error('This bridge does not offer that chat action'), { code: 'CHAT_ACTION_UNAVAILABLE', httpStatus: 501 })
      const result = await chat[action](body)
      // A new branch is created (201); a retried one answers with it (200).
      sendJson(res, SENDS.has(url.pathname) || url.pathname === '/chat/subagent/reassign' ? 202 : url.pathname === '/chat/fork' && !result?.duplicate ? 201 : 200, result)
    } catch (error) {
      sendJson(res, error.httpStatus || 500, {
        accepted: false,
        conversationId: typeof error.conversationId === 'string' ? error.conversationId : (typeof body.conversationId === 'string' ? body.conversationId : ''),
        requestId: typeof error.requestId === 'string' ? error.requestId : (typeof body.requestId === 'string' ? body.requestId : null),
        ...(typeof error.resumeRequired === 'boolean' ? { resumeRequired: error.resumeRequired } : {}),
        ...(typeof error.stopRequired === 'boolean' ? { stopRequired: error.stopRequired } : {}),
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
 * POST /settings/computer-control {policy: 'inherit'|'off'} → 200 {policy, verified, persisted}
 * Loopback/Origin guard, an application/json object with exactly one key. No
 * Codex call is made, so it works signed out; the policy takes effect on the
 * next send and is saved for the next start. A failed save is not an error:
 * the policy still applies and persisted is false. /v1/state carries the same
 * {policy, verified, persisted} as computerControl.
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
 * SUB-14: the last auth/quota/permission rejection of a Codex turn, kept on
 * the auth state as `accessFailure` {kind, cause, at, identity} so that
 * auth.status and /v1/state can tell '인증 만료', '한도 도달' and '권한 부족'
 * apart from '로그인 필요' (codex-auth-state accountAccessState).
 * - an `error` the app-server will retry itself is not recorded;
 * - a failed turn/completed records; a completed one clears everything;
 * - turn/started clears a turn-scoped (policy/sandbox) cause only;
 * - a finished sign-in clears the previous sign-in's failure.
 * The identity is stored with the failure; another account never inherits it.
 * Definite turn/start RPC rejections use the same tracker, scoped to the
 * requesting identity and connection. Tracking never retries or wraps errors.
 */
export function createAccountAccessTracker({ auth, update, now = Date.now }) {
  const current = () => publicAccessFailure(auth()?.accessFailure)
  const set = failure => { if (JSON.stringify(current()) !== JSON.stringify(failure)) update({ accessFailure: failure }) }
  function record(error) {
    if (!error || typeof error !== 'object') return false
    const kind = publicErrorKind(error)
    if (!ACCESS_FAILURE_KINDS.includes(kind)) return false
    set(publicAccessFailure({ kind, cause: accessCause(error.codexErrorInfo), at: now(), identity: publicAuthIdentityKey(auth()) }))
    return true
  }
  function notify(message) {
    const params = message?.params
    switch (message?.method) {
      case 'error': return params?.willRetry === true ? false : record(params?.error)
      case 'turn/completed':
        if (params?.turn?.error) return record(params.turn.error)
        if (current()) set(null)
        return false
      case 'turn/started':
        if (accessFailureScope(current()) === 'turn') set(null)
        return false
      case 'account/login/completed':
        if (params?.success === true && current()) set(null)
        return false
      default: return false
    }
  }
  function requestRejectionKind(error) {
    const structured = publicErrorKind({ codexErrorInfo: error.codexErrorInfo, code: error.code })
    if (ACCESS_FAILURE_KINDS.includes(structured)) return structured
    if (error.codexErrorInfo != null || structured !== 'unknown') return null
    const message = error.message
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) return null
    // A bounded message grammar, not general provider-language inference:
    // leading declaration (optionally in a request-failure envelope), then
    // courtesy instructions. Quoted subjects are opaque, never declarations.
    const quoteEnds = new Map([["'", "'"], ['"', '"'], ['`', '`'], ['‘', '’'], ['“', '”']])
    const statements = []
    let text = '', quote = null
    const finish = question => {
      if (text.trim()) statements.push({ text: text.trim().replace(/\s+/g, ' '), question })
      text = ''
    }
    for (let index = 0; index < message.length; index++) {
      const char = message[index]
      if (quote) {
        if (char === '\\') index++
        else if (char === quote) quote = null
        continue
      }
      const apostrophe = (char === "'" || char === '’') && /[A-Za-z]/.test(message[index - 1] || '') && /[A-Za-z]/.test(message[index + 1] || '')
      if (!apostrophe && quoteEnds.has(char)) { quote = quoteEnds.get(char); text += ' \uFFFC '; continue }
      if (/[.!?;\r\n]/.test(char)) finish(char === '?')
      else text += char
    }
    if (quote) return null
    finish(false)
    const [first, ...advice] = statements
    if (!first || first.question || advice.some(item => !/^please\b/i.test(item.text))) return null
    const declaration = first.text.replace(/^request\s+failed\s*:\s*/i, '')
    const kind = publicErrorKind({ message: declaration })
    // Reuse the existing kinds, but require a complete declarative clause.
    // Unknown envelopes, qualifiers or continuations stay unclassified.
    const grammar = {
      quota: /^(?:(?:you(?: have|'ve)? )?(?:hit|reached|exceeded|exhausted) (?:(?:your|the|current|available) )*(?:usage limit|rate limit|quota)|(?:(?:your|the|current|available) )*(?:usage limit|rate limit|quota) (?:(?:has|have|is|was|been|now|already) )*(?:reached|exceeded|exhausted|depleted))$/i,
      auth: /^(?:unauthori[sz]ed|(?:you are )?not (?:logged|signed) in|(?:please )?(?:log|sign) in again|(?:please )?re-?authenticate|(?:your )?token (?:has )?expired)$/i,
      permission: /^(?:permission denied|access denied|forbidden|not permitted)(?: by policy)?$/i,
    }
    return grammar[kind]?.test(declaration) ? kind : null
  }
  async function request(method, dispatch, isCurrent = () => true) {
    if (method !== 'turn/start') return dispatch()
    const state = auth()
    const identity = state?.isLoggedIn === true ? publicAuthIdentityKey(state) : null
    try {
      return await dispatch()
    } catch (error) {
      // A definite RPC rejection is not proof of an account-access cause.
      // Keep ambiguous inspection/transport failures out of account state.
      try {
        const live = auth()
        if ((Number.isInteger(error?.code) || error?.definite === true) && error?.willRetry !== true
            && identity && live?.isLoggedIn === true && publicAuthIdentityKey(live) === identity && isCurrent()) {
          const kind = requestRejectionKind(error)
          if (kind) set(publicAccessFailure({ kind, cause: accessCause(error.codexErrorInfo), at: now(), identity }))
        }
      } catch { /* An account-state observer must not replace the RPC error. */ }
      throw error
    }
  }
  return { notify, current, request }
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
