// Board project folders (CODE-02, CODE-06; bundle 2-X).
//
// 대표님 결정 2026-10-24:
// - D-X3: a project folder is attached to a Board; its chat rooms inherit it
//   and a room may have its own. A folder is attached only through a
//   privileged picker selection (the HTTP adapter consumes the selectionId and
//   hands this store the verified real path). The real path and dev/ino are
//   kept so that after a restart the folder reconnects by itself only when
//   the folder at that path still has the same dev/ino; otherwise the screen
//   asks the user to pick it again.
// - D-X6: project commands ('테스트·빌드') are the commands the user typed.
//   package.json scripts are offered as suggestions to look at only; nothing
//   here saves or runs a suggestion.
//
// Patterns (pingdotgg/t3code, MIT, Copyright (c) 2026 T3 Tools Inc. — pattern
// only, no code copied): a thread works in its worktree path, else its
// project's workspaceRoot (apps/server/src/project/threadWorkspaceRoot.ts:9-18);
// a project script is {id, name, command, icon} (packages/contracts/src/
// project.ts:22-41) — here `kind` instead of icon.
//
// Field names stay clear of the chat/desk stores' PRIVATE_KEYS. Paths and
// commands are never logged.
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'

export const PROJECT_SCRIPT_KINDS = Object.freeze(['test', 'build', 'lint', 'typecheck', 'run'])
export const PROJECT_LIMITS = Object.freeze({
  maxScripts: 12,
  maxCommandChars: 1000,
  maxNameChars: 60,
  maxTitleChars: 120,
  maxIdChars: 512,
  maxSuggestions: 8,
  maxPackageJsonBytes: 256 * 1024,
})
const SCRIPT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const LINE_BAD = /[\u0000-\u001f\u007f\u2028\u2029]/
const PACKAGE_SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,59}$/

function fail(code, message, httpStatus = 400) {
  throw Object.assign(new Error(message), { code, httpStatus })
}

function opaqueId(value, name) {
  if (typeof value !== 'string' || !value || value.length > PROJECT_LIMITS.maxIdChars || value.includes('\0')) fail('INVALID_PROJECT_REQUEST', `${name} must be an identifier`)
  return value
}

function oneLine(value, name, maximum) {
  if (typeof value !== 'string') fail('INVALID_PROJECT_SCRIPT', `${name} must be text`)
  const text = value.trim()
  if (!text || text.length > maximum || LINE_BAD.test(text)) fail('INVALID_PROJECT_SCRIPT', `${name} must be one line of 1–${maximum} characters`)
  return text
}

function identityOf(identity) {
  if (!identity || typeof identity !== 'object' || !/^\d+$/.test(String(identity.dev)) || !/^\d+$/.test(String(identity.ino))) fail('INVALID_PROJECT_REQUEST', 'Folder identity is required')
  return { dev: String(identity.dev), ino: String(identity.ino) }
}

function kindFor(value, name = '') {
  if (PROJECT_SCRIPT_KINDS.includes(value)) return value
  if (value != null) fail('INVALID_PROJECT_SCRIPT', `Script kind must be one of ${PROJECT_SCRIPT_KINDS.join(', ')}`)
  const lower = String(name).toLowerCase()
  return /test|spec/.test(lower) ? 'test' : /lint/.test(lower) ? 'lint' : /type|tsc/.test(lower) ? 'typecheck' : /build|compile/.test(lower) ? 'build' : 'run'
}

/**
 * Scripts the user typed → stored shape [{id, name, command, kind}].
 * One line each; no NUL/CR/LF (a newline would run a second command).
 */
export function normalizeProjectScripts(scripts) {
  if (!Array.isArray(scripts)) fail('INVALID_PROJECT_SCRIPT', 'Scripts must be a list')
  if (scripts.length > PROJECT_LIMITS.maxScripts) fail('INVALID_PROJECT_SCRIPT', `At most ${PROJECT_LIMITS.maxScripts} commands`)
  const used = new Set()
  return scripts.map((script, index) => {
    if (!script || typeof script !== 'object' || Array.isArray(script) || Object.keys(script).some(key => !['id', 'name', 'command', 'kind'].includes(key))) fail('INVALID_PROJECT_SCRIPT', 'Unexpected script field')
    const name = oneLine(script.name, 'Script name', PROJECT_LIMITS.maxNameChars)
    const command = oneLine(script.command, 'Command', PROJECT_LIMITS.maxCommandChars)
    let id = script.id == null ? `script-${index + 1}` : script.id
    if (typeof id !== 'string' || !SCRIPT_ID.test(id)) fail('INVALID_PROJECT_SCRIPT', 'Script id must be lowercase letters, digits and dashes')
    const base = id.slice(0, 34)
    for (let suffix = index + 1; used.has(id); suffix++) id = `${base}-${suffix}`
    used.add(id)
    return { id, name, command, kind: kindFor(script.kind, name) }
  })
}

