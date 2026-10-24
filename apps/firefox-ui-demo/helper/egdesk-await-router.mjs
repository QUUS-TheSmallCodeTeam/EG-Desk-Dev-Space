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
 */
export const GATE_TOPICS = Object.freeze(['terminal.exit', 'file.changed', 'browser.oauthCompleted', 'user.action'])

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

/**
 * createAwaitGateRouter({ graph, bus, owner }) -> { route(event), drain(), close() }
 * graph needs openGates() and satisfyGate(); events are routed one at a time.
 */
export function createAwaitGateRouter({ graph, bus, owner }) {
  if (typeof graph?.openGates !== 'function' || typeof graph?.satisfyGate !== 'function') throw new TypeError('Task graph with gates is required')
  let tail = Promise.resolve()
  async function route(event) {
    const satisfied = []
    for (const open of graph.openGates()) {
      if (open.expired === true && event.topic !== 'user.action') continue
      if (!gateMatchesEvent(open.gate, event, open)) continue
      try {
        await graph.satisfyGate({ graphId: open.graphId, taskId: open.taskId, gateId: open.gate.gateId,
          evidence: { eventId: event.id, topic: event.topic, at: event.at } })
        satisfied.push({ graphId: open.graphId, taskId: open.taskId, gateId: open.gate.gateId })
      } catch { /* a gate closed meanwhile (cancelled graph, started task) stays as it is */ }
    }
    return satisfied
  }
  const unsubscribe = bus.subscribe({ owner, topics: [...GATE_TOPICS] }, event => {
    const work = tail.then(() => route(event))
    tail = work.catch(() => {})
    return work
  })
  return { route, drain: () => tail, close: unsubscribe }
}
