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