/**
 * package.json text → display-only candidates [{name, command, kind, suggested}].
 * Only test/build/lint/typecheck/check-like names; the runner follows the
 * `packageManager` field (npm when absent). Never saved or run from here.
 */
export function suggestProjectScripts(packageJsonText) {
  if (typeof packageJsonText !== 'string' || packageJsonText.length > PROJECT_LIMITS.maxPackageJsonBytes) return []
  let parsed
  try { parsed = JSON.parse(packageJsonText) } catch { return [] }
  const scripts = parsed && typeof parsed === 'object' && parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts) ? parsed.scripts : null
  if (!scripts) return []
  const manager = typeof parsed.packageManager === 'string' ? (/^(pnpm|yarn|bun)@/.exec(parsed.packageManager)?.[1] || 'npm') : 'npm'
  const runner = name => manager === 'yarn' ? `yarn ${name}` : `${manager} run ${name}`
  const wanted = /^(test|tests|check|lint|build|typecheck|type-check|tsc|ci)(:[\w.-]+)?$/i
  const out = []
  for (const name of Object.keys(scripts)) {
    if (out.length >= PROJECT_LIMITS.maxSuggestions) break
    if (!PACKAGE_SCRIPT_NAME.test(name) || !wanted.test(name) || typeof scripts[name] !== 'string') continue
    out.push({ name, command: runner(name), kind: kindFor(null, name), suggested: true })
  }
  return out
}

/** Stored project + current lstat (bigint or number) → reconnect state. */
export function projectReconnectState(project, stat) {
  if (!stat) return 'missing'
  if (!stat.isDirectory?.() || stat.isSymbolicLink?.()) return 'not-a-directory'
  return String(stat.dev) === project.identity.dev && String(stat.ino) === project.identity.ino ? 'connected' : 'identity-changed'
}

function checkedRecord(record) {
  const keys = ['id', 'title', 'workspaceRoot', 'identity', 'scripts', 'createdAt', 'updatedAt']
  if (!record || typeof record !== 'object' || Object.keys(record).some(key => !keys.includes(key)) || typeof record.id !== 'string' || typeof record.workspaceRoot !== 'string' || !path.isAbsolute(record.workspaceRoot)) fail('INVALID_PROJECT_RECORD', 'Stored project is invalid', 500)
  identityOf(record.identity)
  return record
}

/**
 * One SQLite file per local owner (projects-<sha256(owner)>.sqlite, 0600, in
 * a 0700 directory). Tables: projects(id, payload) and bindings(scope 'board'
 * | 'room', key, projectId, boardId).
 */
