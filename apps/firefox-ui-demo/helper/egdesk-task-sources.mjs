import { createHash, randomUUID } from 'node:crypto'
import { guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'
import { MAX_TEXT, publicText, validateChatCwd } from './codex-chat-values.mjs'
import { MAX_GATE_ANSWER_CHARS } from './egdesk-task-graph.mjs'
import { nativeTaskError } from './egdesk-task-native-store.mjs'
import { openWorkflowStore, readLegacyFile } from './egdesk-workflow-store.mjs'

const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
const LEGACY_FILE = 'task-sources.json'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function validRecord(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && value[0].startsWith('task-source-') &&
    validSource(value[1])
}
function validSource(value) {
  return plainObject(value) &&
    Object.keys(value).every(key => ['boardId', 'owner', 'message', 'cwd'].includes(key)) &&
    typeof value.boardId === 'string' && typeof value.owner === 'string' && typeof value.message === 'string' &&
    (value.cwd === undefined || typeof value.cwd === 'string')
}
function validAnswer(value) {
  const keys = ['graphId', 'taskId', 'gateId', 'boardId', 'owner', 'text']
  return plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => typeof value[key] === 'string')
}

// Luhn check for a run of 13-19 digits (spaces or dashes allowed between them).
function looksLikeCardNumber(text) {
  for (const match of text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = match[0].replace(/[ -]/g, '')
    let sum = 0
    for (let index = 0; index < digits.length; index += 1) {
      let value = Number(digits[digits.length - 1 - index])
      if (index % 2 === 1) { value *= 2; if (value > 9) value -= 9 }
      sum += value
    }
    if (sum % 10 === 0) return true
  }
  return false
}

/**
 * True when written text looks like a password, key, token, card or resident
 * registration number. A gate answer like that is refused, never stored: the
 * same credential patterns publicText redacts, plus cloud keys, long opaque
 * tokens, card numbers (Luhn) and Korean resident registration numbers. It
 * leans toward refusing; 대표님 can rephrase without the value.
 */
export function looksSecret(text) {
  if (typeof text !== 'string' || !text) return false
  if (publicText(text, text.length + 64) !== text) return true
  return /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/.test(text) ||
    /\bAIza[0-9A-Za-z_-]{30,}/.test(text) ||
    /\bsk-ant-[A-Za-z0-9_-]+/.test(text) ||
    /(?:비밀번호|패스워드|비번|암호|인증번호|(?<![A-Za-z])(?:password|passwd|passcode|pwd|pw|pin|otp))\s*[:=]\s*\S+/i.test(text) ||
    /(?<![0-9])\d{6}-?[1-4]\d{6}(?![0-9])/.test(text) ||
    (text.match(/[A-Za-z0-9_+=-]{32,}/g) ?? []).some(run => /\d/.test(run) && /[A-Za-z]/.test(run)) ||
    looksLikeCardNumber(text)
}

/**
 * What a graph task actually asks the Agent to do. A task graph carries only an
 * opaque sourceRef; the text and folder live here, bound to the Board and the
 * signed-in owner (already hashed by the caller) that registered them. The
 * native task adapter resolves sourceRef through resolve() at admission, start
 * and reconciliation, so a graph recovered after a bridge restart can still be
 * reconciled. The written answer to a question gate (CHAT-06) lives here too,
 * bound the same way; the graph journal names it by an opaque textRef only.
 *
 * Storage: the workflow SQLite store (egdesk-workflow-store.mjs), one row per
 * source or answer, so registering one never rewrites the others. Without a
 * directory or store everything stays in memory. The oldest are dropped past
 * the bounds. A task-sources.json written before is imported once and left
 * untouched; a corrupt one is reported (E_TASK_SOURCES_CORRUPT) and kept.
 *
 * openTaskSourceRegistry({ directory? | store?, legacyDirectory?, getOwnerKey })
 *   -> { register, resolve, recordAnswer, answerText, stats, close }
 */
