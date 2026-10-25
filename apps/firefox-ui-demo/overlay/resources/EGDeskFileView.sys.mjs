export const EGDESK_FILE_CLIENT_ENDPOINTS = Object.freeze({
  openPickerChannel: '/v1/files/picker/channel',
  beginPicker: '/v1/files/picker/begin', completePicker: '/v1/files/picker/complete',
  registerRoot: '/v1/files/roots', listDirectory: '/v1/files/list', search: '/v1/files/search', searchContents: '/v1/files/search/contents', readFile: '/v1/files/read',
  createDraft: '/v1/files/drafts/create', readDraft: '/v1/files/drafts/read', updateDraft: '/v1/files/drafts/update',
  saveDraft: '/v1/files/drafts/save', diffDraft: '/v1/files/drafts/diff', sourceStatus: '/v1/files/drafts/source-status', reconnectDraft: '/v1/files/drafts/reconnect', saveAs: '/v1/files/save-as',
  gitStatus: '/v1/files/git/status', gitChanges: '/v1/files/git/changes', gitFileDiff: '/v1/files/git/diff',
  resolvePath: '/v1/files/resolve', saveOriginal: '/v1/files/drafts/save-original',
  revertReviewed: '/v1/files/review/revert', deleteCreated: '/v1/files/review/delete-created',
  attachProject: '/v1/files/projects/attach', openProject: '/v1/files/projects/open', inheritRoomProject: '/v1/files/projects/inherit',
  detachProject: '/v1/files/projects/detach', setProjectScripts: '/v1/files/projects/scripts', suggestProjectScripts: '/v1/files/projects/script-suggestions',
})

// Display parts load on first use: EGDeskDiffView and EGDeskRunResult (1-D)
// and EGDeskChangeReview (2-X). A part that fails to load leaves the File
// view working with its plain layout instead of failing the whole card.
const FILE_VIEW_PARTS = Object.freeze({ diffView: 'EGDeskDiffView.sys.mjs', runResult: 'EGDeskRunResult.sys.mjs', changeReview: 'EGDeskChangeReview.mjs' })
export async function loadEGDeskFileViewPart(name) {
  const file = FILE_VIEW_PARTS[name]
  if (!file) return null
  const url = new URL(file, import.meta.url).href
  try { if (typeof globalThis.ChromeUtils?.importESModule === 'function') return globalThis.ChromeUtils.importESModule(url) } catch {}
  try { return await import(url) } catch { return null }
}

// Korean messages for the 2-X helper codes (original save, review, resolve).
const FILE_ERROR_MESSAGES = Object.freeze({
  NOT_IN_ROOT: '이 파일은 연결된 폴더 밖에 있어 열지 않습니다.',
  RESOURCE_UNAVAILABLE: '파일을 찾을 수 없거나 열 수 없습니다.',
  SOURCE_RECONNECT_REQUIRED: '원본 파일 연결이 끊겼습니다. 원본을 다시 연결한 뒤 저장하세요. 작업사본은 유지됩니다.',
  ORIGINAL_HARD_LINKED: '이 파일은 다른 이름으로도 연결되어 있어 원본에 저장하지 않습니다. 다른 이름으로 새 파일 저장을 쓰세요.',
  SAVE_UNCERTAIN: '저장은 끝났지만 결과를 확인하지 못했습니다. 다시 저장하기 전에 파일을 확인하세요. 작업사본은 유지됩니다.',
  SAVE_FAILED: '원본에 저장하지 못했습니다. 원본은 바뀌지 않았고 작업사본은 유지됩니다.',
  RESOURCE_CHANGED: '원본 파일이 다른 파일로 바뀌었습니다. 원본을 다시 연결하세요. 작업사본은 유지됩니다.',
  PROJECT_RECONNECT_REQUIRED: '프로젝트 폴더를 다시 골라 주세요.',
})

// One letter per git state, as in VS Code's explorer; the label is what a
// screen reader hears. 'contains' marks a folder with changes inside. State
// names follow t3code toGitStatus (apps/web/src/components/diffs/
// diffFileTree.logic.ts:17-29, MIT) — pattern only.
export const EGDESK_GIT_STATE_LABELS = Object.freeze({
  modified: Object.freeze({ letter: 'M', label: '수정됨' }),
  added: Object.freeze({ letter: 'A', label: '새 파일' }),
  deleted: Object.freeze({ letter: 'D', label: '삭제됨' }),
  renamed: Object.freeze({ letter: 'R', label: '이름 바뀜' }),
  untracked: Object.freeze({ letter: 'U', label: '추적 안 함' }),
  conflicted: Object.freeze({ letter: 'C', label: '충돌' }),
  contains: Object.freeze({ letter: '•', label: '안에 변경 있음' }),
})

// gitStatus entries → stateFor(root-relative POSIX path). Keys are NFC so a
// Finder-made (NFD) Korean file name still finds git's precomposed path.
export function createEGDeskGitStateIndex(entries = []) {
  const files = new Map()
  const containing = new Set()
  const untrackedFolders = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.relativePath !== 'string' || !entry.relativePath || entry.state === 'contains' || !Object.hasOwn(EGDESK_GIT_STATE_LABELS, entry.state)) continue
    const key = entry.relativePath.normalize('NFC')
    files.set(key, entry.state)
    if (entry.directory === true && entry.state === 'untracked') untrackedFolders.push(key)
    const parts = key.split('/')
    for (let depth = 1; depth < parts.length; depth++) containing.add(parts.slice(0, depth).join('/'))
  }
  return Object.freeze({
    size: files.size,
    stateFor(relativePath) {
      if (typeof relativePath !== 'string' || !relativePath) return null
      const key = relativePath.normalize('NFC')
      if (files.has(key)) return files.get(key)
      if (untrackedFolders.some(folder => key.startsWith(`${folder}/`))) return 'untracked'
      return containing.has(key) ? 'contains' : null
    },
  })
}

// The helper watcher's `file.changed` payload ({rootId, relativePath, change}),
// alone or inside a bus envelope. Anything else is ignored.
export function normalizeFileChangedEvent(event) {
  const payload = event && typeof event === 'object' && event.payload && typeof event.payload === 'object' ? event.payload : event
  if (!payload || typeof payload !== 'object') return null
  const { rootId, relativePath, change } = payload
  if (typeof rootId !== 'string' || !rootId || rootId.length > 512) return null
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1024 || relativePath.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(relativePath)) return null
  if (relativePath.split('/').some(part => !part || part === '.' || part === '..')) return null
  return Object.freeze({ rootId, relativePath, change: change === 'rename' ? 'rename' : 'change' })
}

export function parentFolderOf(relativePath) {
  const at = String(relativePath).lastIndexOf('/')
  return at < 0 ? '' : String(relativePath).slice(0, at)
}

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
  // register(selectionId, requestOptions) turns the consumed selection into
  // the result: a root (registerRoot) or a Board project (attachProject).
  async function select(purpose, picker, register = (selectionId, requestOptions) => service.registerRoot({ selectionId }, requestOptions)) {
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
      const root = await register(completed.selectionId, requestOptions)
      if (root?.cancelled) return null
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
    // D-X3: pick a project folder for a Board (or one room). The helper
    // stores it and answers the project view (see openProject in the view).
    chooseProjectFolder: async ({ boardId = null, roomId = null, title = null } = {}) => {
      if (typeof service.attachProject !== 'function') throw new Error('프로젝트 폴더 연결이 준비되지 않았습니다.')
      const target = { ...(boardId != null ? { boardId } : {}), ...(roomId != null ? { roomId } : {}), ...(title ? { title } : {}) }
      return (await select('folder', pickDirectory, (selectionId, requestOptions) => service.attachProject({ ...target, selectionId }, requestOptions)))?.root || null
    },
    chooseSaveAs: async options => {
      const selected = await select('save-as-directory', () => pickSaveFile?.(options))
      return selected ? { directoryId: selected.root.directoryId, fileName: selected.picked.fileName } : null
    },
  }
}

