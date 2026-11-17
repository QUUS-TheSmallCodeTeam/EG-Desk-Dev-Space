import { candidatesFromOntologyGraph } from './egdesk-context-setup.mjs'

// Candidate collection for the pre-turn context setup (DECISION_MODEL_CONTEXT_SETUP.md §3.1).
// Code only, no model: titles, short summaries and time slices of
//   - the sources and attachments the person selected for this message,
//   - the recent messages of this conversation (chat store),
//   - the Board this message is sent from (desk store),
//   - the ontology graph (snapshots and nodes).
// Every source is optional and read inside its own try: a missing or broken
// store only means fewer candidates. Full text is loaded lazily (loadText)
// and only for the items the decision model selects.

const text = value => (typeof value === 'string' ? value.trim() : '')
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const ID = /^[A-Za-z0-9._:-]{1,200}$/

export const DEFAULT_RECENT_MESSAGES = 12
const MESSAGE_PAGES = 5 // listMessages pages oldest first; read at most this many pages
const MESSAGE_PAGE = 100

function selectionCandidates(body) {
  const out = []
  const seen = new Set()
  for (const [field, list] of [['selectedSources', body?.selectedSources], ['attachments', body?.attachments]]) {
    if (!Array.isArray(list)) continue
    for (const [index, item] of list.entries()) {
      if (!record(item)) continue
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
  return out
}

function messageText(message) {
  if (typeof message?.text === 'string') return message.text
  if (typeof message?.content === 'string') return message.content
  return ''
}

function recentMessageCandidates(chatStore, clientThreadId, limit, excludeId) {
  if (!chatStore || typeof chatStore.listMessages !== 'function' || !text(clientThreadId)) return []
  let rows = []
  let after = 0
  for (let page = 0; page < MESSAGE_PAGES; page++) {
    const result = chatStore.listMessages(clientThreadId, { afterSeq: after, limit: MESSAGE_PAGE })
    rows = rows.concat(Array.isArray(result?.messages) ? result.messages : []).slice(-(limit + 1))
    if (!result?.hasMore || !Number.isSafeInteger(result.nextCursor)) break
    after = result.nextCursor
  }
  return rows.flatMap((message, index) => {
    if (excludeId && message?.localMessageId === excludeId) return []
    const body = text(messageText(message))
    if (!body) return []
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const key = text(message.localMessageId) || text(message.id) || `m${index}`
    return [{ id: `message:${ID.test(key) ? key : `m${index}`}`, kind: 'conversation', title: `${role === 'user' ? '사용자' : '답변'}: ${clip(body.replace(/\s+/g, ' '), 80)}`,
      summary: clip(body, 300), timeSlice: 'past', loadText: () => body }]
  })
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
  maxMessages = DEFAULT_RECENT_MESSAGES } = {}) {
  const sources = { selected: 0, messages: 0, board: 0, ontology: 0 }
  const take = async (name, read) => {
    try { const list = await read(); sources[name] = list.length; return list }
    catch { sources[name] = -1; return [] }
  }
  const selected = await take('selected', () => selectionCandidates(body))
  const board = await take('board', () => boardCandidates(deskStore, body?.boardId))
  const messages = await take('messages', () => recentMessageCandidates(chatStore, clientThreadId, maxMessages, excludeMessageId).slice(-maxMessages))
  const ontology = await take('ontology', async () => {
    const store = typeof ontologyStore === 'function' ? ontologyStore() : ontologyStore
    if (!store || typeof store.readGraph !== 'function') return []
    return candidatesFromOntologyGraph(await store.readGraph())
  })
  return { candidates: [...selected, ...board, ...messages, ...ontology], sources }
}
