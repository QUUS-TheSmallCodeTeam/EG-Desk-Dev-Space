import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import * as ThreadRouting from '../overlay/resources/EGDeskThreadRouting.sys.mjs';

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `production block: ${start.trim()}`);
  return source.slice(a, b);
};

class Node {
  constructor(tag, props = {}, children = []) {
    this.tag = tag;
    this.props = props;
    this.children = children.filter(child => child != null);
    this.events = {};
  }
  addEventListener(type, fn) { this.events[type] = fn; }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { this.children.push(...nodes); }
}
const el = (tag, props = {}, ...children) => new Node(tag, props, children);
const descendants = node => typeof node === 'string' ? [] : [node, ...node.children.flatMap(descendants)];
const byClass = (node, name) => descendants(node).find(child => (child.props.class || '').split(' ').includes(name));
const text = node => typeof node === 'string' ? node : node.children.map(text).join('');

function threadSection(thread, profile = { label: 'Codex', name: 'Codex' }) {
  const block = between('      const renderThreadSection = ', "\n\n      if (mode === 'hud')");
  const keys = ['el', 'codex', 'activeThread', 'codexBridge', 'codexThreadRowLabel', 'bindChatRoomRowKeys',
    'openRoomFromKeyboard', 'formatRelativeTime', 'codexThreadKindMeta', 'codexThreadAgentProfile', 'ChatState',
    'engineContext', 'codexThreadSessionKey', 'buildCodexSessionBadge', 'renderEngineBadge', 'stripMarkdown', 'codexThreadPreview', 'renderThreadMenu', 'query', 'ThreadRouting'];
  const context = { auth: { isLoggedIn: true }, engines: [{ id: 'claude', label: 'Claude', status: 'ready' }] };
  const values = [el, { threadMenu: null }, thread, { selectThread() {} }, t => t.title, () => {}, () => {},
    () => '방금', type => ({ label: type === 'group' ? 'Board' : 'Codex' }), () => profile, ChatState,
    context, t => t.session || 'resumed', () => el('span', { class: 'egd-codex-session-badge' }, '로컬 기록'),
    t => el('span', { class: 'egd-codex-engine-badge' }, ChatState.chatEngineChipView(t, context).label),
    value => value, t => t.messages.at(-1)?.content || '', () => el('div'), '', ThreadRouting];
  const render = compileFunction(`${block}\nreturn renderThreadSection;`, keys)(...values);
  return render('전체', [thread]);
}

function chromeState(codex, activeEngine) {
  const block = between('      const bridgeNotice = codexBridgeNotice(codex);', '\n      const authCardNeeded =');
  const keys = ['codexBridgeNotice', 'codex', 'activeEngine', 'buildCodexBridgeNotice', 'codexBridge', 'el', 'codexAccessRow', 'codexAccessActions'];
  const bridge = { startLogin() {}, refreshAuthStatus() {}, signOut() {} };
  const state = codex.connected ? 'online' : 'offline';
  // SUB-14 account access chip and its recovery chips, from their production definitions in mountCodexHUD.
  const accessRow = compileFunction(`${between('    const ACCESS_STATE_VALUES = ', "    // Recovery is the user's pick")}\nreturn codexAccessRow;`, [])();
  const accessActions = compileFunction(`${between('    let accessWaitKey = null;', '    const onMessageScrollGesture = ')}\nreturn codexAccessActions;`, ['codexBridge', 'el'])(bridge, el);
  return compileFunction(`${block}\nreturn { chromeRow, connectionNotice };`, keys)(
    () => ({ state }), codex, activeEngine, () => state === 'online' ? null : el('div', {}, '연결 확인'), bridge, el, accessRow, accessActions);
}

