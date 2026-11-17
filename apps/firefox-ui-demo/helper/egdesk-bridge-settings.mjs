import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'
import { COMPUTER_CONTROL_POLICIES } from './codex-computer-control.mjs'
import { CONTEXT_SUGGEST_DEFAULT, normalizeContextSuggest } from './egdesk-context-resolver.mjs'

// Bridge settings the user chose that must outlive a bridge restart.
// One small JSON file in a private directory:
//   { "version": 1, "computerControlPolicy": "inherit" | "off",
//     "contextSuggest": { "mode": "always" | "firstMessage" | "off",
//                         "neverSuggest": [{ "kind": "site", "host": "bank.example.com" } | { "kind": "folder", "path": "/abs" }] },
//     "decisionContext": "off" | "advisory" | "on" }
// - Missing file or missing field: the module default applies
//   (DEFAULT_COMPUTER_CONTROL_POLICY in codex-computer-control.mjs,
//   CONTEXT_SUGGEST_DEFAULT in egdesk-context-resolver.mjs: always suggest,
//   nothing on the list — D-R2 is not decided, so today's behaviour stays).
// - A file that is not valid settings (bad JSON, wrong shape, not a private
//   regular file) is kept beside it as bridge-settings.json.corrupt-<time>-<id>,
//   logged, and the bridge starts with defaults.
// - A file from a newer version is left untouched and never overwritten.
// - Writes are atomic (private temp file, fsync, rename) and mode 0600.
// Opening never throws: a broken store only means choices are not kept.
export const BRIDGE_SETTINGS_FILE = 'bridge-settings.json'
export const BRIDGE_SETTINGS_VERSION = 1
// Room for contextSuggest at its limits (64 entries, folder paths up to 1024
// characters) so a full list is never read back as a damaged file.
export const MAX_BRIDGE_SETTINGS_BYTES = 256 * 1024

const defaultLog = message => console.error(`[egdesk-codex-bridge] ${message}`)
const errorCode = error => (typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'ERROR')
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const normalizedSuggest = value => { try { return normalizeContextSuggest(value) } catch { return null } }
// Decision model context setup (DECISION_MODEL_CONTEXT_SETUP.md): 'off' (default,
// today's behaviour), 'advisory' (decide and record, attach nothing), 'on'.
export const DECISION_CONTEXT_MODES = Object.freeze(['off', 'advisory', 'on'])
export const DECISION_CONTEXT_DEFAULT = 'off'
/** Settings fields this build reads and writes, with their validity rule. */
const FIELDS = Object.freeze({
  computerControlPolicy: value => COMPUTER_CONTROL_POLICIES.includes(value),
  contextSuggest: value => normalizedSuggest(value) !== null,
  decisionContext: value => DECISION_CONTEXT_MODES.includes(value),
})
/** Fields kept in a normalized (frozen) form; others are stored as given. */
const NORMALIZE = Object.freeze({ contextSuggest: normalizedSuggest })
const normalized = (name, value) => (NORMALIZE[name] ? NORMALIZE[name](value) : value)
const sameSetting = (a, b) => a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b))

class SettingsContentError extends Error {}

/** Parses the file's bytes; returns { values, extra } or throws why it is not settings. */
function parseSettings(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new SettingsContentError('not JSON') }
  if (!isPlainObject(data)) throw new SettingsContentError('not an object')
  if (data.version !== BRIDGE_SETTINGS_VERSION) {
    if (Number.isSafeInteger(data.version) && data.version > BRIDGE_SETTINGS_VERSION) return { unsupported: true }
    throw new SettingsContentError('unknown version')
  }
  const values = Object.create(null), extra = Object.create(null)
  for (const [key, value] of Object.entries(data)) {
    if (key === 'version') continue
    if (Object.hasOwn(FIELDS, key)) {
      if (!FIELDS[key](value)) throw new SettingsContentError(`invalid ${key}`)
      values[key] = normalized(key, value)
    } else extra[key] = value // A field a newer build added at the same version is kept as is.
  }
  return { values, extra }
}

function readPrivateFile(file) {
  let fd
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
  catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    if (error.code === 'ELOOP') throw new SettingsContentError('a symbolic link')
    throw error
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || !isOwnedAndPrivate(file, info, 0o077)) throw new SettingsContentError('not a private regular file')
    if (info.size > MAX_BRIDGE_SETTINGS_BYTES) throw new SettingsContentError('too large')
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read)
      if (count === 0) break
      read += count
    }
    return { text: buffer.subarray(0, read).toString('utf8') }
  } finally { closeSync(fd) }
}

/**
 * openBridgeSettings({ dataDir, log?, now? }) → store
 * dataDir: absolute directory for the settings file (created 0700; must be
 * private and not a symlink). log(message) receives one line per problem
 * (file names and error codes only, never contents).
 * store.status: 'loaded' | 'missing' | 'recovered' (a damaged file was set
 *   aside) | 'unsupported' (newer version, left untouched) | 'unreadable' |
 *   'unavailable' (directory refused).
 * store.writable: whether choices can be saved.
 * store.get(name): the saved value of a field, or null when none is saved.
 * store.set(name, value) → true when the file now holds value (written, or
 *   already there); false when it could not be saved. Never throws for I/O.
 * store.computerControl: the adapter CodexChatRuntime takes as
 *   computerControlStore: { policy, persisted, save(policy) }.
 */
