import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

// SUB-11 Engine Profiles: which login (account slot) an engine runs with.
// One small private JSON file beside the bridge settings:
//   { "version": 1, "profiles": [{ "id", "engine", "label", "owned": true }],
//     "active": { "claude": "claude-xxxx" } }
// - 'codex-default' and 'claude-default' always exist and are never stored:
//   they use the person's shared CLI login (~/.codex, ~/.claude), D-S3 (2026-10-24).
// - An added profile is EG-Desk-owned: its config directory is
//   <dataDir>/engines/<id> (0700). The official CLI logs in there
//   (CLAUDE_CONFIG_DIR=… claude auth login / CODEX_HOME=… codex login);
//   EG-Desk never reads the credential inside.
// - Claude can run an added profile (CLAUDE_CONFIG_DIR per spawned process).
//   Codex is one shared app-server process today, so an added Codex profile
//   is kept and shown as 'notYet' (runnable: false) and cannot be made active.
// - A damaged file is set aside (engine-profiles.json.corrupt-<time>-<id>) and
//   the defaults apply; a newer version is left untouched and not overwritten.
// - Writes are atomic (private temp file, fsync, rename), mode 0600.
export const ENGINE_PROFILES_FILE = 'engine-profiles.json'
export const ENGINE_PROFILES_VERSION = 1
export const DEFAULT_ENGINE_PROFILE_IDS = Object.freeze({ codex: 'codex-default', claude: 'claude-default' })
export const PROFILE_ENGINES = Object.freeze(['codex', 'claude'])
export const MAX_ENGINE_PROFILES = 8 // per engine, defaults included (engine-registry shows 8 rows)
const MAX_FILE_BYTES = 64 * 1024
const PROFILE_ID = /^(codex|claude)-[a-z0-9]{8,32}$/
const DEFAULT_LABELS = Object.freeze({ codex: 'ChatGPT (이 컴퓨터 로그인)', claude: 'Claude (이 컴퓨터 로그인)' })

const defaultLog = message => console.error(`[egdesk-codex-bridge] ${message}`)
const errorCode = error => (typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'ERROR')
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const profileError = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus })

/** A label the person typed: trimmed, 1..60 characters, no control characters. */
export function normalizeProfileLabel(value) {
  if (typeof value !== 'string') return null
  const label = value.replace(/\s+/g, ' ').trim()
  return label && label.length <= 60 && !/[\u0000-\u001f\u007f]/.test(label) ? label : null
}

class ContentError extends Error {}

function parseFile(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new ContentError('not JSON') }
  if (!isPlainObject(data)) throw new ContentError('not an object')
  if (data.version !== ENGINE_PROFILES_VERSION) {
    if (Number.isSafeInteger(data.version) && data.version > ENGINE_PROFILES_VERSION) return { unsupported: true }
    throw new ContentError('unknown version')
  }
  if (!Array.isArray(data.profiles)) throw new ContentError('profiles is not a list')
  const profiles = [], seen = new Set()
  for (const row of data.profiles) {
    if (!isPlainObject(row) || !PROFILE_ID.test(row.id) || !PROFILE_ENGINES.includes(row.engine) || !row.id.startsWith(`${row.engine}-`) ||
        normalizeProfileLabel(row.label) !== row.label || row.owned !== true || seen.has(row.id)) throw new ContentError('invalid profile')
    seen.add(row.id)
    profiles.push({ id: row.id, engine: row.engine, label: row.label, owned: true })
  }
  for (const engine of PROFILE_ENGINES) if (profiles.filter(row => row.engine === engine).length > MAX_ENGINE_PROFILES - 1) throw new ContentError('too many profiles')
  const active = {}
  if (data.active !== undefined) {
    if (!isPlainObject(data.active)) throw new ContentError('invalid active')
    for (const [engine, id] of Object.entries(data.active)) {
      if (engine !== 'claude' || !profiles.some(row => row.id === id && row.engine === engine)) throw new ContentError('invalid active')
      active[engine] = id
    }
  }
  return { profiles, active }
}

function readPrivate(file) {
  let fd
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
  catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    if (error.code === 'ELOOP') throw new ContentError('a symbolic link')
    throw error
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || !isOwnedAndPrivate(file, info, 0o077)) throw new ContentError('not a private regular file')
    if (info.size > MAX_FILE_BYTES) throw new ContentError('too large')
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read)
      if (n === 0) break
      read += n
    }
    return { text: buffer.subarray(0, read).toString('utf8') }
  } finally { closeSync(fd) }
}

