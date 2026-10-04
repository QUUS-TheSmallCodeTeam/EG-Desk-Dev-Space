// Presentation controller only: the backend owns snapshots, encrypted staging,
// atomic publication and import transactions. Passwords and source bytes are
// deliberately absent from snapshots and callbacks.
export function createEGDeskPortableState({ bundleService, chooseExportSink, chooseImportSource, onState = () => {} }) {
  if (!bundleService || !['planExport', 'exportPlan', 'cancelExport', 'inspectImport', 'applyNewCopy', 'cancelImport'].every(name => typeof bundleService[name] === 'function')) {
    throw new Error('Portable state requires bundle-service callbacks')
  }
  let state = { phase: 'idle', exportPreview: null, importPreview: null, receipt: null, error: null }
  let generation = 0
  let activeAbort = null
  const snapshot = () => ({ ...state, exportPreview: state.exportPreview && { ...state.exportPreview }, importPreview: state.importPreview && { ...state.importPreview }, receipt: state.receipt && { ...state.receipt } })
  const publish = patch => { state = { ...state, ...patch }; onState(snapshot()); return snapshot() }
  const fail = error => publish({ phase: 'failed', error: error?.message || String(error) })
  const current = epoch => epoch === generation

  async function clearPreviews() {
    const priorExport = state.exportPreview?.planId
    const priorImport = state.importPreview?.importId
    publish({ exportPreview: null, importPreview: null })
    await Promise.all([
      priorExport ? bundleService.cancelExport({ planId: priorExport }) : null,
      priorImport ? bundleService.cancelImport({ importId: priorImport }) : null,
    ])
  }

  async function prepareExport(rootIds) {
    const epoch = ++generation
    activeAbort?.abort()
    activeAbort = new AbortController()
    await clearPreviews()
    publish({ phase: 'export-preparing', error: null, receipt: null })
    try {
      const preview = await bundleService.planExport({ rootIds, signal: activeAbort.signal })
      if (!current(epoch)) { await bundleService.cancelExport({ planId: preview.planId }); return snapshot() }
      return publish({ phase: 'export-ready', exportPreview: preview })
    } catch (error) { if (current(epoch)) return fail(error); return snapshot() }
  }

  async function publishExport({ password, plainAcknowledged = false } = {}) {
    const preview = state.exportPreview
    if (!preview || state.phase !== 'export-ready') throw new Error('내보내기 미리보기를 먼저 확인하세요.')
    if (password == null && plainAcknowledged !== true) throw new Error('암호화하지 않은 파일의 노출 범위를 명시적으로 확인해야 합니다.')
    if (password != null && (typeof password !== 'string' || !password)) throw new Error('암호가 필요합니다.')
    if (typeof chooseExportSink !== 'function') throw new Error('저장 위치 선택기가 연결되지 않았습니다.')
    const epoch = ++generation
    activeAbort = new AbortController()
    try {
      const sink = await chooseExportSink({ extension: '.egdesk', encrypted: password != null, createOnly: true })
      if (!current(epoch)) return snapshot()
      if (!sink) return publish({ phase: 'export-ready' })
      publish({ phase: 'exporting', error: null })
      const receipt = await bundleService.exportPlan({ planId: preview.planId, sink, password, signal: activeAbort.signal })
      if (!current(epoch)) return snapshot()
      return publish({ phase: 'export-published', exportPreview: null, receipt })
    } catch (error) {
      if (!current(epoch)) return snapshot()
      if (state.phase === 'export-cancel-requested' && (error?.code === 'CANCELLED' || error?.name === 'AbortError')) return publish({ phase: 'idle', exportPreview: null, error: null })
      publish({ exportPreview: null })
      return fail(error)
    }
  }

  async function inspectSelectedImport({ password } = {}) {
    if (typeof chooseImportSource !== 'function') throw new Error('가져오기 파일 선택기가 연결되지 않았습니다.')
    const epoch = ++generation
    activeAbort?.abort()
    activeAbort = new AbortController()
    await clearPreviews()
    try {
      const source = await chooseImportSource({ extension: '.egdesk' })
      if (!current(epoch)) return snapshot()
      if (!source) return publish({ phase: 'idle' })
      publish({ phase: 'import-validating', error: null, receipt: null })
      const preview = await bundleService.inspectImport({ source, password, signal: activeAbort.signal })
      if (!current(epoch)) { await bundleService.cancelImport({ importId: preview.importId }); return snapshot() }
      return publish({ phase: 'import-ready', importPreview: preview })
    } catch (error) { if (current(epoch)) return fail(error); return snapshot() }
  }

  async function applyNewCopy() {
    const preview = state.importPreview
    if (!preview || state.phase !== 'import-ready' || preview.mode !== 'new-copy') throw new Error('검증된 새 사본 미리보기가 필요합니다.')
    const epoch = ++generation
    publish({ phase: 'importing', error: null })
    try {
      const receipt = await bundleService.applyNewCopy({ importId: preview.importId })
      if (!current(epoch)) return snapshot()
      return publish({ phase: receipt.status === 'imported-and-reopened' ? 'import-complete' : 'import-reopen-unverified', importPreview: null, receipt })
    } catch (error) { if (current(epoch)) return fail(error); return snapshot() }
  }

  async function cancel() {
    if (state.phase === 'importing') return publish({ error: '가져오기 적용이 시작되었습니다. 완료 또는 실패 결과를 확인하세요.' })
    if (state.phase === 'exporting' || state.phase === 'export-cancel-requested') {
      activeAbort?.abort()
      return publish({ phase: 'export-cancel-requested', error: null })
    }
    generation++
    activeAbort?.abort()
    activeAbort = null
    await clearPreviews()
    return publish({ phase: 'idle', receipt: null, error: null })
  }

  return { snapshot, prepareExport, publishExport, inspectSelectedImport, applyNewCopy, cancel }
}
