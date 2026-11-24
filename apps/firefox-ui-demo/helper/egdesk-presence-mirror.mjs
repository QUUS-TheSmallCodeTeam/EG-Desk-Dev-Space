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

// ---- Whose task a live conversation's run is (cycle 10) ----
// The heartbeat's audience rule asks conversationFlow.audience({ run }) for { requester, owner, participants } as presence member ids.
// The window tells the bridge when a run in one of its conversations works for another member: an opaque presence alias, nothing else.
// Taken only while that alias is in the mirrored snapshot (the feed lists seated, sharing members only). Memory only; an entry ends when
// the window clears it, after ttlMs, or with the process. Without an entry the answer is null: the local person asked, as before.
export const RUN_REQUESTER = Object.freeze({ path: '/presence/requester', ttlMs: 30 * 60_000, max: 64, bodyBytes: 1024 })
const FEED_ALIAS = /^m-[0-9a-f]{16}$/
const BOARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const keyOk = v => typeof v === 'string' && v.length > 0 && v.length <= 256

/** createRunRequesters({ presence, now? }) -> { set(keys, requester) -> status, audience({ run }) -> audience | null, size() } */
export function createRunRequesters({ presence, now = Date.now } = {}) {
  if (typeof presence?.snapshot !== 'function') throw new TypeError('a presence snapshot is required')
  const runs = new Map() // conversation key -> { alias, until }
  const sweep = () => { const t = now(); for (const [key, entry] of runs) if (entry.until <= t) runs.delete(key) }
  return Object.freeze({
    set(keys, requester) {
      const list = (Array.isArray(keys) ? keys : []).filter(keyOk)
      if (!list.length) return 'invalid'
      sweep()
      if (requester === null) { for (const key of list) runs.delete(key); return 'cleared' }
      if (!exact(requester, ['board', 'alias']) || typeof requester.board !== 'string' || !BOARD_ID.test(requester.board) || typeof requester.alias !== 'string' || !FEED_ALIAS.test(requester.alias)) return 'invalid'
      // Permission: the alias must be a member the presence feed lists right now (not the own row).
      let rows = null
      try { rows = presence.snapshot() } catch { rows = null }
      if (!Array.isArray(rows) || !rows.some(row => row && row.self !== true && row.member === requester.alias)) return 'unknown-member'
      while (runs.size >= RUN_REQUESTER.max) runs.delete(runs.keys().next().value)
      const entry = Object.freeze({ alias: requester.alias, until: now() + RUN_REQUESTER.ttlMs })
      for (const key of list) runs.set(key, entry)
      return 'held'
    },
    // The requester is another member; the owner is the local person; the conversation is the owner's own (the member is not in it).
    audience({ run } = {}) {
      if (!run || run.board === true) return null
      sweep()
      const entry = [run.clientThreadId, run.conversationId].filter(keyOk).map(key => runs.get(key)).find(Boolean)
      return entry ? { requester: entry.alias, owner: 'self', participants: ['self'] } : null
    },
    size: () => runs.size,
  })
}

/** POST /presence/requester { clientThreadId, conversationId, requester: { board, alias } | null }. Off (404) unless enabled(). */
export function createRunRequesterHttpHandler({ requesters, enabled = () => false, port = 39218 } = {}) {
  if (!requesters) throw new TypeError('a requester registry is required')
  return async (req, res, url) => {
    if (url.pathname !== RUN_REQUESTER.path) return false
    const reply = (code, body) => { if (!res.destroyed && !res.writableEnded) sendJson(res, code, body); return true }
    let on = false
    try { on = enabled() === true } catch { on = false }
    if (!on) return reply(404, { status: 'off' })
    if (!guardBridgeRequest(req, port)) return reply(403, { status: 'refused', reason: 'loopback-required' })
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, { status: 'refused', reason: 'post-required' }) }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { status: 'refused', reason: 'json-required' })
    let body
    try { body = await readJsonBody(req, { maxBytes: RUN_REQUESTER.bodyBytes }) } catch { return reply(400, { status: 'invalid' }) }
    if (!exact(body, ['clientThreadId', 'conversationId', 'requester'])) return reply(400, { status: 'invalid' })
    const status = requesters.set([body.clientThreadId, body.conversationId], body.requester)
    return reply(status === 'invalid' ? 400 : status === 'unknown-member' ? 409 : 200, { status })
  }
}
