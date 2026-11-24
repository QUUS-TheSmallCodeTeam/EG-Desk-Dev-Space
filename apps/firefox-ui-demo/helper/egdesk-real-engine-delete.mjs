// c28: the real-engine proof of conversation deletion through the PRODUCT path. A persisted conversation with turns, then the window's own request
// (POST /chat/conversation/forget { clientThreadId }, the product's route handler), then by code: the chat store has no rows for it, the engine's thread is gone
// (thread/resume fails), a pending reading heard in it is withdrawn, its conversation-temporary memory is gone, memory of other scopes is kept (owner decisions L2 c17, c18).
// The memory is SEEDED (synthetic pages and readings written straight into the check's own isolated wiki-writes store), because what the models would write there is not
// deterministic; what is proven is the deletion, not the writing. Registered in helper/egdesk-real-engine-registrations.mjs (slot L5).
//
// conversation.seededWrites { pages: [{ id, title, body, scope: conversation | other | personal, pointer? }], readings: [{ page, state: pending | accepted, from?: conversation | other }] }
//   scope conversation = this conversation's own temporary scope (dm:<its clientThreadId>); other = another conversation's (dm:check-other-room); personal = a scope that is not a conversation's.
//   pointer: the page holds no text, only a reference to the conversation's first message (chat-message:<id>): after the deletion it stays as a text-less pointer marked sourceDeleted.
// turn { action: 'delete', expect: { deleted: { storeRowsGone?, engineGone?, pendingReadingsWithdrawn?, conversationMemoryGone?, otherMemoryKept?, pointerMarked?, routeAccepted? } } }
export const SEED_LIMITS = Object.freeze({ pages: 8, readings: 8, id: 60, title: 80, body: 400 })
export const OTHER_ROOM = 'check-other-room'
export const SEED_SCOPES = Object.freeze(['conversation', 'other', 'personal'])
export const DELETED_KEYS = Object.freeze(['routeAccepted', 'storeRowsGone', 'engineGone', 'pendingReadingsWithdrawn', 'conversationMemoryGone', 'otherMemoryKept', 'pointerMarked'])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,59}$/
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

export const SEEDED_WRITES_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  pages: { type: 'array', maxItems: SEED_LIMITS.pages, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'scope'],
    properties: { id: { type: 'string', pattern: SAFE_ID.source }, title: { type: 'string', minLength: 1, maxLength: SEED_LIMITS.title }, body: { type: 'string', minLength: 1, maxLength: SEED_LIMITS.body },
      scope: { enum: [...SEED_SCOPES] }, pointer: { const: true } } } },
  readings: { type: 'array', maxItems: SEED_LIMITS.readings, items: { type: 'object', additionalProperties: false, required: ['page', 'state'],
    properties: { page: { type: 'string', pattern: SAFE_ID.source }, state: { enum: ['pending', 'accepted'] }, from: { enum: ['conversation', 'other'] } } } } } })
export const DELETED_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: Object.fromEntries(DELETED_KEYS.map(k => [k, { const: true }])) })

export function validateSeededWrites(value, where = '$.seededWrites') {
  const errors = [], bad = (at, why) => errors.push(`${at}: ${why}`)
  if (!isObject(value) || !Object.keys(value).length) return [`${where}: an object { pages?, readings? }`]
  for (const key of Object.keys(value)) if (!['pages', 'readings'].includes(key)) bad(`${where}.${key}`, 'unknown key')
  const pages = value.pages ?? [], readings = value.readings ?? [], ids = new Set()
  if (!Array.isArray(pages) || pages.length > SEED_LIMITS.pages) bad(`${where}.pages`, `at most ${SEED_LIMITS.pages} pages`)
  else pages.forEach((p, i) => {
    const at = `${where}.pages[${i}]`
    if (!isObject(p)) return bad(at, 'an object')
    for (const key of Object.keys(p)) if (!['id', 'title', 'body', 'scope', 'pointer'].includes(key)) bad(`${at}.${key}`, 'unknown key')
    if (typeof p.id !== 'string' || !SAFE_ID.test(p.id)) bad(`${at}.id`, `matches ${SAFE_ID.source}`); else if (ids.has(p.id)) bad(`${at}.id`, 'unique'); else ids.add(p.id)
    if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > SEED_LIMITS.title) bad(`${at}.title`, `1-${SEED_LIMITS.title} characters`)
    if (!SEED_SCOPES.includes(p.scope)) bad(`${at}.scope`, SEED_SCOPES.join(' / '))
    if (p.pointer === true && p.body !== undefined) bad(`${at}`, 'a pointer page has no body')
    if (p.pointer !== true && (typeof p.body !== 'string' || !p.body.trim() || p.body.length > SEED_LIMITS.body)) bad(`${at}.body`, `1-${SEED_LIMITS.body} characters (or pointer: true)`)
    if (p.pointer !== undefined && p.pointer !== true) bad(`${at}.pointer`, 'true')
  })
  if (!Array.isArray(readings) || readings.length > SEED_LIMITS.readings) bad(`${where}.readings`, `at most ${SEED_LIMITS.readings} readings`)
  else readings.forEach((r, i) => {
    const at = `${where}.readings[${i}]`
    if (!isObject(r)) return bad(at, 'an object')
    for (const key of Object.keys(r)) if (!['page', 'state', 'from'].includes(key)) bad(`${at}.${key}`, 'unknown key')
    if (typeof r.page !== 'string' || !ids.has(r.page)) bad(`${at}.page`, 'the id of a seeded page')
    if (!['pending', 'accepted'].includes(r.state)) bad(`${at}.state`, 'pending / accepted')
    if (r.from !== undefined && !['conversation', 'other'].includes(r.from)) bad(`${at}.from`, 'conversation / other')
    if (r.from !== undefined && r.state !== 'pending') bad(`${at}.from`, 'only a pending reading belongs to the conversation it was heard in')
  })
  return errors
}

