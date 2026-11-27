import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

// One small JSON file in the private settings directory, same conventions as the key, usage and calibration files:
// mode 0600, private directory, atomic write (private temp file, fsync, rename), never follows links, a damaged file is
// set aside (not trusted, not deleted), a file from a newer version is left untouched and never overwritten.
// Opening never throws; a broken store only means nothing is kept on disk (memory still works for this run).
// openPrivateJsonStore({ dataDir, file, version, maxBytes, empty, normalize(data) -> data, log?, now? })
//   -> { status, data (a copy), save(data) -> boolean }
// status: 'saved' | 'missing' | 'recovered' | 'unsupported' | 'unavailable'
const errorCode = error => (typeof error?.code === 'string' && error.code) || error?.name || 'Error'
const defaultLog = message => { try { process.stderr.write(`[egdesk-store] ${message}\n`) } catch {} }

export function openPrivateJsonStore({ dataDir, file: name, version, maxBytes, empty, normalize, log = defaultLog, now = Date.now } = {}) {
  const say = message => { try { log(message) } catch {} }
  let status = 'unavailable', dir = null, file = null, writable = false, data = normalize(empty())
  try {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Object.assign(new Error('dataDir must be absolute'), { code: 'INVALID_DATA_DIR' })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dataDir)
    dir = realpathSync.native(dataDir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(dir, stat, 0o077)) throw Object.assign(new Error('not private'), { code: 'NOT_PRIVATE' })
    file = path.join(dir, name)
  } catch (error) { say(`${name} unavailable (${errorCode(error)})`); dir = null; file = null }
  if (file) {
    let fd
    try {
      try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) } catch (error) { if (error.code === 'ENOENT') { status = 'missing'; writable = true } else throw error }
      if (fd !== undefined) {
        const info = fstatSync(fd)
        if (!info.isFile() || info.nlink !== 1 || !isOwnedAndPrivate(file, info, 0o077) || info.size > maxBytes * 2) throw new Error('not a private regular file')
        const buffer = Buffer.alloc(info.size); let read = 0
        while (read < buffer.length) { const n = readSync(fd, buffer, read, buffer.length - read, read); if (n === 0) break; read += n }
        const parsed = JSON.parse(buffer.subarray(0, read).toString('utf8'))
        if (parsed && Number.isSafeInteger(parsed.version) && parsed.version > version) { status = 'unsupported'; say(`${name} is from a newer EG-Desk; it is left as is`) }
        else if (!parsed || parsed.version !== version) throw new Error('unknown version')
        else { data = normalize(parsed); status = 'saved'; writable = true }
      }
    } catch (error) {
      const aside = `${name}.corrupt-${now()}-${randomBytes(4).toString('hex')}`
      try { renameSync(file, path.join(dir, aside)); status = 'recovered'; writable = true; say(`${name} was not valid; kept it as ${aside}`) }
      catch (moveError) { status = 'unavailable'; say(`${name} could not be read (${errorCode(error)}/${errorCode(moveError)})`) }
    } finally { if (fd !== undefined) { try { closeSync(fd) } catch {} } }
  }
  function write(next) {
    const body = `${JSON.stringify({ version, ...next })}\n`
    if (Buffer.byteLength(body) > maxBytes) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' })
    const tmp = path.join(dir, `${name}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
    let fd = null
    try {
      fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
      const bytes = Buffer.from(body, 'utf8'); let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
      fsyncSync(fd); closeSync(fd); fd = null
      renameSync(tmp, file)
    } catch (error) { if (fd !== null) { try { closeSync(fd) } catch {} } try { unlinkSync(tmp) } catch {} throw error }
  }
  return Object.freeze({
    get status() { return status },
    get data() { return structuredClone(data) },
    // Normalizes, then writes. Returns false (and keeps the old data) when the store cannot hold it or is unavailable.
    save(next) {
      try {
        const clean = normalize(next)
        if (!writable || !file) return false // nothing can be kept: the caller must treat the write as not done
        write(clean)
        data = clean
        return true
      } catch (error) { say(`${name} could not be saved (${errorCode(error)})`); return false }
    },
  })
}
