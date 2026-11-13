// The Canvas Chat window's frame: what its View bar names, and how its edges
// resize it. The Chat window keeps its own header element, but follows the
// Desk Window Shell's bar (dots · grip · icon · name · Board · actions) and
// its eight resize edges, so these rules mirror the shell's.

export const CHAT_FRAME_HOME_TITLE = '채팅';
export const CHAT_FRAME_MIN_WIDTH = 320;
export const CHAT_FRAME_MIN_HEIGHT = 420;

// The bar names the open conversation (the Agent or the room). On the room
// list, or before a conversation is open, it names the window itself.
export function chatFrameTitle({ thread = null, view = 'list' } = {}) {
  const name = typeof thread?.title === 'string' ? thread.title.trim() : '';
  const conversation = view === 'conversation' && !!name;
  return { text: conversation ? name : CHAT_FRAME_HOME_TITLE, conversation };
}

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// One resize step in world px. A dragged edge moves; the opposite edge stays
// where it was, also once the minimum size stops the drag.
export function resizeFrameRect(start, edges, dx, dy, limits = {}) {
  const minWidth = Math.max(1, finite(limits?.minWidth, CHAT_FRAME_MIN_WIDTH));
  const minHeight = Math.max(1, finite(limits?.minHeight, CHAT_FRAME_MIN_HEIGHT));
  const from = {
    left: finite(start?.left, 0), top: finite(start?.top, 0),
    width: finite(start?.width, minWidth), height: finite(start?.height, minHeight),
  };
  const moveX = finite(dx, 0);
  const moveY = finite(dy, 0);
  const next = { ...from };
  if (edges?.right) next.width = Math.max(minWidth, from.width + moveX);
  if (edges?.bottom) next.height = Math.max(minHeight, from.height + moveY);
  if (edges?.left) {
    next.width = Math.max(minWidth, from.width - moveX);
    next.left = from.left + (from.width - next.width);
  }
  if (edges?.top) {
    next.height = Math.max(minHeight, from.height - moveY);
    next.top = from.top + (from.height - next.height);
  }
  return next;
}
