import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

export const BOARD_AGENT_DRAFT_CONFIG_FILE = 'board-agent-draft-service.json'
// Exact Responses snapshots only: aliases can silently change on the provider.
const ALLOWED_MODELS = new Set(['gpt-4.1-mini-2025-04-14', 'gpt-4.1-nano-2025-04-14'])
const MAX_CONFIG_BYTES = 4096
const isWindows = process.platform === 'win32'
const modeIs = (info, mode) => isWindows || (info.mode & 0o7777n) === mode
const sameObject = (before, after) => before.dev === after.dev && before.ino === after.ino &&
  before.mode === after.mode && before.uid === after.uid
const sameFile = (before, after) => sameObject(before, after) && before.nlink === after.nlink && before.size === after.size &&
  before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
const statOptions = { bigint: true }
const isPrivate = (target, info) => isOwnedAndPrivate(target, {
  isSymbolicLink: () => info.isSymbolicLink(), uid: Number(info.uid), mode: Number(info.mode),
}, 0o077)

function safeAncestors(dataDir) {
  // POSIX: an untrusted owner/group must not be able to swap a safe-looking
  // subtree. A sticky directory such as /tmp permits only trusted owners to
  // remove the trusted entries checked below. Windows uses the existing
  // canonical path and DACL/reparse checks on the private app subtree.
  for (let p = path.dirname(dataDir); p !== path.dirname(p); p = path.dirname(p)) {
    const info = lstatSync(p)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    if (!isWindows && ((info.uid !== 0 && info.uid !== process.getuid()) ||
        ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0))) return false
  }
  return true
}

function readConfig(dataDir) {
  const dir = path.join(dataDir, 'settings')
  const file = path.join(dir, BOARD_AGENT_DRAFT_CONFIG_FILE)
  // Missing is the common case. Do not create anything or launch an ACL check.
  const listed = lstatSync(file, statOptions)
  if (!listed.isFile() || listed.nlink !== 1n || !modeIs(listed, 0o600n) ||
      listed.size <= 0n || listed.size > BigInt(MAX_CONFIG_BYTES)) return null
  if (!safeAncestors(dataDir)) return null
  const root = lstatSync(dataDir, statOptions)
  const parent = lstatSync(dir, statOptions)
  if (!root.isDirectory() || !parent.isDirectory() || !modeIs(parent, 0o700n) ||
      !isPrivate(dataDir, root) || !isPrivate(dir, parent) || !isPrivate(file, listed)) return null

  // O_NONBLOCK also prevents hanging if a POSIX FIFO is substituted before
  // open. Verify the opened descriptor, not just the name checked above.
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  const stable = opened => sameFile(opened, fstatSync(fd, statOptions)) &&
    sameFile(opened, lstatSync(file, statOptions)) &&
    sameObject(root, lstatSync(dataDir, statOptions)) && sameObject(parent, lstatSync(dir, statOptions))
  let text
  try {
    const opened = fstatSync(fd, statOptions)
    if (!sameFile(listed, opened) || !stable(opened)) return null
    const bytes = Buffer.alloc(Number(opened.size))
    for (let read = 0; read < bytes.length;) {
      const count = readSync(fd, bytes, read, bytes.length - read, read)
      if (count === 0) return null
      read += count
    }
    if (!stable(opened)) return null
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally { closeSync(fd) }

  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 ||
      value.version !== 1 || value.provider !== 'openai' || !ALLOWED_MODELS.has(value.model) ||
      typeof value.apiKey !== 'string' || value.apiKey.length < 20 || value.apiKey.length > 512 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(value.apiKey)) return null
  return { apiKey: value.apiKey, model: value.model }
}

// This closure is passed only to the draft transport. Re-read on every use,
// and never retain the last key after a missing/unsafe/rotated file. The
// Decision key is exclusion-only; neither it nor ambient auth is a fallback.
export function createBoardAgentDraftConfigReader({ dataDir, getDecisionApiKey = () => null } = {}) {
  return () => {
    try {
      if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || path.normalize(dataDir) !== dataDir ||
          (isWindows && !/^[A-Za-z]:\\/.test(dataDir))) return null
      const config = readConfig(dataDir)
      return config && config.apiKey !== getDecisionApiKey() ? config : null
    } catch { return null }
  }
}
