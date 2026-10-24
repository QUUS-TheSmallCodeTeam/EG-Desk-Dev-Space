// CTX-03 context resolver: turns screen signals (what the person is looking at
// right now) into a short, ranked list of *suggested* sources. It never reads
// or captures source content and never attaches anything by itself: the only
// policy is 'suggest-only'. A chosen candidate still goes through the existing
// explicit attach path (POST /context/captures or chat send attachments).
//
// Relevance (reasons/score) and permission (requiresConsent/excludedBy) are
// separate fields, as the interaction contract requires.
//
// D-R2 (not decided yet, so the defaults keep today's behaviour): how often to
// suggest ('always' | 'firstMessage' | 'off') and a 'never suggest' list of
// sites and folders are user settings (bridge-settings contextSuggest). The
// mode and the ignore list follow VS Code chat implicit context (MIT, pattern
// only: chatImplicitContext.ts 'chat.implicitContext.enabled' always/first and
// the ignored-files check that drops a value instead of offering it).
// Explicit picks are never filtered: they are the person's own choice.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { chatError } from './codex-chat-values.mjs'

export const RESOLVER_POLICY = 'suggest-only'
// Kinds the screen reports as signals.
export const RESOLVER_KINDS = Object.freeze(['browser', 'file', 'board-element'])
// Kinds a candidate can have: a saved Board matching the words being typed is
// found by the bridge (Board search), never reported by the screen.
export const RESOLVER_CANDIDATE_KINDS = Object.freeze([...RESOLVER_KINDS, 'board'])
// Fixed reason codes, strongest first. The weights are the ranking contract.
export const RESOLVER_REASON_WEIGHTS = Object.freeze({
  explicit: 100, focused: 40, activeBoardMember: 30, sameCluster: 20, matchingBoard: 15, visibleLarge: 10, recentlyUsed: 8,
})
export const RESOLVER_REASONS = Object.freeze(Object.keys(RESOLVER_REASON_WEIGHTS))
// otherAccount/noPermission candidates are listed (they only fill leftover
// slots). userExcluded ones (the 'never suggest' list) are left out entirely
// and only counted in resolution.suggest.omittedByUser.
export const RESOLVER_EXCLUSIONS = Object.freeze(['otherAccount', 'noPermission', 'userExcluded'])
export const RESOLVER_LIMITS = Object.freeze({
  candidates: 12, explicit: 16, visible: 64, clusters: 32, clusterSize: 64, recent: 32, scopes: 8, chosen: 16,
  boards: 3, query: 200, queryWords: 6,
})
export const CONTEXT_SUGGEST_MODES = Object.freeze(['always', 'firstMessage', 'off'])
export const CONTEXT_SUGGEST_LIMITS = Object.freeze({ entries: 64, path: 1024 })
// Today's behaviour: always suggest, nothing on the 'never suggest' list.
export const CONTEXT_SUGGEST_DEFAULT = Object.freeze({ mode: 'always', neverSuggest: Object.freeze([]) })
// area is the visible fraction of the Desk viewport (0..1).
export const VISIBLE_LARGE_AREA = 0.2
export const RECENT_WINDOW_MS = 30 * 60 * 1000
const FUTURE_SKEW_MS = 5 * 60 * 1000

