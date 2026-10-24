// CTX-03 context resolver: turns screen signals (what the person is looking at
// right now) into a short, ranked list of *suggested* sources. It never reads
// or captures source content and never attaches anything by itself: the only
// policy is 'suggest-only'. A chosen candidate still goes through the existing
// explicit attach path (POST /context/captures or chat send attachments).
//
// Relevance (reasons/score) and permission (requiresConsent/excludedBy) are
// separate fields, as the interaction contract requires.
import { createHash } from 'node:crypto'
import { chatError } from './codex-chat-values.mjs'

export const RESOLVER_POLICY = 'suggest-only'
export const RESOLVER_KINDS = Object.freeze(['browser', 'file', 'board-element'])
// Fixed reason codes, strongest first. The weights are the ranking contract.
export const RESOLVER_REASON_WEIGHTS = Object.freeze({
  explicit: 100, focused: 40, activeBoardMember: 30, sameCluster: 20, visibleLarge: 10, recentlyUsed: 8,
})
export const RESOLVER_REASONS = Object.freeze(Object.keys(RESOLVER_REASON_WEIGHTS))
export const RESOLVER_EXCLUSIONS = Object.freeze(['otherAccount', 'noPermission'])
export const RESOLVER_LIMITS = Object.freeze({
  candidates: 12, explicit: 16, visible: 64, clusters: 32, clusterSize: 64, recent: 32, scopes: 8, chosen: 16,
})
// area is the visible fraction of the Desk viewport (0..1).
export const VISIBLE_LARGE_AREA = 0.2
export const RECENT_WINDOW_MS = 30 * 60 * 1000
const FUTURE_SKEW_MS = 5 * 60 * 1000

// Opaque screen identifiers only (e.g. view ids like `egd-file-card-12`).
// No spaces, slashes or '@': paths, URLs and e-mail style identifiers are refused.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/
const RESOURCE_KEYS = ['kind', 'ref', 'accountScope', 'permission', 'signedIn']
const SHAPES = {
  signals: ['boardId', 'explicit', 'visible', 'cluster', 'recent', 'account'],
  explicit: RESOURCE_KEYS,
  visible: [...RESOURCE_KEYS, 'boardId', 'focused', 'area', 'lastInteractedAt', 'clusterId'],
  recent: [...RESOURCE_KEYS, 'at'],
  account: ['scopes'],
}

const invalid = message => { throw chatError('INVALID_RESOLVER_SIGNAL', message, 400) }
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const token = (value, name) => {
  if (typeof value !== 'string' || !TOKEN.test(value)) invalid(`${name} must be an opaque screen identifier`)
  return value
}
const time = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a millisecond timestamp`)
  return value
}
function shape(value, keys, name) {
  if (!plain(value)) invalid(`${name} must be an object`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${name} has an unsupported field: ${key}`)
}
function list(value, max, name) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) invalid(`${name} must be an array of at most ${max} items`)
  return value
}

function resource(value, keys, name) {
  shape(value, keys, name)
  if (!RESOLVER_KINDS.includes(value.kind)) invalid(`${name}.kind must be one of ${RESOLVER_KINDS.join(', ')}`)
  const item = { kind: value.kind, ref: token(value.ref, `${name}.ref`) }
  if (value.accountScope !== undefined) item.accountScope = token(value.accountScope, `${name}.accountScope`)
  if (value.permission !== undefined) {
    if (!['allowed', 'denied'].includes(value.permission)) invalid(`${name}.permission must be allowed or denied`)
    item.permission = value.permission
  }
  if (value.signedIn !== undefined) {
    if (typeof value.signedIn !== 'boolean') invalid(`${name}.signedIn must be true or false`)
    item.signedIn = value.signedIn
  }
  return item
}

function unique(items, name) {
  const refs = new Set()
  for (const item of items) {
    if (refs.has(item.ref)) invalid(`${name} repeats ref ${item.ref}`)
    refs.add(item.ref)
  }
  return items
}

const byRef = (a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)

