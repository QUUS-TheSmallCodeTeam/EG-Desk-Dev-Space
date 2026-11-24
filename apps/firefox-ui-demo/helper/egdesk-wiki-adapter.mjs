import { createHash } from 'node:crypto'
import { candidatesFromOntologyGraph } from './egdesk-context-setup.mjs'
import { openPrivateJsonStore } from './egdesk-private-json-store.mjs'
import { LINK_TYPES, PROVENANCE_BASES, PROVENANCE_KINDS, TIME_SLICES, buildWiki, record } from './egdesk-wiki-reconstruction.mjs'
import { createWikiWriter, mergeSpeechLabels } from './egdesk-turn-memory.mjs'

// The llm-wiki ADAPTER: maps the stores the product already has into wiki pages and typed links, once per turn, in memory.
//   ontology graph      -> pages with the graph's own edges (and snapshot continuations) as typed links
//   Board / selected    -> pages from the candidates this run may read (their own mayRead guard)
//   speech records      -> utterance pages, with the isolated speech labels where they were installed
//   conversation pairs  -> pages from completed pairs of the session topic store, linked by its parent/needs graph
//   written pages       -> the only thing this module persists: what the write path accepted
// Rules: no second copy of raw content where a stable reference to the existing store will do (ref + contentKey from that
// store, the body is read for this turn only); every page keeps the permission it had in its own store (mayRead, scope);
// the revision of a page comes from its store, so receipts notice a change. Nothing here calls a model.

const MAX = Object.freeze({ ontology: 120, candidates: 40, speech: 12, topic: 24, written: 100, body: 2400 })
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/
const sha = text => createHash('sha256').update(String(text)).digest('hex')
const sha12 = text => sha(text).slice(0, 12)
export const safeId = id => (typeof id === 'string' && SAFE_ID.test(id) ? id : `x/${sha12(id)}`)
const clip = (text, n) => (text.length > n ? text.slice(0, n) : text)
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)
const statusOfCandidate = status => (typeof status !== 'string' ? 'unknown' : /plan|draft|propos/i.test(status) ? 'plan' : /done|complete|observ|current|live/i.test(status) ? 'done' : 'unknown')
const REVISION_OK = /^[A-Za-z0-9._-]{1,40}$/

// ---- mappers: each returns raw page objects for buildWiki ----

/** Candidates (ontology graph via candidatesFromOntologyGraph, Board, selected sources) -> pages. Bodies are read now, for this turn. */
// Least privilege: a Board's items are readable only inside that Board's contexts (scope `board:<id>`), a source the person selected for
// this message only in this DM, and the ontology graph is workspace-wide (no scope), as it already is for the decision catalog.
const candidateScope = (c, dmScope) => (/^board:/.test(c.id) ? c.id : /^selected:/.test(c.id) ? dmScope : null)

export async function pagesFromCandidates(candidates, { max = MAX.candidates, skip = () => false, dmScope = null } = {}) {
  const out = []
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (out.length >= max) break
    if (!record(c) || typeof c.id !== 'string' || /^(memory-|conversation:)/.test(c.id) || skip(c)) continue
    let body = ''
    try {
      if (typeof c.loadText === 'function') { const loaded = await c.loadText(); if (typeof loaded === 'string') body = loaded }
      if (!body.trim() && typeof c.summary === 'string') body = c.summary
    } catch { body = typeof c.summary === 'string' ? c.summary : '' }
    body = clip(body.trim() || String(c.title ?? ''), MAX.body)
    if (!body.trim()) continue
    const mayRead = typeof c.mayRead === 'function' ? c.mayRead : null
    out.push({ id: safeId(c.id), title: String(c.title ?? c.id), body, revision: sha12(`${c.title}\u0000${body}`),
      time: { slice: TIME_SLICES.includes(c.timeSlice) ? c.timeSlice : 'unknown' }, provenance: { kind: 'document' }, status: statusOfCandidate(c.status), scope: candidateScope(c, dmScope),
      ...(typeof c.sourceRef === 'string' && c.sourceRef ? { ref: c.sourceRef } : {}), ...(mayRead ? { mayRead } : {}),
      links: (Array.isArray(c.links) ? c.links : []).map(l => ({ type: l.type, to: safeId(l.to) })) })
  }
  return out
}

export const pagesFromOntologyGraph = (graph, options = {}) => pagesFromCandidates(candidatesFromOntologyGraph(graph), { max: MAX.ontology, ...options })

