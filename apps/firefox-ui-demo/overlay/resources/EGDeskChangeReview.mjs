// EGDeskChangeReview — '변경 검토' after an Agent changed files (CODE-05, D-X2).
//
// 대표님 결정 2026-10-24 (D-X2): before approval the card shows '변경 보기'
// with one choice for the whole change (전체 허용 / 거절); after the change is
// applied, each separate change (덩어리) in a file can be put back. A file the
// Agent created is offered for removal only while it is still exactly what
// the Agent wrote. Writing the original goes through the helper's
// conditional write (D-X1): the file must still hash to what this screen read.
//
// Display uses EGDeskDiffView (bundle 1-D) — not CodeMirror (D-X5 undecided).
//
// Patterns (read and followed, no code copied):
// - chunk-wise accept/reject in a unified view: @codemirror/merge
//   src/unified.ts acceptChunk/rejectChunk (MIT) — a chunk is one separate
//   change; reverting it replaces the new lines with the original lines.
// - review after apply, remove a created file only when it holds nothing but
//   the Agent's text, undo the last revert: Zed crates/action_log/src/
//   action_log.rs reject_edits_in_ranges / undo_last_reject (GPL-3.0 —
//   pattern only).
// Line diffing and patch reversal use the vendored jsdiff 9.0.0 (BSD-3-Clause,
// see vendor/VENDOR.md and vendor/jsdiff/LICENSE).
//
// Lines keep their own line endings so a revert puts back the exact bytes.
// Nothing here logs, stores or sends file text; paths and contents are never
// used as object keys.

import { fileDiffFromTexts, fileDiffsFromCodexItem, renderDiffView, diffSummaryText, splitMovedTo, normalizeChangeKind } from './EGDeskDiffView.sys.mjs'
import { diffLines, parsePatch, reversePatch, applyPatch } from './vendor/jsdiff/index.js'

export const CHANGE_REVIEW_LIMITS = Object.freeze({
  maxTextBytes: 1024 * 1024,
  diffTimeoutMs: 100,
  maxChunks: 500,
  maxFiles: 50,
})

const MINUS = '−'

function utf8Bytes(text) {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? (i++, 4) : 3
    if (bytes > CHANGE_REVIEW_LIMITS.maxTextBytes) return bytes
  }
  return bytes
}

// Raw lines with their endings: 'a\r\nb' → ['a\r\n', 'b'].
export function rawLines(text) {
  return typeof text === 'string' ? text.match(/[^\n]*\n|[^\n]+$/g) ?? [] : []
}

/**
 * Text before the Agent and text now → separate changes (덩어리).
 * {status: 'ok'|'empty'|'too-large'|'binary'|'timeout', chunks:[{index,
 * baseStartLine, baseLines, currentStartLine, currentLines, added, removed}]}
 * Line numbers are 1-based; a pure insertion's baseStartLine is the line it
 * comes before, as is a pure deletion's currentStartLine.
 */
export function reviewChunks(beforeText, currentText) {
  const before = typeof beforeText === 'string' ? beforeText : ''
  const current = typeof currentText === 'string' ? currentText : ''
  if (utf8Bytes(before) > CHANGE_REVIEW_LIMITS.maxTextBytes || utf8Bytes(current) > CHANGE_REVIEW_LIMITS.maxTextBytes) return { status: 'too-large', chunks: [] }
  if (before.slice(0, 8000).includes('\u0000') || current.slice(0, 8000).includes('\u0000')) return { status: 'binary', chunks: [] }
  if (before === current) return { status: 'empty', chunks: [] }
  let changes
  try { changes = diffLines(before, current, { timeout: CHANGE_REVIEW_LIMITS.diffTimeoutMs }) } catch { changes = undefined }
  if (!Array.isArray(changes)) return { status: 'timeout', chunks: [] }
  const chunks = []
  let baseLine = 1
  let currentLine = 1
  let pending = null
  const flush = () => {
    if (!pending) return
    pending.index = chunks.length
    pending.added = pending.currentLines.length
    pending.removed = pending.baseLines.length
    chunks.push(pending)
    pending = null
  }
  for (const change of changes) {
    const lines = rawLines(change.value)
    if (change.added || change.removed) {
      pending ||= { index: 0, baseStartLine: baseLine, baseLines: [], currentStartLine: currentLine, currentLines: [], added: 0, removed: 0 }
      if (change.added) { pending.currentLines.push(...lines); currentLine += lines.length }
      else { pending.baseLines.push(...lines); baseLine += lines.length }
    } else {
      flush()
      baseLine += lines.length
      currentLine += lines.length
    }
  }
  flush()
  if (chunks.length > CHANGE_REVIEW_LIMITS.maxChunks) return { status: 'too-large', chunks: [] }
  return { status: chunks.length ? 'ok' : 'empty', chunks }
}

