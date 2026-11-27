// Ephemeral presence for the members of one joint Board (canon 12.2: an optional, temporary signal; never Board state).
//   - Memory only. Nothing here has a database handle: it cannot write the shared ledger, a card position or anybody's layout.
//     The only thing it is given is a read-only `access(person, board, cards)` check.
//   - Content-free by construction: a record has an enum, numbers and one card id. Any other key is refused, so a title, text,
//     URL or pointer position has nowhere to go.
//   - Opt-in per member and per publish: 'off' (default) stores nothing and withdraws what was stored; 'active' stores only
//     "here, and how long since input"; 'region' adds the view rectangle and the focused card.
//   - A reader gets records of the same Board only, as a current member; a focused card only when the reader can see that card.
//   - Records become inactive after staleMs without a new publish and are deleted after expireMs; a member who left or was
//     excluded disappears at once (seat epoch is re-checked on every read).
//   - Requester identity (cycle 10): a member who shares presence may CLAIM a request by an opaque tag (a hash only the holders of
//     that request can compute); another seated member who holds the same request may RESOLVE the tag to the claimer's alias.
//     The service vouches for it: the alias is the authenticated, still seated member who claimed, never a value a client typed.
//     A claim is memory only, ends with the seat, with sharing turned off, or after claimMs.
import { createHmac, randomBytes } from 'node:crypto'
import { JointError } from './egdesk-joint-board-store.mjs'

