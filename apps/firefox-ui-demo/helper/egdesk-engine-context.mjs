// L7 c32/c33: what the engine really shows of EG-Desk's turn/start additionalContext.
//
// The engine cuts the middle out of one additionalContext ENTRY when it is too large (the model says so: "중간 내용이 생략되어 있어"; the first sentence and the last sentences
// survive; its file tools are off, so it cannot read what was spilled). The 0.171 schema documents a spill threshold (2,500 tokens, `0` disables) only for HOOK handlers
// (ConfiguredHookHandler.additionalContextLimit, HookMetadata.additionalContextLimit); TurnStartParams.additionalContext has no threshold parameter and no Config key is about it, so
// EG-Desk cannot raise or disable the limit per thread: it keeps each entry under it.
//
// What the real runs say about the limit (Codex 0.171.0-alpha.13), one entry per turn:
//   passed whole   1,461 B (held-v4), 1,786 B, 3,705 B (Korean, 2,305 chars), 4,682 B (Korean, 2,716 chars), 5,295 B (English, 5,295 chars)         [check-6, check-15]
//   cut            6,340 B (Korean, 3,556 chars; check-12 probe n2), 7,290 B (English, 7,288 chars), 11.7k B, 13.7k B, 17k B and more               [check-8/12/13/15]
//   split parts    2,582 - 3,251 B, 8 parts of one turn (25 kB in all), every marker found: the limit is PER ENTRY, not on the sum                   [check-15]
// So the unit is BYTES (UTF-8; a 3,556-character Korean entry fell where a 5,295-character English one did not) and the threshold lies between 5,295 and 6,340 bytes. EG-Desk designs to
// 4,000 bytes: about a quarter under the largest entry seen whole, over a third under the smallest seen cut, and above every part the real run delivered whole.
//
// splitEngineContext() cuts an entry longer than the limit into several entries: at item boundaries first and, when one item alone is longer, inside that item at sentence boundaries
// (the later chunks start with a "(continued: …)" line). Nothing is dropped or reworded. spilledKeys() names the entries that are over the limit (what the draft check treats as only
// partly seen); emulateSpill() is the test double of the engine's cut.
// Off unless the bridge flags say so: EGDESK_TURN_MEMORY_ENGINE_CONTEXT=split|mark, EGDESK_TURN_MEMORY_ENGINE_BYTES=<n> (default 4000), EGDESK_TURN_MEMORY_ENGINE_CHARS=<n> (an extra cap in characters, none by default).
export const ENGINE_CONTEXT_MODES = Object.freeze(['split', 'mark'])
export const ENGINE_CONTEXT_DEFAULT_BYTES = 4000
export const ENGINE_CONTEXT_MIN_BYTES = 1000
export const ENGINE_CONTEXT_MIN_CHARS = 400
const BOUNDARY = /\n\n(?=\[(?:item|page) id=)/
const CONTINUED = 'EG-Desk context, continued: more items of the same set, same rules as the first part.'
const bytesOf = text => Buffer.byteLength(text, 'utf8')

/** → { mode, bytes, chars|null } or null (off). */
export function engineContextConfig({ engineContext, engineChars, engineBytes } = {}) {
  if (!ENGINE_CONTEXT_MODES.includes(engineContext)) return null
  return { mode: engineContext, bytes: Number.isSafeInteger(engineBytes) && engineBytes >= ENGINE_CONTEXT_MIN_BYTES ? engineBytes : ENGINE_CONTEXT_DEFAULT_BYTES,
    chars: Number.isSafeInteger(engineChars) && engineChars >= ENGINE_CONTEXT_MIN_CHARS ? engineChars : null }
}

const limitOf = limit => ({ bytes: Number.isSafeInteger(limit?.bytes) ? limit.bytes : ENGINE_CONTEXT_DEFAULT_BYTES, chars: Number.isSafeInteger(limit?.chars) ? limit.chars : null })
const fits = (text, limit) => bytesOf(text) <= limit.bytes && (limit.chars === null || text.length <= limit.chars)
const textOf = entry => (typeof entry === 'string' ? entry : typeof entry?.value === 'string' ? entry.value : '')
const isApplication = entry => entry && typeof entry === 'object' && entry.kind === 'application' && typeof entry.value === 'string'

/** Units of an entry: the preamble, then one unit per `[item id=…]` / `[page id=…]` block (a block runs to the next block start). */
export function entryUnits(value) { return String(value).split(BOUNDARY) }

// One unit that does not fit by itself, cut at sentence (or line) boundaries into chunks that do; the later chunks carry a "(continued: item id=…)" line.
function chunkUnit(unit, limit) {
  const headerEnd = unit.indexOf('\n'), header = headerEnd > 0 ? unit.slice(0, headerEnd) : '', body = headerEnd > 0 ? unit.slice(headerEnd + 1) : unit
  const token = /^\[((?:item|page) id=[^\s\]]+)/.exec(header)?.[1] ?? null
  const sentences = body.split(/(?<=[.!?。])\s+|\n+/).filter(Boolean)
  const chunks = []
  let current = header ? [header] : []
  const render = parts => parts.join(' ').replace(/^(\[[^\n]*\]) /, '$1\n')
  const lead = k => (k ? `(continued: ${token ?? 'item'}, part ${k + 1} of ${sentences.length})\n` : '')
  const room = k => ({ bytes: limit.bytes - bytesOf(lead(k)), chars: limit.chars === null ? null : limit.chars - lead(k).length })
  const flush = () => { if (current.length) chunks.push(current); current = [] }
  for (let sentence of sentences) {
    while (!fits(render([...current, sentence]), room(chunks.length))) {
      if (current.length && current.some(p => p !== header)) { flush(); continue }
      // one sentence longer than a whole chunk: cut it by code points
      const budget = room(chunks.length)
      let cut = sentence.length
      while (cut > 1 && !fits(render([...current, sentence.slice(0, cut)]), budget)) cut = Math.floor(cut * 0.9)
      current.push(sentence.slice(0, Math.max(1, cut))); flush(); sentence = sentence.slice(Math.max(1, cut)); if (!sentence) break
    }
    if (sentence) current.push(sentence)
  }
  flush()
  const total = chunks.length
  return chunks.map((parts, k) => (k === 0 ? render(parts) : `(continued: ${token ?? 'item'}, part ${k + 1} of ${total})\n${render(parts)}`))
}

/**
 * splitEngineContext(additionalContext, { limit: { bytes, chars? } }) → { context, parts, oversize }
 *  context  the same entries in the same order, an application entry over the limit replaced by `key`, `key_part2`, … (each within the limit; one item longer than the limit is cut at
 *           sentence boundaries first); untrusted entries and entries within the limit are untouched
 *  parts    { key: [part keys] } for the split ones;  oversize  part keys still over the limit (should stay empty)
 */
export function splitEngineContext(additionalContext, { limit: given } = {}) {
  const limit = limitOf(given)
  if (!additionalContext || typeof additionalContext !== 'object') return { context: additionalContext, parts: {}, oversize: [] }
  const context = {}, parts = {}, oversize = []
  for (const [key, entry] of Object.entries(additionalContext)) {
    if (!isApplication(entry) || fits(entry.value, limit)) { context[key] = entry; continue }
    const room = n => ({ bytes: limit.bytes - (n ? bytesOf(`${CONTINUED}\n\n`) : 0), chars: limit.chars === null ? null : limit.chars - (n ? CONTINUED.length + 2 : 0) })
    const units = entryUnits(entry.value).flatMap(unit => (fits(unit, room(1)) ? [unit] : chunkUnit(unit, room(1))))
    const groups = []
    let current = []
    for (const unit of units) {
      const candidate = [...current, unit].join('\n\n')
      if (current.length && !fits(candidate, room(groups.length))) { groups.push(current); current = [] }
      current.push(unit)
    }
    if (current.length) groups.push(current)
    const names = groups.map((_, i) => (i === 0 ? key : `${key}_part${i + 1}`))
    groups.forEach((group, i) => {
      const value = i === 0 ? group.join('\n\n') : `${CONTINUED}\n\n${group.join('\n\n')}`
      if (!fits(value, limit)) oversize.push(names[i])
      context[names[i]] = { ...entry, value }
    })
    if (names.length > 1) parts[key] = names
  }
  return { context, parts, oversize }
}

/** Entries (application) over the limit: what the engine would cut. */
export function spilledKeys(additionalContext, { limit: given } = {}) {
  const limit = limitOf(given)
  if (!additionalContext || typeof additionalContext !== 'object') return []
  return Object.entries(additionalContext).filter(([, entry]) => isApplication(entry) && !fits(entry.value, limit)).map(([key]) => key)
}

/**
 * emulateSpill(additionalContext, { limit: { bytes }, scope, head }) → { visible: { key: text }, spilled: [keys] }: the test double of the engine. Per entry (scope 'entry', the default,
 * what check-15 showed) or over the sum of all application entries (scope 'total', what it did not): what is over the limit keeps its first `head` share and the rest of the limit
 * from its end, the middle is replaced by a marker; everything else is whole. The real shape of the preview is not known beyond "head and tail survive".
 */
export function emulateSpill(additionalContext, { limit: given, scope = 'entry', head = 0.3 } = {}) {
  const limit = limitOf(given), cap = limit.bytes
  const entries = Object.entries(additionalContext ?? {}).map(([key, entry]) => [key, textOf(entry), isApplication(entry)])
  const total = entries.filter(e => e[2]).reduce((n, e) => n + bytesOf(e[1]), 0)
  const visible = {}, spilled = []
  for (const [key, text, application] of entries) {
    const size = bytesOf(text), over = application && (scope === 'total' ? total > cap : size > cap)
    if (!over) { visible[key] = text; continue }
    const keepBytes = scope === 'total' ? Math.max(200, Math.floor(cap * size / total)) : cap, ratio = Math.min(1, keepBytes / size), keep = Math.floor(text.length * ratio), h = Math.floor(keep * head)
    visible[key] = `${text.slice(0, h)}\n[… ${text.length - keep} characters were written to a file …]\n${text.slice(text.length - (keep - h))}`
    spilled.push(key)
  }
  return { visible, spilled }
}
