import { runResultFromCodexItem, renderRunResultCard } from './EGDeskRunResult.sys.mjs'

const ID_FIELDS = ['conversationId', 'runId', 'itemId']
const UNAVAILABLE = '저장된 명령 출력을 사용할 수 없습니다. 실행 기록이나 보관된 출력을 확인해 주세요.'
const UNVERIFIED_FILE = '이 실행의 프로젝트 연결을 확인하지 못해 파일 열기를 제공하지 않습니다. 표시된 위치는 출력에서 읽은 정보입니다.'

function snapshotIdentity(run, activity) {
  if (activity?.kind !== 'commandExecution') throw new TypeError('A command activity is required')
  const identity = { conversationId: run?.conversationId, runId: run?.runId, itemId: activity.id }
  // Match /chat/command-output's opaque query IDs; do not interpret them as paths.
  if (ID_FIELDS.some(key => typeof identity[key] !== 'string' || !identity[key].trim() || identity[key].length > 300)) {
    throw new TypeError('A conversation, run and command item identity is required')
  }
  return Object.freeze(identity)
}

function snapshotItem(activity) {
  const detail = activity.detail || {}
  return Object.freeze({
    id: activity.id, type: 'commandExecution', status: activity.status,
    command: typeof detail.command === 'string' ? detail.command : '',
    cwd: typeof detail.cwd === 'string' ? detail.cwd : null,
    exitCode: Number.isInteger(detail.exitCode) ? detail.exitCode : null,
    durationMs: Number.isFinite(detail.durationMs) ? detail.durationMs : null,
  })
}

function outputMatches(output, identity) {
  return output?.protocolVersion === 1 && ID_FIELDS.every(key => output[key] === identity[key])
}

function validOutput(output) {
  return typeof output.head === 'string' && typeof output.tail === 'string'
    && typeof output.complete === 'boolean'
    && Number.isSafeInteger(output.totalBytes) && output.totalBytes >= 0
    && Number.isSafeInteger(output.omittedBytes) && output.omittedBytes >= 0 && output.omittedBytes <= output.totalBytes
}

