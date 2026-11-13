// Dock layout (approved desktop style): eight buttons on the Dock, and the
// rest of what the Dock used to hold inside the [새 카드] menu. Pure data and
// decisions only; eg-desk-surface.uc.js renders them.
//
// Keyboard movement follows the W3C ARIA Authoring Practices menu and radio
// group patterns already adopted for this surface (reference-adoption-map
// DSN-04): arrows move, both ends wrap, Home/End jump, Tab is not taken.

const freezeItems = items => Object.freeze(items.map(item => Object.freeze(item)));

/** Windows the Dock opens directly. */
export const DOCK_OPEN_ITEMS = freezeItems([
  { id: 'chat', label: '대화', icon: 'chat' },
  { id: 'memo', label: '메모', icon: 'note' },
  { id: 'browser', label: 'Browser', icon: 'browser' },
  { id: 'terminal', label: '터미널', icon: 'terminal' },
]);

/** Canvas tools that stay on the Dock. */
export const DOCK_TOOL_ITEMS = freezeItems([
  { id: 'select', label: '선택', icon: 'pointer', active: true },
  { id: 'hand', label: '이동', icon: 'move' },
]);

/** The button that opens the menu below. */
export const DOCK_NEW_CARD = Object.freeze({ id: 'create', label: '새 카드', icon: 'plus' });

/** Windows opened from the [새 카드] menu. */
export const DOCK_NEW_CARD_ITEMS = freezeItems([
  { id: 'shelf', label: '파일', icon: 'file' },
  { id: 'ide', label: '개발 (IDE)', icon: 'ide' },
  { id: 'ontology', label: '온톨로지', icon: 'ontology' },
  { id: 'settings', label: '설정', icon: 'settings' },
]);

/** Drawing tools, one icon row inside the [새 카드] menu. */
export const DOCK_DRAW_TOOLS = freezeItems([
  { id: 'pencil', label: '펜', icon: 'pencil' },
  { id: 'square', label: '사각형', icon: 'square' },
  { id: 'ellipse', label: '원', icon: 'ellipse' },
  { id: 'line', label: '선', icon: 'line' },
  { id: 'arrow', label: '화살표', icon: 'arrow' },
  { id: 'label', label: '글자', icon: 'text' },
  { id: 'highlight', label: '강조', icon: 'highlight' },
]);

/** The right end closes what is selected. The id stays 'trash' for existing callers. */
export const DOCK_CLOSE_ITEMS = freezeItems([
  { id: 'trash', label: '선택한 창 닫기', icon: 'close' },
]);

export const DOCK_BUTTON_LIMIT = 8;

/** Ids of the buttons always on the Dock, left to right. */
export function dockButtonIds() {
  return [...DOCK_OPEN_ITEMS, ...DOCK_TOOL_ITEMS, DOCK_NEW_CARD, ...DOCK_CLOSE_ITEMS].map(item => item.id);
}

/**
 * The drawing tool in use, shown as one extra pressed button beside [선택].
 * null for the tools already on the Dock and for anything unknown.
 */
export function dockCurrentDrawTool(activeTool) {
  const tool = DOCK_DRAW_TOOLS.find(item => item.id === activeTool);
  return tool ? { ...tool, title: `지금 도구: ${tool.label} · 눌러서 다른 도구 고르기` } : null;
}

const count = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** Whether the close button can act, and what it says it will do. */
export function dockCloseState({ windows = 0, marks = 0 } = {}) {
  const w = count(windows), m = count(marks);
  if (!w && !m) return { disabled: true, title: '선택한 창 닫기 · 선택한 창이 없습니다' };
  if (w && m) return { disabled: false, title: `선택한 창 ${w}개 닫기 · 표식 ${m}개 지우기` };
  if (m) return { disabled: false, title: `선택한 표식 ${m}개 지우기` };
  return { disabled: false, title: w === 1 ? '선택한 창 닫기' : `선택한 창 ${w}개 닫기` };
}

/** Wording of the marks toggle and of the [새 카드] button while marks are hidden. */
export function dockAnnotationToggle({ hidden = false, count: total = 0 } = {}) {
  if (!hidden) return { label: '표식·메모 숨기기', detail: '', pressed: false, newCardTitle: DOCK_NEW_CARD.label };
  const n = count(total);
  const detail = n ? `숨김 ${n}개` : '숨김';
  return { label: '표식·메모 보이기', detail, pressed: true, newCardTitle: `${DOCK_NEW_CARD.label} · 표식·메모 ${detail}` };
}

/**
 * Next focused item of the [새 카드] menu. Items are counted flat: `cards`
 * rows, then `tools` icons on one row, then the marks toggle. Up/Down move
 * between rows (the tool row is one stop, entered on `activeTool` when given),
 * Left/Right move inside the tool row, both wrap. -1 means the key is not ours.
 */
export function dockMenuMove({ index = -1, key, cards = 0, tools = 0, activeTool = -1 } = {}) {
  const c = count(cards), t = count(tools);
  const toggle = c + t, last = toggle;
  const toolStop = c + (activeTool >= 0 && activeTool < t ? Math.floor(activeTool) : 0);
  const inTools = t > 0 && index >= c && index < c + t;
  switch (key) {
    case 'Home': return 0;
    case 'End': return last;
    case 'ArrowDown':
      if (index < 0 || index > last) return 0;
      if (index === toggle) return 0;
      if (inTools) return toggle;
      if (index === c - 1) return t ? toolStop : toggle;
      return index + 1;
    case 'ArrowUp':
      if (index < 0 || index > last) return last;
      if (index === toggle) return t ? toolStop : (c ? c - 1 : toggle);
      if (inTools) return c ? c - 1 : toggle;
      if (index === 0) return last;
      return index - 1;
    case 'ArrowRight': return inTools ? c + ((index - c + 1) % t) : -1;
    case 'ArrowLeft': return inTools ? c + ((index - c - 1 + t) % t) : -1;
    default: return -1;
  }
}
