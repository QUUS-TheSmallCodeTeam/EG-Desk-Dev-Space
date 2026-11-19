import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs';
import * as BoardThread from '../overlay/resources/EGDeskBoardThread.sys.mjs';
import { mentionNames } from '../overlay/resources/EGDeskChatComposer.sys.mjs';
import * as ThreadMembers from '../overlay/resources/EGDeskThreadMembers.sys.mjs';
import { boardMentions as runtimeMentions, boardMembers as runtimeMembers, CodexChatRuntime } from '../helper/codex-chat-runtime.mjs';
import { openChatStore } from '../helper/egdesk-chat-store.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';

const surfaceScript = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const ID_D = 'designer';
const ID_V = 'verifier';
const room = (extra = {}) => ({
  id: 'room-1', clientBindingId: 'room-1', type: 'group', title: 'Board Thread', engineId: 'codex',
  participants: ['나', '디자이너', '검증 담당', 'Codex'],
  participantRoles: { 나: 'owner', 디자이너: 'member', '검증 담당': 'admin', Codex: 'member' },
  participantAgents: { 디자이너: { profileId: ID_D, avatar: null }, '검증 담당': { profileId: ID_V, avatar: null }, Codex: { profileId: null, avatar: null } },
  messages: [], inputSources: [], briefingInputs: [], ...extra,
});

test('D-M2 mentions: the screen reads @이름 the same way the bridge does', () => {
  const thread = room({ participants: ['나', '디자인', '디자인 리뷰어'], participantAgents: { 디자인: { profileId: 'short' }, '디자인 리뷰어': { profileId: 'long' } } });
  const store = BoardThread.boardStoreMembers(thread);
  for (const message of ['@디자인 리뷰어 봐 주세요', '@디자인, @디자인 리뷰어 둘 다', 'mail@디자인 아님', '[리뷰](agent://long) 그리고 @디자인', '(@디자인) 확인', '@디자인님']) {
    assert.deepEqual(BoardThread.boardMentions(message, thread).map(agent => agent.profileId), runtimeMentions(message, runtimeMembers(store)), message);
  }
});

test('room members go to the chat store as room_members and come back as the same room', () => {
  const thread = room();
  const members = BoardThread.boardStoreMembers(thread);
  assert.deepEqual(members, [
    { kind: 'user', role: 'owner' },
    { kind: 'agent', profileId: ID_D, label: '디자이너', role: 'member' },
    { kind: 'agent', profileId: ID_V, label: '검증 담당', role: 'admin' },
    { kind: 'agent', label: 'Codex', role: 'member' },
  ]);
  assert.deepEqual(BoardThread.boardStoreMembers({ ...thread, type: 'dm' }), [], 'an Agent DM has no Board members');
  // What the store answers (memberKey, addedAt, label null for the person) reads back as no change.
  const saved = members.map((member, index) => ({ memberKey: member.kind === 'user' ? 'user' : member.profileId ? `agent:${member.profileId}` : 'legacy:x', profileId: null, label: null, addedAt: index, ...member }));
  assert.equal(BoardThread.threadFieldsFromStoreMembers(thread, saved), null);
  assert.equal(BoardThread.boardMembersSync(thread, { members: saved, saved: true }), null);
  // Another window added an Agent: the room shows it, faces captured here are kept.
  const withFace = room({ participantAgents: { ...room().participantAgents, 디자이너: { profileId: ID_D, avatar: { kind: 'emoji', value: '🦉', color: '#a9c5a9' } } } });
  const sync = BoardThread.boardMembersSync(withFace, { members: [...saved.slice(0, 2), { memberKey: 'agent:writer', kind: 'agent', profileId: 'writer', label: '작가', role: 'member' }] });
  assert.deepEqual(sync.restore.participants, ['나', '디자이너', '작가']);
  assert.deepEqual(sync.restore.participantRoles, { 나: 'owner', 디자이너: 'member', 작가: 'member' });
  assert.deepEqual(sync.restore.participantAgents.디자이너.avatar, { kind: 'emoji', value: '🦉', color: '#a9c5a9' });
  assert.deepEqual(sync.restore.participantAgents.작가, { profileId: 'writer', avatar: null });
  // The store has none yet: the Desk members move in once.
  assert.deepEqual(BoardThread.boardMembersSync(thread, { members: [], saved: false }), { save: members });
  assert.deepEqual(BoardThread.boardMembersRequest(thread, 'room-1'), { clientThreadId: 'room-1', members });
});

test('D-M2 routing: a mention or an Agent Lead goes to /chat/board/send; a plain-Codex Lead with no mention keeps /chat/send', () => {
  const thread = room({ messages: [
    { role: 'user', content: '어제 시안', status: 'complete' },
    { role: 'assistant', content: '확인했어요', authorName: '디자이너', status: 'complete' },
    { role: 'user', content: '보내는 중', status: 'submitting' },
  ] });
  const base = { message: '그냥 질문', requestId: 'req-1', clientThreadId: 'room-1', profileEnabled: false, conversationId: 'native-room', model: 'gpt-x' };
  assert.equal(BoardThread.boardSendPlan(thread, base), null, 'no mention, plain Codex: only the room answers, as before');
  assert.equal(BoardThread.boardSendPlan(thread, { ...base, message: '@Codex 봐 줘' }), null, 'the plain Codex has no Agent of its own');
  assert.equal(BoardThread.boardSendPlan({ ...thread, type: 'dm' }, { ...base, message: '@디자이너 봐 줘' }), null);

  const mentioned = BoardThread.boardSendPlan(thread, { ...base, message: '@검증 담당 @디자이너 봐 줘' });
  assert.equal(mentioned.path, '/chat/board/send');
  assert.deepEqual(mentioned.mentioned, [ID_V, ID_D]);
  assert.equal(mentioned.body.leadProfileId, null);
  for (const key of ['conversationId', 'profileEnabled', 'stateless', 'profileId']) assert.ok(!(key in mentioned.body), key);
  assert.deepEqual([mentioned.body.message, mentioned.body.requestId, mentioned.body.clientThreadId, mentioned.body.model], ['@검증 담당 @디자이너 봐 줘', 'req-1', 'room-1', 'gpt-x']);
  assert.deepEqual(mentioned.body.members, BoardThread.boardStoreMembers(thread));
  assert.deepEqual(mentioned.body.recentMessages, [{ role: 'user', text: '어제 시안' }, { role: 'agent', text: '확인했어요', author: '디자이너' }]);

  const lead = BoardThread.boardSendPlan(thread, { ...base, profileEnabled: true, profileId: ID_D, profileRevision: 3 });
  assert.deepEqual([lead.body.leadProfileId, lead.body.profileId, lead.body.profileRevision], [ID_D, ID_D, 3], 'with no mention the room\'s Agent answers as Lead');
  assert.deepEqual(BoardThread.boardSendPlan(thread, { ...base, message: '@디자이너 이 페이지', executionPolicy: { mode: 'browserBounded' } }), { error: 'BOARD_BROWSER_BOUNDED' });
  assert.equal(BoardThread.boardSendPlan(thread, { ...base, profileEnabled: true, profileId: ID_D, executionPolicy: { mode: 'browserBounded' } }), null,
    'a Browser-bounded send with no mention stays the ordinary single send');
  assert.match(BoardThread.boardSendErrorText('BOARD_CONCURRENCY_LIMIT'), /2명까지/);
  assert.equal(BoardThread.boardSendErrorText('OTHER'), null);
});