const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`

/**
 * openEngineProfiles({ dataDir, log?, now?, randomId? }) → store
 * dataDir: absolute private directory (created 0700). Never throws for I/O:
 * a broken store only means added profiles are not kept (defaults still work).
 * store.list(engine?) → [{ id, engine, label, owned, runnable, status, active }]
 * store.get(id), store.configDir(id) → absolute dir (owned) or null (shared login)
 * store.active(engine) → the active profile id (defaults when nothing chosen)
 * store.add({ engine, label }) → profile (creates the private dir)
 * store.remove(id, { inUse? }) → true; refuses defaults and the active profile
 * store.setActive(engine, id, { busy? }) → id; refuses Codex added profiles
 *   ('notYet') and any change while busy() (a running Run never moves).
 * store.loginCommand(id, method?) → { line, env, configDir }
 */
export function openEngineProfiles({ dataDir, log = defaultLog, now = Date.now, randomId = () => randomBytes(6).toString('hex') } = {}) {
  const say = message => { try { log(message) } catch {} }
  let status = 'unavailable', writable = false, dir = null, file = null, enginesDir = null
  let profiles = [], active = {}
  try {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Object.assign(new Error('dataDir must be absolute'), { code: 'INVALID_DATA_DIR' })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dataDir)
    dir = realpathSync.native(dataDir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(dir, stat, 0o077)) throw Object.assign(new Error('not private'), { code: 'NOT_PRIVATE' })
    file = path.join(dir, ENGINE_PROFILES_FILE)
    enginesDir = path.join(dir, 'engines')
  } catch (error) {
    say(`engine profile directory unavailable (${errorCode(error)}); only the shared logins are available`)
    dir = null; file = null
  }
  if (file) {
    try {
      const read = readPrivate(file)
      if (read.missing) { status = 'missing'; writable = true }
      else {
        const parsed = parseFile(read.text)
        if (parsed.unsupported) { status = 'unsupported'; say(`${ENGINE_PROFILES_FILE} is from a newer EG-Desk; it is left as is and not saved`) }
        else { ({ profiles, active } = parsed); status = 'loaded'; writable = true }
      }
    } catch (error) {
      if (error instanceof ContentError) {
        const aside = `${ENGINE_PROFILES_FILE}.corrupt-${now()}-${randomBytes(4).toString('hex')}`
        try { renameSync(file, path.join(dir, aside)); status = 'recovered'; writable = true; say(`${ENGINE_PROFILES_FILE} was not valid (${error.message}); kept it as ${aside}`) }
        catch (moveError) { status = 'unreadable'; say(`${ENGINE_PROFILES_FILE} was not valid (${error.message}) and could not be set aside (${errorCode(moveError)})`) }
      } else { status = 'unreadable'; say(`${ENGINE_PROFILES_FILE} could not be read (${errorCode(error)})`) }
    }
  }

  function write(nextProfiles, nextActive) {
    const body = `${JSON.stringify({ version: ENGINE_PROFILES_VERSION, profiles: nextProfiles, active: nextActive }, null, 2)}\n`
    const tmp = path.join(dir, `${ENGINE_PROFILES_FILE}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
    let fd = null
    try {
      fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
      const bytes = Buffer.from(body, 'utf8')
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
      fsyncSync(fd); closeSync(fd); fd = null
      renameSync(tmp, file)
    } catch (error) {
      if (fd !== null) { try { closeSync(fd) } catch {} }
      try { unlinkSync(tmp) } catch {}
      throw error
    }
    try { const dirFd = openSync(dir, 'r'); try { fsyncSync(dirFd) } finally { closeSync(dirFd) } } catch {}
  }

  function commit(nextProfiles, nextActive) {
    if (!writable) throw profileError('ENGINE_PROFILES_UNAVAILABLE', 'Engine profiles cannot be saved on this computer', 503)
    try { write(nextProfiles, nextActive) }
    catch (error) { say(`${ENGINE_PROFILES_FILE} could not be saved (${errorCode(error)})`); throw profileError('ENGINE_PROFILES_UNAVAILABLE', 'Engine profiles could not be saved', 503) }
    profiles = nextProfiles; active = nextActive; status = 'loaded'
  }

  const ownedDir = id => (enginesDir ? path.join(enginesDir, id) : null)
  const find = id => profiles.find(row => row.id === id) || null
  const isDefault = id => Object.values(DEFAULT_ENGINE_PROFILE_IDS).includes(id)
  const engineOf = id => (isDefault(id) ? id.split('-')[0] : find(id)?.engine ?? null)
  const activeId = engine => (engine === 'claude' && active.claude && find(active.claude) ? active.claude : DEFAULT_ENGINE_PROFILE_IDS[engine])

  function view(engine, id) {
    const row = isDefault(id) ? { id, engine, label: DEFAULT_LABELS[engine], owned: false } : find(id)
    const runnable = !row.owned || engine === 'claude'
    return { id: row.id, engine, label: row.label, owned: row.owned, runnable, status: runnable ? 'available' : 'notYet', active: activeId(engine) === row.id }
  }

  function ensurePrivateDir(target) {
    mkdirSync(enginesDir, { recursive: true, mode: 0o700 })
    mkdirSync(target, { recursive: false, mode: 0o700 })
    const stat = lstatSync(target)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(target, stat, 0o077)) throw Object.assign(new Error('not private'), { code: 'NOT_PRIVATE' })
  }

  const store = {
    get status() { return status },
    get writable() { return writable },
    list(engine = null) {
      const engines = engine == null ? PROFILE_ENGINES : PROFILE_ENGINES.filter(name => name === engine)
      return engines.flatMap(name => [DEFAULT_ENGINE_PROFILE_IDS[name], ...profiles.filter(row => row.engine === name).map(row => row.id)].map(id => view(name, id)))
    },
    get(id) { const engine = engineOf(id); return engine ? view(engine, id) : null },
    configDir(id) {
      if (isDefault(id)) return null
      if (!find(id)) throw profileError('ENGINE_PROFILE_NOT_FOUND', 'Unknown engine profile', 404)
      return ownedDir(id)
    },
    active: engine => activeId(engine),
    add({ engine, label } = {}) {
      if (!PROFILE_ENGINES.includes(engine)) throw profileError('INVALID_ENGINE', 'Unknown AI engine')
      const clean = normalizeProfileLabel(label)
      if (!clean) throw profileError('INVALID_PROFILE_LABEL', 'Label must be 1 to 60 characters')
      if (!writable || !enginesDir) throw profileError('ENGINE_PROFILES_UNAVAILABLE', 'Engine profiles cannot be saved on this computer', 503)
      if (profiles.filter(row => row.engine === engine).length >= MAX_ENGINE_PROFILES - 1) throw profileError('ENGINE_PROFILE_LIMIT', 'Too many profiles for this engine', 409)
      const id = `${engine}-${String(randomId()).toLowerCase()}`
      if (!PROFILE_ID.test(id) || find(id)) throw profileError('ENGINE_PROFILE_ID', 'Could not make a profile id', 500)
      const target = ownedDir(id)
      try { ensurePrivateDir(target) } catch (error) {
        say(`engine profile directory could not be made (${errorCode(error)})`)
        throw profileError('ENGINE_PROFILES_UNAVAILABLE', 'The private login folder could not be made', 503)
      }
      try { commit([...profiles, { id, engine, label: clean, owned: true }], active) }
      catch (error) { try { rmSync(target, { recursive: true, force: true }) } catch {} throw error }
      return view(engine, id)
    },
    remove(id, { inUse = () => false } = {}) {
      if (isDefault(id)) throw profileError('ENGINE_PROFILE_DEFAULT', 'The shared login profile cannot be removed', 409)
      const row = find(id)
      if (!row) throw profileError('ENGINE_PROFILE_NOT_FOUND', 'Unknown engine profile', 404)
      if (activeId(row.engine) === id) throw profileError('ENGINE_PROFILE_ACTIVE', 'Switch to another profile before removing this one', 409)
      if (inUse(id)) throw profileError('ENGINE_PROFILE_IN_USE', 'A conversation is running on this profile', 409)
      commit(profiles.filter(entry => entry.id !== id), active)
      // The CLI's login inside goes with it; a failure only leaves a private folder.
      try { rmSync(ownedDir(id), { recursive: true, force: true }) } catch (error) { say(`engine profile folder was not removed (${errorCode(error)})`) }
      return true
    },
    setActive(engine, id, { busy = () => false } = {}) {
      if (!PROFILE_ENGINES.includes(engine) || engineOf(id) !== engine) throw profileError('ENGINE_PROFILE_NOT_FOUND', 'Unknown engine profile', 404)
      if (!view(engine, id).runnable) throw profileError('ENGINE_PROFILE_NOT_YET', 'Codex runs one shared login for now; added ChatGPT profiles cannot run yet', 409)
      if (activeId(engine) === id) return id
      if (busy(engine)) throw profileError('ENGINE_PROFILE_BUSY', 'A conversation is running; switch after it finishes', 409)
      const next = { ...active }
      if (isDefault(id)) delete next[engine]; else next[engine] = id
      commit(profiles, next)
      return id
    },
    loginCommand(id, method = 'claudeai') {
      const engine = engineOf(id)
      if (!engine) throw profileError('ENGINE_PROFILE_NOT_FOUND', 'Unknown engine profile', 404)
      if (engine === 'claude' && !['claudeai', 'console'].includes(method)) throw profileError('CLAUDE_LOGIN_METHOD_INVALID', 'Unknown login method')
      const configDir = isDefault(id) ? null : ownedDir(id)
      const envName = engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
      const base = engine === 'claude' ? `claude auth login --${method}` : 'codex login'
      return { profileId: id, engine, env: configDir ? envName : null, configDir, line: configDir ? `${envName}=${shellQuote(configDir)} ${base}` : base }
    },
  }
  return store
}
