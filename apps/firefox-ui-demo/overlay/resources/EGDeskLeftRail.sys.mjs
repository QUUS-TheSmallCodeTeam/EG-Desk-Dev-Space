// What the left Desk rail, the Board list's empty state and the empty Canvas
// hint say. Pure rules over the Board list entries the screen already keeps
// ({ id, title, saved, closed, dirty, count } from agendaListEntries); the
// screen draws the result and wires the clicks to its existing actions.
//
// - The rail lists the Boards the person saved, under Desk and 파일. A row
//   opens that Board on the same Canvas; nothing in the rail is an example.
// - Rows keep a name order, so opening a Board never moves the row that was
//   just pressed.
// - The empty Canvas hint only points at Edges that already exist (search on
//   top, the rail on the left, the Dock below). It never points right, never
//   asks for a click, and is not an accessible control.

const nameOrder = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const titleOf = entry => typeof entry?.title === 'string' && entry.title.trim() ? entry.title.trim() : 'Board';
const countOf = value => Math.max(0, Math.round(Number(value) || 0));

// Rows of the rail's saved Board list.
//   current — the Board being worked in (selected and open on the Canvas)
//   open    — open on the Canvas; pressing the row moves to it
export function boardRailRows(entries, { openBoardIds = [], activeBoardId = null } = {}) {
  const open = new Set(Array.isArray(openBoardIds) ? openBoardIds.filter(id => id != null) : []);
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && entry.id != null && entry.saved)
    .map(entry => {
      const label = titleOf(entry);
      const isOpen = open.has(entry.id);
      const current = isOpen && activeBoardId != null && entry.id === activeBoardId;
      const count = countOf(entry.count);
      return {
        id: entry.id,
        label,
        current,
        open: isOpen,
        count,
        dirty: isOpen && !!entry.dirty,
        ariaLabel: current ? `Board ${label}, 지금 작업 중` : isOpen ? `Board ${label}로 이동` : `Board ${label} 열기`,
        tooltip: [
          label,
          current ? '지금 작업 중' : isOpen ? 'Canvas에 열려 있음' : null,
          isOpen && entry.dirty ? '저장 안 됨' : null,
          `항목 ${count}개`,
        ].filter(Boolean).join(' · '),
      };
    })
    .sort((a, b) => nameOrder.compare(a.label, b.label) || String(a.id).localeCompare(String(b.id)));
}

// Everything the rail draws for its rows; equal signatures need no redraw.
export function boardRailSignature(rows) {
  return JSON.stringify((Array.isArray(rows) ? rows : []).map(row => [row.id, row.label, row.current, row.open, row.tooltip]));
}

// ↑/↓ step through the rail's buttons and stop at the ends; Home/End jump.
// Returns the index to focus, or null when the key is not the rail's.
export function railFocusIndex({ key, index, count } = {}) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count <= 0 || index < 0 || index >= count) return null;
  if (key === 'ArrowDown') return Math.min(count - 1, index + 1);
  if (key === 'ArrowUp') return Math.max(0, index - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

// What the Board list shows when it has no row.
//   none-saved   — nothing saved and no search: say so, offer the two ways to start
//   no-match     — a search found nothing
//   filter-empty — Boards exist, the chosen filter has none
export function boardListEmptyState({ total = 0, query = '', filter = 'all', canImport = false } = {}) {
  if (String(query || '').trim()) return { kind: 'no-match', message: '검색 결과가 없습니다.', actions: [] };
  if (countOf(total) === 0) {
    return { kind: 'none-saved', message: '저장한 Board가 없습니다', actions: canImport ? ['new', 'import'] : ['new'] };
  }
  if (filter === 'closed') return { kind: 'filter-empty', message: '닫은 Board가 없습니다', actions: [] };
  if (filter === 'recent') return { kind: 'filter-empty', message: '최근에 쓴 Board가 없습니다', actions: [] };
  return { kind: 'no-match', message: '검색 결과가 없습니다.', actions: [] };
}

// The three cues of an empty Canvas. Visible only while the Canvas holds no
// View, no drawing and no Board region.
export function emptyCanvasHint({ cards = 0, shapes = 0, boards = 0, savedBoards = 0, shortcut = '⌘K' } = {}) {
  return {
    visible: countOf(cards) + countOf(shapes) + countOf(boards) === 0,
    cues: [
      { id: 'search', direction: 'up', text: `${shortcut} 검색 또는 AI에게 요청` },
      { id: 'board', direction: 'left', text: countOf(savedBoards) > 0 ? '왼쪽에서 저장한 Board 열기' : '왼쪽 +에서 새 Board 만들기' },
      { id: 'dock', direction: 'down', text: '아래 Dock에서 채팅과 창 열기' },
    ],
  };
}
