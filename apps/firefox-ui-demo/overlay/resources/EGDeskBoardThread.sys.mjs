// CHAT-10: several Agents answering in one Board Thread.
// - Where a Board Thread message goes (D-M2): only the Agents the person
//   @mentioned answer; with no mention only the room's Lead does. A mention or
//   an Agent Lead goes through POST /chat/board/send (each member answers in a
//   conversation of its own with the Board block); a plain-Codex Lead with no
//   mention keeps the ordinary /chat/send (the same single answer).
// - Each member's run as the room shows it (작업 중 · 막힘 · 완료), from the
//   board send answer and the run.board attribution of run.started.
// - The room's members as the chat store keeps them (GET/POST
//   /chat/board/members, chat-store v3 room_members) and back.
// Pure: no DOM, no fetch. The runtime's matching rules live in
// helper/codex-chat-runtime.mjs (boardMentions, boardRecipients).
import { displayProfileAvatar, isProfileId, isRunBusy } from './EGDeskChatState.sys.mjs';

export const BOARD_SEND_PATH = '/chat/board/send';
export const BOARD_MEMBERS_PATH = '/chat/board/members';
const SELF_NAME = '나';
const MAX_RECENT = 12;
const MAX_RECENT_TEXT = 4000;
const MAX_LABEL = 80;
const ROLES = ['owner', 'admin', 'member'];
const AGENT_LINK = /\[[^\]\n]{0,200}\]\((agent:\/\/[^)\s]{1,200})\)/g;
const BEFORE_MENTION = /[\s([{"'“‘]/u;
const AFTER_MENTION = /[\s.,!?;:)\]}"'”’·…]/u;
// Fields /chat/board/send refuses or picks per member itself.
const NOT_FOR_BOARD = ['conversationId', 'profileEnabled', 'executionPolicy', 'stateless', 'agentProfile', 'systemPrompt', 'toolMode', 'profileId', 'profileRevision'];

const text = value => (typeof value === 'string' ? value.trim() : '');
const own = (object, key) => !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
const label = value => Array.from(text(value).normalize('NFC').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')).slice(0, MAX_LABEL).join('').trim();
const namesOf = thread => Array.from(new Set((Array.isArray(thread?.participants) ? thread.participants : []).filter(name => text(name))));
const linksOf = thread => (thread?.participantAgents && typeof thread.participantAgents === 'object' && !Array.isArray(thread.participantAgents) ? thread.participantAgents : {});

export const isBoardRoom = thread => thread?.type === 'group';

/** The room's Agents as { name, profileId } (profileId null for the plain Codex or an earlier name). */
export function boardAgents(thread, { selfName = SELF_NAME } = {}) {
  const links = linksOf(thread);
  return namesOf(thread).filter(name => name !== selfName)
    .map(name => ({ name, profileId: own(links, name) && isProfileId(links[name]?.profileId) ? links[name].profileId : null }));
}

/**
 * The names the message @mentions, in order, as { name, profileId }. Same
 * rules as the bridge: [이름](agent://id) links, then plain @이름 with the
 * longest names first, so '@디자인 리뷰어' is not read as '@디자인'.
 */
export function boardMentions(message, thread, { selfName = SELF_NAME } = {}) {
  const agents = boardAgents(thread, { selfName });
  const value = typeof message === 'string' ? message : '';
  const found = new Map();
  const note = (agent, index) => { const key = agent.profileId || `name:${agent.name}`; if (!found.has(key)) found.set(key, { agent, index }); };
  for (const match of value.matchAll(AGENT_LINK)) {
    const id = match[1].slice('agent://'.length).split(/[/?#]/)[0];
    const agent = agents.find(candidate => candidate.profileId === id);
    if (agent) note(agent, match.index);
  }
  const masked = [...value.replace(AGENT_LINK, link => ' '.repeat(link.length))];
  for (const agent of [...agents].sort((a, b) => [...b.name].length - [...a.name].length)) {
    const token = [...`@${agent.name}`];
    for (let at = 0; at + token.length <= masked.length; at++) {
      if (token.some((char, offset) => masked[at + offset] !== char)) continue;
      const before = masked[at - 1], after = masked[at + token.length];
      if ((before !== undefined && !BEFORE_MENTION.test(before)) || (after !== undefined && !AFTER_MENTION.test(after))) continue;
      note(agent, at);
      masked.fill(' ', at, at + token.length);
    }
  }
  return [...found.values()].sort((a, b) => a.index - b.index).map(entry => entry.agent);
}

/** The room's members as chat-store room_members inputs, in the room's order. */
export function boardStoreMembers(thread, { selfName = SELF_NAME } = {}) {
  if (!isBoardRoom(thread)) return [];
  const links = linksOf(thread);
  const roles = thread.participantRoles && typeof thread.participantRoles === 'object' ? thread.participantRoles : {};
  const members = [], keys = new Set();
  for (const name of namesOf(thread)) {
    const clean = label(name);
    if (!clean) continue;
    const self = name === selfName;
    const role = ROLES.includes(roles[name]) ? roles[name] : self ? 'owner' : 'member';
    const profileId = !self && own(links, name) && isProfileId(links[name]?.profileId) ? links[name].profileId : null;
    const key = self ? 'user' : profileId ? `agent:${profileId}` : `label:${clean}`;
    if (keys.has(key) || (self && keys.has('user'))) continue;
    keys.add(key);
    members.push(self ? { kind: 'user', role } : profileId ? { kind: 'agent', profileId, label: clean, role } : { kind: 'agent', label: clean, role });
  }
  return members;
}

/**
 * Thread fields (participants, participantRoles, participantAgents) from the
 * store's members, or null when the room already shows exactly these. Faces
 * captured at invite are kept; the person reads as `selfName`.
 */
export function threadFieldsFromStoreMembers(thread, members, { selfName = SELF_NAME } = {}) {
  if (!isBoardRoom(thread) || !Array.isArray(members) || !members.length) return null;
  const before = linksOf(thread);
  const avatarFor = (name, profileId) => {
    const match = own(before, name) ? before[name] : Object.values(before).find(link => profileId && link?.profileId === profileId);
    return displayProfileAvatar(match?.avatar) || null;
  };
  const participants = [], participantRoles = {}, participantAgents = {};
  for (const member of members) {
    if (!member || typeof member !== 'object') continue;
    const name = member.kind === 'user' ? selfName : label(member.label) || (isProfileId(member.profileId) ? member.profileId : '');
    if (!name || participants.includes(name)) continue;
    participants.push(name);
    participantRoles[name] = ROLES.includes(member.role) ? member.role : member.kind === 'user' ? 'owner' : 'member';
    if (member.kind === 'agent') participantAgents[name] = { profileId: isProfileId(member.profileId) ? member.profileId : null, avatar: avatarFor(name, member.profileId) };
  }
  if (!participants.length) return null;
  const next = { participants, participantRoles, participantAgents };
  const same = JSON.stringify(namesOf(thread)) === JSON.stringify(participants)
    && JSON.stringify(boardStoreMembers(thread, { selfName })) === JSON.stringify(boardStoreMembers({ type: 'group', ...next }, { selfName }));
  return same ? null : next;
}

/**
 * What to do with a GET /chat/board/members answer when the room opens:
 * { restore: thread fields } when the store has members that differ from the
 * screen, { save: members } when the store has none yet (the Desk pref's
 * members move into it once), or null.
 */
export function boardMembersSync(thread, answer, { selfName = SELF_NAME } = {}) {
  if (!isBoardRoom(thread) || !answer || typeof answer !== 'object') return null;
  const saved = Array.isArray(answer.members) ? answer.members : [];
  if (saved.length) {
    const restore = threadFieldsFromStoreMembers(thread, saved, { selfName });
    return restore ? { restore } : null;
  }
  const members = boardStoreMembers(thread, { selfName });
  return members.length ? { save: members } : null;
}

/** POST /chat/board/members body for the room as it is now. */
export function boardMembersRequest(thread, clientThreadId, { selfName = SELF_NAME } = {}) {
  return { clientThreadId, members: boardStoreMembers(thread, { selfName }) };
}

/** The room's last messages quoted in the Board block (oldest first, ≤ 12). */
export function boardRecentMessages(thread, { selfName = SELF_NAME } = {}) {
  const rows = [];
  for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
    if (!['user', 'assistant'].includes(message?.role) || ['submitting', 'failed'].includes(message.status)) continue;
    const body = text(message.content).slice(0, MAX_RECENT_TEXT).trim();
    if (!body) continue;
    const author = label(message.role === 'user' ? selfName : message.authorName || 'Codex') || null;
    rows.push({ role: message.role === 'user' ? 'user' : 'agent', text: body, ...(author ? { author } : {}) });
  }
  return rows.slice(-MAX_RECENT);
}

/**
 * Where this Board Thread message goes. null = the ordinary /chat/send (not a
 * Board Thread, or no mention and a plain-Codex Lead); { path, body } = POST
 * /chat/board/send; { error: code } = refused before sending.
 */
export function boardSendPlan(thread, chatRequest, { selfName = SELF_NAME } = {}) {
  if (!isBoardRoom(thread) || !chatRequest || typeof chatRequest.message !== 'string') return null;
  const mentioned = boardMentions(chatRequest.message, thread, { selfName });
  const routable = mentioned.filter(agent => agent.profileId);
  const lead = chatRequest.profileEnabled === true && isProfileId(chatRequest.profileId) ? chatRequest.profileId : null;
  // Only the plain Codex was mentioned (it has no Agent of its own): the room's own conversation answers.
  if (mentioned.length && !routable.length && !lead) return null;
  if (!routable.length && !lead) return null;
  if (chatRequest.executionPolicy) return routable.length ? { error: 'BOARD_BROWSER_BOUNDED' } : null;
  const body = {};
  for (const [key, value] of Object.entries(chatRequest)) if (!NOT_FOR_BOARD.includes(key)) body[key] = value;
  body.members = boardStoreMembers(thread, { selfName });
  if (lead) {
    body.leadProfileId = lead;
    body.profileId = lead;
    if (Number.isSafeInteger(chatRequest.profileRevision)) body.profileRevision = chatRequest.profileRevision;
  }
  const recent = boardRecentMessages(thread, { selfName });
  if (recent.length) body.recentMessages = recent;
  return { path: BOARD_SEND_PATH, body, mentioned: routable.map(agent => agent.profileId) };
}

/**
 * A /chat/board/send answer split for the screen: `lead` is a /chat/send-like
 * answer for the Lead's run in the room's own conversation (null when the
 * Lead did not start), `members` the other recipients, `routes` every
 * recipient's outcome kept on the room for its chips.
 */
export function boardSendOutcome(result, requestId, { now = Date.now() } = {}) {
  const rows = Array.isArray(result?.recipients) ? result.recipients.filter(row => row && typeof row === 'object' && isProfileId(row.profileId)) : [];
  const room = typeof result?.clientThreadId === 'string' ? result.clientThreadId : null;
  const leadRow = rows.find(row => row.status === 'started' && row.requestId === requestId && (!room || row.clientThreadId === room)) || null;
  const lead = leadRow && leadRow.conversationId && leadRow.runId ? {
    accepted: true, requestId, clientThreadId: leadRow.clientThreadId, conversationId: leadRow.conversationId, runId: leadRow.runId,
    ...(leadRow.duplicate ? { duplicate: true } : {}),
  } : null;
  const members = rows.filter(row => row !== leadRow && row.status === 'started' && row.conversationId && row.runId && typeof row.requestId === 'string');
  const routes = {};
  for (const row of rows) {
    routes[row.profileId] = { status: ['started', 'deferred', 'failed'].includes(row.status) ? row.status : 'failed',
      reason: row.reason === 'mentioned' ? 'mentioned' : 'lead', requestId: typeof row.requestId === 'string' ? row.requestId : null,
      code: typeof row.code === 'string' ? row.code : null, at: now };
  }
  return { accepted: result?.accepted === true && rows.some(row => row.status === 'started'), lead, members, routes,
    failure: rows.find(row => row.status !== 'started') || null };
}

/** The pending request a member's answer is shown under: in this room, as that Agent. */
export function boardMemberRequest(row, roomThread, { profiles = [] } = {}) {
  const profile = (Array.isArray(profiles) ? profiles : []).find(candidate => candidate?.id === row.profileId) || null;
  const links = linksOf(roomThread);
  const name = Object.keys(links).find(key => links[key]?.profileId === row.profileId) || null;
  const authorName = text(profile?.name) || text(row.label) || name || 'Agent';
  const authorAvatar = displayProfileAvatar(profile?.avatar) || displayProfileAvatar(name ? links[name]?.avatar : null) || null;
  return { requestId: row.requestId, clientThreadId: row.clientThreadId, localThreadId: roomThread.id, conversationId: row.conversationId,
    authorName, ...(authorAvatar ? { authorAvatar } : {}) };
}

/** Marks a run as one Board member's (from the send answer or run.started details.board). */
export function noteBoardRun(run, board, { member = false } = {}) {
  if (!run || !board || typeof board !== 'object' || !isProfileId(board.profileId)) return run;
  run.board = { profileId: board.profileId, reason: board.reason === 'mentioned' ? 'mentioned' : 'lead',
    roomClientThreadId: typeof board.roomClientThreadId === 'string' ? board.roomClientThreadId : run.board?.roomClientThreadId || null };
  if (member) run.boardMember = true;
  return run;
}

/** An answer of a member other than the Lead: it never rebinds the room's own conversation. */
export const isBoardMemberRun = run => run?.boardMember === true;

/**
 * One member's state in the room: the last run attributed to that Agent
 * (run.board), else the last board send's outcome for it. null = nothing to say.
 */
export function boardMemberState(profileId, { runs = [], routes = {}, connectedRunView = null } = {}) {
  if (!isProfileId(profileId)) return null;
  const run = (Array.isArray(runs) ? runs : []).findLast(candidate => candidate?.board?.profileId === profileId) || null;
  const route = own(routes, profileId) ? routes[profileId] : null;
  const routeNewer = route && run && route.requestId && run.requestId !== route.requestId && route.status !== 'started';
  if (run && !routeNewer) {
    if (isRunBusy(run)) {
      const working = typeof connectedRunView === 'function' ? connectedRunView(run) : { state: 'working' };
      if (!working) return null;
      if (working?.state === 'approval') return { kind: 'waiting', label: '승인 대기' };
      if (working?.state === 'question') return { kind: 'waiting', label: '답변 대기' };
      if (working?.state === 'stopping') return { kind: 'active', label: '중지하는 중' };
      return { kind: 'active', label: '작업 중' };
    }
    if (run.status === 'completed') return { kind: 'done', label: '완료' };
    if (['failed', 'interrupted', 'cancelled', 'unavailable'].includes(run.status)) return { kind: 'blocked', label: '막힘' };
    return null;
  }
  if (!route) return null;
  if (route.status === 'deferred') return { kind: 'waiting', label: '차례 대기' };
  if (route.status === 'failed') return { kind: 'blocked', label: '막힘' };
  if (route.status === 'started') return { kind: 'active', label: '작업 중' };
  return null;
}

const SEND_ERROR_TEXT = Object.freeze({
  BOARD_NO_RECIPIENT: '이 Board Thread에서 답할 Agent가 없습니다. @로 Agent를 부르거나 방의 Agent를 정해 주세요.',
  BOARD_MEMBERS_REQUIRED: '이 Board Thread의 참여자를 확인하지 못했습니다. 다시 보내 주세요.',
  INVALID_BOARD_MEMBERS: '이 Board Thread의 참여자 정보가 올바르지 않습니다. 참여자를 확인해 주세요.',
  INVALID_BOARD_MESSAGES: '최근 대화를 함께 보내지 못했습니다. 다시 보내 주세요.',
  INVALID_BOARD_SEND: '이 Board Thread 메시지를 보낼 수 없습니다. 다시 보내 주세요.',
  BOARD_CONCURRENCY_LIMIT: '이 Board Thread에서는 Agent 2명까지 동시에 일합니다. 앞 작업이 끝난 뒤 다시 보내 주세요.',
  BOARD_BROWSER_BOUNDED: 'Browser 조작을 맡긴 메시지는 Board Thread의 한 Agent에게만 보낼 수 있습니다. @부름을 빼고 보내 주세요.',
});
/** Korean text for a refused Board Thread send, or null for other codes. */
export const boardSendErrorText = code => (own(SEND_ERROR_TEXT, code) ? SEND_ERROR_TEXT[code] : null);

// CHAT-10 robustness (a): a member's run events can arrive before the HTTP
// answer of /chat/board/send names its run. The bridge names a member's
// request `${roomRequestId}~<hash>`, so while that send is pending its
// members' events are held (bounded per send, short TTL) and replayed once
// the runs are registered. Anything else is not held.
const EARLY_EVENTS_MAX = 64;
const EARLY_EVENTS_TTL_MS = 15000;
const memberRequestOf = (requestId, roomRequestId) => typeof requestId === 'string' && typeof roomRequestId === 'string' && roomRequestId
  && requestId.startsWith(`${roomRequestId.slice(0, 200)}~`);

export function createBoardEarlyEvents({ max = EARLY_EVENTS_MAX, ttlMs = EARLY_EVENTS_TTL_MS, now = () => Date.now() } = {}) {
  const pending = new Map();  // room requestId → [{ event, at }]
  const prune = rows => { const cutoff = now() - ttlMs; while (rows.length && rows[0].at < cutoff) rows.shift(); return rows; };
  return {
    open(requestId) { if (typeof requestId === 'string' && requestId && !pending.has(requestId)) pending.set(requestId, []); },
    /** true when the event was kept for a pending board send. */
    hold(event) {
      for (const [requestId, rows] of pending) {
        if (!memberRequestOf(event?.requestId, requestId)) continue;
        prune(rows).push({ event, at: now() });
        if (rows.length > max) rows.splice(0, rows.length - max);
        return true;
      }
      return false;
    },
    /** The held events of this send in arrival order (expired ones dropped); the send is no longer pending. */
    release(requestId) { const rows = pending.get(requestId) || []; pending.delete(requestId); return prune(rows).map(row => row.event); },
    close(requestId) { pending.delete(requestId); },
    size(requestId) { return pending.has(requestId) ? prune(pending.get(requestId)).length : 0; },
  };
}

// CHAT-10 robustness (b): after a restart the other members' answers live
// only in their own conversations (board-member:…). The room's history keeps
// a 'board.routed' line naming each member's conversation; those answers are
// read back from the local store and shown in the room again.
const MEMBER_THREAD_PREFIX = 'board-member:';
export const isBoardMemberThreadId = id => typeof id === 'string' && id.startsWith(MEMBER_THREAD_PREFIX);

/** memberClientThreadId → { profileId, label } from a room's 'board.routed' history events. */
export function boardRoutedMembers(events) {
  const found = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.event !== 'board.routed') continue;
    for (const row of Array.isArray(event.details?.recipients) ? event.details.recipients : []) {
      if (!row || !isBoardMemberThreadId(row.clientThreadId) || !isProfileId(row.profileId) || row.status !== 'started') continue;
      found.set(row.clientThreadId, { profileId: row.profileId, label: label(row.label) || null });
    }
  }
  return found;
}

const timeOf = value => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
const sameMessage = (a, b) => [['localMessageId', 'localMessageId'], ['id', 'id']].some(([x, y]) => a[x] && a[x] === b[y])
  || !!(a.runId && a.runId === b.runId && a.role === b.role && a.boardMemberProfileId && a.boardMemberProfileId === b.boardMemberProfileId);

/**
 * The room's messages with one member's stored answers folded in: only that
 * member's finished answers (its copy of the person's message stays out),
 * under its own name and face, placed by time, never twice.
 */
export function foldBoardMemberAnswers(roomThread, memberMessages, member, { profiles = [] } = {}) {
  const current = Array.isArray(roomThread?.messages) ? roomThread.messages : [];
  if (!member || !isProfileId(member.profileId)) return current;
  const who = boardMemberRequest({ profileId: member.profileId, label: member.label }, roomThread || {}, { profiles });
  const messages = [...current];
  for (const stored of Array.isArray(memberMessages) ? memberMessages : []) {
    if (stored?.role !== 'assistant' || !['complete', 'completed'].includes(stored.status ?? 'complete') || !text(stored.content)) continue;
    const { localSeq: _seq, ...rest } = stored;
    const answer = { ...rest, authorName: who.authorName, ...(who.authorAvatar ? { authorAvatar: who.authorAvatar } : {}),
      boardMemberProfileId: member.profileId, localHistory: true };
    if (messages.some(message => sameMessage(answer, message) || sameMessage(message, answer))) continue;
    const at = timeOf(answer.createdAt);
    let index = messages.length;
    if (Number.isFinite(at)) { const after = messages.findIndex(message => timeOf(message.createdAt) > at); if (after >= 0) index = after; }
    messages.splice(index, 0, answer);
  }
  return messages;
}
