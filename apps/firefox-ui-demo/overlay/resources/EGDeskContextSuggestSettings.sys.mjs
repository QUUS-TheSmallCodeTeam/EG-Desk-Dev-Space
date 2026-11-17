// EGDeskContextSuggestSettings — the screen side of CTX-03 '자료 추천' (D-R2).
//
// The helper owns the setting (GET/POST /context/suggest-settings,
// helper/egdesk-context-resolver.mjs normalizeContextSuggest): a mode
// 'always' | 'firstMessage' | 'off' and a 'never suggest' list of
// {kind:'site', host} and {kind:'folder', path}. D-R2 is not decided by the
// owner; the inferred default follows CONTEXT_SUGGEST_DEFAULT (always, empty
// list): suggestions stay suggestions and nothing is attached by itself.
//
// This module is pure: it turns the setting into Settings rows, turns a
// suggestion row into a 'never suggest' entry, and marks screen signals with
// userExcluded when a Browser page's site or a File card's folder is listed.
// The resolver request keeps carrying no site, URL, path or title (the
// collector's existing contract): only that boolean.
// Text only ever goes through textContent.

export const CONTEXT_SUGGEST_MODES = Object.freeze(['always', 'firstMessage', 'off'])
export const CONTEXT_SUGGEST_DEFAULT_MODE = 'always'
export const NEVER_SUGGEST_LIMIT = 64

const MODE_TEXT = Object.freeze({
  always: Object.freeze({ label: '항상 추천', note: '입력할 때마다 지금 보이는 자료를 추천합니다. 고른 것만 붙습니다.' }),
  firstMessage: Object.freeze({ label: '첫 메시지에서만', note: '새 대화의 첫 메시지를 쓸 때만 추천합니다. 고른 것만 붙습니다.' }),
  off: Object.freeze({ label: '추천 끄기', note: '자료를 추천하지 않습니다. 직접 붙인 자료만 씁니다.' }),
})
export const CONTEXT_SUGGEST_SETTINGS_TEXT = Object.freeze({
  title: '자료 추천',
  intro: 'Chat 입력칸 위 \'이것도 붙일까요?\'에 무엇을 보여 줄지 정합니다.',
  listTitle: '추천하지 않을 사이트·폴더',
  listEmpty: '없음 · 추천에서 \'추천 안 함\'을 누르거나 아래에 적어 추가합니다.',
  inputLabel: '사이트 주소 또는 폴더 경로',
  inputPlaceholder: 'bank.example.com 또는 /Users/me/private',
  add: '추가',
  remove: '빼기',
  loading: '자료 추천 설정을 불러오는 중입니다.',
  unavailable: '자료 추천 설정을 불러오지 못했습니다. 브리지 연결을 확인하세요.',
  unsupported: '이 브리지는 자료 추천 설정을 지원하지 않습니다.',
  notPersisted: '이번 실행에만 적용되었습니다. 설정 파일에 저장하지 못했습니다.',
  invalid: '사이트 이름(예: bank.example.com)이나 / 로 시작하는 폴더 경로를 적어 주세요.',
  full: `최대 ${NEVER_SUGGEST_LIMIT}개까지 둘 수 있습니다.`,
  duplicate: '이미 목록에 있습니다.',
})

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const CONTROL = /[\u0000-\u001f\u007f]/
const isAbsolutePath = value => typeof value === 'string' && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value))

export function modeChoices(mode) {
  const selected = CONTEXT_SUGGEST_MODES.includes(mode) ? mode : CONTEXT_SUGGEST_DEFAULT_MODE
  return CONTEXT_SUGGEST_MODES.map(id => Object.freeze({ id, label: id === CONTEXT_SUGGEST_DEFAULT_MODE ? `${MODE_TEXT[id].label} (기본)` : MODE_TEXT[id].label,
    note: MODE_TEXT[id].note, selected: id === selected }))
}

// Host of a Browser page for the list ('www.' kept off, as the label shows it).
// Only http(s) pages have a site; anything else returns null.
export function siteHostFromUrl(url) {
  let parsed
  try { parsed = new URL(String(url || '')) } catch { return null }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  return HOST.test(host) ? host : null
}

const trimFolder = value => value.length > 1 ? value.replace(/[\\/]+$/, '') : value

// path is the folder itself or inside it (no '..' resolution: paths come from
// the helper's verified display path and the helper normalizes saved entries).
export function pathInFolder(path, folder) {
  if (!isAbsolutePath(path) || !isAbsolutePath(folder)) return false
  const base = trimFolder(folder)
  const target = trimFolder(path)
  if (target === base) return true
  if (/[\\/]$/.test(base)) return target.startsWith(base)
  return target.startsWith(`${base}/`) || target.startsWith(`${base}\\`)
}

