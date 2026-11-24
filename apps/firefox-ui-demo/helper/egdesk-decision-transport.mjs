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
//  - Pre-connect: opens ONE TCP(+TLS) connection and parks it. No HTTP request, header, key or body is ever
//    written by the warm-up; it takes no credential. The next real request adopts the parked socket.
//    At most one warm-up per idle period; an unused warm socket is closed after `warmIdleMs`.
export const DECISION_IDLE_MS = 55_000
export const DECISION_HINT_MARGIN_MS = 1_000
export const DECISION_WARM_IDLE_MS = 15_000

const NULL_BODY = new Set([101, 204, 205, 304])
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 20 })

export function createDecisionTransport({ idleMs = DECISION_IDLE_MS, warmIdleMs = DECISION_WARM_IDLE_MS, agentOptions = {}, trace = null } = {}) {
  const stats = { requests: 0, reusedSockets: 0, sockets: 0, warmups: 0, warmupsSkipped: 0, warmAdopted: 0, warmExpired: 0, reusedSocketErrors: 0 }
  let warm = null // { socket, host, port, onTimeout, onError, onClose }
  let warmedSinceRequest = false // one warm-up per idle period: reset by a real request

  const dropWarm = (destroy = true) => {
    if (!warm) return
    const { socket, onTimeout, onError, onClose } = warm
    warm = null
    socket.off('timeout', onTimeout); socket.off('error', onError); socket.off('close', onClose)
    socket.setTimeout(0)
    if (destroy) socket.destroy()
  }
  const takeWarm = options => {
    if (!warm || warm.socket.destroyed || warm.host !== options.host || warm.port !== Number(options.port)) return null
    const { socket } = warm
    dropWarm(false)
    socket.ref()
    stats.warmAdopted++
    return socket
  }

  const make = Base => class DecisionAgent extends Base {
    createConnection(options, callback) {
      const adopted = takeWarm(options)
      if (adopted) return adopted
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
    'https:': new HttpsAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2, scheduling: 'lifo', timeout: idleMs, ...agentOptions }),
    'http:': new HttpAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2, scheduling: 'lifo', timeout: idleMs, ...agentOptions }),
  }
  const protocolOf = url => { if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Unsupported protocol'); return url.protocol }

  function fetch(endpoint, init = {}) {
    const url = new URL(String(endpoint)), protocol = protocolOf(url)
    const { signal } = init
    if (signal?.aborted) return Promise.reject(abortError())
    warmedSinceRequest = false
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
        if (req.reusedSocket) stats.reusedSocketErrors++
        // Never replayed here: the body may have reached the server.
        reject(Object.assign(error, { reusedSocket: req.reusedSocket === true }))
      })
      req.end(init.body)
    })
  }

  /** Content-free warm-up. Returns 'warmed' or 'skipped'. Takes no credential and writes nothing to the socket. */
  function preconnect(endpoint) {
    const url = new URL(String(endpoint)), protocol = protocolOf(url), agent = agents[protocol]
    const host = url.hostname, port = Number(url.port || (protocol === 'https:' ? 443 : 80))
    const parked = Object.values(agent.freeSockets).some(list => list.some(s => !s.destroyed))
    const busy = Object.values(agent.sockets).some(list => list.length > 0)
    if (warm || parked || busy || warmedSinceRequest) { stats.warmupsSkipped++; return 'skipped' }
    warmedSinceRequest = true
    stats.warmups++
    const options = { ...agent.options, host, port, servername: protocol === 'https:' && !/^[\d.:]+$/.test(host) ? host : undefined, path: null }
    options._agentKey = agent.getName(options)
    let socket
    try { socket = (protocol === 'https:' ? https.Agent : http.Agent).prototype.createConnection.call(agent, options) } catch { return 'skipped' }
    stats.sockets++
    socket.unref()
    const onTimeout = () => { stats.warmExpired++; dropWarm() }
    const onError = () => dropWarm()
    const onClose = () => dropWarm(false)
    warm = { socket, host, port, onTimeout, onError, onClose }
    socket.setTimeout(warmIdleMs)
    socket.on('timeout', onTimeout); socket.on('error', onError); socket.on('close', onClose)
    return 'warmed'
  }

  return Object.freeze({ fetch, preconnect, stats: () => ({ ...stats }), close() { dropWarm(); agents['https:'].destroy(); agents['http:'].destroy() } })
}
