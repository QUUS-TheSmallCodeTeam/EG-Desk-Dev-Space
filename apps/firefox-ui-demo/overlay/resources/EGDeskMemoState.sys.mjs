// Canvas memos (sticky notes) and their reply threads: anchor, body, replies,
// resolved state, links to cards and the 'ask an Agent' draft. Pure data: no
// DOM, no sending, no waiting. A memo ask only drafts a Chat message; the
// caller sends it and records the ask only after the send succeeded.
//
// Patterns followed (no code copied):
// - Penpot (MPL-2.0, pattern only): a comment thread pinned to a position
//   inside a frame, a per-file sequence number, a resolved flag and a first
//   comment kept apart from later replies (backend/src/app/rpc/commands/
//   comments.clj create-comment-thread / update-comment-thread; frontend
//   workspace comments update-comment-thread-position re-finds the frame).
// - Two fixed frames instead of a free size (CNV-06 decision): folded
//   240×160 shows the body, expanded 320×280 adds the reply thread and
//   [Agent에게 묻기]. The body scrolls inside the frame.
// - CopilotKit (MIT, Copyright (c) Atai Barkai): a response is only live
//   while its request is still executing (packages/react-core/src/v2/hooks/
//   use-human-in-the-loop.tsx). Here: an Agent answer joins a memo only while
//   that memo's ask is pending.
// - JSON Canvas 1.0 (MIT): edges fromNode/toNode/toEnd/label.
// Contract and product rules: docs/AI_CANVAS_ANNOTATION_LAYER.md (메모 section).

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const token = value => typeof value === 'string' && TOKEN.test(value) ? value : null;
// Chat's answer identity is an opaque run key (conversationId/runId).
// The helper permits up to 300 characters per native ID; no other memo ID
// gets this longer, two-part grammar, and the value is never treated as a path.
const CHAT_ANSWER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,299}\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,299}$/;
const answerIdentifier = value => token(value) || (typeof value === 'string' && CHAT_ANSWER_ID.test(value) ? value : null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const msTime = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const memoRevision = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const knownMemoBasis = memo => [...memo.asks, ...memo.replies].some(item => memoRevision(item.basedOnMemoRevision) !== null);
const round1 = value => Math.round(value * 10) / 10;
const round4 = value => Math.round(value * 10000) / 10000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const MEMO_LIMITS = Object.freeze({
  text: 2000, reply: 2000, replies: 200, asks: 50, links: 8,
  name: 40, linkLabel: 80, question: 500, askText: 4000, askContextReplies: 3, askContextReply: 300,
  target: 80, coordinate: 1e7,
});
export const MEMO_FRAME = Object.freeze({
  folded: Object.freeze({ width: 240, height: 160 }),
  expanded: Object.freeze({ width: 320, height: 280 }),
});
export const MEMO_ASK_STATUSES = Object.freeze(['pending', 'answered', 'cancelled']);
// How far (world px) a memo may sit outside the window it is pinned to.
export const MEMO_ANCHOR_REACH = 4000;

function body(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
}
function oneLine(value, max) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}
const worldPoint = raw => raw && finite(raw.x) && finite(raw.y) && Math.abs(raw.x) <= MEMO_LIMITS.coordinate && Math.abs(raw.y) <= MEMO_LIMITS.coordinate
  ? { x: round1(raw.x), y: round1(raw.y) } : null;
const validRect = rect => rect && finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height) && rect.width > 0 && rect.height > 0;

