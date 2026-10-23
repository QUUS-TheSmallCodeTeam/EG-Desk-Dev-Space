import { chatError, publicText } from './codex-chat-values.mjs'

// The Codex models the signed-in account can choose in Chat, read from the
// app-server's model/list (codex 0.162.1 v2/ModelListParams.json and
// ModelListResponse.json): { data: Model[], nextCursor }, where Model carries
// id, model, displayName, hidden, isDefault, supportedReasoningEfforts[
// { reasoningEffort, description }] and defaultReasoningEffort.
//
// A public row is { id, displayName, isDefault, supportedEfforts, defaultEffort }.
// id is the Model.model slug, the value turn/start accepts as `model` and
// thread/start reports back (in 0.162.1 every listed id equals its model).
// Descriptions, upgrade copy, service tiers, access programs and any other
// field never leave here. The list is an array; a model-chosen string is never
// used as an object key.
export const MODEL_CATALOG_METHOD = 'model/list'
export const MODEL_CATALOG_LIMIT = 50
export const MODEL_CATALOG_MAX_PAGES = 10
const MAX_EFFORTS = 16
// Same bound as EGDESK_CODEX_MODEL (egdesk-native-capabilities.mjs).
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
// ReasoningEffort is a non-empty model-advertised string; keep it a short token.
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/

const modelId = value => typeof value === 'string' && MODEL_ID.test(value) ? value : null
const effortToken = value => typeof value === 'string' && EFFORT.test(value) ? value : null

function efforts(values) {
  const list = []
  for (const value of Array.isArray(values) ? values : []) {
    const effort = effortToken(value)
    if (effort && !list.includes(effort)) list.push(effort)
    if (list.length === MAX_EFFORTS) break
  }
  return list
}

/** One already-public row rebuilt from the allow-list, or null. */
export function publicModelRow(row) {
  const id = modelId(row?.id)
  if (!id) return null
  const supportedEfforts = efforts(row.supportedEfforts)
  const defaultEffort = effortToken(row.defaultEffort)
  return {
    id,
    displayName: (typeof row.displayName === 'string' && publicText(row.displayName, 80).trim()) || id,
    isDefault: row.isDefault === true,
    supportedEfforts,
    // Only an effort the model also lists, so the screen can always send it.
    defaultEffort: defaultEffort && supportedEfforts.includes(defaultEffort) ? defaultEffort : null,
  }
}

/** One model/list Model → a public row, or null when hidden or unusable. */
export function publicCodexModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model) || model.hidden === true) return null
  return publicModelRow({
    id: modelId(model.model) || modelId(model.id),
    displayName: model.displayName,
    isDefault: model.isDefault,
    supportedEfforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(option => option?.reasoningEffort),
    defaultEffort: model.defaultReasoningEffort,
  })
}

/**
 * Public rows (at most `limit`, unique ids, at most one default), or null when
 * the list is unknown. null is never replaced by [] or an invented list.
 */
export function publicModelRows(rows, { limit = MODEL_CATALOG_LIMIT } = {}) {
  if (!Array.isArray(rows)) return null
  const list = []
  let defaultSeen = false
  for (const raw of rows) {
    const row = publicModelRow(raw)
    if (!row || list.some(known => known.id === row.id)) continue
    if (row.isDefault) {
      if (defaultSeen) row.isDefault = false
      defaultSeen = true
    }
    list.push(row)
    if (list.length === limit) break
  }
  return list.length ? list : null
}

/**
 * Reads model/list page by page (hidden models excluded) up to `limit` rows
 * and `maxPages` pages. Any failed or malformed page makes the whole list
 * unknown (null): a partial list would refuse models it never reached.
 */
export async function readCodexModelCatalog(request, { limit = MODEL_CATALOG_LIMIT, maxPages = MODEL_CATALOG_MAX_PAGES } = {}) {
  const rows = []
  const cursors = new Set()
  let cursor = null
  try {
    for (let page = 0; page < maxPages && rows.length < limit; page += 1) {
      const result = await request(MODEL_CATALOG_METHOD, { cursor, includeHidden: false, limit: limit - rows.length })
      if (!result || typeof result !== 'object' || !Array.isArray(result.data)) return null
      for (const model of result.data) {
        const row = publicCodexModel(model)
        if (row && !rows.some(known => known.id === row.id)) rows.push(row)
      }
      const next = result.nextCursor
      if (next == null) break
      // A repeated or malformed cursor would loop forever; stop with what is read.
      if (typeof next !== 'string' || !next || next.length > 4096 || cursors.has(next)) break
      cursors.add(next)
      cursor = next
    }
  } catch { return null }
  return publicModelRows(rows, { limit })
}

/**
 * The Codex row's models for /v1/state: read after each ready app-server
 * connection and whenever the signed-in account changes. null means unknown:
 * offline, not read yet, the read failed, or it belonged to another account.
 * - identity(): the current public account key; a read answered for another
 *   account, or after reset(), is dropped.
 * - refresh({ clear }): clear forgets the previous list first (account change).
 * - onChange(rows) runs after the public value changed.
 */
export function createModelCatalogSync({ request, ready = () => true, identity = () => null, onChange = () => {}, read = readCodexModelCatalog } = {}) {
  let rows = null, generation = 0, inFlight = null
  const snapshot = () => rows ? rows.map(row => ({ ...row, supportedEfforts: [...row.supportedEfforts] })) : null
  const set = next => {
    const changed = JSON.stringify(next) !== JSON.stringify(rows)
    rows = next
    if (changed) onChange(snapshot())
  }
  function refresh({ clear = false } = {}) {
    if (!ready()) { generation += 1; inFlight = null; set(null); return Promise.resolve(null) }
    const owner = identity()
    if (clear) set(null)
    if (inFlight && inFlight.owner === owner && !clear) return inFlight.promise
    const mine = ++generation
    const entry = { owner, promise: null }
    entry.promise = (async () => {
      let next = null
      try { next = await read(request) } catch { next = null }
      if (mine === generation && identity() === owner) set(publicModelRows(next))
      return snapshot()
    })().finally(() => { if (inFlight === entry) inFlight = null })
    inFlight = entry
    return entry.promise
  }
  function reset() {
    generation += 1
    inFlight = null
    set(null)
  }
  return { refresh, reset, snapshot }
}

/**
 * A per-turn model/effort choice checked against the listed models. With no
 * list (null) everything passes, as before the list existed.
 * - model must be a listed id (MODEL_UNAVAILABLE).
 * - effort must be one the chosen model lists (EFFORT_UNSUPPORTED). Without a
 *   model, the model that will run is `currentModel` when it is listed;
 *   otherwise the effort must be listed by at least one model.
 */
export function assertModelSelection(models, { model, effort, currentModel = null } = {}) {
  const list = publicModelRows(models)
  if (!list) return
  const chosen = model !== undefined ? list.find(row => row.id === model) : null
  if (model !== undefined && !chosen) throw chatError('MODEL_UNAVAILABLE', 'This model is not available to the signed-in Codex account', 400)
  if (effort === undefined) return
  const running = chosen || list.find(row => row.id === currentModel) || null
  const allowed = running ? running.supportedEfforts : list.flatMap(row => row.supportedEfforts)
  if (!allowed.includes(effort)) {
    throw chatError('EFFORT_UNSUPPORTED', running ? `${running.displayName} does not support this reasoning effort` : 'No available model supports this reasoning effort', 400)
  }
}