export function validateDeletedExpect(expect, conv, turn, where = '$.expect.deleted') {
  const errors = []
  if (!isObject(expect) || !Object.keys(expect).length) return [`${where}: an object with at least one of ${DELETED_KEYS.join(', ')}`]
  for (const [key, v] of Object.entries(expect)) { if (!DELETED_KEYS.includes(key)) errors.push(`${where}.${key}: unknown key`); else if (v !== true) errors.push(`${where}.${key}: true`) }
  if (turn.action !== 'delete') errors.push(`${where}: only on an action: delete turn`)
  const seeded = conv.seededWrites ?? {}, pages = seeded.pages ?? [], readings = seeded.readings ?? []
  const needs = (key, ok, why) => { if (expect[key] === true && !ok) errors.push(`${where}.${key}: ${why}`) }
  needs('pendingReadingsWithdrawn', readings.some(r => r.state === 'pending' && r.from === 'conversation'), 'needs a seeded pending reading with from: conversation')
  needs('conversationMemoryGone', pages.some(p => p.scope === 'conversation' && p.pointer !== true), 'needs a seeded page with scope: conversation')
  needs('otherMemoryKept', pages.some(p => p.scope !== 'conversation' && p.pointer !== true), 'needs a seeded page of another scope')
  needs('pointerMarked', pages.some(p => p.pointer === true), 'needs a seeded pointer page')
  return errors
}

const REVISION = 's1'
const page = (p, scope, ref) => ({ id: p.id, title: p.title, ...(ref ? { ref } : { body: p.body }), revision: REVISION, time: { slice: 'past' }, provenance: { kind: 'utterance', by: 'user' }, status: 'unknown', scope })
const scopeOf = (name, clientThreadId) => (name === 'conversation' ? `dm:${clientThreadId}` : name === 'other' ? `dm:${OTHER_ROOM}` : 'personal')

/** Write the conversation's seeds into the check's own wiki-writes store (never the person's). `firstMessageRef`: chat-message:<id> of the conversation's first message. */
export function seedWrites(writes, seeded, { clientThreadId, firstMessageRef = null }) {
  const out = { pages: [], readings: [] }
  for (const p of seeded?.pages ?? []) {
    if (p.pointer === true && !firstMessageRef) throw new Error('a pointer page needs the first message of the conversation')
    writes.apply({ kind: 'page', page: page(p, scopeOf(p.scope, clientThreadId), p.pointer === true ? firstMessageRef : null) }); out.pages.push(p.id)
  }
  for (const r of seeded?.readings ?? []) {
    writes.apply({ kind: 'reading', pageId: r.page, sourceRevision: REVISION, reading: { status: 'done', state: r.state, basis: null, ...(r.state === 'pending' ? { spokenAt: '2026-11-20T09:00:00Z' } : { confirmedAt: '2026-11-20T09:00:00Z' }) },
      ...(r.state === 'pending' ? { from: r.from === 'other' ? OTHER_ROOM : clientThreadId } : {}) }); out.readings.push(r.page)
  }
  return out
}

