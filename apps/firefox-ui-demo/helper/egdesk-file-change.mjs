// One shape for a file an Agent changed, whichever engine changed it
// (CODE-05 'Codex·Claude 공통 변경 모양'; bundle 2-X).
//
//   { path, kind: 'add'|'update'|'delete', movePath: string|null,
//     diff: string|null,      // update: hunk-only unified diff; add/delete:
//                             // the whole file text (the Codex convention)
//     oldText: string|null, newText: string|null,   // when both texts are known
//     source: 'codex'|'claude'|'acp'|'git', viaShell: boolean,
//     omitted: null|'fileLimit'|'runLimit'|'unavailable' }
//
// The approval card, the activity row and the change review read only this.
// EGDeskDiffView.fileDiffFromCodexChange and EGDeskChangeReview accept it as is.
//
// Patterns (read and followed):
// - Codex FileUpdateChange {path, kind: 'add'|'delete'|'update' or
//   {type, move_path}, diff} (openai/codex app-server-protocol, Apache-2.0).
// - ACP tool-call diff content {type: 'diff', path, oldText, newText}
//   (agentclientprotocol, Apache-2.0) and agentclientprotocol/claude-agent-acp
//   src/diff.ts (Apache-2.0, Copyright agentclientprotocol contributors):
//   Claude Edit/Write results carry structuredPatch hunks in the jsdiff
//   convention (a side with zero lines stores the line after the change) and
//   originalFile; 1 MiB bounds. Pattern only, no code copied.
// - Files changed by shell commands come from a git checkpoint diff
//   (egdesk-git-checkpoint.mjs, D-X4 default off).
//
// Nothing here reads files, logs or stores text.

export const FILE_CHANGE_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxRunBytes: 1024 * 1024,
  maxFiles: 200,
  maxPathChars: 4096,
})
export const FILE_CHANGE_KINDS = Object.freeze(['add', 'update', 'delete'])

const textOrNull = value => typeof value === 'string' ? value : null
const pathOrNull = value => typeof value === 'string' && value && value.length <= FILE_CHANGE_LIMITS.maxPathChars && !value.includes('\0') ? value : null

function shape({ path, kind, movePath = null, diff = null, oldText = null, newText = null, source, viaShell = false, omitted = null }) {
  return { path, kind, movePath, diff, oldText, newText, source, viaShell, omitted }
}

/** Codex FileUpdateChange (or the chat runtime's run-changes row). */
export function fileChangeFromCodex(change) {
  const path = pathOrNull(change?.path)
  if (!path) return null
  const kind = change.kind
  const type = typeof kind === 'string' ? kind : kind && typeof kind === 'object' ? kind.type : null
  const movePath = pathOrNull(kind && typeof kind === 'object' ? kind.move_path : null) || pathOrNull(change.movePath)
  const omitted = ['fileLimit', 'runLimit', 'unavailable'].includes(change.omitted) ? change.omitted : null
  return shape({ path, kind: FILE_CHANGE_KINDS.includes(type) ? type : 'update', movePath: type === 'update' || !FILE_CHANGE_KINDS.includes(type) ? movePath : null, diff: textOrNull(change.diff), source: 'codex', omitted })
}

/** ACP diff content {type:'diff', path, oldText, newText}. */
export function fileChangeFromAcpDiff(content) {
  const path = pathOrNull(content?.path)
  if (!path || content.type !== 'diff') return null
  const oldText = textOrNull(content.oldText)
  const newText = textOrNull(content.newText)
  const kind = oldText === null ? 'add' : newText === null ? 'delete' : 'update'
  return shape({ path, kind, diff: kind === 'add' ? newText : kind === 'delete' ? oldText : null, oldText, newText, source: 'acp' })
}

/** jsdiff/claude structuredPatch hunks → hunk-only unified diff text. */
export function hunksToUnified(hunks) {
  if (!Array.isArray(hunks)) return ''
  const range = (start, count) => count === 0 ? `${Math.max(0, start - 1)},0` : count === 1 ? String(start) : `${start},${count}`
  return hunks.filter(hunk => hunk && Array.isArray(hunk.lines) && Number.isInteger(hunk.oldStart) && Number.isInteger(hunk.newStart))
    .map(hunk => `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@\n${hunk.lines.map(line => String(line)).join('\n')}\n`)
    .join('')
}

/**
 * A Claude Code Edit/MultiEdit/Write tool result → the shared shape.
 * response: {filePath, structuredPatch, type: 'create'|'update', content,
 * originalFile}; input: the tool input ({file_path, …}).
 */
export function fileChangeFromClaudeToolResult(toolName, input, response) {
  if (!['Edit', 'MultiEdit', 'Write'].includes(toolName)) return null
  const path = pathOrNull(response?.filePath) || pathOrNull(input?.file_path)
  if (!path) return null
  const originalFile = textOrNull(response?.originalFile)
  if (toolName === 'Write') {
    const content = textOrNull(response?.content) ?? textOrNull(input?.content)
    if (response?.type === 'create' || (originalFile === null && response?.type !== 'update')) return shape({ path, kind: 'add', diff: content, newText: content, source: 'claude' })
    const diff = hunksToUnified(response?.structuredPatch)
    return shape({ path, kind: 'update', diff: diff || null, oldText: originalFile, newText: content, source: 'claude', omitted: diff || (originalFile !== null && content !== null) ? null : 'unavailable' })
  }
  const diff = hunksToUnified(response?.structuredPatch)
  // An Edit with an empty old_string on a missing file creates it.
  if (originalFile === '' && input?.old_string === '' && typeof input?.new_string === 'string') return shape({ path, kind: 'add', diff: input.new_string, newText: input.new_string, source: 'claude' })
  return shape({ path, kind: 'update', diff: diff || null, oldText: originalFile, source: 'claude', omitted: diff ? null : 'unavailable' })
}

