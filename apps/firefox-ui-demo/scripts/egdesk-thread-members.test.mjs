import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import * as ThreadMembers from '../overlay/resources/EGDeskThreadMembers.sys.mjs';

const { BASE_AGENT_NAME, inviteMenuView, invitedThreadFields, memberChipViews, removedThreadFields } = ThreadMembers;

const ID_A = 'design-reviewer';
const ID_B = 'verifier';
const ID_C = 'archived-agent';
const EMOJI = { kind: 'emoji', value: '🦉', color: '#a9c5a9' };
const profile = (id, name, extra = {}) => ({ id, name, role: `${name} 역할`, avatar: null, lifecycle: 'active', activeRevision: 1, headRevision: 1, ...extra });
const CATALOG = [profile(ID_A, '디자인 리뷰어', { avatar: EMOJI }), profile(ID_B, '검증 담당'), profile(ID_C, '보관한 Agent', { lifecycle: 'archived' })];
const room = (extra = {}) => ({ id: 'room-1', type: 'group', participants: ['나'], participantRoles: { 나: 'owner' }, ...extra });

test('B01 초대 목록: 기본 Codex와 지금 쓸 수 있는 저장된 Agent만, 이미 들어온 Agent는 빠진다', () => {
  const view = inviteMenuView(room(), { profiles: CATALOG, catalogStatus: 'ready' });
  assert.deepEqual(view.choices.map(choice => [choice.key, choice.name, choice.profileId]), [
    ['codex', BASE_AGENT_NAME, null], [`agent:${ID_A}`, '디자인 리뷰어', ID_A], [`agent:${ID_B}`, '검증 담당', ID_B]]);
  assert.deepEqual(view.choices[1].avatar, EMOJI);
  assert.equal(view.choices[1].role, '디자인 리뷰어 역할');
  assert.equal(view.choices[0].role, '기본 Codex');
  assert.equal(view.note, null);
  assert.equal(view.createLabel, 'Agent 만들기');

  const joined = room({ participants: ['나', 'Codex', '디자인 리뷰어'], participantAgents: { '디자인 리뷰어': { profileId: ID_A, avatar: EMOJI } } });
  assert.deepEqual(inviteMenuView(joined, { profiles: CATALOG, catalogStatus: 'ready' }).choices.map(choice => choice.name), ['검증 담당']);
  // An Agent renamed after it joined is still the same Agent: it is not offered twice.
  const renamed = CATALOG.map(row => (row.id === ID_A ? { ...row, name: 'UX 리뷰어' } : row));
  assert.deepEqual(inviteMenuView(joined, { profiles: renamed, catalogStatus: 'ready' }).choices.map(choice => choice.name), ['검증 담당']);
  // An earlier name-only member with an Agent's name keeps that name to itself.
  assert.deepEqual(inviteMenuView(room({ participants: ['나', '검증 담당'] }), { profiles: CATALOG, catalogStatus: 'ready' }).choices.map(choice => choice.name),
    [BASE_AGENT_NAME, '디자인 리뷰어']);
});

test('B01 초대 목록: Agent가 없거나 목록을 못 읽으면 그 사실과 Agent 만들기를 보여 준다', () => {
  const none = inviteMenuView(room(), { profiles: [], catalogStatus: 'ready' });
  assert.deepEqual(none.choices.map(choice => choice.name), [BASE_AGENT_NAME]);
  assert.equal(none.note, '아직 만든 Agent가 없습니다.');
  const allIn = inviteMenuView(room({ participants: ['나', 'Codex'] }), { profiles: [], catalogStatus: 'ready' });
  assert.deepEqual(allIn.choices, []);
  assert.equal(allIn.note, '아직 만든 Agent가 없습니다.');
  const everyone = room({ participants: ['나', 'Codex', '디자인 리뷰어', '검증 담당'],
    participantAgents: { '디자인 리뷰어': { profileId: ID_A }, '검증 담당': { profileId: ID_B } } });
  assert.equal(inviteMenuView(everyone, { profiles: CATALOG, catalogStatus: 'ready' }).note, '초대할 수 있는 Agent가 모두 참여 중입니다.');
  assert.equal(inviteMenuView(room(), { profiles: [], catalogStatus: 'loading' }).note, 'Agent 목록을 불러오는 중입니다.');
  assert.equal(inviteMenuView(room(), { profiles: [], catalogStatus: 'unavailable' }).note, 'Agent 목록을 불러오지 못했습니다.');
  assert.deepEqual(inviteMenuView(room(), { profiles: CATALOG, catalogStatus: 'unavailable' }).choices.map(choice => choice.name), [BASE_AGENT_NAME],
    'a catalog that could not be read offers no saved Agent');
  assert.deepEqual(inviteMenuView({ id: 'dm', type: 'dm', participants: ['나', 'Codex'] }, { profiles: CATALOG, catalogStatus: 'ready' }).choices, [],
    'only a Board Thread invites');
});

