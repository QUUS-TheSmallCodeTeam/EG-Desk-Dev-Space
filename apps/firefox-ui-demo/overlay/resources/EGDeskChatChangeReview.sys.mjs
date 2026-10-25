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
 */
export function createChatChangeReview({ document, fetchRunChanges, isCurrent, onOpenFile = null, getVerifiedOrigin = null } = {}) {
  if (!document?.createElement || typeof fetchRunChanges !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Chat change review requires a document, fetchRunChanges and isCurrent')
  if ((onOpenFile !== null && typeof onOpenFile !== 'function') || (getVerifiedOrigin !== null && typeof getVerifiedOrigin !== 'function')) throw new TypeError('File opening and verified-origin hooks must be functions')
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

  function render(kind, requestedTarget) {
    if (disposed) throw new Error('Chat change review is disposed')
    const target = targetOf(requestedTarget)
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
    renderActivity: target => render('activity', target),
    invalidate,
    dispose() { invalidate(); disposed = true },
  })
}
