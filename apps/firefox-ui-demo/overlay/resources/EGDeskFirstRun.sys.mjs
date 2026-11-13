// First run: the visible way from the first Browser to the Desk, and the one
// quiet connection line after the first Desk entry. Decisions only; the surface
// (eg-desk-surface.uc.js) owns the DOM and the start page owns its own button.

// The start page (egdesk-start.html) is an EG-Desk chrome page, so it loads in
// the parent process and its DOM events reach the surface window. Web pages
// load in content processes and their events never do; the document address is
// checked as well.
export const START_PAGE_READY_EVENT = 'egdesk-start-ready';
export const START_PAGE_DESK_EVENT = 'egdesk-start-desk';
export const START_PAGE_ENTRY_ATTRIBUTE = 'data-desk-entry';

export function startPageEventDocument(event, startUri) {
  const target = event?.target;
  const doc = target?.nodeType === 9 ? target : target?.ownerDocument;
  return startUri && doc && doc.documentURI === startUri ? doc : null;
}

// 'available' only for the first Browser while it still fills the window.
export function startPageDeskEntry({ initialBrowserFocus, browserCardId, cardId } = {}) {
  return initialBrowserFocus === true && !!cardId && cardId === browserCardId ? 'available' : '';
}

// 연결 필요 / 연결 중 / 연결됨 / 확인 필요. Before the bridge has answered the
// boot default says 'not logged in', which is not a verdict: 'unknown'.
export function codexConnectionState(codex) {
  if (codex?.connected !== true) return 'unknown';
  const auth = codex.authStatus || {};
  const access = auth.access?.state;
  if (access === 'authFailed') return 'check';
  if (auth.isLoggedIn) return 'connected';
  if (codex.isStartingLogin || auth.loginInProgress || access === 'loginInProgress') return 'connecting';
  return 'needed';
}

const NOTICE_BY_STATE = Object.freeze({
  needed: Object.freeze({ state: 'needed', text: 'Codex 연결 필요', action: 'login', actionLabel: '로그인' }),
  connecting: Object.freeze({ state: 'connecting', text: 'Codex 연결 중…', action: null, actionLabel: '' }),
  check: Object.freeze({ state: 'check', text: 'Codex 연결 확인 필요', action: 'settings', actionLabel: '계정 설정' }),
});

// One line under the top bar after the first Desk entry. Never a window.
export function firstEntryConnectionNotice({ entered = false, closed = false, codex = null } = {}) {
  if (!entered || closed) return null;
  const view = NOTICE_BY_STATE[codexConnectionState(codex)];
  return view ? { ...view } : null;
}

// The Desk could not start: the three next steps instead of an empty screen.
// The diagnostic text is what [진단 정보 복사] puts on the clipboard. It carries
// the error and where it was thrown, nothing from the user's Desk.
export function startFailureView(error) {
  const message = String(error?.message || (typeof error === 'string' ? error : '')).trim().slice(0, 400) || '원인을 알 수 없습니다';
  const stack = String(error?.stack || '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 12);
  return {
    title: 'EG-Desk를 시작하지 못했습니다',
    body: '다시 시도해도 같으면 진단 정보를 복사해 문의할 때 붙여 주세요.',
    actions: [
      { id: 'retry', label: '다시 시도', title: 'EG-Desk를 다시 시작합니다', primary: true },
      { id: 'diagnostics', label: '진단 정보 복사', title: '오류 내용을 클립보드에 복사합니다', primary: false },
      { id: 'quit', label: '종료', title: 'EG-Desk를 끝냅니다', primary: false },
    ],
    copied: '진단 정보를 복사했습니다.',
    copyFailed: '진단 정보를 복사하지 못했습니다.',
    diagnostics: ['EG-Desk 시작 실패', message, ...stack].join('\n'),
  };
}

// Connected: the line has nothing left to say and stops listening.
export function firstEntryConnectionSettled(codex) {
  return codexConnectionState(codex) === 'connected';
}
