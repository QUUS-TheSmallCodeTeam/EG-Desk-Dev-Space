// Injected text-file adapters only. Not the project/root picker capability
// channel in EGDeskFileView; do not replace createEGDeskNativeFilePickers there.
// No native globals, DOM, filesystem, networking, logging, deletion, or retry.
const CANCELLED = Object.freeze({ cancelled: true })
const SAVED = Object.freeze({ saved: true })
const ABORTED = Symbol('aborted')
// IOUtils.read uses an unsigned-long maxBytes; reserve one overflow sentinel.
const MAX_READ_LIMIT = 0xfffffffe
const MESSAGES = Object.freeze({
  TEXT_FILE_INPUT: '파일 전송 옵션을 확인하세요.',
  TEXT_FILE_SELECTION_INVALID: '선택한 파일을 확인하지 못했습니다.',
  TEXT_FILE_FORMAT: '허용된 확장자의 파일을 선택하세요.',
  TEXT_FILE_NOT_REGULAR: '일반 파일만 읽을 수 있습니다.',
  TEXT_FILE_TOO_LARGE: '파일이 허용된 크기를 넘습니다.',
  TEXT_FILE_UTF8: '올바른 UTF-8 텍스트 파일이 아닙니다.',
  TEXT_FILE_PICK_FAILED: '파일 선택을 완료하지 못했습니다.',
  TEXT_FILE_READ_FAILED: '파일을 읽지 못했습니다.',
  TEXT_FILE_WRITE_GATE: '파일 쓰기 승인을 확인하지 못했습니다.',
  TEXT_FILE_EXISTS: '같은 이름의 파일이 이미 있습니다. 덮어쓰지 않습니다. 다른 이름을 선택하세요.',
  TEXT_FILE_WRITE_FAILED: '파일 쓰기를 완료하지 못했습니다. 일부 내용이 남아 있을 수 있습니다.',
  TEXT_FILE_WRITE_UNCONFIRMED: '파일 쓰기 결과를 확인하지 못했습니다. 자동으로 다시 쓰거나 삭제하지 않습니다.',
})
class TextFileFailure extends Error {
  constructor(code) { super(MESSAGES[code]); this.name = 'TextFileFailure'; this.code = code }
}
const fail = code => { throw new TextFileFailure(code) }
const safeFailure = (error, fallback) => error instanceof TextFileFailure ? error
  : new TextFileFailure(error?.name === 'NoModificationAllowedError' || error?.code === 'EEXIST' ? 'TEXT_FILE_EXISTS' : fallback)
const wellFormed = text => !/[\uD800-\uDFFF]/u.test(text)
const basename = value => typeof value === 'string' && value.length > 0 && value.length <= 255
  && value !== '.' && value !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(value) && wellFormed(value)
function signalOption(signal) {
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function')) fail('TEXT_FILE_INPUT')
  return signal
}
function selection(value) {
  // Copy only primitive values immediately. The picker/nsIFile can be mutable;
  // no later callback may substitute another target or its displayed filename.
  const path = value?.path, filename = value?.filename
  if (typeof path !== 'string' || !path || /[\u0000-\u001f\u007f]/.test(path) || !wellFormed(path)
      || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)/.test(path)) || !basename(filename)
      || path.split(/[/\\]/).at(-1) !== filename) fail('TEXT_FILE_SELECTION_INVALID')
  return Object.freeze({ path, filename })
}

// Cancel pending read-only steps promptly, even if a native picker cannot be
// dismissed. Consume late rejections, remove listeners, and never process a
// late selection. This is intentionally NOT used for an already-granted write.
function interruptible(operation, signal) {
  if (signal?.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', aborted)
      callback(value)
    }
    const aborted = () => finish(resolve, ABORTED)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) { aborted(); return }
    try { Promise.resolve(operation()).then(value => finish(resolve, value), error => finish(reject, error)) }
    catch (error) { finish(reject, error) }
  })
}