test('room row prioritizes title, latest message and time without duplicate Codex labels', () => {
  const thread = { id: 'one', type: 'dm', title: 'Codex', profileEnabled: false,
    engineId: 'codex', messages: [{ content: '최근 메시지', createdAt: 1 }] };
  const row = threadSection(thread);
  const body = byClass(row, 'egd-codex-thread-item-body');
  assert.deepEqual(body.children.map(child => child.props.class),
    ['egd-codex-thread-item-top', 'egd-codex-thread-item-bottom']);
  assert.equal(text(byClass(row, 'egd-codex-thread-title')), 'Codex');
  assert.equal(text(byClass(row, 'egd-codex-thread-preview')), '최근 메시지');
  assert.equal(text(byClass(row, 'egd-codex-thread-time')), '방금');
  assert.equal(byClass(row, 'egd-codex-thread-kind'), undefined);
  assert.equal(byClass(row, 'egd-codex-engine-badge'), undefined);
  assert.equal(byClass(row, 'egd-codex-agent-profile-chip'), undefined);
  assert.equal(byClass(row, 'egd-codex-session-badge'), undefined);
});

test('distinct Board, Agent and provider identities remain visible', () => {
  const thread = { id: 'board', type: 'group', title: '회의 준비', profileEnabled: true,
    engineId: 'claude', messages: [{ content: '다음 단계', createdAt: 1 }] };
  const row = threadSection(thread, { label: 'Rio', name: 'Rio Agent' });
  assert.equal(text(byClass(row, 'egd-codex-thread-kind')), 'Board');
  assert.equal(text(byClass(row, 'egd-codex-agent-profile-chip')), 'Rio');
  assert.equal(text(byClass(row, 'egd-codex-engine-badge')), 'Claude');
  assert.equal(text(byClass(row, 'egd-codex-thread-preview')), '다음 단계');
});

test('a profile matching the title is not repeated, and default Codex stays implicit', () => {
  const thread = { id: 'rio', type: 'dm', title: 'rio', profileEnabled: true,
    engineId: 'codex', messages: [{ content: '메시지', createdAt: 1 }] };
  const row = threadSection(thread, { label: 'Rio', name: 'Rio Agent' });
  assert.equal(byClass(row, 'egd-codex-agent-profile-chip'), undefined);
  assert.equal(byClass(row, 'egd-codex-engine-badge'), undefined);
});

test('plain local-only rooms retain their important binding status without an Agent badge', () => {
  const thread = { id: 'local', type: 'dm', title: '기록', profileEnabled: false, session: 'local',
    engineId: 'codex', messages: [{ content: '메시지', createdAt: 1 }] };
  const row = threadSection(thread);
  assert.equal(text(byClass(row, 'egd-codex-session-badge')), '로컬 기록');
  assert.equal(byClass(row, 'egd-codex-thread-kind'), undefined);
  assert.equal(byClass(row, 'egd-codex-engine-badge'), undefined);
});

test('healthy connection chips are absent; login, offline and engine problems remain visible', () => {
  const signedIn = { connected: true, error: null, authStatus: { isLoggedIn: true } };
  assert.equal(chromeState(signedIn, { engineId: 'codex', ready: true }).chromeRow, null);
  const login = chromeState({ ...signedIn, authStatus: { isLoggedIn: false } }, { engineId: 'codex', ready: false });
  assert.match(text(login.chromeRow), /로그인 필요/);
  assert.match(text(login.chromeRow), /로그인/);
  assert.doesNotMatch(text(login.chromeRow), /연결됨/);
  const offline = chromeState({ ...signedIn, connected: false }, { engineId: 'codex', ready: false });
  assert.ok(offline.connectionNotice);
  const claude = chromeState(signedIn, { engineId: 'claude', ready: false, reason: 'Claude 연결 확인' });
  assert.equal(text(claude.chromeRow), 'Claude 연결 확인');
});

test('operational notices retain original details and never turn uncertainty into failure or success', () => {
  assert.deepEqual(ChatState.chatOperationalNotice('권한이 부족합니다.'), { text: '권한이 부족합니다.', detail: null });
  const raw = '  Error: unavailable\nstack and provider detail  ';
  assert.deepEqual(ChatState.chatOperationalNotice(raw, { run: true }),
    { text: '실행을 마치지 못했습니다. 활동에서 확인해 주세요.', detail: raw });
  assert.deepEqual(ChatState.chatOperationalNotice(raw), { text: '문제가 발생했습니다. 자세히를 확인해 주세요.', detail: raw });
  assert.equal(ChatState.chatOperationalNotice('  '), null);
});

