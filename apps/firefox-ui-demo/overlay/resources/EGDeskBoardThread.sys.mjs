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
// Pure: no DOM, no fetch. The helper shares the same recipient classifier.
import { awaitResumeMessageView, clientThreadBinding, displayProfileAvatar, fillHistoryAnswerIds, isProfileId, isRunBusy } from './EGDeskChatState.sys.mjs';

export const BOARD_SEND_PATH = '/chat/board/send';
export const BOARD_MEMBERS_PATH = '/chat/board/members';
const SELF_NAME = '나';
const MAX_RECENT = 12;
const MAX_RECENT_TEXT = 4000;
const MAX_LABEL = 80;
const ROLES = ['owner', 'admin', 'member'];
export const BOARD_ADDRESS_START = /[,;:\s([{"'“‘]/u;
const AFTER_MENTION = /[\s.,!?;:)\]}"'”’·…]/u;
// A new field on a DM request is private to that path until explicitly reviewed for Board use.
// The engine, target, persona, revision and conversation are resolved separately.
const BOARD_TURN_FIELDS = ['message', 'cwd', 'model', 'effort', 'projectTarget', 'expectedRoomProject', 'boardId', 'roomId', 'engineProfileId',
  'attachments', 'selectedSources', 'contextSnapshotIds', 'expectedContextScope', 'contextResolution', 'contextCapabilities'];
export function boardTurnFields(input) {
  return Object.fromEntries(BOARD_TURN_FIELDS.filter(key => own(input, key)).map(key => [key, input[key]]));
}

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

/** Ordered, normalized roster identity. It is an observation, not authority. */
export function boardRosterIdentity(members) {
  const keys = new Set();
  return members.flatMap(member => {
    const kind = member?.kind;
    if (kind !== 'agent' && kind !== 'user') return [];
    const profileId = kind === 'agent' && isProfileId(member.profileId) ? member.profileId : null;
    const name = kind === 'agent' ? label(member.label) || null : null;
    if (kind === 'agent' && !profileId && !name) return [];
    const role = ROLES.includes(member.role) ? member.role : kind === 'user' ? 'owner' : 'member';
    const key = kind === 'user' ? 'user' : profileId ? `agent:${profileId}` : `name:${name}`;
    if (keys.has(key)) return [];
    keys.add(key);
    return [[kind, profileId, name, role]];
  });
}

const HANDLE = /@(?:[\p{L}\p{N}_]|-+[\p{L}\p{N}_])[\p{L}\p{N}\p{M}_-]*(?:\.[\p{L}\p{N}\p{M}_-]+)*/uy;
const RESERVED = /@(all|everyone)(?![\p{L}\p{N}\p{M}_-])/iuy;
const INLINE_LITERALS = /<[^>\n]*>|"(?:[^"\\\r\n]|\\[^\r\n])*"@[\p{L}\p{N}_.-]+|\[[^\]\n]*\]\(https?:\/\/[^)\n]*\)|(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>"'`]+/giu;
const BOARD_SPANS = new RegExp(INLINE_LITERALS.source + '|\\[[^\\]\\n]{0,200}\\]\\((agent:\\/\\/[^)\\n]*)\\)', 'giu');
const escaped = (value, index) => {
  let start = index;
  while (start > 0 && value[start - 1] === '\\') start--;
  return (index - start) % 2 !== 0;
};
const mask = length => '\0'.repeat(length);

