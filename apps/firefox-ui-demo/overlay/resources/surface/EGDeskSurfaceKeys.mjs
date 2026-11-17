// EG-Desk keyboard rules for the Desk surface (DSN-04 · UX-05 · UX-06).
// Pure: no DOM, no storage, no imports. The screen file
// (overlay/JS/eg-desk-surface.uc.js) owns the listeners and passes plain
// values in. Loaded with ChromeUtils.importESModule(url) (pure, one shared copy).
//
// What lives here:
//  - the one Escape layer registry: every layer the screen registers is named
//    here with its close tier, so the order is written down once
//    (작은 메뉴 → 확인창 → 검색 결과·Board 목록·기록 패널·미니맵 →
//     크게 띄운 창 위 Chat → 원래 크기), and a test can check the screen
//    registers exactly these;
//  - Escape for the 집중 보기 (focus view) and the peeked / pinned Chat;
//  - roving tabindex: one Tab stop per toolbar, Dock group or window title
//    bar, arrows move inside it;
//  - the name tooltip shown on keyboard focus;
//  - moving a window from its focused header with the arrow keys on the 24px
//    grid (D-V5) and Shift+Space to add or remove it from the selection;
//  - Briefing target and Agent-working windows listed first.

// ---------------------------------------------------------------------------
// Escape layer registry (UX-06)

// Tier order, first closes first. Same tiers as EGDeskLayerStack.ESCAPE_ORDER.
export const ESCAPE_TIERS = Object.freeze(['menu', 'confirm', 'panel', 'peek', 'fullscreen']);

// kind: the EGDeskLayerStack kind the layer registers with (escapeRank maps it
// to its tier). Inside one tier the stack closes the newest registration first,
// so standing panels are listed here in their registration order.
export const ESCAPE_LAYER_REGISTRY = Object.freeze([
  { id: 'chat-menu', kind: 'menu', label: 'Chat 메뉴' },
  { id: 'settings-account-menu', kind: 'menu', label: '설정 계정 메뉴' },
  { id: 'board-menu', kind: 'menu', label: 'Board 메뉴 · 창 Board 메뉴' },
  { id: 'desk-menu', kind: 'menu', label: 'Desk 메뉴' },
  { id: 'placement-menu', kind: 'menu', label: '배치 메뉴' },
  { id: 'memo-relink', kind: 'popover', label: '메모 다시 연결' },
  { id: 'minimap-stack', kind: 'list', label: '미니맵 겹친 목록' },
  { id: 'board-close-guard', kind: 'confirm', label: 'Board 닫기 확인' },
  { id: 'placement-dialog', kind: 'dialog', label: '이동·크기 입력' },
  { id: 'minimap', kind: 'minimap', label: '미니맵' },
  { id: 'desk-history', kind: 'panel', label: 'Desk 기록' },
  { id: 'board-history', kind: 'panel', label: 'Board 기록' },
  { id: 'board-switcher', kind: 'panel', label: 'Board 목록' },
  { id: 'rail-search', kind: 'search', label: '검색 결과' },
  { id: 'chat-peek', kind: 'peek', label: '크게 띄운 창 위 Chat' },
  { id: 'focus-view', kind: 'focus', label: '집중 보기' },
  { id: 'view-fullscreen', kind: 'fullscreen', label: '크게 보기' },
].map(Object.freeze));

const KIND_TIER = Object.freeze({
  menu: 'menu', list: 'menu', popover: 'menu', tooltip: 'menu',
  confirm: 'confirm', dialog: 'confirm', modal: 'confirm',
  panel: 'panel', search: 'panel', minimap: 'panel', briefing: 'panel',
  peek: 'peek',
  fullscreen: 'fullscreen', focus: 'fullscreen',
});

export function escapeTierOf(kind) {
  return typeof kind === 'string' && Object.hasOwn(KIND_TIER, kind) ? KIND_TIER[kind] : 'panel';
}

export function escapeLayerSpec(id) {
  return ESCAPE_LAYER_REGISTRY.find(layer => layer.id === id) || null;
}

// The screen registers a layer with its id and kind; both must match the
// registry. Returns the spec, or throws so a typo shows up at boot and in tests.
export function registeredEscapeLayer(id, kind) {
  const spec = escapeLayerSpec(id);
  if (!spec) throw new Error(`Escape layer '${id}' is not in ESCAPE_LAYER_REGISTRY`);
  if (kind != null && kind !== spec.kind) throw new Error(`Escape layer '${id}' is ${spec.kind}, not ${kind}`);
  return spec;
}

// ids registered by the screen vs. the registry: what is missing or unknown.
export function escapeRegistryGaps(ids = []) {
  const seen = new Set(Array.isArray(ids) ? ids : []);
  return {
    missing: ESCAPE_LAYER_REGISTRY.filter(layer => !seen.has(layer.id)).map(layer => layer.id),
    unknown: [...seen].filter(id => !escapeLayerSpec(id)),
  };
}

