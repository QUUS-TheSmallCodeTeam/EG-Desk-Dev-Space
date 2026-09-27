export const EGDESK_FILE_CLIENT_ENDPOINTS = Object.freeze({
  openPickerChannel: '/v1/files/picker/channel',
  beginPicker: '/v1/files/picker/begin', completePicker: '/v1/files/picker/complete',
  registerRoot: '/v1/files/roots', listDirectory: '/v1/files/list', search: '/v1/files/search', readFile: '/v1/files/read',
  createDraft: '/v1/files/drafts/create', readDraft: '/v1/files/drafts/read', updateDraft: '/v1/files/drafts/update',
  saveDraft: '/v1/files/drafts/save', diffDraft: '/v1/files/drafts/diff', sourceStatus: '/v1/files/drafts/source-status', reconnectDraft: '/v1/files/drafts/reconnect', saveAs: '/v1/files/save-as',
})

// request(path, body, {headers}?) sends POST and returns parsed {ok,result}.
export function createEGDeskFileServiceCallbacks({ request }) {
  if (typeof request !== 'function') throw new TypeError('File request callback is required')
  return Object.fromEntries(Object.entries(EGDESK_FILE_CLIENT_ENDPOINTS).map(([name, path]) => [name, async (body, requestOptions) => {
    const packet = await request(path, body, requestOptions)
    if (packet?.ok !== true || !Object.hasOwn(packet, 'result')) {
      throw Object.assign(new Error(packet?.error || '파일 요청에 실패했습니다.'), { code: packet?.code || 'FILE_REQUEST_FAILED', details: packet?.details })
    }
    return packet.result
  }]))
}

export function suggestEGDeskCopyName(fileName) {
  const name = typeof fileName === 'string' && fileName ? fileName : '파일.txt'
  const extensionAt = name.lastIndexOf('.')
  return extensionAt > 0 && extensionAt < name.length - 1
    ? `${name.slice(0, extensionAt)} 사본${name.slice(extensionAt)}`
    : `${name} 사본`
}

// Privileged Firefox requests omit Origin/Sec-Fetch-Site. The helper binds this
// native channel to an ephemeral nonce; never persist it or synthesize Origin.
export function createEGDeskNativeFilePickers({ service, pickDirectory, pickSaveFile }) {
  let channel = null
  async function channelOptions() {
    if (!channel || channel.expiresAt <= Date.now()) channel = await service.openPickerChannel({})
    return Object.freeze({ headers: Object.freeze({ 'X-EGDesk-Picker-Channel': channel.token }) })
  }
  async function select(purpose, picker) {
    if (typeof picker !== 'function') throw new Error('파일 선택기가 연결되지 않았습니다.')
    let requestOptions = await channelOptions()
    let grant
    try { grant = await service.beginPicker({ purpose }, requestOptions) }
    catch (error) {
      if (error.code !== 'PICKER_CHANNEL_EXPIRED') throw error
      channel = null; requestOptions = await channelOptions()
      grant = await service.beginPicker({ purpose }, requestOptions)
    }
    let picked
    try {
      const selection = await picker()
      // Pin the native result before any renewal await. Neither a new default
      // nor a mutable picker result may substitute another destination.
      picked = selection && typeof selection === 'object'
        ? Object.freeze({ parentPath: selection.parentPath, fileName: selection.fileName }) : selection
    }
    catch (error) { await service.completePicker({ requestId: grant.requestId, cancelled: true }, requestOptions).catch(() => {}); throw error }
    const completeAndRegister = async currentGrant => {
      const completed = await service.completePicker({ requestId: currentGrant.requestId, ...(picked ? { absolutePath: typeof picked === 'string' ? picked : picked.parentPath } : { cancelled: true }) }, requestOptions)
      if (completed.cancelled) return null
      const root = await service.registerRoot({ selectionId: completed.selectionId }, requestOptions)
      return { root, picked }
    }
    try { return await completeAndRegister(grant) }
    catch (error) {
      if (!picked && ['PICKER_GRANT_EXPIRED', 'PICKER_CHANNEL_EXPIRED'].includes(error.code)) return null
      try {
        if (error.code !== 'PICKER_GRANT_EXPIRED') throw error
        // One bounded renewal, using the original nonce and purpose. The server
        // must still validate that channel; never bootstrap a new one here.
        const renewed = await service.beginPicker({ purpose }, requestOptions)
        return await completeAndRegister(renewed)
      } catch (cause) {
        if (picked) {
          cause.pickerSelection = Object.freeze({ purpose, picked })
          cause.selectionPreserved = true
          if (['PICKER_GRANT_EXPIRED', 'PICKER_CHANNEL_EXPIRED'].includes(cause.code)) cause.message = '선택한 위치는 유지되었지만 연결 시간이 만료되었습니다. 연결을 다시 확인해 주세요.'
        }
        throw cause
      }
    }
  }
  return {
    chooseRoot: async () => (await select('folder', pickDirectory))?.root || null,
    chooseSaveAs: async options => {
      const selected = await select('save-as-directory', () => pickSaveFile?.(options))
      return selected ? { directoryId: selected.root.directoryId, fileName: selected.picked.fileName } : null
    },
  }
}

