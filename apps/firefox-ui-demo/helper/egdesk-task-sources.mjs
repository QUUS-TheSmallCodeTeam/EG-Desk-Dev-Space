import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'
import { MAX_TEXT, validateChatCwd } from './codex-chat-values.mjs'
import { nativeTaskError } from './egdesk-task-native-store.mjs'

const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const FILE_NAME = 'task-sources.json'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function validRecord(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && value[0].startsWith('task-source-') &&
    value[1] && typeof value[1] === 'object' && !Array.isArray(value[1]) &&
    Object.keys(value[1]).every(key => ['boardId', 'owner', 'message', 'cwd'].includes(key)) &&
    typeof value[1].boardId === 'string' && typeof value[1].owner === 'string' && typeof value[1].message === 'string' &&
    (value[1].cwd === undefined || typeof value[1].cwd === 'string')
}

/**
 * What a graph task actually asks the Agent to do. A task graph carries only an
 * opaque sourceRef; the text and folder live here, bound to the Board and the
 * signed-in owner (already hashed by the caller) that registered them. The
 * native task adapter resolves sourceRef through resolve() at admission, start
 * and reconciliation, so a graph recovered after a bridge restart can still be
 * reconciled. With a directory the sources persist in one private (0600) file
 * beside the task journal; the oldest are dropped past the bounds.
 *
 * openTaskSourceRegistry({ directory?, getOwnerKey }) -> { register, resolve, stats }
 */
export async function openTaskSourceRegistry({ directory = null, getOwnerKey, maxSources = 512, maxTotalChars = 4 * 1024 * 1024, makeId = randomUUID } = {}) {
  if (typeof getOwnerKey !== 'function') throw new TypeError('getOwnerKey is required')
  const sources = new Map()
  let totalChars = 0
  let file = null
  let writeTail = Promise.resolve()

  if (directory !== null) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory === path.parse(directory).root) throw new TypeError('A dedicated absolute task-source directory is required')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw new TypeError('Task-source directory must be private and owned by this user')
    }
    file = path.join(directory, FILE_NAME)
    let bytes = null
    try { bytes = await fs.readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (bytes !== null) {
      let envelope
      try { envelope = JSON.parse(bytes) } catch { envelope = null }
      if (envelope?.version !== 1 || !Array.isArray(envelope.sources) || envelope.digest !== digest(envelope.sources) || !envelope.sources.every(validRecord)) {
        throw Object.assign(new Error('Task source file failed its version or checksum check'), { code: 'E_TASK_SOURCES_CORRUPT' })
      }
      for (const [sourceRef, record] of envelope.sources) { sources.set(sourceRef, record); totalChars += record.message.length }
    }
  }

  async function persist() {
    if (!file) return
    const snapshot = [...sources]
    const work = writeTail.then(async () => {
      const temporary = path.join(directory, `.task-sources-${randomUUID()}.tmp`)
      let handle
      try {
        handle = await fs.open(temporary, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ version: 1, digest: digest(snapshot), sources: snapshot }))
        await handle.sync()
        await handle.close()
        handle = null
        await fs.rename(temporary, file)
      } finally {
        if (handle) await handle.close()
        await fs.unlink(temporary).catch(() => {})
      }
    })
    writeTail = work.catch(() => {})
    return work
  }

  const currentOwner = () => {
    const owner = getOwnerKey()
    if (typeof owner !== 'string' || !owner) throw nativeTaskError('TASK_AUTHORITY', 'Sign in to prepare Agent tasks', 403)
    return owner
  }

  async function register({ boardId, message, cwd } = {}) {
    if (typeof boardId !== 'string' || boardId.length > 256 || !BOARD_ID.test(boardId)) throw nativeTaskError('TASK_SOURCE_INPUT', 'boardId must be an opaque ID', 400)
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_TEXT) throw nativeTaskError('TASK_SOURCE_INPUT', `message must be 1-${MAX_TEXT} characters`, 400)
    try { validateChatCwd({ cwd }) } catch { throw nativeTaskError('TASK_SOURCE_INPUT', 'cwd must be an absolute local path', 400) }
    const owner = currentOwner()
    while (sources.size && (sources.size >= maxSources || totalChars + message.length > maxTotalChars)) {
      const [oldest, record] = sources.entries().next().value
      sources.delete(oldest)
      totalChars -= record.message.length
    }
    const sourceRef = `task-source-${makeId()}`
    sources.set(sourceRef, { boardId, owner, message, ...(cwd === undefined ? {} : { cwd }) })
    totalChars += message.length
    try { await persist() } catch (error) {
      sources.delete(sourceRef)
      totalChars -= message.length
      throw nativeTaskError('TASK_SOURCE_STORAGE', 'Task source could not be saved', 503)
    }
    return { sourceRef }
  }

  // Side-effect-free: verifies Board and owner, returns only adapter INPUT fields.
  function resolve(context = {}) {
    const source = sources.get(context?.binding?.sourceRef)
    if (!source || source.boardId !== context.boardId || source.owner !== currentOwner()) {
      throw nativeTaskError('TASK_INPUT_UNRESOLVED', 'Task input is unavailable for this Board or account', 403)
    }
    return { message: source.message, ...(source.cwd === undefined ? {} : { cwd: source.cwd }) }
  }

  return { register, resolve, stats: () => ({ sources: sources.size, maxSources }) }
}

/** POST /task-sources {boardId, message, cwd?} -> 201 {sourceRef}. Loopback + Origin guarded, signed-in only. */
export function createTaskSourceHttpHandler({ sources, ensureAuth, port = 39218 }) {
  if (typeof ensureAuth !== 'function') throw new TypeError('ensureAuth is required')
  return async (req, res, parsedUrl = null) => {
    let url
    try { url = parsedUrl || new URL(req.url, `http://127.0.0.1:${port}`) } catch { return false }
    if (url.pathname !== '/task-sources') return false
    if (!guardBridgeRequest(req, port)) {
      sendJson(res, 403, { code: 'TASK_LOOPBACK_REQUIRED', error: 'Untrusted task request origin' })
      return true
    }
    setBridgeCors(req, res)
    try {
      if (req.method !== 'POST') throw nativeTaskError('TASK_ROUTE_NOT_FOUND', 'Use POST', 405)
      const body = await readJsonBody(req, { maxBytes: 128 * 1024 })
      if (Object.keys(body).some(key => !['boardId', 'message', 'cwd'].includes(key))) throw nativeTaskError('TASK_SOURCE_INPUT', 'Invalid task source fields', 400)
      await ensureAuth()
      sendJson(res, 201, await sources.register(body))
    } catch (error) {
      const status = Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? error.httpStatus : 500
      sendJson(res, status, { code: typeof error?.code === 'string' ? error.code : 'TASK_SOURCE_ERROR', error: status === 500 ? 'Task source could not be prepared' : error.message })
    }
    return true
  }
}
