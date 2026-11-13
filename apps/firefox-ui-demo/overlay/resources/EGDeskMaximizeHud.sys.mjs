// EGDeskMaximizeHud — pure rules for what happens to Chat (the HUD) and the top
// bar badge while one View is shown large.
//
// Two presentation modes (VIEWPORT_LAYOUT_INTERACTION_MODEL.md, Card Presentation
// Modes): 'maximized' keeps the top bar and Dock; 'focus' hides all Desk chrome
// and leaves only an exit button. While maximized the HUD is one of
//   hidden  — default, the View uses the safe area as if Chat were closed
//   peek    — Chat overlays the View, the View is not resized
//   pinned  — explicit; Chat sits beside the View and the View is refitted
// (same document, HUD Visibility While Maximized; ledger D-V6: right edge dwell).
//
// No DOM, no timers: the surface owns those and asks this module what to do.

export const MAXIMIZE_HUD_EDGE_PX = 8;
export const MAXIMIZE_HUD_PEEK_OPEN_DELAY_MS = 300;
export const MAXIMIZE_HUD_PEEK_CLOSE_GRACE_MS = 400;
export const MAXIMIZE_HUD_PEEK_SLACK_PX = 24;

const MODE_COPY = { maximized: '크게 보는 중', focus: '집중 보기' };

// The rail label helper still answers a few View types in English; the badge
// is user-facing copy, so those read the way the Dock names them.
const TYPE_LABEL_KO = { Terminal: '터미널', Settings: '설정', Card: '창' };

// The badge sits in the top bar beside the Board name: a long View name is cut
// here (not by CSS) so the state words after it are never the part that is lost.
export const MAXIMIZE_BADGE_NAME_MAX = 18;

function shortBadgeName(name) {
  const chars = Array.from(name);
  return chars.length <= MAXIMIZE_BADGE_NAME_MAX ? name : `${chars.slice(0, MAXIMIZE_BADGE_NAME_MAX).join('').trimEnd()}…`;
}

export function presentationBadge(label, mode) {
  const raw = String(label || '').replace(/\s+/g, ' ').trim();
  const name = TYPE_LABEL_KO[raw] || raw || '창';
  const focus = mode === 'focus';
  return {
    text: `${shortBadgeName(name)} · ${focus ? MODE_COPY.focus : MODE_COPY.maximized}`,
    title: `${name} 창을 ${focus ? '집중 보기 중' : '크게 보는 중'} — 누르면 원래 크기로 돌아갑니다`,
  };
}

function settle(mode, hudMode, peekSource) {
  return { mode, hudMode, peekSource: hudMode === 'peek' ? peekSource : null, avoidHud: hudMode === 'pinned' };
}

// event: 'edge-dwell' | 'dock-open' | 'pin-toggle' | 'pointer-leave' | 'dismiss'
//        | 'hud-closed' | 'enter-focus'
export function nextHudState(current, event) {
  const mode = current?.mode === 'focus' ? 'focus' : 'maximized';
  const hudMode = ['peek', 'pinned'].includes(current?.hudMode) ? current.hudMode : 'hidden';
  const peekSource = hudMode === 'peek' ? (current?.peekSource === 'dock' ? 'dock' : 'edge') : null;
  if (mode === 'focus' || event === 'enter-focus' || event === 'hud-closed') return settle(mode, 'hidden', null);
  switch (event) {
    case 'edge-dwell':
      return hudMode === 'hidden' ? settle(mode, 'peek', 'edge') : settle(mode, hudMode, peekSource);
    case 'dock-open':
      return hudMode === 'pinned' ? settle(mode, 'pinned', null) : settle(mode, 'peek', 'dock');
    case 'pin-toggle':
      if (hudMode === 'peek') return settle(mode, 'pinned', null);
      if (hudMode === 'pinned') return settle(mode, 'peek', 'dock');
      return settle(mode, 'hidden', null);
    case 'pointer-leave':
      return hudMode === 'peek' && peekSource === 'edge' ? settle(mode, 'hidden', null) : settle(mode, hudMode, peekSource);
    case 'dismiss':
      return hudMode === 'peek' ? settle(mode, 'hidden', null) : settle(mode, hudMode, peekSource);
    default:
      return settle(mode, hudMode, peekSource);
  }
}

// A Chat the user opened on purpose (Dock button, edge click, pin) stays open
// after returning to the original size; a hover peek does not.
export function hudKeptOnRestore(hudState) {
  return hudState?.hudMode === 'pinned' || (hudState?.hudMode === 'peek' && hudState?.peekSource === 'dock');
}

export function peekClosesOnPointerLeave(hudState) {
  return hudState?.hudMode === 'peek' && hudState?.peekSource !== 'dock';
}

// The peek stays while the pointer is over Chat, within a small slack around
// it, or in the gutter between Chat and the right edge that opened it.
export function pointerInsidePeekZone(point, hudRect, slack = MAXIMIZE_HUD_PEEK_SLACK_PX) {
  if (!point || !hudRect) return false;
  if (![point.x, point.y, hudRect.left, hudRect.top, hudRect.bottom].every(Number.isFinite)) return false;
  return point.x >= hudRect.left - slack && point.y >= hudRect.top - slack && point.y <= hudRect.bottom + slack;
}

export function pinControlCopy(hudMode) {
  return hudMode === 'pinned'
    ? { label: '고정 해제', title: '고정 해제 — 채팅이 창 위로 겹쳐 보입니다', pressed: true }
    : { label: '고정', title: '채팅을 옆에 고정 — 크게 보는 창이 그만큼 좁아집니다', pressed: false };
}
