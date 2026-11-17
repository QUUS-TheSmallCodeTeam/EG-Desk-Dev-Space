// Pure view models for the Canvas view bar and the off-screen edge dots:
// where the dots sit and how many fold into "+N", what a typed zoom means,
// which earlier view [돌아가기] returns to, and how the snap toggle reads.
// No DOM, no state: the surface script owns drawing and the camera.

export const ZOOM_STEP = 1.25;
export const ZOOM_PERCENT_MIN = 1;
export const ZOOM_PERCENT_MAX = 400;
export const EDGE_DOTS_PER_SIDE = 3;
export const EDGE_DOT_GAP_PX = 24;
export const EDGE_DOT_TARGET_LIMIT = 200;

const SIDES = ['top', 'right', 'bottom', 'left'];
const SIDE_LABELS = Object.freeze({ top: '위쪽', right: '오른쪽', bottom: '아래쪽', left: '왼쪽' });
const finite = (...values) => values.every(Number.isFinite);

// ---------------------------------------------------------------------------
// Zoom typed into the view bar. "150", "150%", " 85.5 % " are accepted; a
// value outside 1–400% is an error the user sees, never silently clamped.

export function parseZoomPercentInput(text, { min = ZOOM_PERCENT_MIN, max = ZOOM_PERCENT_MAX } = {}) {
  const raw = String(text ?? '').normalize('NFKC').trim().replace(/\s*%$/, '').trim();
  if (!raw) return { ok: false, reason: 'empty', message: '배율을 숫자로 입력하세요.' };
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return { ok: false, reason: 'not-number', message: '배율을 숫자로 입력하세요.' };
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent < min || percent > max) {
    return { ok: false, reason: 'out-of-range', message: `${min}~${max}% 사이로 입력하세요.` };
  }
  return { ok: true, percent, zoom: percent / 100 };
}

// The camera that keeps the same screen point (the anchor) over the same
// world point while the zoom changes to the typed value.
export function zoomCameraAt({ pan, zoom, nextZoom, anchor } = {}) {
  if (!finite(pan?.x, pan?.y, zoom, nextZoom, anchor?.x, anchor?.y) || !(zoom > 0) || !(nextZoom > 0)) return null;
  const ratio = nextZoom / zoom;
  return { pan: { x: anchor.x - (anchor.x - pan.x) * ratio, y: anchor.y - (anchor.y - pan.y) * ratio }, zoom: nextZoom };
}

// ---------------------------------------------------------------------------
// [돌아가기]: one remembered view, taken just before 전체 보기 · 미니맵 · 찾기
// moves the camera. A later explicit move replaces it; returning clears it.

const toCamera = value => (finite(value?.pan?.x, value?.pan?.y, value?.zoom) && value.zoom > 0
  ? { pan: { x: value.pan.x, y: value.pan.y }, zoom: value.zoom } : null);

export function sameCamera(a, b, { panTolerance = 0.5, zoomTolerance = 0.0005 } = {}) {
  const left = toCamera(a);
  const right = toCamera(b);
  return !!left && !!right && Math.abs(left.pan.x - right.pan.x) <= panTolerance
    && Math.abs(left.pan.y - right.pan.y) <= panTolerance && Math.abs(left.zoom - right.zoom) <= zoomTolerance;
}

export function createReturnView() {
  let saved = null;
  return {
    remember(camera) {
      const next = toCamera(camera);
      if (!next) return false;
      saved = next;
      return true;
    },
    // Called after the move: a press that did not move the camera (전체 보기
    // twice in a row) must not overwrite the view the user can still return to.
    rememberIfMoved(before, after) {
      const from = toCamera(before);
      if (!from || sameCamera(from, after)) return false;
      saved = from;
      return true;
    },
    // A view equal to where the camera already is gives nothing to return to.
    available(current) { return !!saved && !sameCamera(saved, current); },
    peek() { return saved ? { pan: { ...saved.pan }, zoom: saved.zoom } : null; },
    take(current) {
      if (!saved || sameCamera(saved, current)) { saved = null; return null; }
      const out = saved;
      saved = null;
      return out;
    },
    clear() { saved = null; },
  };
}

