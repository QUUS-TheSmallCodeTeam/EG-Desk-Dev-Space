// L7 c26: memory seeding for lane L5's real-engine check (helper/egdesk-real-engine-check.mjs), in its own module. L5 owns the check; the check
// calls this module at five registration points (marked "memory hook" there) and nothing else of it changes.
//
// A conversation script may carry
//   "memory": { "mode": "on", "pages": [ { "id": "backup/retention", "title": "…", "body": "…", "time": "past", "status": "done",
//                                           "links": [ { "to": "<another page id>", "type": "follows_from" } ] } ] }
// The pages become the ontology graph the isolated run reads (the same graph both the turn-memory wiki and the context selection are built from:
// readGraph of the check's ontologyStore), BEFORE the conversation starts; they exist nowhere else (the data folder is the check's own). "mode"
// is the turn-memory setting for the conversation: "on" attaches what the loop picks (needs --decisions: the Decision model reads the pages);
// "advisory" (the check's default) only records.
// A turn may carry "expect": { "memory": { "attached": [ids], "notAttached": [ids], "noResends": true } }, checked by code on what the check saw
// the product send to the engine (the turn/start additionalContext of that scripted turn, approvals included):
//   attached     every id has its BODY in this turn's context (the selection's [item id=…] or the memory packet's [page id=…] block);
//   notAttached  no id has a body in this turn's context;
//   noResends    no page that had its body in an EARLIER turn of this conversation has its body again (a reference line, "already delivered
//                earlier in this thread, unchanged; content not re-sent", is not a body). The seeded pages never change, so a second body is a re-send.
// Answers are checked with the check's existing answerIncludes / answerExcludes. Nothing here asks a model whether a turn went well.
export const MEMORY_MODES = Object.freeze(['on', 'advisory'])
export const MEMORY_TIMES = Object.freeze(['past', 'present', 'planned', 'hypothetical'])
export const MEMORY_STATUSES = Object.freeze(['done', 'plan'])
export const MEMORY_LINK_TYPES = Object.freeze(['follows_from', 'refers_to', 'same_task'])
export const MEMORY_LIMITS = Object.freeze({ pages: 12, idChars: 60, titleChars: 120, bodyBytes: 4000, links: 4, ids: 12 })
export const MEMORY_EXPECT_KEYS = Object.freeze(['attached', 'notAttached', 'noResends'])
const PAGE_ID = /^[a-z0-9][a-z0-9/_-]{0,59}$/
// The JSON-schema form of the two fields (helper/egdesk-real-engine-script.mjs embeds these in the committed schema; validateMemory adds the
// uniqueness and reference rules a schema cannot say).
export const MEMORY_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['pages'], properties: {
  mode: { enum: [...MEMORY_MODES] },
  pages: { type: 'array', minItems: 1, maxItems: MEMORY_LIMITS.pages, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'body'], properties: {
    id: { type: 'string', pattern: PAGE_ID.source }, title: { type: 'string', minLength: 1, maxLength: MEMORY_LIMITS.titleChars }, body: { type: 'string', minLength: 1, maxLength: MEMORY_LIMITS.bodyBytes },
    time: { enum: [...MEMORY_TIMES] }, status: { enum: [...MEMORY_STATUSES] },
    links: { type: 'array', maxItems: MEMORY_LIMITS.links, items: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { type: 'string' }, type: { enum: [...MEMORY_LINK_TYPES] } } } } } } } } })
const ids = { type: 'array', minItems: 1, maxItems: MEMORY_LIMITS.ids, items: { type: 'string' } }
export const MEMORY_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, properties: { attached: ids, notAttached: ids, noResends: { const: true } } })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const PREFIX = 'ontology:'
const BLOCK = /\[(page|item) id=([^\s\]]+)([^\]]*)\]/g