// Native, keyboard-operable File surface. The shell supplies authorized picker
// results and bridge operations; no renderer-controlled filesystem paths exist.
export function createEGDeskFileView({ document, service, chooseRoot, chooseSaveAs, runCheck, onState = () => {} }) {
  if (!document?.createElement || !service || !['listDirectory', 'search', 'readFile', 'createDraft', 'updateDraft', 'saveDraft', 'saveAs', 'diffDraft'].every(name => typeof service[name] === 'function')) {
    throw new Error('File view requires a document and file-service callbacks')
  }
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }
  const operationId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
  const button = (label, className, action) => {
    const node = el('button', className, label)
    node.type = 'button'
    node.addEventListener('click', action)
    return node
  }
  const root = el('section', 'egdesk-file-view')
  root.setAttribute('aria-label', '파일 작업')
  const toolbar = el('div', 'egdesk-file-toolbar')
  const treePanel = el('section', 'egdesk-file-tree-panel')
  const treeHeading = el('h2', 'egdesk-file-tree-heading', '파일')
  const tree = el('ul', 'egdesk-file-tree')
  tree.setAttribute('role', 'tree')
  tree.setAttribute('aria-label', '연결된 폴더의 파일')
  treePanel.append(treeHeading, tree)
  const searchForm = el('form', 'egdesk-file-search')
  const searchLabel = el('label', 'egdesk-file-search-label', '파일 이름 검색')
  const searchInput = el('input', 'egdesk-file-search-input')
  searchInput.type = 'search'
  searchInput.maxLength = 256
  searchLabel.append(searchInput)
  const searchButton = button('검색', 'egdesk-file-search-button', () => {})
  searchButton.type = 'submit'
  searchForm.append(searchLabel, searchButton)
  const searchResults = el('div', 'egdesk-file-search-results')
  const workspace = el('section', 'egdesk-file-workspace')
  const title = el('h2', 'egdesk-file-title', '파일을 선택하세요')
  const fileDetails = el('details', 'egdesk-file-details')
  fileDetails.append(el('summary', 'egdesk-file-details-summary', '파일 정보'))
  const meta = el('p', 'egdesk-file-meta')
  fileDetails.append(meta)
  const editorLabel = el('label', 'egdesk-file-editor-label', '텍스트 작업사본')
  const editor = el('textarea', 'egdesk-file-editor')
  editor.setAttribute('spellcheck', 'false')
  editorLabel.append(editor)
  editorLabel.hidden = true
  const viewer = el('div', 'egdesk-file-viewer')
  viewer.hidden = true
  const actions = el('div', 'egdesk-file-actions')
  const reviewPanel = el('section', 'egdesk-file-review')
  reviewPanel.hidden = true
  reviewPanel.setAttribute('aria-label', '변경 비교')
  const checkPanel = el('section', 'egdesk-file-check-result')
  checkPanel.hidden = true
  checkPanel.setAttribute('aria-label', '검사 결과')
  const status = el('p', 'egdesk-file-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const error = el('p', 'egdesk-file-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const connectButton = button('폴더 연결', 'egdesk-file-connect', async () => {
    if (!chooseRoot) return
    try { const selected = await chooseRoot(); if (selected) await openRoot(selected) }
    catch (cause) { showError(cause) }
  })
  connectButton.disabled = typeof chooseRoot !== 'function'
  connectButton.title = chooseRoot ? 'OS 선택기로 허용할 폴더를 고릅니다.' : '폴더 선택기가 연결되지 않았습니다.'
  const reviewButton = button('변경 비교', 'egdesk-file-review-button', () => act(review))
  const saveButton = button('작업사본 저장', 'egdesk-file-save-button', () => act(save))
  const saveAsButton = button('다른 이름으로 새 파일 저장', 'egdesk-file-save-as-button', () => act(saveAs))
  const checkButton = button('검사', 'egdesk-file-check-button', () => act(check))
  const reconnectButton = button('원본 다시 연결', 'egdesk-file-reconnect-button', () => act(beginReconnect))
  reconnectButton.hidden = true
  reconnectButton.disabled = !chooseRoot || typeof service.reconnectDraft !== 'function'
  saveAsButton.disabled = typeof chooseSaveAs !== 'function'
  checkButton.disabled = typeof runCheck !== 'function'
  saveAsButton.title = chooseSaveAs ? '기존 파일은 덮어쓰지 않습니다.' : '저장 위치 선택기가 연결되지 않았습니다.'
  checkButton.title = runCheck ? '현재 저장된 작업사본에 검사를 실행합니다.' : '검사 실행기가 연결되지 않았습니다.'
  actions.append(reviewButton, saveButton, saveAsButton, checkButton, reconnectButton)
  toolbar.append(connectButton, searchForm)
  workspace.append(title, fileDetails, editorLabel, viewer, actions, reviewPanel, checkPanel)
  root.append(toolbar, treePanel, searchResults, workspace, status, error)

  let activeRoot = null
  let activeFileId = null
  let draft = null
  let readReceipt = null
  let sourceDisconnected = false
  let pendingReconnect = false
  let operation = 0
  let treeGeneration = 0
  let disposed = false
  let composing = false
  let compositionEndedAt = 0
  let timer = null
  let flushPromise = null
  let savePromise = null
  let localRevision = 0
  const draftsByFile = new Map()
  const token = () => ++operation
  const present = generation => !disposed && generation === operation
  const announce = message => { status.textContent = message; onState(snapshot()) }
  const showError = cause => {
    const details = cause?.details
    if (details?.fileMayExist === true) {
      const target = typeof details.targetName === 'string' && !/[\\/\u0000-\u001f\u007f]/.test(details.targetName) ? details.targetName : '새 파일'
      error.textContent = details.created === true
        ? `‘${target}’ 파일은 만들어졌지만 저장을 완료하지 못했습니다. 파일을 확인한 뒤 다른 이름으로 저장하세요. 작업사본은 유지됩니다.`
        : `‘${target}’ 파일이 만들어졌는지 확인되지 않았습니다. 다시 저장하기 전에 파일을 확인하세요. 작업사본은 유지됩니다.`
    } else if (cause?.code === 'TARGET_EXISTS') error.textContent = '같은 이름의 파일이 있습니다. 다른 이름을 선택하세요.'
    else if (cause?.code === 'SAVE_AS_UNAVAILABLE') error.textContent = '새 파일 저장 기능을 사용할 수 없습니다. 작업사본은 유지됩니다.'
    else if (cause?.code === 'SAVE_AS_FAILED') error.textContent = '새 파일을 만들지 못했습니다. 저장 위치를 확인하세요. 작업사본은 유지됩니다.'
    else error.textContent = cause?.message || String(cause)
    error.hidden = false
    announce(details?.fileMayExist === true ? '새 파일 확인 필요 · 작업사본 유지' : '작업에 실패했습니다. 편집 중인 내용은 그대로 남아 있습니다.')
  }
  const clearError = () => { error.textContent = ''; error.hidden = true }
  const setEditable = enabled => {
    editorLabel.hidden = !enabled; viewer.hidden = enabled; actions.hidden = !enabled
    saveAsButton.disabled = !enabled || !chooseSaveAs || draft?.saveAsAvailable !== true
    saveAsButton.title = draft?.saveAsAvailable === true ? '기존 파일은 덮어쓰지 않습니다.' : '새 파일 저장 기능을 준비 중입니다.'
    reconnectButton.hidden = !enabled || !sourceDisconnected
  }
  const dirty = () => !!draft && (editor.value !== draft.text || draft.bufferRevision !== draft.savedRevision)
  const snapshot = () => ({ rootId: activeRoot?.rootId || null, fileId: activeFileId, draftId: draft?.id || null, sourceRevision: readReceipt?.diskRevision || null, sourceConnection: sourceDisconnected ? 'reconnect-required' : 'connected', bufferRevision: draft?.bufferRevision ?? null, savedRevision: draft?.savedRevision ?? null, dirty: dirty(), scrollTop: editorLabel.hidden ? viewer.scrollTop : editor.scrollTop })

  async function act(work) { clearError(); try { await work() } catch (cause) { showError(cause) } }

  function treeItems() { return [...tree.querySelectorAll('[role="treeitem"]')].filter(item => !item.closest('[hidden]')) }
  tree.addEventListener('keydown', event => {
    const item = event.target.closest?.('[role="treeitem"]')
    if (!item || !tree.contains(item)) return
    const items = treeItems()
    const index = items.indexOf(item)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if (event.key === 'ArrowRight' && item.dataset.kind === 'directory') {
      event.preventDefault(); if (item.getAttribute('aria-expanded') !== 'true') item.click()
      else item.querySelector('[role="treeitem"]')?.focus()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault(); if (item.dataset.kind === 'directory' && item.getAttribute('aria-expanded') === 'true') item.click()
      else item.parentElement?.closest('[role="treeitem"]')?.focus()
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click() }
  })

  async function appendDirectory(directoryId, group, cursor = 0, generation = treeGeneration) {
    const result = await service.listDirectory({ directoryId, cursor, limit: 100 })
    if (disposed || generation !== treeGeneration) return
    for (const entry of result.entries) {
      const item = el('li', `egdesk-file-tree-item egdesk-file-${entry.kind}`, entry.name)
      item.setAttribute('role', 'treeitem')
      item.setAttribute('aria-label', entry.name)
      item.tabIndex = -1
      item.dataset.kind = entry.kind
      if (entry.kind === 'blocked') {
        item.setAttribute('aria-disabled', 'true')
        item.title = entry.reason === 'symlink' ? '심볼릭 링크는 열지 않습니다.' : '이 항목은 열 수 없습니다.'
      } else if (entry.kind === 'directory') {
        item.setAttribute('aria-expanded', 'false')
        item.addEventListener('click', event => { event.stopPropagation(); if (event.target.closest('[role="treeitem"]') !== item) return; act(async () => {
          const expanded = item.getAttribute('aria-expanded') === 'true'
          item.setAttribute('aria-expanded', expanded ? 'false' : 'true')
          let children = item.querySelector('[role="group"]')
          if (!children) { children = el('ul', 'egdesk-file-tree-group'); children.setAttribute('role', 'group'); item.append(children); await appendDirectory(entry.id, children, 0, treeGeneration) }
          children.hidden = expanded
        }) })
      } else {
        item.addEventListener('click', event => { event.stopPropagation(); act(() => pendingReconnect ? reconnectSource(entry.id) : openFile(entry.id)) })
      }
      group.append(item)
    }
    if (result.nextCursor != null) {
      const more = button('더 보기', 'egdesk-file-tree-more', () => act(async () => { more.remove(); await appendDirectory(directoryId, group, result.nextCursor, generation) }))
      more.addEventListener('click', event => event.stopPropagation())
      const holder = el('li', 'egdesk-file-tree-more-row')
      holder.append(more)
      group.append(holder)
    }
  }

  async function openRoot(rootHandle, { preserveDraft = false } = {}) {
    if (!rootHandle?.rootId || !rootHandle?.directoryId) throw new Error('허용된 폴더 핸들이 없습니다.')
    if (draft && editor.value !== draft.text) await flush()
    const generation = token()
    treeGeneration++
    activeRoot = rootHandle
    if (!preserveDraft) { activeFileId = null; draft = null; readReceipt = null; sourceDisconnected = false; pendingReconnect = false }
    tree.replaceChildren()
    searchResults.replaceChildren()
    if (!preserveDraft) { title.textContent = rootHandle.name || '연결된 폴더'; setEditable(false); viewer.textContent = '트리에서 파일을 선택하세요.' }
    await appendDirectory(rootHandle.directoryId, tree, 0, treeGeneration)
    if (present(generation)) { tree.querySelector('[role="treeitem"]')?.setAttribute('tabindex', '0'); announce('폴더가 연결되었습니다.') }
  }

  async function openFile(fileId, restoredDraftId = null, { focus = true } = {}) {
    const generation = token()
    const restored = restoredDraftId && typeof service.readDraft === 'function' ? await service.readDraft({ draftId: restoredDraftId }) : null
    let read
    let disconnected = false
    try { read = await service.readFile({ fileId }) }
    catch (cause) {
      if (!restored || restored.fileId !== fileId) throw cause
      read = { name: restored.name, size: null, sha256: restored.sourceHash, diskRevision: restored.sourceRevision, kind: 'text' }
      disconnected = true
    }
    if (!present(generation)) return
    let nextDraft = null
    if (read.kind === 'text') {
      const prior = draftsByFile.get(fileId)
      if (restoredDraftId && typeof service.readDraft !== 'function') throw new Error('작업사본 재열기 기능이 연결되지 않았습니다.')
      nextDraft = restored || (restoredDraftId ? await service.readDraft({ draftId: restoredDraftId })
        : prior && typeof service.readDraft === 'function' ? await service.readDraft({ draftId: prior.id })
          : prior || await service.createDraft({ fileId }))
      if (!present(generation)) return
      if (nextDraft.fileId !== fileId) throw new Error('작업사본과 파일 대상이 일치하지 않습니다.')
    }

    // A remains the active visual/editing target while B is prepared. Preserve
    // edits arriving during either read or draft creation, including additional
    // typing while that preservation write is in flight, before adopting B.
    while (draft) {
      if (composing) { announce('입력을 마친 후 파일을 다시 여세요.'); return }
      await flush()
      if (!present(generation)) return
      if (composing) { announce('입력을 마친 후 파일을 다시 여세요.'); return }
      if (!draft || editor.value === draft.text) break
    }
    if (!present(generation)) return
    // Reopening the same draft must use the freshly preserved revision, not the
    // candidate read before the user's intervening input.
    if (nextDraft && draft?.id === nextDraft.id) nextDraft = draft
    if (timer) { clearTimeout(timer); timer = null }

    // No asynchronous work occurs between changing the identity/title and its
    // visible buffer. A failed load or preservation write leaves A intact.
    activeFileId = fileId
    sourceDisconnected = disconnected
    pendingReconnect = false
    readReceipt = { name: read.name, size: read.size, sha256: read.sha256, diskRevision: read.diskRevision }
    title.textContent = read.name
    meta.textContent = `${read.size == null ? '원본 위치 확인 필요' : `${read.size} byte`} · SHA-256 ${read.sha256}`
    reviewPanel.hidden = true
    checkPanel.hidden = true
    if (read.kind === 'text') {
      draft = nextDraft
      draftsByFile.set(fileId, draft)
      editor.value = draft.text
      setEditable(true)
      if (focus) editor.focus()
      announce(disconnected ? '작업사본을 열었습니다. 원본을 다시 연결하세요.' : '작업사본을 열었습니다. 원본은 유지됩니다.')
    } else {
      draft = null
      setEditable(false)
      viewer.textContent = '이 형식은 편집할 수 없습니다.'
      viewer.tabIndex = 0
      if (focus) viewer.focus()
      announce('읽기 전용 파일 정보가 열렸습니다.')
    }
  }

  async function beginReconnect() {
    if (!draft || !chooseRoot || typeof service.reconnectDraft !== 'function') return
    const selected = await chooseRoot()
    if (!selected) return
    await openRoot(selected, { preserveDraft: true })
    pendingReconnect = true
    announce('다시 연결할 파일을 선택하세요.')
  }

  async function reconnectSource(fileId) {
    if (!draft || typeof service.reconnectDraft !== 'function') return
    await flush()
    const generation = operation
    const targetDraftId = draft.id
    const previousFileId = activeFileId
    const reconnected = await service.reconnectDraft({ draftId: draft.id, expectedHead: draft.head, fileId, operationId: operationId('file-reconnect') })
    draftsByFile.delete(previousFileId); draftsByFile.set(fileId, reconnected.draft)
    if (!present(generation) || draft?.id !== targetDraftId) return
    draft = reconnected.draft; activeFileId = fileId; readReceipt = reconnected.source
    sourceDisconnected = false; pendingReconnect = false
    title.textContent = reconnected.source.name
    meta.textContent = `${reconnected.source.size} byte · SHA-256 ${reconnected.source.sha256}`
    setEditable(true)
    announce('원본을 다시 연결했습니다. 작업사본은 유지됩니다.')
  }

  async function flush() {
    if (!draft || composing) return
    if (savePromise) await savePromise
    if (!draft || disposed) return
    if (flushPromise) { await flushPromise; if (draft && editor.value !== draft.text) return flush(); return }
    if (editor.value === draft.text) return
    const text = editor.value
    const currentDraft = draft
    const revision = localRevision
    flushPromise = service.updateDraft({ draftId: currentDraft.id, expectedHead: currentDraft.head, text, operationId: operationId('file-edit') })
    try {
      const updated = await flushPromise
      if (draft?.id === currentDraft.id) {
        draft = updated
        draftsByFile.set(activeFileId, updated)
        announce(revision === localRevision && editor.value === text ? '작업사본에 변경을 기록했습니다. 저장은 별도입니다.' : '입력 중인 새 변경이 남아 있습니다.')
      }
    } finally { flushPromise = null }
    if (draft?.id === currentDraft.id && editor.value !== draft.text) return flush()
  }

  editor.addEventListener('compositionstart', () => { composing = true })
  editor.addEventListener('compositionend', () => { composing = false; compositionEndedAt = Date.now(); scheduleFlush() })
  editor.addEventListener('input', () => { localRevision++; announce('저장되지 않은 변경이 있습니다.'); if (!composing) scheduleFlush() })
  function scheduleFlush() { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; act(flush) }, 250) }

  async function review() {
    if (!draft) return
    await flush()
    const generation = operation
    const targetDraftId = draft.id
    const diff = await service.diffDraft({ draftId: targetDraftId })
    if (!present(generation) || draft?.id !== targetDraftId) return
    reviewPanel.replaceChildren()
    const heading = el('h3', 'egdesk-file-review-heading', `변경 비교 · 버퍼 ${diff.bufferRevision}`)
    reviewPanel.append(heading)
    if (!diff.hunks.length) reviewPanel.append(el('p', 'egdesk-file-no-changes', '원본과 비교한 변경이 없습니다.'))
    for (const hunk of diff.hunks) {
      const section = el('section', 'egdesk-file-hunk')
      section.append(el('h4', 'egdesk-file-hunk-title', `원본 ${hunk.baseStartLine}행 ↔ 현재 ${hunk.currentStartLine}행`))
      const before = el('pre', 'egdesk-file-hunk-before', hunk.baseLines.join('\n'))
      before.setAttribute('aria-label', '원본 내용')
      const after = el('pre', 'egdesk-file-hunk-after', hunk.currentLines.join('\n'))
      after.setAttribute('aria-label', '현재 작업사본 내용')
      section.append(before, after)
      reviewPanel.append(section)
    }
    reviewPanel.hidden = false
    announce('변경 비교')
  }

  async function save() {
    if (!draft) return
    await flush()
    const target = draft
    const generation = operation
    savePromise = service.saveDraft({ draftId: target.id, expectedHead: target.head, bufferRevision: target.bufferRevision, operationId: operationId('file-save') })
    try {
      const result = await savePromise
      if (draft?.id === target.id) { draft = result.draft; draftsByFile.set(activeFileId, draft) }
      if (present(generation) && draft?.id === target.id) announce(editor.value === target.text ? '작업사본 저장됨 · 원본 유지' : '작업사본 저장됨 · 새 변경 있음')
    } finally { savePromise = null }
  }

  async function saveAs() {
    if (!draft || !chooseSaveAs) return
    await flush()
    const generation = operation
    const targetDraftId = draft.id
    const target = await chooseSaveAs({ defaultName: suggestEGDeskCopyName(readReceipt?.name), createOnly: true })
    if (!present(generation) || draft?.id !== targetDraftId) return
    if (!target) { announce('다른 이름 저장을 취소했습니다.'); return }
    await flush()
    const sentText = draft.text
    const result = await service.saveAs({ draftId: draft.id, expectedHead: draft.head, directoryId: target.directoryId, fileName: target.fileName, operationId: operationId('file-save-as') })
    if (!present(generation) || draft?.id !== targetDraftId) return
    const latestText = editor.value
    await openFile(result.resourceId)
    if (latestText !== sentText) { editor.value = latestText; localRevision++; await flush() }
    announce(`새 파일 ${result.targetName} 저장됨${latestText !== sentText ? ' · 새 변경 있음' : ''}`)
  }

  async function check() {
    if (!draft || !runCheck) return
    await flush()
    if (draft.bufferRevision !== draft.savedRevision) { announce('검사 전에 현재 작업사본을 저장하세요.'); return }
    const targetRevision = draft.savedRevision
    const generation = operation
    const targetDraftId = draft.id
    const checked = await runCheck({ draftId: draft.id, revision: targetRevision, sha256: draft.savedHash })
    if (!present(generation) || draft?.id !== targetDraftId) return
    checkPanel.replaceChildren(el('h3', 'egdesk-file-check-heading', '검사 결과'), el('pre', 'egdesk-file-check-body', checked?.summary || '검사 결과를 확인할 수 없습니다.'))
    checkPanel.hidden = false
    announce(`검사 결과 · 작업사본 ${targetRevision}${draft.bufferRevision !== targetRevision ? ' · 이후 변경 있음' : ''}`)
  }

  async function captureRef() {
    const reject = (code, message) => { throw Object.assign(new Error(message), { code }) }
    if (disposed || !draft || !activeFileId || typeof service.readDraft !== 'function') reject('CAPTURE_UNAVAILABLE', '읽을 수 있는 작업사본을 먼저 여세요.')
    if (composing) reject('CAPTURE_COMPOSING', '한글 입력을 마친 뒤 다시 첨부하세요.')
    const generation = operation
    const fileId = activeFileId
    const draftId = draft.id
    const revision = localRevision
    await flush()
    if (composing) reject('CAPTURE_COMPOSING', '한글 입력을 마친 뒤 다시 첨부하세요.')
    if (!present(generation) || activeFileId !== fileId || draft?.id !== draftId ||
      localRevision !== revision || editor.value !== draft.text) reject('CAPTURE_STALE', '작업사본이 바뀌었습니다. 다시 첨부하세요.')
    const current = await service.readDraft({ draftId })
    if (composing) reject('CAPTURE_COMPOSING', '한글 입력을 마친 뒤 다시 첨부하세요.')
    if (!present(generation) || activeFileId !== fileId || draft?.id !== draftId ||
      localRevision !== revision || editor.value !== draft.text ||
      current.fileId !== fileId || current.head !== draft.head || current.bufferRevision !== draft.bufferRevision) {
      reject('CAPTURE_STALE', '작업사본이 바뀌었습니다. 다시 첨부하세요.')
    }
    return Object.freeze({ fileId, draftId, head: draft.head, revision: draft.bufferRevision })
  }

  searchForm.addEventListener('submit', event => { event.preventDefault(); act(async () => {
    if (!activeRoot) { announce('먼저 폴더를 연결하세요.'); return }
    const query = searchInput.value.trim()
    if (!query) { searchResults.replaceChildren(); announce('검색을 지웠습니다.'); return }
    const generation = operation
    const found = await service.search({ rootId: activeRoot.rootId, query, limit: 50 })
    if (!present(generation)) return
    searchResults.replaceChildren(el('h3', 'egdesk-file-search-heading', `검색 결과 ${found.matches.length}개${found.truncated ? ' · 일부만 표시' : ''}`))
    for (const match of found.matches) searchResults.append(button(`${match.relativePath} (${match.kind === 'directory' ? '폴더' : '파일'})`, 'egdesk-file-search-result', () => act(async () => {
      if (match.kind === 'file') await (pendingReconnect ? reconnectSource(match.id) : openFile(match.id))
      else announce('폴더 결과는 트리에서 열 수 있습니다.')
    })))
    announce(found.truncated ? '검색 상한에 도달했습니다. 검색어를 좁혀 주세요.' : '파일 이름 검색이 완료되었습니다.')
  }) })

  root.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || composing || event.keyCode === 229 || Date.now() - compositionEndedAt < 100) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && root.contains(document.activeElement)) {
      event.preventDefault(); act(save)
    }
  })
  async function close() {
    if (disposed) return true
    if (composing) { announce('입력을 마친 후 닫아 주세요.'); return false }
    if (timer) { clearTimeout(timer); timer = null }
    try { await flush() }
    catch (cause) { showError(cause); return false }
    disposed = true; token(); treeGeneration++; root.remove(); return true
  }
  return { element: root, openRoot, openFile, reconnectSource, captureRef, restoreDraft: async ({ fileId, draftId }) => {
    const saved = fileId ? null : await service.readDraft({ draftId })
    return openFile(fileId || saved.fileId, draftId, { focus: false })
  }, snapshot, flush, close, dispose: close }
}