export async function openEGDeskProjectStore({ directory, ownerScope, now = Date.now, makeId = randomUUID } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof ownerScope !== 'string' || !ownerScope || ownerScope.length > 512) fail('INVALID_STORE_SCOPE', 'Absolute project directory and owner scope are required', 500)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStat = await fs.lstat(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('INVALID_STORE_SCOPE', 'Project directory must not be a symbolic link', 500)
  const databasePath = path.join(directory, `projects-${createHash('sha256').update(ownerScope).digest('hex')}.sqlite`)
  const existing = await fs.lstat(databasePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('INVALID_STORE_SCOPE', 'Project database is not a regular file', 500)
  const created = await fs.open(databasePath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600)
  await created.close()
  await fs.chmod(databasePath, 0o600)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(databasePath)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bindings (scope TEXT NOT NULL CHECK (scope IN ('board','room')), key TEXT NOT NULL, projectId TEXT NOT NULL, boardId TEXT, PRIMARY KEY (scope, key));`)
  const selectProject = db.prepare('SELECT payload FROM projects WHERE id = ?')
  const allProjects = db.prepare('SELECT payload FROM projects ORDER BY id')
  const upsertProject = db.prepare('INSERT INTO projects (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
  const deleteProject = db.prepare('DELETE FROM projects WHERE id = ?')
  const selectBinding = db.prepare('SELECT projectId, boardId FROM bindings WHERE scope = ? AND key = ?')
  const upsertBinding = db.prepare('INSERT INTO bindings (scope, key, projectId, boardId) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET projectId = excluded.projectId, boardId = excluded.boardId')
  const deleteBinding = db.prepare('DELETE FROM bindings WHERE scope = ? AND key = ?')
  const countBindings = db.prepare('SELECT COUNT(*) AS count FROM bindings WHERE projectId = ?')
  let closed = false
  const ensureOpen = () => { if (closed) fail('STORE_CLOSED', 'Project store is closed', 503) }
  const read = id => { const row = selectProject.get(id); return row ? checkedRecord(JSON.parse(row.payload)) : null }
  const write = record => { upsertProject.run(record.id, JSON.stringify(checkedRecord(record))); return structuredClone(record) }
  const dropIfUnused = id => { if (id && countBindings.get(id).count === 0) deleteProject.run(id) }
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = work(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }

  function bind(scope, key, boardId, { workspaceRoot, identity, title }) {
    ensureOpen()
    opaqueId(key, scope === 'board' ? 'boardId' : 'roomId')
    if (boardId != null) opaqueId(boardId, 'boardId')
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || workspaceRoot.length > 4096 || workspaceRoot.includes('\0')) fail('INVALID_PROJECT_REQUEST', 'A verified absolute folder is required')
    const folder = identityOf(identity)
    const name = title == null || title === '' ? path.basename(workspaceRoot) || workspaceRoot : oneLine(title, 'Project title', PROJECT_LIMITS.maxTitleChars)
    return transaction(() => {
      const previous = selectBinding.get(scope, key)
      const previousRecord = previous ? read(previous.projectId) : null
      let record
      if (previousRecord && previousRecord.workspaceRoot === workspaceRoot) {
        // Same folder picked again (e.g. after reconnect-required): keep the
        // project and its commands, take the new identity.
        record = { ...previousRecord, identity: folder, title: name, updatedAt: now() }
      } else {
        const shared = allProjects.all().map(row => checkedRecord(JSON.parse(row.payload)))
          .find(item => item.workspaceRoot === workspaceRoot && item.identity.dev === folder.dev && item.identity.ino === folder.ino)
        record = shared ? { ...shared, updatedAt: now() } : { id: makeId(), title: name, workspaceRoot, identity: folder, scripts: [], createdAt: now(), updatedAt: now() }
      }
      write(record)
      upsertBinding.run(scope, key, record.id, boardId ?? null)
      if (previousRecord && previousRecord.id !== record.id) dropIfUnused(previousRecord.id)
      return structuredClone(record)
    })
  }

  function unbind(scope, key) {
    ensureOpen()
    opaqueId(key, scope === 'board' ? 'boardId' : 'roomId')
    return transaction(() => {
      const previous = selectBinding.get(scope, key)
      if (!previous) return false
      deleteBinding.run(scope, key)
      dropIfUnused(previous.projectId)
      return true
    })
  }

  function forScope(scope, key) {
    ensureOpen()
    if (key == null) return null
    opaqueId(key, scope === 'board' ? 'boardId' : 'roomId')
    const binding = selectBinding.get(scope, key)
    return binding ? read(binding.projectId) : null
  }

  return {
    attachToBoard: ({ boardId, ...folder }) => bind('board', boardId, null, folder),
    attachToRoom: ({ roomId, boardId = null, ...folder }) => bind('room', roomId, boardId, folder),
    detachBoard: ({ boardId }) => unbind('board', boardId),
    inheritRoom: ({ roomId }) => unbind('room', roomId),
    get(projectId) { ensureOpen(); opaqueId(projectId, 'projectId'); return read(projectId) },
    forBoard: boardId => forScope('board', boardId),
    forRoom: roomId => forScope('room', roomId),
    // A room's own project wins; otherwise the Board's (t3code
    // threadWorkspaceRoot order: worktree, then project root).
    effective({ boardId = null, roomId = null } = {}) {
      const room = roomId == null ? null : forScope('room', roomId)
      if (room) return { project: room, source: 'room' }
      const board = boardId == null ? null : forScope('board', boardId)
      return board ? { project: board, source: 'board' } : { project: null, source: null }
    },
    setScripts({ projectId, scripts }) {
      ensureOpen(); opaqueId(projectId, 'projectId')
      const normalized = normalizeProjectScripts(scripts)
      return transaction(() => {
        const record = read(projectId)
        if (!record) fail('UNKNOWN_PROJECT', 'Project is not attached', 404)
        return write({ ...record, scripts: normalized, updatedAt: now() })
      })
    },
    list() { ensureOpen(); return allProjects.all().map(row => checkedRecord(JSON.parse(row.payload))) },
    close() { if (!closed) { closed = true; db.close() } },
  }
}
