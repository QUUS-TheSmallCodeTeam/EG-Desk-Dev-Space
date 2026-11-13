// BRW-01 · UX-03: what the Browser window's own bar says and which keys it
// takes. Pure view model — the surface (eg-desk-surface.uc.js) owns the DOM.
//
// The security *kind* is a stable key ('secure' | 'insecure' | 'local' |
// 'internal' | 'site'); the Korean text and the icon are looked up from it, so
// no code compares display text.

export const BROWSER_LOADING_LABEL = '불러오는 중';

const SECURITY_LABELS = Object.freeze({
  secure: '보안 연결',
  insecure: '보안되지 않음',
  local: '이 PC',
  internal: 'Firefox',
  site: '사이트',
});

const SECURITY_ICONS = Object.freeze({ secure: 'lock', insecure: 'alert', local: 'file', internal: 'browser', site: 'browser' });

/** 'secure' | 'insecure' | 'local' | 'internal' | 'site' for an address. */
export function browserSecurityKind(url) {
  let protocol = '';
  try { protocol = new URL(String(url || '')).protocol; } catch { return 'site'; }
  if (protocol === 'https:') return 'secure';
  if (protocol === 'http:') return 'insecure';
  if (protocol === 'file:') return 'local';
  if (protocol === 'about:') return 'internal';
  return 'site';
}

export function browserSecurityLabel(kind) {
  return SECURITY_LABELS[kind] || SECURITY_LABELS.site;
}

export function browserSecurityIconName(kind) {
  return SECURITY_ICONS[kind] || SECURITY_ICONS.site;
}

/** The short status beside the page title. */
export function browserStatusText({ loading = false, security = 'site' } = {}) {
  return loading ? BROWSER_LOADING_LABEL : browserSecurityLabel(security);
}

/**
 * Name (aria-label), tooltip and off state of one toolbar button. A turned-off
 * button says why in its tooltip; its name stays the same.
 */
export function browserNavButtonState(action, { canGoBack = false, canGoForward = false, loading = false } = {}) {
  switch (action) {
    case 'back': return { label: '뒤로', title: canGoBack ? '뒤로' : '뒤로 갈 페이지 없음', disabled: !canGoBack };
    case 'forward': return { label: '앞으로', title: canGoForward ? '앞으로' : '앞으로 갈 페이지 없음', disabled: !canGoForward };
    case 'reload': return loading ? { label: '중지', title: '중지', disabled: false } : { label: '새로고침', title: '새로고침', disabled: false };
    case 'home': return { label: '홈', title: '홈', disabled: false };
    case 'duplicate': return { label: '복제', title: '복제', disabled: false };
    case 'menu': return { label: '더보기', title: '더보기', disabled: false };
    default: return null;
  }
}

/**
 * 'focus-address' (⌘/Ctrl+L) | 'new-browser' (⌘/Ctrl+T) | null.
 * Only the platform accelerator alone counts, and only while the active Desk
 * window is a Browser that holds the focus — every other case leaves the key
 * to whoever had it (a terminal's Ctrl+L, a text field, Firefox itself).
 */
export function browserShortcutIntent(event, {
  isMac = false, activeIsBrowser = false, focusInActiveBrowser = false, canOpenWindow = true,
} = {}) {
  if (!event || !activeIsBrowser || !focusInActiveBrowser) return null;
  const accelerator = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!accelerator || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229 || event.repeat) return null;
  const letter = String(event.key || '').toLowerCase();
  if (event.code === 'KeyL' || letter === 'l') return 'focus-address';
  // A maximized window covers the Desk: a new window would open unseen behind it.
  if (event.code === 'KeyT' || letter === 't') return canOpenWindow ? 'new-browser' : null;
  return null;
}