test('board send answers split into the Lead\'s run, the other members\' runs and each recipient\'s chip state', () => {
  const answer = { accepted: true, requestId: 'req-1', clientThreadId: 'room-1', recipients: [
    { profileId: ID_D, reason: 'lead', clientThreadId: 'room-1', requestId: 'req-1', status: 'started', conversationId: 'c-room', runId: 'r-1' },
    { profileId: ID_V, label: '검증 담당', reason: 'mentioned', clientThreadId: 'board-member:v', requestId: 'req-1~v', status: 'started', conversationId: 'c-v', runId: 'r-2' },
    { profileId: 'writer', reason: 'mentioned', clientThreadId: 'board-member:w', requestId: 'req-1~w', status: 'deferred', code: 'BOARD_CONCURRENCY_LIMIT' },
  ] };
  const outcome = BoardThread.boardSendOutcome(answer, 'req-1', { now: 5 });
  assert.deepEqual(outcome.lead, { accepted: true, requestId: 'req-1', clientThreadId: 'room-1', conversationId: 'c-room', runId: 'r-1' });
  assert.deepEqual(outcome.members.map(row => row.profileId), [ID_V]);
  assert.deepEqual(Object.fromEntries(Object.entries(outcome.routes).map(([id, route]) => [id, route.status])), { [ID_D]: 'started', [ID_V]: 'started', writer: 'deferred' });
  assert.equal(outcome.failure.code, 'BOARD_CONCURRENCY_LIMIT');
  const none = BoardThread.boardSendOutcome({ accepted: false, recipients: [{ profileId: ID_V, status: 'failed', code: 'PROFILE_NOT_FOUND', requestId: 'x' }] }, 'req-1');
  assert.deepEqual([none.accepted, none.lead, none.members.length, none.failure.code], [false, null, 0, 'PROFILE_NOT_FOUND']);
  const request = BoardThread.boardMemberRequest(answer.recipients[1], room(), { profiles: [{ id: ID_V, name: '검증 담당', avatar: null }] });
  assert.deepEqual(request, { requestId: 'req-1~v', clientThreadId: 'board-member:v', localThreadId: 'room-1', conversationId: 'c-v', authorName: '검증 담당' });
});

test('each member\'s state (작업 중 · 막힘 · 완료) comes from the run attributed to it, else the last board send', () => {
  const run = (profileId, status, extra = {}) => BoardThread.noteBoardRun({ status, requestId: `req-${profileId}`, ...extra }, { profileId, reason: 'mentioned' });
  assert.deepEqual(BoardThread.boardMemberState(ID_D, { runs: [run(ID_D, 'running')] }), { kind: 'active', label: '작업 중' });
  assert.deepEqual(BoardThread.boardMemberState(ID_D, { runs: [run(ID_D, 'completed')] }), { kind: 'done', label: '완료' });
  assert.deepEqual(BoardThread.boardMemberState(ID_D, { runs: [run(ID_D, 'failed')] }), { kind: 'blocked', label: '막힘' });
  assert.deepEqual(BoardThread.boardMemberState(ID_D, { runs: [run(ID_D, 'running')], connectedRunView: () => ({ state: 'approval' }) }), { kind: 'waiting', label: '승인 대기' });
  assert.equal(BoardThread.boardMemberState(ID_D, { runs: [run(ID_D, 'running')], connectedRunView: () => null }), null, 'disconnected: no guess');
  assert.deepEqual(BoardThread.boardMemberState(ID_V, { routes: { [ID_V]: { status: 'deferred', requestId: 'req-2' } } }), { kind: 'waiting', label: '차례 대기' });
  // A newer refused send outranks an older finished run.
  assert.deepEqual(BoardThread.boardMemberState(ID_D, { runs: [run(ID_D, 'completed')], routes: { [ID_D]: { status: 'failed', requestId: 'req-new' } } }), { kind: 'blocked', label: '막힘' });
  assert.equal(BoardThread.boardMemberState(ID_D, { runs: [run(ID_V, 'running')] }), null);
  const member = BoardThread.noteBoardRun({}, { profileId: ID_V, reason: 'mentioned', roomClientThreadId: 'room-1' }, { member: true });
  assert.deepEqual([member.board, BoardThread.isBoardMemberRun(member)], [{ profileId: ID_V, reason: 'mentioned', roomClientThreadId: 'room-1' }, true]);

  // The chips and the floating Chat head read the same states.
  const runs = [run(ID_D, 'running', { authorName: '디자이너' }), run(ID_V, 'failed', { authorName: '검증 담당' })];
  const chips = ThreadMembers.memberChipViews(room(), { runs, limit: 8 }).chips;
  assert.deepEqual(chips.map(chip => [chip.name, chip.status?.label || null]), [['나', null], ['디자이너', '작업 중'], ['검증 담당', '막힘'], ['Codex', null]]);
  const hud = ThreadMembers.hudMemberRowView(room(), { runs, limit: 2 });
  assert.deepEqual([hud.faces.map(chip => chip.name), hud.more, hud.summary, hud.label], [['디자이너', '검증 담당'], 1, '디자이너 작업 중 · 검증 담당 막힘', '참여 Agent 3명']);
  assert.equal(ThreadMembers.hudMemberRowView(room({ participants: ['나'] }), {}), null);
});

// ── Screen wiring, cut from the surface source ──
function sendHarness({ thread, reply, early = () => [], beforeReplay = () => {} }) {
  const state = { codex: { activeThreadId: thread.id, activityRoomGeneration: 1, threads: [thread], threadDrafts: { [thread.id]: thread.draft }, threadDraftRevisions: { [thread.id]: 1 },
    authStatus: { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'fixture@example.test', identityStatus: 'known' }, connected: true, liveRevision: 0, boardDeliverySupported: true } };
  const protocol = ChatState.createChatProtocolState();
  state.codex.chatProtocol = protocol;
  state.codex.codexAccountKey = ChatState.codexAccountKey(state.codex.authStatus);
  const calls = [], synced = [];
  const getCodexThreadById = (_codex, id) => state.codex.threads.find(item => item.id === id) || null;
  const updateThreadById = (id, update) => { state.codex.threads = state.codex.threads.map(item => item.id === id ? update(item) : item); return getCodexThreadById(null, id); };
  const deps = { state, ChatState, InputContext, BoardThread, protocol, memoAskSendReservations: new Map(),
    getActiveCodexThread: codex => getCodexThreadById(codex, codex.activeThreadId), getCodexThreadById, getCodexThreadDraft: (codex, id) => codex.threadDrafts[id] || '',
    clearMemoManualSendNotice: () => false, showMemoManualSendNotice: () => {}, threadBusy: () => false, chatRoomProjectSendBlock: () => null,
    chatRequestProjectDisplays: new Map(), epochScope: ChatState.createChatEpochScope(), ensureNativeReadyForSend: async () => true, updateThreadById, emit() {},
    captureThreadInputs: async () => [], codexThreadAgentProfile: () => ({ name: '디자이너' }), SELF_MEMBER: '나',
    createCodexMessage: (role, content, status, options) => ({ role, content, status, ...options }),
    appendMessageToThread: (id, message) => updateThreadById(id, item => ({ ...item, messages: [...item.messages, message] })),
    codexThreadRuntimeConfig: current => (current.profileEnabled ? { profileId: ID_D, profileRevision: 2 } : {}), browserToolSelectedSources: () => [], rootSseReady: () => ({ sourceReady: true }),
    chatRoomProjectState: () => null, normalizeChatRoomProjectDefault: value => value, CHAT_ROOM_PROJECT_UNAVAILABLE: 'project unavailable',
    CHAT_REQUEST_PROJECT_INVALID: 'project invalid', codexProfileCatalog: { status: 'ready', profiles: [{ id: ID_V, name: '검증 담당', avatar: null }] },
    fetchJson: async (path, options) => { calls.push([path, JSON.parse(options.body)]); return reply(path, JSON.parse(options.body)); },
    syncProtocolRun: run => synced.push(run),
    boardEarlyEvents: BoardThread.createBoardEarlyEvents(), replayed: [], warnings: [], TAG: 'fixture',
    console: { warn: (...args) => deps.warnings.push(args) },
  };
  // The live stream's chat.event path, as far as admission goes: an unknown request is held for a pending board send.
  deps.handleEvent = event => {
    if (!ChatState.canAdmitChatEvent(protocol, state.codex.threads, event)) { deps.boardEarlyEvents.hold(event); return; }
    beforeReplay(event);
    deps.replayed.push(ChatState.reduceChatEvent(protocol, event));
  };
  const realFetch = deps.fetchJson;
  deps.fetchJson = async (path, options) => { for (const event of early(JSON.parse(options.body))) deps.handleEvent(event); return realFetch(path, options); };
  state.codexBridge = { prepareRoomProjectSend: async () => ({}) };
  const cut = (from, to) => {
    const start = surfaceScript.indexOf(from), end = surfaceScript.indexOf(to, start);
    assert.ok(start >= 0 && end > start, from);
    return surfaceScript.slice(start, end);
  };
  const receiptNames = ['createAcceptedReceiptWatch', 'rememberAcceptedInputReceipt'];
  Object.assign(deps, compileFunction(`${receiptNames.map(name => cut(`  function ${name}(`, '\n  }\n') + '\n  }').join('\n')}\nreturn { ${receiptNames.join(', ')} };`,
    ['state', 'ChatState', 'getCodexThreadById'])(state, ChatState, getCodexThreadById));
  deps.watchMemoRead = compileFunction(`${cut('    const memoReadWatches = new Map();', '    const confirmedLegacyImports')}\nreturn watchMemoRead;`,
    ['state', 'ChatState', 'getCodexThreadById', 'memoAskRuntimeIdentity'])(state, ChatState, getCodexThreadById, () => null);
  deps.snapshotChatRoomProjectExpectation = () => null;
  const plannerNames = ['chatSendEngineId', 'boardBrowserSourcesKey', 'boardComposerInputState', 'boardComposerDelivery'];
  Object.assign(deps, compileFunction(plannerNames.map(name => cut('  function ' + name + '(', '\n  }\n') + '\n  }').join('\n')
    + '\nreturn { ' + plannerNames.join(', ') + ' };', Object.keys(deps))(...Object.values(deps)));
  deps.acceptBoardSend = compileFunction(`${cut('    function acceptBoardSend(', '\n    // One catalog read at a time;')}\nreturn acceptBoardSend;`, Object.keys(deps))(...Object.values(deps));
  const send = compileFunction(`return { ${cut('      async sendMessage(', '\n      },\n')}\n      } };`, Object.keys(deps))(...Object.values(deps)).sendMessage;
  const listeners = new Set();
  return { state, protocol, calls, synced, deps, send: () => send.call({ subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } }, {}),
    thread: () => getCodexThreadById(null, thread.id) };
}

