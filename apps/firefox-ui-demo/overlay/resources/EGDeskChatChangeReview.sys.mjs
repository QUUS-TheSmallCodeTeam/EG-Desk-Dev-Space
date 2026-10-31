// Read-only, on-demand presentation of one chat item's retained changes.
// No approval decisions, filesystem reads/writes, rollback, or chat storage.
import { DIFF_VIEW_LIMITS, diffViewFromRunChanges, fileDiffsFromUnifiedDiff, renderDiffView } from './EGDeskDiffView.sys.mjs'
import { renderApprovalChanges } from './EGDeskChangeReview.mjs'

const NOTES = Object.freeze({
  idle: '이 항목에 보존된 변경 내용만 불러옵니다.',
  loading: '변경 내용을 불러오는 중입니다.',
  unavailable: '이 항목의 변경 내용을 확인할 수 없습니다.',
  missing: '이 항목의 변경 기록이 없습니다. 다른 항목의 변경 내용으로 대신 표시하지 않습니다.',
  'not-retained': '이 실행의 변경 내용이 더 이상 보존되어 있지 않습니다. 현재 파일 내용으로 대신 표시하지 않습니다.',
  empty: '이 항목에 표시할 변경 내용이 보존되어 있지 않습니다.',
  omitted: '일부 변경 내용은 보존되지 않았거나 표시 범위를 넘었습니다.',
  stale: '대화 또는 실행 상태가 바뀌었습니다. 해당 항목을 다시 열어 확인하세요.',
  readonly: '보존된 변경 기록 · 읽기 전용. 일부 내용이 가려질 수 있으며 현재 파일이나 적용 완료를 확인한 결과는 아닙니다.',
  'open-failed': '파일 위치를 확인해 열지 못했습니다.',
  'review-hint': '적용된 변경을 File 창에서 다시 읽어 덩어리별로 되돌릴 수 있습니다.',
  'review-opening': '이 실행의 연결을 다시 확인하고 현재 파일을 여는 중입니다.',
  'review-opened': '별도 File 창에서 현재 파일을 다시 읽어 덩어리별 되돌리기를 열었습니다. 위 기록은 당시 내용입니다.',
  'review-unavailable': '현재 파일을 열지 못했습니다. 보존된 기록은 유지됩니다. 실행의 현재 연결을 확인해 주세요.',
})

const validId = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 300 && !value.includes('\0')
function targetOf(value) {
  if (!['conversationId', 'runId', 'itemId'].every(key => validId(value?.[key]))) return null
  return Object.freeze({ conversationId: value.conversationId, runId: value.runId, itemId: value.itemId })
}

function retainedFileModel(file, source) {
  if (source.omitted || typeof source.diff !== 'string' || source.diff.length === 0) return file
  const raw = () => source.diff.length > DIFF_VIEW_LIMITS.maxRawChars
    ? `${source.diff.slice(0, DIFF_VIEW_LIMITS.maxRawChars)}\n…` : source.diff
  // Keep textual binary metadata visible, but never dump binary file bytes.
  if (file.status === 'binary') return source.diff.includes('\0') ? file : { ...file, raw: raw() }
  if (file.status !== 'empty') return file

  // The item parser accepts arbitrary preamble text as zero hunks. Nonempty
  // retained text is not proof of "no changes". The unified parser can also
  // recognize valid hunkless git rename/copy/mode records before we use the
  // bounded, read-only raw fallback for unrenderable text (even whitespace).
  const metadata = fileDiffsFromUnifiedDiff(source.diff, { path: source.path })
  if (metadata.length === 1 && metadata[0].status === 'ok' && metadata[0].hunks.length === 0) {
    // Metadata paths remain literal evidence in raw text, not file-opening
    // targets. Keep the item row's display path and grant no new authority.
    return { ...file, change: metadata[0].change, status: 'ok', oldPath: null, newPath: null, raw: raw() }
  }
  return { ...file, status: 'unparsable', raw: raw() }
}

// Match before parsing. Never substitute the turn-wide diff, another item
// with the same path, or a live file for a missing retained item.
function selectedItem(packet, target) {
  if (!packet || packet.conversationId !== target.conversationId || packet.runId !== target.runId || packet.protocolVersion !== 1) return { state: 'unavailable' }
  if (packet.retained === false) return { state: 'not-retained' }
  if (packet.retained !== true || !Array.isArray(packet.items)) return { state: 'unavailable' }
  const matches = packet.items.filter(item => item?.itemId === target.itemId)
  if (!matches.length) return { state: 'missing' }
  if (matches.length !== 1 || !Array.isArray(matches[0].files)) return { state: 'unavailable' }
  const source = matches[0]
  if (!source.files.length) return { state: source.truncated ? 'omitted' : 'empty' }
  if (source.files.some(file => !file || typeof file.path !== 'string' || !file.path)) return { state: 'unavailable' }
  const files = source.files.slice(0, DIFF_VIEW_LIMITS.maxFiles).map(file => {
    // An omission takes precedence even if a malformed packet also supplies
    // text. Missing text is unavailable, not an empty/no-change document.
    const kept = file.omitted == null && typeof file.diff === 'string'
    return {
      path: file.path, kind: file.kind, movePath: file.movePath,
      diff: kept ? file.diff : null,
      omitted: kept ? null : ['fileLimit', 'runLimit', 'turnLimit'].includes(file.omitted) ? file.omitted : 'unavailable',
    }
  })
  const item = { itemId: target.itemId, status: source.status, truncated: source.truncated === true || source.files.length > files.length, files }
  const model = diffViewFromRunChanges({ retained: true, items: [item], turn: null }).items[0]
  const displayedFiles = model.files.map((file, index) => retainedFileModel(file, files[index]))
  const incomplete = item.truncated || files.some(file => file.omitted) || model.files.some(file => file.truncated)
  return { state: incomplete ? 'omitted' : 'ready', item, files: displayedFiles }
}