/**
 * createEGDeskTextFilePickers({pickOpenFile,pickSaveFile,stat,readBytes,writeNewFile})
 * returns {readText,saveText} for EGDeskProfileTransfer / EGDeskBoardExport.
 *
 * Host callback contracts (all may return a value or a Promise):
 * - pickOpenFile({accept,signal}) and pickSaveFile({fileName,contentType,signal})
 *   -> {path,filename} ONLY after explicit native picker confirmation, or
 *   {cancelled:true}. path is the absolute chosen target, filename its leaf
 *   name, not a suggestion. Do not pass nsIFile itself or a later getter.
 *   Native returnCancel maps to {cancelled:true}; returnReplace is a known
 *   existing target, NOT cancellation or overwrite permission. The save picker
 *   glue should reject with {code:'EEXIST'} (without a path). This becomes
 *   TEXT_FILE_EXISTS before beginWrite, so the user can choose another name.
 *   This early UX rejection does NOT replace exclusive creation: a target can
 *   still appear after returnOK, and that post-gate collision remains unknown.
 * - stat(path,{signal}) -> {type:'regular',size:<nonnegative integer>}.
 * - readBytes(path,{maxBytes,signal}) -> Uint8Array, starting at byte zero.
 *   Honor maxBytes: the request is the caller's limit + ONE overflow sentinel,
 *   so a file growing after stat cannot slip through as silently truncated text.
 * - writeNewFile(path,bytes,{signal}) -> exact number of bytes written. It MUST
 *   use atomic create-if-absent/exclusive creation on the selected path, not an
 *   exists check followed by an overwrite-capable write. Reject all collisions,
 *   partial writes, and errors; never retry, replace, rename, or delete a file.
 *   Start the exclusive create in this callback without an intervening await.
 *   An abort after the write was granted is an error, never a cancelled receipt.
 *
 * readText({accept:'.md',encoding:'utf-8',maxBytes,signal}) -> {text,filename}
 * or {cancelled:true}. maxBytes is required, 0..0xfffffffe. accept is one simple
 * extension. Stat precedes any read; actual bytes are checked again. Fatal
 * UTF-8 decoding preserves BOM, CR, LF, and all text without normalization,
 * HTML parsing or execution. The result never contains a path.
 * saveText({fileName,text,contentType,signal,beginWrite}) -> {saved:true} or
 * {cancelled:true}. beginWrite is synchronous, one-shot boolean permission.
 * It is called after picker confirmation, immediately before writeNewFile.
 * Only a confirmed full byte-count receipt claims success. Errors are replaced
 * with path-free messages/codes, without original causes/stacks or native DTOs.
 *
 * Verified Gecko glue (2026-10-26; official upstream, not a local native run):
 *   stat: path => IOUtils.stat(path)
 *   readBytes: (path,{maxBytes}) => IOUtils.read(path,{maxBytes})
 *   writeNewFile: (path,bytes) => IOUtils.write(path,bytes,{mode:'create',flush:true})
 * Check signal before invoking a native call; IOUtils has no signal option.
 * Do NOT use tmpPath/backupFile, or invent write noOverwrite/atomic options.
 * mode:'create' uses PR_CREATE_FILE|PR_EXCL on the chosen destination: it is
 * exclusive creation, NOT atomic whole-file publication. A write failure can
 * leave a partial NEW file; the workflow must keep that outcome unknown. There
 * is deliberately no automatic cleanup: that path may since belong to another
 * file. Existing files are never overwritten; the user can choose another name.
 * tmpPath is unsafe for this contract: WriteSync finishes with MoveSync(...,
 * aNoOverwrite=false), which can replace a destination created during the write.
 * Sources:
 * https://github.com/mozilla-firefox/firefox/blob/main/dom/chrome-webidl/IOUtils.webidl
 * https://github.com/mozilla-firefox/firefox/blob/main/xpcom/ioutils/IOUtils.cpp#L1362-L1559
 * https://github.com/mozilla-firefox/firefox/blob/main/widget/nsIFilePicker.idl
 */