test('old failed requests do not relabel later stop or history errors; unconfirmed stays separate', () => {
  const block = between('        const threadRequests = Object.values(codex.chatProtocol.requests)', '\n        const status =');
  const select = compileFunction(`${block}\nreturn pending;`, ['codex', 'ChatState', 'activeThread']);
  const noticeBlock = between('        if (activeThread.sendError) {', '\n        const noticeIds =');
  const renderNotice = compileFunction(`${noticeBlock}\nreturn conversation;`,
    ['activeThread', 'ChatState', 'conversation', 'el', 'sendNoticeDetailsThreadId', 'memoManualSendNotices', 'chatEditedDraftNotices']);
  const memoManualSendNotices = new Map();
  const chatEditedDraftNotices = new Map();
  const room = { id: 'room' };
  const state = requests => select({ chatProtocol: { requests } }, ChatState, room);
  const oldFailed = { localThreadId: 'room', status: 'failed' };
  assert.equal(state({ a: oldFailed }), undefined);
  for (const error of ['중지 여부를 확인하지 못했습니다: timeout', '상태를 확인하지 못했습니다: history unavailable',
    'Error: history refresh failed\nprovider detail']) {
    const conversation = el('div');
    renderNotice({ ...room, sendError: error }, ChatState, conversation, el, null, memoManualSendNotices, chatEditedDraftNotices);
    const notice = conversation.children[0];
    assert.doesNotMatch(text(notice), /메시지를 보내지 못했습니다/);
    assert.ok(text(notice).includes(error), 'the original error remains visible or expandable');
  }
  assert.equal(oldFailed.status, 'failed', 'the original request state is not changed');
  const unknown = { localThreadId: 'room', status: 'unconfirmed' };
  assert.equal(state({ a: oldFailed, b: unknown }), unknown);
  const unrelated = el('div');
  renderNotice({ ...room, sendError: 'Error: stop request failed' }, ChatState, unrelated, el, null, memoManualSendNotices, chatEditedDraftNotices);
  assert.equal(text(unrelated.children[0].children[0]), '문제가 발생했습니다. 자세히를 확인해 주세요.');
  assert.match(source, /pending\?\.status === 'unconfirmed'[\s\S]*?testid: 'chat-reconcile'/);
  assert.match(source, /\['error', 'failed'\]\.includes\(message\.status\) \? 'egd-codex-bubble-error'/);
  assert.match(source, /unconfirmed: '접수 미확인', failed: '전송 거절됨'/);
});

test('a current memo-send notice stays distinct from the original room error', () => {
  const block = between('        if (activeThread.sendError) {', '\n        const noticeIds =');
  const render = compileFunction(`${block}\nreturn conversation;`,
    ['activeThread', 'ChatState', 'conversation', 'el', 'sendNoticeDetailsThreadId', 'memoManualSendNotices', 'chatEditedDraftNotices']);
  const error = 'Error: history refresh failed\nprovider detail';
  const room = { id: 'room', sendError: error };
  const chatEditedDraftNotices = new Map();
  const check = notices => render(room, ChatState, el('div'), el, null, notices, chatEditedDraftNotices);
  const shown = check(new Map([['room', { current: () => true }]]));
  assert.equal(shown.children.length, 2);
  assert.equal(shown.children[0].props.role, 'alert');
  assert.equal(shown.children[0].props.data.testid, 'chat-send-notice');
  assert.ok(text(shown.children[0]).includes(error), 'the original error details remain available');
  assert.equal(shown.children[1].props.role, 'status');
  assert.equal(shown.children[1].props.data.testid, 'chat-memo-send-blocked');
  assert.match(text(shown.children[1]), /보내지 않았습니다.*초안은 그대로입니다/);
  for (const notices of [new Map([['other-room', { current: () => true }]]),
    new Map([['room', { current: () => false }]])]) {
    const hidden = check(notices);
    assert.equal(hidden.children.length, 1, 'another room or expired notice is not displayed');
    assert.ok(text(hidden.children[0]).includes(error));
  }
  assert.equal(room.sendError, error);
});