// publish cadence of the client is 3 s (the Board's existing refresh cadence) and its request timeout is 7 s:
// staleMs = one cadence + one timeout, so a single slow or lost publish does not flip a member to inactive.
// activeInputMs is the single-user provider's own bound (EGDeskWorkPlacement createSingleUserPresence: active within 5 minutes
// of input), so "active" means the same for every row of one snapshot: someone reading without touching the Desk keeps
// protecting their view. Shorter idleness is the consumers' business (they read lastInputAgeMs).
export const PRESENCE_LIMITS = Object.freeze({
  minIntervalMs: 1000, staleMs: 10_000, expireMs: 30_000, activeInputMs: 300_000,
  inputCapMs: 600_000, inputStepMs: 5000, ageStepMs: 1000, grid: 40, space: 20_000, maxSide: 80_000, bodyBytes: 2000,
  claimMs: 15 * 60_000, maxTags: 4, maxClaims: 16, // a claim is re-announced by the claimer's Desk every cadence; it outlives a closed Desk by claimMs at most
})
export const PRESENCE_SHARE = Object.freeze(['off', 'active', 'region'])
const L = PRESENCE_LIMITS
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FIELDS = ['board', 'share', 'inputAgeMs', 'viewport', 'focusCard', 'claim', 'resolve']
const TAG = /^[0-9a-f]{64}$/
const tags = raw => {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > PRESENCE_LIMITS.maxTags || raw.some(tag => typeof tag !== 'string' || !TAG.test(tag)) || new Set(raw).size !== raw.length) refuse(400, 'invalid-presence')
  return raw
}
const RECT = ['x', 'y', 'width', 'height']
const refuse = (status, code) => { throw new JointError(status, code) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const step = (value, size) => Math.floor(value / size) * size

// Outward to the grid: the published rectangle always covers what the member sees and carries no finer movement than one cell.
function checkedViewport(raw) {
  if (raw === null || raw === undefined) return null
  if (!plain(raw) || Object.keys(raw).length !== RECT.length || !RECT.every(key => Number.isFinite(raw[key]))) refuse(400, 'invalid-presence')
  if (raw.width <= 0 || raw.height <= 0 || raw.width > L.maxSide || raw.height > L.maxSide || Math.abs(raw.x) > 2 * L.space || Math.abs(raw.y) > 2 * L.space) refuse(400, 'invalid-presence')
  const x = Math.floor(raw.x / L.grid) * L.grid, y = Math.floor(raw.y / L.grid) * L.grid
  return Object.freeze({ x, y, width: Math.ceil((raw.x + raw.width) / L.grid) * L.grid - x, height: Math.ceil((raw.y + raw.height) / L.grid) * L.grid - y })
}

/**
 * createJointPresence({ access, now?, secret? }) -> { exchange(person, body), size(), clear() }
 * access(person, boardId, cardIds) -> { epoch, visible: [cardId] } | null   (read-only; null = not a member of that Board)
 */
export function createJointPresence({ access, now = Date.now, secret = randomBytes(32) } = {}) {
  if (typeof access !== 'function') throw new TypeError('a read-only access check is required')
  const records = new Map() // board\0person -> { board, person, epoch, at, inputAge, viewport, focus }
  const calls = new Map()   // board\0person -> time of the last accepted call (rate limit only)
  const claims = new Map()  // board\0tag -> { board, person, epoch, at }   (who vouches for being the requester of that request)
  // Opaque per Board and per process: not the account id, not comparable across Boards, different after a restart.
  const alias = (board, person) => 'm-' + createHmac('sha256', secret).update(board).update('\0').update(person).digest('hex').slice(0, 16)
  const seated = (person, board, cards = []) => { try { return access(person, board, cards) || null } catch { return null } }
  function sweep(time) {
    for (const [key, record] of records) if (time - record.at > L.expireMs) records.delete(key)
    for (const [key, at] of calls) if (time - at > L.expireMs) calls.delete(key)
    for (const [key, claim] of claims) if (time - claim.at > L.claimMs) claims.delete(key)
  }
  function exchange(person, body) {
    if (!plain(body) || Object.keys(body).some(key => !FIELDS.includes(key))) refuse(400, 'invalid-presence')
    const { board, share } = body
    if (typeof board !== 'string' || !UUID.test(board) || !PRESENCE_SHARE.includes(share)) refuse(400, 'invalid-presence')
    const focusRaw = body.focusCard ?? null
    if (focusRaw !== null && (typeof focusRaw !== 'string' || !UUID.test(focusRaw))) refuse(400, 'invalid-presence')
    const me = seated(person, board, focusRaw ? [focusRaw] : [])
    if (!me) refuse(404, 'unavailable') // same answer as an unknown Board: membership is not revealed
    const claimTags = tags(body.claim), resolveTags = tags(body.resolve)
    const time = now(), key = board + '\0' + person
    if (share === 'off') {
      // A member who shares nothing has no alias to hand out: no claim, and what was claimed is withdrawn with the record.
      if (body.inputAgeMs != null || body.viewport != null || focusRaw !== null || claimTags.length) refuse(400, 'invalid-presence')
      records.delete(key) // turning sharing off withdraws the record at once, even when this call is rate limited
      for (const [claimKey, claim] of claims) if (claim.board === board && claim.person === person) claims.delete(claimKey)
    }
    if (calls.has(key) && time - calls.get(key) < L.minIntervalMs) refuse(429, 'presence-rate')
    sweep(time)
    if (share !== 'off') {
      const inputAge = body.inputAgeMs
      if (!Number.isSafeInteger(inputAge) || inputAge < 0) refuse(400, 'invalid-presence')
      if (share === 'active' && (body.viewport != null || focusRaw !== null)) refuse(400, 'invalid-presence')
      const viewport = share === 'region' ? checkedViewport(body.viewport) : null
      // The focused card must be one the publisher can see on this Board; otherwise it is simply not kept.
      const focus = share === 'region' && focusRaw && me.visible.includes(focusRaw) ? focusRaw : null
      records.set(key, Object.freeze({ board, person, epoch: me.epoch, at: time, inputAge: step(Math.min(inputAge, L.inputCapMs), L.inputStepMs), viewport, focus }))
    }
    calls.set(key, time)
    // Claims: first come, first kept. Another member cannot take over a tag that a still seated member holds.
    for (const tag of claimTags) {
      const claimKey = board + '\0' + tag, held = claims.get(claimKey)
      if (held && held.person !== person && seated(held.person, board)?.epoch === held.epoch) continue
      if (!held || held.person !== person) {
        let mine = 0
        for (const claim of claims.values()) if (claim.board === board && claim.person === person) mine++
        if (mine >= L.maxClaims) continue
      }
      claims.set(claimKey, { board, person, epoch: me.epoch, at: time })
    }
    const resolved = []
    for (const tag of resolveTags) {
      const claimKey = board + '\0' + tag, claim = claims.get(claimKey)
      if (!claim) continue
      if (seated(claim.person, board)?.epoch !== claim.epoch) { claims.delete(claimKey); continue }
      if (claim.person !== person) resolved.push({ tag, member: alias(board, claim.person) })
    }
    const rows = []
    for (const [otherKey, record] of records) {
      if (record.board !== board || record.person === person) continue
      // A member who left, was excluded or re-joined (new epoch) is gone immediately, not after the expiry.
      if (seated(record.person, board)?.epoch !== record.epoch) { records.delete(otherKey); continue }
      rows.push(record)
    }
    const focusIds = [...new Set(rows.map(record => record.focus).filter(Boolean))]
    const visible = focusIds.length ? new Set(seated(person, board, focusIds)?.visible || []) : new Set()
    const members = rows.map(record => {
      const age = time - record.at, inputAge = Math.min(L.inputCapMs, record.inputAge + age)
      return { member: alias(board, record.person), active: age <= L.staleMs && inputAge <= L.activeInputMs,
        inputAgeMs: step(inputAge, L.inputStepMs), ageMs: step(age, L.ageStepMs),
        viewport: record.viewport ? { ...record.viewport } : null, focusCard: record.focus && visible.has(record.focus) ? record.focus : null }
    }).sort((a, b) => (a.member < b.member ? -1 : 1)) // by alias, never by arrival order
    return { version: 1, board, self: alias(board, person), share, staleMs: L.staleMs, expireMs: L.expireMs, members, ...(resolveTags.length ? { resolved } : {}) }
  }
  return Object.freeze({ exchange, size: () => records.size, claimCount: () => claims.size, clear() { records.clear(); calls.clear(); claims.clear() } })
}
