import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

// The local decision-model usage tally (and the owner's monthly input-token
// cap, once one is chosen) kept across bridge restarts. It is a local guard,
// not a bill: only the input tokens EG-Desk itself counted for one UTC month.
// - Own file, mode 0600, in the same private settings directory as the key;
//   it never contains the key, a hint of it, prompts or answers.
// - Same atomic routine as egdesk-decision-credential.mjs (private temp file,
//   fsync, rename, directory fsync).
// - Deleting the key does not touch it: usage belongs to the month, not the key.
// - A damaged file is set aside and logged; a newer version is left untouched.
// Opening never throws; a broken store only means the tally is not kept.

export const DECISION_BUDGET_FILE = 'egdesk-decision-budget.json'
export const DECISION_BUDGET_VERSION = 1
export const MAX_DECISION_BUDGET_BYTES = 1024

class BudgetContentError extends Error {}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const errorCode = error => (typeof error?.code === 'string' && error.code) || error?.name || 'Error'
const defaultLog = message => { try { process.stderr.write(`[egdesk-decision] ${message}\n`) } catch {} }

function readPrivateFile(file) {
  let fd
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
  catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    if (error.code === 'ELOOP') throw new BudgetContentError('a symbolic link')
    throw error
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || !isOwnedAndPrivate(file, info, 0o077)) throw new BudgetContentError('not a private regular file')
    if (info.size > MAX_DECISION_BUDGET_BYTES) throw new BudgetContentError('too large')
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

function parseBudget(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new BudgetContentError('not JSON') }
  if (!record(data)) throw new BudgetContentError('not an object')
  if (Number.isSafeInteger(data.version) && data.version > DECISION_BUDGET_VERSION) return { unsupported: true }
  if (data.version !== DECISION_BUDGET_VERSION || typeof data.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month) ||
    !Number.isSafeInteger(data.inputTokens) || data.inputTokens < 0 ||
    !(data.cap === null || (Number.isSafeInteger(data.cap) && data.cap > 0))) throw new BudgetContentError('not a decision budget')
  return { state: { month: data.month, inputTokens: data.inputTokens, cap: data.cap } }
}

/**
 * openDecisionBudgetStore({ dataDir, log? }) → store
 * store.status: 'saved' | 'missing' | 'recovered' | 'unsupported' | 'unreadable' | 'unavailable'
 * store.state → { month, inputTokens, cap } read at open, or null
 * store.save({ month, inputTokens, cap }) → true when written; never throws.
 */
export function openDecisionBudgetStore({ dataDir, log = defaultLog, now = Date.now } = {}) {
  const say = message => { try { log(message) } catch {} }
  let status = 'unavailable', writable = false, dir = null, file = null, state = null
  try {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Object.assign(new Error('dataDir must be absolute'), { code: 'INVALID_DATA_DIR' })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dataDir)
    dir = realpathSync.native(dataDir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(dir, stat, 0o077)) throw Object.assign(new Error('not private'), { code: 'NOT_PRIVATE' })
    file = path.join(dir, DECISION_BUDGET_FILE)
  } catch (error) {
    say(`decision budget directory unavailable (${errorCode(error)}); usage is counted for this run only`)
    dir = null; file = null
  }
  if (file) {
    try {
      const read = readPrivateFile(file)
      if (read.missing) { status = 'missing'; writable = true }
      else {
        const parsed = parseBudget(read.text)
        if (parsed.unsupported) { status = 'unsupported'; say(`${DECISION_BUDGET_FILE} is from a newer EG-Desk; it is left as is`) }
        else { state = parsed.state; status = 'saved'; writable = true }
      }
    } catch (error) {
      if (error instanceof BudgetContentError) {
        const aside = `${DECISION_BUDGET_FILE}.corrupt-${now()}-${randomBytes(4).toString('hex')}`
        try {
          renameSync(file, path.join(dir, aside)); status = 'recovered'; writable = true
          say(`${DECISION_BUDGET_FILE} was not a valid budget (${error.message}); kept it as ${aside}`)
        } catch (moveError) {
          status = 'unreadable'
          say(`${DECISION_BUDGET_FILE} was not a valid budget (${error.message}) and could not be set aside (${errorCode(moveError)})`)
        }
      } else { status = 'unreadable'; say(`${DECISION_BUDGET_FILE} could not be read (${errorCode(error)})`) }
    }
  }

  function write(next) {
    const body = `${JSON.stringify({ version: DECISION_BUDGET_VERSION, month: next.month, inputTokens: next.inputTokens, cap: next.cap }, null, 2)}\n`
    const tmp = path.join(dir, `${DECISION_BUDGET_FILE}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
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
    get state() { return state },
    save(next) {
      if (!writable || !file || !record(next)) return false
      try { write(next); status = 'saved'; return true }
      catch (error) { say(`${DECISION_BUDGET_FILE} could not be saved (${errorCode(error)})`); return false }
    },
  })
}