const unquoteGitPath = value => {
  if (!value.startsWith('"')) return value
  try { return JSON.parse(value) } catch { return value.slice(1, -1) }
}

/**
 * A multi-file git patch (checkpoint diff) → shared changes, paths as git
 * printed them (relative to the diff's --relative root). Binary files keep
 * no text (omitted 'unavailable').
 */
export function fileChangesFromGitPatch(patchText) {
  if (typeof patchText !== 'string' || !patchText) return []
  const sections = patchText.split(/^(?=diff --git )/m).filter(section => section.startsWith('diff --git '))
  const out = []
  for (const section of sections.slice(0, FILE_CHANGE_LIMITS.maxFiles)) {
    const lines = section.split('\n')
    let oldPath = null
    let newPath = null
    let kind = 'update'
    let renameFrom = null
    let renameTo = null
    let binary = false
    let bodyStart = lines.length
    for (let index = 1; index < lines.length; index++) {
      const line = lines[index]
      if (line.startsWith('@@')) { bodyStart = index; break }
      if (line.startsWith('new file mode')) kind = 'add'
      else if (line.startsWith('deleted file mode')) kind = 'delete'
      else if (line.startsWith('rename from ')) renameFrom = unquoteGitPath(line.slice(12))
      else if (line.startsWith('rename to ')) renameTo = unquoteGitPath(line.slice(10))
      else if (line.startsWith('--- ')) oldPath = line === '--- /dev/null' ? null : unquoteGitPath(line.slice(4)).replace(/^a\//, '')
      else if (line.startsWith('+++ ')) newPath = line === '+++ /dev/null' ? null : unquoteGitPath(line.slice(4)).replace(/^b\//, '')
      else if (/^Binary files |^GIT binary patch/.test(line)) binary = true
    }
    if (!oldPath && !newPath) {
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0])
      if (header) { oldPath = renameFrom || header[1]; newPath = renameTo || header[2] }
    }
    const path = pathOrNull(kind === 'add' ? newPath : renameFrom || oldPath || newPath)
    if (!path) continue
    const body = lines.slice(bodyStart).join('\n')
    const movePath = kind === 'update' && renameTo && renameTo !== path ? renameTo : null
    if (binary) { out.push(shape({ path, kind, movePath, source: 'git', viaShell: true, omitted: 'unavailable' })); continue }
    if (kind === 'update') { out.push(shape({ path, kind, movePath, diff: body ? `${body.replace(/\n?$/, '\n')}` : '', source: 'git', viaShell: true })); continue }
    // add/delete: the whole text, rebuilt from the +/- lines.
    const sign = kind === 'add' ? '+' : '-'
    const bodyLines = lines.slice(bodyStart)
    const textLines = []
    let noNewline = false
    for (const line of bodyLines) {
      if (line.startsWith(sign)) textLines.push(line.slice(1))
      else if (line.startsWith('\\')) noNewline = true
    }
    const text = textLines.length ? textLines.join('\n') + (noNewline ? '' : '\n') : ''
    out.push(shape({ path, kind, diff: text, oldText: kind === 'delete' ? text : null, newText: kind === 'add' ? text : null, source: 'git', viaShell: true }))
  }
  return out
}

const byteLength = text => typeof text === 'string' ? new TextEncoder().encode(text).length : 0

/** Per-file 256 KiB and per-run 1 MiB bounds; past them only the path stays. */
export function boundFileChanges(changes) {
  let total = 0
  return (Array.isArray(changes) ? changes : []).slice(0, FILE_CHANGE_LIMITS.maxFiles).map(change => {
    const size = byteLength(change.diff) + byteLength(change.oldText) + byteLength(change.newText)
    if (!size || change.omitted) return change
    if (size > FILE_CHANGE_LIMITS.maxFileBytes) return { ...change, diff: null, oldText: null, newText: null, omitted: 'fileLimit' }
    if (total + size > FILE_CHANGE_LIMITS.maxRunBytes) return { ...change, diff: null, oldText: null, newText: null, omitted: 'runLimit' }
    total += size
    return change
  })
}

const joinRoot = (root, relative) => `${root.replace(/[\\/]+$/, '')}/${relative}`
const sameKey = value => String(value).replace(/\\/g, '/').normalize('NFC')

/**
 * A turn's engine changes (exact) plus the checkpoint changes for files no
 * engine reported — those were changed by shell commands (viaShell: true).
 * root: the project folder the checkpoint paths are relative to.
 */
export function mergeTurnChanges({ engine = [], checkpoint = [], root = null } = {}) {
  const seen = new Set()
  const out = []
  for (const change of engine) {
    if (!change?.path) continue
    seen.add(sameKey(change.path))
    if (change.movePath) seen.add(sameKey(change.movePath))
    out.push(change)
  }
  for (const change of checkpoint) {
    if (!change?.path) continue
    const absolute = root && !/^(?:\/|[A-Za-z]:[\\/])/.test(change.path) ? joinRoot(root, change.path) : change.path
    const moved = change.movePath && root && !/^(?:\/|[A-Za-z]:[\\/])/.test(change.movePath) ? joinRoot(root, change.movePath) : change.movePath
    if (seen.has(sameKey(absolute)) || (moved && seen.has(sameKey(moved)))) continue
    seen.add(sameKey(absolute))
    out.push({ ...change, path: absolute, movePath: moved || null, viaShell: true })
  }
  return boundFileChanges(out)
}