test('B01 초대: 고른 Agent가 이름·얼굴로 들어오고 "멤버 N"은 생기지 않는다', () => {
  const view = inviteMenuView(room(), { profiles: CATALOG, catalogStatus: 'ready' });
  const next = invitedThreadFields(room(), view.choices[1]);
  assert.deepEqual(next.participants, ['나', '디자인 리뷰어']);
  assert.deepEqual(next.participantRoles, { 나: 'owner', '디자인 리뷰어': 'member' });
  assert.deepEqual(next.participantAgents, { '디자인 리뷰어': { profileId: ID_A, avatar: EMOJI } });
  const withCodex = invitedThreadFields({ ...room(), ...next }, view.choices[0]);
  assert.deepEqual(withCodex.participants, ['나', '디자인 리뷰어', 'Codex']);
  assert.deepEqual(withCodex.participantAgents, { '디자인 리뷰어': { profileId: ID_A, avatar: EMOJI }, Codex: { profileId: null, avatar: null } });
  assert.ok(!JSON.stringify(withCodex).includes('멤버 '), 'no invented member name');
  // Already in, not a choice, or not a Board Thread: nothing changes.
  assert.equal(invitedThreadFields({ ...room(), ...next }, view.choices[1]), null);
  assert.equal(invitedThreadFields(room(), null), null);
  assert.equal(invitedThreadFields(room(), { key: 'x', name: '  ' }), null);
  assert.equal(invitedThreadFields(room(), { key: 'self', name: '나', profileId: null }), null);
  assert.equal(invitedThreadFields({ ...room(), type: 'dm' }, view.choices[1]), null);
  assert.equal(invitedThreadFields(room(), { key: 'bad', name: '가짜', profileId: 'Not A Profile' }), null);
});

test('B01 제거: 참여자와 함께 그 Agent 연결도 지워지고, 둘 미만으로는 줄지 않는다', () => {
  const thread = room({ participants: ['나', '디자인 리뷰어', '멤버 3'], participantRoles: { 나: 'owner', '디자인 리뷰어': 'admin', '멤버 3': 'member' },
    participantAgents: { '디자인 리뷰어': { profileId: ID_A, avatar: EMOJI } } });
  const next = removedThreadFields(thread, '디자인 리뷰어');
  assert.deepEqual(next, { participants: ['나', '멤버 3'], participantRoles: { 나: 'owner', '멤버 3': 'member' }, participantAgents: {} });
  assert.equal(removedThreadFields({ ...thread, ...next }, '멤버 3'), null, 'a room keeps at least two members');
  assert.equal(removedThreadFields(thread, '나'), null);
  assert.equal(removedThreadFields(thread, '없는 이름'), null);
});

