/**
 * CHAT-06 / BRW-04 gate router: turns workflow events into satisfied task
 * gates, which the task graph then turns into automatic downstream starts.
 *
 * Matching is exact and per gate; nothing is matched broadly:
 *   oauth        browser.oauthCompleted with the same origin, a path equal to
 *                pathPrefix or below it on a "/" boundary, and — when the gate
 *                names a card — that cardId, or a popup card whose
 *                openerCardId is that card (BRW-04: the sign-in finished in the
 *                popup the card opened). browser.navigated never satisfies it.
 *   file         file.changed in the same connected rootId whose relative path
 *                matches relativeGlob ("*", "?" within a segment, "**" across).
 *   terminalExit terminal.exit of the same sessionId (and exitCode if given).
 *   any kind     user.action naming exactly { graphId, taskId, gateId } — the
 *                manual "continue" fallback.
 * An expired gate (its expiresAt/timeoutMs ran out) no longer opens on its own
 * event; only that manual user.action continues it.
 *
 * BRW-04, D-B11 (inferred default, 2026-11-17): a sign-in popup that closes
 * itself (browser.popupClosed, closedBy 'page') finishes an oauth gate only
 * when, afterwards and within POPUP_LOGIN_FOLLOW_MS, its opener card shows a
 * navigation or a load on the gate origin's site (registrable domain), or a
 * browser.oauthCompleted arrives (the rule above). The close alone, a close by
 * the person, a navigation before the close, another card or another site
 * never count. A gate naming a card needs that card as the opener.
 */
import { defaultSiteForHost } from './egdesk-browser-url-policy.mjs'

export const POPUP_LOGIN_FOLLOW_MS = 30000
const MAX_PENDING_POPUP_CLOSES = 64
export const GATE_TOPICS = Object.freeze(['terminal.exit', 'file.changed', 'browser.oauthCompleted', 'user.action',
  'browser.popupClosed', 'browser.navigated', 'browser.loaded'])

