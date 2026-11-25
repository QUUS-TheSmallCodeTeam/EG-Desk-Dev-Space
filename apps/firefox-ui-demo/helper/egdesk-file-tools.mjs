import { createHash, randomBytes } from 'node:crypto'
import { ownEditFact } from './egdesk-own-edit-evidence.mjs' // c30b
import fs from 'node:fs/promises'
import path from 'node:path'
import { noFolderBody } from './egdesk-no-folder.mjs'

// EG-Desk's own file tools (c18 prototype, flag default off): read, search and edit, offered to the engine as dynamic tools, so that
// with the pure-engine switch (egdesk-command-executor.mjs pureEngineThreadOverrides) every file the model reads or changes goes
// through EG-Desk. Safety checks follow the patterns of OpenCode's tools (anomalyco/opencode, packages/core/src/tool/): a NUL byte
// in the first bytes means binary (read-filesystem.ts:148), long lines are cut (MAX_LINE_LENGTH 2000, :18), paging by offset/limit
// (plugin/read.ts); an edit refuses an empty or identical oldString and a non-unique match without replaceAll (plugin/edit.ts:288-322),
// a patch is parsed and verified before anything is written (plugin/patch.ts:83-100), and a preview goes to the permission check
// before the write (edit.ts:332). Only the patterns are used; no code was copied.
//
// Identity: the same model as the command tool. A target is an exact path inside the folder EG-Desk resolved for this run
// (workspaceOf(run)), checked again on its real path (no symlink escape); the approval ledger keys by conversation, turn and the exact
// edit (path and the new content's hash). Nothing reads an engine profile, a subscription account, CODEX_HOME or a screen.
//
// What asks the person (R5, code only, R3): deleting a file, or replacing a whole existing file, that is not generated. Generated =
// ignored by git and not tracked (inspect facts, the same interface as the terminal gate's). Unknown facts count as not generated.
// Creating a new file and a targeted edit (exact string or a diff hunk of an existing file) do not ask: they are shown as a diff, and
// the rest of the file stays. Reads and searches never ask.
//
// Undo (c19): every edit that wrote something leaves one record (the file before it, the hash after it), kept with the run and its
// conversation, bounded per conversation (UNDO_LIMITS). One record undoes one edit, newest first unless an editId is named, and only
// while the file still is what that edit left (otherwise 'undo_conflict': a later change is never overwritten). Undo never asks: it
// puts back what EG-Desk itself replaced.
export const FILE_TOOLS_PROVIDER_ID = 'egdesk-files' // provisional
export const FILE_TOOL_NAMES = Object.freeze({ read: 'egdesk_read_file', search: 'egdesk_search_files', edit: 'egdesk_edit_file', undo: 'egdesk_undo_edit' }) // model-facing
export const UNDO_LIMITS = Object.freeze({ records: 50, bytes: 8 * 1024 * 1024 })
export const FILE_TOOL_LIMITS = Object.freeze({ readBytes: 256 * 1024, fileBytes: 8 * 1024 * 1024, lineChars: 2000, lines: 400, maxLines: 2000, binaryHead: 3 * 1024,
  searchFiles: 2000, searchFileBytes: 1024 * 1024, searchMatches: 200, patternChars: 200, searchMs: 2000, editBytes: 1024 * 1024, previewBytes: 64 * 1024 })
// Never read or edited: secrets stores. Never edited: version-control and engine/agent internals (Codex's own protected list, plus .egdesk).
const SECRET_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg'])
const PROTECTED_SEGMENTS = new Set(['.git', '.codex', '.agents', '.egdesk', ...SECRET_SEGMENTS])
const SKIP_DIRS = new Set(['.git', 'node_modules', ...SECRET_SEGMENTS])

