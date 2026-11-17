// RT-03 .egdesk export and import, as the screen sees them. The bridge owns
// the files (helper 2f9b030, egdesk-portable-http.mjs):
//   GET  /v1/state capabilities.portable: ['export', 'inspect', 'import-as-new',
//        'passphrase', 'exports-list', 'attachments'?, 'file-drafts'?], or ['local-store-unavailable'];
//        an older bridge sends none and answers the routes 404.
//   GET  /v1/portable/exports → { folder, displayPath, files: [{ fileName, bytes, modifiedAt, fileRef }] }
//   POST /v1/portable/export { scope: 'desk'|'board', boardId?, include: { chats, profiles, attachments?, fileDrafts? }, passphrase? }
//        → 201 { fileName, bytes, encrypted, contents, omitted, folder, displayPath, fileRef, redacted }
//        attachments (context captures) and fileDrafts are sent only when chosen
//        (D-R3: off by default), so an older bridge never sees the new fields.
//   POST /v1/portable/inspect { fileRef | bundle (base64), passphrase? }
//        → 200 summary, or { encrypted: true, locked: true, bytes } without the passphrase
//   POST /v1/portable/import { fileRef | bundle, passphrase?, mode: 'asNew' }
//        → 201 { mode, encrypted, verified, contents, desk, boards, chats, profiles, attachments, fileDrafts, redacted }
//   failures: { code, error, reason?, encrypted?, locked?, written? }.
// Import never overwrites: what already exists stays, and a taken ID makes a
// new copy. A passphrase is used for the requests that need it and never
// enters a snapshot. No error code, reason or ID reaches the screen text.
// The dialog flow (choose → check → confirm) follows Excalidraw's 'Save to…' /
// 'Open' with its overwrite warning and tldraw's per-cause file-open errors.
// Pattern reference only, no code copied: excalidraw/excalidraw (MIT) OverwriteConfirm + actionLoadScene; tldraw utils/tldr/file.ts.

export const PORTABLE_MIN_PASSPHRASE_CHARS = 8;
export const PORTABLE_MAX_PASSPHRASE_CHARS = 1024;
export const PORTABLE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const PORTABLE_EXTENSION = '.egdesk';
export const PORTABLE_PLAIN_WARNING = '암호 없이 저장하면 파일을 가진 누구나 내용을 볼 수 있습니다.';
export const PORTABLE_NEW_ENGINE_NOTE = '가져온 대화는 이어서 말하면 새 엔진 대화로 시작합니다.';
export const PORTABLE_DRAFT_NOTE = '파일 초안은 원본 파일과 연결하지 않은 초안으로 들어왔습니다. 원본에 저장하려면 파일 창에서 다시 연결해 주세요.';
export const PORTABLE_EXTRAS_HINT = '꺼 두면 넣지 않습니다. 비밀번호·키·토큰이 든 파일과 너무 큰 파일은 켜도 빠집니다.';

/** What the connected bridge supports; an older bridge (no list) supports nothing. */
export function portableSupport(bridgeState) {
  const list = Array.isArray(bridgeState?.capabilities?.portable) ? bridgeState.capabilities.portable : [];
  const has = name => list.includes(name);
  return {
    export: has('export'), inspect: has('inspect'), importAsNew: has('import-as-new') && has('inspect'),
    passphrase: has('passphrase'), exportsList: has('exports-list'), storeUnavailable: has('local-store-unavailable'),
    attachments: has('attachments'), fileDrafts: has('file-drafts'),
  };
}

const passphraseLength = text => Array.from(text).length;
/**
 * POST /v1/portable/export, or { error } for a passphrase the bridge would refuse.
 * An empty passphrase means a plain file (the screen shows PORTABLE_PLAIN_WARNING).
 * Profiles never travel from the screen (include.profiles false).
 */