/**
 * Put chosen chunks back: their current lines become the original lines.
 * Throws {code: 'CHUNK_DRIFT'} if the text no longer has a chunk's lines where
 * the review found them (the file changed after the review was computed).
 */
export function revertChunks(currentText, chunks, indexes) {
  const lines = rawLines(currentText)
  const chosen = [...new Set(indexes)].map(index => chunks[index]).filter(Boolean).sort((a, b) => b.currentStartLine - a.currentStartLine)
  for (const chunk of chosen) {
    const at = chunk.currentStartLine - 1
    const found = lines.slice(at, at + chunk.currentLines.length)
    if (found.length !== chunk.currentLines.length || found.some((line, i) => line !== chunk.currentLines[i])) {
      throw Object.assign(new Error('The file changed after the review was computed'), { code: 'CHUNK_DRIFT' })
    }
    lines.splice(at, chunk.currentLines.length, ...chunk.baseLines)
  }
  return lines.join('')
}

/**
 * A Codex update diff (hunk-only, maybe with "Moved to: …") applied to the
 * file as it is now, in reverse → the text before the Agent; null when the
 * file no longer matches the Agent's result.
 */
export function beforeTextFromUpdateDiff(currentText, diffText) {
  if (typeof currentText !== 'string' || typeof diffText !== 'string') return null
  const { diff } = splitMovedTo(diffText)
  if (!diff.trim()) return currentText
  let parsed
  try { parsed = parsePatch(diff) } catch { return null }
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0].isBinary) return null
  let restored
  try { restored = applyPatch(currentText, reversePatch(parsed[0])) } catch { return null }
  return typeof restored === 'string' ? restored : null
}

/**
 * One change record + the file text now → what the review can do.
 * Accepts a Codex FileUpdateChange {path, kind, diff} (or the chat runtime's
 * /chat/run-changes row) and the shared shape {path, kind?, oldText, newText}.
 * → {path, change: 'add'|'update'|'delete'|'rename', beforeText, agentText,
 *    status: 'ok'|'drifted'|'unavailable'}
 */
export function reviewTargetFromChange(change, currentText) {
  const path = typeof change?.path === 'string' ? change.path : ''
  const hasTexts = Object.hasOwn(change || {}, 'oldText') || Object.hasOwn(change || {}, 'newText')
  if (hasTexts) {
    const beforeText = typeof change.oldText === 'string' ? change.oldText : null
    const agentText = typeof change.newText === 'string' ? change.newText : null
    const kind = change.kind === 'delete' || (agentText === null && beforeText !== null) ? 'delete' : beforeText === null ? 'add' : 'update'
    return { path, change: kind, beforeText, agentText, status: kind !== 'delete' && typeof currentText !== 'string' ? 'unavailable' : 'ok' }
  }
  const { type, movePath } = normalizeChangeKind(change?.kind)
  const diff = typeof change?.diff === 'string' ? change.diff : null
  if (type === 'add') return { path, change: 'add', beforeText: null, agentText: diff, status: typeof currentText === 'string' ? 'ok' : 'unavailable' }
  if (type === 'delete') return { path, change: 'delete', beforeText: diff, agentText: null, status: 'ok' }
  const moved = movePath || (diff ? splitMovedTo(diff).movePath : null) || (typeof change?.movePath === 'string' ? change.movePath : null)
  const target = { path: moved || path, change: moved ? 'rename' : 'update', beforeText: null, agentText: typeof currentText === 'string' ? currentText : null, status: 'ok' }
  if (typeof currentText !== 'string' || diff === null) return { ...target, status: 'unavailable' }
  const beforeText = beforeTextFromUpdateDiff(currentText, diff)
  return beforeText === null ? { ...target, status: 'drifted' } : { ...target, beforeText }
}