test('the real composer send: an @mention in a Board Thread goes to /chat/board/send and each member\'s run shows in the room', async () => {
  const h = sendHarness({ thread: room({ draft: '@검증 담당 확인해 주세요', profileEnabled: true }), reply: (path, body) => ({
    accepted: true, requestId: body.requestId, clientThreadId: body.clientThreadId, recipients: [
      { profileId: ID_V, label: '검증 담당', reason: 'mentioned', clientThreadId: 'board-member:v', requestId: `${body.requestId}~v`, status: 'started', conversationId: 'c-v', runId: 'r-v' }],
  }) });
  // The room's own project check is a fixture: the room has no project.
  const result = await h.send();
  assert.deepEqual(h.calls.map(([path]) => path), ['/chat/board/send']);
  const body = h.calls[0][1];
  assert.deepEqual([body.leadProfileId, 'conversationId' in body, 'profileEnabled' in body], [ID_D, false, false]);
  assert.deepEqual(result, { requestId: body.requestId, accepted: true });
  const sent = h.thread().messages.find(message => message.role === 'user');
  assert.equal(sent.status, 'complete', 'only a mentioned member answers: the room\'s own request is done');
  assert.equal(h.thread().boardRoutes[ID_V].status, 'started');
  const memberRun = h.protocol.runs[ChatState.runKey('c-v', 'r-v')];
  assert.deepEqual([memberRun.localThreadId, memberRun.authorName, memberRun.boardMember, memberRun.board.profileId], ['room-1', '검증 담당', true, ID_V]);
  assert.equal(h.synced.at(-1), memberRun);
  assert.equal(h.thread().conversationId, undefined, 'a member\'s answer never rebinds the room');
  // A later event of that member is admitted (its request is known) and keeps the attribution.
  assert.ok(ChatState.canAdmitChatEvent(h.protocol, h.state.codex.threads, { requestId: `${body.requestId}~v`, clientThreadId: 'board-member:v', conversationId: 'c-v' }));
});

test('the real composer send: no mention with an Agent Lead answers in the room; a refusal says why in Korean', async () => {
  const lead = sendHarness({ thread: room({ draft: '정리해 주세요', profileEnabled: true }), reply: (path, body) => ({
    accepted: true, requestId: body.requestId, clientThreadId: body.clientThreadId, recipients: [
      { profileId: ID_D, reason: 'lead', clientThreadId: body.clientThreadId, requestId: body.requestId, status: 'started', conversationId: 'c-room', runId: 'r-1' }],
  }) });
  const accepted = await lead.send();
  assert.equal(accepted.accepted, true);
  const run = lead.protocol.runs[ChatState.runKey('c-room', 'r-1')];
  assert.deepEqual([run.localThreadId, run.board.profileId, run.boardMember], ['room-1', ID_D, undefined]);

  const plain = sendHarness({ thread: room({ draft: '그냥 질문' }), reply: () => ({ accepted: true, conversationId: 'c-plain', runId: 'r-plain' }) });
  await plain.send();
  assert.deepEqual(plain.calls.map(([path]) => path), ['/chat/send'], 'a plain-Codex Lead with no mention keeps the ordinary send');

  const busy = sendHarness({ thread: room({ draft: '@검증 담당 확인', profileEnabled: true }), reply: (path, body) => ({
    accepted: false, requestId: body.requestId, clientThreadId: body.clientThreadId, recipients: [
      { profileId: ID_V, reason: 'mentioned', clientThreadId: 'board-member:v', requestId: `${body.requestId}~v`, status: 'deferred', code: 'BOARD_CONCURRENCY_LIMIT' }],
  }) });
  const refused = await busy.send();
  assert.equal(refused.accepted, false);
  assert.match(busy.thread().sendError, /2명까지 동시에/);
  assert.equal(busy.thread().boardRoutes[ID_V].status, 'deferred');
});