/**
 * fetchRunChanges({conversationId, runId, itemId}) -> decoded GET
 * /chat/run-changes packet. The host injects transport; this module never
 * calls the network or stores output in chat state.
 *
 * isCurrent(target) must confirm the ORIGINAL conversation/run/item still
 * owns the visible card (and, for approvals, that its request is still valid).
 * renderApproval(target) / renderActivity(target) return lazy <section>s.
 * Both fetch only when the person opens their <details>. Closing discards
 * the rendered text; reopening refetches. invalidate() retires existing
 * cards; dispose() also prevents creating more cards.
 *
 * Optional activity-only file opening: getVerifiedOrigin(target) must be a
 * trusted synchronous resolver returning {verified:true, conversationId,
 * runId, rootId, projectId?}, backed by independently verified run origin.
 * No origin is inferred from paths, a selected Board, or this diff packet.
 * Without it, even onOpenFile alone produces NO file-opening buttons.
 * onOpenFile({...target, path, line, origin}) must verify that path against
 * that origin before opening, rechecking the original target after any
 * asynchronous verification. No FileView or generic Browser opener is used.
 *
 * Optional stage 2 (D-X2 적용 후 덩어리별 되돌리기), activity cards only:
 * readOrigin(target, {signal}) and onReviewApplied(request) come as a pair,
 * like EGDeskChatRunResult's. renderActivity(target, {applied}) says the host
 * saw the change item complete; a retained item marked completed counts too.
 * The card then offers one button that hands the ORIGINAL IDs and the
 * retained change rows to onReviewApplied({target, changes, readOrigin,
 * isCurrent}). The host must re-verify the run origin through readOrigin,
 * re-read every file and own every revert (D-X1); this module still never
 * reads or writes a file, and the retained rows are display evidence only.
 */