export const FILE_TOOL_SPECS = Object.freeze([
  Object.freeze({ type: 'function', name: FILE_TOOL_NAMES.read, description: 'Read a text file of this conversation\'s folder, in pages of lines. A binary file is described, not dumped.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', description: 'Path relative to the conversation folder.' },
      offset: { type: 'integer', minimum: 1, description: 'First line (1-based).' }, limit: { type: 'integer', minimum: 1, maximum: FILE_TOOL_LIMITS.maxLines } } } }),
  Object.freeze({ type: 'function', name: FILE_TOOL_NAMES.search, description: 'Search the text files of this conversation\'s folder for a string (or a short regular expression).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['pattern'], properties: {
      pattern: { type: 'string' }, regex: { type: 'boolean' }, path: { type: 'string', description: 'Optional folder to search, relative to the conversation folder.' } } } }),
  Object.freeze({ type: 'function', name: FILE_TOOL_NAMES.edit, description: 'Change one file of this conversation\'s folder: replace an exact string, apply a unified diff, write a whole file, or delete it. dryRun shows the diff without writing. Deleting or replacing a whole file a person keeps asks the person first; then call again with exactly the same edit.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'mode'], properties: {
      path: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'diff', 'write', 'delete'] },
      oldString: { type: 'string' }, newString: { type: 'string' }, replaceAll: { type: 'boolean' },
      diff: { type: 'string', description: 'mode diff: a unified diff of this one file (@@ hunks).' }, content: { type: 'string', description: 'mode write: the whole new content.' },
      expectedSha256: { type: 'string', description: 'Optional: refuse when the file changed since you read it.' }, dryRun: { type: 'boolean' } } } }),
  Object.freeze({ type: 'function', name: FILE_TOOL_NAMES.undo, description: 'Undo one earlier edit of this conversation (the newest, or the one named by editId), if the file has not changed since.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { editId: { type: 'string' } } } }),
])