/**
 * What to offer for one file. A created file may be removed only while it
 * still equals the Agent's text; a deleted file cannot be restored here (that
 * needs a new-file save, which never overwrites).
 */
export function reviewActions(target, currentText, chunks = []) {
  if (!target || target.status === 'unavailable') return { revertChunks: false, deleteFile: false, restoreFile: false, reason: 'unavailable' }
  if (target.change === 'add') {
    const unchanged = typeof currentText === 'string' && typeof target.agentText === 'string' && currentText === target.agentText
    return { revertChunks: false, deleteFile: unchanged, restoreFile: false, reason: unchanged ? null : 'edited-after-agent' }
  }
  if (target.change === 'delete') return { revertChunks: false, deleteFile: false, restoreFile: false, reason: 'restore-not-available' }
  if (target.status === 'drifted') return { revertChunks: false, deleteFile: false, restoreFile: false, reason: 'drifted' }
  return { revertChunks: chunks.length > 0, deleteFile: false, restoreFile: false, reason: chunks.length ? null : 'no-changes' }
}

const el = (document, tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}
const makeButton = (document, label, className, action) => {
  const node = el(document, 'button', className, label)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

/**
 * Stage 1 — the approval card body: '변경 보기' of the proposed change and one
 * decision for all of it. onDecision('accept'|'decline').
 */
export function renderApprovalChanges({ document, item, root = '', onDecision } = {}) {
  if (!document?.createElement) throw new TypeError('renderApprovalChanges requires a document')
  const files = fileDiffsFromCodexItem(item)
  const box = el(document, 'section', 'egdesk-change-approval')
  box.setAttribute('aria-label', '변경 보기')
  const details = el(document, 'details', 'egdesk-change-approval-details')
  details.append(el(document, 'summary', 'egdesk-change-approval-summary', `변경 보기 · ${diffSummaryText(files)}`))
  details.append(renderDiffView({ document, files, root, openFiles: 1 }))
  box.append(details)
  if (typeof onDecision === 'function') {
    const actions = el(document, 'div', 'egdesk-change-approval-actions')
    actions.append(
      makeButton(document, '전체 허용', 'egdesk-change-approval-accept', () => onDecision('accept')),
      makeButton(document, '거절', 'egdesk-change-approval-decline', () => onDecision('decline')))
    box.append(actions)
  }
  return box
}

const CHANGE_LABELS = Object.freeze({ add: '새 파일', update: '수정', delete: '삭제', rename: '이름 바꿈' })
const REASON_NOTES = Object.freeze({
  unavailable: '이 파일을 지금 읽을 수 없어 검토할 수 없습니다.',
  'edited-after-agent': 'Agent가 만든 뒤 내용이 바뀌어 삭제를 제안하지 않습니다.',
  'restore-not-available': '지운 파일은 여기서 되살리지 않습니다. 필요하면 새 파일로 저장하세요.',
  'deleted-gone': '이 경로에 파일이 없는 것을 다시 확인했습니다. 지운 파일은 여기서 되살리지 않습니다. 필요하면 위 내용을 새 파일로 저장하세요.',
  'deleted-present': '같은 경로에 파일이 다시 있습니다. 지금 파일은 Agent가 지운 내용과 다를 수 있어 여기서 고치지 않습니다.',
  'deleted-unknown': '이 경로를 다시 확인하지 못했습니다. 지운 파일은 여기서 되살리지 않습니다.',
  drifted: 'Agent가 고친 뒤 파일이 또 바뀌어 덩어리를 찾지 못했습니다.',
  'no-changes': '되돌릴 변경이 없습니다.',
})

/**
 * Stage 2 — review after apply.
 * service: {resolvePath, readFile, revertReviewed, deleteCreated}
 * changes: change records (see reviewTargetFromChange); rootId: the project
 * root the paths belong to. onOpenFile({path, line}) — optional.
 */
export function createChangeReview({ document, service, rootId, changes = [], makeOperationId, onState = () => {}, onOpenFile } = {}) {
  if (!document?.createElement) throw new TypeError('createChangeReview requires a document')
  if (!service || !['resolvePath', 'readFile', 'revertReviewed'].every(name => typeof service[name] === 'function')) throw new TypeError('createChangeReview requires file-service callbacks')
  const operationId = makeOperationId || (prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`)
  const element = el(document, 'section', 'egdesk-change-review')
  element.setAttribute('aria-label', '변경 검토')
  const summary = el(document, 'p', 'egdesk-change-review-summary')
  const list = el(document, 'div', 'egdesk-change-review-files')
  const undoButton = makeButton(document, '되돌리기 취소', 'egdesk-change-review-undo', () => act(undoLastRevert))
  undoButton.hidden = true
  const status = el(document, 'p', 'egdesk-change-review-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const error = el(document, 'p', 'egdesk-change-review-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  element.append(summary, undoButton, list, status, error)
  const files = changes.slice(0, CHANGE_REVIEW_LIMITS.maxFiles).map(change => ({ change, fileId: null, text: null, sha256: null, target: null, chunks: [], chunkStatus: 'empty', actions: null, selected: new Set(), confirmDelete: false, removed: false, conflict: null, deletion: null, node: null }))
  let lastRevert = null
  let disposed = false

  const announce = message => { status.textContent = message; onState(snapshot()) }
  const showError = cause => {
    error.textContent = cause?.code === 'SOURCE_CHANGED' ? '파일이 열 때와 달라 쓰지 않았습니다. 다시 읽은 내용과의 비교를 아래에 보여 줍니다.' : cause?.code === 'CHUNK_DRIFT' ? '파일이 그 사이 바뀌어 덩어리를 찾지 못했습니다. 다시 읽어 왔습니다.' : cause?.message || String(cause)
    error.hidden = false
    announce('작업에 실패했습니다. 파일은 그대로입니다.')
  }
  async function act(work) { error.hidden = true; try { await work() } catch (cause) { showError(cause) } }
  const snapshot = () => ({ files: files.map(file => ({ path: file.target?.path || file.change?.path || '', change: file.target?.change || null, chunks: file.chunks.length, selected: [...file.selected], removed: file.removed, sha256: file.sha256, conflict: !!file.conflict, ...(file.deletion ? { deletion: file.deletion } : {}) })), canUndo: !!lastRevert })
  const shortHash = value => typeof value === 'string' && value ? value.slice(0, 12) : '확인 안 됨'
  // The helper's receipt (requested) and a fresh read of the file (observed)
  // are kept apart: the status line claims only what the re-read confirmed.
  const observedNote = (file, result, requested) => {
    if (file.sha256 == null) return `${requested} 요청은 끝났지만 파일을 다시 읽지 못해 결과를 확인하지 못했습니다.`
    if (result?.unchanged) return '이미 같은 내용이라 쓰지 않았습니다 · 파일을 다시 읽어 확인했습니다.'
    if (typeof result?.sha256 === 'string' && result.sha256 === file.sha256) return `${requested} · 파일을 다시 읽어 확인했습니다.`
    return `${requested} 요청은 끝났지만 다시 읽은 파일이 쓴 결과와 다릅니다. 지금 내용을 기준으로 다시 표시합니다.`
  }
  // D-X1: the conditional write refused because the file no longer hashes to
  // what this screen read. Nothing was written; the comparison is shown and
  // the undo baseline for that file is gone.
  const markConflict = (file, cause) => {
    file.conflict = { reviewedText: file.text, reviewedSha256: file.sha256, reportedSha256: typeof cause?.details?.currentSourceHash === 'string' ? cause.details.currentSourceHash : null }
    if (lastRevert?.fileId === file.fileId) lastRevert = null
  }

  async function loadFile(file) {
    file.selected.clear(); file.confirmDelete = false
    file.fileId = null; file.text = null; file.sha256 = null; file.deletion = null
    if (isDeletion(file.change)) {
      // A deletion has nothing to put back here (no overwrite, D-X1), but the
      // review still shows what was removed and whether the path is really
      // gone now — observed through the same root, never assumed.
      try { file.deletion = (await service.resolvePath({ rootId, path: reviewPathOf(file.change) }))?.kind === 'file' ? 'present' : 'gone' }
      catch (cause) { file.deletion = ['RESOURCE_UNAVAILABLE', 'UNKNOWN_RESOURCE', 'NOT_IN_ROOT'].includes(cause?.code) ? 'gone' : 'unknown' }
    } else if (!file.removed) {
      try {
        const found = await service.resolvePath({ rootId, path: reviewPathOf(file.change) })
        if (found?.kind === 'file') {
          const read = await service.readFile({ fileId: found.id })
          if (read?.kind === 'text') { file.fileId = found.id; file.text = read.text; file.sha256 = read.sha256 }
        }
      } catch {}
    }
    file.target = reviewTargetFromChange(file.change, file.text)
    const review = file.target.change === 'update' || file.target.change === 'rename'
      ? (file.target.beforeText == null ? { status: 'empty', chunks: [] } : reviewChunks(file.target.beforeText, file.text))
      : { status: 'empty', chunks: [] }
    file.chunks = review.chunks
    file.chunkStatus = review.status
    file.actions = reviewActions(file.target, file.text, file.chunks)
  }

  function isDeletion(change) {
    if (Object.hasOwn(change || {}, 'oldText') || Object.hasOwn(change || {}, 'newText')) return change.kind === 'delete' || (change.newText == null && typeof change.oldText === 'string')
    return normalizeChangeKind(change?.kind).type === 'delete'
  }

  function reviewPathOf(change) {
    const { movePath } = normalizeChangeKind(change?.kind)
    const moved = movePath || (typeof change?.diff === 'string' ? splitMovedTo(change.diff).movePath : null) || (typeof change?.movePath === 'string' && change.movePath ? change.movePath : null)
    return moved || change?.path || ''
  }

  function chunkLabel(chunk) {
    const where = chunk.removed && chunk.added ? `원본 ${chunk.baseStartLine}행 → 지금 ${chunk.currentStartLine}행`
      : chunk.added ? `지금 ${chunk.currentStartLine}행에 추가` : `원본 ${chunk.baseStartLine}행 삭제`
    return `${where} · +${chunk.added} ${MINUS}${chunk.removed}`
  }

  function renderFile(file, index) {
    const node = el(document, 'section', 'egdesk-change-review-file')
    node.dataset.change = file.target?.change || 'update'
    const path = file.target?.path || reviewPathOf(file.change)
    node.append(el(document, 'h3', 'egdesk-change-review-file-heading', `${path} · ${CHANGE_LABELS[file.target?.change] || CHANGE_LABELS.update}${file.removed ? ' · 삭제함' : ''}`))
    if (file.removed) return node
    if (file.conflict) {
      const conflict = el(document, 'section', 'egdesk-change-review-conflict')
      conflict.setAttribute('role', 'group')
      conflict.setAttribute('aria-label', '열 때와 다른 파일')
      const observed = file.sha256 ?? file.conflict.reportedSha256
      conflict.append(
        el(document, 'h4', 'egdesk-change-review-conflict-heading', '파일이 열 때와 다릅니다 · 되돌리지 않았습니다'),
        el(document, 'p', 'egdesk-change-review-conflict-text', `검토를 시작할 때 읽은 내용(−)과 지금 파일(+)의 차이입니다. 원본은 그대로입니다. 해시 ${shortHash(file.conflict.reviewedSha256)} → ${shortHash(observed)}`))
      if (typeof file.conflict.reviewedText === 'string' && typeof file.text === 'string') {
        conflict.append(renderDiffView({ document, files: [fileDiffFromTexts({ path, oldText: file.conflict.reviewedText, newText: file.text })], openFiles: 1 }))
      } else conflict.append(el(document, 'p', 'egdesk-change-review-note', '지금 파일을 읽지 못해 비교를 보여 주지 못했습니다.'))
      conflict.append(makeButton(document, '지금 내용으로 계속', 'egdesk-change-review-conflict-continue', () => { file.conflict = null; rerender(index); announce('지금 파일 내용을 기준으로 검토합니다.') }))
      node.append(conflict)
    }
    if (typeof onOpenFile === 'function' && file.fileId) node.append(makeButton(document, '파일 열기', 'egdesk-change-review-open', () => onOpenFile({ path, line: file.chunks[0]?.currentStartLine || 1 })))
    const before = file.target?.change === 'add' ? null : file.target?.beforeText
    if (file.target && (before != null || file.text != null)) {
      const diff = fileDiffFromTexts({ path, oldText: file.target.change === 'add' ? null : before ?? '', newText: file.text ?? '', change: ['rename', 'delete'].includes(file.target.change) ? file.target.change : undefined })
      node.append(renderDiffView({ document, files: [diff], openFiles: 1 }))
    }
    const reason = file.deletion ? `deleted-${file.deletion}` : file.actions?.reason
    if (reason && REASON_NOTES[reason]) node.append(el(document, 'p', 'egdesk-change-review-note', REASON_NOTES[reason]))
    if (file.chunkStatus === 'too-large' || file.chunkStatus === 'timeout' || file.chunkStatus === 'binary') node.append(el(document, 'p', 'egdesk-change-review-note', '이 파일은 덩어리별로 나누지 못했습니다.'))
    if (file.actions?.revertChunks) {
      const chunkList = el(document, 'ol', 'egdesk-change-review-chunks')
      chunkList.setAttribute('aria-label', '덩어리')
      for (const chunk of file.chunks) {
        const row = el(document, 'li', 'egdesk-change-review-chunk')
        const label = chunkLabel(chunk)
        const pick = makeButton(document, '선택', 'egdesk-change-review-pick', () => {
          if (file.selected.has(chunk.index)) file.selected.delete(chunk.index); else file.selected.add(chunk.index)
          pick.setAttribute('aria-pressed', String(file.selected.has(chunk.index)))
          revertSelected.disabled = !file.selected.size
          onState(snapshot())
        })
        pick.setAttribute('aria-pressed', String(file.selected.has(chunk.index)))
        pick.setAttribute('aria-label', `${label} 선택`)
        const revertOne = makeButton(document, '되돌리기', 'egdesk-change-review-revert', () => act(() => revert(index, [chunk.index])))
        revertOne.setAttribute('aria-label', `${label} 되돌리기`)
        row.append(el(document, 'span', 'egdesk-change-review-chunk-label', label), pick, revertOne)
        chunkList.append(row)
      }
      const revertSelected = makeButton(document, '선택한 덩어리 되돌리기', 'egdesk-change-review-revert-selected', () => act(() => revert(index, [...file.selected])))
      revertSelected.disabled = !file.selected.size
      node.append(chunkList, revertSelected)
    }
    if (file.actions?.deleteFile && typeof service.deleteCreated === 'function') {
      if (!file.confirmDelete) {
        node.append(makeButton(document, '파일 삭제 제안', 'egdesk-change-review-delete', () => { file.confirmDelete = true; rerender(index); announce('삭제할지 확인해 주세요.') }))
      } else {
        const confirm = el(document, 'div', 'egdesk-change-review-delete-confirm')
        confirm.setAttribute('role', 'group')
        confirm.setAttribute('aria-label', '파일 삭제 확인')
        confirm.append(
          el(document, 'p', 'egdesk-change-review-delete-question', 'Agent가 만든 그대로인 이 파일을 지울까요?'),
          makeButton(document, '삭제', 'egdesk-change-review-delete-yes', () => act(() => deleteFile(index))),
          makeButton(document, '취소', 'egdesk-change-review-delete-no', () => { file.confirmDelete = false; rerender(index); announce('삭제하지 않았습니다.') }))
        node.append(confirm)
      }
    }
    return node
  }

  function rerender(index) {
    const file = files[index]
    const next = renderFile(file, index)
    const children = [...list.children]
    const at = file.node ? children.indexOf(file.node) : -1
    if (at >= 0) { children[at] = next; list.replaceChildren(...children) }
    else list.append(next)
    file.node = next
  }

  function renderSummary() {
    const total = files.reduce((sum, file) => sum + file.chunks.length, 0)
    const deleted = files.filter(file => file.target?.change === 'delete').length
    summary.textContent = files.length ? `파일 ${files.length}개 · 덩어리 ${total}개${deleted ? ` · 삭제 ${deleted}개` : ''}` : '검토할 변경이 없습니다.'
    undoButton.hidden = !lastRevert
  }

  async function load() {
    for (const file of files) await loadFile(file)
    if (disposed) return snapshot()
    list.replaceChildren()
    files.forEach((file, index) => { file.node = null; rerender(index) })
    renderSummary()
    announce('변경 검토를 열었습니다.')
    return snapshot()
  }

  async function reloadFile(index) {
    await loadFile(files[index])
    rerender(index)
    renderSummary()
  }

  async function revert(index, chunkIndexes) {
    const file = files[index]
    if (!file?.actions?.revertChunks || !file.fileId || !chunkIndexes.length) return null
    let text
    try { text = revertChunks(file.text, file.chunks, chunkIndexes) }
    catch (cause) { await reloadFile(index); throw cause }
    const previous = { text: file.text, sha256: file.sha256 }
    let result
    try { result = await service.revertReviewed({ fileId: file.fileId, expectedSha256: file.sha256, text, operationId: operationId('review-revert') }) }
    catch (cause) {
      if (cause?.code === 'SOURCE_CHANGED') { markConflict(file, cause); await reloadFile(index) }
      throw cause
    }
    file.conflict = null
    lastRevert = { index, fileId: file.fileId, previousText: previous.text, previousSha256: previous.sha256, sha256: result?.sha256 }
    await reloadFile(index)
    // Undo is offered only against a result the re-read actually confirmed.
    if (result?.unchanged || typeof result?.sha256 !== 'string' || file.sha256 !== result.sha256) lastRevert = null
    renderSummary()
    announce(observedNote(file, result, `덩어리 ${chunkIndexes.length}개를 되돌렸습니다`))
    return result
  }

  async function undoLastRevert() {
    if (!lastRevert) return null
    const { index, previousText, sha256 } = lastRevert
    const file = files[index]
    if (!file?.fileId) { lastRevert = null; renderSummary(); return null }
    let result
    try { result = await service.revertReviewed({ fileId: file.fileId, expectedSha256: sha256, text: previousText, operationId: operationId('review-undo') }) }
    catch (cause) {
      if (cause?.code === 'SOURCE_CHANGED') { markConflict(file, cause); await reloadFile(index) }
      throw cause
    }
    lastRevert = null
    file.conflict = null
    await reloadFile(index)
    announce(observedNote(file, result, '되돌리기를 취소했습니다'))
    return result
  }

  async function deleteFile(index) {
    const file = files[index]
    if (!file?.actions?.deleteFile || !file.fileId || typeof service.deleteCreated !== 'function') return null
    let result
    try { result = await service.deleteCreated({ fileId: file.fileId, expectedSha256: file.sha256, operationId: operationId('review-delete') }) }
    catch (cause) {
      if (cause?.code === 'SOURCE_CHANGED') { markConflict(file, cause); await reloadFile(index) }
      throw cause
    }
    if (lastRevert?.index === index) lastRevert = null
    // Observed, not assumed: the path must no longer resolve to a file.
    let observed = 'gone'
    try { observed = (await service.resolvePath({ rootId, path: reviewPathOf(file.change) }))?.kind === 'file' ? 'present' : 'gone' }
    catch (cause) { observed = ['RESOURCE_UNAVAILABLE', 'UNKNOWN_RESOURCE', 'NOT_IN_ROOT'].includes(cause?.code) ? 'gone' : 'unknown' }
    if (observed === 'present') {
      await reloadFile(index)
      announce('삭제 요청은 끝났지만 파일이 아직 있습니다. 지금 내용을 기준으로 다시 표시합니다.')
      return result
    }
    file.removed = true
    file.chunks = []
    file.actions = null
    file.conflict = null
    rerender(index)
    renderSummary()
    announce(observed === 'gone' ? 'Agent가 만든 파일을 지웠습니다 · 파일이 더 이상 없는 것을 확인했습니다.' : 'Agent가 만든 파일 삭제 요청은 끝났지만 결과를 다시 읽어 확인하지 못했습니다.')
    return result
  }

  return {
    element, load, snapshot,
    revert: (index, chunkIndexes) => revert(index, chunkIndexes),
    undoLastRevert, deleteFile,
    dispose() { disposed = true; element.remove?.() },
  }
}
