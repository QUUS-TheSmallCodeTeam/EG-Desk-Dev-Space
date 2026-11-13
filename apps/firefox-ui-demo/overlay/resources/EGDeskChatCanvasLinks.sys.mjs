// Chat ↔ Canvas links (pure view models): where a busy run is working, the way
// back to the Chat a View was opened from, and which Card a recommended
// material row points at. Nothing here moves the camera or touches the DOM;
// the surface script acts on what these return, only when the user asks.

export const WORK_SCREEN_LABEL = '현재 작업 화면';

/**
 * [현재 작업 화면] for one run: the open Card that run is bound to right now.
 * `bindings` are the BRW-13 run bindings (`runId\0cardId\0epoch` → { binding,
 * permission }); a Card the run may act on wins over one it only reads, and
 * among equals the one bound last. Null — no button — when the run is not
 * busy, has no binding, its binding was cancelled, or its Card is closed.
 * `cardFor(cardId)` answers { name } for an open Card, else null.
 */
export function runWorkScreen(run, bindings, { busy = false, cancelled = null, cardFor = () => null } = {}) {
  const runId = typeof run?.runId === 'string' ? run.runId : '';
  if (!runId || busy !== true || !bindings || typeof bindings[Symbol.iterator] !== 'function') return null;
  let best = null;
  for (const entry of bindings) {
    const [key, bound] = Array.isArray(entry) ? entry : [];
    if (typeof key !== 'string' || key.split('\u0000')[0] !== runId || cancelled?.has?.(key)) continue;
    const cardId = bound?.binding?.cardId;
    if (typeof cardId !== 'string' || !cardId) continue;
    const card = cardFor(cardId);
    if (!card) continue;
    const rank = bound.permission === 'interact' ? 1 : 0;
    if (!best || rank >= best.rank) best = { rank, cardId, name: typeof card.name === 'string' ? card.name.trim() : '' };
  }
  if (!best) return null;
  const title = `${best.name || 'Browser'} 창으로 화면 이동`;
  return { cardId: best.cardId, label: WORK_SCREEN_LABEL, title, ariaLabel: `${WORK_SCREEN_LABEL} · ${title}` };
}

/**
 * What '채팅으로 돌아가기' returns to: the camera the user left and where the
 * conversation was scrolled. Taken before the camera moves away.
 */
export function chatReturnOrigin({ pan, zoom, threadId = null, scrollTop = null } = {}) {
  if (!pan || !Number.isFinite(pan.x) || !Number.isFinite(pan.y) || !(zoom > 0) || !Number.isFinite(zoom)) return null;
  return { camera: { pan: { x: pan.x, y: pan.y }, zoom },
    threadId: typeof threadId === 'string' && threadId ? threadId : null,
    scrollTop: Number.isFinite(scrollTop) && scrollTop >= 0 ? scrollTop : null };
}

/**
 * The return itself. `camera` is the saved view while the Chat (world rect
 * `chat`) still shows inside `safe` (screen px) under it; null when the Chat
 * was moved or closed since, so the caller brings the Chat itself. `scrollTop`
 * is given back only to the conversation it was taken from.
 */
export function chatReturnPlan(origin, { activeThreadId = null, chat = null, safe = null } = {}) {
  if (!origin?.camera) return { camera: null, scrollTop: null };
  const scrollTop = origin.scrollTop !== null && origin.threadId !== null && origin.threadId === activeThreadId ? origin.scrollTop : null;
  const { pan, zoom } = origin.camera;
  const box = chat && [chat.x, chat.y, chat.width, chat.height].every(Number.isFinite) && chat.width > 0 && chat.height > 0 ? chat : null;
  const area = safe && [safe.left, safe.top, safe.right, safe.bottom].every(Number.isFinite) ? safe : null;
  if (!box || !area) return { camera: null, scrollTop };
  const left = box.x * zoom + pan.x, top = box.y * zoom + pan.y;
  const shown = left < area.right && left + box.width * zoom > area.left && top < area.bottom && top + box.height * zoom > area.top;
  return { camera: shown ? { pan: { x: pan.x, y: pan.y }, zoom } : null, scrollTop };
}

/**
 * Which Card a recommended material row outlines. 'enter' (hover or focus)
 * takes its row's ref, 'leave' clears only its own, 'clear' always clears.
 */
export function suggestionHighlight(current, event) {
  const ref = typeof current?.ref === 'string' && current.ref ? current.ref : null;
  if (!event) return { ref };
  if (event.type === 'clear') return { ref: null };
  if (event.type === 'enter') return { ref: typeof event.ref === 'string' && event.ref ? event.ref : null };
  if (event.type === 'leave') return { ref: ref === event.ref ? null : ref };
  return { ref };
}