// Run the production project-recheck callback, notice lifetime and notice
// renderer together. The project reply, clock and authority scopes are local
// fixtures; this does not run a provider or exercise a browser send button.
function editedDraftNoticeFixture() {
  const error = 'Error: history refresh failed\nprovider detail';
  const room = { id: 'room', clientBindingId: 'wire-room', inputSources: [], briefingInputs: [], messages: [], sendError: error };
  const other = { id: 'other-room', clientBindingId: 'wire-other', inputSources: [], briefingInputs: [], messages: [], sendError: '다른 방 오류' };
  const state = { codex: { threads: [room, other], activeThreadId: room.id, activityRoomGeneration: 0,
    threadDrafts: { [room.id]: '원래 초안', [other.id]: '다른 초안' }, threadDraftRevisions: { [room.id]: 1, [other.id]: 1 } } };
  const memoManualSendNotices = new Map(), chatEditedDraftNotices = new Map(), timers = new Map(), watches = [];
  const flags = { owner: true, scope: true, watch: true, editedWatch: true };
  let nextTimer = 0, reads = 0, emissions = 0, onEdited = 0, releaseRead;
  const pendingRead = new Promise(resolve => { releaseRead = resolve; });
  const value = { roomId: 'wire-room', status: 'none', source: null, inheritance: null, override: null, project: null };
  const window = { setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id) };
  const scope = () => ({ signal: { aborted: false }, current: () => flags.scope, finish() {} });
  const lookup = compileFunction(`${between('  function getCodexThreadById(', '\n  function getActiveCodexThread(')}\nreturn getCodexThreadById;`, [])();
  const watchMemoRead = (threadId, options) => {
    watches.push({ threadId, options });
    return { current: () => flags.watch && (options?.includeAccess !== true || flags.editedWatch), release() {} };
  };
  const emit = () => { emissions++; };
  const noticeBlock = between('    const clearMemoManualSendNotice = ', '\n\n    connect();');
  const notices = compileFunction(`${noticeBlock}\nreturn { showMemoManualSendNotice, clearMemoManualSendNotice };`,
    ['memoManualSendNotices', 'chatEditedDraftNotices', 'window', 'state', 'createChatProjectScope', 'epochScope',
      'watchMemoRead', 'ChatState', 'getCodexThreadById', 'emit'])(memoManualSendNotices, chatEditedDraftNotices,
    window, state, scope, {}, watchMemoRead, ChatState, lookup, emit);
  const defaults = new Map(), actions = new Map();
  const roomState = compileFunction(`${between('  function chatRoomProjectState(', '\n  function createChatProjectScope(')}\nreturn chatRoomProjectState;`,
    ['chatRoomProjectDefaults', 'ChatState'])(defaults, ChatState);
  const targetsMatch = compileFunction(`${between('  function chatRoomProjectTargetsMatch(', '\n  function observeFileProjectAssociation(')}\nreturn chatRoomProjectTargetsMatch;`, [])();
  const prepareBlock = between('      async prepareRoomProjectSend(', '\n      async saveRoomProjectDefault(');
  const deps = { state, ChatState, getCodexThreadById: lookup, chatProjectDraftActions: actions, emit,
    normalizeChatRoomProjectDefault: () => assert.fail('no previous project is used in this fixture'),
    chatRoomProjectState: roomState, chatRoomProjectTargetsMatch: targetsMatch,
    chatRoomProjectExpectation: () => assert.fail('an edited draft must not reach dispatch preparation'),
    updateThreadById: () => assert.fail('the existing error must not be overwritten'),
    CHAT_ROOM_PROJECT_UNAVAILABLE: '프로젝트 확인 실패', CHAT_REQUEST_PROJECT_INVALID: '프로젝트 선택 오류' };
  const bridge = compileFunction(`return { ${prepareBlock} };`, Object.keys(deps))(...Object.values(deps));
  bridge.createProjectScope = () => scope();
  bridge.readRoomProjectDefault = async (threadId, options) => {
    assert.equal(threadId, room.id); assert.deepEqual(options, { force: true, supersede: true }); reads++;
    const result = await pendingRead;
    defaults.set(room.id, { binding: room.clientBindingId, scope: scope(), status: 'ready', value: result });
    return result;
  };
  const renderBlock = between('        if (activeThread.sendError) {', '\n        const noticeIds =');
  const render = compileFunction(`${renderBlock}\nreturn conversation;`,
    ['activeThread', 'ChatState', 'conversation', 'el', 'sendNoticeDetailsThreadId', 'memoManualSendNotices', 'chatEditedDraftNotices']);
  return { state, room, other, error, flags, timers, watches, memoManualSendNotices, chatEditedDraftNotices,
    reads: () => reads, emissions: () => emissions, editedCallbacks: () => onEdited,
    start: () => bridge.prepareRoomProjectSend(room.id, null, () => flags.owner,
      () => { onEdited++; notices.showMemoManualSendNotice(room, 'draft-edited'); }),
    resolve: () => releaseRead(value),
    edit: text => { state.codex.threadDrafts[room.id] = text; state.codex.threadDraftRevisions[room.id]++; },
    showMemo: () => notices.showMemoManualSendNotice(room),
    render: thread => render(thread, ChatState, el('div'), el, null, memoManualSendNotices, chatEditedDraftNotices) };
}

