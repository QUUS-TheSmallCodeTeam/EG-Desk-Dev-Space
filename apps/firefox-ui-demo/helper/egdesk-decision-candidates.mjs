import { candidatesFromOntologyGraph } from './egdesk-context-setup.mjs'

// Candidate collection for the pre-turn context setup (DECISION_MODEL_CONTEXT_SETUP.md §3.1).
// Code only, no model: titles, short summaries and time slices of
//   - the sources and attachments the person selected for this message,
//   - a metadata-only handle for recent speech in a consenting verified Agent DM,
//   - the Board this message is sent from (desk store),
//   - the ontology graph (snapshots and nodes).
// Every source is optional and read inside its own try: a missing or broken
// store only means fewer candidates. Full text is loaded lazily (loadText)
// and only for the items the decision model selects. A thread identifier alone never authorizes transcript access.

const text = value => (typeof value === 'string' ? value.trim() : '')
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const ID = /^[A-Za-z0-9._:-]{1,200}$/

export const DEFAULT_RECENT_MESSAGES = 12

// A memory handle is a selector, never a grant. Its client label/URL must not
// fall back to an ordinary source, even when the host declines the read.
const MEMORY_ROW = /^memrow:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function selectionCandidates(body, memoryEvidenceFor) {
  const out = []
  const seen = new Set()
  const memoryHandles = new Set()
  for (const [field, list] of [['selectedSources', body?.selectedSources], ['attachments', body?.attachments]]) {
    if (!Array.isArray(list)) continue
    for (const [index, item] of list.entries()) {
      if (!record(item)) continue
      const handle = text(item.id)
      if (handle.startsWith('memrow:') || item.kind === 'memory-evidence') {
        if (field !== 'selectedSources' || !MEMORY_ROW.test(handle) || !memoryEvidenceFor || memoryHandles.size >= 8 || memoryHandles.has(handle)) continue
        memoryHandles.add(handle)
        const access = memoryEvidenceFor(handle)
        if (access) out.push({ id: 'memory-selection:' + index, kind: 'source', title: '선택한 장부 행',
          summary: '연결한 원본 기록', timeSlice: 'unknown', mandatory: true,
          mayRead: access.mayRead, loadText: access.loadText, noteSent: access.noteSent })
        continue
      }
      const title = text(item.label) || text(item.title) || text(item.name) || text(item.url)
      if (!title) continue
      const key = text(item.id) || `${field}-${index}`
      const id = `selected:${ID.test(key) ? key : `${field}-${index}`}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, kind: 'source', title: clip(title, 200), summary: text(item.kind) ? `selected ${text(item.kind)}` : 'selected by the person',
        timeSlice: 'present', ...(text(item.url) ? { sourceRef: clip(text(item.url), 500) } : {}) })
    }
  }
  // Explicit selection wins, even if it is no longer usable. Never silently substitute another grant.
  if (!body?.selectedSources?.length && !body?.attachments?.length && !body?.contextSnapshotIds?.length) {
    const access = memoryEvidenceFor?.discover?.(body.message)
    if (access) out.push({ id: 'memory-lookup:0', kind: 'source', title: '이 대화에서 허용한 기억',
      summary: '질문과 일치하는 원본 기록', timeSlice: 'unknown', mandatory: true,
      mayRead: access.mayRead, loadText: access.loadText, noteSent: access.noteSent })
  }
  return out
}

function boardText(head) {
  const value = head?.body
  if (typeof value === 'string') return value
  if (record(value) && typeof value.text === 'string') return value.text
  try { return value === undefined ? '' : JSON.stringify(value) } catch { return '' }
}

function boardCandidates(deskStore, boardId) {
  if (!deskStore || typeof deskStore.board !== 'function' || !text(boardId)) return []
  const board = deskStore.board(boardId)
  if (!record(board)) return []
  const full = boardText(board.head)
  return [{ id: `board:${ID.test(text(board.id)) ? board.id : 'current'}`, kind: 'board', title: clip(text(board.title) || 'Board', 200),
    summary: clip(full.replace(/\s+/g, ' ').trim(), 300), timeSlice: 'present', ...(full ? { loadText: () => full } : {}) }]
}

/**
 * collectDecisionCandidates({ body, clientThreadId, excludeMessageId?, chatStore?, deskStore?, ontologyStore?, maxMessages? })
 * excludeMessageId: the message being sent (already saved), left out of the recent messages.
 * → { candidates, sources: { selected, messages, board, ontology } (counts; -1 when a store failed) }
 * Never throws. ontologyStore may be a function returning the store (the
 * bridge opens it lazily).
 */
export async function collectDecisionCandidates({ body = {}, clientThreadId = null, excludeMessageId = null, chatStore = null, deskStore = null, ontologyStore = null,
  memoryEvidenceFor = null, speech = null } = {}) {
  const sources = { selected: 0, messages: 0, board: 0, ontology: 0 }
  const take = async (name, read) => {
    try { const list = await read(); sources[name] = list.length; return list }
    catch { sources[name] = -1; return [] }
  }
  const selected = await take('selected', () => selectionCandidates(body, memoryEvidenceFor))
  const board = await take('board', () => boardCandidates(deskStore, body?.boardId))
  // No unconsented transcript, title preview, speaker text or fallback on Board/advisory.
  const messages = await take('messages', () => { const c = speech?.candidate(); return c ? [c] : [] })
  const ontology = await take('ontology', async () => {
    const store = typeof ontologyStore === 'function' ? ontologyStore() : ontologyStore
    if (!store || typeof store.readGraph !== 'function') return []
    return candidatesFromOntologyGraph(await store.readGraph())
  })
  return { candidates: [...selected, ...board, ...messages, ...ontology], sources }
}
