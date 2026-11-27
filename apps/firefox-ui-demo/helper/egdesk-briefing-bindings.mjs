// L4 cycle 23: the briefing output bindings, persisted, so a bridge restart keeps the version chain (c22: "recall your own stale output").
// What each card the briefing flow published was built from: outputId -> { keys, trait, component, outputKey, conversationId, version, hash }.
// The file holds ids, closed kind words, opaque material keys (hashes), versions and content hashes ONLY: never a title, a material's text or a card's text.
// It lives in the bridge's own data dir (0700 dir, 0600 file, written atomically), is bounded (entries, per conversation, bytes, age), is pruned with the
// conversation (forgetConversation) and, by the handler, when the output it names is gone. A broken or unavailable file only means nothing is kept on disk.
// The object is a Map (the same get/set/delete/entries/keys/size the handler and the skeleton use); set/delete save.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'
import { BRIEFING_CATALOG, MATERIAL_TRAITS } from './egdesk-briefing-catalog.mjs'

export const BINDINGS_FILE = 'briefing-bindings.json'
export const BINDINGS_VERSION = 1
export const BINDINGS_LIMITS = Object.freeze({ maxEntries: 500, perConversation: 60, maxKeys: 8, maxBytes: 256 * 1024, retentionDays: 180 })
const OUTPUT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const OUTPUT_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/
const MATERIAL_KEY = /^(?:t:)?[a-f0-9]{16,64}$/ // what normalizeMaterials gives: a memory key or a title/date fingerprint, both hashes
const HASH = /^[a-f0-9]{64}$/
const CONVERSATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const record = v => !!v && typeof v === 'object' && !Array.isArray(v)
const errorCode = error => (typeof error?.code === 'string' && error.code) || error?.name || 'Error'

/** One binding, closed: anything else (a title, text, an unknown kind) refuses the row. -> the clean value or null. */
export function cleanBinding(value, now = Date.now()) {
  if (!record(value)) return null
  const allowed = ['keys', 'trait', 'component', 'outputKey', 'conversationId', 'version', 'hash', 'at']
  if (Object.keys(value).some(k => !allowed.includes(k))) return null
  const { keys, trait, component, outputKey, conversationId } = value
  if (!Array.isArray(keys) || !keys.length || keys.length > BINDINGS_LIMITS.maxKeys || !keys.every(k => typeof k === 'string' && MATERIAL_KEY.test(k))) return null
  if (!MATERIAL_TRAITS.includes(trait) || !BRIEFING_CATALOG.ids.includes(component) || typeof outputKey !== 'string' || !OUTPUT_KEY.test(outputKey)) return null
  if (typeof conversationId !== 'string' || !CONVERSATION.test(conversationId)) return null
  const version = Number.isSafeInteger(value.version) && value.version >= 1 ? value.version : null
  const hash = typeof value.hash === 'string' && HASH.test(value.hash) ? value.hash : null
  const at = Number.isFinite(value.at) && value.at > 0 ? value.at : now
  return { keys: [...new Set(keys)], trait, component, outputKey, conversationId, version, hash, at }
}

function readPrivateFile(file) {
  let fd
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) } catch (error) { if (error.code === 'ENOENT') return { missing: true }; throw error }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || !isOwnedAndPrivate(file, info, 0o077) || info.size > BINDINGS_LIMITS.maxBytes * 2) throw new Error('not a private regular file')
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < buffer.length) { const n = readSync(fd, buffer, read, buffer.length - read, read); if (n === 0) break; read += n }
    return { text: buffer.subarray(0, read).toString('utf8') }
  } finally { closeSync(fd) }
}

