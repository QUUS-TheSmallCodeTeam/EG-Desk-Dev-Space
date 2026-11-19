// CHAT-03 (D-M3 · D-M2): moving chosen Agent DM messages into a Board Thread,
// the links both rooms keep, and @mentions inside a Board Thread.
//
// Pure: no DOM, no fetch. The bridge's chat store is the record. The helper
// (codex-chat-runtime.mjs shareMessages, POST /chat/share) copies the chosen
// saved messages and writes one event on each side: 'messages.shared.in' in
// the Board Thread (copies + a link back) and 'messages.shared.out' in the DM
// (the ids sent + a link forward). The receiving Agent reads the copies once,
// as the <egdesk-shared-messages> block of its next turn. This module turns
// those events into one `routing` view per room, builds the share request,
// places the copied blocks in the timeline, and parses mentions the way the
// helper's boardMentions does ([@이름](agent://id) or plain @이름).
import { clientThreadBinding, isChatWorkNote } from './EGDeskChatState.sys.mjs';

const idText = value => typeof value === 'string' && value.trim() ? value : null;

export const MOVE_TO_BOARD_LABEL = 'Board Thread로 옮기기';
export const PICK_MESSAGES_LABEL = '여러 메시지 골라 옮기기';
export const PICK_TARGET_TITLE = '어느 Board Thread로 옮길까요?';
export const NEW_BOARD_THREAD_LABEL = '새 Board Thread 만들기';
export const RETURN_TO_DM_LABEL = 'DM으로 돌아오기';
export const VIEW_ORIGIN_LABEL = '원래 대화 보기';
export const SENT_TO_THREAD_TEXT = '스레드로 보냄';
export const SHARED_BLOCK_NOTE = '받는 Agent는 다음 메시지를 보낼 때 이 복사본을 함께 읽습니다';
export const MAX_SHARED_MESSAGES = 20; // helper/codex-chat-runtime.mjs MAX_SHARED_MESSAGES