export function createChatChangeReview({ document, fetchRunChanges, isCurrent, onOpenFile = null, getVerifiedOrigin = null, readOrigin = null, onReviewApplied = null } = {}) {
  if (!document?.createElement || typeof fetchRunChanges !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Chat change review requires a document, fetchRunChanges and isCurrent')
  if ([onOpenFile, getVerifiedOrigin, readOrigin, onReviewApplied].some(hook => hook !== null && typeof hook !== 'function')) throw new TypeError('File opening, verified-origin and applied-review hooks must be functions')
  const reviewHooks = typeof readOrigin === 'function' && typeof onReviewApplied === 'function'
  const cards = new Set()
  let disposed = false
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    node.className = className
    if (text != null) node.textContent = text
    return node
  }
  const note = state => el('p', 'egdesk-chat-change-note', NOTES[state])
  const originFor = target => {
    if (!onOpenFile || !getVerifiedOrigin) return null
    try {
      const origin = getVerifiedOrigin(target)
      if (origin?.verified !== true || origin.conversationId !== target.conversationId || origin.runId !== target.runId || !validId(origin.rootId) || (origin.projectId != null && !validId(origin.projectId))) return null
      return Object.freeze({ verified: true, conversationId: target.conversationId, runId: target.runId, rootId: origin.rootId, ...(origin.projectId != null ? { projectId: origin.projectId } : {}) })
    } catch { return null }
  }

  function render(kind, requestedTarget, options = {}) {
    if (disposed) throw new Error('Chat change review is disposed')
    const target = targetOf(requestedTarget)
    const applied = options?.applied === true
    const node = el('section', `egdesk-chat-change-review${kind === 'approval' ? ' egdesk-change-approval' : ''}`)
    node.setAttribute('data-kind', kind)
    const details = el('details', kind === 'approval' ? 'egdesk-change-approval-details' : 'egdesk-chat-change-details')
    const summary = el('summary', kind === 'approval' ? 'egdesk-change-approval-summary' : 'egdesk-chat-change-summary', '변경 보기')
    const content = el('div', 'egdesk-chat-change-content')
    content.setAttribute('aria-live', 'polite')
    const state = { target, node, details, content, retired: false, sequence: 0, loading: false }
    const showState = value => { node.setAttribute('data-state', value); content.replaceChildren(note(value)) }
    showState(target ? 'idle' : 'unavailable')
    details.append(summary, content)
    node.append(details)
    if (target) for (const [key, value] of Object.entries(target)) node.setAttribute(`data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`, value)

    const ownsCard = () => {
      if (disposed || state.retired || !target || node.isConnected !== true) return false
      try { return isCurrent(target) === true } catch { return false }
    }
    const current = sequence => ownsCard() && details.open === true && sequence === state.sequence
    const stale = sequence => {
      if (!disposed && !state.retired && sequence === state.sequence) showState('stale')
    }
    const openFile = (origin, sequence) => async location => {
      if (!current(sequence) || JSON.stringify(originFor(target)) !== JSON.stringify(origin)) return
      try { await onOpenFile({ ...target, path: location.path, line: location.line, origin }) }
      catch { if (current(sequence)) content.append(note('open-failed')) }
    }
    // Stage 2 entry: the host receives the retained rows and the original IDs
    // and does the verified re-read and revert elsewhere (File Card). Fenced
    // by the same card ownership as file opening; nothing is cached here.
    const appliedReviewActions = (sequence, rows) => {
      const box = el('div', 'egdesk-chat-change-review-actions')
      const button = el('button', 'egdesk-chat-change-review-open', '적용된 변경 검토 · 되돌리기')
      button.type = 'button'
      const hint = el('p', 'egdesk-chat-change-note egdesk-chat-change-review-note', NOTES['review-hint'])
      const changes = Object.freeze(rows.map(row => Object.freeze({ path: row.path, kind: row.kind ?? 'update', movePath: typeof row.movePath === 'string' ? row.movePath : null, diff: row.diff, omitted: null })))
      let opening = false
      button.addEventListener('click', async () => {
        if (opening || !current(sequence)) return
        opening = true
        button.disabled = true
        hint.textContent = NOTES['review-opening']
        const stillCurrent = candidate => current(sequence) && ['conversationId', 'runId', 'itemId'].every(key => candidate?.[key] === target[key])
        try {
          const opened = await onReviewApplied({ target, changes, readOrigin, isCurrent: stillCurrent })
          if (current(sequence)) hint.textContent = NOTES[opened?.status === 'opened' ? 'review-opened' : 'review-unavailable']
        } catch { if (current(sequence)) hint.textContent = NOTES['review-unavailable'] }
        finally { opening = false; if (current(sequence)) button.disabled = false }
      })
      box.append(button, hint)
      return box
    }

    async function load() {
      if (!target || state.retired || disposed) return
      if (!details.open) {
        state.sequence++
        state.loading = false
        summary.textContent = '변경 보기'
        showState('idle')
        return
      }
      if (state.loading) return
      const sequence = ++state.sequence
      if (!ownsCard()) { stale(sequence); return }
      state.loading = true
      showState('loading')
      try {
        const packet = await fetchRunChanges(target)
        if (!current(sequence)) { stale(sequence); return }
        const selected = selectedItem(packet, target)
        if (!selected.item) { showState(selected.state); return }
        content.replaceChildren(note('readonly'))
        if (selected.state === 'omitted') content.append(note('omitted'))
        if (kind === 'approval') {
          // Deliberately no onDecision: the existing approvalRequestFor /
          // replyPending path remains the sole owner of every decision.
          const rendered = renderApprovalChanges({ document, item: selected.item })
          const renderedDetails = rendered.querySelector('.egdesk-change-approval-details')
          const renderedSummary = renderedDetails?.querySelector('summary')
          if (!renderedDetails || !renderedSummary) throw new Error('Approval presentation unavailable')
          summary.textContent = renderedSummary.textContent
          // Keep the production approval wording and render the normalized
          // read-only model, so its reparse cannot restore a false "empty".
          // No decision or file-opening callbacks enter either renderer.
          content.append(renderDiffView({ document, files: selected.files, openFiles: 1 }))
        } else {
          const origin = originFor(target)
          content.append(renderDiffView({ document, files: selected.files, ...(origin ? { onOpenFile: openFile(origin, sequence) } : {}) }))
          // Only an applied change can be put back; omitted rows carry no text
          // to review and a declined/failed item changed nothing.
          const reviewable = reviewHooks && (applied || selected.item.status === 'completed') && !['failed', 'declined'].includes(selected.item.status)
            ? selected.item.files.filter(file => file.omitted == null && typeof file.diff === 'string' && file.path) : []
          if (reviewable.length) content.append(appliedReviewActions(sequence, reviewable))
        }
        node.setAttribute('data-state', selected.state)
      } catch {
        if (current(sequence)) showState('unavailable')
        else stale(sequence)
      } finally {
        if (sequence === state.sequence) state.loading = false
      }
    }
    state.retire = () => {
      state.retired = true
      state.sequence++
      details.removeEventListener('toggle', load)
      details.open = false
      summary.textContent = '변경 보기'
      showState('stale')
    }
    details.addEventListener('toggle', load)
    cards.add(state)
    return node
  }

  function invalidate() {
    for (const card of cards) card.retire()
    cards.clear()
  }
  return Object.freeze({
    renderApproval: target => render('approval', target),
    renderActivity: (target, options) => render('activity', target, options),
    invalidate,
    dispose() { invalidate(); disposed = true },
  })
}
