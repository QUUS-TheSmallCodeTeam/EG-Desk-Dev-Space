// EG-Desk Chat composer: the '@' list (CHAT-03, D-M2).
//
// In a Board Thread the person calls an Agent by name; only the Agents named
// answer. EGDeskThreadRouting reads '@이름' out of a sent bubble; this module is
// the writing side: which names the room offers, which '@…' the caret is in,
// what the list shows and what choosing a row puts in the draft. Pure — the
// surface script owns the textarea and the list element.
import { BOARD_ADDRESS_START, boardAddresses, boardLiteralMasked, boardStoreMembers } from './EGDeskBoardThread.sys.mjs';
import { profileRunnable } from './EGDeskChatState.sys.mjs';

export const MENTION_LIST_LABEL = '부를 대상';
export const MAX_MENTION_QUERY = 40;
const AGENT_HINT = 'Agent';
const fold = value => String(value).toLocaleLowerCase();

// Offer only selections that produce a single explicit profile address. The
// room-engine fallback is not a person to call; nor are self or legacy names.
export function mentionNames(thread, selfMember = '나', { profiles } = {}) {
  if (thread?.type !== 'group' || thread.engineId === 'claude') return [];
  const members = boardStoreMembers(thread, { selfName: selfMember });
  const runnable = Array.isArray(profiles) ? new Set(profiles.filter(profileRunnable).map(profile => profile.id)) : null;
  return members.flatMap(({ profileId, label: name }) => {
    if (!profileId || !name || name === selfMember || (runnable && !runnable.has(profileId))) return [];
    const { invalid, mentioned } = boardAddresses('@' + name, members);
    return !invalid && mentioned.length === 1 && mentioned[0].profileId === profileId ? [name] : [];
  });
}

// Names that start with the query first, then names that contain it.
export function mentionMatches(names, query) {
  const wanted = fold(query || '');
  const list = (names || []).filter(Boolean);
  if (!wanted) return list;
  const starts = list.filter(name => fold(name).startsWith(wanted));
  return [...starts, ...list.filter(name => !starts.includes(name) && fold(name).includes(wanted))];
}

// The '@…' the caret is typing on its own line: { start, end, query } or null.
// A name may hold a space ('디자인 리뷰어'), so a space continues the query only
// while the text so far still starts one of the names.
export function mentionQueryAt(text, caret, names = []) {
  const source = typeof text === 'string' ? text : '';
  const end = Math.max(0, Math.min(Number.isInteger(caret) ? caret : source.length, source.length));
  if (!end) return null;
  const lineStart = source.lastIndexOf('\n', end - 1) + 1;
  const start = source.lastIndexOf('@', end - 1);
  if (start < lineStart) return null;
  if (start > 0 && !BOARD_ADDRESS_START.test(source[start - 1])) return null;
  if (boardLiteralMasked(source)[start] !== '@') return null;
  const query = source.slice(start + 1, end);
  if ([...query].length > MAX_MENTION_QUERY) return null;
  if (/\s/u.test(query) && !(names || []).some(name => fold(name).startsWith(fold(query)))) return null;
  return { start, end, query };
}

export const emptyMention = () => ({ open: false, start: null, end: null, query: '', items: [], index: 0, dismissedStart: null });

// The list after the text or the caret changed. `active` is false while the
// composer is not the focused control (the list hides but remembers its row).
// A list never opens while a Korean syllable is being composed; one already
// open keeps narrowing with it. An '@' closed with Escape stays closed until
// the caret leaves it.
export function nextMention(prev, { names = [], text = '', caret = 0, selectionEnd = null, active = true, composing = false } = {}) {
  const before = prev || emptyMention();
  if (!active) return { ...before, open: false, items: [] };
  const collapsed = selectionEnd == null || selectionEnd === caret;
  const mention = names.length && collapsed ? mentionQueryAt(text, caret, names) : null;
  if (!mention) return emptyMention();
  const dismissedStart = before.dismissedStart === mention.start ? before.dismissedStart : null;
  const matches = mentionMatches(names, mention.query);
  const open = dismissedStart === null && matches.length > 0 && (before.open || !composing);
  const sameQuery = before.start === mention.start && before.query === mention.query;
  return {
    open, ...mention, dismissedStart,
    items: open ? matches.map(name => ({ name, kind: 'agent', label: `@${name}`, hint: AGENT_HINT })) : [],
    index: sameQuery ? Math.max(0, Math.min(before.index, Math.max(0, matches.length - 1))) : 0,
  };
}