// Registry ids in the order one Escape after another would close them when
// all are open (tier first; inside a tier the later registration first).
export function escapeCloseOrder(ids = ESCAPE_LAYER_REGISTRY.map(layer => layer.id)) {
  const index = new Map(ESCAPE_LAYER_REGISTRY.map((layer, i) => [layer.id, i]));
  return ids.filter(id => index.has(id)).sort((a, b) => {
    const ta = ESCAPE_TIERS.indexOf(escapeTierOf(escapeLayerSpec(a).kind));
    const tb = ESCAPE_TIERS.indexOf(escapeTierOf(escapeLayerSpec(b).kind));
    return ta - tb || index.get(b) - index.get(a);
  });
}

// The Chat over a fullscreen View (UX-06, D-V6). Only a peek lies over the
// window: Escape closes it. A pinned Chat sits beside the window by the user's
// choice and is not "on top", so Escape passes on (the window goes back to its
// size and the pinned Chat stays open, as hudKeptOnRestore says).
export function chatPeekEscapeOpen({ fullscreen = false, mode = 'maximized', hudMode = 'hidden' } = {}) {
  return !!fullscreen && mode !== 'focus' && hudMode === 'peek';
}

// 집중 보기 uses the whole screen, usually with a page focused inside it. The
// usual route leaves an Escape inside a page to the page. For the focus view
// the screen also listens after the page (bubble from the <browser>): when the
// page did not use the key and nothing else is open above, Escape ends the
// focus view, the way Escape leaves a browser's full screen. The first-run
// Browser focus screen is left through its own button and never by Escape.
export function focusViewEscapeRoute({
  key, composing = false, defaultPrevented = false, repeat = false,
  mode = null, initialBrowserFocus = false, topKind = null,
} = {}) {
  const no = reason => ({ act: false, reason });
  if (key !== 'Escape') return no('not-escape');
  if (mode !== 'focus') return no('not-focus-view');
  if (initialBrowserFocus) return no('first-run-focus');
  if (composing) return no('composing');
  if (defaultPrevented) return no('already-handled');
  if (repeat) return no('held');
  if (topKind != null && topKind !== 'focus') return no('layer-above');
  return { act: true, reason: 'focus-view' };
}

// ---------------------------------------------------------------------------
// Roving tabindex (DSN-04)

// Which item of a group keeps tabindex 0: the focused one, else the last one
// focused, else the first usable one. -1 when none is usable.
export function rovingStop({ count = 0, focused = -1, lastFocused = -1, isSkipped = () => false } = {}) {
  const ok = i => Number.isInteger(i) && i >= 0 && i < count && !isSkipped(i);
  if (ok(focused)) return focused;
  if (ok(lastFocused)) return lastFocused;
  for (let i = 0; i < count; i++) if (ok(i)) return i;
  return -1;
}

// tabindex values for the group: 0 on the stop, -1 everywhere else.
export function rovingTabIndexes(options = {}) {
  const stop = rovingStop(options);
  return Array.from({ length: Math.max(0, options.count || 0) }, (_, i) => (i === stop ? 0 : -1));
}