test('screen wiring: member changes are saved to the store, opening a Board Thread reads them back, the HUD head draws the member row', () => {
  assert.match(surfaceScript, /if \(selected\?\.type === 'group'\) void syncBoardMembers\(threadId\);/);
  assert.equal((surfaceScript.match(/void saveBoardMembers\((?:threadId|targetId)\);/g) || []).length, 3, 'invite, remove and role change');
  assert.match(surfaceScript, /fetchJson\(BoardThread\.BOARD_MEMBERS_PATH, \{ method: 'POST'/);
  assert.match(surfaceScript, /activeThread\.type === 'group' \? renderHudMemberRow\(activeThread\) : null/);
  assert.match(surfaceScript, /data: \{ testid: 'chat-hud-members' \}/);
  assert.match(surfaceScript, /event\.event === 'run\.started' && event\.details\?\.board\) BoardThread\.noteBoardRun\(run, event\.details\.board\)/);
  assert.match(surfaceScript, /\.\.\.\(boardMemberRun \? \{\} : \{ conversationId: run\.conversationId \}\)/);
  assert.match(surfaceCss, /\.egd-codex-hud-members \{/);
});

test('CHAT-10 (a): early member events replay in arrival order even if a handler throws', async () => {
  const attempts = [];
  const failure = new Error('fixture dispatch failure');
  const chatEvent = (requestId, seq, event, details = {}) => ({ type: 'chat.event', v: 2, streamId: 's-1', seq, event, requestId, clientThreadId: 'board-member:v',
    conversationId: 'c-v', runId: 'r-v', engineId: 'codex', ts: '2026-11-17T00:00:00Z', details });
  const h = sendHarness({ thread: room({ draft: '@검증 담당 확인해 주세요', profileEnabled: true }),
    beforeReplay: event => { attempts.push(event.seq); if (event.seq === 2) throw failure; },
    early: body => [
      chatEvent(`${body.requestId}~v`, 1, 'run.started', { board: { profileId: ID_V, reason: 'mentioned', roomClientThreadId: 'room-1' } }),
      chatEvent(`${body.requestId}~v`, 2, 'message.delta', { messageId: 'm-v', delta: '확인' }),
      chatEvent(`${body.requestId}~v`, 3, 'message.completed', { messageId: 'm-v', text: '확인했습니다' }),
      chatEvent('someone-else~x', 4, 'message.completed', { messageId: 'm-x', text: '남의 것' }),
    ],
    reply: (path, body) => ({ accepted: true, requestId: body.requestId, clientThreadId: body.clientThreadId, recipients: [
      { profileId: ID_V, label: '검증 담당', reason: 'mentioned', clientThreadId: 'board-member:v', requestId: `${body.requestId}~v`, status: 'started', conversationId: 'c-v', runId: 'r-v' }] }) });
  const result = await h.send();
  assert.equal(result.accepted, true);
  assert.deepEqual(attempts, [1, 2, 3], 'the failed event is not retried and the unrelated event is not admitted');
  assert.equal(h.deps.replayed.length, 2, 'both surrounding events are handled');
  assert.deepEqual(h.deps.warnings, [['fixture', 'board member early event dispatch failed', failure]]);
  const run = h.protocol.runs[ChatState.runKey('c-v', 'r-v')];
  assert.equal(run.messages.find(message => message.id === 'm-v')?.content, '확인했습니다');
  assert.equal(run.boardMember, true);
  assert.equal(h.deps.boardEarlyEvents.size(h.calls[0][1].requestId), 0, 'the send is no longer pending');
});

test('CHAT-10 (a): the early-event buffer is per pending send, bounded and short-lived', () => {
  let clock = 0;
  const buffer = BoardThread.createBoardEarlyEvents({ max: 3, ttlMs: 1000, now: () => clock });
  assert.equal(buffer.hold({ requestId: 'req-1~a' }), false, 'nothing pending: not held');
  buffer.open('req-1'); buffer.open('req-2');
  assert.equal(buffer.hold({ requestId: 'req-1' }), false, 'the Lead\'s own request is registered before sending');
  assert.equal(buffer.hold({ requestId: 'req-10~a' }), false, 'another request that only shares a prefix');
  for (let seq = 1; seq <= 5; seq++) assert.equal(buffer.hold({ requestId: 'req-1~a', seq }), true);
  assert.equal(buffer.hold({ requestId: 'req-2~b', seq: 9 }), true);
  assert.deepEqual(buffer.release('req-1').map(event => event.seq), [3, 4, 5], 'only the latest few are kept');
  assert.deepEqual(buffer.release('req-1'), [], 'released once');
  clock = 5000;
  assert.deepEqual(buffer.release('req-2'), [], 'held events expire');
  buffer.open('req-3'); buffer.hold({ requestId: 'req-3~c' }); buffer.close('req-3');
  assert.deepEqual(buffer.release('req-3'), [], 'a failed send drops what it held');
});

test('CHAT-10 (b): after a restart the other members\' stored answers come back into the room, once, by time', () => {
  const events = [{ event: 'message.completed' }, { event: 'board.routed', details: { requestId: 'req-1', recipients: [
    { profileId: ID_D, reason: 'lead', clientThreadId: 'room-1', status: 'started' },
    { profileId: ID_V, label: '검증 담당', reason: 'mentioned', clientThreadId: 'board-member:v', status: 'started', conversationId: 'c-v', runId: 'r-v' },
    { profileId: 'writer', label: '작가', reason: 'mentioned', clientThreadId: 'board-member:w', status: 'deferred' }] } }];
  const routed = BoardThread.boardRoutedMembers(events);
  assert.deepEqual([...routed], [['board-member:v', { profileId: ID_V, label: '검증 담당' }]], 'only a member that started, in its own conversation');
  assert.equal(BoardThread.isBoardMemberThreadId('board-member:v'), true);
  assert.equal(BoardThread.isBoardMemberThreadId('room-1'), false);
  const thread = room({ messages: [
    { id: 'u1', role: 'user', content: '@검증 담당 확인', status: 'complete', createdAt: '2026-11-17T10:00:00Z', localSeq: 1 },
    { id: 'a1', role: 'assistant', content: '디자이너 답', status: 'complete', createdAt: '2026-11-17T10:05:00Z', localSeq: 4 },
  ] });
  const stored = [
    { id: 'mu', localMessageId: 'mu', role: 'user', content: '@검증 담당 확인', status: 'complete', createdAt: '2026-11-17T10:00:00Z', localSeq: 1 },
    { id: 'mv', localMessageId: 'mv', role: 'assistant', content: '검증했습니다', status: 'complete', createdAt: '2026-11-17T10:02:00Z', localSeq: 2, runId: 'r-v' },
    { id: 'mz', localMessageId: 'mz', role: 'assistant', content: '', status: 'complete', createdAt: '2026-11-17T10:03:00Z' },
  ];
  const profiles = [{ id: ID_V, name: '검증 담당', avatar: { kind: 'emoji', value: '🦉', color: '#a9c5a9' } }];
  const folded = BoardThread.foldBoardMemberAnswers(thread, stored, routed.get('board-member:v'), { profiles });
  assert.deepEqual(folded.map(message => message.id), ['u1', 'mv', 'a1'], 'the member\'s copy of the person\'s message stays out; its answer sits by time');
  const answer = folded[1];
  assert.deepEqual([answer.authorName, answer.authorAvatar?.value, answer.boardMemberProfileId, 'localSeq' in answer], ['검증 담당', '🦉', ID_V, false]);
  assert.deepEqual(BoardThread.foldBoardMemberAnswers({ ...thread, messages: folded }, stored, routed.get('board-member:v'), { profiles }).map(message => message.id),
    ['u1', 'mv', 'a1'], 'read twice, shown once');
});

test('two addressed Board members keep separate authors through live replies and repeated history loads', () => {
  const requested = room({ messages: [{ id: 'question', role: 'user', content: '@디자이너 @검증 담당 확인' }] });
  const { recipients } = BoardThread.boardDeliveryIntent(requested, requested.messages[0].content);
  assert.deepEqual(recipients.map(r => r.profileId), [ID_D, ID_V]);
  const members = recipients.map(({ profileId, label }) => ({ profileId, label, reason: 'mentioned',
    requestId: `request~${profileId}`, clientThreadId: `board-member:${profileId}`, conversationId: `conversation-${profileId}`, runId: `run-${profileId}` }));
  const sharedText = '확인했습니다', itemId = 'item-1'; // Provider item IDs are scoped to a turn; identical text is not an identity either.
  for (const order of [members, [...members].reverse()]) {
    let thread = { ...requested }, seq = 0;
    const state = ChatState.createChatProtocolState();
    for (const member of members) {
      ChatState.registerChatRequest(state, BoardThread.boardMemberRequest(member, thread), { isLoggedIn: true });
      const run = ChatState.acceptChatRequest(state, { accepted: true, ...member }, member.requestId);
      BoardThread.noteBoardRun(run, member, { member: true });
      assert.equal(run.localThreadId, thread.id);
    }
    const checkAuthors = () => {
      const answers = thread.messages.filter(m => m.role === 'assistant');
      assert.equal(answers.length, 2);
      for (const member of members) {
        const answer = answers.find(m => m.conversationId === member.conversationId && m.runId === member.runId);
        assert.deepEqual([answer?.authorName, answer?.content, answer?.localMessageId, answer?.boardMemberProfileId],
          [member.label, sharedText, `stored-${member.profileId}`, member.profileId]);
        assert.equal(ChatState.answerForPeek(answers, { messageId: answer.id, answerKey: ChatState.answerPeekKey(answer) }), answer);
      }
      assert.equal(thread.messages.filter(m => m.role === 'user').length, 1);
    };
    for (const event of ['message.delta', 'message.completed']) for (const member of order) {
      const { conversationId, runId, requestId, clientThreadId, profileId } = member;
      const run = ChatState.reduceChatEvent(state, { type: 'chat.event', v: 2, provider: 'codex', engineId: 'codex', streamId: 'fixture',
        seq: ++seq, ts: seq, event, requestId, clientThreadId, conversationId, runId, localRunId: `local-${profileId}`,
        localMessageId: `stored-${profileId}`, itemId, details: event === 'message.delta' ? { messageId: itemId, delta: '확인' } : { messageId: itemId, text: sharedText } });
      assert.ok(run);
      thread = { ...thread, messages: ChatState.projectRunMessages(thread.messages, run) };
    }
    checkAuthors();
    for (let load = 0; load < 2; load++) {
      for (const member of [...order].reverse()) {
        const id = `stored-${member.profileId}`;
        const history = [{ id, localMessageId: id, providerItemId: itemId, role: 'assistant', status: 'complete', content: sharedText,
          conversationId: member.conversationId, runId: member.runId, localSeq: 1, createdAt: 5 }];
        thread = { ...thread, messages: BoardThread.foldBoardMemberAnswers(thread, history, member) };
      }
      checkAuthors();
    }
  }
});

test('restoring a Board member preserves each completed item in a run and skips only the same stored item', () => {
  const member = { profileId: ID_V, label: '검증 담당' };
  const history = ['checking', 'final'].map((item, i) => ({ id: `local-${item}`, localMessageId: `local-${item}`,
    providerItemId: item, role: 'assistant', phase: i ? 'final_answer' : null, status: 'complete', content: i ? '최종 답변' : '먼저 확인한 내용',
    runId: 'one-run', conversationId: 'member-conversation', localSeq: i + 1, createdAt: i + 1 }));
  const restore = (thread, page) => ({ ...thread, messages: BoardThread.foldBoardMemberAnswers(thread, page, member) });
  const legacy = history.map(({ localMessageId, ...record }) => record);
  let legacyRoom = restore(room(), legacy);
  legacyRoom = restore(legacyRoom, legacy);
  assert.deepEqual(legacyRoom.messages.map(m => m.providerItemId), ['checking', 'final'], 'distinct known provider items in a legacy run');
  for (const order of [history, [...history].reverse()]) {
    let thread = restore(room(), order);
    thread = restore(thread, history); // overlapping pages or a second open must not repeat either row
    assert.deepEqual(thread.messages.map(m => [m.localMessageId, m.content, m.boardMemberProfileId]),
      [['local-checking', '먼저 확인한 내용', ID_V], ['local-final', '최종 답변', ID_V]]);
  }
});

test('a later member page fills only the same stored answer and preserves the cached row', () => {
  const member = { profileId: ID_V, label: ID_V };
  const cached = { boardMemberProfileId: ID_V, id: 'view', localMessageId: 'stored', localRunId: 'local-run', content: '내 화면', role: 'assistant' };
  const later = { ...cached, id: 'stored', content: '저장소', localHistory: true, runId: 'turn', conversationId: 'member-native' };
  const fold = row => BoardThread.foldBoardMemberAnswers(room({ messages: [row] }), [later], member);
  assert.deepEqual(fold(cached), [{ ...cached, runId: 'turn', conversationId: 'member-native' }]);
  for (const original of [{ ...cached, localRunId: 'old-run' }, { ...cached, runId: 'another-turn' }, { ...cached, boardMemberProfileId: ID_D }]) {
    assert.deepEqual(fold(original), [original], 'a different origin must not be patched');
  }
});

test('cache-free Board replies retain their own run through a reopened SQLite history page', t => {
  const dataDir = createPrivateQaTempDirectory('egdesk-board-origin-');
  const open = () => openChatStore({ dataDir, ownerScope: 'fixture-only' });
  let store;
  t.after(() => { try { store?.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); } });
  store = open();
  const members = [ID_V, ID_D].map(profileId => ({ profileId, label: profileId, clientThreadId: `board-member:${profileId}` }));
  for (const { profileId, clientThreadId } of members) {
    store.createConversation({ clientThreadId });
    const runId = `turn-${profileId}`, conversationId = `conversation-${profileId}`;
    const messages = (profileId === ID_V ? ['commentary', 'final_answer'] : ['final_answer']).map(phase => ({
      id: phase, messageId: phase, role: 'assistant', status: 'complete', phase, text: '같은 내용', localMessageId: `stored-${profileId}-${phase}`,
    })); // Both members reuse the provider's item ID and even the same local run key in different conversations.
    store.appendEvent({ clientThreadId, event: 'run.completed', eventKey: 'completed', ts: 1,
      localRunId: 'local-run', runId, details: {}, runCheckpoint: { clientThreadId, conversationId, runId, answerId: `${conversationId}/${runId}`,
        board: { roomClientThreadId: 'room-1', profileId }, localRunId: 'local-run', status: 'completed', messages } });
  }
  store.close(); store = open();
  const chat = new CodexChatRuntime({ store, request: () => assert.fail('history contacted the engine'), respond: () => {} });
  let restored = room();
  for (let load = 0; load < 2; load++) for (const member of members) {
    const page = chat.getLocalHistory({ clientThreadId: member.clientThreadId });
    const history = ChatState.normalizeLocalHistoryPage(page, member.clientThreadId);
    assert.ok(!history.messages.some(ChatState.isChatWorkNote));
    if (member.profileId === ID_V) assert.equal(history.runs[0].activities.find(a => a.kind === 'workNote')?.detail.text, '같은 내용');
    const owner = { ...member, roomId: restored.id };
    restored = { ...restored, messages: BoardThread.foldBoardMemberAnswers(restored, history.messages, member),
      localRuns: BoardThread.foldBoardMemberWork(restored, history.messages, history.runs, owner, history) };
  }
  assert.equal(restored.messages.length, 2);
  assert.deepEqual(restored.localRuns.map(r => [r.board.profileId, r.activities.map(a => a.detail.text)]), [[ID_V, ['같은 내용']]]);
  for (const member of members) {
    const rows = restored.messages.filter(m => m.boardMemberProfileId === member.profileId);
    assert.deepEqual(rows.map(m => m.phase), ['final_answer']);
    for (const m of rows) {
      const conversationId = `conversation-${member.profileId}`, runId = `turn-${member.profileId}`;
      assert.deepEqual([m.conversationId, m.runId, m.answerId], [conversationId, runId, `${conversationId}/${runId}`]);
      assert.deepEqual([m.localHistory, m.id, m.localMessageId, m.providerItemId, m.authorName],
        [true, `stored-${member.profileId}-${m.phase}`, m.id, m.phase, member.label]);
    }
  }
});

test('CHAT-10 robustness wiring: early events held and replayed, member conversations folded into their room, never shown as rooms', () => {
  assert.match(surfaceScript, /if \(!ChatState\.canAdmitChatEvent\(protocol, state\.codex\.threads, event\)\) \{ boardEarlyEvents\.hold\(event\); return; \}/);
  assert.match(surfaceScript, /if \(boardPlan\) boardEarlyEvents\.open\(requestId\);/);
  assert.match(surfaceScript, /\.finally\(\(\) => boardEarlyEvents\.close\(requestId\)\)/);
  assert.match(surfaceScript, /if \(!BoardThread\.isBoardMemberThreadId\(summary\.clientThreadId\)\) await loadLocalHistoryThread\(summary\);/);
  assert.match(surfaceScript, /if \(BoardThread\.isBoardMemberThreadId\(summary\.clientThreadId\)\) \{\s+const partialRoom = await restoreBoardMemberAnswers\(summary\);/);
  assert.match(surfaceScript, /BoardThread\.boardRoutedMembers\(normalized\.events\)\) boardMemberRooms\.set\(/);
});

function historyHarness({ summaries, routes, read }) {
  const threads = [room(), room({ id: 'room-2' })];
  const state = { codex: { threads, localHistoryBootReady: true } };
  const restore = surfaceScript.match(/    const BOARD_MEMBER_HISTORY_MAX_PAGES[\s\S]*?(?=    async function loadLocalHistoryThread)/)?.[0];
  const load = surfaceScript.match(/    async function loadLocalHistory\(legacyRecords[\s\S]*?(?=    const scheduleReconnect)/)?.[0];
  const render = surfaceScript.match(/        if \(codex\.boardMemberHistoryPartialRooms\?\.has\(activeThread\.id\)\)[\s\S]*?(?=        const bindingHeld)/)?.[0];
  assert.ok(restore && load && render);
  const calls = [];
  const deps = { state, ChatState, BoardThread, boardMemberRooms: routes, codexProfileCatalog: { profiles: [] },
    listLocalHistoryThreads: async () => summaries,
    getCodexThreadById: (codex, id) => codex.threads.find(thread => thread.id === id),
    updateThreadById: (id, update) => { state.codex.threads = state.codex.threads.map(thread => thread.id === id ? update(thread) : thread); },
    fetchJson: async path => {
      const url = new URL(path, 'http://fixture.invalid');
      assert.equal(url.pathname, '/chat/history');
      assert.equal(url.searchParams.get('limit'), '100');
      const id = url.searchParams.get('clientThreadId'), cursor = Number(url.searchParams.get('afterSeq'));
      calls.push([id, cursor]);
      return read(summaries.find(summary => summary.clientThreadId === id), cursor);
    },
    emit() {},
  };
  const boot = compileFunction(`let localLoadPromise, lastLocalLoadAt, legacyHistoryRecords, localRetryTimer, localAutoRetryEligible;
    ${restore}\n${load}\nreturn loadLocalHistory;`, Object.keys(deps))(...Object.values(deps));
  const present = compileFunction(`const notices = []; const conversation = { appendChild: node => notices.push(node) };
    ${render}\nreturn notices;`, ['codex', 'activeThread', 'el']);
  return { boot, calls, state, messages: id => deps.getCodexThreadById(state.codex, id).messages,
    notices: id => present(state.codex, { id }, (_tag, props, text) => ({ props, text })) };
}

const memberSummary = id => ({ clientThreadId: `board-member:${id}`, localConversationId: `store-${id}` });
const memberPage = (thread, cursor, hasMore, nextCursor = cursor + 100) => ({
  protocolVersion: 1, thread, hasMore, nextCursor, events: [], messages: [
    { localMessageId: `${thread.clientThreadId}-${cursor}`, role: 'assistant', text: `answer ${cursor}`, createdAt: 10000 - cursor },
  ],
});

test('Board restart scan caps reads per member and reports partial answers only in the owning room', async () => {
  const [long, sameRoom, otherRoom, unrouted] = ['long', 'same', 'other', 'unrouted'].map(memberSummary);
  let lastPageHasMore = true;
  const h = historyHarness({ summaries: [long, sameRoom, otherRoom, unrouted], routes: new Map([
    [long.clientThreadId, { roomId: 'room-1', profileId: ID_V }],
    [sameRoom.clientThreadId, { roomId: 'room-1', profileId: ID_D }],
    [otherRoom.clientThreadId, { roomId: 'room-2', profileId: ID_D }],
  ]), read: (summary, cursor) => memberPage(summary, cursor, summary === long && (cursor < 1900 || lastPageHasMore)) });
  assert.equal(await h.boot(), true);
  const expectedCalls = [...Array.from({ length: 20 }, (_, index) => [long.clientThreadId, index * 100]),
    [sameRoom.clientThreadId, 0], [otherRoom.clientThreadId, 0]];
  assert.deepEqual(h.calls, expectedCalls);
  assert.equal(h.state.codex.localHistoryStatus, 'ready', 'unrelated history is not reported as a global failure');
  assert.equal(h.messages('room-1').length, 21);
  assert.equal(h.messages('room-1')[0].id, `${long.clientThreadId}-1900`, 'valid answers keep chronological display order');
  assert.deepEqual(h.messages('room-2').map(message => message.id), [`${otherRoom.clientThreadId}-0`]);
  assert.deepEqual(h.state.codex.threads.map(thread => thread.id), ['room-1', 'room-2']);
  const [notice] = h.notices('room-1');
  assert.equal(notice.props.role, 'status');
  assert.match(notice.text, /멤버 답변 기록을 모두 불러오지 못했습니다/);
  assert.deepEqual(h.notices('room-2'), []);

  lastPageHasMore = false;
  assert.equal(await h.boot(), true);
  assert.deepEqual(h.calls.slice(expectedCalls.length), expectedCalls, 'a terminal twentieth page needs no extra read');
  assert.deepEqual(h.notices('room-1'), [], 'a complete scan clears the notice');
  assert.equal(h.messages('room-1').length, 21, 'a reload does not duplicate answers');
});

test('Board restart scan stops at a stalled cursor and rejects a page with a different thread identity', async () => {
  const [stalled, wrong] = ['stalled', 'wrong'].map(memberSummary);
  const h = historyHarness({ summaries: [stalled, wrong], routes: new Map([
    [stalled.clientThreadId, { roomId: 'room-1', profileId: ID_V }],
    [wrong.clientThreadId, { roomId: 'room-2', profileId: ID_D }],
  ]), read: (summary, cursor) => summary === stalled ? memberPage(summary, cursor, true, cursor)
    : memberPage({ ...summary, localConversationId: 'different-store-thread' }, cursor, false) });
  assert.equal(await h.boot(), true);
  assert.deepEqual(h.calls, [[stalled.clientThreadId, 0], [wrong.clientThreadId, 0]]);
  assert.deepEqual(h.messages('room-1').map(message => message.id), [`${stalled.clientThreadId}-0`]);
  assert.deepEqual(h.messages('room-2'), []);
  assert.equal(h.notices('room-1').length, 1);
  assert.equal(h.notices('room-2').length, 1);
});

test('Board intent reports exact ordered identities, real default engine, and a bounded board block', () => {
  const thread = room({ messages: [
    { role: 'user', content: '첫 질문', status: 'complete' },
    { role: 'assistant', content: '답변', status: 'complete' },
    { role: 'user', content: '포함하지 않음', status: 'failed' },
  ] });
  const plan = (message, options) => BoardThread.boardDeliveryIntent(thread, message, { supportsBoardDelivery: true, ...options });
  assert.deepEqual(plan('[@검증 담당](agent://verifier) @디자이너').recipients.map(row => row.profileId), [ID_V, ID_D]);
  assert.deepEqual(plan('@디자이너').roomBlock, { memberCount: 3, recentTurnCount: 2 });
  assert.equal(plan('@Codex 확인').route, 'room');
  assert.equal(plan('@Claude 확인', { engine: 'claude' }).recipients[0].label, 'Claude');
  const lead = { profileEnabled: true, profileId: ID_D };
  const bounded = plan('확인', { ...lead, browserScope: true });
  assert.equal(bounded.route, 'room');
  assert.equal(bounded.roomBlock, null);
  assert.deepEqual(bounded.expectedBoardDelivery.recipientIds, [ID_D]);
  assert.equal(plan('확인', { ...lead, engine: 'claude' }).code, 'BOARD_ENGINE_UNSUPPORTED');
  assert.equal(plan('@디자이너', { browserScope: true }).code, 'BOARD_BROWSER_BOUNDED');
  assert.equal(plan('@디자이너 @검증 담당', { stateless: true }).code, 'BOARD_STATELESS_UNSUPPORTED');
  assert.equal(plan('@디자이너', { supportsBoardDelivery: false }).code, 'BOARD_DELIVERY_UNAVAILABLE');
  assert.equal(plan('@Codex 확인', { supportsBoardDelivery: false }).expectedBoardDelivery, null);
  const picked = [{ kind: 'file', title: '표.pdf', id: 'private' }];
  assert.equal(plan('@디자이너', { selectedResources: picked }).code, 'BOARD_CONTEXT_SCOPE');
  assert.deepEqual(plan('@디자이너', { ...lead, selectedResources: picked }).selectedResources, [{ kind: 'file', label: '표.pdf' }]);
  assert.equal(plan('@검증 담당', { contextResolution: { resolutionId: 'room-only', chosen: [] } }).ok, true);
  assert.equal(plan('@검증 담당', { contextResolution: { resolutionId: 'room-only', chosen: ['file'] } }).code, 'BOARD_CONTEXT_SCOPE');
});

test('Board rejects stale or mixed addresses in Korean prose, never narrows the requested recipients', () => {
  const thread = room({ participants: ['나', '물결'], participantAgents: { 물결: { profileId: 'water' } } });
  for (const message of ['@삭제된이름 확인', '확인해줘 @삭제된이름', '@물결 @없는이름', '@물결 확인 후 @없는이름', '확인,@삭제된이름',
    '@물결 @Codex 확인', '@all 검토', '그런데 @EVERYONE 검토', '@나 확인', '@물결님', '@물결2', '@물결.dev',
    '[지운 Agent](agent://gone) 검토', '@물결 [지운 Agent](agent://gone) 검토', '[@오류](agent://) 확인']) {
    assert.equal(BoardThread.boardDeliveryIntent(thread, message).code, 'BOARD_UNRESOLVED_ADDRESS', message);
  }
  assert.deepEqual(BoardThread.boardDeliveryIntent(thread, '확인해줘 (@물결), [이전 이름](agent://water)').recipients.map(row => row.profileId), ['water']);
  const renamed = { ...thread, ...BoardThread.threadFieldsFromStoreMembers(thread, [{ kind: 'agent', profileId: 'water', label: '파도' }]) };
  assert.equal(BoardThread.boardDeliveryIntent(renamed, '확인해줘 @물결').code, 'BOARD_UNRESOLVED_ADDRESS');
  assert.deepEqual(BoardThread.boardDeliveryIntent(renamed, '@파도 확인').expectedBoardDelivery.recipientIds, ['water']);
});

test('literal mail, URLs, and code never route or narrow Board sends', () => {
  const thread = room();
  for (const message of ['person@host.example 연락', 'abc@디자이너.com 연락', '"메일 @없는이름"@example.com 연락',
    'https://example.com/@디자이너', 'https://:@디자이너.example/', 'ftp://:@없는이름.example/',
    '[@디자이너](https://example.com/) 링크', '<[@디자이너](agent://designer)> 문자열',
    '`@everyone` 문자열', '`` ` @디자이너 [@디자이너](agent://designer) ``',
    '```js\r\n@디자이너 @없는이름\r\n```', '~~~js\n[@디자이너](agent://designer)\n~~~~',
    '다음 예시\n> ```\n> @디자이너 @all\n> ```', '- ~~~js\n  @디자이너\n  ~~~', '~~~\n@디자이너',
    '(@) 기호', '@ 디자이너를 표시합니다', '@# 기호', '@$ 기호', '리터럴 \\@디자이너', 'word@디자이너']) {
    assert.equal(BoardThread.boardDeliveryIntent(thread, message).route, 'room', message);
  }
  const mixed = BoardThread.boardDeliveryIntent(thread, 'person@host.example, `@없는이름` 및 https://:@없는이름.example/ 확인 @디자이너');
  assert.deepEqual(mixed.expectedBoardDelivery.recipientIds, [ID_D]);
  assert.deepEqual(BoardThread.boardDeliveryIntent(thread, '~~~\n@검증 담당\n~~~\n@디자이너').expectedBoardDelivery.recipientIds, [ID_D]);
});

test('opening an explicitly empty roster clears stale local names and leaves ordinary sends usable', () => {
  const thread = room();
  for (const answer of [{ saved: true, members: [] }, { saved: true, rosterSaved: true, members: [] }]) {
    const sync = BoardThread.boardMembersSync(thread, answer);
    assert.deepEqual(sync, { restore: { participants: [], participantRoles: {}, participantAgents: {} } });
    const reopened = { ...thread, ...sync.restore };
    assert.deepEqual(BoardThread.boardDeliveryIntent(reopened, '확인해 줘').expectedBoardDelivery.roster, []);
    assert.equal(BoardThread.boardDeliveryIntent(reopened, '확인해 줘').route, 'room');
    assert.equal(BoardThread.boardDeliveryIntent(reopened, '@디자이너 확인').code, 'BOARD_UNRESOLVED_ADDRESS');
    assert.equal(BoardThread.boardMembersSync(reopened, answer), null);
  }
  assert.ok(BoardThread.boardMembersSync(thread, { saved: false, rosterSaved: false, members: [] }).save);
  assert.equal(BoardThread.boardMembersSync(thread, { saved: true, members: [] }, { legacySavedIsThreadExistence: true }), null);
});

test('native duplicate, self-colliding and missing labels round-trip without inventing speaking identities', () => {
  const saved = [
    { kind: 'agent', profileId: 'a', label: '물결', role: 'admin' },
    { kind: 'agent', profileId: 'b', label: '물결', role: 'member' },
    { kind: 'agent', label: '물결', role: 'member' },
    { kind: 'agent', profileId: 'c', label: null, role: 'owner' },
    { kind: 'agent', profileId: 'd', label: '나', role: 'member' },
    { kind: 'user', label: null, role: 'owner' },
    { kind: 'agent', profileId: 'e', label: '물결 · a' },
  ];
  const thread = room();
  const restored = BoardThread.threadFieldsFromStoreMembers(thread, saved);
  let reopened = JSON.parse(JSON.stringify({ ...thread, ...restored }));
  assert.equal(new Set(reopened.participants).size, saved.length);
  assert.deepEqual(BoardThread.boardRosterIdentity(BoardThread.boardStoreMembers(reopened)), BoardThread.boardRosterIdentity(saved));
  assert.equal(BoardThread.threadFieldsFromStoreMembers(reopened, saved), null);
  assert.equal(BoardThread.boardDeliveryIntent(reopened, '그냥 질문').route, 'room');
  assert.equal(BoardThread.boardDeliveryIntent(reopened, '@물결').code, 'BOARD_UNRESOLVED_ADDRESS');
  assert.equal(BoardThread.boardDeliveryIntent(reopened, '@나').code, 'BOARD_UNRESOLVED_ADDRESS');
  assert.deepEqual(mentionNames(reopened), ['물결 · a']);
  assert.deepEqual(BoardThread.boardDeliveryIntent(reopened, '[대상](agent://c)').expectedBoardDelivery.recipientIds, ['c']);
  reopened = { ...reopened, ...ThreadMembers.invitedThreadFields(reopened, { name: '새 Agent', profileId: 'f' }) };
  assert.deepEqual(BoardThread.boardRosterIdentity(BoardThread.boardStoreMembers(reopened)).slice(0, saved.length), BoardThread.boardRosterIdentity(saved));
});

test('an unknown dispatch row is not a rejection even when other recipients fail or start', () => {
  const failed = { profileId: ID_D, status: 'failed', code: 'PROFILE_NOT_FOUND' };
  const uncertain = { profileId: ID_V, status: 'failed', dispatchStatus: 'unknown', resumeRequired: true, requestId: 'r~v' };
  const started = { profileId: 'writer', status: 'started', requestId: 'r~w', runId: 'native-run', conversationId: 'native-thread' };
  const outcome = BoardThread.boardSendOutcome({ accepted: true, recipients: [failed, uncertain, started] }, 'r');
  assert.equal(outcome.unknown, uncertain);
  assert.equal(outcome.failure, failed);
  assert.deepEqual(outcome.members, [started]);
  assert.equal(outcome.routes[ID_V].status, 'unknown');
  assert.equal(outcome.routes[ID_V].dispatchStatus, 'unknown');
  assert.equal(outcome.routes[ID_V].resumeRequired, true);
  assert.deepEqual(BoardThread.boardMemberState(ID_V, outcome), { kind: 'waiting', label: '접수 미확인' });
});

test('only confirmed room speech crosses the Board boundary; rendering or hiding arbitrary strings is not the privacy boundary', () => {
  const internal = '<egdesk-await-resume><plan>PRIVATE_PLAN</plan></egdesk-await-resume>';
  const thread = room({ messages: [
    { role: 'user', content: '공개 질문', status: 'complete', authorName: '나', inputReferences: [{ text: 'PRIVATE_INPUT' }] },
    { role: 'user', content: internal, status: 'complete', requestId: 'scheduler-action' },
    ...['submitting', 'unconfirmed', 'partial', 'failed', undefined].map(status => ({ role: 'user', status, content: 'PRIVATE_DRAFT' })),
    ...['streaming', 'interrupted', 'failed', 'unavailable'].map(status => ({ role: 'assistant', status, authorName: '디자이너', content: 'PRIVATE_INCOMPLETE' })),
    ...['system', 'tool', 'reasoning'].map(role => ({ role, status: 'complete', content: 'PRIVATE_ACTIVITY' })),
    { role: 'assistant', authorName: '디자이너', status: 'complete', phase: 'commentary', content: '먼저 배경을 보겠습니다.', activities: [{ text: 'PRIVATE_ACTIVITY' }] },
    { role: 'assistant', status: 'completed', content: '이전 공개 답변' },
  ], privateNotes: 'PRIVATE_NOTE' });
  const request = { clientThreadId: 'room-1', requestId: 'public-only', message: '@디자이너 의견',
    systemPrompt: 'PRIVATE_PERSONA', qaOutputMarkers: ['PRIVATE_QA'], privateNotes: 'PRIVATE_NOTE', profileEnabled: false, recentMessages: [{ text: 'PRIVATE_HISTORY' }], engineProfileId: 'PRIVATE_SLOT' };
  const { body } = BoardThread.boardSendPlan(thread, request);
  assert.deepEqual(body.recentMessages, [{ role: 'user', text: '공개 질문' }, { role: 'agent', text: '이전 공개 답변' }]);
  assert.equal(BoardThread.boardDeliveryIntent(thread, request.message).roomBlock.recentTurnCount, 2);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_/);
  const old = {id: 'same', role: 'assistant'}, other = { ...old, runId: 'different' };
  assert.equal(ChatState.answerForPeek([old, other], {messageId: 'same'}), null, 'an ambiguous old item cannot select a different speaker');
  const peek = ChatState.agentPeekView({ author: '디자이너', boardMemberProfileId: ID_D, memberSummary: { id: ID_V, role: 'PRIVATE_LEAD' }, threadType: 'group', profile: { id: ID_V, name: '검증 담당' }, modelText: 'PRIVATE_MODEL', detail: { active: { body: { instructions: 'PRIVATE_PERSONA' } } } });
  assert.deepEqual([peek.name, peek.profileId, peek.compact, peek.role], ['디자이너', ID_D, true, '이 답변의 작성자']);
  assert.doesNotMatch(JSON.stringify(peek), /PRIVATE_|검증 담당|Codex/);
});

test('cold Board work: require a routed Board, member, exact native and local run plus its published answer; copy only the note text', () => {
  const scope = { clientThreadId: 'board-member:synthetic', localConversationId: 'local-member' }, owner = { roomId: 'room-1', profileId: ID_V };
  const r = { ...scope, localHistory: true, localRunId: 'same', runId: 't', conversationId: 'c', answerId: 'c/t', board: { roomClientThreadId: 'room-1', profileId: ID_V },
    activities: [{ id: 'work-note:1', kind: 'workNote', status: 'completed', detail: { text: '작업 메모', raw: 'PRIVATE' }, sourceRefs: ['PRIVATE'] }, { kind: 'commandExecution', detail: 'PRIVATE' }],
    contextCaptures: ['PRIVATE'], messages: ['PRIVATE'], command: 'PRIVATE', status: 'completed' };
  const m = { ...scope, localMessageId: 'a', localRunId: 'same', conversationId: 'c', runId: 't', answerId: 'c/t', role: 'assistant', phase: 'final_answer', status: 'complete' };
  const fold = (thread = room(), answer = m, run = r, who = owner) => BoardThread.foldBoardMemberWork(thread, [answer], [run], who, scope);
  const accepted = fold(); assert.equal(accepted.length, 1); assert.doesNotMatch(JSON.stringify(accepted), /PRIVATE/);
  assert.deepEqual(fold(room({ localRuns: accepted })), accepted);
  for (const change of [{ clientThreadId: 'DM' }, { localRunId: 'other' }, { runId: 'other' }, { localConversationId: 'other' }, { profileBinding: { profileId: ID_D } }, { board: {} }]) assert.deepEqual(fold(room(), m, { ...r, ...change }), []);
  for (const change of [{ role: 'user' }, { phase: 'commentary' }, { status: 'streaming' }, { answerId: 'conflict' }]) assert.deepEqual(fold(room(), { ...m, ...change }), []);
  assert.deepEqual(fold(room({ id: 'other-room' })), []); assert.deepEqual(fold(room({ type: 'dm' })), []);
});

test('cold Board receipts rebuild only checked publication order, never stored display text or a claim of model use', () => {
  const id = 'egdesk-peer:31234567-89ab-cdef-9876-111111111111';
  const scope = { clientThreadId: 'board-member:synthetic', localConversationId: 'verified-member' };
  const member = { roomId: 'room-1', profileId: ID_V };
  const identity = { ...scope, localRunId: 'local-run', runId: 'turn', conversationId: 'thread', answerId: 'thread/turn' };
  const answer = { ...identity, localMessageId: 'msg', role: 'assistant', phase: 'final_answer', status: 'complete' };
  const record = (status, timing) => {
    const activity = { id, kind: 'boardPeerInput', status, title: 'PRIVATE_TITLE', detail: { timing, text: 'PRIVATE_TEXT' }, sourceRefs: ['PRIVATE_REF'] };
    const run = { ...identity, localHistory: true, status: 'completed', board: { roomClientThreadId: 'room-1', profileId: ID_V }, activities: [activity] };
    return BoardThread.foldBoardMemberWork(room(), [answer], [run], member, scope)[0]?.activities[0];
  };
  for (const timing of ['sentAfterPublication', 'ackAfterPublication']) {
    const receipt = record('completed', timing);
    assert.deepEqual(receipt, BoardThread.boardPeerReceipt(id, 'completed', timing));
    assert.equal(receipt.detail.timing, timing); assert.match(receipt.detail.text, /답변에 반영됐는지는 확인되지 않았습니다/);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_/);
    for (const status of ['unknown', 'declined']) assert.deepEqual(record(status, timing), BoardThread.boardPeerReceipt(id, status));
  }
  assert.notEqual(record('completed', 'sentAfterPublication').detail.text, record('completed', 'ackAfterPublication').detail.text);
  for (const timing of [undefined, 'PRIVATE_ORDER', { text: 'PRIVATE' }]) assert.deepEqual(record('completed', timing), BoardThread.boardPeerReceipt(id, 'completed'));
  assert.equal(record('read', 'ackAfterPublication'), undefined);
});