test('B02 참여자 칩: 얼굴과 이름, 읽을 수 있는 역할; 이름만 있는 예전 참여자는 글자 얼굴', () => {
  const thread = room({ participants: ['나', '디자인 리뷰어', '멤버 3', 'Codex'], participantRoles: { 나: 'owner', '디자인 리뷰어': 'admin' },
    participantAgents: { '디자인 리뷰어': { profileId: ID_A, avatar: null }, Codex: { profileId: null, avatar: null } } });
  const { chips, more } = memberChipViews(thread, { profiles: CATALOG });
  assert.equal(more, 0);
  assert.deepEqual(chips.map(chip => [chip.name, chip.label, chip.role, chip.roleLabel, chip.manageable]), [
    ['나', '나', 'owner', '소유자', false], ['디자인 리뷰어', '디자인 리뷰어', 'admin', '관리자', true],
    ['멤버 3', '멤버 3', 'member', '멤버', true], ['Codex', 'Codex', 'member', '멤버', true]]);
  assert.deepEqual(chips[1].avatar, EMOJI, 'the saved Agent shows its saved face');
  assert.equal(chips[1].profileId, ID_A);
  assert.equal(chips[2].avatar, null, 'a name-only member draws its first letter');
  assert.equal(chips[2].profileId, null);
  assert.ok(chips.every(chip => chip.status === null), 'no run data, no status dot');
  assert.equal(chips[1].title, '디자인 리뷰어 · 관리자 · 멤버 관리');
  assert.equal(chips[0].title, '나 · 소유자');

  // A renamed Agent shows its current name; the room keeps its key for roles and menus.
  const renamed = CATALOG.map(row => (row.id === ID_A ? { ...row, name: 'UX 리뷰어' } : row));
  const chip = memberChipViews(thread, { profiles: renamed }).chips[1];
  assert.deepEqual([chip.name, chip.label], ['디자인 리뷰어', 'UX 리뷰어']);
  // Until the catalog answers, the face captured at invite stands in.
  const captured = room({ participants: ['나', '디자인 리뷰어'], participantAgents: { '디자인 리뷰어': { profileId: ID_A, avatar: EMOJI } } });
  assert.deepEqual(memberChipViews(captured, { profiles: [] }).chips[1].avatar, EMOJI);

  const many = room({ participants: ['나', 'a', 'b', 'c', 'd', 'e'] });
  const limited = memberChipViews(many, { profiles: [] });
  assert.deepEqual([limited.chips.length, limited.more], [4, 2]);
  assert.deepEqual(memberChipViews({ id: 'dm', type: 'dm', participants: ['나', 'Codex'] }, {}), { chips: [], more: 0 });
});

test('B02 참여자 칩 상태: 그 방에서 그 Agent 이름으로 돈 마지막 Run만 비춘다 (없으면 점 없음)', () => {
  const thread = room({ participants: ['나', '디자인 리뷰어', '검증 담당', 'Codex', '멤버 3'],
    participantAgents: { '디자인 리뷰어': { profileId: ID_A }, '검증 담당': { profileId: ID_B }, Codex: { profileId: null } } });
  const status = (runs, options = {}) => Object.fromEntries(memberChipViews(thread, { profiles: CATALOG, runs, limit: 8, ...options }).chips
    .map(chip => [chip.name, chip.status && [chip.status.kind, chip.status.label]]));
  assert.deepEqual(status([
    { runId: 'r1', status: 'completed', authorName: '디자인 리뷰어' },
    { runId: 'r2', status: 'running', authorName: '디자인 리뷰어' },
    { runId: 'r3', status: 'failed', authorName: '검증 담당' },
    { runId: 'r4', status: 'completed' },
  ], { roomAgentName: 'Codex' }), {
    나: null, '디자인 리뷰어': ['active', '작업 중'], '검증 담당': ['blocked', '막힘'], Codex: ['done', '완료'], '멤버 3': null });
  assert.deepEqual(status([{ runId: 'r1', status: 'running', authorName: '검증 담당', pendingApprovals: [{ approvalId: 'a' }] }])['검증 담당'], ['waiting', '승인 대기']);
  assert.deepEqual(status([{ runId: 'r1', status: 'running', authorName: '검증 담당', pendingUserInputs: [{ userInputId: 'q', status: 'pending' }] }])['검증 담당'], ['waiting', '답변 대기']);
  // A run without a captured author belongs to the room's Agent, never to everyone.
  assert.deepEqual(status([{ runId: 'r1', status: 'running' }], { roomAgentName: '검증 담당' }),
    { 나: null, '디자인 리뷰어': null, '검증 담당': ['active', '작업 중'], Codex: null, '멤버 3': null });
  // What the bridge cannot say is not shown; a stopped or cancelled run leaves no dot.
  assert.equal(status([{ runId: 'r1', status: 'running', authorName: '검증 담당' }], { connected: false })['검증 담당'], null);
  assert.equal(status([{ runId: 'r1', status: 'interrupted', authorName: '검증 담당' }])['검증 담당'], null);
  assert.equal(status([{ runId: 'r1', status: 'cancelled', authorName: '검증 담당' }])['검증 담당'], null);
  // The status joins the chip's title so it is not colour alone.
  const chip = memberChipViews(thread, { profiles: CATALOG, runs: [{ runId: 'r3', status: 'failed', authorName: '검증 담당' }], limit: 8 }).chips[2];
  assert.equal(chip.title, '검증 담당 · 멤버 · 막힘 · 멤버 관리');
});