export function openBridgeSettings({ dataDir, log = defaultLog, now = Date.now } = {}) {
  const say = message => { try { log(message) } catch {} }
  let status = 'unavailable', writable = false, dir = null, file = null
  let values = Object.create(null), extra = Object.create(null)
  try {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Object.assign(new Error('dataDir must be absolute'), { code: 'INVALID_DATA_DIR' })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dataDir)
    dir = realpathSync.native(dataDir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(dir, stat, 0o077)) throw Object.assign(new Error('not private'), { code: 'NOT_PRIVATE' })
    file = path.join(dir, BRIDGE_SETTINGS_FILE)
  } catch (error) {
    say(`bridge settings directory unavailable (${errorCode(error)}); settings start with defaults and are not saved`)
    dir = null; file = null
  }
  if (file) {
    try {
      const read = readPrivateFile(file)
      if (read.missing) { status = 'missing'; writable = true }
      else {
        const parsed = parseSettings(read.text)
        if (parsed.unsupported) {
          status = 'unsupported'
          say(`${BRIDGE_SETTINGS_FILE} is from a newer EG-Desk; it is left as is, settings start with defaults and are not saved`)
        } else {
          ({ values, extra } = parsed)
          status = 'loaded'; writable = true
        }
      }
    } catch (error) {
      if (error instanceof SettingsContentError) {
        const aside = `${BRIDGE_SETTINGS_FILE}.corrupt-${now()}-${randomBytes(4).toString('hex')}`
        try {
          renameSync(file, path.join(dir, aside))
          status = 'recovered'; writable = true
          say(`${BRIDGE_SETTINGS_FILE} was not valid settings (${error.message}); kept it as ${aside} and started with defaults`)
        } catch (moveError) {
          status = 'unreadable'
          say(`${BRIDGE_SETTINGS_FILE} was not valid settings (${error.message}) and could not be set aside (${errorCode(moveError)}); it is left as is, settings start with defaults and are not saved`)
        }
      } else {
        status = 'unreadable'
        say(`${BRIDGE_SETTINGS_FILE} could not be read (${errorCode(error)}); settings start with defaults and are not saved`)
      }
    }
  }

  function write(next) {
    const body = `${JSON.stringify({ version: BRIDGE_SETTINGS_VERSION, ...next.values, ...next.extra }, null, 2)}\n`
    const tmp = path.join(dir, `${BRIDGE_SETTINGS_FILE}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
    let fd = null
    try {
      fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
      const bytes = Buffer.from(body, 'utf8')
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
      fsyncSync(fd)
      closeSync(fd); fd = null
      renameSync(tmp, file)
    } catch (error) {
      if (fd !== null) { try { closeSync(fd) } catch {} }
      try { unlinkSync(tmp) } catch {}
      throw error
    }
    // Make the rename itself durable where the platform allows it.
    try { const dirFd = openSync(dir, 'r'); try { fsyncSync(dirFd) } finally { closeSync(dirFd) } } catch {}
  }

  const store = {
    get status() { return status },
    get writable() { return writable },
    get(name) {
      if (!Object.hasOwn(FIELDS, name)) throw new TypeError(`Unknown bridge setting: ${name}`)
      return Object.hasOwn(values, name) ? values[name] : null
    },
    set(name, value) {
      if (!Object.hasOwn(FIELDS, name) || !FIELDS[name](value)) throw new TypeError(`Invalid bridge setting: ${name}`)
      if (!writable) return false
      const clean = normalized(name, value)
      if (sameSetting(values[name], clean)) return true
      const next = { values: Object.assign(Object.create(null), values, { [name]: clean }), extra }
      try { write(next) }
      catch (error) {
        say(`${BRIDGE_SETTINGS_FILE} could not be saved (${errorCode(error)}); the setting applies until the bridge restarts`)
        return false
      }
      values = next.values
      status = 'loaded'
      return true
    },
  }
  store.computerControl = Object.freeze({
    // The saved policy, or null (the runtime then uses DEFAULT_COMPUTER_CONTROL_POLICY).
    get policy() { return store.get('computerControlPolicy') },
    // At start: whether a choice can be kept at all.
    get persisted() { return writable },
    save: policy => store.set('computerControlPolicy', policy),
  })
  // D-R2: the adapter ContextRuntime.attachServices takes as settings.
  store.contextSuggest = Object.freeze({
    // The saved setting, or CONTEXT_SUGGEST_DEFAULT (always suggest, empty list).
    get value() { return store.get('contextSuggest') ?? CONTEXT_SUGGEST_DEFAULT },
    // Whether a value is saved (false: the default applies).
    get saved() { return store.get('contextSuggest') !== null },
    get persisted() { return writable },
    save: value => store.set('contextSuggest', value),
  })
  // Decision model mode: the saved choice, or 'off' when none is saved.
  store.decisionContext = Object.freeze({
    get mode() { return store.get('decisionContext') ?? DECISION_CONTEXT_DEFAULT },
    get saved() { return store.get('decisionContext') !== null },
    get persisted() { return writable },
    save: mode => store.set('decisionContext', mode),
  })
  return store
}