// Next index for an arrow key inside a one-row group (wraps at both ends).
// Left/Up go back, Right/Down go on, Home/End jump. null for other keys.
export function rovingNextIndex(key, { count = 0, current = -1, isSkipped = () => false, loop = true } = {}) {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[key];
  if (!count) return null;
  if (key === 'Home' || key === 'End') {
    const forward = key === 'Home';
    for (let n = 0; n < count; n++) {
      const i = forward ? n : count - 1 - n;
      if (!isSkipped(i)) return i;
    }
    return null;
  }
  if (!step) return null;
  let i = current;
  for (let n = 0; n < count; n++) {
    i += step;
    if (i < 0 || i >= count) {
      if (!loop) return current;
      i = (i + count) % count;
    }
    if (!isSkipped(i)) return i;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Keyboard name tooltip (DSN-04)

// The name shown when a control gets keyboard focus: its aria-label, else the
// part of its title before ' — ' (the rest is the longer hover help), else
// its own text. '' when there is nothing to say.
export function keyboardTooltipText({ ariaLabel = '', title = '', text = '', max = 80 } = {}) {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const name = clean(ariaLabel) || clean(String(title ?? '').split(' — ')[0]) || clean(text);
  if (!name) return '';
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

// A tooltip whose text equals what the control already shows adds nothing.
export function keyboardTooltipNeeded({ name = '', visibleText = '' } = {}) {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  return !!clean(name) && clean(name) !== clean(visibleText);
}

// Where the tooltip goes: under the control, or above it when the control is
// in the lower part of the screen (the Dock). Kept inside the viewport.
export function keyboardTooltipPosition(anchor, size, viewport, { gap = 6, margin = 4 } = {}) {
  const w = Math.max(0, size?.width || 0), h = Math.max(0, size?.height || 0);
  const vw = Math.max(0, viewport?.width || 0), vh = Math.max(0, viewport?.height || 0);
  const below = (anchor.top + anchor.height / 2) < vh / 2;
  const top = below ? anchor.top + anchor.height + gap : anchor.top - gap - h;
  const left = anchor.left + anchor.width / 2 - w / 2;
  const clampTo = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  return {
    side: below ? 'below' : 'above',
    left: Math.round(clampTo(left, margin, vw - w - margin)),
    top: Math.round(clampTo(top, margin, vh - h - margin)),
  };
}

// ---------------------------------------------------------------------------
// Window header keys (UX-05, D-V5)

export const WINDOW_KEY_GRID_PX = 24;
// Shift moves five grid cells at a time; Option/Alt releases the grid (D-V5
// "Option/Alt로 해제") and moves one pixel for fine placement.
export const WINDOW_KEY_LARGE_CELLS = 5;
export const WINDOW_KEY_FREE_PX = 1;

const ARROWS = Object.freeze({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] });

// What a key on a focused window header does:
//   { type: 'move', dx, dy, shift, free }  arrow keys,
//   { type: 'select-toggle' }              Shift+Space (keyboard Shift-click),
//   null                                   anything else (left alone).
// ⌘/Ctrl combinations belong to undo/redo and app shortcuts, never here.
export function windowHeaderKeyAction({ key, shiftKey = false, altKey = false, metaKey = false, ctrlKey = false, isComposing = false, keyCode = 0 } = {}) {
  if (isComposing || keyCode === 229 || metaKey || ctrlKey) return null;
  const arrow = ARROWS[key];
  if (arrow) return { type: 'move', dx: arrow[0], dy: arrow[1], shift: !!shiftKey, free: !!altKey };
  if ((key === ' ' || key === 'Spacebar') && shiftKey && !altKey) return { type: 'select-toggle' };
  return null;
}

// One axis: with the grid on, a step lands on the next grid line in that
// direction (an off-grid window first snaps to the line it is moving toward).
function stepAxis(value, dir, { cells, grid, snap }) {
  if (!dir) return value;
  if (!snap) return value + dir * cells * grid;
  const near = Math.round(value / grid) * grid;
  if (Math.abs(near - value) < 1e-6) return near + dir * cells * grid;
  // Off-grid: the snap to the line ahead counts as the first cell.
  const ahead = dir > 0 ? Math.ceil(value / grid) * grid : Math.floor(value / grid) * grid;
  return ahead + dir * (cells - 1) * grid;
}

// New top-left for a window moved by one key press. rect: { x, y } world px.
// snap: the Canvas [맞춤] toggle (off = plain steps, no grid alignment).
export function windowKeyMove(rect, action, { grid = WINDOW_KEY_GRID_PX, snap = true } = {}) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || action?.type !== 'move') return null;
  if (action.free) {
    return { x: rect.x + action.dx * WINDOW_KEY_FREE_PX, y: rect.y + action.dy * WINDOW_KEY_FREE_PX };
  }
  const options = { cells: action.shift ? WINDOW_KEY_LARGE_CELLS : 1, grid, snap: snap !== false };
  return { x: stepAxis(rect.x, action.dx, options), y: stepAxis(rect.y, action.dy, options) };
}

// Spoken after a keyboard move (aria-live), in Korean.
export function windowKeyMoveStatus(point, { snap = true, free = false } = {}) {
  if (!point) return '';
  const how = free ? '격자 해제' : snap ? '24px 격자' : '맞춤 꺼짐';
  return `창 위치 ${Math.round(point.x)}, ${Math.round(point.y)} · ${how}`;
}

// The help a focused window header gives (title / aria-description).
export const WINDOW_HEADER_KEY_HINT = '방향키: 24px씩 옮기기 · Shift+방향키: 120px · Option+방향키: 1px(격자 해제) · Shift+Space: 선택에 더하기/빼기 · ⌘Z: 되돌리기';

// ---------------------------------------------------------------------------
// Windows that matter now go first (UX-05)

// rank 0: the window a Briefing is reading, 1: a window an Agent is working
// in, 2: the rest.
export function windowPriorityRank(id, { briefingIds = [], agentIds = [] } = {}) {
  const has = (list, value) => (typeof list?.has === 'function' ? list.has(value) : Array.isArray(list) && list.includes(value));
  if (has(briefingIds, id)) return 0;
  if (has(agentIds, id)) return 1;
  return 2;
}

// Stable reorder: Briefing target first, then Agent-working, then the rest,
// each keeping the order it came in.
export function prioritizeWindows(items = [], { idOf = item => item?.id ?? item, ...sets } = {}) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index, rank: windowPriorityRank(idOf(item), sets) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.item);
}