export function siteExcluded(host, neverSuggest) {
  return typeof host === 'string' && !!host && (Array.isArray(neverSuggest) ? neverSuggest : [])
    .some(entry => entry?.kind === 'site' && (host === entry.host || host.endsWith(`.${entry.host}`)))
}

export function folderExcluded(path, neverSuggest) {
  return (Array.isArray(neverSuggest) ? neverSuggest : []).some(entry => entry?.kind === 'folder' && pathInFolder(path, entry.path))
}

/**
 * Typed text → one list entry, or {error}. An absolute path is a folder;
 * anything else must read as a site host (a pasted URL keeps only its host).
 */
export function neverSuggestEntryFromInput(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value || CONTROL.test(value) || value.length > 1024) return { error: 'invalid' }
  if (isAbsolutePath(value)) return { entry: Object.freeze({ kind: 'folder', path: trimFolder(value) }) }
  const fromUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? siteHostFromUrl(value) : null
  const host = fromUrl || value.toLowerCase().replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '')
  return HOST.test(host) ? { entry: Object.freeze({ kind: 'site', host }) } : { error: 'invalid' }
}

/**
 * A suggestion row's card → the entry its '추천 안 함' adds.
 * {kind:'browser', url} → site; {kind:'file', folderPath} → folder; else null.
 */
export function neverSuggestEntryForSource({ kind, url, folderPath } = {}) {
  if (kind === 'browser') {
    const host = siteHostFromUrl(url)
    return host ? Object.freeze({ kind: 'site', host }) : null
  }
  if (kind === 'file' && isAbsolutePath(folderPath) && !CONTROL.test(folderPath)) return Object.freeze({ kind: 'folder', path: trimFolder(folderPath) })
  return null
}

export function neverSuggestLabel(entry) {
  if (entry?.kind === 'site') return `사이트 · ${entry.host}`
  if (entry?.kind === 'folder') return `폴더 · ${entry.path}`
  return ''
}

// '추천 안 함' button text for a row.
export function neverSuggestActionLabel(entry) {
  return entry?.kind === 'site' ? `${entry.host} 추천 안 함` : entry?.kind === 'folder' ? '이 폴더 추천 안 함' : ''
}

const sameEntry = (left, right) => left?.kind === right?.kind && (left.kind === 'site' ? left.host === right.host : left.path === right.path)

/** list + entry → {neverSuggest} for POST, or {error: 'duplicate'|'full'|'invalid'}. */
export function withNeverSuggest(list, entry) {
  const current = Array.isArray(list) ? list : []
  if (!entry || !['site', 'folder'].includes(entry.kind)) return { error: 'invalid' }
  if (current.some(item => sameEntry(item, entry))) return { error: 'duplicate' }
  if (current.length >= NEVER_SUGGEST_LIMIT) return { error: 'full' }
  return { neverSuggest: [...current.map(item => ({ ...item })), { ...entry }] }
}

export function withoutNeverSuggest(list, entry) {
  return { neverSuggest: (Array.isArray(list) ? list : []).filter(item => !sameEntry(item, entry)).map(item => ({ ...item })) }
}

/** GET/POST response → {mode, neverSuggest, persisted} or null when malformed. */
export function normalizeSuggestSettings(packet) {
  if (!packet || typeof packet !== 'object' || !CONTEXT_SUGGEST_MODES.includes(packet.mode) || !Array.isArray(packet.neverSuggest)) return null
  const neverSuggest = packet.neverSuggest.slice(0, NEVER_SUGGEST_LIMIT).filter(entry =>
    (entry?.kind === 'site' && typeof entry.host === 'string' && HOST.test(entry.host))
    || (entry?.kind === 'folder' && isAbsolutePath(entry.path) && !CONTROL.test(entry.path)))
    .map(entry => Object.freeze(entry.kind === 'site' ? { kind: 'site', host: entry.host } : { kind: 'folder', path: entry.path }))
  return Object.freeze({ mode: packet.mode, neverSuggest: Object.freeze(neverSuggest), persisted: packet.persisted === true })
}

/**
 * Marks one resolver view signal from the screen card: userExcluded when the
 * Browser page's site (same host-and-subdomain rule as the helper) or the
 * File card's folder is listed. Returns a new object; never adds the site,
 * URL or path.
 */
export function markSuggestSignal(item, { url = null, folderPath = null, neverSuggest = [] } = {}) {
  const next = { ...item }
  if (item?.kind === 'browser' && siteExcluded(siteHostFromUrl(url), neverSuggest)) next.userExcluded = true
  else if (item?.kind === 'file' && folderPath && folderExcluded(folderPath, neverSuggest)) next.userExcluded = true
  return next
}