// A memo is pinned to the card under it (as a 0..1 ratio of the card, so it
// follows move and resize) or to the free Canvas. A card anchor also keeps
// the last world point, so the memo stays visible when the card is closed.
// offset: a memo placed beside its card keeps that world distance from the
// card's nearest edge point (the ratio), so the gap survives a resize.
// label: the card's name when the memo was pinned, shown only on the memo
// itself once that card is closed ('대상 없음'). Never part of an Agent ask.
function normAnchor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'card') {
    const cardId = token(raw.cardId);
    if (!cardId || !finite(raw.x) || !finite(raw.y)) return null;
    const anchor = { kind: 'card', cardId, x: round4(clamp(raw.x, 0, 1)), y: round4(clamp(raw.y, 0, 1)) };
    const at = worldPoint(raw.at);
    if (at) anchor.at = at;
    if (finite(raw.offset?.x) && finite(raw.offset?.y)) {
      const offset = { x: round1(clamp(raw.offset.x, -MEMO_ANCHOR_REACH, MEMO_ANCHOR_REACH)), y: round1(clamp(raw.offset.y, -MEMO_ANCHOR_REACH, MEMO_ANCHOR_REACH)) };
      if (offset.x || offset.y) anchor.offset = offset;
    }
    const label = oneLine(raw.label, MEMO_LIMITS.target);
    if (label) anchor.label = label;
    return anchor;
  }
  const point = worldPoint(raw);
  return raw.kind === 'canvas' && point ? { kind: 'canvas', ...point } : null;
}

function normAuthor(raw) {
  if (raw?.kind === 'user') return { kind: 'user' };
  if (raw?.kind !== 'agent') return null;
  const agentId = token(raw.agentId);
  if (!agentId) return null;
  const author = { kind: 'agent', agentId };
  const name = oneLine(raw.name, MEMO_LIMITS.name);
  if (name) author.name = name;
  return author;
}

function normReply(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = token(raw.id);
  const author = normAuthor(raw.author);
  const text = body(raw.text);
  if (!id || !author || !text) return null;
  const reply = { id, author, text: text.slice(0, MEMO_LIMITS.reply) };
  if (author.kind === 'agent') {
    const answerId = answerIdentifier(raw.answerId);
    if (!answerId) return null;
    reply.answerId = answerId;
    for (const key of ['askId', 'runId']) {
      const value = token(raw[key]);
      if (value) reply[key] = value;
    }
    const basedOn = memoRevision(raw.basedOnMemoRevision);
    if (reply.askId && basedOn !== null) reply.basedOnMemoRevision = basedOn;
    if (raw.truncated === true || text.length > MEMO_LIMITS.reply) reply.truncated = true;
  }
  const createdAt = msTime(raw.createdAt);
  if (createdAt !== null) reply.createdAt = createdAt;
  return reply;
}

// requestId/threadId: the Chat request the question went out as, so the
// answer finds its memo again after a restart.
function normAsk(raw) {
  const askId = token(raw?.askId), agentId = token(raw?.agentId);
  if (!askId || !agentId) return null;
  const ask = { askId, agentId, status: MEMO_ASK_STATUSES.includes(raw.status) ? raw.status : 'pending' };
  for (const key of ['requestId', 'threadId']) {
    const value = token(raw[key]);
    if (value) ask[key] = value;
  }
  const answerId = answerIdentifier(raw.answerId);
  if (ask.status === 'answered' && answerId) ask.answerId = answerId;
  const askedAt = msTime(raw.askedAt);
  if (askedAt !== null) ask.askedAt = askedAt;
  const basedOn = memoRevision(raw.basedOnMemoRevision);
  if (basedOn !== null) ask.basedOnMemoRevision = basedOn;
  return ask;
}

function normLinks(raw, ownId) {
  const links = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (links.length >= MEMO_LIMITS.links) break;
    const targetViewId = token(item?.targetViewId);
    if (!targetViewId || targetViewId === ownId || seen.has(targetViewId)) continue;
    seen.add(targetViewId);
    const link = { targetViewId };
    const label = oneLine(item.label, MEMO_LIMITS.linkLabel);
    if (label) link.label = label;
    links.push(link);
  }
  return links;
}