/** validateMemory(memory, where) → ['<where>: <reason>'] (empty when valid). */
export function validateMemory(memory, where = '$.memory') {
  const errors = [], bad = (at, why) => { if (errors.length < 30) errors.push(`${at}: ${why}`) }
  if (!isObject(memory)) return [`${where}: an object { mode?, pages }`]
  for (const k of Object.keys(memory)) if (!['mode', 'pages'].includes(k)) bad(`${where}.${k}`, 'unknown key')
  if (memory.mode !== undefined && !MEMORY_MODES.includes(memory.mode)) bad(`${where}.mode`, `one of ${MEMORY_MODES.join(' / ')}`)
  const pages = memory.pages
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MEMORY_LIMITS.pages) { bad(`${where}.pages`, `1-${MEMORY_LIMITS.pages} pages`); return errors }
  const ids = new Set()
  pages.forEach((p, i) => {
    const at = `${where}.pages[${i}]`
    if (!isObject(p)) return bad(at, 'an object')
    for (const k of Object.keys(p)) if (!['id', 'title', 'body', 'time', 'status', 'links'].includes(k)) bad(`${at}.${k}`, 'unknown key')
    if (typeof p.id !== 'string' || !PAGE_ID.test(p.id)) bad(`${at}.id`, `matches ${PAGE_ID.source}`)
    else if (ids.has(p.id)) bad(`${at}.id`, 'unique'); else ids.add(p.id)
    if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > MEMORY_LIMITS.titleChars) bad(`${at}.title`, `1-${MEMORY_LIMITS.titleChars} characters`)
    if (typeof p.body !== 'string' || !p.body.trim() || Buffer.byteLength(p.body, 'utf8') > MEMORY_LIMITS.bodyBytes) bad(`${at}.body`, `1-${MEMORY_LIMITS.bodyBytes} bytes`)
    if (p.time !== undefined && !MEMORY_TIMES.includes(p.time)) bad(`${at}.time`, `one of ${MEMORY_TIMES.join(' / ')}`)
    if (p.status !== undefined && !MEMORY_STATUSES.includes(p.status)) bad(`${at}.status`, `one of ${MEMORY_STATUSES.join(' / ')}`)
    if (p.links !== undefined) {
      if (!Array.isArray(p.links) || p.links.length > MEMORY_LIMITS.links) bad(`${at}.links`, `at most ${MEMORY_LIMITS.links}`)
      else p.links.forEach((l, j) => { if (!isObject(l) || typeof l.to !== 'string' || (l.type !== undefined && !MEMORY_LINK_TYPES.includes(l.type)) || Object.keys(l).some(k => !['to', 'type'].includes(k))) bad(`${at}.links[${j}]`, '{ to, type? }') })
    }
  })
  pages.forEach((p, i) => { for (const [j, l] of (Array.isArray(p?.links) ? p.links : []).entries()) if (typeof l?.to === 'string' && !ids.has(l.to)) bad(`${where}.pages[${i}].links[${j}].to`, 'a page of this memory') })
  return errors
}

/** validateMemoryExpect(expect, memory, where) → reasons. */
export function validateMemoryExpect(expect, memory, where = '$.expect.memory') {
  const errors = [], bad = (at, why) => { if (errors.length < 30) errors.push(`${at}: ${why}`) }
  if (!isObject(expect)) return [`${where}: an object`]
  if (!isObject(memory) || !Array.isArray(memory.pages)) bad(where, 'the conversation has no memory.pages to refer to')
  for (const k of Object.keys(expect)) if (!MEMORY_EXPECT_KEYS.includes(k)) bad(`${where}.${k}`, 'unknown key')
  const known = new Set((memory?.pages ?? []).map(p => p?.id))
  for (const k of ['attached', 'notAttached']) {
    if (expect[k] === undefined) continue
    if (!Array.isArray(expect[k]) || !expect[k].length || expect[k].length > MEMORY_LIMITS.ids || expect[k].some(id => typeof id !== 'string')) bad(`${where}.${k}`, `1-${MEMORY_LIMITS.ids} page ids`)
    else for (const id of expect[k]) if (!known.has(id)) bad(`${where}.${k}`, `${id} is not a page of this memory`)
  }
  if (expect.noResends !== undefined && expect.noResends !== true) bad(`${where}.noResends`, 'true')
  if (Array.isArray(expect.attached) && Array.isArray(expect.notAttached) && expect.attached.some(id => expect.notAttached.includes(id))) bad(where, 'attached and notAttached contradict')
  return errors
}

/** The ontology graph of the seeded pages (what ontologyStore.readGraph returns): nodes with body, time slice and status; typed edges. */
export function memoryGraph(memory) {
  const pages = Array.isArray(memory?.pages) ? memory.pages : []
  return { snapshots: [], nodes: pages.map(p => ({ id: p.id, label: p.title, body: p.body, timeSlice: p.time ?? 'present', ...(p.status ? { status: p.status } : {}) })),
    edges: pages.flatMap(p => (p.links ?? []).map(l => ({ source: p.id, target: l.to, relation: l.type ?? 'refers_to' }))) }
}

