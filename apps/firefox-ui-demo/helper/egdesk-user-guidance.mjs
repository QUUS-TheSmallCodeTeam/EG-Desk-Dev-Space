import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { standingLine } from './egdesk-nunchi.mjs'

// L7 u1 (U17): the person's USER GUIDANCE RECORD, up to the conversation ('위': all conversations of this person; the Agent's own guidance, 'below', is out of scope).
//
// What the record holds, and nothing more: a candidate guidance from a reaction the decision model read (egdesk-nunchi.mjs), as CLOSED words (guidance, value, kind, strength), its source
// as a REFERENCE (the chat message ref and conversation, never the person's words) with the time, and its status history. A candidate is never applied by itself: the person (or the host on the
// person's explicit action) applies it; an applied guidance is told to the engine in every conversation, and can be reverted at any time (the record keeps it as reverted, so what was in effect
// when is still known). Nothing leaves this file and nothing here calls a model.
//   status: candidate -> applied | dismissed;  applied -> reverted;  reverted -> applied;  dismissed -> candidate
// Proposal (not built): when to apply by itself. See reports/l7-u1.md §4.
export const GUIDANCE_FILE = 'egdesk-user-guidance.json'
export const GUIDANCE_LIMITS = Object.freeze({ entries: 100, sources: 5, history: 20 })
export const GUIDANCE_KINDS = Object.freeze(['language', 'length', 'format', 'repeated_question', 'scope'])
export const GUIDANCE_STATUSES = Object.freeze(['candidate', 'applied', 'reverted', 'dismissed'])
const NEXT = Object.freeze({ candidate: ['applied', 'dismissed'], applied: ['reverted'], reverted: ['applied'], dismissed: ['candidate'] })
const VALUES = Object.freeze({ language: ['korean', 'english', 'japanese', 'chinese'], length: ['less', 'more'], scope: ['less', 'more'], format: [null], repeated_question: [null] })
const sha = text => createHash('sha256').update(text).digest('hex')
const iso = ms => new Date(ms).toISOString()
const isId = id => typeof id === 'string' && /^ug-[0-9a-f]{12}$/.test(id)

const clean = entry => ({ id: entry.id, guidance: entry.guidance, value: entry.value ?? null, kind: entry.kind, strength: entry.strength, status: entry.status, seen: entry.seen,
  sources: entry.sources.map(s => ({ ref: s.ref, thread: s.thread, at: s.at })), createdAt: entry.createdAt, history: entry.history.map(h => ({ status: h.status, at: h.at, by: h.by })) })