// Opaque screen identifiers only (e.g. view ids like `egd-file-card-12`).
// No spaces, slashes or '@': paths, URLs and e-mail style identifiers are refused.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/
// A lowercase host name only (what URL.hostname gives): no scheme, port,
// path, query or user part. Used to match the 'never suggest' sites.
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const CONTROL = /[\u0000-\u001f\u007f]/
// site: the host of a Browser resource. userExcluded: the screen matched the
// resource against a 'never suggest' folder (it has the path; signals never carry paths).
const RESOURCE_KEYS = ['kind', 'ref', 'accountScope', 'permission', 'signedIn', 'site', 'userExcluded']
const SHAPES = {
  // firstMessage: the room has no message yet (for mode 'firstMessage').
  signals: ['boardId', 'explicit', 'visible', 'cluster', 'recent', 'account', 'firstMessage'],
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
  if (value.site !== undefined) {
    if (typeof value.site !== 'string' || !HOST.test(value.site)) invalid(`${name}.site must be a lowercase host name only`)
    item.site = value.site
  }
  if (value.userExcluded !== undefined) {
    if (typeof value.userExcluded !== 'boolean') invalid(`${name}.userExcluded must be true or false`)
    if (value.userExcluded) item.userExcluded = true
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
  if (input.firstMessage !== undefined) {
    if (typeof input.firstMessage !== 'boolean') invalid('firstMessage must be true or false')
    signals.firstMessage = input.firstMessage
  }
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

// POST /context/resolve body = signals + optional `query` (the words being
// typed, for matching saved Boards). The query is kept apart from the signals:
// it is not part of the digest, the stored resolution or the run record, and
// it is never logged — it only reaches the Board search in memory.
export function validateResolverRequest(input) {
  if (!plain(input)) invalid('signals must be an object')
  const { query, ...rest } = input
  const signals = validateResolverSignals(rest)
  if (query === undefined || query === null) return { signals, query: null }
  if (typeof query !== 'string' || query.length > RESOLVER_LIMITS.query * 4) invalid(`query must be text of at most ${RESOLVER_LIMITS.query} characters`)
  return { signals, query: boardQueryWords(query).join(' ') || null }
}

// Words worth searching Boards for: NFC, whitespace split, 2+ characters
// (one Korean syllable or letter matches too much), distinct, the longest
// RESOLVER_LIMITS.queryWords kept in their typed order, at most 200 characters.
export function boardQueryWords(text) {
  if (typeof text !== 'string') return []
  const words = [...new Set(text.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').split(/\s+/).filter(word => Array.from(word).length >= 2))]
  const kept = new Set([...words].sort((a, b) => Array.from(b).length - Array.from(a).length).slice(0, RESOLVER_LIMITS.queryWords))
  const result = []
  let length = 0
  for (const word of words) if (kept.has(word)) {
    const size = Array.from(word).length + (result.length ? 1 : 0)
    if (length + size > RESOLVER_LIMITS.query) break
    result.push(word)
    length += size
  }
  return result
}

const suggestError = message => { throw chatError('INVALID_CONTEXT_SUGGEST', message, 400) }

// One 'never suggest' entry: { kind: 'site', host } covers the host and its
// subdomains; { kind: 'folder', path } is an absolute folder the screen checks
// file resources against (it sends userExcluded: true for those).
function suggestEntry(value, index) {
  const name = `neverSuggest[${index}]`
  if (!plain(value)) suggestError(`${name} must be an object`)
  if (value.kind === 'site') {
    if (Object.keys(value).some(key => !['kind', 'host'].includes(key))) suggestError(`${name} accepts kind and host only`)
    const host = typeof value.host === 'string' ? value.host.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '') : ''
    if (!HOST.test(host)) suggestError(`${name}.host must be a host name such as bank.example.com, without scheme or path`)
    return { kind: 'site', host }
  }
  if (value.kind === 'folder') {
    if (Object.keys(value).some(key => !['kind', 'path'].includes(key))) suggestError(`${name} accepts kind and path only`)
    if (typeof value.path !== 'string' || !value.path || value.path.length > CONTEXT_SUGGEST_LIMITS.path || CONTROL.test(value.path) || !path.isAbsolute(value.path)) {
      suggestError(`${name}.path must be an absolute folder path of at most ${CONTEXT_SUGGEST_LIMITS.path} characters`)
    }
    return { kind: 'folder', path: path.resolve(value.path) }
  }
  return suggestError(`${name}.kind must be site or folder`)
}

/**
 * normalizeContextSuggest({ mode, neverSuggest }) -> frozen normalized copy.
 * Throws INVALID_CONTEXT_SUGGEST (400). Duplicates are dropped, order kept.
 */
export function normalizeContextSuggest(value) {
  if (!plain(value) || Object.keys(value).some(key => !['mode', 'neverSuggest'].includes(key))) suggestError('contextSuggest accepts mode and neverSuggest only')
  if (!CONTEXT_SUGGEST_MODES.includes(value.mode)) suggestError(`mode must be one of ${CONTEXT_SUGGEST_MODES.join(', ')}`)
  if (!Array.isArray(value.neverSuggest) || value.neverSuggest.length > CONTEXT_SUGGEST_LIMITS.entries) suggestError(`neverSuggest must list at most ${CONTEXT_SUGGEST_LIMITS.entries} entries`)
  const seen = new Set(), neverSuggest = []
  value.neverSuggest.forEach((item, index) => {
    const entry = suggestEntry(item, index)
    const key = `${entry.kind}\0${entry.host ?? entry.path}`
    if (seen.has(key)) return
    seen.add(key)
    neverSuggest.push(Object.freeze(entry))
  })
  return Object.freeze({ mode: value.mode, neverSuggest: Object.freeze(neverSuggest) })
}

const siteExcluded = (site, neverSuggest) => Boolean(site) && neverSuggest.some(entry => entry.kind === 'site' && (site === entry.host || site.endsWith(`.${entry.host}`)))

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
  if (current.site && item.site && current.site !== item.site) invalid(`ref ${item.ref} is reported with two sites`)
  current.site ||= item.site
  if (item.userExcluded) current.userExcluded = true
  if (item.permission === 'denied' || !current.permission) current.permission = item.permission || current.permission
  if (item.signedIn) current.signedIn = true
  for (const key of ['boardId', 'focused', 'area', 'lastInteractedAt', 'clusterId']) if (item[key] !== undefined) current[key] = item[key]
  if (item.at !== undefined) current.at = Math.max(current.at ?? 0, item.at)
  current.sources.add(source)
}

// Deterministic ranking: score desc → most recent interaction desc → larger
// visible area desc → Board search order → ref asc. Selectable candidates come
// first; excluded ones only fill leftover slots so they never push out a
// usable suggestion.
//
// suggest: the normalized contextSuggest setting (default: always, empty list).
//   mode 'off', or 'firstMessage' when signals.firstMessage is not true, keeps
//   only explicit picks; everything else is counted in suggest.omittedByMode.
//   A site on the list, or a resource the screen marked userExcluded, is left
//   out (unless the person picked it explicitly) and counted in omittedByUser.
// matchingBoards: saved Boards whose text matched the typed words, best first
//   ([{ boardId }]); the active Board and refs already reported are skipped.
export function resolveContext(signals, { now = Date.now(), suggest = CONTEXT_SUGGEST_DEFAULT, matchingBoards = [] } = {}) {
  if (!Number.isSafeInteger(now)) throw new TypeError('now must be a millisecond timestamp')
  const settings = suggest === CONTEXT_SUGGEST_DEFAULT ? suggest : normalizeContextSuggest(suggest)
  const implicitAllowed = settings.mode === 'always' || (settings.mode === 'firstMessage' && signals.firstMessage === true)
  const omitted = { omittedByMode: 0, omittedByUser: 0 }
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
    if (!entry.sources.has('explicit')) {
      if (!implicitAllowed) { omitted.omittedByMode += 1; continue }
      if (entry.userExcluded || siteExcluded(entry.site, settings.neverSuggest)) { omitted.omittedByUser += 1; continue }
    }
    const candidate = {
      ref: entry.ref, kind: entry.kind,
      score: reasons.reduce((sum, reason) => sum + RESOLVER_REASON_WEIGHTS[reason], 0),
      reasons,
      // Browser Card content and signed-in pages are suggested, never auto-included.
      requiresConsent: !entry.sources.has('explicit') && (entry.kind === 'browser' || entry.signedIn === true),
    }
    if (entry.accountScope && !scopes.includes(entry.accountScope)) candidate.excludedBy = 'otherAccount'
    else if (entry.permission === 'denied') candidate.excludedBy = 'noPermission'
    candidates.push({ candidate, lastSeen: Math.max(entry.lastInteractedAt ?? 0, entry.at ?? 0), area: entry.area || 0, searchRank: Infinity })
  }
  // CTX-03 matchingBoard: ids and the reason code only; titles and snippets stay with the Board.
  const boardsSeen = new Set()
  for (const match of Array.isArray(matchingBoards) ? matchingBoards : []) {
    const boardId = match?.boardId
    if (typeof boardId !== 'string' || !TOKEN.test(boardId) || boardId === board?.boardId || entries.has(boardId) || boardsSeen.has(boardId)) continue
    if (boardsSeen.size >= RESOLVER_LIMITS.boards) break
    boardsSeen.add(boardId)
    if (!implicitAllowed) { omitted.omittedByMode += 1; continue }
    candidates.push({
      candidate: { ref: boardId, kind: 'board', score: RESOLVER_REASON_WEIGHTS.matchingBoard, reasons: ['matchingBoard'], requiresConsent: false },
      lastSeen: 0, area: 0, searchRank: boardsSeen.size,
    })
  }
  const order = (a, b) => b.candidate.score - a.candidate.score || b.lastSeen - a.lastSeen || b.area - a.area || a.searchRank - b.searchRank || byRef(a.candidate, b.candidate)
  const selectable = candidates.filter(item => !item.candidate.excludedBy).sort(order)
  const excluded = candidates.filter(item => item.candidate.excludedBy).sort(order)
  const ranked = [...selectable, ...excluded].slice(0, RESOLVER_LIMITS.candidates).map(item => item.candidate)
  return {
    policy: RESOLVER_POLICY, resolvedAt: now, signalsDigest: resolverSignalsDigest(signals), board, candidates: ranked,
    suggest: { mode: settings.mode, ...omitted },
  }
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