export function returnButtonView(available) {
  return available
    ? { disabled: false, title: '이동하기 전에 보던 자리로 돌아가기' }
    : { disabled: true, title: '돌아갈 자리가 없습니다 — 전체 보기·미니맵·찾기로 이동한 뒤에 쓸 수 있습니다' };
}

// ---------------------------------------------------------------------------
// Snap toggle wording, shared by the view bar button and the placement menu.

export function snapToggleView(enabled) {
  const on = enabled !== false;
  return {
    pressed: on ? 'true' : 'false',
    label: '맞춤',
    title: on
      ? '격자·안내선 맞춤 켬 — 눌러서 끄기 (끄는 동안 Option/Alt를 누르면 잠깐 꺼집니다)'
      : '격자·안내선 맞춤 끔 — 눌러서 켜기',
    menuLabel: on ? '격자 맞춤 끄기' : '격자 맞춤 켜기',
    menuTitle: on
      ? '창을 끌거나 크기를 바꿀 때 24px 격자와 안내선에 맞추지 않습니다'
      : '창을 끌거나 크기를 바꿀 때 24px 격자와 안내선에 맞춥니다',
  };
}

// ---------------------------------------------------------------------------
// Moving a View from the keyboard (the 이동 dialog's [방향키로 옮기기]):
// one arrow press is 16px, with Shift 128px.

export const NUDGE_STEP_PX = 16;
export const NUDGE_STEP_LARGE_PX = 128;
const NUDGE_DIRECTIONS = Object.freeze({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] });

export function nudgeDelta(key, { shift = false } = {}) {
  const direction = typeof key === 'string' && Object.hasOwn(NUDGE_DIRECTIONS, key) ? NUDGE_DIRECTIONS[key] : null;
  if (!direction) return null;
  const step = shift ? NUDGE_STEP_LARGE_PX : NUDGE_STEP_PX;
  return { dx: direction[0] * step || 0, dy: direction[1] * step || 0 };
}

export function nudgeView() {
  return {
    label: '방향키로 옮기기',
    title: `방향키로 ${NUDGE_STEP_PX}px, Shift+방향키로 ${NUDGE_STEP_LARGE_PX}px씩 옮깁니다 — Enter 적용, Esc 취소`,
    hint: `방향키 ${NUDGE_STEP_PX}px · Shift+방향키 ${NUDGE_STEP_LARGE_PX}px. Enter 적용 · Esc 취소`,
  };
}

export function nudgeStatus({ x, y } = {}) {
  return `x ${Math.round(x)}, y ${Math.round(y)} — Enter 적용 · Esc 취소`;
}

// Shift+press on a View bar: an unselected View joins the selection and
// becomes the active one; a selected View leaves it. `pressedIds` is the
// pressed View first, then its group mates (a group comes and goes whole).
// The selection is never emptied this way.
export function shiftClickSelection(selectedIds = [], pressedIds = [], activeId = null) {
  const unique = list => Array.from(new Set((Array.isArray(list) ? list : []).filter(id => id != null && id !== '')));
  const selected = unique(selectedIds);
  const pressed = unique(pressedIds);
  const activeIn = ids => (ids.includes(activeId) ? activeId : ids[0] ?? null);
  if (!pressed.length) return { ids: selected, activeId: activeIn(selected) };
  if (!selected.includes(pressed[0])) {
    const ids = [...selected, ...pressed.filter(id => !selected.includes(id))];
    return { ids, activeId: pressed[0] };
  }
  const rest = selected.filter(id => !pressed.includes(id));
  if (!rest.length) return { ids: selected, activeId: activeIn(selected) };
  return { ids: rest, activeId: activeIn(rest) };
}

// ---------------------------------------------------------------------------
// Edge dots. Input: the points from EGDeskCanvasLayout.edgeIndicators (one per
// off-screen View, on the visible area's edge). Per side the nearest Views
// keep their own dot; the rest fold into one "+N" dot that leads to the
// nearest of them. Dots on one side are spread so they never stack.