// Native, keyboard-operable File surface. The shell supplies authorized picker
// results and bridge operations; no renderer-controlled filesystem paths exist.
// Optional service callbacks gitStatus/gitChanges/gitFileDiff/searchContents
// light up the '변경' tab, content search and tree state letters.
// 2-X: saveOriginal lights up '원본에 저장' (D-X1: conditional, comparison on
// a changed original); openProject() opens a Board project folder (D-X3);
// runCheck({projectId, rootId, script}) runs one of the project's typed
// commands (D-X6) and may answer {command, exitCode, output, durationMs} for a
// result card; resolvePath lights up openAt({path, line}); showChangeReview()
// hosts the after-apply change review (D-X2). parts = {diffView, runResult,
// changeReview} may inject the display modules (null turns one off).
export function createEGDeskFileView({ document, service, chooseRoot, chooseProject, getProjectTarget, chooseSaveAs, runCheck, projectChecksOnly = false, onState = () => {}, fileChangeDelayMs = 250, parts = {} }) {
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
  // Card-local layout only: retain the shared File surface's colors, controls
  // and focus treatment without changing the concurrently owned stylesheet.
  const layout = (node, declarations) => node.setAttribute('style', declarations)
  const hasGitChanges = typeof service.gitChanges === 'function' && typeof service.gitFileDiff === 'function'
  const hasContentSearch = typeof service.searchContents === 'function'
  const hasOriginalSave = typeof service.saveOriginal === 'function'
  const loadedParts = new Map()
  const part = async name => {
    if (Object.hasOwn(parts, name)) return parts[name] || null
    if (!loadedParts.has(name)) loadedParts.set(name, loadEGDeskFileViewPart(name))
    return loadedParts.get(name)
  }
  const viewKey = operationId('egdesk-file')
  // Roving radio/tab keys (APG): arrows and Home/End move and select.
  const bindRovingKeys = (container, items, select) => container.addEventListener('keydown', event => {
    const enabled = items().filter(item => !item.disabled && item.getAttribute('aria-disabled') !== 'true')
    const index = enabled.indexOf(event.target)
    if (index < 0) return
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? enabled[(index + 1) % enabled.length]
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? enabled[(index - 1 + enabled.length) % enabled.length]
        : event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : null
    if (!next) return
    event.preventDefault(); select(next); next.focus()
  })
  const root = el('section', 'egdesk-file-view')
  root.setAttribute('aria-label', '파일 작업')
  const toolbar = el('div', 'egdesk-file-toolbar')
  layout(toolbar, 'flex-wrap: wrap; gap: 6px; min-width: 0;')
  const connections = el('div', 'egdesk-file-connections')
  layout(connections, 'display: flex; align-items: center; gap: 6px; flex: 1 1 18rem; min-width: 0; max-width: 100%;')
  const projectActions = el('div', 'egdesk-file-project-actions')
  layout(projectActions, 'display: flex; flex-wrap: wrap; align-items: center; gap: 6px; flex: 0 0 auto;')
  const treePanel = el('section', 'egdesk-file-tree-panel')
  const treeHeading = el('h2', 'egdesk-file-tree-heading', '파일')
  const tree = el('ul', 'egdesk-file-tree')
  tree.setAttribute('role', 'tree')
  tree.setAttribute('aria-label', '연결된 폴더의 파일')
  tree.id = `${viewKey}-tree`
  const tabs = el('div', 'egdesk-file-tabs')
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', '파일 창 보기')
  const tabButton = (label, name, panel) => {
    const node = button(label, 'egdesk-file-tab', () => selectTab(name))
    node.setAttribute('role', 'tab')
    node.setAttribute('aria-controls', panel.id)
    node.dataset.tab = name
    return node
  }
  const changesPanel = el('section', 'egdesk-file-changes')
  changesPanel.id = `${viewKey}-changes`
  changesPanel.setAttribute('role', 'tabpanel')
  changesPanel.setAttribute('aria-label', '변경')
  changesPanel.hidden = true
  const filesTab = tabButton('파일', 'files', tree)
  const changesTab = tabButton('변경', 'changes', changesPanel)
  changesTab.disabled = !hasGitChanges
  changesTab.title = hasGitChanges ? '커밋하지 않은 변경을 봅니다.' : '변경 보기가 연결되지 않았습니다.'
  tabs.append(filesTab, changesTab)
  bindRovingKeys(tabs, () => [filesTab, changesTab], node => selectTab(node.dataset.tab))
  // Scope chips: '이번 회차' needs the chat runtime's turn diff (bundle 1-R).
  // Uncommitted / latest-turn scopes as in t3code DiffPanel.tsx:287-304 (MIT), pattern only.
  const scopeGroup = el('div', 'egdesk-file-change-scopes')
  scopeGroup.setAttribute('role', 'radiogroup')
  scopeGroup.setAttribute('aria-label', '변경 범위')
  const scopeChip = (label, scope, enabled) => {
    const node = button(label, 'egdesk-file-change-scope', () => {})
    node.setAttribute('role', 'radio')
    node.setAttribute('aria-checked', String(scope === 'uncommitted'))
    node.tabIndex = scope === 'uncommitted' ? 0 : -1
    node.dataset.scope = scope
    if (!enabled) { node.setAttribute('aria-disabled', 'true'); node.title = '대화 회차 변경 보기는 준비 중입니다.' }
    return node
  }
  scopeGroup.append(scopeChip('커밋 안 한 변경', 'uncommitted', true), scopeChip('이번 회차', 'turn', false))
  const refreshChangesButton = button('새로 고침', 'egdesk-file-change-refresh', () => act(refreshChanges))
  const changesSummary = el('p', 'egdesk-file-change-summary')
  const changeList = el('ul', 'egdesk-file-change-list')
  changeList.setAttribute('aria-label', '바뀐 파일')
  changesPanel.append(scopeGroup, refreshChangesButton, changesSummary, changeList)
  treePanel.append(treeHeading, tabs, tree, changesPanel)
  const searchForm = el('form', 'egdesk-file-search')
  layout(searchForm, 'flex: 1 1 24rem; flex-wrap: wrap; min-width: 0; max-width: 100%;')
  const modeGroup = el('div', 'egdesk-file-search-modes')
  layout(modeGroup, 'display: flex; gap: 5px; flex: 0 0 auto;')
  modeGroup.setAttribute('role', 'radiogroup')
  modeGroup.setAttribute('aria-label', '검색 방식')
  const modeRadio = (label, mode, enabled) => {
    const node = button(label, 'egdesk-file-search-mode', () => setSearchMode(mode))
    node.setAttribute('role', 'radio')
    node.dataset.mode = mode
    node.disabled = !enabled
    if (!enabled) node.title = '내용 검색이 연결되지 않았습니다.'
    return node
  }
  const nameModeButton = modeRadio('이름', 'names', true)
  const contentModeButton = modeRadio('내용', 'contents', hasContentSearch)
  modeGroup.append(nameModeButton, contentModeButton)
  bindRovingKeys(modeGroup, () => [nameModeButton, contentModeButton], node => setSearchMode(node.dataset.mode))
  const searchLabel = el('label', 'egdesk-file-search-label')
  layout(searchLabel, 'flex: 1 1 14rem; min-width: 0;')
  const searchLabelText = el('span', 'egdesk-file-search-label-text', '파일 이름 검색')
  layout(searchLabelText, 'white-space: nowrap; flex: 0 0 auto;')
  const searchInput = el('input', 'egdesk-file-search-input')
  layout(searchInput, 'flex: 1 1 8rem; width: 0; min-width: 4rem; box-sizing: border-box;')
  searchInput.type = 'search'
  searchInput.maxLength = 256
  searchLabel.append(searchLabelText, searchInput)
  const searchButton = button('검색', 'egdesk-file-search-button', () => {})
  searchButton.type = 'submit'
  searchForm.append(modeGroup, searchLabel, searchButton)
  const searchResults = el('div', 'egdesk-file-search-results')
  const workspace = el('section', 'egdesk-file-workspace')
  layout(workspace, 'min-width: 0;')
  const title = el('h2', 'egdesk-file-title', '파일을 선택하세요')
  layout(title, 'min-width: 0; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;')
  const setTitle = text => { title.textContent = text; title.title = text }
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
  const changeDiffPanel = el('section', 'egdesk-file-change-diff')
  changeDiffPanel.hidden = true
  changeDiffPanel.setAttribute('aria-label', '커밋 안 한 변경 보기')
  const checkPanel = el('section', 'egdesk-file-check-result')
  layout(checkPanel, 'flex: 0 0 auto; min-width: 0; max-width: 100%; box-sizing: border-box; overflow-wrap: anywhere;')
  checkPanel.hidden = true
  checkPanel.setAttribute('aria-label', '검사 결과')
  const scriptPanel = el('section', 'egdesk-file-script-settings')
  layout(scriptPanel, 'display: flex; flex-direction: column; gap: 8px; flex: 0 1 auto; min-width: 0; min-height: 0; max-height: 100%; overflow: hidden;')
  scriptPanel.hidden = true
  scriptPanel.setAttribute('aria-label', '검사 명령 설정')
  const sourceConflictPanel = el('section', 'egdesk-file-source-conflict')
  sourceConflictPanel.hidden = true
  sourceConflictPanel.setAttribute('aria-label', '원본 비교')
  const changeReviewPanel = el('section', 'egdesk-file-change-review-panel')
  changeReviewPanel.hidden = true
  changeReviewPanel.setAttribute('aria-label', '변경 검토')
  const status = el('p', 'egdesk-file-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const error = el('p', 'egdesk-file-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const connectButton = button('폴더 연결', 'egdesk-file-connect', async () => {
    if (!chooseRoot) return
    try { const selected = await chooseRoot(); if (selected && !disposed) await openRoot(selected, { project: null }) }
    catch (cause) { showError(cause) }
  })
  connectButton.disabled = typeof chooseRoot !== 'function'
  connectButton.title = chooseRoot ? 'OS 선택기로 허용할 폴더를 고릅니다.' : '폴더 선택기가 연결되지 않았습니다.'
  const projectConnectButton = button('보드 프로젝트 연결', 'egdesk-file-project-connect', () => act(async () => {
    if (projectConnecting || typeof chooseProject !== 'function') return
    // Read the Board once, synchronously with the click, never after a picker.
    const selectedTarget = getProjectTarget?.()
    if (!selectedTarget?.boardId) { announce('프로젝트를 연결할 보드를 먼저 선택하세요.'); return }
    const target = Object.freeze({ boardId: selectedTarget.boardId, title: selectedTarget.title || '선택한 보드' })
    projectConnecting = true
    projectConnectButton.disabled = true; connectButton.disabled = true
    showProjectTarget(target)
    try {
      const project = await chooseProject(target)
      if (project && !disposed) await openProject(project)
    } finally {
      projectConnecting = false
      projectConnectButton.disabled = typeof chooseProject !== 'function'
      connectButton.disabled = typeof chooseRoot !== 'function'
    }
  }))
  const projectActionLabel = el('span', 'egdesk-file-project-connect-label', '보드 프로젝트 연결')
  const projectTargetLabel = el('span', 'egdesk-file-project-target')
  layout(projectConnectButton, 'display: inline-flex; align-items: center; min-width: 0; max-width: 100%; white-space: nowrap; overflow: hidden;')
  layout(projectActionLabel, 'flex: 0 0 auto;')
  layout(projectTargetLabel, 'flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;')
  projectConnectButton.replaceChildren(projectActionLabel, projectTargetLabel)
  const showProjectTarget = target => {
    projectTargetLabel.textContent = target?.title ? ` · ${target.title}` : ''
    projectConnectButton.setAttribute('aria-label', `보드 프로젝트 연결${target?.title ? ` · ${target.title}` : ''}`)
    projectConnectButton.title = target?.boardId ? `${target.title || '선택한 보드'}의 기존 프로젝트를 열거나 폴더를 연결합니다.` : '프로젝트를 연결할 보드를 먼저 선택하세요.'
  }
  projectConnectButton.hidden = typeof chooseProject !== 'function' || typeof getProjectTarget !== 'function'
  const refreshProjectTarget = () => {
    if (projectConnecting || projectConnectButton.hidden) return
    const target = getProjectTarget?.()
    showProjectTarget(target)
  }
  projectConnectButton.addEventListener('focus', refreshProjectTarget)
  projectConnectButton.addEventListener('mouseenter', refreshProjectTarget)
  const reviewButton = button('변경 비교', 'egdesk-file-review-button', () => act(review))
  const saveOriginalButton = button('원본에 저장', 'egdesk-file-save-original-button', () => act(() => saveOriginal()))
  saveOriginalButton.hidden = !hasOriginalSave
  saveOriginalButton.title = '열 때와 같은 원본이면 원본 파일에 저장합니다. 그 사이 바뀌었으면 비교 화면을 먼저 보여 줍니다.'
  const saveButton = button('작업사본 저장', 'egdesk-file-save-button', () => act(save))
  const saveAsButton = button('다른 이름으로 새 파일 저장', 'egdesk-file-save-as-button', () => act(saveAs))
  const checkButton = button('검사', 'egdesk-file-check-button', () => act(check))
  const reconnectButton = button('원본 다시 연결', 'egdesk-file-reconnect-button', () => act(beginReconnect))
  reconnectButton.hidden = true
  reconnectButton.disabled = !chooseRoot || typeof service.reconnectDraft !== 'function'
  saveAsButton.disabled = typeof chooseSaveAs !== 'function'
  checkButton.disabled = typeof runCheck !== 'function'
  checkButton.hidden = projectChecksOnly
  saveAsButton.title = chooseSaveAs ? '기존 파일은 덮어쓰지 않습니다.' : '저장 위치 선택기가 연결되지 않았습니다.'
  checkButton.title = runCheck ? '현재 저장된 작업사본에 검사를 실행합니다.' : '검사 실행기가 연결되지 않았습니다.'
  const projectCheckButton = button('검사', 'egdesk-file-project-check', () => act(() => check()))
  projectCheckButton.hidden = true
  const scriptSettingsButton = button('검사 명령 설정', 'egdesk-file-script-settings-button', () => act(showScriptSettings))
  scriptSettingsButton.hidden = true
  projectActions.hidden = true
  for (const control of [connectButton, scriptSettingsButton, projectCheckButton, nameModeButton, contentModeButton, searchButton]) {
    layout(control, 'white-space: nowrap; flex-shrink: 0;')
  }
  actions.append(reviewButton, saveOriginalButton, saveButton, saveAsButton, checkButton, reconnectButton)
  connections.append(connectButton, projectConnectButton)
  projectActions.append(scriptSettingsButton, projectCheckButton)
  toolbar.append(connections, projectActions, searchForm)
  workspace.append(title, fileDetails, scriptPanel, editorLabel, viewer, actions, sourceConflictPanel, reviewPanel, changeDiffPanel, checkPanel, changeReviewPanel)
  root.append(toolbar, treePanel, searchResults, workspace, status, error)

  let activeRoot = null
  let activeProject = null
  let projectConnecting = false
  let checking = false
  let projectRevision = 0
  let checkReceipt = null
  let changeReview = null
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
  let activeTab = 'files'
  let searchMode = 'names'
  let gitIndex = createEGDeskGitStateIndex([])
  let statusToken = 0
  let changesToken = 0
  let diffToken = 0
  let fileChangeTimer = null
  const pendingFolders = new Set()
  // NFC folder path ('' = root) → the loaded tree group, for onFileChanged.
  const loadedGroups = new Map()
  const itemHandles = new WeakMap()
  const itemBadges = new WeakMap()
  const draftsByFile = new Map()
  const token = () => ++operation
  const present = generation => !disposed && generation === operation
  // Optional original-run fence. It is authority supplied by the caller, not
  // derived from a printed path or the currently selected Board.
  const scopeCurrent = scope => {
    if (disposed || scope?.signal?.aborted) return false
    if (!scope) return true
    try { return typeof scope.rootId === 'string' && !!scope.rootId && typeof scope.isCurrent === 'function' && scope.isCurrent() === true } catch { return false }
  }
  const openCurrent = (generation, rootId, scope) => present(generation) && scopeCurrent(scope)
    && (activeRoot?.rootId || null) === rootId && (!scope || scope.rootId === rootId)
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
    else if (Object.hasOwn(FILE_ERROR_MESSAGES, cause?.code || '')) error.textContent = FILE_ERROR_MESSAGES[cause.code]
    else error.textContent = cause?.message || String(cause)
    error.hidden = false
    announce(details?.fileMayExist === true ? '새 파일 확인 필요 · 작업사본 유지' : '작업에 실패했습니다. 편집 중인 내용은 그대로 남아 있습니다.')
  }
  const clearError = () => { error.textContent = ''; error.hidden = true }
  // The viewer also carries read-only file information. Only its no-file
  // prompt yields to a rendered result, never to a pending run or script chooser.
  const refreshViewerVisibility = () => {
    const hasResult = !checkPanel.hidden && (checkPanel.querySelector('.egdesk-run-result') || checkPanel.querySelector('.egdesk-file-check-body'))
    viewer.hidden = !editorLabel.hidden || (!activeFileId && !!hasResult)
  }
  const showCheckPanel = () => { checkPanel.hidden = false; refreshViewerVisibility() }
  const setEditable = enabled => {
    editorLabel.hidden = !enabled; actions.hidden = !enabled
    refreshViewerVisibility()
    saveAsButton.disabled = !enabled || !chooseSaveAs || draft?.saveAsAvailable !== true
    saveAsButton.title = draft?.saveAsAvailable === true ? '기존 파일은 덮어쓰지 않습니다.' : '새 파일 저장 기능을 준비 중입니다.'
    saveOriginalButton.disabled = !enabled || sourceDisconnected
    reconnectButton.hidden = !enabled || !sourceDisconnected
  }
  const refreshProjectCheck = () => {
    const scripts = activeProject?.scripts || []
    projectCheckButton.hidden = !scripts.length || typeof runCheck !== 'function'
    projectCheckButton.title = `${scripts.length === 1 ? `${scripts[0].name}: ${scripts[0].command}` : '프로젝트에 저장한 명령 중 하나를 실행합니다.'} · 디스크에 저장된 원본 기준`
    projectCheckButton.disabled = checking
    scriptSettingsButton.hidden = !activeProject || typeof service.setProjectScripts !== 'function'
    projectActions.hidden = scriptSettingsButton.hidden && projectCheckButton.hidden
    checkButton.disabled = typeof runCheck !== 'function' || checking
    checkButton.hidden = projectChecksOnly || !!activeProject
  }
  const dirty = () => !!draft && (editor.value !== draft.text || draft.bufferRevision !== draft.savedRevision)
  const snapshot = () => ({ rootId: activeRoot?.rootId || null, projectId: activeProject?.projectId || null, fileId: activeFileId, draftId: draft?.id || null, sourceRevision: readReceipt?.diskRevision || null, sourceConnection: sourceDisconnected ? 'reconnect-required' : 'connected', bufferRevision: draft?.bufferRevision ?? null, savedRevision: draft?.savedRevision ?? null, dirty: dirty(), originalDirty: !!draft && typeof draft.baseText === 'string' && editor.value !== draft.baseText, scrollTop: editorLabel.hidden ? viewer.scrollTop : editor.scrollTop })

  function markCheckStale() {
    projectRevision++
    if (!checkReceipt) return
    checkReceipt.stale = true
    refreshCheckStale()
  }
  function refreshCheckStale() {
    if (!checkReceipt) return
    let label = checkPanel.querySelector('.egdesk-file-check-stale')
    if (!label) { label = el('p', 'egdesk-file-check-stale'); label.setAttribute('role', 'status'); label.setAttribute('data-testid', 'file-check-stale'); checkPanel.append(label) }
    label.textContent = checkReceipt.stale ? '실행 이후 변경 있음 · 아래 결과는 실행을 시작한 폴더·내용 기준입니다.' : ''
    label.hidden = !checkReceipt.stale
  }

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

  const keyOf = relativePath => String(relativePath).normalize('NFC')
  const joinRelative = (parent, name) => parent ? `${parent}/${name}` : name

  function decorateItem(item) {
    const badge = itemBadges.get(item)
    if (!badge) return
    const state = gitIndex.stateFor(item.dataset.relativePath)
    const label = state ? EGDESK_GIT_STATE_LABELS[state] : null
    badge.textContent = label ? label.letter : ''
    badge.hidden = !label
    if (label) item.dataset.gitState = state
    else delete item.dataset.gitState
    item.setAttribute('aria-label', label ? `${item.dataset.name}, ${label.label}` : item.dataset.name)
  }

  function makeTreeItem(entry, parentPath) {
    const item = el('li', `egdesk-file-tree-item egdesk-file-${entry.kind}`, entry.name)
    item.setAttribute('role', 'treeitem')
    item.setAttribute('aria-label', entry.name)
    item.tabIndex = -1
    item.dataset.kind = entry.kind
    item.dataset.name = entry.name
    item.dataset.relativePath = joinRelative(parentPath, entry.name)
    if (entry.id) itemHandles.set(item, entry.id)
    const badge = el('span', 'egdesk-file-tree-state')
    badge.setAttribute('aria-hidden', 'true')
    badge.hidden = true
    item.append(badge)
    itemBadges.set(item, badge)
    if (entry.kind === 'blocked') {
      item.setAttribute('aria-disabled', 'true')
      item.title = entry.reason === 'symlink' ? '심볼릭 링크는 열지 않습니다.' : '이 항목은 열 수 없습니다.'
    } else if (entry.kind === 'directory') {
      item.setAttribute('aria-expanded', 'false')
      item.addEventListener('click', event => { event.stopPropagation(); if (event.target.closest('[role="treeitem"]') !== item) return; act(async () => {
        const expanded = item.getAttribute('aria-expanded') === 'true'
        item.setAttribute('aria-expanded', expanded ? 'false' : 'true')
        let children = item.querySelector('[role="group"]')
        if (!children) { children = el('ul', 'egdesk-file-tree-group'); children.setAttribute('role', 'group'); item.append(children); await appendDirectory(itemHandles.get(item), children, 0, treeGeneration, item.dataset.relativePath) }
        children.hidden = expanded
      }) })
    } else {
      item.addEventListener('click', event => { event.stopPropagation(); const id = itemHandles.get(item); act(() => pendingReconnect ? reconnectSource(id) : openFile(id)) })
    }
    decorateItem(item)
    return item
  }

  function moreRow(directoryId, group, nextCursor, generation, parentPath) {
    const holder = el('li', 'egdesk-file-tree-more-row')
    const more = button('더 보기', 'egdesk-file-tree-more', () => act(async () => { holder.remove(); await appendDirectory(directoryId, group, nextCursor, generation, parentPath) }))
    more.addEventListener('click', event => event.stopPropagation())
    holder.append(more)
    return holder
  }

  async function appendDirectory(directoryId, group, cursor = 0, generation = treeGeneration, parentPath = '', opening = null) {
    const current = () => !disposed && generation === treeGeneration && (!opening || openCurrent(opening.generation, opening.rootId, opening.scope))
    if (!current()) return false
    let result
    try { result = await service.listDirectory({ directoryId, cursor, limit: 100 }) }
    catch (cause) { if (!current()) return false; throw cause }
    if (!current()) return false
    const key = keyOf(parentPath)
    if (cursor === 0) loadedGroups.set(key, { group, directoryId, parentPath, loaded: 0 })
    const registered = loadedGroups.get(key)
    if (registered?.group === group) registered.loaded += result.entries.length
    for (const entry of result.entries) group.append(makeTreeItem(entry, parentPath))
    if (result.nextCursor != null) group.append(moreRow(directoryId, group, result.nextCursor, generation, parentPath))
    return true
  }

  function forgetLoaded(relativePath) {
    const key = keyOf(relativePath)
    for (const loaded of [...loadedGroups.keys()]) if (loaded === key || loaded.startsWith(`${key}/`)) loadedGroups.delete(loaded)
  }

  function ensureRovingTabStop() {
    const items = treeItems()
    if (items.length && !items.some(item => item.getAttribute('tabindex') === '0')) items[0].setAttribute('tabindex', '0')
  }

  // Re-list one loaded folder and reconcile by name: kept items (and their
  // expanded subtrees) stay, new names are added in listing order, gone names
  // are removed. Handles are refreshed from the new listing.
  async function reconcileFolder(folderKey, generation) {
    const loaded = loadedGroups.get(folderKey)
    if (!loaded) return
    const wanted = Math.max(loaded.loaded, 1)
    const listed = []
    let cursor = 0
    let nextCursor = null
    try {
      do {
        const page = await service.listDirectory({ directoryId: loaded.directoryId, cursor, limit: Math.min(200, Math.max(100, wanted - listed.length)) })
        if (disposed || generation !== treeGeneration || loadedGroups.get(folderKey) !== loaded) return
        listed.push(...page.entries)
        nextCursor = page.nextCursor
        cursor = nextCursor ?? cursor
      } while (nextCursor != null && listed.length < wanted)
    } catch {
      // The folder itself is gone or replaced; its parent's reconcile removes it.
      if (folderKey) forgetLoaded(folderKey)
      return
    }
    const currentItems = [...loaded.group.children].filter(node => node.getAttribute?.('role') === 'treeitem')
    const hadMore = [...loaded.group.children].some(node => node.getAttribute?.('role') !== 'treeitem')
    const existing = new Map(currentItems.map(node => [node.dataset.name, node]))
    const items = []
    for (const entry of listed) {
      const kept = existing.get(entry.name)
      if (kept && kept.dataset.kind === entry.kind) {
        existing.delete(entry.name)
        if (entry.id) itemHandles.set(kept, entry.id)
        if (entry.kind === 'directory') { const child = loadedGroups.get(keyOf(kept.dataset.relativePath)); if (child) child.directoryId = entry.id }
        decorateItem(kept)
        items.push(kept)
      } else items.push(makeTreeItem(entry, loaded.parentPath))
    }
    const removed = [...existing.values()]
    loaded.loaded = listed.length
    // Content edits leave the listing as it was: no DOM churn, no focus loss.
    if (!removed.length && !hadMore && nextCursor == null && items.length === currentItems.length && items.every((item, index) => item === currentItems[index])) return
    const active = document.activeElement
    const focusLost = removed.some(node => node.contains(active))
    const focusKept = !focusLost && items.some(node => node.contains(active)) ? active : null
    for (const node of removed) forgetLoaded(node.dataset.relativePath)
    loaded.group.replaceChildren(...items, ...(nextCursor != null ? [moreRow(loaded.directoryId, loaded.group, nextCursor, generation, loaded.parentPath)] : []))
    if (focusKept && document.activeElement !== focusKept) focusKept.focus?.({ preventScroll: true })
    if (focusLost) (loaded.group.parentElement?.closest?.('[role="treeitem"]') || items[0])?.focus?.({ preventScroll: true })
    ensureRovingTabStop()
  }

  async function refreshGitStatus() {
    if (!activeRoot || typeof service.gitStatus !== 'function') return null
    const currentToken = ++statusToken
    const generation = treeGeneration
    let result
    try { result = await service.gitStatus({ rootId: activeRoot.rootId }) }
    catch { return null }
    if (disposed || generation !== treeGeneration || currentToken !== statusToken) return null
    gitIndex = createEGDeskGitStateIndex(result?.available && result?.isRepo ? result.entries : [])
    for (const item of tree.querySelectorAll('[role="treeitem"]')) decorateItem(item)
    return result
  }

  async function openRoot(rootHandle, { preserveDraft = false, project = undefined, scope = null } = {}) {
    if (!rootHandle?.rootId || !rootHandle?.directoryId) throw new Error('허용된 폴더 핸들이 없습니다.')
    if (!scopeCurrent(scope) || scope && scope.rootId !== rootHandle.rootId) return false
    // Claim the operation before the first await; an older flush may not adopt
    // a new root after a more recent file/root selection or close.
    const generation = token()
    rootHandle = { ...rootHandle }
    if (draft && editor.value !== draft.text) {
      try { await flush() }
      catch (cause) { if (!present(generation) || !scopeCurrent(scope)) return false; throw cause }
      if (!present(generation) || !scopeCurrent(scope)) return false
    }
    treeGeneration++
    markCheckStale()
    scriptPanel.hidden = true
    activeProject = project !== undefined ? project : activeProject?.rootId === rootHandle.rootId ? activeProject : null
    refreshProjectCheck()
    changeReview?.dispose(); changeReview = null; changeReviewPanel.hidden = true; sourceConflictPanel.hidden = true
    activeRoot = rootHandle
    if (!preserveDraft) { activeFileId = null; draft = null; readReceipt = null; sourceDisconnected = false; pendingReconnect = false }
    loadedGroups.clear(); pendingFolders.clear(); gitIndex = createEGDeskGitStateIndex([])
    if (fileChangeTimer) { clearTimeout(fileChangeTimer); fileChangeTimer = null }
    tree.replaceChildren()
    searchResults.replaceChildren()
    changeList.replaceChildren(); changesSummary.textContent = ''; changeDiffPanel.hidden = true
    if (!preserveDraft) { setTitle(rootHandle.name || '연결된 폴더'); setEditable(false); viewer.textContent = '트리에서 파일을 선택하세요.' }
    await appendDirectory(rootHandle.directoryId, tree, 0, treeGeneration, '', scope ? { generation, rootId: rootHandle.rootId, scope } : null)
    if (openCurrent(generation, rootHandle.rootId, scope)) {
      tree.querySelector('[role="treeitem"]')?.setAttribute('tabindex', '0'); announce('폴더가 연결되었습니다.')
      // Background: a slow git status must not hold the tree or a restore.
      // An original-run read opens only files, not an implicit git subprocess.
      if (!scope) {
        refreshGitStatus().catch(() => {})
        if (activeTab === 'changes') refreshChanges().catch(() => {})
      }
      return true
    }
    return false
  }

  function selectTab(name) {
    if (name === 'changes' && !hasGitChanges) return
    activeTab = name === 'changes' ? 'changes' : 'files'
    for (const tab of [filesTab, changesTab]) {
      const selected = tab.dataset.tab === activeTab
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    tree.hidden = activeTab !== 'files'
    changesPanel.hidden = activeTab !== 'changes'
    if (activeTab === 'changes') act(refreshChanges)
  }

  function setSearchMode(mode) {
    if (mode === 'contents' && !hasContentSearch) return
    searchMode = mode === 'contents' ? 'contents' : 'names'
    for (const radio of [nameModeButton, contentModeButton]) {
      const checked = radio.dataset.mode === searchMode
      radio.setAttribute('aria-checked', String(checked))
      radio.tabIndex = checked ? 0 : -1
    }
    searchLabelText.textContent = searchMode === 'contents' ? '파일 내용 검색' : '파일 이름 검색'
  }

  function hunkSections(hunks, { before, after, heading }) {
    return hunks.map(hunk => {
      const section = el('section', 'egdesk-file-hunk')
      section.append(el('h4', 'egdesk-file-hunk-title', heading(hunk)))
      const baseText = el('pre', 'egdesk-file-hunk-before', hunk.baseLines.join('\n'))
      baseText.setAttribute('aria-label', before)
      const currentText = el('pre', 'egdesk-file-hunk-after', hunk.currentLines.join('\n'))
      currentText.setAttribute('aria-label', after)
      section.append(baseText, currentText)
      return section
    })
  }

  async function refreshChanges() {
    if (!hasGitChanges) return null
    if (!activeRoot) { changeList.replaceChildren(); changesSummary.textContent = '먼저 폴더를 연결하세요.'; return null }
    const currentToken = ++changesToken
    const generation = treeGeneration
    changesPanel.setAttribute('aria-busy', 'true')
    try {
      const result = await service.gitChanges({ rootId: activeRoot.rootId, scope: 'uncommitted' })
      if (disposed || generation !== treeGeneration || currentToken !== changesToken) return null
      renderChanges(result)
      return result
    } finally { if (currentToken === changesToken) changesPanel.setAttribute('aria-busy', 'false') }
  }

  function renderChanges(result) {
    changeList.replaceChildren()
    const branch = result.branch ? `${result.branch} · ` : ''
    if (!result.available) { changesSummary.textContent = 'git을 찾을 수 없어 변경을 볼 수 없습니다.'; return }
    if (!result.isRepo) { changesSummary.textContent = '이 폴더는 git 저장소 안에 있지 않습니다.'; return }
    if (!result.files.length) { changesSummary.textContent = `${branch}커밋 안 한 변경이 없습니다.`; return }
    const totals = result.totals || { files: result.files.length, additions: 0, deletions: 0 }
    changesSummary.textContent = `${branch}파일 ${totals.files}개${result.countsAvailable === false ? '' : ` · +${totals.additions} −${totals.deletions}`}${result.truncated ? ' · 일부만 표시' : ''}`
    for (const file of result.files) {
      const label = EGDESK_GIT_STATE_LABELS[file.status] || EGDESK_GIT_STATE_LABELS.modified
      const counts = file.binary ? '이진 파일' : Number.isInteger(file.additions) ? `+${file.additions} −${file.deletions}` : ''
      const row = el('li', 'egdesk-file-change-item')
      row.dataset.status = file.status
      const open = button('', 'egdesk-file-change-row', () => act(() => showChangeDiff(file)))
      const letter = el('span', 'egdesk-file-change-state', label.letter)
      letter.setAttribute('aria-hidden', 'true')
      open.append(letter, el('span', 'egdesk-file-change-path', file.previousPath ? `${file.previousPath} → ${file.relativePath}` : file.relativePath), el('span', 'egdesk-file-change-counts', counts))
      open.setAttribute('aria-label', `${file.relativePath}, ${label.label}${counts ? `, ${counts}` : ''}`)
      row.append(open)
      changeList.append(row)
    }
  }

  async function showChangeDiff(file) {
    const currentToken = ++diffToken
    const generation = treeGeneration
    const diff = await service.gitFileDiff({ changeId: file.changeId })
    if (disposed || generation !== treeGeneration || currentToken !== diffToken) return
    const label = EGDESK_GIT_STATE_LABELS[diff.status] || EGDESK_GIT_STATE_LABELS.modified
    changeDiffPanel.replaceChildren(el('h3', 'egdesk-file-change-diff-heading', `${diff.relativePath} · ${label.label}`))
    if (diff.previousPath) changeDiffPanel.append(el('p', 'egdesk-file-change-previous', `이전 이름: ${diff.previousPath}`))
    if (diff.fileId && diff.status !== 'deleted') changeDiffPanel.append(button('파일 열기', 'egdesk-file-change-open', () => act(() => openFile(diff.fileId, null, { keepChangeDiff: true }))))
    if (diff.binary) changeDiffPanel.append(el('p', 'egdesk-file-no-changes', '이진 파일은 줄 비교를 보여 주지 않습니다.'))
    else if (diff.tooLarge) changeDiffPanel.append(el('p', 'egdesk-file-no-changes', '파일이 1MB보다 커서 비교를 보여 주지 않습니다.'))
    else if (!diff.hunks.length) changeDiffPanel.append(el('p', 'egdesk-file-no-changes', diff.status === 'renamed' ? '이름만 바뀌었습니다.' : '내용 변경이 없습니다.'))
    else changeDiffPanel.append(...hunkSections(diff.hunks, { before: '커밋된 내용', after: '지금 내용', heading: hunk => `커밋 ${hunk.baseStartLine}행 ↔ 지금 ${hunk.currentStartLine}행` }))
    if (diff.truncated && !diff.tooLarge) changeDiffPanel.append(el('p', 'egdesk-file-change-truncated', '비교가 길어 앞부분만 보여 줍니다.'))
    changeDiffPanel.hidden = false
    announce(`변경 보기 · ${diff.relativePath}`)
  }

  // Watcher entry point (`file.changed` relayed to the screen). Changes are
  // collected for fileChangeDelayMs (trailing, not reset by later events),
  // then only the affected loaded folders are re-listed — the changed-paths-only
  // refresh of vibe-kanban diff_stream.rs:379-420 (Apache-2.0), pattern only.
  function onFileChanged(event) {
    const change = normalizeFileChangedEvent(event)
    if (disposed || !change || !activeRoot || change.rootId !== activeRoot.rootId) return false
    markCheckStale()
    pendingFolders.add(keyOf(parentFolderOf(change.relativePath)))
    if (!fileChangeTimer) fileChangeTimer = setTimeout(() => { fileChangeTimer = null; flushFileChanges().catch(() => {}) }, fileChangeDelayMs)
    return true
  }

  async function flushFileChanges() {
    if (fileChangeTimer) { clearTimeout(fileChangeTimer); fileChangeTimer = null }
    const generation = treeGeneration
    const folders = [...pendingFolders].sort((a, b) => a.split('/').length - b.split('/').length)
    pendingFolders.clear()
    for (const folder of folders) {
      if (disposed || generation !== treeGeneration) return
      await reconcileFolder(folder, generation)
    }
    if (disposed || generation !== treeGeneration) return
    await Promise.all([refreshGitStatus(), activeTab === 'changes' ? refreshChanges().catch(() => null) : null])
  }

  // Move the caret to a 1-based line of the open working copy (content search
  // results, later activity/result links). Only on an explicit user action.
  function revealLine(lineNumber) {
    if (!draft || editorLabel.hidden || !Number.isInteger(lineNumber) || lineNumber < 1) return false
    const text = editor.value
    let start = 0
    let line = 1
    while (line < lineNumber) {
      const next = text.indexOf('\n', start)
      if (next < 0) break
      start = next + 1
      line++
    }
    const end = text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start)
    const lineHeight = Number.parseFloat(document.defaultView?.getComputedStyle?.(editor)?.lineHeight) || 18
    editor.scrollTop = Math.max(0, (line - 1) * lineHeight - (editor.clientHeight || 0) / 3)
    editor.focus()
    editor.setSelectionRange?.(start, end)
    announce(`${line}행으로 이동했습니다.`)
    return true
  }

  async function openFile(fileId, restoredDraftId = null, { focus = true, keepChangeDiff = false, scope = null, operationGeneration = null } = {}) {
    const rootId = activeRoot?.rootId || null
    if (!scopeCurrent(scope) || scope && scope.rootId !== rootId) return false
    const generation = operationGeneration ?? token()
    const current = () => openCurrent(generation, rootId, scope)
    const readOrStale = promise => Promise.resolve(promise).catch(cause => { if (current()) throw cause; return null })
    if (!current()) return false
    const restored = restoredDraftId && typeof service.readDraft === 'function' ? await readOrStale(service.readDraft({ draftId: restoredDraftId })) : null
    if (!current()) return false
    let read
    let disconnected = false
    try { read = await service.readFile({ fileId }) }
    catch (cause) {
      if (!current()) return false
      if (scope || !restored || restored.fileId !== fileId) throw cause
      read = { name: restored.name, size: null, sha256: restored.sourceHash, diskRevision: restored.sourceRevision, kind: 'text' }
      disconnected = true
    }
    if (!current()) return false
    if (scope && read.fileId !== fileId) throw new Error('확인한 파일과 읽은 파일이 일치하지 않습니다.')
    let nextDraft = null
    if (read.kind === 'text') {
      const prior = draftsByFile.get(fileId)
      if (restoredDraftId && typeof service.readDraft !== 'function') throw new Error('작업사본 재열기 기능이 연결되지 않았습니다.')
      nextDraft = await readOrStale(restored || (restoredDraftId ? service.readDraft({ draftId: restoredDraftId })
        : prior && typeof service.readDraft === 'function' ? service.readDraft({ draftId: prior.id })
          : prior || service.createDraft({ fileId })))
      if (!current()) return false
      if (nextDraft.fileId !== fileId) throw new Error('작업사본과 파일 대상이 일치하지 않습니다.')
      if (scope && (nextDraft.rootId !== rootId || nextDraft.sourceHash !== read.sha256 || nextDraft.sourceRevision !== read.diskRevision)) {
        throw new Error('파일 연결 또는 내용이 읽는 동안 바뀌었습니다. 현재 파일 열기를 다시 선택하세요.')
      }
    }

    // A remains the active visual/editing target while B is prepared. Preserve
    // edits arriving during either read or draft creation, including additional
    // typing while that preservation write is in flight, before adopting B.
    while (draft) {
      if (composing) { announce('입력을 마친 후 파일을 다시 여세요.'); return }
      await readOrStale(flush())
      if (!current()) return false
      if (composing) { announce('입력을 마친 후 파일을 다시 여세요.'); return }
      if (!draft || editor.value === draft.text) break
    }
    if (!current()) return false
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
    setTitle(read.name)
    meta.textContent = `${read.size == null ? '원본 위치 확인 필요' : `${read.size} byte`} · SHA-256 ${read.sha256}`
    reviewPanel.hidden = true
    checkPanel.hidden = true
    if (!keepChangeDiff) changeDiffPanel.hidden = true
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
    return true
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
    setTitle(reconnected.source.name)
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
  editor.addEventListener('input', () => { localRevision++; markCheckStale(); announce('저장되지 않은 변경이 있습니다.'); if (!composing) scheduleFlush() })
  function scheduleFlush() { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; act(flush) }, 250) }

  // Working copy vs the original it was opened from. With EGDeskDiffView the
  // −/+ line view (3.2 adjust: 'CodeMirror 전엔 EGDeskDiffView'); without it,
  // the helper's hunks in the plain layout.
  async function review() {
    if (!draft) return
    await flush()
    const generation = operation
    const targetDraftId = draft.id
    const diffView = typeof draft.baseText === 'string' ? await part('diffView') : null
    if (!present(generation) || draft?.id !== targetDraftId) return
    if (diffView) {
      const file = diffView.fileDiffFromTexts({ path: draft.name || readReceipt?.name || '', oldText: draft.baseText, newText: draft.text, change: 'update' })
      reviewPanel.replaceChildren(el('h3', 'egdesk-file-review-heading', `변경 비교 · 버퍼 ${draft.bufferRevision}`))
      if (file.status === 'empty') reviewPanel.append(el('p', 'egdesk-file-no-changes', '원본과 비교한 변경이 없습니다.'))
      else reviewPanel.append(diffView.renderDiffView({ document, files: [file], openFiles: 1 }))
      reviewPanel.hidden = false
      announce('변경 비교')
      return
    }
    const diff = await service.diffDraft({ draftId: targetDraftId })
    if (!present(generation) || draft?.id !== targetDraftId) return
    reviewPanel.replaceChildren()
    const heading = el('h3', 'egdesk-file-review-heading', `변경 비교 · 버퍼 ${diff.bufferRevision}`)
    reviewPanel.append(heading)
    if (!diff.hunks.length) reviewPanel.append(el('p', 'egdesk-file-no-changes', '원본과 비교한 변경이 없습니다.'))
    reviewPanel.append(...hunkSections(diff.hunks, { before: '원본 내용', after: '현재 작업사본 내용', heading: hunk => `원본 ${hunk.baseStartLine}행 ↔ 현재 ${hunk.currentStartLine}행` }))
    reviewPanel.hidden = false
    announce('변경 비교')
  }

  // D-X1 user save into the original. expectedSourceHash is the disk hash the
  // user just saw on the comparison screen (knowing overwrite).
  async function saveOriginal({ expectedSourceHash = null } = {}) {
    if (!draft || !hasOriginalSave) return null
    if (composing) { announce('입력을 마친 후 저장하세요.'); return null }
    await flush()
    if (!draft || editor.value !== draft.text) { announce('입력 중인 새 변경이 남아 있습니다. 잠시 후 다시 저장하세요.'); return null }
    const target = draft
    const generation = operation
    let result
    savePromise = service.saveOriginal({ draftId: target.id, expectedHead: target.head, bufferRevision: target.bufferRevision, operationId: operationId('file-save-original'), ...(expectedSourceHash ? { expectedSourceHash } : {}) })
    try { result = await savePromise }
    catch (cause) {
      if (cause?.code === 'SOURCE_CHANGED' && present(generation) && draft?.id === target.id) { await showSourceConflict(target, cause.details || {}); return null }
      if (['RESOURCE_CHANGED', 'SOURCE_RECONNECT_REQUIRED'].includes(cause?.code) && draft?.id === target.id) { sourceDisconnected = true; setEditable(true) }
      throw cause
    } finally { savePromise = null }
    if (result?.draft && draft?.id === target.id) { draft = result.draft; draftsByFile.set(activeFileId, draft) }
    if (!present(generation) || draft?.id !== target.id) return result
    sourceConflictPanel.hidden = true
    const receipt = result?.receipt || {}
    readReceipt = { ...readReceipt, size: receipt.size ?? readReceipt?.size, sha256: receipt.sha256 || readReceipt?.sha256, diskRevision: draft.sourceRevision || readReceipt?.diskRevision }
    meta.textContent = `${readReceipt.size == null ? '원본 위치 확인 필요' : `${readReceipt.size} byte`} · SHA-256 ${readReceipt.sha256}`
    announce(receipt.unchanged ? '원본이 이미 같은 내용입니다.' : editor.value === target.text ? '원본에 저장했습니다.' : '원본에 저장했습니다 · 새 변경 있음')
    return result
  }

  // The original changed since it was opened: show what is on disk now (−)
  // against the working copy (+), then let the user overwrite knowingly or
  // keep the original.
  async function showSourceConflict(target, details) {
    let disk = null
    try { disk = await service.readFile({ fileId: activeFileId }) }
    catch (cause) {
      if (cause?.code === 'RESOURCE_CHANGED' || cause?.code === 'RESOURCE_UNAVAILABLE' || cause?.code === 'UNKNOWN_RESOURCE') {
        sourceDisconnected = true; setEditable(true)
        throw Object.assign(new Error(FILE_ERROR_MESSAGES.RESOURCE_CHANGED), { code: 'RESOURCE_CHANGED' })
      }
      throw cause
    }
    if (draft?.id !== target.id) return
    const diskHash = disk?.sha256 || details.currentSourceHash || null
    const diffView = disk?.kind === 'text' ? await part('diffView') : null
    sourceConflictPanel.replaceChildren(
      el('h3', 'egdesk-file-source-conflict-heading', '원본이 열 때와 다릅니다'),
      el('p', 'egdesk-file-source-conflict-text', '다른 프로그램이 원본을 바꿨습니다. 아래는 지금 원본(−)과 내 작업사본(+)의 차이입니다. 원본은 아직 그대로입니다.'))
    if (disk?.kind !== 'text') sourceConflictPanel.append(el('p', 'egdesk-file-no-changes', '지금 원본이 텍스트가 아니어서 비교를 보여 주지 않습니다.'))
    else if (diffView) sourceConflictPanel.append(diffView.renderDiffView({ document, files: [diffView.fileDiffFromTexts({ path: target.name || readReceipt?.name || '', oldText: disk.text, newText: target.text, change: 'update' })], openFiles: 1 }))
    else sourceConflictPanel.append(...hunkSections([{ baseStartLine: 1, baseLines: String(disk.text).split('\n'), currentStartLine: 1, currentLines: String(target.text).split('\n') }], { before: '지금 원본', after: '내 작업사본', heading: () => '지금 원본 ↔ 내 작업사본' }))
    const overwrite = button('내 작업사본으로 원본 덮어쓰기', 'egdesk-file-source-conflict-overwrite', () => act(() => saveOriginal({ expectedSourceHash: diskHash })))
    overwrite.disabled = !diskHash
    const keep = button('원본 그대로 두기', 'egdesk-file-source-conflict-keep', () => { sourceConflictPanel.hidden = true; announce('원본을 그대로 두었습니다. 작업사본은 유지됩니다.') })
    const choices = el('div', 'egdesk-file-source-conflict-actions')
    choices.append(overwrite, keep)
    sourceConflictPanel.append(choices)
    sourceConflictPanel.hidden = false
    announce('원본이 바뀌어 저장하지 않았습니다. 비교를 확인하세요.')
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

  // D-X6: a project command the user typed, run by the shell in the terminal.
  // Several commands → the user picks one (the exact command is shown). The
  // command runs on the files on disk, so working-copy text that was not
  // saved to the original is reported first instead of tested silently.
  function showScriptSettings() {
    if (!activeProject || typeof service.setProjectScripts !== 'function') return
    const projectId = activeProject.projectId, rootId = activeRoot?.rootId
    const fields = el('fieldset', 'egdesk-file-script-fields')
    fields.setAttribute('aria-label', '저장할 검사 명령')
    layout(fields, 'display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; min-width: 0; min-height: 0; max-height: 20rem; overflow: auto; margin: 0; padding: 2px; border: 0;')
    const rows = []
    const add = value => {
      if (rows.length >= 12) return
      const row = el('div', 'egdesk-file-script-row')
      layout(row, 'display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 6px; flex: 0 0 auto; min-width: 0;')
      const nameLabel = el('label', 'egdesk-file-script-name-label', '이름')
      layout(nameLabel, 'display: flex; flex-direction: column; gap: 4px; min-width: 0; grid-column: 1; grid-row: 1;')
      const name = el('input', 'egdesk-file-script-name')
      name.type = 'text'; name.maxLength = 60; name.value = value?.name || ''
      name.setAttribute('aria-label', '검사 명령 이름')
      name.setAttribute('data-testid', 'file-script-name')
      const commandLabel = el('label', 'egdesk-file-script-command-label', '명령')
      layout(commandLabel, 'display: flex; flex-direction: column; gap: 4px; min-width: 0; grid-column: 1 / -1; grid-row: 2;')
      const command = el('input', 'egdesk-file-script-command')
      command.type = 'text'; command.maxLength = 1000; command.value = value?.command || ''
      command.setAttribute('aria-label', '실행할 정확한 명령')
      command.setAttribute('data-testid', 'file-script-command')
      for (const input of [name, command]) {
        layout(input, `width: 100%; min-width: 0; box-sizing: border-box; font: ${input === command ? '13px/1.55 ui-monospace, monospace' : 'inherit'}; color: inherit; background: var(--egd-surface-elevated); border: 1px solid var(--egd-outline); border-radius: 6px; padding: 4px 7px;`)
      }
      command.setAttribute('spellcheck', 'false')
      const entry = { row, name, command, id: value?.id || `script-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, kind: value?.kind }
      const remove = button('삭제', 'egdesk-file-script-remove', () => { rows.splice(rows.indexOf(entry), 1); row.remove(); addButton.disabled = false })
      layout(remove, 'grid-column: 2; grid-row: 1; white-space: nowrap;')
      nameLabel.append(name); commandLabel.append(command)
      row.append(nameLabel, commandLabel, remove); fields.append(row); rows.push(entry)
      addButton.disabled = rows.length >= 12
    }
    const addButton = button('명령 추가', 'egdesk-file-script-add', () => add())
    const saveButton = button('명령 저장', 'egdesk-file-script-save', () => act(async () => {
      if (fields.disabled || disposed || activeProject?.projectId !== projectId || activeRoot?.rootId !== rootId) return
      const scripts = rows.map(({ id, name, command, kind }) => {
        const typedName = name.value.trim(), typedCommand = command.value.trim()
        if (!typedName || typedName.length > 60 || !typedCommand || typedCommand.length > 1000 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(typedName + typedCommand)) {
          throw new Error('이름(60자 이내)과 실행할 명령(1000자 이내)을 한 줄씩 입력하세요.')
        }
        return { id, name: typedName, command: typedCommand, ...(kind ? { kind } : {}) }
      })
      fields.disabled = true; saveButton.disabled = true; addButton.disabled = true
      try {
        const result = await service.setProjectScripts({ projectId, scripts })
        if (result?.projectId !== projectId || !Array.isArray(result.scripts)) throw new Error('검사 명령 저장 결과를 확인하지 못했습니다.')
        if (disposed || activeProject?.projectId !== projectId || activeRoot?.rootId !== rootId) return
        setProjectScripts(result.scripts)
        scriptPanel.hidden = true
        announce('검사 명령을 저장했습니다. 실행하려면 검사를 누르세요.')
      } finally { fields.disabled = false; saveButton.disabled = false; addButton.disabled = rows.length >= 12 }
    }))
    saveButton.setAttribute('data-testid', 'file-script-save')
    const heading = el('h3', '', '검사 명령 설정')
    layout(heading, 'flex: 0 0 auto; margin: 4px 0 0; font: inherit; font-weight: bold;')
    const hint = el('p', '', '직접 입력한 명령만 저장합니다. 저장하거나 프로젝트를 여는 것만으로 실행하지 않습니다.')
    layout(hint, 'flex: 0 0 auto; margin: 0;')
    const editorActions = el('div', 'egdesk-file-script-actions')
    layout(editorActions, 'display: flex; flex-wrap: wrap; gap: 5px; flex: 0 0 auto; padding: 2px 0;')
    const closeButton = button('닫기', 'egdesk-file-script-cancel', () => { scriptPanel.hidden = true })
    for (const control of [addButton, saveButton, closeButton]) layout(control, 'white-space: nowrap; flex-shrink: 0;')
    editorActions.append(addButton, saveButton, closeButton)
    scriptPanel.replaceChildren(heading, hint, fields, editorActions)
    const scripts = activeProject.scripts || []
    for (const script of scripts) add(script)
    if (!scripts.length) add()
    scriptPanel.hidden = false
  }

  async function check(chosen = null) {
    if (typeof runCheck !== 'function' || checking) return
    const scripts = activeProject?.scripts || []
    if (!scripts.length) {
      if (activeProject || projectChecksOnly) { announce(activeProject ? '검사 명령 설정에서 실행할 명령을 먼저 저장하세요.' : '검사할 보드 프로젝트를 먼저 연결하세요.'); return }
      return legacyCheck()
    }
    const script = chosen || (scripts.length === 1 ? scripts[0] : null)
    if (!script) { showScriptChooser(scripts); return }
    if (!scripts.some(saved => saved.id === script.id && saved.name === script.name && saved.command === script.command)) {
      announce('검사 명령이 바뀌었습니다. 저장된 명령을 다시 선택하세요.'); return
    }
    const projectId = activeProject.projectId, rootId = activeRoot?.rootId
    const generation = treeGeneration
    if (draft) {
      await flush()
      if (draft && typeof draft.baseText === 'string' && (editor.value !== draft.text || draft.text !== draft.baseText)) {
        announce('원본에 저장하지 않은 변경이 있습니다. 검사는 디스크의 원본으로 실행되니 먼저 원본에 저장하세요.')
        return
      }
    }
    if (disposed || generation !== treeGeneration || activeProject?.projectId !== projectId || checking) return
    const receipt = { projectId, rootId, projectTitle: activeProject.title || activeRoot?.name || projectId,
      cwd: activeRoot?.displayPath || null, revision: projectRevision, bufferRevision: draft?.bufferRevision ?? null, stale: false }
    checkReceipt = receipt
    checking = true; refreshProjectCheck()
    checkPanel.replaceChildren(el('h3', 'egdesk-file-check-heading', `검사 중 · ${script.name}`))
    showCheckPanel()
    checkPanel.setAttribute('aria-busy', 'true')
    announce(`검사를 시작했습니다 · ${script.name}`)
    let result
    try { result = await runCheck({ projectId, rootId, script: { ...script } }) }
    catch (cause) {
      const notStarted = ['TERMINAL_RUN_REQUEST', 'TERMINAL_RUN_BUSY', 'TERMINAL_INPUT_INACTIVE', 'TERMINAL_INPUT_STALE', 'TERMINAL_PROJECT_CHANGED', 'TERMINAL_RUN_SHELL', 'TERMINAL_NOT_READY'].includes(cause?.code)
      result = { command: script.command, status: notStarted ? 'not-started' : 'unknown', exitCode: null, output: cause?.message || '검사 실행을 확인하지 못했습니다.' }
    }
    finally { checking = false; refreshProjectCheck(); checkPanel.setAttribute('aria-busy', 'false') }
    if (disposed) return
    receipt.stale ||= receipt.revision !== projectRevision || activeProject?.projectId !== projectId || activeRoot?.rootId !== rootId
    await renderCheckResult(result, script, receipt)
  }

  function showScriptChooser(scripts) {
    checkPanel.replaceChildren(el('h3', 'egdesk-file-check-heading', '어떤 검사를 실행할까요?'))
    const list = el('div', 'egdesk-file-check-scripts')
    list.setAttribute('role', 'group')
    list.setAttribute('aria-label', '프로젝트 명령')
    for (const script of scripts) {
      const choice = button(script.name, 'egdesk-file-check-script', () => act(() => check(script)))
      choice.title = script.command
      choice.setAttribute('aria-label', `${script.name}: ${script.command}`)
      choice.append(el('code', 'egdesk-file-check-command', script.command))
      list.append(choice)
    }
    checkPanel.append(list)
    showCheckPanel()
    announce('실행할 명령을 고르세요.')
  }

  async function renderCheckResult(result, script, receipt) {
    const runResult = result && (Object.hasOwn(result, 'output') || Object.hasOwn(result, 'exitCode')) ? await part('runResult') : null
    if (disposed || checkReceipt !== receipt) return
    // Keep the original run's identity, not the currently selected project.
    // Native details makes the full path available by keyboard/click without
    // putting several path lines ahead of the actual outcome on a narrow Card.
    const context = el('details', 'egdesk-file-check-context')
    context.setAttribute('data-testid', 'file-check-location-details')
    const locationToggle = el('summary', 'egdesk-file-check-context-summary')
    locationToggle.setAttribute('data-testid', 'file-check-location-toggle')
    layout(locationToggle, 'white-space: nowrap; cursor: pointer;')
    const locationLabel = el('span', 'egdesk-file-check-context-label', `실행 위치 · ${receipt.projectTitle}`)
    layout(locationLabel, 'display: inline-block; max-width: calc(100% - 1.5em); vertical-align: bottom; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;')
    locationToggle.append(locationLabel)
    const projectLabel = el('p', 'egdesk-file-check-project-name', `프로젝트 · ${receipt.projectTitle}`)
    const fullPath = el('p', 'egdesk-file-check-cwd', `실행 폴더 · ${receipt.cwd || '확인되지 않음'}`)
    fullPath.setAttribute('data-testid', 'file-check-cwd')
    context.append(locationToggle, projectLabel, fullPath)
    if (receipt.bufferRevision != null) context.append(el('p', 'egdesk-file-check-buffer-revision', `작업사본 버전 ${receipt.bufferRevision}`))
    if (runResult) {
      const summary = runResult.summarizeRunResult({ command: result.command || script.command, exitCode: result.exitCode, status: result.status, durationMs: result.durationMs, output: result.output ?? '', cwd: receipt.cwd, projectRoot: receipt.cwd })
      const card = runResult.renderRunResultCard({ document, result: summary, onOpenLocation: location => act(() => {
        if (activeRoot?.rootId !== receipt.rootId || activeProject?.projectId !== receipt.projectId) { announce('이 결과를 실행한 프로젝트를 먼저 열어 주세요.'); return }
        return openAt(location)
      }) })
      const meta = card.querySelector('.egdesk-run-result-meta')
      const contents = [...card.children]
      const metaIndex = contents.indexOf(meta)
      contents.splice(metaIndex < 0 ? contents.length : metaIndex, 0, context)
      card.replaceChildren(...contents)
      checkPanel.replaceChildren(el('h3', 'egdesk-file-check-heading', `검사 결과 · ${script.name}`), card)
      layoutCheckResult()
      showCheckPanel()
      refreshCheckStale()
      announce(`검사 결과 · ${summary.headline}`)
      return
    }
    checkPanel.replaceChildren(el('h3', 'egdesk-file-check-heading', `검사 결과 · ${script.name}`), el('pre', 'egdesk-file-check-body', result?.summary || '검사 결과를 확인할 수 없습니다.'), context)
    layoutCheckResult()
    showCheckPanel()
    refreshCheckStale()
    announce(`검사 결과 · ${script.name}`)
  }

  function layoutCheckResult() {
    // Shared RunResult classes are styled once by the surface stylesheet.
    // Only File's own context/fallback and native keyboard scrolling live here.
    for (const node of checkPanel.querySelectorAll('.egdesk-file-check-context')) {
      layout(node, 'min-width: 0; max-width: 100%; margin: 8px 0; overflow-wrap: anywhere;')
    }
    for (const node of checkPanel.querySelectorAll('.egdesk-file-check-body')) {
      layout(node, 'display: block; width: 100%; min-width: 0; max-width: 100%; max-height: 18rem; box-sizing: border-box; overflow: auto; white-space: pre; overflow-wrap: normal; word-break: normal; font-family: ui-monospace, monospace;')
    }
    for (const selector of ['.egdesk-run-result-command', '.egdesk-run-result-tail', '.egdesk-file-check-body']) {
      for (const node of checkPanel.querySelectorAll(selector)) {
        node.tabIndex = 0 // Native keyboard scrolling of text, not another action.
      }
    }
  }

  async function legacyCheck() {
    if (!draft || !runCheck) return
    await flush()
    if (draft.bufferRevision !== draft.savedRevision) { announce('검사 전에 현재 작업사본을 저장하세요.'); return }
    const targetRevision = draft.savedRevision
    const generation = operation
    const targetDraftId = draft.id
    const checked = await runCheck({ draftId: draft.id, revision: targetRevision, sha256: draft.savedHash })
    if (!present(generation) || draft?.id !== targetDraftId) return
    checkPanel.replaceChildren(el('h3', 'egdesk-file-check-heading', '검사 결과'), el('pre', 'egdesk-file-check-body', checked?.summary || '검사 결과를 확인할 수 없습니다.'))
    layoutCheckResult()
    showCheckPanel()
    announce(`검사 결과 · 작업사본 ${targetRevision}${draft.bufferRevision !== targetRevision ? ' · 이후 변경 있음' : ''}`)
  }

  // A Board project (helper projects/open or attach result) → its folder in
  // this view, with its commands behind '검사'.
  async function openProject(project, { preserveDraft = false } = {}) {
    if (!project?.projectId) throw new Error('프로젝트가 없습니다.')
    if (project.status !== 'connected' || !project.rootId || !project.directoryId) {
      announce(`${project.title || project.name || '프로젝트'} 폴더를 다시 골라 주세요.`)
      return false
    }
    const scripts = Array.isArray(project.scripts) ? project.scripts.filter(script => script && typeof script.name === 'string' && typeof script.command === 'string').map(script => ({ ...script })) : []
    await openRoot({ rootId: project.rootId, directoryId: project.directoryId, name: project.title || project.name, displayPath: project.displayPath, saveAsAvailable: project.saveAsAvailable }, { preserveDraft, project: { projectId: project.projectId, rootId: project.rootId, title: project.title || project.name, scripts } })
    return true
  }

  function setProjectScripts(scripts) {
    if (!activeProject) return false
    markCheckStale()
    activeProject = { ...activeProject, scripts: Array.isArray(scripts) ? scripts.map(script => ({ ...script })) : [] }
    refreshProjectCheck()
    onState(snapshot())
    return true
  }

  // A path printed by an Agent, a test run or a file link → that file in this
  // view at the line. Only inside the connected folder (helper resolve).
  async function openAt({ path: printed, relativePath, line } = {}, { scope = null } = {}) {
    if (!scopeCurrent(scope)) return false
    if (!activeRoot || typeof service.resolvePath !== 'function') { announce('먼저 폴더를 연결하세요.'); return false }
    const rootId = activeRoot.rootId
    if (scope && scope.rootId !== rootId) return false
    const generation = token()
    // Original-run links use their pinned absolute path, never a relative-path
    // hint that could reinterpret an outside location under another root.
    let found
    try { found = await service.resolvePath({ rootId, path: scope ? printed : relativePath || printed }) }
    catch (cause) { if (!openCurrent(generation, rootId, scope)) return false; throw cause }
    if (!openCurrent(generation, rootId, scope)) return false
    if (found?.kind !== 'file') { announce('폴더는 트리에서 열 수 있습니다.'); return false }
    const opened = await openFile(found.id, null, { scope, operationGeneration: generation })
    if (!opened || !openCurrent(generation, rootId, scope)) return false
    if (activeFileId === found.id && Number.isInteger(line) && line > 0) revealLine(line)
    return activeFileId === found.id
  }

  // D-X2 after-apply review of an Agent's changes in the connected folder.
  async function showChangeReview(changes) {
    if (!activeRoot) { announce('먼저 폴더를 연결하세요.'); return null }
    const module = await part('changeReview')
    if (!module?.createChangeReview) throw new Error('변경 검토 화면을 불러오지 못했습니다.')
    changeReview?.dispose()
    changeReview = module.createChangeReview({ document, service, rootId: activeRoot.rootId, changes: Array.isArray(changes) ? changes : [], makeOperationId: operationId, onOpenFile: location => act(() => openAt(location)) })
    changeReviewPanel.replaceChildren(changeReview.element)
    changeReviewPanel.hidden = false
    await changeReview.load()
    announce('변경 검토')
    return changeReview
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

  // A content result line with its fixed-string matches marked.
  function matchedLine(match) {
    const line = el('span', 'egdesk-file-content-line')
    let at = 0
    for (const range of Array.isArray(match.matchRanges) ? match.matchRanges : []) {
      if (!Number.isInteger(range?.start) || !Number.isInteger(range?.end) || range.start < at || range.end <= range.start || range.end > match.lineContent.length) continue
      if (range.start > at) line.append(el('span', 'egdesk-file-content-text', match.lineContent.slice(at, range.start)))
      line.append(el('mark', 'egdesk-file-content-match', match.lineContent.slice(range.start, range.end)))
      at = range.end
    }
    if (at < match.lineContent.length) line.append(el('span', 'egdesk-file-content-text', match.lineContent.slice(at)))
    return line
  }

  async function searchContents(rawQuery) {
    const generation = operation
    const found = await service.searchContents({ rootId: activeRoot.rootId, query: rawQuery, limit: 50 })
    if (!present(generation)) return
    searchResults.replaceChildren(el('h3', 'egdesk-file-search-heading', `내용 검색 결과 ${found.matches.length}개${found.truncated ? ' · 일부만 표시' : ''}`))
    for (const match of found.matches) {
      const result = button('', 'egdesk-file-search-result egdesk-file-content-result', () => act(async () => {
        if (pendingReconnect) { await reconnectSource(match.fileId); return }
        await openFile(match.fileId)
        if (activeFileId === match.fileId) revealLine(match.lineNumber)
      }))
      result.append(el('span', 'egdesk-file-content-location', `${match.relativePath}:${match.lineNumber}`), matchedLine(match))
      result.setAttribute('aria-label', `${match.relativePath} ${match.lineNumber}행: ${match.lineContent}`)
      searchResults.append(result)
    }
    announce(found.truncated ? '검색 상한에 도달했습니다. 검색어를 좁혀 주세요.' : '파일 내용 검색이 완료되었습니다.')
  }

  searchForm.addEventListener('submit', event => { event.preventDefault(); act(async () => {
    if (!activeRoot) { announce('먼저 폴더를 연결하세요.'); return }
    const query = searchInput.value.trim()
    if (!query) { searchResults.replaceChildren(); announce('검색을 지웠습니다.'); return }
    // Whitespace is significant in a content query, so it is sent untrimmed.
    if (searchMode === 'contents') { await searchContents(searchInput.value); return }
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

  setSearchMode('names')
  selectTab('files')
  refreshProjectTarget()

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
    if (fileChangeTimer) { clearTimeout(fileChangeTimer); fileChangeTimer = null }
    pendingFolders.clear()
    disposed = true; token(); treeGeneration++; root.remove(); return true
  }
  return { element: root, openRoot, openFile, reconnectSource, captureRef, restoreDraft: async ({ fileId, draftId }) => {
    const saved = fileId ? null : await service.readDraft({ draftId })
    return openFile(fileId || saved.fileId, draftId, { focus: false })
  }, snapshot, flush, close, dispose: close,
  onFileChanged, flushFileChanges, revealLine, refreshGitStatus, refreshChanges, showTab: selectTab,
  saveOriginal, openProject, setProjectScripts, openAt, showChangeReview, check }
}