/**
 * Settings section DOM. view: {status: 'loading'|'ready'|'error'|'unsupported',
 * value?: normalizeSuggestSettings(), message?}. Handlers return promises:
 * onMode(mode), onRemove(entry), onAdd(entry). The section is redrawn by the
 * host after each answer.
 */
export function renderContextSuggestSettings({ document, view, onMode, onRemove, onAdd } = {}) {
  if (!document?.createElement) throw new TypeError('renderContextSuggestSettings requires a document')
  const T = CONTEXT_SUGGEST_SETTINGS_TEXT
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }
  const section = el('section', 'egd-settings-section egd-settings-context-suggest')
  section.setAttribute('aria-label', T.title)
  section.setAttribute('data-testid', 'settings-context-suggest')
  section.setAttribute('data-state', view?.status || 'loading')
  section.append(el('div', 'egd-settings-section-title', T.title), el('p', 'egd-settings-form-hint', T.intro))
  const status = el('p', 'egd-settings-form-hint egd-settings-context-suggest-status')
  status.setAttribute('role', 'status')
  status.setAttribute('data-testid', 'settings-context-suggest-status')
  const value = view?.status === 'ready' ? view.value : null
  if (!value) {
    status.textContent = view?.status === 'unsupported' ? T.unsupported : view?.status === 'error' ? T.unavailable : T.loading
    section.append(status)
    return section
  }
  const guard = async (work) => {
    try { await work() } catch (error) { status.textContent = error?.message || T.unavailable }
  }
  const choices = modeChoices(value.mode)
  const group = el('div', 'egd-settings-segmented')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', '추천 방식')
  group.setAttribute('data-testid', 'settings-context-suggest-mode')
  for (const choice of choices) {
    const button = el('button', `egd-settings-segment${choice.selected ? ' egd-settings-segment-active' : ''}`, choice.label)
    button.type = 'button'
    button.setAttribute('role', 'radio')
    button.setAttribute('aria-checked', String(choice.selected))
    button.setAttribute('data-testid', `settings-context-suggest-mode-${choice.id}`)
    button.title = choice.note
    button.addEventListener('click', () => { if (!choice.selected && typeof onMode === 'function') return guard(() => onMode(choice.id)) })
    group.append(button)
  }
  section.append(group, el('p', 'egd-settings-form-hint egd-settings-choice-note', choices.find(choice => choice.selected)?.note || ''))
  const listTitle = el('div', 'egd-settings-context-suggest-list-title', T.listTitle)
  const list = el('ul', 'egd-settings-context-suggest-list')
  list.setAttribute('aria-label', T.listTitle)
  list.setAttribute('data-testid', 'settings-context-suggest-never')
  if (!value.neverSuggest.length) list.append(el('li', 'egd-settings-context-suggest-empty', T.listEmpty))
  for (const entry of value.neverSuggest) {
    const row = el('li', 'egd-settings-context-suggest-entry')
    row.setAttribute('data-kind', entry.kind)
    const remove = el('button', 'egd-settings-btn egd-settings-context-suggest-remove', T.remove)
    remove.type = 'button'
    remove.setAttribute('aria-label', `${neverSuggestLabel(entry)} ${T.remove}`)
    remove.addEventListener('click', () => typeof onRemove === 'function' ? guard(() => onRemove(entry)) : undefined)
    row.append(el('span', 'egd-settings-context-suggest-entry-label', neverSuggestLabel(entry)), remove)
    list.append(row)
  }
  const form = el('div', 'egd-settings-context-suggest-add')
  const input = el('input', 'egd-settings-input egd-settings-context-suggest-input')
  input.type = 'text'
  input.setAttribute('aria-label', T.inputLabel)
  input.setAttribute('placeholder', T.inputPlaceholder)
  input.setAttribute('data-testid', 'settings-context-suggest-input')
  const add = el('button', 'egd-settings-btn egd-settings-context-suggest-add-button', T.add)
  add.type = 'button'
  add.setAttribute('data-testid', 'settings-context-suggest-add')
  const submit = () => {
    const parsed = neverSuggestEntryFromInput(input.value)
    if (parsed.error) { status.textContent = T.invalid; return undefined }
    const checked = withNeverSuggest(value.neverSuggest, parsed.entry)
    if (checked.error) { status.textContent = T[checked.error] || T.invalid; return undefined }
    return typeof onAdd === 'function' ? guard(() => onAdd(parsed.entry)) : undefined
  }
  add.addEventListener('click', submit)
  input.addEventListener('keydown', event => {
    if (event?.key !== 'Enter' || event.isComposing) return undefined
    event.preventDefault?.()
    return submit()
  })
  form.append(input, add)
  // The host passes notPersisted after a save the helper could not write.
  status.textContent = view.message || ''
  section.append(listTitle, list, form, status)
  return section
}