// Validates and normalizes the screen's signals. Order-independent: lists are
// sorted, so the same screen state always yields the same digest and ranking.
export function validateResolverSignals(input) {
  shape(input, SHAPES.signals, 'signals')
  const signals = { boardId: null, explicit: [], visible: [], cluster: [], recent: [], account: null }
  if (input.boardId !== undefined && input.boardId !== null) signals.boardId = token(input.boardId, 'boardId')
  signals.explicit = unique(list(input.explicit, RESOLVER_LIMITS.explicit, 'explicit').map((item, i) => resource(item, SHAPES.explicit, `explicit[${i}]`)), 'explicit').sort(byRef)
  signals.visible = unique(list(input.visible, RESOLVER_LIMITS.visible, 'visible').map((value, i) => {
    const name = `visible[${i}]`
    const item = resource(value, SHAPES.visible, name)
    if (value.boardId !== undefined && value.boardId !== null) item.boardId = token(value.boardId, `${name}.boardId`)
    if (value.focused !== undefined) {
      if (typeof value.focused !== 'boolean') invalid(`${name}.focused must be true or false`)
      item.focused = value.focused
    }
    if (value.area !== undefined) {
      if (typeof value.area !== 'number' || !Number.isFinite(value.area) || value.area < 0 || value.area > 1) invalid(`${name}.area must be a viewport fraction between 0 and 1`)
      item.area = value.area
    }
    if (value.lastInteractedAt !== undefined) item.lastInteractedAt = time(value.lastInteractedAt, `${name}.lastInteractedAt`)
    if (value.clusterId !== undefined && value.clusterId !== null) item.clusterId = token(value.clusterId, `${name}.clusterId`)
    return item
  }), 'visible').sort(byRef)
  if (signals.visible.filter(item => item.focused).length > 1) invalid('At most one visible resource can be focused')
  signals.cluster = list(input.cluster, RESOLVER_LIMITS.clusters, 'cluster').map((group, i) => {
    const refs = list(group, RESOLVER_LIMITS.clusterSize, `cluster[${i}]`).map((ref, j) => token(ref, `cluster[${i}][${j}]`))
    if (new Set(refs).size !== refs.length) invalid(`cluster[${i}] repeats a ref`)
    return refs.sort()
  }).sort((a, b) => (a.join('|') < b.join('|') ? -1 : a.join('|') > b.join('|') ? 1 : 0))
  signals.recent = unique(list(input.recent, RESOLVER_LIMITS.recent, 'recent').map((value, i) => {
    const item = resource(value, SHAPES.recent, `recent[${i}]`)
    item.at = time(value.at, `recent[${i}].at`)
    return item
  }), 'recent').sort(byRef)
  if (input.account !== undefined && input.account !== null) {
    shape(input.account, SHAPES.account, 'account')
    const scopes = list(input.account.scopes, RESOLVER_LIMITS.scopes, 'account.scopes').map((scope, i) => token(scope, `account.scopes[${i}]`))
    signals.account = { scopes: [...new Set(scopes)].sort() }
  }
  return signals
}

export function resolverSignalsDigest(signals) {
  return createHash('sha256').update(JSON.stringify(signals)).digest('hex')
}

// Picks the Board the person is working in: the one the screen says is active,
// else the focused card's Board, else the Board with the most visible area.
function bestBoard(signals) {
  if (signals.boardId) return { boardId: signals.boardId, matchedBy: 'active' }
  const focused = signals.visible.find(item => item.focused && item.boardId)
  if (focused) return { boardId: focused.boardId, matchedBy: 'focused' }
  const totals = new Map()
  for (const item of signals.visible) if (item.boardId) {
    const total = totals.get(item.boardId) || { area: 0, members: 0 }
    total.area += item.area || 0
    total.members += 1
    totals.set(item.boardId, total)
  }
  const [best] = [...totals].sort(([a, x], [b, y]) => y.area - x.area || y.members - x.members || (a < b ? -1 : a > b ? 1 : 0))
  return best ? { boardId: best[0], matchedBy: 'visibleArea' } : null
}

function merge(entries, item, source) {
  const current = entries.get(item.ref)
  if (!current) {
    entries.set(item.ref, { ...item, sources: new Set([source]) })
    return
  }
  if (current.kind !== item.kind) invalid(`ref ${item.ref} is reported with two kinds`)
  if (current.accountScope && item.accountScope && current.accountScope !== item.accountScope) invalid(`ref ${item.ref} is reported with two account scopes`)
  current.accountScope ||= item.accountScope
  if (item.permission === 'denied' || !current.permission) current.permission = item.permission || current.permission
  if (item.signedIn) current.signedIn = true
  for (const key of ['boardId', 'focused', 'area', 'lastInteractedAt', 'clusterId']) if (item[key] !== undefined) current[key] = item[key]
  if (item.at !== undefined) current.at = Math.max(current.at ?? 0, item.at)
  current.sources.add(source)
}

