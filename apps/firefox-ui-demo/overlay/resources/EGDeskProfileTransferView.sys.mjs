// Settings presentation only. The caller owns the flow, binding and adapters.
import { PROFILE_TOOL_CEILING_AXES, toolCeilingNotes, chatEffortLabel } from './EGDeskChatState.sys.mjs'

const BUSY = new Set(['reading', 'previewing', 'committing', 'fetching', 'saving'])
const TERMINAL_BINDING = new Set(['stale', 'disposed'])
const EXPORT_UNKNOWN_MESSAGE = '파일이 일부 또는 전부 저장되었을 수 있습니다. 저장 위치의 파일을 확인하기 전에는 다시 저장하지 마세요.'
const EXPORT_EXISTS_MESSAGE = '같은 이름의 파일이 있습니다. 기존 파일은 덮어쓰지 않습니다. 다른 이름이나 위치를 선택해 주세요.'
const text = value => typeof value === 'string' ? value : ''
const binding = value => Number.isSafeInteger(value) && value >= 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function exportCopy(value) {
  if (!object(value) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(text(value.profileId))
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > 999999999
      || (value.hash != null && !/^[0-9a-f]{64}$/.test(text(value.hash)))) return null
  return Object.freeze({ profileId: value.profileId, revision: value.revision,
    ...(value.hash == null ? {} : { hash: value.hash }) })
}

/**
 * createEGDeskProfileTransferView({document}) -> {element, update, dispose}.
 * Append element to the Settings surface, then update({state, actions,
 * exportTarget}) with the ACTUAL flow onState value, flow.bind() actions, and
 * the currently visible saved {profileId, revision, hash?}, or null.
 * No flow, request, picker, file access or global document is created here.
 *
 * A view belongs to ONE flow instance. On account/view/revision change the host
 * must invalidate that flow, obtain new actions and update this view together;
 * create a new view if replacing the flow itself. Older binding updates are
 * ignored. Mismatched state/actions render inert until a matching update.
 * Every update revokes prior render listeners, even if its nodes are reattached.
 * Detached nodes cannot act. dispose() only revokes/removes this view's DOM;
 * the host must separately dispose/invalidate the flow on teardown.
 *
 * Only button clicks call actions. Confirmation is passed BY IDENTITY, export
 * identity is copied at render time, and action results never replace onState.
 * Unknown receipts remain unknown: no automatic retry, activation or assignment.
 * Selectors have identical data-testid and data-action values. In addition to
 * settings-agent-import/export-md/export-toml/import-confirm, QA hooks include
 * transfer-status, transfer-cancel, import-preview and import-instructions.
 * Existing Settings CSS supplies the bounded, scrollable instructions area;
 * its text is complete, not truncated or interpreted as markup.
 */