const respond = (success, value) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] })
const sha256 = data => createHash('sha256').update(data).digest('hex')
const refused = code => respond(true, { status: 'refused', code })
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`)

/** Resolve a path for this run: inside the folder, no protected segment, and the real path (symlinks followed) still inside. */
export async function resolveTarget(root, relative, { write = false } = {}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.length > 4096) return { error: 'FILE_PATH_INVALID' }
  const realRoot = await fs.realpath(root)
  const target = path.resolve(realRoot, relative)
  if (!inside(realRoot, target)) return { error: 'FILE_OUTSIDE_FOLDER' }
  const segments = path.relative(realRoot, target).split(path.sep)
  if (segments.some(segment => SECRET_SEGMENTS.has(segment)) || (write && segments.some(segment => PROTECTED_SEGMENTS.has(segment)))) return { error: 'FILE_PROTECTED' }
  // the nearest existing ancestor (or the target) must really be inside the folder: a symlinked file or folder cannot lead out
  let probe = target
  for (;;) {
    try { const real = await fs.realpath(probe); if (!inside(realRoot, real)) return { error: 'FILE_SYMLINK_ESCAPE' }; break }
    catch (error) { if (error?.code !== 'ENOENT' || probe === realRoot) return { error: 'FILE_UNREADABLE' }; probe = path.dirname(probe) }
  }
  let stat = null
  try { stat = await fs.lstat(target) } catch { stat = null }
  if (stat?.isSymbolicLink() && write) return { error: 'FILE_SYMLINK' } // never write through a link, even one that stays inside
  return { root: realRoot, target, relative: path.relative(realRoot, target), stat }
}

const isBinary = buffer => buffer.subarray(0, 8192).includes(0)
const cutLine = (line, max) => (line.length > max ? `${line.slice(0, max)}… (line cut at ${max} chars)` : line)

/** A bounded unified diff of two texts: common head and tail kept, the changed middle as one hunk (enough for a preview). */
export function previewDiff(relative, before, after, maxBytes = FILE_TOOL_LIMITS.previewBytes) {
  const a = before === null ? [] : before.split('\n'), b = after === null ? [] : after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const ctx = 3, from = Math.max(0, start - ctx), toA = Math.min(a.length, endA + ctx), toB = Math.min(b.length, endB + ctx)
  const lines = [`--- ${before === null ? '/dev/null' : `a/${relative}`}`, `+++ ${after === null ? '/dev/null' : `b/${relative}`}`,
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
    ...a.slice(from, start).map(l => ` ${l}`), ...a.slice(start, endA).map(l => `-${l}`), ...b.slice(start, endB).map(l => `+${l}`), ...a.slice(endA, toA).map(l => ` ${l}`)]
  const text = lines.join('\n')
  return Buffer.byteLength(text) > maxBytes ? { diff: text.slice(0, maxBytes), truncated: true } : { diff: text, truncated: false }
}

/** Apply a unified diff of one file strictly: every hunk's old lines (context and removed) must appear exactly once. */
export function applyUnifiedDiff(source, diff) {
  const lines = String(diff).replace(/\r\n/g, '\n').split('\n')
  let i = 0, deleteFile = false, createFile = false
  const hunks = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('--- ')) { if (line.slice(4).trim() === '/dev/null') createFile = true; continue }
    if (line.startsWith('+++ ')) { if (line.slice(4).trim() === '/dev/null') deleteFile = true; continue }
    if (line.startsWith('@@')) {
      if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) return { error: 'DIFF_INVALID' }
      const hunk = { old: [], next: [] }
      for (i++; i < lines.length && !lines[i].startsWith('@@'); i++) {
        const l = lines[i]
        if (l === '\\ No newline at end of file') continue
        if (l === '' && i === lines.length - 1) continue
        const mark = l[0], body = l.slice(1)
        if (mark === ' ') { hunk.old.push(body); hunk.next.push(body) }
        else if (mark === '-') hunk.old.push(body)
        else if (mark === '+') hunk.next.push(body)
        else if (l === '') { hunk.old.push(''); hunk.next.push('') }
        else return { error: 'DIFF_INVALID' }
      }
      i--
      hunks.push(hunk)
    }
  }
  if (deleteFile) return { deleteFile: true }
  if (!hunks.length) return { error: 'DIFF_EMPTY' }
  let text = createFile ? '' : source
  if (text === null) return { error: 'FILE_NOT_FOUND' }
  for (const hunk of hunks) {
    const oldBlock = hunk.old.join('\n'), newBlock = hunk.next.join('\n')
    if (createFile && !hunk.old.length) { text = newBlock + (newBlock.endsWith('\n') ? '' : '\n'); continue }
    const first = text.indexOf(oldBlock)
    if (first < 0) return { error: 'DIFF_NO_MATCH' }
    if (text.indexOf(oldBlock, first + 1) >= 0) return { error: 'DIFF_AMBIGUOUS' }
    text = text.slice(0, first) + newBlock + text.slice(first + oldBlock.length)
  }
  return { text, createFile }
}

/**
 * createFileToolsProvider({ mode, ledger, workspaceOf, inspect?, onFileChange?, limits? })
 *   inspect({ cwd, paths }) → { targets: { [abs]: { exists, trackedFiles, ignored } }, git } (the terminal gate's interface), or absent
 */
export function createFileToolsProvider({ mode = () => 'off', ledger = null, workspaceOf = () => null, inspect = null, onFileChange = () => {}, onEdit = () => {}, limits = {} } = {}) {
  const L = { ...FILE_TOOL_LIMITS, ...limits }
  const on = () => { try { return mode() === 'on' } catch { return false } }
  const calls = new Map()
  const undo = new Map() // conversationId → [{ editId, runKey, root, relative, kind, before, afterSha, bytes }] newest last
  let editSeq = 0
  const remember = (run, record) => {
    const key = run?.conversationId ?? run?.answerId ?? ''
    const list = undo.get(key) ?? []
    list.push(record)
    let bytes = list.reduce((sum, r) => sum + r.bytes, 0)
    while (list.length > UNDO_LIMITS.records || (bytes > UNDO_LIMITS.bytes && list.length > 1)) bytes -= list.shift().bytes
    if (bytes > UNDO_LIMITS.bytes) list.length = 0 // one edit larger than the whole budget keeps no record
    undo.set(key, list)
    while (undo.size > 64) undo.delete(undo.keys().next().value)
  }
  const rootOf = run => { try { const root = workspaceOf(run); return typeof root === 'string' && path.isAbsolute(root) ? root : null } catch { return null } }
  const generated = async (root, target) => {
    if (typeof inspect !== 'function') return false
    try { const facts = await inspect({ cwd: root, paths: [target] }); const t = facts?.targets?.[target]; return t?.ignored === true && t?.trackedFiles === 0 } catch { return false }
  }
  const factsReason = async (root, target) => {
    if (typeof inspect !== 'function') return 'unresolved_target'
    try { const t = (await inspect({ cwd: root, paths: [target] }))?.targets?.[target]; return !t ? 'unresolved_target' : t.trackedFiles > 0 ? 'tracked_files' : 'deletes_untracked' } catch { return 'unresolved_target' }
  }
  return {
    providerId: FILE_TOOLS_PROVIDER_ID,
    runtime: null,
    specs() { return on() ? FILE_TOOL_SPECS : [] },
    dispatch(run, event) {
      const key = `${run?.answerId ?? run?.runId ?? ''}/${event?.callId ?? ''}`
      if (event?.callId && calls.has(key)) return calls.get(key)
      // c30b: what an edit tool call did, as facts from its own response (helper/egdesk-own-edit-evidence.mjs), for the check of the run's answer; advisory
      const work = this.handle(run, event).catch(() => respond(false, { error: { code: 'FILE_TOOL_FAILED' } })).then(response => { try { const fact = ownEditFact(event?.tool, response); if (fact) onEdit(run, fact) } catch { /* advisory */ } return response })
      if (event?.callId) { calls.set(key, work); while (calls.size > 256) calls.delete(calls.keys().next().value) }
      return work
    },
    async handle(run, event) {
      const name = event?.tool
      if (event?.namespace || !Object.values(FILE_TOOL_NAMES).includes(name)) return respond(false, { error: { code: 'FILE_TOOL_UNKNOWN' } })
      if (!on()) return respond(false, { error: { code: 'FILE_TOOLS_OFF' } })
      if (run?.executionPolicy && (name === FILE_TOOL_NAMES.edit || name === FILE_TOOL_NAMES.undo)) return respond(false, { error: { code: 'FILE_EDIT_FORBIDDEN' } })
      const root = rootOf(run)
      if (!root) return respond(true, noFolderBody('FILE_NO_FOLDER'))
      const args = event.arguments && typeof event.arguments === 'object' ? event.arguments : {}
      if (name === FILE_TOOL_NAMES.read) return this.read(root, args)
      if (name === FILE_TOOL_NAMES.search) return this.search(root, args)
      if (name === FILE_TOOL_NAMES.undo) return this.undo(run, typeof args.editId === 'string' ? args.editId : null)
      return this.edit(run, root, args)
    },
    async read(root, args) {
      const r = await resolveTarget(root, args.path)
      if (r.error) return refused(r.error)
      if (!r.stat) return refused('FILE_NOT_FOUND')
      // a link that stays inside the folder (checked by resolveTarget) is read as its target
      const st = await fs.stat(r.target)
      if (!st.isFile()) return refused('FILE_NOT_A_FILE')
      if (st.size > L.fileBytes) return respond(true, { status: 'too_large', size: st.size, limit: L.fileBytes })
      const buffer = await fs.readFile(r.target)
      if (isBinary(buffer)) return respond(true, { status: 'binary', path: r.relative, size: buffer.length, sha256: sha256(buffer), headBase64: buffer.subarray(0, L.binaryHead).toString('base64') })
      const lines = buffer.toString('utf8').split('\n')
      const offset = Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 1
      const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, L.maxLines) : L.lines
      const out = []
      let bytes = 0, end = offset - 1
      for (let n = offset - 1; n < lines.length && out.length < limit; n++) {
        const line = `${n + 1}: ${cutLine(lines[n], L.lineChars)}`
        bytes += Buffer.byteLength(line) + 1
        if (bytes > L.readBytes) break
        out.push(line); end = n + 1
      }
      return respond(true, { status: 'read', path: r.relative, sha256: sha256(buffer), totalLines: lines.length, startLine: offset, content: out.join('\n'),
        ...(end < lines.length ? { next: end + 1 } : {}) })
    },
    async search(root, args) {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (!pattern || pattern.length > L.patternChars) return refused('SEARCH_PATTERN_INVALID')
      let test
      if (args.regex === true) { try { const re = new RegExp(pattern); test = line => re.test(line) } catch { return refused('SEARCH_PATTERN_INVALID') } }
      else test = line => line.includes(pattern)
      const start = await resolveTarget(root, typeof args.path === 'string' && args.path ? args.path : '.')
      if (start.error) return refused(start.error)
      const began = Date.now(), matches = []
      let files = 0, stoppedBy = null
      const walk = async dir => {
        let entries
        try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
        entries.sort((x, y) => x.name.localeCompare(y.name))
        for (const entry of entries) {
          if (stoppedBy) return
          if (Date.now() - began > L.searchMs) { stoppedBy = 'time'; return }
          const full = path.join(dir, entry.name)
          if (entry.isSymbolicLink()) continue // never follow links while searching
          if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(full); continue }
          if (!entry.isFile()) continue
          if (++files > L.searchFiles) { stoppedBy = 'files'; return }
          let buffer
          try { const st = await fs.stat(full); if (st.size > L.searchFileBytes) continue; buffer = await fs.readFile(full) } catch { continue }
          if (isBinary(buffer)) continue
          const lines = buffer.toString('utf8').split('\n')
          for (let n = 0; n < lines.length; n++) {
            const line = lines[n].length > L.lineChars ? lines[n].slice(0, L.lineChars) : lines[n]
            if (test(line)) { matches.push({ path: path.relative(start.root, full), line: n + 1, text: line }); if (matches.length >= L.searchMatches) { stoppedBy = 'matches'; return } }
          }
        }
      }
      if (start.stat?.isDirectory()) await walk(start.target)
      else return refused('SEARCH_PATH_NOT_A_FOLDER')
      return respond(true, { status: 'searched', matches, filesScanned: Math.min(files, L.searchFiles), ...(stoppedBy ? { stoppedBy } : {}) })
    },
    async edit(run, root, args) {
      const r = await resolveTarget(root, args.path, { write: true })
      if (r.error) return refused(r.error)
      if (r.stat && !r.stat.isFile()) return refused('FILE_NOT_A_FILE')
      let before = null
      if (r.stat) {
        if (r.stat.size > L.editBytes) return refused('FILE_TOO_LARGE_TO_EDIT')
        const buffer = await fs.readFile(r.target)
        if (isBinary(buffer)) return refused('FILE_BINARY')
        before = buffer.toString('utf8')
        if (typeof args.expectedSha256 === 'string' && args.expectedSha256 !== sha256(buffer)) return respond(true, { status: 'stale', code: 'FILE_CHANGED_SINCE_READ', sha256: sha256(buffer) })
      }
      let after, kind
      switch (args.mode) {
        case 'replace': {
          if (before === null) return refused('FILE_NOT_FOUND')
          const oldString = typeof args.oldString === 'string' ? args.oldString : '', newString = typeof args.newString === 'string' ? args.newString : null
          if (!oldString || newString === null) return refused('EDIT_STRINGS_INVALID')
          if (oldString === newString) return refused('EDIT_NO_CHANGE')
          const first = before.indexOf(oldString)
          if (first < 0) return refused('EDIT_NO_MATCH')
          if (args.replaceAll !== true && before.indexOf(oldString, first + 1) >= 0) return refused('EDIT_AMBIGUOUS')
          after = args.replaceAll === true ? before.split(oldString).join(newString) : before.slice(0, first) + newString + before.slice(first + oldString.length)
          kind = 'update'; break
        }
        case 'diff': {
          const applied = applyUnifiedDiff(before, args.diff)
          if (applied.error) return refused(applied.error)
          if (applied.deleteFile) { if (before === null) return refused('FILE_NOT_FOUND'); after = null; kind = 'delete' }
          else { if (applied.createFile && before !== null) return refused('FILE_EXISTS'); after = applied.text; kind = before === null ? 'create' : 'update' }
          break
        }
        case 'write':
          if (typeof args.content !== 'string') return refused('EDIT_CONTENT_INVALID')
          after = args.content; kind = before === null ? 'create' : 'overwrite'; break
        case 'delete':
          if (before === null) return refused('FILE_NOT_FOUND')
          after = null; kind = 'delete'; break
        default: return refused('EDIT_MODE_INVALID')
      }
      if (after !== null && Buffer.byteLength(after) > L.editBytes) return refused('EDIT_TOO_LARGE')
      const preview = previewDiff(r.relative, before, after)
      // deleting or replacing a whole file that is not generated goes to the approval ledger (code reasons; one-time approval)
      const asks = (kind === 'delete' || kind === 'overwrite') && !(await generated(r.root, r.target))
      if (args.dryRun === true) return respond(true, { status: 'preview', kind, path: r.relative, ...preview, needsPerson: asks })
      if (asks) {
        if (!ledger?.check) return respond(false, { error: { code: 'FILE_GATE_UNAVAILABLE' } })
        const decision = await ledger.check({ sessionId: run.conversationId, turnId: run.runId, cwd: r.root, command: `${kind} file ${r.relative}`,
          floor: [await factsReason(r.root, r.target)], identity: `${kind}:${after === null ? 'none' : sha256(after)}` })
        if (decision?.decision === 'deny') {
          let gate = null
          try { gate = JSON.parse(decision.note).egdesk_command_gate } catch { gate = { status: 'needs_person' } }
          return respond(true, { ...gate, kind, path: r.relative, ...preview, written: false })
        }
        if (decision?.decision !== 'allow' && decision?.decision !== 'none') return respond(false, { error: { code: 'FILE_GATE_UNAVAILABLE' } })
      }
      if (after === null) await fs.unlink(r.target)
      else {
        await fs.mkdir(path.dirname(r.target), { recursive: true })
        const temp = path.join(path.dirname(r.target), `.egdesk-write-${randomBytes(6).toString('hex')}`)
        await fs.writeFile(temp, after, { mode: r.stat ? r.stat.mode & 0o7777 : 0o644, flag: 'wx' })
        await fs.rename(temp, r.target) // atomic within the folder
      }
      try { onFileChange(run, { path: r.relative, kind, diff: preview.diff }) } catch { /* the screen's change view is advisory */ }
      const editId = `edit-${++editSeq}`
      remember(run, { editId, runKey: run?.answerId ?? null, root: r.root, relative: r.relative, kind, before, afterSha: after === null ? null : sha256(after),
        bytes: before === null ? 0 : Buffer.byteLength(before) })
      return respond(true, { status: 'edited', editId, kind, path: r.relative, ...(after === null ? {} : { sha256: sha256(after) }), ...preview })
    },
    /** The undo records of a run's conversation (newest last), without file contents. */
    undoRecords(run) { return (undo.get(run?.conversationId ?? run?.answerId ?? '') ?? []).map(r => ({ editId: r.editId, runKey: r.runKey, path: r.relative, kind: r.kind })) },
    async undo(run, editId = null) {
      if (!on()) return respond(false, { error: { code: 'FILE_TOOLS_OFF' } })
      const list = undo.get(run?.conversationId ?? run?.answerId ?? '') ?? []
      const index = editId === null ? list.length - 1 : list.findIndex(r => r.editId === editId)
      if (index < 0) return respond(true, { status: 'nothing_to_undo' })
      const record = list[index]
      const r = await resolveTarget(record.root, record.relative, { write: true })
      if (r.error) return refused(r.error)
      let current = null
      if (r.stat) { if (!r.stat.isFile()) return refused('FILE_NOT_A_FILE'); current = sha256(await fs.readFile(r.target)) }
      if (current !== record.afterSha) return respond(true, { status: 'undo_conflict', editId: record.editId, path: record.relative })
      if (record.before === null) { if (r.stat) await fs.unlink(r.target) }
      else {
        await fs.mkdir(path.dirname(r.target), { recursive: true })
        const temp = path.join(path.dirname(r.target), `.egdesk-write-${randomBytes(6).toString('hex')}`)
        await fs.writeFile(temp, record.before, { mode: r.stat ? r.stat.mode & 0o7777 : 0o644, flag: 'wx' })
        await fs.rename(temp, r.target)
      }
      list.splice(index, 1)
      try { onFileChange(run, { path: record.relative, kind: 'undo', diff: '' }) } catch { /* advisory */ }
      return respond(true, { status: 'undone', editId: record.editId, path: record.relative, restored: record.before === null ? 'removed' : 'previous' })
    },
  }
}