function safeLocation(location) {
  return location?.inProject === true && typeof location.path === 'string' && location.path.length <= 4096
    && (/^\//.test(location.path) || /^[A-Za-z]:[\\/]/.test(location.path))
    && !/[\u0000-\u001f\u007f]|\[redacted\]|•••/i.test(location.path)
    && Number.isSafeInteger(location.line) && location.line > 0
    && (location.column == null || Number.isSafeInteger(location.column) && location.column > 0)
}

/**
 * A retained-output affordance for one original Chat command activity.
 * fetchJson(path, { method: 'GET', signal }) returns the existing bridge body.
 * isCurrent(identity) MUST check the captured view/render generation as well as
 * the original room/run; comparing only the current room ID misses A -> B -> A.
 * No fetch occurs until the person clicks the button (or their explicit result-
 * open action calls open). There is no execution, retry loop or terminal API.
 *
 * projectRoot is parsing/display context, NEVER project authority. Leave
 * onOpenLocation absent until the caller has independently verified the ORIGINAL
 * run's project authority. Neither cwd nor an active Board supplies that proof.
 * An injected onOpenLocation(location, identity) must perform a safe FileView
 * open with that original authority; it is called only by a file-location click.
 */
export function createChatRunResultView({ document, run, activity, fetchJson, isCurrent,
  projectRoot, os, onOpenLocation } = {}) {
  if (!document?.createElement || typeof fetchJson !== 'function' || typeof isCurrent !== 'function') {
    throw new TypeError('A document, output fetch callback and current-view fence are required')
  }
  const identity = snapshotIdentity(run, activity)
  const item = snapshotItem(activity)
  const path = `/chat/command-output?${ID_FIELDS.map(key => `${key}=${encodeURIComponent(identity[key])}`).join('&')}`
  const element = document.createElement('div')
  element.setAttribute('data-testid', 'chat-command-result')
  element.setAttribute('data-state', 'closed')
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '실행 결과 보기'
  button.setAttribute('aria-label', '보관된 명령 출력으로 실행 결과 보기')
  button.setAttribute('aria-expanded', 'false')
  const notice = document.createElement('p')
  notice.className = 'egd-codex-activity-note'
  notice.setAttribute('role', 'status')
  const body = document.createElement('div')
  element.append(button, notice, body)
  let generation = 0, disposed = false, loading = false, controller = null

  const current = ticket => {
    if (disposed || ticket !== generation || element.isConnected !== true) return false
    try { return isCurrent(identity) === true } catch { return false }
  }
  const show = (state, text) => {
    element.setAttribute('data-state', state)
    notice.textContent = text
  }
  const note = text => {
    const node = document.createElement('p')
    node.className = 'egd-codex-activity-note'
    node.textContent = text
    body.append(node)
  }

  async function open() {
    if (!current(generation)) return 'stale'
    if (loading) return 'loading'
    const ticket = ++generation
    loading = true
    controller = new AbortController()
    button.disabled = true
    button.setAttribute('aria-expanded', 'true')
    body.replaceChildren()
    show('loading', '보관된 명령 출력을 불러오는 중입니다.')
    try {
      const output = await fetchJson(path, { method: 'GET', signal: controller.signal })
      if (!current(ticket)) return 'stale'
      if (!outputMatches(output, identity)) {
        show('unavailable', '요청한 실행의 출력인지 확인하지 못해 표시하지 않았습니다.')
        return 'unavailable'
      }
      if (output.retained === false) {
        show('missing', UNAVAILABLE)
        return 'missing'
      }
      if (!validOutput(output)) {
        show('unavailable', '보관된 출력의 형식을 확인하지 못해 결과를 표시하지 않았습니다.')
        return 'unavailable'
      }
      if (!output.totalBytes || !output.head && !output.tail) {
        show('missing', '보관된 출력 내용이 없어 성공·실패 결과를 확인할 수 없습니다.')
        return 'missing'
      }
      const result = runResultFromCodexItem(item, { output: { head: output.head, tail: output.tail,
        omittedBytes: output.omittedBytes }, projectRoot, os })
      // Retained text and counts alone cannot promote a running/unknown item to
      // success. Only a completed output plus the original successful exit can.
      if (item.status === 'inProgress') {
        result.outcome = 'running'
        result.headline = '실행 중 · 완료 결과 아님'
        result.failures = []
        result.firstLocation = null
      } else if (!output.complete || result.outcome === 'passed' && (item.status !== 'completed' || item.exitCode !== 0)) {
        result.outcome = 'unknown'
        result.headline = '완료 결과 확인 안 됨'
        result.failures = []
        result.firstLocation = null
      }
      const locations = result.failures.map(failure => failure.location).filter(Boolean)
      const canOpen = typeof onOpenLocation === 'function' && locations.every(safeLocation)
      const openLocation = canOpen ? location => {
        if (!current(ticket) || !safeLocation(location)) return
        // Copy the parsed location. A callback never receives an active Board or
        // a newly selected file as an implicit substitute for this original run.
        const selected = Object.freeze({ path: location.path, relativePath: location.relativePath,
          line: location.line, column: location.column, label: location.label, inProject: location.inProject })
        const failed = () => { if (current(ticket)) notice.textContent = '이 실행의 파일 위치를 열지 못했습니다.' }
        try { Promise.resolve(onOpenLocation(selected, identity)).catch(failed) } catch { failed() }
      } : undefined
      body.append(renderRunResultCard({ document, result, onOpenLocation: openLocation }))
      note('보관된 출력 기준입니다. 민감한 내용이 가려졌을 수 있습니다.')
      if (output.omittedBytes > 0) note('보관 한도로 출력 일부가 생략되어 있습니다. 전체 로그가 아닙니다.')
      if (!output.complete || item.status === 'inProgress') note('실행 중이거나 출력 완료가 아직 확인되지 않아 최종 성공 결과로 표시하지 않습니다.')
      if (locations.length && !canOpen) note(UNVERIFIED_FILE)
      const state = result.outcome === 'running' ? 'running' : result.outcome === 'unknown' ? 'unknown' : 'ready'
      show(state, '')
      return state
    } catch (error) {
      if (!current(ticket)) return 'stale'
      const missing = ['RUN_NOT_FOUND', 'COMMAND_OUTPUT_UNAVAILABLE'].includes(error?.code) || error?.status === 404
      show(missing ? 'missing' : 'error', missing ? UNAVAILABLE : '명령 출력을 불러오지 못했습니다. 명령은 다시 실행하지 않았습니다.')
      return missing ? 'missing' : 'error'
    } finally {
      loading = false
      controller = null
      if (current(ticket)) {
        button.disabled = false
        button.textContent = '보관된 출력 다시 보기'
      }
    }
  }

  const clicked = () => open()
  button.addEventListener('click', clicked)
  function dispose() {
    if (disposed) return
    disposed = true
    generation++
    controller?.abort()
    button.disabled = true
    button.removeEventListener('click', clicked)
    body.replaceChildren()
    element.setAttribute('data-state', 'disposed')
  }
  return Object.freeze({ element, open, dispose, identity })
}
