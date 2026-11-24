// L7 c34: the memory WRITE path in the real-engine check, through the check's extension API (helper/egdesk-real-engine-extensions.mjs), in its own module.
//
// A conversation that seeds memory (memory.mode "on") and flags EGDESK_TURN_MEMORY_CONFIRM=on runs the product's whole write path on the real engine: the person states something
// in passing, the write judgment (after the answer) stores a PENDING reading on the stored record it is about (never a status), a later turn tells the answering model what was noted,
// and the person's next message confirms or refuses it. A turn may carry
//   "expect": { "recording": { "page": "<seeded page id>", "reading": "none" | "pending" | "accepted" | "rejected" | "pending_or_none",
//                              "status": ["plan", "done", …]        the LATEST reading's status is one of these
//                              "basis":  ["self_reported_observation", …, null]   its source axis (the sentence label that was installed; null = none installed) is one of these
//                              "pageStatus": ["unknown", "plan", "done"]          the record's status now (a promoted reading changes it, a pending one never does)
//                              "confirmed": true | false             the latest reading carries the person's confirmation (confirmedAt)
//                              "readings": n                         readings on that record in all (pending, accepted, rejected)
//                              "newPages": n }                       utterance pages the write path stored in this conversation's scope
// The confirmation step reads the previous reply, which is a past utterance of the DM: the product allows that only for an Agent DM whose person opted in to reuse of the DM's utterances
// (MemoryEvidenceStore.enableSpeech, the opt-in the memory settings offer). A conversation says so with "speechConsent": true (it also needs "agentProfile", so --persisted-with-cleanup):
// after the FIRST turn (the DM then exists) the hook composes a memory-evidence store for this conversation's own temporary folder and makes that opt-in through the product's API, the
// person's setting for this synthetic person; nothing is shared, the folder is removed with the conversation. Without it the confirmation cannot run ("no_previous_answer") and a script
// that expects "accepted" fails by code.
// Checked by code on the product's own view of the write store (the wiki snapshot: the stored readings laid over the seeded records, and the written pages), after the turn's
// answer was posted and the background write judgment settled. Nothing here asks a model whether the recording was right.
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'
export const RECORDING_READING = Object.freeze(['none', 'pending', 'accepted', 'rejected', 'pending_or_none'])
const STATUSES = Object.freeze(['plan', 'done', 'superseded']), PAGE_STATUSES = Object.freeze(['unknown', 'plan', 'done'])
const BASES = Object.freeze(['self_reported_observation', 'attributed_report', 'inference', 'record_based', 'unspecified', null])
export const RECORDING_KEYS = Object.freeze(['page', 'reading', 'status', 'basis', 'pageStatus', 'confirmed', 'readings', 'newPages'])
const listOf = items => ({ type: 'array', minItems: 1, maxItems: 8, items })
export const RECORDING_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['page'], properties: {
  page: { type: 'string' }, reading: { enum: [...RECORDING_READING] }, status: listOf({ enum: [...STATUSES] }), basis: listOf({ enum: [...BASES] }), pageStatus: listOf({ enum: [...PAGE_STATUSES] }),
  confirmed: { type: 'boolean' }, readings: { type: 'integer', minimum: 0, maximum: 20 }, newPages: { type: 'integer', minimum: 0, maximum: 20 } } })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** validateRecordingExpect(expect, conversation, where) → ['<where>.<key>: <reason>'] */
export function validateRecordingExpect(expect, conv, where = '$.expect.recording') {
  const errors = [], bad = (at, why) => { if (errors.length < 20) errors.push(`${at}: ${why}`) }
  if (!isObject(expect)) return [`${where}: an object`]
  for (const k of Object.keys(expect)) if (!RECORDING_KEYS.includes(k)) bad(`${where}.${k}`, 'unknown key')
  const pages = new Set((conv?.memory?.pages ?? []).map(p => p?.id))
  if (typeof expect.page !== 'string' || !pages.has(expect.page)) bad(`${where}.page`, 'a page of this conversation\'s memory')
  if (conv?.memory?.mode !== 'on') bad(where, 'needs memory.mode "on" (the write path only runs when turn memory is on)')
  if (expect.reading !== undefined && !RECORDING_READING.includes(expect.reading)) bad(`${where}.reading`, `one of ${RECORDING_READING.join(' / ')}`)
  const oneOf = (key, allowed) => { if (expect[key] === undefined) return; if (!Array.isArray(expect[key]) || !expect[key].length || expect[key].some(v => !allowed.includes(v))) bad(`${where}.${key}`, `a list of ${allowed.map(String).join(' / ')}`) }
  oneOf('status', STATUSES); oneOf('basis', BASES); oneOf('pageStatus', PAGE_STATUSES)
  if (expect.confirmed !== undefined && typeof expect.confirmed !== 'boolean') bad(`${where}.confirmed`, 'true or false')
  for (const k of ['readings', 'newPages']) if (expect[k] !== undefined && !(Number.isSafeInteger(expect[k]) && expect[k] >= 0 && expect[k] <= 20)) bad(`${where}.${k}`, 'an integer 0-20')
  if (['status', 'basis', 'confirmed'].some(k => expect[k] !== undefined) && (expect.reading === 'none')) bad(where, 'status, basis and confirmed describe a reading, but reading is "none"')
  return errors
}

const READING_FIELDS = r => ({ state: r.state, status: r.status, basis: r.basis ?? null, spokenAt: r.spokenAt ?? null, confirmedAt: r.confirmedAt ?? null, rejectedAt: r.rejectedAt ?? null })
const idsOf = id => [id, `ontology:${id}`]