test('a text-only edit renders its own notice beside the original error and memo conflict', async () => {
  const h = editedDraftNoticeFixture(), checking = h.start();
  assert.equal(h.reads(), 1);
  h.edit('사용자가 고친 초안'); h.resolve();
  assert.equal(await checking, false);
  assert.equal(h.editedCallbacks(), 1);
  assert.equal(h.state.codex.threadDrafts.room, '사용자가 고친 초안');
  assert.deepEqual(h.room.inputSources, []); assert.deepEqual(h.room.briefingInputs, []); assert.deepEqual(h.room.messages, []);
  assert.equal(h.room.sendError, h.error);
  assert.equal(h.memoManualSendNotices.has('room'), false, 'text editing is not a memo conflict');
  assert.deepEqual(h.watches[0], { threadId: 'room', options: { includeAccess: true } });

  h.showMemo();
  const shown = h.render(h.room);
  assert.deepEqual(shown.children.map(node => [node.props.data.testid, node.props.role]),
    [['chat-send-notice', 'alert'], ['chat-memo-send-blocked', 'status'], ['chat-edited-draft-notice', 'status']]);
  assert.ok(text(shown.children[0]).includes(h.error), 'the original error details remain intact');
  assert.match(text(shown.children[1]), /메모 질문.*보내지 않았습니다.*초안은 그대로입니다/);
  assert.match(text(shown.children[2]), /입력이 바뀌어.*보내지 않았습니다.*직접 다시 보내세요/);
  assert.doesNotMatch(text(shown.children[2]), /메모|예약/);
  assert.equal(h.room.sendError, h.error); assert.equal(h.state.codex.threadDrafts.room, '사용자가 고친 초안');
  assert.ok(h.emissions() > 0);

  h.flags.editedWatch = false;
  const stale = h.render(h.room);
  assert.deepEqual(stale.children.map(node => node.props.data.testid), ['chat-send-notice', 'chat-memo-send-blocked']);
  assert.ok(text(stale.children[0]).includes(h.error));
  h.flags.editedWatch = true; // Isolate the independent room-generation fence below.
  h.state.codex.activeThreadId = h.other.id; h.state.codex.activityRoomGeneration++;
  const other = h.render(h.other);
  assert.equal(other.children.length, 1); assert.equal(text(other.children[0]), '다른 방 오류');
  assert.equal(h.render(h.room).children.length, 1, 'the inactive room has no live status');
  h.state.codex.activeThreadId = h.room.id; h.state.codex.activityRoomGeneration++;
  assert.equal(h.render(h.room).children.length, 1, 'an old notice does not revive after a room round trip');
  assert.equal(h.room.sendError, h.error);
});

test('only a current text-only project recheck creates an edited-draft notice', async t => {
  for (const change of ['attachment', 'same-text', 'other-room', 'stale-owner']) await t.test(change, async () => {
    const h = editedDraftNoticeFixture(), checking = h.start();
    assert.equal(h.reads(), 1);
    h.edit(change === 'same-text' ? '원래 초안' : '사용자가 고친 초안');
    if (change === 'attachment') h.room.inputSources = [{ id: 'new-attachment', kind: 'file' }];
    if (change === 'other-room') { h.state.codex.activeThreadId = h.other.id; h.state.codex.activityRoomGeneration++; }
    if (change === 'stale-owner') h.flags.owner = false;
    h.resolve(); assert.equal(await checking, false);
    assert.equal(h.editedCallbacks(), 0); assert.equal(h.chatEditedDraftNotices.size, 0);
    assert.equal(h.memoManualSendNotices.size, 0); assert.equal(h.room.sendError, h.error);
  });
});