export function portableExportRequest({ scope, boardId = null, includeChats = false, includeAttachments = false, includeFileDrafts = false, passphrase = '', confirm = '' } = {}) {
  if (scope !== 'desk' && scope !== 'board') return { error: { field: null, text: '무엇을 내보낼지 알 수 없습니다.' } };
  if (scope === 'board' && (typeof boardId !== 'string' || !boardId)) return { error: { field: null, text: '내보낼 Board를 찾지 못했습니다.' } };
  const secret = typeof passphrase === 'string' ? passphrase : '';
  if (secret) {
    if (passphraseLength(secret) < PORTABLE_MIN_PASSPHRASE_CHARS) return { error: { field: 'passphrase', text: `암호는 ${PORTABLE_MIN_PASSPHRASE_CHARS}자 이상이어야 합니다.` } };
    if (secret.length > PORTABLE_MAX_PASSPHRASE_CHARS) return { error: { field: 'passphrase', text: '암호가 너무 깁니다.' } };
    if (secret !== confirm) return { error: { field: 'confirm', text: '두 암호가 같지 않습니다. 다시 입력해 주세요.' } };
  }
  return {
    method: 'POST', path: '/v1/portable/export',
    body: { scope, ...(scope === 'board' ? { boardId } : {}), include: { chats: includeChats === true, profiles: false,
      ...(includeAttachments === true ? { attachments: true } : {}), ...(includeFileDrafts === true ? { fileDrafts: true } : {}) }, ...(secret ? { passphrase: secret } : {}) },
  };
}

