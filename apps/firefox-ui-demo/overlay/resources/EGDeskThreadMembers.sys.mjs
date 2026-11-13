// CHAT-10: who is in a Board Thread, as the member row draws it. A member is
// still keyed by its name in thread.participants (rooms saved earlier read as
// they are); an invited Agent adds thread.participantAgents[name] =
// { profileId, avatar } — profileId null for the plain Codex. Pure display
// models and thread fields: no DOM, no fetch. Inviting starts no run.
import { agentWorkingView, displayProfileAvatar, isProfileId, isRunBusy, profileRunnable } from './EGDeskChatState.sys.mjs';

export const BASE_AGENT_NAME = 'Codex';
const SELF_NAME = '나';
const ROLE_LABELS = Object.freeze({ owner: '소유자', admin: '관리자', member: '멤버' });

const text = value => (typeof value === 'string' ? value.trim() : '');
const namesOf = thread => Array.from(new Set((Array.isArray(thread?.participants) ? thread.participants : []).filter(name => text(name))));
const own = (object, key) => !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);

/** The Agent links of the members still in the room: { name: { profileId, avatar } }. */
export function memberAgentLinks(thread) {
  const saved = thread?.participantAgents && typeof thread.participantAgents === 'object' && !Array.isArray(thread.participantAgents) ? thread.participantAgents : {};
  const links = {};
  for (const name of namesOf(thread)) {
    if (!own(saved, name) || !saved[name] || typeof saved[name] !== 'object') continue;
    links[name] = { profileId: isProfileId(saved[name].profileId) ? saved[name].profileId : null, avatar: displayProfileAvatar(saved[name].avatar) };
  }
  return links;
}

/**
 * The '초대' list of a Board Thread: the plain Codex and every saved Agent that
 * can answer now, minus whoever is already in the room (by Agent, or by an
 * earlier name-only member holding that name). `note` says why the list is
 * short; 'Agent 만들기' is always offered.
 */
export function inviteMenuView(thread, { profiles = [], catalogStatus = 'ready', selfName = SELF_NAME } = {}) {
  const base = { choices: [], note: null, createLabel: 'Agent 만들기' };
  if (thread?.type !== 'group') return base;
  const names = new Set(namesOf(thread));
  const links = memberAgentLinks(thread);
  const joined = new Set(Object.values(links).map(link => link.profileId).filter(Boolean));
  const saved = catalogStatus === 'ready' ? (Array.isArray(profiles) ? profiles : []).filter(profileRunnable) : [];
  const choices = [];
  if (!names.has(BASE_AGENT_NAME) && BASE_AGENT_NAME !== selfName) {
    choices.push({ key: 'codex', profileId: null, name: BASE_AGENT_NAME, role: '기본 Codex', avatar: null });
  }
  for (const profile of saved) {
    const name = text(profile.name);
    if (!name || name === selfName || name === BASE_AGENT_NAME || !isProfileId(profile.id)) continue;
    if (joined.has(profile.id) || names.has(name) || choices.some(choice => choice.name === name)) continue;
    choices.push({ key: `agent:${profile.id}`, profileId: profile.id, name, role: text(profile.role), avatar: displayProfileAvatar(profile.avatar) });
  }
  const note = catalogStatus === 'loading' || catalogStatus === 'idle' ? 'Agent 목록을 불러오는 중입니다.'
    : catalogStatus !== 'ready' ? 'Agent 목록을 불러오지 못했습니다.'
      : saved.length === 0 ? '아직 만든 Agent가 없습니다.'
        : choices.length === 0 ? '초대할 수 있는 Agent가 모두 참여 중입니다.' : null;
  return { ...base, choices, note };
}

