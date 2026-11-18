// Manual file exchange only. No Board snapshot, source, account or delivery adapter.
import { bytesToBase64, PORTABLE_MIN_PASSPHRASE_CHARS, PORTABLE_MAX_PASSPHRASE_CHARS } from './EGDeskPortableState.sys.mjs';

export const REVIEW_EXTENSION = '.egdesk';
export const REVIEW_MAX_FILE_BYTES = 256 * 1024;
export const REVIEW_RECORD_LIMIT = 48;
export const REVIEW_FIELDS = Object.freeze({ recipient: 256, question: 2048, excerpt: 8192, expectedReply: 2048, answer: 8192, askCode: 39 });
export const REVIEW_LABELS = Object.freeze({ recipient: '받는 사람 표기', question: '검토 질문', excerpt: '공유할 발췌문', expectedReply: '원하는 답변', answer: '회신 내용', askCode: 'Board 질문 코드' });
const requestFields = Object.keys(REVIEW_FIELDS).slice(0, 4);
const askCodePattern = /^egask1-[0-9a-f]{32}$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const pairValid = value => typeof value?.requestId === 'string' && idPattern.test(value.requestId) &&
  typeof value.requestDigest === 'string' && digestPattern.test(value.requestDigest);
const pair = ({ requestId, requestDigest }) => ({ requestId, requestDigest });
const samePair = (a, b) => a.requestId === b.requestId && a.requestDigest === b.requestDigest;
const encoder = new TextEncoder();
// IOUtils can supply an octet array from a different Gecko realm. Native
// TypedArray getters inspect internal slots rather than a caller-provided tag.
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBrand = Object.getOwnPropertyDescriptor(typedArrayProto, Symbol.toStringTag).get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayProto, 'byteLength').get;
function copyReviewBytes(value) {
  if (typedArrayBrand.call(value) !== 'Uint8Array') return null;
  const length = typedArrayByteLength.call(value);
  if (!length || length > REVIEW_MAX_FILE_BYTES) return null;
  const bytes = new Uint8Array(length);
  Uint8Array.prototype.set.call(bytes, value);
  return bytes;
}
const failure = (text, field) => ({ text, field });

export function reviewHandoffSupported(state) {
  return Array.isArray(state?.capabilities?.portable) && state.capabilities.portable.includes('reviewHandoff');
}

function reviewText(field, raw) {
  const value = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').normalize('NFC').trim() : '';
  const label = REVIEW_LABELS[field];
  if (!value && field !== 'excerpt') return { error: failure(`${label} 항목을 입력해 주세요.`, field) };
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.replace(/[\n\t]/g, '')) || (field === 'recipient' && /[\n\r\u2028\u2029]/.test(value))) {
    return { error: failure(`${label} 항목에 허용되지 않는 줄바꿈이나 문자가 있습니다.`, field) };
  }
  const limit = REVIEW_FIELDS[field];
  if (encoder.encode(value).length > limit) return { error: failure(`${label} 항목은 UTF-8 ${limit}바이트 이하여야 합니다.`, field) };
  return { value };
}

export function reviewRequestDraft(raw = {}) {
  const review = { kind: 'request' };
  for (const field of requestFields) {
    const result = reviewText(field, raw?.[field]);
    if (result.error) return result;
    review[field] = result.value;
  }
  if (raw?.askCode !== undefined && raw.askCode !== '') {
    if (typeof raw.askCode !== 'string' || !askCodePattern.test(raw.askCode)) return { error: failure('공유받은 Board 질문 코드를 확인해 주세요.', 'askCode') };
    review.askCode = raw.askCode;
  }
  return { review };
}

function reviewReplyDraft(request, answer) {
  const result = reviewText('answer', answer);
  if (result.error) return result;
  return { review: { kind: 'reply', ...pair(request), answer: result.value } };
}