/** A file from the bridge's export folder, or bytes the person picked. */
export function portableSourceFromExport(file) {
  const name = file?.fileRef?.exportFile;
  return typeof name === 'string' && name ? { kind: 'export', fileName: name, fileRef: { exportFile: name } } : null;
}
export function portableSourceFromBytes(fileName, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
  if (!data || !data.length) return null;
  return { kind: 'file', fileName: typeof fileName === 'string' && fileName ? fileName : `파일${PORTABLE_EXTENSION}`, bytes: data.length, bundle: bytesToBase64(data) };
}
const sourceBody = source => source.kind === 'export' ? { fileRef: source.fileRef } : { bundle: source.bundle };
export function portableInspectRequest(source, passphrase = '') {
  return { method: 'POST', path: '/v1/portable/inspect', body: { ...sourceBody(source), ...(passphrase ? { passphrase } : {}) } };
}
export function portableImportRequest(source, passphrase = '') {
  return { method: 'POST', path: '/v1/portable/import', body: { ...sourceBody(source), ...(passphrase ? { passphrase } : {}), mode: 'asNew' } };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = Array.from(B64, ch => ch.charCodeAt(0));
/** Standard base64 with padding (what the bridge's bundle field takes), in chunks. */
export function bytesToBase64(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parts = [];
  const step = 3 * 8192;
  for (let start = 0; start < data.length; start += step) {
    const end = Math.min(start + step, data.length);
    const out = new Array(Math.ceil((end - start) / 3) * 4);
    let o = 0;
    for (let i = start; i < end; i += 3) {
      const a = data[i], b = i + 1 < end ? data[i + 1] : 0, c = i + 2 < end ? data[i + 2] : 0;
      out[o++] = B64_CODES[a >> 2];
      out[o++] = B64_CODES[((a & 3) << 4) | (b >> 4)];
      out[o++] = i + 1 < end ? B64_CODES[((b & 15) << 2) | (c >> 6)] : 61;
      out[o++] = i + 2 < end ? B64_CODES[c & 63] : 61;
    }
    parts.push(String.fromCharCode.apply(null, out));
  }
  return parts.join('');
}

const pad = number => String(number).padStart(2, '0');
/** '2026-10-24 15:30' in this computer's time, or null. */
export function portableTimeText(at) {
  if (!Number.isFinite(at) || at <= 0) return null;
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** '512바이트', '1.2KB', '3.4MB'. */
export function portableSizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes}바이트`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))}KB`;
  return `${Number((bytes / 1024 / 1024).toFixed(1))}MB`;
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const titleText = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
/** 'Board 2개 · 카드 5개 · 대화 0개' (+ ' · Agent N개' when any). */
export function portableContentsText(contents) {
  const parts = [`Board ${count(contents?.boards)}개`, `카드 ${count(contents?.cards)}개`, `대화 ${count(contents?.chats)}개`];
  if (count(contents?.profiles)) parts.push(`Agent ${count(contents.profiles)}개`);
  if (count(contents?.attachments)) parts.push(`첨부 ${count(contents.attachments)}개`);
  if (count(contents?.fileDrafts)) parts.push(`파일 초안 ${count(contents.fileDrafts)}개`);
  return parts.join(' · ');
}
const OMIT_TEXT = { secret: '비밀값이 들어 있어', 'too-large': '너무 커서', limit: '개수·용량 한도를 넘어', unreadable: '읽지 못해', 'unsafe-name': '이름이 안전하지 않아' };
/** One note per omitted kind: '첨부 3개는 빼고 저장했습니다(비밀값이 들어 있어 2개, 너무 커서 1개).' Names never reach the text. */
export function portableOmittedNotes(omitted, { verb = '빼고 저장했습니다' } = {}) {
  const notes = [];
  for (const [key, label] of [['attachments', '첨부'], ['fileDrafts', '파일 초안']]) {
    const list = Array.isArray(omitted?.[key]) ? omitted[key] : [];
    const total = Array.isArray(omitted?.[key]) ? list.length : count(omitted?.[key]);
    if (!total) continue;
    const reasons = {};
    for (const item of list) if (OMIT_TEXT[item?.reason]) reasons[item.reason] = (reasons[item.reason] || 0) + 1;
    const detail = Object.entries(reasons).map(([reason, n]) => `${OMIT_TEXT[reason]} ${n}개`).join(', ');
    notes.push(`${label} ${total}개는 ${verb}${detail ? `(${detail})` : ''}.`);
  }
  return notes;
}
const scopeText = contents => contents?.scope === 'board' ? `Board '${titleText(contents.title) || 'Board'}'` : 'Desk 전체';

/** GET /v1/portable/exports as rows; the folder is named, never as a full path. */
export function portableExportFilesView(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const rows = files.map(file => {
    const source = portableSourceFromExport(file);
    if (!source) return null;
    return { source, fileName: source.fileName, meta: [portableSizeText(file.bytes), portableTimeText(file.modifiedAt)].filter(Boolean).join(' · ') };
  }).filter(Boolean).slice(0, 100);
  const folder = typeof payload?.displayPath === 'string' && payload.displayPath.startsWith('~/') ? payload.displayPath : '내보내기 폴더';
  return { folder, rows, empty: rows.length === 0 };
}

/**
 * POST /v1/portable/inspect as the check before importing: what is inside, when
 * it was made, whether it is locked, and what importing does to this screen
 * (Excalidraw's 'Open' warns before replacing what is open; here only a Desk
 * file replaces the Desk view, and the current one stays in 복구 기록).
 */
export function portablePreviewView(summary, { fileName = null } = {}) {
  if (!summary || typeof summary !== 'object') return null;
  if (summary.locked === true) return { locked: true, fileName, sizeText: portableSizeText(summary.bytes) };
  const made = portableTimeText(summary.exportedAt);
  const replacesDesk = summary.scope === 'desk' && summary.desk === true;
  return {
    locked: false, fileName, scope: summary.scope === 'board' ? 'board' : 'desk', replacesDesk,
    headline: scopeText(summary),
    summary: [portableContentsText(summary), made ? `${made}에 만듦` : null, summary.encrypted ? '암호로 잠김' : '암호 없음'].filter(Boolean).join(' · '),
    notes: [...portableOmittedNotes(summary.omitted, { verb: '만들 때 빠졌습니다' }),
      ...(count(summary.fileDrafts) ? ['파일 초안은 원본 파일과 연결하지 않은 새 초안으로 들어옵니다. 원본 파일은 바꾸지 않습니다.'] : [])],
    effect: replacesDesk
      ? { tone: 'warning', text: '가져오면 지금 Desk 화면이 이 파일의 Desk로 바뀝니다. 지금 화면은 먼저 복구 기록에 남기고, Board와 대화는 새 사본으로 더합니다.' }
      : { tone: 'info', text: '지금 화면은 그대로 두고, 들어 있는 Board와 대화를 새 사본으로 더합니다.' },
    confirmLabel: '새 사본으로 가져오기',
  };
}

const redactedCount = redacted => count(redacted?.privateFields) + count(redacted?.identifiers) + count(redacted?.maskedTexts);
/** 201 from POST /v1/portable/export: where the file is and what it holds. */
export function portableExportDoneView(result, { saved = true } = {}) {
  const where = typeof result?.displayPath === 'string' && result.displayPath ? result.displayPath : titleText(result?.fileName) || '내보내기 폴더';
  const notes = [];
  if (!result?.encrypted) notes.push(PORTABLE_PLAIN_WARNING);
  const hidden = redactedCount(result?.redacted);
  if (hidden) notes.push(`비밀번호·계정 정보처럼 이 PC에만 있어야 하는 값 ${hidden}개는 빼고 저장했습니다.`);
  if (count(result?.contents?.chatsOmitted)) notes.push(`대화가 많아 ${count(result.contents.chatsOmitted)}개는 넣지 못했습니다.`);
  notes.push(...portableOmittedNotes(result?.omitted));
  if (!saved) notes.push('화면의 마지막 변경을 먼저 저장하지 못해, 그 변경은 파일에 빠졌을 수 있습니다.');
  return {
    title: '내보냈습니다', where, fileName: titleText(result?.fileName),
    summary: [scopeText(result?.contents), portableContentsText(result?.contents), portableSizeText(result?.bytes), result?.encrypted ? '암호로 잠김' : '암호 없음'].filter(Boolean).join(' · '),
    notes,
  };
}

/** 201 from POST /v1/portable/import, after the screen redrew what it could. */
export function portableImportDoneView(result, { redrawn = true } = {}) {
  const boards = Array.isArray(result?.boards) ? result.boards : [];
  const chats = Array.isArray(result?.chats) ? result.chats : [];
  const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
  const attachments = Array.isArray(result?.attachments) ? result.attachments : [];
  const fileDrafts = Array.isArray(result?.fileDrafts) ? result.fileDrafts : [];
  const notes = [];
  const copies = boards.filter(item => item?.idChanged === true).length + chats.filter(item => item?.idChanged === true).length;
  if (copies) notes.push(`같은 ID가 있어 새 사본(${copies}개)으로 들어왔습니다.`);
  if (chats.length) notes.push(PORTABLE_NEW_ENGINE_NOTE);
  const added = profiles.filter(item => item?.status === 'imported').length;
  const skipped = profiles.filter(item => item?.status === 'duplicate').length;
  if (added) notes.push(`Agent ${added}개를 더했습니다.`);
  if (skipped) notes.push(`이미 있는 Agent ${skipped}개는 건너뛰었습니다.`);
  if (attachments.length) notes.push(`첨부 ${attachments.length}개를 새 사본으로 더했습니다.`);
  if (fileDrafts.length) notes.push(PORTABLE_DRAFT_NOTE);
  if (result?.desk && !redrawn) notes.push('가져온 Desk를 화면에 다시 그리지 못했습니다. 복구 기록에서 열 수 있습니다.');
  if (result?.verified === false) notes.push('가져온 내용을 다시 열어 확인하지 못했습니다. Board 목록과 복구 기록에서 확인해 주세요.');
  return {
    title: '가져왔습니다',
    summary: [scopeText(result?.contents), portableContentsText(result?.contents)].join(' · '),
    deskReplaced: !!result?.desk, boards: boards.length, chats: chats.length, notes,
    // What came in, one line per kind that has any (the import summary list).
    received: [
      result?.desk ? 'Desk 화면' : null,
      boards.length ? `Board ${boards.length}개` : null,
      chats.length ? `대화 ${chats.length}개` : null,
      added ? `Agent ${added}개 (검토 필요 초안)` : null,
      attachments.length ? `첨부 ${attachments.length}개` : null,
      fileDrafts.length ? `파일 초안 ${fileDrafts.length}개 (원본과 연결 안 됨)` : null,
    ].filter(Boolean),
  };
}

const ERROR_TEXT = {
  PORTABLE_PASSPHRASE_REQUIRED: '암호로 잠긴 파일입니다. 내보낼 때 정한 암호를 입력해 주세요.',
  PORTABLE_PASSPHRASE_INVALID: '암호가 맞지 않거나 파일이 바뀌었습니다. 아무것도 가져오지 않았습니다.',
  PORTABLE_PASSPHRASE_TOO_SHORT: `암호는 ${PORTABLE_MIN_PASSPHRASE_CHARS}자 이상이어야 합니다.`,
  PORTABLE_FILE_DAMAGED: '파일이 손상되었거나 EG-Desk 파일이 아닙니다. 아무것도 가져오지 않았습니다.',
  PORTABLE_VERSION_UNSUPPORTED: '더 새로운 EG-Desk에서 만든 파일입니다. EG-Desk를 업데이트한 뒤 다시 열어 주세요.',
  PORTABLE_PRIVATE_FIELD: '파일에 비밀번호나 키 같은 보호 값이 들어 있어 가져오지 않았습니다.',
  PORTABLE_FILE_TOO_LARGE: '파일이나 그 안의 내용이 너무 커서(최대 64MB) 가져오지 않았습니다.',
  PORTABLE_EXPORT_TOO_LARGE: '내보낼 내용이 너무 커서 파일을 만들지 않았습니다. 대화 기록을 빼고 다시 시도해 주세요.',
  PORTABLE_NOTHING_TO_EXPORT: '내보낼 Desk나 저장된 Board가 아직 없습니다.',
  PORTABLE_LIMIT: '보관할 수 있는 Board나 Agent 수를 넘어 가져오지 않았습니다. 쓰지 않는 Board를 정리한 뒤 다시 시도해 주세요.',
  PORTABLE_BUSY: '다른 내보내기나 가져오기가 진행 중입니다. 끝난 뒤 다시 시도해 주세요.',
  PORTABLE_FILE_NOT_FOUND: '그 파일을 찾지 못했습니다. 목록을 새로 불러와 주세요.',
  PORTABLE_EXPORT_NAME_TAKEN: '같은 이름의 파일이 너무 많습니다. 내보내기 폴더를 정리한 뒤 다시 시도해 주세요.',
  BOARD_NOT_FOUND: '이 Board가 아직 저장소에 없습니다. Board를 저장한 뒤 다시 시도해 주세요.',
  PORTABLE_LOOPBACK_REQUIRED: '이 컴퓨터의 EG-Desk에서만 할 수 있습니다.',
  PORTABLE_ENTRY_UNSAFE: '파일 안의 첨부나 파일 초안이 안전하지 않아(폴더 경로가 든 이름, 내용 불일치, 비밀값 파일) 아무것도 가져오지 않았습니다.',
  PORTABLE_ATTACHMENT_STORE_UNAVAILABLE: '첨부는 Codex 계정에 로그인한 상태에서만 내보내거나 가져올 수 있습니다. 아무것도 바꾸지 않았습니다.',
  PORTABLE_DRAFT_STORE_UNAVAILABLE: '지금은 파일 초안 저장소를 쓸 수 없어 진행하지 못했습니다. 아무것도 바꾸지 않았습니다.',
  // This screen's own refusal: the Desk as it is now could not be kept in 복구 기록 first.
  PORTABLE_DESK_NOT_KEPT: '지금 Desk를 복구 기록에 먼저 남기지 못해 가져오지 않았습니다. 연결을 확인한 뒤 다시 시도해 주세요.',
};
const UNAVAILABLE_TEXT = '지금은 EG-Desk 저장소를 쓸 수 없어 진행하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
/** Korean text for a refused export or import; never the code, reason or English message. */
export function portableErrorText(error, { action = 'import' } = {}) {
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code === 'PORTABLE_IMPORT_PARTIAL') {
    const written = error.written && typeof error.written === 'object' ? error.written : {};
    const parts = [written.desk ? 'Desk' : null,
      Array.isArray(written.boards) && written.boards.length ? `Board ${written.boards.length}개` : null,
      Array.isArray(written.chats) && written.chats.length ? `대화 ${written.chats.length}개` : null,
      Array.isArray(written.profiles) && written.profiles.length ? `Agent ${written.profiles.length}개` : null,
      Array.isArray(written.attachments) && written.attachments.length ? `첨부 ${written.attachments.length}개` : null,
      Array.isArray(written.fileDrafts) && written.fileDrafts.length ? `파일 초안 ${written.fileDrafts.length}개` : null].filter(Boolean);
    return `가져오다 멈췄습니다. ${parts.length ? `${parts.join(' · ')}는 이미 들어왔습니다. ` : ''}Board 목록과 복구 기록을 확인해 주세요.`;
  }
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (error?.status === 503 || (code && /_UNAVAILABLE$/.test(code))) return UNAVAILABLE_TEXT;
  if (error?.status === 403) return ERROR_TEXT.PORTABLE_LOOPBACK_REQUIRED;
  if (error?.status === 404 || error?.status === 405) return '지금 연결된 EG-Desk는 내보내기와 가져오기를 지원하지 않습니다.';
  if (!error?.status) return 'EG-Desk에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
  return action === 'export' ? '내보내지 못했습니다. 파일은 만들지 않았습니다. 잠시 뒤 다시 시도해 주세요.'
    : action === 'list' ? '내보낸 파일 목록을 불러오지 못했습니다.' : '가져오지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}

/**
 * The export and import dialogs as one small state machine. The screen draws
 * snapshot() and calls these; the bridge request and the screen's own steps
 * are passed in:
 *   request(method, path, body) → { status, body } (throws when unreachable)
 *   saveBeforeExport({ scope, boardId }) → { saved } — the Desk or Board as it is now goes to the store first
 *   readFile() → { fileName, bytes } | null (cancelled); throws { code } for a file too large
 *   beforeImport({ replacesDesk }) → { ok } — keep the Desk as it is now in 복구 기록 and hold autosave; ok false stops the import
 *   applyImported(result) → { redrawn } — redraw and reload lists before the next autosave
 *   afterImport() — release what beforeImport held, success or not
 * Export: form → saving → exporting → done. Import: choose → checking →
 * (locked →) preview → importing → done. One request at a time.
 */
export function createPortableFlow({ request, saveBeforeExport = async () => ({ saved: true }), readFile = async () => null,
  beforeImport = async () => {}, applyImported = async () => ({ redrawn: true }), afterImport = () => {}, onState = () => {} } = {}) {
  if (typeof request !== 'function') throw new TypeError('request is required');
  const closed = () => ({ open: false, mode: null, step: 'closed', busy: false, scope: null, boardId: null, boardTitle: null,
    includeChats: false, includeAttachments: false, includeFileDrafts: false, extras: { attachments: false, fileDrafts: false }, error: null, errorField: null, files: null, filesStatus: 'idle', source: null, preview: null, done: null, exportsList: false });
  let state = closed();
  // Held only between inspect and import of one locked file; never in a snapshot.
  let secret = '';
  let generation = 0;
  const snapshot = () => ({ ...state, extras: { ...state.extras }, files: state.files && { ...state.files, rows: state.files.rows.map(row => ({ ...row })) },
    source: state.source && { kind: state.source.kind, fileName: state.source.fileName }, preview: state.preview && { ...state.preview },
    done: state.done && { ...state.done, notes: [...state.done.notes] } });
  const publish = patch => { state = { ...state, ...patch }; try { onState(snapshot()); } catch { /* A listener never breaks the flow. */ } return snapshot(); };
  const call = async (spec, action) => {
    let response;
    try { response = await request(spec.method, spec.path, spec.body); }
    catch { throw Object.assign(new Error('unreachable'), { status: 0 }); }
    const status = Number(response?.status) || 0;
    const body = response?.body ?? null;
    if (status >= 200 && status < 300) return body;
    throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : `HTTP ${status}`), {
      status, code: typeof body?.code === 'string' ? body.code : null, encrypted: body?.encrypted === true, written: body?.written ?? null, action });
  };

  // extras: which opt-in kinds the bridge supports (portableSupport); both start unchecked (D-R3).
  function openExport({ scope = 'desk', boardId = null, boardTitle = null, extras = null } = {}) {
    generation++;
    secret = '';
    return publish({ ...closed(), open: true, mode: 'export', step: 'form', scope: scope === 'board' ? 'board' : 'desk',
      extras: { attachments: extras?.attachments === true, fileDrafts: extras?.fileDrafts === true },
      boardId: scope === 'board' ? boardId : null, boardTitle: scope === 'board' ? titleText(boardTitle) || 'Board' : null });
  }

  async function submitExport({ passphrase = '', confirm = '', includeChats = false, includeAttachments = false, includeFileDrafts = false } = {}) {
    if (state.mode !== 'export' || state.busy || state.step !== 'form') return snapshot();
    // A kind the bridge does not support is never requested, whatever the screen sent.
    const chosen = { includeChats: includeChats === true, includeAttachments: includeAttachments === true && state.extras.attachments, includeFileDrafts: includeFileDrafts === true && state.extras.fileDrafts };
    const spec = portableExportRequest({ scope: state.scope, boardId: state.boardId, ...chosen, passphrase, confirm });
    if (spec.error) return publish({ ...chosen, error: spec.error.text, errorField: spec.error.field });
    const epoch = ++generation;
    publish({ busy: true, step: 'saving', ...chosen, error: null, errorField: null });
    let saved = false;
    try { saved = (await saveBeforeExport({ scope: state.scope, boardId: state.boardId }))?.saved !== false; } catch { saved = false; }
    if (epoch !== generation) return snapshot();
    publish({ step: 'exporting' });
    try {
      const result = await call(spec, 'export');
      if (epoch !== generation) return snapshot();
      return publish({ busy: false, step: 'done', done: portableExportDoneView(result, { saved }) });
    } catch (error) {
      if (epoch !== generation) return snapshot();
      return publish({ busy: false, step: 'form', error: portableErrorText(error, { action: 'export' }),
        errorField: error.code === 'PORTABLE_PASSPHRASE_TOO_SHORT' ? 'passphrase' : null });
    }
  }

  async function openImport({ exportsList = true } = {}) {
    const epoch = ++generation;
    secret = '';
    publish({ ...closed(), open: true, mode: 'import', step: 'choose', exportsList, filesStatus: exportsList ? 'loading' : 'idle' });
    if (!exportsList) return snapshot();
    return loadExports(epoch);
  }
  async function loadExports(epoch = ++generation) {
    publish({ filesStatus: 'loading' });
    try {
      const payload = await call({ method: 'GET', path: '/v1/portable/exports' }, 'list');
      if (epoch !== generation) return snapshot();
      return publish({ files: portableExportFilesView(payload), filesStatus: 'ready' });
    } catch (error) {
      if (epoch !== generation) return snapshot();
      return publish({ files: null, filesStatus: 'error', error: portableErrorText(error, { action: 'list' }) });
    }
  }

  async function inspect(source, epoch) {
    publish({ busy: true, step: 'checking', source, error: null, errorField: null, preview: null });
    try {
      const summary = await call(portableInspectRequest(source, secret), 'import');
      if (epoch !== generation) return snapshot();
      const preview = portablePreviewView(summary, { fileName: source.fileName });
      if (!preview) throw Object.assign(new Error('bad summary'), { status: 500, code: 'PORTABLE_FILE_DAMAGED' });
      if (preview.locked) { secret = ''; return publish({ busy: false, step: 'locked', preview }); }
      return publish({ busy: false, step: 'preview', preview });
    } catch (error) {
      if (epoch !== generation) return snapshot();
      const locked = ['PORTABLE_PASSPHRASE_REQUIRED', 'PORTABLE_PASSPHRASE_INVALID'].includes(error.code);
      if (!locked) secret = '';
      return publish({ busy: false, step: locked ? 'locked' : 'choose', error: portableErrorText(error), errorField: locked ? 'passphrase' : null,
        source: locked ? source : null, preview: locked ? { locked: true, fileName: source.fileName, sizeText: null } : null });
    }
  }
  async function chooseExport(file) {
    if (state.mode !== 'import' || state.busy) return snapshot();
    const source = portableSourceFromExport(file);
    if (!source) return publish({ error: portableErrorText({ code: 'PORTABLE_FILE_NOT_FOUND', status: 404 }) });
    secret = '';
    return inspect(source, ++generation);
  }
  async function chooseFile() {
    if (state.mode !== 'import' || state.busy) return snapshot();
    const epoch = ++generation;
    publish({ busy: true, error: null, errorField: null });
    let picked;
    try { picked = await readFile(); }
    catch (error) {
      if (epoch !== generation) return snapshot();
      return publish({ busy: false, step: 'choose', error: portableErrorText({ code: error?.code || 'PORTABLE_FILE_DAMAGED', status: 400 }) });
    }
    if (epoch !== generation) return snapshot();
    // A cancelled picker is not an error (Excalidraw's AbortError path).
    if (!picked) return publish({ busy: false });
    if (picked.bytes?.length > PORTABLE_MAX_FILE_BYTES) return publish({ busy: false, error: ERROR_TEXT.PORTABLE_FILE_TOO_LARGE });
    const source = portableSourceFromBytes(picked.fileName, picked.bytes);
    if (!source) return publish({ busy: false, error: ERROR_TEXT.PORTABLE_FILE_DAMAGED });
    secret = '';
    return inspect(source, epoch);
  }
  async function unlock(passphrase = '') {
    if (state.step !== 'locked' || state.busy || !state.source) return snapshot();
    if (!passphrase) return publish({ error: ERROR_TEXT.PORTABLE_PASSPHRASE_REQUIRED, errorField: 'passphrase' });
    secret = passphrase;
    return inspect(state.source, ++generation);
  }
  async function confirmImport() {
    if (state.step !== 'preview' || state.busy || !state.source) return snapshot();
    const epoch = ++generation;
    const source = state.source;
    publish({ busy: true, step: 'importing', error: null });
    let held = false;
    try {
      held = true;
      const ready = await beforeImport({ replacesDesk: state.preview?.replacesDesk === true });
      if (ready?.ok === false) throw Object.assign(new Error('desk not kept'), { status: -1, code: 'PORTABLE_DESK_NOT_KEPT' });
      const result = await call(portableImportRequest(source, secret), 'import');
      secret = '';
      let redrawn = true;
      try { redrawn = (await applyImported(result))?.redrawn !== false; } catch { redrawn = false; }
      if (epoch !== generation) return snapshot();
      return publish({ busy: false, step: 'done', source: null, done: portableImportDoneView(result, { redrawn }) });
    } catch (error) {
      if (epoch !== generation) return snapshot();
      const locked = ['PORTABLE_PASSPHRASE_REQUIRED', 'PORTABLE_PASSPHRASE_INVALID'].includes(error.code);
      if (locked) secret = '';
      return publish({ busy: false, step: locked ? 'locked' : 'preview', error: portableErrorText(error), errorField: locked ? 'passphrase' : null });
    } finally {
      if (held) try { afterImport(); } catch { /* Same. */ }
    }
  }
  function back() {
    if (state.busy) return snapshot();
    generation++;
    secret = '';
    if (state.mode === 'import') return publish({ step: 'choose', source: null, preview: null, error: null, errorField: null });
    return publish({ step: 'form', error: null, errorField: null, done: null });
  }
  function close() {
    generation++;
    secret = '';
    return publish(closed());
  }
  return { snapshot, openExport, submitExport, openImport, loadExports: () => loadExports(), chooseExport, chooseFile, unlock, confirmImport, back, close };
}

// ── Bundle-library controller (before the bridge routes) ──
// The screen no longer uses this: it talks to the bridge over HTTP
// (createPortableFlow above). It stays for helper/egdesk-portable-bundle.test.mjs,
// which drives the bundle library's planExport/exportPlan API directly.
// Passwords and source bytes are deliberately absent from snapshots and callbacks.
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
