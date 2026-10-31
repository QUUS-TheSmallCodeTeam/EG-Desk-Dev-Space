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
  const keys = ['codexBridgeNotice', 'codex', 'activeEngine', 'buildCodexBridgeNotice', 'codexBridge', 'el'];
  const bridge = { startLogin() {}, refreshAuthStatus() {} };
  const state = codex.connected ? 'online' : 'offline';
  return compileFunction(`${block}\nreturn { chromeRow, connectionNotice };`, keys)(
    () => ({ state }), codex, activeEngine, () => state === 'online' ? null : el('div', {}, '연결 확인'), bridge, el);
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
  const renderNotice = compileFunction(`${noticeBlock}\nreturn conversation;`, ['activeThread', 'ChatState', 'conversation', 'el', 'sendNoticeDetailsThreadId']);
  const room = { id: 'room' };
  const state = requests => select({ chatProtocol: { requests } }, ChatState, room);
  const oldFailed = { localThreadId: 'room', status: 'failed' };
  assert.equal(state({ a: oldFailed }), undefined);
  for (const error of ['중지 여부를 확인하지 못했습니다: timeout', '상태를 확인하지 못했습니다: history unavailable',
    'Error: history refresh failed\nprovider detail']) {
    const conversation = el('div');
    renderNotice({ ...room, sendError: error }, ChatState, conversation, el, null);
    const notice = conversation.children[0];
    assert.doesNotMatch(text(notice), /메시지를 보내지 못했습니다/);
    assert.ok(text(notice).includes(error), 'the original error remains visible or expandable');
  }
  assert.equal(oldFailed.status, 'failed', 'the original request state is not changed');
  const unknown = { localThreadId: 'room', status: 'unconfirmed' };
  assert.equal(state({ a: oldFailed, b: unknown }), unknown);
  const unrelated = el('div');
  renderNotice({ ...room, sendError: 'Error: stop request failed' }, ChatState, unrelated, el, null);
  assert.equal(text(unrelated.children[0].children[0]), '문제가 발생했습니다. 자세히를 확인해 주세요.');
  assert.match(source, /pending\?\.status === 'unconfirmed'[\s\S]*?testid: 'chat-reconcile'/);
  assert.match(source, /\['error', 'failed'\]\.includes\(message\.status\) \? 'egd-codex-bubble-error'/);
  assert.match(source, /unconfirmed: '접수 미확인', failed: '전송 거절됨'/);
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