export async function openTaskSourceRegistry({ directory = null, store = null, legacyDirectory = null, getOwnerKey, maxSources = 512,
  maxTotalChars = 4 * 1024 * 1024, maxAnswers = 512, makeId = randomUUID } = {}) {
  if (typeof getOwnerKey !== 'function') throw new TypeError('getOwnerKey is required')
  const sources = new Map()
  const answers = new Map()
  let totalChars = 0
  let backing = store
  const own = !store && directory !== null
  if (store && typeof store.records?.insert !== 'function') throw new TypeError('A workflow store is required')

  if (own) {
    try { backing = openWorkflowStore({ directory }) }
    catch (error) { if (error instanceof TypeError) throw new TypeError('Task-source directory must be private and owned by this user'); throw error }
  }
  if (backing) {
    const corrupt = message => Object.assign(new Error(message), { code: 'E_TASK_SOURCES_CORRUPT' })
    try {
      const legacyAt = own ? legacyDirectory ?? directory : legacyDirectory
      if (legacyAt) {
        backing.legacy.importOnce('task-sources', () => {
          const bytes = readLegacyFile(legacyAt, LEGACY_FILE)
          if (bytes === null) return { source: 'none' }
          let envelope
          try { envelope = JSON.parse(bytes) } catch { envelope = null }
          if (envelope?.version !== 1 || !Array.isArray(envelope.sources) || envelope.digest !== digest(envelope.sources) || !envelope.sources.every(validRecord)) {
            throw corrupt('Task source file failed its version or checksum check')
          }
          if (backing.records.count('source') > 0) return { source: 'kept-existing' }
          for (const [sourceRef, record] of envelope.sources) backing.records.insert('source', sourceRef, JSON.stringify(record))
          return { source: LEGACY_FILE, sources: envelope.sources.length, digest: envelope.digest }
        })
      }
      for (const row of backing.records.list('source')) {
        let record = null
        try { record = JSON.parse(row.json) } catch { /* refused below */ }
        if (!row.key.startsWith('task-source-') || !validSource(record)) throw corrupt('A stored task source failed validation')
        sources.set(row.key, record)
        totalChars += record.message.length
      }
      for (const row of backing.records.list('gate-answer')) {
        let record = null
        try { record = JSON.parse(row.json) } catch { /* refused below */ }
        if (!row.key.startsWith('task-answer-') || !validAnswer(record)) throw corrupt('A stored gate answer failed validation')
        answers.set(row.key, record)
      }
    } catch (error) {
      if (own) backing.close()
      throw error
    }
  }

  // L1 c25 (U11): getOwnerKey(boardId) -- a Board that belongs to a plan of a room on an Agent profile answers that room's account; others, the default
  const currentOwner = boardId => {
    const owner = getOwnerKey(boardId)
    if (typeof owner !== 'string' || !owner) throw nativeTaskError('TASK_AUTHORITY', 'Sign in to prepare Agent tasks', 403)
    return owner
  }

  async function register({ boardId, message, cwd } = {}) {
    if (typeof boardId !== 'string' || boardId.length > 256 || !BOARD_ID.test(boardId)) throw nativeTaskError('TASK_SOURCE_INPUT', 'boardId must be an opaque ID', 400)
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_TEXT) throw nativeTaskError('TASK_SOURCE_INPUT', `message must be 1-${MAX_TEXT} characters`, 400)
    try { validateChatCwd({ cwd }) } catch { throw nativeTaskError('TASK_SOURCE_INPUT', 'cwd must be an absolute local path', 400) }
    const owner = currentOwner(boardId)
    const dropped = []
    let chars = totalChars
    for (const [sourceRef, record] of sources) {
      if (sources.size - dropped.length < maxSources && chars + message.length <= maxTotalChars) break
      dropped.push(sourceRef)
      chars -= record.message.length
    }
    const sourceRef = `task-source-${makeId()}`
    const record = { boardId, owner, message, ...(cwd === undefined ? {} : { cwd }) }
    try {
      backing?.transaction(() => {
        for (const old of dropped) backing.records.remove('source', old)
        backing.records.insert('source', sourceRef, JSON.stringify(record))
      })
    } catch {
      throw nativeTaskError('TASK_SOURCE_STORAGE', 'Task source could not be saved', 503)
    }
    for (const old of dropped) sources.delete(old)
    sources.set(sourceRef, record)
    totalChars = chars + message.length
    return { sourceRef }
  }

  // Side-effect-free: verifies Board and owner, returns only adapter INPUT fields.
  function resolve(context = {}) {
    const source = sources.get(context?.binding?.sourceRef)
    if (!source || source.boardId !== context.boardId || source.owner !== currentOwner(context.boardId)) {
      throw nativeTaskError('TASK_INPUT_UNRESOLVED', 'Task input is unavailable for this Board or account', 403)
    }
    return { message: source.message, ...(source.cwd === undefined ? {} : { cwd: source.cwd }) }
  }

  /**
   * Keeps 대표님's written answer to one question gate; returns { textRef } for
   * the graph journal. Text that looks like a secret is refused, never kept.
   */
  async function recordAnswer({ boardId, graphId, taskId, gateId, text } = {}) {
    for (const [name, value] of Object.entries({ boardId, graphId, taskId, gateId })) {
      if (typeof value !== 'string' || !REF.test(value)) throw nativeTaskError('TASK_GATE_ANSWER', `${name} must be an opaque ID`, 400)
    }
    if (typeof text !== 'string' || !text.trim() || Array.from(text).length > MAX_GATE_ANSWER_CHARS) {
      throw nativeTaskError('TASK_GATE_ANSWER', `The answer must be 1-${MAX_GATE_ANSWER_CHARS} characters`, 400)
    }
    if (looksSecret(text)) throw nativeTaskError('TASK_GATE_ANSWER_PRIVATE', 'The answer looks like a password, key or personal number and was not kept', 400)
    const owner = currentOwner(boardId)
    const dropped = [...answers.keys()].slice(0, Math.max(0, answers.size - maxAnswers + 1))
    const textRef = `task-answer-${makeId()}`
    const record = { graphId, taskId, gateId, boardId, owner, text }
    try {
      backing?.transaction(() => {
        for (const old of dropped) backing.records.remove('gate-answer', old)
        backing.records.insert('gate-answer', textRef, JSON.stringify(record))
      })
    } catch {
      throw nativeTaskError('TASK_SOURCE_STORAGE', 'The answer could not be saved', 503)
    }
    for (const old of dropped) answers.delete(old)
    answers.set(textRef, record)
    return { textRef }
  }

  // Side-effect-free: the answer text only for the same gate, Board and owner.
  function answerText({ textRef, graphId, taskId, gateId, boardId } = {}) {
    const answer = answers.get(textRef)
    if (!answer || answer.graphId !== graphId || answer.taskId !== taskId || answer.gateId !== gateId ||
        answer.boardId !== boardId || answer.owner !== currentOwner(boardId)) {
      throw nativeTaskError('TASK_INPUT_UNRESOLVED', 'The answer to this question is unavailable for this Board or account', 403)
    }
    return answer.text
  }

  return {
    register, resolve, recordAnswer, answerText,
    stats: () => ({ sources: sources.size, maxSources, answers: answers.size }),
    close() { if (own) backing.close() },
  }
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