// Deliberately smaller than a Markdown parser: line fences (even unclosed)
// and equal-length backtick spans. Masking preserves offsets and cannot make
// a name span quoted code or add a boundary where none existed in the source.
function boardCodeMasked(value) {
  const maskInline = span => {
    const runs = [...span.matchAll(/`+/gu)];
    const nextAt = new Map(), closes = [];
    for (let i = runs.length - 1; i >= 0; i--) {
      closes[i] = nextAt.get(runs[i][0].length);
      nextAt.set(runs[i][0].length, i);
    }
    let at = 0, output = '';
    for (let i = 0; i < runs.length; i++) {
      const open = runs[i], closeIndex = closes[i];
      if (closeIndex === undefined || escaped(span, open.index)) continue;
      const close = runs[closeIndex], end = close.index + close[0].length;
      output += span.slice(at, open.index) + mask(end - open.index);
      at = end;
      i = closeIndex;
    }
    return output + span.slice(at);
  };
  let fence = null, offset = 0, start = 0, result = '';
  for (const line of value.split('\n')) {
    const marker = /^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/u.exec(line.replace(/\r$/u, ''));
    const end = Math.min(value.length, offset + line.length + 1);
    if (fence || marker) {
      result += maskInline(value.slice(start, offset)) + mask(end - offset);
      start = end;
      const closes = fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/u.test(marker[2]);
      fence = closes ? null : fence || marker[1];
    }
    offset = end;
  }
  return result + maskInline(value.slice(start));
}

export const boardLiteralMasked = value => boardCodeMasked(value).replace(INLINE_LITERALS, literal => mask(literal.length));

/** Both the composer and helper classify addresses; neither rewrites message text. */
export function boardAddresses(message, members) {
  const agents = boardRosterIdentity(members).filter(([kind]) => kind === 'agent').map(([, profileId, name]) => ({ profileId, name }));
  const value = typeof message === 'string' ? message : '';
  const found = new Map();
  let invalid = false;
  const note = (agent, index) => {
    const key = agent.profileId ? 'agent:' + agent.profileId : 'name:' + agent.name;
    if (!found.has(key) || found.get(key).index > index) found.set(key, { agent, index });
  };
  const masked = boardCodeMasked(value)
    .replace(BOARD_SPANS, (link, url, index) => {
      if (!url) return mask(link.length);
      if (link.includes('\0') || escaped(value, index)) return mask(link.length);
      const id = url.slice('agent://'.length).split(/[/?#]/)[0];
      const agent = /^[^\s]+$/u.test(url) && agents.find(candidate => candidate.profileId === id);
      if (agent) note(agent, index); else invalid = true;
      return mask(link.length);
    });
  const before = at => at === 0 || BOARD_ADDRESS_START.test(value[at - 1]);
  const after = at => (at === value.length || AFTER_MENTION.test(value[at])) && !(value[at] === '.' && /[\p{L}\p{N}\p{M}_-]/u.test(value.slice(at + 1, at + 3)));
  const names = [...new Set(agents.map(agent => agent.name).filter(name => name && !name.includes('@')))].sort((a, b) => b.length - a.length);
  for (let at = masked.indexOf('@'); at !== -1; at = masked.indexOf('@', at + 1)) {
    if (!before(at)) continue;
    RESERVED.lastIndex = at;
    const reserved = RESERVED.exec(masked);
    if (reserved && after(at + reserved[0].length)) { invalid = true; continue; }
    HANDLE.lastIndex = at;
    const handle = HANDLE.exec(masked);
    if (!handle) continue;
    const name = names.find(name => masked.startsWith('@' + name, at) && after(at + 1 + name.length));
    if (name) {
      if (name === SELF_NAME) { invalid = true; continue; }
      const matches = agents.filter(agent => agent.name === name);
      if (matches.length === 1) note(matches[0], at); else invalid = true;
      at += name.length;
      continue;
    }
    // Unknown addresses use a bounded single handle. No inference from @,
    // punctuation-only strings or the several words of an unrecognized label.
    if (after(at + handle[0].length)) invalid = true;
  }
  return { invalid, mentioned: [...found.values()].sort((a, b) => a.index - b.index).map(entry => entry.agent) };
}

export function boardMentions(message, thread, { selfName = SELF_NAME } = {}) {
  return boardAddresses(message, boardStoreMembers(thread, { selfName })).mentioned;
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
    const alias = own(thread.boardRosterAliases, name) ? thread.boardRosterAliases[name] : null;
    const storedLabel = alias?.profileId === profileId && own(alias, 'label') ? label(alias.label) || null : clean;
    const key = self ? 'user' : profileId ? `agent:${profileId}` : `label:${storedLabel}`;
    if (keys.has(key) || (self && keys.has('user'))) continue;
    keys.add(key);
    members.push(self ? { kind: 'user', role } : profileId ? { kind: 'agent', profileId, ...(storedLabel !== null ? { label: storedLabel } : {}), role } : { kind: 'agent', label: storedLabel, role });
  }
  return members;
}

/**
 * Thread fields (participants, participantRoles, participantAgents) from the
 * store's members, or null when the room already shows exactly these. Faces
 * captured at invite are kept; the person reads as `selfName`.
 */
export function threadFieldsFromStoreMembers(thread, members, { selfName = SELF_NAME } = {}) {
  if (!isBoardRoom(thread) || !Array.isArray(members)) return null;
  const roster = boardRosterIdentity(members);
  const before = linksOf(thread);
  const avatarFor = (name, profileId) => {
    const sameName = own(before, name) ? before[name] : null;
    const match = profileId
      ? (sameName?.profileId === profileId ? sameName : Object.values(before).find(link => link?.profileId === profileId))
      : (sameName?.profileId ? null : sameName);
    return displayProfileAvatar(match?.avatar) || null;
  };
  const participants = [], roles = [], agents = [], aliases = [], counts = new Map();
  for (const [kind, , name] of roster) {
    if (kind === 'agent' && name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // The native store keys profiles by ID, not label. The presenter needs
  // unique string keys; give collisions/nameless rows display aliases only.
  // Keep the canonical labels separately so strict roster equality and
  // address resolution never mistake an alias for a new routable name.
  const occupied = new Set([selfName, ...counts.keys()]);
  for (const [kind, profileId, storedLabel, role] of roster) {
    const self = kind === 'user';
    let name = self ? selfName : storedLabel;
    if (!self && (!name || name === selfName || counts.get(name) > 1)) {
      const base = (storedLabel || 'Agent') + ' · ' + (profileId || '이전 멤버');
      name = base;
      for (let n = 2; occupied.has(name); n++) name = base + ' (' + n + ')';
      occupied.add(name);
      aliases.push([name, { profileId, label: storedLabel }]);
    }
    participants.push(name);
    roles.push([name, role]);
    if (!self) agents.push([name, { profileId, avatar: avatarFor(storedLabel ?? name, profileId) }]);
  }
  const next = { participants, participantRoles: Object.fromEntries(roles), participantAgents: Object.fromEntries(agents) };
  if (aliases.length || own(thread, 'boardRosterAliases')) next.boardRosterAliases = Object.fromEntries(aliases);
  const same = JSON.stringify(thread.participants ?? []) === JSON.stringify(participants)
    && JSON.stringify(boardRosterIdentity(boardStoreMembers(thread, { selfName }))) === JSON.stringify(roster)
    && (participants.length || (!Object.keys(thread.participantRoles ?? {}).length && !Object.keys(before).length && !Object.keys(thread.boardRosterAliases ?? {}).length));
  return same ? null : next;
}

/** Reconcile an authoritative roster or seed a room whose roster was never saved. */
export function boardMembersSync(thread, answer, { selfName = SELF_NAME, legacySavedIsThreadExistence = false } = {}) {
  if (!isBoardRoom(thread) || !Array.isArray(answer?.members)) return null;
  const saved = answer.members;
  const authoritative = saved.length || answer.rosterSaved === true
    || (answer.rosterSaved !== false && answer.saved === true && !legacySavedIsThreadExistence);
  if (authoritative) {
    const restore = threadFieldsFromStoreMembers(thread, saved, { selfName });
    return restore ? { restore } : null;
  }
  if (answer.saved !== false && answer.rosterSaved !== false) return null;
  const members = boardStoreMembers(thread, { selfName });
  return members.length ? { save: members } : null;
}

/** POST /chat/board/members body for the room as it is now. */
export function boardMembersRequest(thread, clientThreadId, { selfName = SELF_NAME } = {}) {
  return { clientThreadId, members: boardStoreMembers(thread, { selfName }) };
}

/** Only finished speech from this room, not a draft, activity, or the private XML behind a system line. */
export function boardRecentMessages(thread) {
  const rows = [];
  for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
    if (!['user', 'assistant'].includes(message?.role) || !['complete', 'completed'].includes(message.status) || awaitResumeMessageView(message)) continue;
    const body = text(message.content).slice(0, MAX_RECENT_TEXT).trim();
    if (!body) continue;
    // The recipient is not the person whose screen calls them '나'. Never invent an author for an old answer.
    const author = message.role === 'assistant' ? label(message.authorName || message.author) : null;
    rows.push({ role: message.role === 'user' ? 'user' : 'agent', text: body, ...(author ? { author } : {}) });
  }
  return rows.slice(-MAX_RECENT);
}

export const BOARD_PROJECT_DISCLOSURE = '연결된 프로젝트와 기존 대화, 실행 설정에 따른 자료가 답변에 추가로 사용될 수 있습니다.';
const hasInput = value => value != null && (!Array.isArray(value) || value.length > 0);

/** An empty suggestion response is only a room-scoped acknowledgement. */
export const boardEmptyResolution = value => value != null && typeof value.resolutionId === 'string' && Array.isArray(value.chosen) && value.chosen.length === 0;
export function boardHasScopedResources(input) {
  return ['contextSnapshotIds', 'expectedContextScope', 'attachments', 'selectedSources', 'selectedResources', 'acceptedContextResources']
    .some(key => hasInput(input[key])) || (hasInput(input.contextResolution) && !boardEmptyResolution(input.contextResolution));
}

/** Shared route classification from concrete room inputs, not authentication. */
export function classifyBoardDelivery({ message, members, leadProfileId = null, engine = 'codex', browserBounded = false, stateless = false }) {
  const roomEngine = engine === 'claude' ? 'Claude' : 'Codex';
  const candidates = members.some(member => member.label === roomEngine) ? members : [...members, { kind: 'agent', label: roomEngine }];
  const { mentioned, invalid } = boardAddresses(message, candidates);
  const named = mentioned.filter(agent => agent.profileId);
  const unlinked = mentioned.filter(agent => !agent.profileId);
  const explicitEngine = !leadProfileId && unlinked.length === 1 && !named.length && unlinked[0].name === roomEngine;
  if (invalid || (unlinked.length && !explicitEngine)) return { code: 'BOARD_UNRESOLVED_ADDRESS' };
  if (named.length && browserBounded) return { code: 'BOARD_BROWSER_BOUNDED' };
  if ((named.length || leadProfileId) && engine !== 'codex') return { code: 'BOARD_ENGINE_UNSUPPORTED' };
  const route = !browserBounded && (named.length || leadProfileId) ? 'board' : 'room';
  if (route === 'board' && stateless) return { code: 'BOARD_STATELESS_UNSUPPORTED' };
  return { route, reason: named.length ? 'mentions' : leadProfileId ? 'lead' : 'room-engine', explicitEngine,
    recipientIds: named.length ? named.map(agent => agent.profileId) : leadProfileId ? [leadProfileId] : [] };
}

/** The recipient preview and preflight; wire builders use this same result. */
export function boardDeliveryIntent(thread, message, options = {}) {
  if (!isBoardRoom(thread)) return null;
  const selfName = options.selfName ?? SELF_NAME;
  const clientThreadId = options.clientThreadId ?? clientThreadBinding(thread);
  const engine = options.engine ?? options.engineId ?? thread.engineId ?? 'codex';
  const profileEnabled = options.profileEnabled ?? thread.profileEnabled;
  const candidate = own(options, 'profileId') ? options.profileId : thread.agentProfileId;
  const leadProfileId = profileEnabled === true && isProfileId(candidate) ? candidate : null;
  const members = boardStoreMembers(thread, { selfName });
  const browserBounded = !!(options.browserScope || options.executionPolicy);
  const stateless = options.stateless === true;
  const plan = classifyBoardDelivery({ message, members, leadProfileId, engine, browserBounded, stateless });
  const selected = options.selectedResources ?? options.acceptedContextResources ?? [];
  const selectedResources = (Array.isArray(selected) ? selected : []).flatMap(resource => {
    const name = label(resource?.label ?? resource?.title ?? resource?.name ?? resource);
    return name ? [{ label: name, kind: label(resource?.kind) || '자료' }] : [];
  });
  let code = plan.code ?? null;
  if (!code && members.length > 64) code = 'INVALID_BOARD_MEMBERS';
  if (!code && plan.route === 'board' && options.supportsBoardDelivery === false) code = 'BOARD_DELIVERY_UNAVAILABLE';
  if (!code && plan.route === 'board' && boardHasScopedResources(options) && !(plan.recipientIds.length === 1 && plan.recipientIds[0] === leadProfileId)) code = 'BOARD_CONTEXT_SCOPE';
  const recipients = (plan.recipientIds ?? []).map(profileId => ({ profileId, engine, kind: 'agent',
    label: members.find(member => member.profileId === profileId)?.label || label(options.profiles?.find?.(profile => profile?.id === profileId)?.name) || (profileId === leadProfileId && label(options.roomAgentName)) || 'Agent' }));
  if (!code && !recipients.length) recipients.push({ profileId: null, engine, kind: 'room-engine', label: engine === 'claude' ? 'Claude' : 'Codex' });
  const roomBlock = !code && plan.route === 'board' ? { memberCount: members.filter(member => member.kind === 'user' || member.profileId).length + (leadProfileId && !members.some(member => member.profileId === leadProfileId) ? 1 : 0), recentTurnCount: boardRecentMessages(thread).length } : null;
  const expectedBoardDelivery = !code && options.supportsBoardDelivery !== false ? {
    version: 1, clientThreadId, engine, route: plan.route, reason: plan.reason, leadProfileId,
    recipientIds: plan.recipientIds, roster: boardRosterIdentity(members),
  } : null;
  return { ok: !code, code, error: boardSendErrorText(code), route: plan.route ?? null, reason: plan.reason ?? null,
    recipients, roomBlock, selectedResources, projectDisclosure: BOARD_PROJECT_DISCLOSURE, expectedBoardDelivery };
}

/** null = ordinary /chat/send; Board preparation never silently falls back. */
export function boardSendPlan(thread, chatRequest, options = {}) {
  if (!isBoardRoom(thread) || !chatRequest || typeof chatRequest.message !== 'string') return null;
  const selfName = options.selfName ?? SELF_NAME;
  const intent = boardDeliveryIntent(thread, chatRequest.message, { ...options, ...chatRequest });
  if (!intent.ok) return { error: intent.code };
  if (options.intent && JSON.stringify(options.intent.expectedBoardDelivery) !== JSON.stringify(intent.expectedBoardDelivery)) return { error: 'BOARD_DELIVERY_CHANGED' };
  if (intent.route !== 'board') return null;
  const body = { ...boardTurnFields(chatRequest), clientThreadId: chatRequest.clientThreadId, requestId: chatRequest.requestId };
  if (!intent.recipients.some(recipient => recipient.profileId === intent.expectedBoardDelivery.leadProfileId)) delete body.engineProfileId;
  body.engineId = intent.expectedBoardDelivery.engine;
  body.expectedBoardDelivery = intent.expectedBoardDelivery;
  body.members = boardStoreMembers(thread, { selfName });
  const lead = intent.expectedBoardDelivery.leadProfileId;
  body.leadProfileId = lead;
  if (lead) {
    body.profileId = lead;
    if (Number.isSafeInteger(chatRequest.profileRevision)) body.profileRevision = chatRequest.profileRevision;
  }
  const recent = boardRecentMessages(thread);
  if (recent.length) body.recentMessages = recent;
  return { path: BOARD_SEND_PATH, body, mentioned: intent.reason === 'mentions' ? intent.expectedBoardDelivery.recipientIds : [] };
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
  const uncertain = row => row.status === 'unknown' || row.dispatchStatus === 'unknown' || row.resumeRequired === true;
  const routes = Object.create(null);
  for (const row of rows) {
    routes[row.profileId] = { status: uncertain(row) ? 'unknown' : ['started', 'deferred', 'failed'].includes(row.status) ? row.status : 'failed',
      ...(typeof row.dispatchStatus === 'string' ? { dispatchStatus: row.dispatchStatus } : {}),
      ...(typeof row.resumeRequired === 'boolean' ? { resumeRequired: row.resumeRequired } : {}),
      reason: row.reason === 'mentioned' ? 'mentioned' : 'lead', requestId: typeof row.requestId === 'string' ? row.requestId : null,
      code: typeof row.code === 'string' ? row.code : null, at: now };
  }
  return { accepted: result?.accepted === true && rows.some(row => row.status === 'started'), lead, members, routes,
    unknown: rows.find(uncertain) || null, failure: rows.find(row => row.status !== 'started' && !uncertain(row)) || null };
}

/** The pending request a member's answer is shown under: in this room, as that Agent. */
export function boardMemberRequest(row, roomThread, { profiles = [] } = {}) {
  const profile = (Array.isArray(profiles) ? profiles : []).find(candidate => candidate?.id === row.profileId) || null;
  const links = linksOf(roomThread);
  const name = Object.keys(links).find(key => links[key]?.profileId === row.profileId) || null;
  const authorName = text(row.label) || text(profile?.name) || name || 'Agent';
  const authorAvatar = displayProfileAvatar(profile?.avatar) || displayProfileAvatar(name ? links[name]?.avatar : null) || null;
  return { requestId: row.requestId, clientThreadId: row.clientThreadId, localThreadId: roomThread.id, conversationId: row.conversationId,
    authorName, ...(authorAvatar ? { authorAvatar } : {}) };
}

/** Marks a run as one Board member's (from the send answer or run.started details.board). */
export function noteBoardRun(run, board, { member = false } = {}) {
  if (!run || !board || typeof board !== 'object' || !isProfileId(board.profileId)) return run;
  run.board = { profileId: board.profileId, ...(label(board.label) ? { label: label(board.label) } : {}), reason: board.reason === 'mentioned' ? 'mentioned' : 'lead',
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
  if (route.status === 'unknown') return { kind: 'waiting', label: '접수 미확인' };
  if (route.status === 'deferred') return { kind: 'waiting', label: '차례 대기' };
  if (route.status === 'failed') return { kind: 'blocked', label: '막힘' };
  if (route.status === 'started') return { kind: 'active', label: '작업 중' };
  return null;
}

const SEND_ERROR_TEXT = Object.freeze({
  BOARD_DELIVERY_CHANGED: 'Board 참여자나 전송 대상이 바뀌었습니다. 방을 다시 열고 전송 대상을 확인해 주세요.',
  BOARD_UNRESOLVED_ADDRESS: '확인할 수 없는 @대상이 있습니다. 방에 연결된 Agent를 다시 선택해 주세요. @all 또는 @everyone으로는 보낼 수 없습니다.',
  BOARD_ENGINE_UNSUPPORTED: '현재 Claude Board에서는 @로 Agent를 부르거나 방의 Lead Agent에게 보낼 수 없습니다. 기본 Claude를 선택해 @없이 보내거나 Codex Board에서 다시 확인해 주세요.',
  BOARD_DELIVERY_UNAVAILABLE: '현재 연결은 Board 전송 대상을 검증할 수 없습니다. EG-Desk 연결을 업데이트하고 다시 열어 주세요.',
  BOARD_SPEAKER_CHANGED: '이전 답변과 같은 Agent인지 확인할 수 없어 대화를 이어가지 않았습니다. 다른 Agent는 @로 부르거나 새 Board 대화에서 시작해 주세요.',
  BOARD_STATELESS_UNSUPPORTED: '기록 없이 시작할 때는 Board Agent에게 따로 보낼 수 없습니다. 기록 없이 시작을 끄거나 방의 기본 엔진으로 보내 주세요.',
  BOARD_CONTEXT_SCOPE: '선택한 자료는 이 방의 대화에서만 사용할 수 있습니다. 자료를 빼거나 방의 Lead 한 명만 선택해 주세요.',
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
const MESSAGE_IDENTITY_FIELDS = ['providerItemId', 'runId', 'conversationId', 'boardMemberProfileId'];
function sameMessage(a, b) {
  // A single member turn can persist both commentary and a final answer. Once both
  // records identify their stored item, a shared run must not override that identity.
  if (a.localMessageId && b.localMessageId) return a.localMessageId === b.localMessageId;
  // Legacy rows may lack a store ID. Do not infer equality across known different
  // items, runs, member conversations or authors (provider item IDs are not global).
  if (MESSAGE_IDENTITY_FIELDS.some(key => a[key] && b[key] && a[key] !== b[key])) return false;
  if (a.id && a.id === b.id) return true;
  return !!(a.runId && a.runId === b.runId && a.role === b.role && a.boardMemberProfileId && a.boardMemberProfileId === b.boardMemberProfileId);
}

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
    const match = messages.findIndex(message => sameMessage(answer, message));
    if (match >= 0) {
      const previous = messages[match];
      // An earlier page (or its Desk copy) may predate the run checkpoint.
      // Enrich only the very same member, stored item and local run; never
      // replace the visible row, its author, or its cache/history provenance.
      if (previous.boardMemberProfileId === member.profileId && previous.localMessageId && previous.localMessageId === answer.localMessageId
          && previous.localRunId && previous.localRunId === answer.localRunId) messages[match] = fillHistoryAnswerIds(previous, answer);
      continue;
    }
    const at = timeOf(answer.createdAt);
    let index = messages.length;
    if (Number.isFinite(at)) { const after = messages.findIndex(message => timeOf(message.createdAt) > at); if (after >= 0) index = after; }
    messages.splice(index, 0, answer);
  }
  return messages;
}