// A memo from the screen or a saved Board. Lenient on restore (bad replies,
// asks and links are dropped, an over-long body is cut) but a memo without an
// id or a place is refused. The input is not mutated.
export function normalizeMemoRecord(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('메모가 없습니다.');
  const id = token(raw.id);
  if (!id) throw new Error('메모 id가 없습니다.');
  const anchor = normAnchor(raw.anchor);
  if (!anchor) throw new Error('메모를 둘 자리가 없습니다.');
  const memo = { version: 1, id };
  if (Number.isSafeInteger(raw.seq) && raw.seq > 0) memo.seq = raw.seq;
  memo.anchor = anchor;
  memo.expanded = raw.expanded === true;
  memo.author = normAuthor(raw.author) || { kind: 'user' };
  memo.text = body(raw.text).slice(0, MEMO_LIMITS.text);
  const revision = memoRevision(raw.revision);
  if (revision !== null) memo.revision = revision; // Legacy records stay unknown, not versioned retroactively.
  memo.resolved = raw.resolved === true;
  memo.createdAt = msTime(raw.createdAt) ?? now;
  memo.updatedAt = Math.max(memo.createdAt, msTime(raw.updatedAt) ?? memo.createdAt);
  const replies = [];
  const replyIds = new Set(), answerIds = new Set();
  for (const item of Array.isArray(raw.replies) ? raw.replies : []) {
    if (replies.length >= MEMO_LIMITS.replies) break;
    const reply = normReply(item);
    if (!reply || replyIds.has(reply.id) || (reply.answerId && answerIds.has(reply.answerId))) continue;
    replyIds.add(reply.id);
    if (reply.answerId) answerIds.add(reply.answerId);
    replies.push(reply);
  }
  memo.replies = replies;
  const asks = [];
  const askIds = new Set();
  for (const item of Array.isArray(raw.asks) ? raw.asks : []) {
    if (asks.length >= MEMO_LIMITS.asks) break;
    const ask = normAsk(item);
    if (!ask || askIds.has(ask.askId)) continue;
    askIds.add(ask.askId);
    asks.push(ask);
  }
  memo.asks = asks;
  for (const reply of replies) {
    if (reply.basedOnMemoRevision === undefined) continue;
    const ask = asks.find(item => item.askId === reply.askId && item.agentId === reply.author.agentId
      && item.status === 'answered' && item.answerId === reply.answerId);
    if (!ask || ask.basedOnMemoRevision !== reply.basedOnMemoRevision) delete reply.basedOnMemoRevision;
  }
  memo.links = normLinks(raw.links, id);
  return memo;
}

// Topmost card under the point wins (cards are passed in paint order, last on
// top), as Penpot re-finds the frame for a moved thread.
// cards: [{ id, rect: {x, y, width, height} }] in Canvas world coordinates.
export function memoAnchorAt(point, cards = []) {
  const at = worldPoint(point);
  if (!at) return null;
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index];
    const cardId = token(card?.id);
    const rect = card?.rect;
    if (!cardId || !validRect(rect)) continue;
    if (at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height) {
      return memoAnchorBeside(at, card);
    }
  }
  return { kind: 'canvas', ...at };
}

// Pin to this card wherever the memo is: on it (ratio only) or beside it
// (ratio of the card's nearest edge point plus the world offset from there).
// card: { id, rect, label? }.
export function memoAnchorBeside(point, card) {
  const at = worldPoint(point);
  const cardId = token(card?.id);
  const rect = card?.rect;
  if (!at || !cardId || !validRect(rect)) return null;
  const near = { x: clamp(at.x, rect.x, rect.x + rect.width), y: clamp(at.y, rect.y, rect.y + rect.height) };
  return normAnchor({ kind: 'card', cardId, x: (near.x - rect.x) / rect.width, y: (near.y - rect.y) / rect.height, at,
    offset: { x: at.x - near.x, y: at.y - near.y }, label: card.label });
}

// target: the window the memo is about when it opens beside it (Dock [메모]
// with a window selected). Without one the point decides, as on a drop.
export function createMemoRecord({ id, seq, point, cards = [], target = null, text = '', now = Date.now() } = {}) {
  const anchor = target ? memoAnchorBeside(point, target) : memoAnchorAt(point, cards);
  if (!anchor) throw new Error('메모를 둘 자리가 없습니다.');
  if (body(text).length > MEMO_LIMITS.text) throw new Error(`메모는 ${MEMO_LIMITS.text}자까지 쓸 수 있습니다.`);
  return normalizeMemoRecord({ id, seq, anchor, text, revision: 1, author: { kind: 'user' }, createdAt: now, updatedAt: now }, { now });
}