// ↑↓ on an open list; the ends wrap.
export function moveMention(state, delta) {
  const count = state?.open ? state.items.length : 0;
  if (!count) return state;
  return { ...state, index: (((state.index + delta) % count) + count) % count };
}

// Escape: this '@' stays closed while it is still being typed.
export const dismissMention = state => ({ ...(state || emptyMention()), open: false, items: [], dismissedStart: state?.start ?? null });

// Choosing a name: '@이름' and one space replace the typed '@…'; the caret lands after the space.
export function applyMention(text, state, name) {
  const source = typeof text === 'string' ? text : '';
  if (!state || !Number.isInteger(state.start) || !name) return { text: source, caret: source.length };
  const head = `${source.slice(0, state.start)}@${name}`, tail = source.slice(state.end);
  return { text: `${head}${/^[^\S\n]/u.test(tail) ? '' : ' '}${tail}`, caret: head.length + 1 };
}

// What a key does to an open list: 'next' | 'prev' | 'pick' | 'close', or null
// when the key is the editor's (no list, a syllable in composition, a modifier).
export function mentionKeyAction(event, open) {
  if (!open || !event || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === 'ArrowDown') return 'next';
  if (event.key === 'ArrowUp') return 'prev';
  if (event.key === 'Escape') return 'close';
  if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) return 'pick';
  return null;
}

// ── CTX-04 pre-send scope preview ──
// One <details> above the input: what this send gives the Agent (each row
// can be removed), and earlier sources that changed since they were sent
// (each can be attached again). The model is EGDeskInputContext
// sendScopePreview; the host owns removal and attaching. textContent only.
export function renderSendScope({ document, model, open = false, onRemove, onAdd, onToggle } = {}) {
  if (!document?.createElement) throw new TypeError('renderSendScope requires a document');
  if (!model) return null;
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const details = make('details', 'egd-chat-send-scope');
  details.setAttribute('data-testid', 'chat-send-scope');
  details.setAttribute('data-count', String(model.sentCount));
  details.setAttribute('data-changed', String(model.changedCount));
  if (open) details.open = true;
  const summary = make('summary', 'egd-chat-send-scope-summary', model.summary);
  details.append(summary);
  if (typeof onToggle === 'function') details.addEventListener('toggle', () => onToggle(details.open === true));
  const list = make('ul', 'egd-chat-send-scope-list');
  list.setAttribute('aria-label', '이번에 볼 자료');
  for (const item of model.items) {
    const row = make('li', `egd-chat-send-scope-item egd-chat-send-scope-${item.origin}`);
    row.setAttribute('data-testid', 'chat-send-scope-item');
    row.setAttribute('data-origin', item.origin);
    const text = make('span', 'egd-chat-send-scope-text');
    text.append(make('span', 'egd-chat-send-scope-label', item.label));
    if (item.changed) {
      const chip = make('span', 'egd-chat-source-changed', '바뀜');
      chip.setAttribute('data-testid', 'chat-send-scope-changed');
      text.append(chip);
    }
    if (item.note) text.append(make('span', 'egd-chat-send-scope-note', item.note));
    row.append(text);
    const handler = item.action === 'remove' ? onRemove : item.action === 'add' ? onAdd : null;
    if (typeof handler === 'function') {
      const button = make('button', `egd-chat-send-scope-${item.action}`, item.action === 'remove' ? '빼기' : '다시 붙이기');
      button.type = 'button';
      button.setAttribute('data-testid', `chat-send-scope-${item.action}`);
      button.setAttribute('aria-label', `${item.label} ${item.action === 'remove' ? '빼기' : '다시 붙이기'}`);
      button.addEventListener('click', () => handler(item));
      row.append(button);
    }
    list.append(row);
  }
  details.append(list, make('p', 'egd-chat-send-scope-boundary', model.boundary));
  if (model.changedNote) details.append(make('p', 'egd-chat-send-scope-boundary', model.changedNote));
  return details;
}