/** createUserGuidanceStore({ dataDir, now?, log? }) -> { propose, list, get, setStatus, appliedLines, size } (file: <dataDir>/egdesk-user-guidance.json, 0600, atomic writes) */
export function createUserGuidanceStore({ dataDir, now = Date.now, log = () => {} } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('a data directory is required')
  const file = path.join(dataDir, GUIDANCE_FILE)
  let entries = null
  const load = () => {
    if (entries) return entries
    entries = []
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        if (raw?.version === 1 && Array.isArray(raw.entries)) entries = raw.entries.filter(e => isId(e?.id) && GUIDANCE_KINDS.includes(e.guidance) && GUIDANCE_STATUSES.includes(e.status) && Array.isArray(e.sources) && Array.isArray(e.history)).slice(-GUIDANCE_LIMITS.entries)
      }
    } catch { entries = []; log('user guidance store unreadable: starting empty') }
    return entries
  }
  const save = () => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 1), { mode: 0o600 })
    renameSync(tmp, file); chmodSync(file, 0o600)
  }
  return Object.freeze({
    /**
     * propose({ guidance, value, kind, strength, sourceRef, thread }) -> entry | null
     * A reaction the decision model read, stored as a candidate. The same guidance and value again adds its source (at most five) and counts it (seen); an applied or dismissed one stays so.
     * Anything outside the closed words is refused (null): the record never holds free text.
     */
    propose({ guidance, value = null, kind, strength, sourceRef, thread } = {}) {
      if (!GUIDANCE_KINDS.includes(guidance) || !VALUES[guidance].includes(value ?? null) || typeof kind !== 'string' || !['clear', 'strong'].includes(strength)) return null
      if (typeof sourceRef !== 'string' || !/^chat-message:[A-Za-z0-9._:-]{1,120}$/.test(sourceRef) || typeof thread !== 'string' || !thread || thread.length > 200) return null
      const list = load(), at = iso(now()), id = `ug-${sha(`${guidance}|${value ?? ''}`).slice(0, 12)}`
      const existing = list.find(e => e.id === id)
      if (existing) {
        if (existing.sources.some(s => s.ref === sourceRef)) return clean(existing)
        existing.seen += 1; existing.sources = [...existing.sources, { ref: sourceRef, thread, at }].slice(-GUIDANCE_LIMITS.sources)
        if (strength === 'strong') existing.strength = 'strong'
      } else {
        list.push({ id, guidance, value: value ?? null, kind, strength, status: 'candidate', seen: 1, sources: [{ ref: sourceRef, thread, at }], createdAt: at, history: [{ status: 'candidate', at, by: 'decision_model' }] })
        while (list.length > GUIDANCE_LIMITS.entries) list.shift()
      }
      try { save() } catch (error) { log(`user guidance not saved: ${error?.code ?? 'error'}`); return null }
      return clean(list.find(e => e.id === id))
    },
    list({ status = null } = {}) { return load().filter(e => !status || e.status === status).map(clean) },
    get(id) { const e = load().find(x => x.id === id); return e ? clean(e) : null },
    /** setStatus(id, status, by) -> { ok, entry? , reason? }: only the transitions above; `by` is 'user' for a person's action. */
    setStatus(id, status, by = 'user') {
      if (!isId(id) || !GUIDANCE_STATUSES.includes(status)) return { ok: false, reason: 'invalid' }
      const e = load().find(x => x.id === id)
      if (!e) return { ok: false, reason: 'not_found' }
      if (!NEXT[e.status].includes(status)) return { ok: false, reason: 'transition_refused' }
      e.status = status; e.history = [...e.history, { status, at: iso(now()), by: by === 'user' ? 'user' : 'host' }].slice(-GUIDANCE_LIMITS.history)
      try { save() } catch (error) { log(`user guidance not saved: ${error?.code ?? 'error'}`); return { ok: false, reason: 'not_saved' } }
      return { ok: true, entry: clean(e) }
    },
    /** appliedLines() -> the closed lines of the guidance the person applied (what every conversation tells the engine), one per kind of guidance. */
    // One line per kind of guidance: where the person applied two that disagree (shorter and fuller replies, two languages), the one applied last is the one in effect.
    appliedLines() {
      const latest = new Map()
      for (const e of load().filter(x => x.status === 'applied')) {
        const at = Date.parse([...e.history].reverse().find(h => h.status === 'applied')?.at ?? e.createdAt)
        const kept = latest.get(e.guidance)
        if (!kept || at >= kept.at) latest.set(e.guidance, { at, e })
      }
      return [...latest.values()].map(({ e }) => standingLine(e.guidance, e.value)).filter(Boolean)
    },
    size() { return load().length },
  })
}

/**
 * createUserGuidanceHttpHandler({ store, enabled, port, guard, readJson, send }) -> async (req, res, url) => boolean
 * GET  /v1/user-guidance                       the record (closed words, sources by reference, history)
 * POST /v1/user-guidance/<id>/<action>         action: apply | revert | dismiss | restore   (the person's explicit action)
 * Off (404) unless enabled(); loopback only (the bridge's guard); no body is read for the action.
 */
export const USER_GUIDANCE_PATH = '/v1/user-guidance'
const ACTIONS = Object.freeze({ apply: 'applied', revert: 'reverted', dismiss: 'dismissed', restore: 'candidate' })
export function createUserGuidanceHttpHandler({ store, enabled = () => false, port = 39218, guard, send } = {}) {
  if (!store) throw new TypeError('a user guidance store is required')
  return async (req, res, url) => {
    if (url.pathname !== USER_GUIDANCE_PATH && !url.pathname.startsWith(`${USER_GUIDANCE_PATH}/`)) return false
    const reply = (code, body) => { if (!res.destroyed && !res.writableEnded) send(res, code, body); return true }
    let on = false
    try { on = enabled() === true } catch { on = false }
    if (!on) return reply(404, { status: 'off' })
    if (!guard(req, port)) return reply(403, { status: 'refused', reason: 'loopback-required' })
    if (url.pathname === USER_GUIDANCE_PATH) {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return reply(405, { status: 'refused', reason: 'get-required' }) }
      return reply(200, { status: 'ok', entries: store.list() })
    }
    const [, , , id, action] = url.pathname.split('/')
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, { status: 'refused', reason: 'post-required' }) }
    if (!isId(id) || !Object.hasOwn(ACTIONS, action) || url.pathname.split('/').length !== 5) return reply(400, { status: 'invalid' })
    const done = store.setStatus(id, ACTIONS[action], 'user')
    return done.ok ? reply(200, { status: 'ok', entry: done.entry }) : reply(done.reason === 'not_found' ? 404 : 409, { status: 'refused', reason: done.reason })
  }
}