// The user dropped the memo somewhere else: re-pin to whatever is under it.
// A memo that sat beside its window (offset) and lands on empty Canvas stays
// linked to that window; a memo lifted off the window it lay on comes free.
export function moveMemo(memo, point, cards = [], { now = Date.now() } = {}) {
  let anchor = memoAnchorAt(point, cards);
  if (!anchor) throw new Error('메모를 둘 자리가 없습니다.');
  if (anchor.kind === 'canvas' && memo.anchor?.kind === 'card' && memo.anchor.offset) {
    const current = cards.find(card => card?.id === memo.anchor.cardId && validRect(card.rect));
    if (current) anchor = memoAnchorBeside(point, { ...current, label: current.label || memo.anchor.label }) || anchor;
  }
  return { ...memo, anchor, updatedAt: Math.max(memo.updatedAt, now) };
}

// [다시 연결]: pin the memo, where it is now, to the window the user chose.
export function attachMemoToCard(memo, card, point, { now = Date.now() } = {}) {
  const anchor = token(card?.id) !== memo.id ? memoAnchorBeside(point, card) : null;
  if (!anchor) throw new Error('메모를 이을 대상을 찾을 수 없습니다.');
  return { ...memo, anchor, updatedAt: Math.max(memo.updatedAt, now) };
}

// The thin line from a memo to the window it is pinned to, in world
// coordinates: along the line between the two centres, from the memo's edge
// to the window's edge. null when the memo lies on or touches the window (the
// badge already names it). angle: degrees, for a rotated 1px box.
export function memoTetherSegment(memoRect, targetRect, { minLength = 8 } = {}) {
  if (!validRect(memoRect) || !validRect(targetRect)) return null;
  const from = { x: memoRect.x + memoRect.width / 2, y: memoRect.y + memoRect.height / 2 };
  const dx = targetRect.x + targetRect.width / 2 - from.x, dy = targetRect.y + targetRect.height / 2 - from.y;
  if (!dx && !dy) return null;
  const reach = rect => Math.min(dx ? rect.width / 2 / Math.abs(dx) : Infinity, dy ? rect.height / 2 / Math.abs(dy) : Infinity);
  const exit = reach(memoRect), enter = 1 - reach(targetRect);
  if (!(enter > exit)) return null;
  const length = (enter - exit) * Math.hypot(dx, dy);
  if (length < minLength) return null;
  return { x1: round1(from.x + dx * exit), y1: round1(from.y + dy * exit), x2: round1(from.x + dx * enter), y2: round1(from.y + dy * enter),
    length: round1(length), angle: Math.round(Math.atan2(dy, dx) * 18000 / Math.PI) / 100 };
}