// priority(id): 0 for the window a Briefing is reading, 1 for a window an
// Agent is working in, 2 (default) for the rest (UX-05). On each side those
// keep their own dot first; distance orders Views of the same rank.
export function edgeDotModel(indicators = [], {
  perSide = EDGE_DOTS_PER_SIDE, gap = EDGE_DOT_GAP_PX, titles = null, bounds = null, priority = null,
} = {}) {
  const rankOf = id => {
    if (typeof priority !== 'function') return 2;
    const value = Number(priority(id));
    return Number.isFinite(value) ? value : 2;
  };
  // The caller's Map is made in the window, another global than this module,
  // where `instanceof Map` is false; it is read by its get method instead.
  const windowOf = id => {
    const value = typeof titles?.get === 'function' ? titles.get(id) : titles?.[id];
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text ? `${text} 창` : '이름 없는 창';
  };
  const keep = Math.max(1, Math.floor(perSide) || 1);
  const out = [];
  for (const side of SIDES) {
    const list = (Array.isArray(indicators) ? indicators : [])
      .filter(item => item?.side === side && item.id != null && finite(item.x, item.y))
      .map((item, index) => ({ item, index }))
      .map(entry => ({ ...entry, rank: rankOf(entry.item.id) }))
      .sort((a, b) => a.rank - b.rank || (a.item.distance ?? Infinity) - (b.item.distance ?? Infinity) || a.index - b.index)
      .map(entry => entry.item);
    if (!list.length) continue;
    const single = list.length <= keep ? list : list.slice(0, keep - 1);
    const rest = list.length <= keep ? [] : list.slice(keep - 1);
    const dots = single.map(item => ({
      key: `view:${item.id}`, type: 'view', side, x: item.x, y: item.y, id: item.id, ids: [item.id], count: 1,
      text: '', label: `${SIDE_LABELS[side]} 화면 밖 · ${windowOf(item.id)}으로 이동`,
    }));
    if (rest.length) {
      const nearest = rest[0];
      dots.push({
        key: `more:${side}`, type: 'more', side, x: nearest.x, y: nearest.y, id: nearest.id,
        ids: rest.map(item => item.id), count: rest.length, text: `+${rest.length}`,
        label: `${SIDE_LABELS[side]} 화면 밖 창 ${rest.length}개 더 · 가장 가까운 ${windowOf(nearest.id)}으로 이동`,
      });
    }
    out.push(...spreadAlongSide(dots, side, gap, bounds));
  }
  return out;
}

function spreadAlongSide(dots, side, gap, bounds) {
  const axis = side === 'left' || side === 'right' ? 'y' : 'x';
  const low = axis === 'y' ? bounds?.top : bounds?.left;
  const high = axis === 'y' ? bounds?.bottom : bounds?.right;
  const sorted = dots.map(dot => ({ ...dot })).sort((a, b) => a[axis] - b[axis]);
  if (!(gap > 0) || sorted.length < 2) return sorted;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][axis] - sorted[i - 1][axis] < gap) sorted[i][axis] = sorted[i - 1][axis] + gap;
  }
  if (Number.isFinite(high) && sorted[sorted.length - 1][axis] > high) {
    sorted[sorted.length - 1][axis] = high;
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i + 1][axis] - sorted[i][axis] < gap) sorted[i][axis] = sorted[i + 1][axis] - gap;
    }
  }
  if (Number.isFinite(low) && sorted[0][axis] < low) {
    // More dots than the side can hold at this gap: keep them on screen, evenly.
    const span = Number.isFinite(high) ? Math.max(0, high - low) : gap * (sorted.length - 1);
    const step = sorted.length > 1 ? span / (sorted.length - 1) : 0;
    sorted.forEach((dot, index) => { dot[axis] = low + step * index; });
  }
  return sorted;
}

// Dots are hidden while something else already shows where everything is
// (the minimap) or while the Canvas itself is not what the user is looking at.
export function edgeDotsVisible({ minimapOpen = false, fullscreen = false, browserFocus = false, restoring = false } = {}) {
  return !minimapOpen && !fullscreen && !browserFocus && !restoring;
}
