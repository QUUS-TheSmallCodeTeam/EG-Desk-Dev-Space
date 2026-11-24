import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'

// The Desk's presence snapshot, mirrored into the bridge for the heartbeat's audience rule (egdesk-conversation-flow.mjs audienceFacts).
// Presence lives in the window (camera, viewport, input, the joint Board feed); the heartbeat lives here. The window posts the SAME rows
// it gives the placement runtime, so both consumers read one snapshot:
//   [{ member, self, active, viewport: { x, y, width, height } | null, focusCard: alias | null, lastInputAgeMs }]
// Memory only, never written anywhere. Content-free: aliases, booleans and numbers; any other key refuses the whole post.
// When the window stops posting (closed, flag off) the mirror goes quiet after staleMs and snapshot() is null again, which is exactly
// the single-user behaviour the audience rule already has without a feed ("presence unknown, the requester is taken to be waiting").
export const PRESENCE_MIRROR = Object.freeze({
  path: '/presence/snapshot',
  staleMs: 10_000,          // one posting cadence (3 s) + one request timeout (7 s), the same bound the feed uses for a member
  activeInputMs: 300_000,   // the single-user provider's bound for "active"
  maxRows: 9, bodyBytes: 8192,
})
const ALIAS = /^[A-Za-z0-9_.:-]{1,64}$/ // the alias shape the placement runtime accepts
const ROW = ['member', 'self', 'active', 'viewport', 'focusCard', 'lastInputAgeMs']
const RECT = ['x', 'y', 'width', 'height']
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))

/** The closed row shape, rebuilt. Returns null for anything else: a post is taken whole or not at all. Exactly one own row, first. */
export function normalizePresenceRows(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PRESENCE_MIRROR.maxRows) return null
  const seen = new Set(), out = []
  for (const [index, row] of raw.entries()) {
    if (!exact(row, ROW) || typeof row.member !== 'string' || !ALIAS.test(row.member) || seen.has(row.member) || typeof row.self !== 'boolean' || typeof row.active !== 'boolean') return null
    if (row.self !== (index === 0)) return null
    if (row.viewport !== null && (!exact(row.viewport, RECT) || !RECT.every(k => Number.isFinite(row.viewport[k])) || row.viewport.width <= 0 || row.viewport.height <= 0)) return null
    if (row.self && row.viewport === null) return null
    if (row.focusCard !== null && (typeof row.focusCard !== 'string' || !ALIAS.test(row.focusCard))) return null
    if (!Number.isFinite(row.lastInputAgeMs) || row.lastInputAgeMs < 0) return null
    seen.add(row.member)
    out.push(Object.freeze({ member: row.member, self: row.self, active: row.active,
      viewport: row.viewport === null ? null : Object.freeze({ x: row.viewport.x, y: row.viewport.y, width: row.viewport.width, height: row.viewport.height }),
      focusCard: row.focusCard, lastInputAgeMs: row.lastInputAgeMs }))
  }
  return out
}

/** createPresenceMirror({ now? }) -> { accept(rows) -> boolean, snapshot() -> rows | null, clear() } */
export function createPresenceMirror({ now = Date.now } = {}) {
  let held = null // { at, rows }
  return Object.freeze({
    accept(raw) {
      const rows = normalizePresenceRows(raw)
      if (!rows) return false
      held = { at: now(), rows }
      return true
    },
    // The interface the heartbeat reads. Time keeps running between posts: input ages grow and an "active" that outlived its bound is dropped.
    snapshot() {
      if (!held) return null
      const waited = now() - held.at
      if (!(waited >= 0) || waited > PRESENCE_MIRROR.staleMs) { held = null; return null }
      return held.rows.map(row => {
        const age = row.lastInputAgeMs + waited
        return { member: row.member, self: row.self, active: row.active && age <= PRESENCE_MIRROR.activeInputMs,
          viewport: row.viewport === null ? null : { ...row.viewport }, focusCard: row.focusCard, lastInputAgeMs: age }
      })
    },
    clear() { held = null },
  })
}

/** POST /presence/snapshot { rows } from the window (loopback, JSON). Off (404) unless enabled(). Answers only { status }. */
export function createPresenceMirrorHttpHandler({ mirror, enabled = () => false, port = 39218 } = {}) {
  if (!mirror) throw new TypeError('a presence mirror is required')
  return async (req, res, url) => {
    if (url.pathname !== PRESENCE_MIRROR.path) return false
    const reply = (code, body) => { if (!res.destroyed && !res.writableEnded) sendJson(res, code, body); return true }
    let on = false
    try { on = enabled() === true } catch { on = false }
    if (!on) return reply(404, { status: 'off' })
    if (!guardBridgeRequest(req, port)) return reply(403, { status: 'refused', reason: 'loopback-required' })
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, { status: 'refused', reason: 'post-required' }) }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { status: 'refused', reason: 'json-required' })
    let body
    try { body = await readJsonBody(req, { maxBytes: PRESENCE_MIRROR.bodyBytes }) } catch { return reply(400, { status: 'invalid' }) }
    if (!exact(body, ['rows']) || !mirror.accept(body.rows)) return reply(400, { status: 'invalid' })
    return reply(200, { status: 'held' })
  }
}
