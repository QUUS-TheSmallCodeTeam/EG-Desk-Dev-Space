// L7 c32: what the engine really shows of EG-Desk's turn/start additionalContext.
//
// Real runs (Codex 0.171.0-alpha.13, check-8/12/13): a context entry of about 3,300 characters and more reached the model with its MIDDLE missing ("중간 내용이 생략되어 있어",
// the model's own words; the first sentence of the first page and the last sentences survived, the rest did not; its file tools are off, so it could not read what was spilled);
// entries of about 1,500 characters arrived whole. The 0.171 schema documents a spill to disk with a 2,500-token default ("`0` disables spilling") only on HOOK handlers
// (ConfiguredHookHandler.additionalContextLimit, HookMetadata.additionalContextLimit); TurnStartParams.additionalContext has no threshold parameter, and no key of the Config
// object (analytics … web_search) is about it. So EG-Desk cannot raise or disable the limit for its own entries per thread; it can keep each entry under it.
//
// This module is that: splitEngineContext() cuts an entry that is longer than `limit` characters into several entries at item boundaries (nothing is dropped or reworded; the
// engine shows each part whole); spilledKeys() names the entries that would still exceed it (one single item longer than the limit, or splitting off), which the draft check treats as
// not seen by the answering model; emulateSpill() is the test double of the engine's behaviour (head and tail of an over-limit entry, the middle replaced by a marker).
// Off unless the bridge flags say so: EGDESK_TURN_MEMORY_ENGINE_CONTEXT=split|mark, EGDESK_TURN_MEMORY_ENGINE_CHARS=<n> (default 2000). The unit of the threshold (characters
// or bytes, per entry or per turn) is what the spill probe (real-engine-memory-spill-probe-v2) measures; until it is known the limit is a configured estimate, not a fact.
export const ENGINE_CONTEXT_MODES = Object.freeze(['split', 'mark'])
export const ENGINE_CONTEXT_DEFAULT_CHARS = 2000
export const ENGINE_CONTEXT_MIN_CHARS = 400
const BOUNDARY = /\n\n(?=\[(?:item|page) id=)/
const CONTINUED = 'EG-Desk context, continued: more items of the same set, same rules as the first part.'

export function engineContextConfig({ engineContext, engineChars } = {}) {
  if (!ENGINE_CONTEXT_MODES.includes(engineContext)) return null
  const chars = Number.isSafeInteger(engineChars) && engineChars >= ENGINE_CONTEXT_MIN_CHARS ? engineChars : ENGINE_CONTEXT_DEFAULT_CHARS
  return { mode: engineContext, chars }
}

const textOf = entry => (typeof entry === 'string' ? entry : typeof entry?.value === 'string' ? entry.value : '')
const isApplication = entry => entry && typeof entry === 'object' && entry.kind === 'application' && typeof entry.value === 'string'

/** Units of an entry: the preamble, then one unit per `[item id=…]` / `[page id=…]` block (a block runs to the next block start). */
export function entryUnits(value) { return String(value).split(BOUNDARY) }

/**
 * splitEngineContext(additionalContext, { limit }) → { context, parts, oversize }
 *  context  the same entries in the same order, an application entry longer than `limit` replaced by `key`, `key_part2`, … (each at most `limit` characters unless one single
 *           unit is longer: then that unit stands alone and the key is listed in `oversize`); untrusted entries and entries within the limit are untouched
 *  parts    { key: [part keys] } for the split ones
 */
export function splitEngineContext(additionalContext, { limit = ENGINE_CONTEXT_DEFAULT_CHARS } = {}) {
  if (!additionalContext || typeof additionalContext !== 'object') return { context: additionalContext, parts: {}, oversize: [] }
  const context = {}, parts = {}, oversize = []
  for (const [key, entry] of Object.entries(additionalContext)) {
    if (!isApplication(entry) || entry.value.length <= limit) { context[key] = entry; continue }
    const units = entryUnits(entry.value), groups = []
    let current = [], size = 0
    for (const unit of units) {
      const extra = (current.length ? 2 : 0) + unit.length + (groups.length ? CONTINUED.length + 2 : 0)
      if (current.length && size + extra > limit) { groups.push(current); current = []; size = 0 }
      size += (current.length ? 2 : 0) + unit.length + (groups.length ? CONTINUED.length + 2 : 0)
      current.push(unit)
    }
    if (current.length) groups.push(current)
    const names = groups.map((_, i) => (i === 0 ? key : `${key}_part${i + 1}`))
    groups.forEach((group, i) => {
      const value = (i === 0 ? group.join('\n\n') : `${CONTINUED}\n\n${group.join('\n\n')}`)
      if (value.length > limit) oversize.push(names[i])
      context[names[i]] = { ...entry, value }
    })
    if (names.length > 1) parts[key] = names
  }
  return { context, parts, oversize }
}

/** Entries (application) that the engine would cut: longer than `limit` characters. */
export function spilledKeys(additionalContext, { limit = ENGINE_CONTEXT_DEFAULT_CHARS } = {}) {
  if (!additionalContext || typeof additionalContext !== 'object') return []
  return Object.entries(additionalContext).filter(([, entry]) => isApplication(entry) && entry.value.length > limit).map(([key]) => key)
}

/**
 * emulateSpill(additionalContext, { limit, scope, head }) → { visible: { key: text }, spilled: [keys] }: the test double of the engine. Per entry (scope 'entry', the default) or
 * over the sum of all application entries (scope 'total'): what is over the limit keeps its first `head` share and the rest of the `limit` from its end, the middle is
 * replaced by a marker; everything else is whole. The real shape of the preview is not known beyond "head and tail survive"; tests rely on that and nothing finer.
 */
export function emulateSpill(additionalContext, { limit = ENGINE_CONTEXT_DEFAULT_CHARS, scope = 'entry', head = 0.3 } = {}) {
  const entries = Object.entries(additionalContext ?? {}).map(([key, entry]) => [key, textOf(entry), isApplication(entry)])
  const total = entries.filter(e => e[2]).reduce((n, e) => n + e[1].length, 0)
  const visible = {}, spilled = []
  for (const [key, text, application] of entries) {
    const over = application && (scope === 'total' ? total > limit : text.length > limit)
    if (!over) { visible[key] = text; continue }
    const keep = scope === 'total' ? Math.max(200, Math.floor(limit * text.length / total)) : limit, h = Math.floor(keep * head)
    visible[key] = `${text.slice(0, h)}\n[… ${text.length - keep} characters were written to a file …]\n${text.slice(text.length - (keep - h))}`
    spilled.push(key)
  }
  return { visible, spilled }
}