/** What the writes store holds, as plain facts (no text). */
export function writesFacts(writes, { clientThreadId, seeded }) {
  const data = writes.read(), mine = `dm:${clientThreadId}`
  const ids = new Set(data.pages.map(p => p.id))
  const pending = data.readings.filter(e => e.reading.state === 'pending')
  return {
    pages: Object.fromEntries(data.pages.map(p => [p.id, { scope: p.scope ?? null, hasBody: typeof p.body === 'string', sourceDeleted: p.sourceDeleted === true }])),
    readings: data.readings.map(e => ({ page: e.pageId, state: e.reading.state, from: e.from ?? null })),
    pendingFromConversation: pending.filter(e => e.from === clientThreadId).length, pendingFromOther: pending.filter(e => e.from === OTHER_ROOM).length,
    conversationPages: data.pages.filter(p => p.scope === mine).map(p => p.id), seededKnown: (seeded?.pages ?? []).filter(p => ids.has(p.id)).map(p => p.id),
  }
}

/** The checks, from one record: { route, before, after, store, resume } (see the check's deleteTurn). Booleans with the facts they were read from. */
export function checkDeleted(expect, record) {
  const out = [], put = (check, ok, detail) => out.push({ check: `deleted.${check}`, ok: ok === true, detail })
  const d = record?.deletion
  if (!d) { for (const key of Object.keys(expect)) put(key, false, { error: 'no deletion record' }); return out }
  const seeded = d.seeded ?? { pages: [], readings: [] }
  if (expect.routeAccepted) put('routeAccepted', d.route?.status === 200 && d.route?.body?.accepted === true, { status: d.route?.status ?? null, accepted: d.route?.body?.accepted ?? null })
  if (expect.storeRowsGone) {
    const s = d.store ?? {}, h = d.route?.body?.history ?? {}
    put('storeRowsGone', s.conversation === false && s.messages === 0 && s.listed === false && s.localIds === 0 && h.deleted === true && Number.isSafeInteger(h.rows) && h.rows >= (d.before?.messages ?? Infinity) && (d.before?.messages ?? 0) > 0,
      { conversationStored: s.conversation ?? null, messages: s.messages ?? null, listed: s.listed ?? null, localIds: s.localIds ?? null, historyDeleted: h.deleted ?? null, historyRows: h.rows ?? null, messagesBefore: d.before?.messages ?? null })
  }
  if (expect.engineGone) {
    const eh = d.route?.body?.engineHistory ?? []
    put('engineGone', d.resume?.failed === true && eh.length > 0 && eh.every(h => h.state === 'deleted'), { resumeFailed: d.resume?.failed ?? null, resumeError: d.resume?.error ?? null, engineHistory: eh.map(h => ({ state: h.state, reason: h.reason ?? null })) })
  }
  const before = d.writesBefore, after = d.writesAfter
  if (expect.pendingReadingsWithdrawn) put('pendingReadingsWithdrawn', !!before && !!after && before.pendingFromConversation > 0 && after.pendingFromConversation === 0 && d.route?.body?.modules?.pending_readings === before.pendingFromConversation,
    { before: before?.pendingFromConversation ?? null, after: after?.pendingFromConversation ?? null, moduleCount: d.route?.body?.modules?.pending_readings ?? null })
  if (expect.conversationMemoryGone) put('conversationMemoryGone', !!before && !!after && before.conversationPages.length > 0 && after.conversationPages.length === 0 && !after.readings.some(r => before.conversationPages.includes(r.page)),
    { before: before?.conversationPages.length ?? null, after: after?.conversationPages.length ?? null })
  if (expect.otherMemoryKept) {
    const keep = seeded.pages.filter(p => p.scope !== 'conversation' && p.pointer !== true).map(p => p.id)
    const keptReadings = (seeded.readings ?? []).filter(r => !(r.state === 'pending' && r.from === 'conversation') && keep.includes(r.page))
    const missing = keep.filter(id => !after?.pages?.[id]); const lostReadings = keptReadings.filter(r => !after?.readings?.some(x => x.page === r.page && x.state === r.state && (r.from === 'other' ? x.from === OTHER_ROOM : true)))
    put('otherMemoryKept', !!after && keep.length > 0 && missing.length === 0 && lostReadings.length === 0 && after.pendingFromOther === (before?.pendingFromOther ?? -1), { kept: keep.length - missing.length, missing, lostReadings: lostReadings.length, pendingFromOther: after?.pendingFromOther ?? null })
  }
  if (expect.pointerMarked) {
    const ptr = seeded.pages.filter(p => p.pointer === true).map(p => p.id)
    put('pointerMarked', !!after && ptr.length > 0 && ptr.every(id => after.pages[id] && after.pages[id].hasBody === false && after.pages[id].sourceDeleted === true), { pointers: ptr.map(id => ({ kept: Boolean(after?.pages?.[id]), sourceDeleted: after?.pages?.[id]?.sourceDeleted ?? null })) })
  }
  return out
}