/** Pages in a turn/start additionalContext: { bodies: [short ids], refs: [short ids], keys: [names], copies: { id: number of bodies } }. A reference line is no body. */
export function pagesIn(additionalContext) {
  const bodies = new Set(), refs = new Set(), keys = []
  if (!isObject(additionalContext)) return { bodies: [], refs: [], keys, copies: {} }
  const copies = {}
  for (const [key, entry] of Object.entries(additionalContext)) {
    keys.push(key)
    const text = typeof entry === 'string' ? entry : typeof entry?.value === 'string' ? entry.value : ''
    for (const m of text.matchAll(BLOCK)) {
      const id = m[2].startsWith(PREFIX) ? m[2].slice(PREFIX.length) : m[2]
      if (m[1] === 'page' && /already delivered earlier in this thread/.test(m[3])) refs.add(id); else { bodies.add(id); copies[id] = (copies[id] ?? 0) + 1 }
    }
  }
  return { bodies: [...bodies].sort(), refs: [...refs].filter(id => !bodies.has(id)).sort(), keys, copies }
}

/** Scripts whose memory only works through the Decision model (the pages are picked and judged by it). */
export const memoryNeedsDecisions = conversation => Boolean(conversation?.memory?.pages?.length)

/**
 * createMemoryHook(memory) → the object the check calls. All of it is inert when the conversation has no memory.
 *   graph()                 the ontology graph for readGraph
 *   mode                    the turn-memory setting ('on' | 'advisory' | null when there is no memory)
 *   observe(method, params) every engine request the runtime makes (only turn/start matters)
 *   beginTurn()             a scripted turn starts: forget what the previous one saw
 *   finishTurn(expectMemory) → { record, expectations } and remembers this turn's bodies as delivered
 */
export function createMemoryHook(memory) {
  const enabled = isObject(memory) && Array.isArray(memory.pages)
  const delivered = new Set()
  let current = { bodies: new Set(), refs: new Set(), keys: new Set(), starts: 0, duplicatesInTurn: 0 }
  const fresh = () => ({ bodies: new Set(), refs: new Set(), keys: new Set(), starts: 0, duplicatesInTurn: 0 })
  return {
    enabled,
    mode: enabled ? (memory.mode ?? 'advisory') : null,
    graph: () => (enabled ? memoryGraph(memory) : { snapshots: [], nodes: [], edges: [] }),
    // The product runs turn memory only for a direct DM that is not a one-time (stateless) conversation; every conversation of the check is a one-time
    // thread (ephemeral threads only) and has no Agent profile, so by default turn memory would never run in it. A script that seeds memory with mode
    // "on" opts in: turn memory runs on every turn of that conversation (not on a Board turn). The Decision context selection needs no such opt-in.
    eligible: ({ context } = {}) => enabled && memory.mode === 'on' && context?.engine?.id === 'codex' && !context?.board,
    observe(method, params) {
      if (!enabled || method !== 'turn/start') return
      const seen = pagesIn(params?.additionalContext)
      current.starts++
      for (const id of seen.bodies) { if (current.bodies.has(id)) current.duplicatesInTurn++; current.duplicatesInTurn += (seen.copies[id] ?? 1) - 1; current.bodies.add(id) } // twice in one turn: the selection's item and the memory packet's page (information, not a re-send)
      for (const id of seen.refs) current.refs.add(id)
      for (const key of seen.keys) current.keys.add(key)
    },
    beginTurn() { current = fresh() },
    finishTurn(expectMemory) {
      if (!enabled) return { record: null, expectations: [] }
      const bodies = [...current.bodies].sort(), refs = [...current.refs].sort()
      const resent = bodies.filter(id => delivered.has(id))
      const record = { starts: current.starts, keys: [...current.keys].sort(), attached: bodies, referenced: refs, resent, duplicatesInTurn: current.duplicatesInTurn, deliveredBefore: [...delivered].sort() }
      const expectations = [], put = (check, ok, detail) => expectations.push({ check, ok: ok === true, detail })
      if (expectMemory?.attached) { const missing = expectMemory.attached.filter(id => !current.bodies.has(id)); put('memory.attached', missing.length === 0, { missing, attached: bodies }) }
      if (expectMemory?.notAttached) { const found = expectMemory.notAttached.filter(id => current.bodies.has(id)); put('memory.notAttached', found.length === 0, { found, attached: bodies }) }
      if (expectMemory?.noResends) put('memory.noResends', resent.length === 0, { resent, referenced: refs })
      for (const id of current.bodies) delivered.add(id)
      return { record, expectations }
    },
  }
}