export function createEGDeskTextFilePickers({ pickOpenFile, pickSaveFile, stat, readBytes, writeNewFile } = {}) {
  if ([pickOpenFile, pickSaveFile, stat, readBytes, writeNewFile].some(callback => typeof callback !== 'function')) {
    throw new TypeError('Text file pickers require pickOpenFile, pickSaveFile, stat, readBytes and writeNewFile callbacks')
  }
  async function readText(options = {}) {
    let signal, phase = 'TEXT_FILE_PICK_FAILED'
    try {
      signal = signalOption(options?.signal)
      if (signal?.aborted) return CANCELLED
      const { maxBytes, accept = '.md', encoding = 'utf-8' } = options ?? {}
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_READ_LIMIT || encoding !== 'utf-8'
          || typeof accept !== 'string' || !/^\.[a-z0-9][a-z0-9-]{0,15}$/i.test(accept)) fail('TEXT_FILE_INPUT')
      const picked = await interruptible(() => pickOpenFile(Object.freeze({ accept, signal })), signal)
      if (picked === ABORTED || signal?.aborted || picked?.cancelled === true) return CANCELLED
      const chosen = selection(picked)
      if (!chosen.filename.toLowerCase().endsWith(accept.toLowerCase())) fail('TEXT_FILE_FORMAT')
      phase = 'TEXT_FILE_READ_FAILED'
      const info = await interruptible(() => stat(chosen.path, Object.freeze({ signal })), signal)
      if (info === ABORTED || signal?.aborted) return CANCELLED
      if (info?.type !== 'regular') fail('TEXT_FILE_NOT_REGULAR')
      if (!Number.isSafeInteger(info.size) || info.size < 0) fail('TEXT_FILE_READ_FAILED')
      if (info.size > maxBytes) fail('TEXT_FILE_TOO_LARGE')
      const raw = await interruptible(() => readBytes(chosen.path, Object.freeze({ maxBytes: maxBytes + 1, signal })), signal)
      if (raw === ABORTED || signal?.aborted) return CANCELLED
      if (!ArrayBuffer.isView(raw) || Object.prototype.toString.call(raw) !== '[object Uint8Array]') fail('TEXT_FILE_READ_FAILED')
      if (raw.byteLength > maxBytes) fail('TEXT_FILE_TOO_LARGE')
      // Snapshot the returned view; do not decode unrelated bytes in its buffer.
      const bytes = new Uint8Array(raw)
      let text
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { fail('TEXT_FILE_UTF8') }
      return Object.freeze({ text, filename: chosen.filename })
    } catch (error) {
      if (signal?.aborted) return CANCELLED
      throw safeFailure(error, phase)
    }
  }
  async function saveText(options = {}) {
    let signal, gateEntered = false, phase = 'TEXT_FILE_PICK_FAILED'
    try {
      signal = signalOption(options?.signal)
      if (signal?.aborted) return CANCELLED
      // Snapshot caller input before opening a picker; only these bytes belong
      // to this action, even if the caller edits/rebinds its original object.
      const { fileName, text, contentType, beginWrite } = options ?? {}
      if (!basename(fileName) || typeof text !== 'string' || !wellFormed(text) || typeof contentType !== 'string'
          || !contentType || /[\u0000-\u001f\u007f]/.test(contentType) || typeof beginWrite !== 'function') fail('TEXT_FILE_INPUT')
      const picked = await interruptible(() => pickSaveFile(Object.freeze({ fileName, contentType, signal })), signal)
      if (picked === ABORTED || signal?.aborted || picked?.cancelled === true) return CANCELLED
      const chosen = selection(picked), bytes = new TextEncoder().encode(text), byteLength = bytes.byteLength
      if (signal?.aborted) return CANCELLED
      phase = 'TEXT_FILE_WRITE_GATE'
      gateEntered = true
      const permission = beginWrite()
      if (permission === false) return CANCELLED
      if (permission !== true) fail('TEXT_FILE_WRITE_GATE')
      if (signal?.aborted) fail('TEXT_FILE_WRITE_UNCONFIRMED')
      phase = 'TEXT_FILE_WRITE_FAILED'
      // No stat/exists check and NO await between the gate and this invocation.
      const written = await writeNewFile(chosen.path, bytes, Object.freeze({ signal }))
      if (signal?.aborted || written !== byteLength) fail('TEXT_FILE_WRITE_UNCONFIRMED')
      return SAVED
    } catch (error) {
      if (!gateEntered && signal?.aborted) return CANCELLED
      throw safeFailure(error, phase)
    }
  }
  return Object.freeze({ readText, saveText })
}