/** What the check recorded of the store for a conversation: the readings on the seeded pages and the pages written in scope. Pure over a wiki snapshot ({ pages: Map }). */
export function recordingFacts(wiki, { seededIds = [], clientThreadId = null } = {}) {
  const pages = wiki?.pages instanceof Map ? [...wiki.pages.values()] : []
  const seeded = {}
  for (const id of seededIds) {
    const page = idsOf(id).map(k => wiki.pages.get(k)).find(Boolean)
    if (page) seeded[id] = { status: page.status ?? 'unknown', readings: (page.statusReadings ?? []).map(READING_FIELDS) }
  }
  const scope = clientThreadId ? `dm:${clientThreadId}` : null
  const written = pages.filter(p => scope && p.scope === scope && !seededIds.some(id => idsOf(id).includes(p.id))).map(p => ({ id: p.id, time: p.time?.slice ?? null, status: p.status ?? 'unknown', provenance: p.provenance?.kind ?? null, basis: p.provenance?.basis ?? null }))
  return { seeded, written }
}

/** validateSpeechConsent(value, conv, where) → ['<where>: <reason>'] */
export function validateSpeechConsent(value, conv, where = '$.speechConsent') {
  if (typeof value !== 'boolean') return [`${where}: true or false`]
  const errors = []
  if (value && conv?.agentProfile === undefined) errors.push(`${where}: needs an agentProfile (the opt-in is for an Agent DM)`)
  if (value && conv?.memory?.mode !== 'on') errors.push(`${where}: needs memory.mode "on"`)
  return errors
}

/** checkRecording(expect, facts) → [{ check, ok, detail }] */
export function checkRecording(expect, facts) {
  const out = [], put = (check, ok, detail) => out.push({ check: `recording.${check}`, ok: ok === true, detail })
  const page = facts.seeded[expect.page], readings = page?.readings ?? [], latest = readings.at(-1) ?? null
  if (!page) { put('page', false, { page: expect.page, found: false }); return out }
  if (expect.reading !== undefined) {
    const state = latest?.state ?? 'none', ok = expect.reading === 'pending_or_none' ? state === 'pending' || state === 'none' : state === expect.reading
    put('reading', ok, { wanted: expect.reading, state, readings: readings.map(r => r.state) })
  }
  if (expect.status !== undefined) put('status', latest !== null && expect.status.includes(latest.status), { wanted: expect.status, status: latest?.status ?? null })
  if (expect.basis !== undefined) put('basis', latest === null ? expect.reading === 'pending_or_none' : expect.basis.includes(latest.basis), { wanted: expect.basis, basis: latest?.basis ?? null, reading: latest !== null })
  if (expect.pageStatus !== undefined) put('pageStatus', expect.pageStatus.includes(page.status), { wanted: expect.pageStatus, status: page.status })
  if (expect.confirmed !== undefined) put('confirmed', (latest?.confirmedAt != null) === expect.confirmed, { wanted: expect.confirmed, confirmedAt: latest?.confirmedAt ?? null })
  if (expect.readings !== undefined) put('readings', readings.length === expect.readings, { wanted: expect.readings, readings: readings.length })
  if (expect.newPages !== undefined) put('newPages', facts.written.length === expect.newPages, { wanted: expect.newPages, written: facts.written })
  return out
}

/** The registered turn hook: waits for the turn's background write judgment, then records and checks the store. Active only for a conversation whose script asks for it. */
export function createRecordingHook(conversation) {
  const active = conversation?.memory?.mode === 'on' && (conversation.turns ?? []).some(t => t?.expect?.recording !== undefined)
  const seededIds = (conversation?.memory?.pages ?? []).map(p => p.id)
  const consent = active && conversation.speechConsent === true
  let chat = null, evidence = null, dir = null, granted = null, consentError = null
  return {
    attach(deps) {
      chat = deps.chat
      if (!consent) return
      // the memory-evidence store this synthetic person's opt-in lives in: a private temporary folder, removed in dispose()
      dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-check-recording-')); chmodSync(dir, 0o700)
      const captures = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [dir], now: () => Date.now() })
      evidence = new MemoryEvidenceStore({ dataDir: path.join(dir, 'state'), captures, now: () => Date.now() })
      chat.decisionContext.memoryEvidence = evidence
    },
    dispose() { try { evidence?.close() } catch { /* released */ } try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch { /* temporary */ } },
    async afterTurn(ctx) {
      if (!active || !chat) return null
      if (consent && evidence && granted === null) {
        // after the first turn: the DM exists now; the person opts in, through the product's own authority for this Agent DM
        try {
          const { clientThreadId, conversationId } = ctx.state(), profileId = chat.store.getConversation(clientThreadId)?.agent?.profileId
          granted = Boolean(evidence.enableSpeech(chat.memoryDmAuthority({ clientThreadId, conversationId, expectedProfileId: profileId }).scope))
        } catch (e) { granted = false; consentError = String(e?.message ?? e).slice(0, 100) }
      }
      try { await chat.turnMemoryIdle() } catch { /* the facts below say what was stored */ }
      let facts, error = null
      try {
        const clientThreadId = ctx.state().clientThreadId
        const wiki = await chat.decisionContext.turnMemory.wiki({ body: {}, context: { clientThreadId }, sources: null })
        facts = recordingFacts(wiki, { seededIds, clientThreadId })
      } catch (e) { error = String(e?.message ?? e).slice(0, 120); facts = { seeded: {}, written: [] } }
      const expectations = ctx.expect?.recording !== undefined ? (error ? [{ check: 'recording.read', ok: false, detail: { error } }] : checkRecording(ctx.expect.recording, facts)) : []
      return { record: { ...facts, ...(consent ? { speechConsent: { granted, ...(consentError ? { error: consentError } : {}) } } : {}), ...(error ? { error } : {}) }, expectations }
    },
  }
}