// ── Screen wiring: the bridge actions and the member row, cut from the surface source ──
const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const cut = (from, to) => {
  const start = surfaceSource.indexOf(from);
  const end = surfaceSource.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} … ${to}`);
  return surfaceSource.slice(start, end);
};

function memberBridge({ catalog = { status: 'ready', profiles: CATALOG }, threads } = {}) {
  const state = { codex: { activeThreadId: 'room-1', threads: threads || [room()], memberMenu: null, threadMenu: { threadId: 'room-1' },
    engineMenu: { threadId: 'room-1' }, messageMenu: {}, agentPeek: {} } };
  const calls = { emit: 0, catalogLoads: 0 };
  const source = `return { ${cut('      toggleInviteMenu(threadId, anchorEl = null) {', '      toggleEngineMenu(threadId, anchorEl = null) {')}
    ${cut('      removeFromThread(threadId, memberName) {', '      async refreshAuthStatus() {')} };`;
  const bridge = compileFunction(source, ['state', 'getCodexThreadById', 'updateThreadById', 'emit', 'resolveFloatingMenuPlacement',
    'loadProfileCatalog', 'ThreadMembers', 'codexProfileCatalog', 'SELF_MEMBER', 'buildThreadSubtitle'])(
    state, (codex, id) => codex.threads.find(thread => thread.id === id) || null,
    (id, update) => { state.codex.threads = state.codex.threads.map(thread => (thread.id === id ? update(thread) : thread)); },
    () => { calls.emit += 1; }, rect => ({ left: rect.right - 248, top: rect.bottom + 6 }), () => { calls.catalogLoads += 1; },
    ThreadMembers, catalog, '나', (type, participants) => `멤버 ${participants.length}명`);
  return { state, bridge, calls, thread: () => state.codex.threads[0] };
}

test('B01 화면 배선: 초대는 목록을 열 뿐이고, 고른 Agent만 그 이름·얼굴로 들어온다', () => {
  const h = memberBridge();
  h.bridge.toggleInviteMenu('room-1', { getBoundingClientRect: () => ({ right: 400, bottom: 60 }) });
  assert.deepEqual(h.state.codex.memberMenu, { threadId: 'room-1', memberName: null, invite: true, left: 152, top: 66 });
  assert.deepEqual([h.state.codex.threadMenu, h.state.codex.engineMenu, h.state.codex.messageMenu, h.state.codex.agentPeek], [null, null, null, null],
    'one floating list at a time');
  assert.equal(h.calls.catalogLoads, 1, 'the saved Agent list is read again when the list opens');
  assert.deepEqual(h.thread().participants, ['나'], 'opening the list adds nobody');
  h.bridge.toggleInviteMenu('room-1');
  assert.equal(h.state.codex.memberMenu, null, 'pressing 초대 again closes the list');

  h.bridge.toggleInviteMenu('room-1');
  h.bridge.inviteToThread('room-1', `agent:${ID_A}`);
  assert.deepEqual(h.thread().participants, ['나', '디자인 리뷰어']);
  assert.deepEqual(h.thread().participantAgents, { '디자인 리뷰어': { profileId: ID_A, avatar: EMOJI } });
  assert.equal(h.thread().participantRoles['디자인 리뷰어'], 'member');
  assert.equal(h.thread().subtitle, '멤버 2명');
  assert.equal(h.state.codex.memberMenu, null, 'the list closes after a pick');
  // The same Agent again, a made-up key, or no key: nobody joins and no name is invented.
  for (const key of [`agent:${ID_A}`, 'agent:nobody', undefined, '멤버 3']) h.bridge.inviteToThread('room-1', key);
  assert.deepEqual(h.thread().participants, ['나', '디자인 리뷰어']);
  h.bridge.inviteToThread('room-1', 'codex');
  assert.deepEqual(h.thread().participants, ['나', '디자인 리뷰어', 'Codex']);
  assert.ok(!surfaceSource.includes('`멤버 ${'), 'the surface no longer builds "멤버 N" names');
  assert.ok(!surfaceSource.includes('memberNonce'));

  h.bridge.removeFromThread('room-1', '디자인 리뷰어');
  assert.deepEqual([h.thread().participants, h.thread().participantAgents], [['나', 'Codex'], { Codex: { profileId: null, avatar: null } }]);
  h.bridge.removeFromThread('room-1', 'Codex');
  assert.deepEqual(h.thread().participants, ['나', 'Codex'], 'a room keeps two members');

  const dm = memberBridge({ threads: [{ id: 'room-1', type: 'dm', participants: ['나', 'Codex'] }] });
  dm.bridge.toggleInviteMenu('room-1');
  dm.bridge.inviteToThread('room-1', `agent:${ID_A}`);
  assert.deepEqual([dm.state.codex.memberMenu, dm.thread().participants], [null, ['나', 'Codex']], 'an Agent DM has no invite');
});

