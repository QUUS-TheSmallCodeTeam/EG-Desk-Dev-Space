import { randomUUID } from 'node:crypto'
import { guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'

/**
 * RT-06 workflow event bus: one normalized stream for things that happen
 * outside a chat turn (a Terminal process exits, Codex sign-in changes, a file
 * in a connected folder changes, a Browser card navigates or finishes an OAuth
 * redirect, the user presses "continue"). Task gates and the screen consume it.
 *
 * Every payload has a fixed shape per topic. URLs keep only origin + path,
 * file paths stay relative to their connected root, and auth carries only
 * signedIn. Delivery is per owner scope, serial per subscriber, and bounded:
 * a slow subscriber loses its oldest queued events (counted), never memory.
 *
 * BRW-04: a Browser event from a popup card may also carry openerCardId, the
 * card the popup chain started from, so a sign-in finished in the popup can
 * open a gate that names the original card (see egdesk-await-router.mjs). It is
 * optional and opaque; null or absent means "no opener" and is left out.
 */
export const WORKFLOW_TOPICS = Object.freeze([
  'terminal.exit', 'auth.changed', 'file.changed', 'browser.navigated', 'browser.oauthCompleted', 'user.action',
  // BRW-04 (D-B11, inferred): a card finished loading its document, and a
  // popup card closed (by its page or by the person), naming its opener.
  'browser.loaded', 'browser.popupClosed',
])
const SOURCES = new Map([
  ['terminal.exit', 'terminal'], ['auth.changed', 'auth'], ['file.changed', 'file'],
  ['browser.navigated', 'browser'], ['browser.oauthCompleted', 'browser'], ['user.action', 'manual'],
  ['browser.loaded', 'browser'], ['browser.popupClosed', 'browser'],
])
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const CONTROL = /[\u0000-\u001f\u007f]/

export function workflowEventError(code, message, httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus })
}
const fail = (message, code = 'WORKFLOW_EVENT_INPUT', status = 400) => { throw workflowEventError(code, message, status) }

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Event payload must be an object')
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Event payload field is not allowed: ${key}`)
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`Event payload field is required: ${key}`)
  return value
}
const opaque = (value, name, max = 160) => {
  if (typeof value !== 'string' || !value || value.length > max || !ID.test(value)) fail(`${name} must be an opaque ID`)
  return value
}

/** Keeps only origin + path of an http(s) URL; query, fragment and userinfo never pass. */
export function publicBrowserLocation(value) {
  if (typeof value !== 'string' || value.length > 8192 || CONTROL.test(value)) fail('url must be an http(s) URL')
  let url
  try { url = new URL(value) } catch { fail('url must be an http(s) URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('url must be an http(s) URL')
  const path = url.pathname || '/'
  if (path.length > 2048) fail('url path is too long')
  return { origin: url.origin, path }
}

/** A connected-root relative path in POSIX form; never absolute, never escaping. */
export function relativeRootPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || CONTROL.test(value) || value.includes('\\')) return null
  if (value.startsWith('/')) return null
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return null
  return value
}

function originPath(value, name) {
  const location = publicBrowserLocation(`${value?.origin ?? ''}${value?.path ?? ''}`)
  if (location.origin !== value.origin || location.path !== value.path) fail(`${name} must be a canonical origin and path`)
  return location
}

/**
 * A popup card names the card its popup chain started from (BRW-04). Optional:
 * undefined or null mean no opener. A card is never its own opener.
 */
function openerCardOf(value, cardId) {
  if (value === undefined || value === null) return null
  const openerCardId = opaque(value, 'openerCardId')
  if (openerCardId === cardId) fail('openerCardId must name the card that opened this one, not the card itself')
  return openerCardId
}

function browserCardLocation(payload) {
  exactKeys(payload, ['cardId', 'origin', 'path'], ['openerCardId'])
  const cardId = opaque(payload.cardId, 'cardId')
  const openerCardId = openerCardOf(payload.openerCardId, cardId)
  return { cardId, ...originPath(payload, 'browser location'), ...(openerCardId ? { openerCardId } : {}) }
}

const NORMALIZERS = {
  'terminal.exit': payload => {
    exactKeys(payload, ['sessionId', 'exitCode'], ['signal'])
    if (payload.exitCode !== null && !Number.isSafeInteger(payload.exitCode)) fail('exitCode must be an integer or null')
    const signal = payload.signal ?? null
    if (signal !== null && !Number.isSafeInteger(signal) && !(typeof signal === 'string' && /^[A-Z0-9]{1,32}$/.test(signal))) fail('signal must be a signal name, number or null')
    return { sessionId: opaque(payload.sessionId, 'sessionId'), exitCode: payload.exitCode, signal }
  },
  'auth.changed': payload => {
    exactKeys(payload, ['signedIn'])
    if (typeof payload.signedIn !== 'boolean') fail('signedIn must be true or false')
    return { signedIn: payload.signedIn }
  },
  'file.changed': payload => {
    exactKeys(payload, ['rootId', 'relativePath', 'change'])
    const relativePath = relativeRootPath(payload.relativePath)
    if (!relativePath) fail('relativePath must stay inside its connected root')
    if (payload.change !== 'change' && payload.change !== 'rename') fail('change must be change or rename')
    return { rootId: opaque(payload.rootId, 'rootId', 256), relativePath, change: payload.change }
  },
  'browser.navigated': payload => browserCardLocation(payload),
  'browser.oauthCompleted': payload => browserCardLocation(payload),
  'browser.loaded': payload => browserCardLocation(payload),
  // The popup's last location, its opener (required) and who closed it.
  'browser.popupClosed': payload => {
    exactKeys(payload, ['cardId', 'origin', 'path', 'openerCardId', 'closedBy'])
    const cardId = opaque(payload.cardId, 'cardId')
    const openerCardId = openerCardOf(payload.openerCardId, cardId)
    if (!openerCardId) fail('openerCardId is required for a popup')
    if (payload.closedBy !== 'page' && payload.closedBy !== 'user') fail('closedBy must be page or user')
    return { cardId, ...originPath(payload, 'browser location'), openerCardId, closedBy: payload.closedBy }
  },
  'user.action': payload => {
    exactKeys(payload, ['graphId', 'taskId', 'gateId'])
    return { graphId: opaque(payload.graphId, 'graphId', 256), taskId: opaque(payload.taskId, 'taskId', 256), gateId: opaque(payload.gateId, 'gateId', 256) }
  },
}

function summaryOf(topic, payload) {
  switch (topic) {
    case 'terminal.exit': return payload.exitCode === null ? 'Terminal process ended' : `Terminal process exited with code ${payload.exitCode}`
    case 'auth.changed': return payload.signedIn ? 'Signed in' : 'Signed out'
    case 'file.changed': return `File ${payload.change === 'rename' ? 'added, moved or removed' : 'changed'}: ${payload.relativePath}`
    case 'browser.navigated': return `Browser opened ${payload.origin}${payload.path}`
    case 'browser.oauthCompleted': return `Browser sign-in finished at ${payload.origin}${payload.path}`
    case 'browser.loaded': return `Browser loaded ${payload.origin}${payload.path}`
    case 'browser.popupClosed': return payload.closedBy === 'page' ? 'Browser popup closed itself' : 'Browser popup closed by the user'
    case 'user.action': return 'Continued by the user'
    default: return ''
  }
}

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child) }
  return value
}

/**
 * createWorkflowEventBus() -> { publish, subscribe, recent, flush, stats, close }
 * publish({ topic, owner, payload }) -> frozen event { seq, id, at, topic, source, summary, payload } or null when rate-limited.
 * subscribe({ owner, topics? }, listener) -> unsubscribe. Listeners run after a
 * microtask, one event at a time; a returned promise is awaited before the next.
 * flush() resolves once every subscriber has handled what was queued.
 */
export function createWorkflowEventBus({ maxRecent = 256, maxQueue = 256, maxPerTopicPerSecond = 100, now = Date.now } = {}) {
  for (const [name, value] of Object.entries({ maxRecent, maxQueue, maxPerTopicPerSecond })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new TypeError(`${name} must be a positive bounded integer`)
  }
  const recentEvents = []
  const subscribers = new Set()
  const windows = new Map(WORKFLOW_TOPICS.map(topic => [topic, { start: 0, count: 0 }]))
  let seq = 0
  let dropped = 0
  let rateLimited = 0
  let closed = false

  const ownerOf = owner => {
    if (typeof owner !== 'string' || !owner || owner.length > 128 || CONTROL.test(owner)) throw new TypeError('An owner scope is required')
    return owner
  }

  function kick(subscriber) {
    if (subscriber.running || !subscriber.queue.length) return
    subscriber.running = (async () => {
      await null
      try {
        while (subscriber.queue.length && !subscriber.closed) {
          const entry = subscriber.queue.shift()
          try { await subscriber.listener(entry) } catch { /* a listener never alters the stream */ }
        }
      } finally { subscriber.running = null }
    })()
  }

  function publish({ topic, owner, payload } = {}) {
    if (closed) return null
    const scope = ownerOf(owner)
    const normalize = NORMALIZERS[topic]
    if (!normalize) fail('Unknown workflow event topic', 'WORKFLOW_EVENT_TOPIC')
    const clean = normalize(payload)
    const at = now()
    const window = windows.get(topic)
    if (at - window.start >= 1000) { window.start = at; window.count = 0 }
    if (window.count >= maxPerTopicPerSecond) { rateLimited += 1; return null }
    window.count += 1
    seq += 1
    const event = deepFreeze({
      seq, id: `wfe-${randomUUID()}`, at: new Date(at).toISOString(), topic,
      source: SOURCES.get(topic), summary: summaryOf(topic, clean), payload: clean,
    })
    recentEvents.push({ owner: scope, event })
    if (recentEvents.length > maxRecent) recentEvents.shift()
    for (const subscriber of subscribers) {
      if (subscriber.owner !== scope || !subscriber.topics.has(topic)) continue
      if (subscriber.queue.length >= maxQueue) { subscriber.queue.shift(); subscriber.dropped += 1; dropped += 1 }
      subscriber.queue.push(event)
      kick(subscriber)
    }
    return event
  }

  function subscribe({ owner, topics = WORKFLOW_TOPICS } = {}, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    if (!Array.isArray(topics) || !topics.length || topics.some(topic => !SOURCES.has(topic))) throw new TypeError('topics must be known workflow topics')
    const subscriber = { owner: ownerOf(owner), topics: new Set(topics), listener, queue: [], running: null, dropped: 0, closed: false }
    subscribers.add(subscriber)
    return () => { subscriber.closed = true; subscriber.queue = []; subscribers.delete(subscriber) }
  }

  function recent({ owner, since = 0, limit = maxRecent } = {}) {
    const scope = ownerOf(owner)
    if (!Number.isSafeInteger(since) || since < 0) fail('since must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRecent) fail(`limit must be 1-${maxRecent}`)
    const events = recentEvents.filter(entry => entry.owner === scope && entry.event.seq > since).map(entry => entry.event).slice(-limit)
    return { seq, oldestSeq: recentEvents[0]?.event.seq ?? null, events }
  }

  async function flush() {
    for (let round = 0; round < 64; round += 1) {
      const pending = [...subscribers].map(subscriber => subscriber.running).filter(Boolean)
      if (!pending.length) return
      await Promise.all(pending)
    }
  }

  return {
    publish, subscribe, recent, flush,
    stats: () => ({ seq, subscribers: subscribers.size, dropped, rateLimited }),
    close() { closed = true; for (const subscriber of subscribers) { subscriber.closed = true; subscriber.queue = [] } subscribers.clear() },
  }
}

/**
 * Browser card events from the screen, and catch-up after an SSE reconnect.
 * POST /events/browser {cardId, kind:'navigated'|'oauthCompleted'|'loaded'|'popupClosed', url, openerCardId?, closedBy?}
 *   popupClosed (BRW-04, D-B11): url is the popup's last location, openerCardId
 *   is required and closedBy is 'page' (window.close by the site) or 'user'.
 *   -> 202 {accepted, event:{seq,id,topic,origin,path,openerCardId?}}
 *   openerCardId (BRW-04): sent only by a popup card, naming the card its popup
 *   chain started from; omit it (or send null) for an ordinary card.
 * GET  /events/recent?since=SEQ -> {seq, oldestSeq, events}
 * Loopback + Origin guarded; URLs are reduced to origin + path before publishing.
 */
const BROWSER_KINDS = Object.freeze({ navigated: 'browser.navigated', oauthCompleted: 'browser.oauthCompleted',
  loaded: 'browser.loaded', popupClosed: 'browser.popupClosed' })
export function createWorkflowEventHttpHandler({ bus, owner, port = 39218, maxBrowserEventsPerSecond = 20, now = Date.now }) {
  if (!bus?.publish) throw new TypeError('Workflow event bus is required')
  let window = { start: 0, count: 0 }
  return async (req, res, parsedUrl = null) => {
    let url
    try { url = parsedUrl || new URL(req.url, `http://127.0.0.1:${port}`) } catch { return false }
    if (url.pathname !== '/events/browser' && url.pathname !== '/events/recent') return false
    if (!guardBridgeRequest(req, port)) {
      sendJson(res, 403, { code: 'WORKFLOW_LOOPBACK_REQUIRED', error: 'Untrusted workflow event origin' })
      return true
    }
    setBridgeCors(req, res)
    try {
      if (url.pathname === '/events/recent') {
        if (req.method !== 'GET') throw workflowEventError('WORKFLOW_METHOD', 'Use GET', 405)
        if ([...url.searchParams.keys()].some(key => key !== 'since')) throw workflowEventError('WORKFLOW_EVENT_INPUT', 'Only since is accepted')
        const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : 0
        sendJson(res, 200, bus.recent({ owner, since }))
        return true
      }
      if (req.method !== 'POST') throw workflowEventError('WORKFLOW_METHOD', 'Use POST', 405)
      const body = await readJsonBody(req, { maxBytes: 16 * 1024 })
      exactKeys(body, ['cardId', 'kind', 'url'], ['openerCardId', 'closedBy'])
      const topic = BROWSER_KINDS[body.kind]
      if (!topic) fail('kind must be navigated, oauthCompleted, loaded or popupClosed')
      if ((body.kind === 'popupClosed') !== Object.hasOwn(body, 'closedBy')) fail('closedBy belongs to popupClosed only')
      const location = publicBrowserLocation(body.url)
      const cardId = opaque(body.cardId, 'cardId')
      const openerCardId = openerCardOf(body.openerCardId, cardId)
      const at = now()
      if (at - window.start >= 1000) window = { start: at, count: 0 }
      if (window.count >= maxBrowserEventsPerSecond) throw workflowEventError('WORKFLOW_RATE_LIMIT', 'Too many browser events', 429)
      window.count += 1
      const event = bus.publish({ topic, owner,
        payload: { cardId, ...location, ...(openerCardId ? { openerCardId } : {}),
          ...(body.kind === 'popupClosed' ? { closedBy: body.closedBy } : {}) } })
      if (!event) throw workflowEventError('WORKFLOW_RATE_LIMIT', 'Too many workflow events', 429)
      sendJson(res, 202, { accepted: true, event: { seq: event.seq, id: event.id, topic: event.topic, origin: event.payload.origin, path: event.payload.path,
        ...(event.payload.openerCardId ? { openerCardId: event.payload.openerCardId } : {}) } })
    } catch (error) {
      const status = Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? error.httpStatus : 500
      const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'WORKFLOW_EVENT_ERROR'
      sendJson(res, status, { code, error: status === 500 ? 'Workflow event could not be accepted' : error.message })
    }
    return true
  }
}