export function createEGDeskProfileTransferView({ document } = {}) {
  if (typeof document?.createElement !== 'function') throw new TypeError('A document is required')
  const make = (tag, className = '', value) => {
    const node = document.createElement(tag)
    node.className = className
    if (value !== undefined) node.textContent = text(value)
    return node
  }
  const hook = (node, name) => {
    node.setAttribute('data-testid', name)
    node.setAttribute('data-action', name)
    return node
  }
  const element = hook(make('section', 'egd-settings-section'), 'settings-agent-transfer')
  element.setAttribute('aria-label', 'Agent 가져오기·내보내기')
  let generation = 0, latestBinding = -1, disposed = false, listeners = []
  const revoke = () => {
    generation++
    for (const [node, listener] of listeners) node.removeEventListener('click', listener)
    listeners = []
  }
  const row = (label, value) => {
    const node = make('div', 'egd-settings-detail-row'), detail = make('dd')
    if (typeof value === 'string') detail.textContent = value
    else detail.append(value)
    node.append(make('dt', '', label), detail)
    return node
  }
  const list = values => {
    const node = make('ul', 'egd-settings-plain-list')
    for (const value of values) node.append(make('li', '', value))
    if (!values.length) node.append(make('li', '', '없음'))
    return node
  }
  const metadata = value => {
    // Unknown values retain their original text, never URLs or rich content.
    if (value == null) return '미설정'
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  }
  const named = (value, names) => names.find(([key]) => key === value)?.[1] ?? metadata(value)
  const fields = (value, definitions) => !object(value) ? metadata(value) : list([
    ...definitions.map(([key, label, format = metadata]) => `${label}: ${format(value[key])}`),
    ...Object.keys(value).filter(key => !definitions.some(([known]) => key === known))
      .map(key => `${key}: ${metadata(value[key])}`),
  ])
  const model = value => fields(value, [
    ['engine', '엔진', engine => named(engine, [['codex', 'Codex'], ['claude', 'Claude']])],
    ['modelId', '모델 ID'],
    ['effort', '추론 강도', effort => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)
      ? `${chatEffortLabel(effort)} (${effort})` : metadata(effort)],
  ])
  const avatar = value => fields(value, [
    ['kind', '종류', kind => named(kind, [['initial', '글자'], ['emoji', '이모지'], ['image', '사진']])],
    ['value', '표시 값'],
    ['color', '색상', color => named(color, [
      ['#49634f', '짙은 초록 (#49634f)'], ['#a9c5a9', '연한 초록 (#a9c5a9)'],
      ['#958879', '회갈색 (#958879)'], ['#7b8079', '회색 (#7b8079)'],
      ['#252a26', '짙은 회색 (#252a26)'], ['#f5f0df', '크림색 (#f5f0df)'],
    ])],
  ])
  const toolCeiling = value => {
    if (value != null && !object(value)) return metadata(value)
    // Project only the shared note input to the coerced mode. The imported
    // value stays intact; native approval settings may not prompt every time.
    const notes = toolCeilingNotes(value?.terminal === 'allow' ? { ...value, terminal: 'ask' } : value)
    return list([
      ...PROFILE_TOOL_CEILING_AXES.map(({ axis, label, options }) => `${label}: ${value == null
        ? '별도 제한 미설정' : options.find(option => option.value === value[axis])?.label ?? metadata(value[axis])}`),
      ...(value == null ? ['현재 연결과 승인 설정을 따릅니다. 모든 권한을 허용한다는 뜻은 아닙니다.'] : [
        ...Object.keys(value).filter(key => !PROFILE_TOOL_CEILING_AXES.some(({ axis }) => axis === key))
          .map(key => `${key}: ${metadata(value[key])}`),
        ...notes,
        ...(value.terminal === 'allow' ? ['자동 승인은 제공하지 않으며 현재 승인 설정을 따릅니다.'] : []),
      ]),
    ])
  }
  const adjustment = item => {
    const field = text(item?.field), reason = text(item?.reason)
    const label = named(field, [['name', '이름'], ['description', '역할'], ['color', '아바타 색상'],
      ['emoji', '아바타 이모지'], ['vibe', '말투 메모'], ['avatar', '아바타'], ['instructions', '지침'],
      ['model', '모델'], ['tools', '허용 도구'], ['disallowedTools', '제외 도구'], ['toolCeiling', '도구 범위']])
    const message = [
      ['avatar:photo-not-included', '사진은 가져오기에 포함하지 않았습니다.'],
      ['instructions:edited-outside-egdesk', 'EG-Desk 밖에서 수정된 파일의 지침을 가져왔습니다.'],
      ['color:not-in-palette', '지원하지 않는 색상이라 기본 색상으로 바꿨습니다.'],
      ['emoji:not-one-emoji', '하나의 이모지로 읽을 수 없어 반영하지 않았습니다.'],
      ['model:unsupported', '지원하지 않는 모델이라 지정하지 않았습니다.'],
      ['toolCeiling:narrowed-by-tool-list', '가져온 파일의 도구 목록에 맞춰 사용 범위를 줄였습니다.'],
    ].find(([key]) => key === `${field}:${reason}`)?.[1] ?? named(reason, [
      ['unreadable', '내용을 읽을 수 없었습니다.'], ['shortened', '길이 제한에 맞춰 줄였습니다.'],
    ])
    return `${label}: ${message}`
  }

  function update({ state, actions, exportTarget = null } = {}) {
    if (disposed) return element
    if (binding(state?.binding) && state.binding < latestBinding) return element
    revoke()
    if (binding(state?.binding)) latestBinding = state.binding
    const ticket = generation, target = exportCopy(exportTarget)
    const statusName = text(state?.status)
    const valid = binding(state?.binding) && actions?.binding === state.binding
      && !TERMINAL_BINDING.has(statusName)
    const busy = BUSY.has(statusName), uncertain = statusName === 'unknown'
    const locked = !valid || busy || uncertain
    const confirmation = state?.confirmation // Deliberately NOT copied.
    const canConfirm = valid && state?.canConfirm === true && object(confirmation)
      && object(state?.body) && object(state?.preview) && !busy && !uncertain
    const commandButtons = []
    let invoked = false, cancelInvoked = false
    const current = node => !disposed && generation === ticket && element.isConnected === true
      && node.isConnected === true && element.contains(node)
    const status = hook(make('p', 'egd-settings-notice'), 'transfer-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    status.setAttribute('aria-atomic', 'true')
    // Presentation only: the write boundary's status, never a code alone,
    // determines whether the outcome is known. Keep the raw flow receipt intact.
    const exportNotice = state?.operation === 'export' ? uncertain ? EXPORT_UNKNOWN_MESSAGE
      : statusName === 'failed' && state?.code === 'TEXT_FILE_EXISTS' ? EXPORT_EXISTS_MESSAGE : null : null
    status.textContent = exportNotice || text(state?.message) || (valid
      ? 'Markdown 파일을 골라 내용을 확인한 뒤 초안으로 가져오세요.'
      : 'Agent 연결을 확인한 뒤 다시 열어 주세요.')
    status.setAttribute('data-state', statusName || 'unbound')
    status.setAttribute('data-code', text(state?.code))
    const button = (selector, label, method, argument, disabled, cancel = false, primary = false) => {
      const node = hook(make('button', `egd-settings-btn${primary ? ' egd-settings-btn-primary' : ''}`, label), selector)
      node.type = 'button'
      const callback = actions?.[method]
      node.disabled = disabled || typeof callback !== 'function'
      const listener = () => {
        if (!current(node) || node.disabled || !valid || (cancel ? cancelInvoked : invoked)) return
        if (cancel) { cancelInvoked = true; node.disabled = true }
        else { invoked = true; for (const control of commandButtons) control.disabled = true }
        const failed = () => {
          // No success/cancel inference, no raw adapter error/path in the UI.
          if (current(node)) status.textContent = '요청 결과를 확인하지 못했습니다. 상태를 확인한 뒤 다시 열어 주세요.'
        }
        try {
          const result = argument === undefined ? callback.call(actions) : callback.call(actions, argument)
          return Promise.resolve(result).catch(failed)
        } catch { failed() }
      }
      node.addEventListener('click', listener)
      listeners.push([node, listener])
      if (!cancel) commandButtons.push(node)
      return node
    }

    const head = make('div', 'egd-settings-section-head')
    head.append(make('h3', 'egd-settings-section-title', 'Agent 파일'))
    const controls = make('div', 'egd-settings-detail-actions')
    controls.append(
      button('settings-agent-import', 'Markdown 파일 선택', 'importFile', undefined, locked),
      button('settings-agent-export-md', 'Markdown 내보내기', 'exportProfile', target && { ...target, format: 'md' }, locked || !target),
      button('settings-agent-export-toml', 'Codex TOML 내보내기', 'exportProfile', target && { ...target, format: 'codex-toml' }, locked || !target))
    const targetNote = hook(make('p', 'egd-settings-notice', target
      ? `내보낼 Agent: ${target.profileId} · 저장 버전 ${target.revision}`
      : '내보내려면 Agent의 저장 버전을 선택하세요.'), 'transfer-export-target')
    const content = [head, controls, targetNote, status]
    // These export explanations now lead the live status; do not repeat them
    // below it or suggest another write while the export outcome is unknown.
    if (!exportNotice && state?.code === 'TEXT_FILE_EXISTS') content.push(make('p', 'egd-settings-callout', EXPORT_EXISTS_MESSAGE))
    if (!exportNotice && uncertain) content.push(make('p', 'egd-settings-callout', state?.operation === 'import'
      ? '초안이 만들어졌을 수 있습니다. Agent 목록에서 결과를 확인하기 전에는 다시 가져오지 마세요.'
      : EXPORT_UNKNOWN_MESSAGE))

    if (object(state?.body) && object(state?.preview)) {
      const preview = hook(make('section', 'egd-settings-section'), 'import-preview')
      const details = make('dl', 'egd-settings-detail-list'), body = state.body, warnings = state.preview
      preview.append(make('h4', 'egd-settings-section-title', '가져온 파일 내용'))
      const instructions = hook(make('div', 'egd-settings-instructions', text(body.instructions)), 'import-instructions')
      instructions.setAttribute('tabindex', '0')
      instructions.setAttribute('role', 'region')
      instructions.setAttribute('aria-label', '가져올 Agent 지침 전문')
      details.append(row('파일', text(state.source?.filename)), row('이름', text(body.name)), row('역할', text(body.role)),
        row('지침', instructions), row('모델', model(body.model)), row('아바타', avatar(body.avatar)),
        row('도구 범위', toolCeiling(body.toolCeiling)))
      const unknownFields = Array.isArray(warnings.unknownFields) ? warnings.unknownFields.map(text) : []
      const count = Number.isSafeInteger(warnings.unknownFieldCount) ? warnings.unknownFieldCount : unknownFields.length
      details.append(row('지원하지 않는 항목', hook(list([
        `전체 ${count}개 · 이름 표시 ${unknownFields.length}개`, ...unknownFields]), 'import-unknown-fields')),
      row('연결되지 않은 도구', hook(list(Array.isArray(warnings.unmappedTools) ? warnings.unmappedTools.map(text) : []), 'import-unmapped-tools')),
      row('변경된 설정', hook(list(Array.isArray(warnings.adjusted)
        ? warnings.adjusted.map(adjustment) : []), 'import-adjusted')))
      preview.append(details, make('p', 'egd-settings-callout', '가져온 Agent는 검토할 초안입니다. 자동 활성화하거나 대화방에 배정하지 않습니다.'))
      const confirmControls = make('div', 'egd-settings-detail-actions')
      confirmControls.append(button('settings-agent-import-confirm', '초안 가져오기', 'confirmImport', confirmation, !canConfirm, false, true))
      preview.append(confirmControls)
      content.push(preview)
    } else if (state?.recoverable && state?.source) {
      content.push(make('p', 'egd-settings-notice', `선택한 원문을 유지했습니다: ${text(state.source.filename)}`))
    }
    if (state?.operation === 'export') {
      const details = make('dl', 'egd-settings-detail-list')
      // The receipt's identity can differ from a later visible selection: show
      // both explicitly, never describe the receipt as that newer selection.
      details.append(row('이번 내보내기', `${text(state.profileId)} · 버전 ${state.revision ?? ''} · ${state.format === 'codex-toml' ? 'Codex TOML' : 'Markdown'}`),
        row('파일', text(state.fileName)), row('내보내기 제외 항목', hook(list(Array.isArray(state.omitted) ? state.omitted.map(text) : []), 'transfer-omitted')))
      content.push(details)
    }
    if (valid && (busy || canConfirm)) {
      const cancelControls = make('div', 'egd-settings-detail-actions')
      cancelControls.append(button('transfer-cancel', busy ? '중단 요청' : '가져오기 취소', 'cancel', undefined, false, true))
      content.push(cancelControls)
    }
    element.setAttribute('data-state', statusName || 'unbound')
    element.setAttribute('aria-busy', String(busy))
    element.replaceChildren(...content)
    return element
  }
  return Object.freeze({ element, update, dispose() {
    if (disposed) return
    disposed = true; revoke(); element.replaceChildren()
    element.setAttribute('data-state', 'disposed')
    element.setAttribute('aria-busy', 'false')
  } })
}
