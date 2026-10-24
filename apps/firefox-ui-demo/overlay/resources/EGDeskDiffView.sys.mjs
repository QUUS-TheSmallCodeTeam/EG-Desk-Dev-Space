// EGDeskDiffView — the '바뀐 줄 보기' part (CODE-05).
//
// Turns the changes an Agent proposes or made into one file-by-file model of
// −/+ lines, and renders that model as plain DOM (textContent only) for the
// approval card, the activity row and the File view review panel.
//
// Inputs it understands:
// - a Codex `fileChange` item / FileUpdateChange {path, kind, diff}
//   (kind 'add'|'update'|'delete' or {type, move_path}). An update diff is a
//   hunk-only unified diff with no file headers (codex
//   apply-patch/src/file_update.rs unified_diff_from_chunks); a moved file
//   carries "\n\nMoved to: <path>" after it (codex app-server-protocol
//   item_builders.rs format_file_change_diff); add/delete carry the whole file
//   text, so they become a diff against an empty document.
// - a git-style multi-file diff (codex core/src/turn_diff_tracker.rs turn diff).
// - two texts {path, oldText, newText} (the ACP / Claude Edit·Write shape).
//
// Limits follow the references: at most 1 MiB of text per side and a 100 ms
// line-diff budget (claude-agent-acp src/diff.ts MAX_PATCH_FILE_BYTES /
// PATCH_DIFF_TIMEOUT_MS, codex turn_diff_tracker.rs DIFF_TIMEOUT). Past them
// the file is reported as 'too-large' or 'timeout' instead of being diffed.
//
// The two-text path trims the shared head and tail before diffing, as
// claude-agent-acp src/diff.ts diffHunks does (Apache-2.0, Copyright
// agentclientprotocol contributors; pattern re-implemented here, no code copied).
//
// Line diffing and patch parsing come from the vendored jsdiff 9.0.0 libesm
// (BSD-3-Clause, see vendor/VENDOR.md and vendor/jsdiff/LICENSE).
//
// Nothing here logs, stores or sends the text it is given. Paths and file
// contents are never used as object keys.

import { parsePatch, structuredPatch } from './vendor/jsdiff/index.js'

export const DIFF_VIEW_LIMITS = Object.freeze({
  maxTextBytes: 1024 * 1024,
  diffTimeoutMs: 100,
  contextLines: 3,
  maxFiles: 100,
  maxLinesPerFile: 4000,
  binarySniffChars: 8000,
  maxRawChars: 20000,
})

export const DIFF_FILE_STATUSES = Object.freeze(['ok', 'empty', 'binary', 'too-large', 'timeout', 'unparsable', 'omitted', 'unavailable'])
export const DIFF_FILE_CHANGES = Object.freeze(['add', 'update', 'delete', 'rename', 'copy'])

const CHANGE_LABELS = Object.freeze({ add: '새 파일', update: '수정', delete: '삭제', rename: '이름 바꿈', copy: '복사' })
const STATUS_NOTES = Object.freeze({
  empty: '내용 변경이 없습니다.',
  binary: '바이너리 파일이라 줄 비교를 보여 주지 않습니다.',
  'too-large': '파일이 1MB보다 커서 줄 비교를 생략했습니다.',
  timeout: '비교가 오래 걸려 줄 비교를 생략했습니다.',
  unparsable: '변경 내용을 줄 단위로 해석하지 못했습니다. 받은 내용을 그대로 보여 줍니다.',
  omitted: '변경 내용이 커서 보관하지 않았습니다. 파일을 열어 확인하세요.',
  unavailable: '이 파일의 변경 내용을 받지 못했습니다.',
})
const NO_NEWLINE_NOTE = '파일 끝에 줄바꿈이 없습니다'
const MINUS = '−'

// UTF-8 byte length with an early exit once `limit` is passed (no TextEncoder
// needed, so it behaves the same in a Firefox system module and in node).
export function utf8LengthExceeds(text, limit = DIFF_VIEW_LIMITS.maxTextBytes) {
  if (typeof text !== 'string') return false
  if (text.length > limit) return true
  if (text.length * 3 <= limit) return false
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) { bytes += 4; i++ }
    else bytes += 3
    if (bytes > limit) return true
  }
  return false
}

function looksBinary(text) {
  return typeof text === 'string' && text.slice(0, DIFF_VIEW_LIMITS.binarySniffChars).includes('\u0000')
}

