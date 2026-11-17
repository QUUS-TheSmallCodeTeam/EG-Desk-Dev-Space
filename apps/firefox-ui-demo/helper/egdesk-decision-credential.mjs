import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

// The person's own decision model API key (OpenAI project key), kept apart
// from every other EG-Desk store so no export, sync or log path carries it.
// - One file, mode 0600, in a private 0700 directory that is not a symlink.
// - Writes are atomic (private temp file, fsync, rename), the same routine as
//   egdesk-bridge-settings.mjs.
// - The key leaves this module only through getApiKey(), for the decision
//   client's Authorization header. Status, logs and hints never contain it.
// The OS keychain is not used yet: EG-Desk has no keychain write path today.

export const DECISION_CREDENTIAL_FILE = 'egdesk-decision-credential.json'
export const DECISION_CREDENTIAL_VERSION = 1
export const MAX_DECISION_CREDENTIAL_BYTES = 4096
// Printable ASCII without spaces, 20 to 512 characters (OpenAI project keys
// fit; the exact prefix is not assumed because key formats change).
const KEY_PATTERN = /^[\x21-\x7e]{20,512}$/

export function validDecisionApiKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value)
}

// '…' and the last four characters: enough to tell keys apart in settings.
export function decisionKeyHint(value) {
  return validDecisionApiKey(value) ? `…${value.slice(-4)}` : null
}

class CredentialContentError extends Error {}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const errorCode = error => (typeof error?.code === 'string' && error.code) || error?.name || 'Error'
const defaultLog = message => { try { process.stderr.write(`[egdesk-decision] ${message}\n`) } catch {} }

function readPrivateFile(file) {
  let fd
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
  catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    if (error.code === 'ELOOP') throw new CredentialContentError('a symbolic link')
    throw error
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || !isOwnedAndPrivate(file, info, 0o077)) throw new CredentialContentError('not a private regular file')
    if (info.size > MAX_DECISION_CREDENTIAL_BYTES) throw new CredentialContentError('too large')
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

function parseCredential(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new CredentialContentError('not JSON') }
  if (!record(data)) throw new CredentialContentError('not an object')
  if (Number.isSafeInteger(data.version) && data.version > DECISION_CREDENTIAL_VERSION) return { unsupported: true }
  if (data.version !== DECISION_CREDENTIAL_VERSION || data.provider !== 'openai' || !validDecisionApiKey(data.apiKey)) {
    throw new CredentialContentError('not a decision credential')
  }
  return { apiKey: data.apiKey, savedAt: Number.isSafeInteger(data.savedAt) ? data.savedAt : null }
}

/**
 * openDecisionCredentialStore({ dataDir, log?, now? }) → store
 * store.status: 'configured' | 'missing' | 'recovered' (a damaged file was set
 *   aside) | 'unsupported' (newer version, left untouched) | 'unreadable' |
 *   'unavailable' (directory refused).
 * store.writable, store.hint(), store.savedAt(), store.getApiKey()
 * store.save(apiKey) → true when saved; false on I/O failure. Throws TypeError
 *   for a value that is not a plausible key (never echoed).
 * store.clear() → true when no key file remains.
 */
export function openDecisionCredentialStore({ dataDir, log = defaultLog, now = Date.now } = {}) {
  const say = message => { try { log(message) } catch {} }
  let status = 'unavailable', writable = false, dir = null, file = null
  let apiKey = null, savedAt = null
  try {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Object.assign(new Error('dataDir must be absolute'), { code: 'INVALID_DATA_DIR' })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dataDir)
    dir = realpathSync.native(dataDir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(dir, stat, 0o077)) throw Object.assign(new Error('not private'), { code: 'NOT_PRIVATE' })
    file = path.join(dir, DECISION_CREDENTIAL_FILE)
  } catch (error) {
    say(`decision credential directory unavailable (${errorCode(error)}); the decision model stays off`)
    dir = null; file = null
  }
  if (file) {
    try {
      const read = readPrivateFile(file)
      if (read.missing) { status = 'missing'; writable = true }
      else {
        const parsed = parseCredential(read.text)
        if (parsed.unsupported) {
          status = 'unsupported'
          say(`${DECISION_CREDENTIAL_FILE} is from a newer EG-Desk; it is left as is and the decision model stays off`)
        } else {
          ({ apiKey, savedAt } = parsed)
          status = 'configured'; writable = true
        }
      }
    } catch (error) {
      if (error instanceof CredentialContentError) {
        const aside = `${DECISION_CREDENTIAL_FILE}.corrupt-${now()}-${randomBytes(4).toString('hex')}`
        try {
          renameSync(file, path.join(dir, aside))
          status = 'recovered'; writable = true
          say(`${DECISION_CREDENTIAL_FILE} was not a valid credential (${error.message}); kept it as ${aside}`)
        } catch (moveError) {
          status = 'unreadable'
          say(`${DECISION_CREDENTIAL_FILE} was not a valid credential (${error.message}) and could not be set aside (${errorCode(moveError)})`)
        }
      } else {
        status = 'unreadable'
        say(`${DECISION_CREDENTIAL_FILE} could not be read (${errorCode(error)}); the decision model stays off`)
      }
    }
  }

  function write(next) {
    const body = `${JSON.stringify({ version: DECISION_CREDENTIAL_VERSION, provider: 'openai', apiKey: next.apiKey, savedAt: next.savedAt }, null, 2)}\n`
    const tmp = path.join(dir, `${DECISION_CREDENTIAL_FILE}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
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
    try { const dirFd = openSync(dir, 'r'); try { fsyncSync(dirFd) } finally { closeSync(dirFd) } } catch {}
  }

  return Object.freeze({
    get status() { return status },
    get writable() { return writable },
    hint() { return decisionKeyHint(apiKey) },
    savedAt() { return savedAt },
    getApiKey() { return apiKey },
    save(value) {
      if (!validDecisionApiKey(value)) throw new TypeError('Not a plausible decision model API key')
      if (!writable || !file) return false
      const next = { apiKey: value, savedAt: now() }
      try { write(next) }
      catch (error) {
        say(`${DECISION_CREDENTIAL_FILE} could not be saved (${errorCode(error)})`)
        return false
      }
      apiKey = next.apiKey; savedAt = next.savedAt; status = 'configured'
      return true
    },
    clear() {
      if (!file) return false
      try { unlinkSync(file) }
      catch (error) {
        if (error.code !== 'ENOENT') { say(`${DECISION_CREDENTIAL_FILE} could not be removed (${errorCode(error)})`); return false }
      }
      apiKey = null; savedAt = null
      if (writable) status = 'missing'
      return true
    },
  })
}
