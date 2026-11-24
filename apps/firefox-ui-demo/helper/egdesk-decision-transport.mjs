import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'

// Keep-alive transport for the single Decisions endpoint, built only on node:http(s).
// Used by the decision client as `fetchImpl`; nothing else in the app uses it.
//
//  - Connection reuse: one free-socket pool. A free socket is dropped after the idle cap, or earlier when the
//    server sent `Keep-Alive: timeout=N` (N seconds minus a margin, so we close before the server does).
//    Without a hint the cap is a conservative guess; the real server limit is measured, not assumed.
//  - No automatic retry, ever. node:http never replays a request, and this adapter does not either. A reused
//    socket that fails is reported as an error; the caller decides (the decision client reports `unreachable`,
//    dispatched = true, because the request may already have been processed and billed).
export const DECISION_IDLE_MS = 55_000
export const DECISION_HINT_MARGIN_MS = 1_000

const NULL_BODY = new Set([101, 204, 205, 304])
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 20 })

export function createDecisionTransport({ idleMs = DECISION_IDLE_MS, agentOptions = {}, trace = null } = {}) {
  const stats = { requests: 0, reusedSockets: 0, sockets: 0, reusedSocketErrors: 0 }
  const make = Base => class DecisionAgent extends Base {
    createConnection(options, callback) {
      stats.sockets++
      return super.createConnection(options, callback)
    }
    keepSocketAlive(socket) {
      if (!super.keepSocketAlive(socket)) return false
      let limit = idleMs
      const hint = /(?:^|[,\s])timeout=(\d+)/.exec(String(socket._httpMessage?.res?.headers?.['keep-alive'] ?? ''))?.[1]
      if (hint !== undefined) limit = Math.min(limit, Number(hint) * 1000 - DECISION_HINT_MARGIN_MS)
      if (!(limit > 0)) return false
      socket.setTimeout(limit)
      return true
    }
  }
  const HttpsAgent = make(https.Agent)
  const HttpAgent = make(http.Agent)
  const agents = {
    'https:': new HttpsAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, scheduling: 'lifo', timeout: idleMs, ...agentOptions }),
    'http:': new HttpAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, scheduling: 'lifo', timeout: idleMs, ...agentOptions }),
  }
  const protocolOf = url => { if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Unsupported protocol'); return url.protocol }

  function fetch(endpoint, init = {}) {
    const url = new URL(String(endpoint)), protocol = protocolOf(url)
    const { signal } = init
    if (signal?.aborted) return Promise.reject(abortError())
    stats.requests++
    return new Promise((resolve, reject) => {
      const lib = protocol === 'https:' ? https : http
      const req = lib.request(url, { method: init.method ?? 'GET', headers: init.headers, agent: agents[protocol] }, res => {
        signal?.removeEventListener('abort', onAbort)
        // redirect: 'error'
        if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); reject(new TypeError('Unexpected redirect')); return }
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item)
        resolve(new Response(NULL_BODY.has(res.statusCode) ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers }))
      })
      const onAbort = () => req.destroy(abortError())
      signal?.addEventListener('abort', onAbort, { once: true })
      // Optional data-free timing trace for measurement: phase names and monotonic times only.
      const mark = phase => { try { trace?.({ phase, t: performance.now(), reused: req.reusedSocket === true }) } catch { /* observer only */ } }
      mark('start')
      req.on('socket', socket => {
        if (req.reusedSocket) stats.reusedSockets++
        socket.ref?.()
        if (trace && socket.connecting) { socket.once('lookup', () => mark('lookup')); socket.once('connect', () => mark('connect')); socket.once('secureConnect', () => mark('secureConnect')) }
      })
      req.on('response', () => mark('response'))
      req.on('error', error => {
        signal?.removeEventListener('abort', onAbort)
        // Only transport failures count; our own abort/timeout of a pending request is not a stale-socket error.
        if (req.reusedSocket && !signal?.aborted) stats.reusedSocketErrors++
        // Never replayed here: the body may have reached the server.
        reject(Object.assign(error, { reusedSocket: req.reusedSocket === true }))
      })
      req.end(init.body)
    })
  }

  // warm(): a kept-alive socket is free for the next request right now (the pools' own state: a socket idle past its cap, or past the
  // server's Keep-Alive hint, has already been dropped). false on a cold process, after the idle window, or when every socket is busy.
  const warm = () => Object.values(agents).some(agent => Object.values(agent.freeSockets ?? {}).some(list => Array.isArray(list) && list.some(socket => !socket.destroyed)))
  return Object.freeze({ fetch, warm, stats: () => ({ ...stats }), close() { agents['https:'].destroy(); agents['http:'].destroy() } })
}