/**
 * Speech records (the consenting DM's recent utterances, already verified against the chat store by the runtime) -> utterance pages.
 * record: { localMessageId, role, quote, spokenAt (ISO), sequence, hash, interpretations: [{ source, form, time }] }
 * The time slice and basis come only from labels that were installed (isolated axes above their bars); nothing is guessed.
 */
export function pagesFromSpeechRecords(records, { scope, mayRead = null, max = MAX.speech } = {}) {
  const list = (Array.isArray(records) ? records : []).filter(r => record(r) && typeof r.localMessageId === 'string' && typeof r.quote === 'string' && r.quote.trim()).slice(-max)
  const out = []
  let previous = null
  for (const r of list) {
    const user = r.role === 'user'
    const label = user ? mergeSpeechLabels(Array.isArray(r.interpretations) ? r.interpretations : []) : null
    const attrs = label ? label.record : null
    const id = safeId(`speech/${r.localMessageId}`)
    out.push({ id, title: clip(r.quote.replace(/\s+/g, ' ').trim(), 40), body: clip(r.quote, MAX.body), revision: `s${Number.isSafeInteger(r.sequence) ? r.sequence : sha12(r.quote)}`,
      time: { slice: attrs && ['past', 'present', 'planned', 'hypothetical'].includes(attrs.slice) ? attrs.slice : 'unknown' },
      provenance: { kind: attrs?.provenance.kind ?? 'utterance', by: user ? 'user' : 'Agent', ...(attrs?.provenance.basis && PROVENANCE_BASES.includes(attrs.provenance.basis) ? { basis: attrs.provenance.basis } : {}) },
      status: attrs && (attrs.status === 'plan' || attrs.status === 'done') ? attrs.status : 'unknown', scope, ...(typeof r.spokenAt === 'string' ? { spokenAt: r.spokenAt } : {}),
      ref: `chat-message:${r.localMessageId}`, ...(typeof r.hash === 'string' ? { contentKey: `h:${r.hash.slice(0, 40)}` } : {}), ...(mayRead ? { mayRead } : {}),
      links: previous ? [{ type: 'follows_from', to: previous }] : [] })
    previous = id
  }
  return out
}

/** Completed conversation pairs of the session topic store -> pages, linked by that store's own parent / topic / needs graph. */
export function pagesFromTopicTurns(turns, { scope, mayRead = null, max = MAX.topic } = {}) {
  const list = (Array.isArray(turns) ? turns : []).filter(t => record(t) && typeof t.key === 'string' && typeof t.userText === 'string' && typeof t.assistantText === 'string').slice(-max)
  const known = new Set(list.map(t => t.key))
  return list.map(t => {
    const links = []
    if (typeof t.parent === 'string' && known.has(t.parent)) links.push({ type: 'follows_from', to: safeId(`topic/${t.parent}`) })
    if (typeof t.topic === 'string' && t.topic !== t.key && known.has(t.topic)) links.push({ type: 'same_task', to: safeId(`topic/${t.topic}`) })
    for (const need of Array.isArray(t.needs) ? t.needs : []) if (known.has(need) && need !== t.key) links.push({ type: 'refers_to', to: safeId(`topic/${need}`) })
    const body = clip(`User: ${t.userText}\nAgent: ${t.assistantText}`, MAX.body)
    return { id: safeId(`topic/${t.key}`), title: clip(t.userText.replace(/\s+/g, ' ').trim(), 40), body,
      revision: Number.isSafeInteger(t.seq) ? `s${t.seq}` : sha12(body), time: { slice: 'unknown' }, provenance: { kind: 'utterance', by: 'user+Agent' }, status: 'unknown', scope,
      ...(typeof t.spokenAt === 'string' ? { spokenAt: t.spokenAt } : {}), ref: `chat-pair:${t.key}`,
      ...(typeof t.userHash === 'string' && typeof t.assistantHash === 'string' ? { contentKey: `t:${t.userHash.slice(0, 16)}:${t.assistantHash.slice(0, 16)}` } : {}), ...(mayRead ? { mayRead } : {}), links }
  })
}

// ---- the persistent store: only what the write path accepted ----

const WRITES_FILE = 'egdesk-wiki-writes.json'
const WRITES_LIMITS = Object.freeze({ pages: 200, readings: 200, bytes: 256 * 1024, body: 2000 })
const READING_STATES = new Set(['pending', 'accepted'])
const STATUSES = new Set(['plan', 'done'])
const SOURCE_STATUSES = new Set(['plan', 'done', 'unknown'])
const SLICE_SET = new Set(['past', 'present', 'planned', 'hypothetical'])
const KIND_SET = new Set(PROVENANCE_KINDS)