const SHARE_ERROR_TEXT = Object.freeze({
  INVALID_SHARE: `메시지를 1개부터 ${MAX_SHARED_MESSAGES}개까지 골라 다른 대화방으로 옮길 수 있습니다.`,
  MESSAGE_NOT_SHAREABLE: '작업 메모는 대화 발언으로 옮길 수 없습니다.',
  MESSAGE_NOT_FOUND: '아직 저장되지 않은 메시지가 있어 옮기지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  CONVERSATION_NOT_FOUND: '대화 기록을 이 기기에서 찾지 못해 옮기지 못했습니다.',
  SHARE_TOO_LARGE: '고른 메시지가 너무 길어 한 번에 옮길 수 없습니다. 더 적게 골라 주세요.',
  SHARE_CONFLICT: '같은 메시지를 이미 옮겼습니다.',
  CHAT_STORE_UNAVAILABLE: '로컬 대화 기록을 쓸 수 없어 옮기지 못했습니다.',
});
export function shareErrorText(error) {
  const code = typeof error === 'string' ? error : error?.code;
  return (typeof code === 'string' && SHARE_ERROR_TEXT[code]) || '메시지를 옮기지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}

// ── choosing ────────────────────────────────────────────────────────────────
// Only finished people's and Agents' bubbles move; a streaming or refused one stays.
export function shareableMessage(message) {
  if (!message || isChatWorkNote(message) || !['user', 'assistant'].includes(message.role)) return false;
  if (typeof message.content !== 'string' || !message.content.trim()) return false;
  return !['streaming', 'submitting', 'unconfirmed', 'failed', 'error'].includes(message.status);
}

// The chosen bubbles, in room order, with the saved ids the bridge knows. A
// live bubble the store has not named yet is `missing`; the caller reloads the
// room's local history and asks again.
export function resolveShareMessages(thread, selectedIds) {
  const wanted = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const messages = [], missing = [];
  for (const message of thread?.messages || []) {
    if (!wanted.has(message.id)) continue;
    if (!shareableMessage(message)) { missing.push(message.id); continue; }
    if (idText(message.localMessageId)) messages.push({ id: message.id, localMessageId: message.localMessageId, role: message.role, text: message.content });
    else missing.push(message.id);
  }
  return { messages, localMessageIds: messages.map(message => message.localMessageId), missing };
}

export function buildShareRequest(fromThread, toThread, localMessageIds, shareId = null) {
  const body = { fromClientThreadId: clientThreadBinding(fromThread), toClientThreadId: clientThreadBinding(toThread),
    localMessageIds: [...new Set(localMessageIds || [])].slice(0, MAX_SHARED_MESSAGES) };
  if (idText(shareId)) body.shareId = shareId;
  return body;
}

// Board Threads a DM can send to, newest work first; the DM itself never.
export function boardThreadChoices(threads, fromThread) {
  return (threads || []).filter(thread => thread && thread.type === 'group' && thread.id !== fromThread?.id)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(thread => ({ id: thread.id, title: thread.title, memberCount: (thread.participants || []).length, saved: !!thread.localConversationId }));
}

// ── the routing view of one room ────────────────────────────────────────────
// sharedIn: copies brought here [{ shareId, seq, ts, fromClientThreadId,
//   localMessageIds (the DM's ids), messages: [{ localMessageId, role, text }] }]
// sharedOut: this room's saved ids that were sent on { localMessageId → { shareId, toClientThreadId, ts } }
export const emptyRouting = () => ({ sharedIn: [], sharedOut: {} });

const orderShares = shares => [...shares].sort((a, b) => {
  if (Number.isSafeInteger(a.seq) && Number.isSafeInteger(b.seq) && a.seq !== b.seq) return a.seq - b.seq;
  return (a.ts || 0) - (b.ts || 0);
});
const publicCopies = messages => (Array.isArray(messages) ? messages : [])
  .filter(message => message && typeof message.text === 'string')
  .slice(0, MAX_SHARED_MESSAGES)
  .map(message => ({ localMessageId: idText(message.localMessageId), role: message.role === 'assistant' ? 'assistant' : 'user', text: message.text }));

function withSharedIn(routing, entry) {
  const base = routing || emptyRouting();
  const sharedIn = base.sharedIn.filter(share => share.shareId !== entry.shareId);
  return { ...base, sharedIn: orderShares([...sharedIn, entry]) };
}
function withSharedOut(routing, { shareId, toClientThreadId, localMessageIds, ts }) {
  const base = routing || emptyRouting();
  const sharedOut = { ...base.sharedOut };
  for (const localMessageId of localMessageIds || []) if (idText(localMessageId)) sharedOut[localMessageId] = { shareId, toClientThreadId, ts: ts ?? null };
  return { ...base, sharedOut };
}

// Local history pages arrive in order; each page's share events join the view.
export function routingWithEvents(routing, events) {
  let next = routing || emptyRouting();
  for (const event of Array.isArray(events) ? events : []) {
    const details = event?.details;
    const shareId = idText(details?.shareId);
    if (!shareId) continue;
    if (event.event === 'messages.shared.in') {
      next = withSharedIn(next, { shareId, seq: Number.isSafeInteger(event.seq) ? event.seq : null, ts: event.ts ?? null,
        fromClientThreadId: idText(details.link?.clientThreadId), localMessageIds: Array.isArray(details.link?.localMessageIds) ? details.link.localMessageIds.filter(idText) : [],
        messages: publicCopies(details.messages) });
    } else if (event.event === 'messages.shared.out') {
      next = withSharedOut(next, { shareId, toClientThreadId: idText(details.link?.clientThreadId), localMessageIds: details.localMessageIds, ts: event.ts ?? null });
    }
  }
  return next;
}

// Right after POST /chat/share answers, both rooms show the move before the
// store is read again: the DM marks what left, the Board Thread shows the copies.
export function routingAfterSend(routing, result, localMessageIds, ts = Date.now()) {
  return withSharedOut(routing, { shareId: result.shareId, toClientThreadId: idText(result.toClientThreadId), localMessageIds, ts });
}
export function routingAfterReceive(routing, result, copies, ts = Date.now()) {
  return withSharedIn(routing, { shareId: result.shareId, seq: null, ts, fromClientThreadId: idText(result.fromClientThreadId),
    localMessageIds: publicCopies(copies).map(message => message.localMessageId).filter(Boolean), messages: publicCopies(copies) });
}

export const sharedOutMark = (routing, message) => (message?.localMessageId && routing?.sharedOut?.[message.localMessageId]) || null;

// Each block of copies sits before the first bubble saved after it; a block
// newer than every bubble (or not yet saved) closes the conversation.
export function sharedBlockPlacement(routing, messages) {
  const beforeMessageId = new Map();
  const trailing = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const share of routing?.sharedIn || []) {
    let anchor = null;
    if (Number.isSafeInteger(share.seq)) {
      anchor = list.find(message => Number.isSafeInteger(message.localSeq) && message.localSeq > share.seq)
        || (typeof share.ts === 'number' ? list.find(message => typeof message.createdAt === 'number' && message.createdAt > share.ts) : null) || null;
    }
    if (anchor) beforeMessageId.set(anchor.id, [...(beforeMessageId.get(anchor.id) || []), share]);
    else trailing.push(share);
  }
  return { beforeMessageId, trailing };
}

// ── links between the rooms ─────────────────────────────────────────────────
export function threadByClientId(threads, clientThreadId) {
  if (!idText(clientThreadId)) return null;
  return (threads || []).find(thread => thread && (thread.id === clientThreadId || clientThreadBinding(thread) === clientThreadId)) || null;
}

// The DM that most recently sent messages here, when it is still on this device.
export function returnToDmTarget(thread, threads) {
  if (thread?.type !== 'group') return null;
  for (const share of [...(thread.routing?.sharedIn || [])].reverse()) {
    const origin = threadByClientId(threads, share.fromClientThreadId);
    if (origin && origin.type === 'dm' && origin.id !== thread.id) return origin;
  }
  return null;
}

