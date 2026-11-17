// EG-Desk Canvas Memo links on screen (CNV-06). Pure: no DOM, no imports.
// The records and their rules stay in EGDeskMemoState.sys.mjs; this module
// decides what the screen draws and offers for them:
//  - one line per window a memo points at (its anchor window, then each extra
//    link), each with a stable key so the screen reuses the line node,
//  - the [연결 끊기] choices and what each one changes,
//  - the keyboard list for [다시 연결] (windows nearest the memo first),
//  - the [다시 묻기] row for a question whose answer failed.
// Loaded once with ChromeUtils.importESModule(url) (pure, so one shared copy).

const finiteRect = rect => !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
const centre = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

// Lines for one memo. rectOf(id) returns the window's world rect or null when
// it is not on the Canvas (closed, hidden). segment(memoRect, targetRect) is
// EGDeskMemoState.memoTetherSegment (null when they touch).
// anchorAttached: the memo's anchor window is on the Canvas (data-memo-anchor).
// Returns [{ key, kind: 'anchor'|'link', targetId, label, segment }].
export function memoLinkLines(memo, { memoRect, rectOf, segment, anchorAttached = true } = {}) {
  if (!memo || !finiteRect(memoRect) || typeof rectOf !== 'function' || typeof segment !== 'function') return [];
  const out = [];
  const seen = new Set();
  const add = (kind, targetId, label) => {
    if (!targetId || targetId === memo.id || seen.has(targetId)) return;
    seen.add(targetId);
    const rect = rectOf(targetId);
    if (!finiteRect(rect)) return;
    const line = segment(memoRect, rect);
    if (line) out.push({ key: `${kind}:${targetId}`, kind, targetId, label: label || '', segment: line });
  };
  if (memo.anchor?.kind === 'card' && anchorAttached) add('anchor', memo.anchor.cardId, memo.anchor.label);
  for (const link of Array.isArray(memo.links) ? memo.links : []) add('link', link.targetViewId, link.label);
  return out;
}

// What [연결 끊기] can undo on this memo, in menu order. The anchor window
// first (the memo stays where it is, now pinned to the Canvas), then every
// extra link. titleOf(id) names an open window; a closed one keeps its label.
export function memoUnlinkChoices(memo, { titleOf = () => '' } = {}) {
  const name = (id, fallback) => String(titleOf(id) || fallback || '창').replace(/\s+/g, ' ').trim() || '창';
  const out = [];
  if (memo?.anchor?.kind === 'card') {
    const label = name(memo.anchor.cardId, memo.anchor.label);
    out.push({ kind: 'anchor', targetId: memo.anchor.cardId, label: `${label}에서 떼기`, title: `${label}과의 연결을 끊습니다. 메모는 지금 자리에 남습니다.` });
  }
  for (const link of Array.isArray(memo?.links) ? memo.links : []) {
    const label = name(link.targetViewId, link.label);
    out.push({ kind: 'link', targetId: link.targetViewId, label: `${label} 연결 끊기`, title: `${label}로 가는 선을 지웁니다.` });
  }
  return out;
}

// Windows offered by [다시 연결] from the keyboard: every window on the Canvas
// except memos, nearest to the memo first, then by name. cards: [{ id, label,
// rect }]. The current anchor window is marked so the list can say so.
export function memoRelinkCandidates(memo, cards = [], { memoRect = null, limit = 30 } = {}) {
  const from = finiteRect(memoRect) ? centre(memoRect) : null;
  const rows = (Array.isArray(cards) ? cards : [])
    .filter(card => card?.id && card.id !== memo?.id && finiteRect(card.rect))
    .map((card, index) => {
      const at = centre(card.rect);
      return { id: card.id, label: String(card.label || '창').replace(/\s+/g, ' ').trim() || '창', index,
        distance: from ? Math.hypot(at.x - from.x, at.y - from.y) : index,
        current: memo?.anchor?.kind === 'card' && memo.anchor.cardId === card.id };
    })
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label, 'ko') || a.index - b.index);
  return rows.slice(0, Math.max(0, limit)).map(({ id, label, current }) => ({ id, label: current ? `${label} (지금 연결됨)` : label, current }));
}

// Rows for questions whose answer failed: the Agent's name and [다시 묻기]
// (ask the same Agent again with the memo as it is now) and [닫기].
// nameOf(agentId) gives the Agent's display name.
export function memoFailedAskRows(memo, { nameOf = () => '' } = {}) {
  return (Array.isArray(memo?.asks) ? memo.asks : [])
    .filter(ask => ask?.status === 'failed')
    .map(ask => {
      const name = String(nameOf(ask.agentId) || 'Agent').trim() || 'Agent';
      return { askId: ask.askId, agentId: ask.agentId, text: `${name} 답을 받지 못했습니다`,
        retry: '다시 묻기', retryTitle: `${name}에게 이 메모를 지금 내용으로 다시 보냅니다.`, dismiss: '닫기' };
    });
}

// How a finished run without an answer closes a pending question: stopped on
// purpose (cancelled) is just closed; a failure keeps a row with [다시 묻기].
export function memoAskEndStatus(runStatus) {
  if (runStatus === 'cancelled') return 'cancelled';
  if (['failed', 'interrupted', 'unavailable'].includes(runStatus)) return 'failed';
  return null;
}
