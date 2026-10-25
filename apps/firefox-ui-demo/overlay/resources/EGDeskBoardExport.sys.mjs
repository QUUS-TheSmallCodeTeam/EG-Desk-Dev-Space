// Saved Board -> JSON Canvas workflow. No DOM, picker, filesystem, auto-save,
// auth, or Desk mutation. All messages/notes are plain text for textContent.
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAVED_ONLY_NOTE = '저장된 Board만 내보냅니다. 미저장 변경은 포함하지 않습니다.'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** A portable basename only, never a path; preserve the .canvas extension. */
export function boardCanvasFilename(title) {
  let base = (typeof title === 'string' ? title : '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '-')
    .replace(/\s+/g, ' ').trim().replace(/(?:\.canvas)+$/i, '').replace(/^[. ]+|[. ]+$/g, '')
  const encoder = new TextEncoder()
  let bytes = 0, bounded = ''
  for (const char of Array.from(base).slice(0, 80)) {
    const size = encoder.encode(char).length
    if (bytes + size > 180) break
    bounded += char; bytes += size
  }
  base = bounded.replace(/[. ]+$/g, '') || 'Board'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `Board-${base}`
  return `${base}.canvas`
}

function exportPayload(packet) {
  if (!object(packet?.canvas) || !Array.isArray(packet.canvas.nodes) || !Array.isArray(packet.canvas.edges)
      || !object(packet.report) || packet.report.nodes !== packet.canvas.nodes.length || packet.report.edges !== packet.canvas.edges.length
      || !Array.isArray(packet.report.omitted) || packet.report.omitted.some(item => !object(item)
        || !(item.id === null || typeof item.id === 'string') || typeof item.kind !== 'string' || typeof item.reason !== 'string')) {
    throw new Error('Invalid Board export response')
  }
  // Snapshot the response before opening a picker; no later mutation of the
  // request adapter's object can change what this click will write.
  const text = `${JSON.stringify(packet.canvas, null, 2)}\n`
  const canvas = JSON.parse(text)
  const report = { nodes: packet.report.nodes, edges: packet.report.edges,
    omitted: packet.report.omitted.map(({ id, kind, reason }) => ({ id, kind, reason })) }
  const excluded = canvas.nodes.filter(node => node?.egdesk?.omitted === 'attachment').length
  const notes = [
    SAVED_ONLY_NOTE,
    'Browser는 링크, 결과·메모는 텍스트, 일부 도형은 그룹·연결선으로 변환됩니다. 모든 Board 기능이 그대로 이동하지는 않습니다.',
    excluded ? `첨부·캡처 ${excluded}개의 원본은 제외하고 이름만 포함했습니다.` : '첨부·캡처 원본은 기본적으로 제외됩니다.',
  ]
  if (report.omitted.length) notes.push(`JSON Canvas에서 직접 표시되지 않는 항목 ${report.omitted.length}개가 있습니다. 변환 보고서를 확인하세요.`)
  return { text, report, notes }
}

/**
 * createEGDeskBoardExport({request, saveText, onState})
 * request(path, {method:'GET', signal}) -> unwrapped {canvas, report}; reject
 * non-2xx responses with {code}. No request body or extra export options.
 * saveText({fileName, text, contentType, signal, beginWrite}) -> {saved:true}
 * or {cancelled:true}. After the user chooses a destination, call beginWrite()
 * immediately BEFORE writing. If false, write nothing. A cancelled receipt
 * certifies zero writes. Do not auto-save the Board or retry a failed write.
 *
 * exportBoard({boardId,title,hasStoredBoard,hasUnsavedChanges}) snapshots the
 * clicked projection. hasStoredBoard must be explicitly true. Unsaved edits
 * do NOT block this saved-copy action: the GET still exports only stored data,
 * and states retain the unsaved-excluded note even when dirty state is unknown.
 * Duplicate clicks share the in-flight promise. Call invalidate() on view
 * rebinding, Board deletion or saved-head changes, and dispose() when the bound
 * view is destroyed (not merely when its popup menu closes). Late responses
 * cannot update a newer view. Camera changes and unsaved editing alone need
 * not invalidate a saved-copy export. cancel()/dispose() also fence writes. A write already granted
 * cannot be rolled back: interruption then returns unknown, never cancelled.
 * onState and snapshot() expose frozen plain data (no canvas contents/paths).
 */
export function createEGDeskBoardExport({ request, saveText, onState = () => {} } = {}) {
  if (typeof request !== 'function' || typeof saveText !== 'function' || typeof onState !== 'function') throw new TypeError('Board export requires request, saveText and onState callbacks')
  let active = null, generation = 0, disposed = false
  let state = freeze({ status: 'idle', boardId: null, fileName: null, message: '', notes: [], report: null })
  const publish = next => {
    state = freeze(next)
    // A presentation callback cannot turn a completed write into a failure or
    // trigger an automatic retry by throwing.
    try { onState(state) } catch {}
    return state
  }
  const current = run => active === run && !run.finished && !disposed && generation === run.generation
  const outcome = (run, status, code, message) => freeze({ status, code, message, boardId: run.boardId,
    fileName: run.fileName, report: run.report, notes: run.notes })
  const finish = (run, status, code, message, notify = true) => {
    if (run.finished) return
    run.finished = true
    if (active === run) active = null
    const result = outcome(run, status, code, message)
    if (notify) publish(result)
    run.resolve(result)
  }
  const stop = (status, notify = true) => {
    const run = active
    if (!run) return state
    const uncertain = run.writeStarted
    finish(run, uncertain ? 'unknown' : status, uncertain ? 'BOARD_EXPORT_WRITE_UNCONFIRMED' : `BOARD_EXPORT_${status.toUpperCase()}`,
      uncertain ? '파일 쓰기가 시작된 뒤 결과를 확인하지 못했습니다. 자동으로 다시 저장하지 않습니다.'
        : status === 'stale' ? '화면 연결이 바뀌어 내보내기를 중단했습니다. 파일을 쓰지 않았습니다.' : '내보내기를 취소했습니다. 파일을 쓰지 않았습니다.', notify)
    run.controller.abort()
    return state
  }
  const perform = async run => {
    try {
      if (!current(run)) return
      const packet = await request(`/v1/boards/${encodeURIComponent(run.boardId)}/export?format=json-canvas`, { method: 'GET', signal: run.controller.signal })
      if (!current(run)) return
      if (packet?.code === 'BOARD_NOT_FOUND') {
        finish(run, 'needs-save', 'BOARD_EXPORT_NEEDS_SAVE', '먼저 이 Board를 저장한 뒤 다시 내보내세요. 자동으로 저장하지 않습니다.'); return
      }
      let payload
      try { payload = exportPayload(packet) }
      catch { finish(run, 'failed', 'BOARD_EXPORT_RESPONSE_INVALID', 'Board 변환 결과를 확인하지 못했습니다. 파일을 쓰지 않았습니다.'); return }
      run.report = payload.report; run.notes = payload.notes
      publish(outcome(run, 'saving', null, '파일 저장 위치를 선택하세요.'))
      if (!current(run)) return
      run.saveInvoked = true
      const receipt = await saveText(Object.freeze({ fileName: run.fileName, text: payload.text, contentType: 'application/json; charset=utf-8',
        signal: run.controller.signal, beginWrite: () => {
          if (!current(run) || run.writeStarted) return false
          run.writeStarted = true
          return true
        } }))
      if (!current(run)) return
      if (receipt?.saved === true && receipt.cancelled !== true && run.writeStarted) {
        finish(run, 'saved', null, 'JSON Canvas 파일을 저장했습니다.')
      } else if (receipt?.cancelled === true && receipt.saved !== true && !run.writeStarted) {
        finish(run, 'cancelled', 'BOARD_EXPORT_CANCELLED', '내보내기를 취소했습니다. 파일을 쓰지 않았습니다.')
      } else {
        finish(run, run.writeStarted || receipt?.saved === true ? 'unknown' : 'failed', 'BOARD_EXPORT_SAVE_UNCONFIRMED', '파일 저장을 확인하지 못했습니다. 자동으로 다시 저장하지 않습니다.')
      }
    } catch (error) {
      if (!current(run)) return
      if (!run.saveInvoked && error?.code === 'BOARD_NOT_FOUND') {
        finish(run, 'needs-save', 'BOARD_EXPORT_NEEDS_SAVE', '먼저 이 Board를 저장한 뒤 다시 내보내세요. 자동으로 저장하지 않습니다.')
      } else {
        finish(run, run.writeStarted ? 'unknown' : 'failed', run.writeStarted ? 'BOARD_EXPORT_WRITE_UNCONFIRMED' : 'BOARD_EXPORT_FAILED',
          run.writeStarted ? '파일 쓰기 결과를 확인하지 못했습니다. 자동으로 다시 저장하지 않습니다.' : '내보내기를 완료하지 못했습니다. 자동으로 다시 시도하지 않습니다.')
      }
    }
  }
  const exportBoard = (projection = {}) => {
    if (disposed) return Promise.resolve(state)
    if (active) return active.promise
    const boardId = typeof projection?.boardId === 'string' ? projection.boardId : null
    const run = { boardId, fileName: boardCanvasFilename(projection?.title), generation, controller: new AbortController(),
      writeStarted: false, saveInvoked: false, finished: false, report: null, notes: [SAVED_ONLY_NOTE] }
    run.promise = new Promise(resolve => { run.resolve = resolve })
    active = run
    if (!boardId || !BOARD_ID.test(boardId)) finish(run, 'failed', 'BOARD_EXPORT_INPUT', '내보낼 Board를 먼저 선택하세요.')
    else if (projection.hasStoredBoard !== true) {
      finish(run, 'needs-save', 'BOARD_EXPORT_NEEDS_SAVE', '먼저 이 Board를 저장한 뒤 다시 내보내세요. 자동으로 저장하지 않습니다.')
    } else {
      publish(outcome(run, 'fetching', null, '저장된 Board를 변환하고 있습니다.'))
      void perform(run)
    }
    return run.promise
  }
  return Object.freeze({ exportBoard, snapshot: () => state,
    cancel: () => stop('cancelled'),
    invalidate: () => {
      if (disposed) return state
      generation++; stop('stale', false)
      return publish({ status: 'idle', boardId: null, fileName: null, message: '', notes: [], report: null })
    },
    dispose: () => {
      if (disposed) return state
      generation++; disposed = true; stop('stale', false)
      return publish({ status: 'disposed', boardId: null, fileName: null, message: '', notes: [], report: null })
    },
  })
}