/** Thread fields after inviting `choice` (from inviteMenuView), or null when nothing changes. */
export function invitedThreadFields(thread, choice, { selfName = SELF_NAME } = {}) {
  if (thread?.type !== 'group' || !choice || typeof choice !== 'object') return null;
  const name = text(choice.name);
  const profileId = choice.profileId === null || choice.profileId === undefined ? null : choice.profileId;
  if (!name || name === selfName || (profileId !== null && !isProfileId(profileId))) return null;
  if (profileId === null && name !== BASE_AGENT_NAME) return null;
  const names = namesOf(thread);
  const links = memberAgentLinks(thread);
  if (names.includes(name) || (profileId && Object.values(links).some(link => link.profileId === profileId))) return null;
  return {
    participants: [...names, name],
    participantRoles: { ...(thread.participantRoles || {}), [name]: 'member' },
    participantAgents: { ...links, [name]: { profileId, avatar: displayProfileAvatar(choice.avatar) } },
  };
}

/** Thread fields after `name` leaves, or null when it cannot (the person, a stranger, or the last two). */
export function removedThreadFields(thread, name, { selfName = SELF_NAME } = {}) {
  if (thread?.type !== 'group' || !text(name) || name === selfName) return null;
  const names = namesOf(thread);
  if (!names.includes(name) || names.length - 1 < 2) return null;
  const participants = names.filter(member => member !== name);
  const participantRoles = { ...(thread.participantRoles || {}) };
  delete participantRoles[name];
  const participantAgents = memberAgentLinks({ ...thread, participants });
  return { participants, participantRoles, participantAgents };
}

// The last run that Agent spoke as in this room; a run without a captured
// author is the room Agent's. Only what the run itself says is shown.
function memberStatus(runs, labels, { roomAgentName, connected }) {
  const run = (Array.isArray(runs) ? runs : []).findLast((candidate) => {
    const author = text(candidate?.authorName) || roomAgentName;
    return !!candidate && labels.includes(author);
  });
  if (!run) return null;
  if (isRunBusy(run)) {
    const working = agentWorkingView(run, { connected });
    if (!working) return null;
    if (working.state === 'approval') return { kind: 'waiting', label: '승인 대기' };
    if (working.state === 'question') return { kind: 'waiting', label: '답변 대기' };
    if (working.state === 'stopping') return { kind: 'active', label: '중지하는 중' };
    return { kind: 'active', label: '작업 중' };
  }
  if (run.status === 'failed') return { kind: 'blocked', label: '막힘' };
  if (run.status === 'completed') return { kind: 'done', label: '완료' };
  return null;
}

/**
 * The member chips of a Board Thread: face (the saved Agent's, else the one
 * captured at invite, else the name's letter), name, role, and a status only
 * when a run of that Agent in this room says so. `more` counts the members
 * past `limit`.
 */
export function memberChipViews(thread, { profiles = [], runs = [], roomAgentName = BASE_AGENT_NAME, connected = true, selfName = SELF_NAME, limit = 4 } = {}) {
  if (thread?.type !== 'group') return { chips: [], more: 0 };
  const names = namesOf(thread);
  const links = memberAgentLinks(thread);
  const catalog = Array.isArray(profiles) ? profiles : [];
  const chips = names.slice(0, limit).map((name) => {
    const self = name === selfName;
    const link = links[name] || null;
    const profile = link?.profileId ? catalog.find(row => row?.id === link.profileId) || null : null;
    const label = text(profile?.name) || name;
    const given = thread.participantRoles?.[name];
    const role = own(ROLE_LABELS, given) ? given : self ? 'owner' : 'member';
    const status = self ? null : memberStatus(runs, label === name ? [name] : [name, label], { roomAgentName: text(roomAgentName) || BASE_AGENT_NAME, connected });
    const manageable = !self;
    return {
      name, label, self, role, roleLabel: ROLE_LABELS[role], manageable,
      profileId: link?.profileId || null,
      avatar: displayProfileAvatar(profile?.avatar) || link?.avatar || null,
      status,
      title: [label, ROLE_LABELS[role], status?.label, manageable ? '멤버 관리' : null].filter(Boolean).join(' · '),
    };
  });
  return { chips, more: Math.max(0, names.length - limit) };
}
