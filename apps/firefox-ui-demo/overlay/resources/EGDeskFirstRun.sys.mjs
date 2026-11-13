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

// Connected: the line has nothing left to say and stops listening.
export function firstEntryConnectionSettled(codex) {
  return codexConnectionState(codex) === 'connected';
}