test('B01·B02 화면 배선: 멤버 줄은 얼굴·상태 점·아이콘 펼침으로 그리고, 목록은 Esc·바깥 클릭으로 닫힌다', () => {
  const row = cut('          // CHAT-10: who is in this Board Thread', "          conversation.appendChild(el('div', { class: 'egd-codex-thread-active-head' },");
  assert.match(row, /ThreadMembers\.memberChipViews\(activeThread, \{\s*profiles: codexProfileCatalog\.profiles, runs: codexRuns\(activeThread\)/);
  assert.match(row, /memberFace\(chipView\.avatar, chipView\.label, 'egd-codex-thread-member-face'\)/, 'the chip draws the message avatar face');
  assert.match(row, /chipView\.status \? el\('span', \{\s*class: `egd-codex-thread-member-status egd-codex-thread-member-status-\$\{chipView\.status\.kind\}`,\s*role: 'img', 'aria-label': chipView\.status\.label/,
    'a status dot only when the view has one, named for assistive tech');
  assert.match(row, /deskIcon\('chevron', 'egd-codex-thread-member-caret'\)/);
  assert.ok(!row.includes('▾') && !row.includes('✓'), 'no glyph characters stand in for icons');
  assert.match(row, /el\(canManageMember \? 'button' : 'span'/, 'a member that cannot be managed is not a dead button');
  assert.match(row, /codexBridge\.toggleInviteMenu\(activeThread\.id, ev\.currentTarget\)/);
  assert.match(row, /codexBridge\.inviteToThread\(activeThread\.id, choice\.key\)/);
  assert.match(row, /spawnSettingsCard\(\{ tab: 'agents' \}\)/, "'Agent 만들기' opens the Agent settings");
  assert.match(row, /if \(ev\.key === 'Escape'\) \{\s*codexBridge\.closeMemberMenu\(\);\s*focusMemberControl\(returnFocusKey\);/, 'Esc closes and returns focus');
  assert.equal(row.match(/memberMenuPanel\.addEventListener\('keydown', memberMenuKeydown\(/g)?.length, 2, 'both the member menu and the invite list take the keys');
  assert.ok(!/inviteToThread\(activeThread\.id\)/.test(surfaceSource), 'no one-press invite is left');
  // Outside click: the trigger is spared (it toggles), everything else closes through closeMemberMenu.
  const outside = cut('    const onDocumentMouseDown = (ev) => {', '    const onViewportMutate = (ev) => {');
  assert.match(outside, /target\.closest\('\.egd-codex-thread-member-menu'\)/);
  assert.match(outside, /target\.closest\('\.egd-codex-thread-invite-trigger'\)/);
  assert.match(outside, /closeFloatingMenus\(\);/);
  // Scrolling a long list keeps it open; a wheel anywhere else still closes it.
  const closes = [];
  const onViewportMutate = compileFunction(`${cut('    const onViewportMutate = (ev) => {', "    document.addEventListener('mousedown', onDocumentMouseDown, true);")}\n return onViewportMutate;`,
    ['onMessageScrollGesture', 'closeFloatingMenus'])(() => {}, () => { closes.push(1); });
  onViewportMutate({ type: 'wheel', target: { closest: selector => (selector === '.egd-codex-thread-invite-menu' ? {} : null) } });
  assert.equal(closes.length, 0);
  onViewportMutate({ type: 'wheel', target: { closest: () => null } });
  onViewportMutate({ type: 'resize', target: {} });
  assert.equal(closes.length, 2);
  // Every row of both lists can keep focus through a redraw.
  for (const key of ["focusKey: 'thread-member-menu-admin'", "focusKey: 'thread-member-menu-member'", "focusKey: 'thread-member-menu-remove'",
    'focusKey: `thread-invite-${choice.key}`', "focusKey: 'thread-invite-create'", "focusKey: 'thread-invite'"]) {
    assert.ok(row.includes(key), key);
  }
  // A fork keeps the members' Agent links.
  assert.match(surfaceSource, /if \(source\.participantAgents\) target\.participantAgents = \{ \.\.\.source\.participantAgents \};/);
  // An open invite list survives the state check as long as its Board Thread exists.
  assert.match(surfaceSource, /state\.codex\.memberMenu\.invite === true \? menuThread\?\.type === 'group'/);
});

// The member row block of mountCodexHUD, run against a small stand-in for el():
// what gets drawn and what each press calls.
function drawMemberRow({ thread, memberMenu = null, runs = [], catalog = { status: 'ready', profiles: CATALOG } }) {
  const el = (tag, props = {}, ...children) => {
    const node = { tag, props, children: children.filter(child => child != null), listeners: {}, dataset: { ...(props.data || {}) }, focusCount: 0,
      addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
      appendChild(child) { this.children.push(child); },
      focus() { this.focusCount += 1; },
      querySelectorAll(selector) { assert.equal(selector, 'button:not([disabled])'); return all(this).filter(item => item.tag === 'button'); } };
    for (const [key, value] of Object.entries(props)) if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    return node;
  };
  const all = node => (typeof node === 'string' ? [] : [node, ...node.children.flatMap(all)]);
  const calls = [];
  const bridge = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args.filter(arg => typeof arg !== 'object' || arg === null)]); } });
  let drawn = null;
  const nodes = () => [...all(drawn.memberRowWrap), ...(drawn.memberMenuPanel ? all(drawn.memberMenuPanel) : [])];
  const body = { querySelectorAll: () => nodes().filter(node => node.dataset.focusKey), querySelector: () => null };
  const row = cut('          // CHAT-10: who is in this Board Thread', "          conversation.appendChild(el('div', { class: 'egd-codex-thread-active-head' },");
  drawn = compileFunction(`${row}\n return { memberRowWrap, memberMenuPanel };`, ['activeThread', 'codex', 'codexBridge', 'ThreadMembers', 'codexProfileCatalog',
    'codexRuns', 'codexThreadAgentProfile', 'activeEngine', 'SELF_MEMBER', 'body', 'document', 'el', 'deskIcon', 'codexMessageAvatarFace', 'spawnSettingsCard'])(
    thread, { memberMenu, connected: true }, bridge, ThreadMembers, catalog, () => runs, () => null, { engineId: 'codex', ready: true }, '나', body,
    { activeElement: null }, el, (name, className) => el('svg', { class: className, data: { icon: name } }),
    (avatar, name) => ({ text: avatar?.value || String(name).slice(0, 1), toneClass: avatar ? ' egd-profile-avatar-tone-1' : '', photo: null }),
    (options) => { calls.push(['spawnSettingsCard', options.tab]); });
  const byTestId = id => nodes().filter(node => node.dataset.testid === id);
  const textOf = node => (typeof node === 'string' ? node : node.children.map(textOf).join(''));
  const fire = (node, type, event = {}) => { for (const handler of node.listeners[type] || []) handler({ stopPropagation() {}, preventDefault() {}, currentTarget: node, ...event }); };
  return { drawn, calls, byTestId, textOf, fire, all };
}

test('B01·B02 화면: 멤버 줄이 얼굴·이름·상태 점으로 그려지고, 초대 목록에서 고르면 그 Agent가 초대된다', () => {
  const thread = room({ participants: ['나', '디자인 리뷰어', '멤버 3'], participantRoles: { 나: 'owner', '디자인 리뷰어': 'admin', '멤버 3': 'member' },
    participantAgents: { '디자인 리뷰어': { profileId: ID_A, avatar: EMOJI } } });
  const runs = [{ runId: 'r1', status: 'running', authorName: '디자인 리뷰어' }];

  const closed = drawMemberRow({ thread, runs });
  assert.equal(closed.drawn.memberMenuPanel, null, 'nothing floats until asked');
  const chips = closed.byTestId('chat-thread-member');
  assert.deepEqual(chips.map(chip => [chip.tag, chip.dataset.member, chip.dataset.status]), [['span', '나', 'none'], ['button', '디자인 리뷰어', 'active'], ['button', '멤버 3', 'none']]);
  assert.deepEqual(chips.map(chip => closed.textOf(chip)), ['나나소유자', '🦉디자인 리뷰어관리자', '멤멤버 3멤버'], 'face, name, role — the name-only member shows its first letter');
  assert.equal(closed.byTestId('chat-thread-member-status').length, 1);
  assert.equal(closed.byTestId('chat-thread-member-status')[0].props['aria-label'], '작업 중');
  assert.equal(chips[1].props['aria-expanded'], 'false');
  assert.equal(chips[1].props.title, '디자인 리뷰어 · 관리자 · 작업 중 · 멤버 관리');
  assert.equal(closed.all(chips[1]).filter(node => node.dataset.icon === 'chevron').length, 1);
  const invite = closed.byTestId('chat-thread-invite')[0];
  assert.deepEqual([closed.textOf(invite), invite.props['aria-expanded'], invite.props['aria-haspopup']], ['초대', 'false', 'menu']);
  closed.fire(invite, 'click');
  assert.deepEqual(closed.calls, [['toggleInviteMenu', 'room-1']], 'pressing 초대 opens the list; nobody is added');
  closed.fire(chips[2], 'click');
  assert.deepEqual(closed.calls.at(-1), ['toggleMemberMenu', 'room-1', '멤버 3']);
  assert.deepEqual(chips[0].listeners, {}, 'the person is not a button');

  const inviting = drawMemberRow({ thread, runs, memberMenu: { threadId: 'room-1', memberName: null, invite: true, left: 40.4, top: 90 } });
  const list = inviting.byTestId('chat-thread-invite-menu')[0];
  assert.deepEqual([list.props.role, list.props.style], ['menu', { left: '40px', top: '90px' }]);
  const choices = inviting.byTestId('chat-thread-invite-choice');
  assert.deepEqual(choices.map(choice => [choice.dataset.choice, inviting.textOf(choice)]), [['codex', 'CCodex기본 Codex'], [`agent:${ID_B}`, '검검증 담당검증 담당 역할']]);
  assert.equal(inviting.byTestId('chat-thread-invite-note').length, 0);
  assert.equal(inviting.byTestId('chat-thread-invite')[0].props['aria-expanded'], 'true');
  inviting.fire(choices[1], 'click');
  assert.deepEqual(inviting.calls, [['inviteToThread', 'room-1', `agent:${ID_B}`]]);
  assert.equal(inviting.byTestId('chat-thread-invite')[0].focusCount, 1, 'after a pick, focus is back on 초대');
  inviting.fire(inviting.byTestId('chat-thread-invite-create')[0], 'click');
  assert.deepEqual(inviting.calls.slice(1), [['closeMemberMenu'], ['spawnSettingsCard', 'agents']]);
  inviting.calls.length = 0;
  inviting.fire(list, 'keydown', { key: 'Escape' });
  assert.deepEqual(inviting.calls, [['closeMemberMenu']], 'Esc closes the invite list');
  assert.equal(inviting.byTestId('chat-thread-invite')[0].focusCount, 2, 'and focus returns to 초대');
  inviting.fire(list, 'keydown', { key: 'ArrowDown' });
  assert.equal(choices[0].focusCount, 1, 'the arrow keys walk the rows');
  inviting.fire(list, 'keydown', { key: 'End' });
  assert.equal(inviting.byTestId('chat-thread-invite-create')[0].focusCount, 1);

  const none = drawMemberRow({ thread: room({ participants: ['나', 'Codex'] }), memberMenu: { threadId: 'room-1', memberName: null, invite: true }, catalog: { status: 'ready', profiles: [] } });
  assert.equal(none.byTestId('chat-thread-invite-choice').length, 0);
  assert.equal(none.textOf(none.byTestId('chat-thread-invite-note')[0]), '아직 만든 Agent가 없습니다.');
  assert.equal(none.textOf(none.byTestId('chat-thread-invite-create')[0]), 'Agent 만들기');

  const managing = drawMemberRow({ thread, runs, memberMenu: { threadId: 'room-1', memberName: '멤버 3', left: 10, top: 20 } });
  const menu = managing.byTestId('chat-thread-member-menu')[0];
  assert.equal(menu.props['aria-label'], '멤버 3 멤버 관리');
  const items = managing.all(menu).filter(node => node.tag === 'button');
  assert.deepEqual(items.map(item => [managing.textOf(item), item.props.role, item.props['aria-checked'] ?? null]),
    [['관리자', 'menuitemradio', 'false'], ['멤버', 'menuitemradio', 'true'], ['Board Thread에서 제거', 'menuitem', null]]);
  assert.equal(managing.byTestId('chat-thread-member')[2].props['aria-expanded'], 'true');
  managing.fire(items[0], 'click');
  managing.fire(items[2], 'click');
  managing.fire(menu, 'keydown', { key: 'Escape' });
  assert.deepEqual(managing.calls, [['setThreadMemberRole', 'room-1', '멤버 3', 'admin'], ['removeFromThread', 'room-1', '멤버 3'], ['closeMemberMenu']]);
  assert.equal(managing.byTestId('chat-thread-invite-menu').length, 0, 'one list at a time');
});

test('B02 스타일: 역할 글자 11px 이상, 상태 점은 토큰 색, 누를 수 있는 것은 hover·active·focus 표현', () => {
  const rule = (selector) => {
    const at = surfaceCss.indexOf(`\n${selector} {`);
    assert.notEqual(at, -1, selector);
    return surfaceCss.slice(at, surfaceCss.indexOf('}', at));
  };
  assert.match(surfaceCss, /\.egd-codex-thread-member-role,\n\.egd-codex-thread-member-role-static \{[^}]*font-size: 11px;/);
  assert.match(rule('.egd-codex-thread-member'), /font-size: 11px;/);
  for (const [kind, token] of [['active', '--egd-primary'], ['waiting', '--egd-warning-ink'], ['blocked', '--egd-danger-ink'], ['done', '--egd-success-ink']]) {
    assert.match(rule(`.egd-codex-thread-member-status-${kind}`), new RegExp(`background: var\\(${token}\\);`));
  }
  assert.match(surfaceCss, /\.egd-codex-thread-member-clickable:hover,/);
  assert.match(surfaceCss, /\.egd-codex-thread-member-clickable:active \{/);
  assert.match(surfaceCss, /\.egd-codex-thread-member-clickable:focus-visible,\n\.egd-codex-thread-invite-trigger:focus-visible,\n\.egd-codex-thread-member-menu-item:focus-visible \{[^}]*outline: var\(--egd-focus-outline\);/);
  assert.match(rule('.egd-codex-thread-invite-menu'), /max-height: 300px;\s*overflow-y: auto;/);
});