// Codex PatchChangeKind is {type, move_path}; the chat runtime flattens it to
// the bare type string. Both are accepted.
export function normalizeChangeKind(kind) {
  const type = typeof kind === 'string' ? kind : kind && typeof kind === 'object' ? kind.type : null
  const movePath = kind && typeof kind === 'object' && typeof kind.move_path === 'string' && kind.move_path ? kind.move_path : null
  return { type: ['add', 'delete', 'update'].includes(type) ? type : 'update', movePath }
}

// codex item_builders.rs appends "\n\nMoved to: <path>" to an update diff.
export function splitMovedTo(diffText) {
  if (typeof diffText !== 'string') return { diff: '', movePath: null }
  const match = diffText.match(/(?:^|\r?\n)(?:\r?\n)*Moved to: ([^\r\n]+)[\r\n]*$/)
  if (!match) return { diff: diffText, movePath: null }
  return { diff: diffText.slice(0, match.index) + (match.index > 0 ? '\n' : ''), movePath: match[1].trim() || null }
}

function hunkRange(start, count) {
  if (count === 0) return `${Math.max(0, start - 1)},0`
  return count === 1 ? String(start) : `${start},${count}`
}

function emptyFile({ path, oldPath = null, newPath = null, change = 'update', status = 'ok', raw = null }) {
  return { path: path || newPath || oldPath || '', oldPath, newPath, change, status, hunks: [], added: 0, removed: 0, truncated: false, raw }
}

// One jsdiff hunk (parsePatch or structuredPatch) → display lines with old/new
// line numbers. `budget.lines` caps the lines kept for one file.
function hunkModel(hunk, budget) {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  const lines = []
  let added = 0
  let removed = 0
  for (const raw of hunk.lines) {
    if (budget.lines <= 0) { budget.truncated = true; break }
    const sign = raw[0]
    const text = raw.slice(1).replace(/\r$/, '')
    if (sign === '+') { lines.push({ kind: 'add', text, oldLine: null, newLine }); newLine++; added++ }
    else if (sign === '-') { lines.push({ kind: 'delete', text, oldLine, newLine: null }); oldLine++; removed++ }
    else if (sign === '\\') { lines.push({ kind: 'note', text: NO_NEWLINE_NOTE, oldLine: null, newLine: null }); continue }
    else { lines.push({ kind: 'context', text, oldLine, newLine }); oldLine++; newLine++ }
    budget.lines--
  }
  return {
    hunk: {
      oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines,
      header: `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`,
      lines,
    },
    added, removed,
  }
}

function withHunks(file, hunks) {
  const budget = { lines: DIFF_VIEW_LIMITS.maxLinesPerFile, truncated: false }
  for (const source of hunks) {
    if (budget.lines <= 0) { budget.truncated = true; break }
    const { hunk, added, removed } = hunkModel(source, budget)
    file.hunks.push(hunk)
    file.added += added
    file.removed += removed
  }
  file.truncated = budget.truncated
  if (file.status === 'ok' && file.hunks.length === 0) file.status = 'empty'
  return file
}

function rawFallback(text) {
  if (typeof text !== 'string') return null
  return text.length > DIFF_VIEW_LIMITS.maxRawChars ? `${text.slice(0, DIFF_VIEW_LIMITS.maxRawChars)}\n…` : text
}

function textLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

