// L3 c27: the heartbeat's own messages in the real-engine check (extension API: helper/egdesk-real-engine-extensions.mjs; registered in the "slot L3" of
// helper/egdesk-real-engine-registrations.mjs). A turn may carry
//
//   "expect": { "flow": { "notes": { "equals": 1 }, "firstNoteMs": { "min": 10000, "max": 40000 }, "statedSecondsTrue": true, "noResult": ["done-42"] } }
//
// checked by code on the messages the chat store holds for the turn's window (the system's own messages: ids "egdesk-flow:…"), nothing asks a model:
//   notes              how many of the system's own messages were posted in the window ({ equals?, min?, max? }); { equals: 1 } is "one note, not repeated"
//   firstNoteMs        { min?, max? } the first of them was posted this long after the person's message opened the window (the store's own timestamps)
//   statedSecondsTrue  every number of seconds a note states ("약 30초", "about 30 seconds") is what the clock says: not later than the post, and not older than the
//                      writer's own deadline allows (the note is composed from the facts of its beat; the writer takes up to FLOW_WRITER_SLACK_MS to answer)
//   noResult           strings that exist only in the finished work (an output marker the command's line does not spell out): a note posted while the work runs may not
//                      contain them (a note cannot know a result the work has not produced)
// The record (under hooks.flow in the turn record): the notes of the window, each { atMs, text (<= 300 chars) }.
export const FLOW_PREFIX = 'egdesk-flow:'
export const FLOW_WRITER_SLACK_MS = 20_000
const bounds = max => ({ type: 'object', additionalProperties: false, minProperties: 1, properties: { equals: { type: 'integer', minimum: 0, maximum: max }, min: { type: 'integer', minimum: 0, maximum: max }, max: { type: 'integer', minimum: 0, maximum: max } } })
export const FLOW_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  notes: bounds(5), firstNoteMs: bounds(600_000), statedSecondsTrue: { const: true },
  noResult: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 3, maxLength: 80 } } } })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** validateFlowExpect(expect, { conv, turn }, where) → ['<where>: <reason>'] (empty when valid). */
export function validateFlowExpect(expect, { conv = {}, turn = {} } = {}, where = '$.expect.flow') {
  const errors = [], bad = (at, why) => { if (errors.length < 20) errors.push(`${at}: ${why}`) }
  if (!isObject(expect)) return [`${where}: an object`]
  if (!Object.keys(expect).length) bad(where, 'at least one key')
  for (const k of Object.keys(expect)) if (!['notes', 'firstNoteMs', 'statedSecondsTrue', 'noResult'].includes(k)) bad(`${where}.${k}`, 'unknown key')
  for (const name of ['notes', 'firstNoteMs']) {
    const b = expect[name]
    if (b === undefined) continue
    if (!isObject(b) || !Object.keys(b).length) { bad(`${where}.${name}`, '{ equals?, min?, max? } with at least one'); continue }
    const limit = name === 'notes' ? 5 : 600_000
    for (const [k, v] of Object.entries(b)) { if (!['equals', 'min', 'max'].includes(k)) bad(`${where}.${name}.${k}`, 'unknown key'); else if (!(Number.isInteger(v) && v >= 0 && v <= limit)) bad(`${where}.${name}.${k}`, `an integer 0-${limit}`) }
    if (b.equals !== undefined && (b.min !== undefined || b.max !== undefined)) bad(`${where}.${name}`, 'equals excludes min and max')
    if (b.min !== undefined && b.max !== undefined && b.min > b.max) bad(`${where}.${name}`, 'min above max')
  }
  if (expect.statedSecondsTrue !== undefined && expect.statedSecondsTrue !== true) bad(`${where}.statedSecondsTrue`, 'true')
  if (expect.noResult !== undefined && !(Array.isArray(expect.noResult) && expect.noResult.length >= 1 && expect.noResult.length <= 4 && expect.noResult.every(s => typeof s === 'string' && s.length >= 3 && s.length <= 80))) bad(`${where}.noResult`, '1-4 strings of 3-80 characters')
  if (expect.firstNoteMs !== undefined && expect.notes?.equals === 0) bad(where, 'firstNoteMs and notes.equals 0 contradict')
  if (conv.flags?.EGDESK_CONVERSATION_FLOW !== 'on') bad(where, 'needs flags.EGDESK_CONVERSATION_FLOW = "on" in this conversation (the heartbeat writes the notes)')
  if (turn.whileRunning !== undefined) bad(where, 'not on a whileRunning turn (the window is the scripted turn)')
  return errors
}