// Never put unknown helper data into the UI or the local registry. Check that
// each returned value already is canonical; do not alter inspected file text.
function canonicalReview(raw) {
  if (!pairValid(raw)) return null;
  const parsed = raw.kind === 'request' ? reviewRequestDraft(raw) : raw.kind === 'reply' ? reviewReplyDraft(raw, raw.answer) : null;
  const review = parsed?.review;
  if (!review || Object.keys(review).some(key => raw[key] !== review[key])) return null;
  if (Object.keys(raw).length !== (raw.kind === 'request' ? 7 + (review.askCode ? 1 : 0) : 4)) return null;
  return Object.freeze({ ...review, ...pair(raw) });
}

// Adapters synchronously load/write one dedicated profile preference. Every
// operation loads it again so another window cannot leave this window stale.
// Keep the most recent bounded set and never persist file bytes or passphrases.
export function createReviewStore({ read, write }) {
  function load() {
    const raw = read();
    if (raw === '' || raw == null) return [];
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.rows) || parsed.rows.length > REVIEW_RECORD_LIMIT) throw new Error('Invalid review records');
    const seen = new Set();
    for (const row of parsed.rows) {
      if (!pairValid(row) || seen.has(row.requestId) || typeof row.boardId !== 'string' || !row.boardId ||
        !Number.isSafeInteger(row.at) || (row.answer !== null && (typeof row.answer !== 'string' || reviewText('answer', row.answer).value !== row.answer))) {
        throw new Error('Invalid review record');
      }
      seen.add(row.requestId);
    }
    return parsed.rows;
  }
  function save(rows) { if (write(JSON.stringify({ version: 1, rows })) === false) throw new Error('Review records unavailable'); }
  return {
    check: () => { load(); },
    issue(boardId, review, at = Date.now()) {
      if (!pairValid(review) || typeof boardId !== 'string' || !boardId) throw new Error('Invalid correlation');
      const rows = load();
      if (rows.some(row => row.requestId === review.requestId)) throw new Error('Duplicate issue');
      save([{ boardId, ...pair(review), at, answer: null }, ...rows].slice(0, REVIEW_RECORD_LIMIT));
    },
    find: review => pairValid(review) ? load().find(row => samePair(row, review)) || null : null,
    accept(boardId, reply) {
      const review = canonicalReview(reply);
      if (review?.kind !== 'reply') return 'unmatched';
      const rows = load();
      const row = rows.find(item => samePair(item, review));
      if (!row || row.boardId !== boardId) return 'unmatched';
      if (row.answer !== null) return 'duplicate';
      row.answer = review.answer;
      save(rows);
      return 'added';
    },
    results: boardId => load().filter(row => row.boardId === boardId && row.answer !== null),
    forgetBoards(boardIds, identify = id => id) {
      const rows = load();
      const kept = rows.filter(row => !boardIds.includes(identify(row.boardId)));
      if (kept.length !== rows.length) save(kept);
    },
    reset: () => save([]),
  };
}

const unavailable = '검토 파일 기능을 사용할 수 없습니다.';
const stale = 'Desk 또는 Board가 바뀌었습니다. 검토 작업을 다시 열어 주세요.';
const storeFailure = '이 프로필의 검토 기록을 확인하거나 저장하지 못했습니다.';
const noMatch = '이 프로필에서 만든 요청과 일치하지 않습니다. 어느 Board에도 추가하지 않습니다.';
const duplicate = '이 요청의 회신은 이미 이 Board에 추가되어 있습니다.';
function exportError(code) {
  if (code === 'PORTABLE_REVIEW_SECRET_LIKE') return '비밀번호·키·토큰처럼 보이는 내용이 있어 파일을 만들지 않았습니다. 해당 내용을 빼고 다시 확인해 주세요.';
  if (code === 'PORTABLE_REVIEW_ENCRYPTION_REQUIRED') return 'Board 질문 코드가 있는 요청은 비어 있지 않은 파일 암호로 잠가 주세요.';
  if (code === 'PORTABLE_REVIEW_INPUT') return '검토 텍스트와 길이를 다시 확인해 주세요.';
  if (code === 'PORTABLE_PASSPHRASE_TOO_SHORT' || code === 'PORTABLE_PASSPHRASE_INVALID') return '파일 암호를 다시 확인해 주세요.';
  return '검토 파일 생성 결과를 확인하지 못했습니다. 다시 만들기 전에 내보내기 폴더를 확인해 주세요.';
}