function storedPage(raw) {
  if (!record(raw) || typeof raw.id !== 'string' || !SAFE_ID.test(raw.id) || typeof raw.title !== 'string' || !raw.title.trim()) return null
  const hasBody = typeof raw.body === 'string' && raw.body.trim(), hasRef = typeof raw.ref === 'string' && raw.ref.trim()
  if (!hasBody && !hasRef) return null
  if (!REVISION_OK.test(String(raw.revision ?? '')) || !SLICE_SET.has(raw.time?.slice) || !KIND_SET.has(raw.provenance?.kind)) return null
  return { id: raw.id, title: clip(raw.title, 160), ...(hasBody && !hasRef ? { body: clip(raw.body, WRITES_LIMITS.body) } : {}), ...(hasRef ? { ref: clip(raw.ref, 300) } : {}),
    revision: String(raw.revision), time: { slice: raw.time.slice },
    provenance: { kind: raw.provenance.kind, ...(typeof raw.provenance.by === 'string' ? { by: clip(raw.provenance.by, 60) } : {}), ...(PROVENANCE_BASES.includes(raw.provenance.basis) ? { basis: raw.provenance.basis } : {}) },
    status: SOURCE_STATUSES.has(raw.status) ? raw.status : 'unknown', scope: typeof raw.scope === 'string' ? raw.scope : null,
    ...(typeof raw.spokenAt === 'string' && !Number.isNaN(Date.parse(raw.spokenAt)) ? { spokenAt: raw.spokenAt } : {}),
    links: (Array.isArray(raw.links) ? raw.links : []).filter(l => record(l) && Object.hasOwn(LINK_TYPES, l.type) && typeof l.to === 'string' && SAFE_ID.test(l.to)).slice(0, 16).map(l => ({ type: l.type, to: l.to })) }
}
function storedReading(raw) {
  if (!record(raw) || typeof raw.pageId !== 'string' || !SAFE_ID.test(raw.pageId) || !REVISION_OK.test(String(raw.sourceRevision ?? '')) || !record(raw.reading) ||
      !STATUSES.has(raw.reading.status) || !READING_STATES.has(raw.reading.state)) return null
  return { pageId: raw.pageId, sourceRevision: String(raw.sourceRevision), reading: { status: raw.reading.status, state: raw.reading.state,
    basis: PROVENANCE_BASES.includes(raw.reading.basis) ? raw.reading.basis : null,
    ...(typeof raw.reading.spokenAt === 'string' && !Number.isNaN(Date.parse(raw.reading.spokenAt)) ? { spokenAt: raw.reading.spokenAt } : {}),
    ...(typeof raw.reading.confirmedAt === 'string' && !Number.isNaN(Date.parse(raw.reading.confirmedAt)) ? { confirmedAt: raw.reading.confirmedAt } : {}) } }
}
const normalizeWrites = data => ({ pages: (Array.isArray(data?.pages) ? data.pages : []).map(storedPage).filter(Boolean).slice(-WRITES_LIMITS.pages),
  readings: (Array.isArray(data?.readings) ? data.readings : []).map(storedReading).filter(Boolean).slice(-WRITES_LIMITS.readings) })

/** openWikiWrites({ dataDir }) -> { status, read(), apply(change) -> true|throws }. Bounded, 0600, never exported. */
export function openWikiWrites({ dataDir, log, now } = {}) {
  const store = openPrivateJsonStore({ dataDir, file: WRITES_FILE, version: 1, maxBytes: WRITES_LIMITS.bytes, empty: () => ({ pages: [], readings: [] }), normalize: normalizeWrites, log, now })
  return Object.freeze({
    get status() { return store.status },
    read: () => store.data,
    // Throws when nothing was kept, so the writer leaves the wiki unchanged.
    apply(change) {
      const data = store.data
      if (change?.kind === 'page') {
        // A page that only references the chat store keeps neither the words nor a title cut from them.
        const page = storedPage(change.viaRef ? { ...change.page, body: undefined, title: 'referenced utterance' } : change.page)
        if (!page) throw new Error('page not storable')
        data.pages = [...data.pages.filter(p => p.id !== page.id), page]
      } else if (change?.kind === 'reading') {
        const entry = storedReading({ pageId: change.pageId, sourceRevision: change.sourceRevision, reading: change.reading })
        if (!entry) throw new Error('reading not storable')
        data.readings = [...data.readings, entry]
      } else throw new Error('unknown change')
      while (true) { // trim to the limits; the store itself refuses anything over its byte cap
        if (store.save(data)) return true
        if (data.pages.length > 1) data.pages.shift(); else if (data.readings.length > 1) data.readings.shift(); else throw new Error('store full or unavailable')
      }
    },
  })
}