/** The numbers of seconds a note states, as integers ("약 30초", "about 30 seconds", "30s"). Minutes are not read. */
export function statedSeconds(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(/(\d{1,5})\s*(?:초|seconds?\b|secs?\b|s\b)/gi)) out.push(Number(m[1]))
  return out
}

/** judgeFlow(expect, notes) → [{ check, ok, detail }] for notes [{ atMs, text }] (the window's own messages, oldest first). */
export function judgeFlow(expect, notes) {
  const out = [], put = (check, ok, detail) => out.push({ check, ok: ok === true, detail })
  const within = (b, n) => (b.equals === undefined || n === b.equals) && (b.max === undefined || n <= b.max) && (b.min === undefined || n >= b.min)
  if (expect.notes) put('flow.notes', within(expect.notes, notes.length), { wanted: expect.notes, seen: notes.length })
  if (expect.firstNoteMs) put('flow.firstNoteMs', notes.length > 0 && within(expect.firstNoteMs, notes[0].atMs), { wanted: expect.firstNoteMs, atMs: notes[0]?.atMs ?? null })
  if (expect.statedSecondsTrue) {
    const wrong = []
    for (const note of notes) for (const n of statedSeconds(note.text)) {
      const at = note.atMs / 1000
      if (n > at + 1 || n < at - FLOW_WRITER_SLACK_MS / 1000) wrong.push({ stated: n, postedAtSeconds: Math.round(at * 10) / 10 })
    }
    put('flow.statedSecondsTrue', notes.length > 0 && wrong.length === 0, { notes: notes.length, wrong })
  }
  if (expect.noResult) put('flow.noResult', notes.every(note => expect.noResult.every(s => !note.text.includes(s))), { found: expect.noResult.filter(s => notes.some(note => note.text.includes(s))) })
  return out
}

/** The turn hook: remembers what the store held at the start, and reads the window's own messages at the end. */
// The window opens when the turn begins (the check's own clock, the one the chat store stamps its messages with); the person's message may carry its own timestamp (then that one).
export function createFlowHook({ now = () => Date.now() } = {}) {
  let before = null, began = null
  const messages = state => { try { return state.store.listMessages(state.clientThreadId, { limit: 500 }).messages } catch { return [] } }
  return {
    beginTurn(ctx) { began = now(); before = new Set(messages(ctx.state()).map(m => m.localMessageId ?? m.messageId ?? m.id)) },
    finishTurn(ctx) {
      const all = messages(ctx.state()), key = m => m.localMessageId ?? m.messageId ?? m.id
      const fresh = all.filter(m => !(before ?? new Set()).has(key(m)))
      const opener = fresh.find(m => m.role === 'user'), start = Number.isFinite(opener?.createdAt) ? opener.createdAt : (opener ? began : null)
      before = null; began = null
      const notes = fresh.filter(m => m.role === 'assistant' && typeof m.messageId === 'string' && m.messageId.startsWith(FLOW_PREFIX) && Number.isFinite(m.createdAt) && start !== null)
        .sort((a, b) => a.createdAt - b.createdAt).map(m => ({ atMs: m.createdAt - start, text: String(m.text ?? '') }))
      const expectations = ctx.expect?.flow ? judgeFlow(ctx.expect.flow, notes) : []
      return { record: notes.length ? { notes: notes.map(n => ({ atMs: n.atMs, text: n.text.slice(0, 300) })) } : null, expectations }
    },
  }
}