export function createReviewFlow({ request, pickFile, getContext, isContextCurrent, getBoard, isBoardCurrent, store, onState = () => {}, supported = () => true }) {
  let active = null;
  const view = () => active?.view || null;
  function update(session, delta) {
    if (active !== session) return;
    session.view = Object.freeze({ ...session.view, ...delta });
    onState(session.view);
  }
  function open(step, board = null) {
    if (!supported()) return null;
    close();
    const context = getContext();
    if (!context || !isContextCurrent(context) || (board && !isBoardCurrent(board))) return null;
    active = { context, board, view: null, operation: null, source: null, inspected: null, draft: null };
    update(active, { step, boardTitle: board?.title || null, busy: false, error: null });
    return active;
  }
  function close() {
    if (!active) return;
    const session = active;
    active = null;
    session.operation?.abort();
    onState(null);
  }
  function current(session, extraBoard = null) {
    if (!session || active !== session || session.view?.step === 'stopped') return false;
    if (supported() && isContextCurrent(session.context) && (!session.board || isBoardCurrent(session.board)) &&
      (!extraBoard || isBoardCurrent(extraBoard))) return true;
    const exporting = session.view?.step === 'exporting';
    session.operation?.abort();
    session.source = session.inspected = session.draft = session.board = null;
    session.view = null;
    update(session, { step: 'stopped', busy: false, error: failure(exporting ? 'Desk 또는 Board가 바뀌어 검토 기록을 남기지 않았습니다. 파일은 만들어졌을 수 있으니 내보내기 폴더를 확인해 주세요.' : supported() ? stale : unavailable) });
    return false;
  }
  function begin(session, step) {
    if (!current(session) || session.view.busy) return null;
    const controller = new AbortController();
    session.operation = controller;
    update(session, { step, busy: true, error: null });
    return controller.signal;
  }
  const end = (session, delta) => {
    session.operation = null;
    update(session, { busy: false, ...delta });
  };
  function resetError(session, text, field) { update(session, { error: failure(text, field) }); }
  function openRequest(board) { return board ? open('request-draft', board)?.view || null : null; }
  function previewRequest(values) {
    const s = active;
    if (!current(s) || s.view.step !== 'request-draft') return false;
    const parsed = reviewRequestDraft(values);
    if (parsed.error) { update(s, { error: parsed.error }); return false; }
    s.draft = Object.freeze(parsed.review);
    update(s, { step: 'request-preview', review: s.draft, error: null });
    return true;
  }
  function openFile() { return open('choose')?.view || null; }
  async function chooseFile() {
    const s = active;
    if (!current(s) || s.view.step !== 'choose') return;
    const signal = begin(s, 'choosing');
    if (!signal) return;
    try {
      const picked = await pickFile({ signal });
      if (!current(s)) return;
      if (!picked || picked.cancelled) { end(s, { step: 'choose' }); return; }
      const bytes = copyReviewBytes(picked.bytes);
      if (!bytes) { end(s, { step: 'choose', error: failure('검토 파일은 비어 있지 않아야 하며 최대 256 KiB입니다.') }); return; }
      s.source = { bundle: bytesToBase64(bytes) };
      await inspect(s, '', signal);
    } catch (error) {
      if (current(s)) end(s, { step: 'choose', error: failure(error?.code === 'PORTABLE_FILE_TOO_LARGE' ? '검토 파일은 최대 256 KiB입니다.' : '고른 파일을 열지 못했습니다.') });
    }
  }
  async function inspect(s, passphrase, signal) {
    update(s, { step: 'inspecting' });
    if (signal.aborted || !current(s)) return;
    let response;
    try { response = await request('POST', '/v1/portable/review/inspect', { ...s.source, ...(passphrase ? { passphrase } : {}) }, { signal }); }
    catch { response = null; }
    if (!current(s)) return;
    const body = response?.body;
    if (response?.status === 200 && body?.locked === true && body.encrypted === true) { end(s, { step: 'locked' }); return; }
    const review = response?.status === 200 && body?.locked === false && typeof body.encrypted === 'boolean' ? canonicalReview(body.review) : null;
    if (!review || (review.askCode && !body.encrypted)) {
      const wrongPassword = body?.code === 'PORTABLE_PASSPHRASE_INVALID';
      if (!wrongPassword) s.source = null;
      end(s, { step: wrongPassword ? 'locked' : 'choose', error: failure(wrongPassword ? '암호가 맞지 않거나 파일이 손상되었습니다.' : '검토 요청 또는 회신 파일을 확인하지 못했습니다.', wrongPassword ? 'passphrase' : undefined) });
      return;
    }
    s.source = null;
    s.inspected = review;
    if (review.kind === 'request') { end(s, { step: 'request-inspected', review, encrypted: body.encrypted }); return; }
    let row, target, message;
    try {
      row = store.find(review);
      target = row && getBoard(row.boardId);
      if (!row) message = noMatch;
      else if (!target || !isBoardCurrent(target)) message = '요청을 만든 Board가 지금 열려 있지 않습니다. 원래 Board를 연 뒤 파일을 다시 열어 주세요.';
      else if (row.answer !== null) message = duplicate;
      else s.board = target;
    } catch { message = storeFailure; }
    end(s, { step: 'reply-inspected', review, encrypted: body.encrypted, boardTitle: s.board?.title || null, canReturn: !!s.board, message });
  }
  async function unlock(passphrase) {
    const s = active;
    if (!current(s) || s.view.step !== 'locked' || !s.source) return;
    if (typeof passphrase !== 'string' || !passphrase || passphrase.length > PORTABLE_MAX_PASSPHRASE_CHARS) {
      resetError(s, '파일 암호를 확인해 주세요.', 'passphrase'); return;
    }
    const signal = begin(s, 'inspecting');
    if (signal) await inspect(s, passphrase, signal);
  }
  function beginReply() {
    const s = active;
    if (!current(s) || s.view.step !== 'request-inspected' || s.inspected?.kind !== 'request') return false;
    update(s, { step: 'reply-draft', review: s.inspected, requestReview: s.inspected, error: null });
    return true;
  }
  function beginAgentReply(review, board, { answer, mode, decisionEgress, source }) {
    const s = active;
    if (!current(s, board) || s.view.step !== 'request-inspected' || s.inspected !== review || !s.inspected?.askCode) return false;
    s.board = board;
    const parsed = answer ? reviewReplyDraft(s.inspected, answer) : null;
    const usable = parsed?.review?.answer === answer;
    const answerSource = !answer ? '이 질문에 쓸 관련 공개 발췌문을 찾지 못했습니다. 직접 회신을 쓸 수 있습니다.' :
      !usable ? '결과를 회신에 넣을 수 없습니다. 직접 회신을 써 주세요.' :
      mode === 'draft' ? '전용 OpenAI API로 만든 초안입니다. 내용을 검토하고 내 회신으로 편집해 주세요.' :
      'Board의 관련 공개 발췌문입니다. 생성된 답변이 아닙니다. 내용을 검토하고 내 회신으로 편집해 주세요.';
    update(s, { step: 'reply-draft', review: usable ? parsed.review : s.inspected, requestReview: s.inspected, boardTitle: board.title,
      answerSource: decisionEgress && source !== 'local' ? `${answerSource} 관련성 판단에 별도 Decisions API를 사용했습니다.` : answerSource, error: null });
    return true;
  }
  function previewReply(answer) {
    const s = active;
    if (!current(s) || s.view.step !== 'reply-draft' || s.inspected?.kind !== 'request') return false;
    const parsed = reviewReplyDraft(s.inspected, answer);
    if (parsed.error) { update(s, { error: parsed.error }); return false; }
    s.draft = Object.freeze(parsed.review);
    update(s, { step: 'reply-preview', review: s.draft, error: null });
    return true;
  }
  async function exportFile({ passphrase = '', confirm = '', passwordProtected = passphrase !== '' } = {}) {
    const s = active;
    if (!current(s) || !['request-preview', 'reply-preview'].includes(s.view.step) || !s.draft) return;
    const step = s.view.step, review = s.draft;
    if (review.askCode && !passwordProtected) {
      resetError(s, 'Board 질문 코드가 있는 요청은 파일 암호로 잠가 주세요.', 'passphrase'); return;
    }
    if (passwordProtected) {
      if (typeof passphrase !== 'string' || (review.askCode && !passphrase.trim()) || Array.from(passphrase).length < PORTABLE_MIN_PASSPHRASE_CHARS || passphrase.length > PORTABLE_MAX_PASSPHRASE_CHARS) {
        resetError(s, '암호로 잠그려면 파일 암호를 8자 이상, 최대 1024자까지 입력해 주세요.', 'passphrase'); return;
      }
      if (passphrase !== confirm) { resetError(s, '두 암호가 같지 않습니다.', 'confirm'); return; }
    }
    if (review.kind === 'request') {
      try { store.check(); } catch { resetError(s, storeFailure); return; }
    }
    const signal = begin(s, 'exporting');
    if (!signal || signal.aborted || !current(s)) return;
    let response;
    try { response = await request('POST', '/v1/portable/review/export', { review, ...(passwordProtected ? { passphrase } : {}) }, { signal }); }
    catch { response = null; }
    if (!current(s)) return;
    const body = response?.body;
    const returned = response?.status === 201 ? canonicalReview(body?.review) : null;
    if (!returned || Object.keys(review).some(key => returned[key] !== review[key]) || body.encrypted !== !!passwordProtected) {
      end(s, { step, error: failure(exportError(body?.code)) }); return;
    }
    let warning = null;
    if (review.kind === 'request') {
      try { store.issue(s.board.id, returned); }
      catch { warning = '파일은 만들었지만 이 Board의 로컬 요청 기록을 저장하지 못했습니다. 이 파일의 회신을 Board에 추가할 수 없을 수 있습니다.'; }
    }
    s.draft = s.inspected = null;
    end(s, { step: 'exported', review: null, encrypted: body.encrypted, warning,
      where: typeof body.displayPath === 'string' && body.displayPath.startsWith('~/') ? body.displayPath : null,
      fileName: typeof body.fileName === 'string' ? body.fileName : null });
  }
  function back() {
    const s = active;
    if (!current(s) || s.view.busy) return;
    if (s.view.step === 'request-preview') update(s, { step: 'request-draft', review: s.draft, error: null });
    else if (s.view.step === 'reply-preview') update(s, { step: 'reply-draft', review: s.draft, error: null });
    else if (s.view.step === 'reply-draft') {
      s.board = s.draft = null;
      update(s, { step: 'request-inspected', review: s.inspected, boardTitle: null, answerSource: null, error: null });
    }
    else if (['locked', 'request-inspected', 'reply-inspected'].includes(s.view.step)) {
      s.source = s.inspected = s.board = s.draft = null;
      update(s, { step: 'choose', review: null, error: null, message: null, canReturn: false, boardTitle: null });
    }
  }
  function confirmReturn() {
    const s = active;
    if (!current(s) || s.view.step !== 'reply-inspected' || !s.view.canReturn || s.inspected?.kind !== 'reply' || !s.board) return false;
    try {
      const row = store.find(s.inspected);
      const board = row && getBoard(row.boardId);
      if (!board || board.id !== s.board.id || !current(s, board)) {
        update(s, { canReturn: false, message: noMatch }); return false;
      }
      const result = store.accept(s.board.id, s.inspected);
      update(s, { step: result === 'added' ? 'returned' : 'reply-inspected', canReturn: false,
        message: result === 'duplicate' ? duplicate : result === 'unmatched' ? noMatch : null });
      return result === 'added';
    } catch { resetError(s, storeFailure); return false; }
  }
  function openResults(board) {
    const s = board && open('results', board);
    if (!s) return null;
    try { update(s, { results: store.results(board.id).map(row => ({ at: row.at, answer: row.answer })) }); }
    catch { resetError(s, storeFailure); }
    return s.view;
  }
  return { view, snapshot: view, openRequest, previewRequest, openFile, chooseFile, unlock, beginReply, beginAgentReply, previewReply,
    exportFile, back, confirmReturn, openResults, close, invalidate: () => { if (active) current(active); } };
}