// Deterministic ranking: score desc → most recent interaction desc → larger
// visible area desc → ref asc. Selectable candidates come first; excluded
// ones only fill leftover slots so they never push out a usable suggestion.
export function resolveContext(signals, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now)) throw new TypeError('now must be a millisecond timestamp')
  const board = bestBoard(signals)
  const entries = new Map()
  for (const item of signals.explicit) merge(entries, item, 'explicit')
  for (const item of signals.visible) merge(entries, item, 'visible')
  for (const item of signals.recent) merge(entries, item, 'recent')
  const clustersOf = new Map()
  const join = (ref, id) => { if (!clustersOf.has(ref)) clustersOf.set(ref, new Set()); clustersOf.get(ref).add(id) }
  for (const item of signals.visible) if (item.clusterId) join(item.ref, `id:${item.clusterId}`)
  signals.cluster.forEach((refs, index) => refs.forEach(ref => join(ref, `group:${index}`)))
  const anchors = [...entries.values()].filter(entry => entry.sources.has('explicit') || entry.focused).map(entry => entry.ref)
  const recentEnough = at => at !== undefined && at <= now + FUTURE_SKEW_MS && now - at <= RECENT_WINDOW_MS
  const scopes = signals.account?.scopes || []
  const candidates = []
  for (const entry of entries.values()) {
    const reasons = []
    if (entry.sources.has('explicit')) reasons.push('explicit')
    if (entry.focused) reasons.push('focused')
    if (board && entry.boardId === board.boardId) reasons.push('activeBoardMember')
    const own = clustersOf.get(entry.ref)
    if (own && anchors.some(anchor => anchor !== entry.ref && [...(clustersOf.get(anchor) || [])].some(id => own.has(id)))) reasons.push('sameCluster')
    if ((entry.area || 0) >= VISIBLE_LARGE_AREA) reasons.push('visibleLarge')
    if (recentEnough(entry.lastInteractedAt) || recentEnough(entry.at)) reasons.push('recentlyUsed')
    if (!reasons.length) continue
    const candidate = {
      ref: entry.ref, kind: entry.kind,
      score: reasons.reduce((sum, reason) => sum + RESOLVER_REASON_WEIGHTS[reason], 0),
      reasons,
      // Browser Card content and signed-in pages are suggested, never auto-included.
      requiresConsent: !entry.sources.has('explicit') && (entry.kind === 'browser' || entry.signedIn === true),
    }
    if (entry.accountScope && !scopes.includes(entry.accountScope)) candidate.excludedBy = 'otherAccount'
    else if (entry.permission === 'denied') candidate.excludedBy = 'noPermission'
    candidates.push({ candidate, lastSeen: Math.max(entry.lastInteractedAt ?? 0, entry.at ?? 0), area: entry.area || 0 })
  }
  const order = (a, b) => b.candidate.score - a.candidate.score || b.lastSeen - a.lastSeen || b.area - a.area || byRef(a.candidate, b.candidate)
  const selectable = candidates.filter(item => !item.candidate.excludedBy).sort(order)
  const excluded = candidates.filter(item => item.candidate.excludedBy).sort(order)
  const ranked = [...selectable, ...excluded].slice(0, RESOLVER_LIMITS.candidates).map(item => item.candidate)
  return { policy: RESOLVER_POLICY, resolvedAt: now, signalsDigest: resolverSignalsDigest(signals), board, candidates: ranked }
}

export function validateResolverChoice(value) {
  if (!plain(value) || Object.keys(value).some(key => !['resolutionId', 'chosen'].includes(key))) throw chatError('INVALID_RESOLVER_CHOICE', 'contextResolution needs resolutionId and chosen refs only', 400)
  if (typeof value.resolutionId !== 'string' || !/^[\da-f-]{36}$/i.test(value.resolutionId)) throw chatError('INVALID_RESOLVER_CHOICE', 'Invalid resolutionId', 400)
  const chosen = value.chosen ?? []
  if (!Array.isArray(chosen) || chosen.length > RESOLVER_LIMITS.chosen || chosen.some(ref => typeof ref !== 'string' || !TOKEN.test(ref)) || new Set(chosen).size !== chosen.length) {
    throw chatError('INVALID_RESOLVER_CHOICE', `chosen must list at most ${RESOLVER_LIMITS.chosen} distinct candidate refs`, 400)
  }
  return { resolutionId: value.resolutionId, chosen: [...chosen] }
}

// The '왜 이것이 붙었나' evidence kept with the run binding: identifiers, codes
// and scores only. No titles, URLs, paths or captured text.
export function resolverRecord(resolutionId, resolution, chosenSources = new Map()) {
  return {
    resolutionId, resolvedAt: resolution.resolvedAt, signalsDigest: resolution.signalsDigest,
    policy: resolution.policy, board: resolution.board ? { ...resolution.board } : null,
    candidates: resolution.candidates.map(candidate => ({
      ref: candidate.ref, kind: candidate.kind, score: candidate.score, reasons: [...candidate.reasons],
      requiresConsent: candidate.requiresConsent,
      ...(candidate.excludedBy ? { excludedBy: candidate.excludedBy } : {}),
      chosen: chosenSources.has(candidate.ref),
      ...(chosenSources.has(candidate.ref) ? { sourceId: chosenSources.get(candidate.ref) } : {}),
    })),
  }
}