const globCache = new Map()
export function globMatch(glob, relativePath) {
  if (typeof glob !== 'string' || typeof relativePath !== 'string') return false
  let pattern = globCache.get(glob)
  if (!pattern) {
    let source = ''
    for (let index = 0; index < glob.length; index += 1) {
      const char = glob[index]
      if (char === '*' && glob[index + 1] === '*') {
        const slash = glob[index + 2] === '/'
        source += slash ? '(?:.*/)?' : '.*'
        index += slash ? 2 : 1
      } else if (char === '*') source += '[^/]*'
      else if (char === '?') source += '[^/]'
      else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    pattern = new RegExp(`^${source}$`)
    if (globCache.size > 256) globCache.clear()
    globCache.set(glob, pattern)
  }
  return pattern.test(relativePath)
}

export function pathWithin(path, prefix) {
  if (typeof path !== 'string' || typeof prefix !== 'string' || prefix.length < 2) return false
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
}

/**
 * The card rule of an oauth gate: a gate without a card takes any card; a gate
 * naming a card takes that card, or a popup card the screen reported as opened
 * from it (payload.openerCardId, exact string). The screen mirrors this in
 * EGDeskSurfaceState oauthGateMatches.
 */
export function gateCardMatches(gateCardId, payload) {
  if (gateCardId === undefined) return true
  if (!payload) return false
  return payload.cardId === gateCardId || (typeof payload.openerCardId === 'string' && payload.openerCardId === gateCardId)
}

export function gateMatchesEvent(gate, event, target = {}) {
  if (!gate || !event?.payload) return false
  const payload = event.payload
  if (event.topic === 'user.action') {
    return payload.graphId === target.graphId && payload.taskId === target.taskId && payload.gateId === gate.gateId
  }
  switch (gate.kind) {
    case 'oauth':
      return event.topic === 'browser.oauthCompleted' && payload.origin === gate.origin &&
        pathWithin(payload.path, gate.pathPrefix) && gateCardMatches(gate.cardId, payload)
    case 'file':
      return event.topic === 'file.changed' && payload.rootId === gate.root && globMatch(gate.relativeGlob, payload.relativePath)
    case 'terminalExit':
      return event.topic === 'terminal.exit' && payload.sessionId === gate.sessionId &&
        (gate.exitCode === undefined || payload.exitCode === gate.exitCode)
    default:
      return false
  }
}

function siteOf(origin) {
  try {
    const url = new URL(origin)
    return defaultSiteForHost(url.hostname) || url.origin
  } catch { return null }
}

/**
 * D-B11: does follow (browser.navigated / browser.loaded) after close
 * (browser.popupClosed) finish this oauth gate? Pure; times are the events' at.
 */
export function popupLoginFollowUp(gate, close, follow, { windowMs = POPUP_LOGIN_FOLLOW_MS } = {}) {
  if (gate?.kind !== 'oauth' || close?.topic !== 'browser.popupClosed' || close.payload?.closedBy !== 'page') return false
  if (follow?.topic !== 'browser.navigated' && follow?.topic !== 'browser.loaded') return false
  const opener = close.payload.openerCardId
  if (typeof opener !== 'string' || follow.payload?.cardId !== opener) return false
  if (gate.cardId !== undefined && gate.cardId !== opener) return false
  const closedAt = Date.parse(close.at), followAt = Date.parse(follow.at)
  if (!Number.isFinite(closedAt) || !Number.isFinite(followAt) || followAt < closedAt || followAt - closedAt > windowMs) return false
  if (follow.seq !== undefined && close.seq !== undefined && !(follow.seq > close.seq)) return false
  const site = siteOf(gate.origin)
  return !!site && site === siteOf(follow.payload.origin)
}

/**
 * createAwaitGateRouter({ graph, bus, owner }) -> { route(event), drain(), close() }
 * graph needs openGates() and satisfyGate(); events are routed one at a time.
 */
export function createAwaitGateRouter({ graph, bus, owner }) {
  if (typeof graph?.openGates !== 'function' || typeof graph?.satisfyGate !== 'function') throw new TypeError('Task graph with gates is required')
  let tail = Promise.resolve()
  // Self-closed popups waiting for their opener's follow-up, by opener card.
  const popupCloses = new Map()
  async function route(event) {
    const satisfied = []
    if (event.topic === 'browser.popupClosed') {
      // Recorded only; the close alone never satisfies a gate (D-B11).
      if (event.payload?.closedBy === 'page') {
        popupCloses.delete(event.payload.openerCardId)
        popupCloses.set(event.payload.openerCardId, event)
        while (popupCloses.size > MAX_PENDING_POPUP_CLOSES) popupCloses.delete(popupCloses.keys().next().value)
      }
      return satisfied
    }
    const close = event.topic === 'browser.navigated' || event.topic === 'browser.loaded'
      ? popupCloses.get(event.payload?.cardId) : null
    if (close && Date.parse(event.at) - Date.parse(close.at) > POPUP_LOGIN_FOLLOW_MS) popupCloses.delete(event.payload.cardId)
    for (const open of graph.openGates()) {
      if (open.expired === true && event.topic !== 'user.action') continue
      if (!gateMatchesEvent(open.gate, event, open) && !(close && popupLoginFollowUp(open.gate, close, event))) continue
      try {
        await graph.satisfyGate({ graphId: open.graphId, taskId: open.taskId, gateId: open.gate.gateId,
          evidence: { eventId: event.id, topic: event.topic, at: event.at } })
        satisfied.push({ graphId: open.graphId, taskId: open.taskId, gateId: open.gate.gateId })
      } catch { /* a gate closed meanwhile (cancelled graph, started task) stays as it is */ }
    }
    // One close finishes at most one follow-up.
    if (close && satisfied.length) popupCloses.delete(event.payload.cardId)
    return satisfied
  }
  const unsubscribe = bus.subscribe({ owner, topics: [...GATE_TOPICS] }, event => {
    const work = tail.then(() => route(event))
    tail = work.catch(() => {})
    return work
  })
  return { route, drain: () => tail, close: unsubscribe }
}
