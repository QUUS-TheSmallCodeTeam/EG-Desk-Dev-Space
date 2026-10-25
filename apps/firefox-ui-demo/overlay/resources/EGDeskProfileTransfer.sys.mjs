// D-A2: Agent Markdown -> reviewed draft; one saved revision -> MD/Codex TOML.
// No DOM, filesystem, network, auth, activation, or room assignment here.
export const PROFILE_IMPORT_MAX_BYTES = 56 * 1024
export const PROFILE_EXPORT_FORMATS = Object.freeze(['md', 'codex-toml'])
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const HASH = /^[0-9a-f]{64}$/
const MEDIA_TYPES = Object.freeze({ md: 'text/markdown; charset=utf-8', 'codex-toml': 'application/toml; charset=utf-8' })
const FLAVORS = ['egdesk', 'agency-agents', 'claude-code']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string')
const revision = value => Number.isSafeInteger(value) && value > 0 && value <= 999999999
const wellFormed = value => !/[\uD800-\uDFFF]/u.test(value)
const copy = value => JSON.parse(JSON.stringify(value))
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
const same = (a, b) => a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
  && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key])))
const fail = code => { throw Object.assign(new Error(code), { code }) }
const errorCode = (error, fallback) => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : fallback

/** A portable basename, bounded in UTF-8 bytes, with the selected extension. */
export function profileTransferFilename(filename, format = 'md') {
  if (!PROFILE_EXPORT_FORMATS.includes(format)) throw new TypeError('Unsupported profile export format')
  let base = (typeof filename === 'string' ? filename : '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '-')
    .replace(/[\uD800-\uDFFF]/gu, '-').replace(/\s+/g, ' ').trim()
    .replace(/(?:\.(?:md|toml))+$/i, '').replace(/^[. ]+|[. ]+$/g, '')
  const encoder = new TextEncoder()
  let bytes = 0, bounded = ''
  for (const char of Array.from(base).slice(0, 80)) {
    const size = encoder.encode(char).length
    if (bytes + size > 180) break
    bounded += char; bytes += size
  }
  base = bounded.replace(/[. ]+$/g, '') || 'agent'
  if (/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(base)) base = `agent-${base}`
  return `${base}.${format === 'codex-toml' ? 'toml' : 'md'}`
}

function sourceCopy(input) {
  return freeze({ text: typeof input?.text === 'string' ? input.text : '',
    filename: input?.filename === undefined ? 'agent.md' : typeof input.filename === 'string' ? input.filename : '' })
}
function validateSource(source) {
  if (!source.text.trim() || !source.filename || source.filename.length > 255
      || /[/\\\u0000-\u001f\u007f]/.test(source.filename)) fail('PROFILE_IMPORT_INPUT')
  if (!/\.md$/i.test(source.filename)) fail('PROFILE_IMPORT_FORMAT')
  if (!wellFormed(source.text) || !wellFormed(source.filename)) fail('PROFILE_IMPORT_ENCODING')
  if (new TextEncoder().encode(source.text).length > PROFILE_IMPORT_MAX_BYTES) fail('PROFILE_IMPORT_TOO_LARGE')
}
function previewPayload(packet) {
  const p = packet?.preview, body = packet?.body
  if (packet?.dryRun !== true || packet.format !== 'md' || !FLAVORS.includes(packet.flavor)
      || !object(body) || typeof body.name !== 'string' || !body.name || typeof body.instructions !== 'string'
      || !object(p) || p.format !== 'md' || p.flavor !== packet.flavor || p.reviewRequired !== true
      || p.name !== body.name || p.role !== body.role || !same(p.avatar, body.avatar) || !same(p.model, body.model)
      || !same(p.toolCeiling, body.toolCeiling ?? null) || p.instructionsChars !== Array.from(body.instructions).length
      || !Number.isSafeInteger(p.composedChars) || p.composedChars < 0 || !strings(p.unknownFields) || !strings(p.unmappedTools)
      || !Number.isSafeInteger(p.unknownFieldCount) || p.unknownFieldCount < p.unknownFields.length
      || !Array.isArray(p.adjusted) || p.adjusted.some(item => !object(item) || typeof item.field !== 'string' || typeof item.reason !== 'string')) {
    fail('PROFILE_IMPORT_RESPONSE_INVALID')
  }
  // Preserve all warning fields and normalized metadata, not just their labels.
  return freeze(copy({ body, preview: p, flavor: packet.flavor, format: packet.format }))
}
function draftReceipt(packet, ticket) {
  const p = packet?.profile, head = p?.head
  if (typeof packet?.id !== 'string' || !PROFILE_ID.test(packet.id) || packet.revision !== 1
      || typeof packet.hash !== 'string' || !HASH.test(packet.hash) || packet.unchanged !== false
      || p?.id !== packet.id || p.lifecycle !== 'draft' || p.activeRevision !== null || p.active !== null
      || p.reviewRequired !== true || p.hasDraft !== true || p.headRevision !== packet.revision
      || head?.profileId !== packet.id || head.revision !== packet.revision || head.hash !== packet.hash
      || !same(head.body, ticket.payload.body) || !same(packet.preview, ticket.payload.preview)) fail('PROFILE_IMPORT_RECEIPT_UNCONFIRMED')
  return { profileId: packet.id, revision: packet.revision, hash: packet.hash,
    draft: { profileId: packet.id, revision: packet.revision, hash: packet.hash, lifecycle: 'draft', activeRevision: null, reviewRequired: true } }
}
function exportPayload(packet, target) {
  if (!object(packet) || packet.profileId !== target.profileId || packet.revision !== target.revision || packet.format !== target.format
      || typeof packet.hash !== 'string' || !HASH.test(packet.hash) || (target.hash !== null && packet.hash !== target.hash)
      || packet.mediaType !== MEDIA_TYPES[target.format] || typeof packet.filename !== 'string' || !packet.filename.trim()
      || typeof packet.text !== 'string' || !packet.text || !wellFormed(packet.text) || !strings(packet.omitted)) fail('PROFILE_EXPORT_RESPONSE_INVALID')
  return freeze({ profileId: packet.profileId, revision: packet.revision, hash: packet.hash, format: packet.format,
    fileName: profileTransferFilename(packet.filename, target.format), mediaType: packet.mediaType, text: packet.text, omitted: [...packet.omitted] })
}
const idle = (binding, status = 'idle') => ({ binding, status, operation: null, code: null, message: '',
  source: null, body: null, preview: null, confirmation: null, canConfirm: false, recoverable: false,
  profileId: null, revision: null, hash: null, format: null, flavor: null, fileName: null, omitted: [], draft: null })

/**
 * createEGDeskProfileTransfer({request, readText, saveText, onState})
 *
 * request(path, {method, body?, signal}) -> UNWRAPPED JSON DTO. body is an
 * object, NOT a JSON string. The adapter must pin the account/bridge binding,
 * honor cancellation before dispatch, never auto-retry a POST, and reject
 * non-2xx responses with {code, httpStatus}. Only a definite 4xx rejection is
 * retryable after commit dispatch; timeout/abort/5xx/malformed receipts are not.
 * readText({accept:'.md', encoding:'utf-8', maxBytes, signal}) -> {text, filename}
 * or {cancelled:true}. The adapter must use fatal UTF-8 decoding (no replacement
 * or newline normalization) and enforce maxBytes before reading a large file.
 * saveText({fileName, text, contentType, signal, beginWrite}) -> {saved:true} or
 * {cancelled:true}. Only AFTER explicit picker confirmation, call beginWrite()
 * immediately before the write; false means write nothing. Cancellation means
 * zero writes. This is the same write gate as EGDeskBoardExport.
 *
 * const actions = flow.bind() captures ONE account/view binding:
 *   importFile()                 opens readText and then previews only;
 *   previewImport({text,filename}) previews edited/retried input (default name agent.md);
 *   confirmImport(state.confirmation) explicitly creates the previewed draft;
 *   exportProfile({profileId,revision,format:'md'|'codex-toml',hash?});
 *   cancel().
 * Flow controls: snapshot(), bind(), invalidate(), dispose(). On account,
 * view, visible-revision, or request-adapter rebinding, call invalidate() and
 * obtain NEW actions with bind(). Old actions, confirmations, async callbacks,
 * and write gates are inert. On destruction call dispose(). Render onState,
 * not an old action's eventual result. All state is frozen plain text/data;
 * render as text, never HTML. source retains the exact input for recovery.
 *
 * One operation at a time: repeated clicks join the active promise without
 * retargeting. A confirmation is an opaque object: pass it by identity, not a
 * reconstructed/serialized copy. Successful or uncertain imports consume it;
 * re-previewing the same source in this binding cannot create a second draft.
 * Uncertainty requires checking the profile list before deliberately rebinding
 * for another attempt. No client-side token promises global exactly-once
 * creation across reloads; the backend has no import idempotency key.
 */
export function createEGDeskProfileTransfer({ request, readText, saveText, onState = () => {} } = {}) {
  if ([request, readText, saveText, onState].some(callback => typeof callback !== 'function')) throw new TypeError('Profile transfer requires request, readText, saveText and onState callbacks')
  let generation = 0, sequence = 0, disposed = false, active = null, selected = null
  const attempts = new Map()
  let state = freeze(idle(generation))
  const publish = next => {
    state = freeze(next)
    // Presentation failures cannot alter a receipt or retry a mutation.
    try { onState(state) } catch {}
    return state
  }
  const current = run => active === run && !run.finished && !disposed && run.binding === generation
  const stale = binding => freeze({ ...idle(binding, disposed ? 'disposed' : 'stale'), code: 'PROFILE_TRANSFER_STALE' })
  const bound = binding => !disposed && generation === binding
  const result = (run, status, code, message, extra = {}) => freeze({ ...idle(run.binding), ...run.data,
    status, code, message, operation: run.operation, ...extra })
  const finish = (run, status, code, message, extra = {}, notify = true) => {
    if (run.finished) return run.result
    const value = result(run, status, code, message, extra)
    run.result = value; run.finished = true
    if (active === run) active = null
    // Store the receipt BEFORE publishing: onState may itself invoke actions.
    if (run.commitStarted && run.ticket) {
      run.ticket.result = value
      if (status !== 'failed') attempts.set(run.ticket.key, run.ticket)
    }
    if (notify) publish(value)
    run.resolve(value)
    return value
  }
  const start = (binding, operation, data) => {
    const run = { binding, operation, data, controller: new AbortController(), finished: false, commitStarted: false, writeStarted: false }
    run.promise = new Promise(resolve => { run.resolve = resolve })
    active = run
    return run
  }
  const stop = (status, notify = true) => {
    const run = active
    selected = null
    if (!run) {
      // Closing a completed/uncertain transfer is not evidence of cancellation.
      // Only a still-confirmable preview can become a zero-creation cancel.
      if (notify && state.canConfirm) return publish({ ...state, status, code: 'PROFILE_TRANSFER_CANCELLED',
        message: '가져오기를 취소했습니다. 초안을 만들지 않았습니다.', confirmation: null, canConfirm: false })
      return state
    }
    const uncertain = run.commitStarted || run.writeStarted
    const value = finish(run, uncertain ? 'unknown' : status,
      uncertain ? run.commitStarted ? 'PROFILE_IMPORT_RECEIPT_UNCONFIRMED' : 'PROFILE_EXPORT_WRITE_UNCONFIRMED' : `PROFILE_TRANSFER_${status.toUpperCase()}`,
      uncertain ? '처리가 시작된 뒤 결과를 확인하지 못했습니다. 다시 시도하기 전에 결과를 확인하세요.' : '전송을 중단했습니다. 초안을 만들거나 파일을 쓰지 않았습니다.',
      {}, notify)
    run.controller.abort()
    return value
  }
  const prepare = async (run, input, pick) => {
    try {
      if (!current(run)) return
      if (pick) {
        input = await readText(Object.freeze({ accept: '.md', encoding: 'utf-8', maxBytes: PROFILE_IMPORT_MAX_BYTES, signal: run.controller.signal }))
        if (!current(run)) return
        if (input?.cancelled === true) {
          finish(run, 'cancelled', 'PROFILE_IMPORT_CANCELLED', '파일 선택을 취소했습니다. 초안을 만들지 않았습니다.'); return
        }
      }
      run.data = { ...run.data, source: sourceCopy(input) }
      validateSource(run.data.source)
      const key = JSON.stringify([run.data.source.filename, run.data.source.text])
      const previous = attempts.get(key)
      if (previous) {
        selected = previous
        finish(run, previous.result.status, previous.result.code, previous.result.message, previous.result); return
      }
      publish(result(run, 'previewing', null, '가져올 Agent를 확인하고 있습니다. 아직 초안을 만들지 않습니다.'))
      if (!current(run)) return
      const packet = await request('/profiles/import', Object.freeze({ method: 'POST',
        body: Object.freeze({ ...run.data.source, dryRun: true }), signal: run.controller.signal }))
      if (!current(run)) return
      const payload = previewPayload(packet)
      const ticket = { key, source: run.data.source, payload, confirmation: freeze({ binding: run.binding, preview: ++sequence }), attempted: false, result: null }
      selected = ticket
      run.data = { ...run.data, ...payload, confirmation: ticket.confirmation }
      finish(run, 'preview', null, '내용과 변경·제외된 항목을 확인한 뒤 초안 가져오기를 눌러 주세요. 자동 활성화하거나 대화방에 배정하지 않습니다.', { canConfirm: true })
    } catch (error) {
      if (current(run)) finish(run, 'failed', errorCode(error, 'PROFILE_IMPORT_PREVIEW_FAILED'),
        '가져올 파일을 확인하지 못했습니다. 입력을 유지했습니다. 내용을 확인한 뒤 다시 미리볼 수 있습니다.', { recoverable: true })
    }
  }
  const previewImport = (binding, input, pick = false) => {
    if (!bound(binding)) return Promise.resolve(stale(binding))
    if (active) return active.promise
    selected = null
    const run = start(binding, 'import', { source: pick ? state.source : sourceCopy(input) })
    if (pick) publish(result(run, 'reading', null, '가져올 Markdown 파일을 선택하세요.'))
    void prepare(run, input, pick)
    return run.promise
  }
  const commit = async run => {
    try {
      if (!current(run)) return
      // Set before invoking the adapter: even a synchronous throw may follow a
      // dispatched POST. Never infer "nothing happened" from an exception.
      run.commitStarted = true
      const packet = await request('/profiles/import', Object.freeze({ method: 'POST',
        body: Object.freeze({ ...run.ticket.source, dryRun: false }), signal: run.controller.signal }))
      if (!current(run)) return
      const receipt = draftReceipt(packet, run.ticket)
      finish(run, 'imported', null, 'Agent 초안을 가져왔습니다. 아직 활성화하거나 대화방에 배정하지 않았습니다.', receipt)
    } catch (error) {
      if (!current(run)) return
      // These are explicit helper rejections, not ambiguous timeout/proxy/5xx
      // failures. The adapter must not turn a network failure into a 4xx.
      const rejected = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(error?.httpStatus)
        && typeof error?.code === 'string'
      if (rejected) {
        run.ticket.attempted = false
        finish(run, 'failed', errorCode(error, 'PROFILE_IMPORT_REJECTED'), '초안 생성이 거절되었습니다. 원문과 미리보기를 유지했습니다.', { canConfirm: true, recoverable: true })
      } else {
        finish(run, 'unknown', 'PROFILE_IMPORT_RECEIPT_UNCONFIRMED', '초안 생성 결과를 확인하지 못했습니다. Agent 목록을 확인하기 전에는 다시 가져오지 마세요.')
      }
    }
  }
  const confirmImport = (binding, confirmation) => {
    if (!bound(binding)) return Promise.resolve(stale(binding))
    const ticket = selected
    if (!ticket || confirmation !== ticket.confirmation) return Promise.resolve(freeze({ ...idle(binding, 'ignored'), code: 'PROFILE_IMPORT_CONFIRMATION_STALE' }))
    if (active) return active.promise
    if (ticket.attempted) return Promise.resolve(ticket.result)
    ticket.attempted = true
    const run = start(binding, 'import', { source: ticket.source, ...ticket.payload, confirmation: ticket.confirmation })
    run.ticket = ticket
    publish(result(run, 'committing', null, '확인한 원문으로 Agent 초안을 만들고 있습니다.'))
    void commit(run)
    return run.promise
  }
  const save = async run => {
    try {
      if (!current(run)) return
      const target = run.data
      const packet = await request(`/profiles/${encodeURIComponent(target.profileId)}/export?format=${target.format}&revision=${target.revision}`,
        Object.freeze({ method: 'GET', signal: run.controller.signal }))
      if (!current(run)) return
      const payload = exportPayload(packet, target)
      run.data = { ...run.data, hash: payload.hash, fileName: payload.fileName, omitted: payload.omitted }
      publish(result(run, 'saving', null, '파일 저장 위치를 선택하세요. 선택한 저장 버전만 내보냅니다.'))
      if (!current(run)) return
      const receipt = await saveText(Object.freeze({ fileName: payload.fileName, text: payload.text, contentType: payload.mediaType,
        signal: run.controller.signal, beginWrite: () => {
          if (!current(run) || run.writeStarted) return false
          run.writeStarted = true
          return true
        } }))
      if (!current(run)) return
      if (receipt?.saved === true && receipt.cancelled !== true && run.writeStarted) {
        finish(run, 'saved', null, 'Agent 파일을 저장했습니다.')
      } else if (receipt?.cancelled === true && receipt.saved !== true && !run.writeStarted) {
        finish(run, 'cancelled', 'PROFILE_EXPORT_CANCELLED', '저장을 취소했습니다. 파일을 쓰지 않았습니다.')
      } else {
        finish(run, run.writeStarted || receipt?.saved === true ? 'unknown' : 'failed', 'PROFILE_EXPORT_SAVE_UNCONFIRMED',
          '파일 저장 결과를 확인하지 못했습니다. 자동으로 다시 저장하지 않습니다.', { recoverable: !run.writeStarted && receipt?.saved !== true })
      }
    } catch (error) {
      if (current(run)) finish(run, run.writeStarted ? 'unknown' : 'failed',
        run.writeStarted ? 'PROFILE_EXPORT_WRITE_UNCONFIRMED' : errorCode(error, 'PROFILE_EXPORT_FAILED'),
        run.writeStarted ? '파일 쓰기 결과를 확인하지 못했습니다. 자동으로 다시 저장하지 않습니다.' : '파일을 내보내지 못했습니다. 자동으로 다시 시도하지 않습니다.', { recoverable: !run.writeStarted })
    }
  }
  const exportProfile = (binding, projection) => {
    if (!bound(binding)) return Promise.resolve(stale(binding))
    if (active) return active.promise
    selected = null
    const hash = projection?.hash, format = projection?.format === undefined ? 'md' : projection.format
    // Never freeze an invalid caller-owned object while producing error state.
    const target = { profileId: typeof projection?.profileId === 'string' ? projection.profileId : null,
      revision: revision(projection?.revision) ? projection.revision : null, hash: typeof hash === 'string' ? hash : null,
      format: typeof format === 'string' ? format : null }
    const run = start(binding, 'export', target)
    if (!PROFILE_ID.test(target.profileId ?? '') || !revision(target.revision) || !PROFILE_EXPORT_FORMATS.includes(target.format)
        || (hash !== undefined && hash !== null && (typeof hash !== 'string' || !HASH.test(hash)))) {
      finish(run, 'failed', 'PROFILE_EXPORT_INPUT', '내보낼 Agent의 저장 버전과 파일 형식을 확인하세요.', { recoverable: true })
    } else {
      publish(result(run, 'fetching', null, '선택한 Agent의 저장 버전을 내보내고 있습니다.'))
      void save(run)
    }
    return run.promise
  }
  return Object.freeze({
    bind: () => {
      const binding = generation
      return Object.freeze({ binding, importFile: () => previewImport(binding, undefined, true),
        previewImport: input => previewImport(binding, input), confirmImport: confirmation => confirmImport(binding, confirmation),
        exportProfile: projection => exportProfile(binding, projection), cancel: () => bound(binding) ? stop('cancelled') : stale(binding) })
    },
    snapshot: () => state,
    invalidate: () => {
      if (disposed) return state
      generation++; stop('stale', false); attempts.clear()
      return publish(idle(generation))
    },
    dispose: () => {
      if (disposed) return state
      generation++; disposed = true; stop('stale', false); attempts.clear()
      return publish(idle(generation, 'disposed'))
    },
  })
}