export const REVIEW_AUTH_NOTE = '받는 사람은 이름이나 역할 표기일 뿐입니다. 파일은 전달될 수 있으며, Board 접근 권한을 주거나 작성자를 확인하지 않습니다.';
const REVIEW_MANUAL_NOTE = '파일은 이 기기에만 만듭니다. 자동으로 전달하거나 읽음 여부를 확인하지 않습니다.';
const REVIEW_PLAIN_NOTE = '암호 없이 만들면 파일을 가진 누구나 내용을 볼 수 있습니다.';

// Rendering uses text nodes only, including angle brackets, markup, and line breaks.
export function reviewDialogContent(el, view, flow, { typed = {}, onClose = flow.close, reveal = () => {}, askCodeEnabled = false, onBoardAgentAsk = null } = {}) {
  const { step, review, busy, error } = view;
  const action = (id, label, run, primary = false) => el('button', { type: 'button',
    class: primary ? 'egd-store-primary' : null, data: { testid: `review-${id}`, focusKey: id }, onclick: run }, label);
  const note = (text, kind = 'copy') => el('p', { class: kind === 'warning' ? 'egd-portable-warning' : 'egd-store-panel-copy' }, text);
  const status = text => el('p', { role: 'status', class: 'egd-store-panel-status' }, text);
  const previewText = (field, value) => el('div', { class: 'egd-review-value', data: { testid: `review-value-${field}` }, dir: 'auto' }, value);
  const preview = (value, fields) => el('dl', { class: 'egd-review-preview', 'aria-label': '파일에 담긴 텍스트' }, ...fields.map(field =>
    el('div', {}, el('dt', {}, REVIEW_LABELS[field]), el('dd', {}, previewText(field, value[field])))));
  const buttons = (...children) => el('div', { class: 'egd-review-actions' }, ...children);
  const back = () => action('back', '뒤로', () => flow.back());
  const form = (fields, label, submitId, read, initial = {}, exportOptions = false) => {
    const inputs = {};
    const labels = fields.map(field => {
      const password = ['passphrase', 'confirm', 'askCode'].includes(field);
      const multiline = !password && field !== 'recipient';
      const caption = field === 'passphrase' ? '파일 암호' : field === 'confirm' ? '파일 암호 다시 입력' :
        `${REVIEW_LABELS[field]}${['excerpt', 'askCode'].includes(field) ? ' (선택)' : ''}`;
      const input = el(multiline ? 'textarea' : 'input', {
        class: 'egd-portable-input', type: multiline ? null : (password ? 'password' : 'text'),
        rows: multiline ? (field === 'excerpt' || field === 'answer' ? 4 : 2) : null,
        maxlength: password && field !== 'askCode' ? PORTABLE_MAX_PASSPHRASE_CHARS : REVIEW_FIELDS[field],
        autocomplete: 'off', spellcheck: password ? 'false' : null,
        'aria-invalid': error?.field === field ? 'true' : null,
        data: { field, testid: `review-${field}`, focusKey: field },
      });
      input.value = (field === 'passphrase' || field === 'confirm' ? '' : typed[field] ?? initial[field]) || '';
      inputs[field] = input;
      return el('label', { class: 'egd-portable-field' }, el('span', { class: 'egd-portable-field-label' }, caption), input);
    });
    let lock, passwordFields, plainWarning;
    if (exportOptions) {
      passwordFields = el('div', { id: 'egd-review-password-fields', class: 'egd-review-password-fields' }, ...labels);
      plainWarning = note(REVIEW_PLAIN_NOTE, 'warning');
      lock = el('input', { type: 'checkbox', 'aria-controls': 'egd-review-password-fields',
        data: { field: 'passwordProtected', testid: 'review-password-mode', focusKey: 'passwordProtected' },
        onchange: () => {
          passwordFields.hidden = !lock.checked;
          plainWarning.hidden = lock.checked;
          if (!lock.checked) inputs.passphrase.value = inputs.confirm.value = '';
        } });
      lock.checked = review.askCode ? true : typed.passwordProtected === true;
      lock.disabled = !!review.askCode;
      passwordFields.hidden = !lock.checked;
      plainWarning.hidden = lock.checked;
    }
    return el('form', { class: 'egd-review-form', onsubmit: ev => {
      ev.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
      read(lock ? (lock.checked ? { ...values, passwordProtected: true } : { passwordProtected: false }) : values);
    } }, ...(lock ? [el('label', { class: 'egd-review-password-mode' }, lock, review.askCode ? '질문 코드가 있는 파일은 반드시 암호로 잠급니다' : '암호로 잠그기'), plainWarning, passwordFields] : labels),
    buttons(step !== 'request-draft' ? back() : null,
      el('button', { type: 'submit', class: 'egd-store-primary', data: { testid: `review-${submitId}`, focusKey: submitId } }, label)));
  };
  let title = '검토 파일 열기';
  let content = [];
  if (step === 'request-draft') {
    title = '검토 요청 만들기';
    content = [note('직접 입력한 공유 가능한 텍스트만 담습니다. Board, 카드, 페이지, 원본 파일은 읽거나 복사하지 않습니다. 비밀번호·키·토큰을 넣지 마세요.'),
      note(REVIEW_AUTH_NOTE), askCodeEnabled ? note('Board 소유자가 별도로 공유한 일회용 코드가 있을 때만 넣으세요. 코드가 있는 요청은 반드시 암호로 잠급니다.') : null,
      form(askCodeEnabled ? [...requestFields, 'askCode'] : requestFields, '요청 미리보기', 'preview', values => flow.previewRequest(values), review || {})];
  } else if (step === 'request-preview' || step === 'reply-preview') {
    const request = step === 'request-preview';
    title = request ? '검토 요청 미리보기' : '검토 회신 미리보기';
    content = [preview(review, request ? requestFields : ['answer']), note(REVIEW_MANUAL_NOTE),
      review.askCode ? note('이 요청에는 일회용 Board 질문 코드가 들어 있습니다. 요청 파일과 파일 암호는 별도로 보내세요.', 'warning') : null,
      form(['passphrase', 'confirm'], request ? '요청 파일 만들기' : '회신 파일 만들기', 'export', values => void flow.exportFile(values), {}, true)];
  } else if (step === 'choose') {
    content = [note('직접 받은 .egdesk 검토 요청 또는 회신 파일을 엽니다. 미리보기만으로는 어느 Board도 바뀌지 않습니다.'),
      buttons(action('choose', '검토 파일 선택…', () => void flow.chooseFile(), true))];
  } else if (step === 'locked') {
    title = '암호로 잠긴 EG-Desk 파일';
    content = [note('암호를 입력해야 검토 요청 또는 회신 파일인지 확인할 수 있습니다.'),
      form(['passphrase'], '내용 미리보기', 'unlock', values => void flow.unlock(values.passphrase))];
  } else if (step === 'request-inspected' || step === 'reply-draft') {
    title = step === 'reply-draft' ? '검토 회신 작성' : '검토 요청 내용';
    const writing = step === 'reply-draft';
    content = [note(REVIEW_AUTH_NOTE), preview(writing && review.kind === 'reply' ? view.requestReview : review, requestFields),
      (writing ? view.requestReview : review)?.askCode ? note('일회용 Board 질문 코드가 들어 있습니다. 코드는 요청자의 신원을 확인하지 않습니다.') : null,
      writing && view.answerSource ? note(`‘${view.boardTitle}’ Board · ${view.answerSource}`) : null,
      !writing && review.askCode && askCodeEnabled && !onBoardAgentAsk ? note('Agent로 답변하려면 이 기기에서 설정한 Board를 활성화한 뒤 이 파일을 다시 열어 주세요. 지금은 직접 회신을 쓸 수 있습니다.') : null, writing
      ? form(['answer'], '회신 미리보기', 'preview', values => flow.previewReply(values.answer), review.kind === 'reply' ? review : {})
      : buttons(back(), action('reply', '회신 쓰기…', () => flow.beginReply(), true),
        onBoardAgentAsk ? action('board-agent-ask', '이 Board의 Agent로 답변 준비…', onBoardAgentAsk) : null)];
  } else if (step === 'reply-inspected') {
    title = '검토 회신 내용';
    content = [preview(review, ['answer']), note('파일만으로는 작성자를 확인할 수 없습니다.'), view.message ? status(view.message) : null,
      view.canReturn ? note(`이 요청을 만든 ‘${view.boardTitle}’ Board에만 회신 내용을 로컬 기록으로 남깁니다. 카드나 원본은 바뀌지 않습니다.`) : null,
      view.canReturn && view.encrypted ? note('추가하면 회신 내용이 이 Firefox 프로필에 평문으로 저장됩니다. 파일 암호는 이 로컬 기록을 보호하지 않습니다. 원하지 않으면 뒤로 가거나 창을 닫으세요.', 'warning') : null,
      buttons(back(), view.canReturn ? action('return', '원래 Board에 회신 추가', () => flow.confirmReturn(), true) : null)];
  } else if (step === 'returned') {
    title = '이 Board에 회신 추가됨';
    content = [status(`‘${view.boardTitle}’ Board에 회신 내용을 로컬로 추가했습니다. Board ⋯ → 검토 회신 기록에서 다시 볼 수 있습니다.`),
      preview(review, ['answer'])];
  } else if (step === 'exported') {
    title = '검토 파일을 만들었습니다';
    content = [status('이 기기에 파일을 만들었습니다. 아직 전달하지 않았습니다.'),
      (view.where || view.fileName) ? el('strong', { class: 'egd-portable-where', dir: 'auto' }, view.where || view.fileName) : null,
      note(view.encrypted ? '암호로 잠긴 파일입니다. 암호는 파일과 별도로 공유하세요.' : REVIEW_PLAIN_NOTE, view.encrypted ? 'copy' : 'warning'),
      view.warning ? note(view.warning, 'warning') : null,
      view.where ? buttons(action('reveal', '폴더에서 보기', () => reveal(view.where))) : null];
  } else if (step === 'results') {
    title = '검토 회신 기록';
    content = [note(`‘${view.boardTitle}’ Board에 추가한 이 프로필의 회신입니다. 최근 요청 ${REVIEW_RECORD_LIMIT}개의 기록만 보관합니다.`),
      !view.results?.length ? status('추가된 회신이 없습니다.') : el('ol', { class: 'egd-review-results' }, ...view.results.map(({ at, answer }) =>
        el('li', {}, el('time', {}, new Date(at).toLocaleString('ko-KR')), previewText('answer', answer))))];
  } else if (busy) {
    title = step === 'exporting' ? '검토 파일 만들기' : '검토 파일 열기';
    content = [status(step === 'exporting' ? '이 기기에 파일을 만드는 중…' : '파일을 확인하는 중…')];
  } else if (step === 'stopped') title = '검토 작업 중단됨';
  return { title, children: [el('header', { class: 'egd-store-panel-head' }, el('strong', {}, title),
    el('button', { type: 'button', class: 'egd-store-panel-close', disabled: step === 'exporting',
      'aria-label': busy ? '검토 작업 취소' : '검토 창 닫기', data: { testid: 'review-close', focusKey: 'close' }, onclick: onClose }, '×')),
  view.boardTitle && ['request-draft', 'request-preview'].includes(step) ? note(`요청을 기록할 Board: ${view.boardTitle}`) : null,
  error ? el('p', { role: 'alert', class: 'egd-store-panel-status egd-portable-error', data: { testid: 'review-error' } }, error.text) : null,
  ...content].filter(Boolean) };
}
