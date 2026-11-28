import { randomBytes } from 'node:crypto'
import { draftFromJournal, normalizeProcedure, procedureSummary } from './egdesk-browser-procedure.mjs'

// Round g (L59): saved Browser procedures. Records of kind 'browser_procedure' in the workflow store, key = id.
export const PROCEDURE_KIND = 'browser_procedure'
export const MAX_PROCEDURES = 200

/**
 * createProcedureService({ store, journal, now })
 *   list() -> [summary] newest first      get(id) -> procedure | null
 *   save(raw) -> { ok, procedure } | { ok: false, errors }          a new id; createdAt = updatedAt = now
 *   update(id, raw) -> { ok, procedure } | { ok: false, errors } | { ok: false, notFound: true }   keeps id and createdAt
 *   remove(id) -> boolean
 *   captureDraft({ clientThreadId, cardId, name? }) -> draft | null (no act in the last run); not saved
 *   saveCaptured({ clientThreadId, cardId, name? }) -> save result, or { ok: false, empty: true }
 */
export function createProcedureService({ store, journal, now = Date.now, newId = () => `proc-${randomBytes(8).toString('hex')}` } = {}) {
  if (!store?.records) throw new TypeError('A workflow store is required')
  const read = row => { try { const p = JSON.parse(row.json); return p && typeof p === 'object' ? p : null } catch { return null } }
  const all = () => store.records.list(PROCEDURE_KIND).map(read).filter(Boolean)
  return {
    list: () => all().map(procedureSummary).sort((a, b) => b.updatedAt - a.updatedAt),
    get(id) {
      if (typeof id !== 'string') return null
      const row = store.records.list(PROCEDURE_KIND).find(item => item.key === id)
      return row ? read(row) : null
    },
    save(raw) {
      const at = now()
      const parsed = normalizeProcedure({ ...(raw && typeof raw === 'object' ? raw : {}), id: newId(), createdAt: at, updatedAt: at }, { now: at })
      if (!parsed.ok) return parsed
      if (store.records.count(PROCEDURE_KIND) >= MAX_PROCEDURES) return { ok: false, errors: [`at most ${MAX_PROCEDURES} procedures`] }
      store.records.insert(PROCEDURE_KIND, parsed.procedure.id, JSON.stringify(parsed.procedure))
      return parsed
    },
    update(id, raw) {
      const current = this.get(id)
      if (!current) return { ok: false, notFound: true }
      const at = now()
      const parsed = normalizeProcedure({ ...(raw && typeof raw === 'object' ? raw : {}), id, createdAt: current.createdAt, updatedAt: at }, { now: at })
      if (!parsed.ok) return parsed
      store.records.replace(PROCEDURE_KIND, id, JSON.stringify(parsed.procedure))
      return parsed
    },
    remove: id => typeof id === 'string' && store.records.remove(PROCEDURE_KIND, id),
    captureDraft({ clientThreadId, cardId, name = null } = {}) {
      const entries = journal?.lastRun(clientThreadId, cardId) ?? []
      const draft = draftFromJournal(entries, { now: now(), name, source: { clientThreadId, cardId } })
      return draft.steps.length ? draft : null
    },
    saveCaptured(args) {
      const draft = this.captureDraft(args)
      return draft ? this.save(draft) : { ok: false, empty: true }
    },
  }
}