// Written reading overlay: a reading belongs to the exact source revision it was made against. A page whose source changed since
// is not decorated with a stale reading. Accepted readings override the status; pending ones are shown beside it.
export function overlayWrites(rawPages, written) {
  const byId = new Map(rawPages.map(p => [p.id, p]))
  const counts = new Map()
  for (const entry of written.readings) {
    const page = byId.get(entry.pageId)
    if (!page || page.revision !== entry.sourceRevision) continue
    const same = r => r.state === 'pending' && r.status === entry.reading.status && (r.spokenAt ?? null) === (entry.reading.spokenAt ?? null)
    // An accepted reading (the person's own later confirmation) replaces the pending reading it came from.
    page.statusReadings = [...(page.statusReadings ?? []).filter(r => entry.reading.state !== 'accepted' || !same(r)), entry.reading]
    if (entry.reading.state === 'accepted') page.status = entry.reading.status
    counts.set(page.id, (counts.get(page.id) ?? 0) + 1)
  }
  for (const [id, n] of counts) byId.get(id).revision = `${byId.get(id).revision}.r${n}`
  return rawPages
}

/**
 * createWikiAdapter({ writes?, now? }) -> { snapshot(input) -> Promise<wiki>, scopeFor(context), writerFor(wiki, options) }
 * snapshot({ context, graph, candidates, speechRecords, topicTurns, speechGuard, topicGuard }) — every part is optional; a part that
 * is missing or fails only means fewer pages. Returns the wiki (and wiki.adapter holds per-source counts for the receipt).
 */
export function createWikiAdapter({ writes = null } = {}) {
  const scopeKey = context => (typeof context?.clientThreadId === 'string' && context.clientThreadId ? `dm:${context.clientThreadId}` : null)
  return {
    // This DM, plus the Board the message is sent from (when there is one). No other Board, no other DM.
    scopeFor(context, body = null) {
      const key = scopeKey(context), board = typeof body?.boardId === 'string' && body.boardId.trim() ? body.boardId : null
      return { allowedScopes: [...(key ? [key] : []), ...(board ? [`board:${board}`, 'board:current'] : [])], writeScope: key }
    },
    async snapshot({ context = null, body = null, graph = null, candidates = [], speechRecords = null, topicTurns = null, speechGuard = null, topicGuard = null } = {}) {
      const scope = scopeKey(context), counts = {}
      const take = async (name, read) => { try { const list = await read(); counts[name] = list.length; return list } catch { counts[name] = -1; return [] } }
      const ontology = graph ? await take('ontology', () => pagesFromOntologyGraph(graph)) : []
      const boards = await take('candidates', () => pagesFromCandidates(candidates, { dmScope: scope }))
      const speech = speechRecords && scope ? await take('speech', async () => pagesFromSpeechRecords(await speechRecords(), { scope, mayRead: speechGuard })) : []
      const topic = topicTurns && scope ? await take('topic', async () => pagesFromTopicTurns(await topicTurns(), { scope, mayRead: topicGuard })) : []
      let raw = [...ontology, ...boards, ...speech, ...topic]
      let written = { pages: [], readings: [] }
      try { written = writes ? writes.read() : written } catch { /* a broken store only means no written pages */ }
      // Written pages: a body-less page keeps a reference into the chat store and exists only while that reference still resolves for this caller.
      const resolvable = new Map(speech.map(p => [p.ref, p]))
      const pages = []
      for (const p of written.pages) {
        if (p.scope && p.scope !== scope) continue
        if (p.body) { pages.push({ ...p, body: p.body }); continue }
        const source = resolvable.get(p.ref)
        if (source) pages.push({ ...p, title: source.title, body: source.body, contentKey: source.contentKey, mayRead: source.mayRead })
      }
      counts.written = pages.length
      raw = overlayWrites([...raw, ...pages.slice(-MAX.written)], written)
      const wiki = buildWiki(raw, { maxPages: 400 })
      wiki.adapter = { counts, dropped: wiki.warnings }
      return wiki
    },
    // The write path for a snapshot: persists what it accepts (a reference instead of a copy where the words already live in the chat store).
    // acceptStatus is not offered: no policy callback promotes a reading (see createWikiWriter.promote).
    writerFor(wiki, { enabled = false, canWrite = () => false, idFor = null } = {}) {
      return createWikiWriter(wiki, { enabled, canWrite, idFor, persist: writes ? change => writes.apply(change) : null })
    },
  }
}