// '원래 대화 보기': the DM room and the first copied bubble to bring into view.
export function sharedOriginTarget(share, threads) {
  const origin = threadByClientId(threads, share?.fromClientThreadId);
  if (!origin) return null;
  const wanted = new Set(share.localMessageIds || []);
  const message = wanted.size ? (origin.messages || []).find(item => wanted.has(item.localMessageId) || wanted.has(item.id)) : null;
  return { threadId: origin.id, messageId: message?.id || null };
}

// ── mentions (D-M2: only the Agents named answer; the person can be named too) ──
// Same shape as helper/codex-chat-runtime.mjs boardMentions: a Markdown link
// to agent://profileId, or plain @이름 bounded by space or punctuation,
// longest names first so '@디자인 리뷰어' is not read as '@디자인'.
export const USER_MENTION_NAMES = Object.freeze(['나', '사용자', '사람']);
const AGENT_MENTION_LINK = /\[([^\]\n]{0,200})\]\((agent:\/\/[^)\s]{1,200})\)/g;
const BEFORE_OK = /[\s([{"'“‘]/u, AFTER_OK = /[\s.,!?;:)\]}"'”’·…]/u;

export function mentionSpans(text, { selfNames = USER_MENTION_NAMES, agentNames = [] } = {}) {
  const source = typeof text === 'string' ? text : '';
  const spans = [];
  for (const match of source.matchAll(AGENT_MENTION_LINK)) {
    const profileId = match[2].slice('agent://'.length).split(/[/?#]/)[0];
    spans.push({ start: match.index, end: match.index + match[0].length, kind: 'agent', name: match[1].replace(/^@/, '') || profileId, profileId, text: match[0] });
  }
  const chars = [...source];
  // Indexes are code units (for slicing) but matching walks code points.
  const unitIndex = []; let units = 0;
  for (const char of chars) { unitIndex.push(units); units += char.length; }
  unitIndex.push(units);
  const masked = chars.map((char, index) => spans.some(span => unitIndex[index] >= span.start && unitIndex[index] < span.end) ? ' ' : char);
  const names = [...selfNames.map(name => ({ name, kind: 'user' })), ...agentNames.filter(Boolean).map(name => ({ name, kind: 'agent' }))]
    .filter(entry => typeof entry.name === 'string' && entry.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  for (const entry of names) {
    const token = [...`@${entry.name}`];
    for (let at = 0; at + token.length <= masked.length; at++) {
      if (token.some((char, offset) => masked[at + offset] !== char)) continue;
      const before = masked[at - 1], after = masked[at + token.length];
      if ((before !== undefined && !BEFORE_OK.test(before)) || (after !== undefined && !AFTER_OK.test(after))) continue;
      spans.push({ start: unitIndex[at], end: unitIndex[at + token.length], kind: entry.kind, name: entry.name, profileId: null, text: `@${entry.name}` });
      masked.fill(' ', at, at + token.length);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

// Text split into plain runs and mention chips, in order.
export function mentionSegments(text, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const segments = [];
  let cursor = 0;
  for (const span of mentionSpans(source, options)) {
    if (span.start > cursor) segments.push({ type: 'text', text: source.slice(cursor, span.start) });
    segments.push({ type: 'mention', kind: span.kind, name: span.name, profileId: span.profileId, text: span.text });
    cursor = span.end;
  }
  if (cursor < source.length) segments.push({ type: 'text', text: source.slice(cursor) });
  return segments;
}

export const mentionsUser = (text, selfNames = USER_MENTION_NAMES) => mentionSpans(text, { selfNames, agentNames: [] }).some(span => span.kind === 'user');
export const mentionedAgents = (text, agentNames) => [...new Set(mentionSpans(text, { selfNames: [], agentNames }).map(span => span.name))];

// The Board Thread's Agent names: every participant but the person.
export const threadAgentNames = (thread, selfMember = '나') => (thread?.participants || []).filter(name => name && name !== selfMember);

// How many unread Agent lines in this room call the person by name. The
// badge clears with the room's unread count when the room opens.
export function userMentionBadge(thread, selfNames = USER_MENTION_NAMES) {
  const unread = Number.isSafeInteger(thread?.unreadCount) ? thread.unreadCount : 0;
  if (!unread || thread.type !== 'group') return 0;
  return (thread.messages || []).slice(-unread).filter(message => message.role !== 'user' && mentionsUser(message.content, selfNames)).length;
}

export const sharedCopyAuthor = message => message.role === 'assistant' ? 'Agent' : '나';
export const sharedBlockTitle = share => `다른 대화에서 가져온 메시지 ${share.messages.length}개`;
export const moveDoneText = (count, title) => `메시지 ${count}개를 ‘${title}’ Board Thread로 옮겼습니다. 원래 대화는 그대로 남아 있습니다.`;