class PersistedBindings extends Map {
  #save = () => {}
  constructor(rows, save) { super(); for (const [id, v] of rows) super.set(id, v); this.#save = save }
  set(outputId, value) {
    const clean = typeof outputId === 'string' && OUTPUT_ID.test(outputId) ? cleanBinding(value, this.now()) : null
    if (!clean) return this // a binding the file could not hold is not kept at all (the flow then publishes a new output, as without a chain)
    super.delete(outputId); super.set(outputId, clean) // most recent last (insertion order is the recency the continuation rule reads)
    this.bound(); this.#save(); return this
  }
  delete(outputId) { const had = super.delete(outputId); if (had) this.#save(); return had }
  now() { return Date.now() }
  /** Pruned with the conversation: every binding of it goes. -> how many. */
  forgetConversation(conversationId) {
    let n = 0
    for (const [id, v] of [...super.entries()]) if (v.conversationId === conversationId) { super.delete(id); n++ }
    if (n) this.#save(); return n
  }
  // Age, per-conversation and total bounds; the oldest go first.
  bound() {
    const cutoff = this.now() - BINDINGS_LIMITS.retentionDays * 86400000
    for (const [id, v] of [...super.entries()]) if (v.at < cutoff) super.delete(id)
    const per = new Map()
    for (const [id, v] of [...super.entries()].reverse()) { const c = (per.get(v.conversationId) ?? 0) + 1; per.set(v.conversationId, c); if (c > BINDINGS_LIMITS.perConversation) super.delete(id) }
    while (super.size > BINDINGS_LIMITS.maxEntries) super.delete(super.keys().next().value)
  }
}

/**
 * openBriefingBindings({ dataDir, log?, now? }) -> a Map of outputId -> binding (see the file comment) with forgetConversation and `status`:
 * 'saved' | 'missing' | 'recovered' | 'unsupported' | 'unavailable' (then it is an in-memory Map only, as before cycle 23).
 */
const defaultLog = message => { try { process.stderr.write(`[egdesk-briefing] ${message}\n`) } catch {} }
export function openBriefingBindings({ dataDir, log = defaultLog, now = Date.now } = {}) {
  const say = message => { try { log(message) } catch {} }
  let status = 'unavailable', dir = null, file = null, writable = false, rows = []
  try {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Object.assign(new Error('dataDir must be absolute'), { code: 'INVALID_DATA_DIR' })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dataDir)
    dir = realpathSync.native(dataDir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(dir, stat, 0o077)) throw Object.assign(new Error('not private'), { code: 'NOT_PRIVATE' })
    file = path.join(dir, BINDINGS_FILE)
  } catch (error) { say(`briefing bindings unavailable (${errorCode(error)})`); dir = null; file = null }
  if (file) {
    try {
      const read = readPrivateFile(file)
      if (read.missing) { status = 'missing'; writable = true } else {
        const data = JSON.parse(read.text)
        if (record(data) && Number.isSafeInteger(data.version) && data.version > BINDINGS_VERSION) { status = 'unsupported'; say(`${BINDINGS_FILE} is from a newer EG-Desk; it is left as is`) }
        else {
          if (!record(data) || data.version !== BINDINGS_VERSION || !Array.isArray(data.bindings)) throw new Error('not a bindings file')
          rows = data.bindings.flatMap(row => (Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && OUTPUT_ID.test(row[0]) ? [[row[0], cleanBinding(row[1], now())]] : [])).filter(([, v]) => v)
          status = 'saved'; writable = true
        }
      }
    } catch (error) {
      const aside = `${BINDINGS_FILE}.corrupt-${now()}-${randomBytes(4).toString('hex')}`
      try { renameSync(file, path.join(dir, aside)); status = 'recovered'; writable = true; say(`${BINDINGS_FILE} was not a valid bindings file; kept it as ${aside}`) }
      catch (moveError) { status = 'unavailable'; say(`${BINDINGS_FILE} could not be read (${errorCode(error)}/${errorCode(moveError)})`) }
    }
  }
  function write(map) {
    let bindings = [...Map.prototype.entries.call(map)]
    let body = `${JSON.stringify({ version: BINDINGS_VERSION, bindings })}\n`
    while (bindings.length > 1 && Buffer.byteLength(body) > BINDINGS_LIMITS.maxBytes) { bindings = bindings.slice(1); body = `${JSON.stringify({ version: BINDINGS_VERSION, bindings })}\n` }
    const tmp = path.join(dir, `${BINDINGS_FILE}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
    let fd = null
    try {
      fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
      const bytes = Buffer.from(body, 'utf8')
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
      fsyncSync(fd); closeSync(fd); fd = null
      renameSync(tmp, file)
    } catch (error) { if (fd !== null) { try { closeSync(fd) } catch {} } try { unlinkSync(tmp) } catch {} throw error }
  }
  let map = null
  const save = () => {
    if (!writable || !file) return
    try { write(map); status = 'saved' } catch (error) { say(`${BINDINGS_FILE} could not be saved (${errorCode(error)})`) }
  }
  map = new PersistedBindings(rows, save)
  map.now = now
  map.bound() // the bounds hold from the start (nothing is written until the next change)
  Object.defineProperty(map, 'status', { get: () => status })
  return map
}
