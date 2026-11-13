// EG-Desk Chat composer: the '@' list (CHAT-03, D-M2).
//
// In a Board Thread the person calls an Agent by name; only the Agents named
// answer. EGDeskThreadRouting reads '@이름' out of a sent bubble; this module is
// the writing side: which names the room offers, which '@…' the caret is in,
// what the list shows and what choosing a row puts in the draft. Pure — the
// surface script owns the textarea and the list element.
import { threadAgentNames } from './EGDeskThreadRouting.sys.mjs';

export const MENTION_LIST_LABEL = '부를 대상';
export const MAX_MENTION_QUERY = 40;
const AGENT_HINT = 'Agent', USER_HINT = '대표님';
// Same boundary as EGDeskThreadRouting.mentionSpans: '@' starts a call only at
// the start of the text or after a space, bracket or quote ('mail@…' is not one).
const BEFORE_OK = /[\s([{"'“‘]/u;
const fold = value => String(value).toLocaleLowerCase();

// Who '@' can call here: the room's Agents, then the person. Nobody outside a Board Thread.
export function mentionNames(thread, selfMember = '나') {
  if (thread?.type !== 'group') return [];
  return [...new Set([...threadAgentNames(thread, selfMember).filter(name => typeof name === 'string' && name.trim()), selfMember])];
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
  if (start > 0 && !BEFORE_OK.test(source[start - 1])) return null;
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
  const selfName = names[names.length - 1];
  const open = dismissedStart === null && matches.length > 0 && (before.open || !composing);
  const sameQuery = before.start === mention.start && before.query === mention.query;
  return {
    open, ...mention, dismissedStart,
    items: open ? matches.map(name => ({ name, kind: name === selfName ? 'user' : 'agent', label: `@${name}`, hint: name === selfName ? USER_HINT : AGENT_HINT })) : [],
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
