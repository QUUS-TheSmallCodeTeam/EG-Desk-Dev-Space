// Rail search view rules (UX-04): the scope chips under the field, the
// "ask an Agent" row that keeps the field's promise, and how a request joins a
// draft. Pure: no DOM and no Chat state is touched here.

export const RAIL_SEARCH_SCOPES = Object.freeze([
  Object.freeze({ id: 'all', label: '전체', title: 'Board·Canvas·방문 기록·파일·Chat·웹에서 찾기' }),
  Object.freeze({ id: 'canvas', label: 'Canvas', title: '지금 Canvas에 열려 있는 창에서만 찾기' }),
  Object.freeze({ id: 'boards', label: '저장한 Board', title: '저장한 Board와 그 안에 저장된 Browser에서만 찾기' }),
]);

export function normalizeScope(scope) {
  return RAIL_SEARCH_SCOPES.some(entry => entry.id === scope) ? scope : 'all';
}

export function scopeLabel(scope) {
  const id = normalizeScope(scope);
  return RAIL_SEARCH_SCOPES.find(entry => entry.id === id).label;
}

// A row with `saved: false` is a Board that was never saved.
function scopeAllows(scope, result) {
  if (scope === 'canvas') return result.type === 'card';
  if (scope === 'boards') return result.type === 'history' || (result.type === 'agenda' && result.saved !== false);
  return true;
}

const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// The recipient is never guessed: the conversation that is open on screen, or
// else the pinned Agent DM. With neither there is no request row.
export function askRecipient({ threads, activeThreadId, conversationOpen } = {}) {
  const list = (Array.isArray(threads) ? threads : []).filter(thread => thread && typeof thread.id === 'string' && thread.id);
  const open = conversationOpen ? list.find(thread => thread.id === activeThreadId) : null;
  const thread = open || list.find(item => item.pinned && item.type !== 'group') || null;
  if (!thread) return null;
  const name = cleanText(thread.title) || 'Agent';
  return {
    threadId: thread.id,
    name,
    label: thread.type === 'group' ? `${name} 대화에 요청` : `${name}에게 요청`,
    source: open ? 'open' : 'pinned',
  };
}

export function askRow(query, recipient) {
  const text = cleanText(query);
  if (!text || !recipient?.threadId) return null;
  return {
    key: `ask:${recipient.threadId}`,
    type: 'ask',
    section: 'Agent 요청',
    typeLabel: 'Agent',
    title: `${recipient.label}: ${text}`,
    subtitle: '대화를 열고 입력칸에 초안으로 넣습니다 · 보내기는 직접 누릅니다',
    hint: 'Ctrl/⌘ Enter',
    active: false,
    threadId: recipient.threadId,
    text,
  };
}

// An existing draft is never replaced: the request goes on a new line, once.
export function mergeAskDraft(existing, text) {
  const current = typeof existing === 'string' ? existing : '';
  const add = String(text ?? '').trim();
  if (!add) return current;
  const body = current.replace(/\s+$/, '');
  if (!body.trim()) return add;
  if (body === add || body.endsWith(`\n${add}`)) return body;
  return `${body}\n${add}`;
}

// Found rows in their usual order, then the request row. The request row is
// last and is never cut by the limit; it is first only when it is alone.
export function composeResults({ scope, local = [], web = null, ask = null, navigation = false, limit = 14 } = {}) {
  const id = normalizeScope(scope);
  const found = local.filter(result => result && scopeAllows(id, result));
  const webRow = id === 'all' ? web : null;
  const ordered = webRow && navigation ? [webRow, ...found] : [...found, ...(webRow ? [webRow] : [])];
  return ask ? [...ordered.slice(0, Math.max(0, limit - 1)), ask] : ordered.slice(0, limit);
}

// What the panel says when no row was found (the request row is not a found row).
export function emptyState({ scope, results = [] } = {}) {
  if (results.some(result => result.type !== 'ask')) return null;
  const id = normalizeScope(scope);
  return id === 'all'
    ? { message: '결과 없음', widenLabel: null }
    : { message: `'${scopeLabel(id)}' 범위에서 찾은 것이 없습니다`, widenLabel: '범위를 전체로' };
}