// Two texts → hunks. oldText null means the file did not exist (a new file).
// The shared head and tail outside the context window are not diffed; the
// hunk starts are shifted back afterwards (claude-agent-acp diffHunks pattern).
export function fileDiffFromTexts({ path = '', oldText = null, newText = '', change } = {}) {
  const before = typeof oldText === 'string' ? oldText : ''
  const after = typeof newText === 'string' ? newText : ''
  const kind = change && DIFF_FILE_CHANGES.includes(change) ? change : oldText === null ? 'add' : 'update'
  const file = emptyFile({ path, oldPath: kind === 'add' ? null : path, newPath: kind === 'delete' ? null : path, change: kind })
  if (utf8LengthExceeds(before) || utf8LengthExceeds(after)) { file.status = 'too-large'; return file }
  if (looksBinary(before) || looksBinary(after)) { file.status = 'binary'; return file }
  if (before === after) { file.status = 'empty'; return file }
  const oldLines = textLines(before)
  const newLines = textLines(after)
  const context = DIFF_VIEW_LIMITS.contextLines
  const common = Math.min(oldLines.length, newLines.length)
  let prefix = 0
  while (prefix < common && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (suffix < common - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++
  const skipped = Math.max(0, prefix - context)
  const skippedEnd = Math.max(0, suffix - context)
  let patch
  try {
    patch = structuredPatch('', '',
      oldLines.slice(skipped, oldLines.length - skippedEnd).join(''),
      newLines.slice(skipped, newLines.length - skippedEnd).join(''),
      '', '', { context, timeout: DIFF_VIEW_LIMITS.diffTimeoutMs })
  } catch { patch = undefined }
  if (!patch) { file.status = 'timeout'; return file }
  return withHunks(file, patch.hunks.map(hunk => ({ ...hunk, oldStart: hunk.oldStart + skipped, newStart: hunk.newStart + skipped })))
}

// A Codex FileUpdateChange {path, kind, diff}, or the chat runtime's
// /chat/run-changes file row {path, kind, movePath, diff|null, omitted}
// (omitted: 'fileLimit'|'runLimit' = too big to keep, 'unavailable').
export function fileDiffFromCodexChange(change) {
  const path = typeof change?.path === 'string' ? change.path : ''
  const normalized = normalizeChangeKind(change?.kind)
  const { type } = normalized
  const kindMovePath = normalized.movePath || (typeof change?.movePath === 'string' && change.movePath ? change.movePath : null)
  const diff = typeof change?.diff === 'string' ? change.diff : null
  if (diff === null && typeof change?.omitted === 'string' && change.omitted) {
    const movePath = type === 'update' ? kindMovePath : null
    const newPath = type === 'delete' ? null : movePath || path
    return emptyFile({ path: newPath || path, oldPath: type === 'add' ? null : path, newPath, change: type === 'update' ? (movePath ? 'rename' : 'update') : type, status: change.omitted === 'unavailable' ? 'unavailable' : 'omitted' })
  }
  if (type === 'add') {
    if (diff === null) return emptyFile({ path, newPath: path, change: 'add', status: 'empty' })
    return fileDiffFromTexts({ path, oldText: null, newText: diff, change: 'add' })
  }
  if (type === 'delete') {
    if (diff === null) return emptyFile({ path, oldPath: path, change: 'delete', status: 'empty' })
    return fileDiffFromTexts({ path, oldText: diff, newText: '', change: 'delete' })
  }
  const { diff: body, movePath: textMovePath } = splitMovedTo(diff ?? '')
  const movePath = kindMovePath || textMovePath
  const file = emptyFile({ path: movePath || path, oldPath: path, newPath: movePath || path, change: movePath ? 'rename' : 'update' })
  if (!body.trim()) { file.status = movePath ? 'ok' : 'empty'; return file }
  if (utf8LengthExceeds(body)) { file.status = 'too-large'; return file }
  if (looksBinary(body)) { file.status = 'binary'; return file }
  let parsed
  try { parsed = parsePatch(body) } catch { parsed = null }
  if (!Array.isArray(parsed) || parsed.length !== 1) { file.status = 'unparsable'; file.raw = rawFallback(body); return file }
  if (parsed[0].isBinary) { file.status = 'binary'; return file }
  return withHunks(file, parsed[0].hunks)
}

// A Codex `fileChange` thread item ({changes: []}), a /chat/run-changes item
// ({files: []}) or a plain array of changes.
export function fileDiffsFromCodexItem(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : Array.isArray(item?.files) ? item.files : Array.isArray(item) ? item : []
  return changes.slice(0, DIFF_VIEW_LIMITS.maxFiles).map(fileDiffFromCodexChange)
}

function gitSidePath(name, prefix) {
  if (typeof name !== 'string' || !name || name === '/dev/null') return null
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

// A unified diff that may hold several files (git `diff --git` turn diff,
// GNU diff -u) or a single hunk-only body (then `path` names the file).
export function fileDiffsFromUnifiedDiff(text, { path = '' } = {}) {
  if (typeof text !== 'string' || !text.trim()) return []
  if (utf8LengthExceeds(text)) return [emptyFile({ path, change: 'update', status: 'too-large' })]
  let parsed
  try { parsed = parsePatch(text) } catch { parsed = null }
  if (!Array.isArray(parsed)) return [emptyFile({ path, change: 'update', status: 'unparsable', raw: rawFallback(text) })]
  return parsed.slice(0, DIFF_VIEW_LIMITS.maxFiles).map(index => {
    const git = Boolean(index.isGit)
    const prefixed = git || (index.oldFileName?.startsWith('a/') && index.newFileName?.startsWith('b/'))
    let oldPath = prefixed ? gitSidePath(index.oldFileName, 'a/') : gitSidePath(index.oldFileName, '')
    let newPath = prefixed ? gitSidePath(index.newFileName, 'b/') : gitSidePath(index.newFileName, '')
    if (!oldPath && !newPath && path) { oldPath = path; newPath = path }
    let change = 'update'
    if (index.isCreate || (index.oldFileName === '/dev/null' && newPath)) change = 'add'
    else if (index.isDelete || (index.newFileName === '/dev/null' && oldPath)) change = 'delete'
    else if (index.isRename) change = 'rename'
    else if (index.isCopy) change = 'copy'
    const file = emptyFile({ path: newPath || oldPath || path, oldPath: change === 'add' ? null : oldPath, newPath: change === 'delete' ? null : newPath, change })
    if (index.isBinary) { file.status = 'binary'; return file }
    withHunks(file, index.hunks || [])
    // A rename, copy or empty new/deleted file with no hunks is still a change.
    if (file.status === 'empty' && (change !== 'update' || index.oldMode !== index.newMode)) file.status = 'ok'
    return file
  })
}

// The GET /chat/run-changes response {retained, turn:{diff, omitted}|null,
// items:[{itemId, status, truncated, files:[…]}]} → file diffs per item plus
// the turn diff. turn is null when the response carries none.
export function diffViewFromRunChanges(packet) {
  const items = Array.isArray(packet?.items) ? packet.items : []
  const turn = packet?.turn && typeof packet.turn === 'object' ? packet.turn : null
  return {
    retained: Boolean(packet?.retained),
    items: items.map(item => ({
      itemId: typeof item?.itemId === 'string' ? item.itemId : null,
      status: typeof item?.status === 'string' ? item.status : null,
      truncated: Boolean(item?.truncated),
      files: fileDiffsFromCodexItem(item),
    })),
    turn: turn ? (typeof turn.diff === 'string' ? fileDiffsFromUnifiedDiff(turn.diff) : []) : null,
    turnOmitted: turn && typeof turn.omitted === 'string' ? turn.omitted : null,
  }
}

export function diffStats(files) {
  const list = Array.isArray(files) ? files : []
  return list.reduce((sum, file) => ({ files: sum.files + 1, added: sum.added + (file.added || 0), removed: sum.removed + (file.removed || 0) }), { files: 0, added: 0, removed: 0 })
}

export function fileChangeLabel(file) {
  return CHANGE_LABELS[file?.change] || CHANGE_LABELS.update
}

export function fileStatusNote(file) {
  return file?.status && file.status !== 'ok' ? STATUS_NOTES[file.status] || '' : ''
}

// '파일 2개 · +12 −3'
export function diffSummaryText(files) {
  const { files: count, added, removed } = diffStats(files)
  if (!count) return '바뀐 파일이 없습니다.'
  return `파일 ${count}개 · +${added} ${MINUS}${removed}`
}

// Shortens an absolute path under `root` for display; never resolves '..'.
export function displayDiffPath(path, root) {
  if (typeof path !== 'string') return ''
  if (typeof root !== 'string' || !root) return path
  const base = root.replace(/[\\/]+$/, '')
  if (path === base) return path
  for (const separator of ['/', '\\']) {
    if (path.startsWith(base + separator)) return path.slice(base.length + 1)
  }
  return path
}

// The File view review panel's existing hunk shape
// [{baseStartLine, baseLines, currentStartLine, currentLines}] (egdesk-file-service lineDiff).
export function fileViewHunks(file) {
  return (file?.hunks || []).map(hunk => {
    const base = hunk.lines.filter(line => line.kind === 'context' || line.kind === 'delete')
    const current = hunk.lines.filter(line => line.kind === 'context' || line.kind === 'add')
    return {
      baseStartLine: base[0]?.oldLine ?? hunk.oldStart,
      baseLines: base.map(line => line.text),
      currentStartLine: current[0]?.newLine ?? hunk.newStart,
      currentLines: current.map(line => line.text),
    }
  })
}

// The first changed line in the file as it is now, for "open at this line".
// A deletion has no line of its own there; it points at the line that now
// stands where the deleted text was.
export function firstChangedLine(file) {
  for (const hunk of file?.hunks || []) {
    let lastNew = null
    for (const line of hunk.lines) {
      if (line.kind === 'add') return line.newLine
      if (line.kind === 'delete') return lastNew != null ? lastNew + 1 : Math.max(1, hunk.newStart)
      if (line.newLine != null) lastNew = line.newLine
    }
  }
  return null
}

// Plain DOM for one or more file diffs. Class names are the contract with the
// surface CSS (egdesk-diff-*). Text only ever goes through textContent.
// onOpenFile({path, line}) — optional; adds a '파일 열기' button per file.
export function renderDiffView({ document, files, root = '', openFiles = 3, onOpenFile } = {}) {
  if (!document?.createElement) throw new TypeError('renderDiffView requires a document')
  const list = Array.isArray(files) ? files : []
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }
  const view = el('section', 'egdesk-diff-view')
  view.setAttribute('aria-label', '바뀐 줄 보기')
  view.append(el('p', 'egdesk-diff-summary', diffSummaryText(list)))
  list.forEach((file, index) => {
    const details = el('details', 'egdesk-diff-file')
    details.setAttribute('data-change', file.change)
    details.setAttribute('data-status', file.status)
    if (index < openFiles) details.open = true
    const shownPath = displayDiffPath(file.path, root)
    const summary = el('summary', 'egdesk-diff-file-summary')
    summary.append(
      el('span', 'egdesk-diff-file-path', shownPath),
      el('span', 'egdesk-diff-file-change', fileChangeLabel(file)),
      el('span', 'egdesk-diff-file-added', `+${file.added}`),
      el('span', 'egdesk-diff-file-removed', `${MINUS}${file.removed}`))
    summary.setAttribute('aria-label', `${shownPath} · ${fileChangeLabel(file)} · ${file.added}줄 추가 · ${file.removed}줄 삭제`)
    details.append(summary)
    if (file.change === 'rename' && file.oldPath && file.newPath) {
      details.append(el('p', 'egdesk-diff-file-move', `${displayDiffPath(file.oldPath, root)} → ${displayDiffPath(file.newPath, root)}`))
    }
    if (typeof onOpenFile === 'function' && file.newPath) {
      const open = el('button', 'egdesk-diff-open', '파일 열기')
      open.type = 'button'
      open.setAttribute('aria-label', `${shownPath} 열기`)
      const line = firstChangedLine(file)
      open.addEventListener('click', () => onOpenFile({ path: file.newPath, line }))
      details.append(open)
    }
    const note = fileStatusNote(file)
    if (note) details.append(el('p', 'egdesk-diff-note', note))
    if (file.raw) details.append(el('pre', 'egdesk-diff-raw', file.raw))
    for (const hunk of file.hunks) {
      const block = el('div', 'egdesk-diff-hunk')
      const firstOld = hunk.lines.find(line => line.oldLine != null)?.oldLine ?? hunk.oldStart
      const firstNew = hunk.lines.find(line => line.newLine != null)?.newLine ?? hunk.newStart
      const header = el('p', 'egdesk-diff-hunk-header', `원본 ${firstOld}행 · 바뀐 뒤 ${firstNew}행`)
      header.setAttribute('data-range', hunk.header)
      block.append(header)
      const lines = el('ol', 'egdesk-diff-lines')
      for (const line of hunk.lines) {
        const item = el('li', `egdesk-diff-line egdesk-diff-line-${line.kind}`)
        item.setAttribute('data-kind', line.kind)
        const oldNo = el('span', 'egdesk-diff-ln egdesk-diff-ln-old', line.oldLine == null ? '' : String(line.oldLine))
        const newNo = el('span', 'egdesk-diff-ln egdesk-diff-ln-new', line.newLine == null ? '' : String(line.newLine))
        oldNo.setAttribute('aria-hidden', 'true')
        newNo.setAttribute('aria-hidden', 'true')
        const sign = el('span', 'egdesk-diff-sign', line.kind === 'add' ? '+' : line.kind === 'delete' ? MINUS : ' ')
        sign.setAttribute('aria-hidden', 'true')
        // <ins>/<del> carry "added"/"removed" for assistive tech without extra words.
        const tag = line.kind === 'add' ? 'ins' : line.kind === 'delete' ? 'del' : line.kind === 'note' ? 'em' : 'code'
        item.append(oldNo, newNo, sign, el(tag, 'egdesk-diff-text', line.text))
        lines.append(item)
      }
      block.append(lines)
      details.append(block)
    }
    if (file.truncated) details.append(el('p', 'egdesk-diff-note egdesk-diff-truncated', `줄이 많아 처음 ${DIFF_VIEW_LIMITS.maxLinesPerFile}줄만 보여 줍니다.`))
    view.append(details)
  })
  return view
}