// '답 기다리는 중' elapsed text for a pending ask. '' when the ask has no time.
export function memoWaitLabel(askedAt, now = Date.now()) {
  if (msTime(askedAt) === null || !finite(now)) return '';
  const minutes = Math.floor(Math.max(0, now - askedAt) / 60000);
  if (minutes < 1) return '방금 물음';
  if (minutes < 60) return `${minutes}분째`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}시간 ${minutes % 60}분째` : `${hours}시간째`;
  return `${Math.floor(hours / 24)}일째`;
}

// World position of the memo's top-left corner. attached: pinned to a card
// that is on the Canvas now. missing: its card is gone, last point shown.
export function memoPosition(memo, cards = []) {
  const anchor = memo?.anchor;
  if (anchor?.kind === 'canvas') return { x: anchor.x, y: anchor.y, attached: false, missing: false };
  if (anchor?.kind !== 'card') return null;
  const card = cards.find(item => item?.id === anchor.cardId && validRect(item.rect));
  if (card) {
    return { x: round1(card.rect.x + anchor.x * card.rect.width + (anchor.offset?.x || 0)),
      y: round1(card.rect.y + anchor.y * card.rect.height + (anchor.offset?.y || 0)), attached: true, missing: false };
  }
  return anchor.at ? { x: anchor.at.x, y: anchor.at.y, attached: false, missing: true } : null;
}

// The frame the memo is drawn in. Folding is a view choice and leaves
// updatedAt alone: the memo's content did not change.
export function memoFrame(memo) {
  return memo?.expanded === true ? MEMO_FRAME.expanded : MEMO_FRAME.folded;
}

export function setMemoExpanded(memo, expanded) {
  const next = expanded === true;
  if (next === memo.expanded) return memo;
  return { ...memo, expanded: next };
}

export function editMemoText(memo, text, { now = Date.now() } = {}) {
  const next = body(text);
  if (next.length > MEMO_LIMITS.text) throw new Error(`메모는 ${MEMO_LIMITS.text}자까지 쓸 수 있습니다.`);
  if (next === memo.text) return memo;
  const previous = memoRevision(memo.revision) ?? Math.max(0,
    ...[...memo.asks, ...memo.replies].map(item => memoRevision(item.basedOnMemoRevision) ?? 0));
  const revision = previous + 1;
  // Never wrap an exhausted counter into a falsely matching historical version.
  return { ...memo, text: next, revision: Number.isSafeInteger(revision) ? revision : undefined, updatedAt: Math.max(memo.updatedAt, now) };
}

export function setMemoResolved(memo, resolved, { now = Date.now() } = {}) {
  const next = resolved === true;
  if (next === memo.resolved) return memo;
  return { ...memo, resolved: next, updatedAt: Math.max(memo.updatedAt, now) };
}

// Penpot numbers threads per file; here per Board: next number after the
// highest one in use.
export function nextMemoSeq(memos = []) {
  return memos.reduce((max, memo) => Number.isSafeInteger(memo?.seq) && memo.seq > max ? memo.seq : max, 0) + 1;
}

export function linkMemo(memo, targetViewId, label, { now = Date.now() } = {}) {
  const id = token(targetViewId);
  if (!id || id === memo.id) throw new Error('메모를 이을 대상을 찾을 수 없습니다.');
  const others = memo.links.filter(link => link.targetViewId !== id);
  if (others.length >= MEMO_LIMITS.links) throw new Error(`메모 하나에는 ${MEMO_LIMITS.links}개까지 이을 수 있습니다.`);
  const links = normLinks([...others, { targetViewId: id, label }], memo.id);
  return { ...memo, links, updatedAt: Math.max(memo.updatedAt, now) };
}

export function unlinkMemo(memo, targetViewId, { now = Date.now() } = {}) {
  if (!memo.links.some(link => link.targetViewId === targetViewId)) return memo;
  return { ...memo, links: memo.links.filter(link => link.targetViewId !== targetViewId), updatedAt: Math.max(memo.updatedAt, now) };
}

// JSON Canvas 1.0 edges for export or drawing: memo node -> card node.
export function memoLinksForCanvas(memo) {
  return (memo?.links || []).map(link => ({ id: `${memo.id}->${link.targetViewId}`, fromNode: memo.id, toNode: link.targetViewId, toEnd: 'arrow',
    ...(link.label ? { label: link.label } : {}) }));
}

export const memoAuthorName = author => author?.kind === 'agent' ? author.name || 'Agent' : '나';

// Draft for [Agent에게 묻기]: one Chat message that carries the memo body, the
// card it sits on (target), its latest replies and the question, plus ids for
// routing the answer back. It does not change the memo; call recordMemoAsk
// after the message was sent.
export function memoAskDraft(memo, { agentId, agentName, question = '', target = '' } = {}) {
  const agent = token(agentId);
  if (!agent) throw new Error('물어볼 Agent를 골라 주세요.');
  const ask = oneLine(question, MEMO_LIMITS.question + 1) || '';
  if (ask.length > MEMO_LIMITS.question) throw new Error(`질문은 ${MEMO_LIMITS.question}자까지 쓸 수 있습니다.`);
  if (!memo?.text && !ask) throw new Error('메모 내용이나 질문을 입력해 주세요.');
  const used = new Set(memo.asks.map(item => item.askId));
  let n = memo.asks.length + 1;
  while (used.has(`ask-${n}`)) n += 1;
  const recent = memo.replies.slice(-MEMO_LIMITS.askContextReplies)
    .map(reply => `${memoAuthorName(reply.author)}: ${reply.text.replace(/\s+/g, ' ').slice(0, MEMO_LIMITS.askContextReply)}`);
  const parts = [`[메모${memo.seq ? ` #${memo.seq}` : ''} · ${memo.id}]`, memo.text || '(내용 없음)'];
  const targetLabel = oneLine(target, MEMO_LIMITS.target);
  if (targetLabel) parts.push(`대상: ${targetLabel}`);
  if (recent.length) parts.push(`최근 답글:\n${recent.join('\n')}`);
  if (ask) parts.push(`질문: ${ask}`);
  const draft = { memoId: memo.id, askId: `ask-${n}`, agentId: agent, text: parts.join('\n\n').slice(0, MEMO_LIMITS.askText),
    contextCardIds: [...new Set([...(memo.anchor?.kind === 'card' ? [memo.anchor.cardId] : []), ...memo.links.map(link => link.targetViewId)])] };
  const name = oneLine(agentName, MEMO_LIMITS.name);
  if (name) draft.agentName = name;
  // A new question observes the live body, even on an unversioned legacy memo.
  // This baseline is only for this new draft; historical missing bases stay missing.
  const revision = memoRevision(memo.revision) ?? (knownMemoBasis(memo) ? null : 0);
  if (revision !== null) draft.basedOnMemoRevision = revision;
  return draft;
}

// The ask message was sent: the memo now waits for that Agent's answer.
// requestId/threadId name the Chat request so the answer is routed back.
export function recordMemoAsk(memo, draft, { now = Date.now(), requestId, threadId } = {}) {
  if (draft?.memoId !== memo.id) throw new Error('다른 메모의 질문입니다.');
  const askId = token(draft.askId), agentId = token(draft.agentId);
  if (!askId || !agentId) throw new Error('질문 기록이 올바르지 않습니다.');
  if (memo.asks.some(item => item.askId === askId)) return memo;
  if (memo.asks.length >= MEMO_LIMITS.asks) throw new Error('이 메모의 질문 기록이 가득 찼습니다.');
  const ask = { askId, agentId, status: 'pending', askedAt: now };
  // This is the submitted draft's snapshot, not the possibly edited memo at acceptance.
  const basedOn = memoRevision(draft.basedOnMemoRevision);
  if (basedOn !== null) ask.basedOnMemoRevision = basedOn;
  if (token(requestId)) ask.requestId = requestId;
  if (token(threadId)) ask.threadId = threadId;
  const observedBody = memoRevision(memo.revision) === null && basedOn === 0 && !knownMemoBasis(memo);
  return { ...memo, ...(observedBody ? { revision: 0 } : {}), asks: [...memo.asks, ask], updatedAt: Math.max(memo.updatedAt, now) };
}

// The memo and pending ask a Chat request belongs to, or null.
export function findPendingMemoAsk(memos, requestId) {
  const id = token(requestId);
  if (!id) return null;
  for (const memo of memos || []) {
    const ask = (memo?.asks || []).find(item => item.status === 'pending' && item.requestId === id);
    if (ask) return { memo, ask };
  }
  return null;
}

// A finished Chat run as a memo reply candidate: its answerId, runId and the
// Agent's text (assistant messages joined). null while the run is not
// completed or has no text yet.
export function memoReplyFromRun(run) {
  if (!run || run.status !== 'completed') return null;
  const answerId = answerIdentifier(run.answerId);
  if (!answerId) return null;
  if (answerId.includes('/') && (run.conversationId != null || run.runId != null)
      && (typeof run.conversationId !== 'string' || typeof run.runId !== 'string'
        || answerId !== `${run.conversationId}/${run.runId}`)) return null;
  const text = body((Array.isArray(run.messages) ? run.messages : [])
    .filter(message => message?.role === 'assistant' && !['error', 'failed'].includes(message.status))
    .map(message => typeof message.content === 'string' ? message.content : typeof message.text === 'string' ? message.text : '')
    .filter(Boolean).join('\n\n'));
  if (!text) return null;
  const reply = { answerId, text };
  const runId = token(run.runId);
  if (runId) reply.runId = runId;
  return reply;
}

export function cancelMemoAsk(memo, askId, { now = Date.now() } = {}) {
  const index = memo.asks.findIndex(item => item.askId === askId && item.status === 'pending');
  if (index < 0) return memo;
  const asks = memo.asks.slice();
  asks[index] = { ...asks[index], status: 'cancelled' };
  return { ...memo, asks, updatedAt: Math.max(memo.updatedAt, now) };
}

export const pendingMemoAsks = memo => (memo?.asks || []).filter(item => item.status === 'pending');

// Add one reply. A user reply needs text (over the limit is refused). An Agent
// reply needs the answerId of its Chat answer: the same answerId joins a memo
// once only, and an answer to an ask joins only while that ask is pending and
// only from the Agent that was asked. Over-long Agent text is cut and marked
// truncated; the full answer stays in Chat under answerId.
// Returns { memo, appended, reason } with reason null | 'duplicate' |
// 'ask-closed' | 'ask-mismatch'; memo is the same object when nothing changed.
export function appendMemoReply(memo, reply = {}, { now = Date.now() } = {}) {
  const author = normAuthor(reply.author);
  if (!author) throw new Error('답글 작성자가 올바르지 않습니다.');
  const text = body(reply.text);
  if (!text) throw new Error('답글 내용을 입력해 주세요.');
  const answerId = author.kind === 'agent' ? answerIdentifier(reply.answerId) : null;
  if (author.kind === 'agent' && !answerId) throw new Error('Agent 답글에는 답변 id가 필요합니다.');
  if (answerId && memo.replies.some(item => item.answerId === answerId)) return { memo, appended: false, reason: 'duplicate' };
  if (memo.replies.length >= MEMO_LIMITS.replies) throw new Error('이 메모의 답글이 가득 찼습니다.');
  const used = new Set(memo.replies.map(item => item.id));
  let n = memo.replies.length + 1;
  while (used.has(`reply-${n}`)) n += 1;
  const next = { id: `reply-${n}`, author, text, createdAt: now };
  let asks = memo.asks;
  if (author.kind === 'agent') {
    next.answerId = answerId;
    const askId = reply.askId === undefined ? null : token(reply.askId);
    if (reply.askId !== undefined) {
      const index = memo.asks.findIndex(item => item.askId === askId);
      if (index < 0 || memo.asks[index].status !== 'pending') return { memo, appended: false, reason: 'ask-closed' };
      if (memo.asks[index].agentId !== author.agentId) return { memo, appended: false, reason: 'ask-mismatch' };
      asks = memo.asks.slice();
      asks[index] = { ...asks[index], status: 'answered', answerId };
      next.askId = askId;
      const basedOn = memoRevision(memo.asks[index].basedOnMemoRevision);
      if (basedOn !== null) next.basedOnMemoRevision = basedOn;
    }
    const runId = token(reply.runId);
    if (runId) next.runId = runId;
    if (text.length > MEMO_LIMITS.reply) {
      next.text = text.slice(0, MEMO_LIMITS.reply);
      next.truncated = true;
    }
  } else if (text.length > MEMO_LIMITS.reply) {
    throw new Error(`답글은 ${MEMO_LIMITS.reply}자까지 쓸 수 있습니다.`);
  }
  return { memo: { ...memo, replies: [...memo.replies, next], asks, updatedAt: Math.max(memo.updatedAt, now) }, appended: true, reason: null };
}