test('the actual notice region groups the edited-draft status with independent memo and error notices', () => {
  // This tiny tree implements DOM-style reparenting for the production region.
  const make = (tag, props = {}, ...children) => {
    const node = { tag, props, dataset: props.data || {}, children: [], parent: null,
      appendChild(child) {
        if (child && typeof child === 'object') {
          if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
          child.parent = this;
        }
        this.children.push(child); return child;
      } };
    for (const child of children.filter(child => child != null)) node.appendChild(child);
    return node;
  };
  const block = between('        if (activeThread.sendError) {', '\n        if (!activeThread.messages.some');
  const render = compileFunction(`${block}\nreturn conversation;`,
    ['activeThread', 'ChatState', 'conversation', 'el', 'sendNoticeDetailsThreadId', 'memoManualSendNotices', 'chatEditedDraftNotices']);
  const room = { id: 'room', sendError: 'Error: original detail' }, current = { current: () => true };
  const result = render(room, ChatState, make('div'), make, null, new Map([['room', current]]), new Map([['room', current]]));
  assert.equal(result.children.length, 1);
  const region = result.children[0];
  assert.equal(region.props.role, 'region'); assert.equal(region.props.tabindex, '0');
  assert.equal(region.dataset.threadId, 'room'); assert.match(region.props['aria-label'], /알림 3개/);
  const notices = region.children.filter(node => node.dataset.testid);
  assert.deepEqual(notices.map(node => [node.dataset.testid, node.props.role]),
    [['chat-send-notice', 'alert'], ['chat-memo-send-blocked', 'status'], ['chat-edited-draft-notice', 'status']]);
  assert.match(text(notices[0]), /Error: original detail/);
  assert.match(text(notices[1]), /메모 질문/); assert.match(text(notices[2]), /입력이 바뀌어/);
});

test('filters, history warnings, activity and expandable error details remain separately wired', () => {
  assert.match(source, /codexBridge\.setThreadFilter\(filterDef\.key\)/);
  assert.match(source, /\{ key: 'dm', label: '대화' \}/);
  assert.match(source, /codexBridge\.setThreadQuery\(threadSearch\.value\)/);
  for (const id of ['chat-local-history-coverage', 'chat-local-history-error', 'chat-binding-held', 'chat-agent-unavailable', 'chat-activity-open']) {
    assert.ok(source.includes(id), id);
  }
  assert.match(source, /class: 'egd-codex-notice-details'[\s\S]*?notice\.detail/);
  assert.match(source, /sendNoticeDetailsThreadId === activeThread\.id/);
  assert.match(css, /\.egd-codex-notice-details\[open\][^{]*\{[^}]*overflow:\s*auto/);
});

test('the actual notice region keeps independent alerts and actions reachable', () => {
  const block = between('        const noticeIds = new Set(', '\n        if (!activeThread.messages.some');
  const ids = ['chat-local-history-coverage', 'chat-local-history-error', 'chat-run-error', 'chat-reconcile', 'chat-send-notice'];
  const conversation = { children: ids.map(id => ({ dataset: { testid: id } })), appendChild(node) { this.children.push(node); } };
  const make = (tag, props, ...children) => ({ tag, props, children: children.filter(Boolean), appendChild(child) {
    conversation.children = conversation.children.filter(item => item !== child);
    this.children.push(child);
  } });
  compileFunction(block, ['conversation', 'activeThread', 'el'])(conversation, { id: 'room' }, make);
  const region = conversation.children.at(-1);
  assert.equal(region.props.role, 'region');
  assert.equal(region.props.tabindex, '0');
  assert.match(region.props['aria-label'], /알림 5개/);
  assert.deepEqual(region.children.slice(1).map(child => child.dataset.testid), ids);
  assert.match(source, /currentNotices\.scrollTop = noticeScroll\.top/);
});
